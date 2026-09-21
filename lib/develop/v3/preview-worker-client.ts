import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { PixelDimensions } from "@/lib/develop/process";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { V3PreviewRenderMode } from "@/lib/develop/v3/runtime";
import type {
  V3PreviewWorkerImage,
  V3PreviewWorkerMaskMatte,
  V3PreviewWorkerRenderResult,
  V3PreviewWorkerResponse,
  V3PreviewWorkerRequest,
} from "@/lib/develop/v3/preview-worker-types";
import type { LibraryEntry } from "@/lib/fs/types";
import type { ExportSizeOptions } from "@/lib/export/types";
import type { RenderRegion } from "@/lib/develop/v3/cpu-backend";

interface PreviewWorkerRenderOptions {
  readonly viewportDimensions: PixelDimensions;
  readonly devicePixelRatio: number;
  readonly previewMode: V3PreviewRenderMode;
  readonly includeAnalysis: boolean;
  readonly includePointColor?: boolean;
  readonly maskMattes?: readonly V3PreviewWorkerMaskMatte[];
}

interface PendingRender {
  readonly resolve: (result: V3PreviewWorkerRenderResult) => void;
  readonly reject: (error: Error) => void;
}

interface QueuedPreview extends PendingRender {
  readonly message: Extract<V3PreviewWorkerRequest, { readonly kind: "render" }>;
}

const EMPTY_MASK_MATTES: readonly V3PreviewWorkerMaskMatte[] = [];

function workerFactory(): Worker {
  return new Worker(new URL("./preview-worker.ts", import.meta.url), {
    type: "module",
  });
}

function clonePixels(image: DevelopImage): DevelopImage["rgb"] {
  if (image.rgb instanceof Uint16Array) return new Uint16Array(image.rgb);
  if (image.rgb instanceof Uint8ClampedArray) return new Uint8ClampedArray(image.rgb);
  return new Uint8Array(image.rgb);
}

function sourceImage(image: DevelopImage): V3PreviewWorkerImage {
  return {
    width: image.width,
    height: image.height,
    sourceWidth: image.sourceWidth,
    sourceHeight: image.sourceHeight,
    orientation: image.orientation,
    metadata: image.metadata,
    rgb: clonePixels(image),
    bits: image.bits,
    colors: image.colors,
    pixelProvenance: image.pixelProvenance,
  };
}

export class V3PreviewWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRender>();
  #nextRequestId = 0;
  #disposed = false;
  #activePreview: number | null = null;
  #queuedPreview: QueuedPreview | null = null;
  #maskMattes: readonly V3PreviewWorkerMaskMatte[] | null = null;

  constructor(entry: LibraryEntry, image: DevelopImage) {
    this.#worker = workerFactory();
    this.#worker.onmessage = (event: MessageEvent<V3PreviewWorkerResponse>): void => {
      const response = event.data;
      const pending = this.#pending.get(response.requestId);
      if (!pending) {
        if (
          response.kind === "result" &&
          response.result.kind === "rendered" &&
          "bitmap" in response.result
        ) response.result.bitmap.close();
        return;
      }
      this.#pending.delete(response.requestId);
      if (this.#activePreview === response.requestId) {
        this.#activePreview = null;
        const queued = this.#queuedPreview;
        this.#queuedPreview = null;
        if (queued) this.#sendPreview(queued);
      }
      if (response.kind === "result") {
        pending.resolve({ backend: response.backend, result: response.result });
      } else {
        pending.reject(new Error(response.message));
      }
    };
    this.#worker.onerror = (): void => {
      const error = new Error("The preview worker stopped unexpectedly.");
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#queuedPreview?.reject(error);
      this.#queuedPreview = null;
      this.#disposed = true;
      this.#worker.terminate();
    };

    const workerImage = sourceImage(image);
    const buffer = workerImage.rgb.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new Error("The preview source pixels cannot be transferred to a worker.");
    }
    this.#worker.postMessage(
      { kind: "initialize", entry, image: workerImage },
      [buffer],
    );
  }

  render(
    document: DevelopDocumentV3,
    options: PreviewWorkerRenderOptions,
  ): Promise<V3PreviewWorkerRenderResult> {
    if (this.#disposed) {
      return Promise.resolve({ backend: "cpu", result: { kind: "cancelled" } });
    }
    const requestId = ++this.#nextRequestId;
    return new Promise((resolve, reject) => {
      const preview: QueuedPreview = { resolve, reject, message: {
        kind: "render",
        requestId,
        document,
        viewportDimensions: options.viewportDimensions,
        devicePixelRatio: options.devicePixelRatio,
        previewMode: options.previewMode,
        includeAnalysis: options.includeAnalysis,
        includePointColor: options.includePointColor,
        maskMattes: options.maskMattes ?? EMPTY_MASK_MATTES,
      } };
      if (this.#activePreview !== null) {
        this.#queuedPreview?.resolve({ backend: "cpu", result: { kind: "cancelled" } });
        this.#queuedPreview = preview;
      } else {
        this.#sendPreview(preview);
      }
    });
  }

  #sendPreview(preview: QueuedPreview): void {
    const { message } = preview;
    this.#activePreview = message.requestId;
    this.#pending.set(message.requestId, preview);
    try {
      this.#worker.postMessage({
        ...message,
        maskMattes: message.maskMattes === this.#maskMattes ? undefined : message.maskMattes,
      });
      this.#maskMattes = message.maskMattes ?? EMPTY_MASK_MATTES;
    } catch (error) {
      this.#pending.delete(message.requestId);
      this.#activePreview = null;
      preview.reject(error instanceof Error ? error : new Error("Could not send the preview request."));
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.resolve({ backend: "cpu", result: { kind: "cancelled" } });
    }
    this.#pending.clear();
    this.#queuedPreview?.resolve({ backend: "cpu", result: { kind: "cancelled" } });
    this.#queuedPreview = null;
  }

  renderExport(
    document: DevelopDocumentV3,
    size: ExportSizeOptions,
    maskMattes: readonly V3PreviewWorkerMaskMatte[] = EMPTY_MASK_MATTES,
    region?: RenderRegion,
  ): Promise<V3PreviewWorkerRenderResult> {
    if (this.#disposed) return Promise.resolve({ backend: "cpu", result: { kind: "cancelled" } });
    const requestId = ++this.#nextRequestId;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#worker.postMessage({
        kind: "export", requestId, document, size, region,
        maskMattes: maskMattes === this.#maskMattes ? undefined : maskMattes,
      });
      this.#maskMattes = maskMattes;
    });
  }
}
