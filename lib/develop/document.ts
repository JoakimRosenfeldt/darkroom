import { ASPECT_RATIO_PRESETS } from "@/lib/develop/crop-geometry";
import {
  createDevelopSettings,
} from "@/lib/develop/registry";
import { normalizeCurveSettings } from "@/lib/develop/plugins/curve";
import type {
  AiMaskComponent,
  BasicSettings,
  BrushMaskComponent,
  BrushStroke,
  CurvePoint,
  DevelopDocument,
  DevelopSettings,
  LinearGradientMaskComponent,
  LocalMask,
  MaskComponent,
  MaskRasterAsset,
  MixerBandSettings,
  NormalizedPoint,
  RadialGradientMaskComponent,
  SourceSignature,
} from "@/lib/develop/types";

export const MAX_MASKS = 16;
export const MAX_COMPONENTS_PER_MASK = 64;
export const MAX_BRUSH_STROKES = 4_096;
export const MAX_BRUSH_POINTS = 65_536;
export const MAX_POINTS_PER_STROKE = 8_192;
export const MAX_MATTE_EDGE = 2_048;
export const MAX_DEVELOP_PAYLOAD_BYTES = 16 * 1024 * 1024;

export class DevelopDocumentError extends Error {}

function invalid(message: string): never {
  throw new DevelopDocumentError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : invalid(`${path} must be an object.`);
}

function stringValue(value: unknown, path: string): string {
  return typeof value === "string" ? value : invalid(`${path} must be a string.`);
}

function nonEmptyString(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  return parsed.length > 0 ? parsed : invalid(`${path} must not be empty.`);
}

function booleanValue(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : invalid(`${path} must be a boolean.`);
}

function finiteNumber(value: unknown, path: string): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : invalid(`${path} must be a finite number.`);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  const parsed = finiteNumber(value, path);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : invalid(`${path} is outside the supported range.`);
}

function unit(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  return parsed >= 0 && parsed <= 1
    ? parsed
    : invalid(`${path} must be between 0 and 1.`);
}

function normalizedPoint(value: unknown, path: string): NormalizedPoint {
  const point = record(value, path);
  return { x: unit(point.x, `${path}.x`), y: unit(point.y, `${path}.y`) };
}

function basicSettings(value: unknown, path: string): BasicSettings {
  const input = record(value, path);
  return {
    exposure: finiteNumber(input.exposure, `${path}.exposure`),
    contrast: finiteNumber(input.contrast, `${path}.contrast`),
    highlights: finiteNumber(input.highlights, `${path}.highlights`),
    shadows: finiteNumber(input.shadows, `${path}.shadows`),
    whites: finiteNumber(input.whites, `${path}.whites`),
    blacks: finiteNumber(input.blacks, `${path}.blacks`),
    temperature: finiteNumber(input.temperature, `${path}.temperature`),
    tint: finiteNumber(input.tint, `${path}.tint`),
    vibrance: finiteNumber(input.vibrance, `${path}.vibrance`),
    saturation: finiteNumber(input.saturation, `${path}.saturation`),
  };
}

function curvePoint(value: unknown, path: string): CurvePoint {
  return normalizedPoint(value, path);
}

function curvePoints(value: unknown, path: string): CurvePoint[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 256) {
    return invalid(`${path} must contain between 2 and 256 points.`);
  }
  const points = value.map((point, index) => curvePoint(point, `${path}[${index}]`));
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].x <= points[index - 1].x) {
      invalid(`${path} points must have increasing x coordinates.`);
    }
  }
  return points;
}

function mixerBand(value: unknown, path: string): MixerBandSettings {
  const input = record(value, path);
  return {
    hue: finiteNumber(input.hue, `${path}.hue`),
    saturation: finiteNumber(input.saturation, `${path}.saturation`),
    luminance: finiteNumber(input.luminance, `${path}.luminance`),
  };
}

function parseGlobalSettings(value: unknown): Omit<DevelopSettings, "masking"> {
  const input = record(value, "settings");
  const crop = record(input.crop, "settings.crop");
  const curve = record(input.curve, "settings.curve");
  const mixer = record(input.mixer, "settings.mixer");
  const effects = record(input.effects, "settings.effects");
  const aspectPreset = stringValue(crop.aspectPreset, "settings.crop.aspectPreset");
  const knownAspect = ASPECT_RATIO_PRESETS.find((preset) => preset.id === aspectPreset);
  if (!knownAspect) {
    invalid("settings.crop.aspectPreset is not supported.");
  }
  return {
    basic: basicSettings(input.basic, "settings.basic"),
    crop: {
      enabled: booleanValue(crop.enabled, "settings.crop.enabled"),
      x: unit(crop.x, "settings.crop.x"),
      y: unit(crop.y, "settings.crop.y"),
      width: unit(crop.width, "settings.crop.width"),
      height: unit(crop.height, "settings.crop.height"),
      angle: finiteNumber(crop.angle, "settings.crop.angle"),
      perspectiveX: finiteNumber(crop.perspectiveX, "settings.crop.perspectiveX"),
      perspectiveY: finiteNumber(crop.perspectiveY, "settings.crop.perspectiveY"),
      distortion: finiteNumber(crop.distortion, "settings.crop.distortion"),
      aspectPreset: knownAspect.id,
      customAspectWidth: finiteNumber(crop.customAspectWidth, "settings.crop.customAspectWidth"),
      customAspectHeight: finiteNumber(crop.customAspectHeight, "settings.crop.customAspectHeight"),
    },
    curve: {
      rgb: curvePoints(curve.rgb, "settings.curve.rgb"),
      red: curvePoints(curve.red, "settings.curve.red"),
      green: curvePoints(curve.green, "settings.curve.green"),
      blue: curvePoints(curve.blue, "settings.curve.blue"),
    },
    mixer: {
      red: mixerBand(mixer.red, "settings.mixer.red"),
      orange: mixerBand(mixer.orange, "settings.mixer.orange"),
      yellow: mixerBand(mixer.yellow, "settings.mixer.yellow"),
      green: mixerBand(mixer.green, "settings.mixer.green"),
      aqua: mixerBand(mixer.aqua, "settings.mixer.aqua"),
      blue: mixerBand(mixer.blue, "settings.mixer.blue"),
      purple: mixerBand(mixer.purple, "settings.mixer.purple"),
      magenta: mixerBand(mixer.magenta, "settings.mixer.magenta"),
    },
    effects: {
      vignette: finiteNumber(effects.vignette, "settings.effects.vignette"),
      grain: finiteNumber(effects.grain, "settings.effects.grain"),
      sharpening: finiteNumber(effects.sharpening, "settings.effects.sharpening"),
      noiseReduction: finiteNumber(effects.noiseReduction, "settings.effects.noiseReduction"),
    },
  };
}

function operation(value: unknown, path: string): "add" | "subtract" {
  return value === "add" || value === "subtract"
    ? value
    : invalid(`${path} must be add or subtract.`);
}

type BrushStrokeSettings = Pick<BrushMaskComponent, "size" | "feather" | "flow" | "density">;

function brushStroke(value: unknown, path: string, defaults: BrushStrokeSettings): BrushStroke {
  const input = record(value, path);
  if (!Array.isArray(input.points) || input.points.length === 0 || input.points.length > MAX_POINTS_PER_STROKE) {
    return invalid(`${path}.points has an unsupported length.`);
  }
  const first = normalizedPoint(input.points[0], `${path}.points[0]`);
  return {
    points: [
      first,
      ...input.points.slice(1).map((point, index) =>
        normalizedPoint(point, `${path}.points[${index + 1}]`),
      ),
    ],
    size: input.size === undefined ? defaults.size : unit(input.size, `${path}.size`),
    feather: input.feather === undefined ? defaults.feather : unit(input.feather, `${path}.feather`),
    flow: input.flow === undefined ? defaults.flow : unit(input.flow, `${path}.flow`),
    density: input.density === undefined ? defaults.density : unit(input.density, `${path}.density`),
  };
}

function component(value: unknown, path: string): MaskComponent {
  const input = record(value, path);
  const id = nonEmptyString(input.id, `${path}.id`);
  const componentOperation = operation(input.operation, `${path}.operation`);
  switch (input.kind) {
    case "brush": {
      if (!Array.isArray(input.strokes) || input.strokes.length === 0) {
        return invalid(`${path}.strokes must not be empty.`);
      }
      if (input.strokes.length > MAX_BRUSH_STROKES) {
        return invalid(`${path}.strokes has an unsupported length.`);
      }
      const settings = {
        size: unit(input.size, `${path}.size`),
        feather: unit(input.feather, `${path}.feather`),
        flow: unit(input.flow, `${path}.flow`),
        density: unit(input.density, `${path}.density`),
      };
      const first = brushStroke(input.strokes[0], `${path}.strokes[0]`, settings);
      return {
        kind: "brush",
        id,
        operation: componentOperation,
        strokes: [
          first,
          ...input.strokes.slice(1).map((stroke, index) =>
            brushStroke(stroke, `${path}.strokes[${index + 1}]`, settings),
          ),
        ],
        ...settings,
      } satisfies BrushMaskComponent;
    }
    case "linear-gradient":
      return {
        kind: "linear-gradient",
        id,
        operation: componentOperation,
        start: normalizedPoint(input.start, `${path}.start`),
        end: normalizedPoint(input.end, `${path}.end`),
      } satisfies LinearGradientMaskComponent;
    case "radial-gradient":
      return {
        kind: "radial-gradient",
        id,
        operation: componentOperation,
        center: normalizedPoint(input.center, `${path}.center`),
        radiusX: unit(input.radiusX, `${path}.radiusX`),
        radiusY: unit(input.radiusY, `${path}.radiusY`),
        rotation: finiteNumber(input.rotation, `${path}.rotation`),
        feather: unit(input.feather, `${path}.feather`),
      } satisfies RadialGradientMaskComponent;
    case "ai": {
      const model = record(input.model, `${path}.model`);
      const source = record(input.source, `${path}.source`);
      const inference = record(input.inference, `${path}.inference`);
      const modelId = model.id === "subject" || model.id === "sky"
        ? model.id
        : invalid(`${path}.model.id is not registered.`);
      const selector = input.selector === "subject" || input.selector === "sky"
        ? input.selector
        : invalid(`${path}.selector is not supported.`);
      return {
        kind: "ai",
        id,
        operation: componentOperation,
        selector,
        assetId: nonEmptyString(input.assetId, `${path}.assetId`),
        model: {
          id: modelId,
          revision: nonEmptyString(model.revision, `${path}.model.revision`),
        },
        source: {
          entryId: nonEmptyString(source.entryId, `${path}.source.entryId`),
          relativePath: nonEmptyString(source.relativePath, `${path}.source.relativePath`),
          size: integer(source.size, `${path}.source.size`, 0, Number.MAX_SAFE_INTEGER),
          lastModified: finiteNumber(source.lastModified, `${path}.source.lastModified`),
        } satisfies SourceSignature,
        inference: {
          width: integer(inference.width, `${path}.inference.width`, 1, 8_192),
          height: integer(inference.height, `${path}.inference.height`, 1, 8_192),
          threshold: unit(inference.threshold, `${path}.inference.threshold`),
        },
      } satisfies AiMaskComponent;
    }
    default:
      return invalid(`${path}.kind is not supported.`);
  }
}

export function captureBrushStrokeSettings(component: BrushMaskComponent): BrushMaskComponent {
  if (component.strokes.every((stroke) => (
    stroke.size !== undefined &&
    stroke.feather !== undefined &&
    stroke.flow !== undefined &&
    stroke.density !== undefined
  ))) {
    return component;
  }
  const capture = (stroke: BrushStroke): BrushStroke => ({
    ...stroke,
    size: stroke.size ?? component.size,
    feather: stroke.feather ?? component.feather,
    flow: stroke.flow ?? component.flow,
    density: stroke.density ?? component.density,
  });
  return {
    ...component,
    strokes: [capture(component.strokes[0]), ...component.strokes.slice(1).map(capture)],
  };
}

function localMask(value: unknown, path: string): LocalMask {
  const input = record(value, path);
  if (!Array.isArray(input.components) || input.components.length === 0 || input.components.length > MAX_COMPONENTS_PER_MASK) {
    return invalid(`${path}.components has an unsupported length.`);
  }
  const first = component(input.components[0], `${path}.components[0]`);
  return {
    id: nonEmptyString(input.id, `${path}.id`),
    name: nonEmptyString(input.name, `${path}.name`),
    enabled: booleanValue(input.enabled, `${path}.enabled`),
    inverted: booleanValue(input.inverted, `${path}.inverted`),
    components: [
      first,
      ...input.components.slice(1).map((item, index) =>
        component(item, `${path}.components[${index + 1}]`),
      ),
    ],
    adjustments: basicSettings(input.adjustments, `${path}.adjustments`),
  };
}

function decodedBase64Length(value: string, path: string): number {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return invalid(`${path} is not valid Base64.`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function asset(value: unknown, path: string): MaskRasterAsset {
  const input = record(value, path);
  const pngBase64 = stringValue(input.pngBase64, `${path}.pngBase64`);
  const byteLength = integer(input.byteLength, `${path}.byteLength`, 8, MAX_DEVELOP_PAYLOAD_BYTES);
  if (decodedBase64Length(pngBase64, `${path}.pngBase64`) !== byteLength) {
    invalid(`${path}.byteLength does not match its Base64 data.`);
  }
  if (!pngBase64.startsWith("iVBORw0KGgo")) {
    invalid(`${path}.pngBase64 is not a PNG.`);
  }
  const header = atob(pngBase64.slice(0, 32));
  if (header.length < 24 || header.slice(12, 16) !== "IHDR") {
    invalid(`${path}.pngBase64 has an invalid PNG header.`);
  }
  const headerNumber = (offset: number) =>
    header.charCodeAt(offset) * 0x1000000 +
    header.charCodeAt(offset + 1) * 0x10000 +
    header.charCodeAt(offset + 2) * 0x100 +
    header.charCodeAt(offset + 3);
  const sha256 = stringValue(input.sha256, `${path}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    invalid(`${path}.sha256 is invalid.`);
  }
  const id = nonEmptyString(input.id, `${path}.id`);
  if (id !== sha256) invalid(`${path}.id must equal its SHA-256 hash.`);
  const width = integer(input.width, `${path}.width`, 1, MAX_MATTE_EDGE);
  const height = integer(input.height, `${path}.height`, 1, MAX_MATTE_EDGE);
  if (headerNumber(16) !== width || headerNumber(20) !== height) {
    invalid(`${path} dimensions do not match its PNG header.`);
  }
  return {
    id,
    sha256,
    mimeType: input.mimeType === "image/png"
      ? "image/png"
      : invalid(`${path}.mimeType must be image/png.`),
    width,
    height,
    byteLength,
    pngBase64,
  };
}

function parseMasking(value: unknown): LocalMask[] {
  const input = record(value, "settings.masking");
  if (!Array.isArray(input.masks) || input.masks.length > MAX_MASKS) {
    return invalid(`settings.masking.masks cannot exceed ${MAX_MASKS} masks.`);
  }
  return input.masks.map((mask, index) => localMask(mask, `settings.masking.masks[${index}]`));
}

export function createDefaultDevelopDocument(): DevelopDocument {
  return { version: 2, settings: createDevelopSettings(), maskAssets: {} };
}

export function migrateLegacyDevelopSettings(value: unknown): DevelopDocument {
  const input = record(value, "legacy develop settings");
  const defaults = createDevelopSettings();
  const optionalRecord = (candidate: unknown, path: string): Record<string, unknown> =>
    candidate === undefined ? {} : record(candidate, path);
  const mixer = optionalRecord(input.mixer, "legacy develop settings.mixer");
  const normalized = {
    basic: {
      ...defaults.basic,
      ...optionalRecord(input.basic, "legacy develop settings.basic"),
    },
    crop: {
      ...defaults.crop,
      ...optionalRecord(input.crop, "legacy develop settings.crop"),
    },
    curve: normalizeCurveSettings(input.curve ?? defaults.curve),
    mixer: {
      red: { ...defaults.mixer.red, ...optionalRecord(mixer.red, "legacy develop settings.mixer.red") },
      orange: { ...defaults.mixer.orange, ...optionalRecord(mixer.orange, "legacy develop settings.mixer.orange") },
      yellow: { ...defaults.mixer.yellow, ...optionalRecord(mixer.yellow, "legacy develop settings.mixer.yellow") },
      green: { ...defaults.mixer.green, ...optionalRecord(mixer.green, "legacy develop settings.mixer.green") },
      aqua: { ...defaults.mixer.aqua, ...optionalRecord(mixer.aqua, "legacy develop settings.mixer.aqua") },
      blue: { ...defaults.mixer.blue, ...optionalRecord(mixer.blue, "legacy develop settings.mixer.blue") },
      purple: { ...defaults.mixer.purple, ...optionalRecord(mixer.purple, "legacy develop settings.mixer.purple") },
      magenta: { ...defaults.mixer.magenta, ...optionalRecord(mixer.magenta, "legacy develop settings.mixer.magenta") },
    },
    effects: {
      ...defaults.effects,
      ...optionalRecord(input.effects, "legacy develop settings.effects"),
    },
  };
  const global = parseGlobalSettings(normalized);
  return {
    version: 2,
    settings: { ...global, masking: { masks: [] } },
    maskAssets: {},
  };
}

export function parseDevelopDocument(value: unknown): DevelopDocument {
  const input = record(value, "develop document");
  const version = finiteNumber(input.version, "develop document.version");
  if (version !== 2) {
    invalid(version > 2
      ? `Develop document version ${version} is newer than this version of Darkroom.`
      : `Develop document version ${version} is not supported.`);
  }
  const settingsInput = record(input.settings, "settings");
  const global = parseGlobalSettings(settingsInput);
  const masks = parseMasking(settingsInput.masking);
  const assetsInput = record(input.maskAssets, "maskAssets");
  const maskAssets: Record<string, MaskRasterAsset> = {};
  for (const [key, rawAsset] of Object.entries(assetsInput).sort(([left], [right]) => left.localeCompare(right))) {
    const parsed = asset(rawAsset, `maskAssets.${key}`);
    if (parsed.id !== key) {
      invalid(`maskAssets.${key}.id must match its record key.`);
    }
    maskAssets[key] = parsed;
  }
  const document = {
    version: 2,
    settings: { ...global, masking: { masks } },
    maskAssets,
  } satisfies DevelopDocument;
  validateDevelopDocument(document);
  return document;
}

export function validateDevelopDocument(document: DevelopDocument): void {
  const ids = new Set<string>();
  const referencedAssets = new Set<string>();
  let strokeCount = 0;
  let pointCount = 0;
  for (const mask of document.settings.masking.masks) {
    if (ids.has(mask.id)) invalid(`Duplicate mask or component ID: ${mask.id}.`);
    ids.add(mask.id);
    for (const item of mask.components) {
      if (ids.has(item.id)) invalid(`Duplicate mask or component ID: ${item.id}.`);
      ids.add(item.id);
      switch (item.kind) {
        case "brush":
          strokeCount += item.strokes.length;
          pointCount += item.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
          break;
        case "ai":
          referencedAssets.add(item.assetId);
          if (!document.maskAssets[item.assetId]) {
            invalid(`AI component ${item.id} references missing asset ${item.assetId}.`);
          }
          break;
        case "linear-gradient":
        case "radial-gradient":
          break;
        default: {
          const exhaustive: never = item;
          return exhaustive;
        }
      }
    }
  }
  if (strokeCount > MAX_BRUSH_STROKES) invalid("Develop document has too many brush strokes.");
  if (pointCount > MAX_BRUSH_POINTS) invalid("Develop document has too many brush points.");
  for (const assetId of Object.keys(document.maskAssets)) {
    if (!referencedAssets.has(assetId)) invalid(`Mask asset ${assetId} is not referenced.`);
  }
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_DEVELOP_PAYLOAD_BYTES) {
    invalid("Develop document exceeds the 16 MiB size limit.");
  }
}

export function canonicalDevelopDocument(document: DevelopDocument): DevelopDocument {
  const maskAssets = Object.fromEntries(
    Object.entries(document.maskAssets).sort(([left], [right]) => left.localeCompare(right)),
  );
  return { version: 2, settings: document.settings, maskAssets };
}

export function isDefaultMasking(document: DevelopDocument): boolean {
  return document.settings.masking.masks.length === 0 && Object.keys(document.maskAssets).length === 0;
}
