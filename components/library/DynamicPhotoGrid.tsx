"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import { packDynamicRows } from "@/lib/library/grid-layout";
import { collectVisibleEntryIds } from "@/lib/library/visible-entry-ids";
import { useGridContainerWidth } from "@/hooks/useGridContainerWidth";
import { useScrollToSelectedRow } from "@/hooks/useScrollToSelectedRow";
import { useLibraryStore } from "@/stores/library-store";
import { PhotoTile } from "./PhotoTile";
import { useEntryAspectRatios } from "./useEntryAspectRatios";

interface DynamicPhotoGridProps {
  entries: LibraryEntry[];
  rowHeight: number;
  onGridRowsChange?: (rows: string[][]) => void;
  onPhotoContextMenu?: (entryId: string, event: React.MouseEvent) => void;
}

const ROW_GAP = 20;
const TILE_GAP = 8;
const ROW_HEADER_HEIGHT = 16;
const ROW_HEADER_GAP = 8;
const ROW_HEADER_OVERHEAD = ROW_HEADER_HEIGHT + ROW_HEADER_GAP;

const MONTH_LABELS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function formatRowDate(lastModified: number | undefined): string {
  if (lastModified === undefined) {
    return "—";
  }

  const date = new Date(lastModified);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return `${String(date.getDate()).padStart(2, "0")} ${MONTH_LABELS[date.getMonth()]}`;
}

function getRowDateKey(lastModified: number | undefined): string {
  if (lastModified === undefined) {
    return "unknown";
  }

  const date = new Date(lastModified);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getParentFolderName(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? parts.at(-2) ?? null : null;
}

export function DynamicPhotoGrid({
  entries,
  rowHeight,
  onGridRowsChange,
  onPhotoContextMenu,
}: DynamicPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const containerWidth = useGridContainerWidth(parentRef, entries);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const selectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const selectEntry = useLibraryStore((state) => state.selectEntry);
  const [visibleEntryIds, setVisibleEntryIds] = useState<string[]>([]);
  const getScrollRoot = useCallback(() => parentRef.current, []);

  const visibleOrder = useMemo(
    () => entries.map((entry) => entry.id),
    [entries],
  );
  const selectedEntrySet = useMemo(
    () => new Set(selectedEntryIds),
    [selectedEntryIds],
  );

  const handleSelect = useCallback(
    (entryId: string, modifiers: { shift?: boolean; toggle?: boolean }) => {
      selectEntry(entryId, modifiers, visibleOrder);
    },
    [selectEntry, visibleOrder],
  );

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

  const rowStartsDateGroup = useMemo(
    () =>
      rows.map((row, index) => {
        if (index === 0) {
          return true;
        }

        return (
          getRowDateKey(row.tiles[0]?.entry.lastModified) !==
          getRowDateKey(rows[index - 1]?.tiles[0]?.entry.lastModified)
        );
      }),
    [rows],
  );

  const dateGroupCounts = useMemo(() => {
    const counts = new Map<number, number>();
    let groupStart = 0;

    for (const [index, row] of rows.entries()) {
      if (rowStartsDateGroup[index]) {
        groupStart = index;
      }
      counts.set(groupStart, (counts.get(groupStart) ?? 0) + row.tiles.length);
    }
    return counts;
  }, [rowStartsDateGroup, rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      (rows[index]?.height ?? rowHeight) +
      (rowStartsDateGroup[index] ? ROW_HEADER_OVERHEAD : 0) +
      ROW_GAP,
    overscan: 4,
  });

  const layoutReady = containerWidth > 0 && rows.length > 0;

  useEffect(() => {
    if (!onGridRowsChange) {
      return;
    }
    if (!layoutReady) {
      return;
    }
    onGridRowsChange(
      rows.map((row) => row.tiles.map((tile) => tile.entry.id)),
    );
  }, [rows, layoutReady, onGridRowsChange]);

  const rowIndexByEntryId = useMemo(() => {
    const index = new Map<string, number>();
    rows.forEach((row, rowIndex) => {
      row.tiles.forEach((tile) => index.set(tile.entry.id, rowIndex));
    });
    return index;
  }, [rows]);
  const selectedRowIndex = selectedEntryId
    ? (rowIndexByEntryId.get(selectedEntryId) ?? -1)
    : -1;

  useScrollToSelectedRow({
    layoutReady,
    selectedRowIndex,
    virtualizer,
  });

  const visibleRows = useMemo(
    () =>
      rows.map((row, index) => ({
        height: row.height +
          (rowStartsDateGroup[index] ? ROW_HEADER_OVERHEAD : 0),
        entryIds: row.tiles.map((tile) => tile.entry.id),
      })),
    [rows, rowStartsDateGroup],
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
    setVisibleEntryIds((current) => {
      if (
        current.length === next.length &&
        current.every((id, index) => id === next[index])
      ) {
        return current;
      }
      return next;
    });
  }, [layoutReady, visibleRows, selectedEntryId, virtualizer]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-lr-text-dim">
        No photos match the current filters
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto p-4">
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
            const showHeader = rowStartsDateGroup[virtualRow.index] ?? false;
            const leadEntry = row.tiles[0]?.entry;
            const folderName = getParentFolderName(leadEntry?.relativePath ?? "");
            const dateGroupCount = dateGroupCounts.get(virtualRow.index);

            return (
              <div
                key={virtualRow.key}
                className="absolute left-0 top-0 flex flex-col items-stretch"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  width: `${containerWidth}px`,
                  height: `${row.height + (showHeader ? ROW_HEADER_OVERHEAD : 0)}px`,
                  gap: `${ROW_HEADER_GAP}px`,
                }}
              >
                {showHeader ? (
                  <div className="flex h-4 min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-[11px] uppercase leading-4 tracking-[0.06em] text-lr-text-faint">
                      {formatRowDate(leadEntry?.lastModified)}
                      {folderName ? ` · ${folderName}` : ""}
                    </span>
                    <div className="h-px flex-1 bg-lr-panel-raised" />
                    <span className="shrink-0 font-mono text-[11px] leading-4 text-lr-text-faint">
                      {dateGroupCount ?? row.tiles.length} frame
                      {(dateGroupCount ?? row.tiles.length) === 1 ? "" : "s"}
                    </span>
                  </div>
                ) : null}
                <div
                  className="flex items-start"
                  style={{
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
                      selected={selectedEntrySet.has(tile.entry.id)}
                      metadata={getEntryMetadata(entryMetadata, tile.entry.id)}
                      onSelect={handleSelect}
                      onContextMenu={onPhotoContextMenu}
                      getScrollRoot={getScrollRoot}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
