import type {
  ColorProfileReference,
  SourceRecord,
} from "../process";

export type Rgb = readonly [number, number, number];
export type Matrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export const IDENTITY_MATRIX_3: Matrix3 = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
];

export interface InputCalibration {
  readonly matrixToLinearSrgb: Matrix3;
  readonly channelScale: Rgb;
  readonly exposureOffsetEv: number;
}

export type InputProfileCompatibility =
  | { readonly kind: "verified-standard-srgb" }
  | {
      readonly kind: "decoder-provided";
      readonly decoderId: string;
      readonly decoderColorSpace: string;
    }
  | {
      readonly kind: "camera-specific";
      readonly make: string;
      readonly models: readonly string[];
    };

export interface InputProfileDescriptor {
  readonly reference: ColorProfileReference;
  readonly label: string;
  readonly provenance:
    | "verified-standard"
    | "decoder-provided"
    | "camera-calibration";
  readonly compatibility: InputProfileCompatibility;
  readonly calibration: InputCalibration;
}

export const STANDARD_SRGB_INPUT_PROFILE = {
  reference: {
    id: "darkroom-standard-srgb",
    revision: "verified-identity-1",
    source: "registry",
  },
  label: "Standard sRGB",
  provenance: "verified-standard",
  compatibility: { kind: "verified-standard-srgb" },
  calibration: {
    matrixToLinearSrgb: IDENTITY_MATRIX_3,
    channelScale: [1, 1, 1],
    exposureOffsetEv: 0,
  },
} as const satisfies InputProfileDescriptor;

export type InputProfileResolution =
  | {
      readonly kind: "matched";
      readonly profile: InputProfileDescriptor;
    }
  | {
      readonly kind: "fallback";
      readonly profile: typeof STANDARD_SRGB_INPUT_PROFILE;
      readonly reason: string;
    }
  | {
      readonly kind: "unsupported";
      readonly neutralProfile: typeof STANDARD_SRGB_INPUT_PROFILE;
      readonly reason: string;
    };

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function matrixIsFinite(matrix: Matrix3): boolean {
  return matrix.every(Number.isFinite);
}

function sourceIsVerifiedSrgb(source: SourceRecord): boolean {
  if (source.color.kind !== "profiled" || source.color.transfer.kind !== "srgb") {
    return false;
  }
  const id = source.color.profile.id.trim().toLocaleLowerCase();
  return id === "srgb" ||
    id === "iec-61966-2-1" ||
    id === STANDARD_SRGB_INPUT_PROFILE.reference.id;
}

export function createDecoderProvidedProfile(input: {
  readonly id: string;
  readonly revision: string;
  readonly label: string;
  readonly decoderId: string;
  readonly decoderColorSpace: string;
  readonly matrixToLinearSrgb: Matrix3;
  readonly channelScale?: Rgb;
  readonly exposureOffsetEv?: number;
}): InputProfileDescriptor | null {
  const channelScale = input.channelScale ?? [1, 1, 1];
  if (
    input.id.trim().length === 0 ||
    input.revision.trim().length === 0 ||
    input.decoderId.trim().length === 0 ||
    input.decoderColorSpace.trim().length === 0 ||
    !matrixIsFinite(input.matrixToLinearSrgb) ||
    !channelScale.every((value) => Number.isFinite(value) && value > 0)
  ) {
    return null;
  }

  return {
    reference: {
      id: input.id,
      revision: input.revision,
      source: "decoder",
    },
    label: input.label,
    provenance: "decoder-provided",
    compatibility: {
      kind: "decoder-provided",
      decoderId: input.decoderId,
      decoderColorSpace: input.decoderColorSpace,
    },
    calibration: {
      matrixToLinearSrgb: input.matrixToLinearSrgb,
      channelScale,
      exposureOffsetEv: bounded(input.exposureOffsetEv ?? 0, -8, 8),
    },
  };
}

export function inputProfileIsCompatible(
  profile: InputProfileDescriptor,
  source: SourceRecord,
): boolean {
  switch (profile.compatibility.kind) {
    case "verified-standard-srgb":
      return sourceIsVerifiedSrgb(source);
    case "decoder-provided":
      return source.decoder.decoderId === profile.compatibility.decoderId &&
        source.color.kind === "decoder-provided" &&
        sameText(
          source.color.decoderColorSpace,
          profile.compatibility.decoderColorSpace,
        );
    case "camera-specific":
      return source.camera.kind === "available" &&
        sameText(source.camera.make, profile.compatibility.make) &&
        profile.compatibility.models.some((model) =>
          sameText(model, source.camera.kind === "available" ? source.camera.model : ""),
        );
    default: {
      const exhaustive: never = profile.compatibility;
      return exhaustive;
    }
  }
}

export function resolveInputProfile(
  source: SourceRecord,
  registry: readonly InputProfileDescriptor[],
  requestedProfileId?: string,
): InputProfileResolution {
  if (requestedProfileId !== undefined) {
    const requested = registry.find(
      (profile) => profile.reference.id === requestedProfileId,
    );
    if (!requested) {
      return {
        kind: "unsupported",
        neutralProfile: STANDARD_SRGB_INPUT_PROFILE,
        reason: `Input profile ${requestedProfileId} is not installed.`,
      };
    }
    if (!inputProfileIsCompatible(requested, source)) {
      return {
        kind: "unsupported",
        neutralProfile: STANDARD_SRGB_INPUT_PROFILE,
        reason: `Input profile ${requestedProfileId} is incompatible with this source.`,
      };
    }
    return { kind: "matched", profile: requested };
  }

  const declaredProfileId = source.inputProfile.kind === "available"
    ? source.inputProfile.profile.id
    : undefined;
  if (declaredProfileId !== undefined) {
    const declared = registry.find(
      (profile) => profile.reference.id === declaredProfileId,
    );
    if (declared && inputProfileIsCompatible(declared, source)) {
      return { kind: "matched", profile: declared };
    }
  }

  const decoderMatch = registry.find((profile) =>
    profile.provenance === "decoder-provided" &&
    inputProfileIsCompatible(profile, source),
  );
  if (decoderMatch) return { kind: "matched", profile: decoderMatch };

  if (sourceIsVerifiedSrgb(source)) {
    return {
      kind: "fallback",
      profile: STANDARD_SRGB_INPUT_PROFILE,
      reason: "The source is explicitly tagged as standard sRGB.",
    };
  }

  return {
    kind: "unsupported",
    neutralProfile: STANDARD_SRGB_INPUT_PROFILE,
    reason: "No compatible, verified input profile is available.",
  };
}

export function applyInputCalibration(
  rgb: Rgb,
  calibration: InputCalibration,
): Rgb {
  const matrix = calibration.matrixToLinearSrgb;
  const scale = calibration.channelScale;
  if (
    !matrixIsFinite(matrix) ||
    !scale.every((value) => Number.isFinite(value) && value > 0) ||
    !Number.isFinite(calibration.exposureOffsetEv)
  ) {
    return rgb;
  }
  const exposure = 2 ** bounded(calibration.exposureOffsetEv, -8, 8);
  if (
    matrix.every((value, index) => value === IDENTITY_MATRIX_3[index]) &&
    scale[0] === 1 &&
    scale[1] === 1 &&
    scale[2] === 1 &&
    exposure === 1
  ) {
    return rgb;
  }

  const red = finiteOr(rgb[0], 0) * bounded(scale[0], 0.0625, 16);
  const green = finiteOr(rgb[1], 0) * bounded(scale[1], 0.0625, 16);
  const blue = finiteOr(rgb[2], 0) * bounded(scale[2], 0.0625, 16);
  return [
    bounded((matrix[0] * red + matrix[1] * green + matrix[2] * blue) * exposure, -16, 16),
    bounded((matrix[3] * red + matrix[4] * green + matrix[5] * blue) * exposure, -16, 16),
    bounded((matrix[6] * red + matrix[7] * green + matrix[8] * blue) * exposure, -16, 16),
  ];
}
