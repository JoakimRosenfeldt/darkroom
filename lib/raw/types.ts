import type { FileRef } from "@/lib/fs/types";

export interface DecodeOptions {
  thumbnail?: boolean;
  maxEdge?: number;
}

export interface DecodedImage {
  width: number;
  height: number;
  rgb: Uint8Array | Uint16Array | Uint8ClampedArray;
  bits: number;
  colors: number;
  metadata: Record<string, unknown>;
  blob: Blob;
  objectUrl: string;
}

export interface ImageProfile {
  id: string;
  extensions: string[];
  detect(file: Pick<FileRef, "name">): boolean;
  decode(
    input: Uint8Array,
    options?: DecodeOptions,
  ): Promise<DecodedImage>;
}
