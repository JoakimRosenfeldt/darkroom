import type { DevelopPlugin, EffectsSettings } from "@/lib/develop/types";
import { numberProp } from "@/lib/develop/xmp-value";

export const DEFAULT_EFFECTS_SETTINGS: EffectsSettings = {
  vignette: 0,
  vignetteMidpoint: 50,
  vignetteRoundness: 0,
  vignetteFeather: 50,
  vignetteHighlights: 0,
  grain: 0,
  grainSize: 25,
  grainRoughness: 50,
  sharpening: 0,
  sharpenRadius: 1,
  sharpenDetail: 25,
  sharpenMasking: 0,
  noiseReduction: 0,
  noiseDetail: 50,
  noiseContrast: 0,
  colorNoiseReduction: 0,
  colorNoiseDetail: 50,
  colorNoiseSmoothness: 50,
};

function isDefault(settings: EffectsSettings): boolean {
  return Object.entries(DEFAULT_EFFECTS_SETTINGS).every(
    ([key, value]) => settings[key as keyof EffectsSettings] === value,
  );
}

export const effectsPlugin: DevelopPlugin<"effects"> = {
  id: "effects",
  label: "Effects & Details",
  defaults: DEFAULT_EFFECTS_SETTINGS,
  isDefault,
  xmp: {
    write: (settings) => ({
      "crs:PostCropVignetteAmount": String(Math.round(settings.vignette)),
      "crs:PostCropVignetteMidpoint": String(Math.round(settings.vignetteMidpoint)),
      "crs:PostCropVignetteRoundness": String(Math.round(settings.vignetteRoundness)),
      "crs:PostCropVignetteFeather": String(Math.round(settings.vignetteFeather)),
      "crs:PostCropVignetteHighlightContrast": String(Math.round(settings.vignetteHighlights)),
      "crs:GrainAmount": String(Math.round(settings.grain)),
      "crs:GrainSize": String(Math.round(settings.grainSize)),
      "crs:GrainFrequency": String(Math.round(settings.grainRoughness)),
      "crs:Sharpness": String(Math.round(settings.sharpening)),
      "crs:SharpenRadius": settings.sharpenRadius.toFixed(1),
      "crs:SharpenDetail": String(Math.round(settings.sharpenDetail)),
      "crs:SharpenEdgeMasking": String(Math.round(settings.sharpenMasking)),
      "crs:LuminanceSmoothing": String(Math.round(settings.noiseReduction)),
      "crs:LuminanceNoiseReductionDetail": String(Math.round(settings.noiseDetail)),
      "crs:LuminanceNoiseReductionContrast": String(Math.round(settings.noiseContrast)),
      "crs:ColorNoiseReduction": String(Math.round(settings.colorNoiseReduction)),
      "crs:ColorNoiseReductionDetail": String(Math.round(settings.colorNoiseDetail)),
      "crs:ColorNoiseReductionSmoothness": String(Math.round(settings.colorNoiseSmoothness)),
    }),
    read: (props) => ({
      vignette: numberProp(props, "crs:PostCropVignetteAmount") ?? 0,
      vignetteMidpoint: numberProp(props, "crs:PostCropVignetteMidpoint") ?? 50,
      vignetteRoundness: numberProp(props, "crs:PostCropVignetteRoundness") ?? 0,
      vignetteFeather: numberProp(props, "crs:PostCropVignetteFeather") ?? 50,
      vignetteHighlights: numberProp(props, "crs:PostCropVignetteHighlightContrast") ?? 0,
      grain: numberProp(props, "crs:GrainAmount") ?? 0,
      grainSize: numberProp(props, "crs:GrainSize") ?? 25,
      grainRoughness: numberProp(props, "crs:GrainFrequency") ?? 50,
      sharpening: numberProp(props, "crs:Sharpness") ?? 0,
      sharpenRadius: numberProp(props, "crs:SharpenRadius") ?? 1,
      sharpenDetail: numberProp(props, "crs:SharpenDetail") ?? 25,
      sharpenMasking: numberProp(props, "crs:SharpenEdgeMasking") ?? 0,
      noiseReduction: numberProp(props, "crs:LuminanceSmoothing") ?? 0,
      noiseDetail: numberProp(props, "crs:LuminanceNoiseReductionDetail") ?? 50,
      noiseContrast: numberProp(props, "crs:LuminanceNoiseReductionContrast") ?? 0,
      colorNoiseReduction: numberProp(props, "crs:ColorNoiseReduction") ?? 0,
      colorNoiseDetail: numberProp(props, "crs:ColorNoiseReductionDetail") ?? 50,
      colorNoiseSmoothness: numberProp(props, "crs:ColorNoiseReductionSmoothness") ?? 50,
    }),
  },
};
