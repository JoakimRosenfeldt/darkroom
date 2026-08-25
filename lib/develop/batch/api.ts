import { parseCatalogId, parseEntryId, type CatalogId, type EntryId } from "../../catalog/ids.ts";
import { parseSessionId, type SessionId } from "../../catalog/runtime.ts";
import { parseDevelopPresetField, type DevelopPresetField } from "../presets/policy.ts";
import { parseDevelopPresetId, type DevelopPresetId } from "../presets/schema.ts";
import { parseDevelopBatchId, parseDevelopBatchReceipt, type DevelopBatchId, type DevelopBatchReceipt } from "./domain.ts";

export type DevelopBatchSelectedOperation =
  | { readonly kind: "preset"; readonly presetId: DevelopPresetId; readonly revision: number; readonly fields: readonly DevelopPresetField[] | null; readonly amount: number }
  | { readonly kind: "clipboard"; readonly fields: readonly DevelopPresetField[] }
  | { readonly kind: "section-reset"; readonly fields: readonly DevelopPresetField[] }
  | { readonly kind: "selected-control"; readonly field: DevelopPresetField };

interface BatchSessionRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

export type DevelopBatchStartRequest =
  | (BatchSessionRequest & { readonly kind: "previous"; readonly currentEntryId: EntryId; readonly fields: readonly DevelopPresetField[] })
  | (BatchSessionRequest & { readonly kind: "sync"; readonly sourceEntryId: EntryId; readonly targetEntryIds: readonly EntryId[]; readonly fields: readonly DevelopPresetField[] })
  | (BatchSessionRequest & { readonly kind: "batch"; readonly sourceEntryId: EntryId; readonly targetEntryIds: readonly EntryId[]; readonly operation: DevelopBatchSelectedOperation });

export interface DevelopBatchListRequest extends BatchSessionRequest {
  readonly limit: number;
}

export interface DevelopBatchTargetRequest extends BatchSessionRequest {
  readonly batchId: DevelopBatchId;
}

export interface DevelopBatchAutoSyncRequest extends BatchSessionRequest {
  readonly sourceEntryId: EntryId;
  readonly targetEntryIds: readonly EntryId[];
  readonly fields: readonly DevelopPresetField[];
}

export type DevelopBatchUpdate = {
  readonly catalogId: CatalogId;
  readonly receipts: readonly DevelopBatchReceipt[];
};

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} has unknown fields.`);
}
function fields(value: unknown): readonly DevelopPresetField[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) fail("Develop batch fields are invalid.");
  const parsed = value.map(parseDevelopPresetField);
  if (new Set(parsed).size !== parsed.length) fail("Develop batch fields contain duplicates.");
  return parsed;
}
function entryIds(value: unknown): readonly EntryId[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) fail("Develop batch target entries are invalid.");
  const parsed = value.map(parseEntryId);
  if (new Set(parsed).size !== parsed.length) fail("Develop batch target entries contain duplicates.");
  return parsed;
}
function session(input: Record<string, unknown>): BatchSessionRequest {
  return { catalogId: parseCatalogId(input.catalogId), sessionId: parseSessionId(input.sessionId) };
}

function selectedOperation(value: unknown): DevelopBatchSelectedOperation {
  const input = record(value, "Develop batch selected operation");
  if (input.kind === "preset") {
    exact(input, ["kind", "presetId", "revision", "fields", "amount"], "Develop batch preset operation");
    if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || !Number.isFinite(input.amount) || Number(input.amount) < 0 || Number(input.amount) > 100) fail("Develop batch preset revision or amount is invalid.");
    return { kind: "preset", presetId: parseDevelopPresetId(input.presetId), revision: Number(input.revision), fields: input.fields === null ? null : fields(input.fields), amount: Number(input.amount) };
  }
  if (input.kind === "clipboard") {
    exact(input, ["kind", "fields"], "Develop batch clipboard operation");
    return { kind: "clipboard", fields: fields(input.fields) };
  }
  if (input.kind === "section-reset") {
    exact(input, ["kind", "fields"], "Develop batch reset operation");
    return { kind: "section-reset", fields: fields(input.fields) };
  }
  if (input.kind === "selected-control") {
    exact(input, ["kind", "field"], "Develop batch control operation");
    return { kind: "selected-control", field: parseDevelopPresetField(input.field) };
  }
  return fail("Develop batch selected operation kind is invalid.");
}

export function parseDevelopBatchStartRequest(value: unknown): DevelopBatchStartRequest {
  const input = record(value, "Develop batch start request");
  if (input.kind === "previous") {
    exact(input, ["kind", "catalogId", "sessionId", "currentEntryId", "fields"], "Previous Develop request");
    return { kind: "previous", ...session(input), currentEntryId: parseEntryId(input.currentEntryId), fields: fields(input.fields) };
  }
  if (input.kind === "sync") {
    exact(input, ["kind", "catalogId", "sessionId", "sourceEntryId", "targetEntryIds", "fields"], "Sync Develop request");
    return { kind: "sync", ...session(input), sourceEntryId: parseEntryId(input.sourceEntryId), targetEntryIds: entryIds(input.targetEntryIds), fields: fields(input.fields) };
  }
  if (input.kind === "batch") {
    exact(input, ["kind", "catalogId", "sessionId", "sourceEntryId", "targetEntryIds", "operation"], "Batch Develop request");
    return { kind: "batch", ...session(input), sourceEntryId: parseEntryId(input.sourceEntryId), targetEntryIds: entryIds(input.targetEntryIds), operation: selectedOperation(input.operation) };
  }
  return fail("Develop batch start kind is invalid.");
}

export function parseDevelopBatchListRequest(value: unknown): DevelopBatchListRequest {
  const input = record(value, "Develop batch list request");
  exact(input, ["catalogId", "sessionId", "limit"], "Develop batch list request");
  if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 250) fail("Develop batch list limit is invalid.");
  return { ...session(input), limit: Number(input.limit) };
}

export function parseDevelopBatchTargetRequest(value: unknown): DevelopBatchTargetRequest {
  const input = record(value, "Develop batch target request");
  exact(input, ["catalogId", "sessionId", "batchId"], "Develop batch target request");
  return { ...session(input), batchId: parseDevelopBatchId(input.batchId) };
}

export function parseDevelopBatchAutoSyncRequest(value: unknown): DevelopBatchAutoSyncRequest {
  const input = record(value, "Auto Sync request");
  exact(input, ["catalogId", "sessionId", "sourceEntryId", "targetEntryIds", "fields"], "Auto Sync request");
  return { ...session(input), sourceEntryId: parseEntryId(input.sourceEntryId), targetEntryIds: entryIds(input.targetEntryIds), fields: fields(input.fields) };
}

export function parseDevelopBatchReceiptList(value: unknown): readonly DevelopBatchReceipt[] {
  if (!Array.isArray(value) || value.length > 250) fail("Develop batch Receipt list is invalid.");
  return value.map(parseDevelopBatchReceipt);
}

export function parseDevelopBatchUpdate(value: unknown): DevelopBatchUpdate {
  const input = record(value, "Develop batch update");
  exact(input, ["catalogId", "receipts"], "Develop batch update");
  return { catalogId: parseCatalogId(input.catalogId), receipts: parseDevelopBatchReceiptList(input.receipts) };
}
