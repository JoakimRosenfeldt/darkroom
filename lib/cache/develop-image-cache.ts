import type { LibraryEntry } from "@/lib/fs/types";
import { decodeEntry } from "@/lib/raw/decode";

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
  blob?: Blob;
  objectUrl?: string;
}

const MAX_DEVELOP_IMAGES = 3;
const PREVIEW_MAX_EDGE = 2_560;

const imageCache = new Map<string, DevelopImage>();
const inFlightImages = new Map<string, Promise<DevelopImage>>();

function toDevelopImage(decoded: Awaited<ReturnType<typeof decodeEntry>>): DevelopImage {
  const orientation = decoded.metadata.decoderProvenance === "nikon-sdk" &&
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
    blob: decoded.blob,
    objectUrl: decoded.objectUrl,
  };
}

function cacheKey(entry: LibraryEntry): string {
  return `${entry.relativePath}:${entry.lastModified}`;
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

export async function loadDevelopImage(entry: LibraryEntry): Promise<DevelopImage> {
  const key = cacheKey(entry);
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
    maxEdge: PREVIEW_MAX_EDGE,
  }).then((decoded) => {
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
): Promise<DevelopImage> {
  const decoded = await decodeEntry(entry, { fullResolution: true });
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
): void {
  if (activeIndex < 0) {
    return;
  }

  for (const index of [activeIndex + 1, activeIndex - 1]) {
    const entry = entries[index];
    if (entry) {
      void loadDevelopImage(entry).catch(() => {
        // Preloading is best-effort and should not surface UI errors.
      });
    }
  }
}
