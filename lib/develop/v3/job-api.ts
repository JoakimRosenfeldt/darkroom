import {
  parseDevelopJobId,
  parseDevelopJobSnapshot,
  parseDevelopDocumentRevision,
  parseCoordinateFrameRevision,
  parseGenerativeRemoveConsentReceipt,
  type CoordinateFrameRevision,
  type DevelopDocumentRevision,
  type DevelopJobId,
  type DevelopJobSnapshot,
  type GenerativeRemoveConsentReceipt,
} from "./jobs";
import type { V3SourceSignature } from "../process";
import {
  parseDevelopAssetRef,
  parseDevelopAssetSourceSignature,
  type DevelopAssetRef,
} from "./assets";
import {
  parsePrototypeImage,
  type PrototypeImage,
} from "./prototype-operations";

interface DevelopJobIntentBase {
  readonly source: V3SourceSignature;
  readonly documentRevision: DevelopDocumentRevision;
}

export type DevelopJobIntent =
  | DevelopJobIntentBase & { readonly kind: "depth" }
  | DevelopJobIntentBase & { readonly kind: "denoise"; readonly strength: number }
  | DevelopJobIntentBase & { readonly kind: "raw-details"; readonly amount: number }
  | DevelopJobIntentBase & { readonly kind: "super-resolution"; readonly scale: 2 }
  | DevelopJobIntentBase & {
      readonly kind: "generative-remove";
      readonly selection: DevelopAssetRef;
      readonly consentReceiptId: string;
      readonly seed: number;
      readonly searchRadius: number;
    };

export interface DevelopJobStartRequest {
  readonly intent: DevelopJobIntent;
  readonly image: PrototypeImage;
}

export interface DevelopJobRetryRequest {
  readonly jobId: DevelopJobId;
  readonly intent: DevelopJobIntent;
  readonly image: PrototypeImage;
}

export interface DevelopJobTargetRequest {
  readonly jobId: DevelopJobId;
}

export interface DevelopJobAcceptRequest {
  readonly jobId: DevelopJobId;
  readonly currentSource: V3SourceSignature;
  readonly currentDocumentRevision: DevelopDocumentRevision;
  readonly currentFrameRevision: CoordinateFrameRevision;
  readonly candidateIds: readonly [string, ...string[]];
}

export interface GenerativeRemoveConsentGrantRequest {
  readonly source: V3SourceSignature;
  readonly selection: DevelopAssetRef;
  readonly seed: number;
  readonly searchRadius: number;
}

export interface GenerativeRemoveConsentRevokeRequest {
  readonly receiptId: string;
}

export interface DevelopJobAcceptanceResult {
  readonly kind: "artifact-published-document-pending";
  readonly job: Extract<DevelopJobSnapshot, { readonly status: "accepted" }>;
}

export type DevelopJobListener = (
  snapshots: readonly DevelopJobSnapshot[],
) => void;

export interface DevelopJobApi {
  readonly list: () => Promise<readonly DevelopJobSnapshot[]>;
  readonly start: (request: DevelopJobStartRequest) => Promise<DevelopJobSnapshot>;
  readonly cancel: (request: DevelopJobTargetRequest) => Promise<DevelopJobSnapshot>;
  readonly retry: (request: DevelopJobRetryRequest) => Promise<DevelopJobSnapshot>;
  readonly discard: (request: DevelopJobTargetRequest) => Promise<void>;
  readonly accept: (
    request: DevelopJobAcceptRequest,
  ) => Promise<DevelopJobAcceptanceResult>;
  readonly grantGenerativeRemoveConsent: (
    request: GenerativeRemoveConsentGrantRequest,
  ) => Promise<GenerativeRemoveConsentReceipt>;
  readonly revokeGenerativeRemoveConsent: (
    request: GenerativeRemoveConsentRevokeRequest,
  ) => Promise<GenerativeRemoveConsentReceipt>;
  readonly subscribe: (listener: DevelopJobListener) => () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0")
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

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = boundedNumber(value, label, minimum, maximum);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

export function parseDevelopJobIntent(value: unknown): DevelopJobIntent {
  if (!isRecord(value)) throw new Error("Develop job intent is invalid.");
  const base = {
    source: parseDevelopAssetSourceSignature(value.source),
    documentRevision: parseDevelopDocumentRevision(value.documentRevision),
  };
  switch (value.kind) {
    case "depth":
      return { ...base, kind: "depth" };
    case "denoise":
      return {
        ...base,
        kind: "denoise",
        strength: boundedNumber(value.strength, "Denoise strength", 0, 100),
      };
    case "raw-details":
      return {
        ...base,
        kind: "raw-details",
        amount: boundedNumber(value.amount, "Raw Details amount", 0, 100),
      };
    case "super-resolution":
      if (value.scale !== 2) throw new Error("Super Resolution scale is invalid.");
      return { ...base, kind: "super-resolution", scale: 2 };
    case "generative-remove": {
      const selection = parseDevelopAssetRef(value.selection);
      if (selection.kind !== "mask-matte") {
        throw new Error("Generative Remove selection must be a mask matte.");
      }
      return {
        ...base,
        kind: "generative-remove",
        selection,
        consentReceiptId: boundedText(value.consentReceiptId, "Consent receipt ID"),
        seed: boundedInteger(value.seed, "Generative Remove seed", 0, 0xffff_ffff),
        searchRadius: boundedInteger(value.searchRadius, "Generative Remove search radius", 1, 64),
      };
    }
    default:
      throw new Error("Develop job intent operation is invalid.");
  }
}

export function parseDevelopJobStartRequest(value: unknown): DevelopJobStartRequest {
  if (!isRecord(value)) throw new Error("Develop job start request is invalid.");
  return {
    intent: parseDevelopJobIntent(value.intent),
    image: parsePrototypeImage(value.image),
  };
}

export function parseDevelopJobRetryRequest(value: unknown): DevelopJobRetryRequest {
  if (!isRecord(value)) throw new Error("Develop job retry request is invalid.");
  return {
    jobId: parseDevelopJobId(value.jobId),
    intent: parseDevelopJobIntent(value.intent),
    image: parsePrototypeImage(value.image),
  };
}

export function parseDevelopJobTargetRequest(value: unknown): DevelopJobTargetRequest {
  if (!isRecord(value)) throw new Error("Develop job target request is invalid.");
  return { jobId: parseDevelopJobId(value.jobId) };
}

export function parseDevelopJobAcceptRequest(value: unknown): DevelopJobAcceptRequest {
  if (!isRecord(value)) throw new Error("Develop job acceptance request is invalid.");
  return {
    jobId: parseDevelopJobId(value.jobId),
    currentSource: parseDevelopAssetSourceSignature(value.currentSource),
    currentDocumentRevision: parseDevelopDocumentRevision(value.currentDocumentRevision),
    currentFrameRevision: parseCoordinateFrameRevision(value.currentFrameRevision),
    candidateIds: parseCandidateIds(value.candidateIds),
  };
}

function parseCandidateIds(value: unknown): readonly [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new Error("Accepted prototype candidate IDs are invalid.");
  }
  const ids = value.map((item) => boundedText(item, "Prototype candidate ID"));
  if (new Set(ids).size !== ids.length) {
    throw new Error("Accepted prototype candidate IDs must be unique.");
  }
  const first = ids[0];
  if (!first) throw new Error("Accepted prototype candidate IDs are invalid.");
  return [first, ...ids.slice(1)];
}

export function parseGenerativeRemoveConsentGrantRequest(
  value: unknown,
): GenerativeRemoveConsentGrantRequest {
  if (!isRecord(value)) throw new Error("Generative Remove consent request is invalid.");
  const selection = parseDevelopAssetRef(value.selection);
  if (selection.kind !== "mask-matte") {
    throw new Error("Generative Remove consent requires a mask matte.");
  }
  return {
    source: parseDevelopAssetSourceSignature(value.source),
    selection,
    seed: boundedInteger(value.seed, "Generative Remove seed", 0, 0xffff_ffff),
    searchRadius: boundedInteger(value.searchRadius, "Generative Remove search radius", 1, 64),
  };
}

export function parseGenerativeRemoveConsentRevokeRequest(
  value: unknown,
): GenerativeRemoveConsentRevokeRequest {
  if (!isRecord(value)) throw new Error("Generative Remove consent revocation is invalid.");
  return { receiptId: boundedText(value.receiptId, "Consent receipt ID") };
}

export function parseGenerativeRemoveConsentResult(
  value: unknown,
): GenerativeRemoveConsentReceipt {
  return parseGenerativeRemoveConsentReceipt(value);
}

export function parseDevelopJobSnapshotList(
  value: unknown,
): readonly DevelopJobSnapshot[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("Develop job snapshot list is invalid.");
  }
  return value.map(parseDevelopJobSnapshot);
}

export function parseDevelopJobAcceptanceResult(
  value: unknown,
): DevelopJobAcceptanceResult {
  if (!isRecord(value) || value.kind !== "artifact-published-document-pending") {
    throw new Error("Develop job acceptance result is invalid.");
  }
  const job = parseDevelopJobSnapshot(value.job);
  if (job.status !== "accepted") {
    throw new Error("Develop job acceptance snapshot is invalid.");
  }
  return { kind: "artifact-published-document-pending", job };
}
