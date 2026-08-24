import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type {
  CpuAssetAvailability,
  CpuRenderResult,
} from "@/lib/develop/v3/cpu-backend";
import { renderV3Runtime } from "@/lib/develop/v3/runtime";
import type {
  V3PreviewWorkerRequest,
  V3PreviewWorkerResponse,
} from "@/lib/develop/v3/preview-worker-types";
import type { LibraryEntry } from "@/lib/fs/types";

type RenderMessage = Extract<V3PreviewWorkerRequest, { readonly kind: "render" }>;

let entry: LibraryEntry | null = null;
let image: DevelopImage | null = null;
let pendingRender: RenderMessage | null = null;
let renderScheduled = false;

function post(response: V3PreviewWorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(response, { transfer });
}

function transferList(result: CpuRenderResult): Transferable[] {
  if (result.kind !== "rendered") return [];
  const transfers: Transferable[] = [];
  if (result.pixels.pixels.buffer instanceof ArrayBuffer) {
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
  if (renderScheduled) return;
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

  try {
    const result = await renderV3Runtime(message.document, {
      kind: "v3-preview",
      entry,
      image,
      viewportDimensions: message.viewportDimensions,
      devicePixelRatio: message.devicePixelRatio,
      previewMode: message.previewMode,
      assets: assetsFor(message),
    });
    post(
      { kind: "result", requestId: message.requestId, result },
      transferList(result),
    );
  } catch (error) {
    post({
      kind: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Could not render the preview.",
    });
  }

  if (pendingRender) scheduleRender();
}

self.onmessage = (event: MessageEvent<V3PreviewWorkerRequest>): void => {
  const message = event.data;
  if (message.kind === "initialize") {
    entry = message.entry;
    image = message.image;
    return;
  }

  if (pendingRender) {
    post({
      kind: "result",
      requestId: pendingRender.requestId,
      result: { kind: "cancelled" },
    });
  }
  pendingRender = message;
  scheduleRender();
};
