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
  readonly cache?: "editor" | "thumbnail";
  readonly includeBlob?: boolean;
}

const EDITOR_CACHE_BYTES = 160 * 1024 * 1024;
const THUMBNAIL_CACHE_BYTES = 32 * 1024 * 1024;
const PREVIEW_MAX_EDGE = 2_560;

const imageCache = new Map<string, DevelopImage>();
const thumbnailImageCache = new Map<string, DevelopImage>();
interface ImageLoad {
  readonly promise: Promise<DevelopImage>;
  readonly controller: AbortController;
  consumers: number;
  readonly priority: { value: number };
}
const inFlightImages = new Map<string, ImageLoad>();
const preloads = new Map<string, AbortController>();

function waitForImage(load: ImageLoad, signal?: AbortSignal): Promise<DevelopImage> {
  signal?.throwIfAborted();
  load.consumers += 1;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", abort);
      if (--load.consumers === 0) load.controller.abort();
    };
    const abort = () => { release(); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    load.promise.then(
      (image) => { release(); resolve(image); },
      (error: unknown) => { release(); reject(error); },
    );
  });
}

function toDevelopImage(decoded: Awaited<ReturnType<typeof decodeEntry>>): DevelopImage {
  if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
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

function rememberImage(
  cache: Map<string, DevelopImage>, key: string, image: DevelopImage, budget: number,
): void {
  cache.delete(key);
  cache.set(key, image);
  let bytes = 0;
  for (const cached of cache.values()) bytes += cached.rgb.byteLength + (cached.blob?.size ?? 0);
  for (const [oldestKey, oldest] of cache) {
    if (bytes <= budget) break;
    cache.delete(oldestKey);
    bytes -= oldest.rgb.byteLength + (oldest.blob?.size ?? 0);
  }
}

export async function loadDevelopImage(
  entry: LibraryEntry,
  options: DevelopImageLoadOptions = {},
): Promise<DevelopImage> {
  options.signal?.throwIfAborted();
  const rawColorMode = options.rawColorMode ?? "decoder-rendered";
  const requestedEdge = options.maxEdge ?? PREVIEW_MAX_EDGE;
  if (!Number.isFinite(requestedEdge) || requestedEdge <= 0) throw new Error("Preview size must be positive.");
  const maxEdge = [360, 720, 1280, PREVIEW_MAX_EDGE].find((edge) => edge >= requestedEdge) ?? PREVIEW_MAX_EDGE;
  const key = `${cacheKey(entry, rawColorMode, maxEdge)}-${options.includeBlob ? "blob" : "pixels"}`;
  const cache = options.cache === "thumbnail" ? thumbnailImageCache : imageCache;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let load = inFlightImages.get(key);
  if (!load || load.controller.signal.aborted) {
    const controller = new AbortController();
    const priority = { value: options.priority ?? 0 };
    const promise = decodeEntry(entry, {
      thumbnail: true, rawSource: "developed", sourcePixels: !options.includeBlob, maxEdge,
      signal: controller.signal, priority: () => priority.value,
      cameraProfile: cameraProfileDecode(entry, rawColorMode),
    }).then((decoded) => {
      if (controller.signal.aborted && decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
      controller.signal.throwIfAborted();
      if (decoded.pixelProvenance.decoderPath === "embedded-preview") {
        if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
        throw new Error("Full RAW decoding failed. Only an embedded JPEG preview is available. Check the Nikon decoder in Support / Formats before editing.");
      }
      return toDevelopImage(decoded);
    });
    load = { promise, controller, consumers: 0, priority };
    inFlightImages.set(key, load);
    const completedLoad = load;
    const clear = () => {
      if (inFlightImages.get(key) === completedLoad) inFlightImages.delete(key);
    };
    promise.then(clear, clear);
  }
  load.priority.value = Math.max(load.priority.value, options.priority ?? 0);
  const image = await waitForImage(load, options.signal);
  options.signal?.throwIfAborted();
  rememberImage(cache, key, image, options.cache === "thumbnail" ? THUMBNAIL_CACHE_BYTES : EDITOR_CACHE_BYTES);
  return image;
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
  const preloadKey = (entry: LibraryEntry) => JSON.stringify([
    entry.catalogId, entry.assetId, entry.id, entry.assetRevision, options.rawColorMode, options.includeBlob, options.maxEdge,
  ]);
  const wanted = new Set<string>();
  for (const index of activeIndex < 0 ? [] : [activeIndex, activeIndex + 1, activeIndex - 1]) {
    const entry = entries[index];
    if (entry) wanted.add(preloadKey(entry));
  }
  for (const [id, controller] of preloads) {
    if (!wanted.has(id)) { controller.abort(); preloads.delete(id); }
  }
  if (activeIndex < 0) return;
  for (const index of [activeIndex + 1, activeIndex - 1]) {
    const entry = entries[index];
    if (!entry) continue;
    const key = preloadKey(entry);
    if (preloads.has(key)) continue;
    const controller = new AbortController();
    preloads.set(key, controller);
    void loadDevelopImage(entry, { ...options, signal: controller.signal, priority: -10 })
      .catch(() => undefined)
      .finally(() => { if (preloads.get(key) === controller) preloads.delete(key); });
  }
}
