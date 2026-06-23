"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import { measureContentWidth, packDynamicRows } from "@/lib/library/grid-layout";
import { collectVisibleEntryIds } from "@/lib/library/visible-entry-ids";
import { useLibraryStore } from "@/stores/library-store";
import { PhotoTile } from "./PhotoTile";
import { useEntryAspectRatios } from "./useEntryAspectRatios";

interface DynamicPhotoGridProps {
  entries: LibraryEntry[];
  rowHeight: number;
  onGridRowsChange?: (rows: string[][]) => void;
}

const ROW_GAP = 4;
const TILE_GAP = 2;

export function DynamicPhotoGrid({
  entries,
  rowHeight,
  onGridRowsChange,
}: DynamicPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const selectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const setSelectedEntryId = useLibraryStore((state) => state.setSelectedEntryId);
  const [visibleEntryIds, setVisibleEntryIds] = useState<string[]>([]);
  const getScrollRoot = useCallback(() => parentRef.current, []);

  const { aspectRatios } = useEntryAspectRatios(entries, visibleEntryIds);

  const rows = useMemo(
    () =>
      packDynamicRows(
        entries,
        aspectRatios,
        containerWidth,
        rowHeight,
        TILE_GAP,
      ),
    [entries, aspectRatios, containerWidth, rowHeight],
  );

  useLayoutEffect(() => {
    const element = parentRef.current;
    if (element) {
      setContainerWidth(measureContentWidth(element));
    }
  }, []);

  useEffect(() => {
    const element = parentRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => {
      setContainerWidth(measureContentWidth(element));
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.height ?? rowHeight) + ROW_GAP,
    overscan: 4,
  });

  const layoutReady = containerWidth > 0 && rows.length > 0;

  useEffect(() => {
    if (!onGridRowsChange) {
      return;
    }
    if (!layoutReady) {
      onGridRowsChange([]);
      return;
    }
    onGridRowsChange(
      rows.map((row) => row.tiles.map((tile) => tile.entry.id)),
    );
  }, [rows, layoutReady, onGridRowsChange]);

  const selectedRowIndex = useMemo(() => {
    if (!selectedEntryId) {
      return -1;
    }

    return rows.findIndex((row) =>
      row.tiles.some((tile) => tile.entry.id === selectedEntryId),
    );
  }, [rows, selectedEntryId]);

  useEffect(() => {
    if (!layoutReady || selectedRowIndex < 0) {
      return;
    }

    virtualizer.scrollToIndex(selectedRowIndex, { align: "auto" });
  }, [layoutReady, selectedRowIndex, virtualizer]);

  const visibleRows = useMemo(
    () =>
      rows.map((row) => ({
        height: row.height,
        entryIds: row.tiles.map((tile) => tile.entry.id),
      })),
    [rows],
  );

  useEffect(() => {
    const element = parentRef.current;
    if (!element || visibleRows.length === 0) {
      return;
    }

    const scrollElement = element;

    function updateVisibleEntryIds() {
      const next = collectVisibleEntryIds(
        scrollElement,
        virtualizer.getVirtualItems(),
        visibleRows,
        selectedEntryId,
      );

      setVisibleEntryIds((current) => {
        if (
          current.length === next.length &&
          current.every((id, index) => id === next[index])
        ) {
          return current;
        }
        return next;
      });
    }

    updateVisibleEntryIds();
    element.addEventListener("scroll", updateVisibleEntryIds, { passive: true });
    window.addEventListener("resize", updateVisibleEntryIds);

    return () => {
      element.removeEventListener("scroll", updateVisibleEntryIds);
      window.removeEventListener("resize", updateVisibleEntryIds);
    };
  }, [visibleRows, selectedEntryId, virtualizer]);

  useLayoutEffect(() => {
    const element = parentRef.current;
    if (!element || visibleRows.length === 0) {
      return;
    }

    const next = collectVisibleEntryIds(
      element,
      virtualizer.getVirtualItems(),
      visibleRows,
      selectedEntryId,
    );
    setVisibleEntryIds(next);
  }, [layoutReady, visibleRows, selectedEntryId, virtualizer]);

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
                  height: `${row.height}px`,
                  gap: `${TILE_GAP}px`,
                }}
              >
                {row.tiles.map((tile) => (
                  <PhotoTile
                    key={tile.entry.id}
                    entry={tile.entry}
                    width={tile.width}
                    height={tile.height}
                    fit="cover"
                    selected={tile.entry.id === selectedEntryId}
                    metadata={getEntryMetadata(entryMetadata, tile.entry.id)}
                    onSelect={setSelectedEntryId}
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
