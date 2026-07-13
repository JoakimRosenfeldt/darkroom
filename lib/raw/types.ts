export interface DecodeOptions {
  relativePath?: string;
  thumbnail?: boolean;
  rawSource?: "embedded" | "developed";
  fullResolution?: boolean;
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

export interface ImageProfile {
  id: string;
  extensions: string[];
  detect(file: Pick<{ name: string }, "name">): boolean;
  decode(
    input: Uint8Array,
    options?: DecodeOptions,
  ): Promise<DecodedImage>;
}
