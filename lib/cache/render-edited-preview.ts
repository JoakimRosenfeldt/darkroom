import type { LibraryEntry } from "@/lib/fs/types";
import type { StoredDevelopDocument } from "@/lib/develop/v3/document";
import { createDefaultV3DevelopDocument } from "@/lib/develop/v3/document";
import { decodePersistedDevelopDocument } from "@/lib/develop/v3/codec";
import { loadV3PreviewMaskMattes } from "@/lib/develop/v3/runtime";
import { V3PreviewWorkerClient } from "@/lib/develop/v3/preview-worker-client";
import { FrozenV2Renderer, renderFrozenV2 } from "@/lib/develop/frozen-v2-backend";
import { loadDevelopImage } from "./develop-image-cache";
import { runWithPreviewLimit } from "./concurrency";

export function renderEditedPreview(
  entry: LibraryEntry,
  stored: StoredDevelopDocument | null,
  maxEdge: number,
  options: { readonly signal?: AbortSignal; readonly priority?: number },
): Promise<Blob> {
  return runWithPreviewLimit(async () => {
    options.signal?.throwIfAborted();
    const parsed = decodePersistedDevelopDocument(stored ?? createDefaultV3DevelopDocument());
    if (parsed.kind !== "editable") {
      throw new Error(parsed.kind === "invalid" ? parsed.message : "This edit needs a newer version of Darkroom.");
    }
    const document = parsed.document;
    const image = await loadDevelopImage(entry, {
      rawColorMode: document.version === 3 ? "libraw-camera-matrix" : "decoder-rendered",
      maxEdge: Math.max(360, maxEdge),
      priority: options.priority,
    });
    options.signal?.throwIfAborted();
    const canvas = window.document.createElement("canvas");
    if (document.version === 2) {
      const renderer = new FrozenV2Renderer(canvas, true);
      try {
        const output = await renderFrozenV2(document, {
          kind: "export", image, renderer,
          sourceSignature: { entryId: entry.id, relativePath: entry.relativePath, size: entry.size, lastModified: entry.lastModified },
          size: { mode: "long-edge", pixels: maxEdge, neverUpscale: true },
        });
        const outputCanvas = window.document.createElement("canvas");
        outputCanvas.width = output.width;
        outputCanvas.height = output.height;
        const context = outputCanvas.getContext("2d");
        if (!context) throw new Error("Photo preview is unavailable.");
        context.putImageData(new ImageData(new Uint8ClampedArray(output.pixels), output.width, output.height), 0, 0);
        return await previewBlob(outputCanvas);
      } finally { renderer.dispose(); }
    }
    const worker = new V3PreviewWorkerClient(entry, image);
    const abort = () => worker.dispose();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const maskMattes = await loadV3PreviewMaskMattes(document, entry, image);
      options.signal?.throwIfAborted();
      const { result } = await worker.render(document, {
        viewportDimensions: { width: maxEdge, height: maxEdge },
        devicePixelRatio: 1, previewMode: "settled", includeAnalysis: false, maskMattes,
      });
      if (result.kind !== "rendered") {
        options.signal?.throwIfAborted();
        throw new Error("The saved edit could not be rendered. Open the photo to check its edit and source files.");
      }
      canvas.width = result.dimensions.width;
      canvas.height = result.dimensions.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Photo preview is unavailable.");
      if ("bitmap" in result) {
        context.drawImage(result.bitmap, 0, 0);
        result.bitmap.close();
      } else {
        context.putImageData(new ImageData(new Uint8ClampedArray(result.pixels.pixels), canvas.width, canvas.height), 0, 0);
      }
      options.signal?.throwIfAborted();
      return await previewBlob(canvas);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      worker.dispose();
    }
  }, options);
}

function previewBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Photo preview could not be encoded.")),
    "image/jpeg", 0.94,
  ));
}
