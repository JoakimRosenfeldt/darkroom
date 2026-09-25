import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { CatalogAssetRequest } from "@/lib/catalog/api";
import { buildFromImageData } from "./libraw-client";
import type { DecodeOptions, DecodedImage } from "./types";

const DECODER_REVISION = "libraw-native-0.22.1-compat-v1";
const MAX_PIXEL_BYTES = 512 * 1024 * 1024;

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
  const header = record(JSON.parse(new TextDecoder().decode(new Uint8Array(response, 4, metadataLength))));
  const { width, height, byteCount } = header;
  if (header.version !== 1 || header.bits !== 16 || header.colors !== 3 || header.decoderRevision !== DECODER_REVISION ||
      typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 || width > 65_535 ||
      typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 || height > 65_535 ||
      typeof byteCount !== "number" || byteCount !== width * height * 6 || byteCount > MAX_PIXEL_BYTES ||
      byteCount !== response.byteLength - pixelOffset) {
    throw new Error("Native RAW pixels are invalid.");
  }
  return {
    image: { width, height, bits: 16, colors: 3, data: new Uint16Array(response, pixelOffset, byteCount / 2) },
    metadata: record(header.metadata),
  };
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
    const response = await invoke<ArrayBuffer>("darkroom_libraw_decode", {
      requestId,
      request,
      options: { mode: options.fullResolution ? "full" : "preview", maxEdge: options.maxEdge ?? 2_560 },
      onStarted,
    });
    options.signal?.throwIfAborted();
    const { image, metadata } = decodeResponse(response);
    if (typeof metadata.timestamp === "number") metadata.timestamp = new Date(metadata.timestamp * 1_000);
    const decoded = await buildFromImageData(image, metadata, options);
    if (options.signal?.aborted && decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
    options.signal?.throwIfAborted();
    return {
      ...decoded,
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
