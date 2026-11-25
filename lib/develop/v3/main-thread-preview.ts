import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { LibraryEntry } from "@/lib/fs/types";
import { MAX_CPU_RENDER_PIXELS, type CpuAssetAvailability } from "./cpu-backend";
import { V3GpuPreviewRenderer, v3GpuPreviewSupport } from "./gpu-backend";
import { registerNativeSource } from "./native-context";
import { prepareV3RuntimeRender } from "./runtime";
import type { DevelopDocumentV3 } from "./document";
import { applyV3DocumentSync } from "./preview-worker-types";
import type {
  V3PreviewWorkerMaskMatte,
  V3PreviewWorkerRequest,
  V3PreviewWorkerRenderResult,
} from "./preview-worker-types";

type RenderMessage = Exclude<V3PreviewWorkerRequest, { kind: "initialize" }>;
const MAX_NATIVE_INTERACTIVE_PIXELS = 1_000_000;

// Runs GPU previews on the main thread for both Tauri native GPU (avoiding
// worker ping-pong and source cloning while Rust executes on its GPU pool)
// and WebKitGTK WebGL2 (which lacks worker WebGL). Unsupported stages return
// null so the client falls back cleanly to the CPU worker.
export class MainThreadGpuPreview {
  readonly #renderer = new V3GpuPreviewRenderer();
  #pending: Promise<void> = Promise.resolve();
  readonly #inFlight = new Set<Promise<unknown>>();
  #disposed = false;
  #gpuWarm = false;
  #interactivePixels = 1_000_000;
  #lastDimensions = "";
  #fastFrames = 0;
  #residentDocument: DevelopDocumentV3 | null = null;
  #maskMattes: readonly V3PreviewWorkerMaskMatte[] = [];

  constructor(
    readonly entry: LibraryEntry,
    readonly image: DevelopImage,
    readonly native = false,
  ) {
    if (native && image.nativeSourceHandle && image.rgb instanceof Uint16Array) {
      registerNativeSource(image.rgb, image.nativeSourceHandle);
    }
  }

  #assetsFor(maskMattes: readonly V3PreviewWorkerMaskMatte[]): CpuAssetAvailability | undefined {
    if (maskMattes.length === 0) return undefined;
    const mattes = new Map(
      maskMattes
        .filter((matte) => matte.kind !== "depth-map")
        .map((matte) => [matte.assetId, matte] as const),
    );
    const depths = new Map(
      maskMattes
        .filter((matte) => matte.kind === "depth-map")
        .map((matte) => [matte.assetId, matte] as const),
    );
    return {
      hasAsset: (id) => mattes.has(id) || depths.has(id),
      maskMatte: (id) => mattes.get(id),
      depthMap: (id) => depths.get(id),
    };
  }

  warmup(document: DevelopDocumentV3): Promise<void> {
    if (this.#disposed || this.#gpuWarm || !this.native) return Promise.resolve();
    const run = this.#pending.then(async () => {
      if (this.#disposed || this.#gpuWarm) return;
      const prepared = await prepareV3RuntimeRender(document, {
        kind: "v3-export",
        entry: this.entry,
        image: this.image,
        size: { mode: "original" },
        format: "jpeg",
        includeAnalysis: false,
        cancellation: {
          isCancelled: () => this.#disposed,
          reason: () => this.#disposed ? "Preview disposed" : null,
        },
      });
      if (this.#disposed || prepared.kind !== "prepared") return;
      if (v3GpuPreviewSupport(prepared.input).kind !== "supported") return;
      await this.#renderer.warmup(prepared.input);
      if (!this.#disposed) this.#gpuWarm = true;
    });
    this.#pending = run.then(() => {}, () => {});
    return run;
  }

  render(message: RenderMessage): Promise<V3PreviewWorkerRenderResult | null> {
    // Applied synchronously in dispatch order before any await so concurrent
    // native GPU renders always see the exact document for their request.
    const renderDocument = applyV3DocumentSync(this.#residentDocument, message.documentSync);
    if (!renderDocument) {
      return Promise.reject(
        new Error("The main-thread preview received a document patch with no resident document."),
      );
    }
    this.#residentDocument = renderDocument;
    if (message.maskMattes !== undefined) this.#maskMattes = message.maskMattes;
    const maskMattes = this.#maskMattes;

    if (this.native && this.#gpuWarm && message.kind === "render") {
      const promise = this.#pending.then(() => this.#render(message, renderDocument, maskMattes));
      this.#inFlight.add(promise);
      void promise.finally(() => {
        this.#inFlight.delete(promise);
      });
      return promise;
    }

    const result = this.#pending.then(() => this.#render(message, renderDocument, maskMattes));
    this.#pending = result.then(() => {}, () => {});
    return result;
  }

  async #render(
    message: RenderMessage,
    renderDocument: DevelopDocumentV3,
    maskMattes: readonly V3PreviewWorkerMaskMatte[],
  ): Promise<V3PreviewWorkerRenderResult | null> {
    if (this.#disposed) return { backend: "gpu", result: { kind: "cancelled" } };
    const assets = this.#assetsFor(maskMattes);
    const source = {
      entry: this.entry,
      image: this.image,
      assets,
      cancellation: {
        isCancelled: () => this.#disposed,
        reason: () => this.#disposed ? "Preview disposed" : null,
      },
    };
    const gpuPreviewPixels = this.native && message.kind === "render" && message.previewMode === "interactive"
      ? Math.min(this.#interactivePixels, MAX_NATIVE_INTERACTIVE_PIXELS)
      : this.#interactivePixels;
    const prepared = await prepareV3RuntimeRender(renderDocument, message.kind === "export" ? {
      ...source, kind: "v3-export", size: message.size, format: "jpeg", includeAnalysis: false,
    } : {
      ...source,
      kind: "v3-preview",
      viewportDimensions: message.viewportDimensions,
      devicePixelRatio: message.devicePixelRatio,
      previewMode: message.previewMode,
      includeAnalysis: message.includeAnalysis || message.includeHistogram === true,
      histogramOnly: !message.includeAnalysis && message.includeHistogram === true,
      includePointColor: message.includePointColor,
      maximumPreviewPixels: message.previewMode === "settled" ? MAX_CPU_RENDER_PIXELS
        : Math.min(MAX_CPU_RENDER_PIXELS, gpuPreviewPixels * (message.previewMode === "refined" ? 4 : 1)),
    });
    if (this.#disposed) return { backend: "gpu", result: { kind: "cancelled" } };
    if (prepared.kind !== "prepared") return { backend: "gpu", result: prepared };
    const result = message.kind === "export"
      ? await (message.region ? this.#renderer.renderRegion(prepared.input, message.region) : this.#renderer.renderExport(prepared.input))
      : await this.#renderer.render(prepared.input, {
          includeAnalysis: message.includeAnalysis || message.includeHistogram === true,
        });
    if (this.#disposed) {
      if (result?.kind === "rendered" && "bitmap" in result) result.bitmap.close();
      return { backend: "gpu", result: { kind: "cancelled" } };
    }
    if (!result) return null;
    if (result.kind === "rendered") this.#gpuWarm = true;
    if (message.kind === "render" && message.previewMode === "interactive" && result.kind === "rendered" && "renderDurationMs" in result) {
      const dimensions = `${result.dimensions.width}x${result.dimensions.height}`;
      if (dimensions === this.#lastDimensions) {
        const elapsed = result.processingDurationMs ?? result.renderDurationMs;
        if (elapsed > 24) {
          this.#interactivePixels = Math.max(64_000, Math.floor(this.#interactivePixels / 2));
          this.#fastFrames = 0;
        } else if (elapsed < 10 && ++this.#fastFrames >= 3) {
          this.#interactivePixels = Math.min(
            this.native ? MAX_NATIVE_INTERACTIVE_PIXELS : MAX_CPU_RENDER_PIXELS,
            this.#interactivePixels * 2,
          );
          this.#fastFrames = 0;
        } else if (elapsed >= 10) this.#fastFrames = 0;
      } else this.#fastFrames = 0;
      this.#lastDimensions = dimensions;
    }
    return { backend: "gpu", result };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Wait for every in-flight render before releasing the GPU session or context.
    const settleAll = Promise.allSettled([this.#pending, ...this.#inFlight]);
    void settleAll.finally(() => {
      const release = () => this.#renderer.dispose();
      if (this.native) {
        release();
      } else if (typeof requestIdleCallback === "function") {
        requestIdleCallback(release, { timeout: 250 });
      } else {
        setTimeout(release, 32);
      }
    });
  }
}
