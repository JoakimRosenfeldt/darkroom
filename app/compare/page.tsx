"use client";

import { Suspense, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CompareView } from "@/components/viewer/CompareView";
import { useLibraryResult } from "@/hooks/useLibraryResult";
import { useLibraryStore } from "@/stores/library-store";

function ComparePageContent() {
  const [searchParams] = useSearchParams();
  const entries = useLibraryStore((state) => state.entries);
  const result = useLibraryResult();
  const selectId = searchParams.get("select");
  const candidateId = searchParams.get("candidate");
  const pairKey = `${selectId ?? ""}|${candidateId ?? ""}`;
  const byId = new Map<string, (typeof entries)[number]>(entries.map((entry) => [entry.id, entry]));
  const liveOrdered = result.viewerEntryIds.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  const liveSelect = liveOrdered.find((entry) => entry.id === selectId);
  const liveCandidate = liveOrdered.find((entry) => entry.id === candidateId);
  // Freeze the pair and its ordering once resolved, so curation inside
  // Compare cannot evict a compared photo (HH-08) — but do not freeze an
  // unresolved first render (direct load before the catalog arrives).
  const [snapshot, setSnapshot] = useState<{
    key: string;
    ordered: typeof liveOrdered;
    select: (typeof entries)[number];
    candidate: (typeof entries)[number];
  } | null>(null);
  if (
    (snapshot === null || snapshot.key !== pairKey) &&
    liveSelect && liveCandidate && liveSelect.id !== liveCandidate.id
  ) {
    setSnapshot({ key: pairKey, ordered: liveOrdered, select: liveSelect, candidate: liveCandidate });
  }
  const active = snapshot !== null && snapshot.key === pairKey
    ? snapshot
    : liveSelect && liveCandidate && liveSelect.id !== liveCandidate.id
      ? { ordered: liveOrdered, select: liveSelect, candidate: liveCandidate }
      : null;
  const { ordered, select, candidate } = active ?? { ordered: [], select: undefined, candidate: undefined };
  if (!select || !candidate || select.id === candidate.id) {
    return <main className="flex h-screen flex-col items-center justify-center gap-4 bg-lr-toolbar text-sm text-lr-text-muted"><p>Choose exactly two photos from the current Library view to compare.</p><Link to="/" className="rounded border border-lr-border-subtle px-3 py-1.5 hover:text-lr-text">Back to Library</Link></main>;
  }
  return <CompareView select={select} candidate={candidate} entries={ordered} />;
}

export default function ComparePage() {
  return <Suspense fallback={<main className="flex h-screen items-center justify-center bg-lr-toolbar text-sm text-lr-text-muted">Opening Compare…</main>}><ComparePageContent /></Suspense>;
}
