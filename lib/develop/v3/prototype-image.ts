import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { prepareAiInferenceImage } from "@/lib/ai/image-preparation";
import type { DevelopDocumentV3 } from "./document";
import { canonicalV3DocumentHashInput } from "./document";
import {
  parseDevelopDocumentRevision,
  type DevelopDocumentRevision,
} from "./jobs";
import type {
  PrototypeImage,
  PrototypeOperation,
} from "./prototype-operations";

const ONE_MEGAPIXEL = 1_048_576;

function imageLimit(operation: PrototypeOperation): {
  readonly maximumEdge: number;
  readonly maximumPixels: number;
} {
  switch (operation) {
    case "depth":
      return { maximumEdge: 2_048, maximumPixels: 4_194_304 };
    case "denoise":
    case "raw-details":
    case "generative-remove":
      return { maximumEdge: 2_048, maximumPixels: ONE_MEGAPIXEL };
    case "super-resolution":
      return { maximumEdge: 1_024, maximumPixels: ONE_MEGAPIXEL };
    default: {
      const _exhaustive: never = operation;
      return _exhaustive;
    }
  }
}

function boundedDimensions(
  width: number,
  height: number,
  operation: PrototypeOperation,
): { readonly width: number; readonly height: number } {
  const limit = imageLimit(operation);
  const scale = Math.min(
    1,
    limit.maximumEdge / Math.max(width, height),
    Math.sqrt(limit.maximumPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function resizeRgb(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Uint8Array {
  if (sourceWidth === width && sourceHeight === height) return source;

  const output = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(
      sourceHeight - 1,
      Math.floor((y + 0.5) * sourceHeight / height),
    );
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        sourceWidth - 1,
        Math.floor((x + 0.5) * sourceWidth / width),
      );
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 3;
      const outputOffset = (y * width + x) * 3;
      output[outputOffset] = source[sourceOffset];
      output[outputOffset + 1] = source[sourceOffset + 1];
      output[outputOffset + 2] = source[sourceOffset + 2];
    }
  }
  return output;
}

export async function preparePrototypeImage(
  image: DevelopImage,
  operation: PrototypeOperation,
): Promise<PrototypeImage> {
  const prepared = prepareAiInferenceImage({
    width: image.width,
    height: image.height,
    sourceWidth: image.sourceWidth,
    sourceHeight: image.sourceHeight,
    orientation: image.orientation,
    bits: image.bits,
    colors: image.colors,
    pixels: image.rgb,
  }, () => undefined);
  const dimensions = boundedDimensions(prepared.width, prepared.height, operation);
  const pixels = resizeRgb(
    new Uint8Array(prepared.rgb),
    prepared.width,
    prepared.height,
    dimensions.width,
    dimensions.height,
  );
  return { dimensions, channels: 3, pixels };
}

function hexadecimalDigest(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

export async function developDocumentRevision(
  document: DevelopDocumentV3,
): Promise<DevelopDocumentRevision> {
  const input = new TextEncoder().encode(canonicalV3DocumentHashInput(document));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return parseDevelopDocumentRevision({
    kind: "develop-document-revision",
    value: hexadecimalDigest(digest),
  });
}
