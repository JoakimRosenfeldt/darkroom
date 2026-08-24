export type ViewerZoomMode = "fit" | "fill" | "actual" | "custom";

export interface ViewerSize {
  readonly width: number;
  readonly height: number;
}

export interface ViewerTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const VIEWER_ZOOM_STEPS = [25, 50, 100, 200, 400] as const;

export function containedSize(viewport: ViewerSize, image: ViewerSize): ViewerSize {
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

export function relativeScaleForMode(
  mode: ViewerZoomMode,
  viewport: ViewerSize,
  image: ViewerSize,
  devicePixelRatio: number,
  customPercent = 100,
): number {
  const contained = containedSize(viewport, image);
  if (mode === "fit") return 1;
  if (mode === "fill") {
    return Math.max(viewport.width / contained.width, viewport.height / contained.height);
  }
  const cssSourceScale = mode === "actual"
    ? 1 / Math.max(1, devicePixelRatio)
    : customPercent / 100;
  return cssSourceScale / (contained.width / image.width);
}

export function clampViewerOffset(
  viewport: ViewerSize,
  imageRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  scale: number,
  offset: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  function axis(viewportSize: number, start: number, size: number, value: number): number {
    const min = viewportSize - (start + size) * scale;
    const max = -start * scale;
    return min > max ? (min + max) / 2 : Math.min(max, Math.max(min, value));
  }
  return {
    x: axis(viewport.width, imageRect.x, imageRect.width, offset.x),
    y: axis(viewport.height, imageRect.y, imageRect.height, offset.y),
  };
}

export function anchoredViewerTransform(
  current: ViewerTransform,
  scale: number,
  anchor: { readonly x: number; readonly y: number },
  viewport: ViewerSize,
  imageRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): ViewerTransform {
  const ratio = scale / current.scale;
  const offset = clampViewerOffset(viewport, imageRect, scale, {
    x: anchor.x - (anchor.x - current.x) * ratio,
    y: anchor.y - (anchor.y - current.y) * ratio,
  });
  return { scale, ...offset };
}

export function nextZoomPercent(current: number, direction: -1 | 1): number {
  if (direction > 0) return VIEWER_ZOOM_STEPS.find((step) => step > current) ?? 400;
  return [...VIEWER_ZOOM_STEPS].reverse().find((step) => step < current) ?? 25;
}
