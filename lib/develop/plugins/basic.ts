import type { BasicSettings, DevelopPlugin } from "@/lib/develop/types";
import { numberProp } from "@/lib/develop/number-prop";

export const DEFAULT_BASIC_SETTINGS: BasicSettings = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
};

function isDefault(settings: BasicSettings): boolean {
  return Object.values(settings).every((value) => value === 0);
}

export const basicPlugin: DevelopPlugin<"basic"> = {
  id: "basic",
  label: "Basic",
  defaults: DEFAULT_BASIC_SETTINGS,
  isDefault,
  xmp: {
    write: (settings) => ({
      "crs:ProcessVersion": "15.0",
      "crs:Exposure2012": settings.exposure.toFixed(2),
      "crs:Contrast2012": String(Math.round(settings.contrast)),
      "crs:Highlights2012": String(Math.round(settings.highlights)),
      "crs:Shadows2012": String(Math.round(settings.shadows)),
      "crs:Whites2012": String(Math.round(settings.whites)),
      "crs:Blacks2012": String(Math.round(settings.blacks)),
      "crs:Temperature": String(Math.round(5500 + settings.temperature)),
      "crs:Tint": String(Math.round(settings.tint)),
      "crs:Vibrance": String(Math.round(settings.vibrance)),
      "crs:Saturation": String(Math.round(settings.saturation)),
    }),
    read: (props) => {
      const temperature = numberProp(props, "crs:Temperature");
      return {
        exposure: numberProp(props, "crs:Exposure2012") ?? 0,
        contrast: numberProp(props, "crs:Contrast2012") ?? 0,
        highlights: numberProp(props, "crs:Highlights2012") ?? 0,
        shadows: numberProp(props, "crs:Shadows2012") ?? 0,
        whites: numberProp(props, "crs:Whites2012") ?? 0,
        blacks: numberProp(props, "crs:Blacks2012") ?? 0,
        temperature: temperature === null ? 0 : temperature - 5500,
        tint: numberProp(props, "crs:Tint") ?? 0,
        vibrance: numberProp(props, "crs:Vibrance") ?? 0,
        saturation: numberProp(props, "crs:Saturation") ?? 0,
      };
    },
  },
};
