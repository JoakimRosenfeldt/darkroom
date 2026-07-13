export interface BasicSettings {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
}

import type { AspectRatioPresetId } from "@/lib/develop/crop-geometry";

export interface CropSettings {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  perspectiveX: number;
  perspectiveY: number;
  distortion: number;
  aspectPreset: AspectRatioPresetId;
  customAspectWidth: number;
  customAspectHeight: number;
}

export type CurveChannel = "rgb" | "red" | "green" | "blue";

export interface CurvePoint {
  x: number;
  y: number;
}

export type CurveSettings = Record<CurveChannel, CurvePoint[]>;

export type MixerColor =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "aqua"
  | "blue"
  | "purple"
  | "magenta";

export interface MixerBandSettings {
  hue: number;
  saturation: number;
  luminance: number;
}

export type MixerSettings = Record<MixerColor, MixerBandSettings>;

export interface EffectsSettings {
  vignette: number;
  grain: number;
  sharpening: number;
  noiseReduction: number;
}

export interface DevelopSettings {
  basic: BasicSettings;
  crop: CropSettings;
  curve: CurveSettings;
  mixer: MixerSettings;
  effects: EffectsSettings;
}

export type DevelopPluginId = keyof DevelopSettings;

export type DevelopPluginSettings<T extends DevelopPluginId> =
  DevelopSettings[T];

export type XmpValue = string | string[];
export type XmpProps = Record<string, XmpValue>;

export interface XmpPluginAdapter<T extends DevelopPluginId> {
  write(settings: DevelopSettings[T]): XmpProps;
  read(props: XmpProps): Partial<DevelopSettings[T]>;
}

export interface DevelopPlugin<T extends DevelopPluginId> {
  id: T;
  label: string;
  defaults: DevelopSettings[T];
  isDefault(settings: DevelopSettings[T]): boolean;
  xmp: XmpPluginAdapter<T>;
}
