"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { DevelopRenderer } from "@/lib/develop/renderer";
import type { DevelopDocument, SourceSignature } from "@/lib/develop/types";

export interface ImageViewportTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const FIT_VIEWPORT_TRANSFORM: ImageViewportTransform = { scale: 1, x: 0, y: 0 };

interface ImageViewportProps {
  readonly image: DevelopImage;
  readonly document: DevelopDocument;
  readonly sourceSignature: SourceSignature;
  readonly original: boolean;
  readonly label: string;
  readonly transform: ImageViewportTransform;
  readonly onTransformChange: (transform: ImageViewportTransform) => void;
  readonly className?: string;
}

export function ImageViewport({ image, document, sourceSignature, original, label, transform, onTransformChange, className = "" }: ImageViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<DevelopRenderer | null>(null);
  const documentRef = useRef(document);
  const dragRef = useRef<{ readonly pointerId: number; readonly startX: number; readonly startY: number; readonly x: number; readonly y: number } | null>(null);
  const requestRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stableSignature = useMemo(() => ({ ...sourceSignature }), [sourceSignature]);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    setReady(false);
    setError(null);
    const renderer = new DevelopRenderer(canvas);
    rendererRef.current = renderer;
    void (async () => {
      try {
        await renderer.setImage(image);
        if (!active) return;
        await renderer.prepare(documentRef.current, stableSignature, "preview");
        if (active) setReady(true);
      } catch (loadError: unknown) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Preview could not be prepared.");
      }
    })();
    return () => {
      active = false;
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [image, stableSignature]);

  useEffect(() => {
    const container = containerRef.current;
    const renderer = rendererRef.current;
    if (!container || !renderer || !ready) return;
    const currentContainer = container;
    const currentRenderer = renderer;
    let active = true;
    function render() {
      const width = Math.max(1, currentContainer.clientWidth * transform.scale);
      const height = Math.max(1, currentContainer.clientHeight * transform.scale);
      currentRenderer.resize(width, height);
      const request = ++requestRef.current;
      void currentRenderer.render(document, stableSignature, original, document.settings.crop.enabled ? "crop-preview" : "source").catch((renderError: unknown) => {
        if (active && request === requestRef.current) setError(renderError instanceof Error ? renderError.message : "Preview could not be rendered.");
      });
    }
    render();
    const observer = new ResizeObserver(render);
    observer.observe(currentContainer);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [document, original, ready, stableSignature, transform.scale]);

  function wheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const nextScale = Math.min(8, Math.max(1, transform.scale * Math.exp(-event.deltaY * 0.001)));
    const ratio = nextScale / transform.scale;
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    onTransformChange({
      scale: nextScale,
      x: nextScale === 1 ? 0 : pointerX - (pointerX - transform.x) * ratio,
      y: nextScale === 1 ? 0 : pointerY - (pointerY - transform.y) * ratio,
    });
  }

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (transform.scale <= 1) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: transform.x, y: transform.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onTransformChange({ ...transform, x: drag.x + event.clientX - drag.startX, y: drag.y + event.clientY - drag.startY });
  }

  function pointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div ref={containerRef} className={`relative h-full min-h-0 overflow-hidden bg-[#100f0e] ${className}`} onWheel={wheel} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onDoubleClick={() => onTransformChange(transform.scale > 1 ? FIT_VIEWPORT_TRANSFORM : { scale: 2, x: 0, y: 0 })}>
      <div className="absolute inset-0 will-change-transform" style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transformOrigin: "0 0" }}>
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
      <span className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-white/10 bg-black/65 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/70 backdrop-blur">{label}</span>
      {!ready && !error ? <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-wider text-lr-text-faint">Rendering…</div> : null}
      {error ? <div className="absolute inset-x-3 bottom-3 rounded-md border border-red-400/30 bg-red-950/85 px-3 py-2 text-xs text-red-100">{error}</div> : null}
    </div>
  );
}
