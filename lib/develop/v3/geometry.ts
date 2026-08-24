import {
  COORDINATE_FRAME_REVISION,
  type ExifOrientation,
} from "../process";
import {
  invertDistortedUv,
  mapDistortedUv,
  type LensCalibration,
  type OpticsAmounts,
} from "./optics";

export const CANONICAL_GEOMETRY_REVISION =
  `${COORDINATE_FRAME_REVISION}:geometry-1`;

export type QuarterTurns = 0 | 1 | 2 | 3;
export type Homography = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface GeometryPoint {
  readonly x: number;
  readonly y: number;
}

export interface GeometryCrop {
  readonly enabled: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface UserOrientation {
  readonly quarterTurns: QuarterTurns;
  readonly flipHorizontal: boolean;
  readonly flipVertical: boolean;
  readonly fineAngleDegrees: number;
}

export interface AcceptedUprightTransform {
  readonly enabled: boolean;
  readonly matrix: Homography;
  readonly revision: string;
}

export interface CanonicalGeometry {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly exifOrientation: ExifOrientation;
  readonly optics: {
    readonly calibration: LensCalibration;
    readonly amounts: OpticsAmounts;
  };
  readonly orientation: UserOrientation;
  readonly manualPerspective: Homography;
  readonly upright: AcceptedUprightTransform;
  readonly constrainCrop: boolean;
  readonly crop: GeometryCrop;
}

export const IDENTITY_HOMOGRAPHY: Homography = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
];

export type GeometryMapResult =
  | {
      readonly kind: "mapped";
      readonly point: GeometryPoint;
      readonly insideDestination: boolean;
    }
  | { readonly kind: "unmappable"; readonly reason: string };

const FULL_CROP: GeometryCrop = {
  enabled: true,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};
const MIN_CROP_SIZE = 0.01;
const CONSTRAIN_SAMPLES_PER_EDGE = 16;
const CONSTRAIN_ITERATIONS = 96;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function cropRect(crop: GeometryCrop): GeometryCrop {
  const width = clamp(crop.width, MIN_CROP_SIZE, 1);
  const height = clamp(crop.height, MIN_CROP_SIZE, 1);
  return {
    enabled: true,
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
  };
}

function orientedAspectRatio(geometry: CanonicalGeometry): number {
  const width = Math.max(1, finiteOr(geometry.sourceWidth, 1));
  const height = Math.max(1, finiteOr(geometry.sourceHeight, 1));
  const exifSwapsAxes = geometry.exifOrientation >= 5;
  let aspect = exifSwapsAxes ? height / width : width / height;
  if (geometry.orientation.quarterTurns % 2 === 1) aspect = 1 / aspect;
  return clamp(aspect, 1 / 1000, 1000);
}

function storedToExifOriented(
  point: GeometryPoint,
  orientation: ExifOrientation,
): GeometryPoint {
  switch (orientation) {
    case 2: return { x: 1 - point.x, y: point.y };
    case 3: return { x: 1 - point.x, y: 1 - point.y };
    case 4: return { x: point.x, y: 1 - point.y };
    case 5: return { x: point.y, y: point.x };
    case 6: return { x: 1 - point.y, y: point.x };
    case 7: return { x: 1 - point.y, y: 1 - point.x };
    case 8: return { x: point.y, y: 1 - point.x };
    case 1: return point;
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

function exifOrientedToStored(
  point: GeometryPoint,
  orientation: ExifOrientation,
): GeometryPoint {
  switch (orientation) {
    case 2: return { x: 1 - point.x, y: point.y };
    case 3: return { x: 1 - point.x, y: 1 - point.y };
    case 4: return { x: point.x, y: 1 - point.y };
    case 5: return { x: point.y, y: point.x };
    case 6: return { x: point.y, y: 1 - point.x };
    case 7: return { x: 1 - point.y, y: 1 - point.x };
    case 8: return { x: 1 - point.y, y: point.x };
    case 1: return point;
    default: {
      const exhaustive: never = orientation;
      return exhaustive;
    }
  }
}

function applyQuarterTurns(
  point: GeometryPoint,
  turns: QuarterTurns,
): GeometryPoint {
  switch (turns) {
    case 0: return point;
    case 1: return { x: 1 - point.y, y: point.x };
    case 2: return { x: 1 - point.x, y: 1 - point.y };
    case 3: return { x: point.y, y: 1 - point.x };
    default: {
      const exhaustive: never = turns;
      return exhaustive;
    }
  }
}

function invertQuarterTurns(
  point: GeometryPoint,
  turns: QuarterTurns,
): GeometryPoint {
  return applyQuarterTurns(point, turns === 1 ? 3 : turns === 3 ? 1 : turns);
}

function applyUserOrientation(
  point: GeometryPoint,
  orientation: UserOrientation,
): GeometryPoint {
  const turned = applyQuarterTurns(point, orientation.quarterTurns);
  return {
    x: orientation.flipHorizontal ? 1 - turned.x : turned.x,
    y: orientation.flipVertical ? 1 - turned.y : turned.y,
  };
}

function invertUserOrientation(
  point: GeometryPoint,
  orientation: UserOrientation,
): GeometryPoint {
  return invertQuarterTurns({
    x: orientation.flipHorizontal ? 1 - point.x : point.x,
    y: orientation.flipVertical ? 1 - point.y : point.y,
  }, orientation.quarterTurns);
}

function rotateAroundCenter(
  point: GeometryPoint,
  angleDegrees: number,
  aspectRatio: number,
): GeometryPoint {
  const angle = clamp(angleDegrees, -180, 180) * Math.PI / 180;
  if (angle === 0) return point;
  const x = (point.x - 0.5) * aspectRatio;
  const y = point.y - 0.5;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: 0.5 + (x * cosine - y * sine) / aspectRatio,
    y: 0.5 + x * sine + y * cosine,
  };
}

function homographyPoint(
  point: GeometryPoint,
  matrix: Homography,
): GeometryPoint | null {
  if (!matrix.every(Number.isFinite)) return null;
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-10) return null;
  const x = (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator;
  const y = (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function invertHomography(matrix: Homography): Homography | null {
  if (!matrix.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h) -
    b * (d * i - f * g) +
    c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  const inverse = 1 / determinant;
  return [
    (e * i - f * h) * inverse,
    (c * h - b * i) * inverse,
    (b * f - c * e) * inverse,
    (f * g - d * i) * inverse,
    (a * i - c * g) * inverse,
    (c * d - a * f) * inverse,
    (d * h - e * g) * inverse,
    (b * g - a * h) * inverse,
    (a * e - b * d) * inverse,
  ];
}

function mapped(point: GeometryPoint): GeometryMapResult {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { kind: "unmappable", reason: "The transform produced a non-finite coordinate." };
  }
  return {
    kind: "mapped",
    point,
    insideDestination: point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1,
  };
}

function mapOutputToStoredWithCrop(
  output: GeometryPoint,
  geometry: CanonicalGeometry,
  crop: GeometryCrop,
): GeometryMapResult {
  let point: GeometryPoint = {
    x: crop.x + output.x * crop.width,
    y: crop.y + output.y * crop.height,
  };
  const uprightInverse = invertHomography(
    geometry.upright.enabled ? geometry.upright.matrix : IDENTITY_HOMOGRAPHY,
  );
  const manualInverse = invertHomography(geometry.manualPerspective);
  if (!uprightInverse || !manualInverse) {
    return { kind: "unmappable", reason: "A perspective transform is singular." };
  }
  const afterUpright = homographyPoint(point, uprightInverse);
  if (!afterUpright) return { kind: "unmappable", reason: "Upright cannot map this coordinate." };
  const afterManual = homographyPoint(afterUpright, manualInverse);
  if (!afterManual) return { kind: "unmappable", reason: "Perspective cannot map this coordinate." };
  point = rotateAroundCenter(
    afterManual,
    -geometry.orientation.fineAngleDegrees,
    orientedAspectRatio(geometry),
  );
  point = invertUserOrientation(point, geometry.orientation);
  const distorted = mapDistortedUv(
    point,
    geometry.optics.calibration.distortion,
    geometry.optics.amounts.distortion,
  );
  point = exifOrientedToStored(distorted, geometry.exifOrientation);
  return mapped(point);
}

function boundaryIsInside(
  geometry: CanonicalGeometry,
  crop: GeometryCrop,
): boolean {
  for (let index = 0; index <= CONSTRAIN_SAMPLES_PER_EDGE; index += 1) {
    const position = index / CONSTRAIN_SAMPLES_PER_EDGE;
    const points: readonly GeometryPoint[] = [
      { x: position, y: 0 },
      { x: position, y: 1 },
      { x: 0, y: position },
      { x: 1, y: position },
    ];
    for (const point of points) {
      const result = mapOutputToStoredWithCrop(point, geometry, crop);
      if (result.kind !== "mapped" || !result.insideDestination) return false;
    }
  }
  return true;
}

export function resolveConstrainedCrop(geometry: CanonicalGeometry): GeometryCrop {
  const base = geometry.crop.enabled ? cropRect(geometry.crop) : FULL_CROP;
  if (!geometry.constrainCrop || boundaryIsInside(geometry, base)) return base;
  const centerX = base.x + base.width / 2;
  const centerY = base.y + base.height / 2;
  let scale = 1;
  for (let iteration = 0; iteration < CONSTRAIN_ITERATIONS; iteration += 1) {
    scale *= 0.98;
    const candidate = cropRect({
      enabled: true,
      x: centerX - base.width * scale / 2,
      y: centerY - base.height * scale / 2,
      width: base.width * scale,
      height: base.height * scale,
    });
    if (boundaryIsInside(geometry, candidate)) return candidate;
  }
  return cropRect({
    enabled: true,
    x: centerX - MIN_CROP_SIZE / 2,
    y: centerY - MIN_CROP_SIZE / 2,
    width: MIN_CROP_SIZE,
    height: MIN_CROP_SIZE,
  });
}

export function mapOutputToStored(
  output: GeometryPoint,
  geometry: CanonicalGeometry,
  effectiveCrop = resolveConstrainedCrop(geometry),
): GeometryMapResult {
  return mapOutputToStoredWithCrop(output, geometry, cropRect(effectiveCrop));
}

export function mapStoredToOutput(
  stored: GeometryPoint,
  geometry: CanonicalGeometry,
  effectiveCrop = resolveConstrainedCrop(geometry),
): GeometryMapResult {
  let point = storedToExifOriented(stored, geometry.exifOrientation);
  point = invertDistortedUv(
    point,
    geometry.optics.calibration.distortion,
    geometry.optics.amounts.distortion,
  );
  point = applyUserOrientation(point, geometry.orientation);
  point = rotateAroundCenter(
    point,
    geometry.orientation.fineAngleDegrees,
    orientedAspectRatio(geometry),
  );
  const afterManual = homographyPoint(point, geometry.manualPerspective);
  if (!afterManual) return { kind: "unmappable", reason: "Perspective cannot map this coordinate." };
  const afterUpright = homographyPoint(
    afterManual,
    geometry.upright.enabled ? geometry.upright.matrix : IDENTITY_HOMOGRAPHY,
  );
  if (!afterUpright) return { kind: "unmappable", reason: "Upright cannot map this coordinate." };
  const crop = cropRect(effectiveCrop);
  return mapped({
    x: (afterUpright.x - crop.x) / crop.width,
    y: (afterUpright.y - crop.y) / crop.height,
  });
}

function keyNumber(value: number): string {
  const finite = finiteOr(value, 0);
  return Object.is(finite, -0) ? "0" : finite.toFixed(12);
}

export function geometryCacheIdentity(geometry: CanonicalGeometry): string {
  const values: readonly (string | number | boolean)[] = [
    CANONICAL_GEOMETRY_REVISION,
    geometry.sourceWidth,
    geometry.sourceHeight,
    geometry.exifOrientation,
    geometry.orientation.quarterTurns,
    geometry.orientation.flipHorizontal,
    geometry.orientation.flipVertical,
    geometry.orientation.fineAngleDegrees,
    geometry.upright.revision,
  ];
  const numericTail = [
    geometry.optics.calibration.distortion.k1,
    geometry.optics.calibration.distortion.k2,
    geometry.optics.calibration.distortion.k3,
    geometry.optics.calibration.illumination.v1,
    geometry.optics.calibration.illumination.v2,
    geometry.optics.calibration.lateralChromaticAberration.red,
    geometry.optics.calibration.lateralChromaticAberration.blue,
    geometry.optics.amounts.distortion,
    geometry.optics.amounts.illumination,
    geometry.optics.amounts.lateralChromaticAberration,
    ...geometry.manualPerspective,
    geometry.upright.enabled ? 1 : 0,
    ...geometry.upright.matrix,
    geometry.constrainCrop ? 1 : 0,
    geometry.crop.enabled ? 1 : 0,
    geometry.crop.x,
    geometry.crop.y,
    geometry.crop.width,
    geometry.crop.height,
  ];
  return [...values.map(String), ...numericTail.map(keyNumber)].join("\u001f");
}
