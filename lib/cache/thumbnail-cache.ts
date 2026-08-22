import { idbGet, idbSet } from "./idb";
import type { LibraryEntry } from "@/lib/fs/types";
import { decodeEntry } from "@/lib/raw/decode";

const CACHE_PREFIX = "darkroom-thumb:";
const MAX_MEMORY_THUMBNAILS = 300;

export interface ThumbnailCacheKey {
  relativePath: string;
  lastModified: number;
  thumbnail: boolean;
}

interface LoadThumbnailOptions {
  priority?: number;
  signal?: AbortSignal;
}

const memoryCache = new Map<string, Blob>();
interface InFlightThumbnailLoad {
  promise: Promise<Blob>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

const inFlightLoads = new Map<string, InFlightThumbnailLoad>();

function waitForCaller(
  load: InFlightThumbnailLoad,
  signal?: AbortSignal,
): Promise<Blob> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Thumbnail request was cancelled.", "AbortError"));
  }
  load.consumers += 1;
  return new Promise<Blob>((resolve, reject) => {
    let finished = false;
    function release(aborted: boolean) {
      if (finished) return;
      finished = true;
      load.consumers -= 1;
      signal?.removeEventListener("abort", onAbort);
      if (aborted && load.consumers === 0 && !load.settled) {
        load.controller.abort();
      }
    }
    const onAbort = () => {
      release(true);
      reject(new DOMException("Thumbnail request was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    load.promise.then(
      (blob) => {
        release(false);
        resolve(blob);
      },
      (error: unknown) => {
        release(false);
        reject(error);
      },
    );
  });
}

function buildCacheKey(key: ThumbnailCacheKey): string {
  return `${CACHE_PREFIX}${key.relativePath}:${key.lastModified}:${key.thumbnail ? "thumb" : "full"}`;
}

function rememberThumbnail(cacheKey: string, blob: Blob): void {
  if (memoryCache.has(cacheKey)) {
    memoryCache.delete(cacheKey);
  }

  memoryCache.set(cacheKey, blob);

  if (memoryCache.size > MAX_MEMORY_THUMBNAILS) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) {
      memoryCache.delete(oldestKey);
    }
  }
}

export async function getCachedThumbnail(
  key: ThumbnailCacheKey,
): Promise<Blob | null> {
  const cacheKey = buildCacheKey(key);
  const memoryCached = memoryCache.get(cacheKey);
  if (memoryCached) {
    memoryCache.delete(cacheKey);
    memoryCache.set(cacheKey, memoryCached);
    return memoryCached;
  }

  const cached = await idbGet<Blob>(cacheKey);
  if (cached) {
    rememberThumbnail(cacheKey, cached);
  }

  return cached ?? null;
}

export async function setCachedThumbnail(
  key: ThumbnailCacheKey,
  blob: Blob,
): Promise<void> {
  const cacheKey = buildCacheKey(key);
  rememberThumbnail(cacheKey, blob);
  await idbSet(cacheKey, blob);
}

export async function loadThumbnailBlob(
  entry: LibraryEntry,
  maxEdge: number,
  options: LoadThumbnailOptions = {},
): Promise<Blob> {
  const key = {
    relativePath: entry.relativePath,
    lastModified: entry.lastModified,
    thumbnail: true,
  };
  const cacheKey = buildCacheKey(key);
  const activeLoad = inFlightLoads.get(cacheKey);

  if (activeLoad) {
    return waitForCaller(activeLoad, options.signal);
  }

  const controller = new AbortController();
  const promise = (async () => {
    const cached = await getCachedThumbnail(key);
    if (cached) {
      return cached;
    }

    const decoded = await decodeEntry(entry, {
      thumbnail: true,
      maxEdge,
      priority: options.priority,
      signal: controller.signal,
    });
    URL.revokeObjectURL(decoded.objectUrl);
    await setCachedThumbnail(key, decoded.blob);
    return decoded.blob;
  })();
  const load: InFlightThumbnailLoad = {
    promise,
    controller,
    consumers: 0,
    settled: false,
  };

  function clearCompletedLoad() {
    load.settled = true;
    if (inFlightLoads.get(cacheKey) === load) {
      inFlightLoads.delete(cacheKey);
    }
  }

  inFlightLoads.set(cacheKey, load);
  promise.then(clearCompletedLoad, clearCompletedLoad);
  return waitForCaller(load, options.signal);
}
