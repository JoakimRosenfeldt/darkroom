import type {
  DevelopSharpeningSettings,
  StandardDenoiseSettings,
} from "./detail";
import type { Rgb } from "./profiles";

export interface LegacyV2DetailSettings {
  readonly noiseReduction: StandardDenoiseSettings;
  readonly sharpening: DevelopSharpeningSettings;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function luminance(rgb: Rgb): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  const amount = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

export function legacyV2DetailIsActive(
  settings: LegacyV2DetailSettings,
): boolean {
  return settings.noiseReduction.noiseReduction > 0 ||
    settings.noiseReduction.colorNoiseReduction > 0 ||
    settings.sharpening.sharpening > 0;
}

export function legacyV2DetailSampleRadius(
  settings: LegacyV2DetailSettings,
): number {
  const sharpeningRadius = settings.sharpening.sharpening > 0
    ? Math.max(0.5, settings.sharpening.sharpenRadius)
    : 0;
  const luminanceRadius = settings.noiseReduction.noiseReduction > 0 ? 1 : 0;
  const colorRadius = settings.noiseReduction.colorNoiseReduction > 0
    ? 0.5 + settings.noiseReduction.colorNoiseSmoothness * 0.025
    : 0;
  return Math.max(sharpeningRadius, luminanceRadius, colorRadius);
}

export function applyLegacyV2DetailPixel(
  center: Rgb,
  neighborAverage: Rgb,
  settings: LegacyV2DetailSettings,
): Rgb {
  const noise = settings.noiseReduction;
  const sharpening = settings.sharpening;
  const luminanceBlend = clamp(
    noise.noiseReduction * 0.003 * (1.5 - noise.noiseDetail * 0.01),
    0,
    0.9,
  );
  const centerLuminance = luminance(center);
  const averageLuminance = luminance(neighborAverage);
  const luminanceDelta = (averageLuminance - centerLuminance) * luminanceBlend;
  let color: Rgb = [
    center[0] + luminanceDelta,
    center[1] + luminanceDelta,
    center[2] + luminanceDelta,
  ];
  const contrast = luminanceBlend * noise.noiseContrast * 0.01;
  color = [
    color[0] + (color[0] - neighborAverage[0]) * contrast,
    color[1] + (color[1] - neighborAverage[1]) * contrast,
    color[2] + (color[2] - neighborAverage[2]) * contrast,
  ];

  const colorBlend = clamp(
    noise.colorNoiseReduction * 0.003 *
      (1.5 - noise.colorNoiseDetail * 0.01) *
      (0.5 + noise.colorNoiseSmoothness * 0.01),
    0,
    0.9,
  );
  const colorLuminance = luminance(color);
  const sourceChroma: Rgb = [
    color[0] - colorLuminance,
    color[1] - colorLuminance,
    color[2] - colorLuminance,
  ];
  const averageChroma: Rgb = [
    neighborAverage[0] - averageLuminance,
    neighborAverage[1] - averageLuminance,
    neighborAverage[2] - averageLuminance,
  ];
  color = [
    colorLuminance + sourceChroma[0] +
      (averageChroma[0] - sourceChroma[0]) * colorBlend,
    colorLuminance + sourceChroma[1] +
      (averageChroma[1] - sourceChroma[1]) * colorBlend,
    colorLuminance + sourceChroma[2] +
      (averageChroma[2] - sourceChroma[2]) * colorBlend,
  ];

  const edgeStrength = Math.hypot(
    color[0] - neighborAverage[0],
    color[1] - neighborAverage[1],
    color[2] - neighborAverage[2],
  );
  const masking = sharpening.sharpenMasking * 0.01;
  const maskThreshold = sharpening.sharpenMasking * 0.0015;
  const maskedEdge = smoothstep(
    maskThreshold,
    maskThreshold + 0.04,
    edgeStrength,
  );
  const edgeMask = 1 + (maskedEdge - 1) * masking;
  const detailAmount = 0.5 + sharpening.sharpenDetail * 0.02;
  const sharpeningStrength = sharpening.sharpening * 0.015 *
    detailAmount * edgeMask;
  return [
    color[0] + (color[0] - neighborAverage[0]) * sharpeningStrength,
    color[1] + (color[1] - neighborAverage[1]) * sharpeningStrength,
    color[2] + (color[2] - neighborAverage[2]) * sharpeningStrength,
  ];
}
