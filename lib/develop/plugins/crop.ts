import type { CropSettings } from "@/lib/develop/types";

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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeCrop(settings: CropSettings): CropSettings {
  const x = clamp(settings.x, 0, 0.95);
  const y = clamp(settings.y, 0, 0.95);
  return {
    ...settings,
    x,
    y,
    width: clamp(settings.width, 0.05, 1 - x),
    height: clamp(settings.height, 0.05, 1 - y),
  };
}

export function isDefaultCrop(settings: CropSettings): boolean {
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

export function writeCropXmp(settings: CropSettings): Record<string, string> {
  const crop = normalizeCrop(settings);
  if (!crop.enabled) {
    return {};
  }
  return {
    "crs:HasCrop": "True",
    "crs:CropLeft": crop.x.toFixed(6),
    "crs:CropTop": crop.y.toFixed(6),
    "crs:CropRight": (crop.x + crop.width).toFixed(6),
    "crs:CropBottom": (crop.y + crop.height).toFixed(6),
    "crs:CropAngle": crop.angle.toFixed(2),
    "crs:PerspectiveHorizontal": String(Math.round(crop.perspectiveX)),
    "crs:PerspectiveVertical": String(Math.round(crop.perspectiveY)),
    "crs:LensManualDistortionAmount": String(Math.round(crop.distortion)),
  };
}

export function readCropXmp(
  props: Record<string, string>,
): Partial<CropSettings> {
  const left = numberProp(props, "crs:CropLeft") ?? 0;
  const top = numberProp(props, "crs:CropTop") ?? 0;
  const right = numberProp(props, "crs:CropRight") ?? 1;
  const bottom = numberProp(props, "crs:CropBottom") ?? 1;
  return normalizeCrop({
    enabled: props["crs:HasCrop"] === "True" || left > 0 || top > 0,
    x: left,
    y: top,
    width: Math.max(0.05, right - left),
    height: Math.max(0.05, bottom - top),
    angle: numberProp(props, "crs:CropAngle") ?? 0,
    perspectiveX: numberProp(props, "crs:PerspectiveHorizontal") ?? 0,
    perspectiveY: numberProp(props, "crs:PerspectiveVertical") ?? 0,
    distortion: numberProp(props, "crs:LensManualDistortionAmount") ?? 0,
  });
}
