export type AiModelId = "subject" | "sky";
export type AiModelDisclosureLink = "source" | "license";

export interface AiModelDisclosure {
  readonly id: AiModelId;
  readonly selector: AiModelId;
  readonly purpose: string;
  readonly bytes: number;
  readonly revision: string;
  readonly input: {
    readonly width: number;
    readonly height: number;
  };
  readonly sourceUrl: string;
  readonly license: {
    readonly name: "MIT";
    readonly url: string;
  };
  readonly offlineCacheBehavior: string;
}

export type AiModelState =
  | {
      status: "missing";
      model: AiModelDisclosure;
    }
  | {
      status: "downloading";
      model: AiModelDisclosure;
      receivedBytes: number;
      totalBytes: number;
    }
  | {
      status: "ready";
      model: AiModelDisclosure;
    }
  | {
      status: "error";
      model: AiModelDisclosure;
      message: string;
    };

export interface AiModelProgress {
  modelId: AiModelId;
  receivedBytes: number;
  totalBytes: number;
}

export type Unsubscribe = () => void;

export function isAiModelId(value: unknown): value is AiModelId {
  return value === "subject" || value === "sky";
}

export function parseAiModelId(value: unknown): AiModelId {
  if (!isAiModelId(value)) {
    throw new Error("Unknown AI model.");
  }
  return value;
}

export function isAiModelProgress(value: unknown): value is AiModelProgress {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("modelId" in value) || !("receivedBytes" in value) || !("totalBytes" in value)) {
    return false;
  }
  return (
    isAiModelId(value.modelId) &&
    typeof value.receivedBytes === "number" &&
    Number.isSafeInteger(value.receivedBytes) &&
    value.receivedBytes >= 0 &&
    typeof value.totalBytes === "number" &&
    Number.isSafeInteger(value.totalBytes) &&
    value.totalBytes > 0 &&
    value.receivedBytes <= value.totalBytes
  );
}
