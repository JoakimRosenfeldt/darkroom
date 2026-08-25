import { parseCatalogId, parseEntryId, parseOperationId, type CatalogId, type EntryId, type OperationId } from "../catalog/ids.ts";
import type { PersistedDevelopDocument } from "./v3/document.ts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type DevelopRevisionId = Brand<string, "DevelopRevisionId">;
export type DevelopRefId = Brand<string, "DevelopRefId">;
export type DevelopDocumentHash = Brand<string, "DevelopDocumentHash">;
export type DevelopHistoryJson = null | boolean | number | string | DevelopHistoryJson[] | { [key: string]: DevelopHistoryJson };

export const DEVELOP_HISTORY_CHECKPOINT_INTERVAL = 20;
export const DEVELOP_HISTORY_EARLY_CHECKPOINT_BYTES = 256 * 1024;
export const DEVELOP_HISTORY_MAX_PATCH_BYTES = 2 * 1024 * 1024;
export const DEVELOP_HISTORY_MAX_OPERATIONS = 100_000;
export const DEVELOP_HISTORY_MAX_DEPTH = 16;
export const DEVELOP_HISTORY_RETAINED_REVISIONS = 500;
export const DEVELOP_HISTORY_MAX_REFS_PER_KIND = 100;
export const DEVELOP_HISTORY_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const DEVELOP_HISTORY_MAX_CATALOG_BYTES = 1024 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
export type DevelopHistoryDocument = PersistedDevelopDocument | { readonly [key: string]: DevelopHistoryJson } | null;

type DevelopHistoryDocumentDecodeResult =
  | { readonly kind: "editable"; readonly document: PersistedDevelopDocument }
  | { readonly kind: "read-only-newer" }
  | { readonly kind: "invalid"; readonly message: string };

let documentDecoder: ((value: unknown) => DevelopHistoryDocumentDecodeResult) | null = null;

export function installDevelopHistoryDocumentDecoder(
  decoder: (value: unknown) => DevelopHistoryDocumentDecodeResult,
): void {
  documentDecoder = decoder;
}

export type DevelopPatchOperation =
  | { readonly kind: "set"; readonly path: readonly string[]; readonly value: DevelopHistoryJson }
  | { readonly kind: "remove"; readonly path: readonly string[] };

export interface DevelopHistoryPatch {
  readonly version: 1;
  readonly operations: readonly DevelopPatchOperation[];
}

export interface DevelopHistoryRevision {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly revisionId: DevelopRevisionId;
  readonly parentRevisionId: DevelopRevisionId | null;
  readonly operationId: OperationId;
  readonly ordinal: number;
  readonly label: string;
  readonly documentHash: DevelopDocumentHash;
  readonly checkpoint: boolean;
  readonly createdAt: number;
}

export interface DevelopHistoryRecoveryRevision extends DevelopHistoryRevision {
  readonly document: DevelopHistoryDocument;
}

export interface DevelopHistoryLoadedRevision extends DevelopHistoryRecoveryRevision {
  readonly headRevisionId: DevelopRevisionId;
}

export interface DevelopHistoryCorruption {
  readonly kind: "missing-head" | "missing-revision" | "cycle" | "checkpoint" | "patch" | "hash" | "document";
  readonly message: string;
  readonly failedRevisionId: DevelopRevisionId | null;
}

export type DevelopHistoryLoadResult =
  | { readonly kind: "loaded"; readonly value: DevelopHistoryLoadedRevision }
  | {
      readonly kind: "recovery";
      readonly catalogId: CatalogId;
      readonly entryId: EntryId;
      readonly requestedRevisionId: DevelopRevisionId | null;
      readonly headRevisionId: DevelopRevisionId | null;
      readonly lastValidRevision: DevelopHistoryRecoveryRevision | null;
      readonly corruption: DevelopHistoryCorruption;
    };

export type DevelopHistoryRefKind = "version" | "snapshot";

export interface DevelopHistoryRef {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly refId: DevelopRefId;
  readonly kind: DevelopHistoryRefKind;
  readonly name: string;
  readonly revisionId: DevelopRevisionId;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DevelopHistoryLoadInput {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly revisionId: DevelopRevisionId | null;
}

export interface DevelopHistoryListInput {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly limit: number;
}

export interface DevelopHistoryTargetInput {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
}

export interface DevelopHistoryCommitInput {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly revisionId: DevelopRevisionId;
  readonly expectedParentRevisionId: DevelopRevisionId;
  readonly operationId: OperationId;
  readonly label: string;
  readonly document: DevelopHistoryDocument;
  readonly createdAt: number;
}

export interface DevelopHistoryCommitResult {
  readonly revision: DevelopHistoryRevision;
  readonly idempotent: boolean;
}

export interface DevelopHistoryProjection {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly revisionId: DevelopRevisionId;
  readonly contentSha256: string;
  readonly projectedAt: number;
}

export type DevelopHistoryProjectionWriteInput = DevelopHistoryProjection;

export type DevelopHistoryRefMutationInput =
  | {
      readonly kind: "create";
      readonly catalogId: CatalogId;
      readonly entryId: EntryId;
      readonly refId: DevelopRefId;
      readonly refKind: DevelopHistoryRefKind;
      readonly name: string;
      readonly revisionId: DevelopRevisionId;
      readonly createdAt: number;
    }
  | {
      readonly kind: "rename";
      readonly catalogId: CatalogId;
      readonly entryId: EntryId;
      readonly refId: DevelopRefId;
      readonly name: string;
      readonly updatedAt: number;
    }
  | {
      readonly kind: "move";
      readonly catalogId: CatalogId;
      readonly entryId: EntryId;
      readonly refId: DevelopRefId;
      readonly revisionId: DevelopRevisionId;
      readonly updatedAt: number;
    }
  | {
      readonly kind: "delete";
      readonly catalogId: CatalogId;
      readonly entryId: EntryId;
      readonly refId: DevelopRefId;
    };

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) fail(`${label} has unknown fields.`);
}
function finite(value: unknown, label: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail(`${label} is invalid.`);
}
function integer(value: unknown, label: string, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fail(`${label} is invalid.`);
}
function text(value: unknown, label: string, maximum = 120): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) fail(`${label} is invalid.`);
  return value.trim();
}
function uuid<Name extends "DevelopRevisionId" | "DevelopRefId">(value: unknown, label: Name): Brand<string, Name> {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() as Brand<string, Name> : fail(`${label} must be a UUID.`);
}
export function parseDevelopRevisionId(value: unknown): DevelopRevisionId { return uuid(value, "DevelopRevisionId"); }
export function parseDevelopRefId(value: unknown): DevelopRefId { return uuid(value, "DevelopRefId"); }
export function createDevelopRevisionId(value?: string): DevelopRevisionId { return parseDevelopRevisionId(value ?? crypto.randomUUID()); }
export function createDevelopRefId(value?: string): DevelopRefId { return parseDevelopRefId(value ?? crypto.randomUUID()); }
export function parseDevelopDocumentHash(value: unknown): DevelopDocumentHash {
  return typeof value === "string" && SHA256.test(value) ? value as DevelopDocumentHash : fail("Develop document hash is invalid.");
}

export function parseDevelopHistoryJson(value: unknown, depth = 0, seen = new Set<object>()): DevelopHistoryJson {
  if (depth > DEVELOP_HISTORY_MAX_DEPTH) fail("Develop history JSON exceeds the depth limit.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fail("Develop history JSON number is invalid.");
  if (typeof value !== "object") fail("Develop history JSON value is invalid.");
  if (seen.has(value)) fail("Develop history JSON cannot be cyclic.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => parseDevelopHistoryJson(item, depth + 1, seen));
    const output = Object.create(null) as { [key: string]: DevelopHistoryJson };
    for (const key of Object.keys(value).sort()) {
      if (key.includes("\0")) fail("Develop history JSON key is invalid.");
      output[key] = parseDevelopHistoryJson(Reflect.get(value, key), depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalDevelopHistoryJson(value: unknown): string {
  return JSON.stringify(parseDevelopHistoryJson(value));
}

export function parseDevelopHistoryDocument(value: unknown): DevelopHistoryDocument {
  if (value === null) return null;
  const parsed = parseDevelopHistoryJson(value);
  const input = record(parsed, "Develop document");
  if (input.version === undefined) {
    return parsed as { readonly [key: string]: DevelopHistoryJson };
  }
  if (input.version !== 2 && input.version !== 3) {
    if (typeof input.version === "number" && input.version > 3) fail("Newer Develop documents are read-only.");
    fail("Develop document version is invalid.");
  }
  if (documentDecoder !== null) {
    const decoded = documentDecoder(value);
    if (decoded.kind === "editable") return decoded.document;
    if (decoded.kind === "read-only-newer") fail("Newer Develop documents are read-only.");
    fail(decoded.message);
  }
  if (input.version === 2) {
    record(input.settings, "Develop document settings");
    record(input.maskAssets, "Develop document mask assets");
  } else {
    if (input.process !== "darkroom-v3" || typeof input.schemaRevision !== "string") fail("Develop V3 document identity is invalid.");
    for (const key of ["tone", "color", "optics", "geometry", "local", "cleanup", "presence", "detail", "effects", "hdr", "compatibility"] as const) {
      record(input[key], `Develop V3 ${key}`);
    }
  }
  return parsed as unknown as PersistedDevelopDocument;
}

export function canonicalDevelopHistoryDocument(value: unknown): string {
  return JSON.stringify(parseDevelopHistoryDocument(value));
}

export function collectDevelopHistoryAssetHashes(document: DevelopHistoryDocument): readonly string[] {
  if (document === null || document.version !== 3) return [];
  const hashes = new Set<string>();
  const visit = (value: DevelopHistoryJson): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const assetId = value.assetId;
    const sha256 = value.sha256;
    if (typeof assetId === "string" && assetId === sha256 && SHA256.test(assetId)) hashes.add(assetId);
    for (const child of Object.values(value)) visit(child);
  };
  visit(parseDevelopHistoryJson(document));
  return [...hashes].sort();
}

function sameJson(left: DevelopHistoryJson, right: DevelopHistoryJson): boolean {
  return canonicalDevelopHistoryJson(left) === canonicalDevelopHistoryJson(right);
}

export function diffDevelopHistory(before: unknown, after: unknown): DevelopHistoryPatch {
  const left = parseDevelopHistoryJson(before);
  const right = parseDevelopHistoryJson(after);
  const operations: DevelopPatchOperation[] = [];
  const visit = (oldValue: DevelopHistoryJson, newValue: DevelopHistoryJson, path: readonly string[], depth: number): void => {
    if (sameJson(oldValue, newValue)) return;
    if (depth >= DEVELOP_HISTORY_MAX_DEPTH || Array.isArray(oldValue) || Array.isArray(newValue) || oldValue === null || newValue === null || typeof oldValue !== "object" || typeof newValue !== "object") {
      operations.push({ kind: "set", path, value: newValue });
      return;
    }
    const oldRecord = oldValue as { [key: string]: DevelopHistoryJson };
    const newRecord = newValue as { [key: string]: DevelopHistoryJson };
    for (const key of Object.keys(oldRecord).sort()) if (!Object.hasOwn(newRecord, key)) operations.push({ kind: "remove", path: [...path, key] });
    for (const key of Object.keys(newRecord).sort()) {
      if (!Object.hasOwn(oldRecord, key)) operations.push({ kind: "set", path: [...path, key], value: newRecord[key]! });
      else visit(oldRecord[key]!, newRecord[key]!, [...path, key], depth + 1);
      if (operations.length > DEVELOP_HISTORY_MAX_OPERATIONS) fail("Develop history patch exceeds the operation limit.");
    }
  };
  visit(left, right, [], 0);
  return { version: 1, operations };
}

export function parseDevelopHistoryPatch(value: unknown): DevelopHistoryPatch {
  const input = record(value, "Develop history patch");
  exactKeys(input, ["version", "operations"], "Develop history patch");
  if (input.version !== 1 || !Array.isArray(input.operations) || input.operations.length > DEVELOP_HISTORY_MAX_OPERATIONS) fail("Develop history patch is invalid.");
  const operations = input.operations.map((item, index): DevelopPatchOperation => {
    const operation = record(item, `Develop history patch operation ${index}`);
    const kind = operation.kind;
    if (!Array.isArray(operation.path) || operation.path.length > DEVELOP_HISTORY_MAX_DEPTH || operation.path.some((part) => typeof part !== "string" || part.includes("\0"))) fail("Develop history patch path is invalid.");
    const path = operation.path as string[];
    if (kind === "remove") { exactKeys(operation, ["kind", "path"], "Develop history remove operation"); return { kind, path }; }
    if (kind === "set") { exactKeys(operation, ["kind", "path", "value"], "Develop history set operation"); return { kind, path, value: parseDevelopHistoryJson(operation.value) }; }
    return fail("Develop history patch operation kind is invalid.");
  });
  const patch = { version: 1 as const, operations };
  if (new TextEncoder().encode(JSON.stringify(patch)).byteLength > DEVELOP_HISTORY_MAX_PATCH_BYTES) fail("Develop history patch exceeds the byte limit.");
  return patch;
}

export function replayDevelopHistory(base: unknown, patchValue: unknown): DevelopHistoryJson {
  let document = parseDevelopHistoryJson(base);
  const patch = parseDevelopHistoryPatch(patchValue);
  for (const operation of patch.operations) {
    if (operation.path.length === 0) {
      if (operation.kind === "remove") fail("Develop history cannot remove the document root.");
      document = parseDevelopHistoryJson(operation.value);
      continue;
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) fail("Develop history patch parent is invalid.");
    let parent = document as { [key: string]: DevelopHistoryJson };
    for (const part of operation.path.slice(0, -1)) {
      const child = parent[part];
      if (typeof child !== "object" || child === null || Array.isArray(child)) fail("Develop history patch parent is missing.");
      parent = child as { [key: string]: DevelopHistoryJson };
    }
    const key = operation.path.at(-1)!;
    if (operation.kind === "remove") delete parent[key];
    else Object.defineProperty(parent, key, {
      value: parseDevelopHistoryJson(operation.value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return parseDevelopHistoryJson(document);
}

function refKind(value: unknown): DevelopHistoryRefKind {
  return value === "version" || value === "snapshot" ? value : fail("Develop history ref kind is invalid.");
}

export function parseDevelopHistoryLoadInput(value: unknown): DevelopHistoryLoadInput {
  const input = record(value, "Develop history load input"); exactKeys(input, ["catalogId", "entryId", "revisionId"], "Develop history load input");
  return { catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), revisionId: input.revisionId === null ? null : parseDevelopRevisionId(input.revisionId) };
}
export function parseDevelopHistoryListInput(value: unknown): DevelopHistoryListInput {
  const input = record(value, "Develop history list input"); exactKeys(input, ["catalogId", "entryId", "limit"], "Develop history list input");
  return { catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), limit: integer(input.limit, "Develop history list limit", 1, DEVELOP_HISTORY_RETAINED_REVISIONS) };
}
export function parseDevelopHistoryTargetInput(value: unknown): DevelopHistoryTargetInput {
  const input = record(value, "Develop history target");
  exactKeys(input, ["catalogId", "entryId"], "Develop history target");
  return { catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId) };
}
export function parseDevelopHistoryCommitInput(value: unknown): DevelopHistoryCommitInput {
  const input = record(value, "Develop history commit input"); exactKeys(input, ["catalogId", "entryId", "revisionId", "expectedParentRevisionId", "operationId", "label", "document", "createdAt"], "Develop history commit input");
  return { catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), revisionId: parseDevelopRevisionId(input.revisionId), expectedParentRevisionId: parseDevelopRevisionId(input.expectedParentRevisionId), operationId: parseOperationId(input.operationId), label: text(input.label, "Develop history label"), document: parseDevelopHistoryDocument(input.document), createdAt: finite(input.createdAt, "Develop history createdAt") };
}
export function parseDevelopHistoryRefMutationInput(value: unknown): DevelopHistoryRefMutationInput {
  const input = record(value, "Develop history ref mutation");
  if (input.kind === "create") { exactKeys(input, ["kind", "catalogId", "entryId", "refId", "refKind", "name", "revisionId", "createdAt"], "Develop history ref create"); return { kind: "create", catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), refId: parseDevelopRefId(input.refId), refKind: refKind(input.refKind), name: text(input.name, "Develop history ref name"), revisionId: parseDevelopRevisionId(input.revisionId), createdAt: finite(input.createdAt, "Develop history ref createdAt") }; }
  if (input.kind === "rename") { exactKeys(input, ["kind", "catalogId", "entryId", "refId", "name", "updatedAt"], "Develop history ref rename"); return { kind: "rename", catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), refId: parseDevelopRefId(input.refId), name: text(input.name, "Develop history ref name"), updatedAt: finite(input.updatedAt, "Develop history ref updatedAt") }; }
  if (input.kind === "move") { exactKeys(input, ["kind", "catalogId", "entryId", "refId", "revisionId", "updatedAt"], "Develop history ref move"); return { kind: "move", catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), refId: parseDevelopRefId(input.refId), revisionId: parseDevelopRevisionId(input.revisionId), updatedAt: finite(input.updatedAt, "Develop history ref updatedAt") }; }
  if (input.kind === "delete") { exactKeys(input, ["kind", "catalogId", "entryId", "refId"], "Develop history ref delete"); return { kind: "delete", catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), refId: parseDevelopRefId(input.refId) }; }
  return fail("Develop history ref mutation kind is invalid.");
}

export function parseDevelopHistoryRevision(value: unknown): DevelopHistoryRevision {
  const input = record(value, "Develop history revision"); exactKeys(input, ["catalogId", "entryId", "revisionId", "parentRevisionId", "operationId", "ordinal", "label", "documentHash", "checkpoint", "createdAt"], "Develop history revision");
  if (typeof input.checkpoint !== "boolean") fail("Develop history checkpoint is invalid.");
  return { catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), revisionId: parseDevelopRevisionId(input.revisionId), parentRevisionId: input.parentRevisionId === null ? null : parseDevelopRevisionId(input.parentRevisionId), operationId: parseOperationId(input.operationId), ordinal: integer(input.ordinal, "Develop history ordinal", 0, Number.MAX_SAFE_INTEGER), label: text(input.label, "Develop history label"), documentHash: parseDevelopDocumentHash(input.documentHash), checkpoint: input.checkpoint, createdAt: finite(input.createdAt, "Develop history createdAt") };
}
export function parseDevelopHistoryLoadedRevision(value: unknown): DevelopHistoryLoadedRevision {
  const input = record(value, "Loaded Develop history revision");
  exactKeys(input, ["catalogId", "entryId", "revisionId", "parentRevisionId", "operationId", "ordinal", "label", "documentHash", "checkpoint", "createdAt", "document", "headRevisionId"], "Loaded Develop history revision");
  const revision = parseDevelopHistoryRevision(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "document" && key !== "headRevisionId")));
  return { ...revision, document: parseDevelopHistoryDocument(input.document), headRevisionId: parseDevelopRevisionId(input.headRevisionId) };
}
export function parseDevelopHistoryRecoveryRevision(value: unknown): DevelopHistoryRecoveryRevision {
  const input = record(value, "Develop history recovery revision");
  exactKeys(input, ["catalogId", "entryId", "revisionId", "parentRevisionId", "operationId", "ordinal", "label", "documentHash", "checkpoint", "createdAt", "document"], "Develop history recovery revision");
  const revision = parseDevelopHistoryRevision(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "document")));
  return { ...revision, document: parseDevelopHistoryDocument(input.document) };
}
export function parseDevelopHistoryLoadResult(value: unknown): DevelopHistoryLoadResult {
  const input = record(value, "Develop history load result");
  if (input.kind === "loaded") {
    exactKeys(input, ["kind", "value"], "Develop history loaded result");
    return { kind: "loaded", value: parseDevelopHistoryLoadedRevision(input.value) };
  }
  if (input.kind !== "recovery") return fail("Develop history load result kind is invalid.");
  exactKeys(input, ["kind", "catalogId", "entryId", "requestedRevisionId", "headRevisionId", "lastValidRevision", "corruption"], "Develop history recovery result");
  const corruption = record(input.corruption, "Develop history corruption");
  exactKeys(corruption, ["kind", "message", "failedRevisionId"], "Develop history corruption");
  const corruptionKind = corruption.kind;
  if (corruptionKind !== "missing-head" && corruptionKind !== "missing-revision" && corruptionKind !== "cycle" && corruptionKind !== "checkpoint" && corruptionKind !== "patch" && corruptionKind !== "hash" && corruptionKind !== "document") fail("Develop history corruption kind is invalid.");
  return {
    kind: "recovery",
    catalogId: parseCatalogId(input.catalogId),
    entryId: parseEntryId(input.entryId),
    requestedRevisionId: input.requestedRevisionId === null ? null : parseDevelopRevisionId(input.requestedRevisionId),
    headRevisionId: input.headRevisionId === null ? null : parseDevelopRevisionId(input.headRevisionId),
    lastValidRevision: input.lastValidRevision === null ? null : parseDevelopHistoryRecoveryRevision(input.lastValidRevision),
    corruption: {
      kind: corruptionKind,
      message: text(corruption.message, "Develop history corruption message", 1_024),
      failedRevisionId: corruption.failedRevisionId === null ? null : parseDevelopRevisionId(corruption.failedRevisionId),
    },
  };
}
export function parseDevelopHistoryCommitResult(value: unknown): DevelopHistoryCommitResult {
  const input = record(value, "Develop history commit result"); exactKeys(input, ["revision", "idempotent"], "Develop history commit result");
  if (typeof input.idempotent !== "boolean") fail("Develop history idempotence is invalid.");
  return { revision: parseDevelopHistoryRevision(input.revision), idempotent: input.idempotent };
}
export function parseDevelopHistoryProjection(value: unknown): DevelopHistoryProjection {
  const input = record(value, "Develop history projection");
  exactKeys(input, ["catalogId", "entryId", "revisionId", "contentSha256", "projectedAt"], "Develop history projection");
  if (typeof input.contentSha256 !== "string" || !SHA256.test(input.contentSha256)) fail("Develop history projection digest is invalid.");
  return {
    catalogId: parseCatalogId(input.catalogId),
    entryId: parseEntryId(input.entryId),
    revisionId: parseDevelopRevisionId(input.revisionId),
    contentSha256: input.contentSha256,
    projectedAt: finite(input.projectedAt, "Develop history projectedAt"),
  };
}
export function parseDevelopHistoryProjectionWriteInput(value: unknown): DevelopHistoryProjectionWriteInput {
  return parseDevelopHistoryProjection(value);
}
export function parseDevelopHistoryRef(value: unknown): DevelopHistoryRef {
  const input = record(value, "Develop history ref"); exactKeys(input, ["catalogId", "entryId", "refId", "kind", "name", "revisionId", "createdAt", "updatedAt"], "Develop history ref");
  return { catalogId: parseCatalogId(input.catalogId), entryId: parseEntryId(input.entryId), refId: parseDevelopRefId(input.refId), kind: refKind(input.kind), name: text(input.name, "Develop history ref name"), revisionId: parseDevelopRevisionId(input.revisionId), createdAt: finite(input.createdAt, "Develop history ref createdAt"), updatedAt: finite(input.updatedAt, "Develop history ref updatedAt") };
}
