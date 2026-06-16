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

function justifyRow(
  entries: LibraryEntry[],
  aspectRatios: Map<string, number>,
  containerWidth: number,
  gap: number,
): PackedRow {
  const aspects = entries.map((entry) => aspectRatios.get(entry.id) ?? 1);
  const aspectSum = aspects.reduce((sum, aspect) => sum + aspect, 0);
  const gaps = Math.max(0, entries.length - 1) * gap;
  const height = (containerWidth - gaps) / aspectSum;

  const tiles = entries.map((entry, index) => {
    const width = aspects[index] * height;
    return {
      entry,
      width: Math.round(width),
      height: Math.round(height),
    };
  });

  return {
    tiles,
    height: Math.round(height),
  };
}

export function packDynamicRows(
  entries: LibraryEntry[],
  aspectRatios: Map<string, number>,
  containerWidth: number,
  targetRowHeight: number,
  gap: number,
): PackedRow[] {
  if (containerWidth <= 0 || entries.length === 0) {
    return [];
  }

  const rows: PackedRow[] = [];
  let currentEntries: LibraryEntry[] = [];
  let currentAspectSum = 0;

  for (const entry of entries) {
    const aspect = aspectRatios.get(entry.id) ?? 1;
    const nextCount = currentEntries.length + 1;
    const nextAspectSum = currentAspectSum + aspect;
    const nextGaps = Math.max(0, nextCount - 1) * gap;
    const widthAtTarget = nextAspectSum * targetRowHeight + nextGaps;

    if (widthAtTarget > containerWidth && currentEntries.length > 0) {
      rows.push(
        justifyRow(currentEntries, aspectRatios, containerWidth, gap),
      );
      currentEntries = [entry];
      currentAspectSum = aspect;
      continue;
    }

    currentEntries.push(entry);
    currentAspectSum = nextAspectSum;
  }

  if (currentEntries.length > 0) {
    rows.push(justifyRow(currentEntries, aspectRatios, containerWidth, gap));
  }

  return rows;
}
