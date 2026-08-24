export const MAX_AUTO_TONE_HISTOGRAM_BINS = 4_096;

const TARGET_MEDIAN = 0.21;
const TARGET_HIGHLIGHT = 0.76;
const TARGET_WHITE = 0.97;

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

  const medianExposure = Math.log2(
    TARGET_MEDIAN / Math.max(0.02, statistics.median),
  );
  const highlightExposure = Math.log2(
    TARGET_HIGHLIGHT / Math.max(0.08, statistics.highlightPoint),
  );
  const whiteExposure = Math.log2(
    TARGET_WHITE / Math.max(0.1, statistics.whitePoint),
  );
  const upperExposure = Math.min(
    highlightExposure + 0.25,
    whiteExposure + 0.2,
  );
  const lowerExposure = Math.min(highlightExposure - 0.5, upperExposure);
  const exposure = clamp(
    clamp(medianExposure, lowerExposure, upperExposure),
    -1.5,
    2,
  );
  const exposureGain = 2 ** exposure;
  const adjustedShadow = statistics.shadowPoint * exposureGain;
  const adjustedHighlight = statistics.highlightPoint * exposureGain;
  const adjustedBlack = statistics.blackPoint * exposureGain;
  const adjustedWhite = statistics.whitePoint * exposureGain;
  const contrast = clamp(
    4 + Math.max(
      0,
      (0.55 - (statistics.highlightPoint - statistics.shadowPoint) * exposureGain) * 50,
    ),
    4,
    18,
  );
  const shadows = clamp(
    (0.035 - adjustedShadow) * 160 + statistics.clippedShadowFraction * 20,
    -12,
    15,
  );
  const highlights = clamp(
    (TARGET_HIGHLIGHT - adjustedHighlight) * 100 -
      statistics.clippedHighlightFraction * 25,
    -25,
    20,
  );
  const blacks = clamp(
    (0.008 - adjustedBlack) * 400 + statistics.clippedShadowFraction * 50,
    -15,
    15,
  );
  const whites = clamp(
    (1 - adjustedWhite) * 80 - statistics.clippedHighlightFraction * 30,
    -8,
    8,
  );
  const vibrance = clamp((0.28 - statistics.meanSaturation) * 35, 0, 10);
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
