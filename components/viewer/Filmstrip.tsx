"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import { PhotoTile } from "@/components/library/PhotoTile";
import { useLibraryStore } from "@/stores/library-store";
import type { SelectEntryModifiers } from "@/stores/library-store";
import { IconChevronLeft, IconChevronRight } from "@/components/shell/icons";

interface FilmstripProps {
  entries: LibraryEntry[];
  orderedEntryIds: readonly string[];
  missingEntryIds: readonly string[];
  activeId: string;
  selectedIds: string[];
  onSelect: (id: string, modifiers: SelectEntryModifiers) => void;
  referenceId?: string | null;
  onSetReference?: (id: string) => void;
}

const THUMB_SIZE = 76;
const THUMB_GAP = 8;

export function Filmstrip({
  entries,
  orderedEntryIds,
  missingEntryIds,
  activeId,
  selectedIds,
  onSelect,
  referenceId = null,
  onSetReference,
}: FilmstripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const getScrollRoot = useCallback(() => scrollRef.current, []);
  const entryById = useMemo(
    () => new Map<string, LibraryEntry>(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const missing = useMemo(() => new Set(missingEntryIds), [missingEntryIds]);
  const activeIndex = useMemo(
    () => orderedEntryIds.indexOf(activeId),
    [activeId, orderedEntryIds],
  );
  const pickedCount = useMemo(
    () => entries.reduce(
      (count, entry) =>
        getEntryMetadata(entryMetadata, entry.id).pick === "pick"
          ? count + 1
          : count,
      0,
    ),
    [entries, entryMetadata],
  );
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: orderedEntryIds.length,
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
    for (
      let index = activeIndex + direction;
      index >= 0 && index < orderedEntryIds.length;
      index += direction
    ) {
      const next = entryById.get(orderedEntryIds[index]!);
      if (next) {
        onSelect(next.id, {});
        return;
      }
    }
  }

  return (
    <div className="flex h-[104px] shrink-0 items-stretch border-t border-lr-border-subtle bg-lr-panel">
      <div className="flex w-[52px] flex-col border-r border-lr-border-subtle">
        <button
          type="button"
          onClick={() => selectRelative(-1)}
          disabled={!orderedEntryIds.slice(0, activeIndex).some((entryId) => entryById.has(entryId))}
          className="flex flex-1 items-center justify-center text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-30"
          aria-label="Previous photo"
        >
          <IconChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => selectRelative(1)}
          disabled={!orderedEntryIds.slice(activeIndex + 1).some((entryId) => entryById.has(entryId))}
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
            const entryId = orderedEntryIds[virtualItem.index];
            if (!entryId) return null;
            const entry = entryById.get(entryId);

            if (!entry || missing.has(entryId)) {
              return (
                <div
                  key={entryId}
                  role="img"
                  aria-label={`Missing photo ${virtualItem.index + 1}${selectedIds.includes(entryId) ? ", selected" : ""}`}
                  className={[
                    "absolute top-0 flex items-center justify-center rounded-md border border-dashed border-amber-300/30 bg-amber-950/20 px-2 text-center text-[9px] uppercase tracking-wider text-amber-100/60",
                    selectedIds.includes(entryId) ? "ring-2 ring-inset ring-lr-accent" : "",
                  ].join(" ")}
                  style={{
                    width: `${THUMB_SIZE}px`,
                    height: `${THUMB_SIZE}px`,
                    transform: `translateX(${virtualItem.start}px)`,
                  }}
                >
                  Missing
                </div>
              );
            }

            return (
              <div
                key={entry.id}
                className={[
                  "group absolute top-0 shrink-0 overflow-hidden rounded-md",
                  entry.id === activeId
                    ? "ring-2 ring-inset ring-lr-accent"
                    : "",
                ].join(" ")}
                style={{
                  width: `${THUMB_SIZE}px`,
                  height: `${THUMB_SIZE}px`,
                  transform: `translateX(${virtualItem.start}px)`,
                }}
              >
                <button
                  type="button"
                  aria-current={entry.id === activeId ? "true" : undefined}
                  aria-pressed={selectedIds.includes(entry.id)}
                  aria-label={`Select ${entry.name}`}
                  onClick={(event) => onSelect(entry.id, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })}
                  className="block h-full w-full"
                >
                  <PhotoTile entry={entry} width={THUMB_SIZE} height={THUMB_SIZE} selected={selectedIds.includes(entry.id)} metadata={getEntryMetadata(entryMetadata, entry.id)} compact getScrollRoot={getScrollRoot} />
                </button>
                {onSetReference ? (
                  <button type="button" onClick={() => onSetReference(entry.id)} aria-label={`Use ${entry.name} as reference`} title="Set as reference" className={`absolute bottom-1 right-1 z-40 rounded border px-1 py-0.5 font-mono text-[8px] ${referenceId === entry.id ? "border-lr-accent bg-lr-selection text-lr-accent" : "border-white/15 bg-black/70 text-white/60 opacity-0 hover:text-white group-hover:opacity-100"}`}>REF</button>
                ) : null}
              </div>
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
          {activeIndex >= 0 ? `${activeIndex + 1} / ${orderedEntryIds.length}` : "—"}
        </span>
        <span className="text-[10px] uppercase tracking-[0.08em] text-lr-text-muted">
          {selectedIds.length > 1
            ? `${selectedIds.length} selected`
            : missingEntryIds.length > 0
              ? `${missingEntryIds.length} missing`
              : activeIndex >= 0
                ? `${pickedCount} picked`
              : "Photos"}
        </span>
      </div>
    </div>
  );
}
