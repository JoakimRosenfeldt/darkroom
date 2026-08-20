import type { AiModelId } from "@/lib/ai/types";
import type {
  MaskRasterAsset,
  SourceSignature,
} from "@/lib/develop/types";

export type AiInferenceBackend = "webgpu" | "wasm";

export type AiInferenceStage =
  | "preparing"
  | "loading-model"
  | "inference"
  | "encoding";

export interface PreparedAiImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: ArrayBuffer;
}

export type AiInferenceSourcePixels =
  | Uint8Array
  | Uint16Array
  | Uint8ClampedArray;

/** Original decoded pixels. The client transfers the backing buffer to the worker. */
export interface AiInferenceSourceImage {
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly orientation: number;
  readonly bits: number;
  readonly colors: number;
  readonly pixels: AiInferenceSourcePixels;
}

export interface AiInferenceWorkerRunRequest {
  readonly kind: "run";
  readonly requestId: string;
  readonly modelId: AiModelId;
  readonly image: AiInferenceSourceImage;
  readonly sourceSignature: SourceSignature;
  readonly backend: "auto" | "wasm";
}

export interface AiInferenceWorkerCancelRequest {
  readonly kind: "cancel";
  readonly requestId: string;
}

export type AiInferenceWorkerRequest =
  | AiInferenceWorkerRunRequest
  | AiInferenceWorkerCancelRequest;

export interface AiInferenceProgressMessage {
  readonly kind: "progress";
  readonly requestId: string;
  readonly stage: AiInferenceStage;
  readonly progress: number;
}

export interface AiInferenceResult {
  readonly kind: "result";
  readonly requestId: string;
  readonly backend: AiInferenceBackend;
  readonly fallbackReason?: string;
  readonly sourceSignature: SourceSignature;
  readonly asset: MaskRasterAsset;
  readonly component: {
    readonly kind: "ai";
    readonly selector: AiModelId;
    readonly model: {
      readonly id: AiModelId;
      readonly revision: string;
    };
    readonly source: SourceSignature;
    readonly inference: {
      readonly width: number;
      readonly height: number;
      readonly threshold: number;
    };
  };
}

export type AiInferenceErrorCode =
  | "cancelled"
  | "model-unavailable"
  | "protocol"
  | "inference"
  | "runtime";

export interface AiInferenceErrorMessage {
  readonly kind: "error";
  readonly requestId: string;
  readonly code: AiInferenceErrorCode;
  readonly message: string;
  readonly fallbackReason?: string;
}

export type AiInferenceWorkerResponse =
  | AiInferenceProgressMessage
  | AiInferenceResult
  | AiInferenceErrorMessage;

export function aiModelRevision(modelId: AiModelId): string {
  switch (modelId) {
    case "subject":
      return "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7";
    case "sky":
      return "dac255883ec5faf508561a47172096bfd8708db0";
  }
}
