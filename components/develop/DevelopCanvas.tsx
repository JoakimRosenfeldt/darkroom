"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { DevelopRenderer } from "@/lib/develop/renderer";
import { useDevelopStore } from "@/stores/develop-store";
import { InteractiveCropOverlay } from "@/components/develop/InteractiveCropOverlay";
import { computeContainedImageRect } from "@/lib/develop/crop-geometry";
import type { CropSettings } from "@/lib/develop/types";

export interface CropPreviewTransform {
  scale: number;
  x: number;
  y: number;
}

interface DevelopCanvasProps {
  image: DevelopImage;
  alt: string;
  cropActive: boolean;
  cropDraft: CropSettings | null;
  cropImageOffset: { x: number; y: number };
  previewTransform: CropPreviewTransform;
  onCropChange: (crop: CropSettings, preserveFrame?: boolean) => void;
  onPreviewTransformChange: (
    update: (current: CropPreviewTransform) => CropPreviewTransform,
  ) => void;
}

const MIN_PREVIEW_ZOOM = 0.25;
const MAX_PREVIEW_ZOOM = 8;

export function DevelopCanvas({
  image,
  alt,
  cropActive,
  cropDraft,
  cropImageOffset,
  previewTransform,
  onCropChange,
  onPreviewTransformChange,
}: DevelopCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<DevelopRenderer | null>(null);
  const cropDraftRef = useRef(cropDraft);
  const settings = useDevelopStore((state) => state.settings);
  const showOriginal = useDevelopStore((state) => state.showOriginal);
  const setShowOriginal = useDevelopStore((state) => state.setShowOriginal);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageRect, setImageRect] = useState(() =>
    computeContainedImageRect(1, 1, image.width, image.height),
  );
  const usesEmbeddedRawPreview = image.metadata.developSource === "embedded";

  useEffect(() => {
    cropDraftRef.current = cropDraft;
  }, [cropDraft]);

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
    const container = containerRef.current;
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
      setImageRect(
        computeContainedImageRect(
          currentContainer.clientWidth,
          currentContainer.clientHeight,
          image.width,
          image.height,
        ),
      );
      const state = useDevelopStore.getState();
      const draft = cropDraftRef.current;
      currentRenderer.render(
        draft ? { ...state.settings, crop: draft } : state.settings,
        state.showOriginal,
        draft ? "source" : state.settings.crop.enabled ? "crop-preview" : "source",
      );
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(currentContainer);
    return () => observer.disconnect();
  }, [ready, image.height, image.width]);

  useEffect(() => {
    if (ready) {
      const previewSettings = cropDraft
        ? { ...settings, crop: cropDraft }
        : settings;
      rendererRef.current?.render(
        previewSettings,
        showOriginal,
        cropDraft ? "source" : settings.crop.enabled ? "crop-preview" : "source",
      );
    }
  }, [settings, showOriginal, ready, cropDraft]);

  function onWheel(event: React.WheelEvent) {
    const container = containerRef.current;
    if (!cropActive || !container) {
      return;
    }
    event.preventDefault();
    const bounds = container.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    onPreviewTransformChange((current) => {
      const scale = Math.max(
        MIN_PREVIEW_ZOOM,
        Math.min(MAX_PREVIEW_ZOOM, current.scale * Math.exp(-event.deltaY * 0.001)),
      );
      const ratio = scale / current.scale;
      const xLimit = bounds.width * (1 - scale);
      const yLimit = bounds.height * (1 - scale);
      return {
        scale,
        x: Math.max(Math.min(0, xLimit), Math.min(Math.max(0, xLimit), pointerX - (pointerX - current.x) * ratio)),
        y: Math.max(Math.min(0, yLimit), Math.min(Math.max(0, yLimit), pointerY - (pointerY - current.y) * ratio)),
      };
    });
  }

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
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      onWheel={onWheel}
    >
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${previewTransform.x}px, ${previewTransform.y}px) scale(${previewTransform.scale})`,
          transformOrigin: "0 0",
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={cropActive ? {
            transform: `translate(${cropImageOffset.x * imageRect.width}px, ${cropImageOffset.y * imageRect.height}px)`,
          } : undefined}
        />
        {cropActive && cropDraft ? (
          <InteractiveCropOverlay
            crop={cropDraft}
            imageOffset={cropImageOffset}
            imageRect={imageRect}
            imageWidth={image.width}
            imageHeight={image.height}
            previewScale={previewTransform.scale}
            onChange={onCropChange}
          />
        ) : null}
      </div>
      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs uppercase tracking-wider text-lr-text-dim">
          Preparing editor...
        </div>
      ) : null}
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
