import type { DecodeOptions, DecodedImage, ImageProfile } from "../types";
import {
  getFormatExtensionsForProfile,
  getFormatCapabilityForFileName,
  recognizeFormatFromBytes,
} from "@/lib/formats/registry";

const STANDARD_EXTENSIONS = getFormatExtensionsForProfile("standard");

async function blobToDecodedImage(
  blob: Blob,
  metadata: Record<string, unknown>,
  options: DecodeOptions,
): Promise<DecodedImage> {
  options.signal?.throwIfAborted();
  const bitmap = await createImageBitmap(blob);
  try {
    options.signal?.throwIfAborted();
    const scale = options.thumbnail && options.maxEdge
      ? Math.min(1, options.maxEdge / Math.max(bitmap.width, bitmap.height))
      : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const decoded = {
      width, height, bits: 8, colors: 4,
      pixelProvenance: standardPixelProvenance(), metadata,
    };
    if (!options.thumbnail && !options.sourcePixels) {
      return { ...decoded, rgb: new Uint8Array(0), blob, objectUrl: URL.createObjectURL(blob) };
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create canvas context");
    context.drawImage(bitmap, 0, 0, width, height);
    if (options.sourcePixels) {
      return { ...decoded, rgb: context.getImageData(0, 0, width, height).data };
    }
    const outputBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    options.signal?.throwIfAborted();
    return { ...decoded, rgb: new Uint8Array(0), blob: outputBlob, objectUrl: URL.createObjectURL(outputBlob) };
  } finally {
    bitmap.close();
  }
}

function standardPixelProvenance(): DecodedImage["pixelProvenance"] {
  return {
    decoderPath: "processed-standard",
    decoderRevision: "browser-canvas-rgba8-v1",
    colorSpace: "srgb",
    transfer: "encoded",
    bitDepth: 8,
    cameraProfileStage: {
      kind: "unavailable",
      reason: "Standard images contain rendered pixels.",
    },
  };
}

export const standardImageProfile: ImageProfile = {
  id: "standard",
  extensions: STANDARD_EXTENSIONS,
  detect: (file) =>
    getFormatCapabilityForFileName(file.name)?.profileId === "standard",
  decode: async (input, options: DecodeOptions = {}): Promise<DecodedImage> => {
    const mimeType = detectMimeType(input);
    const blob = new Blob([input as BlobPart], { type: mimeType });
    return blobToDecodedImage(blob, {
      format: mimeType,
      source: "standard",
      decoderProvenance: "standard",
    }, options);
  },
};

function detectMimeType(input: Uint8Array): string {
  const format = recognizeFormatFromBytes(input);
  if (format?.id === "jpeg") return "image/jpeg";
  if (format?.id === "png") return "image/png";
  if (format?.id === "webp") return "image/webp";
  return "application/octet-stream";
}
