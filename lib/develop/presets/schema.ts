import { parseSourceId, type SourceId } from "../../catalog/ids.ts";
import { ASPECT_RATIO_PRESETS } from "../crop-geometry.ts";
import type { CurveSettings, MixerSettings } from "../types.ts";
import type {
  BasicToneEdits,
  GlobalColorEdits,
  PersistedCrop,
  PersistedInputProfile,
  PostCropEffects,
} from "../v3/document.ts";
import { parseLocalMasksV3, referencedMaskArtifacts, type LocalMaskV3 } from "../v3/masking.ts";
import type { PresenceSettings } from "../v3/presence.ts";
import type { DevelopSharpeningSettings, StandardDenoiseSettings } from "../v3/detail.ts";
import type { DevelopAssetRef } from "../v3/assets.ts";
import { parseDevelopAssetRefs } from "../v3/assets.ts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type DevelopPresetId = Brand<string, "DevelopPresetId">;
export const DEVELOP_PRESET_SCHEMA_VERSION = 1;
export const DEVELOP_PRESET_MAX_BYTES = 2 * 1024 * 1024;
export const DEVELOP_PRESET_MAX_NODES = 100_000;
export const DEVELOP_PRESET_MAX_DEPTH = 16;
export const DEVELOP_PRESET_MAX_RECORDS = 10_000;
export const DEVELOP_PRESET_MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export const DEVELOP_PRESET_FIELDS = [
  "basic",
  "mixer",
  "effects",
  "tone-curves",
  "camera-profile",
  "crop",
  "manual-masks",
  "ai-masks",
] as const;

export type DevelopPresetField = (typeof DEVELOP_PRESET_FIELDS)[number];
export type DevelopPresetSource = "built-in" | "user" | "imported";

export interface BasicPresetValues {
  readonly tone: BasicToneEdits;
  readonly global: GlobalColorEdits;
  readonly whiteBalanceAdjustment: { readonly temperature: number; readonly tint: number };
}

export interface EffectsPresetValues {
  readonly presence: PresenceSettings;
  readonly noiseReduction: StandardDenoiseSettings;
  readonly sharpening: DevelopSharpeningSettings;
  readonly postCrop: PostCropEffects;
}

export type DevelopPresetPayloadEntry =
  | { readonly field: "basic"; readonly value: BasicPresetValues }
  | { readonly field: "mixer"; readonly value: MixerSettings }
  | { readonly field: "effects"; readonly value: EffectsPresetValues }
  | { readonly field: "tone-curves"; readonly value: CurveSettings }
  | { readonly field: "camera-profile"; readonly value: PersistedInputProfile }
  | { readonly field: "crop"; readonly value: PersistedCrop }
  | { readonly field: "manual-masks"; readonly value: readonly LocalMaskV3[] }
  | {
      readonly field: "ai-masks";
      readonly value: {
        readonly sourceId: SourceId;
        readonly masks: readonly LocalMaskV3[];
        readonly assetRefs: readonly DevelopAssetRef[];
      };
    };

export interface DevelopPresetCompatibility {
  readonly process: "darkroom-v3";
  readonly documentSchemaRevision: "darkroom-v3-document-2";
}

export interface DevelopPresetRecord {
  readonly schemaVersion: typeof DEVELOP_PRESET_SCHEMA_VERSION;
  readonly presetId: DevelopPresetId;
  readonly revision: number;
  readonly name: string;
  readonly author: string;
  readonly category: string;
  readonly source: DevelopPresetSource;
  readonly favorite: boolean;
  readonly fields: readonly DevelopPresetField[];
  readonly payload: readonly DevelopPresetPayloadEntry[];
  readonly compatibility: DevelopPresetCompatibility;
}

export interface AppliedPresetState {
  readonly presetId: DevelopPresetId;
  readonly revision: number;
  readonly amount: number;
  readonly includedFields: readonly DevelopPresetField[];
  readonly baseline: readonly DevelopPresetPayloadEntry[];
  readonly target: readonly DevelopPresetPayloadEntry[];
  readonly lastExpanded: readonly DevelopPresetPayloadEntry[];
  readonly linkState: "linked" | "modified";
}

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
  const input = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (Object.keys(input).some((key) => !expected.has(key))) fail(`${label} has unknown fields.`);
  return input;
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    return fail(`${label} is invalid.`);
  }
  return value.trim();
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return fail(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function integer(value: unknown, label: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid.`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  return typeof value === "boolean" ? value : fail(`${label} must be boolean.`);
}

function serializedSize(value: unknown): number {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > DEVELOP_PRESET_MAX_NODES) fail("Develop preset exceeds the JSON node limit.");
    if (depth > DEVELOP_PRESET_MAX_DEPTH) fail("Develop preset exceeds the JSON depth limit.");
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("Develop preset contains a non-finite number.");
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (typeof item !== "object") fail("Develop preset is not JSON data.");
    for (const [key, child] of Object.entries(item)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor" || key.includes("\0")) {
        fail("Develop preset contains an invalid field name.");
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return fail("Develop preset is not serializable JSON data.");
  }
  return new TextEncoder().encode(json).byteLength;
}

function boundedPreset(value: unknown, maximumBytes = DEVELOP_PRESET_MAX_BYTES): void {
  if (serializedSize(value) > maximumBytes) fail("Develop preset exceeds the byte limit.");
}

export function parseDevelopPresetId(value: unknown): DevelopPresetId {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase() as DevelopPresetId
    : fail("DevelopPresetId must be a UUID.");
}

export function createDevelopPresetId(value?: string): DevelopPresetId {
  return parseDevelopPresetId(value ?? crypto.randomUUID());
}

export function parseDevelopPresetSha256(value: unknown): string {
  return typeof value === "string" && SHA256.test(value)
    ? value.toLowerCase()
    : fail("Develop preset SHA-256 is invalid.");
}

function presetField(value: unknown): DevelopPresetField {
  const found = DEVELOP_PRESET_FIELDS.find((field) => field === value);
  return found ?? fail("Develop preset field is not supported.");
}

function exactObject(value: unknown, label: string, bounds: Readonly<Record<string, readonly [number, number]>>): Record<string, number> {
  const input = record(value, label, Object.keys(bounds));
  return Object.fromEntries(Object.entries(bounds).map(([key, [minimum, maximum]]) => [
    key,
    finite(input[key], `${label}.${key}`, minimum, maximum),
  ]));
}

function basic(value: unknown): BasicPresetValues {
  const input = record(value, "basic preset payload", ["tone", "global", "whiteBalanceAdjustment"]);
  const tone = exactObject(input.tone, "basic preset tone", {
    exposure: [-5, 5], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], whites: [-100, 100], blacks: [-100, 100],
  });
  const global = exactObject(input.global, "basic preset global", { vibrance: [-100, 100], saturation: [-100, 100] });
  const whiteBalanceAdjustment = exactObject(input.whiteBalanceAdjustment, "basic preset white balance", { temperature: [-3_000, 3_000], tint: [-150, 150] });
  return {
    tone: tone as unknown as BasicToneEdits,
    global: global as unknown as GlobalColorEdits,
    whiteBalanceAdjustment: whiteBalanceAdjustment as unknown as BasicPresetValues["whiteBalanceAdjustment"],
  };
}

const MIXER_COLORS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;

function mixer(value: unknown): MixerSettings {
  const input = record(value, "mixer preset payload", MIXER_COLORS);
  return Object.fromEntries(MIXER_COLORS.map((color) => [color, exactObject(input[color], `mixer preset ${color}`, {
    hue: [-100, 100], saturation: [-100, 100], luminance: [-100, 100],
  })])) as unknown as MixerSettings;
}

function effects(value: unknown): EffectsPresetValues {
  const input = record(value, "effects preset payload", ["presence", "noiseReduction", "sharpening", "postCrop"]);
  return {
    presence: exactObject(input.presence, "effects preset presence", { texture: [-100, 100], clarity: [-100, 100], dehaze: [-100, 100] }) as unknown as PresenceSettings,
    noiseReduction: exactObject(input.noiseReduction, "effects preset noise reduction", {
      noiseReduction: [0, 100], noiseDetail: [0, 100], noiseContrast: [0, 100], colorNoiseReduction: [0, 100], colorNoiseDetail: [0, 100], colorNoiseSmoothness: [0, 100],
    }) as unknown as StandardDenoiseSettings,
    sharpening: exactObject(input.sharpening, "effects preset sharpening", {
      sharpening: [0, 100], sharpenRadius: [0.5, 3], sharpenDetail: [0, 100], sharpenMasking: [0, 100],
    }) as unknown as DevelopSharpeningSettings,
    postCrop: exactObject(input.postCrop, "effects preset post crop", {
      vignette: [-100, 100], vignetteMidpoint: [0, 100], vignetteRoundness: [-100, 100], vignetteFeather: [0, 100], vignetteHighlights: [0, 100], grain: [0, 100], grainSize: [0, 100], grainRoughness: [0, 100],
    }) as unknown as PostCropEffects,
  };
}

function curve(value: unknown, label: string): CurveSettings[keyof CurveSettings] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 256) fail(`${label} must contain 2 to 256 points.`);
  const points = value.map((item, index) => {
    const point = record(item, `${label}[${index}]`, ["x", "y"]);
    return { x: finite(point.x, `${label}[${index}].x`, 0, 1), y: finite(point.y, `${label}[${index}].y`, 0, 1) };
  });
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.x <= points[index - 1]!.x) fail(`${label} x values must increase.`);
  }
  return points;
}

function curves(value: unknown): CurveSettings {
  const input = record(value, "tone curve preset payload", ["rgb", "red", "green", "blue"]);
  return { rgb: curve(input.rgb, "rgb curve"), red: curve(input.red, "red curve"), green: curve(input.green, "green curve"), blue: curve(input.blue, "blue curve") };
}

function profile(value: unknown): PersistedInputProfile {
  const input = record(value, "camera profile preset payload", ["registryRevision", "selection", "calibration"]);
  if (typeof input.selection !== "object" || input.selection === null || Array.isArray(input.selection)) fail("Camera profile selection must be an object.");
  const rawSelection = input.selection as Record<string, unknown>;
  let parsedSelection: PersistedInputProfile["selection"];
  if (rawSelection.kind === "decoder-default") {
    record(input.selection, "camera profile selection", ["kind"]);
    parsedSelection = { kind: "decoder-default" };
  } else if (rawSelection.kind === "selected") {
    const selection = record(input.selection, "camera profile selection", ["kind", "profileId", "profileRevision"]);
    parsedSelection = { kind: "selected", profileId: text(selection.profileId, "profileId"), profileRevision: text(selection.profileRevision, "profileRevision") };
  } else if (rawSelection.kind === "unavailable") {
    const selection = record(input.selection, "camera profile selection", ["kind", "reason"]);
    parsedSelection = { kind: "unavailable", reason: text(selection.reason, "profile reason", 4_096) };
  }
  else parsedSelection = fail("Camera profile selection is invalid.");
  const calibration = record(input.calibration, "camera profile calibration", ["matrixToLinearSrgb", "channelScale", "exposureOffsetEv"]);
  const tuple = (item: unknown, label: string, length: number, minimum: number, maximum: number): number[] => {
    if (!Array.isArray(item) || item.length !== length) fail(`${label} has the wrong length.`);
    return item.map((part, index) => finite(part, `${label}[${index}]`, minimum, maximum));
  };
  const matrix = tuple(calibration.matrixToLinearSrgb, "profile matrix", 9, -16, 16);
  const channels = tuple(calibration.channelScale, "profile channel scale", 3, 0.0625, 16);
  return {
    registryRevision: text(input.registryRevision, "profile registry revision"),
    selection: parsedSelection,
    calibration: {
      matrixToLinearSrgb: [matrix[0]!, matrix[1]!, matrix[2]!, matrix[3]!, matrix[4]!, matrix[5]!, matrix[6]!, matrix[7]!, matrix[8]!],
      channelScale: [channels[0]!, channels[1]!, channels[2]!],
      exposureOffsetEv: finite(calibration.exposureOffsetEv, "profile exposure offset", -8, 8),
    },
  };
}

function crop(value: unknown): PersistedCrop {
  const input = record(value, "crop preset payload", ["enabled", "x", "y", "width", "height", "aspectPreset", "customAspectWidth", "customAspectHeight"]);
  const width = finite(input.width, "crop width", 0.05, 1);
  const height = finite(input.height, "crop height", 0.05, 1);
  const x = finite(input.x, "crop x", 0, 1);
  const y = finite(input.y, "crop y", 0, 1);
  if (x + width > 1 || y + height > 1) fail("Crop extends outside normalized bounds.");
  const aspectPreset = ASPECT_RATIO_PRESETS.find((candidate) => candidate.id === input.aspectPreset)?.id ?? fail("Crop aspect preset is invalid.");
  return {
    enabled: bool(input.enabled, "crop enabled"), x, y, width, height, aspectPreset,
    customAspectWidth: finite(input.customAspectWidth, "crop custom aspect width", 0.01, 1_000),
    customAspectHeight: finite(input.customAspectHeight, "crop custom aspect height", 0.01, 1_000),
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") return fail("Preset payload is not JSON data.");
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function parsedMasks(value: unknown, kind: "manual" | "ai"): readonly LocalMaskV3[] {
  if (!Array.isArray(value)) fail(`${kind} masks must be an array.`);
  const parsed = parseLocalMasksV3(value);
  if (canonical(value) !== canonical(parsed)) fail(`${kind} masks contain unknown or normalized fields.`);
  const valid = parsed.every((mask) => {
    const sources = maskSources(mask);
    return sources.length > 0 && sources.every((sourceKind) => kind === "manual" ? sourceKind !== "ai-matte" && sourceKind !== "depth-range" : sourceKind === "ai-matte");
  });
  if (!valid) fail(`${kind} masks contain unsupported mask sources.`);
  return parsed;
}

function maskSources(mask: LocalMaskV3): readonly string[] {
  const visit = (expression: LocalMaskV3["expression"]): string[] => {
    switch (expression.kind) {
      case "source": return [expression.source.kind];
      case "combine": return [...visit(expression.left), ...visit(expression.right)];
      case "invert": return visit(expression.child);
      default: { const exhaustive: never = expression; return exhaustive; }
    }
  };
  return visit(mask.expression);
}

function aiMasks(value: unknown): Extract<DevelopPresetPayloadEntry, { readonly field: "ai-masks" }>["value"] {
  const input = record(value, "AI mask preset payload", ["sourceId", "masks", "assetRefs"]);
  const masks = parsedMasks(input.masks, "ai");
  const assetRefs = parseDevelopAssetRefs(input.assetRefs);
  if (canonical(input.assetRefs) !== canonical(assetRefs)) fail("AI mask asset references contain unknown or normalized fields.");
  if (assetRefs.some((asset) => asset.kind !== "mask-matte")) fail("AI mask presets support only mask-matte assets.");
  const referenced = new Set(masks.flatMap((mask) => referencedMaskArtifacts(mask.expression).map((asset) => asset.assetId)));
  if (referenced.size !== assetRefs.length || assetRefs.some((asset) => !referenced.has(asset.assetId))) {
    fail("AI mask asset references do not match the masks.");
  }
  return { sourceId: parseSourceId(input.sourceId), masks, assetRefs };
}

function payloadEntry(value: unknown): DevelopPresetPayloadEntry {
  const input = record(value, "Develop preset payload entry", ["field", "value"]);
  const field = presetField(input.field);
  switch (field) {
    case "basic": return { field, value: basic(input.value) };
    case "mixer": return { field, value: mixer(input.value) };
    case "effects": return { field, value: effects(input.value) };
    case "tone-curves": return { field, value: curves(input.value) };
    case "camera-profile": return { field, value: profile(input.value) };
    case "crop": return { field, value: crop(input.value) };
    case "manual-masks": return { field, value: parsedMasks(input.value, "manual") };
    case "ai-masks": return { field, value: aiMasks(input.value) };
    default: { const exhaustive: never = field; return exhaustive; }
  }
}

export function parseDevelopPresetPayload(value: unknown, fieldsValue: unknown): readonly DevelopPresetPayloadEntry[] {
  if (!Array.isArray(fieldsValue) || fieldsValue.length === 0 || fieldsValue.length > DEVELOP_PRESET_FIELDS.length) fail("Develop preset fields are invalid.");
  const fields = fieldsValue.map(presetField);
  if (new Set(fields).size !== fields.length) fail("Develop preset fields contain duplicates.");
  if (!Array.isArray(value) || value.length !== fields.length) fail("Develop preset payload does not match its fields.");
  const payload = value.map(payloadEntry);
  if (new Set(payload.map((entry) => entry.field)).size !== payload.length) fail("Develop preset payload contains duplicates.");
  if (fields.some((field) => !payload.some((entry) => entry.field === field))) fail("Develop preset payload is missing a declared field.");
  return fields.map((field) => payload.find((entry) => entry.field === field)!);
}

export function parseDevelopPresetRecord(value: unknown): DevelopPresetRecord {
  boundedPreset(value);
  const input = record(value, "Develop preset", ["schemaVersion", "presetId", "revision", "name", "author", "category", "source", "favorite", "fields", "payload", "compatibility"]);
  if (input.schemaVersion !== DEVELOP_PRESET_SCHEMA_VERSION) fail("Develop preset schema version is not supported.");
  const source = input.source === "built-in" || input.source === "user" || input.source === "imported" ? input.source : fail("Develop preset source is invalid.");
  const compatibility = record(input.compatibility, "Develop preset compatibility", ["process", "documentSchemaRevision"]);
  if (compatibility.process !== "darkroom-v3" || compatibility.documentSchemaRevision !== "darkroom-v3-document-2") fail("Develop preset compatibility is not supported.");
  const payload = parseDevelopPresetPayload(input.payload, input.fields);
  return {
    schemaVersion: DEVELOP_PRESET_SCHEMA_VERSION,
    presetId: parseDevelopPresetId(input.presetId),
    revision: integer(input.revision, "Develop preset revision"),
    name: text(input.name, "Develop preset name"),
    author: text(input.author, "Develop preset author"),
    category: text(input.category, "Develop preset category"),
    source,
    favorite: bool(input.favorite, "Develop preset favorite"),
    fields: payload.map((entry) => entry.field),
    payload,
    compatibility: { process: "darkroom-v3", documentSchemaRevision: "darkroom-v3-document-2" },
  };
}

export function parseAppliedPresetState(value: unknown): AppliedPresetState {
  boundedPreset(value, 8 * 1024 * 1024);
  const input = record(value, "Applied preset state", ["presetId", "revision", "amount", "includedFields", "baseline", "target", "lastExpanded", "linkState"]);
  if (input.linkState !== "linked" && input.linkState !== "modified") fail("Applied preset link state is invalid.");
  const baseline = parseDevelopPresetPayload(input.baseline, input.includedFields);
  const target = parseDevelopPresetPayload(input.target, input.includedFields);
  const lastExpanded = parseDevelopPresetPayload(input.lastExpanded, input.includedFields);
  return {
    presetId: parseDevelopPresetId(input.presetId),
    revision: integer(input.revision, "Applied preset revision"),
    amount: finite(input.amount, "Applied preset amount", 0, 100),
    includedFields: baseline.map((entry) => entry.field),
    baseline,
    target,
    lastExpanded,
    linkState: input.linkState,
  };
}

export function canonicalDevelopPresetJson(value: unknown): string {
  return canonical(parseDevelopPresetRecord(value));
}

export function cloneDevelopPreset<T extends DevelopPresetRecord | AppliedPresetState>(value: T): T {
  return structuredClone(value);
}
