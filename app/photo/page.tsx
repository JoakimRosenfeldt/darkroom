"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { PhotoViewer } from "@/components/viewer/PhotoViewer";
import { ModuleSpine } from "@/components/shell/ModuleSpine";
import { useLibraryResult } from "@/hooks/useLibraryResult";
import { getEntryById, useLibraryStore } from "@/stores/library-store";

function PhotoPageContent() {
  const searchParams = useSearchParams();
  const entries = useLibraryStore((state) => state.entries);
  const photoId = searchParams.get("id");
  const libraryResult = useLibraryResult();
  const resultEntries = useMemo(() => {
    const byId = new Map<string, (typeof entries)[number]>(
      entries.map((entry) => [entry.id, entry]),
    );
    return libraryResult.viewerEntryIds
      .map((id) => byId.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  }, [entries, libraryResult.viewerEntryIds]);

  const entry = useMemo(() => {
    if (!photoId) {
      return undefined;
    }
    return getEntryById(resultEntries, photoId);
  }, [resultEntries, photoId]);

  if (!photoId) {
    return (
      <div className="flex h-screen bg-lr-toolbar">
        <ModuleSpine activeModule="library" />
        <main className="flex flex-1 items-center justify-center text-sm text-lr-text-muted">
          No photo selected.
        </main>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="flex h-screen bg-lr-toolbar">
        <ModuleSpine activeModule="library" />
        <main className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm text-lr-text-muted">
            Photo not found in the current catalog.
          </p>
          <p className="text-xs text-lr-text-dim">
            Open or re-link the catalog from the Library module.
          </p>
        </main>
      </div>
    );
  }

  return <PhotoViewer entry={entry} entries={resultEntries} />;
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
