import type { EffectsSettings } from "@/lib/develop/types";

export const DEFAULT_EFFECTS_SETTINGS: EffectsSettings = {
  vignette: 0,
  grain: 0,
  sharpening: 0,
  noiseReduction: 0,
};

function numberProp(props: Record<string, string>, key: string): number | null {
  const raw = props[key];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function isDefaultEffects(settings: EffectsSettings): boolean {
  return Object.values(settings).every((value) => value === 0);
}

export function writeEffectsXmp(
  settings: EffectsSettings,
): Record<string, string> {
  return {
    "crs:PostCropVignetteAmount": String(Math.round(settings.vignette)),
    "crs:GrainAmount": String(Math.round(settings.grain)),
    "crs:Sharpness": String(Math.round(settings.sharpening)),
    "crs:LuminanceSmoothing": String(Math.round(settings.noiseReduction)),
    "crs:ColorNoiseReduction": String(Math.round(settings.noiseReduction / 2)),
  };
}

export function readEffectsXmp(
  props: Record<string, string>,
): Partial<EffectsSettings> {
  return {
    vignette: numberProp(props, "crs:PostCropVignetteAmount") ?? 0,
    grain: numberProp(props, "crs:GrainAmount") ?? 0,
    sharpening: numberProp(props, "crs:Sharpness") ?? 0,
    noiseReduction: numberProp(props, "crs:LuminanceSmoothing") ?? 0,
  };
}
