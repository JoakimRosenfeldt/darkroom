import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { matrixCameraProfileFromLibRawMetadata, type MatrixCameraProfile } from "../lib/camera-profiles/matrix.ts";

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
let libRawModulePromise: Promise<NativeLibRawModule> | null = null;
let verificationQueue: Promise<void> = Promise.resolve();

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
  if (
    !(data instanceof Uint16Array) ||
    typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 ||
    typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 ||
    bits !== 16 || colors !== 3 || data.length !== width * height * colors
  ) {
    throw new Error("LibRaw did not produce verified linear RGB16 camera pixels.");
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

async function loadModule(): Promise<NativeLibRawModule> {
  if (libRawModulePromise) return libRawModulePromise;
  libRawModulePromise = (async () => {
    const moduleName: string = "libraw-wasm/dist/libraw.js";
    const imported: unknown = await import(moduleName);
    const factory = typeof imported === "object" && imported !== null
      ? Reflect.get(imported, "default")
      : null;
    if (typeof factory !== "function") throw new Error("LibRaw verification factory is unavailable.");
    const wasmPath = require.resolve("libraw-wasm/dist/libraw.wasm");
    const wasmBinary = new Uint8Array(await fs.readFile(wasmPath));
    return nativeModule(await Reflect.apply(factory, undefined, [{ wasmBinary }]));
  })();
  return libRawModulePromise;
}

export function verifyLibRawInputProfile(bytes: Uint8Array): Promise<MatrixCameraProfile> {
  const execute = async (): Promise<MatrixCameraProfile> => {
    const runtime = await loadModule();
    const raw = nativeRaw(runtime.create());
    try {
      raw.open(bytes.slice(), {
        halfSize: true,
        outputBps: 16,
        outputColor: 0,
        gamm: [1, 1],
        noAutoBright: true,
        useCameraMatrix: 0,
        useCameraWb: true,
        userQual: 0,
      });
      const metadata = structuredClone(object(raw.metadata(true)));
      nativeImage(raw.imageData());
      return matrixCameraProfileFromLibRawMetadata(metadata);
    } finally {
      raw.delete?.();
    }
  };
  const result = verificationQueue.then(execute, execute);
  verificationQueue = result.then(() => undefined, () => undefined);
  return result;
}
