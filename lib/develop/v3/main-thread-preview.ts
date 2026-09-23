import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { LibraryEntry } from "@/lib/fs/types";
import { MAX_CPU_RENDER_PIXELS } from "./cpu-backend";
import { V3GpuPreviewRenderer } from "./gpu-backend";
import { prepareV3RuntimeRender } from "./runtime";
import type { V3PreviewWorkerRequest, V3PreviewWorkerRenderResult } from "./preview-worker-types";

type RenderMessage = Exclude<V3PreviewWorkerRequest, { kind: "initialize" }>;

// WebKitGTK supports WebGL on the main thread but does not enable worker WebGL.
// Keep the same shaders and pixel contracts; unsupported stages still use the worker.
export class MainThreadGpuPreview {
  readonly #renderer = new V3GpuPreviewRenderer();
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;
  #interactivePixels = 1_000_000;
  #lastDimensions = "";
  #fastFrames = 0;

  constructor(readonly entry: LibraryEntry, readonly image: DevelopImage) {}

  render(message: RenderMessage): Promise<V3PreviewWorkerRenderResult | null> {
    const result = this.#pending.then(() => this.#render(message));
    this.#pending = result.then(() => {}, () => {});
    return result;
  }

  async #render(message: RenderMessage): Promise<V3PreviewWorkerRenderResult | null> {
    if (this.#disposed) return { backend: "gpu", result: { kind: "cancelled" } };
    const mattes = new Map((message.maskMattes ?? []).map((matte) => [matte.assetId, matte]));
    const assets = mattes.size ? {
      hasAsset: (id: string) => mattes.has(id),
      maskMatte: (id: string) => mattes.get(id),
    } : undefined;
    const source = { entry: this.entry, image: this.image, assets, cancellation: { isCancelled: () => this.#disposed, reason: () => this.#disposed ? "Preview disposed" : null } };
    const prepared = await prepareV3RuntimeRender(message.document, message.kind === "export" ? {
      ...source, kind: "v3-export", size: message.size, format: "jpeg", includeAnalysis: false,
    } : {
      ...source, kind: "v3-preview", viewportDimensions: message.viewportDimensions,
      devicePixelRatio: message.devicePixelRatio, previewMode: message.previewMode,
      includeAnalysis: message.includeAnalysis, includePointColor: message.includePointColor,
      maximumPreviewPixels: message.previewMode === "settled" ? MAX_CPU_RENDER_PIXELS
        : Math.min(MAX_CPU_RENDER_PIXELS, this.#interactivePixels * (message.previewMode === "refined" ? 4 : 1)),
    });
    if (this.#disposed) return { backend: "gpu", result: { kind: "cancelled" } };
    if (prepared.kind !== "prepared") return { backend: "gpu", result: prepared };
    const result = message.kind === "export"
      ? await (message.region ? this.#renderer.renderRegion(prepared.input, message.region) : this.#renderer.renderExport(prepared.input))
      : await this.#renderer.render(prepared.input, { includeAnalysis: message.includeAnalysis });
    if (this.#disposed) {
      if (result?.kind === "rendered" && "bitmap" in result) result.bitmap.close();
      return { backend: "gpu", result: { kind: "cancelled" } };
    }
    if (!result) return null;
    if (message.kind === "render" && message.previewMode === "interactive" && result.kind === "rendered" && "renderDurationMs" in result) {
      const dimensions = `${result.dimensions.width}x${result.dimensions.height}`;
      if (dimensions === this.#lastDimensions) {
        if (result.renderDurationMs > 24) {
          this.#interactivePixels = Math.max(64_000, Math.floor(this.#interactivePixels / 2));
          this.#fastFrames = 0;
        } else if (result.renderDurationMs < 10 && ++this.#fastFrames >= 3) {
          this.#interactivePixels = Math.min(MAX_CPU_RENDER_PIXELS, this.#interactivePixels * 2);
          this.#fastFrames = 0;
        } else if (result.renderDurationMs >= 10) this.#fastFrames = 0;
      } else this.#fastFrames = 0;
      this.#lastDimensions = dimensions;
    }
    return { backend: "gpu", result };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.#pending.finally(() => {
      // Let the next view paint before releasing the WebGL context.
      const release = () => this.#renderer.dispose();
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(release, { timeout: 250 });
      } else {
        setTimeout(release, 32);
      }
    });
  }
}
