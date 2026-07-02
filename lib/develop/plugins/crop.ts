import type { CropSettings, DevelopPlugin } from "@/lib/develop/types";

export const DEFAULT_CROP_SETTINGS: CropSettings = {
  enabled: false,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  angle: 0,
  perspectiveX: 0,
  perspectiveY: 0,
  distortion: 0,
};

function numberProp(props: Record<string, string>, key: string): number | null {
  const raw = props[key];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isDefault(settings: CropSettings): boolean {
  return (
    !settings.enabled &&
    settings.x === 0 &&
    settings.y === 0 &&
    settings.width === 1 &&
    settings.height === 1 &&
    settings.angle === 0 &&
    settings.perspectiveX === 0 &&
    settings.perspectiveY === 0 &&
    settings.distortion === 0
  );
}

export const cropPlugin: DevelopPlugin<"crop"> = {
  id: "crop",
  label: "Crop & Transform",
  defaults: DEFAULT_CROP_SETTINGS,
  isDefault,
  xmp: {
    write: (settings) => {
      if (!settings.enabled) {
        return {} as Record<string, string>;
      }
      return {
        "crs:HasCrop": "True",
        "crs:CropLeft": settings.x.toFixed(6),
        "crs:CropTop": settings.y.toFixed(6),
        "crs:CropRight": (settings.x + settings.width).toFixed(6),
        "crs:CropBottom": (settings.y + settings.height).toFixed(6),
        "crs:CropAngle": settings.angle.toFixed(2),
        "crs:PerspectiveHorizontal": String(Math.round(settings.perspectiveX)),
        "crs:PerspectiveVertical": String(Math.round(settings.perspectiveY)),
        "crs:LensManualDistortionAmount": String(
          Math.round(settings.distortion),
        ),
      };
    },
    read: (props) => {
      const left = numberProp(props, "crs:CropLeft") ?? 0;
      const top = numberProp(props, "crs:CropTop") ?? 0;
      const right = numberProp(props, "crs:CropRight") ?? 1;
      const bottom = numberProp(props, "crs:CropBottom") ?? 1;
      return {
        enabled: props["crs:HasCrop"] === "True" || left > 0 || top > 0,
        x: left,
        y: top,
        width: Math.max(0.05, right - left),
        height: Math.max(0.05, bottom - top),
        angle: numberProp(props, "crs:CropAngle") ?? 0,
        perspectiveX: numberProp(props, "crs:PerspectiveHorizontal") ?? 0,
        perspectiveY: numberProp(props, "crs:PerspectiveVertical") ?? 0,
        distortion: numberProp(props, "crs:LensManualDistortionAmount") ?? 0,
      };
    },
  },
};
