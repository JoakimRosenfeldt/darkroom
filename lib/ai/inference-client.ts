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
    const worker = workerFactory();
    const backend = options.forceWasm ? "wasm" : "auto";

    return await new Promise<AiInferenceResult>((resolve, reject) => {
      let settled = false;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        callback();
      };

      const abort = (): void => {
        finish(() => reject(abortError()));
      };

      worker.onmessage = (event: MessageEvent<AiInferenceWorkerResponse>): void => {
        const response = event.data;
        if (!response || response.requestId !== id) {
          return;
        }
        if (response.kind === "progress") {
          options.onProgress?.({ stage: response.stage, progress: response.progress });
          return;
        }
        if (response.kind === "result") {
          finish(() => resolve(response));
          return;
        }
        finish(() => reject(safeWorkerError(response)));
      };

      worker.onerror = (): void => {
        finish(() => reject(new AiInferenceError(
          "runtime",
          "The AI inference worker stopped unexpectedly.",
        )));
      };

      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });

      worker.postMessage(
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
    });
  } finally {
    disposeDevelopImage(sourceImage);
  }
}
