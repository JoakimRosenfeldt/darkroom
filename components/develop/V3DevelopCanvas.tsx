"use client";

import { useEffect, useRef, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { getDevelopSession } from "@/lib/develop/session";
import type {
  CpuAnalysisTapResult,
  CpuBackendBlockingDiagnostic,
  CpuBackendDiagnostic,
  CpuRenderResult,
} from "@/lib/develop/v3/cpu-backend";
import type { LibraryEntry } from "@/lib/fs/types";
import { useDevelopStore } from "@/stores/develop-store";

export type V3CanvasDiagnostic =
  | CpuBackendDiagnostic
  | CpuBackendBlockingDiagnostic;

interface V3DevelopCanvasProps {
  readonly entry: LibraryEntry;
  readonly image: DevelopImage;
  readonly alt: string;
  readonly cropActive?: boolean;
  readonly maskingActive?: boolean;
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
  onRenderDiagnostics,
  onAnalysis,
}: V3DevelopCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef(0);
  const diagnosticsCallbackRef = useRef(onRenderDiagnostics);
  const analysisCallbackRef = useRef(onAnalysis);
  const documentRevision = useDevelopStore((state) =>
    state.activeCatalogId === entry.catalogId
      ? state.sessions[entry.id]?.documentRevision ?? 0
      : 0,
  );
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
      const cancellation = { cancelled: false };
      activeCancellation = cancellation;
      const requestId = ++requestRef.current;
      const width = Math.max(1, Math.round(container.clientWidth));
      const height = Math.max(1, Math.round(container.clientHeight));
      const session = getDevelopSession(entry.catalogId, entry.id);
      setPreview({ kind: "loading" });
      if (!session) {
        setPreview({ kind: "invalid", message: "Develop session is not ready." });
        return;
      }
      void session.render({
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
      }).then((result) => {
        if (disposed || cancellation.cancelled || requestId !== requestRef.current) return;
        if (result.kind !== "rendered") {
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
        const dimensions = result.dimensions;
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
        analysisCallbackRef.current?.(result.analysis);
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
      observer.disconnect();
    };
  }, [documentRevision, entry, image]);

  const limitation = cropActive || maskingActive
    ? "Crop and mask overlays are not available in the v3 preview yet."
    : null;

  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black"
      aria-busy={preview.kind === "loading"}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={alt}
        className={preview.kind === "rendered" ? "block" : "invisible"}
        style={{ width: displayDimensions.width, height: displayDimensions.height }}
      />
      {preview.kind !== "rendered" ? (
        <div
          role={preview.kind === "loading" ? "status" : "alert"}
          className="absolute max-w-sm rounded border border-lr-border-subtle bg-lr-panel/95 px-4 py-3 text-center text-xs text-lr-text-muted"
        >
          {preview.kind === "loading" ? "Rendering v3 preview…" : preview.message}
        </div>
      ) : null}
      {limitation ? (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-lr-panel/90 px-3 py-1.5 text-[11px] text-lr-text-muted">
          {limitation}
        </div>
      ) : null}
    </div>
  );
}
