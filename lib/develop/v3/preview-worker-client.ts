import { invoke, isTauri } from "@tauri-apps/api/core";
import { computeV3DocumentSync } from "./preview-worker-types";
import type { NativeGpuWorkerRequest, NativeGpuWorkerResponse } from "./preview-worker-types";
import { ensureDevelopImagePixels, type DevelopImage } from "@/lib/cache/develop-image-cache";
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
import { MainThreadGpuPreview } from "./main-thread-preview";
import type { RenderRegion } from "@/lib/develop/v3/cpu-backend";

interface PreviewWorkerRenderOptions {
  readonly viewportDimensions: PixelDimensions;
  readonly devicePixelRatio: number;
  readonly previewMode: V3PreviewRenderMode;
  readonly includeAnalysis: boolean;
  readonly includeHistogram?: boolean;
  readonly includePointColor?: boolean;
  readonly maskMattes?: readonly V3PreviewWorkerMaskMatte[];
}

interface PendingRender {
  readonly resolve: (result: V3PreviewWorkerRenderResult) => void;
  readonly reject: (error: Error) => void;
}

// Internal messages carry the whole document; the wire sync payload is
// computed at dispatch time against the destination actually used.
type ClientRenderMessage = Omit<
  Extract<V3PreviewWorkerRequest, { readonly kind: "render" }>,
  "documentSync"
> & { readonly document: DevelopDocumentV3 };
type ClientExportMessage = Omit<
  Extract<V3PreviewWorkerRequest, { readonly kind: "export" }>,
  "documentSync"
> & { readonly document: DevelopDocumentV3 };
type ClientMessage = ClientRenderMessage | ClientExportMessage;

interface QueuedPreview extends PendingRender {
  readonly message: ClientRenderMessage;
}

const EMPTY_MASK_MATTES: readonly V3PreviewWorkerMaskMatte[] = [];
const MAX_ACTIVE_PREVIEWS = 2;

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
    nativeSourceHandle: image.nativeSourceHandle,
    bits: image.bits,
    colors: image.colors,
    pixelProvenance: image.pixelProvenance,
  };
}

export class V3PreviewWorkerClient {
  #worker: Worker | null = null;
  #workerPromise: Promise<Worker> | null = null;
  #workerReady = false;
  readonly #nativeSessions = new Set<string>();
  readonly #nativeGpu = isTauri();
  #mainGpu: MainThreadGpuPreview | null;
  #entry: LibraryEntry;
  #image: DevelopImage;
  readonly #pending = new Map<number, PendingRender>();
  #nextRequestId = 0;
  #disposed = false;
  readonly #activePreviews = new Set<number>();
  #queuedPreview: QueuedPreview | null = null;
  #maskMattes: readonly V3PreviewWorkerMaskMatte[] | null = null;
  #mainMaskMattes: readonly V3PreviewWorkerMaskMatte[] | null = null;
  // Last document dispatched per destination, paired with the instance
  // it was sent to. A patch is only valid against that instance's
  // resident document, so a dispatch to a different instance (a
  // recreated renderer or worker) falls back to a full sync. The
  // pairing also makes a stale dispatch harmless: if it writes its
  // pair after the destination was replaced, the next dispatch sees a
  // target mismatch and sends full.
  #workerSync: { readonly target: Worker; readonly document: DevelopDocumentV3 } | null = null;
  #mainSync: { readonly target: MainThreadGpuPreview; readonly document: DevelopDocumentV3 } | null = null;

  constructor(entry: LibraryEntry, image: DevelopImage) {
    this.#entry = entry;
    this.#image = image;
    this.#mainGpu = this.#createMainGpu(entry, image);
  }

  #createMainGpu(entry: LibraryEntry, image: DevelopImage): MainThreadGpuPreview | null {
    const webkit = typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);
    return this.#nativeGpu || webkit ? new MainThreadGpuPreview(entry, image, this.#nativeGpu) : null;
  }

  warmup(document: DevelopDocumentV3): void {
    if (this.#disposed || !this.#nativeGpu || !this.#mainGpu) return;
    void this.#mainGpu.warmup(document);
  }

  // Points an idle client at another photo so its worker and loaded modules can be reused.
  retarget(entry: LibraryEntry, image: DevelopImage): void {
    if (this.#disposed || this.#activePreviews.size > 0 || this.#queuedPreview || this.#pending.size > 0) {
      throw new Error("Only an idle preview worker can change photos.");
    }
    this.#entry = entry;
    this.#image = image;
    this.#maskMattes = null;
    this.#mainMaskMattes = null;
    this.#workerSync = null;
    this.#mainSync = null;
    this.#mainGpu?.dispose();
    this.#mainGpu = this.#createMainGpu(entry, image);
    if (!this.#worker || !this.#workerReady) return;
    const expected = image.sourceWidth * image.sourceHeight * image.colors;
    if (image.rgb.length < expected && image.nativeSourceHandle) {
      // Tear down the idle CPU worker so it lazily materializes pixels if ever needed.
      this.#worker.terminate();
      this.#worker = null;
      this.#workerPromise = null;
      this.#workerReady = false;
      return;
    }
    const source = sourceImage(image);
    const buffer = source.rgb.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new Error("The preview source pixels cannot be transferred to a worker.");
    this.#worker.postMessage({ kind: "initialize", entry, image: source, nativeGpu: this.#nativeGpu }, [buffer]);
  }

  #receive(response: Exclude<V3PreviewWorkerResponse, { readonly kind: "ready" }>): void {
    if (response.kind === "error") {
      // An error can mean a destination lost its resident document (a
      // patch with nothing to patch). Clearing both pairs costs one
      // full resync on the next dispatch and self-recovers; this also
      // covers the #dispatch catch, which funnels through here.
      this.#workerSync = null;
      this.#mainSync = null;
    }
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      if (response.kind === "result" && response.result.kind === "rendered" && "bitmap" in response.result) response.result.bitmap.close();
      return;
    }
    this.#pending.delete(response.requestId);
    if (this.#activePreviews.delete(response.requestId)) {
      const queued = this.#queuedPreview;
      this.#queuedPreview = null;
      if (queued) this.#sendPreview(queued);
    }
    if (response.kind === "result") pending.resolve({ backend: response.backend, result: response.result });
    else pending.reject(new Error(response.message));
  }

  #ensureWorker(): Promise<Worker> {
    if (this.#workerPromise) return this.#workerPromise;
    this.#workerSync = null;
    this.#maskMattes = null;
    const worker = this.#worker = workerFactory();
    this.#workerPromise = new Promise((resolve, reject) => {
      const fail = (error: Error): void => {
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        this.#queuedPreview?.reject(error);
        this.#queuedPreview = null;
        this.#disposed = true;
        if (this.#workerReady) worker.terminate();
        else {
          // Failed imports can leave sibling loads pending. Detach the photo without terminating them.
          worker.onmessage = null;
          worker.onerror = null;
          this.#worker = null;
        }
        void this.#releaseNativeSessions();
        this.#mainGpu?.dispose();
        reject(error);
      };
      worker.onmessage = (event: MessageEvent<V3PreviewWorkerResponse | NativeGpuWorkerRequest>) => {
        if (event.data.kind === "ready") {
          this.#workerReady = true;
          if (this.#disposed) {
            worker.terminate();
            reject(new Error("The preview worker was disposed."));
            return;
          }
          try {
            const image = sourceImage(this.#image);
            const buffer = image.rgb.buffer;
            if (!(buffer instanceof ArrayBuffer)) throw new Error("The preview source pixels cannot be transferred to a worker.");
            this.#workerSync = null;
            this.#maskMattes = null;
            worker.postMessage({ kind: "initialize", entry: this.#entry, image, nativeGpu: this.#nativeGpu }, [buffer]);
            resolve(worker);
          } catch (error) {
            fail(error instanceof Error ? error : new Error("Could not initialize the preview worker."));
          }
        } else if (event.data.kind === "native-gpu") void this.#nativeRequest(worker, event.data);
        else this.#receive(event.data);
      };
      worker.onerror = (): void => fail(new Error("The preview worker stopped unexpectedly."));
    });
    return this.#workerPromise;
  }

  async #nativeRequest(worker: Worker, request: NativeGpuWorkerRequest): Promise<void> {
    let session: string | null = null;
    try {
      const length = new DataView(request.bytes.buffer).getUint32(0, true);
      const metadata: unknown = JSON.parse(new TextDecoder().decode(request.bytes.subarray(4, 4 + length)));
      const release = metadata && typeof metadata === "object" && "release" in metadata && metadata.release === true;
      if (metadata && typeof metadata === "object" && "session" in metadata && typeof metadata.session === "string") {
        session = metadata.session;
        this.#nativeSessions.add(session);
      }
      const bytes = await invoke<ArrayBuffer>("darkroom_gpu", request.bytes);
      if (release && session) this.#nativeSessions.delete(session);
      if (this.#disposed) {
        if (session && !release) this.#nativeSessions.add(session);
        await this.#releaseNativeSessions();
        return;
      }
      const response: NativeGpuWorkerResponse = { kind: "native-gpu-result", id: request.id, bytes };
      worker.postMessage(response, [bytes]);
    } catch (error) {
      if (this.#disposed) {
        if (session) this.#nativeSessions.add(session);
        await this.#releaseNativeSessions();
        return;
      }
      const response: NativeGpuWorkerResponse = { kind: "native-gpu-error", id: request.id, message: error instanceof Error ? error.message : String(error) };
      worker.postMessage(response);
    }
  }

  async #releaseNativeSessions(): Promise<void> {
    const sessions = [...this.#nativeSessions];
    this.#nativeSessions.clear();
    await Promise.all(sessions.map(async (session) => {
      const metadata = new TextEncoder().encode(JSON.stringify({ session, release: true }));
      const request = new Uint8Array(4 + metadata.length);
      new DataView(request.buffer).setUint32(0, metadata.length, true);
      request.set(metadata, 4);
      try { await invoke("darkroom_gpu", request); } catch { /* Failed devices own no usable sessions. */ }
    }));
  }

  async #dispatch(message: ClientMessage): Promise<void> {
    try {
      const renderer = this.#mainGpu;
      if (renderer) {
        const { document, ...rest } = message;
        const base = this.#mainSync?.target === renderer ? this.#mainSync.document : null;
        const documentSync = computeV3DocumentSync(base, document);
        const maskMattes = message.maskMattes === this.#mainMaskMattes ? undefined : message.maskMattes;
        this.#mainSync = { target: renderer, document };
        this.#mainMaskMattes = message.maskMattes ?? EMPTY_MASK_MATTES;
        const result = await renderer.render({ ...rest, documentSync, maskMattes });
        if (result) { this.#receive({ kind: "result", requestId: message.requestId, ...result }); return; }
      }
      if (this.#disposed) return;
      const expected = this.#image.sourceWidth * this.#image.sourceHeight * this.#image.colors;
      if (this.#image.rgb.length < expected && this.#image.nativeSourceHandle) {
        await ensureDevelopImagePixels(this.#image, this.#entry);
        if (this.#disposed) return;
      }
      const worker = await this.#ensureWorker();
      if (this.#disposed) return;
      const { document, ...rest } = message;
      const base = this.#workerSync?.target === worker ? this.#workerSync.document : null;
      const documentSync = computeV3DocumentSync(base, document);
      worker.postMessage({ ...rest, documentSync, maskMattes: message.maskMattes === this.#maskMattes ? undefined : message.maskMattes });
      this.#workerSync = { target: worker, document };
      this.#maskMattes = message.maskMattes ?? EMPTY_MASK_MATTES;
    } catch (error) {
      this.#receive({ kind: "error", requestId: message.requestId, message: error instanceof Error ? error.message : "Could not render preview." });
    }
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
        includeHistogram: options.includeHistogram,
        includePointColor: options.includePointColor,
        maskMattes: options.maskMattes ?? EMPTY_MASK_MATTES,
      } };
      if (this.#activePreviews.size >= MAX_ACTIVE_PREVIEWS) {
        this.#queuedPreview?.resolve({ backend: "cpu", result: { kind: "cancelled" } });
        this.#queuedPreview = preview;
      } else {
        this.#sendPreview(preview);
      }
    });
  }

  #sendPreview(preview: QueuedPreview): void {
    const { message } = preview;
    this.#activePreviews.add(message.requestId);
    this.#pending.set(message.requestId, preview);
    void this.#dispatch(message);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#workerSync = null;
    this.#mainSync = null;
    this.#mainMaskMattes = null;
    // Avoid tearing down WebKit module loaders while the worker is still starting.
    if (this.#workerReady) this.#worker?.terminate();
    void this.#releaseNativeSessions();
    this.#mainGpu?.dispose();
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
      void this.#dispatch({ kind: "export", requestId, document, size, region, maskMattes });
    });
  }
}
