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
import type { AiModelId } from "@/lib/ai/types";

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
  masking: MaskingSettings;
}

export type GlobalDevelopPluginId = Exclude<keyof DevelopSettings, "masking">;
export type DevelopPluginId = GlobalDevelopPluginId;

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

export type NonEmpty<T> = readonly [T, ...T[]];
export type MaskId = string;
export type MaskComponentId = string;
export type MaskAssetId = string;
export type AiSelector = "subject" | "sky";
export type MaskOperation = "add" | "subtract";

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface BrushStroke {
  points: NonEmpty<NormalizedPoint>;
  size: number;
  feather: number;
  flow: number;
  density: number;
}

export interface BrushMaskComponent {
  kind: "brush";
  id: MaskComponentId;
  operation: MaskOperation;
  strokes: NonEmpty<BrushStroke>;
  size: number;
  feather: number;
  flow: number;
  density: number;
}

export interface LinearGradientMaskComponent {
  kind: "linear-gradient";
  id: MaskComponentId;
  operation: MaskOperation;
  start: NormalizedPoint;
  end: NormalizedPoint;
}

export interface RadialGradientMaskComponent {
  kind: "radial-gradient";
  id: MaskComponentId;
  operation: MaskOperation;
  center: NormalizedPoint;
  radiusX: number;
  radiusY: number;
  rotation: number;
  feather: number;
}

export interface SourceSignature {
  entryId: string;
  relativePath: string;
  size: number;
  lastModified: number;
}

export interface AiMaskComponent {
  kind: "ai";
  id: MaskComponentId;
  operation: MaskOperation;
  selector: AiSelector;
  assetId: MaskAssetId;
  model: {
    id: AiModelId;
    revision: string;
  };
  source: SourceSignature;
  inference: {
    width: number;
    height: number;
    threshold: number;
  };
}

export type MaskComponent =
  | BrushMaskComponent
  | LinearGradientMaskComponent
  | RadialGradientMaskComponent
  | AiMaskComponent;

export interface LocalMask {
  id: MaskId;
  name: string;
  enabled: boolean;
  inverted: boolean;
  components: NonEmpty<MaskComponent>;
  adjustments: BasicSettings;
}

export interface MaskingSettings {
  masks: LocalMask[];
}

export interface MaskRasterAsset {
  id: MaskAssetId;
  sha256: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteLength: number;
  pngBase64: string;
}

export interface DevelopDocument {
  version: 2;
  settings: DevelopSettings;
  maskAssets: Record<string, MaskRasterAsset>;
}
