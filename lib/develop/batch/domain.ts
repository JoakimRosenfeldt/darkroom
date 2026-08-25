import { parseCatalogId, parseEntryId, type CatalogId, type EntryId } from "../../catalog/ids.ts";
import { parseDevelopRevisionId, type DevelopRevisionId } from "../history.ts";
import { DEVELOP_PRESET_FIELDS, parseDevelopPresetField, type DevelopPresetField } from "../presets/policy.ts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type DevelopBatchId = Brand<string, "DevelopBatchId">;
export type DevelopBatchOperationId = Brand<string, "DevelopBatchOperationId">;
export type DevelopBatchKind = "previous" | "sync" | "auto-sync" | "batch" | "undo";
export type DevelopBatchJson = null | boolean | number | string | DevelopBatchJson[] | { readonly [key: string]: DevelopBatchJson };

export const DEVELOP_BATCH_SCHEMA_VERSION = 1;
export const DEVELOP_BATCH_MAX_TARGETS = 10_000;
export const DEVELOP_BATCH_MAX_JOBS_PER_CATALOG = 10_000;
export const DEVELOP_BATCH_MAX_OPERATION_BYTES = 2 * 1024 * 1024;
export const DEVELOP_BATCH_MAX_JOB_BYTES = 64 * 1024 * 1024;
export const DEVELOP_BATCH_MAX_CATALOG_BYTES = 1024 * 1024 * 1024;
export const DEVELOP_BATCH_MAX_DEPTH = 16;
export const DEVELOP_BATCH_MAX_NODES = 100_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DevelopBatchOperation =
  | { readonly kind: "copy-fields"; readonly fields: readonly DevelopPresetField[] }
  | { readonly kind: "preset"; readonly preset: DevelopBatchJson; readonly fields: readonly DevelopPresetField[] | null; readonly amount: number }
  | { readonly kind: "paste-settings"; readonly payload: DevelopBatchJson; readonly fields: readonly DevelopPresetField[] }
  | { readonly kind: "section-reset"; readonly fields: readonly DevelopPresetField[] }
  | { readonly kind: "selected-control"; readonly field: DevelopPresetField; readonly payloadEntry: DevelopBatchJson }
  | { readonly kind: "undo"; readonly sourceBatchId: DevelopBatchId };

export interface DevelopBatchFrozenTarget {
  readonly entryId: EntryId;
  readonly expectedRevisionId: DevelopRevisionId;
}

export interface DevelopBatchCreateInput {
  readonly schemaVersion: typeof DEVELOP_BATCH_SCHEMA_VERSION;
  readonly catalogId: CatalogId;
  readonly batchId: DevelopBatchId;
  readonly operationId: DevelopBatchOperationId;
  readonly kind: Exclude<DevelopBatchKind, "undo">;
  readonly sourceEntryId: EntryId | null;
  readonly sourceRevisionId: DevelopRevisionId | null;
  readonly targets: readonly DevelopBatchFrozenTarget[];
  readonly operation: Exclude<DevelopBatchOperation, { readonly kind: "undo" }>;
  readonly createdAt: number;
}

export type DevelopBatchItemState =
  | { readonly kind: "queued" }
  | { readonly kind: "active"; readonly phase: "reconcile" | "apply" | "commit" }
  | { readonly kind: "completed"; readonly entryId: EntryId; readonly revisionId: DevelopRevisionId; readonly warnings: readonly string[] }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: "not-started" }
  | { readonly kind: "failed"; readonly error: string; readonly retryable: boolean };

export interface DevelopBatchReceiptItem {
  readonly position: number;
  readonly entryId: EntryId;
  readonly operationId: DevelopBatchOperationId;
  readonly plannedRevisionId: DevelopRevisionId;
  readonly expectedRevisionId: DevelopRevisionId;
  readonly beforeRevisionId: DevelopRevisionId | null;
  readonly afterRevisionId: DevelopRevisionId | null;
  readonly restoreRevisionId: DevelopRevisionId | null;
  readonly state: DevelopBatchItemState;
  readonly attempts: number;
  readonly updatedAt: number;
}

export interface DevelopBatchReceipt {
  readonly schemaVersion: typeof DEVELOP_BATCH_SCHEMA_VERSION;
  readonly catalogId: CatalogId;
  readonly batchId: DevelopBatchId;
  readonly operationId: DevelopBatchOperationId;
  readonly kind: DevelopBatchKind;
  readonly sourceEntryId: EntryId | null;
  readonly sourceRevisionId: DevelopRevisionId | null;
  readonly targetEntryIds: readonly EntryId[];
  readonly operation: DevelopBatchOperation;
  readonly items: readonly DevelopBatchReceiptItem[];
  readonly cancellationRequested: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type DevelopBatchCommand =
  | { readonly kind: "create"; readonly input: DevelopBatchCreateInput }
  | { readonly kind: "get"; readonly catalogId: CatalogId; readonly batchId: DevelopBatchId }
  | { readonly kind: "list"; readonly catalogId: CatalogId; readonly limit: number }
  | { readonly kind: "run" | "cancel" | "retry"; readonly catalogId: CatalogId; readonly batchId: DevelopBatchId }
  | {
      readonly kind: "freeze";
      readonly catalogId: CatalogId; readonly batchId: DevelopBatchId; readonly operationId: DevelopBatchOperationId;
      readonly batchKind: "sync" | "batch"; readonly sourceEntryId: EntryId | null;
      readonly targetEntryIds: readonly EntryId[]; readonly operation: Exclude<DevelopBatchOperation, { readonly kind: "undo" }>;
      readonly createdAt: number;
    }
  | {
      readonly kind: "previous";
      readonly catalogId: CatalogId; readonly batchId: DevelopBatchId; readonly operationId: DevelopBatchOperationId;
      readonly currentEntryId: EntryId; readonly fields: readonly DevelopPresetField[]; readonly createdAt: number;
    }
  | {
      readonly kind: "undo";
      readonly catalogId: CatalogId; readonly sourceBatchId: DevelopBatchId; readonly batchId: DevelopBatchId;
      readonly operationId: DevelopBatchOperationId; readonly createdAt: number;
    }
  | {
      readonly kind: "auto-enable";
      readonly catalogId: CatalogId; readonly sourceEntryId: EntryId; readonly targetEntryIds: readonly EntryId[];
      readonly fields: readonly DevelopPresetField[]; readonly updatedAt: number;
    }
  | { readonly kind: "auto-disable"; readonly catalogId: CatalogId; readonly updatedAt: number }
  | {
      readonly kind: "auto-emit";
      readonly catalogId: CatalogId; readonly batchId: DevelopBatchId; readonly operationId: DevelopBatchOperationId;
      readonly sourceRevisionId: DevelopRevisionId; readonly createdAt: number;
    };

export type DevelopBatchCommandResult = DevelopBatchReceipt | readonly DevelopBatchReceipt[] | null;

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} has unknown fields.`);
}
function finite(value: unknown, label: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail(`${label} is invalid.`);
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fail(`${label} is invalid.`);
}
function text(value: unknown, label: string, maximum = 1_024): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) fail(`${label} is invalid.`);
  return value.trim();
}
function uuid<Name extends "DevelopBatchId" | "DevelopBatchOperationId">(value: unknown, label: Name): Brand<string, Name> {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() as Brand<string, Name> : fail(`${label} must be a UUID.`);
}

export function parseDevelopBatchId(value: unknown): DevelopBatchId { return uuid(value, "DevelopBatchId"); }
export function createDevelopBatchId(value?: string): DevelopBatchId { return parseDevelopBatchId(value ?? crypto.randomUUID()); }
export function parseDevelopBatchOperationId(value: unknown): DevelopBatchOperationId { return uuid(value, "DevelopBatchOperationId"); }
export function createDevelopBatchOperationId(value?: string): DevelopBatchOperationId { return parseDevelopBatchOperationId(value ?? crypto.randomUUID()); }

export function parseDevelopBatchJson(value: unknown): DevelopBatchJson {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): DevelopBatchJson => {
    nodes += 1;
    if (nodes > DEVELOP_BATCH_MAX_NODES) fail("Develop batch payload exceeds the node limit.");
    if (depth > DEVELOP_BATCH_MAX_DEPTH) fail("Develop batch payload exceeds the depth limit.");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : fail("Develop batch payload contains a non-finite number.");
    if (typeof item !== "object") fail("Develop batch payload is not JSON data.");
    if (seen.has(item)) fail("Develop batch payload cannot be cyclic.");
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
      const output = Object.create(null) as { [key: string]: DevelopBatchJson };
      for (const key of Object.keys(item).sort()) {
        if (key.includes("\0")) fail("Develop batch payload contains an invalid field name.");
        output[key] = visit(Reflect.get(item, key), depth + 1);
      }
      return output;
    } finally {
      seen.delete(item);
    }
  };
  return visit(value, 0);
}

export function canonicalDevelopBatchJson(value: unknown): string {
  return JSON.stringify(parseDevelopBatchJson(value));
}

function fields(value: unknown, allowEmpty = false): readonly DevelopPresetField[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > DEVELOP_PRESET_FIELDS.length) fail("Develop batch fields are invalid.");
  const parsed = value.map(parseDevelopPresetField);
  if (new Set(parsed).size !== parsed.length) fail("Develop batch fields contain duplicates.");
  return parsed;
}

export function parseDevelopBatchOperation(value: unknown): DevelopBatchOperation {
  const input = record(value, "Develop batch operation");
  const kind = input.kind;
  let operation: DevelopBatchOperation;
  if (kind === "copy-fields") {
    exact(input, ["kind", "fields"], "Develop batch copy-fields operation");
    operation = { kind, fields: fields(input.fields) };
  } else if (kind === "preset") {
    exact(input, ["kind", "preset", "fields", "amount"], "Develop batch preset operation");
    operation = { kind, preset: parseDevelopBatchJson(input.preset), fields: input.fields === null ? null : fields(input.fields), amount: finite(input.amount, "Develop batch preset amount") };
    if (operation.amount < 0 || operation.amount > 100) fail("Develop batch preset amount is invalid.");
  } else if (kind === "paste-settings") {
    exact(input, ["kind", "payload", "fields"], "Develop batch paste operation");
    operation = { kind, payload: parseDevelopBatchJson(input.payload), fields: fields(input.fields) };
  } else if (kind === "section-reset") {
    exact(input, ["kind", "fields"], "Develop batch reset operation");
    operation = { kind, fields: fields(input.fields) };
  } else if (kind === "selected-control") {
    exact(input, ["kind", "field", "payloadEntry"], "Develop batch control operation");
    operation = { kind, field: parseDevelopPresetField(input.field), payloadEntry: parseDevelopBatchJson(input.payloadEntry) };
  } else if (kind === "undo") {
    exact(input, ["kind", "sourceBatchId"], "Develop batch undo operation");
    operation = { kind, sourceBatchId: parseDevelopBatchId(input.sourceBatchId) };
  } else operation = fail("Develop batch operation kind is invalid.");
  const bytes = new TextEncoder().encode(JSON.stringify(operation)).byteLength;
  if (bytes > DEVELOP_BATCH_MAX_OPERATION_BYTES) fail("Develop batch operation exceeds the byte limit.");
  return operation;
}

function batchKind(value: unknown): DevelopBatchKind {
  return value === "previous" || value === "sync" || value === "auto-sync" || value === "batch" || value === "undo"
    ? value
    : fail("Develop batch kind is invalid.");
}

function assertBatchKindOperation(kind: DevelopBatchKind, operation: DevelopBatchOperation): void {
  const valid = kind === "undo"
    ? operation.kind === "undo"
    : kind === "previous" || kind === "sync" || kind === "auto-sync"
      ? operation.kind === "copy-fields"
      : operation.kind === "preset" || operation.kind === "paste-settings" ||
        operation.kind === "section-reset" || operation.kind === "selected-control";
  if (!valid) fail(`Develop batch kind ${kind} cannot use operation ${operation.kind}.`);
}

export function parseDevelopBatchCreateInput(value: unknown): DevelopBatchCreateInput {
  const input = record(value, "Develop batch create input");
  exact(input, ["schemaVersion", "catalogId", "batchId", "operationId", "kind", "sourceEntryId", "sourceRevisionId", "targets", "operation", "createdAt"], "Develop batch create input");
  if (input.schemaVersion !== DEVELOP_BATCH_SCHEMA_VERSION || input.kind === "undo") fail("Develop batch create schema or kind is invalid.");
  if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > DEVELOP_BATCH_MAX_TARGETS) fail("Develop batch targets are invalid.");
  const targets = input.targets.map((value, index): DevelopBatchFrozenTarget => {
    const target = record(value, `Develop batch target ${index}`);
    exact(target, ["entryId", "expectedRevisionId"], `Develop batch target ${index}`);
    return { entryId: parseEntryId(target.entryId), expectedRevisionId: parseDevelopRevisionId(target.expectedRevisionId) };
  });
  if (new Set(targets.map((target) => target.entryId)).size !== targets.length) fail("Develop batch targets contain duplicates.");
  const kind = batchKind(input.kind);
  if (kind === "undo") fail("Develop batch create kind is invalid.");
  const sourceEntryId = input.sourceEntryId === null ? null : parseEntryId(input.sourceEntryId);
  const sourceRevisionId = input.sourceRevisionId === null ? null : parseDevelopRevisionId(input.sourceRevisionId);
  if ((sourceEntryId === null) !== (sourceRevisionId === null)) fail("Develop batch source is incomplete.");
  if ((kind === "previous" || kind === "sync" || kind === "auto-sync") && sourceEntryId === null) fail("Develop batch source is required.");
  if (kind === "batch" && sourceEntryId !== null) fail("Batch Develop operations cannot carry an unused source.");
  if (sourceEntryId !== null && targets.some((target) => target.entryId === sourceEntryId)) fail("Develop batch source cannot be a target.");
  const operation = parseDevelopBatchOperation(input.operation);
  if (operation.kind === "undo") fail("Develop batch create operation is invalid.");
  assertBatchKindOperation(kind, operation);
  const parsed: DevelopBatchCreateInput = {
    schemaVersion: DEVELOP_BATCH_SCHEMA_VERSION,
    catalogId: parseCatalogId(input.catalogId),
    batchId: parseDevelopBatchId(input.batchId),
    operationId: parseDevelopBatchOperationId(input.operationId),
    kind,
    sourceEntryId,
    sourceRevisionId,
    targets,
    operation,
    createdAt: finite(input.createdAt, "Develop batch createdAt"),
  };
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > DEVELOP_BATCH_MAX_JOB_BYTES) fail("Develop batch job exceeds the byte limit.");
  return parsed;
}

export function parseDevelopBatchItemState(value: unknown): DevelopBatchItemState {
  const input = record(value, "Develop batch item state");
  if (input.kind === "queued") { exact(input, ["kind"], "Develop batch queued state"); return { kind: "queued" }; }
  if (input.kind === "active") {
    exact(input, ["kind", "phase"], "Develop batch active state");
    if (input.phase !== "reconcile" && input.phase !== "apply" && input.phase !== "commit") fail("Develop batch active phase is invalid.");
    return { kind: "active", phase: input.phase };
  }
  if (input.kind === "completed") {
    exact(input, ["kind", "entryId", "revisionId", "warnings"], "Develop batch completed state");
    if (!Array.isArray(input.warnings) || input.warnings.length > 256) fail("Develop batch warnings are invalid.");
    return { kind: "completed", entryId: parseEntryId(input.entryId), revisionId: parseDevelopRevisionId(input.revisionId), warnings: input.warnings.map((warning) => text(warning, "Develop batch warning")) };
  }
  if (input.kind === "skipped") { exact(input, ["kind", "reason"], "Develop batch skipped state"); return { kind: "skipped", reason: text(input.reason, "Develop batch skip reason") }; }
  if (input.kind === "cancelled") { exact(input, ["kind", "reason"], "Develop batch cancelled state"); if (input.reason !== "not-started") fail("Develop batch cancellation reason is invalid."); return { kind: "cancelled", reason: "not-started" }; }
  if (input.kind === "failed") { exact(input, ["kind", "error", "retryable"], "Develop batch failed state"); if (typeof input.retryable !== "boolean") fail("Develop batch retryable flag is invalid."); return { kind: "failed", error: text(input.error, "Develop batch failure"), retryable: input.retryable }; }
  return fail("Develop batch item state kind is invalid.");
}

export function parseDevelopBatchReceipt(value: unknown): DevelopBatchReceipt {
  const input = record(value, "Develop batch Receipt");
  exact(input, ["schemaVersion", "catalogId", "batchId", "operationId", "kind", "sourceEntryId", "sourceRevisionId", "targetEntryIds", "operation", "items", "cancellationRequested", "createdAt", "updatedAt"], "Develop batch Receipt");
  if (input.schemaVersion !== DEVELOP_BATCH_SCHEMA_VERSION || !Array.isArray(input.targetEntryIds) || !Array.isArray(input.items) || input.targetEntryIds.length !== input.items.length) fail("Develop batch Receipt is invalid.");
  const targetEntryIds = input.targetEntryIds.map(parseEntryId);
  if (targetEntryIds.length === 0 || targetEntryIds.length > DEVELOP_BATCH_MAX_TARGETS || new Set(targetEntryIds).size !== targetEntryIds.length) fail("Develop batch Receipt targets are invalid.");
  const items = input.items.map((value, index): DevelopBatchReceiptItem => {
    const item = record(value, `Develop batch Receipt item ${index}`);
    exact(item, ["position", "entryId", "operationId", "plannedRevisionId", "expectedRevisionId", "beforeRevisionId", "afterRevisionId", "restoreRevisionId", "state", "attempts", "updatedAt"], `Develop batch Receipt item ${index}`);
    const entryId = parseEntryId(item.entryId);
    if (entryId !== targetEntryIds[index]) fail("Develop batch Receipt order is invalid.");
    const position = integer(item.position, "Develop batch item position", 0, DEVELOP_BATCH_MAX_TARGETS - 1);
    if (position !== index) fail("Develop batch Receipt positions are invalid.");
    return {
      position,
      entryId,
      operationId: parseDevelopBatchOperationId(item.operationId),
      plannedRevisionId: parseDevelopRevisionId(item.plannedRevisionId),
      expectedRevisionId: parseDevelopRevisionId(item.expectedRevisionId),
      beforeRevisionId: item.beforeRevisionId === null ? null : parseDevelopRevisionId(item.beforeRevisionId),
      afterRevisionId: item.afterRevisionId === null ? null : parseDevelopRevisionId(item.afterRevisionId),
      restoreRevisionId: item.restoreRevisionId === null ? null : parseDevelopRevisionId(item.restoreRevisionId),
      state: parseDevelopBatchItemState(item.state),
      attempts: integer(item.attempts, "Develop batch attempts", 0, Number.MAX_SAFE_INTEGER),
      updatedAt: finite(item.updatedAt, "Develop batch item updatedAt"),
    };
  });
  if (typeof input.cancellationRequested !== "boolean") fail("Develop batch cancellation flag is invalid.");
  const receipt: DevelopBatchReceipt = {
    schemaVersion: DEVELOP_BATCH_SCHEMA_VERSION,
    catalogId: parseCatalogId(input.catalogId), batchId: parseDevelopBatchId(input.batchId), operationId: parseDevelopBatchOperationId(input.operationId), kind: batchKind(input.kind),
    sourceEntryId: input.sourceEntryId === null ? null : parseEntryId(input.sourceEntryId), sourceRevisionId: input.sourceRevisionId === null ? null : parseDevelopRevisionId(input.sourceRevisionId),
    targetEntryIds, operation: parseDevelopBatchOperation(input.operation), items,
    cancellationRequested: input.cancellationRequested,
    createdAt: finite(input.createdAt, "Develop batch createdAt"), updatedAt: finite(input.updatedAt, "Develop batch updatedAt"),
  };
  assertBatchKindOperation(receipt.kind, receipt.operation);
  if ((receipt.sourceEntryId === null) !== (receipt.sourceRevisionId === null)) {
    fail("Develop batch Receipt source is incomplete.");
  }
  if ((receipt.kind === "previous" || receipt.kind === "sync" || receipt.kind === "auto-sync") && receipt.sourceEntryId === null) {
    fail("Develop batch Receipt source is required.");
  }
  if ((receipt.kind === "batch" || receipt.kind === "undo") && receipt.sourceEntryId !== null) {
    fail("Develop batch Receipt carries an unused source.");
  }
  if (new Set(items.map((item) => item.operationId)).size !== items.length) {
    fail("Develop batch Receipt item operation IDs must be unique.");
  }
  if (new Set(items.map((item) => item.plannedRevisionId)).size !== items.length) {
    fail("Develop batch Receipt planned revision IDs must be unique.");
  }
  for (const item of items) {
    const beforeIsExpected = item.beforeRevisionId === item.expectedRevisionId;
    if (receipt.kind === "undo" ? item.restoreRevisionId === null : item.restoreRevisionId !== null) {
      fail("Develop batch Receipt restore revision is inconsistent with its kind.");
    }
    switch (item.state.kind) {
      case "queued":
      case "skipped":
      case "cancelled":
        if (item.beforeRevisionId !== null || item.afterRevisionId !== null) fail("Develop batch terminal revisions are inconsistent.");
        break;
      case "active":
        if (item.afterRevisionId !== null || (item.state.phase === "commit" ? !beforeIsExpected : item.beforeRevisionId !== null)) {
          fail("Develop batch active revisions are inconsistent with its phase.");
        }
        break;
      case "completed":
        if (
          item.state.entryId !== item.entryId ||
          item.state.revisionId !== item.afterRevisionId ||
          item.afterRevisionId !== item.plannedRevisionId ||
          !beforeIsExpected
        ) fail("Develop batch completed state is inconsistent with its item revisions.");
        break;
      case "failed":
        if (item.afterRevisionId !== null || (item.beforeRevisionId !== null && !beforeIsExpected)) {
          fail("Develop batch failed revisions are inconsistent.");
        }
        break;
      default: {
        const exhaustive: never = item.state;
        fail(`Develop batch item state is invalid: ${String(exhaustive)}.`);
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > DEVELOP_BATCH_MAX_JOB_BYTES) fail("Develop batch Receipt exceeds the byte limit.");
  return receipt;
}

function entryIds(value: unknown, label: string): readonly EntryId[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DEVELOP_BATCH_MAX_TARGETS) fail(`${label} is invalid.`);
  const parsed = value.map(parseEntryId);
  if (new Set(parsed).size !== parsed.length) fail(`${label} contains duplicates.`);
  return parsed;
}

export function parseDevelopBatchCommand(value: unknown): DevelopBatchCommand {
  const input = record(value, "Develop batch command");
  const kind = input.kind;
  if (kind === "create") { exact(input, ["kind", "input"], "Develop batch create command"); return { kind, input: parseDevelopBatchCreateInput(input.input) }; }
  if (kind === "get" || kind === "run" || kind === "cancel" || kind === "retry") {
    exact(input, ["kind", "catalogId", "batchId"], "Develop batch command");
    return { kind, catalogId: parseCatalogId(input.catalogId), batchId: parseDevelopBatchId(input.batchId) };
  }
  if (kind === "list") {
    exact(input, ["kind", "catalogId", "limit"], "Develop batch list command");
    return { kind, catalogId: parseCatalogId(input.catalogId), limit: integer(input.limit, "Develop batch list limit", 1, 1_000) };
  }
  if (kind === "freeze") {
    exact(input, ["kind", "catalogId", "batchId", "operationId", "batchKind", "sourceEntryId", "targetEntryIds", "operation", "createdAt"], "Develop batch freeze command");
    if (input.batchKind !== "sync" && input.batchKind !== "batch") fail("Develop batch freeze kind is invalid.");
    const operation = parseDevelopBatchOperation(input.operation);
    if (operation.kind === "undo") fail("Develop batch freeze operation is invalid.");
    return { kind, catalogId: parseCatalogId(input.catalogId), batchId: parseDevelopBatchId(input.batchId), operationId: parseDevelopBatchOperationId(input.operationId), batchKind: input.batchKind, sourceEntryId: input.sourceEntryId === null ? null : parseEntryId(input.sourceEntryId), targetEntryIds: entryIds(input.targetEntryIds, "Develop batch target IDs"), operation, createdAt: finite(input.createdAt, "Develop batch createdAt") };
  }
  if (kind === "previous") {
    exact(input, ["kind", "catalogId", "batchId", "operationId", "currentEntryId", "fields", "createdAt"], "Previous Develop command");
    return { kind, catalogId: parseCatalogId(input.catalogId), batchId: parseDevelopBatchId(input.batchId), operationId: parseDevelopBatchOperationId(input.operationId), currentEntryId: parseEntryId(input.currentEntryId), fields: fields(input.fields), createdAt: finite(input.createdAt, "Previous Develop createdAt") };
  }
  if (kind === "undo") {
    exact(input, ["kind", "catalogId", "sourceBatchId", "batchId", "operationId", "createdAt"], "Develop batch undo command");
    return { kind, catalogId: parseCatalogId(input.catalogId), sourceBatchId: parseDevelopBatchId(input.sourceBatchId), batchId: parseDevelopBatchId(input.batchId), operationId: parseDevelopBatchOperationId(input.operationId), createdAt: finite(input.createdAt, "Develop batch undo createdAt") };
  }
  if (kind === "auto-enable") {
    exact(input, ["kind", "catalogId", "sourceEntryId", "targetEntryIds", "fields", "updatedAt"], "Auto Sync enable command");
    return { kind, catalogId: parseCatalogId(input.catalogId), sourceEntryId: parseEntryId(input.sourceEntryId), targetEntryIds: entryIds(input.targetEntryIds, "Auto Sync target IDs"), fields: fields(input.fields), updatedAt: finite(input.updatedAt, "Auto Sync updatedAt") };
  }
  if (kind === "auto-disable") {
    exact(input, ["kind", "catalogId", "updatedAt"], "Auto Sync disable command");
    return { kind, catalogId: parseCatalogId(input.catalogId), updatedAt: finite(input.updatedAt, "Auto Sync updatedAt") };
  }
  if (kind === "auto-emit") {
    exact(input, ["kind", "catalogId", "batchId", "operationId", "sourceRevisionId", "createdAt"], "Auto Sync emit command");
    return { kind, catalogId: parseCatalogId(input.catalogId), batchId: parseDevelopBatchId(input.batchId), operationId: parseDevelopBatchOperationId(input.operationId), sourceRevisionId: parseDevelopRevisionId(input.sourceRevisionId), createdAt: finite(input.createdAt, "Auto Sync createdAt") };
  }
  return fail("Develop batch command kind is invalid.");
}

export function parseDevelopBatchCommandResult(value: unknown): DevelopBatchCommandResult {
  if (value === null) return null;
  return Array.isArray(value) ? value.map(parseDevelopBatchReceipt) : parseDevelopBatchReceipt(value);
}
