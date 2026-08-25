import { createRequire } from "node:module";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { matrixCameraProfileFromLibRawMetadata } from "../lib/camera-profiles/matrix.ts";
import {
  LIBRAW_PROFILE_MAX_METADATA_BYTES,
  LIBRAW_PROFILE_MAX_METADATA_DEPTH,
  LIBRAW_PROFILE_MAX_METADATA_NODES,
  LIBRAW_PROFILE_MAX_OUTPUT_BYTES,
  LIBRAW_PROFILE_MAX_WASM_BYTES,
  parseLibRawProfileWorkerInput,
  safeLibRawProfileError,
  type LibRawProfileWorkerResponse,
} from "./libraw-profile-protocol.ts";

interface NativeLibRawImage {
  readonly data: Uint16Array;
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly colors: number;
}

interface NativeLibRaw {
  readonly open: (bytes: Uint8Array, settings: Record<string, unknown>) => void;
  readonly metadata: (full: boolean) => unknown;
  readonly imageData: () => unknown;
  readonly delete?: () => void;
}

interface NativeLibRawModule {
  readonly create: () => unknown;
}

const require = createRequire(__filename);

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LibRaw verification returned invalid data.");
  }
  return Object.fromEntries(Object.entries(value));
}

function nativeModule(value: unknown): NativeLibRawModule {
  const input = object(value);
  const LibRaw = Reflect.get(input, "LibRaw");
  if (typeof LibRaw !== "function") throw new Error("LibRaw verification module is unavailable.");
  return { create: () => Reflect.construct(LibRaw, []) };
}

function nativeImage(value: unknown): NativeLibRawImage {
  const input = object(value);
  const data = Reflect.get(input, "data");
  const width = Reflect.get(input, "width");
  const height = Reflect.get(input, "height");
  const bits = Reflect.get(input, "bits");
  const colors = Reflect.get(input, "colors");
  const samples = typeof width === "number" && typeof height === "number"
    ? width * height * 3
    : Number.NaN;
  if (
    !(data instanceof Uint16Array) ||
    typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 ||
    typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 ||
    !Number.isSafeInteger(samples) || samples * Uint16Array.BYTES_PER_ELEMENT > LIBRAW_PROFILE_MAX_OUTPUT_BYTES ||
    bits !== 16 || colors !== 3 || data.length !== samples
  ) {
    throw new Error("LibRaw did not produce bounded linear RGB16 camera pixels.");
  }
  return { data, width, height, bits, colors };
}

function nativeRaw(value: unknown): NativeLibRaw {
  const input = object(value);
  const open = Reflect.get(input, "open");
  const metadata = Reflect.get(input, "metadata");
  const imageData = Reflect.get(input, "imageData");
  const dispose = Reflect.get(input, "delete");
  if (
    typeof open !== "function" || typeof metadata !== "function" ||
    typeof imageData !== "function" || (dispose !== undefined && typeof dispose !== "function")
  ) {
    throw new Error("LibRaw verification decoder is invalid.");
  }
  return {
    open: (bytes, settings) => Reflect.apply(open, input, [bytes, settings]),
    metadata: (full) => Reflect.apply(metadata, input, [full]),
    imageData: () => Reflect.apply(imageData, input, []),
    ...(typeof dispose === "function" ? { delete: () => { Reflect.apply(dispose, input, []); } } : {}),
  };
}

async function readBoundedFile(filePath: string, maximum: number): Promise<Uint8Array> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) {
      throw new Error("LibRaw verification module is invalid or too large.");
    }
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error("LibRaw verification module ended early.");
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("LibRaw verification module changed while it was read.");
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

function boundedMetadata(value: unknown): Record<string, unknown> {
  const root = object(value);
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > LIBRAW_PROFILE_MAX_METADATA_NODES || current.depth > LIBRAW_PROFILE_MAX_METADATA_DEPTH) {
      throw new Error("LibRaw verification metadata exceeds its structural limit.");
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) throw new Error("LibRaw verification metadata is cyclic.");
    seen.add(current.value);
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const item of values) pending.push({ value: item, depth: current.depth + 1 });
  }
  const serialized = JSON.stringify(root);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > LIBRAW_PROFILE_MAX_METADATA_BYTES) {
    throw new Error("LibRaw verification metadata is too large.");
  }
  return root;
}

async function loadModule(): Promise<NativeLibRawModule> {
  const moduleName: string = "libraw-wasm/dist/libraw.js";
  const imported: unknown = await import(moduleName);
  const factory = typeof imported === "object" && imported !== null
    ? Reflect.get(imported, "default")
    : null;
  if (typeof factory !== "function") throw new Error("LibRaw verification factory is unavailable.");
  const wasmPath = require.resolve("libraw-wasm/dist/libraw.wasm");
  const wasmBinary = await readBoundedFile(wasmPath, LIBRAW_PROFILE_MAX_WASM_BYTES);
  return nativeModule(await Reflect.apply(factory, undefined, [{ wasmBinary }]));
}

async function verify(): Promise<LibRawProfileWorkerResponse> {
  const bytes = parseLibRawProfileWorkerInput(workerData);
  const runtime = await loadModule();
  const raw = nativeRaw(runtime.create());
  try {
    raw.open(bytes, {
      halfSize: true,
      outputBps: 16,
      outputColor: 0,
      gamm: [1, 1],
      noAutoBright: true,
      useCameraMatrix: 0,
      useCameraWb: true,
      userQual: 0,
    });
    const metadata = boundedMetadata(raw.metadata(true));
    nativeImage(raw.imageData());
    return { kind: "verified", profile: matrixCameraProfileFromLibRawMetadata(metadata) };
  } finally {
    raw.delete?.();
  }
}

if (!parentPort) throw new Error("LibRaw profile worker requires a parent port.");
const port = parentPort;
void verify().then(
  (response) => port.postMessage(response),
  (error: unknown) => port.postMessage({ kind: "failed", message: safeLibRawProfileError(error) } satisfies LibRawProfileWorkerResponse),
);
