import { hslToRgb } from "./point-color";
import type { Rgb } from "./profiles";

export interface ColorGradingWheel {
  readonly hueDegrees: number;
  readonly saturation: number;
  readonly luminance: number;
}

export interface ColorGradingSettings {
  readonly shadows: ColorGradingWheel;
  readonly midtones: ColorGradingWheel;
  readonly highlights: ColorGradingWheel;
  readonly balance: number;
  readonly blending: number;
}

export interface ColorGradingWeights {
  readonly shadows: number;
  readonly midtones: number;
  readonly highlights: number;
}

export const COLOR_GRADING_NUMERIC_BOUNDS = {
  hueDegrees: { minimum: 0, maximumExclusive: 360 },
  saturation: { minimum: 0, maximum: 100 },
  luminance: { minimum: -100, maximum: 100 },
  balance: { minimum: -100, maximum: 100 },
  blending: { minimum: 0, maximum: 100 },
} as const;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  if (minimum === maximum) return value < minimum ? 0 : 1;
  const position = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return position * position * (3 - 2 * position);
}

function wheelIsNeutral(wheel: ColorGradingWheel): boolean {
  return clamp(wheel.saturation, 0, 100) === 0 &&
    clamp(wheel.luminance, -100, 100) === 0;
}

export function colorGradingWeights(
  luminance: number,
  settings: ColorGradingSettings,
): ColorGradingWeights {
  const value = clamp(luminance, 0, 1);
  const balanceShift = clamp(settings.balance, -100, 100) / 500;
  const feather = 0.05 + clamp(settings.blending, 0, 100) / 400;
  const shadowPivot = clamp(0.35 + balanceShift, 0.1, 0.7);
  const highlightPivot = clamp(0.65 + balanceShift, 0.3, 0.9);
  let shadows = 1 - smoothstep(shadowPivot - feather, shadowPivot + feather, value);
  let highlights = smoothstep(
    highlightPivot - feather,
    highlightPivot + feather,
    value,
  );
  let midtones = Math.max(0, 1 - shadows - highlights);
  const total = shadows + midtones + highlights;
  if (total > 1) {
    shadows /= total;
    midtones /= total;
    highlights /= total;
  }
  return { shadows, midtones, highlights };
}

function wheelTint(wheel: ColorGradingWheel): Rgb {
  return hslToRgb({
    hueDegrees: wheel.hueDegrees,
    saturation: 1,
    luminance: 0.5,
  });
}

function applyWheel(
  rgb: Rgb,
  wheel: ColorGradingWheel,
  weight: number,
): Rgb {
  if (weight === 0 || wheelIsNeutral(wheel)) return rgb;
  const tint = wheelTint(wheel);
  const saturation = clamp(wheel.saturation, 0, 100) / 100;
  const luminance = clamp(wheel.luminance, -100, 100) / 100;
  return [
    clamp(rgb[0] + (tint[0] - 0.5) * saturation * weight + luminance * 0.25 * weight, 0, 1),
    clamp(rgb[1] + (tint[1] - 0.5) * saturation * weight + luminance * 0.25 * weight, 0, 1),
    clamp(rgb[2] + (tint[2] - 0.5) * saturation * weight + luminance * 0.25 * weight, 0, 1),
  ];
}

export function applyColorGrading(
  rgb: Rgb,
  settings: ColorGradingSettings,
): Rgb {
  if (
    wheelIsNeutral(settings.shadows) &&
    wheelIsNeutral(settings.midtones) &&
    wheelIsNeutral(settings.highlights)
  ) {
    return rgb;
  }
  const luminance = clamp(
    rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722,
    0,
    1,
  );
  const weights = colorGradingWeights(luminance, settings);
  let result = applyWheel(rgb, settings.shadows, weights.shadows);
  result = applyWheel(result, settings.midtones, weights.midtones);
  return applyWheel(result, settings.highlights, weights.highlights);
}
