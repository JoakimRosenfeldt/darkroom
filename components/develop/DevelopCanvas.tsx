"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { DevelopRenderer } from "@/lib/develop/renderer";
import { useDevelopStore } from "@/stores/develop-store";
import { InteractiveCropOverlay } from "@/components/develop/InteractiveCropOverlay";

interface DevelopCanvasProps {
  image: DevelopImage;
  alt: string;
}

export function DevelopCanvas({ image, alt }: DevelopCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<DevelopRenderer | null>(null);
  const settings = useDevelopStore((state) => state.settings);
  const showOriginal = useDevelopStore((state) => state.showOriginal);
  const setShowOriginal = useDevelopStore((state) => state.setShowOriginal);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usesEmbeddedRawPreview = image.metadata.developSource === "embedded";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const currentCanvas = canvas;

    let active = true;
    setReady(false);
    setError(null);

    async function loadRenderer() {
      try {
        rendererRef.current?.dispose();
        const renderer = new DevelopRenderer(currentCanvas);
        rendererRef.current = renderer;
        await renderer.setImage(image);
        if (!active) {
          renderer.dispose();
          return;
        }
        setReady(true);
      } catch (rendererError) {
        if (active) {
          setError(
            rendererError instanceof Error
              ? rendererError.message
              : "Could not initialize editor preview.",
          );
        }
      }
    }

    void loadRenderer();

    return () => {
      active = false;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !renderer || !container || !ready) {
      return;
    }
    const currentContainer = container;
    const currentRenderer = renderer;

    function resize() {
      currentRenderer.resize(
        currentContainer.clientWidth,
        currentContainer.clientHeight,
      );
      const state = useDevelopStore.getState();
      currentRenderer.render(state.settings, state.showOriginal);
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(currentContainer);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    if (ready) {
      rendererRef.current?.render(settings, showOriginal);
    }
  }, [settings, showOriginal, ready]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "\\") {
        setShowOriginal(true);
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "\\") {
        setShowOriginal(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [setShowOriginal]);

  if (error) {
    return (
      <div className="relative h-full w-full">
        {image.objectUrl ? (
          <Image
            src={image.objectUrl}
            alt={alt}
            fill
            unoptimized
            className="object-contain"
            preload
          />
        ) : null}
        <div className="absolute left-3 top-3 rounded border border-red-500/40 bg-red-950/80 px-3 py-2 text-xs text-red-100">
          Editing preview unavailable: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full" />
      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs uppercase tracking-wider text-lr-text-dim">
          Preparing editor...
        </div>
      ) : null}
      <InteractiveCropOverlay
        imageWidth={image.width}
        imageHeight={image.height}
      />
      {usesEmbeddedRawPreview ? (
        <div className="absolute bottom-3 left-3 rounded bg-amber-950/90 px-2 py-1 text-[11px] text-amber-100">
          RAW processing unavailable — editing embedded preview
        </div>
      ) : null}
      {showOriginal ? (
        <div className="absolute left-3 top-3 rounded bg-lr-panel/90 px-2 py-1 text-[11px] uppercase tracking-wider text-lr-text-muted">
          Before
        </div>
      ) : null}
    </div>
  );
}
