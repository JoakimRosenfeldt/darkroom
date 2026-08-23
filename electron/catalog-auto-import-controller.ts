import { createHash } from "node:crypto";
import path from "node:path";
import {
  createOperationId,
  parseCatalogId,
  parseOperationId,
  parsePresetId,
  parseRootId,
  type CatalogId,
  type OperationId,
  type PresetId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  canonicalJson,
  parseImportTemplate,
  parseJsonValue,
  type JsonValue,
  type ImportTemplate,
} from "../lib/import/domain.ts";
import {
  normalizeAutoImportRelativePath,
  parseAutoImportRuleId,
  parseFileObservation,
  validateAutoImportRules,
  type AutoImportDestinationConflictPolicy,
  type AutoImportDuplicatePolicy,
  type AutoImportFileObservation,
  type AutoImportQueueItem,
  type AutoImportRule,
  type AutoImportRuleId,
  type StableFileGateInput,
} from "../lib/import/auto-import.ts";
import {
  ImportOperationCancelledError,
  type ExecuteFrozenPlanOptions,
  type ImportOperationExecution,
} from "./import-operation-service.ts";
import { CatalogFaultInjectedError } from "./catalog-fault-injection.ts";
import {
  AutoImportStore,
  type AutoImportStoreState,
} from "./auto-import-store.ts";

const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_DRAIN_LIMIT = 100;
const MAX_DRAIN_LIMIT = 1_000;
const EXECUTION_FAILURE_CODE = "execution-failed";
const EXECUTION_FAILURE_MESSAGE = "Auto Import execution failed.";

export interface CatalogAutoImportRootSnapshot {
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly canonicalPath: string | null;
}

export interface CatalogAutoImportPresetSnapshot {
  readonly catalogId: CatalogId;
  readonly presetId: PresetId;
  readonly name: string;
  readonly version: number;
  readonly template: ImportTemplate;
  readonly payload: JsonValue;
  readonly updatedAt: number;
}

export interface CatalogAutoImportResolver {
  readonly resolveRoot: (input: {
    readonly catalogId: CatalogId;
    readonly rootId: RootId;
  }) => Promise<unknown>;
  readonly resolvePreset: (input: {
    readonly catalogId: CatalogId;
    readonly presetId: PresetId;
  }) => Promise<unknown>;
}

export interface CatalogAutoImportExecutor {
  readonly executeAutoImport: (
    item: AutoImportQueueItem,
    rule: AutoImportRule,
    options: ExecuteFrozenPlanOptions,
  ) => Promise<ImportOperationExecution>;
}

export interface CatalogAutoImportConfigureInput {
  readonly ingressRootId: RootId;
  readonly ingressRelativePath: string;
  readonly destinationRootId: RootId;
  readonly destinationRelativePath: string;
  readonly presetId: PresetId;
  readonly duplicatePolicy: AutoImportDuplicatePolicy;
  readonly destinationConflictPolicy: AutoImportDestinationConflictPolicy;
  readonly stabilityMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
  readonly enabled?: boolean;
}

export interface CatalogAutoImportDrainOptions {
  readonly maxItems?: number;
  readonly leaseMs?: number;
}

export interface CatalogAutoImportError {
  readonly code: typeof EXECUTION_FAILURE_CODE;
  readonly message: typeof EXECUTION_FAILURE_MESSAGE;
}

export interface CatalogAutoImportStatusRule {
  readonly ruleId: AutoImportRuleId;
  readonly enabled: boolean;
  readonly ingressRootId: RootId;
  readonly ingressRelativePath: string;
  readonly destinationRootId: RootId;
  readonly destinationRelativePath: string;
  readonly presetId: PresetId;
  readonly presetVersion: number;
  readonly presetSha256: string;
  readonly duplicatePolicy: AutoImportDuplicatePolicy;
  readonly destinationConflictPolicy: AutoImportDestinationConflictPolicy;
  readonly stabilityMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

export interface CatalogAutoImportStatusItem {
  readonly queueId: OperationId;
  readonly ruleId: AutoImportRuleId;
  readonly relativePath: string;
  readonly state: AutoImportQueueItem["state"];
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: number;
  readonly leaseUntil: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly error: CatalogAutoImportError | null;
}

export interface CatalogAutoImportStatusCounts {
  readonly total: number;
  readonly queued: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export type CatalogAutoImportControllerState = "unconfigured" | "disabled" | "paused" | "ready";

export interface CatalogAutoImportStatus {
  readonly catalogId: CatalogId;
  readonly state: CatalogAutoImportControllerState;
  readonly paused: boolean;
  readonly degraded: boolean;
  readonly rule: CatalogAutoImportStatusRule | null;
  readonly counts: CatalogAutoImportStatusCounts;
  readonly items: readonly CatalogAutoImportStatusItem[];
}

export interface CatalogAutoImportDrainResult {
  readonly queueId: OperationId;
  readonly state: AutoImportQueueItem["state"];
  readonly attempts: number;
  readonly error: CatalogAutoImportError | null;
}

export interface CatalogAutoImportControllerOptions {
  readonly catalogId: CatalogId;
  readonly store: AutoImportStore;
  readonly resolver: CatalogAutoImportResolver;
  readonly executor: CatalogAutoImportExecutor;
  readonly assertCurrentSession?: () => void | Promise<void>;
  readonly now?: () => number;
  readonly leaseMs?: number;
}

interface ParsedConfigureInput {
  readonly ingressRootId: RootId;
  readonly ingressRelativePath: string;
  readonly destinationRootId: RootId;
  readonly destinationRelativePath: string;
  readonly presetId: PresetId;
  readonly duplicatePolicy: AutoImportDuplicatePolicy;
  readonly destinationConflictPolicy: AutoImportDestinationConflictPolicy;
  readonly stabilityMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
  readonly enabled: boolean | undefined;
}

interface ParsedRootSnapshot {
  readonly rootId: RootId;
  readonly canonicalPath: string | null;
}

interface ParsedPresetSnapshot {
  readonly catalogId: CatalogId;
  readonly presetId: PresetId;
  readonly name: string;
  readonly version: number;
  readonly template: ImportTemplate;
  readonly payload: JsonValue;
  readonly updatedAt: number;
}

interface CancellationToken {
  cancelled: boolean;
}

interface ClaimedItem {
  readonly item: AutoImportQueueItem;
  readonly rule: AutoImportRule;
  readonly token: CancellationToken;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

interface SerialQueue {
  current: Promise<void>;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function duplicatePolicy(value: unknown): AutoImportDuplicatePolicy {
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

function destinationPolicy(value: unknown): AutoImportDestinationConflictPolicy {
  if (value !== "skip" && value !== "replace" && value !== "rename") {
    throw new Error("Auto Import destination conflict policy is invalid.");
  }
  return value;
}

function parseConfigureInput(value: unknown): ParsedConfigureInput {
  if (!isRecord(value)) throw new Error("Auto Import configuration is invalid.");
  const parsedDestinationConflictPolicy = destinationPolicy(value.destinationConflictPolicy);
  if (parsedDestinationConflictPolicy === "replace") {
    throw new Error("Auto Import Replace conflicts are unavailable.");
  }
  const parsedDuplicatePolicy = duplicatePolicy(value.duplicatePolicy);
  if (parsedDuplicatePolicy === "use-existing-location") {
    throw new Error("Auto Import use-existing-location duplicates are unavailable.");
  }
  return {
    ingressRootId: parseRootId(value.ingressRootId),
    ingressRelativePath: normalizeAutoImportRelativePath(requiredString(value.ingressRelativePath, "Auto Import ingress path")),
    destinationRootId: parseRootId(value.destinationRootId),
    destinationRelativePath: normalizeAutoImportRelativePath(requiredString(value.destinationRelativePath, "Auto Import destination path")),
    presetId: parsePresetId(value.presetId),
    duplicatePolicy: parsedDuplicatePolicy,
    destinationConflictPolicy: parsedDestinationConflictPolicy,
    stabilityMs: safeInteger(value.stabilityMs, "Auto Import stability interval"),
    maxAttempts: safeInteger(value.maxAttempts, "Auto Import attempt limit", 1),
    retryBackoffMs: safeInteger(value.retryBackoffMs, "Auto Import retry backoff"),
    enabled: optionalBoolean(value.enabled, "Auto Import enabled"),
  };
}

function parseRootSnapshot(value: unknown, catalogId: CatalogId, expectedRootId: RootId): ParsedRootSnapshot {
  if (!isRecord(value)) throw new Error("Auto Import root is invalid.");
  const rootId = parseRootId(value.rootId);
  if (rootId !== expectedRootId) throw new Error("Auto Import root does not match the requested root.");
  if (value.catalogId !== undefined && parseCatalogId(value.catalogId) !== catalogId) {
    throw new Error("Auto Import root belongs to another catalog.");
  }
  const canonicalPath = value.canonicalPath === undefined || value.canonicalPath === null
    ? null
    : requiredString(value.canonicalPath, "Auto Import root path");
  if (canonicalPath !== null && (!path.isAbsolute(canonicalPath) || path.normalize(canonicalPath) !== canonicalPath)) {
    throw new Error("Auto Import root path is invalid.");
  }
  return { rootId, canonicalPath };
}

function parsePresetSnapshot(value: unknown, catalogId: CatalogId, expectedPresetId: PresetId): ParsedPresetSnapshot {
  if (!isRecord(value)) throw new Error("Auto Import preset is invalid.");
  const presetId = parsePresetId(value.presetId);
  if (presetId !== expectedPresetId) throw new Error("Auto Import preset does not match the requested preset.");
  if (value.catalogId !== undefined && parseCatalogId(value.catalogId) !== catalogId) {
    throw new Error("Auto Import preset belongs to another catalog.");
  }
  const version = safeInteger(value.version ?? value.revision, "Auto Import preset version");
  const name = requiredString(value.name, "Auto Import preset name");
  const updatedAt = safeInteger(value.updatedAt, "Auto Import preset updatedAt");
  const livePayload = value.payload;
  const isLivePayload = isRecord(livePayload) &&
    livePayload.version === 1 &&
    "template" in livePayload &&
    "payload" in livePayload &&
    "isDefault" in livePayload;
  const template = parseImportTemplate(isLivePayload ? livePayload.template : value.template);
  const payload = isLivePayload ? livePayload.payload : livePayload;
  return {
    catalogId,
    presetId,
    name,
    version,
    template,
    payload: parseJsonValue(payload, "Auto Import preset payload"),
    updatedAt,
  };
}

function joinedRootPath(root: ParsedRootSnapshot, relativePath: string): string | null {
  if (root.canonicalPath === null) return null;
  return path.resolve(root.canonicalPath, ...relativePath.split("/"));
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertNoOverlap(
  ingressRoot: ParsedRootSnapshot,
  ingressRelativePath: string,
  destinationRoot: ParsedRootSnapshot,
  destinationRelativePath: string,
): void {
  if (ingressRoot.rootId === destinationRoot.rootId) {
    const ingressPath = normalizeAutoImportRelativePath(ingressRelativePath);
    const destinationPath = normalizeAutoImportRelativePath(destinationRelativePath);
    if (ingressPath === destinationPath || ingressPath.startsWith(`${destinationPath}/`) || destinationPath.startsWith(`${ingressPath}/`)) {
      throw new Error("Auto Import ingress and destination may not overlap.");
    }
  }
  const ingressAbsolute = joinedRootPath(ingressRoot, ingressRelativePath);
  const destinationAbsolute = joinedRootPath(destinationRoot, destinationRelativePath);
  if (
    ingressAbsolute !== null &&
    destinationAbsolute !== null &&
    (containsPath(ingressAbsolute, destinationAbsolute) || containsPath(destinationAbsolute, ingressAbsolute))
  ) {
    throw new Error("Auto Import ingress and destination may not overlap.");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameRuleConfiguration(left: AutoImportRule, right: AutoImportRule): boolean {
  return left.catalogId === right.catalogId &&
    left.ruleId === right.ruleId &&
    left.ingressRootId === right.ingressRootId &&
    left.ingressRelativePath === right.ingressRelativePath &&
    left.destinationRootId === right.destinationRootId &&
    left.destinationRelativePath === right.destinationRelativePath &&
    left.placement === right.placement &&
    left.presetId === right.presetId &&
    left.presetVersion === right.presetVersion &&
    left.presetSha256 === right.presetSha256 &&
    left.duplicatePolicy === right.duplicatePolicy &&
    left.destinationConflictPolicy === right.destinationConflictPolicy &&
    left.stabilityMs === right.stabilityMs &&
    left.maxAttempts === right.maxAttempts &&
    left.retryBackoffMs === right.retryBackoffMs;
}

function cloneRule(rule: AutoImportRule): AutoImportRule {
  return structuredClone(rule);
}

function sanitizedError(): CatalogAutoImportError {
  return { code: EXECUTION_FAILURE_CODE, message: EXECUTION_FAILURE_MESSAGE };
}

function statusError(value: string | null): CatalogAutoImportError | null {
  return value === null ? null : sanitizedError();
}

function counts(items: readonly AutoImportQueueItem[]): CatalogAutoImportStatusCounts {
  const result = { total: items.length, queued: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of items) result[item.state] += 1;
  return result;
}

function statusRule(rule: AutoImportRule): CatalogAutoImportStatusRule {
  return {
    ruleId: rule.ruleId,
    enabled: rule.enabled,
    ingressRootId: rule.ingressRootId,
    ingressRelativePath: rule.ingressRelativePath,
    destinationRootId: rule.destinationRootId,
    destinationRelativePath: rule.destinationRelativePath,
    presetId: rule.presetId,
    presetVersion: rule.presetVersion,
    presetSha256: rule.presetSha256,
    duplicatePolicy: rule.duplicatePolicy,
    destinationConflictPolicy: rule.destinationConflictPolicy,
    stabilityMs: rule.stabilityMs,
    maxAttempts: rule.maxAttempts,
    retryBackoffMs: rule.retryBackoffMs,
  };
}

function statusItem(item: AutoImportQueueItem): CatalogAutoImportStatusItem {
  return {
    queueId: item.queueId,
    ruleId: item.ruleId,
    relativePath: item.relativePath,
    state: item.state,
    attempts: item.attempts,
    maxAttempts: item.maxAttempts,
    nextAttemptAt: item.nextAttemptAt,
    leaseUntil: item.leaseUntil,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    error: statusError(item.error),
  };
}

function parseObservation(value: unknown): AutoImportFileObservation {
  if (!isRecord(value) || typeof value.relativePath !== "string" || typeof value.readable !== "boolean") {
    throw new Error("Auto Import file observation is invalid.");
  }
  return {
    relativePath: normalizeAutoImportRelativePath(value.relativePath),
    observation: parseFileObservation(value.observation),
    readable: value.readable,
  };
}

function parseGate(first: unknown, second: unknown): StableFileGateInput {
  return { first: parseObservation(first), second: parseObservation(second) };
}

function currentRule(state: AutoImportStoreState, catalogId: CatalogId): AutoImportRule | null {
  if (state.rules.length > 1) throw new Error("Auto Import state contains more than one rule.");
  for (const rule of state.rules) {
    if (rule.catalogId !== catalogId) throw new Error("Auto Import state belongs to another catalog.");
  }
  for (const item of state.queue.list()) {
    if (item.catalogId !== catalogId) throw new Error("Auto Import queue belongs to another catalog.");
  }
  return state.rules[0] ?? null;
}

function currentItem(state: AutoImportStoreState, queueId: OperationId): AutoImportQueueItem | null {
  return state.queue.list().find((item) => item.queueId === queueId) ?? null;
}

function validateClock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Auto Import clock value is invalid.");
  return value;
}

function validateLease(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_MS) {
    throw new Error("Auto Import lease duration is invalid.");
  }
  return value;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DRAIN_LIMIT) {
    throw new Error("Auto Import drain limit is invalid.");
  }
  return value;
}

export class CatalogAutoImportController {
  private readonly catalogId: CatalogId;
  private readonly store: AutoImportStore;
  private readonly resolver: CatalogAutoImportResolver;
  private readonly executor: CatalogAutoImportExecutor;
  private readonly assertCurrentSession: () => void | Promise<void>;
  private readonly nowSource: () => number;
  private readonly defaultLeaseMs: number;
  private readonly serial: SerialQueue = { current: Promise.resolve() };
  private readonly inFlight = new Map<OperationId, CancellationToken>();

  public constructor(options: CatalogAutoImportControllerOptions) {
    this.catalogId = parseCatalogId(options.catalogId);
    this.store = options.store;
    this.resolver = options.resolver;
    this.executor = options.executor;
    this.assertCurrentSession = options.assertCurrentSession ?? (() => undefined);
    this.nowSource = options.now ?? Date.now;
    this.defaultLeaseMs = validateLease(options.leaseMs ?? DEFAULT_LEASE_MS);
  }

  public async status(): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      await this.assertCurrentSession();
      return this.statusFromState(await this.loadState());
    });
  }

  public dispose(): void {
    this.cancelInFlight();
  }

  public async configure(input: unknown): Promise<AutoImportRule> {
    const parsed = parseConfigureInput(input);
    return this.serialize(async () => {
      await this.assertCurrentSession();
      const state = await this.loadState();
      const existing = currentRule(state, this.catalogId);
      const [ingressRoot, destinationRoot, presetValue] = await Promise.all([
        this.resolver.resolveRoot({ catalogId: this.catalogId, rootId: parsed.ingressRootId }),
        this.resolver.resolveRoot({ catalogId: this.catalogId, rootId: parsed.destinationRootId }),
        this.resolver.resolvePreset({ catalogId: this.catalogId, presetId: parsed.presetId }),
      ]);
      await this.assertCurrentSession();
      const parsedIngressRoot = parseRootSnapshot(ingressRoot, this.catalogId, parsed.ingressRootId);
      const parsedDestinationRoot = parseRootSnapshot(destinationRoot, this.catalogId, parsed.destinationRootId);
      assertNoOverlap(parsedIngressRoot, parsed.ingressRelativePath, parsedDestinationRoot, parsed.destinationRelativePath);
      const preset = parsePresetSnapshot(presetValue, this.catalogId, parsed.presetId);
      const canonicalPayload = canonicalJson({
        catalogId: preset.catalogId,
        presetId: preset.presetId,
        name: preset.name,
        version: preset.version,
        template: { pattern: preset.template.pattern },
        payload: preset.payload,
        updatedAt: preset.updatedAt,
      });
      const rule: AutoImportRule = {
        catalogId: this.catalogId,
        ruleId: existing?.ruleId ?? parseAutoImportRuleId(createOperationId()),
        ingressRootId: parsed.ingressRootId,
        ingressRelativePath: parsed.ingressRelativePath,
        destinationRootId: parsed.destinationRootId,
        destinationRelativePath: parsed.destinationRelativePath,
        placement: "copy",
        presetId: preset.presetId,
        presetVersion: preset.version,
        presetSha256: sha256(canonicalPayload),
        duplicatePolicy: parsed.duplicatePolicy,
        destinationConflictPolicy: parsed.destinationConflictPolicy,
        enabled: parsed.enabled ?? existing?.enabled ?? false,
        stabilityMs: parsed.stabilityMs,
        maxAttempts: parsed.maxAttempts,
        retryBackoffMs: parsed.retryBackoffMs,
      };
      validateAutoImportRules([rule]);
      if (existing !== null && (!sameRuleConfiguration(existing, rule) || !rule.enabled)) {
        this.cancelInFlight();
        await this.store.disable(existing.ruleId, this.clock());
      }
      await this.store.setRules([rule]);
      return cloneRule(rule);
    });
  }

  public async enable(): Promise<AutoImportRule> {
    return this.setEnabled(true);
  }

  public async disable(): Promise<AutoImportRule> {
    return this.serialize(async () => {
      await this.assertCurrentSession();
      const state = await this.loadState();
      const existing = currentRule(state, this.catalogId);
      if (existing === null) throw new Error("Auto Import rule is not configured.");
      this.cancelInFlight();
      const rule = { ...existing, enabled: false } satisfies AutoImportRule;
      await this.store.setRules([rule]);
      await this.store.disable(rule.ruleId, this.clock());
      return cloneRule(rule);
    });
  }

  public pause(): Promise<void> {
    return this.serialize(async () => {
      await this.assertCurrentSession();
      await this.store.pause();
    });
  }

  public resume(): Promise<void> {
    return this.serialize(async () => {
      await this.assertCurrentSession();
      await this.store.resume();
    });
  }

  public async observe(first: unknown, second: unknown): Promise<AutoImportQueueItem | null> {
    const gate = parseGate(first, second);
    return this.serialize(async () => {
      await this.assertCurrentSession();
      const state = await this.loadState();
      const rule = currentRule(state, this.catalogId);
      if (rule === null) throw new Error("Auto Import rule is not configured.");
      return this.store.enqueue(rule.ruleId, gate, this.clock());
    });
  }

  public async drain(options: CatalogAutoImportDrainOptions = {}): Promise<readonly CatalogAutoImportDrainResult[]> {
    const limit = validateLimit(options.maxItems ?? DEFAULT_DRAIN_LIMIT);
    const leaseMs = validateLease(options.leaseMs ?? this.defaultLeaseMs);
    const results: CatalogAutoImportDrainResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const claimed = await this.claimNext(leaseMs);
      if (claimed === null) break;
      results.push(await this.executeClaim(claimed));
    }
    return results;
  }

  public async cancel(queueId: OperationId): Promise<void> {
    const parsedQueueId = parseOperationId(queueId);
    const token = this.inFlight.get(parsedQueueId);
    if (token !== undefined) token.cancelled = true;
    await this.serialize(async () => {
      await this.assertCurrentSession();
      const state = await this.loadState();
      const item = currentItem(state, parsedQueueId);
      if (item === null) throw new Error("Auto Import queue item does not exist.");
      await this.store.cancel(parsedQueueId, this.clock());
    });
  }

  public retryFailed(): Promise<void> {
    return this.serialize(async () => {
      await this.assertCurrentSession();
      await this.store.retryFailed(this.clock());
    });
  }

  public clearFailed(): Promise<void> {
    return this.serialize(async () => {
      await this.assertCurrentSession();
      await this.store.clearFailed();
    });
  }

  private async setEnabled(enabled: boolean): Promise<AutoImportRule> {
    return this.serialize(async () => {
      await this.assertCurrentSession();
      const state = await this.loadState();
      const existing = currentRule(state, this.catalogId);
      if (existing === null) throw new Error("Auto Import rule is not configured.");
      if (!enabled) this.cancelInFlight();
      const rule = { ...existing, enabled } satisfies AutoImportRule;
      await this.store.setRules([rule]);
      if (!enabled) await this.store.disable(rule.ruleId, this.clock());
      return cloneRule(rule);
    });
  }

  private async claimNext(leaseMs: number): Promise<ClaimedItem | null> {
    return this.serialize(async () => {
      await this.assertCurrentSession();
      const state = await this.loadState();
      const rule = currentRule(state, this.catalogId);
      if (rule === null || !rule.enabled || state.paused) return null;
      const item = await this.store.claimNext(this.clock(), leaseMs);
      if (item === null) return null;
      const token: CancellationToken = { cancelled: false };
      this.inFlight.set(item.queueId, token);
      const currentState = await this.loadState();
      const current = currentItem(currentState, item.queueId);
      if (current === null || current.state !== "claimed") {
        token.cancelled = true;
        this.inFlight.delete(item.queueId);
        return null;
      }
      return { item, rule: cloneRule(rule), token };
    });
  }

  private async executeClaim(claimed: ClaimedItem): Promise<CatalogAutoImportDrainResult> {
    const { item, rule, token } = claimed;
    try {
      await this.assertCurrentSession();
      const execution = await this.executor.executeAutoImport(item, rule, {
        isCancelled: () => token.cancelled,
      });
      await this.assertCurrentSession();
      if (token.cancelled || execution.state === "cancelled") {
        await this.cancelIfClaimed(item.queueId);
      } else if (execution.state === "completed") {
        await this.completeIfClaimed(item.queueId, token);
      } else if (execution.retryable === true) {
        await this.recoverIfClaimed(item.queueId);
      } else {
        await this.failIfClaimed(item.queueId, rule);
      }
    } catch (error) {
      if (token.cancelled || error instanceof ImportOperationCancelledError) {
        await this.cancelIfClaimed(item.queueId);
      } else if (
        error instanceof CatalogFaultInjectedError &&
        (error.point.stage === "catalog-applied" || error.point.stage === "source-cleaned")
      ) {
        await this.recoverIfClaimed(item.queueId);
      } else {
        await this.failIfClaimed(item.queueId, rule);
      }
    } finally {
      this.inFlight.delete(item.queueId);
    }
    return this.serialize(async () => {
      const state = await this.loadState();
      const current = currentItem(state, item.queueId);
      if (current === null) throw new Error("Auto Import queue item disappeared.");
      return {
        queueId: current.queueId,
        state: current.state,
        attempts: current.attempts,
        error: statusError(current.error),
      };
    });
  }

  private async completeIfClaimed(queueId: OperationId, token: CancellationToken): Promise<void> {
    if (token.cancelled) return;
    await this.serialize(async () => {
      const state = await this.loadState();
      const item = currentItem(state, queueId);
      if (item?.state === "claimed" && !token.cancelled) await this.store.complete(queueId, this.clock());
    });
  }

  private async failIfClaimed(queueId: OperationId, rule: AutoImportRule): Promise<void> {
    await this.serialize(async () => {
      const state = await this.loadState();
      const item = currentItem(state, queueId);
      if (item?.state === "claimed") await this.store.fail(queueId, EXECUTION_FAILURE_CODE, this.clock());
      else if (item?.state === "queued" && item.ruleId !== rule.ruleId) throw new Error("Auto Import rule does not own this queue item.");
    });
  }

  private async recoverIfClaimed(queueId: OperationId): Promise<void> {
    await this.serialize(async () => {
      const state = await this.loadState();
      const item = currentItem(state, queueId);
      if (item?.state === "claimed") {
        await this.store.recover(queueId, EXECUTION_FAILURE_CODE, this.clock());
      }
    });
  }

  private async cancelIfClaimed(queueId: OperationId): Promise<void> {
    await this.serialize(async () => {
      const state = await this.loadState();
      const item = currentItem(state, queueId);
      if (item?.state === "claimed") await this.store.cancel(queueId, this.clock());
    });
  }

  private cancelInFlight(): void {
    for (const token of this.inFlight.values()) token.cancelled = true;
  }

  private async loadState(): Promise<AutoImportStoreState> {
    const state = await this.store.load();
    currentRule(state, this.catalogId);
    return state;
  }

  private statusFromState(state: AutoImportStoreState): CatalogAutoImportStatus {
    const rule = currentRule(state, this.catalogId);
    const items = state.queue.list().map(statusItem);
    const controllerState: CatalogAutoImportControllerState = rule === null
      ? "unconfigured"
      : !rule.enabled
        ? "disabled"
        : state.paused
          ? "paused"
          : "ready";
    return {
      catalogId: this.catalogId,
      state: controllerState,
      paused: state.paused,
      degraded: false,
      rule: rule === null ? null : statusRule(rule),
      counts: counts(state.queue.list()),
      items,
    };
  }

  private clock(): number {
    return validateClock(this.nowSource());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.current.then(operation, operation);
    this.serial.current = next.then(() => undefined, () => undefined);
    return next;
  }
}

export function createCatalogAutoImportController(
  options: CatalogAutoImportControllerOptions,
): CatalogAutoImportController {
  return new CatalogAutoImportController(options);
}
