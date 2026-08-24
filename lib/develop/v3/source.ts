import {
  type AsShotWhiteBalance,
  type CameraMetadata,
  type ColorProfileReference,
  type DecoderProvenance,
  type ExifOrientation,
  type InputProfileState,
  type LensMetadata,
  type PixelDimensions,
  type PixelPrecision,
  type SourceColorEncoding,
  type SourceRecord,
  type TransferFunction,
  type V3SourceSignature,
} from "../process";
import type { RenderQualityRequest } from "../render-contract";

export const MAX_SOURCE_EDGE = 200_000;
export const MAX_RENDER_TILES = 65_536;
export const MAX_TILE_EDGE = 16_384;
export const MAX_TILE_OVERLAP = 512;

export type SourceRequestPriority =
  | "active-loupe"
  | "export"
  | "fit"
  | "grid"
  | "background-analysis";

export const SOURCE_REQUEST_PRIORITY = {
  "active-loupe": 5,
  export: 4,
  fit: 3,
  grid: 2,
  "background-analysis": 1,
} as const satisfies Readonly<Record<SourceRequestPriority, number>>;

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DecodedSourceRequest {
  readonly source: SourceRecord;
  readonly region: PixelRegion;
  readonly precision: "native" | "linear-float32";
  readonly priority: SourceRequestPriority;
}

export interface RenderTileRequest {
  readonly tileId: string;
  readonly index: number;
  readonly core: PixelRegion;
  readonly renderRegion: PixelRegion;
  readonly overlap: number;
  readonly priority: SourceRequestPriority;
}

export interface CancellationProbe {
  readonly isCancelled: () => boolean;
  readonly reason: () => string | null;
}

export type CancellationCheckpoint =
  | { readonly kind: "continue" }
  | { readonly kind: "cancelled"; readonly reason: string };

export type TilePlanResult =
  | {
      readonly kind: "planned";
      readonly outputDimensions: PixelDimensions;
      readonly tiles: readonly RenderTileRequest[];
    }
  | { readonly kind: "invalid"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const unknownField = Object.keys(value).find((key) => !fields.includes(key));
  if (unknownField) throw new Error(`${path}.${unknownField} is not supported.`);
  return value;
}

function text(value: unknown, path: string, maximum = 4_096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${path} is invalid.`);
  }
  return value;
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${path} is invalid.`);
  }
  return value;
}

function positiveFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be positive and finite.`);
  }
  return value;
}

function nonNegativeFinite(
  value: unknown,
  path: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${path} is invalid.`);
  }
  return value;
}

function dimensions(value: unknown, path: string): PixelDimensions {
  const input = strictRecord(value, path, ["width", "height"]);
  const parsed = {
    width: integer(input.width, `${path}.width`, 1, MAX_SOURCE_EDGE),
    height: integer(input.height, `${path}.height`, 1, MAX_SOURCE_EDGE),
  };
  if (!Number.isSafeInteger(parsed.width * parsed.height)) {
    throw new Error(`${path} pixel count is too large.`);
  }
  return parsed;
}

function sourceSignature(value: unknown, path: string): V3SourceSignature {
  const input = strictRecord(value, path, [
    "entryId",
    "catalogId",
    "assetRevision",
    "relativePath",
    "size",
    "lastModified",
  ]);
  return {
    entryId: text(input.entryId, `${path}.entryId`, 1_024),
    catalogId: text(input.catalogId, `${path}.catalogId`, 1_024),
    assetRevision: integer(input.assetRevision, `${path}.assetRevision`, 0, Number.MAX_SAFE_INTEGER),
    relativePath: text(input.relativePath, `${path}.relativePath`),
    size: integer(input.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER),
    lastModified: nonNegativeFinite(
      input.lastModified,
      `${path}.lastModified`,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function orientation(value: unknown, path: string): ExifOrientation {
  switch (value) {
    case 1: return 1;
    case 2: return 2;
    case 3: return 3;
    case 4: return 4;
    case 5: return 5;
    case 6: return 6;
    case 7: return 7;
    case 8: return 8;
    default: throw new Error(`${path} is not an EXIF orientation.`);
  }
}

function decoder(value: unknown, path: string): DecoderProvenance {
  const input = strictRecord(value, path, [
    "kind",
    "decoderId",
    "decoderRevision",
    "sourceDimensions",
    "previewDimensions",
  ]);
  const decoderId = text(input.decoderId, `${path}.decoderId`, 256);
  switch (input.kind) {
    case "full-source": {
      if (input.sourceDimensions !== undefined || input.previewDimensions !== undefined) {
        throw new Error(`${path} full-source provenance contains reduced dimensions.`);
      }
      return {
        kind: "full-source",
        decoderId,
        decoderRevision: text(input.decoderRevision, `${path}.decoderRevision`, 256),
      };
    }
    case "reduced-source":
      if (input.previewDimensions !== undefined) {
        throw new Error(`${path} reduced-source provenance contains preview dimensions.`);
      }
      return {
        kind: "reduced-source",
        decoderId,
        decoderRevision: text(input.decoderRevision, `${path}.decoderRevision`, 256),
        sourceDimensions: dimensions(input.sourceDimensions, `${path}.sourceDimensions`),
      };
    case "embedded-preview":
      if (input.decoderRevision !== undefined || input.sourceDimensions !== undefined) {
        throw new Error(`${path} embedded-preview provenance contains unsupported fields.`);
      }
      return {
        kind: "embedded-preview",
        decoderId,
        previewDimensions: dimensions(input.previewDimensions, `${path}.previewDimensions`),
      };
    default: throw new Error(`${path}.kind is not supported.`);
  }
}

function precision(value: unknown, path: string): PixelPrecision {
  const input = strictRecord(value, path, ["kind", "componentBits", "storageBits"]);
  if (input.kind === "integer") {
    const componentBits = integer(input.componentBits, `${path}.componentBits`, 8, 16);
    if (![8, 10, 12, 14, 16].includes(componentBits)) {
      throw new Error(`${path}.componentBits is not supported.`);
    }
    const storageBits = input.storageBits === 8 ? 8 : input.storageBits === 16 ? 16 : null;
    if (storageBits === null || componentBits > storageBits) {
      throw new Error(`${path}.storageBits is not supported.`);
    }
    switch (componentBits) {
      case 8:
        if (storageBits !== 8) throw new Error(`${path}.storageBits is not supported.`);
        return { kind: "integer", componentBits: 8, storageBits: 8 };
      case 10: return { kind: "integer", componentBits: 10, storageBits: 16 };
      case 12: return { kind: "integer", componentBits: 12, storageBits: 16 };
      case 14: return { kind: "integer", componentBits: 14, storageBits: 16 };
      case 16: return { kind: "integer", componentBits: 16, storageBits: 16 };
      default: throw new Error(`${path}.componentBits is not supported.`);
    }
  }
  if (input.kind === "float") {
    if (input.componentBits === 16 && input.storageBits === 16) {
      return { kind: "float", componentBits: 16, storageBits: 16 };
    }
    if (input.componentBits === 32 && input.storageBits === 32) {
      return { kind: "float", componentBits: 32, storageBits: 32 };
    }
  }
  throw new Error(`${path} is not a supported precision.`);
}

function transfer(value: unknown, path: string): TransferFunction {
  const input = strictRecord(value, path, ["kind", "exponent", "label"]);
  switch (input.kind) {
    case "linear": return { kind: "linear" };
    case "srgb": return { kind: "srgb" };
    case "pq": return { kind: "pq" };
    case "hlg": return { kind: "hlg" };
    case "gamma": return { kind: "gamma", exponent: positiveFinite(input.exponent, `${path}.exponent`) };
    case "unknown": return { kind: "unknown", label: text(input.label, `${path}.label`, 256) };
    default: throw new Error(`${path}.kind is not supported.`);
  }
}

function profileReference(value: unknown, path: string): ColorProfileReference {
  const input = strictRecord(value, path, ["id", "revision", "source"]);
  const source = input.source === "embedded" ||
    input.source === "decoder" ||
    input.source === "registry" ||
    input.source === "user"
    ? input.source
    : null;
  if (!source) throw new Error(`${path}.source is not supported.`);
  return {
    id: text(input.id, `${path}.id`, 256),
    revision: text(input.revision, `${path}.revision`, 256),
    source,
  };
}

function color(value: unknown, path: string): SourceColorEncoding {
  const input = strictRecord(value, path, [
    "kind",
    "profile",
    "transfer",
    "decoderColorSpace",
    "reason",
  ]);
  switch (input.kind) {
    case "profiled":
      return {
        kind: "profiled",
        profile: profileReference(input.profile, `${path}.profile`),
        transfer: transfer(input.transfer, `${path}.transfer`),
      };
    case "decoder-provided":
      return {
        kind: "decoder-provided",
        decoderColorSpace: text(input.decoderColorSpace, `${path}.decoderColorSpace`, 256),
        transfer: transfer(input.transfer, `${path}.transfer`),
      };
    case "uncharacterized":
      return { kind: "uncharacterized", reason: text(input.reason, `${path}.reason`) };
    default: throw new Error(`${path}.kind is not supported.`);
  }
}

function inputProfile(value: unknown, path: string): InputProfileState {
  const input = strictRecord(value, path, [
    "kind", "profile", "decoderId", "decoderColorSpace", "reason",
  ]);
  switch (input.kind) {
    case "available":
      return { kind: "available", profile: profileReference(input.profile, `${path}.profile`) };
    case "decoder-default":
      return {
        kind: "decoder-default",
        decoderId: text(input.decoderId, `${path}.decoderId`, 256),
        decoderColorSpace: text(input.decoderColorSpace, `${path}.decoderColorSpace`, 256),
      };
    case "unavailable": return { kind: "unavailable", reason: text(input.reason, `${path}.reason`) };
    default: throw new Error(`${path}.kind is not supported.`);
  }
}

function asShotWhiteBalance(value: unknown, path: string): AsShotWhiteBalance {
  const input = strictRecord(value, path, ["kind", "source", "multipliers", "reason"]);
  if (input.kind === "unavailable") {
    return { kind: "unavailable", reason: text(input.reason, `${path}.reason`) };
  }
  if (input.kind !== "available") throw new Error(`${path}.kind is not supported.`);
  const source = input.source === "metadata" || input.source === "decoder" ? input.source : null;
  if (!source) throw new Error(`${path}.source is not supported.`);
  if (!Array.isArray(input.multipliers) || input.multipliers.length !== 3) {
    throw new Error(`${path}.multipliers is invalid.`);
  }
  return {
    kind: "available",
    source,
    multipliers: [
      positiveFinite(input.multipliers[0], `${path}.multipliers[0]`),
      positiveFinite(input.multipliers[1], `${path}.multipliers[1]`),
      positiveFinite(input.multipliers[2], `${path}.multipliers[2]`),
    ],
  };
}

function camera(value: unknown, path: string): CameraMetadata {
  const input = strictRecord(value, path, ["kind", "make", "model", "serialNumber"]);
  if (input.kind === "unavailable") return { kind: "unavailable" };
  if (input.kind !== "available") throw new Error(`${path}.kind is not supported.`);
  return {
    kind: "available",
    make: text(input.make, `${path}.make`, 256),
    model: text(input.model, `${path}.model`, 256),
    ...(input.serialNumber === undefined
      ? {}
      : { serialNumber: text(input.serialNumber, `${path}.serialNumber`, 256) }),
  };
}

function lens(value: unknown, path: string): LensMetadata {
  const input = strictRecord(value, path, ["kind", "make", "model", "identifier"]);
  if (input.kind === "unavailable") return { kind: "unavailable" };
  if (input.kind !== "available") throw new Error(`${path}.kind is not supported.`);
  return {
    kind: "available",
    ...(input.make === undefined ? {} : { make: text(input.make, `${path}.make`, 256) }),
    model: text(input.model, `${path}.model`, 256),
    ...(input.identifier === undefined
      ? {}
      : { identifier: text(input.identifier, `${path}.identifier`, 256) }),
  };
}

export function parseSourceRecord(value: unknown): SourceRecord {
  const input = strictRecord(value, "source", [
    "version", "signature", "dimensions", "orientation", "decoder", "precision",
    "color", "inputProfile", "asShotWhiteBalance", "camera", "lens",
  ]);
  if (input.version !== 1) throw new Error("Source record version is not supported.");
  return {
    version: 1,
    signature: sourceSignature(input.signature, "source.signature"),
    dimensions: dimensions(input.dimensions, "source.dimensions"),
    orientation: orientation(input.orientation, "source.orientation"),
    decoder: decoder(input.decoder, "source.decoder"),
    precision: precision(input.precision, "source.precision"),
    color: color(input.color, "source.color"),
    inputProfile: inputProfile(input.inputProfile, "source.inputProfile"),
    asShotWhiteBalance: asShotWhiteBalance(
      input.asShotWhiteBalance,
      "source.asShotWhiteBalance",
    ),
    camera: camera(input.camera, "source.camera"),
    lens: lens(input.lens, "source.lens"),
  };
}

export function validatePixelRegion(
  region: PixelRegion,
  dimensionsValue: PixelDimensions,
): string | null {
  if (
    !Number.isSafeInteger(region.x) ||
    !Number.isSafeInteger(region.y) ||
    !Number.isSafeInteger(region.width) ||
    !Number.isSafeInteger(region.height) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.x + region.width > dimensionsValue.width ||
    region.y + region.height > dimensionsValue.height
  ) {
    return "Pixel region is outside its dimensions.";
  }
  return null;
}

export function cancellationCheckpoint(probe: CancellationProbe): CancellationCheckpoint {
  if (!probe.isCancelled()) return { kind: "continue" };
  return { kind: "cancelled", reason: probe.reason() ?? "Cancelled." };
}

export function sourcePriorityForQuality(
  quality: RenderQualityRequest,
): SourceRequestPriority {
  switch (quality.kind) {
    case "loupe": return "active-loupe";
    case "export": return "export";
    case "fit": return "fit";
    case "grid": return "grid";
    default: {
      const exhaustive: never = quality;
      return exhaustive;
    }
  }
}

function validQualityDimensions(value: PixelDimensions): boolean {
  return Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    value.width >= 1 &&
    value.height >= 1 &&
    value.width <= MAX_SOURCE_EDGE &&
    value.height <= MAX_SOURCE_EDGE;
}

export function validateRenderQualityRequest(
  quality: RenderQualityRequest,
): string | null {
  if (!validQualityDimensions(quality.outputDimensions)) {
    return "Render output dimensions are invalid.";
  }
  switch (quality.kind) {
    case "grid":
      return Number.isSafeInteger(quality.sourceMaxEdge) &&
        quality.sourceMaxEdge >= 1 &&
        quality.sourceMaxEdge <= MAX_SOURCE_EDGE &&
        Number.isFinite(quality.devicePixelRatio) &&
        quality.devicePixelRatio >= 0.5 &&
        quality.devicePixelRatio <= 8
        ? null
        : "Grid quality request is invalid.";
    case "fit":
      return validQualityDimensions(quality.viewportDimensions) &&
        Number.isFinite(quality.devicePixelRatio) &&
        quality.devicePixelRatio >= 0.5 &&
        quality.devicePixelRatio <= 8
        ? null
        : "Fit quality request is invalid.";
    case "loupe":
      return validQualityDimensions(quality.viewportDimensions) &&
        Number.isFinite(quality.sourceCenter.x) &&
        Number.isFinite(quality.sourceCenter.y) &&
        quality.sourceCenter.x >= 0 &&
        quality.sourceCenter.x <= 1 &&
        quality.sourceCenter.y >= 0 &&
        quality.sourceCenter.y <= 1 &&
        Number.isFinite(quality.zoom) &&
        quality.zoom >= 1 &&
        quality.zoom <= 64 &&
        Number.isFinite(quality.devicePixelRatio) &&
        quality.devicePixelRatio >= 0.5 &&
        quality.devicePixelRatio <= 8
        ? null
        : "Loupe quality request is invalid.";
    case "export": {
      const qualityValue = quality.encoderQuality.kind === "lossless"
        ? true
        : Number.isFinite(quality.encoderQuality.value) &&
          quality.encoderQuality.value >= 1 &&
          quality.encoderQuality.value <= 100;
      return validQualityDimensions(quality.tileDimensions) &&
        quality.tileDimensions.width <= MAX_TILE_EDGE &&
        quality.tileDimensions.height <= MAX_TILE_EDGE &&
        Number.isSafeInteger(quality.tileOverlap) &&
        quality.tileOverlap >= 0 &&
        quality.tileOverlap <= MAX_TILE_OVERLAP &&
        qualityValue
        ? null
        : "Export quality request is invalid.";
    }
    default: {
      const exhaustive: never = quality;
      return exhaustive;
    }
  }
}

export function planFullResolutionTiles(input: {
  readonly outputDimensions: PixelDimensions;
  readonly tileDimensions: PixelDimensions;
  readonly overlap: number;
  readonly priority: SourceRequestPriority;
}): TilePlanResult {
  const output = input.outputDimensions;
  const tile = input.tileDimensions;
  if (
    !Number.isSafeInteger(output.width) ||
    !Number.isSafeInteger(output.height) ||
    output.width < 1 ||
    output.height < 1 ||
    output.width > MAX_SOURCE_EDGE ||
    output.height > MAX_SOURCE_EDGE ||
    !Number.isSafeInteger(tile.width) ||
    !Number.isSafeInteger(tile.height) ||
    tile.width < 1 ||
    tile.height < 1 ||
    tile.width > MAX_TILE_EDGE ||
    tile.height > MAX_TILE_EDGE ||
    !Number.isSafeInteger(input.overlap) ||
    input.overlap < 0 ||
    input.overlap > MAX_TILE_OVERLAP
  ) {
    return { kind: "invalid", reason: "Tile plan dimensions are invalid." };
  }
  const columns = Math.ceil(output.width / tile.width);
  const rows = Math.ceil(output.height / tile.height);
  if (columns * rows > MAX_RENDER_TILES) {
    return { kind: "invalid", reason: `Tile plan exceeds ${MAX_RENDER_TILES} tiles.` };
  }
  const tiles: RenderTileRequest[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * tile.width;
      const y = row * tile.height;
      const width = Math.min(tile.width, output.width - x);
      const height = Math.min(tile.height, output.height - y);
      const renderX = Math.max(0, x - input.overlap);
      const renderY = Math.max(0, y - input.overlap);
      const renderRight = Math.min(output.width, x + width + input.overlap);
      const renderBottom = Math.min(output.height, y + height + input.overlap);
      const index = tiles.length;
      tiles.push({
        tileId: `${row}:${column}`,
        index,
        core: { x, y, width, height },
        renderRegion: {
          x: renderX,
          y: renderY,
          width: renderRight - renderX,
          height: renderBottom - renderY,
        },
        overlap: input.overlap,
        priority: input.priority,
      });
    }
  }
  return { kind: "planned", outputDimensions: output, tiles };
}
