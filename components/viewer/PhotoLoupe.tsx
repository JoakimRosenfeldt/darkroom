"use client";

import { useEffect, useRef, useState } from "react";
import { disposeDevelopImage, loadDevelopExportImage, type DevelopImage } from "@/lib/cache/develop-image-cache";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import { buildV3SourceRecord, loadV3PreviewMaskMattes, resolveV3ExportDimensions } from "@/lib/develop/v3/runtime";
import { V3PreviewWorkerClient } from "@/lib/develop/v3/preview-worker-client";
import type { LibraryEntry } from "@/lib/fs/types";

export interface LoupePosition { x: number; y: number }

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
  const [localPosition, setLocalPosition] = useState({ x: 0.5, y: 0.5 });
  const center = position ?? localPosition;
  const [viewport, setViewport] = useState({ width: 1, height: 1, dpr: 1 });
  const [source, setSource] = useState<{ image: DevelopImage; worker: V3PreviewWorkerClient } | null>(null);
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
      setSource({ image: loaded, worker });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Full-resolution photo unavailable.");
    });
    return () => { controller.abort(); worker?.dispose(); if (image) disposeDevelopImage(image); };
  }, [entry]);

  useEffect(() => {
    if (!source || viewport.width < 2 || viewport.height < 2) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      setStatus("Rendering detail…");
      void (async () => {
        const record = buildV3SourceRecord(entry, source.image, "export");
        if (record.kind !== "source") throw new Error("Source color information is unavailable.");
        const dimensions = resolveV3ExportDimensions(document, record.source, { mode: "original" });
        if (!dimensions) throw new Error("This photo exceeds the supported full-resolution size.");
        dimensionsRef.current = dimensions;
        const width = Math.min(dimensions.width, Math.max(1, Math.round(viewport.width * viewport.dpr)));
        const height = Math.min(dimensions.height, Math.max(1, Math.round(viewport.height * viewport.dpr)));
        const x = Math.max(0, Math.min(dimensions.width - width, Math.round(center.x * dimensions.width - width / 2)));
        const y = Math.max(0, Math.min(dimensions.height - height, Math.round(center.y * dimensions.height - height / 2)));
        const mattes = await loadV3PreviewMaskMattes(document, entry, source.image);
        if (!active) return;
        const { result } = await source.worker.renderExport(document, { mode: "original" }, mattes, { x, y, width, height });
        if (!active) return;
        if (result.kind === "cancelled") return;
        if (result.kind !== "rendered" || "bitmap" in result) throw new Error("The saved edit could not be rendered at 1:1.");
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width / viewport.dpr}px`;
        canvas.style.height = `${height / viewport.dpr}px`;
        canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(result.pixels.pixels), width, height), 0, 0);
        setStatus("");
      })().catch((error: unknown) => {
        if (active) setStatus(error instanceof Error ? error.message : "Detail unavailable.");
      });
    }, 60);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [source, entry, document, viewport, center.x, center.y]);

  return <div ref={containerRef} className="absolute inset-0 z-30 flex cursor-grab items-center justify-center overflow-hidden bg-[#131110] active:cursor-grabbing"
    aria-label="100 percent detail; drag to pan" aria-busy={status !== ""}
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
    <canvas ref={canvasRef} role="img" aria-label={`${entry.name}, full-resolution edited detail`} style={{ imageRendering: "pixelated" }} />
    {status ? <p role="status" className="absolute bottom-4 max-w-lg rounded bg-black/80 px-3 py-2 text-center text-xs text-white">{status}</p> : null}
  </div>;
}
