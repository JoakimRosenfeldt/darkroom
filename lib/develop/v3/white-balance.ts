import type { SourceRecord } from "../process";
import type { Rgb } from "./profiles";

export const MAX_WHITE_BALANCE_SAMPLES = 4_096;

export interface WhiteBalanceValues {
  readonly temperatureKelvin: number;
  readonly tint: number;
  readonly gains: Rgb;
}

export type WhiteBalanceSetting =
  | { readonly mode: "current"; readonly values: WhiteBalanceValues }
  | { readonly mode: "camera"; readonly values: WhiteBalanceValues }
  | { readonly mode: "custom"; readonly values: WhiteBalanceValues }
  | { readonly mode: "sampled"; readonly values: WhiteBalanceValues }
  | { readonly mode: "auto"; readonly values: WhiteBalanceValues };

export interface WhiteBalanceSourceCapabilities {
  readonly source: SourceRecord;
  readonly rgbState: "unbalanced-linear" | "camera-wb-baked" | "unknown";
}

export type WhiteBalanceSampleSource =
  | { readonly kind: "source-linear"; readonly samples: readonly Rgb[] }
  | { readonly kind: "display-referred"; readonly samples: readonly Rgb[] }
  | { readonly kind: "unavailable"; readonly reason: string };

export type WhiteBalanceProposalResult =
  | {
      readonly kind: "proposal";
      readonly mode: "camera" | "sampled" | "auto";
      readonly values: WhiteBalanceValues;
      readonly sampleCount: number;
    }
  | {
      readonly kind: "unavailable";
      readonly mode: "camera" | "auto";
      readonly reason: string;
    }
  | {
      readonly kind: "invalid-source";
      readonly mode: "sampled" | "auto";
      readonly reason:
        | "not-source-linear"
        | "tap-unavailable"
        | "empty"
        | "non-finite"
        | "no-neutral-samples";
    };

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

export function resolveManualWhiteBalance(adjustment: {
  readonly temperature: number;
  readonly tint: number;
}): WhiteBalanceValues {
  const temperature = clamp(adjustment.temperature, -3_000, 3_000);
  const tint = clamp(adjustment.tint, -150, 150);
  const warmth = temperature / 3_000;
  const tintScale = Math.pow(2, -tint / 150);
  return {
    temperatureKelvin: Math.round(clamp(5_500 + temperature, 2_000, 50_000)),
    tint,
    gains: [
      clamp(Math.pow(2, warmth), 0.25, 4),
      clamp(tintScale, 0.25, 4),
      clamp(Math.pow(2, -warmth), 0.25, 4),
    ],
  };
}

function normalizedGains(red: number, green: number, blue: number): Rgb {
  if (red <= 0 || green <= 0 || blue <= 0) return [1, 1, 1];
  return [
    clamp(green / red, 0.25, 4),
    1,
    clamp(green / blue, 0.25, 4),
  ];
}

function valuesFromGains(gains: Rgb): WhiteBalanceValues {
  const redBlueBalance = Math.log2(clamp(gains[0] / gains[2], 1 / 16, 16));
  const greenBalance = Math.log2(clamp(2 / (gains[0] + gains[2]), 1 / 16, 16));
  return {
    temperatureKelvin: Math.round(clamp(5_500 + redBlueBalance * 1_750, 2_000, 50_000)),
    tint: Math.round(clamp(greenBalance * 50, -150, 150) * 100) / 100,
    gains,
  };
}

function neutralProposal(
  mode: "sampled" | "auto",
  source: WhiteBalanceSampleSource,
): WhiteBalanceProposalResult {
  if (source.kind !== "source-linear") {
    return {
      kind: "invalid-source",
      mode,
      reason: source.kind === "display-referred"
        ? "not-source-linear"
        : "tap-unavailable",
    };
  }
  if (source.samples.length === 0) {
    return { kind: "invalid-source", mode, reason: "empty" };
  }

  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let redMinimum = Number.POSITIVE_INFINITY;
  let greenMinimum = Number.POSITIVE_INFINITY;
  let blueMinimum = Number.POSITIVE_INFINITY;
  let redMaximum = Number.NEGATIVE_INFINITY;
  let greenMaximum = Number.NEGATIVE_INFINITY;
  let blueMaximum = Number.NEGATIVE_INFINITY;
  let count = 0;
  let encounteredNonFinite = false;
  const limit = Math.min(source.samples.length, MAX_WHITE_BALANCE_SAMPLES);
  for (let index = 0; index < limit; index += 1) {
    const sample = source.samples[index];
    if (!sample.every(Number.isFinite)) {
      encounteredNonFinite = true;
      continue;
    }
    const red = clamp(sample[0], 0, 16);
    const green = clamp(sample[1], 0, 16);
    const blue = clamp(sample[2], 0, 16);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    if (maximum < 1e-4 || maximum >= 15.99 || minimum / maximum < 0.08) continue;
    redSum += red;
    greenSum += green;
    blueSum += blue;
    redMinimum = Math.min(redMinimum, red);
    greenMinimum = Math.min(greenMinimum, green);
    blueMinimum = Math.min(blueMinimum, blue);
    redMaximum = Math.max(redMaximum, red);
    greenMaximum = Math.max(greenMaximum, green);
    blueMaximum = Math.max(blueMaximum, blue);
    count += 1;
  }
  if (count === 0) {
    return {
      kind: "invalid-source",
      mode,
      reason: encounteredNonFinite ? "non-finite" : "no-neutral-samples",
    };
  }
  if (count > 4) {
    redSum -= redMinimum + redMaximum;
    greenSum -= greenMinimum + greenMaximum;
    blueSum -= blueMinimum + blueMaximum;
    count -= 2;
  }
  const gains = normalizedGains(redSum / count, greenSum / count, blueSum / count);
  return {
    kind: "proposal",
    mode,
    values: valuesFromGains(gains),
    sampleCount: count,
  };
}

export function proposeCameraWhiteBalance(
  capabilities: WhiteBalanceSourceCapabilities,
): WhiteBalanceProposalResult {
  if (capabilities.rgbState === "camera-wb-baked") {
    return {
      kind: "unavailable",
      mode: "camera",
      reason: "Camera white balance is already baked into the source pixels.",
    };
  }
  if (capabilities.rgbState !== "unbalanced-linear") {
    return {
      kind: "unavailable",
      mode: "camera",
      reason: "The source pixel white-balance state is unknown.",
    };
  }
  if (capabilities.source.asShotWhiteBalance.kind === "unavailable") {
    return {
      kind: "unavailable",
      mode: "camera",
      reason: capabilities.source.asShotWhiteBalance.reason,
    };
  }
  const multipliers = capabilities.source.asShotWhiteBalance.multipliers;
  if (!multipliers.every((value) => Number.isFinite(value) && value > 0)) {
    return {
      kind: "unavailable",
      mode: "camera",
      reason: "The as-shot white-balance metadata is invalid.",
    };
  }
  const green = multipliers[1];
  const gains: Rgb = [
    clamp(multipliers[0] / green, 0.25, 4),
    1,
    clamp(multipliers[2] / green, 0.25, 4),
  ];
  return {
    kind: "proposal",
    mode: "camera",
    values: valuesFromGains(gains),
    sampleCount: 0,
  };
}

export function proposeSampledWhiteBalance(
  source: WhiteBalanceSampleSource,
): WhiteBalanceProposalResult {
  return neutralProposal("sampled", source);
}

export function proposeAutoWhiteBalance(
  source: WhiteBalanceSampleSource,
): WhiteBalanceProposalResult {
  return neutralProposal("auto", source);
}

export function applyWhiteBalance(rgb: Rgb, values: WhiteBalanceValues): Rgb {
  const gains: Rgb = [
    clamp(values.gains[0], 0.25, 4),
    clamp(values.gains[1], 0.25, 4),
    clamp(values.gains[2], 0.25, 4),
  ];
  if (gains[0] === 1 && gains[1] === 1 && gains[2] === 1) return rgb;
  return [
    clamp(finiteOr(rgb[0], 0) * gains[0], 0, 16),
    clamp(finiteOr(rgb[1], 0) * gains[1], 0, 16),
    clamp(finiteOr(rgb[2], 0) * gains[2], 0, 16),
  ];
}
