import * as ort from "onnxruntime-web/webgpu";
import type { Tensor } from "onnxruntime-web";
import { isAiModelId } from "@/lib/ai/types";
import { prepareAiInferenceImage } from "@/lib/ai/image-preparation";
import type {
  AiInferenceSourceImage,
  AiInferenceErrorCode,
  AiInferenceStage,
  AiInferenceWorkerRequest,
  AiInferenceWorkerResponse,
  AiInferenceWorkerRunRequest,
  PreparedAiImage,
} from "@/lib/ai/worker-types";
import { aiModelRevision } from "@/lib/ai/worker-types";

const IMAGE_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGE_STD = [0.229, 0.224, 0.225] as const;
const SUBJECT_INPUT_SIZE = 512;
const SKY_INPUT_SIZE = 384;
const PNG_CHUNK_LIMIT = 65_535;

class CancelledInferenceError extends Error {}

class SafeWorkerError extends Error {
  readonly code: AiInferenceErrorCode;
  readonly fallbackReason?: string;

  constructor(code: AiInferenceErrorCode, message: string, fallbackReason?: string) {
    super(message);
    this.name = "SafeWorkerError";
    this.code = code;
    this.fallbackReason = fallbackReason;
  }
}

const cancelledRequests = new Set<string>();

function post(message: AiInferenceWorkerResponse): void {
  self.postMessage(message);
}

function checkCancelled(requestId: string): void {
  if (cancelledRequests.has(requestId)) {
    throw new CancelledInferenceError("AI inference was cancelled.");
  }
}

function report(
  requestId: string,
  stage: AiInferenceStage,
  progress: number,
): void {
  post({
    kind: "progress",
    requestId,
    stage,
    progress: Math.max(0, Math.min(1, progress)),
  });
}

function modelUri(modelId: AiInferenceWorkerRunRequest["modelId"]): string {
  switch (modelId) {
    case "subject":
      return "darkroom-model://model/subject";
    case "sky":
      return "darkroom-model://model/sky";
  }
}

function inputSpec(modelId: AiInferenceWorkerRunRequest["modelId"]): {
  readonly inputName: string;
  readonly outputName: string;
  readonly size: number;
  readonly classes: number;
} {
  switch (modelId) {
    case "subject":
      return {
        inputName: "input_image",
        outputName: "output_image",
        size: SUBJECT_INPUT_SIZE,
        classes: 1,
      };
    case "sky":
      return {
        inputName: "input",
        outputName: "output",
        size: SKY_INPUT_SIZE,
        classes: 4,
      };
  }
}

function isSourcePixels(
  pixels: unknown,
): pixels is AiInferenceSourceImage["pixels"] {
  return pixels instanceof Uint8Array ||
    pixels instanceof Uint16Array ||
    pixels instanceof Uint8ClampedArray;
}

function pixelsMatchBitDepth(
  pixels: AiInferenceSourceImage["pixels"],
  bits: number,
): boolean {
  return bits === 16
    ? pixels instanceof Uint16Array
    : pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray;
}

function assertSourceImage(image: AiInferenceSourceImage): void {
  if (
    !Number.isInteger(image.width) ||
    image.width < 1 ||
    image.width > 65_535 ||
    !Number.isInteger(image.height) ||
    image.height < 1 ||
    image.height > 65_535 ||
    !Number.isInteger(image.sourceWidth) ||
    image.sourceWidth < 1 ||
    image.sourceWidth > 65_535 ||
    !Number.isInteger(image.sourceHeight) ||
    image.sourceHeight < 1 ||
    image.sourceHeight > 65_535 ||
    !Number.isInteger(image.orientation) ||
    image.orientation < 1 ||
    image.orientation > 8 ||
    !Number.isInteger(image.colors) ||
    image.colors < 3 ||
    image.colors > 4 ||
    (image.bits !== 8 && image.bits !== 16) ||
    !isSourcePixels(image.pixels) ||
    !pixelsMatchBitDepth(image.pixels, image.bits)
  ) {
    throw new SafeWorkerError("protocol", "AI source dimensions are unsupported.");
  }
  const expectedLength = image.sourceWidth * image.sourceHeight * image.colors;
  if (!Number.isSafeInteger(expectedLength) || image.pixels.length !== expectedLength) {
    throw new SafeWorkerError("protocol", "AI source pixels are invalid.");
  }
}

function buildInputTensor(
  image: PreparedAiImage,
  modelId: AiInferenceWorkerRunRequest["modelId"],
): ort.Tensor {
  const spec = inputSpec(modelId);
  const source = new Uint8Array(image.rgb);
  const pixels = spec.size * spec.size;
  const data = new Float32Array(pixels * 3);

  for (let y = 0; y < spec.size; y += 1) {
    const sourceY = Math.max(0, Math.min(image.height - 1, (y + 0.5) * image.height / spec.size - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < spec.size; x += 1) {
      const sourceX = Math.max(0, Math.min(image.width - 1, (x + 0.5) * image.width / spec.size - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const topLeft = (y0 * image.width + x0) * 3;
      const topRight = (y0 * image.width + x1) * 3;
      const bottomLeft = (y1 * image.width + x0) * 3;
      const bottomRight = (y1 * image.width + x1) * 3;
      const pixel = y * spec.size + x;

      for (let channel = 0; channel < 3; channel += 1) {
        const top = source[topLeft + channel] * (1 - xWeight) +
          source[topRight + channel] * xWeight;
        const bottom = source[bottomLeft + channel] * (1 - xWeight) +
          source[bottomRight + channel] * xWeight;
        const value = (top * (1 - yWeight) + bottom * yWeight) / 255;
        data[channel * pixels + pixel] = (value - IMAGE_MEAN[channel]) / IMAGE_STD[channel];
      }
    }
  }

  return new ort.Tensor("float32", data, [1, 3, spec.size, spec.size]);
}

function isFloat32Data(data: Tensor["data"]): data is Float32Array {
  return data instanceof Float32Array;
}

async function outputData(
  output: Tensor | undefined,
  expectedClasses: number,
): Promise<{ data: Float32Array; height: number; width: number }> {
  if (!output || output.dims.length !== 4) {
    throw new SafeWorkerError("inference", "The AI model returned an unsupported output.");
  }
  if (
    output.dims[0] !== 1 ||
    output.dims[1] !== expectedClasses ||
    !Number.isInteger(output.dims[2]) ||
    !Number.isInteger(output.dims[3]) ||
    output.dims[2] < 1 ||
    output.dims[3] < 1
  ) {
    throw new SafeWorkerError("inference", "The AI model returned unexpected output dimensions.");
  }
  const data = await output.getData(true);
  if (!isFloat32Data(data)) {
    throw new SafeWorkerError("inference", "The AI model returned unsupported output data.");
  }
  return { data, height: output.dims[2], width: output.dims[3] };
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exponent = Math.exp(-value);
    return 1 / (1 + exponent);
  }
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function resizedAlpha(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  classes: number,
  subject: boolean,
): Uint8Array {
  const target = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.max(0, Math.min(sourceHeight - 1, (y + 0.5) * sourceHeight / targetHeight - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.max(0, Math.min(sourceWidth - 1, (x + 0.5) * sourceWidth / targetWidth - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const valueAt = (sampleX: number, sampleY: number): number => {
        const pixel = sampleY * sourceWidth + sampleX;
        if (subject) {
          return sigmoid(source[pixel]);
        }
        let bestClass = 0;
        let bestValue = source[pixel];
        for (let classIndex = 1; classIndex < classes; classIndex += 1) {
          const classValue = source[classIndex * sourceWidth * sourceHeight + pixel];
          if (classValue > bestValue) {
            bestClass = classIndex;
            bestValue = classValue;
          }
        }
        return bestClass === 1 ? 1 : 0;
      };
      const top = valueAt(x0, y0) * (1 - xWeight) + valueAt(x1, y0) * xWeight;
      const bottom = valueAt(x0, y1) * (1 - xWeight) + valueAt(x1, y1) * xWeight;
      target[y * targetWidth + x] = Math.round((top * (1 - yWeight) + bottom * yWeight) * 255);
    }
  }
  return target;
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, false);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const bytes = new Uint8Array(12 + data.byteLength);
  const view = new DataView(bytes.buffer);
  writeUint32(view, 0, data.byteLength);
  bytes.set(typeBytes, 4);
  bytes.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.byteLength + data.byteLength);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.byteLength);
  writeUint32(view, 8 + data.byteLength, crc32(crcInput));
  return bytes;
}

function encodePng(width: number, height: number, alpha: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    raw.set(alpha.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const blocks = Math.ceil(raw.byteLength / PNG_CHUNK_LIMIT);
  const compressed = new Uint8Array(2 + raw.byteLength + blocks * 5 + 4);
  compressed[0] = 0x78;
  compressed[1] = 0x01;
  let compressedOffset = 2;
  let rawOffset = 0;
  for (let block = 0; block < blocks; block += 1) {
    const length = Math.min(PNG_CHUNK_LIMIT, raw.byteLength - rawOffset);
    compressed[compressedOffset] = block === blocks - 1 ? 1 : 0;
    compressedOffset += 1;
    compressed[compressedOffset] = length & 0xff;
    compressed[compressedOffset + 1] = length >>> 8;
    compressed[compressedOffset + 2] = (~length) & 0xff;
    compressed[compressedOffset + 3] = (~length >>> 8) & 0xff;
    compressedOffset += 4;
    compressed.set(raw.subarray(rawOffset, rawOffset + length), compressedOffset);
    compressedOffset += length;
    rawOffset += length;
  }
  const compressedView = new DataView(compressed.buffer);
  writeUint32(compressedView, compressedOffset, adler32(raw));

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  writeUint32(headerView, 0, width);
  writeUint32(headerView, 4, height);
  header[8] = 8;
  header[9] = 0;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const idat = pngChunk("IDAT", compressed);
  const ihdr = pngChunk("IHDR", header);
  const iend = pngChunk("IEND", new Uint8Array(0));
  const output = new Uint8Array(8 + ihdr.byteLength + idat.byteLength + iend.byteLength);
  output.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let outputOffset = 8;
  output.set(ihdr, outputOffset);
  outputOffset += ihdr.byteLength;
  output.set(idat, outputOffset);
  outputOffset += idat.byteLength;
  output.set(iend, outputOffset);
  return output;
}

function base64(bytes: Uint8Array): string {
  let value = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function runBackend(
  request: AiInferenceWorkerRunRequest,
  image: PreparedAiImage,
  backend: "webgpu" | "wasm",
): Promise<Uint8Array> {
  const spec = inputSpec(request.modelId);
  const model = modelUri(request.modelId);
  let session: ort.InferenceSession;
  try {
    session = await ort.InferenceSession.create(model, {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
    });
  } catch {
    throw new SafeWorkerError(
      "model-unavailable",
      safeMessage("model-unavailable"),
    );
  }
  try {
    checkCancelled(request.requestId);
    const input = buildInputTensor(image, request.modelId);
    try {
      const outputs = await session.run(
        { [spec.inputName]: input },
        [spec.outputName],
      );
      checkCancelled(request.requestId);
      const output = outputs[spec.outputName];
      try {
        const parsed = await outputData(output, spec.classes);
        return resizedAlpha(
          parsed.data,
          parsed.width,
          parsed.height,
          image.width,
          image.height,
          spec.classes,
          request.modelId === "subject",
        );
      } finally {
        output?.dispose();
      }
    } finally {
      input.dispose();
    }
  } finally {
    await session.release();
  }
}

function safeMessage(code: AiInferenceErrorCode): string {
  switch (code) {
    case "model-unavailable":
      return "The local AI model is unavailable. Download it first, then try again.";
    case "protocol":
      return "The local AI model service returned an invalid response.";
    case "inference":
      return "The AI model could not produce a mask.";
    case "runtime":
      return "The AI runtime is unavailable on this device.";
    case "cancelled":
      return "AI inference was cancelled.";
  }
}

function toSafeError(error: unknown, fallbackReason?: string): SafeWorkerError {
  if (error instanceof CancelledInferenceError) {
    return new SafeWorkerError("cancelled", safeMessage("cancelled"), fallbackReason);
  }
  if (error instanceof SafeWorkerError) {
    return new SafeWorkerError(error.code, safeMessage(error.code), fallbackReason ?? error.fallbackReason);
  }
  return new SafeWorkerError("inference", safeMessage("inference"), fallbackReason);
}

async function runRequest(request: AiInferenceWorkerRunRequest): Promise<void> {
  assertSourceImage(request.image);
  report(request.requestId, "preparing", 0.05);
  const image = prepareAiInferenceImage(
    request.image,
    () => checkCancelled(request.requestId),
  );
  checkCancelled(request.requestId);

  let alpha: Uint8Array;
  let backend: "webgpu" | "wasm" = "wasm";
  let fallbackReason: string | undefined;
  if (request.backend === "wasm") {
    report(request.requestId, "loading-model", 0.2);
    report(request.requestId, "inference", 0.45);
    alpha = await runBackend(request, image, "wasm");
    backend = "wasm";
  } else {
    try {
      report(request.requestId, "loading-model", 0.2);
      report(request.requestId, "inference", 0.45);
      alpha = await runBackend(request, image, "webgpu");
      backend = "webgpu";
    } catch (error) {
      checkCancelled(request.requestId);
      fallbackReason = "WebGPU inference was unavailable; used the CPU fallback.";
      report(request.requestId, "loading-model", 0.3);
      report(request.requestId, "inference", 0.5);
      try {
        alpha = await runBackend(request, image, "wasm");
        backend = "wasm";
      } catch (fallbackError) {
        const safe = toSafeError(fallbackError, fallbackReason);
        if (error instanceof SafeWorkerError && error.code === "protocol") {
          throw safe;
        }
        throw safe;
      }
    }
  }

  checkCancelled(request.requestId);
  report(request.requestId, "encoding", 0.8);
  const png = encodePng(image.width, image.height, alpha);
  const digest = await sha256(png);
  checkCancelled(request.requestId);
  const asset = {
    id: digest,
    sha256: digest,
    mimeType: "image/png" as const,
    width: image.width,
    height: image.height,
    byteLength: png.byteLength,
    pngBase64: base64(png),
  };
  post({
    kind: "result",
    requestId: request.requestId,
    backend,
    ...(fallbackReason ? { fallbackReason } : {}),
    sourceSignature: request.sourceSignature,
    asset,
    component: {
      kind: "ai",
      selector: request.modelId,
      model: { id: request.modelId, revision: aiModelRevision(request.modelId) },
      source: request.sourceSignature,
      inference: {
        width: image.width,
        height: image.height,
        threshold: 0,
      },
    },
  });
}

function isRunRequest(value: unknown): value is AiInferenceWorkerRunRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("kind" in value) || value.kind !== "run") {
    return false;
  }
  if (!("requestId" in value) || typeof value.requestId !== "string" || value.requestId.length === 0) {
    return false;
  }
  if (!("modelId" in value) || !isAiModelId(value.modelId)) {
    return false;
  }
  if (!("backend" in value) || (value.backend !== "auto" && value.backend !== "wasm")) {
    return false;
  }
  if (!("image" in value) || typeof value.image !== "object" || value.image === null) {
    return false;
  }
  return "width" in value.image &&
    "height" in value.image &&
    "sourceWidth" in value.image &&
    "sourceHeight" in value.image &&
    "orientation" in value.image &&
    "bits" in value.image &&
    "colors" in value.image &&
    "pixels" in value.image;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

self.onmessage = (event: MessageEvent<AiInferenceWorkerRequest>): void => {
  const request: unknown = event.data;
  if (
    isRecord(request) &&
    request.kind === "cancel" &&
    typeof request.requestId === "string"
  ) {
    cancelledRequests.add(request.requestId);
    return;
  }
  if (!isRunRequest(request)) {
    post({
      kind: "error",
      requestId: isRecord(request) && typeof request.requestId === "string"
        ? request.requestId
        : "unknown",
      code: "protocol",
      message: safeMessage("protocol"),
    });
    return;
  }
  void runRequest(request)
    .catch((error: unknown) => {
      const safe = toSafeError(error);
      post({
        kind: "error",
        requestId: request.requestId,
        code: safe.code,
        message: safe.message,
        ...(safe.fallbackReason ? { fallbackReason: safe.fallbackReason } : {}),
      });
    })
    .finally(() => {
      cancelledRequests.delete(request.requestId);
    });
};

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = "error";
