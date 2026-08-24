import type { Rgb } from "./profiles";
import {
  readClampedPixel,
  sampleBilinearClamped,
  type ReadonlyRgbImage,
  type SpatialStageDeclaration,
} from "./presence";

export type DetailStageId = "standard-denoise" | "develop-sharpening";

export interface StandardDenoiseSettings {
  readonly noiseReduction: number;
  readonly noiseDetail: number;
  readonly noiseContrast: number;
  readonly colorNoiseReduction: number;
  readonly colorNoiseDetail: number;
  readonly colorNoiseSmoothness: number;
}

export interface DevelopSharpeningSettings {
  readonly sharpening: number;
  readonly sharpenRadius: number;
  readonly sharpenDetail: number;
  readonly sharpenMasking: number;
}

export const DETAIL_STAGE_DECLARATIONS = [
  {
    id: "standard-denoise",
    semanticStageId: "standard-denoise",
    orderWithinStage: 1,
    sourceRelativeScale: { kind: "source-pixels", radius: 3 },
    haloSourcePixels: 3,
    borderPolicy: "clamp-to-edge",
    inputPrecision: "linear-float32",
    dependencies: ["optics"],
  },
  {
    id: "develop-sharpening",
    semanticStageId: "develop-sharpening",
    orderWithinStage: 1,
    sourceRelativeScale: { kind: "source-pixels", radius: 3 },
    haloSourcePixels: 3,
    borderPolicy: "clamp-to-edge",
    inputPrecision: "linear-float32",
    dependencies: ["creative-spatial-effect"],
  },
] as const satisfies readonly SpatialStageDeclaration<DetailStageId>[];

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function sourceRadiusInInputPixels(
  radiusSourcePixels: number,
  sourcePixelsPerInputPixel: number,
): number {
  return clamp(
    radiusSourcePixels / clamp(sourcePixelsPerInputPixel, 1 / 64, 64),
    0.25,
    192,
  );
}

function nineTapAverage(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
  radius: number,
): Rgb {
  const diagonal = radius * Math.SQRT1_2;
  const offsets: readonly (readonly [number, number])[] = [
    [0, 0],
    [radius, 0],
    [-radius, 0],
    [0, radius],
    [0, -radius],
    [diagonal, diagonal],
    [-diagonal, diagonal],
    [diagonal, -diagonal],
    [-diagonal, -diagonal],
  ];
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const offset of offsets) {
    const sample = sampleBilinearClamped(image, x + offset[0], y + offset[1]);
    red += sample[0];
    green += sample[1];
    blue += sample[2];
  }
  return [red / offsets.length, green / offsets.length, blue / offsets.length];
}

function luminance(rgb: Rgb): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

export function applyStandardDenoisePixel(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
  settings: StandardDenoiseSettings,
  sourcePixelsPerInputPixel: number,
): Rgb {
  const center = readClampedPixel(image, x, y);
  const luminanceAmount = clamp(settings.noiseReduction, 0, 100) / 100;
  const colorAmount = clamp(settings.colorNoiseReduction, 0, 100) / 100;
  if (luminanceAmount === 0 && colorAmount === 0) return center;
  const luminanceDetail = clamp(settings.noiseDetail, 0, 100) / 100;
  const colorDetail = clamp(settings.colorNoiseDetail, 0, 100) / 100;
  const smoothness = clamp(settings.colorNoiseSmoothness, 0, 100) / 100;
  const radius = sourceRadiusInInputPixels(
    1 + luminanceAmount * 2,
    sourcePixelsPerInputPixel,
  );
  const average = nineTapAverage(image, x, y, radius);
  const centerLuminance = luminance(center);
  const averageLuminance = luminance(average);
  const edge = Math.abs(centerLuminance - averageLuminance);
  const contrastThreshold = 0.005 + clamp(settings.noiseContrast, 0, 100) / 500;
  const edgeProtection = clamp(edge / contrastThreshold, 0, 1);
  const luminanceMix = luminanceAmount * (1 - edgeProtection * luminanceDetail);
  const targetLuminance = centerLuminance +
    (averageLuminance - centerLuminance) * luminanceMix;
  const luminanceDelta = targetLuminance - centerLuminance;
  const centerChroma: Rgb = [
    center[0] - centerLuminance,
    center[1] - centerLuminance,
    center[2] - centerLuminance,
  ];
  const averageChroma: Rgb = [
    average[0] - averageLuminance,
    average[1] - averageLuminance,
    average[2] - averageLuminance,
  ];
  const colorMix = colorAmount * (0.5 + smoothness * 0.5) *
    (1 - edgeProtection * colorDetail);
  const outputChannel = (channel: 0 | 1 | 2): number => {
    const chroma = centerChroma[channel] +
      (averageChroma[channel] - centerChroma[channel]) * colorMix;
    return clamp(centerLuminance + luminanceDelta + chroma, 0, 16);
  };
  return [outputChannel(0), outputChannel(1), outputChannel(2)];
}

export function applyDevelopSharpeningPixel(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
  settings: DevelopSharpeningSettings,
  sourcePixelsPerInputPixel: number,
): Rgb {
  const center = readClampedPixel(image, x, y);
  const amount = clamp(settings.sharpening, 0, 100) / 100;
  if (amount === 0) return center;
  const radius = sourceRadiusInInputPixels(
    clamp(settings.sharpenRadius, 0.5, 3),
    sourcePixelsPerInputPixel,
  );
  const average = nineTapAverage(image, x, y, radius);
  const detail = 0.5 + clamp(settings.sharpenDetail, 0, 100) / 100 * 1.5;
  const edge = Math.abs(luminance(center) - luminance(average));
  const masking = clamp(settings.sharpenMasking, 0, 100) / 100;
  const threshold = masking * 0.08;
  const edgeWeight = threshold === 0
    ? 1
    : clamp((edge - threshold) / 0.04, 0, 1);
  const strength = amount * detail * edgeWeight;
  return [
    clamp(center[0] + (center[0] - average[0]) * strength, 0, 16),
    clamp(center[1] + (center[1] - average[1]) * strength, 0, 16),
    clamp(center[2] + (center[2] - average[2]) * strength, 0, 16),
  ];
}
