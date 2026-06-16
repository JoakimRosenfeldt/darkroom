"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { measureContentWidth, packSquareRows } from "@/lib/library/grid-layout";
import { PhotoTile } from "./PhotoTile";

interface PhotoGridProps {
  entries: LibraryEntry[];
  thumbSize: number;
}

const ROW_GAP = 4;
const TILE_GAP = 2;

export function PhotoGrid({ entries, thumbSize }: PhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const { rows } = useMemo(
    () => packSquareRows(entries, containerWidth, thumbSize, TILE_GAP),
    [entries, containerWidth, thumbSize],
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
    estimateSize: (index) => (rows[index]?.cellSize ?? thumbSize) + ROW_GAP,
    overscan: 6,
  });

  const layoutReady = containerWidth > 0 && rows.length > 0;

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
