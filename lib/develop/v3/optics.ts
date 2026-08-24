import type { SourceRecord } from "../process";
import type { Rgb } from "./profiles";

export interface OpticsPoint {
  readonly x: number;
  readonly y: number;
}

export interface RadialCoefficients {
  readonly k1: number;
  readonly k2: number;
  readonly k3: number;
}

export interface IlluminationCoefficients {
  readonly v1: number;
  readonly v2: number;
}

export interface LateralChromaticAberration {
  readonly red: number;
  readonly blue: number;
}

export interface LensCalibration {
  readonly distortion: RadialCoefficients;
  readonly illumination: IlluminationCoefficients;
  readonly lateralChromaticAberration: LateralChromaticAberration;
}

export interface LensProfileDescriptor {
  readonly id: string;
  readonly revision: string;
  readonly label: string;
  readonly make?: string;
  readonly model: string;
  readonly identifiers: readonly string[];
  readonly calibration: LensCalibration;
  readonly provenance: "user" | "licensed-registry" | "decoder";
}

export const NEUTRAL_LENS_CALIBRATION = {
  distortion: { k1: 0, k2: 0, k3: 0 },
  illumination: { v1: 0, v2: 0 },
  lateralChromaticAberration: { red: 0, blue: 0 },
} as const satisfies LensCalibration;

export type LensMatchConfidence =
  | { readonly kind: "exact"; readonly score: 1; readonly evidence: string }
  | { readonly kind: "strong"; readonly score: number; readonly evidence: string }
  | { readonly kind: "weak"; readonly score: number; readonly evidence: string };

export type LensProfileOverride =
  | { readonly kind: "automatic" }
  | { readonly kind: "profile"; readonly profileId: string }
  | { readonly kind: "off" };

export type LensProfileResolution =
  | { readonly kind: "off"; readonly calibration: typeof NEUTRAL_LENS_CALIBRATION }
  | {
      readonly kind: "matched";
      readonly profile: LensProfileDescriptor;
      readonly confidence: LensMatchConfidence;
      readonly manual: boolean;
    }
  | {
      readonly kind: "unsupported";
      readonly calibration: typeof NEUTRAL_LENS_CALIBRATION;
      readonly reason: string;
    };

export interface OpticsAmounts {
  readonly distortion: number;
  readonly illumination: number;
  readonly lateralChromaticAberration: number;
}

export interface DefringeSettings {
  readonly amount: number;
  readonly purpleHueDegrees: number;
  readonly greenHueDegrees: number;
  readonly hueRangeDegrees: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function normalizedText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function circularHueDistance(left: number, right: number): number {
  const distance = Math.abs(((left - right + 540) % 360) - 180);
  return Number.isFinite(distance) ? distance : 180;
}

function profileConfidence(
  source: Extract<SourceRecord["lens"], { readonly kind: "available" }>,
  profile: LensProfileDescriptor,
): LensMatchConfidence | null {
  if (
    source.identifier !== undefined &&
    profile.identifiers.some((identifier) =>
      normalizedText(identifier) === normalizedText(source.identifier ?? ""),
    )
  ) {
    return { kind: "exact", score: 1, evidence: "Lens identifier matched." };
  }
  if (
    normalizedText(profile.model) === normalizedText(source.model) &&
    profile.make !== undefined &&
    source.make !== undefined &&
    normalizedText(profile.make) === normalizedText(source.make)
  ) {
    return { kind: "strong", score: 0.95, evidence: "Lens make and model matched." };
  }
  if (normalizedText(profile.model) === normalizedText(source.model)) {
    return { kind: "weak", score: 0.75, evidence: "Only the lens model matched." };
  }
  return null;
}

export function resolveLensProfile(
  source: SourceRecord,
  registry: readonly LensProfileDescriptor[],
  override: LensProfileOverride,
): LensProfileResolution {
  if (override.kind === "off") {
    return { kind: "off", calibration: NEUTRAL_LENS_CALIBRATION };
  }
  if (override.kind === "profile") {
    const profile = registry.find((candidate) => candidate.id === override.profileId);
    return profile
      ? {
          kind: "matched",
          profile,
          confidence: {
            kind: "exact",
            score: 1,
            evidence: "The profile was selected manually.",
          },
          manual: true,
        }
      : {
          kind: "unsupported",
          calibration: NEUTRAL_LENS_CALIBRATION,
          reason: `Lens profile ${override.profileId} is not installed.`,
        };
  }
  if (source.lens.kind === "unavailable") {
    return {
      kind: "unsupported",
      calibration: NEUTRAL_LENS_CALIBRATION,
      reason: "The source has no lens identity.",
    };
  }

  let best: { readonly profile: LensProfileDescriptor; readonly confidence: LensMatchConfidence } | null = null;
  for (const profile of registry) {
    const confidence = profileConfidence(source.lens, profile);
    if (confidence && (!best || confidence.score > best.confidence.score)) {
      best = { profile, confidence };
    }
  }
  return best
    ? { kind: "matched", ...best, manual: false }
    : {
        kind: "unsupported",
        calibration: NEUTRAL_LENS_CALIBRATION,
        reason: "No compatible lens profile is installed.",
      };
}

export function mapDistortedUv(
  point: OpticsPoint,
  coefficients: RadialCoefficients,
  amount = 1,
): OpticsPoint {
  const mix = clamp(amount, -1, 1);
  if (
    mix === 0 ||
    (coefficients.k1 === 0 && coefficients.k2 === 0 && coefficients.k3 === 0)
  ) {
    return point;
  }
  const x = finiteOr(point.x, 0.5) - 0.5;
  const y = finiteOr(point.y, 0.5) - 0.5;
  const radius2 = x * x + y * y;
  const radial = 1 + mix * (
    clamp(coefficients.k1, -2, 2) * radius2 +
    clamp(coefficients.k2, -2, 2) * radius2 * radius2 +
    clamp(coefficients.k3, -2, 2) * radius2 * radius2 * radius2
  );
  return {
    x: 0.5 + x * clamp(radial, 0.125, 8),
    y: 0.5 + y * clamp(radial, 0.125, 8),
  };
}

export function invertDistortedUv(
  distorted: OpticsPoint,
  coefficients: RadialCoefficients,
  amount = 1,
): OpticsPoint {
  if (
    amount === 0 ||
    (coefficients.k1 === 0 && coefficients.k2 === 0 && coefficients.k3 === 0)
  ) {
    return distorted;
  }
  let estimate = distorted;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const mapped = mapDistortedUv(estimate, coefficients, amount);
    estimate = {
      x: estimate.x + distorted.x - mapped.x,
      y: estimate.y + distorted.y - mapped.y,
    };
  }
  return estimate;
}

export function illuminationGain(
  point: OpticsPoint,
  coefficients: IlluminationCoefficients,
  amount = 1,
): number {
  const mix = clamp(amount, 0, 1);
  if (mix === 0 || (coefficients.v1 === 0 && coefficients.v2 === 0)) return 1;
  const x = finiteOr(point.x, 0.5) - 0.5;
  const y = finiteOr(point.y, 0.5) - 0.5;
  const radius2 = x * x + y * y;
  const falloff = 1 +
    clamp(coefficients.v1, -2, 2) * radius2 +
    clamp(coefficients.v2, -2, 2) * radius2 * radius2;
  return clamp(1 + (falloff - 1) * mix, 0.25, 4);
}

export function lateralChromaticAberrationUvs(
  point: OpticsPoint,
  coefficients: LateralChromaticAberration,
  amount = 1,
): { readonly red: OpticsPoint; readonly green: OpticsPoint; readonly blue: OpticsPoint } {
  const mix = clamp(amount, 0, 1);
  if (mix === 0 || (coefficients.red === 0 && coefficients.blue === 0)) {
    return { red: point, green: point, blue: point };
  }
  const x = finiteOr(point.x, 0.5) - 0.5;
  const y = finiteOr(point.y, 0.5) - 0.5;
  const redScale = 1 + clamp(coefficients.red, -0.05, 0.05) * mix;
  const blueScale = 1 + clamp(coefficients.blue, -0.05, 0.05) * mix;
  return {
    red: { x: 0.5 + x * redScale, y: 0.5 + y * redScale },
    green: point,
    blue: { x: 0.5 + x * blueScale, y: 0.5 + y * blueScale },
  };
}

function rgbToHsl(rgb: Rgb): Rgb {
  const red = clamp(rgb[0], 0, 1);
  const green = clamp(rgb[1], 0, 1);
  const blue = clamp(rgb[2], 0, 1);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  const delta = maximum - minimum;
  if (delta === 0) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);
  return [(hue + 360) % 360, saturation, lightness];
}

function hslToRgb(hsl: Rgb): Rgb {
  const hue = ((finiteOr(hsl[0], 0) % 360) + 360) % 360;
  const saturation = clamp(hsl[1], 0, 1);
  const lightness = clamp(hsl[2], 0, 1);
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
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
  const offset = lightness - chroma / 2;
  return [red + offset, green + offset, blue + offset];
}

export function applyHueBoundedDefringe(
  rgb: Rgb,
  settings: DefringeSettings,
): Rgb {
  const amount = clamp(settings.amount, 0, 100) / 100;
  if (amount === 0) return rgb;
  const hsl = rgbToHsl(rgb);
  const range = clamp(settings.hueRangeDegrees, 1, 60);
  const distance = Math.min(
    circularHueDistance(hsl[0], settings.purpleHueDegrees),
    circularHueDistance(hsl[0], settings.greenHueDegrees),
  );
  if (distance >= range) return rgb;
  const weight = 1 - distance / range;
  return hslToRgb([hsl[0], hsl[1] * (1 - amount * weight), hsl[2]]);
}
