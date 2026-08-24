import type { AspectRatioPresetId } from "../crop-geometry";
import {
  COORDINATE_FRAME_REVISION,
  DEVELOP_PROCESS_ID,
  DEVELOP_PROCESS_VERSION,
} from "../process";
import type {
  CurveSettings,
  DevelopDocument,
  LocalMask,
  MixerSettings,
} from "../types";
import type { DevelopAssetRef } from "./assets";
import type { CleanupLayer } from "./cleanup";
import {
  DEFAULT_LENS_BLUR_SETTINGS,
  type LensBlurSettings,
} from "./lens-blur";
import type { ColorGradingSettings } from "./color-grading";
import type {
  DevelopSharpeningSettings,
  StandardDenoiseSettings,
} from "./detail";
import type { GeometryFrame, Homography, UserOrientation } from "./geometry";
import { IDENTITY_HOMOGRAPHY } from "./geometry";
import type { MonochromeSettings } from "./monochrome";
import { NEUTRAL_MONOCHROME_PROFILE } from "./monochrome";
import type { PointColorSettings } from "./point-color";
import type { InputCalibration } from "./profiles";
import { IDENTITY_MATRIX_3 } from "./profiles";
import type { DefringeSettings, OpticsAmounts } from "./optics";
import type { PresenceSettings } from "./presence";
import type { WhiteBalanceValues } from "./white-balance";

export const V3_DOCUMENT_SCHEMA_REVISION = "darkroom-v3-document-1";
export const V2_TO_V3_MAPPING_REVISION = "darkroom-v2-to-v3-1";

export interface BasicToneEdits {
  readonly exposure: number;
  readonly contrast: number;
  readonly highlights: number;
  readonly shadows: number;
  readonly whites: number;
  readonly blacks: number;
}

export interface GlobalColorEdits {
  readonly vibrance: number;
  readonly saturation: number;
}

export type PersistedWhiteBalanceMode =
  | "current"
  | "camera"
  | "custom"
  | "sampled"
  | "auto"
  | "legacy-custom";

export interface PersistedWhiteBalance {
  readonly mode: PersistedWhiteBalanceMode;
  readonly adjustment: {
    readonly temperature: number;
    readonly tint: number;
  };
  readonly resolved: WhiteBalanceValues;
}

export type InputProfileSelection =
  | { readonly kind: "decoder-default" }
  | {
      readonly kind: "selected";
      readonly profileId: string;
      readonly profileRevision: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface PersistedInputProfile {
  readonly registryRevision: string;
  readonly selection: InputProfileSelection;
  readonly calibration: InputCalibration;
}

export type LensProfileSelection =
  | { readonly kind: "automatic" }
  | { readonly kind: "selected"; readonly profileId: string }
  | { readonly kind: "off" };

export interface PersistedOptics {
  readonly registryRevision: string;
  readonly profile: LensProfileSelection;
  readonly amounts: OpticsAmounts;
  readonly manualDistortion: number;
  readonly defringe: DefringeSettings;
}

export interface PersistedCrop {
  readonly enabled: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly aspectPreset: AspectRatioPresetId;
  readonly customAspectWidth: number;
  readonly customAspectHeight: number;
}

export interface PersistedGeometry {
  readonly coordinateFrameRevision: typeof COORDINATE_FRAME_REVISION;
  readonly orientation: UserOrientation;
  readonly manualPerspective: {
    readonly horizontal: number;
    readonly vertical: number;
    readonly matrix: Homography;
  };
  readonly upright: {
    readonly mode: "manual" | "guided" | "automatic";
    readonly enabled: boolean;
    readonly matrix: Homography;
    readonly revision: string;
  };
  readonly constrainCrop: boolean;
  readonly crop: PersistedCrop;
}

export interface PersistedLocalEdits {
  readonly geometryFrame: GeometryFrame;
  readonly masks: readonly LocalMask[];
  readonly maskAssetRefs: readonly DevelopAssetRef[];
}

export interface PostCropEffects {
  readonly vignette: number;
  readonly vignetteMidpoint: number;
  readonly vignetteRoundness: number;
  readonly vignetteFeather: number;
  readonly vignetteHighlights: number;
  readonly grain: number;
  readonly grainSize: number;
  readonly grainRoughness: number;
}

export interface HdrEdits {
  readonly enabled: boolean;
  readonly exposure: number;
  readonly highlights: number;
  readonly whites: number;
  readonly headroomStops: number;
  readonly sdrBrightness: number;
  readonly sdrContrast: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface QuarantinedV3Field {
  readonly path: string;
  readonly value: JsonValue;
}

export interface V3Compatibility {
  readonly mappingRevision: string | null;
  readonly legacyV2: DevelopDocument | null;
  readonly externalFieldIndex: readonly string[];
  readonly quarantine: readonly QuarantinedV3Field[];
}

export interface DevelopDocumentV3 {
  readonly version: typeof DEVELOP_PROCESS_VERSION;
  readonly process: typeof DEVELOP_PROCESS_ID;
  readonly schemaRevision: typeof V3_DOCUMENT_SCHEMA_REVISION;
  readonly tone: {
    readonly basic: BasicToneEdits;
    readonly curves: CurveSettings;
  };
  readonly color: {
    readonly whiteBalance: PersistedWhiteBalance;
    readonly global: GlobalColorEdits;
    readonly inputProfile: PersistedInputProfile;
    readonly pointColor: PointColorSettings;
    readonly mixer: MixerSettings;
    readonly monochrome: MonochromeSettings;
    readonly grading: ColorGradingSettings;
  };
  readonly optics: PersistedOptics;
  readonly geometry: PersistedGeometry;
  readonly local: PersistedLocalEdits;
  readonly cleanup: CleanupLayer;
  readonly presence: PresenceSettings;
  readonly detail: {
    readonly noiseReduction: StandardDenoiseSettings;
    readonly sharpening: DevelopSharpeningSettings;
  };
  readonly effects: { readonly postCrop: PostCropEffects };
  readonly lensBlur: LensBlurSettings;
  readonly hdr: HdrEdits;
  readonly compatibility: V3Compatibility;
}

export type PersistedDevelopDocument = DevelopDocument | DevelopDocumentV3;

export type NewerDevelopDocument = JsonObject & {
  readonly version: number;
};

export type StoredDevelopDocument =
  | PersistedDevelopDocument
  | NewerDevelopDocument;

const LINEAR_CURVE = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

const NEUTRAL_MIXER_BAND = { hue: 0, saturation: 0, luminance: 0 };

export const DEFAULT_V3_DEVELOP_DOCUMENT = {
  version: DEVELOP_PROCESS_VERSION,
  process: DEVELOP_PROCESS_ID,
  schemaRevision: V3_DOCUMENT_SCHEMA_REVISION,
  tone: {
    basic: {
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
    },
    curves: {
      rgb: LINEAR_CURVE.map((point) => ({ ...point })),
      red: LINEAR_CURVE.map((point) => ({ ...point })),
      green: LINEAR_CURVE.map((point) => ({ ...point })),
      blue: LINEAR_CURVE.map((point) => ({ ...point })),
    },
  },
  color: {
    whiteBalance: {
      mode: "current",
      adjustment: { temperature: 0, tint: 0 },
      resolved: {
        temperatureKelvin: 5_500,
        tint: 0,
        gains: [1, 1, 1],
      },
    },
    global: { vibrance: 0, saturation: 0 },
    inputProfile: {
      registryRevision: "none",
      selection: { kind: "decoder-default" },
      calibration: {
        matrixToLinearSrgb: IDENTITY_MATRIX_3,
        channelScale: [1, 1, 1],
        exposureOffsetEv: 0,
      },
    },
    pointColor: { adjustments: [] },
    mixer: {
      red: { ...NEUTRAL_MIXER_BAND },
      orange: { ...NEUTRAL_MIXER_BAND },
      yellow: { ...NEUTRAL_MIXER_BAND },
      green: { ...NEUTRAL_MIXER_BAND },
      aqua: { ...NEUTRAL_MIXER_BAND },
      blue: { ...NEUTRAL_MIXER_BAND },
      purple: { ...NEUTRAL_MIXER_BAND },
      magenta: { ...NEUTRAL_MIXER_BAND },
    },
    monochrome: {
      enabled: false,
      profileId: NEUTRAL_MONOCHROME_PROFILE.id,
      mixer: { ...NEUTRAL_MONOCHROME_PROFILE.channelBias },
    },
    grading: {
      shadows: { hueDegrees: 0, saturation: 0, luminance: 0 },
      midtones: { hueDegrees: 0, saturation: 0, luminance: 0 },
      highlights: { hueDegrees: 0, saturation: 0, luminance: 0 },
      balance: 0,
      blending: 50,
    },
  },
  optics: {
    registryRevision: "none",
    profile: { kind: "off" },
    amounts: {
      distortion: 0,
      illumination: 0,
      lateralChromaticAberration: 0,
    },
    manualDistortion: 0,
    defringe: {
      amount: 0,
      purpleHueDegrees: 300,
      greenHueDegrees: 120,
      hueRangeDegrees: 30,
    },
  },
  geometry: {
    coordinateFrameRevision: COORDINATE_FRAME_REVISION,
    orientation: {
      quarterTurns: 0,
      flipHorizontal: false,
      flipVertical: false,
      fineAngleDegrees: 0,
    },
    manualPerspective: {
      horizontal: 0,
      vertical: 0,
      matrix: IDENTITY_HOMOGRAPHY,
    },
    upright: {
      mode: "manual",
      enabled: false,
      matrix: IDENTITY_HOMOGRAPHY,
      revision: "none",
    },
    constrainCrop: false,
    crop: {
      enabled: false,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      aspectPreset: "original",
      customAspectWidth: 1,
      customAspectHeight: 1,
    },
  },
  local: {
    geometryFrame: "canonical-v3",
    masks: [],
    maskAssetRefs: [],
  },
  cleanup: { components: [] },
  presence: { texture: 0, clarity: 0, dehaze: 0 },
  detail: {
    noiseReduction: {
      noiseReduction: 0,
      noiseDetail: 50,
      noiseContrast: 0,
      colorNoiseReduction: 0,
      colorNoiseDetail: 50,
      colorNoiseSmoothness: 50,
    },
    sharpening: {
      sharpening: 0,
      sharpenRadius: 1,
      sharpenDetail: 25,
      sharpenMasking: 0,
    },
  },
  effects: {
    postCrop: {
      vignette: 0,
      vignetteMidpoint: 50,
      vignetteRoundness: 0,
      vignetteFeather: 50,
      vignetteHighlights: 0,
      grain: 0,
      grainSize: 25,
      grainRoughness: 50,
    },
  },
  lensBlur: DEFAULT_LENS_BLUR_SETTINGS,
  hdr: {
    enabled: false,
    exposure: 0,
    highlights: 0,
    whites: 0,
    headroomStops: 0,
    sdrBrightness: 0,
    sdrContrast: 0,
  },
  compatibility: {
    mappingRevision: null,
    legacyV2: null,
    externalFieldIndex: [],
    quarantine: [],
  },
} satisfies DevelopDocumentV3;

export function createDefaultV3DevelopDocument(): DevelopDocumentV3 {
  return structuredClone(DEFAULT_V3_DEVELOP_DOCUMENT);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical documents require finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  throw new Error("Canonical documents cannot contain this value.");
}

export function canonicalV3DocumentHashInput(document: DevelopDocumentV3): string {
  return stableJson({
    version: document.version,
    process: document.process,
    schemaRevision: document.schemaRevision,
    tone: document.tone,
    color: document.color,
    optics: document.optics,
    geometry: document.geometry,
    local: document.local,
    cleanup: document.cleanup,
    presence: document.presence,
    detail: document.detail,
    effects: document.effects,
    lensBlur: document.lensBlur,
    hdr: document.hdr,
  });
}
