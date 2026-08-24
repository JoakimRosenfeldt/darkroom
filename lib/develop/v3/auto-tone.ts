export const MAX_AUTO_TONE_HISTOGRAM_BINS = 4_096;

export interface ToneStatistics {
  readonly blackPoint: number;
  readonly shadowPoint: number;
  readonly median: number;
  readonly highlightPoint: number;
  readonly whitePoint: number;
  readonly meanSaturation: number;
  readonly clippedShadowFraction: number;
  readonly clippedHighlightFraction: number;
}

export type AutoToneInput =
  | { readonly kind: "statistics"; readonly statistics: ToneStatistics }
  | {
      readonly kind: "histogram";
      readonly luminanceBins: ReadonlyArray<number>;
      readonly pixelCount: number;
      readonly meanSaturation: number;
    };

export interface AutoToneValues {
  readonly exposure: number;
  readonly contrast: number;
  readonly highlights: number;
  readonly shadows: number;
  readonly whites: number;
  readonly blacks: number;
  readonly vibrance: number;
  readonly saturation: number;
}

export type AutoToneProposal =
  | { readonly kind: "proposal"; readonly values: AutoToneValues }
  | {
      readonly kind: "no-result";
      readonly reason: "empty" | "invalid-statistics" | "invalid-histogram";
    };

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(
  bins: ReadonlyArray<number>,
  total: number,
  fraction: number,
): number {
  const target = total * clamp(fraction, 0, 1);
  let accumulated = 0;
  for (let index = 0; index < bins.length; index += 1) {
    accumulated += bins[index];
    if (accumulated >= target) return (index + 0.5) / bins.length;
  }
  return 1;
}

function statisticsFromHistogram(
  input: Extract<AutoToneInput, { readonly kind: "histogram" }>,
): ToneStatistics | null {
  if (
    input.luminanceBins.length < 2 ||
    input.luminanceBins.length > MAX_AUTO_TONE_HISTOGRAM_BINS ||
    !Number.isSafeInteger(input.pixelCount) ||
    input.pixelCount <= 0 ||
    !input.luminanceBins.every((count) =>
      Number.isSafeInteger(count) && count >= 0,
    )
  ) {
    return null;
  }
  const countedPixels = input.luminanceBins.reduce((sum, count) => sum + count, 0);
  if (countedPixels !== input.pixelCount) return null;
  return {
    blackPoint: percentile(input.luminanceBins, countedPixels, 0.01),
    shadowPoint: percentile(input.luminanceBins, countedPixels, 0.1),
    median: percentile(input.luminanceBins, countedPixels, 0.5),
    highlightPoint: percentile(input.luminanceBins, countedPixels, 0.9),
    whitePoint: percentile(input.luminanceBins, countedPixels, 0.99),
    meanSaturation: clamp(input.meanSaturation, 0, 1),
    clippedShadowFraction: input.luminanceBins[0] / countedPixels,
    clippedHighlightFraction:
      input.luminanceBins[input.luminanceBins.length - 1] / countedPixels,
  };
}

function validStatistics(statistics: ToneStatistics): boolean {
  const percentiles = [
    statistics.blackPoint,
    statistics.shadowPoint,
    statistics.median,
    statistics.highlightPoint,
    statistics.whitePoint,
  ];
  return Object.values(statistics).every(Number.isFinite) &&
    percentiles.every((value) => value >= 0 && value <= 1) &&
    percentiles.every((value, index) => index === 0 || value >= percentiles[index - 1]) &&
    statistics.meanSaturation >= 0 && statistics.meanSaturation <= 1 &&
    statistics.clippedShadowFraction >= 0 && statistics.clippedShadowFraction <= 1 &&
    statistics.clippedHighlightFraction >= 0 && statistics.clippedHighlightFraction <= 1;
}

export function proposeAutoTone(input: AutoToneInput): AutoToneProposal {
  const statistics = input.kind === "statistics"
    ? input.statistics
    : statisticsFromHistogram(input);
  if (!statistics) {
    return {
      kind: "no-result",
      reason: input.kind === "histogram" ? "invalid-histogram" : "invalid-statistics",
    };
  }
  if (!validStatistics(statistics)) {
    return { kind: "no-result", reason: "invalid-statistics" };
  }
  if (statistics.whitePoint <= statistics.blackPoint + 1e-5) {
    return { kind: "no-result", reason: "empty" };
  }

  const range = statistics.whitePoint - statistics.blackPoint;
  const exposure = clamp(Math.log2(0.42 / Math.max(0.02, statistics.median)), -2.5, 2.5);
  const contrast = clamp((0.65 - range) * 80, -30, 30);
  const shadows = clamp((0.18 - statistics.shadowPoint) * 180, -40, 40);
  const highlights = clamp((0.82 - statistics.highlightPoint) * 180, -40, 40);
  const blacks = clamp(
    (0.02 - statistics.blackPoint) * 400 - statistics.clippedShadowFraction * 50,
    -25,
    25,
  );
  const whites = clamp(
    (0.98 - statistics.whitePoint) * 400 - statistics.clippedHighlightFraction * 50,
    -25,
    25,
  );
  const vibrance = clamp((0.35 - statistics.meanSaturation) * 50, -15, 20);
  return {
    kind: "proposal",
    values: {
      exposure: rounded(exposure),
      contrast: rounded(contrast),
      highlights: rounded(highlights),
      shadows: rounded(shadows),
      whites: rounded(whites),
      blacks: rounded(blacks),
      vibrance: rounded(vibrance),
      saturation: 0,
    },
  };
}
