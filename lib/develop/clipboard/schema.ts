import {
  parseAssetId,
  parseCatalogId,
  parseEntryId,
  parseSourceId,
  type AssetId,
  type CatalogId,
  type EntryId,
  type SourceId,
} from "../../catalog/ids.ts";
import type { EntryMetadata } from "../../catalog/types.ts";
import {
  DEVELOP_PRESET_FIELDS,
  parseDevelopPresetPayload,
  type DevelopPresetField,
  type DevelopPresetPayloadEntry,
} from "../presets/schema.ts";
import {
  parseDevelopAssetRefs,
  type DevelopAssetRef,
} from "../v3/assets.ts";
import { V3_DOCUMENT_SCHEMA_REVISION } from "../v3/document.ts";

export const DEVELOP_CLIPBOARD_SCHEMA_VERSION = 1;
export const DEVELOP_CLIPBOARD_MAX_BYTES = 2 * 1024 * 1024;
export const DEVELOP_CLIPBOARD_MAX_NODES = 100_000;
export const DEVELOP_CLIPBOARD_MAX_DEPTH = 16;
export const DEVELOP_CLIPBOARD_MAX_REFS = 10_000;
export const DEVELOP_CLIPBOARD_TEXT_PREFIX = "DARKROOM-DEVELOP-SETTINGS/1\n";

export const DEVELOP_CLIPBOARD_GROUPS = [
  ...DEVELOP_PRESET_FIELDS,
  "metadata",
] as const;

export type DevelopClipboardGroup = (typeof DEVELOP_CLIPBOARD_GROUPS)[number];

export const DEFAULT_DEVELOP_CLIPBOARD_GROUPS: readonly DevelopClipboardGroup[] = [
  "basic",
  "mixer",
  "effects",
  "tone-curves",
];

export interface DevelopClipboardSource {
  readonly catalogId: CatalogId;
  readonly entryId: EntryId;
  readonly sourceId: SourceId;
  readonly assetId: AssetId;
  readonly assetRevision: number;
  readonly size: number;
  readonly lastModified: number;
}

export type DevelopClipboardMetadata = Pick<
  EntryMetadata,
  "pick" | "rating" | "colorLabel"
>;

export interface DevelopClipboardPayload {
  readonly schemaVersion: typeof DEVELOP_CLIPBOARD_SCHEMA_VERSION;
  readonly source: DevelopClipboardSource;
  readonly document: {
    readonly process: "darkroom-v3";
    readonly schemaRevision: typeof V3_DOCUMENT_SCHEMA_REVISION;
  };
  readonly createdAt: number;
  readonly selectedGroups: readonly DevelopClipboardGroup[];
  readonly payload: readonly DevelopPresetPayloadEntry[];
  readonly assetRefs: readonly DevelopAssetRef[];
  readonly metadata: DevelopClipboardMetadata | null;
}

export type DevelopClipboardReadResult =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "ready"; readonly payload: DevelopClipboardPayload };

function fail(message: string): never {
  throw new Error(message);
}

function record(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object.`);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    return fail(`${label} has unknown fields.`);
  }
  return input;
}

function finiteInteger(
  value: unknown,
  label: string,
  minimum: number,
): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : fail(`${label} is invalid.`);
}

function finiteNumber(value: unknown, label: string, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? value
    : fail(`${label} is invalid.`);
}

function boundedJson(value: unknown): void {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > DEVELOP_CLIPBOARD_MAX_NODES) {
      fail("Develop clipboard data exceeds the node limit.");
    }
    if (depth > DEVELOP_CLIPBOARD_MAX_DEPTH) {
      fail("Develop clipboard data exceeds the depth limit.");
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("Develop clipboard data contains a non-finite number.");
      return;
    }
    if (typeof item === "string") {
      if (item.length > 4_096 || item.includes("\0")) {
        fail("Develop clipboard data contains an invalid string.");
      }
      return;
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) fail("Develop clipboard data contains a cycle.");
      seen.add(item);
      item.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (typeof item !== "object") fail("Develop clipboard data is not JSON.");
    if (seen.has(item)) fail("Develop clipboard data contains a cycle.");
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (
        key.length === 0 ||
        key.length > 256 ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor" ||
        key.includes("\0")
      ) {
        fail("Develop clipboard data contains an invalid field name.");
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > DEVELOP_CLIPBOARD_MAX_BYTES) {
    fail("Develop clipboard data exceeds the byte limit.");
  }
}

function clipboardGroup(value: unknown): DevelopClipboardGroup {
  return DEVELOP_CLIPBOARD_GROUPS.find((group) => group === value) ??
    fail("Develop clipboard group is not supported.");
}

export function parseDevelopClipboardGroups(
  value: unknown,
): readonly DevelopClipboardGroup[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > DEVELOP_CLIPBOARD_GROUPS.length) {
    return fail("Develop clipboard groups are invalid.");
  }
  const groups = value.map(clipboardGroup);
  if (new Set(groups).size !== groups.length) {
    return fail("Develop clipboard groups contain duplicates.");
  }
  return groups;
}

function metadata(value: unknown): DevelopClipboardMetadata {
  const input = record(value, "Develop clipboard metadata", [
    "pick",
    "rating",
    "colorLabel",
  ]);
  const pick = input.pick === "none" || input.pick === "pick" || input.pick === "reject"
    ? input.pick
    : fail("Develop clipboard pick is invalid.");
  const rating = input.rating === 0 || input.rating === 1 || input.rating === 2 ||
    input.rating === 3 || input.rating === 4 || input.rating === 5
    ? input.rating
    : fail("Develop clipboard rating is invalid.");
  const colorLabel = input.colorLabel === null || input.colorLabel === "red" ||
    input.colorLabel === "yellow" || input.colorLabel === "green" ||
    input.colorLabel === "blue" || input.colorLabel === "purple"
    ? input.colorLabel
    : fail("Develop clipboard color label is invalid.");
  return { pick, rating, colorLabel };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") return fail("Develop clipboard data is not JSON.");
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function requireNormalizedClipboardCurves(payload: readonly DevelopPresetPayloadEntry[]): void {
  const curves = payload.find((entry) => entry.field === "tone-curves");
  if (!curves || curves.field !== "tone-curves") return;
  for (const points of [curves.value.rgb, curves.value.red, curves.value.green, curves.value.blue]) {
    if (points.length !== 256 || points.some((point, index) => point.x !== index / 255)) {
      fail("Develop clipboard tone curves must contain 256 normalized samples per channel.");
    }
  }
}

export function parseDevelopClipboardPayload(value: unknown): DevelopClipboardPayload {
  boundedJson(value);
  const input = record(value, "Develop clipboard payload", [
    "schemaVersion",
    "source",
    "document",
    "createdAt",
    "selectedGroups",
    "payload",
    "assetRefs",
    "metadata",
  ]);
  if (input.schemaVersion !== DEVELOP_CLIPBOARD_SCHEMA_VERSION) {
    return fail("Develop clipboard schema is not supported.");
  }
  const sourceValue = record(input.source, "Develop clipboard source", [
    "catalogId",
    "entryId",
    "sourceId",
    "assetId",
    "assetRevision",
    "size",
    "lastModified",
  ]);
  const source: DevelopClipboardSource = {
    catalogId: parseCatalogId(sourceValue.catalogId),
    entryId: parseEntryId(sourceValue.entryId),
    sourceId: parseSourceId(sourceValue.sourceId),
    assetId: parseAssetId(sourceValue.assetId),
    assetRevision: finiteInteger(sourceValue.assetRevision, "Develop clipboard asset revision", 0),
    size: finiteInteger(sourceValue.size, "Develop clipboard source size", 0),
    lastModified: finiteNumber(sourceValue.lastModified, "Develop clipboard source modified time", 0),
  };
  const documentValue = record(input.document, "Develop clipboard document", [
    "process",
    "schemaRevision",
  ]);
  if (
    documentValue.process !== "darkroom-v3" ||
    documentValue.schemaRevision !== V3_DOCUMENT_SCHEMA_REVISION
  ) {
    return fail("Develop clipboard process is not supported.");
  }
  const selectedGroups = parseDevelopClipboardGroups(input.selectedGroups);
  const developFields = selectedGroups.filter(
    (group): group is DevelopPresetField => group !== "metadata",
  );
  const payload = developFields.length === 0
    ? Array.isArray(input.payload) && input.payload.length === 0
      ? []
      : fail("Metadata-only clipboard data cannot contain Develop fields.")
    : parseDevelopPresetPayload(input.payload, developFields);
  requireNormalizedClipboardCurves(payload);
  if (!Array.isArray(input.assetRefs) || input.assetRefs.length > DEVELOP_CLIPBOARD_MAX_REFS) {
    return fail("Develop clipboard asset references are invalid.");
  }
  const assetRefs = parseDevelopAssetRefs(input.assetRefs);
  if (canonical(input.assetRefs) !== canonical(assetRefs)) {
    return fail("Develop clipboard asset references contain unknown fields.");
  }
  const payloadAssetRefs = payload.flatMap((item) =>
    item.field === "ai-masks" ? item.value.assetRefs : [],
  );
  if (canonical(assetRefs) !== canonical(payloadAssetRefs)) {
    return fail("Develop clipboard asset references do not match the selected fields.");
  }
  const includesMetadata = selectedGroups.includes("metadata");
  if (includesMetadata !== (input.metadata !== null)) {
    return fail("Develop clipboard metadata does not match the selected groups.");
  }
  return {
    schemaVersion: DEVELOP_CLIPBOARD_SCHEMA_VERSION,
    source,
    document: {
      process: "darkroom-v3",
      schemaRevision: V3_DOCUMENT_SCHEMA_REVISION,
    },
    createdAt: finiteInteger(input.createdAt, "Develop clipboard creation time", 0),
    selectedGroups,
    payload,
    assetRefs,
    metadata: input.metadata === null ? null : metadata(input.metadata),
  };
}

export function serializeDevelopClipboardPayload(value: unknown): string {
  const payload = parseDevelopClipboardPayload(value);
  return `${DEVELOP_CLIPBOARD_TEXT_PREFIX}${JSON.stringify(payload)}`;
}

export function parseDevelopClipboardText(value: unknown): DevelopClipboardPayload {
  if (typeof value !== "string" || !value.startsWith(DEVELOP_CLIPBOARD_TEXT_PREFIX)) {
    return fail("Clipboard does not contain Darkroom Develop settings.");
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > DEVELOP_CLIPBOARD_MAX_BYTES + DEVELOP_CLIPBOARD_TEXT_PREFIX.length) {
    return fail("Develop clipboard data exceeds the byte limit.");
  }
  const json = value.slice(DEVELOP_CLIPBOARD_TEXT_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return fail("Develop clipboard data is not valid JSON.");
  }
  return parseDevelopClipboardPayload(parsed);
}

export function parseDevelopClipboardReadResult(value: unknown): DevelopClipboardReadResult {
  const input = record(value, "Develop clipboard read result", ["kind", "reason", "payload"]);
  if (input.kind === "empty") {
    record(value, "Empty Develop clipboard result", ["kind"]);
    return { kind: "empty" };
  }
  if (input.kind === "invalid") {
    record(value, "Invalid Develop clipboard result", ["kind", "reason"]);
    if (typeof input.reason !== "string" || input.reason.length === 0 || input.reason.length > 512) {
      return fail("Develop clipboard error is invalid.");
    }
    return { kind: "invalid", reason: input.reason };
  }
  if (input.kind === "ready") {
    record(value, "Ready Develop clipboard result", ["kind", "payload"]);
    return { kind: "ready", payload: parseDevelopClipboardPayload(input.payload) };
  }
  return fail("Develop clipboard result kind is invalid.");
}
