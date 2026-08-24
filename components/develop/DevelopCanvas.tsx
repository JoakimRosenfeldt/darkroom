"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  V3CanvasOverlay,
  type V3CanvasTool,
} from "@/components/develop/V3CanvasOverlay";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { getDevelopSession } from "@/lib/develop/session";
import type { GeometryPoint } from "@/lib/develop/v3/geometry";
import {
  createDefaultV3DevelopDocument,
  type DevelopDocumentV3,
} from "@/lib/develop/v3/document";
import type { Rgb } from "@/lib/develop/v3/profiles";
import {
  buildV3SourceRecord,
  renderV3Runtime,
  type V3PreviewSessionRenderRequest,
} from "@/lib/develop/v3/runtime";
import type {
  CpuAnalysisTapResult,
  CpuBackendBlockingDiagnostic,
  CpuBackendDiagnostic,
  CpuPointColorInput,
  CpuRenderResult,
} from "@/lib/develop/v3/cpu-backend";
import type { Sha256Digest } from "@/lib/develop/render-contract";
import type { LibraryEntry } from "@/lib/fs/types";
import { isEditableTarget } from "@/hooks/is-editable-target";
import {
  anchoredViewerTransform,
  clampViewerOffset,
  nextZoomPercent,
  type ViewerTransform,
} from "@/lib/viewer/geometry";
import { useDevelopStore } from "@/stores/develop-store";

export type { V3CanvasTool } from "@/components/develop/V3CanvasOverlay";

export type V3CanvasDiagnostic =
  | CpuBackendDiagnostic
  | CpuBackendBlockingDiagnostic;

export interface V3AnalysisBinding {
  readonly catalogId: string;
  readonly entryId: string;
  readonly assetRevision: number;
  readonly documentRevision: number;
  readonly planFingerprint: Sha256Digest;
}

const analysisBindings = new WeakMap<
  readonly CpuAnalysisTapResult[],
  V3AnalysisBinding
>();
const activeAnalysis = new Map<
  string,
  {
    readonly analysis: readonly CpuAnalysisTapResult[];
    readonly binding: V3AnalysisBinding;
  }
>();

function analysisKey(catalogId: string, entryId: string): string {
  return JSON.stringify([catalogId, entryId]);
}

function clearActiveAnalysis(catalogId: string, entryId: string): void {
  activeAnalysis.delete(analysisKey(catalogId, entryId));
}

function bindActiveAnalysis(
  analysis: readonly CpuAnalysisTapResult[],
  binding: V3AnalysisBinding,
): void {
  analysisBindings.set(analysis, binding);
  activeAnalysis.set(analysisKey(binding.catalogId, binding.entryId), {
    analysis,
    binding,
  });
}

export function currentV3AnalysisBinding(
  analysis: readonly CpuAnalysisTapResult[],
): V3AnalysisBinding | null {
  const binding = analysisBindings.get(analysis);
  if (!binding) return null;
  const current = activeAnalysis.get(analysisKey(binding.catalogId, binding.entryId));
  return current?.analysis === analysis ? binding : null;
}

interface DevelopCanvasProps {
  readonly entry: LibraryEntry;
  readonly image: DevelopImage;
  readonly alt: string;
  readonly cropActive?: boolean;
  readonly maskingActive?: boolean;
  readonly canvasTool: V3CanvasTool;
  readonly onCanvasToolChange: (tool: V3CanvasTool) => void;
  readonly onRenderDiagnostics?: (
    diagnostics: readonly V3CanvasDiagnostic[],
  ) => void;
  readonly onAnalysis?: (analysis: readonly CpuAnalysisTapResult[]) => void;
}

type PreviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "rendered" }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "cancelled"; readonly message: string };

interface DisplayDimensions {
  readonly width: number;
  readonly height: number;
}

interface PanGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly x: number;
  readonly y: number;
}

const FIT_TRANSFORM: ViewerTransform = { scale: 1, x: 0, y: 0 };
const MIN_ZOOM_PERCENT = 100;
const MAX_ZOOM_PERCENT = 400;

function centeredImageRect(
  viewport: DisplayDimensions,
  image: DisplayDimensions,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  return {
    x: (viewport.width - image.width) / 2,
    y: (viewport.height - image.height) / 2,
    width: image.width,
    height: image.height,
  };
}

function beforeDocument(document: DevelopDocumentV3): DevelopDocumentV3 {
  const neutral = createDefaultV3DevelopDocument();
  return {
    ...neutral,
    optics: {
      ...neutral.optics,
      manualDistortion: document.optics.manualDistortion,
    },
    geometry: document.geometry,
    local: {
      ...neutral.local,
      geometryFrame: document.local.geometryFrame,
    },
  };
}

function resultMessage(result: Exclude<CpuRenderResult, { readonly kind: "rendered" }>): string {
  if (result.kind === "cancelled") return "Preview render was cancelled.";
  if (result.kind === "blocked") {
    const diagnostic = result.diagnostics[0];
    return "reason" in diagnostic
      ? diagnostic.reason
      : `Preview is blocked by ${diagnostic.kind}.`;
  }
  const issue = result.issues[0];
  return "reason" in issue
    ? issue.reason
    : `Preview request is invalid: ${issue.kind}.`;
}

export function DevelopCanvas({
  entry,
  image,
  alt,
  cropActive = false,
  maskingActive = false,
  canvasTool,
  onCanvasToolChange,
  onRenderDiagnostics,
  onAnalysis,
}: DevelopCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointColorInputRef = useRef<CpuPointColorInput | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const requestRef = useRef(0);
  const diagnosticsCallbackRef = useRef(onRenderDiagnostics);
  const analysisCallbackRef = useRef(onAnalysis);
  const documentRevision = useDevelopStore((state) =>
    state.activeCatalogId === entry.catalogId
      ? state.sessions[entry.id]?.documentRevision ?? 0
      : 0,
  );
  const document = useDevelopStore((state) => {
    const session = state.activeCatalogId === entry.catalogId
      ? state.sessions[entry.id]
      : undefined;
    return session?.processKind === "v3" && session.persistedDocument?.version === 3
      ? session.persistedDocument
      : null;
  });
  const maskTool = useDevelopStore((state) => {
    const session = state.activeCatalogId === entry.catalogId
      ? state.sessions[entry.id]
      : undefined;
    return session?.ui.tool ?? "none";
  });
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [displayDimensions, setDisplayDimensions] = useState({ width: 1, height: 1 });
  const [viewTransform, setViewTransform] = useState<ViewerTransform>(FIT_TRANSFORM);
  const [showBefore, setShowBefore] = useState(false);
  const [beforeReady, setBeforeReady] = useState(false);
  const [panning, setPanning] = useState(false);

  const activeDisplayDimensions = displayDimensions;
  const canvasInteractionActive = cropActive || canvasTool.kind !== "none" ||
    (maskingActive && maskTool !== "none");

  useEffect(() => {
    diagnosticsCallbackRef.current = onRenderDiagnostics;
  }, [onRenderDiagnostics]);

  useEffect(() => {
    analysisCallbackRef.current = onAnalysis;
  }, [onAnalysis]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) {
      setPreview({ kind: "invalid", message: "2D canvas rendering is unavailable." });
      return;
    }

    let disposed = false;
    let activeCancellation: { cancelled: boolean } | null = null;

    const render = () => {
      if (activeCancellation) activeCancellation.cancelled = true;
      pointColorInputRef.current = null;
      setBeforeReady(false);
      setShowBefore(false);
      clearActiveAnalysis(entry.catalogId, entry.id);
      analysisCallbackRef.current?.([]);
      const cancellation = { cancelled: false };
      activeCancellation = cancellation;
      const requestId = ++requestRef.current;
      const width = Math.max(1, Math.round(container.clientWidth));
      const height = Math.max(1, Math.round(container.clientHeight));
      const session = getDevelopSession(entry.catalogId, entry.id);
      setPreview({ kind: "loading" });
      if (!session || !document) {
        setPreview({ kind: "invalid", message: "Develop session is not ready." });
        return;
      }
      const renderSnapshot = session.snapshot();
      const request = {
        kind: "v3-preview",
        entry,
        image,
        viewportDimensions: { width, height },
        devicePixelRatio: window.devicePixelRatio || 1,
        cancellation: {
          isCancelled: () => disposed || cancellation.cancelled,
          reason: () => disposed || cancellation.cancelled
            ? "A newer preview request replaced this render."
            : null,
        },
      } satisfies V3PreviewSessionRenderRequest;
      const renderDocument = cropActive
        ? {
            ...document,
            geometry: {
              ...document.geometry,
              constrainCrop: false,
              crop: { ...document.geometry.crop, enabled: false },
            },
          }
        : document;
      const resultPromise = cropActive
        ? renderV3Runtime(renderDocument, request)
        : session.render(request);
      void resultPromise.then((result) => {
        if (disposed || cancellation.cancelled || requestId !== requestRef.current) return;
        if (result.kind !== "rendered") {
          pointColorInputRef.current = null;
          if (result.kind === "blocked") {
            diagnosticsCallbackRef.current?.(result.diagnostics);
            analysisCallbackRef.current?.([]);
            setPreview({ kind: "blocked", message: resultMessage(result) });
          } else if (result.kind === "invalid") {
            diagnosticsCallbackRef.current?.([]);
            analysisCallbackRef.current?.([]);
            setPreview({ kind: "invalid", message: resultMessage(result) });
          } else {
            diagnosticsCallbackRef.current?.([]);
            analysisCallbackRef.current?.([]);
            setPreview({ kind: "cancelled", message: resultMessage(result) });
          }
          return;
        }
        const currentSnapshot = session.snapshot();
        if (
          renderSnapshot.processKind !== "v3" ||
          currentSnapshot.processKind !== "v3" ||
          currentSnapshot.documentRevision !== renderSnapshot.documentRevision
        ) {
          analysisCallbackRef.current?.([]);
          setPreview({
            kind: "cancelled",
            message: "The Develop document changed during this render.",
          });
          return;
        }
        const dimensions = result.dimensions;
        pointColorInputRef.current = result.pointColorInput;
        canvas.width = dimensions.width;
        canvas.height = dimensions.height;
        context.putImageData(
          new ImageData(
            new Uint8ClampedArray(result.pixels.pixels),
            dimensions.width,
            dimensions.height,
          ),
          0,
          0,
        );
        const scale = Math.min(width / dimensions.width, height / dimensions.height);
        setDisplayDimensions({
          width: Math.max(1, Math.round(dimensions.width * scale)),
          height: Math.max(1, Math.round(dimensions.height * scale)),
        });
        diagnosticsCallbackRef.current?.(result.diagnostics);
        if (!cropActive) {
          bindActiveAnalysis(result.analysis, {
            catalogId: entry.catalogId,
            entryId: entry.id,
            assetRevision: entry.assetRevision,
            documentRevision: renderSnapshot.documentRevision,
            planFingerprint: result.planFingerprint,
          });
          analysisCallbackRef.current?.(result.analysis);
        }
        setPreview({ kind: "rendered" });
        const sourceCanvas = sourceCanvasRef.current;
        const sourceContext = sourceCanvas?.getContext("2d") ?? null;
        if (!sourceCanvas || !sourceContext) return;
        void renderV3Runtime(beforeDocument(renderDocument), request).then((before) => {
          if (disposed || cancellation.cancelled || requestId !== requestRef.current) return;
          const latestSnapshot = session.snapshot();
          if (
            before.kind !== "rendered" ||
            latestSnapshot.processKind !== "v3" ||
            latestSnapshot.documentRevision !== renderSnapshot.documentRevision ||
            before.dimensions.width !== dimensions.width ||
            before.dimensions.height !== dimensions.height
          ) return;
          sourceCanvas.width = before.dimensions.width;
          sourceCanvas.height = before.dimensions.height;
          sourceContext.putImageData(
            new ImageData(
              new Uint8ClampedArray(before.pixels.pixels),
              before.dimensions.width,
              before.dimensions.height,
            ),
            0,
            0,
          );
          setBeforeReady(true);
        }).catch(() => {
          if (!disposed && !cancellation.cancelled && requestId === requestRef.current) {
            setBeforeReady(false);
          }
        });
      }).catch((error: unknown) => {
        if (disposed || cancellation.cancelled || requestId !== requestRef.current) return;
        diagnosticsCallbackRef.current?.([]);
        analysisCallbackRef.current?.([]);
        setPreview({
          kind: "invalid",
          message: error instanceof Error ? error.message : "Could not render the preview.",
        });
      });
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(container);
    return () => {
      disposed = true;
      if (activeCancellation) activeCancellation.cancelled = true;
      pointColorInputRef.current = null;
      clearActiveAnalysis(entry.catalogId, entry.id);
      observer.disconnect();
    };
  }, [cropActive, document, documentRevision, entry, image]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const viewport = {
      width: container.clientWidth,
      height: container.clientHeight,
    };
    const imageRect = centeredImageRect(viewport, activeDisplayDimensions);
    setViewTransform((current) => current.scale === 1
      ? FIT_TRANSFORM
      : {
          ...current,
          ...clampViewerOffset(viewport, imageRect, current.scale, current),
        });
  }, [activeDisplayDimensions]);

  const applyZoom = useCallback((
    percent: number,
    anchor?: { readonly x: number; readonly y: number },
  ) => {
    const container = containerRef.current;
    if (!container) return;
    const viewport = {
      width: container.clientWidth,
      height: container.clientHeight,
    };
    const imageRect = centeredImageRect(viewport, activeDisplayDimensions);
    const scale = Math.max(
      MIN_ZOOM_PERCENT,
      Math.min(MAX_ZOOM_PERCENT, percent),
    ) / 100;
    setViewTransform((current) => anchoredViewerTransform(
      current,
      scale,
      anchor ?? { x: viewport.width / 2, y: viewport.height / 2 },
      viewport,
      imageRect,
    ));
  }, [activeDisplayDimensions]);

  const stepZoom = useCallback((direction: -1 | 1): void => {
    const currentPercent = Math.round(viewTransform.scale * 100);
    const nextPercent = Math.max(
      MIN_ZOOM_PERCENT,
      Math.min(MAX_ZOOM_PERCENT, nextZoomPercent(currentPercent, direction)),
    );
    applyZoom(nextPercent);
  }, [applyZoom, viewTransform.scale]);

  function onWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (canvasInteractionActive || preview.kind !== "rendered") return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const currentPercent = Math.round(viewTransform.scale * 100);
    const nextPercent = Math.max(
      MIN_ZOOM_PERCENT,
      Math.min(
        MAX_ZOOM_PERCENT,
        nextZoomPercent(currentPercent, event.deltaY < 0 ? 1 : -1),
      ),
    );
    applyZoom(nextPercent, {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const interactive = event.target instanceof HTMLElement &&
      Boolean(event.target.closest("button"));
    if (
      interactive ||
      canvasInteractionActive ||
      preview.kind !== "rendered" ||
      viewTransform.scale <= 1 ||
      event.button !== 0
    ) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
    const imageRect = centeredImageRect(
      { width: bounds.width, height: bounds.height },
      activeDisplayDimensions,
    );
    const imageX = (pointer.x - viewTransform.x) / viewTransform.scale;
    const imageY = (pointer.y - viewTransform.y) / viewTransform.scale;
    if (
      imageX < imageRect.x ||
      imageX > imageRect.x + imageRect.width ||
      imageY < imageRect.y ||
      imageY > imageRect.y + imageRect.height
    ) return;

    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: viewTransform.x,
      y: viewTransform.y,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const viewport = {
      width: event.currentTarget.clientWidth,
      height: event.currentTarget.clientHeight,
    };
    const imageRect = centeredImageRect(viewport, activeDisplayDimensions);
    const offset = clampViewerOffset(
      viewport,
      imageRect,
      viewTransform.scale,
      {
        x: pan.x + event.clientX - pan.startX,
        y: pan.y + event.clientY - pan.startY,
      },
    );
    setViewTransform((current) => ({ ...current, ...offset }));
  }

  function finishPan(event: ReactPointerEvent<HTMLDivElement>): void {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const interactive = event.target instanceof HTMLElement &&
      Boolean(event.target.closest("button"));
    if (interactive || canvasInteractionActive || preview.kind !== "rendered") return;
    if (viewTransform.scale > 1) {
      setViewTransform(FIT_TRANSFORM);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    applyZoom(200, {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === "\\" && beforeReady) {
        event.preventDefault();
        setShowBefore(true);
        return;
      }
      if (canvasInteractionActive) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        stepZoom(1);
      } else if (event.key === "-") {
        event.preventDefault();
        stepZoom(-1);
      }
    }

    function onKeyUp(event: KeyboardEvent): void {
      if (event.key === "\\") setShowBefore(false);
    }

    function releaseBefore(): void {
      setShowBefore(false);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseBefore);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseBefore);
    };
  }, [beforeReady, canvasInteractionActive, stepZoom]);

  const sourceResult = buildV3SourceRecord(entry, image, "preview");
  const samplePointColorInput = useCallback((output: GeometryPoint): Rgb | null => {
    const input = pointColorInputRef.current;
    if (!input || input.dimensions.width < 1 || input.dimensions.height < 1) return null;
    const x = Math.max(0, Math.min(
      input.dimensions.width - 1,
      Math.floor(output.x * input.dimensions.width),
    ));
    const y = Math.max(0, Math.min(
      input.dimensions.height - 1,
      Math.floor((1 - output.y) * input.dimensions.height),
    ));
    const offset = (y * input.dimensions.width + x) * 3;
    return [
      input.pixels[offset] ?? 0,
      input.pixels[offset + 1] ?? 0,
      input.pixels[offset + 2] ?? 0,
    ];
  }, []);

  return (
    <div
      ref={containerRef}
      className={[
        "relative h-full min-h-0 w-full overflow-hidden",
        canvasInteractionActive || preview.kind !== "rendered"
          ? ""
          : viewTransform.scale > 1
            ? panning ? "cursor-grabbing" : "cursor-grab"
            : "cursor-zoom-in",
      ].join(" ")}
      aria-busy={preview.kind === "loading"}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPan}
      onPointerCancel={finishPan}
      onDoubleClick={onDoubleClick}
    >
      {preview.kind === "rendered" && !canvasInteractionActive ? (
        <div className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded-lg border border-white/10 bg-black/70 p-1 shadow-xl backdrop-blur">
          <button
            type="button"
            aria-label="Zoom out"
            aria-keyshortcuts="-"
            disabled={viewTransform.scale <= 1}
            onClick={() => stepZoom(-1)}
            className="rounded px-2 py-1 text-xs text-white/65 hover:text-white disabled:opacity-35"
          >
            −
          </button>
          <button
            type="button"
            aria-pressed={viewTransform.scale === 1}
            onClick={() => setViewTransform(FIT_TRANSFORM)}
            className={[
              "rounded-md px-2 py-1 text-[10px] uppercase tracking-wide",
              viewTransform.scale === 1
                ? "bg-lr-selection text-lr-accent"
                : "text-white/65 hover:text-white",
            ].join(" ")}
          >
            Fit
          </button>
          <span
            role="status"
            aria-label={`Zoom ${Math.round(viewTransform.scale * 100)} percent`}
            className="w-10 text-center font-mono text-[10px] text-white/75"
          >
            {Math.round(viewTransform.scale * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            aria-keyshortcuts="+"
            disabled={viewTransform.scale >= MAX_ZOOM_PERCENT / 100}
            onClick={() => stepZoom(1)}
            className="rounded px-2 py-1 text-xs text-white/65 hover:text-white disabled:opacity-35"
          >
            +
          </button>
          <span className="mx-0.5 h-4 w-px bg-white/10" />
          <button
            type="button"
            aria-pressed={showBefore}
            aria-keyshortcuts="\\"
            disabled={!beforeReady}
            title="Hold to view before edits (\\)"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setShowBefore(true);
            }}
            onPointerUp={(event) => {
              setShowBefore(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => setShowBefore(false)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
              if (event.key === "Enter" || event.key === " ") setShowBefore(true);
            }}
            onKeyUp={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
              if (event.key === "Enter" || event.key === " ") setShowBefore(false);
            }}
            className={[
              "rounded-md px-2 py-1 text-[10px] uppercase tracking-wide",
              showBefore
                ? "bg-lr-selection text-lr-accent"
                : "text-white/65 hover:text-white disabled:opacity-35",
            ].join(" ")}
          >
            Before · \
          </button>
        </div>
      ) : null}
      <div
        className={[
          "absolute inset-0",
          preview.kind === "rendered" ? "" : "invisible",
          panning
            ? ""
            : "will-change-transform transition-transform duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        ].join(" ")}
        style={{
          transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.scale})`,
          transformOrigin: "0 0",
        }}
      >
        <div
          className={[
            "absolute inset-0 flex items-center justify-center",
            showBefore ? "invisible" : "",
          ].join(" ")}
        >
          <div
            className="relative"
            style={{ width: displayDimensions.width, height: displayDimensions.height }}
          >
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={alt}
              aria-hidden={showBefore}
              className="block h-full w-full"
            />
            {document && sourceResult.kind === "source" ? (
              <V3CanvasOverlay
                document={document}
                source={sourceResult.source}
                image={image}
                width={displayDimensions.width}
                height={displayDimensions.height}
                cropActive={cropActive}
                maskingActive={maskingActive}
                canvasTool={canvasTool}
                onCanvasToolChange={onCanvasToolChange}
                samplePointColorInput={samplePointColorInput}
              />
            ) : null}
          </div>
        </div>
        <div
          className={[
            "absolute inset-0 flex items-center justify-center",
            showBefore ? "" : "invisible",
          ].join(" ")}
        >
          <canvas
            ref={sourceCanvasRef}
            role="img"
            aria-label={`${alt}, before edits`}
            aria-hidden={!showBefore}
            className="block h-full w-full"
            style={displayDimensions}
          />
        </div>
      </div>
      {showBefore && preview.kind === "rendered" ? (
        <div className="pointer-events-none absolute left-3 top-3 z-40 rounded bg-lr-panel/90 px-2 py-1 text-[11px] uppercase tracking-wider text-lr-text-muted">
          Before
        </div>
      ) : null}
      {preview.kind !== "rendered" ? (
        <div
          role={preview.kind === "loading" ? "status" : "alert"}
          className="absolute max-w-sm rounded border border-lr-border-subtle bg-lr-panel/95 px-4 py-3 text-center text-xs text-lr-text-muted"
        >
          {preview.kind === "loading" ? "Rendering preview…" : preview.message}
        </div>
      ) : null}
    </div>
  );
}
