import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { parseCatalogDecodeResult } from "@/lib/catalog/api";

type Listener = (event: undefined, payload: unknown) => void;

const channels = [
  "darkroom:develop-batch-updated",
  "darkroom:develop-jobs-updated",
  "darkroom:catalog-metadata-analysis-progress",
  "darkroom:catalog-event",
  "darkroom:catalog-fingerprint-progress",
  "darkroom:ai-model-progress",
] as const;

function encodeBinary(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function encode(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return { __darkroomBinary: encodeBinary(new Uint8Array(value)), type: "ArrayBuffer" };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      __darkroomBinary: encodeBinary(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      type: value.constructor.name,
    };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("__darkroomBinary" in value && typeof value.__darkroomBinary === "string") {
    const binary = atob(value.__darkroomBinary);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const type = "type" in value ? value.type : "ArrayBuffer";
    switch (type) {
      case "Uint8Array": return bytes;
      case "Uint8ClampedArray": return new Uint8ClampedArray(bytes.buffer);
      case "Uint16Array": return new Uint16Array(bytes.buffer);
      case "Float32Array": return new Float32Array(bytes.buffer);
      case "ArrayBuffer": return bytes.buffer;
      default: throw new Error("The desktop returned an unsupported binary type.");
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

const listeners = new Map<string, Set<Listener>>();
let initialized: Promise<void> | undefined;

export const desktopTransport = {
  initialize(): Promise<void> {
    initialized ??= (async () => {
      const subscriptions: UnlistenFn[] = [];
      try {
        // Subscribe before exposing the API so immediate native events cannot race setup.
        for (const channel of channels) {
          subscriptions.push(await listen(channel, ({ payload }) => {
            for (const listener of listeners.get(channel) ?? []) listener(undefined, payload);
          }));
        }
      } catch (error) {
        for (const unsubscribe of subscriptions) unsubscribe();
        throw error;
      }
    })();
    return initialized;
  },

  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    try {
      if (channel === "darkroom:catalog-read-asset" || channel === "darkroom:catalog-read-asset-head") {
        return await invoke<ArrayBuffer>("darkroom_read", { channel, args }) as T;
      }
      if (channel === "darkroom:catalog-read-embedded-preview") {
        return await invoke<ArrayBuffer>("darkroom_preview", { request: args[0] }) as T;
      }
      if (channel === "darkroom:catalog-decode-asset") {
        const response = await invoke<ArrayBuffer>("darkroom_decode", { args });
        if (!(response instanceof ArrayBuffer) || response.byteLength < 4) {
          throw new Error("Native decode response is invalid.");
        }
        const metadataLength = new DataView(response).getUint32(0, true);
        const pixelOffset = 4 + metadataLength;
        if (metadataLength > 64 * 1024 || pixelOffset > response.byteLength || response.byteLength - pixelOffset > 512 * 1024 * 1024) {
          throw new Error("Native decode response size is invalid.");
        }
        const metadata: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(response, 4, metadataLength)));
        if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
          throw new Error("Native decode metadata is invalid.");
        }
        if ("available" in metadata && metadata.available === true) {
          if (!("byteCount" in metadata) || metadata.byteCount !== response.byteLength - pixelOffset) {
            throw new Error("Native decode pixel byte count is invalid.");
          }
          return parseCatalogDecodeResult({ ...metadata, pixels: response.slice(pixelOffset) }) as T;
        }
        if (pixelOffset !== response.byteLength) throw new Error("Native decode failure contains pixels.");
        return parseCatalogDecodeResult(metadata) as T;
      }
      if (channel === "darkroom:encode-and-save-export") {
        const payload = args[2];
        const wrapped = payload !== null && typeof payload === "object" && "pixels" in payload;
        const pixels = wrapped ? payload.pixels : payload;
        const bytes = pixels instanceof ArrayBuffer
          ? new Uint8Array(pixels)
          : ArrayBuffer.isView(pixels)
            ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
            : null;
        if (!bytes) throw new Error("Export pixels are not a binary buffer.");
        const metadata = new TextEncoder().encode(JSON.stringify([
          args[0], args[1], wrapped ? { ...payload, pixels: null } : null, args[3],
        ]));
        const request = new Uint8Array(4 + metadata.length + bytes.length);
        new DataView(request.buffer).setUint32(0, metadata.length, true);
        request.set(metadata, 4);
        request.set(bytes, 4 + metadata.length);
        return await invoke<T>("darkroom_export", request);
      }
      const result = await invoke<unknown>("darkroom_invoke", { channel, args: encode(args) });
      return (channel === "darkroom:develop-asset-read"
        ? decode(result)
        : result) as T;
    } catch (error) {
      throw error instanceof Error ? error : new Error(typeof error === "string" ? error : "The desktop command failed.");
    }
  },

  on(channel: string, listener: Listener): void {
    const subscribers = listeners.get(channel) ?? new Set<Listener>();
    subscribers.add(listener);
    listeners.set(channel, subscribers);
  },

  removeListener(channel: string, listener: Listener): void {
    listeners.get(channel)?.delete(listener);
  },
};
