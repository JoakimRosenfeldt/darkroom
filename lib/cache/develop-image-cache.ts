import type { LibraryEntry } from "@/lib/fs/types";
import { isNikonDecoderProvenance } from "@/lib/formats/registry";
import { decodeEntry } from "@/lib/raw/decode";
import type { CameraProfileDecode, PixelProvenance } from "@/lib/raw/types";
import { assetCacheKey } from "./asset-cache-key";

export interface DevelopImage {
  /** Oriented dimensions used by the editor and crop controls. */
  width: number;
  height: number;
  /** Stored pixel dimensions used only for direct texture uploads. */
  sourceWidth: number;
  sourceHeight: number;
  orientation: number;
  metadata: Record<string, unknown>;
  rgb: Uint8Array | Uint16Array | Uint8ClampedArray;
  bits: number;
  colors: number;
  pixelProvenance: PixelProvenance;
  blob?: Blob;
  objectUrl?: string;
}

export interface DevelopImageLoadOptions {
  readonly rawColorMode?: "decoder-rendered" | "libraw-camera-matrix";
  readonly maxEdge?: number;
  readonly signal?: AbortSignal;
  readonly priority?: number;
}

const MAX_DEVELOP_IMAGES = 3;
const PREVIEW_MAX_EDGE = 2_560;

const imageCache = new Map<string, DevelopImage>();
const inFlightImages = new Map<string, Promise<DevelopImage>>();

function toDevelopImage(decoded: Awaited<ReturnType<typeof decodeEntry>>): DevelopImage {
  const orientation = isNikonDecoderProvenance(decoded.metadata.decoderProvenance) &&
    Number.isInteger(decoded.metadata.orientation) &&
    Number(decoded.metadata.orientation) >= 1 &&
    Number(decoded.metadata.orientation) <= 8
    ? Number(decoded.metadata.orientation)
    : 1;
  const rotated = orientation >= 5;

  return {
    width: rotated ? decoded.height : decoded.width,
    height: rotated ? decoded.width : decoded.height,
    sourceWidth: decoded.width,
    sourceHeight: decoded.height,
    orientation,
    metadata: decoded.metadata,
    rgb: decoded.rgb,
    bits: decoded.bits,
    colors: decoded.colors,
    pixelProvenance: decoded.pixelProvenance,
    blob: decoded.blob,
    objectUrl: decoded.objectUrl,
  };
}

function cacheKey(
  entry: LibraryEntry,
  rawColorMode: NonNullable<DevelopImageLoadOptions["rawColorMode"]>,
  maxEdge: number,
): string {
  return assetCacheKey({
    catalogId: entry.catalogId,
    assetId: entry.assetId,
    revision: entry.assetRevision,
  }, entry.formatId === "nef" && rawColorMode === "libraw-camera-matrix"
    ? `develop-libraw-camera-matrix-v1-${maxEdge}`
    : `develop-${maxEdge}`);
}

function cameraProfileDecode(
  entry: LibraryEntry,
  rawColorMode: NonNullable<DevelopImageLoadOptions["rawColorMode"]>,
): CameraProfileDecode {
  return entry.formatId === "nef" && rawColorMode === "libraw-camera-matrix"
    ? { kind: "libraw-camera-matrix" }
    : { kind: "none" };
}

function rememberImage(key: string, image: DevelopImage): void {
  if (imageCache.has(key)) {
    imageCache.delete(key);
  }

  imageCache.set(key, image);

  while (imageCache.size > MAX_DEVELOP_IMAGES) {
    const oldestKey = imageCache.keys().next().value;
    if (!oldestKey) {
      return;
    }

    const oldest = imageCache.get(oldestKey);
    if (oldest?.objectUrl) {
      URL.revokeObjectURL(oldest.objectUrl);
    }
    imageCache.delete(oldestKey);
  }
}

export async function loadDevelopImage(
  entry: LibraryEntry,
  options: DevelopImageLoadOptions = {},
): Promise<DevelopImage> {
  const rawColorMode = options.rawColorMode ?? "decoder-rendered";
  const maxEdge = options.maxEdge ?? PREVIEW_MAX_EDGE;
  const key = cacheKey(entry, rawColorMode, maxEdge);
  const cached = imageCache.get(key);
  if (cached) {
    imageCache.delete(key);
    imageCache.set(key, cached);
    return cached;
  }

  const activeLoad = inFlightImages.get(key);
  if (activeLoad) {
    return activeLoad;
  }

  const load = decodeEntry(entry, {
    thumbnail: true,
    rawSource: "developed",
    maxEdge,
    priority: options.priority,
    cameraProfile: cameraProfileDecode(entry, rawColorMode),
  }).then((decoded) => {
    if (decoded.pixelProvenance.decoderPath === "embedded-preview") {
      if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
      throw new Error("Full RAW decoding failed. Only an embedded JPEG preview is available. Check the Nikon decoder in Support / Formats before editing.");
    }
    const image = toDevelopImage(decoded);
    rememberImage(key, image);
    return image;
  });

  inFlightImages.set(key, load);

  try {
    return await load;
  } finally {
    inFlightImages.delete(key);
  }
}

export async function loadDevelopExportImage(
  entry: LibraryEntry,
  options: DevelopImageLoadOptions = {},
): Promise<DevelopImage> {
  const rawColorMode = options.rawColorMode ?? "decoder-rendered";
  const decoded = await decodeEntry(entry, {
    fullResolution: true,
    sourcePixels: true,
    signal: options.signal,
    cameraProfile: cameraProfileDecode(entry, rawColorMode),
  });
  return toDevelopImage(decoded);
}

/**
 * Load a fresh source decode for local AI inference. This skips the editor
 * cache and requests source pixels without changing thumbnail semantics.
 */
export async function loadDevelopInferenceImage(
  entry: LibraryEntry,
  signal?: AbortSignal,
): Promise<DevelopImage> {
  if (signal?.aborted) {
    throw new Error("AI source loading was cancelled.");
  }
  const decoded = await decodeEntry(entry, {
    fullResolution: true,
    sourcePixels: true,
    signal,
  });
  if (signal?.aborted) {
    throw new Error("AI source loading was cancelled.");
  }
  return toDevelopImage(decoded);
}

export function disposeDevelopImage(image: DevelopImage): void {
  if (image.objectUrl) {
    URL.revokeObjectURL(image.objectUrl);
  }
}

export function preloadDevelopImages(
  entries: LibraryEntry[],
  activeIndex: number,
  options: DevelopImageLoadOptions = {},
): void {
  if (activeIndex < 0) {
    return;
  }

  for (const index of [activeIndex + 1, activeIndex - 1]) {
    const entry = entries[index];
    if (entry) {
      void loadDevelopImage(entry, options).catch(() => {
        // Preloading is best-effort and should not surface UI errors.
      });
    }
  }
}
