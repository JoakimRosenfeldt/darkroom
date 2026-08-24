"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PhotoViewer } from "@/components/viewer/PhotoViewer";
import { ModuleSpine } from "@/components/shell/ModuleSpine";
import { useLibraryResultForQuery } from "@/hooks/useLibraryResult";
import { getEntryById, useLibraryStore } from "@/stores/library-store";
import {
  refreshViewerSession,
  resolveViewerSession,
  viewerPhotoHref,
} from "@/lib/viewer/session";
import { getLibraryResultQuery, type LibraryResultResolution } from "@/lib/library/result-repository";
import { isLibraryResultId } from "@/lib/library/result-contract";
import { isAssetId } from "@/lib/catalog/ids";
import { recordVisibleLibraryResult } from "@/lib/library/result-session";
import { useLibraryViewSettings } from "@/hooks/useLibraryViewSettings";

function ResultUnavailable({ message }: { message: string }) {
  const router = useRouter();
  return (
    <div className="flex h-screen bg-lr-toolbar">
      <ModuleSpine activeModule="library" />
      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="max-w-lg text-sm text-lr-text-muted">{message}</p>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="rounded bg-lr-accent px-4 py-2 text-xs font-medium text-[#14202a]"
        >
          Return to Library
        </button>
      </main>
    </div>
  );
}

function PhotoPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const entries = useLibraryStore((state) => state.entries);
  const catalogId = useLibraryStore((state) => state.catalogId);
  const catalogRevision = useLibraryStore((state) => state.catalogRevision);
  const hasBootstrapped = useLibraryStore((state) => state.hasBootstrapped);
  const restoreViewerSelection = useLibraryStore((state) => state.restoreViewerSelection);
  const setCatalogView = useLibraryStore((state) => state.setCatalogView);
  const [, updateLibraryViewSettings] = useLibraryViewSettings();
  const photoParam = searchParams.get("id");
  const resultParam = searchParams.get("result");
  const photoId = isAssetId(photoParam) ? photoParam : null;
  const resultId = isLibraryResultId(resultParam) ? resultParam : null;
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const query = useMemo(
    () => resultId ? getLibraryResultQuery(resultId) : null,
    [resultId],
  );
  const [resolutionState, setResolutionState] = useState<{
    readonly key: string;
    readonly value: LibraryResultResolution;
  } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [redirectNotice, setRedirectNotice] = useState<{
    readonly resultId: string;
    readonly message: string;
  } | null>(null);
  const restoredResultIdRef = useRef<string | null>(null);
  const resolutionKey = `${resultId ?? ""}\u0000${photoId ?? ""}`;
  const resolvedSession = resolutionState?.key === resolutionKey
    ? resolutionState.value
    : null;

  const reconstructedResult = useLibraryResultForQuery(query);
  const availableEntryIds = useMemo(
    () => entries.filter((entry) => entry.health === "present").map((entry) => entry.id),
    [entries],
  );

  useEffect(() => {
    if (!hasBootstrapped || !photoId || !resultId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const resolution = resolveViewerSession({
        resultId,
        requestedEntryId: photoId,
        catalogId,
        catalogRevision,
        availableEntryIds,
        reconstructedEntryIds: reconstructedResult.viewerEntryIds,
        selectedEntryIds,
      });
      if (resolution.snapshot && restoredResultIdRef.current !== resultId) {
        if (resolution.query) {
          setCatalogView(resolution.query.primaryScope);
          updateLibraryViewSettings({
            textQuery: resolution.query.textQuery,
            facets: resolution.query.facets,
            curationFilter: resolution.query.curationFilter,
            filter: resolution.query.formatFilter,
            sort: resolution.query.sort,
            sortDirection: resolution.query.sortDirection,
          });
        }
        restoreViewerSelection(
          resolution.snapshot.origin.selectedEntryIds,
          resolution.snapshot.activeEntryId,
          resolution.snapshot.origin.focusedEntryId,
        );
        restoredResultIdRef.current = resultId;
      }
      if (
        resolution.snapshot &&
        resolution.snapshot.activeEntryId !== photoId &&
        resolution.message
      ) {
        setRedirectNotice({ resultId, message: resolution.message });
      }
      setResolutionState({
        key: resolutionKey,
        value: resolution,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    availableEntryIds,
    catalogId,
    catalogRevision,
    hasBootstrapped,
    photoId,
    reconstructedResult.viewerEntryIds,
    resolutionKey,
    restoreViewerSelection,
    resultId,
    setCatalogView,
    selectedEntryIds,
    updateLibraryViewSettings,
  ]);

  useEffect(() => {
    if (
      resultId && photoId && resolvedSession?.snapshot &&
      resolvedSession.snapshot.activeEntryId !== photoId
    ) {
      router.replace(viewerPhotoHref(resolvedSession.snapshot.activeEntryId, resultId));
    }
  }, [photoId, resolvedSession, resultId, router]);

  useEffect(() => {
    if (!resolvedSession?.snapshot) return;
    recordVisibleLibraryResult(
      resolvedSession.snapshot.orderedEntryIds,
      resolvedSession.snapshot.orderedEntryIds,
      `saved:${resolvedSession.snapshot.id}:${resolvedSession.snapshot.catalogRevision}`,
      resolvedSession.query,
    );
  }, [resolvedSession]);

  function refreshResult() {
    if (!resultId || !catalogId || !resolvedSession?.snapshot) return;
    try {
      const snapshot = refreshViewerSession({
        resultId,
        catalogId,
        catalogRevision,
        orderedEntryIds: reconstructedResult.viewerEntryIds,
        activeEntryId: resolvedSession.snapshot.activeEntryId,
        availableEntryIds,
        selectedEntryIds,
      });
      const nextQuery = getLibraryResultQuery(resultId);
      if (nextQuery === null) throw new Error("The saved Library filters are no longer available.");
      setResolutionState({
        key: resolutionKey,
        value: {
          status: "exact",
          snapshot,
          query: nextQuery,
          message: snapshot.missingEntryIds.length > 0
            ? `Result refreshed. ${snapshot.missingEntryIds.length} photos are missing.`
            : "Library result refreshed.",
        },
      });
      setRefreshError(null);
      setRedirectNotice(null);
      if (snapshot.activeEntryId !== photoId) {
        router.replace(viewerPhotoHref(snapshot.activeEntryId, resultId));
      }
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "The Library result could not be refreshed.");
    }
  }

  const resultEntries = useMemo(() => {
    const byId = new Map<string, (typeof entries)[number]>(
      entries.filter((entry) => entry.health === "present").map((entry) => [entry.id, entry]),
    );
    return (resolvedSession?.snapshot?.orderedEntryIds ?? [])
      .map((id) => byId.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  }, [entries, resolvedSession?.snapshot?.orderedEntryIds]);

  const entry = useMemo(() => {
    if (!photoId) {
      return undefined;
    }
    return getEntryById(resultEntries, resolvedSession?.snapshot?.activeEntryId ?? photoId);
  }, [resultEntries, photoId, resolvedSession?.snapshot?.activeEntryId]);

  if (!photoId || !resultId) {
    return <ResultUnavailable message="This Develop link is incomplete. Return to Library and open the photo again." />;
  }

  if (!hasBootstrapped || resolvedSession === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-lr-toolbar text-sm text-lr-text-dim">
        Restoring Library result…
      </div>
    );
  }

  if (resolvedSession.snapshot === null) {
    return <ResultUnavailable message={resolvedSession.message} />;
  }

  if (!entry) {
    return <ResultUnavailable message="This photo is missing from the saved Library result. Return to Library to locate or re-link it." />;
  }

  return (
    <PhotoViewer
      entry={entry}
      entries={resultEntries}
      resultId={resolvedSession.snapshot.id}
      resultCatalogRevision={resolvedSession.snapshot.catalogRevision}
      resultEntryIds={resolvedSession.snapshot.orderedEntryIds}
      missingEntryIds={resolvedSession.snapshot.missingEntryIds}
      sessionMessage={
        refreshError ??
        (redirectNotice?.resultId === resultId ? redirectNotice.message : null) ??
        resolvedSession.message
      }
      onRefreshResult={refreshResult}
    />
  );
}

export default function PhotoPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-sm text-lr-text-dim">
          Loading...
        </div>
      }
    >
      <PhotoPageContent />
    </Suspense>
  );
}
