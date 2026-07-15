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
const DETAIL_ZOOM = 2;
const FIT_TRANSFORM: CropPreviewTransform = { scale: 1, x: 0, y: 0 };

function clampZoomOffset(
  viewportSize: number,
  imageStart: number,
  imageSize: number,
  scale: number,
  offset: number,
): number {
  const min = viewportSize - (imageStart + imageSize) * scale;
  const max = -imageStart * scale;
  return min > max ? (min + max) / 2 : Math.min(max, Math.max(min, offset));
}

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
  const [viewTransform, setViewTransform] = useState(FIT_TRANSFORM);
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
    setViewTransform(FIT_TRANSFORM);

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
      const renderScale = cropActive ? 1 : viewTransform.scale;
      currentRenderer.resize(
        currentContainer.clientWidth * renderScale,
        currentContainer.clientHeight * renderScale,
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
  }, [ready, image.height, image.width, cropActive, viewTransform.scale]);

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

  function onClick(event: React.MouseEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (cropActive || !ready || !container) {
      return;
    }
    const bounds = container.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const sourceWidth = settings.crop.enabled
      ? image.width * settings.crop.width
      : image.width;
    const sourceHeight = settings.crop.enabled
      ? image.height * settings.crop.height
      : image.height;
    const rect = computeContainedImageRect(
      bounds.width,
      bounds.height,
      sourceWidth,
      sourceHeight,
    );
    const imageX = (pointerX - viewTransform.x) / viewTransform.scale;
    const imageY = (pointerY - viewTransform.y) / viewTransform.scale;
    if (
      imageX < rect.x ||
      imageX > rect.x + rect.width ||
      imageY < rect.y ||
      imageY > rect.y + rect.height
    ) {
      return;
    }
    if (viewTransform.scale > 1) {
      setViewTransform(FIT_TRANSFORM);
      return;
    }
    setViewTransform({
      scale: DETAIL_ZOOM,
      x: clampZoomOffset(
        bounds.width,
        rect.x,
        rect.width,
        DETAIL_ZOOM,
        bounds.width / 2 - pointerX * DETAIL_ZOOM,
      ),
      y: clampZoomOffset(
        bounds.height,
        rect.y,
        rect.height,
        DETAIL_ZOOM,
        bounds.height / 2 - pointerY * DETAIL_ZOOM,
      ),
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

  const activeTransform = cropActive ? previewTransform : viewTransform;

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden ${
        cropActive || !ready
          ? ""
          : viewTransform.scale > 1
            ? "cursor-zoom-out"
            : "cursor-zoom-in"
      }`}
      onWheel={onWheel}
      onClick={onClick}
    >
      <div
        className={`absolute inset-0 ${
          cropActive
            ? ""
            : "will-change-transform transition-transform duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        }`}
        style={{
          transform: `translate(${activeTransform.x}px, ${activeTransform.y}px) scale(${activeTransform.scale})`,
          transformOrigin: "0 0",
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={cropActive ? {
            transform: `translate(${cropImageOffset.x * imageRect.width}px, ${cropImageOffset.y * imageRect.height}px)`,
            clipPath: `inset(${imageRect.y}px ${imageRect.x}px)`,
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
