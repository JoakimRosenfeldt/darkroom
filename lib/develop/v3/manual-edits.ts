import type {
  BasicSettings,
  SourceSignature,
} from "../types";
import type { CleanupEllipse, RedEyeComponent } from "./cleanup";
import type { GeometryPoint } from "./geometry";
import type { Rgb } from "./profiles";
import { evaluateMask, type LocalMaskV3 } from "./masking";

export type LocalGeometryFrame = "canonical-v3" | "legacy-oriented-v2";

export interface MaskRasterDimensions {
  readonly width: number;
  readonly height: number;
}

export interface MaskRasterMatte extends MaskRasterDimensions {
  readonly pixels: Uint8Array;
}

export interface MaskCoverageAssets {
  readonly sourceSignature: SourceSignature;
  readonly maskMatte: (assetId: string) => MaskRasterMatte | undefined;
  readonly depthMap?: (assetId: string) => MaskRasterMatte | undefined;
}

export function pointInLocalGeometryFrame(
  frame: LocalGeometryFrame,
  canonical: GeometryPoint,
): GeometryPoint {
  switch (frame) {
    case "canonical-v3":
      return canonical;
    case "legacy-oriented-v2":
      // Frozen v2 stored manual masks in normalized EXIF-oriented source
      // coordinates with a bottom-left origin. That basis is the v3 canonical
      // basis; only the transform implementation around it changed.
      return { x: canonical.x, y: canonical.y };
    default: {
      const exhaustive: never = frame;
      return exhaustive;
    }
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  if (minimum === maximum) return value < minimum ? 0 : 1;
  const position = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return position * position * (3 - 2 * position);
}

function rotatedEllipseDistance(point: GeometryPoint, ellipse: CleanupEllipse): {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
} {
  const angle = ellipse.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = point.x - ellipse.center.x;
  const dy = point.y - ellipse.center.y;
  const x = (cosine * dx + sine * dy) / ellipse.radiusX;
  const y = (-sine * dx + cosine * dy) / ellipse.radiusY;
  return { x, y, distance: Math.hypot(x, y) };
}

export function manualMaskCoverage(
  mask: LocalMaskV3,
  point: GeometryPoint,
  dimensions: MaskRasterDimensions,
  assets?: MaskCoverageAssets,
  analysis?: { readonly color: Rgb; readonly edge: number },
): number {
  if (!mask.enabled) return 0;
  return evaluateMask({
    expression: mask.expression,
    point,
    dimensions,
    sourceSignature: assets?.sourceSignature,
    analysis,
    artifacts: assets
      ? { maskMatte: assets.maskMatte, depthMap: assets.depthMap }
      : undefined,
  }).coverage;
}

export function applyLocalBasicAdjustment(rgb: Rgb, settings: BasicSettings): Rgb {
  const gain = 2 ** clamp(settings.exposure, -10, 10);
  let red = rgb[0] * gain;
  let green = rgb[1] * gain;
  let blue = rgb[2] * gain;
  red *= 1 + settings.temperature * 0.00008 + settings.tint * 0.00002;
  green *= 1 - Math.abs(settings.tint) * 0.00003;
  blue *= 1 - settings.temperature * 0.00008 - settings.tint * 0.00002;
  const sourceLuminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const common = smoothstep(0.7, 0, sourceLuminance) * settings.shadows * 0.0015 +
    smoothstep(0.35, 1, sourceLuminance) * settings.highlights * 0.0012 +
    smoothstep(0.72, 1, sourceLuminance) * settings.whites * 0.0012 +
    smoothstep(0.25, 0, sourceLuminance) * settings.blacks * 0.0012;
  const contrast = 1 + clamp(settings.contrast, -100, 100) * 0.0035;
  let result: Rgb = [
    (red + common - 0.5) * contrast + 0.5,
    (green + common - 0.5) * contrast + 0.5,
    (blue + common - 0.5) * contrast + 0.5,
  ];
  if (settings.saturation !== 0) {
    const gray = result[0] * 0.2126 + result[1] * 0.7152 + result[2] * 0.0722;
    const scale = Math.max(0, 1 + settings.saturation / 100);
    result = [
      gray + (result[0] - gray) * scale,
      gray + (result[1] - gray) * scale,
      gray + (result[2] - gray) * scale,
    ];
  }
  if (settings.vibrance !== 0) {
    const gray = result[0] * 0.2126 + result[1] * 0.7152 + result[2] * 0.0722;
    const saturation = Math.max(...result) - Math.min(...result);
    const scale = Math.max(0, 1 + settings.vibrance / 100 * (1 - clamp(saturation, 0, 1)));
    result = [
      gray + (result[0] - gray) * scale,
      gray + (result[1] - gray) * scale,
      gray + (result[2] - gray) * scale,
    ];
  }
  return [
    clamp(result[0], -16, 16),
    clamp(result[1], -16, 16),
    clamp(result[2], -16, 16),
  ];
}

export function repairCoverage(
  point: GeometryPoint,
  ellipse: CleanupEllipse,
  feather: number,
  opacity: number,
): number {
  const distance = rotatedEllipseDistance(point, ellipse).distance;
  return clamp((1 - smoothstep(1 - feather, 1, distance)) * opacity, 0, 1);
}

export function mapRepairSourcePoint(
  point: GeometryPoint,
  target: CleanupEllipse,
  source: CleanupEllipse,
): GeometryPoint | null {
  const local = rotatedEllipseDistance(point, target);
  if (local.distance > 1) return null;
  const angle = source.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = local.x * source.radiusX;
  const y = local.y * source.radiusY;
  return {
    x: source.center.x + cosine * x - sine * y,
    y: source.center.y + sine * x + cosine * y,
  };
}

export function applyRedEye(
  rgb: Rgb,
  component: RedEyeComponent,
  point: GeometryPoint,
): Rgb {
  if (!component.enabled || component.amount === 0) return rgb;
  const distance = rotatedEllipseDistance(point, component.bounds).distance;
  const pupil = clamp(component.pupilRadius, 0.001, 1);
  const edge = 1 - smoothstep(pupil * 0.8, pupil, distance);
  if (edge <= 0) return rgb;
  const greenBlue = (rgb[1] + rgb[2]) * 0.5;
  const dominance = Math.max(0, rgb[0] - Math.max(rgb[1], rgb[2]));
  const redness = smoothstep(0.01, 0.35, dominance);
  const light = clamp(rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722, 0, 1);
  const catchlight = smoothstep(0.65, 1, light) * component.catchlightProtection;
  const amount = edge * redness * component.amount * (1 - catchlight);
  return [rgb[0] + (greenBlue - rgb[0]) * amount, rgb[1], rgb[2]];
}
