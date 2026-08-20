import type { DecodeOptions, DecodedImage, ImageProfile } from "../types";
import { decodeEmbeddedThumbnail, decodeWithLibRaw } from "../libraw-client";

const PREVIEW_MAX_EDGE = 2_560;

async function decodeEmbeddedSourcePixels(
  embedded: DecodedImage,
): Promise<DecodedImage> {
  if (!embedded.blob) {
    throw new Error("The embedded RAW preview is unavailable for AI masking.");
  }
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(embedded.blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not decode the embedded RAW preview.");
    }
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgb: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
      bits: 8,
      colors: 4,
      metadata: embedded.metadata,
    };
  } finally {
    bitmap?.close();
    if (embedded.objectUrl) {
      URL.revokeObjectURL(embedded.objectUrl);
    }
  }
}

async function decodeDevelopedNef(
  input: Uint8Array,
  options: DecodeOptions,
): Promise<DecodedImage> {
  try {
    return await decodeWithLibRaw(input, options);
  } catch {
    // Unsupported Nikon compression reaches the native fallback only after LibRaw fails.
  }

  let fallbackCode = "SDK_UNAVAILABLE";
  let fallbackMessage = "Nikon decoder is unavailable.";
  const api = typeof window === "undefined" ? undefined : window.darkroom;

  if (api && options.relativePath) {
    try {
      const result = await api.decodeNef({
        relativePath: options.relativePath,
        mode: options.fullResolution ? "full" : "preview",
        maxEdge: Math.min(options.maxEdge ?? PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE),
      });
      if (result.available) {
        return {
          width: result.width,
          height: result.height,
          rgb: new Uint16Array(result.pixels),
          bits: result.bitDepth,
          colors: result.channels,
          metadata: {
            decoderProvenance: "nikon-sdk",
            developSource: "native",
            protocolVersion: result.version,
            sourceWidth: result.width,
            sourceHeight: result.height,
            width: result.width,
            height: result.height,
            channels: result.channels,
            bitDepth: result.bitDepth,
            byteCount: result.byteCount,
            orientation: result.orientation,
            colorSpace: result.colorSpace,
            transferFunction: result.transferFunction,
            pixelFormat: result.pixelFormat,
          },
        };
      }
      fallbackCode = result.code;
      fallbackMessage = result.message;
    } catch (error) {
      fallbackCode = "NATIVE_DECODE_FAILED";
      fallbackMessage = error instanceof Error
        ? error.message
        : "Nikon decoder failed.";
    }
  }

  const embedded = await decodeEmbeddedThumbnail(input);
  if (!embedded) {
    throw new Error(fallbackMessage);
  }
  embedded.metadata.developSource = "embedded";
  embedded.metadata.fallbackCode = fallbackCode;
  embedded.metadata.fallbackMessage = fallbackMessage;
  return options.sourcePixels
    ? decodeEmbeddedSourcePixels(embedded)
    : embedded;
}

export const nefProfile: ImageProfile = {
  id: "nef",
  extensions: [".nef"],
  detect: (file) => file.name.toLowerCase().endsWith(".nef"),
  decode: (input, options: DecodeOptions = {}) =>
    options.fullResolution ||
    (options.thumbnail && options.rawSource === "developed")
      ? decodeDevelopedNef(input, options)
      : decodeWithLibRaw(input, options),
};
