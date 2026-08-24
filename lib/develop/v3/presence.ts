import type { SemanticStageId } from "../process";
import type { Rgb } from "./profiles";

export type PresenceStageId = "texture" | "clarity" | "dehaze";

export interface SpatialStageDeclaration<Id extends string> {
  readonly id: Id;
  readonly semanticStageId: SemanticStageId;
  readonly orderWithinStage: number;
  readonly sourceRelativeScale: {
    readonly kind: "source-pixels";
    readonly radius: number;
  };
  readonly haloSourcePixels: number;
  readonly borderPolicy: "clamp-to-edge";
  readonly inputPrecision: "linear-float32";
  readonly dependencies: readonly string[];
}

export interface ReadonlyRgbImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly data: ArrayLike<number>;
}

export interface PresenceSettings {
  readonly texture: number;
  readonly clarity: number;
  readonly dehaze: number;
}

export const PRESENCE_STAGE_DECLARATIONS = [
  {
    id: "texture",
    semanticStageId: "presence",
    orderWithinStage: 1,
    sourceRelativeScale: { kind: "source-pixels", radius: 2 },
    haloSourcePixels: 2,
    borderPolicy: "clamp-to-edge",
    inputPrecision: "linear-float32",
    dependencies: ["local-adjustments"],
  },
  {
    id: "clarity",
    semanticStageId: "presence",
    orderWithinStage: 2,
    sourceRelativeScale: { kind: "source-pixels", radius: 16 },
    haloSourcePixels: 16,
    borderPolicy: "clamp-to-edge",
    inputPrecision: "linear-float32",
    dependencies: ["texture"],
  },
  {
    id: "dehaze",
    semanticStageId: "presence",
    orderWithinStage: 3,
    sourceRelativeScale: { kind: "source-pixels", radius: 32 },
    haloSourcePixels: 32,
    borderPolicy: "clamp-to-edge",
    inputPrecision: "linear-float32",
    dependencies: ["clarity"],
  },
] as const satisfies readonly SpatialStageDeclaration<PresenceStageId>[];

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function validImage(image: ReadonlyRgbImage): boolean {
  return Number.isSafeInteger(image.width) && image.width > 0 &&
    Number.isSafeInteger(image.height) && image.height > 0 &&
    image.data.length >= image.width * image.height * image.channels;
}

export function readClampedPixel(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
): Rgb {
  if (!validImage(image)) return [0, 0, 0];
  const sourceX = Math.round(clamp(x, 0, image.width - 1));
  const sourceY = Math.round(clamp(y, 0, image.height - 1));
  const offset = (sourceY * image.width + sourceX) * image.channels;
  return [
    finiteOr(image.data[offset], 0),
    finiteOr(image.data[offset + 1], 0),
    finiteOr(image.data[offset + 2], 0),
  ];
}

export function sampleBilinearClamped(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
): Rgb {
  if (!validImage(image)) return [0, 0, 0];
  const boundedX = clamp(x, 0, image.width - 1);
  const boundedY = clamp(y, 0, image.height - 1);
  const x0 = Math.floor(boundedX);
  const y0 = Math.floor(boundedY);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const fractionX = boundedX - x0;
  const fractionY = boundedY - y0;
  const topLeft = readClampedPixel(image, x0, y0);
  const topRight = readClampedPixel(image, x1, y0);
  const bottomLeft = readClampedPixel(image, x0, y1);
  const bottomRight = readClampedPixel(image, x1, y1);
  const channel = (index: 0 | 1 | 2): number => {
    const top = topLeft[index] + (topRight[index] - topLeft[index]) * fractionX;
    const bottom = bottomLeft[index] + (bottomRight[index] - bottomLeft[index]) * fractionX;
    return top + (bottom - top) * fractionY;
  };
  return [channel(0), channel(1), channel(2)];
}

function sourceRadiusInInputPixels(
  radiusSourcePixels: number,
  sourcePixelsPerInputPixel: number,
): number {
  return clamp(
    radiusSourcePixels / clamp(sourcePixelsPerInputPixel, 1 / 64, 64),
    0.25,
    512,
  );
}

function nineTapAverage(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
  radius: number,
): Rgb {
  const diagonal = radius * Math.SQRT1_2;
  const offsets: readonly (readonly [number, number])[] = [
    [0, 0],
    [radius, 0],
    [-radius, 0],
    [0, radius],
    [0, -radius],
    [diagonal, diagonal],
    [-diagonal, diagonal],
    [diagonal, -diagonal],
    [-diagonal, -diagonal],
  ];
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const offset of offsets) {
    const sample = sampleBilinearClamped(image, x + offset[0], y + offset[1]);
    red += sample[0];
    green += sample[1];
    blue += sample[2];
  }
  return [red / offsets.length, green / offsets.length, blue / offsets.length];
}

export function applyTexturePixel(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
  amount: number,
  sourcePixelsPerInputPixel: number,
): Rgb {
  const center = readClampedPixel(image, x, y);
  const strength = clamp(amount, -100, 100) / 100;
  if (strength === 0) return center;
  const blur = nineTapAverage(
    image,
    x,
    y,
    sourceRadiusInInputPixels(2, sourcePixelsPerInputPixel),
  );
  return [
    clamp(center[0] + (center[0] - blur[0]) * strength * 0.6, 0, 16),
    clamp(center[1] + (center[1] - blur[1]) * strength * 0.6, 0, 16),
    clamp(center[2] + (center[2] - blur[2]) * strength * 0.6, 0, 16),
  ];
}

export function applyClarityPixel(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
  amount: number,
  sourcePixelsPerInputPixel: number,
): Rgb {
  const center = readClampedPixel(image, x, y);
  const strength = clamp(amount, -100, 100) / 100;
  if (strength === 0) return center;
  const blur = nineTapAverage(
    image,
    x,
    y,
    sourceRadiusInInputPixels(16, sourcePixelsPerInputPixel),
  );
  const centerLuminance = center[0] * 0.2126 + center[1] * 0.7152 + center[2] * 0.0722;
  const blurLuminance = blur[0] * 0.2126 + blur[1] * 0.7152 + blur[2] * 0.0722;
  const adjustment = (centerLuminance - blurLuminance) * strength * 0.8;
  return [
    clamp(center[0] + adjustment, 0, 16),
    clamp(center[1] + adjustment, 0, 16),
    clamp(center[2] + adjustment, 0, 16),
  ];
}

export function applyDehazePixel(
  image: ReadonlyRgbImage,
  x: number,
  y: number,
  amount: number,
  sourcePixelsPerInputPixel: number,
): Rgb {
  const center = readClampedPixel(image, x, y);
  const strength = clamp(amount, -100, 100) / 100;
  if (strength === 0) return center;
  const local = nineTapAverage(
    image,
    x,
    y,
    sourceRadiusInInputPixels(32, sourcePixelsPerInputPixel),
  );
  const darkChannel = clamp(Math.min(local[0], local[1], local[2]), 0, 1);
  if (strength > 0) {
    const transmission = clamp(1 - strength * darkChannel * 0.8, 0.2, 1);
    return [
      clamp((center[0] - (1 - transmission)) / transmission, 0, 16),
      clamp((center[1] - (1 - transmission)) / transmission, 0, 16),
      clamp((center[2] - (1 - transmission)) / transmission, 0, 16),
    ];
  }
  const haze = -strength * 0.35;
  return [
    clamp(center[0] * (1 - haze) + haze, 0, 16),
    clamp(center[1] * (1 - haze) + haze, 0, 16),
    clamp(center[2] * (1 - haze) + haze, 0, 16),
  ];
}
