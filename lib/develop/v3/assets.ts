import {
  COORDINATE_FRAME_REVISION,
  SEMANTIC_STAGE_IDS,
  type PixelDimensions,
  type SemanticStageId,
  type V3SourceSignature,
} from "../process";
import {
  parseSha256Digest,
  type AcceptedAssetKind,
  type AcceptedAssetRevision,
  type Sha256Digest,
} from "../render-contract";

export const MAX_DEVELOP_ASSET_REFS = 256;
export const MAX_DEVELOP_ASSET_EDGE = 65_535;
export const MAX_DEVELOP_ASSET_BYTES = 512 * 1024 * 1024;

export type DevelopAssetMimeType =
  | "image/png"
  | "image/webp"
  | "application/x-darkroom-depth";

export interface DevelopAssetDescriptor {
  readonly kind: AcceptedAssetKind;
  readonly sha256: Sha256Digest;
  readonly sourceSignature: V3SourceSignature;
  readonly coordinateFrameRevision: typeof COORDINATE_FRAME_REVISION;
  readonly colorStageId: SemanticStageId;
  readonly dimensions: PixelDimensions;
  readonly byteLength: number;
  readonly mimeType: DevelopAssetMimeType;
  readonly producerId: string;
  readonly producerRevision: string;
}

export interface DevelopAssetCandidate {
  readonly kind: "candidate";
  readonly candidateId: string;
  readonly descriptor: DevelopAssetDescriptor;
}

export interface DevelopAssetRef extends AcceptedAssetRevision {
  readonly assetId: Sha256Digest;
}

export type AssetReferenceOwner =
  | { readonly kind: "canonical-document"; readonly ownerId: string }
  | { readonly kind: "retained-v2"; readonly ownerId: string }
  | { readonly kind: "recovery-journal"; readonly ownerId: string };

export type AssetLifecycle =
  | "preview-candidate"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "stale";

export interface AssetRetentionInput {
  readonly lifecycle: AssetLifecycle;
  readonly references: readonly AssetReferenceOwner[];
  readonly recoveryUntilMs: number;
  readonly nowMs: number;
}

export type AssetRetentionDecision =
  | {
      readonly kind: "protected";
      readonly reason: "referenced" | "candidate-in-review" | "recovery-window";
    }
  | { readonly kind: "collectible" }
  | { readonly kind: "invalid"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
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

function parseAssetKind(value: unknown): AcceptedAssetKind {
  switch (value) {
    case "mask-matte":
    case "repair-patch":
    case "depth-map":
      return value;
    default:
      throw new Error("Develop asset kind is invalid.");
  }
}

function parseMimeType(value: unknown): DevelopAssetMimeType {
  switch (value) {
    case "image/png":
    case "image/webp":
    case "application/x-darkroom-depth":
      return value;
    default:
      throw new Error("Develop asset MIME type is invalid.");
  }
}

function mimeTypeMatchesKind(
  kind: AcceptedAssetKind,
  mimeType: DevelopAssetMimeType,
): boolean {
  switch (kind) {
    case "mask-matte":
      return mimeType === "image/png";
    case "repair-patch":
      return mimeType === "image/png" || mimeType === "image/webp";
    case "depth-map":
      return mimeType === "application/x-darkroom-depth";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function parseSemanticStageId(value: unknown): SemanticStageId {
  for (const stageId of SEMANTIC_STAGE_IDS) {
    if (value === stageId) return stageId;
  }
  throw new Error("Develop asset color stage is invalid.");
}

function parseCoordinateFrameRevision(
  value: unknown,
): typeof COORDINATE_FRAME_REVISION {
  if (value !== COORDINATE_FRAME_REVISION) {
    throw new Error("Develop asset coordinate frame is invalid.");
  }
  return COORDINATE_FRAME_REVISION;
}

function parseDimensions(value: unknown): PixelDimensions {
  if (!isRecord(value)) {
    throw new Error("Develop asset dimensions are invalid.");
  }
  return {
    width: boundedInteger(
      value.width,
      "Develop asset width",
      1,
      MAX_DEVELOP_ASSET_EDGE,
    ),
    height: boundedInteger(
      value.height,
      "Develop asset height",
      1,
      MAX_DEVELOP_ASSET_EDGE,
    ),
  };
}

export function parseDevelopAssetSourceSignature(
  value: unknown,
): V3SourceSignature {
  if (!isRecord(value)) {
    throw new Error("Develop asset source signature is invalid.");
  }
  return {
    entryId: boundedText(value.entryId, "Source entry ID", 1_024),
    catalogId: boundedText(value.catalogId, "Source catalog ID", 1_024),
    assetRevision: boundedInteger(
      value.assetRevision,
      "Source asset revision",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    relativePath: boundedText(value.relativePath, "Source relative path", 4_096),
    size: boundedInteger(value.size, "Source size", 0, Number.MAX_SAFE_INTEGER),
    lastModified: boundedNumber(
      value.lastModified,
      "Source modified time",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function parseDevelopAssetDescriptor(value: unknown): DevelopAssetDescriptor {
  if (!isRecord(value)) {
    throw new Error("Develop asset metadata is invalid.");
  }
  const kind = parseAssetKind(value.kind);
  const mimeType = parseMimeType(value.mimeType);
  if (!mimeTypeMatchesKind(kind, mimeType)) {
    throw new Error("Develop asset MIME type does not match its kind.");
  }
  return {
    kind,
    sha256: parseSha256Digest(value.sha256),
    sourceSignature: parseDevelopAssetSourceSignature(value.sourceSignature),
    coordinateFrameRevision: parseCoordinateFrameRevision(
      value.coordinateFrameRevision,
    ),
    colorStageId: parseSemanticStageId(value.colorStageId),
    dimensions: parseDimensions(value.dimensions),
    byteLength: boundedInteger(
      value.byteLength,
      "Develop asset byte length",
      1,
      MAX_DEVELOP_ASSET_BYTES,
    ),
    mimeType,
    producerId: boundedText(value.producerId, "Asset producer ID", 256),
    producerRevision: boundedText(
      value.producerRevision,
      "Asset producer revision",
      256,
    ),
  };
}

export function parseDevelopAssetCandidate(value: unknown): DevelopAssetCandidate {
  if (!isRecord(value) || value.kind !== "candidate") {
    throw new Error("Develop asset candidate is invalid.");
  }
  return {
    kind: "candidate",
    candidateId: boundedText(value.candidateId, "Asset candidate ID", 256),
    descriptor: parseDevelopAssetDescriptor(value.descriptor),
  };
}

export function parseDevelopAssetRef(value: unknown): DevelopAssetRef {
  if (!isRecord(value)) {
    throw new Error("Develop asset reference is invalid.");
  }
  const kind = parseAssetKind(value.kind);
  const sha256 = parseSha256Digest(value.sha256);
  const assetId = parseSha256Digest(value.assetId);
  if (assetId !== sha256) {
    throw new Error("Develop asset address does not match its checksum.");
  }
  return {
    assetId,
    kind,
    sha256,
    producerRevision: boundedText(
      value.producerRevision,
      "Asset producer revision",
      256,
    ),
    coordinateFrameRevision: parseCoordinateFrameRevision(
      value.coordinateFrameRevision,
    ),
    colorStageId: parseSemanticStageId(value.colorStageId),
  };
}

export function parseDevelopAssetRefs(value: unknown): readonly DevelopAssetRef[] {
  if (!Array.isArray(value) || value.length > MAX_DEVELOP_ASSET_REFS) {
    throw new Error("Develop asset reference list is invalid.");
  }
  const references = value.map(parseDevelopAssetRef);
  if (new Set(references.map((reference) => reference.assetId)).size !== references.length) {
    throw new Error("Develop asset references contain duplicate addresses.");
  }
  return references;
}

export function acceptedAssetRevision(
  reference: DevelopAssetRef,
): AcceptedAssetRevision {
  return reference;
}

export function decideAssetRetention(
  input: AssetRetentionInput,
): AssetRetentionDecision {
  if (
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.recoveryUntilMs) ||
    input.nowMs < 0 ||
    input.recoveryUntilMs < 0 ||
    input.references.length > MAX_DEVELOP_ASSET_REFS ||
    input.references.some((reference) =>
      reference.ownerId.length === 0 || reference.ownerId.length > 1_024
    )
  ) {
    return { kind: "invalid", reason: "Asset retention input is invalid." };
  }
  if (input.references.length > 0) {
    return { kind: "protected", reason: "referenced" };
  }
  if (input.lifecycle === "preview-candidate") {
    return { kind: "protected", reason: "candidate-in-review" };
  }
  if (input.nowMs < input.recoveryUntilMs) {
    return { kind: "protected", reason: "recovery-window" };
  }
  return { kind: "collectible" };
}
