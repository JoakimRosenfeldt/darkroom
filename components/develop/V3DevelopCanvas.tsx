"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  V3CanvasOverlay,
  type V3CanvasTool,
} from "@/components/develop/V3CanvasOverlay";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { getDevelopSession } from "@/lib/develop/session";
import type { GeometryPoint } from "@/lib/develop/v3/geometry";
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

interface V3DevelopCanvasProps {
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

export function V3DevelopCanvas({
  entry,
  image,
  alt,
  cropActive = false,
  maskingActive = false,
  canvasTool,
  onCanvasToolChange,
  onRenderDiagnostics,
  onAnalysis,
}: V3DevelopCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointColorInputRef = useRef<CpuPointColorInput | null>(null);
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
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [displayDimensions, setDisplayDimensions] = useState({ width: 1, height: 1 });

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
      }).catch((error: unknown) => {
        if (disposed || cancellation.cancelled || requestId !== requestRef.current) return;
        diagnosticsCallbackRef.current?.([]);
        analysisCallbackRef.current?.([]);
        setPreview({
          kind: "invalid",
          message: error instanceof Error ? error.message : "Could not render the v3 preview.",
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
      className="relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black"
      aria-busy={preview.kind === "loading"}
    >
      <div
        className={preview.kind === "rendered" ? "relative" : "invisible relative"}
        style={{ width: displayDimensions.width, height: displayDimensions.height }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={alt}
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
      {preview.kind !== "rendered" ? (
        <div
          role={preview.kind === "loading" ? "status" : "alert"}
          className="absolute max-w-sm rounded border border-lr-border-subtle bg-lr-panel/95 px-4 py-3 text-center text-xs text-lr-text-muted"
        >
          {preview.kind === "loading" ? "Rendering v3 preview…" : preview.message}
        </div>
      ) : null}
    </div>
  );
}
