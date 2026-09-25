import { nativeGpuAvailable, setNativeGpuTransport } from "./native-context";
import type { NativeGpuWorkerRequest, NativeGpuWorkerResponse } from "./preview-worker-types";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { CpuAssetAvailability } from "@/lib/develop/v3/cpu-backend";
import { MAX_CPU_RENDER_PIXELS, V3CpuPreviewCache, renderV3Cpu, renderV3CpuRegion } from "@/lib/develop/v3/cpu-backend";
import {
  V3GpuPreviewRenderer,
  v3GpuPreviewSupport,
} from "@/lib/develop/v3/gpu-backend";
import {
  prepareV3RuntimeRender,
} from "@/lib/develop/v3/runtime";
import type {
  V3PreviewBackend,
  V3PreviewRenderOutput,
  V3PreviewWorkerRequest,
  V3PreviewWorkerResponse,
  V3PreviewWorkerMaskMatte,
} from "@/lib/develop/v3/preview-worker-types";
import type { LibraryEntry } from "@/lib/fs/types";

let nativeRequestId = 0;
const nativeRequests = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();

type RenderMessage = Exclude<V3PreviewWorkerRequest, { readonly kind: "initialize" }>;

let entry: LibraryEntry | null = null;
let image: DevelopImage | null = null;
let pendingRender: RenderMessage | null = null;
let renderScheduled = false;
let rendering = false;
let gpuRenderer: V3GpuPreviewRenderer | null = null;
let cpuCache = new V3CpuPreviewCache();
let maskMattes: readonly V3PreviewWorkerMaskMatte[] = [];
let gpuUnavailable = false;
let interactivePixels = 1_000_000;
let lastGpuDimensions = "";
let fastFrames = 0;
let cpuInteractivePixels = 16_000;
let lastCpuDimensions = "";
let fastCpuFrames = 0;
const MAX_NATIVE_INTERACTIVE_PIXELS = 1_000_000;

function post(response: V3PreviewWorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(response, { transfer });
}

function transferList(result: V3PreviewRenderOutput): Transferable[] {
  if (result.kind !== "rendered") return [];
  const transfers: Transferable[] = [];
  if ("bitmap" in result) {
    transfers.push(result.bitmap);
  } else if (result.pixels.pixels.buffer instanceof ArrayBuffer) {
    transfers.push(result.pixels.pixels.buffer);
  }
  if (result.pointColorInput?.pixels.buffer instanceof ArrayBuffer) {
    transfers.push(result.pointColorInput.pixels.buffer);
  }
  return transfers;
}

function assetsFor(): CpuAssetAvailability | undefined {
  if (maskMattes.length === 0) return undefined;
  const mattes = new Map(
    maskMattes.map((matte) => [matte.assetId, matte] as const),
  );
  return {
    hasAsset: (assetId) => mattes.has(assetId),
    maskMatte: (assetId) => mattes.get(assetId),
  };
}

function scheduleRender(): void {
  if (renderScheduled || rendering) return;
  renderScheduled = true;
  setTimeout(() => {
    void renderLatest();
  }, 0);
}

async function renderLatest(): Promise<void> {
  renderScheduled = false;
  const message = pendingRender;
  pendingRender = null;
  if (!message) return;
  if (!entry || !image) {
    post({
      kind: "error",
      requestId: message.requestId,
      message: "The preview worker source is unavailable.",
    });
    return;
  }

  rendering = true;
  try {
    const assets = assetsFor();
    if (message.kind === "export") {
      const request = { kind: "v3-export", entry, image, size: message.size, format: "jpeg", assets, includeAnalysis: false } as const;
      const prepared = await prepareV3RuntimeRender(message.document, request);
      let result: V3PreviewRenderOutput = prepared.kind === "prepared" ? { kind: "cancelled" } : prepared;
      let backend: V3PreviewBackend = "cpu";
      if (prepared.kind === "prepared") {
        const renderer = gpuRenderer ??= new V3GpuPreviewRenderer();
        const accelerated = message.region
          ? await renderer.renderRegion(prepared.input, message.region)
          : await renderer.renderExport(prepared.input);
        if (accelerated) {
          result = accelerated;
          backend = "gpu";
        } else {
          result = message.region
            ? await renderV3CpuRegion(prepared.input, message.region, cpuCache)
            : await renderV3Cpu(prepared.input);
        }
      }
      post({ kind: "result", requestId: message.requestId, backend, result }, transferList(result));
      return;
    }
    const runtimeRequest = {
      kind: "v3-preview",
      entry,
      image,
      viewportDimensions: message.viewportDimensions,
      devicePixelRatio: message.devicePixelRatio,
      previewMode: message.previewMode,
      includeAnalysis: message.includeAnalysis,
      includePointColor: message.includePointColor,
      assets,
    } as const;
    const renderCpuPreview = async (): Promise<V3PreviewRenderOutput> => {
      const prepared = await prepareV3RuntimeRender(message.document, {
        ...runtimeRequest,
        maximumPreviewPixels: message.previewMode === "settled"
          ? MAX_CPU_RENDER_PIXELS
          : Math.min(256_000, cpuInteractivePixels * (message.previewMode === "refined" ? 4 : 1)),
      });
      if (prepared.kind !== "prepared") return prepared;
      const started = performance.now();
      const result = await renderV3Cpu(prepared.input, cpuCache);
      if (result.kind === "rendered" && message.previewMode === "interactive") {
        const dimensions = `${result.dimensions.width}x${result.dimensions.height}`;
        if (dimensions === lastCpuDimensions) {
          const elapsed = performance.now() - started;
          if (elapsed > 24) {
            cpuInteractivePixels = Math.max(16_000, Math.floor(cpuInteractivePixels / 2));
            fastCpuFrames = 0;
          } else if (elapsed < 10 && ++fastCpuFrames >= 3) {
            cpuInteractivePixels = Math.min(256_000, cpuInteractivePixels * 2);
            fastCpuFrames = 0;
          } else if (elapsed >= 10) {
            fastCpuFrames = 0;
          }
        } else {
          fastCpuFrames = 0;
        }
        lastCpuDimensions = dimensions;
      }
      return result;
    };
    const gpuPreviewPixels = nativeGpuAvailable() && message.previewMode === "interactive"
      ? Math.min(interactivePixels, MAX_NATIVE_INTERACTIVE_PIXELS)
      : interactivePixels;
    const gpuPreparation = await prepareV3RuntimeRender(
      message.document,
      gpuUnavailable ? runtimeRequest : {
        ...runtimeRequest,
        maximumPreviewPixels: message.previewMode === "settled"
          ? MAX_CPU_RENDER_PIXELS
          : Math.min(MAX_CPU_RENDER_PIXELS, gpuPreviewPixels * (message.previewMode === "refined" ? 4 : 1)),
      },
    );
    let backend: V3PreviewBackend = "gpu";
    let result: V3PreviewRenderOutput;
    if (
      gpuPreparation.kind === "prepared" &&
      !gpuUnavailable &&
      v3GpuPreviewSupport(gpuPreparation.input).kind === "supported"
    ) {
      const gpuResult = await (gpuRenderer ??= new V3GpuPreviewRenderer()).render(
        gpuPreparation.input,
        { includeAnalysis: message.includeAnalysis },
      );
      if (gpuResult) {
        result = gpuResult;
        if (gpuResult.kind === "rendered") {
          const dimensions = `${gpuResult.dimensions.width}x${gpuResult.dimensions.height}`;
          // Ignore allocation and shader warmup when sizing subsequent drag frames.
          if (message.previewMode === "interactive" && dimensions === lastGpuDimensions) {
            // Reducing pixels cannot remove native IPC and main-thread queue latency.
            const elapsed = gpuResult.processingDurationMs ?? gpuResult.renderDurationMs;
            if (elapsed > 24) {
              interactivePixels = Math.max(64_000, Math.floor(interactivePixels / 2));
              fastFrames = 0;
            } else if (elapsed < 10 && ++fastFrames >= 3) {
              interactivePixels = Math.min(nativeGpuAvailable() ? MAX_NATIVE_INTERACTIVE_PIXELS : MAX_CPU_RENDER_PIXELS, interactivePixels * 2);
              fastFrames = 0;
            } else if (elapsed >= 10) {
              fastFrames = 0;
            }
          } else if (dimensions !== lastGpuDimensions) {
            fastFrames = 0;
          }
          lastGpuDimensions = dimensions;
        }
      } else {
        gpuUnavailable = true;
        backend = "cpu";
        result = await renderCpuPreview();
      }
    } else {
      backend = "cpu";
      result = gpuPreparation.kind === "prepared"
        ? await renderCpuPreview()
        : gpuPreparation;
    }
    post(
      { kind: "result", requestId: message.requestId, backend, result },
      transferList(result),
    );
  } catch (error) {
    post({
      kind: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Could not render the preview.",
    });
  } finally {
    rendering = false;
    if (pendingRender) scheduleRender();
  }
}

self.onmessage = (event: MessageEvent<V3PreviewWorkerRequest | NativeGpuWorkerResponse>): void => {
  const message = event.data;
  if (message.kind === "native-gpu-result" || message.kind === "native-gpu-error") {
    const pending = nativeRequests.get(message.id);
    nativeRequests.delete(message.id);
    if (message.kind === "native-gpu-result") pending?.resolve(message.bytes);
    else pending?.reject(new Error(message.message));
    return;
  }
  if (message.kind === "initialize") {
    if (message.nativeGpu) setNativeGpuTransport((bytes) => new Promise((resolve, reject) => {
      const id = ++nativeRequestId;
      nativeRequests.set(id, { resolve, reject });
      const request: NativeGpuWorkerRequest = { kind: "native-gpu", id, bytes };
      self.postMessage(request, { transfer: [bytes.buffer] });
    }));
    entry = message.entry;
    image = message.image;
    gpuRenderer?.dispose();
    gpuRenderer = new V3GpuPreviewRenderer();
    cpuCache = new V3CpuPreviewCache();
    maskMattes = [];
    gpuUnavailable = false;
    interactivePixels = 1_000_000;
    lastGpuDimensions = "";
    fastFrames = 0;
    cpuInteractivePixels = 16_000;
    lastCpuDimensions = "";
    fastCpuFrames = 0;
    return;
  }

  if (message.maskMattes) maskMattes = message.maskMattes;

  if (pendingRender) {
    post({
      kind: "result",
      requestId: pendingRender.requestId,
      backend: "cpu",
      result: { kind: "cancelled" },
    });
  }
  pendingRender = message;
  scheduleRender();
};
