"use client";

import { useEffect, useRef, useState } from "react";
import { disposeDevelopImage, loadDevelopExportImage, type DevelopImage } from "@/lib/cache/develop-image-cache";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import { buildV3SourceRecord, loadV3PreviewMaskMattes, resolveV3ExportDimensions } from "@/lib/develop/v3/runtime";
import { V3PreviewWorkerClient } from "@/lib/develop/v3/preview-worker-client";
import { useDevelopStore } from "@/stores/develop-store";
import type { ExportSizeOptions } from "@/lib/export/types";
import type { LibraryEntry } from "@/lib/fs/types";

export interface LoupePosition { x: number; y: number }

function regionOrigin(center: LoupePosition, dimensions: { width: number; height: number }, width: number, height: number) {
  return {
    x: Math.max(0, Math.min(dimensions.width - width, Math.round(center.x * dimensions.width - width / 2))),
    y: Math.max(0, Math.min(dimensions.height - height, Math.round(center.y * dimensions.height - height / 2))),
  };
}


export function PhotoLoupe({ entry, document, position, onPositionChange }: {
  entry: LibraryEntry;
  document: DevelopDocumentV3;
  position?: LoupePosition;
  onPositionChange?: (position: LoupePosition) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; position: LoupePosition } | null>(null);
  const dimensionsRef = useRef({ width: 1, height: 1 });
  const scheduleRef = useRef<((document: DevelopDocumentV3, center: LoupePosition, interactive: boolean) => void) | null>(null);
  const interactive = useDevelopStore((state) =>
    state.activeCatalogId === entry.catalogId && Boolean(state.sessions[entry.id]?.transientEdit),
  );
  const [localPosition, setLocalPosition] = useState({ x: 0.5, y: 0.5 });
  const center = position ?? localPosition;
  const [viewport, setViewport] = useState({ width: 1, height: 1, dpr: 1 });
  const [source, setSource] = useState<{ entry: LibraryEntry; image: DevelopImage; worker: V3PreviewWorkerClient } | null>(null);
  const [renderedSource, setRenderedSource] = useState<typeof source>(null);
  const [paintedRegion, setPaintedRegion] = useState<{
    x: number; y: number; width: number; height: number;
    dimensions: { width: number; height: number };
    viewport: typeof viewport;
    geometry: string;
  } | null>(null);
  const [status, setStatus] = useState("Loading full-resolution photo…");

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight, dpr: window.devicePixelRatio || 1 });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let worker: V3PreviewWorkerClient | undefined;
    let image: DevelopImage | undefined;
    void loadDevelopExportImage(entry, { rawColorMode: "libraw-camera-matrix", signal: controller.signal }).then((loaded) => {
      image = loaded;
      if (controller.signal.aborted) { disposeDevelopImage(loaded); return; }
      if (loaded.pixelProvenance.decoderPath === "embedded-preview") throw new Error("Full RAW decoding failed. An embedded preview cannot show 1:1 detail.");
      worker = new V3PreviewWorkerClient(entry, loaded);
      setSource({ entry, image: loaded, worker });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Full-resolution photo unavailable.");
    });
    return () => { controller.abort(); worker?.dispose(); if (image) disposeDevelopImage(image); };
  }, [entry]);

  useEffect(() => {
    if (!source || source.entry !== entry || viewport.width < 2 || viewport.height < 2) return;
    let active = true;
    let rendering = false;
    let animationFrame = 0;
    let pending: { document: DevelopDocumentV3; center: LoupePosition; interactive: boolean } | null = null;
    let exactLocalKey: string | null = null;
    let draftCanvas: OffscreenCanvas | null = null;

    const renderLatest = async (): Promise<void> => {
      animationFrame = 0;
      const request = pending;
      pending = null;
      if (!active || !request) return;
      rendering = true;
      try {
        const { document, center, interactive } = request;
        const record = buildV3SourceRecord(entry, source.image, "export");
        if (record.kind !== "source") throw new Error("Source color information is unavailable.");
        const dimensions = resolveV3ExportDimensions(document, record.source, { mode: "original" });
        if (!dimensions) throw new Error("This photo exceeds the supported full-resolution size.");
        const width = Math.min(dimensions.width, Math.max(1, Math.round(viewport.width * viewport.dpr)));
        const height = Math.min(dimensions.height, Math.max(1, Math.round(viewport.height * viewport.dpr)));
        const { x, y } = regionOrigin(center, dimensions, width, height);
        const localKey = JSON.stringify(document.local);
        const draft = interactive && localKey !== exactLocalKey && width * height > 64_000;
        const size: ExportSizeOptions = draft
          ? { mode: "long-edge", pixels: Math.max(1, Math.round(Math.max(dimensions.width, dimensions.height) * Math.sqrt(64_000 / (width * height)))) }
          : { mode: "original" };
        const renderDimensions = resolveV3ExportDimensions(document, record.source, size);
        if (!renderDimensions) throw new Error("The detail preview dimensions are unavailable.");
        const renderWidth = Math.max(1, Math.round(width * renderDimensions.width / dimensions.width));
        const renderHeight = Math.max(1, Math.round(height * renderDimensions.height / dimensions.height));
        const renderOrigin = regionOrigin(center, renderDimensions, renderWidth, renderHeight);
        const mattes = await loadV3PreviewMaskMattes(document, entry, source.image);
        if (!active) return;
        const { result } = await source.worker.renderExport(document, size, mattes, { ...renderOrigin, width: renderWidth, height: renderHeight });
        if (!active) return;
        if (result.kind === "cancelled") return;
        if (result.kind !== "rendered" || "bitmap" in result) throw new Error("The saved edit could not be rendered at 1:1.");
        const canvas = canvasRef.current;
        if (!canvas) return;
        dimensionsRef.current = dimensions;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        canvas.style.width = `${width / viewport.dpr}px`;
        canvas.style.height = `${height / viewport.dpr}px`;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Detail canvas rendering is unavailable.");
        const pixels = new ImageData(new Uint8ClampedArray(result.pixels.pixels), renderWidth, renderHeight);
        if (draft) {
          draftCanvas ??= new OffscreenCanvas(renderWidth, renderHeight);
          draftCanvas.width = renderWidth;
          draftCanvas.height = renderHeight;
          draftCanvas.getContext("2d")?.putImageData(pixels, 0, 0);
          context.clearRect(0, 0, width, height);
          context.drawImage(draftCanvas, 0, 0, width, height);
        } else {
          context.putImageData(pixels, 0, 0);
          exactLocalKey = localKey;
        }
        setRenderedSource(source);
        setPaintedRegion({ x, y, width, height, dimensions, viewport, geometry: JSON.stringify([document.geometry, document.optics.manualDistortion]) });
        setStatus("");
      } catch (error: unknown) {
        if (active && !pending) setStatus(error instanceof Error ? error.message : "Detail unavailable.");
      } finally {
        rendering = false;
        if (active && pending) animationFrame = requestAnimationFrame(() => { void renderLatest(); });
      }
    };

    scheduleRef.current = (document, center, interactive) => {
      pending = { document, center, interactive };
      if (!rendering && !animationFrame) {
        animationFrame = requestAnimationFrame(() => { void renderLatest(); });
      }
    };
    return () => {
      active = false;
      pending = null;
      cancelAnimationFrame(animationFrame);
      scheduleRef.current = null;
    };
  }, [source, entry, viewport]);

  useEffect(() => {
    scheduleRef.current?.(document, center, interactive);
  }, [source, entry, document, viewport, center, interactive]);

  const sourceReady = source?.entry === entry && renderedSource === source;
  const visibleStatus = sourceReady ? status : status || "Loading full-resolution photo…";
  const canTranslate = sourceReady && paintedRegion &&
    paintedRegion.viewport === viewport && paintedRegion.geometry === JSON.stringify([document.geometry, document.optics.manualDistortion]);
  const desiredOrigin = canTranslate
    ? regionOrigin(center, paintedRegion.dimensions, paintedRegion.width, paintedRegion.height)
    : null;
  const translation = desiredOrigin && paintedRegion
    ? { x: (paintedRegion.x - desiredOrigin.x) / viewport.dpr, y: (paintedRegion.y - desiredOrigin.y) / viewport.dpr }
    : { x: 0, y: 0 };

  return <div ref={containerRef} className="absolute inset-0 z-30 flex cursor-grab items-center justify-center overflow-hidden bg-[#131110] active:cursor-grabbing"
    aria-label="100 percent detail; drag to pan" aria-busy={!sourceReady || status !== ""}
    onWheel={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => {
      event.stopPropagation();
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { x: event.clientX, y: event.clientY, position: center };
    }}
    onPointerMove={(event) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dimensions = dimensionsRef.current;
      const halfX = Math.min(0.5, viewport.width * viewport.dpr / dimensions.width / 2);
      const halfY = Math.min(0.5, viewport.height * viewport.dpr / dimensions.height / 2);
      const next = {
        x: Math.max(halfX, Math.min(1 - halfX, drag.position.x - (event.clientX - drag.x) * viewport.dpr / dimensions.width)),
        y: Math.max(halfY, Math.min(1 - halfY, drag.position.y - (event.clientY - drag.y) * viewport.dpr / dimensions.height)),
      };
      setLocalPosition(next);
      onPositionChange?.(next);
    }}
    onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
    <canvas ref={canvasRef} role="img" aria-label={`${entry.name}, full-resolution edited detail`} style={{ imageRendering: "pixelated", visibility: sourceReady ? "visible" : "hidden", transform: `translate(${translation.x}px, ${translation.y}px)` }} />
    {visibleStatus ? <p role="status" className="absolute bottom-4 max-w-lg rounded bg-black/80 px-3 py-2 text-center text-xs text-white">{visibleStatus}</p> : null}
  </div>;
}
