import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  parsePresetId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type PresetId,
  type RootId,
} from "../catalog/ids.ts";
import { parseRelativePath, parseSessionId, type SessionId } from "../catalog/runtime.ts";
import type {
  ImportAction,
  ImportDestinationDecision,
  ImportDuplicateDecision,
} from "./domain.ts";

export type CatalogManualImportAction = Exclude<ImportAction, "rename">;
export type CatalogManualImportDuplicatePolicy = Exclude<
  ImportDuplicateDecision["kind"],
  "use-existing-location"
>;
export type CatalogManualImportDestinationPolicy = Exclude<
  ImportDestinationDecision["kind"],
  "rename"
> | "rename";

export interface CatalogImportPrepareRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly action: CatalogManualImportAction;
  readonly destinationRootId: RootId;
  readonly presetId: PresetId | null;
  readonly duplicatePolicy: CatalogManualImportDuplicatePolicy;
  readonly destinationPolicy: CatalogManualImportDestinationPolicy;
}

export interface CatalogImportOperationRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
}

export interface CatalogImportPreparedItemView {
  readonly itemId: AssetId;
  readonly sourceName: string;
  readonly sourceRelativePath: string;
  readonly destinationRelativePath: string;
  readonly formatId: string;
  readonly duplicate: "unique" | "duplicate" | "not-fully-checked";
  readonly destinationConflict: boolean;
  readonly outcome: "run" | "skip" | "replace" | "rename";
}

export interface CatalogImportDraftView {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly action: CatalogManualImportAction;
  readonly presetName: string;
  readonly items: readonly CatalogImportPreparedItemView[];
  readonly canRun: boolean;
  readonly copyAsDng: {
    readonly status: "unavailable";
    readonly reason: string;
  };
}

export type CatalogImportItemStage =
  | "planned"
  | "destination-prepared"
  | "destination-published"
  | "catalog-applied"
  | "source-cleaned";

export interface CatalogImportItemResultView {
  readonly itemId: AssetId;
  readonly destinationAssetId: AssetId;
  readonly stage: CatalogImportItemStage;
  readonly status: "completed" | "skipped" | "failed" | "cancelled";
  readonly xmpStatus: "absent" | "preserved" | "mismatch";
  readonly sourceRetained: boolean;
  readonly error: string | null;
}

export interface CatalogImportExecutionView {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly state: "planned" | "running" | "completed" | "failed" | "cancelled";
  readonly items: readonly CatalogImportItemResultView[];
  readonly error: string | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${label} contains unexpected fields.`);
  }
}

function text(value: unknown, label: string, pathFree = false): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  if (pathFree && (value.includes("/") || value.includes("\\"))) {
    throw new Error(`${label} must not contain a path.`);
  }
  return value;
}

function nullableText(value: unknown, label: string, pathFree = false): string | null {
  return value === null ? null : text(value, label, pathFree);
}

export function parseCatalogImportPrepareRequest(
  value: unknown,
): CatalogImportPrepareRequest {
  const input = record(value, "Import prepare request");
  exactKeys(input, [
    "catalogId",
    "sessionId",
    "action",
    "destinationRootId",
    "presetId",
    "duplicatePolicy",
    "destinationPolicy",
  ], "Import prepare request");
  const action = input.action;
  if (action !== "add" && action !== "copy" && action !== "move") {
    throw new Error("Import action is invalid.");
  }
  const duplicatePolicy = input.duplicatePolicy;
  if (
    duplicatePolicy !== "skip-incoming" &&
    duplicatePolicy !== "continue-unchecked" &&
    duplicatePolicy !== "keep-both"
  ) {
    throw new Error("Import duplicate policy is invalid.");
  }
  const destinationPolicy = input.destinationPolicy;
  if (
    destinationPolicy !== "skip" &&
    destinationPolicy !== "replace" &&
    destinationPolicy !== "rename"
  ) {
    throw new Error("Import destination policy is invalid.");
  }
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    action,
    destinationRootId: parseRootId(input.destinationRootId),
    presetId: input.presetId === null ? null : parsePresetId(input.presetId),
    duplicatePolicy,
    destinationPolicy,
  };
}

export function parseCatalogImportOperationRequest(
  value: unknown,
): CatalogImportOperationRequest {
  const input = record(value, "Import operation request");
  exactKeys(input, ["catalogId", "sessionId", "operationId"], "Import operation request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
  };
}

function parsePreparedItemView(value: unknown): CatalogImportPreparedItemView {
  const input = record(value, "Import prepared item");
  exactKeys(input, [
    "itemId",
    "sourceName",
    "sourceRelativePath",
    "destinationRelativePath",
    "formatId",
    "duplicate",
    "destinationConflict",
    "outcome",
  ], "Import prepared item");
  const duplicate = input.duplicate;
  if (duplicate !== "unique" && duplicate !== "duplicate" && duplicate !== "not-fully-checked") {
    throw new Error("Import prepared item duplicate state is invalid.");
  }
  const outcome = input.outcome;
  if (outcome !== "run" && outcome !== "skip" && outcome !== "replace" && outcome !== "rename") {
    throw new Error("Import prepared item outcome is invalid.");
  }
  if (typeof input.destinationConflict !== "boolean") {
    throw new Error("Import prepared item destination conflict is invalid.");
  }
  return {
    itemId: parseAssetId(input.itemId),
    sourceName: text(input.sourceName, "Import source name", true),
    sourceRelativePath: parseRelativePath(input.sourceRelativePath, "Import source path"),
    destinationRelativePath: parseRelativePath(input.destinationRelativePath, "Import destination path"),
    formatId: text(input.formatId, "Import format id"),
    duplicate,
    destinationConflict: input.destinationConflict,
    outcome,
  };
}

export function parseCatalogImportDraftView(value: unknown): CatalogImportDraftView {
  const input = record(value, "Import draft");
  exactKeys(input, [
    "catalogId",
    "sessionId",
    "operationId",
    "action",
    "presetName",
    "items",
    "canRun",
    "copyAsDng",
  ], "Import draft");
  const action = input.action;
  if (action !== "add" && action !== "copy" && action !== "move") {
    throw new Error("Import draft action is invalid.");
  }
  if (!Array.isArray(input.items)) throw new Error("Import draft items are invalid.");
  if (typeof input.canRun !== "boolean") throw new Error("Import draft run state is invalid.");
  const dng = record(input.copyAsDng, "Import DNG capability");
  exactKeys(dng, ["status", "reason"], "Import DNG capability");
  if (dng.status !== "unavailable") throw new Error("Import DNG capability is invalid.");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
    action,
    presetName: text(input.presetName, "Import preset name", true),
    items: input.items.map(parsePreparedItemView),
    canRun: input.canRun,
    copyAsDng: {
      status: "unavailable",
      reason: text(dng.reason, "Import DNG reason", true),
    },
  };
}

function parseItemStage(value: unknown): CatalogImportItemStage {
  if (
    value !== "planned" &&
    value !== "destination-prepared" &&
    value !== "destination-published" &&
    value !== "catalog-applied" &&
    value !== "source-cleaned"
  ) {
    throw new Error("Import item stage is invalid.");
  }
  return value;
}

function parseItemResultView(value: unknown): CatalogImportItemResultView {
  const input = record(value, "Import item result");
  exactKeys(input, [
    "itemId",
    "destinationAssetId",
    "stage",
    "status",
    "xmpStatus",
    "sourceRetained",
    "error",
  ], "Import item result");
  if (
    input.status !== "completed" &&
    input.status !== "skipped" &&
    input.status !== "failed" &&
    input.status !== "cancelled"
  ) throw new Error("Import item status is invalid.");
  if (input.xmpStatus !== "absent" && input.xmpStatus !== "preserved" && input.xmpStatus !== "mismatch") {
    throw new Error("Import item XMP status is invalid.");
  }
  if (typeof input.sourceRetained !== "boolean") throw new Error("Import item source state is invalid.");
  return {
    itemId: parseAssetId(input.itemId),
    destinationAssetId: parseAssetId(input.destinationAssetId),
    stage: parseItemStage(input.stage),
    status: input.status,
    xmpStatus: input.xmpStatus,
    sourceRetained: input.sourceRetained,
    error: nullableText(input.error, "Import item error", true),
  };
}

export function parseCatalogImportExecutionView(value: unknown): CatalogImportExecutionView {
  const input = record(value, "Import execution");
  exactKeys(input, ["catalogId", "sessionId", "operationId", "state", "items", "error"], "Import execution");
  if (
    input.state !== "planned" &&
    input.state !== "running" &&
    input.state !== "completed" &&
    input.state !== "failed" &&
    input.state !== "cancelled"
  ) throw new Error("Import execution state is invalid.");
  if (!Array.isArray(input.items)) throw new Error("Import execution items are invalid.");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
    state: input.state,
    items: input.items.map(parseItemResultView),
    error: nullableText(input.error, "Import execution error", true),
  };
}
