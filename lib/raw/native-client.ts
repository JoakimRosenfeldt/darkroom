import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { CatalogAssetRequest } from "@/lib/catalog/api";
import { nativeGpuAvailable } from "@/lib/develop/v3/native-context";
import { buildFromImageData } from "./libraw-client";
import type { DecodeOptions, DecodedImage } from "./types";

const DECODER_REVISION = "libraw-native-0.22.1-linear-v2";
const STANDARD_DECODER_REVISION = "native-image-rgba8-v1";
const MAX_PIXEL_BYTES = 512 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headerTextDecoder = new TextDecoder();

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native RAW metadata is invalid.");
  }
  return value as Record<string, unknown>;
}

function decodeResponse(response: ArrayBuffer) {
  if (!(response instanceof ArrayBuffer) || response.byteLength < 4) {
    throw new Error("Native RAW response is invalid.");
  }
  const metadataLength = new DataView(response).getUint32(0, true);
  const pixelOffset = 4 + metadataLength;
  if (metadataLength === 0 || metadataLength > 64 * 1024 || metadataLength % 4 !== 0 || pixelOffset > response.byteLength) {
    throw new Error("Native RAW response size is invalid.");
  }
  const header = record(JSON.parse(headerTextDecoder.decode(new Uint8Array(response, 4, metadataLength))));
  const { width, height, byteCount } = header;
  const sourceHandle = header.sourceHandle;
  const pixelsOmitted = header.pixelsOmitted === true;
  if (header.version !== 1 || header.bits !== 16 || header.colors !== 3 || header.decoderRevision !== DECODER_REVISION ||
      typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 || width > 65_535 ||
      typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 || height > 65_535 ||
      typeof byteCount !== "number" || byteCount !== width * height * 6 || byteCount > MAX_PIXEL_BYTES ||
      (pixelsOmitted
        ? response.byteLength !== pixelOffset || typeof sourceHandle !== "string" || !UUID_PATTERN.test(sourceHandle)
        : byteCount !== response.byteLength - pixelOffset ||
          (sourceHandle !== undefined && (typeof sourceHandle !== "string" || !UUID_PATTERN.test(sourceHandle))))) {
    throw new Error("Native RAW pixels are invalid.");
  }
  return {
    image: {
      width,
      height,
      bits: 16,
      colors: 3,
      data: pixelsOmitted
        ? new Uint16Array(0)
        : new Uint16Array(response, pixelOffset, byteCount / 2),
    },
    nativeSourceHandle: typeof sourceHandle === "string" ? sourceHandle : undefined,
    metadata: record(header.metadata),
  };
}

function decodeStandardResponse(response: ArrayBuffer) {
  if (!(response instanceof ArrayBuffer) || response.byteLength < 4) {
    throw new Error("Native image response is invalid.");
  }
  const metadataLength = new DataView(response).getUint32(0, true);
  const pixelOffset = 4 + metadataLength;
  if (metadataLength === 0 || metadataLength > 64 * 1024 || metadataLength % 4 !== 0 || pixelOffset > response.byteLength) {
    throw new Error("Native image response size is invalid.");
  }
  const header = record(JSON.parse(headerTextDecoder.decode(new Uint8Array(response, 4, metadataLength))));
  const { width, height, colors, byteCount, format } = header;
  const sourceHandle = header.sourceHandle;
  const pixelsOmitted = header.pixelsOmitted === true;
  if (header.version !== 1 || header.bits !== 8 || (colors !== 3 && colors !== 4) ||
      header.decoderRevision !== STANDARD_DECODER_REVISION ||
      typeof format !== "string" ||
      typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 || width > 65_535 ||
      typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 || height > 65_535 ||
      typeof byteCount !== "number" || byteCount !== width * height * colors || byteCount > MAX_PIXEL_BYTES ||
      (pixelsOmitted
        ? response.byteLength !== pixelOffset || typeof sourceHandle !== "string" || !UUID_PATTERN.test(sourceHandle)
        : byteCount !== response.byteLength - pixelOffset ||
          (sourceHandle !== undefined && (typeof sourceHandle !== "string" || !UUID_PATTERN.test(sourceHandle))))) {
    throw new Error("Native image pixels are invalid.");
  }
  return {
    width,
    height,
    colors,
    format,
    rgb: pixelsOmitted
      ? new Uint8Array(0)
      : new Uint8Array(response, pixelOffset, byteCount),
    nativeSourceHandle: typeof sourceHandle === "string" ? sourceHandle : undefined,
  };
}

export async function readNativeSourcePixels(
  handle: string,
  bits: number,
): Promise<Uint8Array | Uint16Array | null> {
  if (!isTauri() || !UUID_PATTERN.test(handle)) return null;
  try {
    const response = await invoke<ArrayBuffer>("darkroom_read_source", { handle });
    if (!(response instanceof ArrayBuffer) || response.byteLength === 0) return null;
    if (bits > 8) {
      if (response.byteLength % 2 !== 0) return null;
      return new Uint16Array(response);
    }
    return new Uint8Array(response);
  } catch {
    return null;
  }
}

export async function decodeWithNativeStandard(
  request: CatalogAssetRequest,
  options: DecodeOptions = {},
): Promise<DecodedImage | null> {
  if (!isTauri() || !options.fullResolution || !options.sourcePixels) return null;
  options.signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  let started = false;
  let finished = false;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    if (!started || finished || cancellation) return;
    cancellation = invoke<void>("darkroom_libraw_cancel", { requestId }).catch(() => undefined);
  };
  const onStarted = new Channel<void>(() => {
    started = true;
    if (options.signal?.aborted) cancel();
  });
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const handleOnly = options.handleOnly !== false && nativeGpuAvailable();
    const response = await invoke<ArrayBuffer>("darkroom_decode_standard", {
      requestId,
      request,
      options: { handleOnly },
      onStarted,
    });
    options.signal?.throwIfAborted();
    const decoded = decodeStandardResponse(response);
    return {
      width: decoded.width,
      height: decoded.height,
      rgb: decoded.rgb,
      nativeSourceHandle: decoded.nativeSourceHandle,
      bits: 8,
      colors: decoded.colors,
      pixelProvenance: {
        decoderPath: "processed-standard",
        decoderRevision: STANDARD_DECODER_REVISION,
        colorSpace: "srgb",
        transfer: "encoded",
        bitDepth: 8,
        cameraProfileStage: {
          kind: "unavailable",
          reason: "Standard images contain rendered pixels.",
        },
      },
      metadata: {
        format: decoded.format,
        source: "standard",
        decoderProvenance: "standard",
        decoderExecution: "native-image",
        originalWidth: decoded.width,
        originalHeight: decoded.height,
      },
    };
  } catch {
    options.signal?.throwIfAborted();
    return null;
  } finally {
    finished = true;
    options.signal?.removeEventListener("abort", cancel);
    if (cancellation) await cancellation;
  }
}

export async function decodeWithNativeLibRaw(
  request: CatalogAssetRequest,
  options: DecodeOptions = {},
): Promise<DecodedImage | null> {
  if (!isTauri() || options.cameraProfile?.kind !== "libraw-camera-matrix" ||
      !(options.fullResolution || (options.thumbnail && options.rawSource === "developed"))) return null;
  options.signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  let started = false;
  let finished = false;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    if (!started || finished || cancellation) return;
    cancellation = invoke<void>("darkroom_libraw_cancel", { requestId }).catch(() => undefined);
  };
  const onStarted = new Channel<void>(() => {
    started = true;
    if (options.signal?.aborted) cancel();
  });
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const handleOnly = Boolean(
      options.fullResolution &&
      options.sourcePixels &&
      options.handleOnly !== false &&
      nativeGpuAvailable(),
    );
    const response = await invoke<ArrayBuffer>("darkroom_libraw_decode", {
      requestId,
      request,
      options: {
        mode: options.fullResolution ? "full" : "preview",
        maxEdge: options.maxEdge ?? 2_560,
        handleOnly,
      },
      onStarted,
    });
    options.signal?.throwIfAborted();
    const { image, metadata, nativeSourceHandle } = decodeResponse(response);
    if (typeof metadata.timestamp === "number") metadata.timestamp = new Date(metadata.timestamp * 1_000);
    const decoded = await buildFromImageData(image, metadata, options);
    if (options.signal?.aborted && decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
    options.signal?.throwIfAborted();
    return {
      ...decoded,
      nativeSourceHandle,
      // Preserve the decoder family used by existing Develop default rules.
      pixelProvenance: { ...decoded.pixelProvenance, decoderRevision: DECODER_REVISION },
      metadata: {
        ...decoded.metadata,
        decoderExecution: "libraw-native",
        ...(options.thumbnail ? { developSource: "raw" } : {}),
      },
    };
  } catch {
    options.signal?.throwIfAborted();
    return null;
  } finally {
    finished = true;
    options.signal?.removeEventListener("abort", cancel);
    if (cancellation) await cancellation;
  }
}
