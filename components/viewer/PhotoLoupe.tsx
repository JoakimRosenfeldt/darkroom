"use client";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { disposeDevelopImage, loadDevelopExportImage, type DevelopImage } from "@/lib/cache/develop-image-cache";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import { buildV3SourceRecord, loadV3PreviewMaskMattes, resolveV3ExportDimensions } from "@/lib/develop/v3/runtime";
import { V3PreviewWorkerClient } from "@/lib/develop/v3/preview-worker-client";
import { useDevelopStore } from "@/stores/develop-store";
import type { ExportSizeOptions } from "@/lib/export/types";
import type { LibraryEntry } from "@/lib/fs/types";
import {
  coveringDetailTiles,
  createDetailViewGeometry,
  DETAIL_TILE_BYTES,
  DetailTileCache,
  detailLevelKey,
  MAX_DETAIL_CACHE_BYTES,
  planDetailTiles,
  quantizeDetailDensity,
  type DetailDimensions,
  type DetailLevel,
  type DetailTile,
  type DetailTileRequest,
} from "@/lib/viewer/detail-tiles";

export interface LoupePosition { x: number; y: number }

type LoupeViewport = { width: number; height: number; dpr: number };
type LoupeSource = { entry: LibraryEntry; image: DevelopImage };
type ExportGeometry = Extract<ReturnType<typeof buildV3SourceRecord>, { kind: "source" }>['source'];
type RenderInput = {
  entry: LibraryEntry;
  source: LoupeSource;
  document: DevelopDocumentV3;
  center: LoupePosition;
  focus: LoupePosition;
  interactive: boolean;
  displayWidth: number | undefined;
  viewport: LoupeViewport;
};
type DimensionsContext = {
  source: LoupeSource;
  document: DevelopDocumentV3;
  dimensions: DetailDimensions;
};
type CacheOwner = {
  entry: LibraryEntry;
  image: DevelopImage | null;
  document: DevelopDocumentV3;
};
type PlannedView = {
  readonly fullDimensions: DetailDimensions;
  readonly level: DetailLevel;
  readonly geometry: ReturnType<typeof createDetailViewGeometry>;
  readonly visible: readonly DetailTileRequest[];
  readonly prefetch: readonly DetailTileRequest[];
  readonly missingVisible: readonly DetailTileRequest[];
  readonly failedVisible: readonly DetailTileRequest[];
};

const LOADING_STATUS = "Loading full-resolution photo…";

function sameViewport(left: LoupeViewport, right: LoupeViewport): boolean {
  return left.width === right.width && left.height === right.height && left.dpr === right.dpr;
}

function sameView(left: RenderInput, right: RenderInput): boolean {
  return left.entry === right.entry && left.source === right.source && left.document === right.document &&
    left.center.x === right.center.x && left.center.y === right.center.y &&
    left.focus.x === right.focus.x && left.focus.y === right.focus.y &&
    left.displayWidth === right.displayWidth && sameViewport(left.viewport, right.viewport) &&
    left.interactive === right.interactive;
}

function requestBytes(request: DetailTileRequest): number {
  return request.width * request.height * 4;
}

function intersectsView(tile: DetailTile, originX: number, originY: number, width: number, height: number): boolean {
  return tile.fullX < originX + width && tile.fullX + tile.fullWidth > originX &&
    tile.fullY < originY + height && tile.fullY + tile.fullHeight > originY;
}

export function PhotoLoupe({ entry, document, position, focusPosition, onPositionChange, displaySize, basePreviewDimensions, onSourceDimensions, active = true, preload = false, passive = false, panning = false, showStatus = true }: {
  entry: LibraryEntry;
  document: DevelopDocumentV3;
  position?: LoupePosition;
  focusPosition?: LoupePosition;
  onPositionChange?: (position: LoupePosition) => void;
  displaySize?: { width: number; height: number };
  basePreviewDimensions?: DetailDimensions;
  onSourceDimensions?: (dimensions: { width: number; height: number }) => void;
  active?: boolean;
  preload?: boolean;
  passive?: boolean;
  panning?: boolean;
  showStatus?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; position: LoupePosition } | null>(null);
  const dimensionsRef = useRef<DetailDimensions>({ width: 1, height: 1 });
  const dimensionsContextRef = useRef<DimensionsContext | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const fadeAnimationRef = useRef(0);
  const activeRef = useRef(active);
  const panningRef = useRef(panning);
  const cacheRef = useRef(new DetailTileCache());
  const cacheOwnerRef = useRef<CacheOwner | null>(null);
  const statusRef = useRef<{ entry: LibraryEntry; value: string }>({ entry, value: LOADING_STATUS });
  const interactive = useDevelopStore((state) =>
    state.activeCatalogId === entry.catalogId && Boolean(state.sessions[entry.id]?.transientEdit),
  );
  const [localPosition, setLocalPosition] = useState({ x: 0.5, y: 0.5 });
  const centerX = position?.x ?? localPosition.x;
  const centerY = position?.y ?? localPosition.y;
  const center = useMemo(() => ({ x: centerX, y: centerY }), [centerX, centerY]);
  const focusX = focusPosition?.x ?? centerX;
  const focusY = focusPosition?.y ?? centerY;
  const focus = useMemo(() => ({ x: focusX, y: focusY }), [focusX, focusY]);
  const [viewport, setViewport] = useState<LoupeViewport>({ width: 1, height: 1, dpr: 1 });
  const [source, setSource] = useState<LoupeSource | null>(null);
  const [readyEntry, setReadyEntry] = useState<LibraryEntry | null>(() => active && !passive ? entry : null);
  const loadReady = readyEntry === entry;
  const workerRef = useRef<V3PreviewWorkerClient | null>(null);
  const [visibleBusy, setVisibleBusy] = useState(false);
  const [statusState, setStatusState] = useState<{ entry: LibraryEntry; value: string }>({ entry, value: LOADING_STATUS });
  const status = statusState.entry === entry ? statusState.value : LOADING_STATUS;
  const reportSourceDimensions = useEffectEvent((dimensions: DetailDimensions) => onSourceDimensions?.(dimensions));
  const reportStatus = useEffectEvent((value: string) => {
    statusRef.current = { entry, value };
    setStatusState({ entry, value });
  });
  const displayWidth = displaySize?.width;
  const currentInput = useMemo<RenderInput | null>(() => source?.entry === entry
    ? { entry, source, document, center, focus, interactive, displayWidth, viewport }
    : null,
  [source, entry, document, center, focus, interactive, displayWidth, viewport]);
  const currentInputRef = useRef(currentInput);

  const drawCachedTiles = useCallback((): void => {
    const canvas = canvasRef.current;
    const input = currentInputRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const width = Math.max(1, Math.round(viewport.width * viewport.dpr));
    const height = Math.max(1, Math.round(viewport.height * viewport.dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    context.globalAlpha = 1;
    context.clearRect(0, 0, viewport.width, viewport.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    const dimensionContext = dimensionsContextRef.current;
    if (!input || !dimensionContext || dimensionContext.source !== input.source || dimensionContext.document !== input.document) return;
    const fullDimensions = dimensionContext.dimensions;
    const cssScale = input.displayWidth === undefined ? 1 / input.viewport.dpr : input.displayWidth / fullDimensions.width;
    const geometry = createDetailViewGeometry(fullDimensions, input.viewport, input.center, cssScale);
    const baseDensityX = basePreviewDimensions ? basePreviewDimensions.width / fullDimensions.width : 0;
    const baseDensityY = basePreviewDimensions ? basePreviewDimensions.height / fullDimensions.height : 0;
    const visibleTiles = cacheRef.current.values()
      .filter((tile) => intersectsView(tile, geometry.originX, geometry.originY, geometry.visibleWidth, geometry.visibleHeight))
      .filter((tile) => tile.level.width / fullDimensions.width + 1e-9 >= baseDensityX && tile.level.height / fullDimensions.height + 1e-9 >= baseDensityY)
      .sort((left, right) => left.level.density - right.level.density);
    let hasFadingTile = false;

    for (const tile of visibleTiles) {
      const left = geometry.imageOffsetX + (tile.fullX - geometry.originX) * cssScale;
      const top = geometry.imageOffsetY + (tile.fullY - geometry.originY) * cssScale;
      const right = geometry.imageOffsetX + (tile.fullX + tile.fullWidth - geometry.originX) * cssScale;
      const bottom = geometry.imageOffsetY + (tile.fullY + tile.fullHeight - geometry.originY) * cssScale;
      const snappedLeft = Math.round(left * input.viewport.dpr) / input.viewport.dpr;
      const snappedTop = Math.round(top * input.viewport.dpr) / input.viewport.dpr;
      const snappedRight = Math.round(right * input.viewport.dpr) / input.viewport.dpr;
      const snappedBottom = Math.round(bottom * input.viewport.dpr) / input.viewport.dpr;
      if (snappedRight <= snappedLeft || snappedBottom <= snappedTop) continue;
      const opacity = Math.min(1, Math.max(0, (performance.now() - tile.fadeStartedAt) / 120));
      if (opacity < 1) hasFadingTile = true;
      context.globalAlpha = opacity;
      context.drawImage(tile.canvas, snappedLeft, snappedTop, snappedRight - snappedLeft, snappedBottom - snappedTop);
      cacheRef.current.touch(tile.key);
    }
    context.globalAlpha = 1;

    if (hasFadingTile && !fadeAnimationRef.current) {
      fadeAnimationRef.current = requestAnimationFrame(() => {
        fadeAnimationRef.current = 0;
        drawRef.current?.();
      });
    }

  }, [viewport, basePreviewDimensions]);

  useLayoutEffect(() => {
    activeRef.current = active;
    panningRef.current = panning;
    currentInputRef.current = currentInput;
    const ownerImage = source?.entry === entry ? source.image : null;
    const owner = cacheOwnerRef.current;
    if (owner?.entry !== entry || owner.image !== ownerImage || owner.document !== document) {
      cacheRef.current.clear();
      cacheOwnerRef.current = { entry, image: ownerImage, document };
      dimensionsContextRef.current = null;
      dimensionsRef.current = { width: 1, height: 1 };
      if (fadeAnimationRef.current) cancelAnimationFrame(fadeAnimationRef.current);
      fadeAnimationRef.current = 0;
      setVisibleBusy(false);
      if (owner?.entry === entry && owner.document !== document) {
        const value = ownerImage ? "" : LOADING_STATUS;
        statusRef.current = { entry, value };
        setStatusState({ entry, value });
      }
    }
    if (statusRef.current.entry !== entry) {
      statusRef.current = { entry, value: LOADING_STATUS };
      setStatusState({ entry, value: LOADING_STATUS });
    }
    drawRef.current = drawCachedTiles;
    drawRef.current();
  }, [active, panning, currentInput, source, entry, document, viewport, basePreviewDimensions, drawCachedTiles]);

  useEffect(() => {
    if (loadReady || (!active && !preload) || (passive && panning)) return;
    const timer = setTimeout(() => setReadyEntry(entry), passive ? 200 : 0);
    return () => clearTimeout(timer);
  }, [loadReady, entry, active, preload, passive, panning, displayWidth]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight, dpr: window.devicePixelRatio || 1 };
      setViewport((current) => sameViewport(current, next) ? current : next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);

  useEffect(() => {
    if (!loadReady) return;
    const controller = new AbortController();
    let image: DevelopImage | undefined;
    void loadDevelopExportImage(entry, { rawColorMode: "libraw-camera-matrix", signal: controller.signal }).then((loaded) => {
      image = loaded;
      if (controller.signal.aborted) { disposeDevelopImage(loaded); return; }
      if (loaded.pixelProvenance.decoderPath === "embedded-preview") throw new Error("Full RAW decoding failed. An embedded preview cannot show 1:1 detail.");
      try {
        reportSourceDimensions({ width: loaded.width, height: loaded.height });
      } catch {
        reportStatus("Full-resolution dimensions could not be applied.");
      }
      setSource({ entry, image: loaded });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) reportStatus(error instanceof Error ? error.message : "Full-resolution photo unavailable.");
    });
    return () => {
      controller.abort();
      workerRef.current?.dispose();
      workerRef.current = null;
      if (image) disposeDevelopImage(image);
    };
  }, [entry, loadReady]);

  useEffect(() => {
    if (!source || source.entry !== entry) return;
    let effectActive = true;
    let rendering = false;
    let animationFrame = 0;
    let dimensionDocument: DevelopDocumentV3 | null = null;
    let fullDimensions: DetailDimensions | null = null;
    let sourceGeometry: ExportGeometry | null = null;
    let levels = new Map<string, DetailLevel>();
    let maskMattes: { key: string; value: ReturnType<typeof loadV3PreviewMaskMattes> } | null = null;
    let failedDocument: DevelopDocumentV3 | null = null;
    let failedKeys = new Set<string>();

    const clearSchedule = (): void => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    const isCurrentOwner = (input: RenderInput): boolean => {
      const latest = currentInputRef.current;
      return effectActive && latest !== null && latest.entry === entry && latest.source === source &&
        latest.document === input.document;
    };

    const planForInput = (input: RenderInput): PlannedView => {
      if (dimensionDocument !== input.document || !fullDimensions) {
        const record = buildV3SourceRecord(entry, source.image, "export");
        if (record.kind !== "source") throw new Error("Source color information is unavailable.");
        const resolved = resolveV3ExportDimensions(input.document, record.source, { mode: "original" });
        if (!resolved) throw new Error("This photo exceeds the supported full-resolution size.");
        dimensionDocument = input.document;
        fullDimensions = resolved;
        sourceGeometry = record.source;
        levels = new Map();
        failedDocument = input.document;
        failedKeys = new Set();
      }
      const resolvedFullDimensions = fullDimensions;
      if (!resolvedFullDimensions || !sourceGeometry) throw new Error("The detail preview dimensions are unavailable.");
      dimensionsRef.current = resolvedFullDimensions;
      dimensionsContextRef.current = { source, document: input.document, dimensions: resolvedFullDimensions };

      const cssScale = input.displayWidth === undefined ? 1 / input.viewport.dpr : input.displayWidth / resolvedFullDimensions.width;
      const density = quantizeDetailDensity(cssScale * input.viewport.dpr);
      const levelKey = detailLevelKey(density);
      let level = levels.get(levelKey);
      if (!level) {
        const size: ExportSizeOptions = density >= 1
          ? { mode: "original" }
          : { mode: "long-edge", pixels: Math.max(1, Math.round(Math.max(resolvedFullDimensions.width, resolvedFullDimensions.height) * density)), neverUpscale: true };
        const dimensions = resolveV3ExportDimensions(input.document, sourceGeometry, size);
        if (!dimensions) throw new Error("The detail preview dimensions are unavailable.");
        level = { ...dimensions, density, key: levelKey };
        levels.set(levelKey, level);
      }

      const geometry = createDetailViewGeometry(resolvedFullDimensions, input.viewport, input.center, cssScale);
      const plan = planDetailTiles(resolvedFullDimensions, level, geometry, input.focus);
      const cache = cacheRef.current;
      const cachedTiles = cache.values();
      const protectedKeys = new Set<string>();
      const missingVisible: DetailTileRequest[] = [];
      const failedVisible: DetailTileRequest[] = [];
      for (const request of plan.visible) {
        if (cache.get(request.key)) {
          protectedKeys.add(request.key);
          continue;
        }
        const covering = coveringDetailTiles(request, cachedTiles);
        if (covering.length > 0) {
          for (const tile of covering) protectedKeys.add(tile.key);
          continue;
        }
        protectedKeys.add(request.key);
        if (failedDocument === input.document && failedKeys.has(request.key)) failedVisible.push(request);
        else missingVisible.push(request);
      }
      const visibleBytes = plan.visible.reduce((total, request) => total + requestBytes(request), 0);
      cache.setHighWaterBudget(Math.min(MAX_DETAIL_CACHE_BYTES, visibleBytes + DETAIL_TILE_BYTES));
      cache.setProtectedKeys(protectedKeys);
      setVisibleBusy(missingVisible.length > 0);
      if (missingVisible.length === 0 && failedVisible.length === 0 &&
        statusRef.current.entry === input.entry && statusRef.current.value === LOADING_STATUS) {
        reportStatus("");
      }
      return { fullDimensions: resolvedFullDimensions, level, geometry, visible: plan.visible, prefetch: plan.prefetch, missingVisible, failedVisible };
    };

    const sameLatestView = (requested: RenderInput): boolean => {
      const latest = currentInputRef.current;
      return latest !== null && sameView(requested, latest);
    };

    const renderTile = (input: RenderInput, request: DetailTileRequest, purpose: "visible" | "prefetch"): void => {
      if (rendering || !effectActive) return;
      rendering = true;
      void (async () => {
        try {
          const matteKey = JSON.stringify(input.document.local.maskAssetRefs);
          if (maskMattes?.key !== matteKey) {
            maskMattes = { key: matteKey, value: loadV3PreviewMaskMattes(input.document, entry, source.image) };
          }
          const mattes = await maskMattes.value;
          if (!effectActive) return;
          if (!sameLatestView(input) || (purpose === "prefetch" && (panningRef.current || input.interactive))) {
            return;
          }
          const worker = workerRef.current ?? new V3PreviewWorkerClient(entry, source.image);
          workerRef.current = worker;
          const size: ExportSizeOptions = request.level.density >= 1
            ? { mode: "original" }
            : { mode: "long-edge", pixels: Math.max(1, Math.round(Math.max(fullDimensions?.width ?? request.level.width, fullDimensions?.height ?? request.level.height) * request.level.density)), neverUpscale: true };
          const rendered = await worker.renderExport(input.document, size, mattes, {
            x: request.x,
            y: request.y,
            width: request.width,
            height: request.height,
          });
          const result = rendered.result;
          if (!isCurrentOwner(input)) {
            if (result.kind === "rendered" && "bitmap" in result) result.bitmap.close();
            return;
          }
          if (result.kind === "cancelled") {
            failedKeys.add(request.key);
            if (purpose === "visible") reportStatus("The detail preview was cancelled.");
            return;
          }
          if (result.kind !== "rendered" || "bitmap" in result) {
            if (result.kind === "rendered" && "bitmap" in result) result.bitmap.close();
            throw new Error("The saved edit could not be rendered at 1:1.");
          }
          if (result.dimensions.width !== request.width || result.dimensions.height !== request.height) {
            throw new Error("The detail tile dimensions do not match the requested region.");
          }

          const tileCanvas = window.document.createElement("canvas");
          tileCanvas.width = request.width;
          tileCanvas.height = request.height;
          const context = tileCanvas.getContext("2d");
          if (!context) throw new Error("Detail canvas rendering is unavailable.");
          const rgba = result.pixels.pixels;
          const imageData = new ImageData(rgba.buffer instanceof ArrayBuffer
            ? new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength)
            : new Uint8ClampedArray(rgba), request.width, request.height);
          context.putImageData(imageData, 0, 0);
          const tile: DetailTile = {
            ...request,
            canvas: tileCanvas,
            byteLength: tileCanvas.width * tileCanvas.height * 4,
            fadeStartedAt: performance.now(),
          };
          try {
            const latest = currentInputRef.current;
            if (latest && isCurrentOwner(latest)) planForInput(latest);
          } catch {
            // The completed tile can still be used if geometry resolution is temporarily unavailable.
          }
          const cached = cacheRef.current.add(tile);
          if (!cached) {
            failedKeys.add(request.key);
            if (purpose === "visible") reportStatus("Detail cache is full.");
            return;
          }
          drawRef.current?.();
          failedKeys.delete(request.key);
          if (purpose === "visible" && sameLatestView(input) &&
            statusRef.current.entry === input.entry && statusRef.current.value === LOADING_STATUS) {
            reportStatus("");
          }
        } catch (error: unknown) {
          if (isCurrentOwner(input)) {
            failedKeys.add(request.key);
            if (purpose === "visible") reportStatus(error instanceof Error ? error.message : "Detail unavailable.");
          }
        } finally {
          rendering = false;
          if (effectActive) scheduleRef.current?.();
        }
      })();
    };

    const pump = (): void => {
      if (!effectActive) return;
      if (!activeRef.current) {
        setVisibleBusy(false);
        return;
      }
      const input = currentInputRef.current;
      if (!input || input.source !== source || input.entry !== entry || input.viewport.width < 2 || input.viewport.height < 2) {
        setVisibleBusy(false);
        return;
      }
      let planned: PlannedView;
      try {
        planned = planForInput(input);
      } catch (error: unknown) {
        setVisibleBusy(false);
        reportStatus(error instanceof Error ? error.message : "Detail unavailable.");
        return;
      }
      if (rendering) return;
      const visibleRequest = planned.missingVisible[0];
      if (visibleRequest) {
        renderTile(input, visibleRequest, "visible");
        return;
      }
      if (planned.failedVisible.length > 0 || input.interactive || panningRef.current) return;
      const cachedTiles = cacheRef.current.values();
      for (const request of planned.prefetch) {
        if (cacheRef.current.get(request.key) || coveringDetailTiles(request, cachedTiles).length > 0) continue;
        if (failedDocument === input.document && failedKeys.has(request.key)) continue;
        if (!cacheRef.current.canFitPrefetch(requestBytes(request))) continue;
        renderTile(input, request, "prefetch");
        return;
      }
    };

    const schedule = (): void => {
      if (!effectActive) return;
      clearSchedule();
      if (!activeRef.current) {
        setVisibleBusy(false);
        return;
      }
      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0;
        pump();
      });
    };

    scheduleRef.current = schedule;
    schedule();
    return () => {
      effectActive = false;
      clearSchedule();
      scheduleRef.current = null;
    };
  }, [source, entry]);

  useEffect(() => {
    scheduleRef.current?.();
  }, [source, entry, document, viewport, center.x, center.y, focus.x, focus.y, interactive, displayWidth, active, panning]);

  useEffect(() => () => {
    if (fadeAnimationRef.current) cancelAnimationFrame(fadeAnimationRef.current);
    cacheRef.current.clear();
  }, []);

  const sourceReady = source?.entry === entry;
  const visibleStatus = active && showStatus ? status : "";
  const ariaBusy = active && (!sourceReady || visibleBusy || status !== "");

  return <div ref={containerRef} className={`absolute inset-0 z-30 flex items-center justify-center overflow-hidden ${passive ? "bg-transparent" : "bg-[#131110]"} ${passive || !active ? "pointer-events-none" : "cursor-grab active:cursor-grabbing"}`}
    aria-label={displaySize ? "Full-resolution detail" : "100 percent detail; drag to pan"} aria-busy={ariaBusy} aria-hidden={!active}
    style={{ visibility: active ? "visible" : "hidden" }}
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
    <canvas ref={canvasRef} role="img" aria-label={`${entry.name}, full-resolution edited detail`} className="absolute inset-0 block h-full w-full" />
    {visibleStatus ? <p role="status" className="absolute bottom-4 max-w-lg rounded bg-black/80 px-3 py-2 text-center text-xs text-white">{visibleStatus}</p> : null}
  </div>;
}
