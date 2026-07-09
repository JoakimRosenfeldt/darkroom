import type { DevelopPlugin, EffectsSettings } from "@/lib/develop/types";
import { numberProp } from "@/lib/develop/number-prop";

export const DEFAULT_EFFECTS_SETTINGS: EffectsSettings = {
  vignette: 0,
  grain: 0,
  sharpening: 0,
  noiseReduction: 0,
};

function isDefault(settings: EffectsSettings): boolean {
  return Object.values(settings).every((value) => value === 0);
}

export const effectsPlugin: DevelopPlugin<"effects"> = {
  id: "effects",
  label: "Effects & Details",
  defaults: DEFAULT_EFFECTS_SETTINGS,
  isDefault,
  xmp: {
    write: (settings) => ({
      "crs:PostCropVignetteAmount": String(Math.round(settings.vignette)),
      "crs:GrainAmount": String(Math.round(settings.grain)),
      "crs:Sharpness": String(Math.round(settings.sharpening)),
      "crs:LuminanceSmoothing": String(Math.round(settings.noiseReduction)),
      "crs:ColorNoiseReduction": String(
        Math.round(settings.noiseReduction / 2),
      ),
    }),
    read: (props) => ({
      vignette: numberProp(props, "crs:PostCropVignetteAmount") ?? 0,
      grain: numberProp(props, "crs:GrainAmount") ?? 0,
      sharpening: numberProp(props, "crs:Sharpness") ?? 0,
      noiseReduction: numberProp(props, "crs:LuminanceSmoothing") ?? 0,
    }),
  },
};
