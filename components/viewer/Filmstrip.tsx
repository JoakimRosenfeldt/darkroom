"use client";

import { useEffect, useRef } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { PhotoTile } from "@/components/library/PhotoTile";
import { IconChevronLeft, IconChevronRight } from "@/components/shell/icons";

interface FilmstripProps {
  entries: LibraryEntry[];
  activeId: string;
  onSelect: (id: string) => void;
}

const THUMB_SIZE = 72;

export function Filmstrip({ entries, activeId, onSelect }: FilmstripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || activeIndex < 0) {
      return;
    }

    const thumb = container.children[activeIndex] as HTMLElement | undefined;
    thumb?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeIndex]);

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
    <div className="flex h-[88px] shrink-0 items-stretch border-t border-lr-border-subtle bg-lr-panel">
      <div className="flex flex-col border-r border-lr-border-subtle">
        <button
          type="button"
          onClick={() => selectRelative(-1)}
          disabled={activeIndex <= 0}
          className="flex flex-1 items-center justify-center px-2 text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-30"
          aria-label="Previous photo"
        >
          <IconChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => selectRelative(1)}
          disabled={activeIndex < 0 || activeIndex >= entries.length - 1}
          className="flex flex-1 items-center justify-center px-2 text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-30"
          aria-label="Next photo"
        >
          <IconChevronRight className="h-4 w-4" />
        </button>
      </div>

      <button
        type="button"
        onClick={() => scrollBy(-1)}
        className="flex w-6 shrink-0 items-center justify-center text-lr-text-dim hover:bg-lr-panel-raised hover:text-lr-text"
        aria-label="Scroll left"
      >
        <IconChevronLeft className="h-3 w-3" />
      </button>

      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 py-2"
      >
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelect(entry.id)}
            className="shrink-0"
          >
            <PhotoTile
              entry={entry}
              size={THUMB_SIZE}
              selected={entry.id === activeId}
              compact
            />
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => scrollBy(1)}
        className="flex w-6 shrink-0 items-center justify-center text-lr-text-dim hover:bg-lr-panel-raised hover:text-lr-text"
        aria-label="Scroll right"
      >
        <IconChevronRight className="h-3 w-3" />
      </button>

      <div className="flex w-16 shrink-0 items-center justify-center border-l border-lr-border-subtle text-[11px] text-lr-text-dim">
        {activeIndex >= 0 ? `${activeIndex + 1}/${entries.length}` : "—"}
      </div>
    </div>
  );
}
