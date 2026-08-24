"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { loadThumbnailBlob } from "@/lib/cache/thumbnail-cache";
import { COLOR_LABEL_HEX, getEntryMetadata } from "@/lib/catalog/defaults";
import { COLOR_LABELS } from "@/lib/catalog/types";
import type { LibraryEntry } from "@/lib/fs/types";
import { nextZoomPercent } from "@/lib/viewer/geometry";
import { useLibraryStore } from "@/stores/library-store";
import { ModuleSpine } from "@/components/shell/ModuleSpine";

export function CompareView({
  select,
  candidate,
  entries,
}: {
  select: LibraryEntry;
  candidate: LibraryEntry;
  entries: readonly LibraryEntry[];
}) {
  const router = useRouter();
  const metadata = useLibraryStore((state) => state.entryMetadata);
  const applyMetadata = useLibraryStore((state) => state.applyMetadataToEntries);
  const [candidateId, setCandidateId] = useState(candidate.id);
  const [activePane, setActivePane] = useState<"select" | "candidate">("candidate");
  const [linked, setLinked] = useState(true);
  const [selectZoom, setSelectZoom] = useState(100);
  const [candidateZoom, setCandidateZoom] = useState(100);
  const selectPaneRef = useRef<HTMLElement>(null);
  const candidatePaneRef = useRef<HTMLElement>(null);
  const syncingPanRef = useRef(false);
  const currentCandidate = entries.find((entry) => entry.id === candidateId) ?? candidate;
  const candidateIndex = entries.findIndex((entry) => entry.id === currentCandidate.id);
  const active = activePane === "select" ? select : currentCandidate;
  const activeMetadata = getEntryMetadata(metadata, active.id);

  function setZoom(percent: number) {
    if (linked || activePane === "select") setSelectZoom(percent);
    if (linked || activePane === "candidate") setCandidateZoom(percent);
  }

  function moveCandidate(direction: -1 | 1) {
    if (entries.length < 2) return;
    let index = candidateIndex;
    for (let checked = 0; checked < entries.length; checked += 1) {
      index = (index + direction + entries.length) % entries.length;
      const entry = entries[index];
      if (entry && entry.id !== select.id) {
        setCandidateId(entry.id);
        return;
      }
    }
  }

  function syncPan(source: "select" | "candidate", element: HTMLElement) {
    if (!linked || syncingPanRef.current) return;
    const target = source === "select" ? candidatePaneRef.current : selectPaneRef.current;
    if (!target) return;
    const sourceWidth = Math.max(1, element.scrollWidth - element.clientWidth);
    const sourceHeight = Math.max(1, element.scrollHeight - element.clientHeight);
    const targetWidth = Math.max(0, target.scrollWidth - target.clientWidth);
    const targetHeight = Math.max(0, target.scrollHeight - target.clientHeight);
    syncingPanRef.current = true;
    target.scrollLeft = (element.scrollLeft / sourceWidth) * targetWidth;
    target.scrollTop = (element.scrollTop / sourceHeight) * targetHeight;
    requestAnimationFrame(() => {
      syncingPanRef.current = false;
    });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-lr-toolbar">
      <ModuleSpine activeModule="develop" developPhotoId={select.id} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-lr-border-subtle bg-lr-toolbar px-4">
          <button type="button" onClick={() => router.push("/")} className="rounded border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:text-lr-text">
            Back to Library
          </button>
          <span className="ml-2 text-sm font-semibold text-lr-text">Compare</span>
          <button type="button" onClick={() => setLinked((value) => !value)} aria-pressed={linked} className={`rounded border px-2.5 py-1.5 text-xs ${linked ? "border-lr-accent bg-lr-selection text-lr-accent" : "border-lr-border-subtle text-lr-text-muted"}`}>
            {linked ? "Linked" : "Independent"}
          </button>
          <div className="ml-auto flex items-center gap-1 rounded border border-lr-border-subtle p-1">
            <button type="button" aria-label="Zoom out" onClick={() => setZoom(nextZoomPercent(activePane === "select" ? selectZoom : candidateZoom, -1))} className="px-2 text-lr-text-muted">−</button>
            <button type="button" onClick={() => setZoom(100)} className="w-12 font-mono text-[10px] text-lr-text-muted">{activePane === "select" ? selectZoom : candidateZoom}%</button>
            <button type="button" aria-label="Zoom in" onClick={() => setZoom(nextZoomPercent(activePane === "select" ? selectZoom : candidateZoom, 1))} className="px-2 text-lr-text-muted">+</button>
          </div>
          <button type="button" onClick={() => applyMetadata([active.id], { pick: "pick" })} className={`rounded px-2.5 py-1.5 text-xs ${activeMetadata.pick === "pick" ? "bg-lr-selection text-lr-accent" : "text-lr-text-muted"}`}>Pick</button>
          <button type="button" onClick={() => applyMetadata([active.id], { pick: "reject" })} className={`rounded px-2.5 py-1.5 text-xs ${activeMetadata.pick === "reject" ? "bg-red-950 text-red-300" : "text-lr-text-muted"}`}>Reject</button>
          {[1, 2, 3, 4, 5].map((rating) => (
            <button key={rating} type="button" aria-label={`Rate ${rating} stars`} onClick={() => applyMetadata([active.id], { rating: rating as 1 | 2 | 3 | 4 | 5 })} className={rating <= activeMetadata.rating ? "text-lr-accent" : "text-lr-border"}>★</button>
          ))}
          {COLOR_LABELS.map((label) => (
            <button
              key={label}
              type="button"
              aria-label={`${label} color label`}
              onClick={() => applyMetadata([active.id], { colorLabel: activeMetadata.colorLabel === label ? null : label })}
              className="h-3 w-3 rounded-sm border"
              style={{ backgroundColor: COLOR_LABEL_HEX[label], borderColor: activeMetadata.colorLabel === label ? "white" : "transparent" }}
            />
          ))}
        </header>
        <main className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-lr-border-subtle">
          <ComparePane
            key={`select-${select.id}`}
            label="Select"
            entry={select}
            zoom={selectZoom}
            active={activePane === "select"}
            onActivate={() => setActivePane("select")}
            paneRef={selectPaneRef}
            onScroll={(element) => syncPan("select", element)}
          />
          <ComparePane
            key={`candidate-${currentCandidate.id}`}
            label="Candidate"
            entry={currentCandidate}
            zoom={candidateZoom}
            active={activePane === "candidate"}
            onActivate={() => setActivePane("candidate")}
            paneRef={candidatePaneRef}
            onScroll={(element) => syncPan("candidate", element)}
          />
        </main>
        <footer className="flex h-12 shrink-0 items-center justify-center gap-3 border-t border-lr-border-subtle bg-lr-toolbar">
          <button type="button" onClick={() => moveCandidate(-1)} className="rounded border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:text-lr-text">Previous candidate</button>
          <span className="font-mono text-[10px] text-lr-text-faint">{Math.max(1, candidateIndex + 1)} / {entries.length}</span>
          <button type="button" onClick={() => moveCandidate(1)} className="rounded border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:text-lr-text">Next candidate</button>
        </footer>
      </div>
    </div>
  );
}

function ComparePane({
  label,
  entry,
  zoom,
  active,
  onActivate,
  paneRef,
  onScroll,
}: {
  label: string;
  entry: LibraryEntry;
  zoom: number;
  active: boolean;
  onActivate: () => void;
  paneRef: RefObject<HTMLElement | null>;
  onScroll: (element: HTMLElement) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useMemo(() => `${entry.id}:${entry.assetRevision}`, [entry.assetRevision, entry.id]);
  useEffect(() => {
    let activeRequest = true;
    let objectUrl: string | null = null;
    void loadThumbnailBlob(entry, 2000, { priority: 5 }).then((blob) => {
      if (!activeRequest) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }, (reason: unknown) => {
      if (activeRequest) setError(reason instanceof Error ? reason.message : "Preview unavailable.");
    });
    return () => {
      activeRequest = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry, requestKey]);

  return (
    <section
      ref={paneRef}
      onPointerDown={onActivate}
      onScroll={(event) => onScroll(event.currentTarget)}
      className={`relative min-w-0 overflow-auto bg-[#131110] ring-inset ${active ? "ring-2 ring-lr-accent" : ""}`}
      aria-label={`${label}: ${entry.name}`}
    >
      <div className="sticky left-0 top-0 z-10 flex h-10 items-center gap-2 bg-black/60 px-3 backdrop-blur">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-lr-accent">{label}</span>
        <span className="truncate font-mono text-xs text-lr-text">{entry.name}</span>
        <span className="ml-auto truncate font-mono text-[9px] text-lr-text-faint">{entry.relativePath}</span>
      </div>
      <div className="relative flex min-h-[calc(100%-40px)] min-w-full items-center justify-center p-8" style={{ width: `${Math.max(100, zoom)}%`, height: `${Math.max(100, zoom)}%` }}>
        {url ? (
          <Image src={url} alt={entry.name} fill unoptimized className="object-contain p-8" sizes="50vw" />
        ) : error ? (
          <p className="max-w-sm text-center text-sm text-lr-danger">{error}</p>
        ) : (
          <p className="text-xs text-lr-text-faint">Loading preview…</p>
        )}
      </div>
    </section>
  );
}
