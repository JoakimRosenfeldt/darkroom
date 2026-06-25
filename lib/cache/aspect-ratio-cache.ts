import { idbGet, idbSet } from "./idb";
import type { LibraryEntry } from "@/lib/fs/types";

const CACHE_PREFIX = "darkroom-aspect:";
const memoryCache = new Map<string, number>();

function cacheKey(entry: Pick<LibraryEntry, "relativePath" | "lastModified">): string {
  return `${entry.relativePath}:${entry.lastModified}`;
}

function persistKey(entry: LibraryEntry): string {
  return `${CACHE_PREFIX}${cacheKey(entry)}`;
}

export function getCachedEntryAspectRatio(
  entry: LibraryEntry,
): number | undefined {
  return memoryCache.get(cacheKey(entry));
}

export function rememberEntryAspectRatio(
  entry: LibraryEntry,
  ratio: number,
): void {
  memoryCache.set(cacheKey(entry), ratio);
  void idbSet(persistKey(entry), ratio).catch(() => {
    // Aspect ratio persistence is best-effort.
  });
}

export async function getPersistedAspectRatio(
  entry: LibraryEntry,
): Promise<number | null> {
  const cached = memoryCache.get(cacheKey(entry));
  if (cached) {
    return cached;
  }

  const stored = await idbGet<number>(persistKey(entry));
  if (typeof stored === "number" && stored > 0) {
    memoryCache.set(cacheKey(entry), stored);
    return stored;
  }

  return null;
}
