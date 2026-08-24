import {
  parseAssetId,
  parseCatalogId,
  type AssetId,
  type CatalogId,
} from "../catalog/ids";
import { parseSessionId, type SessionId } from "../catalog/runtime";

export interface ExactDuplicateTrashRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly keeperId: AssetId;
  readonly targetIds: readonly AssetId[];
}

export interface ExactDuplicateTrashItemResult {
  readonly entryId: AssetId;
  readonly trashed: boolean;
  readonly error: string | null;
}

export interface ExactDuplicateTrashResult {
  readonly items: readonly ExactDuplicateTrashItemResult[];
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

export function parseExactDuplicateTrashRequest(value: unknown): ExactDuplicateTrashRequest {
  const input = record(value, "Exact duplicate trash request");
  if (!Array.isArray(input.targetIds) || input.targetIds.length === 0 || input.targetIds.length > 10_000) {
    throw new Error("Exact duplicate trash targets are invalid.");
  }
  const keeperId = parseAssetId(input.keeperId);
  const targetIds = [...new Set(input.targetIds.map(parseAssetId))].filter((id) => id !== keeperId);
  if (targetIds.length === 0) throw new Error("Exact duplicate trash needs a non-keeper target.");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    keeperId,
    targetIds,
  };
}

export function parseExactDuplicateTrashResult(value: unknown): ExactDuplicateTrashResult {
  const input = record(value, "Exact duplicate trash result");
  if (!Array.isArray(input.items)) throw new Error("Exact duplicate trash items are invalid.");
  return {
    items: input.items.map((item, index) => {
      const source = record(item, `Exact duplicate trash items[${index}]`);
      if (typeof source.trashed !== "boolean") throw new Error("Exact duplicate trash status is invalid.");
      if (source.error !== null && typeof source.error !== "string") {
        throw new Error("Exact duplicate trash error is invalid.");
      }
      return {
        entryId: parseAssetId(source.entryId),
        trashed: source.trashed,
        error: source.error,
      };
    }),
  };
}
