export type DecoderProfileId = "standard" | "nef";

export type FormatFamily = "standard" | "raw" | "other";

export type FormatRecognition = "supported" | "recognized-unsupported";

export type CapabilityStatus = "supported" | "unavailable" | "unverified";

export type FormatBackend =
  | "standard"
  | "libraw"
  | "embedded-preview"
  | "nikon-native"
  | "none";

export interface SignatureRule {
  readonly offset: number;
  readonly bytes: readonly number[];
}

export interface CapabilityRoute {
  readonly status: CapabilityStatus;
  readonly backend: FormatBackend;
  readonly fallbackBackend?: FormatBackend;
  readonly reason: string | null;
}

export type FormatId =
  | "nef"
  | "jpeg"
  | "png"
  | "webp"
  | "dng"
  | "cr2"
  | "cr3"
  | "arw"
  | "raf"
  | "orf"
  | "rw2"
  | "heif"
  | "tiff"
  | "psd"
  | "jxl"
  | "video";

export interface FormatCapability {
  readonly kind: "format";
  readonly id: FormatId;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly signatures: readonly SignatureRule[];
  readonly family: FormatFamily;
  readonly profileId: DecoderProfileId | null;
  readonly recognition: FormatRecognition;
  readonly recognitionReason: string | null;
  readonly preview: CapabilityRoute;
  readonly develop: CapabilityRoute;
  readonly metadata: CapabilityRoute;
  readonly exportFormats: readonly string[];
  readonly issueIds: readonly number[];
}

export type CapabilityOperationId =
  | "copy-as-dng"
  | "original-raw-export"
  | "video-import"
  | "video-playback"
  | "video-transforms"
  | "video-export";

export interface OperationCapability {
  readonly kind: "operation";
  readonly id: CapabilityOperationId;
  readonly label: string;
  readonly status: CapabilityStatus;
  readonly reason: string;
  readonly issueId: number;
}

export interface CameraSupportRow {
  readonly vendor: string;
  readonly model: string;
  readonly extension: string;
  readonly compression: string;
  readonly bitDepth: number | null;
  readonly backend: "libraw" | "nikon-native" | "embedded-preview";
  readonly status: "supported" | "fallback" | "unsupported" | "unverified";
  readonly colorStatus: string;
  readonly sampleChecksum: string | null;
}

export type NikonDecoderKind = "native" | "test-only";
export type NikonDecoderProvenance = "nikon-sdk" | "nikon-test-only";
export type NikonRuntimeBackend = "nikon-sdk" | "darkroom-test-mock";
export type NikonPixelProtocol = "rgb16le-v1";
export type NikonRuntimePackageState = "packaged" | "development" | "test-only" | "unavailable";

export interface NikonRuntimeCapability {
  readonly status: "available" | "unavailable" | "misconfigured" | "test-only";
  readonly kind: NikonDecoderKind | "none";
  readonly packageState: NikonRuntimePackageState;
  readonly version: string | null;
  readonly architecture: string | null;
  readonly checksum: string | null;
  readonly backend: NikonRuntimeBackend | null;
  readonly pixelProtocol: NikonPixelProtocol | null;
  readonly reason: string;
}

export interface FormatCapabilityReport {
  readonly version: 1;
  readonly appVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly formats: readonly FormatCapability[];
  readonly operations: readonly OperationCapability[];
  readonly cameraRows: readonly CameraSupportRow[];
  readonly nikon: NikonRuntimeCapability;
}
