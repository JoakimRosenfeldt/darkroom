"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { CompareView } from "@/components/viewer/CompareView";
import { useLibraryResult } from "@/hooks/useLibraryResult";
import { useLibraryStore } from "@/stores/library-store";

function ComparePageContent() {
  const searchParams = useSearchParams();
  const entries = useLibraryStore((state) => state.entries);
  const result = useLibraryResult();
  const ordered = useMemo(() => {
    const byId = new Map<string, (typeof entries)[number]>(entries.map((entry) => [entry.id, entry]));
    return result.viewerEntryIds.flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry] : [];
    });
  }, [entries, result.viewerEntryIds]);
  const select = ordered.find((entry) => entry.id === searchParams.get("select"));
  const candidate = ordered.find((entry) => entry.id === searchParams.get("candidate"));
  if (!select || !candidate || select.id === candidate.id) {
    return <main className="flex h-screen items-center justify-center bg-lr-toolbar text-sm text-lr-text-muted">Choose exactly two photos from the current Library view to compare.</main>;
  }
  return <CompareView select={select} candidate={candidate} entries={ordered} />;
}

export default function ComparePage() {
  return <Suspense fallback={<main className="flex h-screen items-center justify-center bg-lr-toolbar text-sm text-lr-text-muted">Opening Compare…</main>}><ComparePageContent /></Suspense>;
}
