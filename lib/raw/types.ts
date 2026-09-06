import type { CatalogAssetRequest } from "../catalog/api";
import type { MatrixCameraProfile } from "../camera-profiles/matrix";

export type CameraProfileDecode =
  | { readonly kind: "none" }
  | { readonly kind: "libraw-camera-matrix" };

interface UnprofiledPixelProvenance {
  readonly decoderPath:
    | "libraw"
    | "nikon-sdk"
    | "nikon-test-only"
    | "embedded-preview"
    | "processed-standard";
  readonly decoderRevision: string;
  readonly colorSpace: "camera-rgb" | "srgb" | "unknown";
  readonly transfer: "linear" | "encoded" | "unknown";
  readonly bitDepth: number | null;
  readonly cameraProfileStage: {
    readonly kind: "unavailable";
    readonly reason: string;
  };
}

interface ProfiledLibRawPixelProvenance {
  readonly decoderPath: "libraw";
  readonly decoderRevision: string;
  readonly colorSpace: "camera-rgb";
  readonly transfer: "linear";
  readonly bitDepth: 16;
  readonly cameraProfileStage: {
    readonly kind: "available";
    readonly stage: "before-develop-tone";
    readonly profile: MatrixCameraProfile;
    readonly camera: {
      readonly make: string;
      readonly model: string;
    };
  };
}

export type PixelProvenance =
  | UnprofiledPixelProvenance
  | ProfiledLibRawPixelProvenance;

export interface DecodeOptions {
  relativePath?: string;
  assetRequest?: CatalogAssetRequest;
  thumbnail?: boolean;
  rawSource?: "embedded" | "developed";
  fullResolution?: boolean;
  /** Decode the original image into pixels without changing thumbnail output. */
  sourcePixels?: boolean;
  maxEdge?: number;
  priority?: number;
  signal?: AbortSignal;
  cameraProfile?: CameraProfileDecode;
}

export interface DecodedImage {
  width: number;
  height: number;
  rgb: Uint8Array | Uint16Array | Uint8ClampedArray;
  bits: number;
  colors: number;
  pixelProvenance: PixelProvenance;
  metadata: Record<string, unknown>;
  blob?: Blob;
  objectUrl?: string;
}

import type { DecoderProfileId } from "../formats/types";

export interface ImageProfile {
  id: DecoderProfileId;
  extensions: readonly string[];
  detect(file: Pick<{ name: string }, "name">): boolean;
  decode(
    input: Uint8Array,
    options?: DecodeOptions,
  ): Promise<DecodedImage>;
}
