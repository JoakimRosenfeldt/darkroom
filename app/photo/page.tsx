"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { PhotoViewer } from "@/components/viewer/PhotoViewer";
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
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-zinc-400">
        No photo selected. Return to the library and choose an image.
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-zinc-400">
        This photo is not available in the current library. Open the source
        folder again from the library page.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <PhotoViewer entry={entry} />
    </div>
  );
}

export default function PhotoPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl px-6 py-16 text-center text-zinc-500">
          Loading photo...
        </div>
      }
    >
      <PhotoPageContent />
    </Suspense>
  );
}
