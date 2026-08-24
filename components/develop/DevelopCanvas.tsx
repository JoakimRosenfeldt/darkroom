"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  FrozenV2Renderer,
  type MaskOverlayMode,
  type RenderDiagnostic,
} from "@/lib/develop/frozen-v2-backend";
import { getDevelopSession } from "@/lib/develop/session";
import { useDevelopStore } from "@/stores/develop-store";
import { InteractiveCropOverlay } from "@/components/develop/InteractiveCropOverlay";
import { MaskingOverlay } from "@/components/develop/MaskingOverlay";
import type { BrushSettings } from "@/components/develop/MaskingOverlay";
import type { MaskTool } from "@/components/develop/MaskingPanel";
import { computeContainedImageRect } from "@/lib/develop/crop-geometry";
import { createDefaultDevelopDocument } from "@/lib/develop/document";
import type { CropSettings, SourceSignature } from "@/lib/develop/types";
import {
  anchoredViewerTransform,
  nextZoomPercent,
  relativeScaleForMode,
  type ViewerZoomMode,
} from "@/lib/viewer/geometry";
import { isEditableTarget } from "@/hooks/is-editable-target";

export interface CropPreviewTransform {
  scale: number;
  x: number;
  y: number;
}

interface DevelopCanvasProps {
  image: DevelopImage;
  alt: string;
  sourceSignature: SourceSignature;
  cropActive: boolean;
  cropDraft: CropSettings | null;
  cropImageOffset: { x: number; y: number };
  previewTransform: CropPreviewTransform;
  onCropChange: (crop: CropSettings, preserveFrame?: boolean) => void;
  onPreviewTransformChange: (
    update: (current: CropPreviewTransform) => CropPreviewTransform,
  ) => void;
  overlayMaskId?: string | null;
  overlayMode?: MaskOverlayMode;
  onRenderDiagnostics?: (diagnostics: readonly RenderDiagnostic[]) => void;
  maskingActive?: boolean;
  brushSettings: BrushSettings;
  onBrushSettingsChange: (settings: BrushSettings) => void;
}

const MIN_PREVIEW_ZOOM = 0.25;
const MAX_PREVIEW_ZOOM = 8;
const DETAIL_ZOOM = 2;
const FIT_TRANSFORM: CropPreviewTransform = { scale: 1, x: 0, y: 0 };
const EMPTY_DOCUMENT = createDefaultDevelopDocument();

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
  sourceSignature,
  cropActive,
  cropDraft,
  cropImageOffset,
  previewTransform,
  onCropChange,
  onPreviewTransformChange,
  overlayMaskId = null,
  overlayMode = "color",
  onRenderDiagnostics,
  maskingActive = false,
  brushSettings,
  onBrushSettingsChange,
}: DevelopCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FrozenV2Renderer | null>(null);
  const cropDraftRef = useRef(cropDraft);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const renderRequestRef = useRef(0);
  const document = useDevelopStore((state) => {
    const session = state.activeEntryId ? state.sessions[state.activeEntryId] : undefined;
    return session?.document ?? EMPTY_DOCUMENT;
  });
  const settings = document.settings;
  const showOriginal = useDevelopStore((state) => state.showOriginal);
  const setShowOriginal = useDevelopStore((state) => state.setShowOriginal);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setRenderDiagnostics] = useState<readonly RenderDiagnostic[]>([]);
  const [viewTransform, setViewTransform] = useState(FIT_TRANSFORM);
  const [zoomMode, setZoomMode] = useState<ViewerZoomMode>("fit");
  const [zoomPercent, setZoomPercent] = useState(100);
  const [panning, setPanning] = useState(false);
  const [imageRect, setImageRect] = useState(() =>
    computeContainedImageRect(1, 1, image.width, image.height),
  );
  const [displayImageRect, setDisplayImageRect] = useState(() =>
    computeContainedImageRect(1, 1, image.width, image.height),
  );
  const usesEmbeddedRawPreview = image.metadata.developSource === "embedded";
  const maskTool = useDevelopStore((state): MaskTool => {
    const session = state.activeEntryId ? state.sessions[state.activeEntryId] : undefined;
    return session?.ui.tool ?? "none";
  });
  const selectedMask = useDevelopStore((state) => {
    const session = state.activeEntryId ? state.sessions[state.activeEntryId] : undefined;
    const selectedMaskId = session?.ui.selectedMaskId;
    return session?.document.settings.masking.masks.find((mask) => mask.id === selectedMaskId) ?? null;
  });
  const selectedComponent = useDevelopStore((state) => {
    const session = state.activeEntryId ? state.sessions[state.activeEntryId] : undefined;
    const selectedMaskId = session?.ui.selectedMaskId;
    const selectedComponentId = session?.ui.selectedComponentId;
    const mask = session?.document.settings.masking.masks.find((item) => item.id === selectedMaskId);
    return mask?.components.find((component) => component.id === selectedComponentId) ?? null;
  });
  const { entryId, catalogId, assetRevision, relativePath, size, lastModified } = sourceSignature;
  const stableSourceSignature = useMemo(
    () => ({ entryId, catalogId, assetRevision, relativePath, size, lastModified }),
    [entryId, catalogId, assetRevision, relativePath, size, lastModified],
  );

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
    setZoomMode("fit");
    setZoomPercent(100);

    async function loadRenderer() {
      try {
        rendererRef.current?.dispose();
        const renderer = new FrozenV2Renderer(currentCanvas);
        rendererRef.current = renderer;
        await renderer.setImage(image);
        const catalogId = stableSourceSignature.catalogId;
        if (!catalogId) throw new Error("Develop source is missing its catalog identity.");
        const session = getDevelopSession(
          catalogId,
          stableSourceSignature.entryId,
        );
        if (!session) throw new Error("Develop session is not ready.");
        const preparation = await session.render({
          kind: "prepare",
          renderer,
          sourceSignature: stableSourceSignature,
          policy: "preview",
        });
        if (!active) {
          renderer.dispose();
          return;
        }
        setRenderDiagnostics(preparation.diagnostics);
        onRenderDiagnostics?.(preparation.diagnostics);
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
  }, [image, onRenderDiagnostics, stableSourceSignature]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    const container = containerRef.current;
    if (!canvas || !renderer || !container || !ready) {
      return;
    }
    const currentContainer = container;
    const currentRenderer = renderer;
    let active = true;

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
      const nextDisplayRect = computeContainedImageRect(
        currentContainer.clientWidth,
        currentContainer.clientHeight,
        settings.crop.enabled ? image.width * settings.crop.width : image.width,
        settings.crop.enabled ? image.height * settings.crop.height : image.height,
      );
      setDisplayImageRect(nextDisplayRect);
      if (!cropActive) {
        setViewTransform((current) => ({
          ...current,
          x: clampZoomOffset(
            currentContainer.clientWidth,
            nextDisplayRect.x,
            nextDisplayRect.width,
            current.scale,
            current.x,
          ),
          y: clampZoomOffset(
            currentContainer.clientHeight,
            nextDisplayRect.y,
            nextDisplayRect.height,
            current.scale,
            current.y,
          ),
        }));
      }
      const state = useDevelopStore.getState();
      const activeDocument = state.activeEntryId
        ? state.sessions[state.activeEntryId]?.document ?? EMPTY_DOCUMENT
        : EMPTY_DOCUMENT;
      const draft = cropDraftRef.current;
      const renderDocument = draft
        ? { ...activeDocument, settings: { ...activeDocument.settings, crop: draft } }
        : activeDocument;
      const request = ++renderRequestRef.current;
      const catalogId = stableSourceSignature.catalogId;
      if (!catalogId) return;
      const session = getDevelopSession(
        catalogId,
        stableSourceSignature.entryId,
      );
      if (!session) return;
      void session.render({
        kind: "preview",
        renderer: currentRenderer,
        sourceSignature: stableSourceSignature,
        showOriginal: state.showOriginal,
        mode: draft ? "source" : activeDocument.settings.crop.enabled ? "crop-preview" : "source",
        options: { overlayMaskId, overlayMode },
        documentOverride: renderDocument,
      }).then((preparation) => {
        if (active && request === renderRequestRef.current) {
          setRenderDiagnostics(preparation.diagnostics);
          onRenderDiagnostics?.(preparation.diagnostics);
        }
      }).catch((renderError: unknown) => {
        if (active && request === renderRequestRef.current) {
          setError(renderError instanceof Error ? renderError.message : "Could not render editor preview.");
        }
      });
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(currentContainer);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [
    ready,
    image.height,
    image.width,
    cropActive,
    settings.crop,
    viewTransform.scale,
    onRenderDiagnostics,
    overlayMaskId,
    overlayMode,
    stableSourceSignature,
  ]);

  useEffect(() => {
    if (ready) {
      const previewSettings = cropDraft
        ? { ...document, settings: { ...document.settings, crop: cropDraft } }
        : document;
      const renderer = rendererRef.current;
      if (!renderer) {
        return;
      }
      const catalogId = stableSourceSignature.catalogId;
      if (!catalogId) return;
      const session = getDevelopSession(
        catalogId,
        stableSourceSignature.entryId,
      );
      if (!session) return;
      const request = ++renderRequestRef.current;
      void session.render({
        kind: "preview",
        renderer,
        sourceSignature: stableSourceSignature,
        showOriginal,
        mode: cropDraft ? "source" : settings.crop.enabled ? "crop-preview" : "source",
        options: { overlayMaskId, overlayMode },
        documentOverride: previewSettings,
      }).then((preparation) => {
        if (request === renderRequestRef.current) {
          setRenderDiagnostics(preparation.diagnostics);
          onRenderDiagnostics?.(preparation.diagnostics);
        }
      }).catch((renderError: unknown) => {
        if (request === renderRequestRef.current) {
          setError(renderError instanceof Error ? renderError.message : "Could not render editor preview.");
        }
      });
    }
  }, [
    document,
    settings,
    showOriginal,
    ready,
    cropDraft,
    onRenderDiagnostics,
    overlayMaskId,
    overlayMode,
    stableSourceSignature,
  ]);

  function onWheel(event: React.WheelEvent) {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    event.preventDefault();
    const bounds = container.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    if (cropActive) {
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
      return;
    }
    const percent = nextZoomPercent(zoomMode === "custom" ? zoomPercent : 100, event.deltaY < 0 ? 1 : -1);
    applyViewerZoom("custom", percent, { x: pointerX, y: pointerY });
  }

  const applyViewerZoom = useCallback((
    mode: ViewerZoomMode,
    percent = 100,
    anchor?: { x: number; y: number },
  ) => {
    const container = containerRef.current;
    if (!container) return;
    const viewport = { width: container.clientWidth, height: container.clientHeight };
    const source = {
      width: settings.crop.enabled ? image.width * settings.crop.width : image.width,
      height: settings.crop.enabled ? image.height * settings.crop.height : image.height,
    };
    const rect = computeContainedImageRect(viewport.width, viewport.height, source.width, source.height);
    const scale = Math.max(
      MIN_PREVIEW_ZOOM,
      Math.min(MAX_PREVIEW_ZOOM, relativeScaleForMode(
        mode,
        viewport,
        source,
        window.devicePixelRatio,
        percent,
      )),
    );
    setViewTransform((current) => anchoredViewerTransform(
      current,
      scale,
      anchor ?? { x: viewport.width / 2, y: viewport.height / 2 },
      viewport,
      rect,
    ));
    setZoomMode(mode);
    setZoomPercent(percent);
  }, [image.height, image.width, settings.crop.enabled, settings.crop.height, settings.crop.width]);

  function getViewImageRect(width: number, height: number) {
    return computeContainedImageRect(
      width,
      height,
      settings.crop.enabled ? image.width * settings.crop.width : image.width,
      settings.crop.enabled ? image.height * settings.crop.height : image.height,
    );
  }

  function isInsideImage(x: number, y: number, rect: typeof imageRect) {
    const imageX = (x - viewTransform.x) / viewTransform.scale;
    const imageY = (y - viewTransform.y) / viewTransform.scale;
    return (
      imageX >= rect.x &&
      imageX <= rect.x + rect.width &&
      imageY >= rect.y &&
      imageY <= rect.y + rect.height
    );
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (cropActive || (maskingActive && maskTool !== "none") || viewTransform.scale <= 1) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (!isInsideImage(x, y, getViewImageRect(bounds.width, bounds.height))) {
      return;
    }
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: viewTransform.x,
      y: viewTransform.y,
      moved: false,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (!pan.moved && Math.hypot(deltaX, deltaY) < 4) {
      return;
    }
    pan.moved = true;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const rect = getViewImageRect(bounds.width, bounds.height);
    setViewTransform((current) => ({
      ...current,
      x: clampZoomOffset(
        bounds.width,
        rect.x,
        rect.width,
        current.scale,
        pan.x + deltaX,
      ),
      y: clampZoomOffset(
        bounds.height,
        rect.y,
        rect.height,
        current.scale,
        pan.y + deltaY,
      ),
    }));
  }

  function finishPan(
    event: React.PointerEvent<HTMLDivElement>,
    suppressClick = true,
  ) {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    suppressClickRef.current = suppressClick && pan.moved;
    panRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onClick(event: React.MouseEvent<HTMLDivElement>) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const container = containerRef.current;
    if (cropActive || (maskingActive && maskTool !== "none") || !ready || !container) {
      return;
    }
    const bounds = container.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const rect = getViewImageRect(bounds.width, bounds.height);
    if (!isInsideImage(pointerX, pointerY, rect)) {
      return;
    }
    if (viewTransform.scale > 1) {
      setViewTransform(FIT_TRANSFORM);
      setZoomMode("fit");
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
    setZoomMode("custom");
    setZoomPercent(200);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "\\") {
        setShowOriginal(true);
        return;
      }
      if (isEditableTarget(event.target) || cropActive || (maskingActive && maskTool !== "none")) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        applyViewerZoom("custom", nextZoomPercent(zoomMode === "custom" ? zoomPercent : 100, 1));
      } else if (event.key === "-") {
        event.preventDefault();
        applyViewerZoom("custom", nextZoomPercent(zoomMode === "custom" ? zoomPercent : 100, -1));
      } else if (event.key === "0") {
        event.preventDefault();
        applyViewerZoom("fit");
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        applyViewerZoom("fill");
      } else if (event.key === "!") {
        event.preventDefault();
        applyViewerZoom("actual");
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
  }, [applyViewerZoom, cropActive, maskingActive, maskTool, setShowOriginal, zoomMode, zoomPercent]);

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
        cropActive || !ready || (maskingActive && maskTool !== "none")
          ? ""
          : viewTransform.scale > 1
            ? panning
              ? "cursor-grabbing"
              : "cursor-grab"
              : "cursor-zoom-in"
      } ${maskingActive && maskTool !== "none" ? "cursor-crosshair" : ""}`}
      onWheel={onWheel}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPan}
      onPointerCancel={(event) => finishPan(event, false)}
    >
      {!cropActive && !(maskingActive && maskTool !== "none") ? (
        <div
          className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded-lg border border-white/10 bg-black/70 p-1 shadow-xl backdrop-blur"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {(["fit", "fill", "actual"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={zoomMode === mode}
              onClick={() => applyViewerZoom(mode)}
              className={`rounded-md px-2 py-1 text-[10px] uppercase tracking-wide ${
                zoomMode === mode ? "bg-lr-selection text-lr-accent" : "text-white/65 hover:text-white"
              }`}
            >
              {mode === "actual" ? "1:1" : mode}
            </button>
          ))}
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => applyViewerZoom("custom", nextZoomPercent(zoomMode === "custom" ? zoomPercent : 100, -1))}
            className="rounded px-2 py-1 text-xs text-white/65 hover:text-white"
          >
            −
          </button>
          <span role="status" aria-label={`Zoom ${zoomMode === "fit" ? "fit" : zoomMode === "fill" ? "fill" : zoomMode === "actual" ? "actual pixels" : `${zoomPercent} percent`}`} className="w-10 text-center font-mono text-[10px] text-white/75">
            {zoomMode === "fit" ? "FIT" : zoomMode === "fill" ? "FILL" : zoomMode === "actual" ? "1:1" : `${zoomPercent}%`}
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => applyViewerZoom("custom", nextZoomPercent(zoomMode === "custom" ? zoomPercent : 100, 1))}
            className="rounded px-2 py-1 text-xs text-white/65 hover:text-white"
          >
            +
          </button>
        </div>
      ) : null}
      <div
        className={`absolute inset-0 ${
          cropActive || panning
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
        {!cropActive && maskingActive ? (
          <MaskingOverlay
            imageRect={displayImageRect}
            displayWidth={image.width}
            displayHeight={image.height}
            orientation={image.orientation}
            crop={settings.crop}
            mask={selectedMask}
            component={selectedComponent}
            tool={maskTool}
            brushSettings={brushSettings}
            onBrushSettingsChange={onBrushSettingsChange}
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
