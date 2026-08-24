"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { loadDevelopImage } from "@/lib/cache/develop-image-cache";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import type { LibraryEntry } from "@/lib/fs/types";
import { resolveDevelopDocument } from "@/lib/export/settings";
import { sourceSignatureForEntry } from "@/lib/develop/source-transform";
import type { DevelopDocument } from "@/lib/develop/types";
import { useLibraryStore } from "@/stores/library-store";
import { FIT_VIEWPORT_TRANSFORM, ImageViewport, type ImageViewportTransform } from "./ImageViewport";

export type ViewerSurfaceMode = "before-side" | "before-split" | "reference";

interface ViewerSurfaceProps {
  readonly mode: ViewerSurfaceMode;
  readonly entry: LibraryEntry;
  readonly image: DevelopImage;
  readonly document: DevelopDocument;
  readonly referenceEntry: LibraryEntry | null;
  readonly linked: boolean;
}

export function ViewerSurface({ mode, entry, image, document, referenceEntry, linked }: ViewerSurfaceProps) {
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const [primaryTransform, setPrimaryTransform] = useState<ImageViewportTransform>(FIT_VIEWPORT_TRANSFORM);
  const [secondaryTransform, setSecondaryTransform] = useState<ImageViewportTransform>(FIT_VIEWPORT_TRANSFORM);
  const [split, setSplit] = useState(50);
  const [referenceLoad, setReferenceLoad] = useState<{
    readonly entryId: string;
    readonly image: DevelopImage | null;
    readonly error: string | null;
  } | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const primarySignature = useMemo(() => sourceSignatureForEntry(entry), [entry]);
  const referenceDocument = referenceEntry ? resolveDevelopDocument(null, getEntryMetadata(entryMetadata, referenceEntry.id)) : null;
  const referenceSignature = useMemo(() => referenceEntry ? sourceSignatureForEntry(referenceEntry) : null, [referenceEntry]);

  useEffect(() => {
    let active = true;
    if (!referenceEntry) return () => { active = false; };
    void loadDevelopImage(referenceEntry).then(
      (loaded) => { if (active) setReferenceLoad({ entryId: referenceEntry.id, image: loaded, error: null }); },
      (loadError: unknown) => { if (active) setReferenceLoad({ entryId: referenceEntry.id, image: null, error: loadError instanceof Error ? loadError.message : "Reference preview is unavailable." }); },
    );
    return () => { active = false; };
  }, [referenceEntry]);

  function primaryChange(next: ImageViewportTransform) {
    setPrimaryTransform(next);
    if (linked) setSecondaryTransform(next);
  }

  function secondaryChange(next: ImageViewportTransform) {
    setSecondaryTransform(next);
    if (linked) setPrimaryTransform(next);
  }

  function setSplitFromPointer(clientX: number) {
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setSplit(Math.min(95, Math.max(5, ((clientX - bounds.left) / bounds.width) * 100)));
  }

  if (mode === "before-split") {
    return (
      <div ref={splitRef} className="relative h-full min-h-0 overflow-hidden" onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setSplitFromPointer(event.clientX); }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
        <ImageViewport image={image} document={document} sourceSignature={primarySignature} original={false} label="After" transform={primaryTransform} onTransformChange={primaryChange} />
        <div className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          <div className="pointer-events-auto h-full">
            <ImageViewport image={image} document={document} sourceSignature={primarySignature} original label="Before" transform={primaryTransform} onTransformChange={primaryChange} />
          </div>
        </div>
        <button type="button" role="slider" aria-label="Before and after split" aria-valuemin={5} aria-valuemax={95} aria-valuenow={Math.round(split)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setSplit((value) => Math.max(5, value - 2)); else if (event.key === "ArrowRight") setSplit((value) => Math.min(95, value + 2)); else if (event.key === "Home") setSplit(5); else if (event.key === "End") setSplit(95); }} onPointerDown={(event) => { event.currentTarget.parentElement?.setPointerCapture(event.pointerId); setSplitFromPointer(event.clientX); }} className="absolute inset-y-0 z-30 w-8 -translate-x-1/2 cursor-col-resize outline-none" style={{ left: `${split}%` }}>
          <span className="absolute inset-y-0 left-1/2 w-px bg-white/80 shadow-[0_0_8px_rgba(0,0,0,.8)]" />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40 bg-black/75 px-1.5 py-3 text-[9px] text-white">↔</span>
        </button>
      </div>
    );
  }

  if (mode === "reference") {
    const loadedReference = referenceLoad?.entryId === referenceEntry?.id ? referenceLoad : null;
    const referenceImage = loadedReference?.image ?? null;
    const referenceError = loadedReference?.error ?? null;
    return (
      <div className="grid h-full min-h-0 grid-cols-2 gap-px bg-lr-border-subtle">
        <ImageViewport image={image} document={document} sourceSignature={primarySignature} original={false} label={`Active · ${entry.name}`} transform={primaryTransform} onTransformChange={primaryChange} />
        {referenceEntry && referenceImage && referenceDocument && referenceSignature ? (
          <ImageViewport image={referenceImage} document={referenceDocument} sourceSignature={referenceSignature} original={false} label={`Reference · ${referenceEntry.name}`} transform={secondaryTransform} onTransformChange={secondaryChange} />
        ) : (
          <div className="flex h-full items-center justify-center bg-[#100f0e] px-8 text-center text-xs text-lr-text-faint">{referenceError ?? "Choose a reference from the filmstrip, then navigate to another photo."}</div>
        )}
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-px bg-lr-border-subtle">
      <ImageViewport image={image} document={document} sourceSignature={primarySignature} original label="Before" transform={secondaryTransform} onTransformChange={secondaryChange} />
      <ImageViewport image={image} document={document} sourceSignature={primarySignature} original={false} label="After" transform={primaryTransform} onTransformChange={primaryChange} />
    </div>
  );
}
