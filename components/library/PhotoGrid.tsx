"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import { packSquareRows } from "@/lib/library/grid-layout";
import { useGridContainerWidth } from "@/hooks/useGridContainerWidth";
import { useLibraryStore } from "@/stores/library-store";
import { PhotoTile } from "./PhotoTile";

interface PhotoGridProps {
  entries: LibraryEntry[];
  thumbSize: number;
  onGridRowsChange?: (rows: string[][]) => void;
  onPhotoContextMenu?: (entryId: string, event: React.MouseEvent) => void;
}

const ROW_GAP = 4;
const TILE_GAP = 2;

export function PhotoGrid({ entries, thumbSize, onGridRowsChange, onPhotoContextMenu }: PhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const containerWidth = useGridContainerWidth(parentRef, entries);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const selectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const selectEntry = useLibraryStore((state) => state.selectEntry);
  const getScrollRoot = useCallback(() => parentRef.current, []);

  const visibleOrder = useMemo(
    () => entries.map((entry) => entry.id),
    [entries],
  );

  const handleSelect = useCallback(
    (entryId: string, modifiers: { shift?: boolean; toggle?: boolean }) => {
      selectEntry(entryId, modifiers, visibleOrder);
    },
    [selectEntry, visibleOrder],
  );

  const { rows } = useMemo(
    () => packSquareRows(entries, containerWidth, thumbSize, TILE_GAP),
    [entries, containerWidth, thumbSize],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.cellSize ?? thumbSize) + ROW_GAP,
    overscan: 6,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const layoutReady = containerWidth > 0 && rows.length > 0;

  useEffect(() => {
    if (!onGridRowsChange) {
      return;
    }
    if (!layoutReady) {
      return;
    }
    onGridRowsChange(rows.map((row) => row.entries.map((entry) => entry.id)));
  }, [rows, layoutReady, onGridRowsChange]);

  const selectedRowIndex = useMemo(() => {
    if (!selectedEntryId) {
      return -1;
    }

    return rows.findIndex((row) =>
      row.entries.some((entry) => entry.id === selectedEntryId),
    );
  }, [rows, selectedEntryId]);

  useEffect(() => {
    if (!layoutReady || selectedRowIndex < 0) {
      return;
    }

    virtualizerRef.current.scrollToIndex(selectedRowIndex, { align: "auto" });
  }, [layoutReady, selectedRowIndex]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-lr-text-dim">
        No photos match the current filters
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto p-1">
      {!layoutReady ? (
        <div className="flex h-full min-h-[200px] items-center justify-center text-xs text-lr-text-dim">
          Preparing layout...
        </div>
      ) : (
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) {
              return null;
            }

            return (
              <div
                key={virtualRow.key}
                className="absolute left-0 top-0 flex items-stretch"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  width: `${containerWidth}px`,
                  height: `${row.cellSize}px`,
                  gap: `${TILE_GAP}px`,
                }}
              >
                {row.entries.map((entry) => (
                  <PhotoTile
                    key={entry.id}
                    entry={entry}
                    width={row.cellSize}
                    height={row.cellSize}
                    fit="contain"
                    selected={selectedEntryIds.includes(entry.id)}
                    metadata={getEntryMetadata(entryMetadata, entry.id)}
                    onSelect={handleSelect}
                    onContextMenu={onPhotoContextMenu}
                    getScrollRoot={getScrollRoot}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
