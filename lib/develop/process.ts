import type { SourceSignature } from "./types";
import type { MatrixCameraProfile } from "../camera-profiles/matrix";

export const FROZEN_DEVELOP_PROCESS_VERSION = 2;
export const DEVELOP_PROCESS_VERSION = 3;
export const DEVELOP_PROCESS_ID = "darkroom-v3";

export type DevelopProcessVersion =
  | typeof FROZEN_DEVELOP_PROCESS_VERSION
  | typeof DEVELOP_PROCESS_VERSION;

export function isDevelopProcessVersion(
  value: unknown,
): value is DevelopProcessVersion {
  return value === FROZEN_DEVELOP_PROCESS_VERSION ||
    value === DEVELOP_PROCESS_VERSION;
}

export type V3SourceSignature = Readonly<Required<SourceSignature>>;

export interface PixelDimensions {
  readonly width: number;
  readonly height: number;
}

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type PixelPrecision =
  | {
      readonly kind: "integer";
      readonly componentBits: 8;
      readonly storageBits: 8;
    }
  | {
      readonly kind: "integer";
      readonly componentBits: 10 | 12 | 14 | 16;
      readonly storageBits: 16;
    }
  | {
      readonly kind: "float";
      readonly componentBits: 16;
      readonly storageBits: 16;
    }
  | {
      readonly kind: "float";
      readonly componentBits: 32;
      readonly storageBits: 32;
    };

export type TransferFunction =
  | { readonly kind: "linear" }
  | { readonly kind: "srgb" }
  | { readonly kind: "gamma"; readonly exponent: number }
  | { readonly kind: "pq" }
  | { readonly kind: "hlg" }
  | { readonly kind: "unknown"; readonly label: string };

export interface ColorProfileReference {
  readonly id: string;
  readonly revision: string;
  readonly source: "embedded" | "decoder" | "registry" | "user";
}

export type SourceColorEncoding =
  | {
      readonly kind: "profiled";
      readonly profile: ColorProfileReference;
      readonly transfer: TransferFunction;
    }
  | {
      readonly kind: "decoder-provided";
      readonly decoderColorSpace: string;
      readonly transfer: TransferFunction;
    }
  | {
      readonly kind: "uncharacterized";
      readonly reason: string;
    };

export type WorkingColorSpace =
  | {
      readonly kind: "decoder-provided";
      readonly encoding: Extract<
        SourceColorEncoding,
        { readonly kind: "decoder-provided" }
      >;
    }
  | {
      readonly kind: "verified-profile-transform";
      readonly profile: ColorProfileReference;
      readonly transfer: { readonly kind: "linear" };
    };

export type DecoderProvenance =
  | {
      readonly kind: "full-source";
      readonly decoderId: string;
      readonly decoderRevision: string;
    }
  | {
      readonly kind: "reduced-source";
      readonly decoderId: string;
      readonly decoderRevision: string;
      readonly sourceDimensions: PixelDimensions;
    }
  | {
      readonly kind: "embedded-preview";
      readonly decoderId: string;
      readonly previewDimensions: PixelDimensions;
    };

export type InputProfileState =
  | {
      readonly kind: "available";
      readonly profile: ColorProfileReference;
      readonly stage: "before-develop-tone";
      readonly transform: MatrixCameraProfile;
    }
  | {
      readonly kind: "decoder-default";
      readonly decoderId: string;
      readonly decoderColorSpace: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
    };

export type AsShotWhiteBalance =
  | {
      readonly kind: "available";
      readonly source: "metadata" | "decoder";
      readonly multipliers: readonly [number, number, number];
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
    };

export type CameraMetadata =
  | {
      readonly kind: "available";
      readonly make: string;
      readonly model: string;
      readonly serialNumber?: string;
    }
  | { readonly kind: "unavailable" };

export type LensMetadata =
  | {
      readonly kind: "available";
      readonly make?: string;
      readonly model: string;
      readonly identifier?: string;
    }
  | { readonly kind: "unavailable" };

export interface SourceRecord {
  readonly version: 1;
  readonly signature: V3SourceSignature;
  readonly dimensions: PixelDimensions;
  readonly orientation: ExifOrientation;
  readonly decoder: DecoderProvenance;
  readonly precision: PixelPrecision;
  readonly color: SourceColorEncoding;
  readonly inputProfile: InputProfileState;
  readonly asShotWhiteBalance: AsShotWhiteBalance;
  readonly camera: CameraMetadata;
  readonly lens: LensMetadata;
}

export const COORDINATE_FRAME_REVISION =
  "oriented-source-normalized-bottom-left-v1";

export interface CoordinateFrameDefinition {
  readonly revision: typeof COORDINATE_FRAME_REVISION;
  readonly space: "exif-oriented-source";
  readonly units: "normalized";
  readonly origin: "bottom-left";
  readonly xAxis: "right";
  readonly yAxis: "up";
  readonly storedBefore: readonly [
    "optics",
    "user-orientation-and-transform",
    "crop",
  ];
}

export const V3_COORDINATE_FRAME = {
  revision: COORDINATE_FRAME_REVISION,
  space: "exif-oriented-source",
  units: "normalized",
  origin: "bottom-left",
  xAxis: "right",
  yAxis: "up",
  storedBefore: ["optics", "user-orientation-and-transform", "crop"],
} as const satisfies CoordinateFrameDefinition;

export const SEMANTIC_STAGE_IDS = [
  "decode-and-orientation",
  "wb-and-input-profile",
  "optics",
  "standard-denoise",
  "canonical-geometry",
  "source-repair",
  "basic-tone",
  "curve-and-color",
  "local-adjustments",
  "presence",
  "creative-spatial-effect",
  "develop-sharpening",
  "post-crop-effects",
  "resize-and-tile-assembly",
  "output-or-proof-transform",
  "analysis-overlays-and-encode",
] as const satisfies readonly string[];

export type SemanticStageId = (typeof SEMANTIC_STAGE_IDS)[number];

export type SemanticStageOwner =
  | "SourceProvider"
  | "V3ColorKernel"
  | "V3OpticsKernel"
  | "V3DetailKernel"
  | "V3CoordinateModel"
  | "V3RepairKernel"
  | "V3LocalAdjustmentKernel"
  | "V3SpatialEffectKernel"
  | "V3RenderBackend"
  | "V3OutputTransform"
  | "V3AnalysisEncoder";

export interface SemanticStageDefinition {
  readonly order: number;
  readonly id: SemanticStageId;
  readonly label: string;
  readonly owner: SemanticStageOwner;
  readonly dependsOn: readonly SemanticStageId[];
}

export const SEMANTIC_STAGE_REGISTRY_VERSION =
  "darkroom-v3-semantic-stages-1";

export const V3_SEMANTIC_STAGES = [
  {
    order: 1,
    id: "decode-and-orientation",
    label: "Decode and orientation",
    owner: "SourceProvider",
    dependsOn: [],
  },
  {
    order: 2,
    id: "wb-and-input-profile",
    label: "WB and input profile",
    owner: "V3ColorKernel",
    dependsOn: ["decode-and-orientation"],
  },
  {
    order: 3,
    id: "optics",
    label: "Optics",
    owner: "V3OpticsKernel",
    dependsOn: ["wb-and-input-profile"],
  },
  {
    order: 4,
    id: "standard-denoise",
    label: "Standard denoise",
    owner: "V3DetailKernel",
    dependsOn: ["optics"],
  },
  {
    order: 5,
    id: "canonical-geometry",
    label: "Canonical geometry",
    owner: "V3CoordinateModel",
    dependsOn: ["standard-denoise"],
  },
  {
    order: 6,
    id: "source-repair",
    label: "Source repair",
    owner: "V3RepairKernel",
    dependsOn: ["canonical-geometry"],
  },
  {
    order: 7,
    id: "basic-tone",
    label: "Basic tone",
    owner: "V3ColorKernel",
    dependsOn: ["source-repair"],
  },
  {
    order: 8,
    id: "curve-and-color",
    label: "Curve and color",
    owner: "V3ColorKernel",
    dependsOn: ["basic-tone"],
  },
  {
    order: 9,
    id: "local-adjustments",
    label: "Local adjustments",
    owner: "V3LocalAdjustmentKernel",
    dependsOn: ["curve-and-color"],
  },
  {
    order: 10,
    id: "presence",
    label: "Presence",
    owner: "V3ColorKernel",
    dependsOn: ["local-adjustments"],
  },
  {
    order: 11,
    id: "creative-spatial-effect",
    label: "Creative spatial effect",
    owner: "V3SpatialEffectKernel",
    dependsOn: ["presence"],
  },
  {
    order: 12,
    id: "develop-sharpening",
    label: "Develop sharpening",
    owner: "V3DetailKernel",
    dependsOn: ["creative-spatial-effect"],
  },
  {
    order: 13,
    id: "post-crop-effects",
    label: "Post-crop effects",
    owner: "V3ColorKernel",
    dependsOn: ["develop-sharpening"],
  },
  {
    order: 14,
    id: "resize-and-tile-assembly",
    label: "Resize and tile assembly",
    owner: "V3RenderBackend",
    dependsOn: ["post-crop-effects"],
  },
  {
    order: 15,
    id: "output-or-proof-transform",
    label: "Output or proof transform",
    owner: "V3OutputTransform",
    dependsOn: ["resize-and-tile-assembly"],
  },
  {
    order: 16,
    id: "analysis-overlays-and-encode",
    label: "Analysis, overlays, and encode",
    owner: "V3AnalysisEncoder",
    dependsOn: ["output-or-proof-transform"],
  },
] as const satisfies readonly SemanticStageDefinition[];

export const ANALYSIS_TAP_IDS = [
  "tone-input",
  "wb-sample",
  "display-output",
  "scene-headroom",
  "proof-output",
] as const satisfies readonly string[];

export type AnalysisTapId = (typeof ANALYSIS_TAP_IDS)[number];

export interface AnalysisTapDefinition {
  readonly id: AnalysisTapId;
  readonly owner: SemanticStageOwner;
  readonly readsFrom: readonly SemanticStageId[];
  readonly availability: "required" | "proof-only";
  readonly content: string;
}

export const V3_ANALYSIS_TAPS = [
  {
    id: "tone-input",
    owner: "V3RepairKernel",
    readsFrom: ["source-repair"],
    availability: "required",
    content:
      "Full-frame source-repair output before tone, color, local, presence, spatial, sharpening, and post-crop stages.",
  },
  {
    id: "wb-sample",
    owner: "V3CoordinateModel",
    readsFrom: ["wb-and-input-profile", "canonical-geometry"],
    availability: "required",
    content: "Source-linear values addressed through the canonical coordinate map.",
  },
  {
    id: "display-output",
    owner: "V3OutputTransform",
    readsFrom: ["output-or-proof-transform"],
    availability: "required",
    content: "Display-transformed full-frame values before transient overlays.",
  },
  {
    id: "scene-headroom",
    owner: "V3RenderBackend",
    readsFrom: ["resize-and-tile-assembly"],
    availability: "required",
    content: "Scene-linear values before the SDR display transform.",
  },
  {
    id: "proof-output",
    owner: "V3OutputTransform",
    readsFrom: ["output-or-proof-transform"],
    availability: "proof-only",
    content: "Proof-transformed values and the matching out-of-gamut mask.",
  },
] as const satisfies readonly AnalysisTapDefinition[];

export type DevelopStateClass =
  | "library-result"
  | "source-record"
  | "semantic-edits"
  | "unknown-external-metadata"
  | "undo-history"
  | "derived-assets"
  | "generated-jobs"
  | "view-state"
  | "export-intent"
  | "cache";

export type DevelopStateOwner =
  | "LibraryResultRepository"
  | "SourceProvider"
  | "DevelopRepository"
  | "XmpAdapter"
  | "DevelopSession"
  | "DevelopAssetStore"
  | "GeneratedJobRunner"
  | "DevelopViewAdapter"
  | "ExportRequest"
  | "CacheService";

export type PersistencePolicy =
  | "bounded-electron-app-data"
  | "catalog-derived"
  | "catalog-and-xmp"
  | "original-xmp-dom"
  | "memory-and-recovery-journal"
  | "content-addressed-electron-app-data"
  | "runtime-until-accepted"
  | "local-workspace-preferences"
  | "local-export-preferences"
  | "disposable";

export interface DevelopStateOwnership {
  readonly state: DevelopStateClass;
  readonly owner: DevelopStateOwner;
  readonly persistence: PersistencePolicy;
}

export const V3_STATE_OWNERSHIP = [
  {
    state: "library-result",
    owner: "LibraryResultRepository",
    persistence: "bounded-electron-app-data",
  },
  {
    state: "source-record",
    owner: "SourceProvider",
    persistence: "catalog-derived",
  },
  {
    state: "semantic-edits",
    owner: "DevelopRepository",
    persistence: "catalog-and-xmp",
  },
  {
    state: "unknown-external-metadata",
    owner: "XmpAdapter",
    persistence: "original-xmp-dom",
  },
  {
    state: "undo-history",
    owner: "DevelopSession",
    persistence: "memory-and-recovery-journal",
  },
  {
    state: "derived-assets",
    owner: "DevelopAssetStore",
    persistence: "content-addressed-electron-app-data",
  },
  {
    state: "generated-jobs",
    owner: "GeneratedJobRunner",
    persistence: "runtime-until-accepted",
  },
  {
    state: "view-state",
    owner: "DevelopViewAdapter",
    persistence: "local-workspace-preferences",
  },
  {
    state: "export-intent",
    owner: "ExportRequest",
    persistence: "local-export-preferences",
  },
  { state: "cache", owner: "CacheService", persistence: "disposable" },
] as const satisfies readonly DevelopStateOwnership[];

export const DEVELOP_CAPABILITY_IDS = [
  "nikon-rgb16-source",
  "libraw-high-bit-decode",
  "standard-image-high-bit-decode",
  "high-bit-intermediate-render",
  "high-bit-readback",
  "typed-high-bit-export",
  "input-profile-transform",
  "camera-profile-dataset",
  "lens-profile-dataset",
  "proof-transform",
  "hdr-display",
  "hdr-output-encode",
  "subject-model",
  "sky-model",
  "people-removal-model",
  "reflection-removal-model",
  "dust-removal-model",
  "depth-model",
] as const satisfies readonly string[];

export type DevelopCapabilityId = (typeof DEVELOP_CAPABILITY_IDS)[number];

export type CapabilityFallback =
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "sdr-rgba8"; readonly reason: string }
  | { readonly kind: "decoder-provided-color"; readonly reason: string }
  | { readonly kind: "neutral-optics"; readonly reason: string }
  | { readonly kind: "manual-cleanup"; readonly reason: string };

export type CapabilityDecision =
  | {
      readonly kind: "available";
      readonly evidence: readonly [string, ...string[]];
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly fallback: CapabilityFallback;
    }
  | {
      readonly kind: "unverified";
      readonly missingEvidence: string;
      readonly fallback: CapabilityFallback;
    };

export type CapabilityTier =
  | {
      readonly kind: "sdr-rgba8";
      readonly id: "baseline-sdr-rgba8";
    }
  | {
      readonly kind: "high-bit-sdr";
      readonly id: `high-bit-sdr:${string}`;
      readonly evidence: readonly [string, ...string[]];
    }
  | {
      readonly kind: "hdr";
      readonly id: `hdr:${string}`;
      readonly evidence: readonly [string, ...string[]];
    };

export interface DevelopCapabilityReport {
  readonly revision: string;
  readonly tier: CapabilityTier;
  readonly capabilities: Readonly<
    Record<DevelopCapabilityId, CapabilityDecision>
  >;
}

export function capabilityIsAvailable(
  decision: CapabilityDecision,
): boolean {
  switch (decision.kind) {
    case "available":
      return true;
    case "unavailable":
    case "unverified":
      return false;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

export const BASELINE_CAPABILITY_REPORT = {
  revision: "1a48819-step-0",
  tier: { kind: "sdr-rgba8", id: "baseline-sdr-rgba8" },
  capabilities: {
    "nikon-rgb16-source": {
      kind: "available",
      evidence: [
        "The qualified native Nikon decoder returns rgb16le source pixels.",
        "The renderer accepts the Uint16Array source through its RGB16UI upload path.",
      ],
    },
    "libraw-high-bit-decode": {
      kind: "available",
      evidence: [
        "The named LibRaw camera-profile path requests 16-bit linear camera RGB.",
        "Default thumbnails and non-Develop decodes keep their existing rendered output.",
      ],
    },
    "standard-image-high-bit-decode": {
      kind: "unavailable",
      reason: "The browser canvas decoder returns RGBA8 pixels.",
      fallback: { kind: "sdr-rgba8", reason: "Use the current browser-decoded RGBA8 result." },
    },
    "high-bit-intermediate-render": {
      kind: "unverified",
      missingEvidence: "No RGBA16F intermediate render probe has passed.",
      fallback: { kind: "sdr-rgba8", reason: "Keep the frozen RGBA8 render path." },
    },
    "high-bit-readback": {
      kind: "unavailable",
      reason: "The current WebGL readback requests UNSIGNED_BYTE RGBA pixels.",
      fallback: { kind: "sdr-rgba8", reason: "Read RGBA8 output only." },
    },
    "typed-high-bit-export": {
      kind: "unavailable",
      reason: "The current Sharp boundary validates exactly four bytes per pixel.",
      fallback: { kind: "block", reason: "Block high-bit output requests." },
    },
    "input-profile-transform": {
      kind: "available",
      evidence: [
        "The CPU pointwise stage applies the validated matrix before basic tone.",
        "The RGB16 LibRaw path uses the CPU renderer because high-bit GPU source upload is unavailable.",
        "Only provenance that names the before-develop-tone stage can supply the matrix.",
      ],
    },
    "camera-profile-dataset": {
      kind: "available",
      evidence: [
        "The app-owned camera profile registry accepts only bounded matrix DCP and Darkroom profile-XMP files.",
        "Imported transforms are validated before their calibration is stored in a Develop document.",
      ],
    },
    "lens-profile-dataset": {
      kind: "unavailable",
      reason: "No licensed lens profile dataset is present.",
      fallback: {
        kind: "neutral-optics",
        reason: "Keep automatic optics neutral and expose manual controls.",
      },
    },
    "proof-transform": {
      kind: "unverified",
      missingEvidence: "No proof transform or gamut fixture has passed.",
      fallback: { kind: "block", reason: "Disable proof and gamut claims." },
    },
    "hdr-display": {
      kind: "unverified",
      missingEvidence: "No Electron HDR display probe has passed.",
      fallback: { kind: "sdr-rgba8", reason: "Use an explicit SDR preview transform." },
    },
    "hdr-output-encode": {
      kind: "unverified",
      missingEvidence: "No encoder HDR metadata and transfer probe has passed.",
      fallback: { kind: "block", reason: "Block HDR output requests." },
    },
    "subject-model": {
      kind: "available",
      evidence: ["The local subject model has a pinned revision and verified artifact checksum."],
    },
    "sky-model": {
      kind: "available",
      evidence: ["The local sky model has a pinned revision and verified artifact checksum."],
    },
    "people-removal-model": {
      kind: "unavailable",
      reason: "No licensed local people-removal model is present.",
      fallback: { kind: "manual-cleanup", reason: "Offer manual cleanup only." },
    },
    "reflection-removal-model": {
      kind: "unavailable",
      reason: "No licensed local reflection-removal model is present.",
      fallback: { kind: "manual-cleanup", reason: "Offer manual cleanup only." },
    },
    "dust-removal-model": {
      kind: "unavailable",
      reason: "No licensed local dust-removal model is present.",
      fallback: { kind: "manual-cleanup", reason: "Offer manual cleanup only." },
    },
    "depth-model": {
      kind: "unavailable",
      reason: "No licensed local depth model is present.",
      fallback: { kind: "block", reason: "Do not claim generated depth or Lens Blur." },
    },
  },
} as const satisfies DevelopCapabilityReport;

export type DevelopDiagnostic =
  | {
      readonly kind: "embedded-preview-source";
      readonly category: "source";
      readonly dimensions: PixelDimensions;
    }
  | {
      readonly kind: "reduced-source";
      readonly category: "source";
      readonly dimensions: PixelDimensions;
    }
  | {
      readonly kind: "rgba8-render-fallback";
      readonly category: "precision";
      readonly capabilityTier: string;
    }
  | {
      readonly kind: "input-profile-unavailable";
      readonly category: "color";
      readonly reason: string;
    }
  | {
      readonly kind: "lens-profile-unavailable";
      readonly category: "optics";
      readonly reason: string;
    }
  | {
      readonly kind: "proof-transform-unavailable";
      readonly category: "proof";
      readonly profileId: string;
    }
  | {
      readonly kind: "missing-edit-asset";
      readonly category: "asset";
      readonly assetId: string;
      readonly componentId: string;
    }
  | {
      readonly kind: "stale-generated-result";
      readonly category: "generated-work";
      readonly jobId: string;
      readonly changedInputs: readonly [string, ...string[]];
    }
  | {
      readonly kind: "sdr-display-transform";
      readonly category: "display";
      readonly retainedTap: "scene-headroom";
    }
  | {
      readonly kind: "high-bit-output-blocked";
      readonly category: "output";
      readonly requestedBits: 10 | 12 | 16 | 32;
    }
  | {
      readonly kind: "hdr-output-blocked";
      readonly category: "output";
      readonly requestedTransfer: "pq" | "hlg";
    }
  | {
      readonly kind: "newer-process-read-only";
      readonly category: "compatibility";
      readonly foundVersion: number;
      readonly latestWritableVersion: typeof DEVELOP_PROCESS_VERSION;
    };
