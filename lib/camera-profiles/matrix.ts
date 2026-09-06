export type CameraProfileMatrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface CameraProfileCompatibility {
  readonly make: string;
  readonly model: string;
}

export interface MatrixCameraProfile {
  readonly version: 1;
  readonly kind: "matrix";
  readonly id: string;
  readonly revision: string;
  readonly label: string;
  readonly compatibility: CameraProfileCompatibility;
  readonly matrixToLinearSrgb: CameraProfileMatrix3;
  readonly channelScale: readonly [number, number, number];
  readonly exposureOffsetEv: number;
}

const MAX_TEXT_LENGTH = 256;
const MAX_MATRIX_MAGNITUDE = 16;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function strictRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  const input = record(value, path);
  const unsupported = Object.keys(input).find((key) => !fields.includes(key));
  if (unsupported) throw new Error(`${path}.${unsupported} is not supported.`);
  return input;
}

function text(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    value.includes("\0")
  ) {
    throw new Error(`${path} is invalid.`);
  }
  return value.trim();
}

function boundedNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${path} is invalid.`);
  }
  return value;
}

function tuple3(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${path} must contain three numbers.`);
  }
  return [
    boundedNumber(value[0], `${path}[0]`, minimum, maximum),
    boundedNumber(value[1], `${path}[1]`, minimum, maximum),
    boundedNumber(value[2], `${path}[2]`, minimum, maximum),
  ];
}

function matrix3(value: unknown, path: string): CameraProfileMatrix3 {
  if (!Array.isArray(value) || value.length !== 9) {
    throw new Error(`${path} must contain nine numbers.`);
  }
  const parsed = value.map((item, index) =>
    boundedNumber(item, `${path}[${index}]`, -MAX_MATRIX_MAGNITUDE, MAX_MATRIX_MAGNITUDE),
  );
  const matrix: CameraProfileMatrix3 = [
    parsed[0]!, parsed[1]!, parsed[2]!,
    parsed[3]!, parsed[4]!, parsed[5]!,
    parsed[6]!, parsed[7]!, parsed[8]!,
  ];
  const determinant =
    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7]) -
    matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6]) +
    matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6]);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) {
    throw new Error(`${path} must be invertible.`);
  }
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (matrix.every((item, index) => item === identity[index])) {
    throw new Error(`${path} must be non-neutral.`);
  }
  return matrix;
}

function emptyUnsupportedList(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length !== 0) {
    throw new Error(`${path} contains unsupported profile operations.`);
  }
}

export function parseMatrixCameraProfile(value: unknown): MatrixCameraProfile {
  const input = strictRecord(value, "profile", [
    "version",
    "kind",
    "id",
    "revision",
    "label",
    "compatibility",
    "matrixToLinearSrgb",
    "channelScale",
    "exposureOffsetEv",
    "unsupportedTags",
    "opcodes",
  ]);
  if (input.version !== 1 || input.kind !== "matrix") {
    throw new Error("Only matrix camera profile version 1 is supported.");
  }
  if (input.unsupportedTags !== undefined) {
    emptyUnsupportedList(input.unsupportedTags, "profile.unsupportedTags");
  }
  if (input.opcodes !== undefined) {
    emptyUnsupportedList(input.opcodes, "profile.opcodes");
  }
  const compatibility = strictRecord(
    input.compatibility,
    "profile.compatibility",
    ["make", "model"],
  );
  return {
    version: 1,
    kind: "matrix",
    id: text(input.id, "profile.id"),
    revision: text(input.revision, "profile.revision"),
    label: text(input.label, "profile.label"),
    compatibility: {
      make: text(compatibility.make, "profile.compatibility.make"),
      model: text(compatibility.model, "profile.compatibility.model"),
    },
    matrixToLinearSrgb: matrix3(
      input.matrixToLinearSrgb,
      "profile.matrixToLinearSrgb",
    ),
    channelScale: tuple3(input.channelScale, "profile.channelScale", 0.0625, 16),
    exposureOffsetEv: boundedNumber(
      input.exposureOffsetEv,
      "profile.exposureOffsetEv",
      -8,
      8,
    ),
  };
}

function normalizedCameraText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function cameraProfileIsCompatible(
  profile: MatrixCameraProfile,
  camera: CameraProfileCompatibility,
): boolean {
  return normalizedCameraText(profile.compatibility.make) === normalizedCameraText(camera.make) &&
    normalizedCameraText(profile.compatibility.model) === normalizedCameraText(camera.model);
}

function profileIdPart(value: string): string {
  const part = normalizedCameraText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!part) throw new Error("LibRaw camera identity cannot form a profile id.");
  return part;
}

function libRawRgbCameraMatrix(value: unknown): CameraProfileMatrix3 {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error("LibRaw camera-to-sRGB matrix is unavailable.");
  }
  const rows = value.slice(0, 3).map((row, index) => {
    if (!Array.isArray(row) || row.length < 3) {
      throw new Error(`LibRaw camera-to-sRGB matrix row ${index} is invalid.`);
    }
    return row.slice(0, 3);
  });
  return matrix3(rows.flat(), "LibRaw camera-to-sRGB matrix");
}

export function matrixCameraProfileFromLibRawMetadata(
  metadata: Record<string, unknown>,
): MatrixCameraProfile {
  const make = text(metadata.camera_make, "LibRaw camera make");
  const model = text(metadata.camera_model, "LibRaw camera model");
  const colorData = record(metadata.color_data, "LibRaw color data");
  const matrix = libRawRgbCameraMatrix(colorData.rgb_cam);
  const id = `darkroom.libraw-matrix.${profileIdPart(make)}.${profileIdPart(model)}`;
  return parseMatrixCameraProfile({
    version: 1,
    kind: "matrix",
    id,
    revision: "libraw-rgb-cam-v1",
    label: `${make} ${model} LibRaw matrix`,
    compatibility: { make, model },
    matrixToLinearSrgb: matrix,
    channelScale: [1, 1, 1],
    exposureOffsetEv: 0,
    unsupportedTags: [],
    opcodes: [],
  });
}
