import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { CpuAssetAvailability } from "@/lib/develop/v3/cpu-backend";
import { renderV3Cpu, renderV3CpuRegion } from "@/lib/develop/v3/cpu-backend";
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
} from "@/lib/develop/v3/preview-worker-types";
import type { LibraryEntry } from "@/lib/fs/types";

type RenderMessage = Exclude<V3PreviewWorkerRequest, { readonly kind: "initialize" }>;

let entry: LibraryEntry | null = null;
let image: DevelopImage | null = null;
let pendingRender: RenderMessage | null = null;
let renderScheduled = false;
let rendering = false;
let gpuRenderer: V3GpuPreviewRenderer | null = null;

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

function assetsFor(message: RenderMessage): CpuAssetAvailability | undefined {
  if (message.maskMattes.length === 0) return undefined;
  const mattes = new Map(
    message.maskMattes.map((matte) => [matte.assetId, matte] as const),
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
    const assets = assetsFor(message);
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
            ? await renderV3CpuRegion(prepared.input, message.region)
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
    const gpuPreparation = await prepareV3RuntimeRender(
      message.document,
      runtimeRequest,
    );
    let backend: V3PreviewBackend = "gpu";
    let result: V3PreviewRenderOutput;
    if (
      gpuPreparation.kind === "prepared" &&
      v3GpuPreviewSupport(gpuPreparation.input).kind === "supported"
    ) {
      const gpuResult = await (gpuRenderer ??= new V3GpuPreviewRenderer()).render(
        gpuPreparation.input,
        { includeAnalysis: message.includeAnalysis },
      );
      if (gpuResult) {
        result = gpuResult;
      } else {
        backend = "cpu";
        result = await renderV3Cpu(gpuPreparation.input);
      }
    } else {
      backend = "cpu";
      result = gpuPreparation.kind === "prepared"
        ? await renderV3Cpu(gpuPreparation.input)
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

self.onmessage = (event: MessageEvent<V3PreviewWorkerRequest>): void => {
  const message = event.data;
  if (message.kind === "initialize") {
    entry = message.entry;
    image = message.image;
    gpuRenderer?.dispose();
    gpuRenderer = new V3GpuPreviewRenderer();
    return;
  }

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
