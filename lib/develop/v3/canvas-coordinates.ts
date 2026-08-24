import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type {
  PixelDimensions,
  SourceRecord,
  TransferFunction,
} from "../process";
import type { DevelopDocumentV3 } from "./document";
import {
  mapCanonicalToOutput,
  mapCanonicalToStored,
  mapOutputToCanonical,
  type CanonicalGeometry,
  type GeometryMapResult,
  type GeometryPoint,
} from "./geometry";
import {
  NEUTRAL_LENS_CALIBRATION,
  type LensCalibration,
} from "./optics";
import type { Rgb } from "./profiles";

export type CanvasSourceSampleResult =
  | { readonly kind: "sampled"; readonly samples: readonly Rgb[] }
  | { readonly kind: "unavailable"; readonly reason: string };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));
}

function manualLensCalibration(document: DevelopDocumentV3): LensCalibration {
  return document.optics.manualDistortion === 0
    ? NEUTRAL_LENS_CALIBRATION
    : {
        distortion: {
          k1: clamp(document.optics.manualDistortion / 100, -1, 1),
          k2: 0,
          k3: 0,
        },
        illumination: { v1: 0, v2: 0 },
        lateralChromaticAberration: { red: 0, blue: 0 },
      };
}

export function v3OrientedDimensions(source: SourceRecord): PixelDimensions {
  return source.orientation >= 5
    ? { width: source.dimensions.height, height: source.dimensions.width }
    : source.dimensions;
}

export function createV3CanvasGeometry(
  document: DevelopDocumentV3,
  source: SourceRecord,
): CanonicalGeometry {
  return {
    sourceWidth: source.dimensions.width,
    sourceHeight: source.dimensions.height,
    exifOrientation: source.orientation,
    optics: {
      calibration: manualLensCalibration(document),
      amounts: {
        distortion: document.optics.manualDistortion === 0 ? 0 : 1,
        illumination: 0,
        lateralChromaticAberration: 0,
      },
    },
    orientation: document.geometry.orientation,
    manualPerspective: document.geometry.manualPerspective.matrix,
    upright: document.geometry.upright,
    constrainCrop: document.geometry.constrainCrop,
    crop: document.geometry.crop,
  };
}

export function mapV3CanvasOutputToCanonical(
  output: GeometryPoint,
  document: DevelopDocumentV3,
  source: SourceRecord,
): GeometryMapResult {
  return mapOutputToCanonical(output, createV3CanvasGeometry(document, source));
}

export function mapV3CanonicalToCanvasOutput(
  canonical: GeometryPoint,
  document: DevelopDocumentV3,
  source: SourceRecord,
): GeometryMapResult {
  return mapCanonicalToOutput(canonical, createV3CanvasGeometry(document, source));
}

function sourceTransfer(source: SourceRecord): TransferFunction | null {
  switch (source.color.kind) {
    case "decoder-provided":
    case "profiled":
      return source.color.transfer;
    case "uncharacterized":
      return null;
    default: {
      const exhaustive: never = source.color;
      return exhaustive;
    }
  }
}

function decodeTransfer(value: number, transfer: TransferFunction): number | null {
  const bounded = clamp(value, 0, 1);
  switch (transfer.kind) {
    case "linear": return bounded;
    case "srgb": return bounded <= 0.04045
      ? bounded / 12.92
      : ((bounded + 0.055) / 1.055) ** 2.4;
    case "gamma": return bounded ** clamp(transfer.exponent, 0.1, 8);
    case "hlg":
    case "pq":
    case "unknown":
      return null;
    default: {
      const exhaustive: never = transfer;
      return exhaustive;
    }
  }
}

function readLinearPixel(
  image: DevelopImage,
  transfer: TransferFunction,
  x: number,
  y: number,
): Rgb | null {
  const boundedX = Math.max(0, Math.min(image.sourceWidth - 1, x));
  const boundedY = Math.max(0, Math.min(image.sourceHeight - 1, y));
  const offset = (boundedY * image.sourceWidth + boundedX) * image.colors;
  const maximum = 2 ** image.bits - 1;
  const red = decodeTransfer((image.rgb[offset] ?? 0) / maximum, transfer);
  const green = decodeTransfer((image.rgb[offset + 1] ?? 0) / maximum, transfer);
  const blue = decodeTransfer((image.rgb[offset + 2] ?? 0) / maximum, transfer);
  return red === null || green === null || blue === null
    ? null
    : [red, green, blue];
}

export function sampleV3SourceLinear(
  image: DevelopImage,
  source: SourceRecord,
  canonical: GeometryPoint,
): CanvasSourceSampleResult {
  const transfer = sourceTransfer(source);
  if (!transfer) {
    return { kind: "unavailable", reason: "The source color transfer is not characterized." };
  }
  const stored = mapCanonicalToStored(canonical, source.orientation);
  const centerX = Math.round(clamp(stored.x, 0, 1) * Math.max(0, image.sourceWidth - 1));
  const centerY = Math.round((1 - clamp(stored.y, 0, 1)) * Math.max(0, image.sourceHeight - 1));
  const samples: Rgb[] = [];
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sample = readLinearPixel(image, transfer, centerX + offsetX, centerY + offsetY);
      if (!sample) {
        return { kind: "unavailable", reason: `The ${transfer.kind} transfer cannot be sampled as linear RGB.` };
      }
      samples.push(sample);
    }
  }
  return { kind: "sampled", samples };
}
