import type { DecodeOptions, DecodedImage, ImageProfile } from "../types";
import { getFormatExtensionsForProfile, getFormatCapabilityForFileName } from "@/lib/formats/registry";
import { decodeEmbeddedThumbnail, decodeWithLibRaw } from "../libraw-client";

const PREVIEW_MAX_EDGE = 2_560;
const unsupportedSources = new Set<string>();

function sourceKey(options: DecodeOptions): string | null {
  const request = options.assetRequest;
  return request && options.assetRevision !== undefined
    ? JSON.stringify([request.catalogId, request.assetId, options.assetRevision])
    : null;
}

function unsupportedByLibRaw(error: unknown): boolean {
  return error instanceof Error &&
    /unsupported.*(?:file|format|raw)|(?:file|format|raw).*not supported|not implemented/i.test(error.message);
}

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
      pixelProvenance: embedded.pixelProvenance,
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
  skipLibRaw = false,
): Promise<DecodedImage> {
  options.signal?.throwIfAborted();
  const key = sourceKey(options);
  let unsupported = skipLibRaw || (key !== null && unsupportedSources.has(key));
  if (!unsupported) {
    try {
      return await decodeWithLibRaw(input, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      unsupported = unsupportedByLibRaw(error);
    }
  }

  if (unsupported && key !== null) {
    unsupportedSources.add(key);
    const oldest = unsupportedSources.values().next().value;
    if (unsupportedSources.size > 256 && oldest !== undefined) unsupportedSources.delete(oldest);
  }
  let fallbackCode = "SDK_UNAVAILABLE";
  let fallbackMessage = "Nikon decoder is unavailable.";
  const api = typeof window === "undefined" ? undefined : window.darkroom;

  if (api && options.assetRequest) {
    try {
      const result = await api.catalogDecodeAsset(options.assetRequest, {
        kind: "nef",
        mode: options.fullResolution ? "full" : "preview",
        maxEdge: Math.min(options.maxEdge ?? PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE),
      });
      options.signal?.throwIfAborted();
      if (result.available) {
        return {
          width: result.width,
          height: result.height,
          rgb: new Uint16Array(result.pixels),
          bits: result.bitDepth,
          colors: result.channels,
          pixelProvenance: {
            decoderPath: result.provenance,
            decoderRevision: "rgb16le-v1",
            colorSpace: result.colorSpace,
            transfer: "encoded",
            bitDepth: result.bitDepth,
            cameraProfileStage: {
              kind: "unavailable",
              reason: "The Nikon decoder protocol returns rendered sRGB pixels.",
            },
          },
          metadata: {
            decoderProvenance: result.provenance,
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
      options.signal?.throwIfAborted();
      fallbackCode = "NATIVE_DECODE_FAILED";
      fallbackMessage = error instanceof Error
        ? error.message
        : "Nikon decoder failed.";
    }
  }

  const embedded = await decodeEmbeddedThumbnail(input, options);
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

function cameraProfileFallbackReason(error: unknown): string {
  const message = error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "The LibRaw camera profile stage failed.";
  return `The LibRaw camera profile stage is unavailable: ${message}`;
}

async function decodeWithCameraProfileFallback(
  input: Uint8Array,
  options: DecodeOptions,
): Promise<DecodedImage> {
  const key = sourceKey(options);
  if (key !== null && unsupportedSources.has(key)) {
    return decodeDevelopedNef(input, { ...options, cameraProfile: { kind: "none" } }, true);
  }
  try {
    return await decodeWithLibRaw(input, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    const fallback = await decodeDevelopedNef(input, {
      ...options,
      cameraProfile: { kind: "none" },
    }, unsupportedByLibRaw(error));
    return {
      ...fallback,
      pixelProvenance: {
        ...fallback.pixelProvenance,
        cameraProfileStage: {
          kind: "unavailable",
          reason: cameraProfileFallbackReason(error),
        },
      },
    };
  }
}

export const nefProfile: ImageProfile = {
  id: "nef",
  extensions: getFormatExtensionsForProfile("nef"),
  detect: (file) =>
    getFormatCapabilityForFileName(file.name)?.profileId === "nef",
  decode: (input, options: DecodeOptions = {}) => {
    if (options.cameraProfile?.kind === "libraw-camera-matrix") {
      return decodeWithCameraProfileFallback(input, options);
    }
    return options.fullResolution ||
      (options.thumbnail && options.rawSource === "developed")
        ? decodeDevelopedNef(input, options)
        : decodeWithLibRaw(input, options);
  },
};
