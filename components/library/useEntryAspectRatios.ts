"use client";

import { useEffect, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { getEntryAspectRatio } from "@/lib/library/grid-layout";

export function useEntryAspectRatios(entries: LibraryEntry[]) {
  const [aspectRatios, setAspectRatios] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(entries.length > 0);

  useEffect(() => {
    if (entries.length === 0) {
      setAspectRatios(new Map());
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    async function loadAspectRatios() {
      const results = await Promise.all(
        entries.map(async (entry) => {
          const ratio = await getEntryAspectRatio(entry);
          return [entry.id, ratio] as const;
        }),
      );

      if (cancelled) {
        return;
      }

      setAspectRatios(new Map(results));
      setLoading(false);
    }

    void loadAspectRatios();

    return () => {
      cancelled = true;
    };
  }, [entries]);

  return { aspectRatios, loading };
}
