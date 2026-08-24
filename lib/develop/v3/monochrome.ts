import { circularHueDistanceDegrees, rgbToHsl } from "./point-color";
import type { Rgb } from "./profiles";

export const MONOCHROME_CHANNELS = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
] as const;

export type MonochromeChannel = (typeof MONOCHROME_CHANNELS)[number];
export type MonochromeMixer = Readonly<Record<MonochromeChannel, number>>;

export interface MonochromeProfile {
  readonly id: string;
  readonly revision: string;
  readonly label: string;
  readonly luminanceWeights: Rgb;
  readonly channelBias: MonochromeMixer;
}

export interface MonochromeSettings {
  readonly enabled: boolean;
  readonly profileId: string;
  readonly mixer: MonochromeMixer;
}

export const NEUTRAL_MONOCHROME_PROFILE = {
  id: "darkroom-neutral-monochrome",
  revision: "1",
  label: "Neutral B&W",
  luminanceWeights: [0.2126, 0.7152, 0.0722],
  channelBias: {
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
    aqua: 0,
    blue: 0,
    purple: 0,
    magenta: 0,
  },
} as const satisfies MonochromeProfile;

export type MonochromeProfileResolution =
  | { readonly kind: "resolved"; readonly profile: MonochromeProfile }
  | { readonly kind: "unsupported"; readonly profileId: string };

const CHANNEL_HUES: Readonly<Record<MonochromeChannel, number>> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 275,
  magenta: 315,
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

export function resolveMonochromeProfile(
  profileId: string,
  registry: readonly MonochromeProfile[],
): MonochromeProfileResolution {
  const profile = registry.find((candidate) => candidate.id === profileId);
  return profile
    ? { kind: "resolved", profile }
    : { kind: "unsupported", profileId };
}

function mixerAdjustment(
  hueDegrees: number,
  mixer: MonochromeMixer,
  profile: MonochromeProfile,
): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const channel of MONOCHROME_CHANNELS) {
    const distance = circularHueDistanceDegrees(hueDegrees, CHANNEL_HUES[channel]);
    const weight = Math.max(0, 1 - distance / 60);
    weighted += weight * clamp(mixer[channel] + profile.channelBias[channel], -100, 100);
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight / 100 : 0;
}

export function applyMonochrome(
  rgb: Rgb,
  settings: MonochromeSettings,
  profile: MonochromeProfile,
): Rgb {
  if (!settings.enabled) return rgb;
  const red = clamp(rgb[0], 0, 1);
  const green = clamp(rgb[1], 0, 1);
  const blue = clamp(rgb[2], 0, 1);
  const weights: Rgb = [
    clamp(profile.luminanceWeights[0], 0, 2),
    clamp(profile.luminanceWeights[1], 0, 2),
    clamp(profile.luminanceWeights[2], 0, 2),
  ];
  const weightTotal = Math.max(1e-6, weights[0] + weights[1] + weights[2]);
  const base = (
    red * weights[0] +
    green * weights[1] +
    blue * weights[2]
  ) / weightTotal;
  const hsl = rgbToHsl([red, green, blue]);
  const adjustment = mixerAdjustment(hsl.hueDegrees, settings.mixer, profile);
  const luminance = clamp(base + adjustment * hsl.saturation * 0.5, 0, 1);
  return [luminance, luminance, luminance];
}
