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
}

export interface CurveSettings {
  shadows: number;
  midtones: number;
  highlights: number;
}

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

export interface XmpPluginAdapter<T extends DevelopPluginId> {
  write(settings: DevelopSettings[T]): Record<string, string>;
  read(props: Record<string, string>): Partial<DevelopSettings[T]>;
}

export interface DevelopPlugin<T extends DevelopPluginId> {
  id: T;
  label: string;
  defaults: DevelopSettings[T];
  isDefault(settings: DevelopSettings[T]): boolean;
  xmp: XmpPluginAdapter<T>;
}
