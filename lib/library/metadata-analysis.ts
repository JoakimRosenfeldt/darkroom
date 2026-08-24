import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  type AssetId,
  type CatalogId,
  type OperationId,
} from "../catalog/ids";
import { parseSessionId, type SessionId } from "../catalog/runtime";
import { parseEntryAnalysis, type EntryAnalysis } from "./model";

export interface MetadataAnalysisRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly entryIds: readonly AssetId[];
}

export interface MetadataAnalysisOperationRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
}

export interface MetadataAnalysisItem {
  readonly entryId: AssetId;
  readonly analysis: EntryAnalysis;
}

export interface MetadataAnalysisResult extends MetadataAnalysisProgress {
  readonly items: readonly MetadataAnalysisItem[];
}

export interface MetadataAnalysisProgress extends MetadataAnalysisOperationRequest {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: boolean;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const output: RecordValue = {};
  for (const [key, item] of Object.entries(value)) output[key] = item;
  return output;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a nonnegative integer.`);
  }
  return value;
}

export function parseMetadataAnalysisOperationRequest(
  value: unknown,
): MetadataAnalysisOperationRequest {
  const input = record(value, "Metadata analysis operation request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
  };
}

export function parseMetadataAnalysisRequest(value: unknown): MetadataAnalysisRequest {
  const input = record(value, "Metadata analysis request");
  const operation = parseMetadataAnalysisOperationRequest(input);
  if (!Array.isArray(input.entryIds) || input.entryIds.length > 50_000) {
    throw new Error("Metadata analysis entryIds are invalid.");
  }
  return {
    ...operation,
    entryIds: [...new Set(input.entryIds.map((entryId) => parseAssetId(entryId)))],
  };
}

export function parseMetadataAnalysisProgress(value: unknown): MetadataAnalysisProgress {
  const input = record(value, "Metadata analysis progress");
  const operation = parseMetadataAnalysisOperationRequest(input);
  if (typeof input.cancelled !== "boolean") {
    throw new Error("Metadata analysis progress cancelled is invalid.");
  }
  const total = nonnegativeInteger(input.total, "Metadata analysis progress total");
  const completed = nonnegativeInteger(input.completed, "Metadata analysis progress completed");
  const failed = nonnegativeInteger(input.failed, "Metadata analysis progress failed");
  if (completed > total || failed > completed) {
    throw new Error("Metadata analysis progress counts are invalid.");
  }
  return { ...operation, total, completed, failed, cancelled: input.cancelled };
}

export function parseMetadataAnalysisResult(value: unknown): MetadataAnalysisResult {
  const input = record(value, "Metadata analysis result");
  const progress = parseMetadataAnalysisProgress(input);
  if (!Array.isArray(input.items)) throw new Error("Metadata analysis result items are invalid.");
  const items = input.items.map((item, index) => {
    const source = record(item, `Metadata analysis result items[${index}]`);
    return {
      entryId: parseAssetId(source.entryId),
      analysis: parseEntryAnalysis(
        source.analysis,
        `Metadata analysis result items[${index}].analysis`,
      ),
    };
  });
  if (items.length !== progress.completed) {
    throw new Error("Metadata analysis result counts are inconsistent.");
  }
  return { ...progress, items };
}
