"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { packDynamicRows } from "@/lib/library/grid-layout";
import { PhotoTile } from "./PhotoTile";
import { useEntryAspectRatios } from "./useEntryAspectRatios";

interface DynamicPhotoGridProps {
  entries: LibraryEntry[];
  rowHeight: number;
}

const ROW_GAP = 4;
const TILE_GAP = 2;

function measureContentWidth(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  const padding =
    Number.parseFloat(style.paddingLeft) +
    Number.parseFloat(style.paddingRight);
  return element.clientWidth - padding;
}

export function DynamicPhotoGrid({ entries, rowHeight }: DynamicPhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const { aspectRatios, loading } = useEntryAspectRatios(entries);

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

  const layoutReady = containerWidth > 0 && !loading && rows.length > 0;

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
