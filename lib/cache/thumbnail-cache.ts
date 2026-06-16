import { get, set } from "idb-keyval";

const CACHE_PREFIX = "darkroom-thumb:";

export interface ThumbnailCacheKey {
  relativePath: string;
  lastModified: number;
  thumbnail: boolean;
}

function buildCacheKey(key: ThumbnailCacheKey): string {
  return `${CACHE_PREFIX}${key.relativePath}:${key.lastModified}:${key.thumbnail ? "thumb" : "full"}`;
}

export async function getCachedThumbnail(
  key: ThumbnailCacheKey,
): Promise<Blob | null> {
  const cached = await get<Blob>(buildCacheKey(key));
  return cached ?? null;
}

export async function setCachedThumbnail(
  key: ThumbnailCacheKey,
  blob: Blob,
): Promise<void> {
  await set(buildCacheKey(key), blob);
}

export function createThumbnailObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}
