import type { LibraryEntry } from "@/lib/fs/types";
import type { CropSettings, SourceSignature } from "@/lib/develop/types";

export type SourceRenderMode = "source" | "crop-preview" | "export";

export interface SourceTransformInput {
  displayWidth: number;
  displayHeight: number;
  textureWidth: number;
  textureHeight: number;
  orientation: number;
  crop: CropSettings;
  mode: SourceRenderMode;
}

export interface NormalizedSourceUv {
  x: number;
  y: number;
}

export interface TransformedSourceUv {
  /** Normalized coordinates in the oriented source image, before EXIF mapping. */
  oriented: NormalizedSourceUv;
  /** Normalized coordinates in the stored pixel texture. */
  stored: NormalizedSourceUv;
}

/**
 * The GLSL and CPU implementations below intentionally share the same order:
 * output y flip, optional crop remap, crop rotation, lens controls, then EXIF.
 * Mask textures use `oriented`, while the source image uses `stored`.
 */
export const SOURCE_TRANSFORM_GLSL = `
vec2 orient_uv(vec2 uv) {
  if (u_orientation == 2) return vec2(1.0 - uv.x, uv.y);
  if (u_orientation == 3) return vec2(1.0 - uv.x, 1.0 - uv.y);
  if (u_orientation == 4) return vec2(uv.x, 1.0 - uv.y);
  if (u_orientation == 5) return vec2(uv.y, uv.x);
  if (u_orientation == 6) return vec2(uv.y, 1.0 - uv.x);
  if (u_orientation == 7) return vec2(1.0 - uv.y, 1.0 - uv.x);
  if (u_orientation == 8) return vec2(1.0 - uv.y, uv.x);
  return uv;
}

vec2 transform_oriented_uv(vec2 uv) {
  uv = vec2(uv.x, 1.0 - uv.y);

  if (u_crop_enabled > 0.5) {
    vec2 crop_center = u_crop.xy + u_crop.zw * 0.5;
    if (u_crop_output > 0.5) {
      uv = u_crop.xy + uv * u_crop.zw;
    }

    vec2 p = (uv - crop_center) / u_texel;
    float angle = radians(-u_crop_angle);
    mat2 rotation = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    p = rotation * p;
    uv = crop_center + p * u_texel;
  }

  vec2 centered = uv - 0.5;
  uv += vec2(centered.y * u_perspective_x, centered.x * u_perspective_y) * 0.002;
  uv += centered * dot(centered, centered) * u_distortion * 0.001;
  return uv;
}

vec2 transform_uv(vec2 uv) {
  return orient_uv(transform_oriented_uv(uv));
}`;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampUv(uv: NormalizedSourceUv): NormalizedSourceUv {
  return { x: clampUnit(uv.x), y: clampUnit(uv.y) };
}

function orientUv(uv: NormalizedSourceUv, orientation: number): NormalizedSourceUv {
  switch (orientation) {
    case 2:
      return { x: 1 - uv.x, y: uv.y };
    case 3:
      return { x: 1 - uv.x, y: 1 - uv.y };
    case 4:
      return { x: uv.x, y: 1 - uv.y };
    case 5:
      return { x: uv.y, y: uv.x };
    case 6:
      return { x: uv.y, y: 1 - uv.x };
    case 7:
      return { x: 1 - uv.y, y: 1 - uv.x };
    case 8:
      return { x: 1 - uv.y, y: uv.x };
    default:
      return uv;
  }
}

export function transformOutputUv(
  outputUv: NormalizedSourceUv,
  input: SourceTransformInput,
): TransformedSourceUv {
  let oriented = { x: outputUv.x, y: 1 - outputUv.y };
  const crop = input.crop;

  if (crop.enabled) {
    const cropCenter = {
      x: crop.x + crop.width * 0.5,
      y: crop.y + crop.height * 0.5,
    };
    if (input.mode !== "source") {
      oriented = {
        x: crop.x + oriented.x * crop.width,
        y: crop.y + oriented.y * crop.height,
      };
    }

    const texel = {
      x: 1 / input.displayWidth,
      y: 1 / input.displayHeight,
    };
    const p = {
      x: (oriented.x - cropCenter.x) / texel.x,
      y: (oriented.y - cropCenter.y) / texel.y,
    };
    const angle = (-crop.angle * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    oriented = {
      x: cropCenter.x + (cos * p.x - sin * p.y) * texel.x,
      y: cropCenter.y + (sin * p.x + cos * p.y) * texel.y,
    };
  }

  const centered = { x: oriented.x - 0.5, y: oriented.y - 0.5 };
  oriented = {
    x: oriented.x + centered.y * crop.perspectiveX * 0.002,
    y: oriented.y + centered.x * crop.perspectiveY * 0.002,
  };
  const radiusSquared = centered.x * centered.x + centered.y * centered.y;
  oriented = {
    x: oriented.x + centered.x * radiusSquared * crop.distortion * 0.001,
    y: oriented.y + centered.y * radiusSquared * crop.distortion * 0.001,
  };

  const clamped = clampUv(oriented);
  return { oriented: clamped, stored: clampUv(orientUv(clamped, input.orientation)) };
}

/**
 * Maps a mask point in oriented-source space back to the visible output.
 * The lens controls are intentionally inverted with a few fixed-point passes;
 * the forward correction is small and this keeps the UI aligned with the GLSL
 * transform without maintaining a second crop implementation.
 */
export function orientedToOutputUv(
  orientedUv: NormalizedSourceUv,
  input: SourceTransformInput,
): NormalizedSourceUv {
  const crop = input.crop;
  let source = clampUv(orientedUv);
  for (let index = 0; index < 6; index += 1) {
    const centered = { x: source.x - 0.5, y: source.y - 0.5 };
    const radiusSquared = centered.x * centered.x + centered.y * centered.y;
    source = {
      x: orientedUv.x - centered.y * crop.perspectiveX * 0.002 - centered.x * radiusSquared * crop.distortion * 0.001,
      y: orientedUv.y - centered.x * crop.perspectiveY * 0.002 - centered.y * radiusSquared * crop.distortion * 0.001,
    };
  }

  if (crop.enabled) {
    const cropCenter = {
      x: crop.x + crop.width * 0.5,
      y: crop.y + crop.height * 0.5,
    };
    const texel = {
      x: 1 / input.displayWidth,
      y: 1 / input.displayHeight,
    };
    const p = {
      x: (source.x - cropCenter.x) / texel.x,
      y: (source.y - cropCenter.y) / texel.y,
    };
    const angle = (crop.angle * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    source = {
      x: cropCenter.x + (cos * p.x - sin * p.y) * texel.x,
      y: cropCenter.y + (sin * p.x + cos * p.y) * texel.y,
    };
    if (input.mode !== "source") {
      source = {
        x: (source.x - crop.x) / crop.width,
        y: (source.y - crop.y) / crop.height,
      };
    }
  }

  return {
    x: clampUnit(source.x),
    y: clampUnit(1 - source.y),
  };
}

export function sourceSignatureForEntry(
  entry: Pick<LibraryEntry, "id" | "relativePath" | "size" | "lastModified">,
): SourceSignature {
  return {
    entryId: entry.id,
    relativePath: entry.relativePath,
    size: entry.size,
    lastModified: entry.lastModified,
  };
}

export function sourceSignaturesEqual(
  left: SourceSignature,
  right: SourceSignature,
): boolean {
  return left.entryId === right.entryId &&
    left.relativePath === right.relativePath &&
    left.size === right.size &&
    left.lastModified === right.lastModified;
}

export function sourceSignatureKey(signature: SourceSignature): string {
  return [
    signature.entryId,
    signature.relativePath,
    signature.size,
    signature.lastModified,
  ].join("\u001f");
}
