export const MIN_CROP_SIZE = 0.05;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropHandle =
  | "move"
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

export function computeContainedImageRect(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
): ImageRect {
  const containerRatio = containerWidth / containerHeight;
  const imageRatio = imageWidth / imageHeight;
  let width = containerWidth;
  let height = containerHeight;

  if (imageRatio > containerRatio) {
    height = width / imageRatio;
  } else {
    width = height * imageRatio;
  }

  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  };
}

export function clampCropRect(rect: CropRect): CropRect {
  const width = Math.max(MIN_CROP_SIZE, Math.min(1, rect.width));
  const height = Math.max(MIN_CROP_SIZE, Math.min(1, rect.height));
  const x = Math.max(0, Math.min(1 - width, rect.x));
  const y = Math.max(0, Math.min(1 - height, rect.y));
  return { x, y, width, height };
}

export function fitCropToAspectRatio(
  rect: CropRect,
  aspectRatio: number,
): CropRect {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const area = rect.width * rect.height;

  let width = Math.sqrt(area * aspectRatio);
  let height = width / aspectRatio;

  const maxWidth = Math.min(centerX, 1 - centerX) * 2;
  const maxHeight = Math.min(centerY, 1 - centerY) * 2;

  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspectRatio;
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspectRatio;
  }

  width = Math.max(MIN_CROP_SIZE, width);
  height = Math.max(MIN_CROP_SIZE, height);

  return clampCropRect({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  });
}

function constrainSize(
  width: number,
  height: number,
  aspectRatio: number | null,
  anchor: "width" | "height",
): { width: number; height: number } {
  if (!aspectRatio || aspectRatio <= 0) {
    return { width, height };
  }
  if (anchor === "width") {
    return { width, height: width / aspectRatio };
  }
  return { width: height * aspectRatio, height };
}

export function applyCropDrag(
  rect: CropRect,
  handle: CropHandle,
  deltaX: number,
  deltaY: number,
  aspectRatio: number | null,
): CropRect {
  let { x, y, width, height } = rect;

  if (handle === "move") {
    return clampCropRect({
      x: x + deltaX,
      y: y + deltaY,
      width,
      height,
    });
  }

  if (handle.includes("e")) {
    width += deltaX;
  }
  if (handle.includes("w")) {
    x += deltaX;
    width -= deltaX;
  }
  if (handle.includes("s")) {
    height += deltaY;
  }
  if (handle.includes("n")) {
    y += deltaY;
    height -= deltaY;
  }

  width = Math.max(MIN_CROP_SIZE, width);
  height = Math.max(MIN_CROP_SIZE, height);

  if (aspectRatio && aspectRatio > 0) {
    const horizontal = handle === "e" || handle === "w";
    const vertical = handle === "n" || handle === "s";
    const corner = handle.length === 2;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;

    if (corner) {
      const useWidth = Math.abs(deltaX) >= Math.abs(deltaY);
      ({ width, height } = constrainSize(
        width,
        height,
        aspectRatio,
        useWidth ? "width" : "height",
      ));
      if (handle.includes("w")) {
        x = rect.x + rect.width - width;
      }
      if (handle.includes("n")) {
        y = rect.y + rect.height - height;
      }
    } else if (horizontal) {
      ({ width, height } = constrainSize(width, height, aspectRatio, "width"));
      if (handle === "w") {
        x = rect.x + rect.width - width;
      }
      y = centerY - height / 2;
    } else if (vertical) {
      ({ width, height } = constrainSize(width, height, aspectRatio, "height"));
      if (handle === "n") {
        y = rect.y + rect.height - height;
      }
      x = centerX - width / 2;
    }
  }

  return clampCropRect({ x, y, width, height });
}

export function parseAspectRatioInput(
  widthText: string,
  heightText: string,
): number | null {
  const width = Number(widthText);
  const height = Number(heightText);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
}

export const ASPECT_RATIO_PRESETS = [
  { id: "original", label: "Original" },
  { id: "free", label: "Free" },
  { id: "1:1", label: "1 : 1", ratio: 1 },
  { id: "4:3", label: "4 : 3", ratio: 4 / 3 },
  { id: "3:2", label: "3 : 2", ratio: 3 / 2 },
  { id: "16:9", label: "16 : 9", ratio: 16 / 9 },
  { id: "5:4", label: "5 : 4", ratio: 5 / 4 },
  { id: "2:3", label: "2 : 3", ratio: 2 / 3 },
  { id: "9:16", label: "9 : 16", ratio: 9 / 16 },
  { id: "custom", label: "Custom" },
] as const;

export type AspectRatioPresetId = (typeof ASPECT_RATIO_PRESETS)[number]["id"];

export function getPresetAspectRatio(
  presetId: AspectRatioPresetId,
): number | null {
  const preset = ASPECT_RATIO_PRESETS.find((item) => item.id === presetId);
  if (!preset || preset.id === "free" || preset.id === "original" || preset.id === "custom") {
    return null;
  }
  return preset.ratio;
}

export function resolveAspectRatio(
  presetId: AspectRatioPresetId,
  imageWidth: number,
  imageHeight: number,
  customWidth: number,
  customHeight: number,
): number | null {
  if (presetId === "free") {
    return null;
  }
  if (presetId === "original") {
    return imageWidth / imageHeight;
  }
  if (presetId === "custom") {
    return parseAspectRatioInput(String(customWidth), String(customHeight));
  }
  return getPresetAspectRatio(presetId);
}
