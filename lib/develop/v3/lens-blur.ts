import {
  COORDINATE_FRAME_REVISION,
  type SemanticStageId,
  type V3SourceSignature,
} from "../process";
import type { GeometryPoint } from "./geometry";
import {
  parseDevelopAssetDescriptor,
  parseDevelopAssetRef,
  type DevelopAssetDescriptor,
  type DevelopAssetRef,
} from "./assets";
import {
  currentGeneratedJobCapability,
  type GeneratedJob,
} from "./generated-jobs";

export type DepthAssetRef = DevelopAssetRef & {
  readonly kind: "depth-map";
};

export type DepthAssetDescriptor = DevelopAssetDescriptor & {
  readonly kind: "depth-map";
};

export interface LensBlurValues {
  readonly focusDepth: number;
  readonly focusRange: number;
  readonly radius: number;
  readonly bokeh: number;
  readonly foreground: number;
  readonly background: number;
}

export interface LensBlurFocusSample {
  readonly point: GeometryPoint;
  readonly depth: number;
}

export type LensBlurSettings =
  | {
      readonly kind: "disabled";
      readonly values: LensBlurValues;
    }
  | {
      readonly kind: "enabled";
      readonly depthAsset: DepthAssetRef;
      readonly values: LensBlurValues;
    };

export const DEFAULT_LENS_BLUR_VALUES = {
  focusDepth: 0.5,
  focusRange: 0.2,
  radius: 0,
  bokeh: 0,
  foreground: 0,
  background: 0,
} as const satisfies LensBlurValues;

export const DEFAULT_LENS_BLUR_SETTINGS = {
  kind: "disabled",
  values: DEFAULT_LENS_BLUR_VALUES,
} as const satisfies LensBlurSettings;

export interface LensBlurAssetContext {
  readonly sourceSignature: V3SourceSignature;
  readonly coordinateFrameRevision: typeof COORDINATE_FRAME_REVISION;
  readonly colorStageId: SemanticStageId;
  readonly producerRevision: string;
  readonly descriptor: DepthAssetDescriptor | null;
}

export type LensBlurState =
  | { readonly kind: "disabled"; readonly reason: "user-disabled" }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "missing-depth"
        | "missing-asset"
        | "stale-source"
        | "stale-coordinate-frame"
        | "stale-color-stage"
        | "stale-producer"
        | "invalid-settings";
      readonly action:
        | "select-accepted-depth"
        | "repair-depth-reference"
        | "disable-lens-blur";
      readonly message: string;
    }
  | {
      readonly kind: "ready";
      readonly depthAsset: DepthAssetRef;
      readonly descriptor: DepthAssetDescriptor;
      readonly values: LensBlurValues;
    };

export type LensBlurEnableResult =
  | { readonly kind: "enabled"; readonly settings: LensBlurSettings }
  | {
      readonly kind: "unavailable";
      readonly reason: "missing-depth" | "invalid-settings";
      readonly action: "select-accepted-depth";
    };

export type DepthWorkflowState =
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly action: "select-accepted-depth";
    }
  | { readonly kind: "queued"; readonly jobId: string; readonly cancellable: true }
  | {
      readonly kind: "running";
      readonly jobId: string;
      readonly progress: number;
      readonly cancellable: true;
    }
  | {
      readonly kind: "review";
      readonly jobId: string;
      readonly candidateIds: readonly [string, ...string[]];
    }
  | {
      readonly kind: "retry";
      readonly jobId: string;
      readonly reason: string;
    }
  | { readonly kind: "complete"; readonly depthAssets: readonly DepthAssetRef[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseValues(value: unknown): LensBlurValues {
  if (!isRecord(value)) {
    throw new Error("Lens Blur values are invalid.");
  }
  return {
    focusDepth: boundedNumber(value.focusDepth, "Lens Blur focus depth", 0, 1),
    focusRange: boundedNumber(value.focusRange, "Lens Blur focus range", 0, 1),
    radius: boundedNumber(value.radius, "Lens Blur radius", 0, 100),
    bokeh: boundedNumber(value.bokeh, "Lens Blur bokeh", 0, 100),
    foreground: boundedNumber(value.foreground, "Lens Blur foreground", -100, 100),
    background: boundedNumber(value.background, "Lens Blur background", -100, 100),
  };
}

export function parseDepthAssetRef(value: unknown): DepthAssetRef {
  const reference = parseDevelopAssetRef(value);
  if (reference.kind !== "depth-map") {
    throw new Error("Lens Blur requires a depth asset reference.");
  }
  return { ...reference, kind: "depth-map" };
}

export function parseDepthAssetDescriptor(value: unknown): DepthAssetDescriptor {
  const descriptor = parseDevelopAssetDescriptor(value);
  if (descriptor.kind !== "depth-map") {
    throw new Error("Lens Blur requires a depth asset descriptor.");
  }
  return { ...descriptor, kind: "depth-map" };
}

export function parseLensBlurSettings(value: unknown): LensBlurSettings {
  if (!isRecord(value)) throw new Error("Lens Blur settings are invalid.");
  const values = parseValues(value.values);
  if (value.kind === "disabled") return { kind: "disabled", values };
  if (value.kind === "enabled") {
    return {
      kind: "enabled",
      depthAsset: parseDepthAssetRef(value.depthAsset),
      values,
    };
  }
  throw new Error("Lens Blur state is invalid.");
}

function sourceSignaturesEqual(
  left: V3SourceSignature,
  right: V3SourceSignature,
): boolean {
  return left.entryId === right.entryId &&
    left.catalogId === right.catalogId &&
    left.assetRevision === right.assetRevision &&
    left.relativePath === right.relativePath &&
    left.size === right.size &&
    left.lastModified === right.lastModified;
}

function refMatchesDescriptor(
  reference: DepthAssetRef,
  descriptor: DepthAssetDescriptor,
): boolean {
  return reference.assetId === descriptor.sha256 &&
    reference.sha256 === descriptor.sha256 &&
    reference.producerRevision === descriptor.producerRevision &&
    reference.coordinateFrameRevision === descriptor.coordinateFrameRevision &&
    reference.colorStageId === descriptor.colorStageId;
}

export function enableLensBlur(input: {
  readonly values: LensBlurValues;
  readonly depthAsset: DepthAssetRef | null;
}): LensBlurEnableResult {
  let values: LensBlurValues;
  try {
    values = parseValues(input.values);
  } catch {
    return {
      kind: "unavailable",
      reason: "invalid-settings",
      action: "select-accepted-depth",
    };
  }
  if (!input.depthAsset) {
    return {
      kind: "unavailable",
      reason: "missing-depth",
      action: "select-accepted-depth",
    };
  }
  try {
    return {
      kind: "enabled",
      settings: {
        kind: "enabled",
        depthAsset: parseDepthAssetRef(input.depthAsset),
        values,
      },
    };
  } catch {
    return {
      kind: "unavailable",
      reason: "invalid-settings",
      action: "select-accepted-depth",
    };
  }
}

export function applyLensBlurFocusSample(input: {
  readonly values: LensBlurValues;
  readonly sample: LensBlurFocusSample;
}): LensBlurValues | null {
  try {
    const values = parseValues(input.values);
    boundedNumber(input.sample.point.x, "Lens Blur sample x", 0, 1);
    boundedNumber(input.sample.point.y, "Lens Blur sample y", 0, 1);
    const focusDepth = boundedNumber(
      input.sample.depth,
      "Lens Blur sampled depth",
      0,
      1,
    );
    return { ...values, focusDepth };
  } catch {
    return null;
  }
}

export function resolveLensBlurState(
  settings: LensBlurSettings,
  context: LensBlurAssetContext,
): LensBlurState {
  let parsed: LensBlurSettings;
  try {
    parsed = parseLensBlurSettings(settings);
  } catch {
    return {
      kind: "unavailable",
      reason: "invalid-settings",
      action: "disable-lens-blur",
      message: "Lens Blur settings are invalid.",
    };
  }
  if (parsed.kind === "disabled") {
    return { kind: "disabled", reason: "user-disabled" };
  }
  if (!context.descriptor) {
    return {
      kind: "unavailable",
      reason: "missing-asset",
      action: "repair-depth-reference",
      message: "The accepted depth asset is missing.",
    };
  }
  let descriptor: DepthAssetDescriptor;
  try {
    descriptor = parseDepthAssetDescriptor(context.descriptor);
  } catch {
    return {
      kind: "unavailable",
      reason: "missing-depth",
      action: "select-accepted-depth",
      message: "The selected asset is not a valid depth map.",
    };
  }
  if (!refMatchesDescriptor(parsed.depthAsset, descriptor)) {
    return {
      kind: "unavailable",
      reason: "missing-asset",
      action: "repair-depth-reference",
      message: "The depth reference does not match the stored asset.",
    };
  }
  if (!sourceSignaturesEqual(descriptor.sourceSignature, context.sourceSignature)) {
    return {
      kind: "unavailable",
      reason: "stale-source",
      action: "select-accepted-depth",
      message: "The depth asset belongs to an older source revision.",
    };
  }
  if (
    descriptor.coordinateFrameRevision !== context.coordinateFrameRevision ||
    parsed.depthAsset.coordinateFrameRevision !== context.coordinateFrameRevision
  ) {
    return {
      kind: "unavailable",
      reason: "stale-coordinate-frame",
      action: "select-accepted-depth",
      message: "The depth asset uses an older coordinate frame.",
    };
  }
  if (
    descriptor.colorStageId !== context.colorStageId ||
    parsed.depthAsset.colorStageId !== context.colorStageId
  ) {
    return {
      kind: "unavailable",
      reason: "stale-color-stage",
      action: "select-accepted-depth",
      message: "The depth asset uses an older color-stage input.",
    };
  }
  if (
    descriptor.producerRevision !== context.producerRevision ||
    parsed.depthAsset.producerRevision !== context.producerRevision
  ) {
    return {
      kind: "unavailable",
      reason: "stale-producer",
      action: "select-accepted-depth",
      message: "The depth asset uses an older producer revision.",
    };
  }
  return {
    kind: "ready",
    depthAsset: parsed.depthAsset,
    descriptor,
    values: parsed.values,
  };
}

export function depthWorkflowState(job: GeneratedJob | null): DepthWorkflowState {
  if (!job) {
    const capability = currentGeneratedJobCapability("depth");
    switch (capability.kind) {
      case "disabled":
        return {
          kind: "unavailable",
          reason: capability.reason,
          action: "select-accepted-depth",
        };
      case "available":
        return {
          kind: "unavailable",
          reason: "No depth job has started.",
          action: "select-accepted-depth",
        };
      case "manual-cleanup":
        return {
          kind: "unavailable",
          reason: capability.reason,
          action: "select-accepted-depth",
        };
      default: {
        const exhaustive: never = capability;
        return exhaustive;
      }
    }
  }
  if (job.jobKind !== "depth") {
    return {
      kind: "unavailable",
      reason: "The current generated job does not produce depth.",
      action: "select-accepted-depth",
    };
  }
  switch (job.status) {
    case "queued":
      return { kind: "queued", jobId: job.id, cancellable: true };
    case "running":
      return {
        kind: "running",
        jobId: job.id,
        progress: job.progress,
        cancellable: true,
      };
    case "candidate": {
      const candidateIds = job.candidates.map((candidate) => candidate.candidateId);
      const first = candidateIds[0];
      return first
        ? { kind: "review", jobId: job.id, candidateIds: [first, ...candidateIds.slice(1)] }
        : {
            kind: "retry",
            jobId: job.id,
            reason: "The depth candidate is missing.",
          };
    }
    case "failed":
      return { kind: "retry", jobId: job.id, reason: job.error.message };
    case "cancelled":
      return { kind: "retry", jobId: job.id, reason: "Depth generation was cancelled." };
    case "rejected":
      return { kind: "retry", jobId: job.id, reason: "The depth candidate was rejected." };
    case "stale":
      return { kind: "retry", jobId: job.id, reason: "The depth candidate is stale." };
    case "accepted":
      return {
        kind: "complete",
        depthAssets: job.assetRefs.flatMap((reference) => {
          if (reference.kind !== "depth-map") return [];
          const depthAsset: DepthAssetRef = { ...reference, kind: "depth-map" };
          return [depthAsset];
        }),
      };
    default: {
      const exhaustive: never = job;
      return exhaustive;
    }
  }
}
