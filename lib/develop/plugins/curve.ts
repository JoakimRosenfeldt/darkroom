import type {
  CurveChannel,
  CurvePoint,
  CurveSettings,
  DevelopPlugin,
} from "@/lib/develop/types";

export const CURVE_CHANNELS: CurveChannel[] = ["rgb", "red", "green", "blue"];
export const CURVE_LUT_SIZE = 64;

const LINEAR_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const DEFAULT_CURVE_SETTINGS: CurveSettings = {
  rgb: LINEAR_CURVE.map((point) => ({ ...point })),
  red: LINEAR_CURVE.map((point) => ({ ...point })),
  green: LINEAR_CURVE.map((point) => ({ ...point })),
  blue: LINEAR_CURVE.map((point) => ({ ...point })),
};

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function normalizeCurvePoints(value: unknown): CurvePoint[] {
  if (!Array.isArray(value)) {
    return LINEAR_CURVE.map((point) => ({ ...point }));
  }

  const points = value
    .filter(
      (point): point is CurvePoint =>
        typeof point === "object" &&
        point !== null &&
        Number.isFinite((point as CurvePoint).x) &&
        Number.isFinite((point as CurvePoint).y),
    )
    .map((point) => ({ x: clamp(point.x), y: clamp(point.y) }))
    .sort((a, b) => a.x - b.x);

  if (points.length < 2) {
    return LINEAR_CURVE.map((point) => ({ ...point }));
  }

  points[0].x = 0;
  points[points.length - 1].x = 1;
  return points;
}

export function normalizeCurveSettings(value: unknown): CurveSettings {
  const settings = value as Partial<CurveSettings> & {
    shadows?: number;
    midtones?: number;
    highlights?: number;
  };

  if (
    Number.isFinite(settings?.shadows) ||
    Number.isFinite(settings?.midtones) ||
    Number.isFinite(settings?.highlights)
  ) {
    const legacyPoint = (x: number, adjustment = 0): CurvePoint => ({
      x: x / 255,
      y: clamp((x + adjustment) / 255),
    });
    return {
      ...structuredClone(DEFAULT_CURVE_SETTINGS),
      rgb: [
        legacyPoint(0),
        legacyPoint(64, settings.shadows ?? 0),
        legacyPoint(128, settings.midtones ?? 0),
        legacyPoint(192, settings.highlights ?? 0),
        legacyPoint(255),
      ],
    };
  }

  return Object.fromEntries(
    CURVE_CHANNELS.map((channel) => [
      channel,
      normalizeCurvePoints(settings?.[channel]),
    ]),
  ) as CurveSettings;
}

export function sampleCurve(points: CurvePoint[], input: number): number {
  const value = clamp(input);
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (value <= right.x) {
      const left = points[index - 1];
      const width = right.x - left.x;
      if (width === 0) {
        return left.y;
      }
      const amount = (value - left.x) / width;
      const before = points[Math.max(0, index - 2)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const leftWidth = right.x - before.x;
      const rightWidth = after.x - left.x;
      const leftSlope = leftWidth === 0 ? 0 : (right.y - before.y) / leftWidth;
      const rightSlope = rightWidth === 0 ? 0 : (after.y - left.y) / rightWidth;
      const squared = amount * amount;
      const cubed = squared * amount;
      return clamp(
        (2 * cubed - 3 * squared + 1) * left.y +
          (cubed - 2 * squared + amount) * width * leftSlope +
          (-2 * cubed + 3 * squared) * right.y +
          (cubed - squared) * width * rightSlope,
      );
    }
  }
  return points[points.length - 1]?.y ?? value;
}

export function createCurveLut(settings: CurveSettings): Float32Array {
  const values = new Float32Array(CURVE_CHANNELS.length * CURVE_LUT_SIZE);
  for (const [channelIndex, channel] of CURVE_CHANNELS.entries()) {
    for (let index = 0; index < CURVE_LUT_SIZE; index += 1) {
      values[index * CURVE_CHANNELS.length + channelIndex] = sampleCurve(
        settings[channel],
        index / (CURVE_LUT_SIZE - 1),
      );
    }
  }
  return values;
}

function curveProp(points: CurvePoint[]): string {
  return points
    .map(({ x, y }) => `${Math.round(x * 255)}, ${Math.round(y * 255)}`)
    .join("; ");
}

function parseCurve(value: string | undefined): CurvePoint[] | undefined {
  if (!value) {
    return undefined;
  }
  const points = value.split(";").map((pair) => {
    const [x, y] = pair.split(",").map((part) => Number(part.trim()) / 255);
    return { x, y };
  });
  return normalizeCurvePoints(points);
}

function isDefault(settings: CurveSettings): boolean {
  return CURVE_CHANNELS.every((channel) => {
    const points = settings[channel];
    return (
      points.length === 2 &&
      points[0].x === 0 &&
      points[0].y === 0 &&
      points[1].x === 1 &&
      points[1].y === 1
    );
  });
}

export const curvePlugin: DevelopPlugin<"curve"> = {
  id: "curve",
  label: "Tone Curve",
  defaults: DEFAULT_CURVE_SETTINGS,
  isDefault,
  xmp: {
    write: (settings) => ({
      "crs:ToneCurvePV2012": curveProp(settings.rgb),
      "crs:ToneCurvePV2012Red": curveProp(settings.red),
      "crs:ToneCurvePV2012Green": curveProp(settings.green),
      "crs:ToneCurvePV2012Blue": curveProp(settings.blue),
    }),
    read: (props) => {
      const rgb = parseCurve(props["crs:ToneCurvePV2012"]);
      const red = parseCurve(props["crs:ToneCurvePV2012Red"]);
      const green = parseCurve(props["crs:ToneCurvePV2012Green"]);
      const blue = parseCurve(props["crs:ToneCurvePV2012Blue"]);
      if (!rgb && !red && !green && !blue) {
        return {};
      }
      return normalizeCurveSettings({ rgb, red, green, blue });
    },
  },
};
