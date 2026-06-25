import type { LibraryEntry } from "@/lib/fs/types";
import {
  getCachedEntryAspectRatio,
  rememberEntryAspectRatio,
} from "@/lib/cache/aspect-ratio-cache";
import { resolveEntryAspectRatio } from "@/lib/library/entry-dimensions";

export { getCachedEntryAspectRatio, rememberEntryAspectRatio };

export async function getEntryAspectRatio(
  entry: LibraryEntry,
  options: { priority?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const cached = getCachedEntryAspectRatio(entry);
  if (cached) {
    return cached;
  }

  const ratio = await resolveEntryAspectRatio(entry, {
    signal: options.signal,
  });
  rememberEntryAspectRatio(entry, ratio);
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

export interface PackedSquareRow {
  entries: LibraryEntry[];
  cellSize: number;
}

export function measureContentWidth(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  const padding =
    Number.parseFloat(style.paddingLeft) +
    Number.parseFloat(style.paddingRight);
  return element.clientWidth - padding;
}

export function packSquareRows(
  entries: LibraryEntry[],
  containerWidth: number,
  targetCellSize: number,
  gap: number,
): { rows: PackedSquareRow[]; columnCount: number } {
  if (containerWidth <= 0 || entries.length === 0) {
    return { rows: [], columnCount: 1 };
  }

  const columnCount = Math.max(
    1,
    Math.floor((containerWidth + gap) / (targetCellSize + gap)),
  );

  const fullRowGaps = Math.max(0, columnCount - 1) * gap;
  const cellSize = Math.round(
    (containerWidth - fullRowGaps) / columnCount,
  );

  const rows: PackedSquareRow[] = [];

  for (let index = 0; index < entries.length; index += columnCount) {
    const rowEntries = entries.slice(index, index + columnCount);
    rows.push({
      entries: rowEntries,
      cellSize,
    });
  }

  return { rows, columnCount };
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

  const tiles: PackedTile[] = entries.map((entry, index) => ({
    entry,
    width: aspects[index] * height,
    height,
  }));

  const roundedTiles = tiles.map((tile) => ({
    ...tile,
    width: Math.round(tile.width),
    height: Math.round(tile.height),
  }));

  const usedWidth = roundedTiles.reduce(
    (sum, tile, index) => sum + tile.width + (index > 0 ? gap : 0),
    0,
  );
  const remainder = Math.round(containerWidth - usedWidth);
  if (roundedTiles.length > 0 && remainder !== 0) {
    roundedTiles[roundedTiles.length - 1].width += remainder;
  }

  return {
    tiles: roundedTiles,
    height: roundedTiles[0]?.height ?? Math.round(height),
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
