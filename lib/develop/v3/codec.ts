import { ASPECT_RATIO_PRESETS } from "../crop-geometry";
import { parseDevelopDocument, parseDevelopLocalMasks } from "../document";
import {
  COORDINATE_FRAME_REVISION,
  DEVELOP_PROCESS_ID,
  DEVELOP_PROCESS_VERSION,
  type DevelopDiagnostic,
} from "../process";
import {
  parseDevelopAssetRefs,
  type DevelopAssetRef,
} from "./assets";
import { parseCleanupLayer } from "./cleanup";
import type {
  CurvePoint,
  CurveSettings,
  MixerBandSettings,
  MixerColor,
  MixerSettings,
} from "../types";
import {
  MAX_POINT_COLOR_SAMPLES,
  type PointColorAdjustment,
} from "./point-color";
import {
  LEGACY_V3_DOCUMENT_SCHEMA_REVISION,
  V3_DOCUMENT_SCHEMA_REVISION,
  type DevelopDocumentV3,
  type HdrEdits,
  type InputProfileSelection,
  type NewerDevelopDocument,
  type JsonValue,
  type LensProfileSelection,
  type PersistedDevelopDocument,
  type PersistedGeometry,
  type PersistedInputProfile,
  type PersistedOptics,
  type PersistedWhiteBalance,
  type PostCropEffects,
  type QuarantinedV3Field,
  type V3Compatibility,
} from "./document";
import {
  migrateLegacyMask,
  parseLocalMasksV3,
  referencedMaskArtifacts,
} from "./masking";
import type { Homography, QuarterTurns } from "./geometry";
import { parseLensBlurSettings } from "./lens-blur";
import type { Matrix3, Rgb } from "./profiles";

export const MAX_V3_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_V3_QUARANTINE_BYTES = 64 * 1024;
export const MAX_V3_QUARANTINE_FIELDS = 64;
export const MAX_V3_EXTERNAL_FIELDS = 256;

const MAX_STRING_LENGTH = 4_096;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_COLLECTION = 100_000;
const MIXER_COLORS: readonly MixerColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
];

interface CodecState {
  readonly quarantine: QuarantinedV3Field[];
  quarantineBytes: number;
}

export class V3DocumentCodecError extends Error {}

export type PersistedDocumentDecodeResult =
  | { readonly kind: "editable"; readonly document: PersistedDevelopDocument }
  | {
      readonly kind: "read-only-newer";
      readonly foundVersion: number;
      readonly raw: NewerDevelopDocument;
      readonly diagnostic: Extract<DevelopDiagnostic, { readonly kind: "newer-process-read-only" }>;
    }
  | { readonly kind: "invalid"; readonly message: string };

function invalid(message: string): never {
  throw new V3DocumentCodecError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > MAX_JSON_DEPTH) invalid(`${path} exceeds the JSON depth limit.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > MAX_V3_PAYLOAD_BYTES) {
      invalid(`${path} exceeds the string limit.`);
    }
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalid(`${path} must be finite.`);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_COLLECTION) invalid(`${path} is too large.`);
    return value.map((child, index) => jsonValue(child, `${path}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_COLLECTION) invalid(`${path} has too many fields.`);
    const parsed: Record<string, JsonValue> = {};
    for (const [key, child] of entries) {
      if (key.length === 0 || key.length > 256) invalid(`${path} has an invalid field name.`);
      parsed[key] = jsonValue(child, `${path}.${key}`, depth + 1);
    }
    return parsed;
  }
  return invalid(`${path} is not JSON data.`);
}

function addQuarantine(
  state: CodecState,
  path: string,
  value: unknown,
): void {
  if (state.quarantine.length >= MAX_V3_QUARANTINE_FIELDS) {
    invalid(`v3 quarantine cannot exceed ${MAX_V3_QUARANTINE_FIELDS} fields.`);
  }
  const field = { path: text(path, "quarantine.path", 512), value: jsonValue(value, path) };
  const bytes = new TextEncoder().encode(JSON.stringify(field)).byteLength;
  if (state.quarantineBytes + bytes > MAX_V3_QUARANTINE_BYTES) {
    invalid(`v3 quarantine cannot exceed ${MAX_V3_QUARANTINE_BYTES} bytes.`);
  }
  state.quarantine.push(field);
  state.quarantineBytes += bytes;
}

function record(
  value: unknown,
  path: string,
  knownFields: readonly string[],
  state: CodecState,
): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${path} must be an object.`);
  for (const [key, child] of Object.entries(value)) {
    if (!knownFields.includes(key)) addQuarantine(state, `${path}.${key}`, child);
  }
  return value;
}

function text(value: unknown, path: string, maximum = MAX_STRING_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    invalid(`${path} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function optionalText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function bool(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : invalid(`${path} must be boolean.`);
}

function numberIn(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${path} must be between ${minimum} and ${maximum}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function literal<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T {
  for (const candidate of values) {
    if (value === candidate) return candidate;
  }
  return invalid(`${path} is not supported.`);
}

function tuple3(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): Rgb {
  if (!Array.isArray(value) || value.length !== 3) invalid(`${path} must contain 3 numbers.`);
  return [
    numberIn(value[0], `${path}[0]`, minimum, maximum),
    numberIn(value[1], `${path}[1]`, minimum, maximum),
    numberIn(value[2], `${path}[2]`, minimum, maximum),
  ];
}

function matrix3(value: unknown, path: string): Matrix3 {
  if (!Array.isArray(value) || value.length !== 9) invalid(`${path} must contain 9 numbers.`);
  return [
    numberIn(value[0], `${path}[0]`, -16, 16),
    numberIn(value[1], `${path}[1]`, -16, 16),
    numberIn(value[2], `${path}[2]`, -16, 16),
    numberIn(value[3], `${path}[3]`, -16, 16),
    numberIn(value[4], `${path}[4]`, -16, 16),
    numberIn(value[5], `${path}[5]`, -16, 16),
    numberIn(value[6], `${path}[6]`, -16, 16),
    numberIn(value[7], `${path}[7]`, -16, 16),
    numberIn(value[8], `${path}[8]`, -16, 16),
  ];
}

function homography(value: unknown, path: string): Homography {
  return matrix3(value, path);
}

function curvePoints(value: unknown, path: string, state: CodecState): CurvePoint[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 256) {
    invalid(`${path} must contain between 2 and 256 points.`);
  }
  const points = value.map((rawPoint, index) => {
    const point = record(rawPoint, `${path}[${index}]`, ["x", "y"], state);
    return {
      x: numberIn(point.x, `${path}[${index}].x`, 0, 1),
      y: numberIn(point.y, `${path}[${index}].y`, 0, 1),
    };
  });
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].x <= points[index - 1].x) invalid(`${path} x values must increase.`);
  }
  return points;
}

function curves(value: unknown, path: string, state: CodecState): CurveSettings {
  const input = record(value, path, ["rgb", "red", "green", "blue"], state);
  return {
    rgb: curvePoints(input.rgb, `${path}.rgb`, state),
    red: curvePoints(input.red, `${path}.red`, state),
    green: curvePoints(input.green, `${path}.green`, state),
    blue: curvePoints(input.blue, `${path}.blue`, state),
  };
}

function mixerBand(value: unknown, path: string, state: CodecState): MixerBandSettings {
  const input = record(value, path, ["hue", "saturation", "luminance"], state);
  return {
    hue: numberIn(input.hue, `${path}.hue`, -100, 100),
    saturation: numberIn(input.saturation, `${path}.saturation`, -100, 100),
    luminance: numberIn(input.luminance, `${path}.luminance`, -100, 100),
  };
}

function mixer(value: unknown, path: string, state: CodecState): MixerSettings {
  const input = record(value, path, MIXER_COLORS, state);
  return {
    red: mixerBand(input.red, `${path}.red`, state),
    orange: mixerBand(input.orange, `${path}.orange`, state),
    yellow: mixerBand(input.yellow, `${path}.yellow`, state),
    green: mixerBand(input.green, `${path}.green`, state),
    aqua: mixerBand(input.aqua, `${path}.aqua`, state),
    blue: mixerBand(input.blue, `${path}.blue`, state),
    purple: mixerBand(input.purple, `${path}.purple`, state),
    magenta: mixerBand(input.magenta, `${path}.magenta`, state),
  };
}

function assetReferences(
  value: unknown,
  path: string,
  state: CodecState,
): readonly DevelopAssetRef[] {
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectAssetUnknowns(item, `${path}[${index}]`, state));
    }
    return parseDevelopAssetRefs(value);
  } catch (error) {
    return invalid(
      `${path} is invalid: ${error instanceof Error ? error.message : "invalid asset references"}`,
    );
  }
}

function collectAssetUnknowns(value: unknown, path: string, state: CodecState): void {
  if (!isRecord(value)) return;
  record(value, path, [
    "assetId",
    "kind",
    "sha256",
    "producerRevision",
    "coordinateFrameRevision",
    "colorStageId",
  ], state);
}

function collectEllipseUnknowns(value: unknown, path: string, state: CodecState): void {
  if (!isRecord(value)) return;
  const ellipse = record(value, path, ["center", "radiusX", "radiusY", "rotationDegrees"], state);
  if (isRecord(ellipse.center)) record(ellipse.center, `${path}.center`, ["x", "y"], state);
}

function collectCleanupUnknowns(value: unknown, path: string, state: CodecState): void {
  if (!isRecord(value)) return;
  const layer = record(value, path, ["components"], state);
  if (!Array.isArray(layer.components)) return;
  layer.components.forEach((item, index) => {
    if (!isRecord(item)) return;
    const itemPath = `${path}.components[${index}]`;
    if (item.kind === "repair") {
      const component = record(item, itemPath, [
        "kind", "id", "enabled", "target", "feather", "opacity", "mode", "source",
      ], state);
      collectEllipseUnknowns(component.target, `${itemPath}.target`, state);
      if (isRecord(component.source)) {
        const source = record(component.source, `${itemPath}.source`, ["kind", "region", "asset"], state);
        collectEllipseUnknowns(source.region, `${itemPath}.source.region`, state);
        if (source.asset !== undefined) {
          collectAssetUnknowns(source.asset, `${itemPath}.source.asset`, state);
        }
      }
    } else if (item.kind === "red-eye") {
      const component = record(item, itemPath, [
        "kind", "id", "enabled", "origin", "bounds", "pupilRadius", "amount",
        "catchlightProtection",
      ], state);
      collectEllipseUnknowns(component.bounds, `${itemPath}.bounds`, state);
    }
  });
}

function collectLensBlurUnknowns(value: unknown, path: string, state: CodecState): void {
  if (!isRecord(value)) return;
  const settings = record(value, path, ["kind", "values", "depthAsset"], state);
  if (isRecord(settings.values)) {
    record(settings.values, `${path}.values`, [
      "focusDepth", "focusRange", "radius", "bokeh", "foreground", "background",
    ], state);
  }
  if (settings.depthAsset !== undefined) {
    collectAssetUnknowns(settings.depthAsset, `${path}.depthAsset`, state);
  }
}

function whiteBalance(
  value: unknown,
  path: string,
  state: CodecState,
): PersistedWhiteBalance {
  const input = record(value, path, ["mode", "adjustment", "resolved"], state);
  const adjustment = record(input.adjustment, `${path}.adjustment`, ["temperature", "tint"], state);
  const resolved = record(input.resolved, `${path}.resolved`, ["temperatureKelvin", "tint", "gains"], state);
  return {
    mode: literal(input.mode, `${path}.mode`, [
      "current",
      "camera",
      "custom",
      "sampled",
      "auto",
      "legacy-custom",
    ]),
    adjustment: {
      temperature: numberIn(adjustment.temperature, `${path}.adjustment.temperature`, -3_000, 3_000),
      tint: numberIn(adjustment.tint, `${path}.adjustment.tint`, -150, 150),
    },
    resolved: {
      temperatureKelvin: numberIn(resolved.temperatureKelvin, `${path}.resolved.temperatureKelvin`, 2_000, 50_000),
      tint: numberIn(resolved.tint, `${path}.resolved.tint`, -150, 150),
      gains: tuple3(resolved.gains, `${path}.resolved.gains`, 0.25, 4),
    },
  };
}

function profileSelection(value: unknown, path: string, state: CodecState): InputProfileSelection {
  const input = record(value, path, ["kind", "profileId", "profileRevision", "reason"], state);
  switch (input.kind) {
    case "decoder-default": return { kind: "decoder-default" };
    case "selected":
      return {
        kind: "selected",
        profileId: text(input.profileId, `${path}.profileId`, 256),
        profileRevision: text(input.profileRevision, `${path}.profileRevision`, 256),
      };
    case "unavailable":
      return { kind: "unavailable", reason: text(input.reason, `${path}.reason`) };
    default: return invalid(`${path}.kind is not supported.`);
  }
}

function inputProfile(value: unknown, path: string, state: CodecState): PersistedInputProfile {
  const input = record(value, path, ["registryRevision", "selection", "calibration"], state);
  const calibration = record(
    input.calibration,
    `${path}.calibration`,
    ["matrixToLinearSrgb", "channelScale", "exposureOffsetEv"],
    state,
  );
  return {
    registryRevision: text(input.registryRevision, `${path}.registryRevision`, 256),
    selection: profileSelection(input.selection, `${path}.selection`, state),
    calibration: {
      matrixToLinearSrgb: matrix3(calibration.matrixToLinearSrgb, `${path}.calibration.matrixToLinearSrgb`),
      channelScale: tuple3(calibration.channelScale, `${path}.calibration.channelScale`, 0.0625, 16),
      exposureOffsetEv: numberIn(calibration.exposureOffsetEv, `${path}.calibration.exposureOffsetEv`, -8, 8),
    },
  };
}

function pointColorAdjustment(
  value: unknown,
  path: string,
  state: CodecState,
): PointColorAdjustment {
  const fields = [
    "id", "enabled", "sourceHueDegrees", "sourceSaturation", "sourceLuminance",
    "hueRangeDegrees", "saturationRange", "luminanceRange", "falloff",
    "hueShiftDegrees", "saturationShift", "luminanceShift",
  ];
  const input = record(value, path, fields, state);
  return {
    id: text(input.id, `${path}.id`, 256),
    enabled: bool(input.enabled, `${path}.enabled`),
    sourceHueDegrees: numberIn(input.sourceHueDegrees, `${path}.sourceHueDegrees`, 0, 360),
    sourceSaturation: numberIn(input.sourceSaturation, `${path}.sourceSaturation`, 0, 1),
    sourceLuminance: numberIn(input.sourceLuminance, `${path}.sourceLuminance`, 0, 1),
    hueRangeDegrees: numberIn(input.hueRangeDegrees, `${path}.hueRangeDegrees`, 1, 180),
    saturationRange: numberIn(input.saturationRange, `${path}.saturationRange`, 0.01, 1),
    luminanceRange: numberIn(input.luminanceRange, `${path}.luminanceRange`, 0.01, 1),
    falloff: numberIn(input.falloff, `${path}.falloff`, 0, 1),
    hueShiftDegrees: numberIn(input.hueShiftDegrees, `${path}.hueShiftDegrees`, -180, 180),
    saturationShift: numberIn(input.saturationShift, `${path}.saturationShift`, -1, 1),
    luminanceShift: numberIn(input.luminanceShift, `${path}.luminanceShift`, -1, 1),
  };
}

function lensSelection(value: unknown, path: string, state: CodecState): LensProfileSelection {
  const input = record(value, path, ["kind", "profileId"], state);
  switch (input.kind) {
    case "automatic": return { kind: "automatic" };
    case "off": return { kind: "off" };
    case "selected":
      return { kind: "selected", profileId: text(input.profileId, `${path}.profileId`, 256) };
    default: return invalid(`${path}.kind is not supported.`);
  }
}

function optics(value: unknown, path: string, state: CodecState): PersistedOptics {
  const input = record(value, path, ["registryRevision", "profile", "amounts", "manualDistortion", "defringe"], state);
  const amounts = record(input.amounts, `${path}.amounts`, [
    "distortion", "illumination", "lateralChromaticAberration",
  ], state);
  const defringe = record(input.defringe, `${path}.defringe`, [
    "amount", "purpleHueDegrees", "greenHueDegrees", "hueRangeDegrees",
  ], state);
  return {
    registryRevision: text(input.registryRevision, `${path}.registryRevision`, 256),
    profile: lensSelection(input.profile, `${path}.profile`, state),
    amounts: {
      distortion: numberIn(amounts.distortion, `${path}.amounts.distortion`, -1, 1),
      illumination: numberIn(amounts.illumination, `${path}.amounts.illumination`, 0, 1),
      lateralChromaticAberration: numberIn(
        amounts.lateralChromaticAberration,
        `${path}.amounts.lateralChromaticAberration`,
        0,
        1,
      ),
    },
    manualDistortion: numberIn(input.manualDistortion, `${path}.manualDistortion`, -100, 100),
    defringe: {
      amount: numberIn(defringe.amount, `${path}.defringe.amount`, 0, 100),
      purpleHueDegrees: numberIn(defringe.purpleHueDegrees, `${path}.defringe.purpleHueDegrees`, 0, 360),
      greenHueDegrees: numberIn(defringe.greenHueDegrees, `${path}.defringe.greenHueDegrees`, 0, 360),
      hueRangeDegrees: numberIn(defringe.hueRangeDegrees, `${path}.defringe.hueRangeDegrees`, 1, 60),
    },
  };
}

function quarterTurns(value: unknown, path: string): QuarterTurns {
  switch (value) {
    case 0: return 0;
    case 1: return 1;
    case 2: return 2;
    case 3: return 3;
    default: return invalid(`${path} must be 0, 1, 2, or 3.`);
  }
}

function geometry(value: unknown, path: string, state: CodecState): PersistedGeometry {
  const input = record(value, path, [
    "coordinateFrameRevision", "orientation", "manualPerspective", "upright",
    "constrainCrop", "crop",
  ], state);
  if (input.coordinateFrameRevision !== COORDINATE_FRAME_REVISION) {
    invalid(`${path}.coordinateFrameRevision is not supported.`);
  }
  const orientation = record(input.orientation, `${path}.orientation`, [
    "quarterTurns", "flipHorizontal", "flipVertical", "fineAngleDegrees",
  ], state);
  const manual = record(input.manualPerspective, `${path}.manualPerspective`, [
    "horizontal", "vertical", "matrix",
  ], state);
  const upright = record(input.upright, `${path}.upright`, [
    "mode", "enabled", "matrix", "revision",
  ], state);
  const crop = record(input.crop, `${path}.crop`, [
    "enabled", "x", "y", "width", "height", "aspectPreset",
    "customAspectWidth", "customAspectHeight",
  ], state);
  const aspectPreset = ASPECT_RATIO_PRESETS.find((preset) => preset.id === crop.aspectPreset);
  if (!aspectPreset) invalid(`${path}.crop.aspectPreset is not supported.`);
  const width = numberIn(crop.width, `${path}.crop.width`, 0.05, 1);
  const height = numberIn(crop.height, `${path}.crop.height`, 0.05, 1);
  const x = numberIn(crop.x, `${path}.crop.x`, 0, 1);
  const y = numberIn(crop.y, `${path}.crop.y`, 0, 1);
  if (x + width > 1 || y + height > 1) invalid(`${path}.crop extends outside the source.`);
  return {
    coordinateFrameRevision: COORDINATE_FRAME_REVISION,
    orientation: {
      quarterTurns: quarterTurns(orientation.quarterTurns, `${path}.orientation.quarterTurns`),
      flipHorizontal: bool(orientation.flipHorizontal, `${path}.orientation.flipHorizontal`),
      flipVertical: bool(orientation.flipVertical, `${path}.orientation.flipVertical`),
      fineAngleDegrees: numberIn(orientation.fineAngleDegrees, `${path}.orientation.fineAngleDegrees`, -180, 180),
    },
    manualPerspective: {
      horizontal: numberIn(manual.horizontal, `${path}.manualPerspective.horizontal`, -100, 100),
      vertical: numberIn(manual.vertical, `${path}.manualPerspective.vertical`, -100, 100),
      matrix: homography(manual.matrix, `${path}.manualPerspective.matrix`),
    },
    upright: {
      mode: literal(upright.mode, `${path}.upright.mode`, ["manual", "guided", "automatic"]),
      enabled: bool(upright.enabled, `${path}.upright.enabled`),
      matrix: homography(upright.matrix, `${path}.upright.matrix`),
      revision: text(upright.revision, `${path}.upright.revision`, 256),
    },
    constrainCrop: bool(input.constrainCrop, `${path}.constrainCrop`),
    crop: {
      enabled: bool(crop.enabled, `${path}.crop.enabled`),
      x,
      y,
      width,
      height,
      aspectPreset: aspectPreset.id,
      customAspectWidth: numberIn(crop.customAspectWidth, `${path}.crop.customAspectWidth`, 0.01, 10_000),
      customAspectHeight: numberIn(crop.customAspectHeight, `${path}.crop.customAspectHeight`, 0.01, 10_000),
    },
  };
}

function compatibility(value: unknown, path: string, state: CodecState): V3Compatibility {
  const input = record(value, path, [
    "mappingRevision", "legacyV2", "externalFieldIndex", "quarantine",
  ], state);
  const legacyV2 = input.legacyV2 === null
    ? null
    : parseDevelopDocument(input.legacyV2);
  if (!Array.isArray(input.externalFieldIndex) || input.externalFieldIndex.length > MAX_V3_EXTERNAL_FIELDS) {
    invalid(`${path}.externalFieldIndex is too large.`);
  }
  const externalFieldIndex = input.externalFieldIndex.map((item, index) =>
    text(item, `${path}.externalFieldIndex[${index}]`, 512),
  );
  if (!Array.isArray(input.quarantine) || input.quarantine.length > MAX_V3_QUARANTINE_FIELDS) {
    invalid(`${path}.quarantine is too large.`);
  }
  for (let index = 0; index < input.quarantine.length; index += 1) {
    const item = input.quarantine[index];
    if (!isRecord(item)) invalid(`${path}.quarantine[${index}] must be an object.`);
    addQuarantine(
      state,
      text(item.path, `${path}.quarantine[${index}].path`, 512),
      item.value,
    );
  }
  return {
    mappingRevision: optionalText(input.mappingRevision, `${path}.mappingRevision`),
    legacyV2,
    externalFieldIndex,
    quarantine: state.quarantine,
  };
}

function postCrop(value: unknown, path: string, state: CodecState): PostCropEffects {
  const input = record(value, path, [
    "vignette", "vignetteMidpoint", "vignetteRoundness", "vignetteFeather",
    "vignetteHighlights", "grain", "grainSize", "grainRoughness",
  ], state);
  return {
    vignette: numberIn(input.vignette, `${path}.vignette`, -100, 100),
    vignetteMidpoint: numberIn(input.vignetteMidpoint, `${path}.vignetteMidpoint`, 0, 100),
    vignetteRoundness: numberIn(input.vignetteRoundness, `${path}.vignetteRoundness`, -100, 100),
    vignetteFeather: numberIn(input.vignetteFeather, `${path}.vignetteFeather`, 0, 100),
    vignetteHighlights: numberIn(input.vignetteHighlights, `${path}.vignetteHighlights`, 0, 100),
    grain: numberIn(input.grain, `${path}.grain`, 0, 100),
    grainSize: numberIn(input.grainSize, `${path}.grainSize`, 0, 100),
    grainRoughness: numberIn(input.grainRoughness, `${path}.grainRoughness`, 0, 100),
  };
}

function hdr(value: unknown, path: string, state: CodecState): HdrEdits {
  const input = record(value, path, [
    "enabled", "exposure", "highlights", "whites", "headroomStops",
    "sdrBrightness", "sdrContrast",
  ], state);
  return {
    enabled: bool(input.enabled, `${path}.enabled`),
    exposure: numberIn(input.exposure, `${path}.exposure`, -10, 10),
    highlights: numberIn(input.highlights, `${path}.highlights`, -100, 100),
    whites: numberIn(input.whites, `${path}.whites`, -100, 100),
    headroomStops: numberIn(input.headroomStops, `${path}.headroomStops`, 0, 16),
    sdrBrightness: numberIn(input.sdrBrightness, `${path}.sdrBrightness`, -100, 100),
    sdrContrast: numberIn(input.sdrContrast, `${path}.sdrContrast`, -100, 100),
  };
}

function payloadBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) invalid("Develop document is not JSON data.");
    return new TextEncoder().encode(serialized).byteLength;
  } catch (error) {
    if (error instanceof V3DocumentCodecError) throw error;
    return invalid("Develop document is not serializable JSON data.");
  }
}

export function parseV3DevelopDocument(value: unknown): DevelopDocumentV3 {
  if (payloadBytes(value) > MAX_V3_PAYLOAD_BYTES) {
    invalid(`v3 develop documents cannot exceed ${MAX_V3_PAYLOAD_BYTES} bytes.`);
  }
  const state: CodecState = { quarantine: [], quarantineBytes: 0 };
  const input = record(value, "develop document", [
    "version", "process", "schemaRevision", "tone", "color", "optics", "geometry",
    "local", "cleanup", "presence", "detail", "effects", "lensBlur", "hdr",
    "compatibility",
  ], state);
  if (input.version !== DEVELOP_PROCESS_VERSION) invalid("Develop document version must be 3.");
  if (input.process !== DEVELOP_PROCESS_ID) invalid("Develop document process is not darkroom-v3.");
  if (
    input.schemaRevision !== V3_DOCUMENT_SCHEMA_REVISION &&
    input.schemaRevision !== LEGACY_V3_DOCUMENT_SCHEMA_REVISION
  ) {
    invalid("Develop document schema revision is not supported.");
  }
  const isLegacySchema = input.schemaRevision === LEGACY_V3_DOCUMENT_SCHEMA_REVISION;
  const parsedCompatibility = compatibility(input.compatibility, "compatibility", state);
  const tone = record(input.tone, "tone", ["basic", "curves"], state);
  const basic = record(tone.basic, "tone.basic", [
    "exposure", "contrast", "highlights", "shadows", "whites", "blacks",
  ], state);
  const color = record(input.color, "color", [
    "whiteBalance", "global", "inputProfile", "pointColor", "mixer",
    "monochrome", "grading",
  ], state);
  const global = record(color.global, "color.global", ["vibrance", "saturation"], state);
  const pointColor = record(color.pointColor, "color.pointColor", ["adjustments"], state);
  if (!Array.isArray(pointColor.adjustments) || pointColor.adjustments.length > MAX_POINT_COLOR_SAMPLES) {
    invalid(`color.pointColor.adjustments cannot exceed ${MAX_POINT_COLOR_SAMPLES} items.`);
  }
  const pointIds = new Set<string>();
  const pointAdjustments = pointColor.adjustments.map((item, index) => {
    const parsed = pointColorAdjustment(item, `color.pointColor.adjustments[${index}]`, state);
    if (pointIds.has(parsed.id)) invalid(`Duplicate Point Color ID ${parsed.id}.`);
    pointIds.add(parsed.id);
    return parsed;
  });
  const monochrome = record(color.monochrome, "color.monochrome", ["enabled", "profileId", "mixer"], state);
  const monochromeMixer = record(monochrome.mixer, "color.monochrome.mixer", MIXER_COLORS, state);
  const grading = record(color.grading, "color.grading", [
    "shadows", "midtones", "highlights", "balance", "blending",
  ], state);
  const gradingWheel = (wheelValue: unknown, wheelPath: string) => {
    const wheel = record(wheelValue, wheelPath, ["hueDegrees", "saturation", "luminance"], state);
    return {
      hueDegrees: numberIn(wheel.hueDegrees, `${wheelPath}.hueDegrees`, 0, 360),
      saturation: numberIn(wheel.saturation, `${wheelPath}.saturation`, 0, 100),
      luminance: numberIn(wheel.luminance, `${wheelPath}.luminance`, -100, 100),
    };
  };
  const local = record(input.local, "local", ["geometryFrame", "masks", "maskAssetRefs"], state);
  if (!Array.isArray(local.masks)) invalid("local.masks must be an array.");
  const maskAssetRefs = assetReferences(local.maskAssetRefs, "local.maskAssetRefs", state);
  if (maskAssetRefs.some((asset) => asset.kind !== "mask-matte" && asset.kind !== "depth-map")) {
    invalid("local.maskAssetRefs can contain only mask mattes and depth maps.");
  }
  const localMasks = isLegacySchema
    ? parseDevelopLocalMasks(local.masks).map((mask) => migrateLegacyMask(mask, maskAssetRefs))
    : (() => {
        try {
          return parseLocalMasksV3(local.masks);
        } catch (error) {
          return invalid(error instanceof Error ? error.message : "local.masks is invalid.");
        }
      })();
  const referencedMaskAssets = new Set(
    localMasks.flatMap((mask) =>
      referencedMaskArtifacts(mask.expression).map((asset) => asset.assetId)
    ),
  );
  if (
    referencedMaskAssets.size !== maskAssetRefs.length ||
    maskAssetRefs.some((asset) => !referencedMaskAssets.has(asset.assetId))
  ) {
    invalid("local.maskAssetRefs must cover every referenced mask matte.");
  }
  const presence = record(input.presence, "presence", ["texture", "clarity", "dehaze"], state);
  const detail = record(input.detail, "detail", ["noiseReduction", "sharpening"], state);
  const denoise = record(detail.noiseReduction, "detail.noiseReduction", [
    "noiseReduction", "noiseDetail", "noiseContrast", "colorNoiseReduction",
    "colorNoiseDetail", "colorNoiseSmoothness",
  ], state);
  const sharpening = record(detail.sharpening, "detail.sharpening", [
    "sharpening", "sharpenRadius", "sharpenDetail", "sharpenMasking",
  ], state);
  const effects = record(input.effects, "effects", ["postCrop"], state);
  const parsedDocument: DevelopDocumentV3 = {
    version: DEVELOP_PROCESS_VERSION,
    process: DEVELOP_PROCESS_ID,
    schemaRevision: V3_DOCUMENT_SCHEMA_REVISION,
    tone: {
      basic: {
        exposure: numberIn(basic.exposure, "tone.basic.exposure", -5, 5),
        contrast: numberIn(basic.contrast, "tone.basic.contrast", -100, 100),
        highlights: numberIn(basic.highlights, "tone.basic.highlights", -100, 100),
        shadows: numberIn(basic.shadows, "tone.basic.shadows", -100, 100),
        whites: numberIn(basic.whites, "tone.basic.whites", -100, 100),
        blacks: numberIn(basic.blacks, "tone.basic.blacks", -100, 100),
      },
      curves: curves(tone.curves, "tone.curves", state),
    },
    color: {
      whiteBalance: whiteBalance(color.whiteBalance, "color.whiteBalance", state),
      global: {
        vibrance: numberIn(global.vibrance, "color.global.vibrance", -100, 100),
        saturation: numberIn(global.saturation, "color.global.saturation", -100, 100),
      },
      inputProfile: inputProfile(color.inputProfile, "color.inputProfile", state),
      pointColor: { adjustments: pointAdjustments },
      mixer: mixer(color.mixer, "color.mixer", state),
      monochrome: {
        enabled: bool(monochrome.enabled, "color.monochrome.enabled"),
        profileId: text(monochrome.profileId, "color.monochrome.profileId", 256),
        mixer: {
          red: numberIn(monochromeMixer.red, "color.monochrome.mixer.red", -100, 100),
          orange: numberIn(monochromeMixer.orange, "color.monochrome.mixer.orange", -100, 100),
          yellow: numberIn(monochromeMixer.yellow, "color.monochrome.mixer.yellow", -100, 100),
          green: numberIn(monochromeMixer.green, "color.monochrome.mixer.green", -100, 100),
          aqua: numberIn(monochromeMixer.aqua, "color.monochrome.mixer.aqua", -100, 100),
          blue: numberIn(monochromeMixer.blue, "color.monochrome.mixer.blue", -100, 100),
          purple: numberIn(monochromeMixer.purple, "color.monochrome.mixer.purple", -100, 100),
          magenta: numberIn(monochromeMixer.magenta, "color.monochrome.mixer.magenta", -100, 100),
        },
      },
      grading: {
        shadows: gradingWheel(grading.shadows, "color.grading.shadows"),
        midtones: gradingWheel(grading.midtones, "color.grading.midtones"),
        highlights: gradingWheel(grading.highlights, "color.grading.highlights"),
        balance: numberIn(grading.balance, "color.grading.balance", -100, 100),
        blending: numberIn(grading.blending, "color.grading.blending", 0, 100),
      },
    },
    optics: optics(input.optics, "optics", state),
    geometry: geometry(input.geometry, "geometry", state),
    local: {
      geometryFrame: literal(local.geometryFrame, "local.geometryFrame", [
        "canonical-v3",
        "legacy-oriented-v2",
      ]),
      masks: localMasks,
      maskAssetRefs,
    },
    cleanup: (() => {
      try {
        collectCleanupUnknowns(input.cleanup, "cleanup", state);
        return parseCleanupLayer(input.cleanup);
      } catch (error) {
        return invalid(
          `cleanup is invalid: ${error instanceof Error ? error.message : "invalid cleanup layer"}`,
        );
      }
    })(),
    presence: {
      texture: numberIn(presence.texture, "presence.texture", -100, 100),
      clarity: numberIn(presence.clarity, "presence.clarity", -100, 100),
      dehaze: numberIn(presence.dehaze, "presence.dehaze", -100, 100),
    },
    detail: {
      noiseReduction: {
        noiseReduction: numberIn(denoise.noiseReduction, "detail.noiseReduction.noiseReduction", 0, 100),
        noiseDetail: numberIn(denoise.noiseDetail, "detail.noiseReduction.noiseDetail", 0, 100),
        noiseContrast: numberIn(denoise.noiseContrast, "detail.noiseReduction.noiseContrast", 0, 100),
        colorNoiseReduction: numberIn(denoise.colorNoiseReduction, "detail.noiseReduction.colorNoiseReduction", 0, 100),
        colorNoiseDetail: numberIn(denoise.colorNoiseDetail, "detail.noiseReduction.colorNoiseDetail", 0, 100),
        colorNoiseSmoothness: numberIn(denoise.colorNoiseSmoothness, "detail.noiseReduction.colorNoiseSmoothness", 0, 100),
      },
      sharpening: {
        sharpening: numberIn(sharpening.sharpening, "detail.sharpening.sharpening", 0, 100),
        sharpenRadius: numberIn(sharpening.sharpenRadius, "detail.sharpening.sharpenRadius", 0.5, 3),
        sharpenDetail: numberIn(sharpening.sharpenDetail, "detail.sharpening.sharpenDetail", 0, 100),
        sharpenMasking: numberIn(sharpening.sharpenMasking, "detail.sharpening.sharpenMasking", 0, 100),
      },
    },
    effects: { postCrop: postCrop(effects.postCrop, "effects.postCrop", state) },
    lensBlur: (() => {
      try {
        collectLensBlurUnknowns(input.lensBlur, "lensBlur", state);
        return parseLensBlurSettings(input.lensBlur);
      } catch (error) {
        return invalid(
          `lensBlur is invalid: ${error instanceof Error ? error.message : "invalid Lens Blur settings"}`,
        );
      }
    })(),
    hdr: hdr(input.hdr, "hdr", state),
    compatibility: { ...parsedCompatibility, quarantine: state.quarantine },
  };
  return parsedDocument;
}

export function decodePersistedDevelopDocument(
  value: unknown,
): PersistedDocumentDecodeResult {
  try {
    if (payloadBytes(value) > MAX_V3_PAYLOAD_BYTES) {
      return { kind: "invalid", message: "Develop document exceeds the payload limit." };
    }
    if (!isRecord(value)) return { kind: "invalid", message: "Develop document must be an object." };
    if (typeof value.version !== "number" || !Number.isSafeInteger(value.version)) {
      return { kind: "invalid", message: "Develop document version must be an integer." };
    }
    if (value.version === 2) {
      return { kind: "editable", document: parseDevelopDocument(value) };
    }
    if (value.version === DEVELOP_PROCESS_VERSION) {
      return { kind: "editable", document: parseV3DevelopDocument(value) };
    }
    if (value.version > DEVELOP_PROCESS_VERSION) {
      const parsedRaw = jsonValue(value, "develop document");
      if (!isRecord(parsedRaw)) {
        return { kind: "invalid", message: "Develop document must be an object." };
      }
      const raw = { ...parsedRaw, version: value.version } satisfies NewerDevelopDocument;
      return {
        kind: "read-only-newer",
        foundVersion: value.version,
        raw,
        diagnostic: {
          kind: "newer-process-read-only",
          category: "compatibility",
          foundVersion: value.version,
          latestWritableVersion: DEVELOP_PROCESS_VERSION,
        },
      };
    }
    return { kind: "invalid", message: `Develop document version ${value.version} is not supported.` };
  } catch (error) {
    return {
      kind: "invalid",
      message: error instanceof Error ? error.message : "Develop document is invalid.",
    };
  }
}

export function encodeV3DevelopDocument(document: DevelopDocumentV3): string {
  return JSON.stringify(parseV3DevelopDocument(document));
}
