import {
  parseCatalogId,
  parseOperationId,
  parsePresetId,
  parseRootId,
  type CatalogId,
  type OperationId,
  type PresetId,
  type RootId,
} from "../catalog/ids.ts";
import { sameFileObservation, type FileObservation } from "./domain.ts";

type RuleId = string & { readonly __brand: "AutoImportRuleId" };

export type AutoImportRuleState = "enabled" | "disabled";
export type AutoImportQueueState = "queued" | "claimed" | "completed" | "failed" | "cancelled";
export type AutoImportDuplicatePolicy =
  | "skip-incoming"
  | "continue-unchecked"
  | "keep-both"
  | "use-existing-location";
export type AutoImportDestinationConflictPolicy = "skip" | "replace" | "rename";

export interface AutoImportRule {
  readonly catalogId: CatalogId;
  readonly ruleId: RuleId;
  readonly ingressRootId: RootId;
  readonly ingressRelativePath: string;
  readonly destinationRootId: RootId;
  readonly destinationRelativePath: string;
  readonly placement: "copy";
  readonly presetId: PresetId;
  readonly presetVersion: number;
  readonly presetSha256: string;
  readonly duplicatePolicy: AutoImportDuplicatePolicy;
  readonly destinationConflictPolicy: AutoImportDestinationConflictPolicy;
  readonly enabled: boolean;
  readonly stabilityMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

export interface AutoImportFileObservation {
  readonly relativePath: string;
  readonly observation: FileObservation;
  readonly readable: boolean;
}

export interface AutoImportQueueItem {
  readonly queueId: OperationId;
  readonly catalogId: CatalogId;
  readonly ruleId: RuleId;
  readonly relativePath: string;
  readonly placement: "copy";
  readonly observation: FileObservation;
  readonly dedupeKey: string;
  readonly state: AutoImportQueueState;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** A catalog-apply acknowledgement was ambiguous; recovery may exceed the normal attempt limit. */
  readonly recoveryRequired?: boolean;
  readonly retryBackoffMs: number;
  readonly nextAttemptAt: number;
  readonly leaseUntil: number | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StableFileGateInput {
  readonly first: AutoImportFileObservation;
  readonly second: AutoImportFileObservation;
}

export interface AutoImportExecutor {
  execute(item: AutoImportQueueItem): Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAutoImportRuleId(value: unknown): RuleId {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Auto Import rule ID is invalid.");
  }
  return value.toLowerCase() as RuleId;
}

export function normalizeAutoImportRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("Auto Import path must be relative.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Auto Import path contains an invalid segment.");
  }
  return segments.join("/");
}

function pathContains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseAutoImportDuplicatePolicy(value: unknown): AutoImportDuplicatePolicy {
  if (
    value !== "skip-incoming" &&
    value !== "continue-unchecked" &&
    value !== "keep-both" &&
    value !== "use-existing-location"
  ) {
    throw new Error("Auto Import duplicate policy is invalid.");
  }
  return value;
}

function parseAutoImportDestinationConflictPolicy(value: unknown): AutoImportDestinationConflictPolicy {
  if (value !== "skip" && value !== "replace" && value !== "rename") {
    throw new Error("Auto Import destination conflict policy is invalid.");
  }
  return value;
}

export function validateAutoImportRules(rules: readonly AutoImportRule[]): void {
  const enabledByCatalog = new Set<CatalogId>();
  for (const rule of rules) {
    const ingressPath = normalizeAutoImportRelativePath(rule.ingressRelativePath);
    const destinationPath = normalizeAutoImportRelativePath(rule.destinationRelativePath);
    if (rule.placement !== "copy") {
      throw new Error("Auto Import placement must be Copy.");
    }
    if (rule.stabilityMs < 0 || !Number.isSafeInteger(rule.stabilityMs)) {
      throw new Error("Auto Import stability interval is invalid.");
    }
    if (rule.maxAttempts < 1 || !Number.isSafeInteger(rule.maxAttempts)) {
      throw new Error("Auto Import attempt limit is invalid.");
    }
    if (rule.retryBackoffMs < 0 || !Number.isSafeInteger(rule.retryBackoffMs)) {
      throw new Error("Auto Import retry backoff is invalid.");
    }
    if (!Number.isSafeInteger(rule.presetVersion) || rule.presetVersion < 0) {
      throw new Error("Auto Import preset version is invalid.");
    }
    if (!isSha256(rule.presetSha256)) {
      throw new Error("Auto Import preset snapshot hash is invalid.");
    }
    parseAutoImportDuplicatePolicy(rule.duplicatePolicy);
    parseAutoImportDestinationConflictPolicy(rule.destinationConflictPolicy);
    if (rule.enabled) {
      if (enabledByCatalog.has(rule.catalogId)) {
        throw new Error("Only one enabled Auto Import rule is allowed per catalog.");
      }
      enabledByCatalog.add(rule.catalogId);
    }
    if (
      rule.ingressRootId === rule.destinationRootId &&
      (pathContains(ingressPath, destinationPath) || pathContains(destinationPath, ingressPath))
    ) {
      throw new Error("Auto Import ingress and destination may not overlap.");
    }
  }
}

export function isStableAutoImportFile(input: StableFileGateInput, minimumStableMs = 0): boolean {
  return (
    input.first.readable &&
    input.second.readable &&
    normalizeAutoImportRelativePath(input.first.relativePath) ===
      normalizeAutoImportRelativePath(input.second.relativePath) &&
    sameFileObservation(input.first.observation, input.second.observation) &&
    input.second.observation.observedAt - input.first.observation.observedAt >= minimumStableMs
  );
}

function dedupeKey(relativePath: string, observation: FileObservation): string {
  return `${normalizeAutoImportRelativePath(relativePath)}\u0000${observation.size}\u0000${observation.modifiedAt}\u0000${observation.localFileId ?? ""}`;
}

function cloneItem(item: AutoImportQueueItem): AutoImportQueueItem {
  return structuredClone(item);
}

function canTransition(
  from: AutoImportQueueState,
  to: AutoImportQueueState,
): boolean {
  if (from === "queued") return to === "claimed" || to === "cancelled";
  if (from === "claimed") {
    return to === "claimed" || to === "queued" || to === "failed" ||
      to === "completed" || to === "cancelled";
  }
  if (from === "failed") return to === "queued";
  return false;
}

function transitionItem(
  item: AutoImportQueueItem,
  state: AutoImportQueueState,
  updates: Partial<AutoImportQueueItem> = {},
): AutoImportQueueItem {
  if (!canTransition(item.state, state)) {
    throw new Error(`Illegal Auto Import queue transition: ${item.state} -> ${state}.`);
  }
  return { ...item, ...updates, state };
}

export class AutoImportQueue {
  private readonly items = new Map<OperationId, AutoImportQueueItem>();
  private paused = false;

  constructor(items: readonly unknown[] = []) {
    for (const rawItem of items) {
      const item = parseAutoImportQueueItem(rawItem);
      if (this.items.has(item.queueId)) {
        throw new Error("Auto Import queue contains a duplicate queue ID.");
      }
      const duplicate = [...this.items.values()].find(
        (existing) => existing.dedupeKey === item.dedupeKey,
      );
      if (duplicate !== undefined) {
        if (duplicate.state !== "cancelled" || item.state === "cancelled") {
          continue;
        }
        this.items.delete(duplicate.queueId);
      }
      this.items.set(item.queueId, cloneItem(item));
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  list(): readonly AutoImportQueueItem[] {
    return [...this.items.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((item) => cloneItem(item));
  }

  enqueue(
    rule: AutoImportRule,
    gate: StableFileGateInput,
    now = Date.now(),
  ): AutoImportQueueItem | null {
    if (!rule.enabled || this.paused || !isStableAutoImportFile(gate, rule.stabilityMs)) {
      return null;
    }
    if (!pathContains(normalizeAutoImportRelativePath(rule.ingressRelativePath), normalizeAutoImportRelativePath(gate.second.relativePath))) {
      return null;
    }
    const observation = gate.second;
    const normalizedPath = normalizeAutoImportRelativePath(observation.relativePath);
    const key = dedupeKey(normalizedPath, observation.observation);
    const existing = this.list().find((item) => item.dedupeKey === key);
    if (existing !== undefined && existing.state !== "cancelled") return existing;
    if (existing?.state === "cancelled") this.items.delete(existing.queueId);
  const item: AutoImportQueueItem = {
      queueId: parseOperationId(cryptoRandomUuid()),
      catalogId: rule.catalogId,
      ruleId: rule.ruleId,
      relativePath: normalizedPath,
      placement: "copy",
      observation: observation.observation,
      dedupeKey: key,
      state: "queued",
    attempts: 0,
    maxAttempts: rule.maxAttempts,
    recoveryRequired: false,
      retryBackoffMs: rule.retryBackoffMs,
      nextAttemptAt: now,
      leaseUntil: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.queueId, item);
    return cloneItem(item);
  }

  claimNext(now = Date.now(), leaseMs = 30_000): AutoImportQueueItem | null {
    if (!Number.isSafeInteger(now) || !Number.isFinite(leaseMs) || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Auto Import lease bounds are invalid.");
    }
    if (now + leaseMs > Number.MAX_SAFE_INTEGER) {
      throw new Error("Auto Import lease exceeds safe bounds.");
    }
    if (this.paused) {
      return null;
    }
    for (const item of this.items.values()) {
      if (
        item.state === "claimed" &&
        (item.leaseUntil ?? 0) <= now &&
        item.attempts >= item.maxAttempts &&
        item.recoveryRequired !== true
      ) {
        this.items.set(
          item.queueId,
          transitionItem(item, "failed", { leaseUntil: null, updatedAt: now }),
        );
      }
    }
    const candidate = this.list().find(
      (item) =>
        (item.state === "queued" || (item.state === "claimed" && (item.leaseUntil ?? 0) <= now)) &&
        item.nextAttemptAt <= now &&
        (item.attempts < item.maxAttempts || item.recoveryRequired === true),
    );
    if (candidate === undefined) {
      return null;
    }
    const claimed = transitionItem(candidate, "claimed", {
      attempts: candidate.recoveryRequired === true ? candidate.attempts : candidate.attempts + 1,
      leaseUntil: now + leaseMs,
      updatedAt: now,
    });
    this.items.set(candidate.queueId, claimed);
    return cloneItem(claimed);
  }

  complete(queueId: OperationId, now = Date.now()): void {
    this.update(queueId, (item) => transitionItem(item, "completed", {
      leaseUntil: null,
      updatedAt: now,
      error: null,
      recoveryRequired: false,
    }));
  }

  fail(queueId: OperationId, error: string, rule: AutoImportRule, now = Date.now()): void {
    this.update(queueId, (item) => {
      if (rule.ruleId !== item.ruleId) {
        throw new Error("Auto Import rule does not own this queue item.");
      }
      if (item.recoveryRequired === true) {
        return transitionItem(item, "queued", {
          leaseUntil: null,
          nextAttemptAt: now + item.retryBackoffMs * Math.max(1, item.attempts),
          updatedAt: now,
          error,
          recoveryRequired: true,
        });
      }
      const terminal = item.attempts >= item.maxAttempts;
      return transitionItem(item, terminal ? "failed" : "queued", {
        leaseUntil: null,
        nextAttemptAt: terminal ? now : now + item.retryBackoffMs * Math.max(1, item.attempts),
        updatedAt: now,
        error,
      });
    });
  }

  recover(queueId: OperationId, error: string, now = Date.now()): void {
    this.update(queueId, (item) => transitionItem(item, "queued", {
      leaseUntil: null,
      nextAttemptAt: now + item.retryBackoffMs * Math.max(1, item.attempts),
      updatedAt: now,
      error,
      recoveryRequired: true,
    }));
  }

  cancel(queueId: OperationId, now = Date.now()): void {
    this.update(queueId, (item) => transitionItem(item, "cancelled", {
      leaseUntil: null,
      updatedAt: now,
    }));
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  disable(ruleId: RuleId, now = Date.now()): void {
    for (const item of this.items.values()) {
      if (item.ruleId === ruleId && (item.state === "queued" || item.state === "claimed")) {
        this.items.set(item.queueId, transitionItem(item, "cancelled", {
          leaseUntil: null,
          updatedAt: now,
        }));
      }
    }
  }

  retryFailed(now = Date.now()): void {
    for (const item of [...this.items.values()]) {
      if (item.state === "failed") {
        const replacement: AutoImportQueueItem = {
          ...item,
          queueId: parseOperationId(cryptoRandomUuid()),
          state: "queued",
          attempts: 0,
          nextAttemptAt: now,
          leaseUntil: null,
          error: null,
          recoveryRequired: false,
          createdAt: now,
          updatedAt: now,
        };
        this.items.delete(item.queueId);
        this.items.set(replacement.queueId, replacement);
      }
    }
  }

  clearFailed(): void {
    for (const [queueId, item] of this.items.entries()) {
      if (item.state === "failed") {
        this.items.delete(queueId);
      }
    }
  }

  private update(queueId: OperationId, update: (item: AutoImportQueueItem) => AutoImportQueueItem): void {
    const item = this.items.get(queueId);
    if (item === undefined) {
      throw new Error("Auto Import queue item does not exist.");
    }
    this.items.set(queueId, update(item));
  }
}

function cryptoRandomUuid(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  throw new Error("Secure UUID generation is unavailable.");
}

export function parseAutoImportRule(value: unknown): AutoImportRule {
  if (
    !isRecord(value) ||
    typeof value.ingressRelativePath !== "string" ||
    typeof value.destinationRelativePath !== "string" ||
    value.placement !== "copy" ||
    typeof value.enabled !== "boolean" ||
    typeof value.stabilityMs !== "number" ||
    typeof value.maxAttempts !== "number" ||
    typeof value.retryBackoffMs !== "number"
  ) {
    throw new Error("Auto Import rule is invalid.");
  }
  const presetVersion = value.presetVersion;
  const presetSha256 = value.presetSha256;
  if (typeof presetVersion !== "number" || !Number.isSafeInteger(presetVersion) || presetVersion < 0 || !isSha256(presetSha256)) {
    throw new Error("Auto Import preset snapshot is invalid.");
  }
  const rule: AutoImportRule = {
    catalogId: parseCatalogId(value.catalogId),
    ruleId: parseAutoImportRuleId(value.ruleId),
    ingressRootId: parseRootId(value.ingressRootId),
    ingressRelativePath: normalizeAutoImportRelativePath(value.ingressRelativePath),
    destinationRootId: parseRootId(value.destinationRootId),
    destinationRelativePath: normalizeAutoImportRelativePath(value.destinationRelativePath),
    placement: "copy",
    presetId: parsePresetId(value.presetId),
    presetVersion,
    presetSha256,
    duplicatePolicy: parseAutoImportDuplicatePolicy(value.duplicatePolicy),
    destinationConflictPolicy: parseAutoImportDestinationConflictPolicy(value.destinationConflictPolicy),
    enabled: value.enabled,
    stabilityMs: value.stabilityMs,
    maxAttempts: value.maxAttempts,
    retryBackoffMs: value.retryBackoffMs,
  };
  validateAutoImportRules([rule]);
  return rule;
}

export function parseAutoImportQueueItem(value: unknown): AutoImportQueueItem {
  if (
    !isRecord(value) ||
    typeof value.relativePath !== "string" ||
    value.placement !== "copy" ||
    typeof value.dedupeKey !== "string" ||
    typeof value.state !== "string" ||
    typeof value.attempts !== "number" ||
    typeof value.maxAttempts !== "number" ||
    typeof value.retryBackoffMs !== "number" ||
    typeof value.nextAttemptAt !== "number" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    throw new Error("Auto Import queue item is invalid.");
  }
  if (
    value.state !== "queued" &&
    value.state !== "claimed" &&
    value.state !== "completed" &&
    value.state !== "failed" &&
    value.state !== "cancelled"
  ) {
    throw new Error("Auto Import queue state is invalid.");
  }
  if (
    !Number.isSafeInteger(value.attempts) ||
    !Number.isSafeInteger(value.maxAttempts) ||
    !Number.isSafeInteger(value.retryBackoffMs) ||
    !Number.isFinite(value.nextAttemptAt) ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.updatedAt)
  ) {
    throw new Error("Auto Import queue timing fields are invalid.");
  }
  if (value.attempts < 0 || value.maxAttempts < 1 || value.attempts > value.maxAttempts || value.retryBackoffMs < 0) {
    throw new Error("Auto Import queue limits are invalid.");
  }
  const leaseUntil = value.leaseUntil === null ? null : value.leaseUntil;
  if (leaseUntil !== null && (typeof leaseUntil !== "number" || !Number.isFinite(leaseUntil))) {
    throw new Error("Auto Import queue lease is invalid.");
  }
  if (leaseUntil !== null && (!Number.isSafeInteger(leaseUntil) || leaseUntil < 0)) {
    throw new Error("Auto Import queue lease bounds are invalid.");
  }
  if (
    (value.state === "claimed" && leaseUntil === null) ||
    (value.state !== "claimed" && leaseUntil !== null) ||
    (leaseUntil !== null && leaseUntil < value.updatedAt)
  ) {
    throw new Error("Auto Import queue lease bounds are invalid.");
  }
  if (value.error !== null && typeof value.error !== "string") {
    throw new Error("Auto Import queue error is invalid.");
  }
  const recoveryRequired = value.recoveryRequired === undefined ? false : value.recoveryRequired;
  if (typeof recoveryRequired !== "boolean") {
    throw new Error("Auto Import queue recovery state is invalid.");
  }
  const relativePath = normalizeAutoImportRelativePath(value.relativePath);
  const observation = parseFileObservation(value.observation);
  if (value.dedupeKey !== dedupeKey(relativePath, observation)) {
    throw new Error("Auto Import queue dedupe key is invalid.");
  }
  return {
    queueId: parseOperationId(value.queueId),
    catalogId: parseCatalogId(value.catalogId),
    ruleId: parseAutoImportRuleId(value.ruleId),
    relativePath,
    placement: "copy",
    observation,
    dedupeKey: value.dedupeKey,
    state: value.state,
    attempts: value.attempts,
    maxAttempts: value.maxAttempts,
    recoveryRequired,
    retryBackoffMs: value.retryBackoffMs,
    nextAttemptAt: value.nextAttemptAt,
    leaseUntil,
    error: value.error,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseFileObservation(value: unknown): FileObservation {
  if (!isRecord(value)) {
    throw new Error("Auto Import observation is invalid.");
  }
  const size = value.size;
  const modifiedAt = value.modifiedAt;
  const observedAt = value.observedAt;
  const localFileId = value.localFileId;
  if (
    typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
    typeof modifiedAt !== "number" || !Number.isFinite(modifiedAt) ||
    typeof observedAt !== "number" || !Number.isFinite(observedAt) ||
    (localFileId !== null && typeof localFileId !== "string")
  ) {
    throw new Error("Auto Import observation fields are invalid.");
  }
  return { size, modifiedAt, observedAt, localFileId };
}

export type AutoImportRuleId = RuleId;
