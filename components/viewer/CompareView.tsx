"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { loadThumbnailBlob } from "@/lib/cache/thumbnail-cache";
import { COLOR_LABEL_HEX, getEntryMetadata } from "@/lib/catalog/defaults";
import { COLOR_LABELS } from "@/lib/catalog/types";
import type { LibraryEntry } from "@/lib/fs/types";
import { PhotoLoupe, type LoupePosition } from "./PhotoLoupe";
import { decodePersistedDevelopDocument } from "@/lib/develop/v3/codec";
import { createDefaultV3DevelopDocument } from "@/lib/develop/v3/document";
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
  const [selectZoom, setSelectZoom] = useState(0);
  const [candidateZoom, setCandidateZoom] = useState(0);
  const [selectPosition, setSelectPosition] = useState<LoupePosition>({ x: 0.5, y: 0.5 });
  const [candidatePosition, setCandidatePosition] = useState<LoupePosition>({ x: 0.5, y: 0.5 });
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
            <button type="button" onClick={() => setZoom(0)} aria-pressed={(activePane === "select" ? selectZoom : candidateZoom) === 0} className="px-2 text-xs text-lr-text">Fit</button>
            <button type="button" onClick={() => setZoom(100)} aria-pressed={(activePane === "select" ? selectZoom : candidateZoom) === 100} className="px-2 text-xs text-lr-text">100%</button>
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
            position={selectPosition}
            onPositionChange={(value) => { setSelectPosition(value); if (linked) setCandidatePosition(value); }}
            active={activePane === "select"}
            onActivate={() => setActivePane("select")}
          />
          <ComparePane
            key={`candidate-${currentCandidate.id}`}
            label="Candidate"
            entry={currentCandidate}
            zoom={candidateZoom}
            position={candidatePosition}
            onPositionChange={(value) => { setCandidatePosition(value); if (linked) setSelectPosition(value); }}
            active={activePane === "candidate"}
            onActivate={() => setActivePane("candidate")}
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
  position,
  onPositionChange,
  active,
  onActivate,
}: {
  label: string;
  entry: LibraryEntry;
  zoom: number;
  position: LoupePosition;
  onPositionChange: (position: LoupePosition) => void;
  active: boolean;
  onActivate: () => void;
}) {
  const [preview, setPreview] = useState<{ url: string; document: unknown } | null>(null);
  const developDocument = useLibraryStore((state) => state.entryMetadata[entry.id]?.develop ?? null);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useMemo(() => `${entry.id}:${entry.assetRevision}`, [entry.assetRevision, entry.id]);
  useEffect(() => {
    let activeRequest = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    void loadThumbnailBlob(entry, 2000, { priority: 50, document: developDocument, signal: controller.signal }).then((blob) => {
      if (!activeRequest) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview({ url: objectUrl, document: developDocument });
      setError(null);
    }, (reason: unknown) => {
      if (activeRequest) setError(reason instanceof Error ? reason.message : "Preview unavailable.");
    });
    return () => {
      activeRequest = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry, requestKey, developDocument]);

  const url = preview?.document === developDocument ? preview.url : null;
  const decoded = useMemo(() => decodePersistedDevelopDocument(developDocument ?? createDefaultV3DevelopDocument()), [developDocument]);

  return (
    <section
      onPointerDownCapture={onActivate}
      className={`relative min-w-0 overflow-hidden bg-[#131110] ring-inset ${active ? "ring-2 ring-lr-accent" : ""}`}
      aria-label={`${label}: ${entry.name}`}
    >
      <div className="sticky left-0 top-0 z-10 flex h-10 items-center gap-2 bg-black/60 px-3 backdrop-blur">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-lr-accent">{label}</span>
        <span className="truncate font-mono text-xs text-lr-text">{entry.name}</span>
        <span className="ml-auto truncate font-mono text-[9px] text-lr-text-faint">{entry.relativePath}</span>
      </div>
      <div className="relative flex min-h-[calc(100%-40px)] min-w-full items-center justify-center p-8" style={{ height: "calc(100% - 40px)" }}>
        {zoom === 100 && decoded.kind === "editable" && decoded.document.version === 3 ? <PhotoLoupe entry={entry} document={decoded.document} position={position} onPositionChange={onPositionChange} /> : zoom === 100 ? <p className="text-sm text-lr-text">Open this legacy edit in Develop to enable full-resolution comparison.</p> : url ? (
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
