"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  V3CanvasOverlay,
  type V3CanvasTool,
} from "@/components/develop/V3CanvasOverlay";
import { PhotoLoupe } from "@/components/viewer/PhotoLoupe";
import {
  getCachedDevelopExportImage,
  type DevelopImage,
} from "@/lib/cache/develop-image-cache";
import { getDevelopSession } from "@/lib/develop/session";
import type { GeometryPoint } from "@/lib/develop/v3/geometry";
import {
  createDefaultV3DevelopDocument,
  type DevelopDocumentV3,
} from "@/lib/develop/v3/document";
import type { Rgb } from "@/lib/develop/v3/profiles";
import {
  buildV3SourceRecord,
  loadV3PreviewMaskMattes,
  resolveV3ExportDimensions,
  type V3PreviewMaskMatte,
  type V3PreviewRenderMode,
} from "@/lib/develop/v3/runtime";
import { V3PreviewWorkerClient } from "@/lib/develop/v3/preview-worker-client";
import type {
  V3PreviewBackend,
  V3PreviewRenderOutput,
} from "@/lib/develop/v3/preview-worker-types";
import type {
  CpuAnalysisTapResult,
  CpuBackendBlockingDiagnostic,
  CpuBackendDiagnostic,
  CpuPointColorInput,
} from "@/lib/develop/v3/cpu-backend";
import { MAX_CPU_RENDER_PIXELS } from "@/lib/develop/v3/cpu-backend";
import type { Sha256Digest } from "@/lib/develop/render-contract";
import type { LibraryEntry } from "@/lib/fs/types";
import { isEditableTarget } from "@/hooks/is-editable-target";
import {
  anchoredViewerTransform,
  clampViewerOffset,
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

interface PaintedRasterDimensions extends DisplayDimensions {
  readonly document: DevelopDocumentV3;
  readonly documentRevision: number;
  readonly cropActive: boolean;
  readonly entryId: string;
  readonly assetRevision: number;
}

function positiveDimensions(width: unknown, height: unknown): DisplayDimensions | null {
  return typeof width === "number" && Number.isSafeInteger(width) && width > 0 &&
    typeof height === "number" && Number.isSafeInteger(height) && height > 0
    ? { width, height }
    : null;
}

function requestedPreviewDimensions(
  width: number,
  height: number,
  previewScale: number,
  devicePixelRatio: number,
  aspect: DisplayDimensions,
): DisplayDimensions {
  const viewportWidth = Math.max(1, Math.round(width * previewScale));
  const viewportHeight = Math.max(1, Math.round(height * previewScale));
  const boundsWidth = Math.max(1, Math.round(viewportWidth * devicePixelRatio));
  const boundsHeight = Math.max(1, Math.round(viewportHeight * devicePixelRatio));
  const scale = Math.min(boundsWidth / aspect.width, boundsHeight / aspect.height);
  let outputWidth = Math.max(1, Math.round(aspect.width * scale));
  let outputHeight = Math.max(1, Math.round(aspect.height * scale));
  const pixels = outputWidth * outputHeight;
  if (pixels > MAX_CPU_RENDER_PIXELS) {
    const capScale = Math.sqrt(MAX_CPU_RENDER_PIXELS / pixels);
    outputWidth = Math.max(1, Math.floor(outputWidth * capScale));
    outputHeight = Math.max(1, Math.floor(outputHeight * capScale));
  }
  return { width: outputWidth, height: outputHeight };
}

function initialFullSourceDimensions(
  entry: LibraryEntry,
  image: DevelopImage,
): DisplayDimensions | null {
  const cached = getCachedDevelopExportImage(entry, { rawColorMode: "libraw-camera-matrix" });
  if (cached) return positiveDimensions(cached.width, cached.height);
  if (image.pixelProvenance.decoderPath !== "processed-standard" &&
      image.pixelProvenance.decoderPath !== "libraw") return null;
  return positiveDimensions(image.metadata.originalWidth, image.metadata.originalHeight);
}

interface DrawnFrame {
  readonly backend: V3PreviewBackend;
  readonly cropActive: boolean;
  readonly document: DevelopDocumentV3;
  readonly documentRevision: number;
  readonly mode: V3PreviewRenderMode;
  readonly rasterSaturated: boolean;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly viewportScale: number;
}

interface PanGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly actualSize: boolean;
  readonly startedAtFit: boolean;
  moved: boolean;
}

const FIT_TRANSFORM: ViewerTransform = { scale: 1, x: 0, y: 0 };
const EMPTY_ANALYSIS: readonly CpuAnalysisTapResult[] = [];

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

interface BeforeDocumentInput {
  readonly geometry: DevelopDocumentV3["geometry"];
  readonly geometryFrame: DevelopDocumentV3["local"]["geometryFrame"];
  readonly manualDistortion: DevelopDocumentV3["optics"]["manualDistortion"];
}

function beforeDocument(input: BeforeDocumentInput): DevelopDocumentV3 {
  const neutral = createDefaultV3DevelopDocument();
  return {
    ...neutral,
    optics: {
      ...neutral.optics,
      manualDistortion: input.manualDistortion,
    },
    geometry: input.geometry,
    local: {
      ...neutral.local,
      geometryFrame: input.geometryFrame,
    },
  };
}

function resultMessage(
  result: Exclude<V3PreviewRenderOutput, { readonly kind: "rendered" }>,
): string {
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

function imageDataPixels(pixels: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  return pixels.buffer instanceof ArrayBuffer
    ? new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
    : new Uint8ClampedArray(pixels);
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
  const quickWorkerRef = useRef<V3PreviewWorkerClient | null>(null);
  const detailWorkerRef = useRef<V3PreviewWorkerClient | null>(null);
  const detailRenderingRef = useRef(false);
  const analysisWorkerRef = useRef<V3PreviewWorkerClient | null>(null);
  const beforeWorkerRef = useRef<V3PreviewWorkerClient | null>(null);
  const hasRenderedRef = useRef(false);
  const drawnRequestRef = useRef(0);
  const drawnFrameRef = useRef<DrawnFrame | null>(null);
  const lastInteractiveRevisionRef = useRef<number | null>(null);
  const beforeContentKeyRef = useRef<string | null>(null);
  const maskMattesRef = useRef<{
    readonly key: string;
    readonly value: Promise<readonly V3PreviewMaskMatte[]>;
  } | null>(null);
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
    const document = session?.previewDocument ?? session?.persistedDocument;
    return session?.processKind === "v3" && document?.version === 3
      ? document
      : null;
  });
  const previewMode = useDevelopStore((state) => {
    const session = state.activeCatalogId === entry.catalogId
      ? state.sessions[entry.id]
      : undefined;
    return session?.transientEdit ? "interactive" : "settled";
  });
  const includePointColor = canvasTool.kind === "point-color";
  const maskTool = useDevelopStore((state) => {
    const session = state.activeCatalogId === entry.catalogId
      ? state.sessions[entry.id]
      : undefined;
    return session?.ui.tool ?? "none";
  });
  const beforeGeometry = document?.geometry ?? null;
  const beforeGeometryFrame = document?.local.geometryFrame ?? null;
  const beforeManualDistortion = document?.optics.manualDistortion ?? null;
  const beforeDocumentKey = beforeGeometry && beforeGeometryFrame &&
      beforeManualDistortion !== null
    ? JSON.stringify({
        geometry: beforeGeometry,
        geometryFrame: beforeGeometryFrame,
        manualDistortion: beforeManualDistortion,
      } satisfies BeforeDocumentInput)
    : null;
  const neutralBeforeDocument = useMemo(
    () => beforeDocumentKey
      ? beforeDocument(JSON.parse(beforeDocumentKey) as BeforeDocumentInput)
      : null,
    [beforeDocumentKey],
  );
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [displayDimensions, setDisplayDimensions] = useState({ width: 1, height: 1 });
  const [paintedRasterDimensions, setPaintedRasterDimensions] = useState<PaintedRasterDimensions | null>(null);
  const [beforeRasterDimensions, setBeforeRasterDimensions] = useState<DisplayDimensions | null>(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [previewTransform, setViewTransform] = useState<ViewerTransform>(FIT_TRANSFORM);
  const [wheelZoomDirect, setWheelZoomDirect] = useState(false);
  const [zoomFocus, setZoomFocus] = useState<{ x: number; y: number } | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  const [beforeReady, setBeforeReady] = useState(false);
  const [panning, setPanning] = useState(false);
  const [detailCanvasContainer, setDetailCanvasContainer] = useState<HTMLDivElement | null>(null);
  const [previewRenderScale, setPreviewRenderScale] = useState(1);
  const transformElementRef = useRef<HTMLDivElement | null>(null);
  const wheelZoomDirectRef = useRef(false);
  const beforeRasterRef = useRef<{ readonly contentKey: string; readonly dimensions: DisplayDimensions } | null>(null);

  const activeDisplayDimensions = displayDimensions;
  const [actualSize, setActualSize] = useState(false);
  const [actualPosition, setActualPosition] = useState({ x: 0.5, y: 0.5 });
  const [fullSourceDimensions, setFullSourceDimensions] = useState(() => initialFullSourceDimensions(entry, image));
  const fullSourceDimensionsRef = useRef(fullSourceDimensions);
  const pendingFullSourceDimensionsRef = useRef<DisplayDimensions | null>(null);
  const detailDimensions = useMemo(() => {
    if (!fullSourceDimensions || !document) return null;
    try {
      return resolveV3ExportDimensions(
        document,
        { dimensions: fullSourceDimensions, orientation: 1 },
        { mode: "original" },
      );
    } catch {
      return null;
    }
  }, [document, fullSourceDimensions]);
  const lastZoomRef = useRef<number | "actual">("actual");
  const actualScale = detailDimensions
    ? detailDimensions.width / (window.devicePixelRatio || 1) / displayDimensions.width
    : 1;
  const imageRect = useMemo(() => centeredImageRect(viewport, activeDisplayDimensions), [viewport, activeDisplayDimensions]);
  const viewTransform = useMemo(() => actualSize ? {
    scale: actualScale,
    ...clampViewerOffset(viewport, imageRect, actualScale, {
      x: viewport.width / 2 - (imageRect.x + actualPosition.x * imageRect.width) * actualScale,
      y: viewport.height / 2 - (imageRect.y + actualPosition.y * imageRect.height) * actualScale,
    }),
  } : previewTransform, [actualSize, actualScale, imageRect, actualPosition, viewport, previewTransform]);
  const viewTransformRef = useRef(viewTransform);
  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform;
  }, [viewTransform]);
  const zoomed = actualSize || viewTransform.scale !== 1;
  const maximumScale = Math.max(4, actualScale * 4);
  const detailPosition = actualSize ? actualPosition : {
    x: ((viewport.width / 2 - viewTransform.x) / viewTransform.scale - imageRect.x) / imageRect.width,
    y: ((viewport.height / 2 - viewTransform.y) / viewTransform.scale - imageRect.y) / imageRect.height,
  };
  const canvasInteractionActive = cropActive || canvasTool.kind !== "none" ||
    (maskingActive && maskTool !== "none");

  const applyFullSourceDimensions = useCallback((dimensions: DisplayDimensions) => {
    const current = fullSourceDimensionsRef.current;
    if (current?.width === dimensions.width && current.height === dimensions.height) return;
    fullSourceDimensionsRef.current = dimensions;
    setFullSourceDimensions(dimensions);
  }, []);

  const reportFullSourceDimensions = useCallback((dimensions: DisplayDimensions) => {
    const validated = positiveDimensions(dimensions.width, dimensions.height);
    if (!validated) return;
    const current = pendingFullSourceDimensionsRef.current ?? fullSourceDimensionsRef.current;
    if (current?.width === validated.width && current.height === validated.height) return;
    if (panRef.current) {
      pendingFullSourceDimensionsRef.current = validated;
      return;
    }
    applyFullSourceDimensions(validated);
  }, [applyFullSourceDimensions]);

  useEffect(() => {
    if (panning) return;
    const timeout = window.setTimeout(() => {
      if (panRef.current) return;
      setPreviewRenderScale((current) => current === viewTransform.scale ? current : viewTransform.scale);
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [panning, viewTransform.scale]);

  useEffect(() => {
    diagnosticsCallbackRef.current = onRenderDiagnostics;
  }, [onRenderDiagnostics]);

  useEffect(() => {
    analysisCallbackRef.current = onAnalysis;
  }, [onAnalysis]);

  useEffect(() => {
    hasRenderedRef.current = false;
    drawnRequestRef.current = 0;
    drawnFrameRef.current = null;
    lastInteractiveRevisionRef.current = null;
    maskMattesRef.current = null;
    detailRenderingRef.current = false;
    let worker: V3PreviewWorkerClient;
    try {
      worker = new V3PreviewWorkerClient(entry, image);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Could not start the preview worker.";
      const timeout = window.setTimeout(() => {
        setPreview({ kind: "invalid", message });
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    quickWorkerRef.current = worker;

    return () => {
      worker.dispose();
      detailWorkerRef.current?.dispose();
      beforeWorkerRef.current?.dispose();
      analysisWorkerRef.current?.dispose();
      pointColorInputRef.current = null;
      clearActiveAnalysis(entry.catalogId, entry.id);
      quickWorkerRef.current = null;
      detailWorkerRef.current = null;
      beforeWorkerRef.current = null;
      analysisWorkerRef.current = null;
    };
  }, [entry, image]);

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
    let renderedViewportWidth = 0;
    let renderedViewportHeight = 0;
    let refineTimer: ReturnType<typeof setTimeout> | undefined;
    let analysisTimer: ReturnType<typeof setTimeout> | undefined;
    let animationFrame = 0;

    const render = (force = false) => {
      const width = Math.max(1, Math.round(container.clientWidth));
      const height = Math.max(1, Math.round(container.clientHeight));
      setViewport((current) => current.width === width && current.height === height ? current : { width, height });
      if (
        !force &&
        width === renderedViewportWidth &&
        height === renderedViewportHeight
      ) return;
      renderedViewportWidth = width;
      renderedViewportHeight = height;
      const session = getDevelopSession(entry.catalogId, entry.id);
      const quickWorker = quickWorkerRef.current;
      if (!session || !document || !quickWorker) {
        setPreview({ kind: "invalid", message: "Develop session is not ready." });
        return;
      }
      const renderSnapshot = session.snapshot();
      const drawnFrame = drawnFrameRef.current;
      const sameContent = drawnFrame?.documentRevision ===
          renderSnapshot.documentRevision &&
        drawnFrame.document === document &&
        drawnFrame.cropActive === cropActive;
      const devicePixelRatio = Math.min(2, Math.max(0.5, window.devicePixelRatio || 1));
      const requiredDimensions = requestedPreviewDimensions(
        width,
        height,
        previewRenderScale,
        devicePixelRatio,
        { width: canvas.width, height: canvas.height },
      );
      const currentAnalysis = activeAnalysis.get(analysisKey(entry.catalogId, entry.id));
      const hasCurrentAnalysis = cropActive ||
        (currentAnalysis !== undefined && currentAnalysis.analysis.length > 0 &&
          currentAnalysis.binding.documentRevision === renderSnapshot.documentRevision &&
          currentAnalysis.binding.assetRevision === entry.assetRevision);
      const canReuseSettledFrame = previewMode === "settled" && sameContent &&
        drawnFrame?.mode === "settled" &&
        (drawnFrame.rasterSaturated ||
          (canvas.width >= requiredDimensions.width && canvas.height >= requiredDimensions.height)) &&
        (!includePointColor || pointColorInputRef.current !== null) &&
        hasCurrentAnalysis;
      if (canReuseSettledFrame && drawnFrame) {
        const scale = Math.min(width / canvas.width, height / canvas.height);
        setDisplayDimensions((current) => {
          const next = {
            width: Math.max(1, Math.round(canvas.width * scale)),
            height: Math.max(1, Math.round(canvas.height * scale)),
          };
          return current.width === next.width && current.height === next.height ? current : next;
        });
        drawnFrameRef.current = {
          ...drawnFrame,
          viewportHeight: height,
          viewportWidth: width,
        };
        renderedViewportWidth = width;
        renderedViewportHeight = height;
        return;
      }
      if (previewMode === "interactive") {
        lastInteractiveRevisionRef.current = renderSnapshot.documentRevision;
        if (sameContent && drawnFrame?.viewportWidth === width &&
            drawnFrame.viewportHeight === height &&
            drawnFrame.viewportScale === previewRenderScale) return;
      }
      const interactionRelease = previewMode === "settled" &&
        lastInteractiveRevisionRef.current === renderSnapshot.documentRevision;
      if (interactionRelease && sameContent && drawnFrame?.viewportWidth === width &&
          drawnFrame.viewportHeight === height && drawnFrame.viewportScale === previewRenderScale &&
          drawnFrame.mode === "settled" &&
          (!includePointColor || pointColorInputRef.current !== null)) return;

      clearTimeout(refineTimer);
      clearTimeout(analysisTimer);
      const sameContentSettledRender = previewMode === "settled" && sameContent &&
        drawnFrame?.mode === "settled";
      if (!sameContent) {
        pointColorInputRef.current = null;
        setShowBefore(false);
        clearActiveAnalysis(entry.catalogId, entry.id);
        analysisCallbackRef.current?.(EMPTY_ANALYSIS);
      }
      const requestId = ++requestRef.current;
      if (!hasRenderedRef.current) setPreview({ kind: "loading" });
      if (detailRenderingRef.current) {
        detailWorkerRef.current?.dispose();
        detailWorkerRef.current = null;
        detailRenderingRef.current = false;
      }
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

      const applyResult = (
        result: V3PreviewRenderOutput,
        mode: V3PreviewRenderMode,
        backend: V3PreviewBackend,
      ): boolean => {
        const closeBitmap = (): void => {
          if (result.kind === "rendered" && "bitmap" in result) {
            result.bitmap.close();
          }
        };
        if (disposed || requestId !== requestRef.current) {
          closeBitmap();
          return false;
        }
        const currentSnapshot = session.snapshot();
        if (
          renderSnapshot.processKind !== "v3" ||
          currentSnapshot.processKind !== "v3" ||
          currentSnapshot.documentRevision !== renderSnapshot.documentRevision
        ) {
          closeBitmap();
          return false;
        }
        if (result.kind !== "rendered") {
          pointColorInputRef.current = null;
          if (result.kind === "blocked") {
            diagnosticsCallbackRef.current?.(result.diagnostics);
            analysisCallbackRef.current?.(EMPTY_ANALYSIS);
            setPreview({ kind: "blocked", message: resultMessage(result) });
          } else if (result.kind === "invalid") {
            diagnosticsCallbackRef.current?.([]);
            analysisCallbackRef.current?.(EMPTY_ANALYSIS);
            setPreview({ kind: "invalid", message: resultMessage(result) });
          }
          return false;
        }
        const dimensions = result.dimensions;
        const keepExistingRaster = sameContent && drawnFrame?.mode === "settled" &&
          canvas.width * canvas.height >= dimensions.width * dimensions.height;
        if (!keepExistingRaster) {
          pointColorInputRef.current = result.pointColorInput;
          if (canvas.width !== dimensions.width) canvas.width = dimensions.width;
          if (canvas.height !== dimensions.height) canvas.height = dimensions.height;
          if ("bitmap" in result) {
            context.drawImage(result.bitmap, 0, 0);
            result.bitmap.close();
          } else {
            context.putImageData(
              new ImageData(
                imageDataPixels(result.pixels.pixels),
                dimensions.width,
                dimensions.height,
              ),
              0,
              0,
            );
          }
        } else if ("bitmap" in result) {
          result.bitmap.close();
        } else if (!pointColorInputRef.current) {
          pointColorInputRef.current = result.pointColorInput;
        }
        const paintedDimensions = { width: canvas.width, height: canvas.height };
        setPaintedRasterDimensions((current) =>
          current?.width === paintedDimensions.width && current.height === paintedDimensions.height
            && current.document === document &&
            current.documentRevision === renderSnapshot.documentRevision &&
            current.cropActive === cropActive && current.entryId === entry.id &&
            current.assetRevision === entry.assetRevision
            ? current
            : {
                ...paintedDimensions,
                document,
                documentRevision: renderSnapshot.documentRevision,
                cropActive,
                entryId: entry.id,
                assetRevision: entry.assetRevision,
              },
        );
        const scale = Math.min(width / paintedDimensions.width, height / paintedDimensions.height);
        setDisplayDimensions((current) => {
          const next = {
            width: Math.max(1, Math.round(paintedDimensions.width * scale)),
            height: Math.max(1, Math.round(paintedDimensions.height * scale)),
          };
          return current.width === next.width && current.height === next.height ? current : next;
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
          analysisCallbackRef.current?.(result.analysis.length ? result.analysis : EMPTY_ANALYSIS);
        }
        drawnRequestRef.current = Math.max(drawnRequestRef.current, requestId);
        const requestedDimensions = requestedPreviewDimensions(
          width,
          height,
          previewRenderScale,
          Math.min(2, Math.max(0.5, window.devicePixelRatio || 1)),
          dimensions,
        );
        drawnFrameRef.current = {
          backend: keepExistingRaster && drawnFrame ? drawnFrame.backend : backend,
          cropActive,
          document,
          documentRevision: renderSnapshot.documentRevision,
          mode: keepExistingRaster && drawnFrame ? drawnFrame.mode : mode,
          rasterSaturated: keepExistingRaster && drawnFrame
            ? drawnFrame.rasterSaturated
            : mode === "settled" && (dimensions.width < requestedDimensions.width ||
              dimensions.height < requestedDimensions.height),
          viewportHeight: height,
          viewportWidth: width,
          viewportScale: keepExistingRaster && drawnFrame
            ? drawnFrame.viewportScale
            : previewRenderScale,
        };
        hasRenderedRef.current = true;
        setPreview((current) => current.kind === "rendered" ? current : { kind: "rendered" });
        return true;
      };

      const renderPreview = async (): Promise<void> => {
        const maskMatteKey = JSON.stringify(renderDocument.local.maskAssetRefs);
        if (maskMattesRef.current?.key !== maskMatteKey) {
          maskMattesRef.current = {
            key: maskMatteKey,
            value: loadV3PreviewMaskMattes(renderDocument, entry, image),
          };
        }
        const maskMattes = await maskMattesRef.current.value;
        if (disposed || requestId !== requestRef.current) return;
        const options = {
          viewportDimensions: {
            width: Math.max(1, Math.round(width * previewRenderScale)),
            height: Math.max(1, Math.round(height * previewRenderScale)),
          },
          devicePixelRatio: window.devicePixelRatio || 1,
          maskMattes,
          includePointColor,
        } as const;
        let backend = drawnFrame?.backend ?? null;
        if (!interactionRelease && !sameContentSettledRender) {
          const quick = await quickWorker.render(renderDocument, {
            ...options,
            previewMode: "interactive",
            includeAnalysis: false,
          });
          if (!applyResult(quick.result, "interactive", quick.backend)) return;
          backend = quick.backend;
          if (disposed || requestId !== requestRef.current) return;
        }

        if (previewMode === "interactive") {
          refineTimer = setTimeout(() => {
            if (disposed || requestId !== requestRef.current) return;
            void quickWorker.render(renderDocument, {
              ...options,
              previewMode: "refined",
              includeAnalysis: false,
            }).then((refined) => {
              applyResult(refined.result, "refined", refined.backend);
            }).catch(handleRenderError);
          }, 100);
          return;
        }

        const detailWorker = backend === "gpu"
          ? quickWorker
          : detailWorkerRef.current ?? new V3PreviewWorkerClient(entry, image);
        if (detailWorker !== quickWorker) {
          detailWorkerRef.current = detailWorker;
          detailRenderingRef.current = true;
        }
        const detailed = await detailWorker.render(renderDocument, {
          ...options,
          previewMode: "settled",
          includeAnalysis: backend !== "gpu" && !cropActive,
        }).finally(() => {
          if (detailWorkerRef.current === detailWorker) detailRenderingRef.current = false;
        });
        if (!applyResult(detailed.result, "settled", detailed.backend)) return;
        if (cropActive || disposed || requestId !== requestRef.current ||
            (detailed.result.kind === "rendered" && detailed.result.analysis.length > 0)) return;
        analysisTimer = setTimeout(() => {
          void renderAnalysis().catch(handleRenderError);
        }, 120);
        const renderAnalysis = async (): Promise<void> => {
          if (disposed || requestId !== requestRef.current) return;
          const analysisWorker = analysisWorkerRef.current ??= new V3PreviewWorkerClient(entry, image);
          const analyzed = await analysisWorker.render(renderDocument, {
            ...options,
            previewMode: "settled",
            includeAnalysis: true,
          });
          const result = analyzed.result;
          if (result.kind !== "rendered") return;
          if ("bitmap" in result) result.bitmap.close();
          if (disposed || requestId !== requestRef.current ||
              session.snapshot().documentRevision !== renderSnapshot.documentRevision) return;
          pointColorInputRef.current = result.pointColorInput;
          bindActiveAnalysis(result.analysis, {
            catalogId: entry.catalogId,
            entryId: entry.id,
            assetRevision: entry.assetRevision,
            documentRevision: renderSnapshot.documentRevision,
            planFingerprint: result.planFingerprint,
          });
          analysisCallbackRef.current?.(result.analysis);
        };
      };

      const handleRenderError = (error: unknown): void => {
        if (disposed || requestId !== requestRef.current) return;
        if (!hasRenderedRef.current) {
          diagnosticsCallbackRef.current?.([]);
          analysisCallbackRef.current?.(EMPTY_ANALYSIS);
          setPreview({
            kind: "invalid",
            message: error instanceof Error ? error.message : "Could not render the preview.",
          });
        }
      };
      void renderPreview().catch(handleRenderError);
    };

    const scheduleRender = (force = false): void => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => render(force));
    };
    scheduleRender(true);
    const observer = new ResizeObserver(() => scheduleRender());
    observer.observe(container);
    return () => {
      disposed = true;
      clearTimeout(refineTimer);
      clearTimeout(analysisTimer);
      cancelAnimationFrame(animationFrame);
      if (detailRenderingRef.current) {
        detailWorkerRef.current?.dispose();
        detailWorkerRef.current = null;
        detailRenderingRef.current = false;
      }
      observer.disconnect();
    };
  }, [cropActive, document, documentRevision, entry, image, includePointColor, previewMode, previewRenderScale]);

  useEffect(() => {
    const container = containerRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    const sourceContext = sourceCanvas?.getContext("2d") ?? null;
    if (
      !container ||
      !sourceCanvas ||
      !sourceContext ||
      !neutralBeforeDocument
    ) return;

    let disposed = false;
    const width = Math.max(1, Math.round(container.clientWidth));
    const height = Math.max(1, Math.round(container.clientHeight));
    const renderDocument = cropActive
      ? {
          ...neutralBeforeDocument,
          geometry: {
            ...neutralBeforeDocument.geometry,
            constrainCrop: false,
            crop: { ...neutralBeforeDocument.geometry.crop, enabled: false },
          },
        }
      : neutralBeforeDocument;
    const beforeContentKey = JSON.stringify([
      entry.catalogId,
      entry.id,
      entry.assetRevision,
      cropActive,
      renderDocument,
    ]);
    if (beforeContentKeyRef.current !== beforeContentKey) {
      beforeContentKeyRef.current = beforeContentKey;
      beforeRasterRef.current = null;
      setBeforeReady(false);
      setBeforeRasterDimensions(null);
      setShowBefore(false);
    }

    const timeout = window.setTimeout(() => {
      let beforeWorker: V3PreviewWorkerClient;
      try {
        beforeWorker = beforeWorkerRef.current ?? new V3PreviewWorkerClient(entry, image);
      } catch {
        if (!disposed) setBeforeReady(false);
        return;
      }
      beforeWorkerRef.current = beforeWorker;
      void beforeWorker.render(renderDocument, {
        viewportDimensions: {
          width: Math.max(1, Math.round(width * previewRenderScale)),
          height: Math.max(1, Math.round(height * previewRenderScale)),
        },
        devicePixelRatio: window.devicePixelRatio || 1,
        previewMode: "settled",
        includeAnalysis: false,
        includePointColor: false,
      }).then(({ result: before }) => {
        if (disposed) {
          if (before.kind === "rendered" && "bitmap" in before) {
            before.bitmap.close();
          }
          return;
        }
        if (before.kind !== "rendered") return;
        const existingRaster = beforeRasterRef.current;
        const keepBeforeRaster = existingRaster?.contentKey === beforeContentKey &&
          existingRaster.dimensions.width * existingRaster.dimensions.height >=
            before.dimensions.width * before.dimensions.height;
        if (keepBeforeRaster) {
          if ("bitmap" in before) before.bitmap.close();
        } else {
          if (sourceCanvas.width !== before.dimensions.width) {
            sourceCanvas.width = before.dimensions.width;
          }
          if (sourceCanvas.height !== before.dimensions.height) {
            sourceCanvas.height = before.dimensions.height;
          }
          if ("bitmap" in before) {
            sourceContext.drawImage(before.bitmap, 0, 0);
            before.bitmap.close();
          } else {
            sourceContext.putImageData(
              new ImageData(
                imageDataPixels(before.pixels.pixels),
                before.dimensions.width,
                before.dimensions.height,
              ),
              0,
              0,
            );
          }
          beforeRasterRef.current = { contentKey: beforeContentKey, dimensions: before.dimensions };
          setBeforeRasterDimensions((current) =>
            current?.width === before.dimensions.width && current.height === before.dimensions.height
              ? current
              : before.dimensions,
          );
        }
        setBeforeReady(true);
      }).catch(() => {
        if (!disposed) setBeforeReady(false);
      });
    }, 250);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [
    cropActive,
    neutralBeforeDocument,
    entry,
    image,
    previewRenderScale,
  ]);

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
    factor: number,
    anchor = { x: viewport.width / 2, y: viewport.height / 2 },
  ) => {
    const current = viewTransformRef.current;
    const focus = {
      x: Math.max(0, Math.min(1, ((anchor.x - current.x) / current.scale - imageRect.x) / imageRect.width)),
      y: Math.max(0, Math.min(1, ((anchor.y - current.y) / current.scale - imageRect.y) / imageRect.height)),
    };
    setZoomFocus(focus);
    const nextScale = Math.max(1, Math.min(maximumScale, current.scale * factor));
    if (nextScale > 1) lastZoomRef.current = nextScale;
    setActualSize(false);
    const next = nextScale === 1 ? FIT_TRANSFORM : anchoredViewerTransform(
      current, nextScale, anchor, viewport,
      centeredImageRect(viewport, activeDisplayDimensions),
    );
    viewTransformRef.current = next;
    setViewTransform(next);
  }, [activeDisplayDimensions, imageRect, maximumScale, viewport]);

  const setWheelZoomDirectMode = useCallback((direct: boolean): void => {
    wheelZoomDirectRef.current = direct;
    setWheelZoomDirect(direct);
  }, []);

  function fit(): void {
    setWheelZoomDirectMode(false);
    if (zoomed) lastZoomRef.current = actualSize ? "actual" : viewTransform.scale;
    setZoomFocus(null);
    setActualSize(false);
    viewTransformRef.current = FIT_TRANSFORM;
    setViewTransform(FIT_TRANSFORM);
  }

  function zoomFromFit(pointer: { x: number; y: number }): ViewerTransform {
    setWheelZoomDirectMode(false);
    const position = {
      x: Math.max(0, Math.min(1, (pointer.x - imageRect.x) / imageRect.width)),
      y: Math.max(0, Math.min(1, (pointer.y - imageRect.y) / imageRect.height)),
    };
    setZoomFocus(position);
    if (lastZoomRef.current === "actual") {
      setActualPosition(position);
      setActualSize(true);
      const next = {
        scale: actualScale,
        ...clampViewerOffset(viewport, imageRect, actualScale, {
          x: viewport.width / 2 - (imageRect.x + position.x * imageRect.width) * actualScale,
          y: viewport.height / 2 - (imageRect.y + position.y * imageRect.height) * actualScale,
        }),
      };
      viewTransformRef.current = next;
      return next;
    } else {
      const scale = Math.min(maximumScale, lastZoomRef.current);
      const next = {
        scale,
        ...clampViewerOffset(viewport, imageRect, scale, {
          x: viewport.width / 2 - pointer.x * scale,
          y: viewport.height / 2 - pointer.y * scale,
        }),
      };
      setActualSize(false);
      viewTransformRef.current = next;
      setViewTransform(next);
      return next;
    }
  }

  const stepZoom = useCallback((direction: -1 | 1): void => {
    setWheelZoomDirectMode(false);
    applyZoom(1.25 ** direction);
  }, [applyZoom, setWheelZoomDirectMode]);

  const onWheel = useEffectEvent((event: WheelEvent): void => {
    if ((maskingActive && maskTool === "brush") || previewMode === "interactive" ||
        panRef.current || preview.kind !== "rendered" || event.deltaY === 0 ||
        (event.target instanceof Element && event.target.closest("button, input, select, [role=button]"))) return;
    event.preventDefault();
    const bounds = containerRef.current!.getBoundingClientRect();
    if (!wheelZoomDirectRef.current) {
      // Take over from the visible point of an in-flight control zoom.
      const transform = transformElementRef.current
        ? window.getComputedStyle(transformElementRef.current).transform
        : "none";
      if (transform !== "none") {
        try {
          const matrix = new DOMMatrixReadOnly(transform);
          if (matrix.is2D && Number.isFinite(matrix.a) && matrix.a > 0 &&
              Number.isFinite(matrix.d) && Math.abs(matrix.a - matrix.d) < 1e-6 &&
              Math.abs(matrix.b) < 1e-6 && Math.abs(matrix.c) < 1e-6 &&
              Number.isFinite(matrix.e) && Number.isFinite(matrix.f)) {
            viewTransformRef.current = {
              scale: (matrix.a + matrix.d) / 2,
              x: matrix.e,
              y: matrix.f,
            };
          }
        } catch {
          // Keep the latest transform ref when the browser cannot parse the computed value.
        }
      }
      setWheelZoomDirectMode(true);
    }
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? bounds.height : 1;
    const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
    applyZoom(Math.exp(-delta * 0.002), {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const wheel = (event: WheelEvent) => onWheel(event);
    container.addEventListener("wheel", wheel, { passive: false });
    return () => container.removeEventListener("wheel", wheel);
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const interactive = event.target instanceof Element &&
      Boolean(event.target.closest("button, input, select, [role=button]"));
    if (interactive || canvasInteractionActive || preview.kind !== "rendered" ||
        event.button !== 0 || !event.isPrimary) return;

    setWheelZoomDirectMode(false);

    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const imageX = (pointer.x - viewTransform.x) / viewTransform.scale;
    const imageY = (pointer.y - viewTransform.y) / viewTransform.scale;
    if (imageX < imageRect.x || imageX > imageRect.x + imageRect.width ||
        imageY < imageRect.y || imageY > imageRect.y + imageRect.height) return;

    const startedAtFit = !zoomed;
    const startTransform = startedAtFit ? zoomFromFit(pointer) : viewTransform;
    const gestureActualSize = startedAtFit
      ? lastZoomRef.current === "actual"
      : actualSize;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: startTransform.x,
      y: startTransform.y,
      scale: startTransform.scale,
      actualSize: gestureActualSize,
      startedAtFit,
      moved: false,
    };
    setPanning(!startedAtFit);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - pan.startX, event.clientY - pan.startY) > 4 && !pan.moved) {
      pan.moved = true;
      if (pan.startedAtFit) setPanning(true);
    }
    if (!pan.moved) return;
    setZoomFocus(null);
    const offset = clampViewerOffset(viewport, imageRect, pan.scale, {
        x: pan.x + event.clientX - pan.startX,
        y: pan.y + event.clientY - pan.startY,
      });
    if (pan.actualSize) {
      setActualPosition({
        x: ((viewport.width / 2 - offset.x) / pan.scale - imageRect.x) / imageRect.width,
        y: ((viewport.height / 2 - offset.y) / pan.scale - imageRect.y) / imageRect.height,
      });
    } else {
      setViewTransform({ scale: pan.scale, ...offset });
    }
  }

  function finishPan(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
    const pendingDimensions = pendingFullSourceDimensionsRef.current;
    pendingFullSourceDimensionsRef.current = null;
    if (pendingDimensions) applyFullSourceDimensions(pendingDimensions);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (event.type === "pointerup" && !pan.startedAtFit && !pan.moved && !canvasInteractionActive) fit();
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
      if (canvasInteractionActive || panRef.current) return;
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

  const sourceResult = useMemo(() => buildV3SourceRecord(entry, image, "preview"), [entry, image]);
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
  const currentPaintedRasterDimensions = paintedRasterDimensions?.document === document &&
      paintedRasterDimensions.documentRevision === documentRevision &&
      paintedRasterDimensions.cropActive === cropActive &&
      paintedRasterDimensions.entryId === entry.id &&
      paintedRasterDimensions.assetRevision === entry.assetRevision
    ? { width: paintedRasterDimensions.width, height: paintedRasterDimensions.height }
    : undefined;

  return (
    <div
      ref={containerRef}
      className={[
        "relative h-full min-h-0 w-full touch-none select-none overflow-hidden",
        canvasInteractionActive || preview.kind !== "rendered"
          ? ""
          : viewTransform.scale > 1
            ? panning ? "cursor-grabbing" : "cursor-grab"
            : "cursor-zoom-in",
      ].join(" ")}
      aria-busy={preview.kind === "loading"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPan}
      onPointerCancel={finishPan}
      onLostPointerCapture={finishPan}
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
            aria-pressed={!actualSize && viewTransform.scale === 1}
            onClick={fit}
            className={[
              "rounded-md px-2 py-1 text-[10px] uppercase tracking-wide",
              !actualSize && viewTransform.scale === 1
                ? "bg-lr-selection text-lr-accent"
                : "text-white/65 hover:text-white",
            ].join(" ")}
          >
            Fit
          </button>
          <span
            role="status"
            aria-label={detailDimensions
              ? `Zoom ${Math.round(viewTransform.scale / actualScale * 100)} percent`
              : actualSize ? "Loading full-resolution dimensions" : `Preview enlargement ${viewTransform.scale} times Fit`}
            className="w-10 text-center font-mono text-[10px] text-white/75"
          >
            {!zoomed ? "" : detailDimensions
              ? `${Math.round(viewTransform.scale / actualScale * 100)}%`
              : actualSize ? "…" : `${Number(viewTransform.scale.toFixed(2))}× Fit`}
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            aria-keyshortcuts="+"
            disabled={viewTransform.scale >= maximumScale}
            onClick={() => stepZoom(1)}
            className="rounded px-2 py-1 text-xs text-white/65 hover:text-white disabled:opacity-35"
          >
            +
          </button>
          <button
            type="button"
            aria-pressed={actualSize || (zoomed && Math.abs(viewTransform.scale - actualScale) < 0.001)}
            onClick={() => {
              setWheelZoomDirectMode(false);
              setActualPosition(detailPosition);
              setZoomFocus(detailPosition);
              setActualSize(true);
            }}
            className={`rounded px-2 py-1 text-xs ${actualSize ? "bg-lr-selection text-lr-accent" : "text-white"}`}
          >
            100%
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
      {document ? (
        <PhotoLoupe
          key={`${entry.id}:${entry.assetRevision}`}
          entry={entry}
          document={showBefore ? neutralBeforeDocument ?? document : document}
          position={detailPosition}
          focusPosition={zoomFocus ?? detailPosition}
          basePreviewDimensions={showBefore
            ? beforeRasterDimensions ?? currentPaintedRasterDimensions
            : currentPaintedRasterDimensions}
          displaySize={actualSize ? undefined : { width: displayDimensions.width * viewTransform.scale, height: displayDimensions.height * viewTransform.scale }}
          onSourceDimensions={reportFullSourceDimensions}
          active={preview.kind === "rendered" && !canvasInteractionActive}
          showStatus={zoomed}
          preload
          passive
          panning={panning}
          canvasContainer={detailCanvasContainer}
        />
      ) : null}
      <div
        ref={transformElementRef}
        className={[
          "absolute inset-0 will-change-transform",
          preview.kind === "rendered" ? "" : "invisible",
          panning || wheelZoomDirect
            ? "transition-none"
            : "transition-transform duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
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
        <div
          ref={setDetailCanvasContainer}
          className="pointer-events-none absolute inset-0 transition-none"
          style={{
            // Undo the target view so detail follows the shared outer animation.
            transform: `scale(${1 / viewTransform.scale}) translate(${-viewTransform.x}px, ${-viewTransform.y}px)`,
            transformOrigin: "0 0",
          }}
        />
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
