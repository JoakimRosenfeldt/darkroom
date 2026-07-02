import type { CurveSettings, DevelopPlugin } from "@/lib/develop/types";

export const DEFAULT_CURVE_SETTINGS: CurveSettings = {
  shadows: 0,
  midtones: 0,
  highlights: 0,
};

function numberProp(props: Record<string, string>, key: string): number | null {
  const raw = props[key];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isDefault(settings: CurveSettings): boolean {
  return Object.values(settings).every((value) => value === 0);
}

export const curvePlugin: DevelopPlugin<"curve"> = {
  id: "curve",
  label: "Tone Curve",
  defaults: DEFAULT_CURVE_SETTINGS,
  isDefault,
  xmp: {
    write: (settings) => ({
      "crs:ToneCurvePV2012": [
        "0, 0",
        `64, ${Math.round(64 + settings.shadows)}`,
        `128, ${Math.round(128 + settings.midtones)}`,
        `192, ${Math.round(192 + settings.highlights)}`,
        "255, 255",
      ].join("; "),
    }),
    read: (props) => {
      const curve = props["crs:ToneCurvePV2012"];
      if (!curve) {
        return {};
      }
      const values = curve
        .split(";")
        .map((pair) => pair.split(",").map((value) => Number(value.trim())));
      const pointAt = (x: number) =>
        values.find(([pointX]) => pointX === x)?.[1] ?? x;
      return {
        shadows: pointAt(64) - 64,
        midtones: pointAt(128) - 128,
        highlights: pointAt(192) - 192,
      };
    },
  },
};
