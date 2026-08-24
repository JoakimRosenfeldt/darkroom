"use client";

import { useEffect, useMemo } from "react";
import { useLibraryViewSettings } from "@/hooks/useLibraryViewSettings";
import { buildQueryIndex } from "@/lib/library/query";
import { buildExactDuplicateGroups } from "@/lib/library/duplicates";
import { resolveLibraryResult, type LibraryPrimaryScope } from "@/lib/library/result";
import type { LibraryResultQuery } from "@/lib/library/result-contract";
import { recordVisibleLibraryResult } from "@/lib/library/result-session";
import { useLibraryStore } from "@/stores/library-store";

export function useLibraryResult(
  primaryScopeOverride?: LibraryPrimaryScope,
  recordSession = true,
  queryOverride?: LibraryResultQuery | null,
) {
  const entries = useLibraryStore((state) => state.entries);
  const metadata = useLibraryStore((state) => state.entryMetadata);
  const albums = useLibraryStore((state) => state.albums);
  const archivedEntryIds = useLibraryStore((state) => state.archivedEntryIds);
  const workspace = useLibraryStore((state) => state.libraryWorkspace);
  const catalogScope = useLibraryStore((state) => state.catalogView);
  const catalogId = useLibraryStore((state) => state.catalogId);
  const primaryScope = queryOverride?.primaryScope ?? primaryScopeOverride ?? catalogScope;
  const catalogRevision = useLibraryStore((state) => state.catalogRevision);
  const [settings] = useLibraryViewSettings();
  const queryIndex = useMemo(
    () => buildQueryIndex(entries, metadata, albums, workspace),
    [entries, metadata, albums, workspace],
  );
  const duplicateEntryIds = useMemo(() => new Set(
    buildExactDuplicateGroups(entries, metadata, albums, archivedEntryIds, workspace)
      .flatMap((group) => group.members.map((member) => member.entry.id)),
  ), [albums, archivedEntryIds, entries, metadata, workspace]);
  const result = useMemo(
    () => resolveLibraryResult({
      catalogRevision,
      entries,
      metadata,
      albums,
      archivedEntryIds,
      workspace,
      primaryScope,
      textQuery: queryOverride?.textQuery ?? settings.textQuery,
      facets: queryOverride?.facets ?? settings.facets,
      curationFilter: queryOverride?.curationFilter ?? settings.curationFilter,
      formatFilter: queryOverride?.formatFilter ?? settings.filter,
      sort: queryOverride?.sort ?? settings.sort,
      sortDirection: queryOverride?.sortDirection ?? settings.sortDirection,
      expandedStackIds: new Set(settings.expandedStackIds),
      duplicateEntryIds,
      queryIndex,
    }),
    [
      albums,
      archivedEntryIds,
      catalogRevision,
      entries,
      duplicateEntryIds,
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
      queryOverride,
    ],
  );
  const query = useMemo<LibraryResultQuery | null>(() => catalogId === null
    ? null
    : {
        catalogId,
        catalogRevision,
        primaryScope,
        archivePolicy: primaryScope.type === "archive" ? "only" : "exclude",
        textQuery: queryOverride?.textQuery ?? settings.textQuery,
        facets: queryOverride?.facets ?? settings.facets,
        curationFilter: queryOverride?.curationFilter ?? settings.curationFilter,
        formatFilter: queryOverride?.formatFilter ?? settings.filter,
        sort: queryOverride?.sort ?? settings.sort,
        sortDirection: queryOverride?.sortDirection ?? settings.sortDirection,
      }, [
        catalogId,
        catalogRevision,
        primaryScope,
        queryOverride,
        settings.curationFilter,
        settings.facets,
        settings.filter,
        settings.sort,
        settings.sortDirection,
        settings.textQuery,
      ]);
  useEffect(() => {
    if (recordSession) {
      recordVisibleLibraryResult(
        result.visibleEntryIds,
        result.viewerEntryIds,
        result.revision,
        query,
      );
    }
  }, [query, recordSession, result.revision, result.viewerEntryIds, result.visibleEntryIds]);
  return { ...result, query };
}

export function useLibraryResultForQuery(query: LibraryResultQuery | null) {
  return useLibraryResult(undefined, false, query);
}
