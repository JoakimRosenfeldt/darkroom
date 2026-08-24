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
import { parseRelativePath, parseSessionId, type SessionId } from "../catalog/runtime.ts";
import type {
  AutoImportDestinationConflictPolicy,
  AutoImportDuplicatePolicy,
  AutoImportQueueState,
} from "./auto-import.ts";
import { parseAutoImportRuleId, type AutoImportRuleId } from "./auto-import.ts";

type RecordValue = Record<string, unknown>;

const CAPABILITY_REASON = "Move is unavailable for Auto Import.";
const AUTO_IMPORT_ERROR_MESSAGE = "Auto Import execution failed.";
const MAX_STATUS_ITEMS = 100_000;
const MAX_STABILITY_MS = 24 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 100;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1_000;

export interface AutoImportCapability {
  readonly copy: "available";
  readonly move: {
    readonly status: "unavailable";
    readonly reason: string;
  };
}

export const AUTO_IMPORT_CAPABILITY: AutoImportCapability = Object.freeze({
  copy: "available",
  move: Object.freeze({ status: "unavailable", reason: CAPABILITY_REASON }),
});

export type AutoImportApiControl =
  | "status"
  | "enable"
  | "disable"
  | "pause"
  | "resume"
  | "retry-failed"
  | "clear-failed";

export interface AutoImportConfigureRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly action: "copy";
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
  readonly enabled: boolean;
}

export interface AutoImportControlRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly action: AutoImportApiControl;
}

export interface AutoImportCancelRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly queueId: OperationId;
}

export type AutoImportControllerState = "unconfigured" | "disabled" | "paused" | "ready";

export interface AutoImportStatusRule {
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

export interface AutoImportStatusError {
  readonly code: "execution-failed";
  readonly message: typeof AUTO_IMPORT_ERROR_MESSAGE;
}

export interface AutoImportStatusItem {
  readonly queueId: OperationId;
  readonly ruleId: AutoImportRuleId;
  readonly relativePath: string;
  readonly state: AutoImportQueueState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: number;
  readonly leaseUntil: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly error: AutoImportStatusError | null;
}

export interface AutoImportStatusCounts {
  readonly total: number;
  readonly queued: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface AutoImportStatus {
  readonly catalogId: CatalogId;
  readonly state: AutoImportControllerState;
  readonly paused: boolean;
  readonly degraded: boolean;
  readonly rule: AutoImportStatusRule | null;
  readonly counts: AutoImportStatusCounts;
  readonly items: readonly AutoImportStatusItem[];
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  return value;
}

function exact(value: RecordValue, keys: readonly string[], name: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${name} contains unexpected fields.`);
  }
}

function exactOptional(value: RecordValue, required: readonly string[], optional: readonly string[], name: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name} contains unexpected fields.`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${name} is missing ${key}.`);
  }
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function safeInteger(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is invalid.`);
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

function parseCopyAction(value: unknown): "copy" {
  if (value === undefined || value === "copy") return "copy";
  if (value === "move") throw new Error(CAPABILITY_REASON);
  throw new Error("Auto Import action is invalid.");
}

function pathFreeMessage(value: unknown): string {
  const message = stringValue(value, "Auto Import error message");
  if (
    message.includes("/") ||
    message.includes("\\") ||
    /^[A-Za-z]:/.test(message) ||
    message.includes("file://")
  ) {
    throw new Error("Auto Import error message must not contain a native path.");
  }
  return message;
}

function parseSha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

export function parseAutoImportCapability(value: unknown): AutoImportCapability {
  const input = record(value, "Auto Import capability");
  exact(input, ["copy", "move"], "Auto Import capability");
  if (input.copy !== "available") throw new Error("Auto Import Copy capability is invalid.");
  const move = record(input.move, "Auto Import Move capability");
  exact(move, ["status", "reason"], "Auto Import Move capability");
  if (move.status !== "unavailable") throw new Error("Auto Import Move capability is invalid.");
  const reason = stringValue(move.reason, "Auto Import Move capability reason");
  if (reason.includes("/") || reason.includes("\\")) throw new Error("Auto Import capability reason is invalid.");
  return { copy: "available", move: { status: "unavailable", reason } };
}

export function parseAutoImportAction(value: unknown): "copy" {
  return parseCopyAction(value);
}

export function parseAutoImportConfigureRequest(value: unknown): AutoImportConfigureRequest {
  const input = record(value, "Auto Import configuration request");
  exactOptional(
    input,
    [
      "catalogId",
      "sessionId",
      "ingressRootId",
      "ingressRelativePath",
      "destinationRootId",
      "destinationRelativePath",
      "presetId",
      "duplicatePolicy",
      "destinationConflictPolicy",
      "stabilityMs",
      "maxAttempts",
      "retryBackoffMs",
      "enabled",
    ],
    ["action"],
    "Auto Import configuration request",
  );
  const parsedDuplicatePolicy = duplicatePolicy(input.duplicatePolicy);
  if (parsedDuplicatePolicy === "use-existing-location") {
    throw new Error("Auto Import use-existing-location duplicates are unavailable.");
  }
  const parsedDestinationPolicy = destinationPolicy(input.destinationConflictPolicy);
  if (parsedDestinationPolicy === "replace") {
    throw new Error("Auto Import Replace conflicts are unavailable.");
  }
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    action: parseCopyAction(input.action),
    ingressRootId: parseRootId(input.ingressRootId),
    ingressRelativePath: parseRelativePath(input.ingressRelativePath, "ingressRelativePath"),
    destinationRootId: parseRootId(input.destinationRootId),
    destinationRelativePath: parseRelativePath(input.destinationRelativePath, "destinationRelativePath"),
    presetId: parsePresetId(input.presetId),
    duplicatePolicy: parsedDuplicatePolicy,
    destinationConflictPolicy: parsedDestinationPolicy,
    stabilityMs: safeInteger(input.stabilityMs, "stabilityMs", 0, MAX_STABILITY_MS),
    maxAttempts: safeInteger(input.maxAttempts, "maxAttempts", 1, MAX_ATTEMPTS),
    retryBackoffMs: safeInteger(input.retryBackoffMs, "retryBackoffMs", 0, MAX_BACKOFF_MS),
    enabled: booleanValue(input.enabled, "enabled"),
  };
}

export function parseAutoImportControlRequest(value: unknown): AutoImportControlRequest {
  const input = record(value, "Auto Import control request");
  exact(input, ["catalogId", "sessionId", "action"], "Auto Import control request");
  const action = input.action;
  if (
    action !== "status" &&
    action !== "enable" &&
    action !== "disable" &&
    action !== "pause" &&
    action !== "resume" &&
    action !== "retry-failed" &&
    action !== "clear-failed"
  ) {
    throw new Error("Auto Import control action is invalid.");
  }
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    action,
  };
}

export function parseAutoImportCancelRequest(value: unknown): AutoImportCancelRequest {
  const input = record(value, "Auto Import cancellation request");
  exact(input, ["catalogId", "sessionId", "queueId"], "Auto Import cancellation request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    queueId: parseOperationId(input.queueId),
  };
}

function parseStatusRule(value: unknown): AutoImportStatusRule {
  const input = record(value, "Auto Import status rule");
  exact(
    input,
    [
      "ruleId",
      "enabled",
      "ingressRootId",
      "ingressRelativePath",
      "destinationRootId",
      "destinationRelativePath",
      "presetId",
      "presetVersion",
      "presetSha256",
      "duplicatePolicy",
      "destinationConflictPolicy",
      "stabilityMs",
      "maxAttempts",
      "retryBackoffMs",
    ],
    "Auto Import status rule",
  );
  const parsedDuplicatePolicy = duplicatePolicy(input.duplicatePolicy);
  if (parsedDuplicatePolicy === "use-existing-location") {
    throw new Error("Auto Import use-existing-location duplicates are unavailable.");
  }
  const parsedDestinationPolicy = destinationPolicy(input.destinationConflictPolicy);
  if (parsedDestinationPolicy === "replace") {
    throw new Error("Auto Import Replace conflicts are unavailable.");
  }
  return {
    ruleId: parseAutoImportRuleId(input.ruleId),
    enabled: booleanValue(input.enabled, "enabled"),
    ingressRootId: parseRootId(input.ingressRootId),
    ingressRelativePath: parseRelativePath(input.ingressRelativePath, "ingressRelativePath"),
    destinationRootId: parseRootId(input.destinationRootId),
    destinationRelativePath: parseRelativePath(input.destinationRelativePath, "destinationRelativePath"),
    presetId: parsePresetId(input.presetId),
    presetVersion: safeInteger(input.presetVersion, "presetVersion"),
    presetSha256: parseSha256(input.presetSha256, "presetSha256"),
    duplicatePolicy: parsedDuplicatePolicy,
    destinationConflictPolicy: parsedDestinationPolicy,
    stabilityMs: safeInteger(input.stabilityMs, "stabilityMs", 0, MAX_STABILITY_MS),
    maxAttempts: safeInteger(input.maxAttempts, "maxAttempts", 1, MAX_ATTEMPTS),
    retryBackoffMs: safeInteger(input.retryBackoffMs, "retryBackoffMs", 0, MAX_BACKOFF_MS),
  };
}

function parseStatusError(value: unknown): AutoImportStatusError | null {
  if (value === null) return null;
  const input = record(value, "Auto Import status error");
  exact(input, ["code", "message"], "Auto Import status error");
  if (input.code !== "execution-failed" || input.message !== AUTO_IMPORT_ERROR_MESSAGE) {
    throw new Error("Auto Import status error is invalid.");
  }
  pathFreeMessage(input.message);
  return { code: "execution-failed", message: AUTO_IMPORT_ERROR_MESSAGE };
}

function parseStatusItem(value: unknown): AutoImportStatusItem {
  const input = record(value, "Auto Import status item");
  exact(
    input,
    [
      "queueId",
      "ruleId",
      "relativePath",
      "state",
      "attempts",
      "maxAttempts",
      "nextAttemptAt",
      "leaseUntil",
      "createdAt",
      "updatedAt",
      "error",
    ],
    "Auto Import status item",
  );
  const state = input.state;
  if (state !== "queued" && state !== "claimed" && state !== "completed" && state !== "failed" && state !== "cancelled") {
    throw new Error("Auto Import status item state is invalid.");
  }
  const leaseUntil = input.leaseUntil === null
    ? null
    : safeInteger(input.leaseUntil, "leaseUntil");
  const item = {
    queueId: parseOperationId(input.queueId),
    ruleId: parseAutoImportRuleId(input.ruleId),
    relativePath: parseRelativePath(input.relativePath),
    state,
    attempts: safeInteger(input.attempts, "attempts"),
    maxAttempts: safeInteger(input.maxAttempts, "maxAttempts", 1, MAX_ATTEMPTS),
    nextAttemptAt: safeInteger(input.nextAttemptAt, "nextAttemptAt"),
    leaseUntil,
    createdAt: safeInteger(input.createdAt, "createdAt"),
    updatedAt: safeInteger(input.updatedAt, "updatedAt"),
    error: parseStatusError(input.error),
  } satisfies AutoImportStatusItem;
  if (item.attempts > item.maxAttempts) throw new Error("Auto Import status attempts are invalid.");
  if ((state === "claimed") !== (leaseUntil !== null)) throw new Error("Auto Import status lease is invalid.");
  return item;
}

function parseStatusCounts(value: unknown): AutoImportStatusCounts {
  const input = record(value, "Auto Import status counts");
  exact(input, ["total", "queued", "claimed", "completed", "failed", "cancelled"], "Auto Import status counts");
  const result = {
    total: safeInteger(input.total, "total"),
    queued: safeInteger(input.queued, "queued"),
    claimed: safeInteger(input.claimed, "claimed"),
    completed: safeInteger(input.completed, "completed"),
    failed: safeInteger(input.failed, "failed"),
    cancelled: safeInteger(input.cancelled, "cancelled"),
  };
  if (result.queued + result.claimed + result.completed + result.failed + result.cancelled !== result.total) {
    throw new Error("Auto Import status counts do not add up.");
  }
  return result;
}

export function parseAutoImportStatus(value: unknown): AutoImportStatus {
  const input = record(value, "Auto Import status");
  exact(input, ["catalogId", "state", "paused", "degraded", "rule", "counts", "items"], "Auto Import status");
  const state = input.state;
  if (state !== "unconfigured" && state !== "disabled" && state !== "paused" && state !== "ready") {
    throw new Error("Auto Import status state is invalid.");
  }
  if (!Array.isArray(input.items) || input.items.length > MAX_STATUS_ITEMS) {
    throw new Error("Auto Import status items are invalid.");
  }
  const counts = parseStatusCounts(input.counts);
  const items = input.items.map(parseStatusItem);
  if (items.length !== counts.total) throw new Error("Auto Import status item count is invalid.");
  const rule = input.rule === null ? null : parseStatusRule(input.rule);
  if (state === "unconfigured" && rule !== null) throw new Error("Unconfigured Auto Import status has a rule.");
  if (state !== "unconfigured" && rule === null) throw new Error("Configured Auto Import status has no rule.");
  return {
    catalogId: parseCatalogId(input.catalogId),
    state,
    paused: booleanValue(input.paused, "paused"),
    degraded: booleanValue(input.degraded, "degraded"),
    rule,
    counts,
    items,
  };
}

export type { CatalogId, OperationId, PresetId, RootId, SessionId };
