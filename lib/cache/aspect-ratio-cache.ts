import { get, set } from "idb-keyval";
import type { LibraryEntry } from "@/lib/fs/types";

const CACHE_PREFIX = "darkroom-aspect:";

function buildCacheKey(entry: LibraryEntry): string {
  return `${CACHE_PREFIX}${entry.relativePath}:${entry.lastModified}`;
}

export async function getPersistedAspectRatio(
  entry: LibraryEntry,
): Promise<number | null> {
  const cached = await get<number>(buildCacheKey(entry));
  return typeof cached === "number" && cached > 0 ? cached : null;
}

export async function setPersistedAspectRatio(
  entry: LibraryEntry,
  ratio: number,
): Promise<void> {
  await set(buildCacheKey(entry), ratio);
}
