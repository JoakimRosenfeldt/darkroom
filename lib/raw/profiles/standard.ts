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
  mode: "metadata" | "thumbnail" | "source",
): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob);

  if (mode === "metadata") {
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();

    return {
      width,
      height,
      rgb: new Uint8Array(0),
      bits: 8,
      colors: 4,
      pixelProvenance: standardPixelProvenance(),
      metadata,
      blob,
      objectUrl: URL.createObjectURL(blob),
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not create canvas context");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

  if (mode === "source") {
    return {
      width: canvas.width,
      height: canvas.height,
      rgb: imageData.data,
      bits: 8,
      colors: 4,
      pixelProvenance: standardPixelProvenance(),
      metadata,
    };
  }

  const outputBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (!result) {
        reject(new Error("Failed to encode standard image"));
        return;
      }
      resolve(result);
    }, "image/jpeg", 0.92);
  });

  return {
    width: canvas.width,
    height: canvas.height,
    rgb: imageData.data,
    bits: 8,
    colors: 4,
    pixelProvenance: standardPixelProvenance(),
    metadata,
    blob: outputBlob,
    objectUrl: URL.createObjectURL(outputBlob),
  };
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

async function resizeBlob(blob: Blob, maxEdge: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not create canvas context");
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (!result) {
        reject(new Error("Failed to resize image"));
        return;
      }
      resolve(result);
    }, "image/jpeg", 0.9);
  });
}

export const standardImageProfile: ImageProfile = {
  id: "standard",
  extensions: STANDARD_EXTENSIONS,
  detect: (file) =>
    getFormatCapabilityForFileName(file.name)?.profileId === "standard",
  decode: async (input, options?: DecodeOptions): Promise<DecodedImage> => {
    const mimeType = detectMimeType(input);
    let blob = new Blob([input as BlobPart], { type: mimeType });

    if (options?.thumbnail && options.maxEdge) {
      blob = await resizeBlob(blob, options.maxEdge);
    }

    const mode = options?.sourcePixels
      ? "source"
      : options?.thumbnail
        ? "thumbnail"
        : "metadata";
    return blobToDecodedImage(blob, {
      format: mimeType,
      source: "standard",
      decoderProvenance: "standard",
    }, mode);
  },
};

function detectMimeType(input: Uint8Array): string {
  const format = recognizeFormatFromBytes(input);
  if (format?.id === "jpeg") return "image/jpeg";
  if (format?.id === "png") return "image/png";
  if (format?.id === "webp") return "image/webp";
  return "application/octet-stream";
}
