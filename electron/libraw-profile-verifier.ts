import path from "node:path";
import { Worker } from "node:worker_threads";
import type { MatrixCameraProfile } from "../lib/camera-profiles/matrix.ts";
import {
  LIBRAW_PROFILE_MAX_INPUT_BYTES,
  LIBRAW_PROFILE_TIMEOUT_MS,
  parseLibRawProfileWorkerResponse,
} from "./libraw-profile-protocol.ts";

export interface LibRawProfileVerificationOptions {
  readonly workerPath?: string | URL;
  readonly timeoutMs?: number;
}

let verificationQueue: Promise<void> = Promise.resolve();

function positiveTimeout(value: number | undefined): number {
  if (value === undefined) return LIBRAW_PROFILE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > LIBRAW_PROFILE_TIMEOUT_MS) {
    throw new Error("LibRaw profile verification timeout is invalid.");
  }
  return value;
}

function transferableBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.byteLength < 1 || bytes.byteLength > LIBRAW_PROFILE_MAX_INPUT_BYTES) {
    throw new Error("LibRaw profile input is invalid or too large.");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function runWorker(
  bytes: Uint8Array,
  options: LibRawProfileVerificationOptions,
): Promise<MatrixCameraProfile> {
  const input = transferableBytes(bytes);
  const workerPath = options.workerPath ?? path.join(__dirname, "libraw-profile-worker.js");
  const timeoutMs = positiveTimeout(options.timeoutMs);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: input,
      transferList: [input.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: 384,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const finish = (result: { readonly kind: "resolve"; readonly profile: MatrixCameraProfile } | { readonly kind: "reject"; readonly error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate().catch(() => undefined);
      if (result.kind === "resolve") resolve(result.profile);
      else reject(result.error);
    };
    const timer = setTimeout(() => {
      finish({ kind: "reject", error: new Error("LibRaw profile verification timed out.") });
    }, timeoutMs);
    worker.once("message", (value: unknown) => {
      try {
        const response = parseLibRawProfileWorkerResponse(value);
        if (response.kind === "failed") finish({ kind: "reject", error: new Error(response.message) });
        else finish({ kind: "resolve", profile: response.profile });
      } catch (error) {
        finish({ kind: "reject", error: error instanceof Error ? error : new Error("LibRaw profile worker returned invalid data.") });
      }
    });
    worker.once("error", (error) => finish({ kind: "reject", error }));
    worker.once("exit", (code) => {
      if (code !== 0) finish({ kind: "reject", error: new Error("LibRaw profile worker stopped unexpectedly.") });
    });
  });
}

export function verifyLibRawInputProfile(
  bytes: Uint8Array,
  options: LibRawProfileVerificationOptions = {},
): Promise<MatrixCameraProfile> {
  const execute = () => runWorker(bytes, options);
  const result = verificationQueue.then(execute, execute);
  verificationQueue = result.then(() => undefined, () => undefined);
  return result;
}
