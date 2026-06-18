import { get, set } from "idb-keyval";
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
const inFlightLoads = new Map<string, Promise<Blob>>();

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

  const cached = await get<Blob>(cacheKey);
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
  await set(cacheKey, blob);
}

export function createThumbnailObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
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
  const shouldShareInFlightLoad =
    !options.signal && (options.priority ?? 0) <= 0;
  const activeLoad = shouldShareInFlightLoad ? inFlightLoads.get(cacheKey) : null;

  if (activeLoad) {
    return activeLoad;
  }

  const load = (async () => {
    const cached = await getCachedThumbnail(key);
    if (cached) {
      return cached;
    }

    const decoded = await decodeEntry(entry, {
      thumbnail: true,
      maxEdge,
      priority: options.priority,
      signal: options.signal,
    });
    URL.revokeObjectURL(decoded.objectUrl);
    await setCachedThumbnail(key, decoded.blob);
    return decoded.blob;
  })();

  if (shouldShareInFlightLoad) {
    inFlightLoads.set(cacheKey, load);
  }

  try {
    return await load;
  } finally {
    if (shouldShareInFlightLoad) {
      inFlightLoads.delete(cacheKey);
    }
  }
}
