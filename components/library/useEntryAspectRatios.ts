"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { runWithAspectLimit } from "@/lib/cache/concurrency";
import {
  getCachedEntryAspectRatio,
  getEntryAspectRatio,
} from "@/lib/library/grid-layout";

function seedAspectRatios(entries: LibraryEntry[]): Map<string, number> {
  const seeded = new Map<string, number>();
  for (const entry of entries) {
    const cached = getCachedEntryAspectRatio(entry);
    if (cached) {
      seeded.set(entry.id, cached);
    }
  }
  return seeded;
}

function priorityForIndex(index: number): number {
  return Math.max(1, 100 - index);
}

export function useEntryAspectRatios(
  entries: LibraryEntry[],
  priorityEntryIds: string[],
) {
  const entriesById = useMemo(
    () => new Map<string, LibraryEntry>(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const entrySetKey = useMemo(() => {
    const ids = entries.map((entry) => entry.id);
    ids.sort();
    return ids.join("\0");
  }, [entries]);
  const [aspectRatios, setAspectRatios] = useState<Map<string, number>>(() =>
    seedAspectRatios(entries),
  );
  const previousEntriesByIdRef = useRef(entriesById);
  const generationRef = useRef(0);
  const inFlightRef = useRef(new Map<string, number>());
  const loadedRef = useRef(new Set<string>());
  const pendingUpdatesRef = useRef(new Map<string, number>());
  const flushFrameRef = useRef<number | null>(null);

  useEffect(() => {
    generationRef.current += 1;
    const catalogEntries = [...entriesById.values()];
    const seeded = seedAspectRatios(catalogEntries);
    const previousEntriesById = previousEntriesByIdRef.current;
    previousEntriesByIdRef.current = entriesById;
    loadedRef.current = new Set(seeded.keys());
    setAspectRatios((current) => {
      const next = new Map(seeded);
      for (const [id, ratio] of current) {
        const entry = entriesById.get(id);
        const previous = previousEntriesById.get(id);
        if (entry && previous &&
          entry.catalogId === previous.catalogId &&
          entry.assetId === previous.assetId &&
          entry.assetRevision === previous.assetRevision) {
          next.set(id, ratio);
          loadedRef.current.add(id);
        }
      }
      return next;
    });
    inFlightRef.current.clear();
    pendingUpdatesRef.current.clear();
  }, [entrySetKey, entriesById]);

  useEffect(() => {
    const generation = generationRef.current;

    function scheduleUpdate(id: string, ratio: number) {
      pendingUpdatesRef.current.set(id, ratio);
      if (flushFrameRef.current === null) {
        flushFrameRef.current = window.requestAnimationFrame(() => {
          flushFrameRef.current = null;
          if (pendingUpdatesRef.current.size === 0) {
            return;
          }

          const batch = pendingUpdatesRef.current;
          pendingUpdatesRef.current = new Map();

          setAspectRatios((current) => {
            const next = new Map(current);
            for (const [entryId, ratio] of batch) {
              next.set(entryId, ratio);
            }
            return next;
          });
        });
      }
    }

    async function loadAspectRatio(entryId: string, priority: number) {
      if (
        loadedRef.current.has(entryId) ||
        inFlightRef.current.get(entryId) === generation ||
        !entriesById.has(entryId)
      ) {
        return;
      }

      const entry = entriesById.get(entryId)!;
      inFlightRef.current.set(entryId, generation);

      try {
        const ratio = await runWithAspectLimit(
          () => getEntryAspectRatio(entry),
          { priority },
        );
        if (generation === generationRef.current && !loadedRef.current.has(entryId)) {
          loadedRef.current.add(entryId);
          scheduleUpdate(entryId, ratio);
        }
      } catch {
        if (generation === generationRef.current && !loadedRef.current.has(entryId)) {
          loadedRef.current.add(entryId);
          scheduleUpdate(entryId, 1);
        }
      } finally {
        if (inFlightRef.current.get(entryId) === generation) inFlightRef.current.delete(entryId);
      }
    }

    const uniquePriorityIds = [...new Set(priorityEntryIds)].filter(
      (entryId) => entriesById.has(entryId) && !loadedRef.current.has(entryId),
    );

    for (const [index, entryId] of uniquePriorityIds.entries()) {
      void loadAspectRatio(entryId, priorityForIndex(index));
    }

  }, [entriesById, priorityEntryIds]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      if (flushFrameRef.current !== null) {
        window.cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
    };
  }, []);

  const updateAspectRatio = useCallback((entryId: string, ratio: number) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    loadedRef.current.add(entryId);
    pendingUpdatesRef.current.delete(entryId);
    setAspectRatios((current) => {
      const previous = current.get(entryId);
      if (previous !== undefined && Math.abs(previous - ratio) < 0.01) return current;
      const next = new Map(current);
      next.set(entryId, ratio);
      return next;
    });
  }, []);

  return { aspectRatios, updateAspectRatio };
}
