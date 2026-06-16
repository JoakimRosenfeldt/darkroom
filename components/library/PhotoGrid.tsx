"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { PhotoTile } from "./PhotoTile";

interface PhotoGridProps {
  entries: LibraryEntry[];
  thumbSize: number;
}

const GRID_GAP = 2;

export function PhotoGrid({ entries, thumbSize }: PhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const columnCount = Math.max(
    1,
    Math.floor((containerWidth + GRID_GAP) / (thumbSize + GRID_GAP)),
  );
  const rowCount = Math.ceil(entries.length / columnCount);
  const rowHeight = thumbSize + GRID_GAP;

  const rows = useMemo(() => {
    const grouped: LibraryEntry[][] = [];
    for (let i = 0; i < entries.length; i += columnCount) {
      grouped.push(entries.slice(i, i + columnCount));
    }
    return grouped;
  }, [entries, columnCount]);

  useEffect(() => {
    const element = parentRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setContainerWidth(element.clientWidth);

    return () => observer.disconnect();
  }, []);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });

  return (
    <div ref={parentRef} className="h-full overflow-auto p-1">
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const rowEntries = rows[virtualRow.index] ?? [];
          return (
            <div
              key={virtualRow.key}
              className="absolute left-0 top-0 flex gap-0.5 p-0.5"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                height: `${virtualRow.size}px`,
              }}
            >
              {rowEntries.map((entry) => (
                <PhotoTile
                  key={entry.id}
                  entry={entry}
                  size={thumbSize}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
