"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { PhotoViewer } from "@/components/viewer/PhotoViewer";
import { TopBar } from "@/components/shell/TopBar";
import { getEntryById, useLibraryStore } from "@/stores/library-store";

function PhotoPageContent() {
  const searchParams = useSearchParams();
  const entries = useLibraryStore((state) => state.entries);
  const photoId = searchParams.get("id");

  const entry = useMemo(() => {
    if (!photoId) {
      return undefined;
    }
    return getEntryById(entries, photoId);
  }, [entries, photoId]);

  if (!photoId) {
    return (
      <div className="flex h-screen flex-col">
        <TopBar activeModule="library" showBack />
        <div className="flex flex-1 items-center justify-center text-sm text-lr-text-muted">
          No photo selected.
        </div>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="flex h-screen flex-col">
        <TopBar activeModule="library" showBack />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm text-lr-text-muted">
            Photo not found in the current catalog.
          </p>
          <p className="text-xs text-lr-text-dim">
            Re-import the source folder from the Library module.
          </p>
        </div>
      </div>
    );
  }

  return <PhotoViewer entry={entry} entries={entries} />;
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
