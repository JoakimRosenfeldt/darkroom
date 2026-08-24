export const MAX_HISTOGRAM_BINS = 1_024;
const HEADROOM_BINS = 2_048;
const MAX_HEADROOM_LINEAR = 64;

export type AnalysisState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: T };

export type DisplayOutputBuffer = {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly encoding: "unit-float" | "uint8" | "uint16";
  readonly data: ArrayLike<number>;
};

export interface ChannelHistogram {
  readonly red: ReadonlyArray<number>;
  readonly green: ReadonlyArray<number>;
  readonly blue: ReadonlyArray<number>;
  readonly luminance: ReadonlyArray<number>;
}

export interface ChannelClipping {
  readonly shadows: number;
  readonly highlights: number;
  readonly hasShadowClipping: boolean;
  readonly hasHighlightClipping: boolean;
}

export interface SdrClipping {
  readonly red: ChannelClipping;
  readonly green: ChannelClipping;
  readonly blue: ChannelClipping;
}

export interface DisplayAnalysis {
  readonly pixelCount: number;
  readonly binCount: number;
  readonly histogram: ChannelHistogram;
  readonly clipping: SdrClipping;
}

export type HdrHeadroomResult =
  | {
      readonly kind: "available";
      readonly maximumLinear: number;
      readonly percentile99Linear: number;
      readonly maximumStopsAboveSdr: number;
      readonly percentile99StopsAboveSdr: number;
      readonly sampleCount: number;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface SceneHeadroomInput {
  readonly luminance: ArrayLike<number>;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function normalizedComponent(
  value: number,
  encoding: DisplayOutputBuffer["encoding"],
): number {
  switch (encoding) {
    case "unit-float": return value;
    case "uint8": return value / 255;
    case "uint16": return value / 65_535;
    default: {
      const exhaustive: never = encoding;
      return exhaustive;
    }
  }
}

function clippingResult(shadows: number, highlights: number): ChannelClipping {
  return {
    shadows,
    highlights,
    hasShadowClipping: shadows > 0,
    hasHighlightClipping: highlights > 0,
  };
}

export function analyzeDisplayOutput(
  input: DisplayOutputBuffer,
  requestedBins = 256,
): AnalysisState<DisplayAnalysis> {
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    return { kind: "error", message: "Display-output dimensions are invalid." };
  }
  const pixelCount = input.width * input.height;
  const requiredComponents = pixelCount * input.channels;
  if (!Number.isSafeInteger(requiredComponents) || input.data.length < requiredComponents) {
    return { kind: "error", message: "Display-output pixels are incomplete." };
  }
  const binCount = Math.round(clamp(requestedBins, 16, MAX_HISTOGRAM_BINS));
  const redBins = Array<number>(binCount).fill(0);
  const greenBins = Array<number>(binCount).fill(0);
  const blueBins = Array<number>(binCount).fill(0);
  const luminanceBins = Array<number>(binCount).fill(0);
  let redShadows = 0;
  let greenShadows = 0;
  let blueShadows = 0;
  let redHighlights = 0;
  let greenHighlights = 0;
  let blueHighlights = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * input.channels;
    const rawRed = input.data[offset];
    const rawGreen = input.data[offset + 1];
    const rawBlue = input.data[offset + 2];
    if (![rawRed, rawGreen, rawBlue].every(Number.isFinite)) {
      return { kind: "error", message: "Display-output pixels contain non-finite values." };
    }
    const red = normalizedComponent(rawRed, input.encoding);
    const green = normalizedComponent(rawGreen, input.encoding);
    const blue = normalizedComponent(rawBlue, input.encoding);
    if (red <= 0) redShadows += 1;
    if (green <= 0) greenShadows += 1;
    if (blue <= 0) blueShadows += 1;
    if (red >= 1) redHighlights += 1;
    if (green >= 1) greenHighlights += 1;
    if (blue >= 1) blueHighlights += 1;
    const redIndex = Math.min(binCount - 1, Math.floor(clamp(red, 0, 1) * binCount));
    const greenIndex = Math.min(binCount - 1, Math.floor(clamp(green, 0, 1) * binCount));
    const blueIndex = Math.min(binCount - 1, Math.floor(clamp(blue, 0, 1) * binCount));
    const luminance = clamp(red * 0.2126 + green * 0.7152 + blue * 0.0722, 0, 1);
    const luminanceIndex = Math.min(binCount - 1, Math.floor(luminance * binCount));
    redBins[redIndex] += 1;
    greenBins[greenIndex] += 1;
    blueBins[blueIndex] += 1;
    luminanceBins[luminanceIndex] += 1;
  }

  return {
    kind: "ready",
    value: {
      pixelCount,
      binCount,
      histogram: {
        red: redBins,
        green: greenBins,
        blue: blueBins,
        luminance: luminanceBins,
      },
      clipping: {
        red: clippingResult(redShadows, redHighlights),
        green: clippingResult(greenShadows, greenHighlights),
        blue: clippingResult(blueShadows, blueHighlights),
      },
    },
  };
}

export function analyzeSceneHeadroom(input: SceneHeadroomInput): HdrHeadroomResult {
  if (input.luminance.length === 0) {
    return { kind: "unavailable", reason: "The scene-headroom tap is empty." };
  }
  const bins = Array<number>(HEADROOM_BINS).fill(0);
  let maximum = 0;
  let count = 0;
  for (let index = 0; index < input.luminance.length; index += 1) {
    const value = input.luminance[index];
    if (!Number.isFinite(value) || value < 0) {
      return { kind: "unavailable", reason: "Scene-headroom values are invalid." };
    }
    maximum = Math.max(maximum, value);
    const boundedValue = clamp(value, 0, MAX_HEADROOM_LINEAR);
    const bin = Math.min(
      HEADROOM_BINS - 1,
      Math.floor(boundedValue / MAX_HEADROOM_LINEAR * HEADROOM_BINS),
    );
    bins[bin] += 1;
    count += 1;
  }
  const target = count * 0.99;
  let accumulated = 0;
  let percentile99 = maximum;
  for (let index = 0; index < bins.length; index += 1) {
    accumulated += bins[index];
    if (accumulated >= target) {
      percentile99 = (index + 0.5) / HEADROOM_BINS * MAX_HEADROOM_LINEAR;
      break;
    }
  }
  return {
    kind: "available",
    maximumLinear: maximum,
    percentile99Linear: percentile99,
    maximumStopsAboveSdr: Math.max(0, Math.log2(Math.max(1, maximum))),
    percentile99StopsAboveSdr: Math.max(0, Math.log2(Math.max(1, percentile99))),
    sampleCount: count,
  };
}
