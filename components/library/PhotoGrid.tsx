"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { PhotoTile } from "./PhotoTile";

interface PhotoGridProps {
  entries: LibraryEntry[];
}

const COLUMN_COUNT = 4;
const ROW_HEIGHT = 260;
const GAP = 16;

export function PhotoGrid({ entries }: PhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(entries.length / COLUMN_COUNT);

  const rows = useMemo(() => {
    const grouped: LibraryEntry[][] = [];
    for (let i = 0; i < entries.length; i += COLUMN_COUNT) {
      grouped.push(entries.slice(i, i + COLUMN_COUNT));
    }
    return grouped;
  }, [entries]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT + GAP,
    overscan: 4,
  });

  if (entries.length === 0) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/60 p-10 text-center text-zinc-500">
        Open a folder to start browsing your photo library.
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-[calc(100vh-220px)] overflow-auto pr-2">
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const rowEntries = rows[virtualRow.index] ?? [];
          return (
            <div
              key={virtualRow.key}
              className="absolute left-0 top-0 grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                height: `${virtualRow.size}px`,
              }}
            >
              {rowEntries.map((entry) => (
                <PhotoTile key={entry.id} entry={entry} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
