import type { AiModelId } from "@/lib/ai/types";
import {
  disposeDevelopImage,
  loadDevelopInferenceImage,
} from "@/lib/cache/develop-image-cache";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { LibraryEntry } from "@/lib/fs/types";
import type { SourceSignature } from "@/lib/develop/types";
import type {
  AiInferenceErrorCode,
  AiInferenceProgressMessage,
  AiInferenceResult,
  AiInferenceWorkerResponse,
  AiInferenceSourceImage,
} from "@/lib/ai/worker-types";

export interface AiInferenceProgress {
  readonly stage: AiInferenceProgressMessage["stage"];
  readonly progress: number;
}

export interface RunAiMaskInferenceOptions {
  readonly modelId: AiModelId;
  readonly entry: LibraryEntry;
  readonly sourceSignature: SourceSignature;
  readonly signal?: AbortSignal;
  readonly forceWasm?: boolean;
  readonly onProgress?: (progress: AiInferenceProgress) => void;
}

export class AiInferenceError extends Error {
  readonly code: AiInferenceErrorCode;
  readonly fallbackReason?: string;

  constructor(
    code: AiInferenceErrorCode,
    message: string,
    fallbackReason?: string,
  ) {
    super(message);
    this.name = "AiInferenceError";
    this.code = code;
    this.fallbackReason = fallbackReason;
  }
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `ai-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

function abortError(): AiInferenceError {
  return new AiInferenceError("cancelled", "AI inference was cancelled.");
}

function safeWorkerError(
  response: Extract<AiInferenceWorkerResponse, { kind: "error" }>,
): AiInferenceError {
  const message = response.code === "model-unavailable"
    ? "The selected AI model is unavailable. Download it first, then try again."
    : response.code === "protocol"
      ? "The local AI model service is unavailable. Restart Darkroom and try again."
      : response.message;
  return new AiInferenceError(response.code, message, response.fallbackReason);
}

function workerFactory(): Worker {
  return new Worker(new URL("./inference-worker.ts", import.meta.url), {
    type: "module",
  });
}

const WORKER_IDLE_MS = 61_000;

interface PendingInference {
  readonly resolve: (result: AiInferenceResult) => void;
  readonly reject: (error: AiInferenceError) => void;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AiInferenceProgress) => void;
  readonly abort: () => void;
}

interface SharedWorkerState {
  readonly worker: Worker;
  readonly pending: Map<string, PendingInference>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

let sharedWorkerState: SharedWorkerState | null = null;

function runtimeError(): AiInferenceError {
  return new AiInferenceError(
    "runtime",
    "The AI inference worker stopped unexpectedly.",
  );
}

function clearWorkerIdleTimer(state: SharedWorkerState): void {
  if (state.idleTimer === null) {
    return;
  }
  clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

function scheduleWorkerIdle(state: SharedWorkerState): void {
  clearWorkerIdleTimer(state);
  if (state.pending.size > 0) {
    return;
  }
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (sharedWorkerState !== state || state.pending.size > 0) {
      return;
    }
    resetWorkerState(state);
  }, WORKER_IDLE_MS);
}

function takePending(
  state: SharedWorkerState,
  id: string,
): PendingInference | undefined {
  const pending = state.pending.get(id);
  if (pending === undefined) {
    return undefined;
  }
  state.pending.delete(id);
  pending.signal?.removeEventListener("abort", pending.abort);
  if (state.pending.size === 0) {
    scheduleWorkerIdle(state);
  }
  return pending;
}

function resetWorkerState(
  state: SharedWorkerState,
  rejection: AiInferenceError = runtimeError(),
): void {
  if (sharedWorkerState === state) {
    sharedWorkerState = null;
  }
  clearWorkerIdleTimer(state);
  state.worker.onmessage = null;
  state.worker.onerror = null;
  state.worker.onmessageerror = null;
  state.worker.terminate();
  const pending = [...state.pending.values()];
  state.pending.clear();
  for (const request of pending) {
    request.signal?.removeEventListener("abort", request.abort);
    request.reject(rejection);
  }
}

function handleWorkerResponse(
  state: SharedWorkerState,
  event: MessageEvent<AiInferenceWorkerResponse>,
): void {
  const response = event.data;
  if (!response || typeof response.requestId !== "string") {
    return;
  }
  const pending = state.pending.get(response.requestId);
  if (pending === undefined) {
    return;
  }
  if (response.kind === "progress") {
    pending.onProgress?.({ stage: response.stage, progress: response.progress });
    return;
  }
  const request = takePending(state, response.requestId);
  if (request === undefined) {
    return;
  }
  if (response.kind === "result") {
    request.resolve(response);
    return;
  }
  const error = safeWorkerError(response);
  request.reject(error);
  if (error.code !== "cancelled") {
    resetWorkerState(state, error);
  }
}

function createWorkerState(): SharedWorkerState {
  const state: SharedWorkerState = {
    worker: workerFactory(),
    pending: new Map(),
    idleTimer: null,
  };
  state.worker.onmessage = (event: MessageEvent<AiInferenceWorkerResponse>): void => {
    handleWorkerResponse(state, event);
  };
  state.worker.onerror = (): void => {
    resetWorkerState(state);
  };
  state.worker.onmessageerror = (): void => {
    resetWorkerState(state);
  };
  return state;
}

function getWorkerState(): SharedWorkerState {
  if (sharedWorkerState === null) {
    sharedWorkerState = createWorkerState();
  }
  return sharedWorkerState;
}

function abortPending(state: SharedWorkerState, id: string): void {
  const pending = takePending(state, id);
  if (pending === undefined) {
    return;
  }
  pending.reject(abortError());
  try {
    state.worker.postMessage({ kind: "cancel", requestId: id });
  } catch {
    resetWorkerState(state);
    return;
  }
  if (state.pending.size === 0) {
    resetWorkerState(state);
  }
}

function sourceImageForWorker(image: DevelopImage): AiInferenceSourceImage {
  const buffer = image.rgb.buffer;
  if (!(buffer instanceof ArrayBuffer)) {
    throw new AiInferenceError(
      "protocol",
      "The decoded AI source pixels cannot be transferred to the worker.",
    );
  }
  return {
    width: image.width,
    height: image.height,
    sourceWidth: image.sourceWidth,
    sourceHeight: image.sourceHeight,
    orientation: image.orientation,
    bits: image.bits,
    colors: image.colors,
    pixels: image.rgb,
  };
}

export async function runAiMaskInference(
  options: RunAiMaskInferenceOptions,
): Promise<AiInferenceResult> {
  const sourceImage = await loadDevelopInferenceImage(options.entry, options.signal);
  try {
    if (options.signal?.aborted) {
      throw abortError();
    }
    const image = sourceImageForWorker(sourceImage);
    const pixelBuffer = image.pixels.buffer;
    if (!(pixelBuffer instanceof ArrayBuffer)) {
      throw new AiInferenceError(
        "protocol",
        "The decoded AI source pixels cannot be transferred to the worker.",
      );
    }
    const id = requestId();
    let state: SharedWorkerState;
    try {
      state = getWorkerState();
    } catch {
      throw runtimeError();
    }
    const backend = options.forceWasm ? "wasm" : "auto";

    return await new Promise<AiInferenceResult>((resolve, reject) => {
      const abort = (): void => {
        abortPending(state, id);
      };
      state.pending.set(id, {
        resolve,
        reject,
        signal: options.signal,
        onProgress: options.onProgress,
        abort,
      });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }

      try {
        state.worker.postMessage(
          {
            kind: "run",
            requestId: id,
            modelId: options.modelId,
            image,
            sourceSignature: options.sourceSignature,
            backend,
          },
          [pixelBuffer],
        );
      } catch {
        const pending = takePending(state, id);
        pending?.reject(runtimeError());
        resetWorkerState(state);
      }
    });
  } finally {
    disposeDevelopImage(sourceImage);
  }
}
