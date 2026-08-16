"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import { PhotoTile } from "@/components/library/PhotoTile";
import { useLibraryStore } from "@/stores/library-store";
import { IconChevronLeft, IconChevronRight } from "@/components/shell/icons";

interface FilmstripProps {
  entries: LibraryEntry[];
  activeId: string;
  onSelect: (id: string) => void;
}

const THUMB_SIZE = 76;
const THUMB_GAP = 8;

export function Filmstrip({ entries, activeId, onSelect }: FilmstripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const getScrollRoot = useCallback(() => scrollRef.current, []);
  const activeIndex = useMemo(
    () => entries.findIndex((entry) => entry.id === activeId),
    [entries, activeId],
  );
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => THUMB_SIZE + THUMB_GAP,
    overscan: 16,
  });

  useEffect(() => {
    if (activeIndex < 0) {
      return;
    }

    virtualizer.scrollToIndex(activeIndex, {
      align: "center",
      behavior: "smooth",
    });
  }, [activeIndex, virtualizer]);

  function scrollBy(direction: -1 | 1) {
    scrollRef.current?.scrollBy({
      left: direction * THUMB_SIZE * 4,
      behavior: "smooth",
    });
  }

  function selectRelative(direction: -1 | 1) {
    if (activeIndex < 0) {
      return;
    }
    const next = entries[activeIndex + direction];
    if (next) {
      onSelect(next.id);
    }
  }

  return (
    <div className="flex h-[104px] shrink-0 items-stretch border-t border-lr-border-subtle bg-lr-panel">
      <div className="flex w-[52px] flex-col border-r border-lr-border-subtle">
        <button
          type="button"
          onClick={() => selectRelative(-1)}
          disabled={activeIndex <= 0}
          className="flex flex-1 items-center justify-center text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-30"
          aria-label="Previous photo"
        >
          <IconChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => selectRelative(1)}
          disabled={activeIndex < 0 || activeIndex >= entries.length - 1}
          className="flex flex-1 items-center justify-center border-t border-lr-border-subtle text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-30"
          aria-label="Next photo"
        >
          <IconChevronRight className="h-4 w-4" />
        </button>
      </div>

      <button
        type="button"
        onClick={() => scrollBy(-1)}
        className="flex w-6 shrink-0 items-center justify-center text-lr-text-faint hover:bg-lr-panel-raised hover:text-lr-text"
        aria-label="Scroll left"
      >
        <IconChevronLeft className="h-3 w-3" />
      </button>

      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-3 py-[14px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div
          className="relative h-full"
          style={{ width: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const entry = entries[virtualItem.index];
            if (!entry) {
              return null;
            }

            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSelect(entry.id)}
                className="absolute top-0 shrink-0"
                style={{
                  width: `${THUMB_SIZE}px`,
                  height: `${THUMB_SIZE}px`,
                  transform: `translateX(${virtualItem.start}px)`,
                }}
              >
                <PhotoTile
                  entry={entry}
                  width={THUMB_SIZE}
                  height={THUMB_SIZE}
                  selected={entry.id === activeId}
                  metadata={getEntryMetadata(entryMetadata, entry.id)}
                  compact
                  getScrollRoot={getScrollRoot}
                />
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={() => scrollBy(1)}
        className="flex w-6 shrink-0 items-center justify-center text-lr-text-faint hover:bg-lr-panel-raised hover:text-lr-text"
        aria-label="Scroll right"
      >
        <IconChevronRight className="h-3 w-3" />
      </button>

      <div className="flex w-24 shrink-0 flex-col items-center justify-center gap-0.5 border-l border-lr-border-subtle">
        <span className="font-mono text-[13px] text-lr-text">
          {activeIndex >= 0 ? `${activeIndex + 1} / ${entries.length}` : "—"}
        </span>
        <span className="text-[10px] uppercase tracking-[0.08em] text-lr-text-muted">
          {activeIndex >= 0 ? "Current" : "Photos"}
        </span>
      </div>
    </div>
  );
}
