"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { runWithAspectLimit } from "@/lib/cache/concurrency";
import { getPersistedAspectRatio } from "@/lib/cache/aspect-ratio-cache";
import {
  getCachedEntryAspectRatio,
  getEntryAspectRatio,
  rememberEntryAspectRatio,
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
    () => new Map(entries.map((entry) => [entry.id, entry])),
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
  const inFlightRef = useRef(new Set<string>());
  const loadedRef = useRef(new Set<string>());
  const pendingUpdatesRef = useRef(new Map<string, number>());
  const flushFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const catalogEntries = [...entriesById.values()];
    const seeded = seedAspectRatios(catalogEntries);
    loadedRef.current = new Set(seeded.keys());
    setAspectRatios((current) => {
      const next = new Map(seeded);
      for (const [id, ratio] of current) {
        if (entriesById.has(id) && !next.has(id)) {
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
    let cancelled = false;

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

    async function hydratePersistedRatio(entryId: string) {
      const entry = entriesById.get(entryId);
      if (!entry || loadedRef.current.has(entryId)) {
        return;
      }

      const cached = getCachedEntryAspectRatio(entry);
      if (cached) {
        loadedRef.current.add(entryId);
        scheduleUpdate(entryId, cached);
        return;
      }

      const persisted = await getPersistedAspectRatio(entry);
      if (cancelled || !persisted || loadedRef.current.has(entryId)) {
        return;
      }

      loadedRef.current.add(entryId);
      rememberEntryAspectRatio(entry, persisted);
      scheduleUpdate(entryId, persisted);
    }

    async function loadAspectRatio(entryId: string, priority: number) {
      if (
        cancelled ||
        loadedRef.current.has(entryId) ||
        inFlightRef.current.has(entryId) ||
        !entriesById.has(entryId)
      ) {
        return;
      }

      const entry = entriesById.get(entryId)!;
      inFlightRef.current.add(entryId);

      try {
        const ratio = await runWithAspectLimit(
          () => getEntryAspectRatio(entry),
          { priority },
        );
        if (!cancelled) {
          loadedRef.current.add(entryId);
          scheduleUpdate(entryId, ratio);
        }
      } catch {
        if (!cancelled) {
          loadedRef.current.add(entryId);
          scheduleUpdate(entryId, 1);
        }
      } finally {
        inFlightRef.current.delete(entryId);
      }
    }

    const uniquePriorityIds = [...new Set(priorityEntryIds)].filter(
      (entryId) => entriesById.has(entryId) && !loadedRef.current.has(entryId),
    );

    for (const entryId of uniquePriorityIds) {
      void hydratePersistedRatio(entryId);
    }

    for (const [index, entryId] of uniquePriorityIds.entries()) {
      void loadAspectRatio(entryId, priorityForIndex(index));
    }

    return () => {
      cancelled = true;
      if (flushFrameRef.current !== null) {
        window.cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
    };
  }, [entriesById, priorityEntryIds]);

  return { aspectRatios };
}
