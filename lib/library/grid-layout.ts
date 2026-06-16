import type { LibraryEntry } from "@/lib/fs/types";
import {
  getCachedThumbnail,
  setCachedThumbnail,
} from "@/lib/cache/thumbnail-cache";
import { decodeEntry } from "@/lib/raw/decode";

const aspectRatioCache = new Map<string, number>();

function cacheKey(entry: LibraryEntry): string {
  return `${entry.relativePath}:${entry.lastModified}`;
}

async function getThumbnailBlob(entry: LibraryEntry): Promise<Blob> {
  const thumbKey = {
    relativePath: entry.relativePath,
    lastModified: entry.lastModified,
    thumbnail: true,
  };

  let blob = await getCachedThumbnail(thumbKey);
  if (!blob) {
    const decoded = await decodeEntry(entry, {
      thumbnail: true,
      maxEdge: 480,
    });
    blob = decoded.blob;
    URL.revokeObjectURL(decoded.objectUrl);
    await setCachedThumbnail(thumbKey, blob);
  }

  return blob;
}

export async function getEntryAspectRatio(entry: LibraryEntry): Promise<number> {
  const key = cacheKey(entry);
  const cached = aspectRatioCache.get(key);
  if (cached) {
    return cached;
  }

  const blob = await getThumbnailBlob(entry);
  const bitmap = await createImageBitmap(blob);
  const ratio = bitmap.width / bitmap.height;
  bitmap.close();

  aspectRatioCache.set(key, ratio);
  return ratio;
}

export interface PackedTile {
  entry: LibraryEntry;
  width: number;
  height: number;
}

export interface PackedRow {
  tiles: PackedTile[];
  height: number;
}

export function packDynamicRows(
  entries: LibraryEntry[],
  aspectRatios: Map<string, number>,
  containerWidth: number,
  tileHeight: number,
  gap: number,
): PackedRow[] {
  if (containerWidth <= 0 || entries.length === 0) {
    return [];
  }

  const rows: PackedRow[] = [];
  let currentTiles: PackedTile[] = [];
  let currentWidth = 0;

  for (const entry of entries) {
    const aspect = aspectRatios.get(entry.id) ?? 1;
    const width = Math.max(48, Math.round(tileHeight * aspect));

    const gapBefore = currentTiles.length > 0 ? gap : 0;
    const nextWidth = currentWidth + gapBefore + width;

    if (nextWidth > containerWidth && currentTiles.length > 0) {
      rows.push({ tiles: currentTiles, height: tileHeight });
      currentTiles = [{ entry, width, height: tileHeight }];
      currentWidth = width;
      continue;
    }

    currentTiles.push({ entry, width, height: tileHeight });
    currentWidth = nextWidth;
  }

  if (currentTiles.length > 0) {
    rows.push({ tiles: currentTiles, height: tileHeight });
  }

  return rows;
}
