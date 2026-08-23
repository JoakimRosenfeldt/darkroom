import type {
  AssetId,
  CatalogId,
  OperationId,
  PresetId,
  RootId,
} from "../catalog/ids.ts";
import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  parsePresetId,
  parseRootId,
} from "../catalog/ids.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ImportAction = "add" | "copy" | "move" | "rename";

export type ImportTemplateToken =
  | "filename"
  | "stem"
  | "extension"
  | "original"
  | "cameraMake"
  | "cameraModel"
  | "sequence"
  | "year"
  | "month"
  | "day";

export interface ImportTemplate {
  readonly pattern: string;
}

export interface ImportTemplateContext {
  readonly filename: string;
  readonly stem: string;
  readonly extension: string;
  readonly original: string;
  readonly cameraMake: string;
  readonly cameraModel: string;
  readonly sequence: number;
  readonly date: Date;
}

export interface FileObservation {
  readonly size: number;
  readonly modifiedAt: number;
  readonly localFileId: string | null;
  readonly observedAt: number;
}

export type XmpSourceState = "absent" | "present" | "unreadable";

export interface ImportSource {
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly observation: FileObservation;
  readonly xmpState: XmpSourceState;
  readonly formatId: string;
}

export interface ImportPreset {
  readonly catalogId: CatalogId;
  readonly presetId: PresetId;
  readonly name: string;
  readonly version: number;
  readonly template: ImportTemplate;
  readonly payload: JsonValue;
  readonly updatedAt: number;
}

export interface FrozenPresetSnapshot {
  readonly catalogId: CatalogId;
  readonly presetId: PresetId;
  readonly name: string;
  readonly version: number;
  readonly canonicalJson: string;
  readonly sha256: string;
}

export interface ImportPlanItem {
  readonly itemId: AssetId;
  readonly sourceAssetId: AssetId | null;
  readonly destinationAssetId: AssetId;
  readonly action: ImportAction;
  readonly source: ImportSource;
  readonly destinationRelativePath: string;
  readonly xmpDestinationRelativePath: string | null;
  readonly conflictDecisions: ImportConflictDecisions;
}

export type ImportDuplicateDecision =
  | { readonly kind: "skip-incoming" }
  | { readonly kind: "continue-unchecked" }
  | { readonly kind: "keep-both" }
  | { readonly kind: "use-existing-location"; readonly existingAssetId: AssetId };

export type ImportDestinationDecision =
  | { readonly kind: "skip" }
  | { readonly kind: "replace" }
  | { readonly kind: "rename"; readonly destinationRelativePath: string };

export interface ImportConflictDecisions {
  readonly duplicate: ImportDuplicateDecision | null;
  readonly destination: ImportDestinationDecision | null;
}

export interface ImportPlanDraft {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly destinationRootId: RootId;
  readonly preset: ImportPreset;
  readonly items: readonly ImportPlanItem[];
  readonly createdAt: number;
}

export interface FrozenImportPlan {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly destinationRootId: RootId;
  readonly preset: FrozenPresetSnapshot;
  readonly items: readonly ImportPlanItem[];
  readonly createdAt: number;
  readonly planSha256: string;
}

export interface ImportConflict {
  readonly itemId: AssetId;
  readonly destinationRelativePath: string;
  readonly kind: "destination-exists" | "duplicate" | "invalid-path" | "xmp-mismatch";
  readonly severity: "warning" | "error";
}

export interface ImportPlanReview {
  readonly planSha256: string;
  readonly conflicts: readonly ImportConflict[];
  readonly decisions: readonly {
    readonly itemId: AssetId;
    readonly decisions: ImportConflictDecisions;
  }[];
  readonly canFreeze: boolean;
}

export type DngAdapterResult =
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly reason: string };

const TEMPLATE_TOKEN_PATTERN = /\{\{([^{}]*)\}\}/g;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TEMPLATE_TOKENS: readonly ImportTemplateToken[] = [
  "filename",
  "stem",
  "extension",
  "original",
  "cameraMake",
  "cameraModel",
  "sequence",
  "year",
  "month",
  "day",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return value;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item));
}

export function parseJsonValue(value: unknown, label = "JSON value"): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`${label} is not valid JSON data.`);
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON cannot contain a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function isTemplateToken(value: string): value is ImportTemplateToken {
  return TEMPLATE_TOKENS.some((token) => token === value);
}

function sanitizeSegment(value: string, label: string): string {
  const sanitized = value.replace(/[\\/\0]/g, "_").trim();
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error(`${label} renders an empty path segment.`);
  }
  return sanitized;
}

function validateRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("Template must render a relative path.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Template contains an invalid path segment.");
  }
  return segments.join("/");
}

export function parseImportTemplate(value: unknown): ImportTemplate {
  if (!isRecord(value) || typeof value.pattern !== "string") {
    throw new Error("Import template is invalid.");
  }
  if (value.pattern.length === 0 || value.pattern.length > 512) {
    throw new Error("Import template length is invalid.");
  }
  const tokens = value.pattern.matchAll(TEMPLATE_TOKEN_PATTERN);
  const unmatched = value.pattern.replace(TEMPLATE_TOKEN_PATTERN, "");
  if (unmatched.includes("{{") || unmatched.includes("}}")) {
    throw new Error("Import template contains an unmatched token.");
  }
  for (const match of tokens) {
    const token = match[1];
    if (token === undefined || !isTemplateToken(token)) {
      throw new Error("Import template contains an unknown token.");
    }
  }
  return { pattern: value.pattern };
}

export function renderImportTemplate(
  template: ImportTemplate,
  context: ImportTemplateContext,
): string {
  parseImportTemplate(template);
  if (!Number.isFinite(context.date.getTime()) || !Number.isFinite(context.sequence)) {
    throw new Error("Import template context contains an invalid date or sequence.");
  }
  const filename = sanitizeSegment(context.filename, "Filename");
  const stem = sanitizeSegment(context.stem, "Stem");
  const extension = context.extension
    ? sanitizeSegment(context.extension.replace(/^\./, ""), "Extension")
    : "";
  const values: Record<ImportTemplateToken, string> = {
    filename,
    stem,
    extension,
    original: sanitizeSegment(context.original, "Original name"),
    cameraMake: sanitizeSegment(context.cameraMake || "Unknown", "Camera make"),
    cameraModel: sanitizeSegment(context.cameraModel || "Unknown", "Camera model"),
    sequence: String(Math.max(0, Math.trunc(context.sequence))).padStart(4, "0"),
    year: String(context.date.getFullYear()).padStart(4, "0"),
    month: String(context.date.getMonth() + 1).padStart(2, "0"),
    day: String(context.date.getDate()).padStart(2, "0"),
  };
  const rendered = template.pattern.replace(TEMPLATE_TOKEN_PATTERN, (_match, token: string) => {
    if (!isTemplateToken(token)) {
      throw new Error("Import template contains an unknown token.");
    }
    return values[token];
  });
  return validateRelativePath(rendered);
}

export function sameFileObservation(
  expected: FileObservation,
  actual: FileObservation,
): boolean {
  return (
    expected.size === actual.size &&
    expected.modifiedAt === actual.modifiedAt &&
    expected.localFileId === actual.localFileId
  );
}

export function parseFileObservation(value: unknown): FileObservation {
  if (!isRecord(value)) {
    throw new Error("File observation is invalid.");
  }
  const { size, modifiedAt, observedAt, localFileId } = value;
  if (
    typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
    typeof modifiedAt !== "number" || !Number.isFinite(modifiedAt) ||
    typeof observedAt !== "number" || !Number.isFinite(observedAt) ||
    (localFileId !== null && typeof localFileId !== "string")
  ) {
    throw new Error("File observation fields are invalid.");
  }
  return { size, modifiedAt, observedAt, localFileId };
}

function parseImportAction(value: unknown): ImportAction {
  if (value !== "add" && value !== "copy" && value !== "move" && value !== "rename") {
    throw new Error("Import action is invalid.");
  }
  return value;
}

function parseDuplicateDecision(value: unknown): ImportDuplicateDecision | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Import duplicate decision is invalid.");
  }
  if (
    value.kind === "skip-incoming" ||
    value.kind === "continue-unchecked" ||
    value.kind === "keep-both"
  ) {
    return { kind: value.kind };
  }
  if (value.kind === "use-existing-location") {
    return { kind: value.kind, existingAssetId: parseAssetId(value.existingAssetId) };
  }
  throw new Error("Import duplicate decision is invalid.");
}

function parseDestinationDecision(value: unknown): ImportDestinationDecision | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Import destination decision is invalid.");
  }
  if (value.kind === "skip" || value.kind === "replace") {
    return { kind: value.kind };
  }
  if (value.kind === "rename" && typeof value.destinationRelativePath === "string") {
    return { kind: "rename", destinationRelativePath: validateRelativePath(value.destinationRelativePath) };
  }
  throw new Error("Import destination decision is invalid.");
}

function parseXmpSourceState(value: unknown): XmpSourceState {
  if (value !== "absent" && value !== "present" && value !== "unreadable") {
    throw new Error("XMP source state is invalid.");
  }
  return value;
}

function parseImportSource(value: unknown): ImportSource {
  if (!isRecord(value) || typeof value.relativePath !== "string" || typeof value.formatId !== "string") {
    throw new Error("Import source is invalid.");
  }
  return {
    rootId: parseRootId(value.rootId),
    relativePath: validateRelativePath(value.relativePath),
    observation: parseFileObservation(value.observation),
    xmpState: parseXmpSourceState(value.xmpState),
    formatId: value.formatId,
  };
}

export function parseImportPreset(value: unknown): ImportPreset {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "number" || !Number.isSafeInteger(value.version) ||
    typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)
  ) {
    throw new Error("Import preset is invalid.");
  }
  return {
    catalogId: parseCatalogId(value.catalogId),
    presetId: parsePresetId(value.presetId),
    name: value.name,
    version: parseSafeInteger(value.version, "Preset version"),
    template: parseImportTemplate(value.template),
    payload: parseJsonValue(value.payload, "Import preset payload"),
    updatedAt: value.updatedAt,
  };
}

function parseFrozenPresetSnapshot(value: unknown): FrozenPresetSnapshot {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "number" || !Number.isSafeInteger(value.version) ||
    typeof value.canonicalJson !== "string" ||
    typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new Error("Frozen preset snapshot is invalid.");
  }
  return {
    catalogId: parseCatalogId(value.catalogId),
    presetId: parsePresetId(value.presetId),
    name: value.name,
    version: parseSafeInteger(value.version, "Frozen preset version"),
    canonicalJson: value.canonicalJson,
    sha256: value.sha256,
  };
}

function parseImportPlanItem(value: unknown): ImportPlanItem {
  if (
    !isRecord(value) ||
    typeof value.destinationRelativePath !== "string" ||
    (value.xmpDestinationRelativePath !== null && typeof value.xmpDestinationRelativePath !== "string")
  ) {
    throw new Error("Import plan item is invalid.");
  }
  return {
    itemId: parseAssetId(value.itemId),
    sourceAssetId: value.sourceAssetId === null ? null : parseAssetId(value.sourceAssetId),
    destinationAssetId: parseAssetId(value.destinationAssetId),
    action: parseImportAction(value.action),
    source: parseImportSource(value.source),
    destinationRelativePath: validateRelativePath(value.destinationRelativePath),
    xmpDestinationRelativePath:
      value.xmpDestinationRelativePath === null
        ? null
        : validateRelativePath(value.xmpDestinationRelativePath),
    conflictDecisions: {
      duplicate: parseDuplicateDecision(
        isRecord(value.conflictDecisions) ? value.conflictDecisions.duplicate ?? null : null,
      ),
      destination: parseDestinationDecision(
        isRecord(value.conflictDecisions) ? value.conflictDecisions.destination ?? null : null,
      ),
    },
  };
}

export function parseFrozenImportPlan(value: unknown): FrozenImportPlan {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) ||
    typeof value.planSha256 !== "string" || !SHA256_PATTERN.test(value.planSha256)
  ) {
    throw new Error("Frozen import plan is invalid.");
  }
  return {
    operationId: parseOperationId(value.operationId),
    catalogId: parseCatalogId(value.catalogId),
    destinationRootId: parseRootId(value.destinationRootId),
    preset: parseFrozenPresetSnapshot(value.preset),
    items: value.items.map((item) => parseImportPlanItem(item)),
    createdAt: value.createdAt,
    planSha256: value.planSha256,
  };
}
