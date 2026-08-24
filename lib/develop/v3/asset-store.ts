import type { V3SourceSignature } from "../process";
import { parseSha256Digest } from "../render-contract";
import {
  MAX_DEVELOP_ASSET_BYTES,
  MAX_DEVELOP_ASSET_REFS,
  parseDevelopAssetCandidate,
  parseDevelopAssetDescriptor,
  parseDevelopAssetRef,
  parseDevelopAssetSourceSignature,
  type AssetLifecycle,
  type AssetReferenceOwner,
  type DevelopAssetCandidate,
  type DevelopAssetDescriptor,
  type DevelopAssetRef,
} from "./assets";

export const MAX_ASSET_RECORDS_PER_OBJECT = MAX_DEVELOP_ASSET_REFS;
export const MAX_ASSET_GC_PROTECTED_REFS = 50_000;
export const MAX_ASSET_GC_FAILURES = 256;
export const DEPTH_MAP_HEADER_BYTES = 24;
export const DEPTH_MAP_FORMAT_VERSION = 1;
export const DEPTH_MAP_FLOAT32_LE = 1;
export const DEPTH_MAP_CHANNELS = 1;
export const DEPTH_MAP_MAGIC = [
  0x44,
  0x52,
  0x44,
  0x45,
  0x50,
  0x54,
  0x48,
  0x00,
] as const satisfies readonly number[];

export interface DevelopAssetPutRequest {
  readonly candidate: DevelopAssetCandidate;
  readonly bytes: Uint8Array;
  readonly nowMs: number;
  readonly recoveryUntilMs: number;
}

export type DevelopAssetPutResult =
  | {
      readonly kind: "stored";
      readonly candidate: DevelopAssetCandidate;
      readonly object: "created" | "reused";
    }
  | {
      readonly kind: "deduplicated";
      readonly candidate: DevelopAssetCandidate;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "byte-length-mismatch"
        | "checksum-mismatch"
        | "content-metadata-mismatch"
        | "candidate-conflict"
        | "record-limit";
      readonly message: string;
    };

export type DevelopAssetFinalLifecycle = Exclude<
  AssetLifecycle,
  "preview-candidate"
>;

export interface DevelopAssetTransitionRequest {
  readonly candidate: DevelopAssetCandidate;
  readonly lifecycle: DevelopAssetFinalLifecycle;
  readonly reference: DevelopAssetRef | null;
  readonly nowMs: number;
  readonly recoveryUntilMs: number;
}

export type DevelopAssetTransitionResult =
  | {
      readonly kind: "changed" | "unchanged";
      readonly lifecycle: DevelopAssetFinalLifecycle;
    }
  | {
      readonly kind: "missing";
      readonly action: "rebuild-candidate";
      readonly message: string;
    }
  | {
      readonly kind: "conflict";
      readonly action: "review-current-candidate";
      readonly message: string;
    };

export interface DevelopAssetReadRequest {
  readonly reference: DevelopAssetRef;
  readonly sourceSignature: V3SourceSignature;
}

export type DevelopAssetReadResult =
  | {
      readonly kind: "ready";
      readonly descriptor: DevelopAssetDescriptor;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "missing";
      readonly reason: "metadata-missing" | "bytes-missing" | "not-accepted";
      readonly action: "restore-or-rebuild" | "accept-candidate";
      readonly message: string;
    }
  | {
      readonly kind: "corrupt";
      readonly reason:
        | "metadata-invalid"
        | "reference-mismatch"
        | "byte-length-mismatch"
        | "checksum-mismatch"
        | "content-metadata-mismatch";
      readonly action: "restore-or-rebuild";
      readonly message: string;
    };

export interface ProtectedDevelopAssetReference {
  readonly owner: AssetReferenceOwner;
  readonly reference: DevelopAssetRef;
}

export interface DevelopAssetGcRequest {
  readonly protectedReferences: readonly ProtectedDevelopAssetReference[];
  readonly nowMs: number;
  readonly cursor: string | null;
}

export interface DevelopAssetGcFailure {
  readonly assetId: string;
  readonly code: "metadata-invalid" | "filesystem-error";
  readonly message: string;
}

export interface DevelopAssetGcResult {
  readonly examined: number;
  readonly deleted: number;
  readonly protected: number;
  readonly candidateDeferred: number;
  readonly recoveryDeferred: number;
  readonly failed: number;
  readonly failures: readonly DevelopAssetGcFailure[];
  readonly omittedFailures: number;
  readonly nextCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTime(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength > MAX_DEVELOP_ASSET_BYTES) {
      throw new Error("Develop asset bytes are invalid.");
    }
    return Uint8Array.from(value);
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength === 0 || value.byteLength > MAX_DEVELOP_ASSET_BYTES) {
      throw new Error("Develop asset bytes are invalid.");
    }
    return new Uint8Array(value.slice(0));
  }
  throw new Error("Develop asset bytes are invalid.");
}

function parseRecoveryWindow(
  nowValue: unknown,
  recoveryUntilValue: unknown,
): { readonly nowMs: number; readonly recoveryUntilMs: number } {
  const nowMs = parseTime(nowValue, "Develop asset current time");
  const recoveryUntilMs = parseTime(
    recoveryUntilValue,
    "Develop asset recovery time",
  );
  if (recoveryUntilMs < nowMs) {
    throw new Error("Develop asset recovery time is in the past.");
  }
  return { nowMs, recoveryUntilMs };
}

function parseFinalLifecycle(value: unknown): DevelopAssetFinalLifecycle {
  switch (value) {
    case "accepted":
    case "rejected":
    case "cancelled":
    case "stale":
      return value;
    default:
      throw new Error("Develop asset lifecycle is invalid.");
  }
}

function parseOwner(value: unknown): AssetReferenceOwner {
  if (!isRecord(value)) {
    throw new Error("Develop asset reference owner is invalid.");
  }
  if (
    value.kind !== "canonical-document" &&
    value.kind !== "retained-v2" &&
    value.kind !== "recovery-journal"
  ) {
    throw new Error("Develop asset reference owner kind is invalid.");
  }
  if (
    typeof value.ownerId !== "string" ||
    value.ownerId.length === 0 ||
    value.ownerId.length > 1_024 ||
    value.ownerId.includes("\0")
  ) {
    throw new Error("Develop asset reference owner ID is invalid.");
  }
  return { kind: value.kind, ownerId: value.ownerId };
}

function parseFailure(value: unknown): DevelopAssetGcFailure {
  if (!isRecord(value)) throw new Error("Develop asset GC failure is invalid.");
  if (
    value.code !== "metadata-invalid" &&
    value.code !== "filesystem-error"
  ) {
    throw new Error("Develop asset GC failure code is invalid.");
  }
  if (
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 1_024
  ) {
    throw new Error("Develop asset GC failure content is invalid.");
  }
  return {
    assetId: parseSha256Digest(value.assetId),
    code: value.code,
    message: value.message,
  };
}

function parseCount(value: unknown, label: string): number {
  return parseTime(value, label);
}

function parsePutRejectionReason(
  value: unknown,
): Extract<DevelopAssetPutResult, { readonly kind: "rejected" }>["reason"] {
  switch (value) {
    case "byte-length-mismatch":
    case "checksum-mismatch":
    case "content-metadata-mismatch":
    case "candidate-conflict":
    case "record-limit":
      return value;
    default:
      throw new Error("Develop asset rejection reason is invalid.");
  }
}

function parseCorruptionReason(
  value: unknown,
): Extract<DevelopAssetReadResult, { readonly kind: "corrupt" }>["reason"] {
  switch (value) {
    case "metadata-invalid":
    case "reference-mismatch":
    case "byte-length-mismatch":
    case "checksum-mismatch":
    case "content-metadata-mismatch":
      return value;
    default:
      throw new Error("Develop asset corruption reason is invalid.");
  }
}

export function parseDevelopAssetPutRequest(
  value: unknown,
): DevelopAssetPutRequest {
  if (!isRecord(value)) throw new Error("Develop asset put request is invalid.");
  const time = parseRecoveryWindow(value.nowMs, value.recoveryUntilMs);
  return {
    candidate: parseDevelopAssetCandidate(value.candidate),
    bytes: parseBytes(value.bytes),
    ...time,
  };
}

export function parseDevelopAssetTransitionRequest(
  value: unknown,
): DevelopAssetTransitionRequest {
  if (!isRecord(value)) {
    throw new Error("Develop asset transition request is invalid.");
  }
  const lifecycle = parseFinalLifecycle(value.lifecycle);
  const reference = value.reference === null
    ? null
    : parseDevelopAssetRef(value.reference);
  if (lifecycle === "accepted" && reference === null) {
    throw new Error("Accepted assets require an accepted reference.");
  }
  if (lifecycle !== "accepted" && reference !== null) {
    throw new Error("Unaccepted assets cannot carry an accepted reference.");
  }
  return {
    candidate: parseDevelopAssetCandidate(value.candidate),
    lifecycle,
    reference,
    ...parseRecoveryWindow(value.nowMs, value.recoveryUntilMs),
  };
}

export function parseDevelopAssetReadRequest(
  value: unknown,
): DevelopAssetReadRequest {
  if (!isRecord(value)) {
    throw new Error("Develop asset read request is invalid.");
  }
  return {
    reference: parseDevelopAssetRef(value.reference),
    sourceSignature: parseDevelopAssetSourceSignature(value.sourceSignature),
  };
}

export function parseDevelopAssetGcRequest(
  value: unknown,
): DevelopAssetGcRequest {
  if (
    !isRecord(value) ||
    !Array.isArray(value.protectedReferences) ||
    value.protectedReferences.length > MAX_ASSET_GC_PROTECTED_REFS
  ) {
    throw new Error("Develop asset GC request is invalid.");
  }
  const cursor = value.cursor === null
    ? null
    : parseSha256Digest(value.cursor);
  return {
    nowMs: parseTime(value.nowMs, "Develop asset GC time"),
    cursor,
    protectedReferences: value.protectedReferences.map((item) => {
      if (!isRecord(item)) {
        throw new Error("Protected develop asset reference is invalid.");
      }
      return {
        owner: parseOwner(item.owner),
        reference: parseDevelopAssetRef(item.reference),
      };
    }),
  };
}

export function parseDevelopAssetPutResult(
  value: unknown,
): DevelopAssetPutResult {
  if (!isRecord(value)) throw new Error("Develop asset put result is invalid.");
  if (value.kind === "stored") {
    if (value.object !== "created" && value.object !== "reused") {
      throw new Error("Develop asset object result is invalid.");
    }
    return {
      kind: "stored",
      candidate: parseDevelopAssetCandidate(value.candidate),
      object: value.object,
    };
  }
  if (value.kind === "deduplicated") {
    return {
      kind: "deduplicated",
      candidate: parseDevelopAssetCandidate(value.candidate),
    };
  }
  if (value.kind === "rejected") {
    const reason = parsePutRejectionReason(value.reason);
    if (
      typeof value.message !== "string" ||
      value.message.length === 0 ||
      value.message.length > 1_024
    ) {
      throw new Error("Develop asset rejection is invalid.");
    }
    return { kind: "rejected", reason, message: value.message };
  }
  throw new Error("Develop asset put result kind is invalid.");
}

export function parseDevelopAssetTransitionResult(
  value: unknown,
): DevelopAssetTransitionResult {
  if (!isRecord(value)) {
    throw new Error("Develop asset transition result is invalid.");
  }
  if (value.kind === "changed" || value.kind === "unchanged") {
    return { kind: value.kind, lifecycle: parseFinalLifecycle(value.lifecycle) };
  }
  if (
    value.kind === "missing" &&
    value.action === "rebuild-candidate" &&
    typeof value.message === "string"
  ) {
    if (value.message.length === 0 || value.message.length > 1_024) {
      throw new Error("Develop asset transition message is invalid.");
    }
    return { kind: "missing", action: value.action, message: value.message };
  }
  if (
    value.kind === "conflict" &&
    value.action === "review-current-candidate" &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 1_024
  ) {
    return { kind: "conflict", action: value.action, message: value.message };
  }
  throw new Error("Develop asset transition result kind is invalid.");
}

export function parseDevelopAssetReadResult(
  value: unknown,
): DevelopAssetReadResult {
  if (!isRecord(value)) throw new Error("Develop asset read result is invalid.");
  if (value.kind === "ready") {
    const bytes = parseBytes(value.bytes);
    const descriptor = parseDevelopAssetDescriptor(value.descriptor);
    if (bytes.byteLength !== descriptor.byteLength) {
      throw new Error("Develop asset read length is invalid.");
    }
    return { kind: "ready", descriptor, bytes };
  }
  if (value.kind === "missing") {
    if (
      value.reason !== "metadata-missing" &&
      value.reason !== "bytes-missing" &&
      value.reason !== "not-accepted"
    ) {
      throw new Error("Develop asset missing reason is invalid.");
    }
    const action = value.reason === "not-accepted"
      ? "accept-candidate"
      : "restore-or-rebuild";
    if (
      value.action !== action ||
      typeof value.message !== "string" ||
      value.message.length === 0 ||
      value.message.length > 1_024
    ) {
      throw new Error("Develop asset missing result is invalid.");
    }
    return { kind: "missing", reason: value.reason, action, message: value.message };
  }
  if (value.kind === "corrupt") {
    const reason = parseCorruptionReason(value.reason);
    if (
      value.action !== "restore-or-rebuild" ||
      typeof value.message !== "string" ||
      value.message.length === 0 ||
      value.message.length > 1_024
    ) {
      throw new Error("Develop asset corruption result is invalid.");
    }
    return {
      kind: "corrupt",
      reason,
      action: "restore-or-rebuild",
      message: value.message,
    };
  }
  throw new Error("Develop asset read result kind is invalid.");
}

export function parseDevelopAssetGcResult(
  value: unknown,
): DevelopAssetGcResult {
  if (!isRecord(value) || !Array.isArray(value.failures)) {
    throw new Error("Develop asset GC result is invalid.");
  }
  const failures = value.failures.map(parseFailure);
  if (failures.length > MAX_ASSET_GC_FAILURES) {
    throw new Error("Develop asset GC result has too many failures.");
  }
  const result = {
    examined: parseCount(value.examined, "Develop asset GC examined count"),
    deleted: parseCount(value.deleted, "Develop asset GC deleted count"),
    protected: parseCount(value.protected, "Develop asset GC protected count"),
    candidateDeferred: parseCount(
      value.candidateDeferred,
      "Develop asset GC candidate count",
    ),
    recoveryDeferred: parseCount(
      value.recoveryDeferred,
      "Develop asset GC recovery count",
    ),
    failed: parseCount(value.failed, "Develop asset GC failed count"),
    failures,
    omittedFailures: parseCount(
      value.omittedFailures,
      "Develop asset GC omitted failure count",
    ),
    nextCursor: value.nextCursor === null
      ? null
      : parseSha256Digest(value.nextCursor),
  } satisfies DevelopAssetGcResult;
  if (
    result.deleted + result.protected + result.candidateDeferred +
      result.recoveryDeferred + result.failed !== result.examined ||
    result.failures.length + result.omittedFailures !== result.failed
  ) {
    throw new Error("Develop asset GC counts are inconsistent.");
  }
  return result;
}

export function descriptorMatchesReference(
  descriptor: DevelopAssetDescriptor,
  reference: DevelopAssetRef,
): boolean {
  return descriptor.sha256 === reference.assetId &&
    descriptor.sha256 === reference.sha256 &&
    descriptor.kind === reference.kind &&
    descriptor.producerRevision === reference.producerRevision &&
    descriptor.coordinateFrameRevision === reference.coordinateFrameRevision &&
    descriptor.colorStageId === reference.colorStageId;
}

export function sourceSignaturesMatch(
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

export function descriptorsMatch(
  left: DevelopAssetDescriptor,
  right: DevelopAssetDescriptor,
): boolean {
  return left.kind === right.kind &&
    left.sha256 === right.sha256 &&
    sourceSignaturesMatch(left.sourceSignature, right.sourceSignature) &&
    left.coordinateFrameRevision === right.coordinateFrameRevision &&
    left.colorStageId === right.colorStageId &&
    left.dimensions.width === right.dimensions.width &&
    left.dimensions.height === right.dimensions.height &&
    left.byteLength === right.byteLength &&
    left.mimeType === right.mimeType &&
    left.producerId === right.producerId &&
    left.producerRevision === right.producerRevision;
}
