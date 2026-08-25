import type { PixelDimensions } from "../process";

export const PROTOTYPE_OPERATION_LIMITS = {
  maximumEdge: 2_048,
  maximumPixels: 4_194_304,
  maximumDenoiseRadius: 3,
  maximumRemoveRadius: 64,
} as const;

export const PROTOTYPE_ALGORITHMS = {
  depth: { id: "builtin-prototype-depth-v1", revision: "1" },
  denoise: { id: "builtin-prototype-denoise-v1", revision: "1" },
  rawDetails: { id: "builtin-prototype-raw-details-v1", revision: "1" },
  superResolution: {
    id: "builtin-prototype-super-resolution-v1",
    revision: "1",
  },
  generativeRemove: { id: "local-mock-remove-v1", revision: "1" },
} as const;

export type PrototypeOperation =
  | "depth"
  | "denoise"
  | "raw-details"
  | "super-resolution"
  | "generative-remove";

export interface PrototypeImage {
  readonly dimensions: PixelDimensions;
  readonly channels: 3 | 4;
  readonly pixels: Uint8Array;
}

export interface PrototypeDenoiseParameters {
  readonly strength: number;
}

export interface PrototypeRawDetailsParameters {
  readonly amount: number;
}

export interface PrototypeRemoveParameters {
  readonly selection: Uint8Array;
  readonly seed: number;
  readonly searchRadius: number;
}

export type PrototypeParameterHashInput =
  | { readonly operation: "depth"; readonly algorithmRevision: "1" }
  | {
      readonly operation: "denoise";
      readonly algorithmRevision: "1";
      readonly strength: number;
    }
  | {
      readonly operation: "raw-details";
      readonly algorithmRevision: "1";
      readonly amount: number;
    }
  | {
      readonly operation: "super-resolution";
      readonly algorithmRevision: "1";
      readonly scale: 2;
    }
  | {
      readonly operation: "generative-remove";
      readonly algorithmRevision: "1";
      readonly seed: number;
      readonly searchRadius: number;
      readonly selection: Uint8Array;
    };

export type PrototypeProcessorResult<T> =
  | { readonly kind: "completed"; readonly output: T }
  | { readonly kind: "cancelled" };

export interface PrototypeDepthOutput {
  readonly kind: "depth-map";
  readonly dimensions: PixelDimensions;
  readonly values: Float32Array;
  readonly algorithm: typeof PROTOTYPE_ALGORITHMS.depth;
  readonly parameterHashInput: Extract<
    PrototypeParameterHashInput,
    { readonly operation: "depth" }
  >;
}

export type PrototypeImageOutput =
  | {
      readonly kind: "image";
      readonly image: PrototypeImage;
      readonly algorithm: typeof PROTOTYPE_ALGORITHMS.denoise;
      readonly parameterHashInput: Extract<
        PrototypeParameterHashInput,
        { readonly operation: "denoise" }
      >;
    }
  | {
      readonly kind: "image";
      readonly image: PrototypeImage;
      readonly algorithm: typeof PROTOTYPE_ALGORITHMS.rawDetails;
      readonly parameterHashInput: Extract<
        PrototypeParameterHashInput,
        { readonly operation: "raw-details" }
      >;
    }
  | {
      readonly kind: "image";
      readonly image: PrototypeImage;
      readonly algorithm: typeof PROTOTYPE_ALGORITHMS.superResolution;
      readonly parameterHashInput: Extract<
        PrototypeParameterHashInput,
        { readonly operation: "super-resolution" }
      >;
    };

export interface PrototypeRemoveOutput {
  readonly kind: "alternatives";
  readonly alternatives: readonly [PrototypeImage, PrototypeImage];
  readonly algorithm: typeof PROTOTYPE_ALGORITHMS.generativeRemove;
  readonly parameterHashInput: Extract<
    PrototypeParameterHashInput,
    { readonly operation: "generative-remove" }
  >;
}

export type CancellationProbe = () => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseDimensions(value: unknown): PixelDimensions {
  if (!isRecord(value)) throw new Error("Prototype image dimensions are invalid.");
  const width = boundedInteger(
    value.width,
    "Prototype image width",
    1,
    PROTOTYPE_OPERATION_LIMITS.maximumEdge,
  );
  const height = boundedInteger(
    value.height,
    "Prototype image height",
    1,
    PROTOTYPE_OPERATION_LIMITS.maximumEdge,
  );
  if (width * height > PROTOTYPE_OPERATION_LIMITS.maximumPixels) {
    throw new Error("Prototype image pixel count exceeds the limit.");
  }
  return { width, height };
}

function copiedBytes(value: unknown, expectedLength: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new Error(`${label} is invalid.`);
  }
  return Uint8Array.from(value);
}

function validateImageForProcessing(image: PrototypeImage): void {
  const { width, height } = image.dimensions;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > PROTOTYPE_OPERATION_LIMITS.maximumEdge ||
    height > PROTOTYPE_OPERATION_LIMITS.maximumEdge ||
    width * height > PROTOTYPE_OPERATION_LIMITS.maximumPixels ||
    (image.channels !== 3 && image.channels !== 4) ||
    image.pixels.length !== width * height * image.channels
  ) {
    throw new Error("Prototype image is outside the processing limits.");
  }
}

function validateParameter(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside the processing limits.`);
  }
}

export function parsePrototypeImage(value: unknown): PrototypeImage {
  if (!isRecord(value)) throw new Error("Prototype image is invalid.");
  const dimensions = parseDimensions(value.dimensions);
  const channels = boundedInteger(value.channels, "Prototype image channels", 3, 4);
  if (channels !== 3 && channels !== 4) {
    throw new Error("Prototype image must use RGB or RGBA pixels.");
  }
  return {
    dimensions,
    channels,
    pixels: copiedBytes(
      value.pixels,
      dimensions.width * dimensions.height * channels,
      "Prototype image pixels",
    ),
  };
}

export function parsePrototypeDenoiseParameters(
  value: unknown,
): PrototypeDenoiseParameters {
  if (!isRecord(value)) throw new Error("Prototype denoise parameters are invalid.");
  return { strength: boundedNumber(value.strength, "Denoise strength", 0, 100) };
}

export function parsePrototypeRawDetailsParameters(
  value: unknown,
): PrototypeRawDetailsParameters {
  if (!isRecord(value)) {
    throw new Error("Prototype Raw Details parameters are invalid.");
  }
  return { amount: boundedNumber(value.amount, "Raw Details amount", 0, 100) };
}

export function parsePrototypeRemoveParameters(input: {
  readonly value: unknown;
  readonly dimensions: PixelDimensions;
}): PrototypeRemoveParameters {
  if (!isRecord(input.value)) {
    throw new Error("Prototype Generative Remove parameters are invalid.");
  }
  const pixelCount = input.dimensions.width * input.dimensions.height;
  return {
    selection: copiedBytes(
      input.value.selection,
      pixelCount,
      "Generative Remove selection",
    ),
    seed: boundedInteger(
      input.value.seed,
      "Generative Remove seed",
      0,
      0xffff_ffff,
    ),
    searchRadius: boundedInteger(
      input.value.searchRadius,
      "Generative Remove search radius",
      1,
      PROTOTYPE_OPERATION_LIMITS.maximumRemoveRadius,
    ),
  };
}

function cancelled(probe: CancellationProbe, row: number): boolean {
  return row % 8 === 0 && probe();
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function pixelLuminance(pixels: Uint8Array, offset: number): number {
  return (
    0.2126 * pixels[offset] +
    0.7152 * pixels[offset + 1] +
    0.0722 * pixels[offset + 2]
  ) / 255;
}

export function createPrototypeDepthMap(input: {
  readonly image: PrototypeImage;
  readonly isCancelled: CancellationProbe;
}): PrototypeProcessorResult<PrototypeDepthOutput> {
  validateImageForProcessing(input.image);
  const { width, height } = input.image.dimensions;
  const { channels, pixels } = input.image;
  const luminance = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    if (cancelled(input.isCancelled, y)) return { kind: "cancelled" };
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      luminance[index] = pixelLuminance(pixels, index * channels);
    }
  }
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    if (cancelled(input.isCancelled, y)) return { kind: "cancelled" };
    const vertical = height === 1 ? 0.5 : 1 - y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const left = luminance[y * width + Math.max(0, x - 1)];
      const right = luminance[y * width + Math.min(width - 1, x + 1)];
      const above = luminance[Math.max(0, y - 1) * width + x];
      const below = luminance[Math.min(height - 1, y + 1) * width + x];
      const edge = Math.min(1, Math.hypot(right - left, below - above));
      values[index] = Math.max(
        0,
        Math.min(1, 0.5 * vertical + 0.35 * (1 - luminance[index]) + 0.15 * edge),
      );
    }
  }
  return {
    kind: "completed",
    output: {
      kind: "depth-map",
      dimensions: { width, height },
      values,
      algorithm: PROTOTYPE_ALGORITHMS.depth,
      parameterHashInput: { operation: "depth", algorithmRevision: "1" },
    },
  };
}

export function denoisePrototypeImage(input: {
  readonly image: PrototypeImage;
  readonly parameters: PrototypeDenoiseParameters;
  readonly isCancelled: CancellationProbe;
}): PrototypeProcessorResult<PrototypeImageOutput> {
  validateImageForProcessing(input.image);
  validateParameter(input.parameters.strength, "Denoise strength", 0, 100);
  const { width, height } = input.image.dimensions;
  const { channels, pixels } = input.image;
  const strength = input.parameters.strength;
  const radius = Math.max(1, Math.ceil(strength / 34));
  const spatialSigma = 0.7 + strength / 50;
  const rangeSigma = 10 + strength * 0.8;
  const output = Uint8Array.from(pixels);
  for (let y = 0; y < height; y += 1) {
    if (cancelled(input.isCancelled, y)) return { kind: "cancelled" };
    for (let x = 0; x < width; x += 1) {
      const center = (y * width + x) * channels;
      for (let channel = 0; channel < 3; channel += 1) {
        let weighted = 0;
        let weightTotal = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const sampleY = Math.max(0, Math.min(height - 1, y + dy));
          for (let dx = -radius; dx <= radius; dx += 1) {
            const sampleX = Math.max(0, Math.min(width - 1, x + dx));
            const sample = (sampleY * width + sampleX) * channels;
            const distance = dx * dx + dy * dy;
            const difference = pixels[sample + channel] - pixels[center + channel];
            const weight = Math.exp(-distance / (2 * spatialSigma * spatialSigma)) *
              Math.exp(-(difference * difference) / (2 * rangeSigma * rangeSigma));
            weighted += pixels[sample + channel] * weight;
            weightTotal += weight;
          }
        }
        const filtered = weighted / Math.max(Number.EPSILON, weightTotal);
        output[center + channel] = clampByte(
          pixels[center + channel] +
            (filtered - pixels[center + channel]) * (strength / 100),
        );
      }
    }
  }
  return {
    kind: "completed",
    output: {
      kind: "image",
      image: {
        dimensions: { ...input.image.dimensions },
        channels: input.image.channels,
        pixels: output,
      },
      algorithm: PROTOTYPE_ALGORITHMS.denoise,
      parameterHashInput: {
        operation: "denoise",
        algorithmRevision: "1",
        strength,
      },
    },
  };
}

export function enhancePrototypeRawDetails(input: {
  readonly image: PrototypeImage;
  readonly parameters: PrototypeRawDetailsParameters;
  readonly isCancelled: CancellationProbe;
}): PrototypeProcessorResult<PrototypeImageOutput> {
  validateImageForProcessing(input.image);
  validateParameter(input.parameters.amount, "Raw Details amount", 0, 100);
  const { width, height } = input.image.dimensions;
  const { channels, pixels } = input.image;
  const amount = input.parameters.amount;
  const output = Uint8Array.from(pixels);
  for (let y = 0; y < height; y += 1) {
    if (cancelled(input.isCancelled, y)) return { kind: "cancelled" };
    for (let x = 0; x < width; x += 1) {
      const center = (y * width + x) * channels;
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const sampleY = Math.max(0, Math.min(height - 1, y + dy));
          for (let dx = -1; dx <= 1; dx += 1) {
            const sampleX = Math.max(0, Math.min(width - 1, x + dx));
            sum += pixels[(sampleY * width + sampleX) * channels + channel];
          }
        }
        const highPass = pixels[center + channel] - sum / 9;
        output[center + channel] = clampByte(
          pixels[center + channel] + highPass * (amount / 80),
        );
      }
    }
  }
  return {
    kind: "completed",
    output: {
      kind: "image",
      image: {
        dimensions: { ...input.image.dimensions },
        channels: input.image.channels,
        pixels: output,
      },
      algorithm: PROTOTYPE_ALGORITHMS.rawDetails,
      parameterHashInput: {
        operation: "raw-details",
        algorithmRevision: "1",
        amount,
      },
    },
  };
}

function cubicWeight(value: number): number {
  const absolute = Math.abs(value);
  if (absolute <= 1) return 1.5 * absolute ** 3 - 2.5 * absolute ** 2 + 1;
  if (absolute < 2) return -0.5 * absolute ** 3 + 2.5 * absolute ** 2 - 4 * absolute + 2;
  return 0;
}

function bicubicSample(
  image: PrototypeImage,
  sourceX: number,
  sourceY: number,
  channel: number,
): number {
  const { width, height } = image.dimensions;
  const xBase = Math.floor(sourceX);
  const yBase = Math.floor(sourceY);
  let value = 0;
  let total = 0;
  for (let dy = -1; dy <= 2; dy += 1) {
    const y = Math.max(0, Math.min(height - 1, yBase + dy));
    const yWeight = cubicWeight(sourceY - (yBase + dy));
    for (let dx = -1; dx <= 2; dx += 1) {
      const x = Math.max(0, Math.min(width - 1, xBase + dx));
      const weight = yWeight * cubicWeight(sourceX - (xBase + dx));
      value += image.pixels[(y * width + x) * image.channels + channel] * weight;
      total += weight;
    }
  }
  return value / Math.max(Number.EPSILON, total);
}

export function superResolvePrototypeImage(input: {
  readonly image: PrototypeImage;
  readonly isCancelled: CancellationProbe;
}): PrototypeProcessorResult<PrototypeImageOutput> {
  validateImageForProcessing(input.image);
  const width = input.image.dimensions.width * 2;
  const height = input.image.dimensions.height * 2;
  if (
    width > PROTOTYPE_OPERATION_LIMITS.maximumEdge ||
    height > PROTOTYPE_OPERATION_LIMITS.maximumEdge ||
    width * height > PROTOTYPE_OPERATION_LIMITS.maximumPixels
  ) {
    throw new Error("Prototype Super Resolution output exceeds the image limit.");
  }
  const { channels } = input.image;
  const scaled = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    if (cancelled(input.isCancelled, y)) return { kind: "cancelled" };
    const sourceY = (y + 0.5) / 2 - 0.5;
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) / 2 - 0.5;
      const offset = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        scaled[offset + channel] = clampByte(
          bicubicSample(input.image, sourceX, sourceY, channel),
        );
      }
    }
  }
  const sharpened = Uint8Array.from(scaled);
  for (let y = 0; y < height; y += 1) {
    if (cancelled(input.isCancelled, y)) return { kind: "cancelled" };
    for (let x = 0; x < width; x += 1) {
      const center = (y * width + x) * channels;
      for (let channel = 0; channel < 3; channel += 1) {
        const left = (y * width + Math.max(0, x - 1)) * channels + channel;
        const right = (y * width + Math.min(width - 1, x + 1)) * channels + channel;
        const above = (Math.max(0, y - 1) * width + x) * channels + channel;
        const below = (Math.min(height - 1, y + 1) * width + x) * channels + channel;
        const blur = (scaled[left] + scaled[right] + scaled[above] + scaled[below]) / 4;
        sharpened[center + channel] = clampByte(
          scaled[center + channel] + 0.18 * (scaled[center + channel] - blur),
        );
      }
    }
  }
  return {
    kind: "completed",
    output: {
      kind: "image",
      image: { dimensions: { width, height }, channels, pixels: sharpened },
      algorithm: PROTOTYPE_ALGORITHMS.superResolution,
      parameterHashInput: {
        operation: "super-resolution",
        algorithmRevision: "1",
        scale: 2,
      },
    },
  };
}

function nextRandom(state: number): number {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function fillRemoveAlternative(input: {
  readonly image: PrototypeImage;
  readonly parameters: PrototypeRemoveParameters;
  readonly seed: number;
  readonly isCancelled: CancellationProbe;
}): PrototypeProcessorResult<PrototypeImage> {
  const { width, height } = input.image.dimensions;
  const { channels, pixels } = input.image;
  const output = Uint8Array.from(pixels);
  let random = input.seed || 0x9e37_79b9;
  for (let y = 0; y < height; y += 1) {
    if (cancelled(input.isCancelled, y)) return { kind: "cancelled" };
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const alpha = input.parameters.selection[pixelIndex] / 255;
      if (alpha === 0) continue;
      random = nextRandom(random + pixelIndex);
      const phase = (random / 0x1_0000_0000) * Math.PI * 2;
      let sampleIndex = pixelIndex;
      for (let radius = 1; radius <= input.parameters.searchRadius; radius += 1) {
        const angle = phase + radius * 2.399963229728653;
        const sampleX = Math.max(
          0,
          Math.min(width - 1, Math.round(x + Math.cos(angle) * radius)),
        );
        const sampleY = Math.max(
          0,
          Math.min(height - 1, Math.round(y + Math.sin(angle) * radius)),
        );
        const candidate = sampleY * width + sampleX;
        if (input.parameters.selection[candidate] === 0) {
          sampleIndex = candidate;
          break;
        }
      }
      const targetOffset = pixelIndex * channels;
      const sampleOffset = sampleIndex * channels;
      for (let channel = 0; channel < 3; channel += 1) {
        output[targetOffset + channel] = clampByte(
          pixels[targetOffset + channel] * (1 - alpha) +
            pixels[sampleOffset + channel] * alpha,
        );
      }
    }
  }
  return {
    kind: "completed",
    output: {
      dimensions: { width, height },
      channels,
      pixels: output,
    },
  };
}

export function generativeRemovePrototype(input: {
  readonly image: PrototypeImage;
  readonly parameters: PrototypeRemoveParameters;
  readonly isCancelled: CancellationProbe;
}): PrototypeProcessorResult<PrototypeRemoveOutput> {
  validateImageForProcessing(input.image);
  if (input.parameters.selection.length !== input.image.dimensions.width * input.image.dimensions.height) {
    throw new Error("Generative Remove selection is outside the processing limits.");
  }
  validateParameter(input.parameters.seed, "Generative Remove seed", 0, 0xffff_ffff);
  if (!Number.isSafeInteger(input.parameters.seed)) {
    throw new Error("Generative Remove seed is outside the processing limits.");
  }
  validateParameter(
    input.parameters.searchRadius,
    "Generative Remove search radius",
    1,
    PROTOTYPE_OPERATION_LIMITS.maximumRemoveRadius,
  );
  if (!Number.isSafeInteger(input.parameters.searchRadius)) {
    throw new Error("Generative Remove search radius is outside the processing limits.");
  }
  const first = fillRemoveAlternative({
    ...input,
    seed: input.parameters.seed,
  });
  if (first.kind === "cancelled") return first;
  const second = fillRemoveAlternative({
    ...input,
    seed: nextRandom(input.parameters.seed ^ 0xa5a5_a5a5),
  });
  if (second.kind === "cancelled") return second;
  return {
    kind: "completed",
    output: {
      kind: "alternatives",
      alternatives: [first.output, second.output],
      algorithm: PROTOTYPE_ALGORITHMS.generativeRemove,
      parameterHashInput: {
        operation: "generative-remove",
        algorithmRevision: "1",
        seed: input.parameters.seed,
        searchRadius: input.parameters.searchRadius,
        selection: Uint8Array.from(input.parameters.selection),
      },
    },
  };
}
