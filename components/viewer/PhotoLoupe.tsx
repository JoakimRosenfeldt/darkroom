"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { disposeDevelopImage, loadDevelopExportImage, type DevelopImage } from "@/lib/cache/develop-image-cache";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import { buildV3SourceRecord, loadV3PreviewMaskMattes, resolveV3ExportDimensions } from "@/lib/develop/v3/runtime";
import { V3PreviewWorkerClient } from "@/lib/develop/v3/preview-worker-client";
import type { V3PreviewBackend } from "@/lib/develop/v3/preview-worker-types";
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


export function PhotoLoupe({ entry, document, position, onPositionChange, displaySize, onDimensions, passive = false, panning = false }: {
  entry: LibraryEntry;
  document: DevelopDocumentV3;
  position?: LoupePosition;
  onPositionChange?: (position: LoupePosition) => void;
  displaySize?: { width: number; height: number };
  onDimensions?: (dimensions: { width: number; height: number }) => void;
  passive?: boolean;
  panning?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; position: LoupePosition } | null>(null);
  const dimensionsRef = useRef({ width: 1, height: 1 });
  const scheduleRef = useRef<((document: DevelopDocumentV3, center: LoupePosition, interactive: boolean, displayWidth: number | undefined, panning: boolean) => void) | null>(null);
  const interactive = useDevelopStore((state) =>
    state.activeCatalogId === entry.catalogId && Boolean(state.sessions[entry.id]?.transientEdit),
  );
  const [localPosition, setLocalPosition] = useState({ x: 0.5, y: 0.5 });
  const center = position ?? localPosition;
  const [viewport, setViewport] = useState({ width: 1, height: 1, dpr: 1 });
  const [source, setSource] = useState<{ entry: LibraryEntry; image: DevelopImage; worker: V3PreviewWorkerClient } | null>(null);
  const [renderedSource, setRenderedSource] = useState<typeof source>(null);
  const [loadReady, setLoadReady] = useState(!passive);
  const [paintedRegion, setPaintedRegion] = useState<{
    x: number; y: number; width: number; height: number;
    dimensions: { width: number; height: number };
    viewport: typeof viewport;
    geometry: string;
    cssScale: number;
    displayWidth: number | undefined;
  } | null>(null);
  const [status, setStatus] = useState("Loading full-resolution photo…");
  const reportDimensions = useEffectEvent((dimensions: { width: number; height: number }) => onDimensions?.(dimensions));
  const displayWidth = displaySize?.width;

  useEffect(() => {
    if (loadReady || !passive || panning) return;
    const timer = setTimeout(() => setLoadReady(true), 200);
    return () => clearTimeout(timer);
  }, [loadReady, passive, panning, displayWidth]);

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
    if (!loadReady) return;
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
  }, [entry, loadReady]);

  useEffect(() => {
    if (!source || source.entry !== entry || viewport.width < 2 || viewport.height < 2) return;
    let active = true;
    let rendering = false;
    let animationFrame = 0;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let pending: { document: DevelopDocumentV3; center: LoupePosition; interactive: boolean; displayWidth: number | undefined } | null = null;
    let backend: V3PreviewBackend | null = null;
    let maskMattes: { key: string; value: ReturnType<typeof loadV3PreviewMaskMattes> } | null = null;

    const scheduleRender = (): void => {
      if (!active || !pending) return;
      if (passive) {
        if (quietTimer !== null) clearTimeout(quietTimer);
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        quietTimer = setTimeout(() => {
          quietTimer = null;
          if (!active || rendering || animationFrame || !pending) return;
          animationFrame = requestAnimationFrame(() => { void renderLatest(); });
        }, 120);
      } else if (!rendering && !animationFrame) {
        animationFrame = requestAnimationFrame(() => { void renderLatest(); });
      }
    };

    const renderLatest = async (): Promise<void> => {
      animationFrame = 0;
      const request = pending;
      pending = null;
      if (!active || !request) return;
      rendering = true;
      try {
        const { document, center, interactive, displayWidth: requestedDisplayWidth } = request;
        const record = buildV3SourceRecord(entry, source.image, "export");
        if (record.kind !== "source") throw new Error("Source color information is unavailable.");
        const dimensions = resolveV3ExportDimensions(document, record.source, { mode: "original" });
        if (!dimensions) throw new Error("This photo exceeds the supported full-resolution size.");
        reportDimensions(dimensions);
        const cssScale = requestedDisplayWidth === undefined ? 1 / viewport.dpr : requestedDisplayWidth / dimensions.width;
        const pixels = viewport.width * viewport.height * viewport.dpr ** 2;
        const draftScale = interactive && backend !== "gpu" ? Math.min(1, Math.sqrt(64_000 / pixels)) : 1;
        const renderScale = Math.min(1, cssScale * viewport.dpr) * draftScale;
        const size: ExportSizeOptions = renderScale < 1
          ? { mode: "long-edge", pixels: Math.max(1, Math.round(Math.max(dimensions.width, dimensions.height) * renderScale)) }
          : { mode: "original" };
        const renderDimensions = resolveV3ExportDimensions(document, record.source, size);
        if (!renderDimensions) throw new Error("The detail preview dimensions are unavailable.");
        const renderedCssScale = cssScale * dimensions.width / renderDimensions.width;
        const renderWidth = Math.min(renderDimensions.width, Math.max(1, Math.round(viewport.width / renderedCssScale)));
        const renderHeight = Math.min(renderDimensions.height, Math.max(1, Math.round(viewport.height / renderedCssScale)));
        const renderOrigin = regionOrigin(center, renderDimensions, renderWidth, renderHeight);
        const matteKey = JSON.stringify(document.local.maskAssetRefs);
        if (maskMattes?.key !== matteKey) {
          maskMattes = { key: matteKey, value: loadV3PreviewMaskMattes(document, entry, source.image) };
        }
        const mattes = await maskMattes.value;
        if (!active) return;
        const rendered = await source.worker.renderExport(document, size, mattes, { ...renderOrigin, width: renderWidth, height: renderHeight });
        const { result } = rendered;
        backend = rendered.backend;
        if (!active) return;
        if (result.kind === "cancelled") return;
        if (result.kind !== "rendered" || "bitmap" in result) throw new Error("The saved edit could not be rendered at 1:1.");
        const canvas = canvasRef.current;
        if (!canvas) return;
        dimensionsRef.current = dimensions;
        if (canvas.width !== renderWidth) canvas.width = renderWidth;
        if (canvas.height !== renderHeight) canvas.height = renderHeight;
        canvas.style.width = `${renderWidth * renderedCssScale}px`;
        canvas.style.height = `${renderHeight * renderedCssScale}px`;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Detail canvas rendering is unavailable.");
        const rgba = result.pixels.pixels;
        const imageData = new ImageData(rgba.buffer instanceof ArrayBuffer
          ? new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength)
          : new Uint8ClampedArray(rgba), renderWidth, renderHeight);
        context.putImageData(imageData, 0, 0);
        setRenderedSource(source);
        setPaintedRegion({ ...renderOrigin, width: renderWidth, height: renderHeight, dimensions: renderDimensions, viewport, cssScale: renderedCssScale, displayWidth: requestedDisplayWidth, geometry: JSON.stringify([document.geometry, document.optics.manualDistortion]) });
        setStatus("");
      } catch (error: unknown) {
        if (active && !pending) setStatus(error instanceof Error ? error.message : "Detail unavailable.");
      } finally {
        rendering = false;
        if (active && pending) scheduleRender();
      }
    };

    scheduleRef.current = (document, center, interactive, displayWidth, isPanning) => {
      if (passive && isPanning) {
        pending = null;
        if (quietTimer !== null) clearTimeout(quietTimer);
        quietTimer = null;
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = 0;
        return;
      }
      pending = { document, center, interactive, displayWidth };
      scheduleRender();
    };
    return () => {
      active = false;
      pending = null;
      cancelAnimationFrame(animationFrame);
      if (quietTimer !== null) clearTimeout(quietTimer);
      scheduleRef.current = null;
    };
  }, [source, entry, viewport, passive]);

  useEffect(() => {
    scheduleRef.current?.(document, center, interactive, displayWidth, panning);
  }, [source, entry, document, viewport, center, interactive, displayWidth, panning]);

  const sourceReady = source?.entry === entry && renderedSource === source;
  const visibleStatus = sourceReady ? status : status || "Loading full-resolution photo…";
  const geometry = JSON.stringify([document.geometry, document.optics.manualDistortion]);
  const desiredPassiveOrigin = paintedRegion
    ? regionOrigin(center, paintedRegion.dimensions, paintedRegion.width, paintedRegion.height)
    : null;
  const stalePassiveLoupe = passive && (panning || !sourceReady || !paintedRegion || paintedRegion.displayWidth !== displayWidth || paintedRegion.viewport !== viewport || paintedRegion.geometry !== geometry || !desiredPassiveOrigin || paintedRegion.x !== desiredPassiveOrigin.x || paintedRegion.y !== desiredPassiveOrigin.y);
  const canTranslate = sourceReady && paintedRegion &&
    paintedRegion.viewport === viewport && paintedRegion.geometry === JSON.stringify([document.geometry, document.optics.manualDistortion]);
  const desiredOrigin = canTranslate
    ? regionOrigin(center, paintedRegion.dimensions, paintedRegion.width, paintedRegion.height)
    : null;
  const translation = !passive && desiredOrigin && paintedRegion
    ? { x: (paintedRegion.x - desiredOrigin.x) * paintedRegion.cssScale, y: (paintedRegion.y - desiredOrigin.y) * paintedRegion.cssScale }
    : { x: 0, y: 0 };

  return <div ref={containerRef} className={`absolute inset-0 z-30 flex items-center justify-center overflow-hidden ${passive || stalePassiveLoupe ? "bg-transparent" : "bg-[#131110]"} ${passive ? "pointer-events-none" : "cursor-grab active:cursor-grabbing"}`}
    aria-label={displaySize ? "Full-resolution detail" : "100 percent detail; drag to pan"} aria-busy={!sourceReady || stalePassiveLoupe || status !== ""}
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
    <canvas ref={canvasRef} role="img" aria-label={`${entry.name}, full-resolution edited detail`} className={passive ? "transition-opacity duration-[120ms] ease-out motion-reduce:transition-none" : undefined} style={{ imageRendering: "pixelated", visibility: sourceReady && !stalePassiveLoupe ? "visible" : "hidden", opacity: passive && stalePassiveLoupe ? 0 : 1, transform: `translate(${translation.x}px, ${translation.y}px)` }} />
    {visibleStatus ? <p role="status" className="absolute bottom-4 max-w-lg rounded bg-black/80 px-3 py-2 text-center text-xs text-white">{visibleStatus}</p> : null}
  </div>;
}
