import type { Rgb } from "./profiles";

export const MAX_POINT_COLOR_SAMPLES = 8;

export interface HslColor {
  readonly hueDegrees: number;
  readonly saturation: number;
  readonly luminance: number;
}

export interface PointColorAdjustment {
  readonly id: string;
  readonly enabled: boolean;
  readonly sourceHueDegrees: number;
  readonly sourceSaturation: number;
  readonly sourceLuminance: number;
  readonly hueRangeDegrees: number;
  readonly saturationRange: number;
  readonly luminanceRange: number;
  readonly falloff: number;
  readonly hueShiftDegrees: number;
  readonly saturationShift: number;
  readonly luminanceShift: number;
}

export interface PointColorSettings {
  readonly adjustments: readonly PointColorAdjustment[];
}

export const POINT_COLOR_STAGE_CONTRACT = {
  semanticStage: "curve-and-color",
  after: "global-color",
  before: ["mixer", "effects"],
  maximumSamples: MAX_POINT_COLOR_SAMPLES,
} as const;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function wrapHue(value: number): number {
  return ((finiteOr(value, 0) % 360) + 360) % 360;
}

export function circularHueDistanceDegrees(left: number, right: number): number {
  return Math.abs(((wrapHue(left) - wrapHue(right) + 540) % 360) - 180);
}

export function rgbToHsl(rgb: Rgb): HslColor {
  const red = clamp(rgb[0], 0, 1);
  const green = clamp(rgb[1], 0, 1);
  const blue = clamp(rgb[2], 0, 1);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const luminance = (maximum + minimum) / 2;
  const delta = maximum - minimum;
  if (delta === 0) return { hueDegrees: 0, saturation: 0, luminance };
  const saturation = delta / (1 - Math.abs(2 * luminance - 1));
  let hueDegrees: number;
  if (maximum === red) hueDegrees = 60 * (((green - blue) / delta) % 6);
  else if (maximum === green) hueDegrees = 60 * ((blue - red) / delta + 2);
  else hueDegrees = 60 * ((red - green) / delta + 4);
  return { hueDegrees: wrapHue(hueDegrees), saturation, luminance };
}

export function hslToRgb(hsl: HslColor): Rgb {
  const hue = wrapHue(hsl.hueDegrees);
  const saturation = clamp(hsl.saturation, 0, 1);
  const luminance = clamp(hsl.luminance, 0, 1);
  const chroma = (1 - Math.abs(2 * luminance - 1)) * saturation;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (segment < 1) [red, green] = [chroma, secondary];
  else if (segment < 2) [red, green] = [secondary, chroma];
  else if (segment < 3) [green, blue] = [chroma, secondary];
  else if (segment < 4) [green, blue] = [secondary, chroma];
  else if (segment < 5) [red, blue] = [secondary, chroma];
  else [red, blue] = [chroma, secondary];
  const offset = luminance - chroma / 2;
  return [red + offset, green + offset, blue + offset];
}

function sanitized(adjustment: PointColorAdjustment): PointColorAdjustment | null {
  if (adjustment.id.trim().length === 0) return null;
  return {
    id: adjustment.id,
    enabled: adjustment.enabled,
    sourceHueDegrees: wrapHue(adjustment.sourceHueDegrees),
    sourceSaturation: clamp(adjustment.sourceSaturation, 0, 1),
    sourceLuminance: clamp(adjustment.sourceLuminance, 0, 1),
    hueRangeDegrees: clamp(adjustment.hueRangeDegrees, 1, 180),
    saturationRange: clamp(adjustment.saturationRange, 0.01, 1),
    luminanceRange: clamp(adjustment.luminanceRange, 0.01, 1),
    falloff: clamp(adjustment.falloff, 0, 1),
    hueShiftDegrees: clamp(adjustment.hueShiftDegrees, -180, 180),
    saturationShift: clamp(adjustment.saturationShift, -1, 1),
    luminanceShift: clamp(adjustment.luminanceShift, -1, 1),
  };
}

export function boundedPointColorSettings(
  settings: PointColorSettings,
): PointColorSettings {
  const adjustments: PointColorAdjustment[] = [];
  for (const candidate of settings.adjustments) {
    const adjustment = sanitized(candidate);
    if (adjustment) adjustments.push(adjustment);
    if (adjustments.length === MAX_POINT_COLOR_SAMPLES) break;
  }
  return { adjustments };
}

function rangeWeight(distance: number, falloff: number): number {
  const boundedDistance = clamp(distance, 0, 1);
  if (boundedDistance >= 1) return 0;
  const feather = clamp(falloff, 0, 1);
  const inner = 1 - feather;
  if (feather === 0 || boundedDistance <= inner) return 1;
  const position = (boundedDistance - inner) / feather;
  const smooth = position * position * (3 - 2 * position);
  return 1 - smooth;
}

export function pointColorWeight(
  color: HslColor,
  adjustment: PointColorAdjustment,
): number {
  const bounded = sanitized(adjustment);
  if (!bounded || !bounded.enabled) return 0;
  const hueDistance = circularHueDistanceDegrees(
    color.hueDegrees,
    bounded.sourceHueDegrees,
  ) / bounded.hueRangeDegrees;
  const saturationDistance = Math.abs(
    color.saturation - bounded.sourceSaturation,
  ) / bounded.saturationRange;
  const luminanceDistance = Math.abs(
    color.luminance - bounded.sourceLuminance,
  ) / bounded.luminanceRange;
  return rangeWeight(hueDistance, bounded.falloff) *
    rangeWeight(saturationDistance, bounded.falloff) *
    rangeWeight(luminanceDistance, bounded.falloff);
}

export function pointColorAffectsPixel(
  rgb: Rgb,
  adjustment: PointColorAdjustment,
): boolean {
  return pointColorWeight(rgbToHsl(rgb), adjustment) > 0;
}

export function applyPointColor(rgb: Rgb, settings: PointColorSettings): Rgb {
  if (settings.adjustments.length === 0) return rgb;
  let color = rgbToHsl(rgb);
  let changed = false;
  for (const candidate of settings.adjustments.slice(0, MAX_POINT_COLOR_SAMPLES)) {
    const adjustment = sanitized(candidate);
    if (!adjustment || !adjustment.enabled) continue;
    if (
      adjustment.hueShiftDegrees === 0 &&
      adjustment.saturationShift === 0 &&
      adjustment.luminanceShift === 0
    ) {
      continue;
    }
    const weight = pointColorWeight(color, adjustment);
    if (weight === 0) continue;
    changed = true;
    color = {
      hueDegrees: wrapHue(color.hueDegrees + adjustment.hueShiftDegrees * weight),
      saturation: clamp(
        color.saturation + adjustment.saturationShift * weight,
        0,
        1,
      ),
      luminance: clamp(
        color.luminance + adjustment.luminanceShift * weight,
        0,
        1,
      ),
    };
  }
  return changed ? hslToRgb(color) : rgb;
}
