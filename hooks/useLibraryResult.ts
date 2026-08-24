"use client";

import { useMemo } from "react";
import { useLibraryViewSettings } from "@/hooks/useLibraryViewSettings";
import { buildQueryIndex } from "@/lib/library/query";
import { resolveLibraryResult } from "@/lib/library/result";
import { useLibraryStore } from "@/stores/library-store";

export function useLibraryResult() {
  const entries = useLibraryStore((state) => state.entries);
  const metadata = useLibraryStore((state) => state.entryMetadata);
  const albums = useLibraryStore((state) => state.albums);
  const archivedEntryIds = useLibraryStore((state) => state.archivedEntryIds);
  const workspace = useLibraryStore((state) => state.libraryWorkspace);
  const primaryScope = useLibraryStore((state) => state.catalogView);
  const catalogRevision = useLibraryStore((state) => state.catalogRevision);
  const [settings] = useLibraryViewSettings();
  const queryIndex = useMemo(
    () => buildQueryIndex(entries, metadata, albums, workspace),
    [entries, metadata, albums, workspace],
  );
  return useMemo(
    () => resolveLibraryResult({
      catalogRevision,
      entries,
      metadata,
      albums,
      archivedEntryIds,
      workspace,
      primaryScope,
      textQuery: settings.textQuery,
      facets: settings.facets,
      curationFilter: settings.curationFilter,
      formatFilter: settings.filter,
      sort: settings.sort,
      sortDirection: settings.sortDirection,
      expandedStackIds: new Set(settings.expandedStackIds),
      queryIndex,
    }),
    [
      albums,
      archivedEntryIds,
      catalogRevision,
      entries,
      metadata,
      primaryScope,
      queryIndex,
      settings.curationFilter,
      settings.expandedStackIds,
      settings.facets,
      settings.filter,
      settings.sort,
      settings.sortDirection,
      settings.textQuery,
      workspace,
    ],
  );
}
