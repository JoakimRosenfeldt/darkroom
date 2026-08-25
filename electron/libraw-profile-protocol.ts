import {
  parseMatrixCameraProfile,
  type MatrixCameraProfile,
} from "../lib/camera-profiles/matrix.ts";

export const LIBRAW_PROFILE_MAX_INPUT_BYTES = 128 * 1024 * 1024;
export const LIBRAW_PROFILE_MAX_WASM_BYTES = 64 * 1024 * 1024;
export const LIBRAW_PROFILE_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const LIBRAW_PROFILE_MAX_METADATA_BYTES = 2 * 1024 * 1024;
export const LIBRAW_PROFILE_MAX_METADATA_DEPTH = 16;
export const LIBRAW_PROFILE_MAX_METADATA_NODES = 100_000;
export const LIBRAW_PROFILE_TIMEOUT_MS = 30_000;

export type LibRawProfileWorkerResponse =
  | { readonly kind: "verified"; readonly profile: MatrixCameraProfile }
  | { readonly kind: "failed"; readonly message: string };

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.fromEntries(Object.entries(value));
}

function message(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0")) {
    throw new Error("LibRaw profile worker error is invalid.");
  }
  return value;
}

export function parseLibRawProfileWorkerInput(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > LIBRAW_PROFILE_MAX_INPUT_BYTES) {
    throw new Error("LibRaw profile input is invalid or too large.");
  }
  return value;
}

export function parseLibRawProfileWorkerResponse(value: unknown): LibRawProfileWorkerResponse {
  const input = object(value, "LibRaw profile worker response");
  if (input.kind === "failed") {
    if (Object.keys(input).some((key) => key !== "kind" && key !== "message")) {
      throw new Error("LibRaw profile worker response has unknown fields.");
    }
    return { kind: "failed", message: message(input.message) };
  }
  if (input.kind !== "verified" || Object.keys(input).some((key) => key !== "kind" && key !== "profile")) {
    throw new Error("LibRaw profile worker response is invalid.");
  }
  return { kind: "verified", profile: parseMatrixCameraProfile(input.profile) };
}

export function safeLibRawProfileError(error: unknown): string {
  const value = error instanceof Error && error.message.length > 0
    ? error.message
    : "LibRaw profile verification failed.";
  return value.replaceAll("\0", "").slice(0, 512) || "LibRaw profile verification failed.";
}
