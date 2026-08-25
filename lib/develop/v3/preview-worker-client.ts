import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { PixelDimensions } from "@/lib/develop/process";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { V3PreviewRenderMode } from "@/lib/develop/v3/runtime";
import type {
  V3PreviewWorkerImage,
  V3PreviewWorkerMaskMatte,
  V3PreviewWorkerRenderResult,
  V3PreviewWorkerResponse,
} from "@/lib/develop/v3/preview-worker-types";
import type { LibraryEntry } from "@/lib/fs/types";

interface PreviewWorkerRenderOptions {
  readonly viewportDimensions: PixelDimensions;
  readonly devicePixelRatio: number;
  readonly previewMode: V3PreviewRenderMode;
  readonly includeAnalysis: boolean;
  readonly maskMattes?: readonly V3PreviewWorkerMaskMatte[];
}

interface PendingRender {
  readonly resolve: (result: V3PreviewWorkerRenderResult) => void;
  readonly reject: (error: Error) => void;
}

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
      this.#pending.set(requestId, { resolve, reject });
      this.#worker.postMessage({
        kind: "render",
        requestId,
        document,
        viewportDimensions: options.viewportDimensions,
        devicePixelRatio: options.devicePixelRatio,
        previewMode: options.previewMode,
        includeAnalysis: options.includeAnalysis,
        maskMattes: options.maskMattes ?? [],
      });
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.resolve({ backend: "cpu", result: { kind: "cancelled" } });
    }
    this.#pending.clear();
  }
}
