import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  type AnalysisTapId,
  type DevelopCapabilityReport,
  type DevelopDiagnostic,
  type PixelDimensions,
  type SemanticStageId,
  type SourceRecord,
  type TransferFunction,
} from "../process";
import {
  parseSha256Digest,
  type BlockingDevelopDiagnostic,
  type RenderOutputIntent,
  type RenderQualityRequest,
  type RenderRequest,
  type Sha256Digest,
} from "../render-contract";
import {
  analyzeDisplayOutput,
  analyzeSceneHeadroom,
  type AnalysisState,
  type DisplayAnalysis,
  type HdrHeadroomResult,
} from "./analysis";
import { proposeAutoTone, type AutoToneProposal } from "./auto-tone";
import { cacheKeyMaterial, frameClassForPlan, planCacheKey } from "./cache";
import { applyColorGrading } from "./color-grading";
import {
  compileV3DevelopPlan,
  type CompiledV3Plan,
  type CompilerValidationIssue,
} from "./compiler";
import {
  applyDevelopSharpeningPixel,
} from "./detail";
import type { DevelopDocumentV3 } from "./document";
import {
  IDENTITY_HOMOGRAPHY,
  mapOutputToStored,
  resolveConstrainedCrop,
  type CanonicalGeometry,
  type GeometryCrop,
  type GeometryPoint,
} from "./geometry";
import { applyMonochrome, NEUTRAL_MONOCHROME_PROFILE } from "./monochrome";
import {
  applyHueBoundedDefringe,
  NEUTRAL_LENS_CALIBRATION,
  type LensCalibration,
} from "./optics";
import {
  applyPointColor,
  hslToRgb,
  rgbToHsl,
} from "./point-color";
import {
  applyClarityPixel,
  applyDehazePixel,
  applyTexturePixel,
  type ReadonlyRgbImage,
} from "./presence";
import { applyInputCalibration, type Rgb } from "./profiles";
import { MAX_TILE_OVERLAP, type CancellationProbe } from "./source";
import { applyWhiteBalance } from "./white-balance";

export const V3_CPU_BACKEND_ID = "darkroom-v3-cpu-reference";
export const V3_CPU_BACKEND_REVISION = "1";
export const MAX_CPU_RENDER_PIXELS = 8_388_608;
export const MAX_CPU_EXPORT_PIXELS = 50_000_000;
const MAX_CPU_TILE_CORE_EDGE = 1_024;

export type CpuBackendDiagnostic =
  | DevelopDiagnostic
  | {
      readonly kind: "source-precision-reduced";
      readonly category: "precision";
      readonly sourceBits: 10 | 12 | 14 | 16;
      readonly outputBits: 8;
    }
  | {
      readonly kind: "edit-disabled";
      readonly category: "edit";
      readonly stageId: SemanticStageId;
      readonly componentId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "analysis-unavailable";
      readonly category: "analysis";
      readonly tap: AnalysisTapId;
      readonly reason: string;
    }
  | {
      readonly kind: "stored-profile-calibration-applied";
      readonly category: "color";
      readonly profileId: string;
      readonly profileRevision: string;
      readonly assumption: "validated-stored-matrix";
    };

export type CpuBackendBlockingDiagnostic =
  | BlockingDevelopDiagnostic
  | {
      readonly kind: "source-pixels-invalid";
      readonly category: "source";
      readonly reason: string;
    }
  | {
      readonly kind: "source-transfer-unavailable";
      readonly category: "color";
      readonly transfer: string;
    }
  | {
      readonly kind: "output-transform-unavailable";
      readonly category: "output";
      readonly reason: string;
    }
  | {
      readonly kind: "profile-transform-unavailable";
      readonly category: "color";
      readonly profileId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "edit-unsupported";
      readonly category: "edit";
      readonly stageId: SemanticStageId;
      readonly componentId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "cpu-render-capacity-exceeded";
      readonly category: "output";
      readonly requestedPixels: number;
      readonly maximumPixels: number;
    }
  | {
      readonly kind: "cpu-stage-halo-exceeded";
      readonly category: "output";
      readonly requestedHalo: number;
      readonly maximumHalo: number;
    }
  | {
      readonly kind: "fingerprint-unavailable";
      readonly category: "output";
      readonly reason: string;
    };

export type CpuBackendValidationIssue =
  | CompilerValidationIssue
  | { readonly kind: "backend-identity-mismatch"; readonly reason: string }
  | { readonly kind: "document-hash-mismatch" }
  | { readonly kind: "plan-key-invalid"; readonly reason: string };

export interface ToneInputAnalysis {
  readonly displayStatistics: DisplayAnalysis;
  readonly autoTone: AutoToneProposal;
}

export type CpuAnalysisTapResult =
  | {
      readonly tap: "tone-input";
      readonly state: AnalysisState<ToneInputAnalysis>;
    }
  | {
      readonly tap: "display-output";
      readonly state: AnalysisState<DisplayAnalysis>;
    }
  | {
      readonly tap: "scene-headroom";
      readonly state: AnalysisState<HdrHeadroomResult>;
    }
  | {
      readonly tap: "wb-sample" | "proof-output";
      readonly state: AnalysisState<never>;
    };

export interface CpuFrameIdentity {
  readonly frameClass: ReturnType<typeof frameClassForPlan>;
  readonly quality: RenderQualityRequest;
}

export type CpuRenderResult =
  | {
      readonly kind: "rendered";
      readonly planFingerprint: Sha256Digest;
      readonly frameIdentity: CpuFrameIdentity;
      readonly dimensions: PixelDimensions;
      readonly pixels: { readonly kind: "rgba8"; readonly pixels: Uint8Array };
      readonly diagnostics: readonly CpuBackendDiagnostic[];
      readonly analysis: readonly CpuAnalysisTapResult[];
    }
  | {
      readonly kind: "blocked";
      readonly diagnostics: readonly [
        CpuBackendBlockingDiagnostic,
        ...CpuBackendBlockingDiagnostic[],
      ];
    }
  | {
      readonly kind: "invalid";
      readonly issues: readonly [CpuBackendValidationIssue, ...CpuBackendValidationIssue[]];
    }
  | { readonly kind: "cancelled" };

export interface CpuAssetAvailability {
  readonly hasAsset: (assetId: string) => boolean;
}

export interface CpuRenderInput {
  readonly image: DevelopImage;
  readonly document: DevelopDocumentV3;
  readonly source: SourceRecord;
  readonly request: RenderRequest;
  readonly capabilities: DevelopCapabilityReport;
  readonly cancellation?: CancellationProbe;
  readonly assets?: CpuAssetAvailability;
}

interface FloatRgbImage extends ReadonlyRgbImage {
  readonly channels: 3;
  readonly data: Float32Array;
}

interface GeometryRenderResult {
  readonly image: FloatRgbImage;
  readonly alpha: Uint8Array;
}

interface RenderRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const MIXER_BANDS = [
  { id: "red", center: 0 },
  { id: "orange", center: 30 },
  { id: "yellow", center: 60 },
  { id: "green", center: 120 },
  { id: "aqua", center: 180 },
  { id: "blue", center: 240 },
  { id: "purple", center: 270 },
  { id: "magenta", center: 300 },
] as const;

const CHECKPOINT_ROW_INTERVAL = 16;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  if (minimum === maximum) return value < minimum ? 0 : 1;
  const position = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return position * position * (3 - 2 * position);
}

function cancelled(probe: CancellationProbe | undefined): boolean {
  return probe?.isCancelled() ?? false;
}

function outputIsExport(quality: RenderQualityRequest): boolean {
  return quality.kind === "export";
}

function nonEmptyBlocking(
  diagnostics: readonly CpuBackendBlockingDiagnostic[],
): readonly [CpuBackendBlockingDiagnostic, ...CpuBackendBlockingDiagnostic[]] | null {
  const first = diagnostics[0];
  return first ? [first, ...diagnostics.slice(1)] : null;
}

function sourceTransfer(source: SourceRecord): TransferFunction | null {
  switch (source.color.kind) {
    case "profiled":
    case "decoder-provided":
      return source.color.transfer;
    case "uncharacterized":
      return null;
    default: {
      const exhaustive: never = source.color;
      return exhaustive;
    }
  }
}

function transferLabel(transfer: TransferFunction | null): string {
  if (!transfer) return "uncharacterized";
  return transfer.kind === "unknown" ? `unknown:${transfer.label}` : transfer.kind;
}

function transferIsSupported(transfer: TransferFunction | null): boolean {
  return transfer?.kind === "linear" ||
    transfer?.kind === "srgb" ||
    transfer?.kind === "gamma";
}

function srgbToLinear(value: number): number {
  const bounded = clamp(value, 0, 1);
  return bounded <= 0.04045
    ? bounded / 12.92
    : ((bounded + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const bounded = clamp(value, 0, 1);
  return bounded <= 0.0031308
    ? bounded * 12.92
    : 1.055 * bounded ** (1 / 2.4) - 0.055;
}

function decodeTransfer(value: number, transfer: TransferFunction): number {
  switch (transfer.kind) {
    case "linear": return clamp(value, 0, 1);
    case "srgb": return srgbToLinear(value);
    case "gamma": return clamp(value, 0, 1) ** clamp(transfer.exponent, 0.1, 10);
    case "pq":
    case "hlg":
    case "unknown":
      return 0;
    default: {
      const exhaustive: never = transfer;
      return exhaustive;
    }
  }
}

function standardSrgbProfileId(id: string): boolean {
  const normalized = id.trim().toLocaleLowerCase();
  return normalized === "srgb" ||
    normalized === "iec-61966-2-1" ||
    normalized === "darkroom-standard-srgb";
}

function sourceColorIsSupported(input: CpuRenderInput): CpuBackendBlockingDiagnostic | null {
  const transfer = sourceTransfer(input.source);
  if (!transferIsSupported(transfer)) {
    return {
      kind: "source-transfer-unavailable",
      category: "color",
      transfer: transferLabel(transfer),
    };
  }
  if (input.document.color.inputProfile.selection.kind === "selected") return null;
  switch (input.source.color.kind) {
    case "profiled":
      return standardSrgbProfileId(input.source.color.profile.id)
        ? null
        : {
            kind: "profile-transform-unavailable",
            category: "color",
            profileId: input.source.color.profile.id,
            reason: "The CPU backend has no verified transform for this source profile.",
          };
    case "decoder-provided":
      return standardSrgbProfileId(input.source.color.decoderColorSpace)
        ? null
        : {
            kind: "profile-transform-unavailable",
            category: "color",
            profileId: input.source.color.decoderColorSpace,
            reason: "The decoder color space is not verified as linear sRGB or standard sRGB.",
          };
    case "uncharacterized":
      return {
        kind: "profile-transform-unavailable",
        category: "color",
        profileId: "uncharacterized",
        reason: input.source.color.reason,
      };
    default: {
      const exhaustive: never = input.source.color;
      return exhaustive;
    }
  }
}

function effectiveOutput(plan: CompiledV3Plan): RenderOutputIntent | null {
  for (const stage of plan.stages) {
    if (stage.parameters.kind === "output-or-proof-transform") {
      return stage.parameters.effective;
    }
  }
  return null;
}

function outputBlockingDiagnostic(
  output: RenderOutputIntent | null,
): CpuBackendBlockingDiagnostic | null {
  if (!output) {
    return {
      kind: "output-transform-unavailable",
      category: "output",
      reason: "The compiled plan has no output transform.",
    };
  }
  if (output.kind === "export-hdr") {
    return {
      kind: "hdr-output-blocked",
      category: "output",
      requestedTransfer: output.transfer,
    };
  }
  if (output.kind === "preview-sdr") {
    if (output.proofView.kind === "enabled") {
      return {
        kind: "proof-transform-unavailable",
        category: "proof",
        profileId: output.proofView.profile.id,
      };
    }
    return standardSrgbProfileId(output.displayProfile.id)
      ? null
      : {
          kind: "output-transform-unavailable",
          category: "output",
          reason: `Display profile ${output.displayProfile.id} has no verified CPU transform.`,
        };
  }
  if (output.bitDepth !== 8) {
    return {
      kind: "high-bit-output-blocked",
      category: "output",
      requestedBits: output.bitDepth,
    };
  }
  if (output.transfer !== "srgb") {
    return {
      kind: "output-transform-unavailable",
      category: "output",
      reason: "The export gamma exponent is not present in the render intent.",
    };
  }
  return standardSrgbProfileId(output.outputProfile.id)
    ? null
    : {
        kind: "output-transform-unavailable",
        category: "output",
        reason: `Output profile ${output.outputProfile.id} has no verified CPU transform.`,
      };
}

function imageValidationError(image: DevelopImage, source: SourceRecord): string | null {
  if (
    !Number.isSafeInteger(image.sourceWidth) ||
    !Number.isSafeInteger(image.sourceHeight) ||
    image.sourceWidth !== source.dimensions.width ||
    image.sourceHeight !== source.dimensions.height
  ) {
    return "Decoded pixel dimensions do not match the source record.";
  }
  if (image.orientation !== source.orientation) {
    return "Decoded EXIF orientation does not match the source record.";
  }
  if (image.colors !== 3 && image.colors !== 4) {
    return "The CPU backend accepts only RGB or RGBA source components.";
  }
  const requiredComponents = image.sourceWidth * image.sourceHeight * image.colors;
  if (!Number.isSafeInteger(requiredComponents) || image.rgb.length < requiredComponents) {
    return "Decoded source pixels are incomplete.";
  }
  if (source.precision.kind !== "integer") {
    return "DevelopImage does not carry typed floating-point source pixels.";
  }
  if (image.bits !== source.precision.componentBits) {
    return "Decoded component depth does not match the source record.";
  }
  if (source.precision.storageBits === 8 && image.rgb instanceof Uint16Array) {
    return "An 8-bit source cannot use 16-bit storage.";
  }
  if (source.precision.storageBits === 16 && !(image.rgb instanceof Uint16Array)) {
    return "A high-bit source requires Uint16 storage.";
  }
  return null;
}

function documentUsesHdr(document: DevelopDocumentV3): boolean {
  return document.hdr.enabled;
}

function localAdjustmentIsNeutral(mask: DevelopDocumentV3["local"]["masks"][number]): boolean {
  return Object.values(mask.adjustments).every((value) => value === 0);
}

function assetPresent(input: CpuRenderInput, assetId: string): boolean {
  try {
    return input.assets?.hasAsset(assetId) ?? false;
  } catch {
    return false;
  }
}

function unsupportedEditDiagnostics(input: CpuRenderInput): {
  readonly notices: CpuBackendDiagnostic[];
  readonly blocking: CpuBackendBlockingDiagnostic[];
} {
  const notices: CpuBackendDiagnostic[] = [];
  const blocking: CpuBackendBlockingDiagnostic[] = [];
  const exporting = outputIsExport(input.request.plan.qualityAndDimensions);
  const reportUnsupported = (
    stageId: SemanticStageId,
    componentId: string,
    reason: string,
  ): void => {
    if (exporting) {
      blocking.push({
        kind: "edit-unsupported",
        category: "edit",
        stageId,
        componentId,
        reason,
      });
    } else {
      notices.push({
        kind: "edit-disabled",
        category: "edit",
        stageId,
        componentId,
        reason,
      });
    }
  };
  const reportMissing = (assetId: string, componentId: string): void => {
    const diagnostic = {
      kind: "missing-edit-asset" as const,
      category: "asset" as const,
      assetId,
      componentId,
    };
    if (exporting) blocking.push(diagnostic);
    else notices.push(diagnostic);
  };

  for (const mask of input.document.local.masks) {
    if (!mask.enabled || localAdjustmentIsNeutral(mask)) continue;
    reportUnsupported(
      "local-adjustments",
      mask.id,
      "The CPU reference backend has no v3 local-mask raster callback.",
    );
    for (const component of mask.components) {
      if (component.kind !== "ai") continue;
      if (!assetPresent(input, component.assetId)) {
        reportMissing(component.assetId, component.id);
      }
    }
  }

  for (const component of input.document.cleanup.components) {
    if (!component.enabled) continue;
    reportUnsupported(
      "source-repair",
      component.id,
      "The CPU reference backend has no cleanup pixel callback.",
    );
    if (
      component.kind === "repair" &&
      component.source.kind === "accepted-patch" &&
      !assetPresent(input, component.source.asset.assetId)
    ) {
      reportMissing(component.source.asset.assetId, component.id);
    }
  }

  if (input.document.lensBlur.kind === "enabled") {
    const values = input.document.lensBlur.values;
    const active = values.radius !== 0 || values.bokeh !== 0 ||
      values.foreground !== 0 || values.background !== 0;
    if (active) {
      reportUnsupported(
        "creative-spatial-effect",
        "lens-blur",
        "The CPU reference backend has no depth-map sampling callback.",
      );
      if (!assetPresent(input, input.document.lensBlur.depthAsset.assetId)) {
        reportMissing(input.document.lensBlur.depthAsset.assetId, "lens-blur");
      }
    }
  }
  return { notices, blocking };
}

function opticsNotice(document: DevelopDocumentV3): DevelopDiagnostic | null {
  const requestsProfile = document.optics.profile.kind !== "off" ||
    document.optics.amounts.distortion !== 0 ||
    document.optics.amounts.illumination !== 0 ||
    document.optics.amounts.lateralChromaticAberration !== 0;
  return requestsProfile
    ? {
        kind: "lens-profile-unavailable",
        category: "optics",
        reason: "The CPU backend has no lens calibration registry. Profile corrections stay neutral; manual distortion still applies.",
      }
    : null;
}

function activeStageHalo(input: CpuRenderInput): number {
  const scale = clamp(sourceScale(input), 1 / 64, 64);
  const presence = input.document.presence;
  const sharpening = input.document.detail.sharpening;
  let halo = 0;
  if (presence.texture !== 0) halo += Math.ceil(clamp(2 / scale, 0.25, 512));
  if (presence.clarity !== 0) halo += Math.ceil(clamp(16 / scale, 0.25, 512));
  if (presence.dehaze !== 0) halo += Math.ceil(clamp(32 / scale, 0.25, 512));
  if (sharpening.sharpening !== 0) {
    halo += Math.ceil(clamp(
      clamp(sharpening.sharpenRadius, 0.5, 3) / scale,
      0.25,
      192,
    ));
  }
  return halo;
}

function preflight(
  input: CpuRenderInput,
  plan: CompiledV3Plan,
): {
  readonly notices: CpuBackendDiagnostic[];
  readonly blocking: CpuBackendBlockingDiagnostic[];
} {
  const notices: CpuBackendDiagnostic[] = [...plan.diagnostics];
  const blocking: CpuBackendBlockingDiagnostic[] = [];
  const imageError = imageValidationError(input.image, input.source);
  if (imageError) {
    blocking.push({ kind: "source-pixels-invalid", category: "source", reason: imageError });
  }
  const sourceColorError = sourceColorIsSupported(input);
  if (sourceColorError) blocking.push(sourceColorError);
  const outputError = outputBlockingDiagnostic(effectiveOutput(plan));
  if (outputError) blocking.push(outputError);
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const pixelCount = dimensions.width * dimensions.height;
  const maximumPixels = outputIsExport(input.request.plan.qualityAndDimensions)
    ? MAX_CPU_EXPORT_PIXELS
    : MAX_CPU_RENDER_PIXELS;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > maximumPixels) {
    blocking.push({
      kind: "cpu-render-capacity-exceeded",
      category: "output",
      requestedPixels: pixelCount,
      maximumPixels,
    });
  }
  if (outputIsExport(input.request.plan.qualityAndDimensions)) {
    const halo = activeStageHalo(input);
    if (halo > MAX_TILE_OVERLAP) {
      blocking.push({
        kind: "cpu-stage-halo-exceeded",
        category: "output",
        requestedHalo: halo,
        maximumHalo: MAX_TILE_OVERLAP,
      });
    }
  }
  if (documentUsesHdr(input.document)) {
    blocking.push({
      kind: "edit-unsupported",
      category: "edit",
      stageId: "basic-tone",
      componentId: "hdr-edits",
      reason: "The RGBA8 CPU backend does not execute HDR editing values.",
    });
  }
  if (
    input.document.color.monochrome.enabled &&
    input.document.color.monochrome.profileId !== NEUTRAL_MONOCHROME_PROFILE.id
  ) {
    blocking.push({
      kind: "profile-transform-unavailable",
      category: "color",
      profileId: input.document.color.monochrome.profileId,
      reason: "Only the built-in neutral monochrome profile is verified.",
    });
  }
  if (input.source.precision.kind === "integer" && input.source.precision.componentBits !== 8) {
    notices.push({
      kind: "source-precision-reduced",
      category: "precision",
      sourceBits: input.source.precision.componentBits,
      outputBits: 8,
    });
  }
  if (input.document.color.inputProfile.selection.kind === "selected") {
    notices.push({
      kind: "stored-profile-calibration-applied",
      category: "color",
      profileId: input.document.color.inputProfile.selection.profileId,
      profileRevision: input.document.color.inputProfile.selection.profileRevision,
      assumption: "validated-stored-matrix",
    });
  }
  const optics = opticsNotice(input.document);
  if (optics && !notices.some((notice) => notice.kind === "lens-profile-unavailable")) {
    notices.push(optics);
  }
  const unsupported = unsupportedEditDiagnostics(input);
  notices.push(...unsupported.notices);
  blocking.push(...unsupported.blocking);
  return { notices, blocking };
}

function orientedDimensions(source: SourceRecord): PixelDimensions {
  return source.orientation >= 5
    ? { width: source.dimensions.height, height: source.dimensions.width }
    : source.dimensions;
}

function manualLensCalibration(document: DevelopDocumentV3): LensCalibration {
  return document.optics.manualDistortion === 0
    ? NEUTRAL_LENS_CALIBRATION
    : {
        distortion: {
          k1: clamp(document.optics.manualDistortion / 100, -1, 1),
          k2: 0,
          k3: 0,
        },
        illumination: { v1: 0, v2: 0 },
        lateralChromaticAberration: { red: 0, blue: 0 },
      };
}

function opticsStageGeometry(
  input: CpuRenderInput,
  calibration: LensCalibration,
): CanonicalGeometry {
  return {
    sourceWidth: input.source.dimensions.width,
    sourceHeight: input.source.dimensions.height,
    exifOrientation: input.source.orientation,
    optics: {
      calibration,
      amounts: {
        distortion: input.document.optics.manualDistortion === 0 ? 0 : 1,
        illumination: 0,
        lateralChromaticAberration: 0,
      },
    },
    orientation: {
      quarterTurns: 0,
      flipHorizontal: false,
      flipVertical: false,
      fineAngleDegrees: 0,
    },
    manualPerspective: IDENTITY_HOMOGRAPHY,
    upright: { enabled: false, matrix: IDENTITY_HOMOGRAPHY, revision: "none" },
    constrainCrop: false,
    crop: { enabled: false, x: 0, y: 0, width: 1, height: 1 },
  };
}

function userStageGeometry(
  document: DevelopDocumentV3,
  dimensions: PixelDimensions,
): CanonicalGeometry {
  return {
    sourceWidth: dimensions.width,
    sourceHeight: dimensions.height,
    exifOrientation: 1,
    optics: { calibration: NEUTRAL_LENS_CALIBRATION, amounts: {
      distortion: 0,
      illumination: 0,
      lateralChromaticAberration: 0,
    } },
    orientation: document.geometry.orientation,
    manualPerspective: document.geometry.manualPerspective.matrix,
    upright: document.geometry.upright,
    constrainCrop: document.geometry.constrainCrop,
    crop: document.geometry.crop,
  };
}

function maximumSourceValue(image: DevelopImage): number {
  return 2 ** image.bits - 1;
}

function readSourcePixel(
  input: CpuRenderInput,
  x: number,
  y: number,
  transfer: TransferFunction,
): Rgb {
  const boundedX = Math.max(0, Math.min(input.image.sourceWidth - 1, x));
  const boundedY = Math.max(0, Math.min(input.image.sourceHeight - 1, y));
  const offset = (boundedY * input.image.sourceWidth + boundedX) * input.image.colors;
  const maximum = maximumSourceValue(input.image);
  const decoded: Rgb = [
    decodeTransfer((input.image.rgb[offset] ?? 0) / maximum, transfer),
    decodeTransfer((input.image.rgb[offset + 1] ?? 0) / maximum, transfer),
    decodeTransfer((input.image.rgb[offset + 2] ?? 0) / maximum, transfer),
  ];
  return applyHueBoundedDefringe(
    applyInputCalibration(
      applyWhiteBalance(decoded, input.document.color.whiteBalance.resolved),
      input.document.color.inputProfile.calibration,
    ),
    input.document.optics.defringe,
  );
}

function interpolateRgb(
  topLeft: Rgb,
  topRight: Rgb,
  bottomLeft: Rgb,
  bottomRight: Rgb,
  fractionX: number,
  fractionY: number,
): Rgb {
  const channel = (index: 0 | 1 | 2): number => {
    const top = topLeft[index] + (topRight[index] - topLeft[index]) * fractionX;
    const bottom = bottomLeft[index] + (bottomRight[index] - bottomLeft[index]) * fractionX;
    return top + (bottom - top) * fractionY;
  };
  return [channel(0), channel(1), channel(2)];
}

function sampleSource(
  input: CpuRenderInput,
  point: GeometryPoint,
  transfer: TransferFunction,
): Rgb {
  const x = point.x * input.image.sourceWidth - 0.5;
  const y = (1 - point.y) * input.image.sourceHeight - 0.5;
  const x0 = Math.floor(clamp(x, 0, input.image.sourceWidth - 1));
  const y0 = Math.floor(clamp(y, 0, input.image.sourceHeight - 1));
  const x1 = Math.min(input.image.sourceWidth - 1, x0 + 1);
  const y1 = Math.min(input.image.sourceHeight - 1, y0 + 1);
  return interpolateRgb(
    readSourcePixel(input, x0, y0, transfer),
    readSourcePixel(input, x1, y0, transfer),
    readSourcePixel(input, x0, y1, transfer),
    readSourcePixel(input, x1, y1, transfer),
    clamp(x, 0, input.image.sourceWidth - 1) - x0,
    clamp(y, 0, input.image.sourceHeight - 1) - y0,
  );
}

function outputPoint(
  x: number,
  y: number,
  dimensions: PixelDimensions,
  quality: RenderQualityRequest,
  region: RenderRegion,
): GeometryPoint {
  const point = {
    x: (region.x + x + 0.5) / dimensions.width,
    y: 1 - (region.y + y + 0.5) / dimensions.height,
  };
  if (quality.kind !== "loupe") return point;
  return {
    x: quality.sourceCenter.x + (point.x - 0.5) / quality.zoom,
    y: quality.sourceCenter.y + (point.y - 0.5) / quality.zoom,
  };
}

function writeRgb(data: Float32Array, pixel: number, rgb: Rgb): void {
  const offset = pixel * 3;
  data[offset] = rgb[0];
  data[offset + 1] = rgb[1];
  data[offset + 2] = rgb[2];
}

function denoiseIsActive(document: DevelopDocumentV3): boolean {
  return document.detail.noiseReduction.noiseReduction !== 0 ||
    document.detail.noiseReduction.colorNoiseReduction !== 0;
}

function sampleOpticsStage(
  input: CpuRenderInput,
  point: GeometryPoint,
  transfer: TransferFunction,
  geometry: CanonicalGeometry,
  crop: GeometryCrop,
): Rgb | null {
  const bounded = { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
  const mapped = mapOutputToStored(bounded, geometry, crop);
  return mapped.kind === "mapped" && mapped.insideDestination
    ? sampleSource(input, mapped.point, transfer)
    : null;
}

function denoisedOpticsSample(
  input: CpuRenderInput,
  point: GeometryPoint,
  transfer: TransferFunction,
  geometry: CanonicalGeometry,
  crop: GeometryCrop,
): Rgb | null {
  const center = sampleOpticsStage(input, point, transfer, geometry, crop);
  if (!center || !denoiseIsActive(input.document)) return center;
  const settings = input.document.detail.noiseReduction;
  const luminanceAmount = clamp(settings.noiseReduction, 0, 100) / 100;
  const colorAmount = clamp(settings.colorNoiseReduction, 0, 100) / 100;
  const oriented = orientedDimensions(input.source);
  const radius = 1 + luminanceAmount * 2;
  const diagonal = radius * Math.SQRT1_2;
  const offsets: readonly (readonly [number, number])[] = [
    [0, 0],
    [radius, 0],
    [-radius, 0],
    [0, radius],
    [0, -radius],
    [diagonal, diagonal],
    [-diagonal, diagonal],
    [diagonal, -diagonal],
    [-diagonal, -diagonal],
  ];
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const offset of offsets) {
    const sample = sampleOpticsStage(input, {
      x: point.x + offset[0] / oriented.width,
      y: point.y - offset[1] / oriented.height,
    }, transfer, geometry, crop) ?? center;
    red += sample[0];
    green += sample[1];
    blue += sample[2];
  }
  const average: Rgb = [red / offsets.length, green / offsets.length, blue / offsets.length];
  const centerLuminance = luminance(center);
  const averageLuminance = luminance(average);
  const edge = Math.abs(centerLuminance - averageLuminance);
  const contrastThreshold = 0.005 + clamp(settings.noiseContrast, 0, 100) / 500;
  const edgeProtection = clamp(edge / contrastThreshold, 0, 1);
  const luminanceMix = luminanceAmount *
    (1 - edgeProtection * clamp(settings.noiseDetail, 0, 100) / 100);
  const targetLuminance = centerLuminance +
    (averageLuminance - centerLuminance) * luminanceMix;
  const luminanceDelta = targetLuminance - centerLuminance;
  const colorMix = colorAmount *
    (0.5 + clamp(settings.colorNoiseSmoothness, 0, 100) / 200) *
    (1 - edgeProtection * clamp(settings.colorNoiseDetail, 0, 100) / 100);
  const channel = (index: 0 | 1 | 2): number => {
    const centerChroma = center[index] - centerLuminance;
    const averageChroma = average[index] - averageLuminance;
    const chroma = centerChroma + (averageChroma - centerChroma) * colorMix;
    return clamp(centerLuminance + luminanceDelta + chroma, 0, 16);
  };
  return [channel(0), channel(1), channel(2)];
}

function renderGeometry(
  input: CpuRenderInput,
  transfer: TransferFunction,
  region: RenderRegion,
): GeometryRenderResult | null {
  const outputDimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const oriented = orientedDimensions(input.source);
  const userGeometry = userStageGeometry(input.document, oriented);
  const opticsGeometry = opticsStageGeometry(input, manualLensCalibration(input.document));
  const userCrop = resolveConstrainedCrop(userGeometry);
  const opticsCrop = resolveConstrainedCrop(opticsGeometry);
  const pixelCount = region.width * region.height;
  const data = new Float32Array(pixelCount * 3);
  const alpha = new Uint8Array(pixelCount);
  for (let y = 0; y < region.height; y += 1) {
    if (y % CHECKPOINT_ROW_INTERVAL === 0 && cancelled(input.cancellation)) return null;
    for (let x = 0; x < region.width; x += 1) {
      const pixel = y * region.width + x;
      const userMapped = mapOutputToStored(
        outputPoint(
          x,
          y,
          outputDimensions,
          input.request.plan.qualityAndDimensions,
          region,
        ),
        userGeometry,
        userCrop,
      );
      if (userMapped.kind !== "mapped" || !userMapped.insideDestination) continue;
      const sample = denoisedOpticsSample(
        input,
        userMapped.point,
        transfer,
        opticsGeometry,
        opticsCrop,
      );
      if (!sample) continue;
      writeRgb(data, pixel, sample);
      alpha[pixel] = 255;
    }
  }
  return { image: { width: region.width, height: region.height, channels: 3, data }, alpha };
}

function luminance(rgb: Rgb): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function applyBasicTone(rgb: Rgb, document: DevelopDocumentV3): Rgb {
  const basic = document.tone.basic;
  const global = document.color.global;
  if (
    Object.values(basic).every((value) => value === 0) &&
    global.vibrance === 0 &&
    global.saturation === 0
  ) {
    return rgb;
  }
  const gain = 2 ** clamp(basic.exposure, -10, 10);
  let red = rgb[0] * gain;
  let green = rgb[1] * gain;
  let blue = rgb[2] * gain;
  const sourceLuminance = luminance([red, green, blue]);
  const shadowMask = smoothstep(0.7, 0, sourceLuminance);
  const highlightMask = smoothstep(0.35, 1, sourceLuminance);
  const common = shadowMask * basic.shadows * 0.0015 +
    highlightMask * basic.highlights * 0.0012 +
    smoothstep(0.72, 1, sourceLuminance) * basic.whites * 0.0012 +
    smoothstep(0.25, 0, sourceLuminance) * basic.blacks * 0.0012;
  const contrast = 1 + clamp(basic.contrast, -100, 100) * 0.0035;
  red = (red + common - 0.5) * contrast + 0.5;
  green = (green + common - 0.5) * contrast + 0.5;
  blue = (blue + common - 0.5) * contrast + 0.5;
  let result: Rgb = [red, green, blue];
  if (global.saturation !== 0) {
    const gray = luminance(result);
    const scale = Math.max(0, 1 + global.saturation / 100);
    result = [
      gray + (result[0] - gray) * scale,
      gray + (result[1] - gray) * scale,
      gray + (result[2] - gray) * scale,
    ];
  }
  if (global.vibrance !== 0) {
    const gray = luminance(result);
    const saturation = Math.max(...result) - Math.min(...result);
    const scale = Math.max(0, 1 + global.vibrance / 100 * (1 - clamp(saturation, 0, 1)));
    result = [
      gray + (result[0] - gray) * scale,
      gray + (result[1] - gray) * scale,
      gray + (result[2] - gray) * scale,
    ];
  }
  return [
    clamp(result[0], -16, 16),
    clamp(result[1], -16, 16),
    clamp(result[2], -16, 16),
  ];
}

function curveIsIdentity(points: DevelopDocumentV3["tone"]["curves"]["rgb"]): boolean {
  return points.every((point) => Math.abs(point.x - point.y) <= Number.EPSILON);
}

function sampleCurve(
  value: number,
  points: DevelopDocumentV3["tone"]["curves"]["rgb"],
): number {
  const bounded = clamp(value, 0, 1);
  const first = points[0];
  if (!first || bounded <= first.x) return first?.y ?? bounded;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    const left = points[index - 1];
    if (!right || !left || bounded > right.x) continue;
    const width = right.x - left.x;
    const amount = width <= 0 ? 0 : (bounded - left.x) / width;
    return left.y + (right.y - left.y) * amount;
  }
  return points[points.length - 1]?.y ?? bounded;
}

function applyCurves(rgb: Rgb, document: DevelopDocumentV3): Rgb {
  const curves = document.tone.curves;
  if (
    curveIsIdentity(curves.rgb) && curveIsIdentity(curves.red) &&
    curveIsIdentity(curves.green) && curveIsIdentity(curves.blue)
  ) {
    return rgb;
  }
  const master: Rgb = [
    sampleCurve(rgb[0], curves.rgb),
    sampleCurve(rgb[1], curves.rgb),
    sampleCurve(rgb[2], curves.rgb),
  ];
  return [
    sampleCurve(master[0], curves.red),
    sampleCurve(master[1], curves.green),
    sampleCurve(master[2], curves.blue),
  ];
}

function mixerIsNeutral(document: DevelopDocumentV3): boolean {
  return MIXER_BANDS.every(({ id }) => {
    const band = document.color.mixer[id];
    return band.hue === 0 && band.saturation === 0 && band.luminance === 0;
  });
}

function applyMixer(rgb: Rgb, document: DevelopDocumentV3): Rgb {
  if (mixerIsNeutral(document)) return rgb;
  const hsl = rgbToHsl(rgb);
  let hueShift = 0;
  let saturationScale = 1;
  let luminanceShift = 0;
  for (const { id, center } of MIXER_BANDS) {
    const difference = Math.abs(hsl.hueDegrees - center);
    const distance = Math.min(difference, 360 - difference);
    const weight = smoothstep(64.8, 0, distance);
    const band = document.color.mixer[id];
    hueShift += band.hue * weight;
    saturationScale += band.saturation * weight / 100;
    luminanceShift += band.luminance * weight * 0.005;
  }
  return hslToRgb({
    hueDegrees: hsl.hueDegrees + hueShift,
    saturation: hsl.saturation * saturationScale,
    luminance: hsl.luminance + luminanceShift,
  });
}

function applyCurveAndColor(rgb: Rgb, document: DevelopDocumentV3): Rgb {
  let result = applyCurves(rgb, document);
  result = applyPointColor(result, document.color.pointColor);
  result = applyMixer(result, document);
  result = applyMonochrome(
    result,
    document.color.monochrome,
    NEUTRAL_MONOCHROME_PROFILE,
  );
  return applyColorGrading(result, document.color.grading);
}

function applyPointwiseStages(
  input: CpuRenderInput,
  image: FloatRgbImage,
): boolean {
  for (let y = 0; y < image.height; y += 1) {
    if (y % CHECKPOINT_ROW_INTERVAL === 0 && cancelled(input.cancellation)) return false;
    for (let x = 0; x < image.width; x += 1) {
      const pixel = y * image.width + x;
      const offset = pixel * 3;
      const source: Rgb = [
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      ];
      writeRgb(
        image.data,
        pixel,
        applyCurveAndColor(applyBasicTone(source, input.document), input.document),
      );
    }
  }
  return true;
}

type SpatialPixelOperation = (
  image: FloatRgbImage,
  x: number,
  y: number,
  sourcePixelsPerInputPixel: number,
) => Rgb;

function applySpatialOperation(
  input: CpuRenderInput,
  source: FloatRgbImage,
  targetData: Float32Array,
  scale: number,
  operation: SpatialPixelOperation,
): FloatRgbImage | null {
  for (let y = 0; y < source.height; y += 1) {
    if (y % CHECKPOINT_ROW_INTERVAL === 0 && cancelled(input.cancellation)) return null;
    for (let x = 0; x < source.width; x += 1) {
      writeRgb(
        targetData,
        y * source.width + x,
        operation(source, x, y, scale),
      );
    }
  }
  return { width: source.width, height: source.height, channels: 3, data: targetData };
}

function sourceScale(input: CpuRenderInput): number {
  const oriented = orientedDimensions(input.source);
  const output = input.request.plan.qualityAndDimensions.outputDimensions;
  return Math.max(oriented.width / output.width, oriented.height / output.height);
}

function applyPresence(
  input: CpuRenderInput,
  initial: FloatRgbImage,
): FloatRgbImage | null {
  const settings = input.document.presence;
  if (settings.texture === 0 && settings.clarity === 0 && settings.dehaze === 0) {
    return initial;
  }
  const scale = sourceScale(input);
  let current = initial;
  let scratch: Float32Array = new Float32Array(initial.data.length);
  const run = (operation: SpatialPixelOperation): boolean => {
    const next = applySpatialOperation(input, current, scratch, scale, operation);
    if (!next) return false;
    scratch = current.data;
    current = next;
    return true;
  };
  if (settings.texture !== 0 && !run((image, x, y, pixelScale) =>
    applyTexturePixel(image, x, y, settings.texture, pixelScale))) return null;
  if (settings.clarity !== 0 && !run((image, x, y, pixelScale) =>
    applyClarityPixel(image, x, y, settings.clarity, pixelScale))) return null;
  if (settings.dehaze !== 0 && !run((image, x, y, pixelScale) =>
    applyDehazePixel(image, x, y, settings.dehaze, pixelScale))) return null;
  return current;
}

function applySharpening(
  input: CpuRenderInput,
  image: FloatRgbImage,
): FloatRgbImage | null {
  if (input.document.detail.sharpening.sharpening === 0) return image;
  const target = new Float32Array(image.data.length);
  return applySpatialOperation(
    input,
    image,
    target,
    sourceScale(input),
    (source, x, y, scale) => applyDevelopSharpeningPixel(
      source,
      x,
      y,
      input.document.detail.sharpening,
      scale,
    ),
  );
}

function noise01(x: number, y: number): number {
  let value = Math.imul(x + 1, 0x1f123bb5) ^ Math.imul(y + 1, 0x5f356495);
  value ^= value >>> 16;
  value = Math.imul(value, 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4_294_967_295;
}

function applyPostCrop(
  input: CpuRenderInput,
  image: FloatRgbImage,
  region: RenderRegion,
): boolean {
  const settings = input.document.effects.postCrop;
  if (settings.vignette === 0 && settings.grain === 0) return true;
  for (let y = 0; y < image.height; y += 1) {
    if (y % CHECKPOINT_ROW_INTERVAL === 0 && cancelled(input.cancellation)) return false;
    for (let x = 0; x < image.width; x += 1) {
      const pixel = y * image.width + x;
      const offset = pixel * 3;
      let color: Rgb = [
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      ];
      if (settings.vignette !== 0) {
        const output = input.request.plan.qualityAndDimensions.outputDimensions;
        const normalizedX = Math.abs(((region.x + x + 0.5) / output.width - 0.5) * 2);
        const normalizedY = Math.abs(((region.y + y + 0.5) / output.height - 0.5) * 2);
        const boxDistance = Math.max(normalizedX, normalizedY);
        const roundDistance = Math.hypot(normalizedX, normalizedY) * Math.SQRT1_2;
        const shapeMix = settings.vignetteRoundness * 0.005 + 0.5;
        const shape = boxDistance + (roundDistance - boxDistance) * shapeMix;
        const midpoint = 0.15 + 0.65 * settings.vignetteMidpoint / 100;
        const feather = Math.max(0.01, 0.03 + 0.72 * settings.vignetteFeather / 100);
        const edge = smoothstep(midpoint, midpoint + feather, shape);
        const protection = smoothstep(0.45, 1, luminance(color)) *
          settings.vignetteHighlights / 100;
        const mask = edge * (1 - protection);
        const darken = 1 - mask * Math.max(0, -settings.vignette) * 0.008;
        const lighten = mask * Math.max(0, settings.vignette) * 0.006;
        color = [
          color[0] * darken + lighten,
          color[1] * darken + lighten,
          color[2] * darken + lighten,
        ];
      }
      if (settings.grain !== 0) {
        const scale = 0.75 + 3.25 * settings.grainSize / 100;
        const globalX = region.x + x;
        const globalY = region.y + y;
        const fine = noise01(Math.floor(globalX / scale), Math.floor(globalY / scale));
        const coarse = noise01(Math.floor(globalX / scale / 2), Math.floor(globalY / scale / 2));
        const roughness = settings.grainRoughness / 100;
        const amount = (fine + (coarse - fine) * roughness - 0.5) *
          settings.grain * 0.004;
        color = [color[0] + amount, color[1] + amount, color[2] + amount];
      }
      writeRgb(image.data, pixel, color);
    }
  }
  return true;
}

function meanSaturation(image: FloatRgbImage): number {
  let sum = 0;
  const pixelCount = image.width * image.height;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 3;
    sum += rgbToHsl([
      image.data[offset] ?? 0,
      image.data[offset + 1] ?? 0,
      image.data[offset + 2] ?? 0,
    ]).saturation;
  }
  return pixelCount === 0 ? 0 : sum / pixelCount;
}

function toneInputAnalysis(image: FloatRgbImage): CpuAnalysisTapResult {
  const state = analyzeDisplayOutput({
    width: image.width,
    height: image.height,
    channels: 3,
    encoding: "unit-float",
    data: image.data,
  });
  if (state.kind !== "ready") return { tap: "tone-input", state };
  return {
    tap: "tone-input",
    state: {
      kind: "ready",
      value: {
        displayStatistics: state.value,
        autoTone: proposeAutoTone({
          kind: "histogram",
          luminanceBins: state.value.histogram.luminance,
          pixelCount: state.value.pixelCount,
          meanSaturation: meanSaturation(image),
        }),
      },
    },
  };
}

function sceneHeadroomAnalysis(image: FloatRgbImage): CpuAnalysisTapResult {
  const pixelCount = image.width * image.height;
  const values = new Float32Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 3;
    values[pixel] = Math.max(0, luminance([
      image.data[offset] ?? 0,
      image.data[offset + 1] ?? 0,
      image.data[offset + 2] ?? 0,
    ]));
  }
  return {
    tap: "scene-headroom",
    state: { kind: "ready", value: analyzeSceneHeadroom({ luminance: values }) },
  };
}

function encodeRgba8(
  input: CpuRenderInput,
  image: FloatRgbImage,
  alpha: Uint8Array,
): Uint8Array | null {
  const pixels = new Uint8Array(image.width * image.height * 4);
  for (let y = 0; y < image.height; y += 1) {
    if (y % CHECKPOINT_ROW_INTERVAL === 0 && cancelled(input.cancellation)) return null;
    for (let x = 0; x < image.width; x += 1) {
      const pixel = y * image.width + x;
      const sourceOffset = pixel * 3;
      const targetOffset = pixel * 4;
      pixels[targetOffset] = Math.round(linearToSrgb(image.data[sourceOffset] ?? 0) * 255);
      pixels[targetOffset + 1] = Math.round(linearToSrgb(image.data[sourceOffset + 1] ?? 0) * 255);
      pixels[targetOffset + 2] = Math.round(linearToSrgb(image.data[sourceOffset + 2] ?? 0) * 255);
      pixels[targetOffset + 3] = alpha[pixel] ?? 0;
    }
  }
  return pixels;
}

interface ExecutedRegion {
  readonly scene: FloatRgbImage;
  readonly pixels: Uint8Array;
}

function executeRegion(
  input: CpuRenderInput,
  transfer: TransferFunction,
  region: RenderRegion,
  beforeTone?: (image: FloatRgbImage) => void,
): ExecutedRegion | null {
  const geometry = renderGeometry(input, transfer, region);
  if (!geometry) return null;
  beforeTone?.(geometry.image);
  if (!applyPointwiseStages(input, geometry.image)) return null;
  const presence = applyPresence(input, geometry.image);
  if (!presence) return null;
  const sharpened = applySharpening(input, presence);
  if (!sharpened) return null;
  if (!applyPostCrop(input, sharpened, region)) return null;
  const pixels = encodeRgba8(input, sharpened, geometry.alpha);
  return pixels ? { scene: sharpened, pixels } : null;
}

interface ToneAccumulator {
  readonly red: number[];
  readonly green: number[];
  readonly blue: number[];
  readonly luminance: number[];
  pixelCount: number;
  redShadows: number;
  redHighlights: number;
  greenShadows: number;
  greenHighlights: number;
  blueShadows: number;
  blueHighlights: number;
  saturationSum: number;
}

function createToneAccumulator(): ToneAccumulator {
  return {
    red: Array<number>(256).fill(0),
    green: Array<number>(256).fill(0),
    blue: Array<number>(256).fill(0),
    luminance: Array<number>(256).fill(0),
    pixelCount: 0,
    redShadows: 0,
    redHighlights: 0,
    greenShadows: 0,
    greenHighlights: 0,
    blueShadows: 0,
    blueHighlights: 0,
    saturationSum: 0,
  };
}

function accumulateTone(
  accumulator: ToneAccumulator,
  image: FloatRgbImage,
  renderedRegion: RenderRegion,
  core: RenderRegion,
): void {
  const startX = core.x - renderedRegion.x;
  const startY = core.y - renderedRegion.y;
  for (let y = 0; y < core.height; y += 1) {
    for (let x = 0; x < core.width; x += 1) {
      const offset = ((startY + y) * image.width + startX + x) * 3;
      const color: Rgb = [
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      ];
      const red = color[0];
      const green = color[1];
      const blue = color[2];
      if (red <= 0) accumulator.redShadows += 1;
      if (red >= 1) accumulator.redHighlights += 1;
      if (green <= 0) accumulator.greenShadows += 1;
      if (green >= 1) accumulator.greenHighlights += 1;
      if (blue <= 0) accumulator.blueShadows += 1;
      if (blue >= 1) accumulator.blueHighlights += 1;
      const redIndex = Math.min(255, Math.floor(clamp(red, 0, 1) * 256));
      const greenIndex = Math.min(255, Math.floor(clamp(green, 0, 1) * 256));
      const blueIndex = Math.min(255, Math.floor(clamp(blue, 0, 1) * 256));
      const luminanceValue = clamp(luminance(color), 0, 1);
      const luminanceIndex = Math.min(255, Math.floor(luminanceValue * 256));
      accumulator.red[redIndex] += 1;
      accumulator.green[greenIndex] += 1;
      accumulator.blue[blueIndex] += 1;
      accumulator.luminance[luminanceIndex] += 1;
      accumulator.saturationSum += rgbToHsl(color).saturation;
      accumulator.pixelCount += 1;
    }
  }
}

function channelClipping(shadows: number, highlights: number) {
  return {
    shadows,
    highlights,
    hasShadowClipping: shadows > 0,
    hasHighlightClipping: highlights > 0,
  };
}

function finishToneAccumulator(accumulator: ToneAccumulator): CpuAnalysisTapResult {
  const displayStatistics: DisplayAnalysis = {
    pixelCount: accumulator.pixelCount,
    binCount: 256,
    histogram: {
      red: accumulator.red,
      green: accumulator.green,
      blue: accumulator.blue,
      luminance: accumulator.luminance,
    },
    clipping: {
      red: channelClipping(accumulator.redShadows, accumulator.redHighlights),
      green: channelClipping(accumulator.greenShadows, accumulator.greenHighlights),
      blue: channelClipping(accumulator.blueShadows, accumulator.blueHighlights),
    },
  };
  return {
    tap: "tone-input",
    state: {
      kind: "ready",
      value: {
        displayStatistics,
        autoTone: proposeAutoTone({
          kind: "histogram",
          luminanceBins: accumulator.luminance,
          pixelCount: accumulator.pixelCount,
          meanSaturation: accumulator.pixelCount === 0
            ? 0
            : accumulator.saturationSum / accumulator.pixelCount,
        }),
      },
    },
  };
}

interface HeadroomAccumulator {
  readonly bins: number[];
  count: number;
  maximum: number;
}

function createHeadroomAccumulator(): HeadroomAccumulator {
  return { bins: Array<number>(2_048).fill(0), count: 0, maximum: 0 };
}

function accumulateHeadroom(
  accumulator: HeadroomAccumulator,
  image: FloatRgbImage,
  renderedRegion: RenderRegion,
  core: RenderRegion,
): void {
  const startX = core.x - renderedRegion.x;
  const startY = core.y - renderedRegion.y;
  for (let y = 0; y < core.height; y += 1) {
    for (let x = 0; x < core.width; x += 1) {
      const offset = ((startY + y) * image.width + startX + x) * 3;
      const value = Math.max(0, luminance([
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
      ]));
      accumulator.maximum = Math.max(accumulator.maximum, value);
      const bin = Math.min(2_047, Math.floor(clamp(value, 0, 64) / 64 * 2_048));
      accumulator.bins[bin] += 1;
      accumulator.count += 1;
    }
  }
}

function finishHeadroomAccumulator(accumulator: HeadroomAccumulator): CpuAnalysisTapResult {
  if (accumulator.count === 0) {
    return {
      tap: "scene-headroom",
      state: { kind: "ready", value: { kind: "unavailable", reason: "The scene-headroom tap is empty." } },
    };
  }
  const target = accumulator.count * 0.99;
  let total = 0;
  let percentile99 = accumulator.maximum;
  for (let index = 0; index < accumulator.bins.length; index += 1) {
    total += accumulator.bins[index] ?? 0;
    if (total >= target) {
      percentile99 = (index + 0.5) / 2_048 * 64;
      break;
    }
  }
  return {
    tap: "scene-headroom",
    state: {
      kind: "ready",
      value: {
        kind: "available",
        maximumLinear: accumulator.maximum,
        percentile99Linear: percentile99,
        maximumStopsAboveSdr: Math.max(0, Math.log2(Math.max(1, accumulator.maximum))),
        percentile99StopsAboveSdr: Math.max(0, Math.log2(Math.max(1, percentile99))),
        sampleCount: accumulator.count,
      },
    },
  };
}

function expandedRegion(
  core: RenderRegion,
  dimensions: PixelDimensions,
  halo: number,
): RenderRegion {
  const x = Math.max(0, core.x - halo);
  const y = Math.max(0, core.y - halo);
  const right = Math.min(dimensions.width, core.x + core.width + halo);
  const bottom = Math.min(dimensions.height, core.y + core.height + halo);
  return { x, y, width: right - x, height: bottom - y };
}

function copyCorePixels(
  destination: Uint8Array,
  source: Uint8Array,
  renderedRegion: RenderRegion,
  core: RenderRegion,
  outputWidth: number,
): void {
  const sourceX = core.x - renderedRegion.x;
  const sourceY = core.y - renderedRegion.y;
  for (let y = 0; y < core.height; y += 1) {
    const sourceOffset = ((sourceY + y) * renderedRegion.width + sourceX) * 4;
    const targetOffset = ((core.y + y) * outputWidth + core.x) * 4;
    destination.set(
      source.subarray(sourceOffset, sourceOffset + core.width * 4),
      targetOffset,
    );
  }
}

function displayAnalysis(pixels: Uint8Array, dimensions: PixelDimensions): CpuAnalysisTapResult {
  return {
    tap: "display-output",
    state: analyzeDisplayOutput({
      width: dimensions.width,
      height: dimensions.height,
      channels: 4,
      encoding: "uint8",
      data: pixels,
    }),
  };
}

function unavailableAnalysis(tap: "wb-sample" | "proof-output"): CpuAnalysisTapResult {
  return {
    tap,
    state: {
      kind: "unavailable",
      reason: tap === "wb-sample"
        ? "WB sampling requires an explicit canonical sample region."
        : "The CPU backend has no verified proof transform.",
    },
  };
}

function hexDigest(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(material: string): Promise<Sha256Digest | null> {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(material);
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return parseSha256Digest(hexDigest(digest));
}

function backendIdentityIssue(request: RenderRequest): CpuBackendValidationIssue | null {
  const backend = request.plan.backend;
  if (
    backend.kind !== "v3" ||
    backend.id !== V3_CPU_BACKEND_ID ||
    backend.revision !== V3_CPU_BACKEND_REVISION
  ) {
    return {
      kind: "backend-identity-mismatch",
      reason: `Expected ${V3_CPU_BACKEND_ID}@${V3_CPU_BACKEND_REVISION}.`,
    };
  }
  return null;
}

function planKeyIssue(request: RenderRequest): {
  readonly issue: CpuBackendValidationIssue | null;
  readonly material: string | null;
} {
  const result = cacheKeyMaterial(planCacheKey(request.plan));
  switch (result.kind) {
    case "key": return { issue: null, material: result.material };
    case "invalid": return {
      issue: { kind: "plan-key-invalid", reason: result.reason },
      material: null,
    };
    case "too-large": return {
      issue: {
        kind: "plan-key-invalid",
        reason: `Plan identity is ${result.byteLength} bytes and exceeds the cache-key bound.`,
      },
      material: null,
    };
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function requestedAnalysis(
  input: CpuRenderInput,
  toneInput: CpuAnalysisTapResult | null,
  sceneImage: FloatRgbImage,
  outputPixels: Uint8Array,
): CpuAnalysisTapResult[] {
  const results: CpuAnalysisTapResult[] = [];
  for (const tap of input.request.requestedTaps) {
    switch (tap) {
      case "tone-input":
        if (toneInput) results.push(toneInput);
        break;
      case "display-output":
        results.push(displayAnalysis(
          outputPixels,
          input.request.plan.qualityAndDimensions.outputDimensions,
        ));
        break;
      case "scene-headroom":
        results.push(sceneHeadroomAnalysis(sceneImage));
        break;
      case "wb-sample":
      case "proof-output":
        results.push(unavailableAnalysis(tap));
        break;
      default: {
        const exhaustive: never = tap;
        return exhaustive;
      }
    }
  }
  return results;
}

interface RenderedPixelsAndAnalysis {
  readonly pixels: Uint8Array;
  readonly analysis: readonly CpuAnalysisTapResult[];
}

function renderFullFrame(
  input: CpuRenderInput,
  transfer: TransferFunction,
): RenderedPixelsAndAnalysis | null {
  const dimensions = input.request.plan.qualityAndDimensions.outputDimensions;
  const region = { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
  let toneInput: CpuAnalysisTapResult | null = null;
  const executed = executeRegion(
    input,
    transfer,
    region,
    input.request.requestedTaps.includes("tone-input")
      ? (image) => { toneInput = toneInputAnalysis(image); }
      : undefined,
  );
  if (!executed) return null;
  return {
    pixels: executed.pixels,
    analysis: requestedAnalysis(input, toneInput, executed.scene, executed.pixels),
  };
}

function renderTiledExport(
  input: CpuRenderInput,
  transfer: TransferFunction,
): RenderedPixelsAndAnalysis | null {
  const quality = input.request.plan.qualityAndDimensions;
  if (quality.kind !== "export") return renderFullFrame(input, transfer);
  const dimensions = quality.outputDimensions;
  const pixels = new Uint8Array(dimensions.width * dimensions.height * 4);
  const halo = activeStageHalo(input);
  const coreWidth = Math.min(quality.tileDimensions.width, MAX_CPU_TILE_CORE_EDGE);
  const coreHeight = Math.min(quality.tileDimensions.height, MAX_CPU_TILE_CORE_EDGE);
  const wantsTone = input.request.requestedTaps.includes("tone-input");
  const wantsHeadroom = input.request.requestedTaps.includes("scene-headroom");
  const tone = wantsTone ? createToneAccumulator() : null;
  const headroom = wantsHeadroom ? createHeadroomAccumulator() : null;
  for (let y = 0; y < dimensions.height; y += coreHeight) {
    if (cancelled(input.cancellation)) return null;
    for (let x = 0; x < dimensions.width; x += coreWidth) {
      const core = {
        x,
        y,
        width: Math.min(coreWidth, dimensions.width - x),
        height: Math.min(coreHeight, dimensions.height - y),
      };
      const renderedRegion = expandedRegion(core, dimensions, halo);
      const executed = executeRegion(
        input,
        transfer,
        renderedRegion,
        tone
          ? (image) => { accumulateTone(tone, image, renderedRegion, core); }
          : undefined,
      );
      if (!executed) return null;
      if (headroom) accumulateHeadroom(headroom, executed.scene, renderedRegion, core);
      copyCorePixels(pixels, executed.pixels, renderedRegion, core, dimensions.width);
    }
  }
  const toneResult = tone ? finishToneAccumulator(tone) : null;
  const headroomResult = headroom ? finishHeadroomAccumulator(headroom) : null;
  const analysis: CpuAnalysisTapResult[] = [];
  for (const tap of input.request.requestedTaps) {
    switch (tap) {
      case "tone-input":
        if (toneResult) analysis.push(toneResult);
        break;
      case "display-output":
        analysis.push(displayAnalysis(pixels, dimensions));
        break;
      case "scene-headroom":
        if (headroomResult) analysis.push(headroomResult);
        break;
      case "wb-sample":
      case "proof-output":
        analysis.push(unavailableAnalysis(tap));
        break;
      default: {
        const exhaustive: never = tap;
        return exhaustive;
      }
    }
  }
  return { pixels, analysis };
}

export async function renderV3Cpu(input: CpuRenderInput): Promise<CpuRenderResult> {
  if (cancelled(input.cancellation)) return { kind: "cancelled" };
  const identityIssue = backendIdentityIssue(input.request);
  if (identityIssue) return { kind: "invalid", issues: [identityIssue] };
  const compiled = compileV3DevelopPlan({
    document: input.document,
    source: input.source,
    request: input.request,
    capabilities: input.capabilities,
  });
  if (compiled.kind === "blocked") return compiled;
  if (compiled.kind === "invalid") return compiled;
  if (cancelled(input.cancellation)) return { kind: "cancelled" };

  const documentDigest = await sha256(compiled.plan.canonicalDocumentHashInput);
  if (!documentDigest) {
    return {
      kind: "blocked",
      diagnostics: [{
        kind: "fingerprint-unavailable",
        category: "output",
        reason: "Web Crypto SHA-256 is unavailable.",
      }],
    };
  }
  if (documentDigest !== input.request.plan.canonicalDocumentHash) {
    return { kind: "invalid", issues: [{ kind: "document-hash-mismatch" }] };
  }
  const key = planKeyIssue(input.request);
  if (key.issue || !key.material) {
    return {
      kind: "invalid",
      issues: [key.issue ?? { kind: "plan-key-invalid", reason: "Plan key is missing." }],
    };
  }
  const preflightResult = preflight(input, compiled.plan);
  const blocked = nonEmptyBlocking(preflightResult.blocking);
  if (blocked) return { kind: "blocked", diagnostics: blocked };
  if (cancelled(input.cancellation)) return { kind: "cancelled" };

  const transfer = sourceTransfer(input.source);
  if (!transfer || !transferIsSupported(transfer)) {
    return {
      kind: "blocked",
      diagnostics: [{
        kind: "source-transfer-unavailable",
        category: "color",
        transfer: transferLabel(transfer),
      }],
    };
  }
  const rendered = outputIsExport(input.request.plan.qualityAndDimensions)
    ? renderTiledExport(input, transfer)
    : renderFullFrame(input, transfer);
  if (!rendered) return { kind: "cancelled" };
  if (cancelled(input.cancellation)) return { kind: "cancelled" };
  const planFingerprint = await sha256(key.material);
  if (!planFingerprint) {
    return {
      kind: "blocked",
      diagnostics: [{
        kind: "fingerprint-unavailable",
        category: "output",
        reason: "Web Crypto SHA-256 is unavailable.",
      }],
    };
  }
  if (cancelled(input.cancellation)) return { kind: "cancelled" };
  return {
    kind: "rendered",
    planFingerprint,
    frameIdentity: {
      frameClass: frameClassForPlan(input.request.plan),
      quality: input.request.plan.qualityAndDimensions,
    },
    dimensions: input.request.plan.qualityAndDimensions.outputDimensions,
    pixels: { kind: "rgba8", pixels: rendered.pixels },
    diagnostics: preflightResult.notices,
    analysis: rendered.analysis,
  };
}
