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
  const current = clampCropRect(rect);
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return current;
  }

  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  const minWidth = Math.max(MIN_CROP_SIZE, MIN_CROP_SIZE * aspectRatio);
  const maxWidth = Math.min(1, aspectRatio);
  if (minWidth > maxWidth) {
    return current;
  }

  const width = Math.max(
    minWidth,
    Math.min(maxWidth, Math.sqrt(current.width * current.height * aspectRatio)),
  );
  const height = width / aspectRatio;

  return clampCropRect({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  });
}

export function applyCropDrag(
  rect: CropRect,
  handle: CropHandle,
  deltaX: number,
  deltaY: number,
  aspectRatio: number | null,
): CropRect {
  const current = clampCropRect(rect);
  let { x, y, width, height } = current;

  if (handle === "move") {
    return clampCropRect({
      x: x + deltaX,
      y: y + deltaY,
      width,
      height,
    });
  }

  if (aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0) {
    const horizontal = handle === "e" || handle === "w";
    const vertical = handle === "n" || handle === "s";
    const corner = handle.length === 2;
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    if (corner) {
      const west = handle.includes("w");
      const north = handle.includes("n");
      const fixedX = west ? x + width : x;
      const fixedY = north ? y + height : y;
      const minWidth = Math.max(MIN_CROP_SIZE, MIN_CROP_SIZE * aspectRatio);
      const maxWidth = Math.min(
        west ? fixedX : 1 - fixedX,
        (north ? fixedY : 1 - fixedY) * aspectRatio,
      );
      if (minWidth > maxWidth) {
        return current;
      }
      const useWidth = Math.abs(deltaX) >= Math.abs(deltaY);
      const requestedWidth = useWidth
        ? width + (west ? -deltaX : deltaX)
        : (height + (north ? -deltaY : deltaY)) * aspectRatio;
      width = Math.max(minWidth, Math.min(maxWidth, requestedWidth));
      height = width / aspectRatio;
      x = west ? fixedX - width : fixedX;
      y = north ? fixedY - height : fixedY;
    } else if (horizontal) {
      const west = handle === "w";
      const fixedX = west ? x + width : x;
      const minWidth = Math.max(MIN_CROP_SIZE, MIN_CROP_SIZE * aspectRatio);
      const maxWidth = Math.min(
        west ? fixedX : 1 - fixedX,
        Math.min(centerY, 1 - centerY) * 2 * aspectRatio,
      );
      if (minWidth > maxWidth) {
        return current;
      }
      width = Math.max(
        minWidth,
        Math.min(maxWidth, width + (west ? -deltaX : deltaX)),
      );
      height = width / aspectRatio;
      x = west ? fixedX - width : fixedX;
      y = centerY - height / 2;
    } else if (vertical) {
      const north = handle === "n";
      const fixedY = north ? y + height : y;
      const minHeight = Math.max(MIN_CROP_SIZE, MIN_CROP_SIZE / aspectRatio);
      const maxHeight = Math.min(
        north ? fixedY : 1 - fixedY,
        Math.min(centerX, 1 - centerX) * 2 / aspectRatio,
      );
      if (minHeight > maxHeight) {
        return current;
      }
      height = Math.max(
        minHeight,
        Math.min(maxHeight, height + (north ? -deltaY : deltaY)),
      );
      width = height * aspectRatio;
      y = north ? fixedY - height : fixedY;
      x = centerX - width / 2;
    }

    return clampCropRect({ x, y, width, height });
  }

  const right = x + width;
  const bottom = y + height;
  const nextX = handle.includes("w")
    ? Math.max(0, Math.min(right - MIN_CROP_SIZE, x + deltaX))
    : x;
  const nextY = handle.includes("n")
    ? Math.max(0, Math.min(bottom - MIN_CROP_SIZE, y + deltaY))
    : y;
  const nextRight = handle.includes("e")
    ? Math.max(nextX + MIN_CROP_SIZE, Math.min(1, right + deltaX))
    : right;
  const nextBottom = handle.includes("s")
    ? Math.max(nextY + MIN_CROP_SIZE, Math.min(1, bottom + deltaY))
    : bottom;
  return {
    x: nextX,
    y: nextY,
    width: nextRight - nextX,
    height: nextBottom - nextY,
  };
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
  const pixelRatio = presetId === "original"
    ? imageWidth / imageHeight
    : presetId === "custom"
      ? parseAspectRatioInput(String(customWidth), String(customHeight))
      : getPresetAspectRatio(presetId);
  return pixelRatio && imageWidth > 0 && imageHeight > 0
    ? pixelRatio * imageHeight / imageWidth
    : null;
}
