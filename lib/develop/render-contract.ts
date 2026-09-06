import type { ExportFormatId } from "../export/types.ts";
import type { SourceSignature } from "./types.ts";
import {
  COORDINATE_FRAME_REVISION,
  DEVELOP_PROCESS_VERSION,
  FROZEN_DEVELOP_PROCESS_VERSION,
  SEMANTIC_STAGE_REGISTRY_VERSION,
  type AnalysisTapId,
  type CapabilityTier,
  type ColorProfileReference,
  type DevelopDiagnostic,
  type PixelDimensions,
  type SemanticStageId,
  type V3SourceSignature,
} from "./process.ts";

export type Sha256Digest = string & {
  readonly __brand: "Sha256Digest";
};

export function parseSha256Digest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Expected a lowercase SHA-256 digest.");
  }
  return value as Sha256Digest;
}

export interface NormalizedCoordinate {
  readonly x: number;
  readonly y: number;
}

export type PreviewQualityRequest =
  | {
      readonly kind: "grid";
      readonly outputDimensions: PixelDimensions;
      readonly sourceMaxEdge: number;
      readonly devicePixelRatio: number;
    }
  | {
      readonly kind: "fit";
      readonly outputDimensions: PixelDimensions;
      readonly viewportDimensions: PixelDimensions;
      readonly devicePixelRatio: number;
    }
  | {
      readonly kind: "loupe";
      readonly outputDimensions: PixelDimensions;
      readonly viewportDimensions: PixelDimensions;
      readonly sourceCenter: NormalizedCoordinate;
      readonly zoom: number;
      readonly devicePixelRatio: number;
    };

export type EncoderQuality =
  | { readonly kind: "lossless" }
  | { readonly kind: "lossy"; readonly value: number };

export interface ExportQualityRequest {
  readonly kind: "export";
  readonly outputDimensions: PixelDimensions;
  readonly tileDimensions: PixelDimensions;
  readonly tileOverlap: number;
  readonly encoderQuality: EncoderQuality;
}

export type RenderQualityRequest =
  | PreviewQualityRequest
  | ExportQualityRequest;

export type RenderingIntent =
  | "perceptual"
  | "relative-colorimetric"
  | "absolute-colorimetric"
  | "saturation";

export type ProofViewIntent =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly profile: ColorProfileReference;
      readonly renderingIntent: RenderingIntent;
      readonly blackPointCompensation: boolean;
      readonly gamutWarning: "hidden" | "visible";
    };

export interface PreviewOutputIntent {
  readonly kind: "preview-sdr";
  readonly displayProfile: ColorProfileReference;
  readonly transfer: "srgb";
  readonly proofView: ProofViewIntent;
}

export interface SdrExportOutputIntent {
  readonly kind: "export-sdr";
  readonly format: ExportFormatId;
  readonly bitDepth: 8 | 16;
  readonly outputProfile: ColorProfileReference;
  readonly transfer: "srgb" | "gamma";
  readonly renderingIntent: RenderingIntent;
}

export type UnsupportedHdrBehavior =
  | { readonly kind: "block" }
  | {
      readonly kind: "convert-to-sdr";
      readonly fallback: SdrExportOutputIntent;
    };

export interface HdrExportOutputIntent {
  readonly kind: "export-hdr";
  readonly format: ExportFormatId;
  readonly bitDepth: 10 | 12 | 16;
  readonly outputProfile: ColorProfileReference;
  readonly transfer: "pq" | "hlg";
  readonly renderingIntent: RenderingIntent;
  readonly unsupported: UnsupportedHdrBehavior;
}

export type ExportOutputIntent =
  | SdrExportOutputIntent
  | HdrExportOutputIntent;

export type RenderOutputIntent = PreviewOutputIntent | ExportOutputIntent;

export type AcceptedAssetKind =
  | "mask-matte"
  | "repair-patch"
  | "depth-map";

export interface AcceptedAssetRevision {
  readonly assetId: string;
  readonly kind: AcceptedAssetKind;
  readonly sha256: Sha256Digest;
  readonly producerRevision: string;
  readonly coordinateFrameRevision: typeof COORDINATE_FRAME_REVISION;
  readonly colorStageId: SemanticStageId;
}

type CapabilityTierIdentityOf<
  Tier extends { readonly kind: string; readonly id: string },
> = Tier extends unknown ? Pick<Tier, "kind" | "id"> : never;

export type CapabilityTierIdentity = CapabilityTierIdentityOf<CapabilityTier>;

export type RenderBackendIdentity =
  | {
      readonly kind: "frozen-v2";
      readonly revision: string;
    }
  | {
      readonly kind: "v3";
      readonly id: string;
      readonly revision: string;
    };

interface RenderPlanIdentityBase {
  readonly canonicalDocumentHash: Sha256Digest;
  readonly acceptedAssetRevisions: readonly AcceptedAssetRevision[];
  readonly compilerVersion: string;
  readonly stageRegistryVersion: typeof SEMANTIC_STAGE_REGISTRY_VERSION;
  readonly coordinateFrameRevision: typeof COORDINATE_FRAME_REVISION;
  readonly capabilityTier: CapabilityTierIdentity;
}

type V2RenderPlanProcessIdentity = {
  readonly processVersion: typeof FROZEN_DEVELOP_PROCESS_VERSION;
  readonly sourceSignature: Readonly<SourceSignature>;
  readonly backend: Extract<RenderBackendIdentity, { readonly kind: "frozen-v2" }>;
};

type V3RenderPlanProcessIdentity = {
  readonly processVersion: typeof DEVELOP_PROCESS_VERSION;
  readonly sourceSignature: V3SourceSignature;
  readonly backend: Extract<RenderBackendIdentity, { readonly kind: "v3" }>;
};

export type RenderPlanProcessIdentity =
  | V2RenderPlanProcessIdentity
  | V3RenderPlanProcessIdentity;

export type PreviewRenderPlanIdentityInputs = RenderPlanIdentityBase &
  RenderPlanProcessIdentity & {
    readonly qualityAndDimensions: PreviewQualityRequest;
    readonly colorIntent: PreviewOutputIntent;
  };

export type ExportRenderPlanIdentityInputs = RenderPlanIdentityBase &
  RenderPlanProcessIdentity & {
    readonly qualityAndDimensions: ExportQualityRequest;
    readonly colorIntent: ExportOutputIntent;
  };

export type RenderPlanIdentityInputs =
  | PreviewRenderPlanIdentityInputs
  | ExportRenderPlanIdentityInputs;

export interface RenderRequest {
  readonly plan: RenderPlanIdentityInputs;
  readonly requestedTaps: readonly AnalysisTapId[];
}

export type RenderedPixelBuffer =
  | {
      readonly kind: "rgba8";
      readonly pixels: Uint8Array;
    }
  | {
      readonly kind: "rgba16";
      readonly pixels: Uint16Array;
    }
  | {
      readonly kind: "rgba16f";
      readonly pixels: Uint16Array;
    }
  | {
      readonly kind: "rgba32f";
      readonly pixels: Float32Array;
    };

export type BlockingDevelopDiagnostic = Extract<
  DevelopDiagnostic,
  {
    readonly kind:
      | "input-profile-unavailable"
      | "proof-transform-unavailable"
      | "missing-edit-asset"
      | "high-bit-output-blocked"
      | "hdr-output-blocked"
      | "newer-process-read-only";
  }
>;

export type RenderResult =
  | {
      readonly kind: "rendered";
      readonly planFingerprint: Sha256Digest;
      readonly dimensions: PixelDimensions;
      readonly pixels: RenderedPixelBuffer;
      readonly diagnostics: readonly DevelopDiagnostic[];
    }
  | {
      readonly kind: "blocked";
      readonly diagnostics: readonly [
        BlockingDevelopDiagnostic,
        ...BlockingDevelopDiagnostic[],
      ];
    }
  | { readonly kind: "cancelled" };
