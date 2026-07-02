import type {
  DevelopPlugin,
  MixerBandSettings,
  MixerColor,
  MixerSettings,
} from "@/lib/develop/types";

export const MIXER_COLORS: MixerColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
];

const XMP_NAMES: Record<MixerColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  aqua: "Aqua",
  blue: "Blue",
  purple: "Purple",
  magenta: "Magenta",
};

const DEFAULT_BAND: MixerBandSettings = {
  hue: 0,
  saturation: 0,
  luminance: 0,
};

export const DEFAULT_MIXER_SETTINGS = Object.fromEntries(
  MIXER_COLORS.map((color) => [color, { ...DEFAULT_BAND }]),
) as MixerSettings;

function numberProp(props: Record<string, string>, key: string): number | null {
  const raw = props[key];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isDefault(settings: MixerSettings): boolean {
  return MIXER_COLORS.every((color) =>
    Object.values(settings[color]).every((value) => value === 0),
  );
}

export const mixerPlugin: DevelopPlugin<"mixer"> = {
  id: "mixer",
  label: "Color Mixer",
  defaults: DEFAULT_MIXER_SETTINGS,
  isDefault,
  xmp: {
    write: (settings) => {
      const props: Record<string, string> = {};
      for (const color of MIXER_COLORS) {
        const name = XMP_NAMES[color];
        props[`crs:HueAdjustment${name}`] = String(
          Math.round(settings[color].hue),
        );
        props[`crs:SaturationAdjustment${name}`] = String(
          Math.round(settings[color].saturation),
        );
        props[`crs:LuminanceAdjustment${name}`] = String(
          Math.round(settings[color].luminance),
        );
      }
      return props;
    },
    read: (props) => {
      const settings = structuredClone(DEFAULT_MIXER_SETTINGS);
      for (const color of MIXER_COLORS) {
        const name = XMP_NAMES[color];
        settings[color] = {
          hue: numberProp(props, `crs:HueAdjustment${name}`) ?? 0,
          saturation: numberProp(props, `crs:SaturationAdjustment${name}`) ?? 0,
          luminance: numberProp(props, `crs:LuminanceAdjustment${name}`) ?? 0,
        };
      }
      return settings;
    },
  },
};
