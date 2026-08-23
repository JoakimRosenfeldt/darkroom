import {
  parseCatalogId,
  parseRootId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import { parseDirtyScope, type DirtyScope } from "../lib/catalog/watch.ts";
import { parseRelativePath } from "../lib/catalog/runtime.ts";
import {
  isStableAutoImportFile,
  normalizeAutoImportRelativePath,
  parseFileObservation,
  type AutoImportFileObservation,
} from "../lib/import/auto-import.ts";
import { sameFileObservation } from "../lib/import/domain.ts";
import type {
  CatalogAutoImportController,
  CatalogAutoImportStatus,
  CatalogAutoImportStatusRule,
} from "./catalog-auto-import-controller.ts";

const DEFAULT_MAX_PENDING = 1_000;
const DEFAULT_MAX_CANDIDATES = 1_000;
const DEFAULT_DRAIN_LIMIT = 100;
const MAX_UNREADABLE_GATE_RETRIES = 3;
const MAX_ENUMERATION_PAGES = 16;

export interface CatalogAutoImportMonitorCandidate {
  readonly rootId: RootId;
  readonly relativePath: string;
}

export interface CatalogAutoImportMonitorPorts {
  readonly listCandidates: (
    rule: CatalogAutoImportStatusRule,
    scopes: readonly DirtyScope[],
    signal: AbortSignal,
    limit?: number,
  ) => Promise<readonly unknown[] | CatalogAutoImportCandidatePage>;
  readonly observe: (
    rootId: RootId,
    relativePath: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly schedule?: (delayMs: number, callback: () => void) => CatalogAutoImportMonitorTimer;
}

export interface CatalogAutoImportCandidatePage {
  readonly candidates: readonly CatalogAutoImportMonitorCandidate[];
  readonly overflowed: boolean;
  readonly degraded?: boolean;
}

export interface CatalogAutoImportMonitorTimer {
  readonly cancel: () => void;
}

export interface CatalogAutoImportMonitorOptions {
  readonly catalogId: CatalogId;
  readonly controller: CatalogAutoImportController;
  readonly ports: CatalogAutoImportMonitorPorts;
  readonly maxPending?: number;
  readonly maxCandidates?: number;
  readonly drainLimit?: number;
  readonly now?: () => number;
}

interface PendingGate {
  readonly key: string;
  readonly relativePath: string;
  readonly first: AutoImportFileObservation | null;
  readonly unreadableRetries: number;
  readonly scheduledAt: number;
  readonly generation: number;
  timer: CatalogAutoImportMonitorTimer | null;
}

interface SerialQueue {
  current: Promise<void>;
}

interface MonitorScopeSet {
  readonly rootId: RootId | null;
  readonly scopes: readonly DirtyScope[];
}

function defaultSchedule(delayMs: number, callback: () => void): CatalogAutoImportMonitorTimer {
  const timer = setTimeout(callback, delayMs);
  return { cancel: () => clearTimeout(timer) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${label} contains unexpected fields.`);
  }
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > DEFAULT_MAX_CANDIDATES) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function pathIsWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function candidateKey(rootId: RootId, relativePath: string): string {
  return `${rootId}\u0000${relativePath}`;
}

function parseCandidate(value: unknown): CatalogAutoImportMonitorCandidate {
  if (!isRecord(value)) throw new Error("Auto Import monitor candidate is invalid.");
  exactKeys(value, ["rootId", "relativePath"], "Auto Import monitor candidate");
  return {
    rootId: parseRootId(value.rootId),
    relativePath: parseRelativePath(value.relativePath),
  };
}

function parseObservation(value: unknown): AutoImportFileObservation {
  if (!isRecord(value)) throw new Error("Auto Import monitor observation is invalid.");
  exactKeys(value, ["relativePath", "observation", "readable"], "Auto Import monitor observation");
  if (typeof value.readable !== "boolean") throw new Error("Auto Import monitor readability is invalid.");
  return {
    relativePath: normalizeAutoImportRelativePath(parseRelativePath(value.relativePath)),
    observation: parseFileObservation(value.observation),
    readable: value.readable,
  };
}

function normalizeRulePath(value: string): string {
  return normalizeAutoImportRelativePath(parseRelativePath(value));
}

function configuredRule(status: CatalogAutoImportStatus): CatalogAutoImportStatusRule | null {
  if (status.state !== "ready" || status.rule === null || !status.rule.enabled || status.paused) return null;
  return status.rule;
}

function sameRuleSnapshot(left: CatalogAutoImportStatusRule, right: CatalogAutoImportStatusRule): boolean {
  return left.ruleId === right.ruleId &&
    left.ingressRootId === right.ingressRootId &&
    left.ingressRelativePath === right.ingressRelativePath &&
    left.destinationRootId === right.destinationRootId &&
    left.destinationRelativePath === right.destinationRelativePath &&
    left.presetId === right.presetId &&
    left.presetVersion === right.presetVersion &&
    left.presetSha256 === right.presetSha256 &&
    left.duplicatePolicy === right.duplicatePolicy &&
    left.destinationConflictPolicy === right.destinationConflictPolicy &&
    left.stabilityMs === right.stabilityMs &&
    left.maxAttempts === right.maxAttempts &&
    left.retryBackoffMs === right.retryBackoffMs &&
    left.enabled === right.enabled;
}

export class CatalogAutoImportMonitor {
  private readonly catalogId: CatalogId;
  private readonly controller: CatalogAutoImportController;
  private readonly ports: CatalogAutoImportMonitorPorts;
  private readonly schedule: (delayMs: number, callback: () => void) => CatalogAutoImportMonitorTimer;
  private readonly maxPending: number;
  private readonly maxCandidates: number;
  private readonly drainLimit: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingGate>();
  private readonly handled = new Map<string, AutoImportFileObservation["observation"]>();
  private readonly serial: SerialQueue = { current: Promise.resolve() };
  private drainSerial: Promise<void> = Promise.resolve();
  private retryTimer: CatalogAutoImportMonitorTimer | null = null;
  private retryDueAt: number | null = null;
  private abortController = new AbortController();
  private started = false;
  private closed = false;
  private generation = 0;
  private enumerationOverflowed = false;
  private enumerationDegraded = false;
  private overflowTimer: CatalogAutoImportMonitorTimer | null = null;
  private overflowOffset = 0;

  public constructor(options: CatalogAutoImportMonitorOptions) {
    this.catalogId = parseCatalogId(options.catalogId);
    this.controller = options.controller;
    this.ports = options.ports;
    this.schedule = options.ports.schedule ?? defaultSchedule;
    this.maxPending = positiveBound(options.maxPending, DEFAULT_MAX_PENDING, "Auto Import pending bound");
    this.maxCandidates = positiveBound(options.maxCandidates, DEFAULT_MAX_CANDIDATES, "Auto Import candidate bound");
    this.drainLimit = positiveBound(options.drainLimit, DEFAULT_DRAIN_LIMIT, "Auto Import drain bound");
    this.now = options.now ?? Date.now;
  }

  public async start(): Promise<void> {
    if (this.closed) throw new Error("Auto Import monitor is closed.");
    if (this.started) return;
    this.started = true;
    await this.refresh();
  }

  public get hasEnumerationOverflow(): boolean {
    return this.enumerationOverflowed;
  }

  public get hasEnumerationDegraded(): boolean {
    return this.enumerationDegraded;
  }

  public async refresh(): Promise<void> {
    if (this.closed) return;
    await this.serialize(async () => {
      if (this.closed) return;
      try {
        this.enumerationOverflowed = false;
        this.enumerationDegraded = false;
        this.clearOverflowTimer();
        const status = await this.controller.status();
        await this.drainQueued();
        const rule = configuredRule(status);
        this.clearPending();
        if (rule !== null) {
          await this.reconcileInternal({ rootId: rule.ingressRootId, scopes: [{ kind: "root" }] });
        }
      } catch {
        // A failed native enumeration is retried by a later reconciliation hint.
      }
    });
  }

  public async reconcile(scopes: readonly DirtyScope[]): Promise<void>;
  public async reconcile(rootId: RootId, scopes: readonly DirtyScope[]): Promise<void>;
  public async reconcile(
    first: RootId | readonly DirtyScope[],
    second?: readonly DirtyScope[],
  ): Promise<void> {
    if (this.closed) return;
    const scopeSet: MonitorScopeSet = Array.isArray(first)
      ? { rootId: null, scopes: first }
      : { rootId: parseRootId(first), scopes: second ?? [] };
    await this.serialize(async () => {
      if (this.closed) return;
      try {
        await this.reconcileInternal(scopeSet);
      } catch {
        // Reconciliation is best-effort. Native errors are intentionally path-free.
      }
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.clearPending();
    this.clearRetryTimer();
    this.clearOverflowTimer();
  }

  public async waitForIdle(): Promise<void> {
    await this.drainSerial;
  }

  public async drain(): Promise<void> {
    if (this.closed) return;
    await this.drainQueued();
  }

  private async reconcileInternal(scopeSet: MonitorScopeSet): Promise<void> {
    if (this.closed) return;
    const status = await this.controller.status();
    const rule = configuredRule(status);
    if (rule === null || (scopeSet.rootId !== null && scopeSet.rootId !== rule.ingressRootId)) return;
    const ingressPath = normalizeRulePath(rule.ingressRelativePath);
    const scopes = this.collapseScopes(scopeSet.scopes);
    if (scopes.length === 0) return;
    const hasRootScope = scopes.some((scope) => scope.kind === "root");
    let candidates = await this.collectCandidates(rule, ingressPath, scopes, hasRootScope);
    if (candidates.length > this.maxCandidates) {
      const start = this.overflowOffset % candidates.length;
      const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
      this.overflowOffset = (start + this.maxCandidates) % candidates.length;
      candidates = rotated.slice(0, this.maxCandidates);
    }
    const overflow = await this.processCandidates(rule, candidates);
    if (overflow || (this.enumerationOverflowed && !this.enumerationDegraded)) this.scheduleOverflowRefresh(rule);
    if (overflow) {
      this.clearPending();
      const refreshed = await this.enumerate(rule, null);
      await this.processCandidates(rule, refreshed.slice(0, this.maxCandidates), true);
    }
  }

  private collapseScopes(scopes: readonly DirtyScope[]): readonly DirtyScope[] {
    let root = false;
    const paths = new Set<string>();
    for (const rawScope of scopes) {
      const scope = parseDirtyScope(rawScope);
      if (scope.kind === "root") {
        root = true;
      } else {
        paths.add(scope.relativePath);
      }
    }
    if (root) return [{ kind: "root" }];
    return [...paths].sort().map((relativePath) => ({ kind: "path", relativePath }));
  }

  private async collectCandidates(
    rule: CatalogAutoImportStatusRule,
    ingressPath: string,
    scopes: readonly DirtyScope[],
    hasRootScope: boolean,
  ): Promise<readonly CatalogAutoImportMonitorCandidate[]> {
    const candidates = new Map<string, CatalogAutoImportMonitorCandidate>();
    if (hasRootScope) {
      for (const candidate of await this.enumerate(rule, null)) {
        this.addCandidate(candidates, candidate, rule.ingressRootId, ingressPath);
      }
    } else {
      for (const scope of scopes.slice(0, this.maxCandidates)) {
        if (scope.kind !== "path" || !pathIsWithin(ingressPath, scope.relativePath)) continue;
        const scopedCandidates = await this.enumerate(rule, scope.relativePath);
        if (scopedCandidates.length === 0) {
          this.addCandidate(candidates, { rootId: rule.ingressRootId, relativePath: scope.relativePath }, rule.ingressRootId, ingressPath);
        } else {
          for (const candidate of scopedCandidates) {
            this.addCandidate(candidates, candidate, rule.ingressRootId, ingressPath);
          }
        }
        if (candidates.size >= this.maxCandidates) break;
      }
    }
    return [...candidates.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private async enumerate(
    rule: CatalogAutoImportStatusRule,
    relativePath: string | null,
  ): Promise<readonly CatalogAutoImportMonitorCandidate[]> {
    if (this.closed) return [];
    try {
      const result: CatalogAutoImportMonitorCandidate[] = [];
      const scopes = relativePath === null
        ? [{ kind: "root" } satisfies DirtyScope]
        : [{ kind: "path", relativePath } satisfies DirtyScope];
      let complete = false;
      for (let pageIndex = 0; pageIndex < MAX_ENUMERATION_PAGES; pageIndex += 1) {
        const page = await this.ports.listCandidates(rule, scopes, this.abortController.signal, this.maxCandidates);
        let values: readonly unknown[];
        if (Array.isArray(page)) {
          values = page;
        } else if (isRecord(page) && Array.isArray(page.candidates) && typeof page.overflowed === "boolean") {
          values = page.candidates;
          if (page.overflowed) this.enumerationOverflowed = true;
          if (page.degraded === true) this.enumerationDegraded = true;
        } else {
          return result;
        }
        for (const value of values) {
          try {
            result.push(parseCandidate(value));
          } catch {
            // Ignore malformed candidates from a native adapter.
          }
        }
        if (Array.isArray(page) || !isRecord(page) || page.overflowed === false || page.degraded === true) {
          complete = true;
          break;
        }
      }
      if (!complete && this.enumerationOverflowed && !this.enumerationDegraded) {
        this.enumerationDegraded = true;
      }
      return result;
    } catch {
      return [];
    }
  }

  private addCandidate(
    candidates: Map<string, CatalogAutoImportMonitorCandidate>,
    candidate: CatalogAutoImportMonitorCandidate,
    expectedRootId: RootId,
    ingressPath: string,
  ): void {
    if (candidate.rootId !== expectedRootId) return;
    const relativePath = normalizeRulePath(candidate.relativePath);
    if (!pathIsWithin(ingressPath, relativePath)) return;
    const normalized = { rootId: candidate.rootId, relativePath };
    candidates.set(candidateKey(normalized.rootId, normalized.relativePath), normalized);
  }

  private async processCandidates(
    rule: CatalogAutoImportStatusRule,
    candidates: readonly CatalogAutoImportMonitorCandidate[],
    ignoreOverflow = false,
  ): Promise<boolean> {
    let overflow = false;
    for (const candidate of candidates.slice(0, this.maxCandidates + 1)) {
      if (this.closed) return false;
      const key = candidateKey(candidate.rootId, candidate.relativePath);
      if (!this.pending.has(key) && this.pending.size >= this.maxPending) {
        overflow = true;
        if (!ignoreOverflow) break;
        continue;
      }
      this.cancelPending(key);
      const first = await this.observeCandidate(candidate);
      const readableFirst = first !== null && first.readable ? first : null;
      const handledObservation = this.handled.get(key);
      if (readableFirst !== null && handledObservation !== undefined && sameFileObservation(handledObservation, readableFirst.observation)) {
        continue;
      }
      if (this.closed) return false;
      const pending: PendingGate = {
        key,
        relativePath: candidate.relativePath,
        first: readableFirst,
        unreadableRetries: readableFirst === null ? 1 : 0,
        scheduledAt: this.now(),
        generation: ++this.generation,
        timer: null,
      };
      this.pending.set(key, pending);
      pending.timer = this.scheduleGate(rule.stabilityMs, () => {
        void this.firePending(pending, rule).catch(() => undefined);
      });
    }
    return overflow;
  }

  private async observeCandidate(
    candidate: CatalogAutoImportMonitorCandidate,
  ): Promise<AutoImportFileObservation | null> {
    if (this.closed) return null;
    try {
      const parsed = parseObservation(await this.ports.observe(
        candidate.rootId,
        candidate.relativePath,
        this.abortController.signal,
      ));
      if (parsed.relativePath !== candidate.relativePath) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async firePending(entry: PendingGate, rule: CatalogAutoImportStatusRule): Promise<void> {
    if (this.closed || this.pending.get(entry.key) !== entry) return;
    const remaining = entry.scheduledAt + rule.stabilityMs - this.now();
    if (remaining > 0) {
      entry.timer = this.schedule(remaining, () => {
        void this.firePending(entry, rule).catch(() => undefined);
      });
      return;
    }
    const status = await this.controller.status().catch(() => null);
    const currentRule = status === null ? null : configuredRule(status);
    if (
      this.closed ||
      currentRule === null ||
      !sameRuleSnapshot(currentRule, rule) ||
      this.pending.get(entry.key) !== entry
    ) {
      this.cancelPending(entry.key);
      return;
    }
    const second = await this.observeCandidate({
      rootId: rule.ingressRootId,
      relativePath: entry.relativePath,
    });
    if (entry.first === null) {
      if (second !== null && second.readable) {
        this.reschedulePending(entry, second, rule);
      } else {
        this.rescheduleUnreadableOrDrop(entry, rule);
      }
      return;
    }
    if (second === null || !second.readable) {
      this.rescheduleUnreadableOrDrop(entry, rule);
      return;
    }
    if (!isStableAutoImportFile({ first: entry.first, second }, rule.stabilityMs)) {
      this.reschedulePending(entry, second, rule);
      return;
    }
    this.cancelPending(entry.key);
    if (this.closed) return;
    try {
      await this.controller.observe(entry.first, second);
      this.handled.set(entry.key, second.observation);
      await this.drainQueued();
    } catch {
      // The controller owns durable failure state. Do not expose native errors here.
    }
  }

  private cancelPending(key: string): void {
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    entry.timer?.cancel();
    this.pending.delete(key);
  }

  private reschedulePending(
    entry: PendingGate,
    first: AutoImportFileObservation | null,
    rule: CatalogAutoImportStatusRule,
    unreadableRetries = first === null ? entry.unreadableRetries + 1 : 0,
  ): void {
    if (this.closed || this.pending.get(entry.key) !== entry) return;
    entry.timer?.cancel();
    const replacement: PendingGate = {
      key: entry.key,
      relativePath: entry.relativePath,
      first,
      unreadableRetries,
      scheduledAt: this.now(),
      generation: ++this.generation,
      timer: null,
    };
    this.pending.set(entry.key, replacement);
    replacement.timer = this.scheduleGate(rule.stabilityMs, () => {
      void this.firePending(replacement, rule).catch(() => undefined);
    });
  }

  private rescheduleUnreadableOrDrop(entry: PendingGate, rule: CatalogAutoImportStatusRule): void {
    const unreadableRetries = entry.unreadableRetries + 1;
    if (unreadableRetries >= MAX_UNREADABLE_GATE_RETRIES) {
      this.cancelPending(entry.key);
      return;
    }
    this.reschedulePending(entry, entry.first, rule, unreadableRetries);
  }

  private scheduleGate(delayMs: number, callback: () => void): CatalogAutoImportMonitorTimer {
    return this.schedule(Math.max(1, delayMs), callback);
  }

  private clearPending(): void {
    for (const entry of this.pending.values()) entry.timer?.cancel();
    this.pending.clear();
  }

  private scheduleOverflowRefresh(rule: CatalogAutoImportStatusRule): void {
    if (this.closed || this.overflowTimer !== null) return;
    this.overflowTimer = this.scheduleGate(Math.max(rule.stabilityMs, 1_000), () => {
      this.overflowTimer = null;
      void this.refresh();
    });
  }

  private clearOverflowTimer(): void {
    this.overflowTimer?.cancel();
    this.overflowTimer = null;
  }

  private drainQueued(): Promise<void> {
    const next = this.drainSerial.then(async () => {
      if (this.closed) return;
      try {
        await this.controller.drain({ maxItems: this.drainLimit });
      } catch {
        // A later hint or startup pass can retry the durable queue.
      }
      await this.scheduleRetryTimer();
    });
    this.drainSerial = next.then(() => undefined, () => undefined);
    return next;
  }

  private async scheduleRetryTimer(): Promise<void> {
    if (this.closed) return;
    let status: CatalogAutoImportStatus;
    try {
      status = await this.controller.status();
    } catch {
      return;
    }
    const rule = configuredRule(status);
    const retryAt = rule === null
      ? null
      : status.items
        .map((item) => {
          if (item.state === "queued") return { queueId: item.queueId, dueAt: item.nextAttemptAt };
          if (item.state === "claimed" && item.leaseUntil !== null) return { queueId: item.queueId, dueAt: item.leaseUntil };
          return null;
        })
        .flatMap((item) => item === null ? [] : [item])
        .sort((left, right) => left.dueAt - right.dueAt || left.queueId.localeCompare(right.queueId))[0] ?? null;
    if (retryAt === null) {
      this.clearRetryTimer();
      return;
    }
    const dueAt = retryAt.dueAt;
    if (this.retryTimer !== null && this.retryDueAt === dueAt) return;
    this.clearRetryTimer();
    this.retryDueAt = dueAt;
    this.retryTimer = this.scheduleGate(Math.max(1, dueAt - this.now()), () => {
      this.retryTimer = null;
      this.retryDueAt = null;
      void this.drainQueued();
    });
  }

  private clearRetryTimer(): void {
    this.retryTimer?.cancel();
    this.retryTimer = null;
    this.retryDueAt = null;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.current.then(operation, operation);
    this.serial.current = next.then(() => undefined, () => undefined);
    return next;
  }
}
