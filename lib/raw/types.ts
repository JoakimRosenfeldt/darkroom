import type { CatalogAssetRequest } from "../catalog/api";

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
}

export interface DecodedImage {
  width: number;
  height: number;
  rgb: Uint8Array | Uint16Array | Uint8ClampedArray;
  bits: number;
  colors: number;
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
