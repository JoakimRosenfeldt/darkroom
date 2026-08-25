import { COORDINATE_FRAME_REVISION, type V3SourceSignature } from "../process";
import { parseSha256Digest, type Sha256Digest } from "../render-contract";
import {
  parseDevelopAssetCandidate,
  parseDevelopAssetRef,
  parseDevelopAssetSourceSignature,
  type DevelopAssetCandidate,
  type DevelopAssetRef,
} from "./assets";
import { PROTOTYPE_ALGORITHMS } from "./prototype-operations";

export const MAX_DEVELOP_JOB_ATTEMPTS = 16;
export const MAX_DEVELOP_JOB_CANDIDATES = 8;

export interface DevelopJobId {
  readonly kind: "develop-job-id";
  readonly value: string;
}

export interface SourceRevision {
  readonly kind: "source-revision";
  readonly value: string;
}

export interface DevelopDocumentRevision {
  readonly kind: "develop-document-revision";
  readonly value: string;
}

export interface CoordinateFrameRevision {
  readonly kind: "coordinate-frame-revision";
  readonly value: typeof COORDINATE_FRAME_REVISION;
}

export interface GenerativeRemoveConsentReceipt {
  readonly kind: "generative-remove-consent";
  readonly id: string;
  readonly provider: "local-mock-remove-v1";
  readonly disclosure: "local-processing-no-network-v1";
  readonly sourceRevision: SourceRevision;
  readonly selectionAssetId: Sha256Digest;
  readonly intentHash: Sha256Digest;
  readonly grantedAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number | null;
}

interface DevelopJobRequestBase {
  readonly source: V3SourceSignature;
  readonly sourceRevision: SourceRevision;
  readonly documentRevision: DevelopDocumentRevision;
  readonly frameRevision: CoordinateFrameRevision;
  readonly parameterHash: Sha256Digest;
}

export type DevelopJobRequest =
  | DevelopJobRequestBase & {
      readonly kind: "depth";
      readonly implementation: "builtin-prototype-depth-v1";
    }
  | DevelopJobRequestBase & {
      readonly kind: "denoise";
      readonly implementation: "builtin-prototype-denoise-v1";
      readonly strength: number;
    }
  | DevelopJobRequestBase & {
      readonly kind: "raw-details";
      readonly implementation: "builtin-prototype-raw-details-v1";
      readonly amount: number;
    }
  | DevelopJobRequestBase & {
      readonly kind: "super-resolution";
      readonly implementation: "builtin-prototype-super-resolution-v1";
      readonly scale: 2;
    }
  | DevelopJobRequestBase & {
      readonly kind: "generative-remove";
      readonly implementation: "local-mock-remove-v1";
      readonly selection: DevelopAssetRef;
      readonly consent: GenerativeRemoveConsentReceipt;
      readonly seed: number;
      readonly searchRadius: number;
    };

interface DevelopJobProvenanceBase {
  readonly implementation: "prototype";
  readonly algorithmRevision: "1";
  readonly parameterHash: Sha256Digest;
  readonly sourceRevision: SourceRevision;
  readonly documentRevision: DevelopDocumentRevision;
  readonly frameRevision: CoordinateFrameRevision;
}

export type DevelopJobProvenance = DevelopJobProvenanceBase &
  (
    | { readonly operation: "depth"; readonly algorithmId: "builtin-prototype-depth-v1" }
    | { readonly operation: "denoise"; readonly algorithmId: "builtin-prototype-denoise-v1" }
    | {
        readonly operation: "raw-details";
        readonly algorithmId: "builtin-prototype-raw-details-v1";
      }
    | {
        readonly operation: "super-resolution";
        readonly algorithmId: "builtin-prototype-super-resolution-v1";
      }
    | {
        readonly operation: "generative-remove";
        readonly algorithmId: "local-mock-remove-v1";
      }
  );

export type DevelopJobFailureCode =
  | "model-unavailable"
  | "unsupported-input"
  | "device-limit"
  | "privacy-limit"
  | "provider-error"
  | "integrity-error"
  | "filesystem-error";

export type DevelopJobRecoveryAction =
  | "repair-model"
  | "choose-supported-input"
  | "reduce-work-or-change-device"
  | "review-consent"
  | "retry-provider"
  | "restore-or-rebuild"
  | "repair-storage";

export interface DevelopJobFailure {
  readonly code: DevelopJobFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly recovery: DevelopJobRecoveryAction;
}

export type DevelopJobRunningStage =
  | "decoding"
  | "processing"
  | "provider-request"
  | "provider-response";

export interface DevelopJobProgress {
  readonly completed: number;
  readonly total: number;
}

interface DevelopJobBase {
  readonly id: DevelopJobId;
  readonly request: DevelopJobRequest;
  readonly provenance: DevelopJobProvenance;
  readonly attempt: number;
  readonly retryOf: DevelopJobId | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type DevelopJobSnapshot =
  | DevelopJobBase & { readonly status: "queued" }
  | DevelopJobBase & {
      readonly status: "preparing";
      readonly stage: "validating-input";
    }
  | DevelopJobBase & {
      readonly status: "running";
      readonly stage: DevelopJobRunningStage;
      readonly progress: DevelopJobProgress;
    }
  | DevelopJobBase & {
      readonly status: "postprocess";
      readonly stage: "encoding-artifacts";
      readonly progress: DevelopJobProgress;
    }
  | DevelopJobBase & {
      readonly status: "awaiting-review";
      readonly candidates: readonly [
        DevelopAssetCandidate,
        ...DevelopAssetCandidate[],
      ];
    }
  | DevelopJobBase & {
      readonly status: "accepting";
      readonly candidates: readonly [
        DevelopAssetCandidate,
        ...DevelopAssetCandidate[],
      ];
      readonly acceptanceId: string;
    }
  | DevelopJobBase & {
      readonly status: "accepted";
      readonly assets: readonly [DevelopAssetRef, ...DevelopAssetRef[]];
      readonly acceptanceId: string;
    }
  | DevelopJobBase & {
      readonly status: "cancelled";
      readonly reason: "user-requested" | "superseded";
    }
  | DevelopJobBase & {
      readonly status: "failed";
      readonly failure: DevelopJobFailure;
    }
  | DevelopJobBase & {
      readonly status: "interrupted";
      readonly reason:
        | "application-restart"
        | "worker-exit"
        | "provider-state-unknown";
      readonly candidates: readonly [];
    }
  | DevelopJobBase & {
      readonly status: "interrupted";
      readonly reason: "acceptance-recovery";
      readonly candidates: readonly [DevelopAssetCandidate, ...DevelopAssetCandidate[]];
      readonly acceptanceId: string;
    }
  | DevelopJobBase & {
      readonly status: "stale";
      readonly reason:
        | "source-revision"
        | "document-revision"
        | "frame-revision";
      readonly candidates: readonly DevelopAssetCandidate[];
    }
  | DevelopJobBase & {
      readonly status: "discarded";
      readonly reason: "user-discarded";
    };

export type DevelopJobTransitionEvent =
  | { readonly kind: "prepare"; readonly atMs: number }
  | {
      readonly kind: "run";
      readonly atMs: number;
      readonly stage: DevelopJobRunningStage;
      readonly total: number;
    }
  | {
      readonly kind: "progress";
      readonly atMs: number;
      readonly completed: number;
    }
  | {
      readonly kind: "change-running-stage";
      readonly atMs: number;
      readonly stage: DevelopJobRunningStage;
    }
  | { readonly kind: "postprocess"; readonly atMs: number; readonly total: number }
  | {
      readonly kind: "review";
      readonly atMs: number;
      readonly candidates: readonly DevelopAssetCandidate[];
    }
  | {
      readonly kind: "accept";
      readonly atMs: number;
      readonly acceptanceId: string;
      readonly candidates: readonly DevelopAssetCandidate[];
    }
  | {
      readonly kind: "accepted";
      readonly atMs: number;
      readonly assets: readonly DevelopAssetRef[];
    }
  | {
      readonly kind: "cancel";
      readonly atMs: number;
      readonly reason: "user-requested" | "superseded";
    }
  | { readonly kind: "fail"; readonly atMs: number; readonly failure: DevelopJobFailure }
  | {
      readonly kind: "interrupt";
      readonly atMs: number;
      readonly reason:
        | "application-restart"
        | "worker-exit"
        | "provider-state-unknown";
    }
  | {
      readonly kind: "mark-stale";
      readonly atMs: number;
      readonly reason:
        | "source-revision"
        | "document-revision"
        | "frame-revision";
    }
  | { readonly kind: "discard"; readonly atMs: number };

export type DevelopJobTransitionResult =
  | { readonly kind: "changed"; readonly job: DevelopJobSnapshot }
  | { readonly kind: "invalid"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maximum = 256): string {
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

export function parseDevelopJobId(value: unknown): DevelopJobId {
  if (!isRecord(value) || value.kind !== "develop-job-id") {
    throw new Error("Develop job ID is invalid.");
  }
  return { kind: "develop-job-id", value: boundedText(value.value, "Develop job ID") };
}

export function parseSourceRevision(value: unknown): SourceRevision {
  if (!isRecord(value) || value.kind !== "source-revision") {
    throw new Error("Source revision is invalid.");
  }
  return { kind: "source-revision", value: boundedText(value.value, "Source revision") };
}

export function parseDevelopDocumentRevision(value: unknown): DevelopDocumentRevision {
  if (!isRecord(value) || value.kind !== "develop-document-revision") {
    throw new Error("Develop document revision is invalid.");
  }
  return {
    kind: "develop-document-revision",
    value: boundedText(value.value, "Develop document revision"),
  };
}

export function parseCoordinateFrameRevision(value: unknown): CoordinateFrameRevision {
  if (
    !isRecord(value) ||
    value.kind !== "coordinate-frame-revision" ||
    value.value !== COORDINATE_FRAME_REVISION
  ) {
    throw new Error("Coordinate frame revision is invalid.");
  }
  return { kind: "coordinate-frame-revision", value: COORDINATE_FRAME_REVISION };
}

function sameSourceRevision(left: SourceRevision, right: SourceRevision): boolean {
  return left.value === right.value;
}

export function parseGenerativeRemoveConsentReceipt(
  value: unknown,
): GenerativeRemoveConsentReceipt {
  if (
    !isRecord(value) ||
    value.kind !== "generative-remove-consent" ||
    value.provider !== "local-mock-remove-v1" ||
    value.disclosure !== "local-processing-no-network-v1"
  ) {
    throw new Error("Generative Remove consent receipt is invalid.");
  }
  const receipt = {
    kind: "generative-remove-consent",
    id: boundedText(value.id, "Consent receipt ID"),
    provider: "local-mock-remove-v1",
    disclosure: "local-processing-no-network-v1",
    sourceRevision: parseSourceRevision(value.sourceRevision),
    selectionAssetId: parseSha256Digest(value.selectionAssetId),
    intentHash: parseSha256Digest(value.intentHash),
    grantedAtMs: boundedInteger(
      value.grantedAtMs,
      "Consent grant time",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    expiresAtMs: boundedInteger(
      value.expiresAtMs,
      "Consent expiry time",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    revokedAtMs: value.revokedAtMs === null
      ? null
      : boundedInteger(
          value.revokedAtMs,
          "Consent revocation time",
          0,
          Number.MAX_SAFE_INTEGER,
        ),
  } satisfies GenerativeRemoveConsentReceipt;
  if (
    receipt.expiresAtMs <= receipt.grantedAtMs ||
    (receipt.revokedAtMs !== null &&
      (receipt.revokedAtMs < receipt.grantedAtMs ||
        receipt.revokedAtMs > receipt.expiresAtMs))
  ) {
    throw new Error("Generative Remove consent lifetime is invalid.");
  }
  return receipt;
}

function parseRequestBase(value: Record<string, unknown>): DevelopJobRequestBase {
  return {
    source: parseDevelopAssetSourceSignature(value.source),
    sourceRevision: parseSourceRevision(value.sourceRevision),
    documentRevision: parseDevelopDocumentRevision(value.documentRevision),
    frameRevision: parseCoordinateFrameRevision(value.frameRevision),
    parameterHash: parseSha256Digest(value.parameterHash),
  };
}

export function parseDevelopJobRequest(value: unknown): DevelopJobRequest {
  if (!isRecord(value)) throw new Error("Develop job request is invalid.");
  const base = parseRequestBase(value);
  switch (value.kind) {
    case "depth":
      if (value.implementation !== PROTOTYPE_ALGORITHMS.depth.id) {
        throw new Error("Depth implementation is invalid.");
      }
      return { ...base, kind: "depth", implementation: PROTOTYPE_ALGORITHMS.depth.id };
    case "denoise":
      if (value.implementation !== PROTOTYPE_ALGORITHMS.denoise.id) {
        throw new Error("Denoise implementation is invalid.");
      }
      return {
        ...base,
        kind: "denoise",
        implementation: PROTOTYPE_ALGORITHMS.denoise.id,
        strength: boundedNumber(value.strength, "Denoise strength", 0, 100),
      };
    case "raw-details":
      if (value.implementation !== PROTOTYPE_ALGORITHMS.rawDetails.id) {
        throw new Error("Raw Details implementation is invalid.");
      }
      return {
        ...base,
        kind: "raw-details",
        implementation: PROTOTYPE_ALGORITHMS.rawDetails.id,
        amount: boundedNumber(value.amount, "Raw Details amount", 0, 100),
      };
    case "super-resolution":
      if (
        value.implementation !== PROTOTYPE_ALGORITHMS.superResolution.id ||
        value.scale !== 2
      ) {
        throw new Error("Super Resolution implementation is invalid.");
      }
      return {
        ...base,
        kind: "super-resolution",
        implementation: PROTOTYPE_ALGORITHMS.superResolution.id,
        scale: 2,
      };
    case "generative-remove": {
      if (value.implementation !== PROTOTYPE_ALGORITHMS.generativeRemove.id) {
        throw new Error("Generative Remove implementation is invalid.");
      }
      const consent = parseGenerativeRemoveConsentReceipt(value.consent);
      if (!sameSourceRevision(consent.sourceRevision, base.sourceRevision)) {
        throw new Error("Generative Remove consent is stale.");
      }
      const selection = parseDevelopAssetRef(value.selection);
      if (selection.kind !== "mask-matte") {
        throw new Error("Generative Remove selection must be a mask matte.");
      }
      if (consent.selectionAssetId !== selection.assetId) {
        throw new Error("Generative Remove consent does not match the selection.");
      }
      if (
        consent.expiresAtMs <= consent.grantedAtMs ||
        (consent.revokedAtMs !== null && consent.revokedAtMs < consent.grantedAtMs)
      ) {
        throw new Error("Generative Remove consent lifetime is invalid.");
      }
      return {
        ...base,
        kind: "generative-remove",
        implementation: PROTOTYPE_ALGORITHMS.generativeRemove.id,
        selection,
        consent,
        seed: boundedInteger(value.seed, "Generative Remove seed", 0, 0xffff_ffff),
        searchRadius: boundedInteger(
          value.searchRadius,
          "Generative Remove search radius",
          1,
          64,
        ),
      };
    }
    default:
      throw new Error("Develop job operation is invalid.");
  }
}

export function provenanceForDevelopJob(
  request: DevelopJobRequest,
): DevelopJobProvenance {
  const base = {
    implementation: "prototype",
    algorithmRevision: "1",
    parameterHash: request.parameterHash,
    sourceRevision: request.sourceRevision,
    documentRevision: request.documentRevision,
    frameRevision: request.frameRevision,
  } as const satisfies DevelopJobProvenanceBase;
  switch (request.kind) {
    case "depth":
      return {
        ...base,
        operation: "depth",
        algorithmId: request.implementation,
      };
    case "denoise":
      return {
        ...base,
        operation: "denoise",
        algorithmId: request.implementation,
      };
    case "raw-details":
      return {
        ...base,
        operation: "raw-details",
        algorithmId: request.implementation,
      };
    case "super-resolution":
      return {
        ...base,
        operation: "super-resolution",
        algorithmId: request.implementation,
      };
    case "generative-remove":
      return {
        ...base,
        operation: "generative-remove",
        algorithmId: request.implementation,
      };
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

export function recoveryActionForFailure(
  code: DevelopJobFailureCode,
): DevelopJobRecoveryAction {
  switch (code) {
    case "model-unavailable":
      return "repair-model";
    case "unsupported-input":
      return "choose-supported-input";
    case "device-limit":
      return "reduce-work-or-change-device";
    case "privacy-limit":
      return "review-consent";
    case "provider-error":
      return "retry-provider";
    case "integrity-error":
      return "restore-or-rebuild";
    case "filesystem-error":
      return "repair-storage";
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function parseFailureCode(value: unknown): DevelopJobFailureCode {
  switch (value) {
    case "model-unavailable":
    case "unsupported-input":
    case "device-limit":
    case "privacy-limit":
    case "provider-error":
    case "integrity-error":
    case "filesystem-error":
      return value;
    default:
      throw new Error("Develop job failure code is invalid.");
  }
}

export function parseDevelopJobFailure(value: unknown): DevelopJobFailure {
  if (!isRecord(value) || typeof value.retryable !== "boolean") {
    throw new Error("Develop job failure is invalid.");
  }
  const code = parseFailureCode(value.code);
  const recovery = recoveryActionForFailure(code);
  if (value.recovery !== recovery) {
    throw new Error("Develop job recovery action does not match the failure.");
  }
  return {
    code,
    message: boundedText(value.message, "Develop job failure message", 1_024),
    retryable: value.retryable,
    recovery,
  };
}

export function createQueuedDevelopJob(input: {
  readonly id: DevelopJobId;
  readonly request: DevelopJobRequest;
  readonly nowMs: number;
}): DevelopJobSnapshot {
  const nowMs = boundedInteger(input.nowMs, "Develop job creation time", 0, Number.MAX_SAFE_INTEGER);
  return {
    id: input.id,
    request: input.request,
    provenance: provenanceForDevelopJob(input.request),
    attempt: 1,
    retryOf: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    status: "queued",
  };
}

function validEventTime(job: DevelopJobSnapshot, atMs: number): boolean {
  return Number.isSafeInteger(atMs) && atMs >= job.updatedAtMs;
}

function progress(completed: number, total: number): DevelopJobProgress | null {
  if (
    !Number.isSafeInteger(completed) ||
    !Number.isSafeInteger(total) ||
    completed < 0 ||
    total <= 0 ||
    completed > total
  ) {
    return null;
  }
  return { completed, total };
}

function candidates(
  values: readonly DevelopAssetCandidate[],
): readonly [DevelopAssetCandidate, ...DevelopAssetCandidate[]] | null {
  if (values.length === 0 || values.length > MAX_DEVELOP_JOB_CANDIDATES) return null;
  const first = values[0];
  if (!first) return null;
  return [first, ...values.slice(1)];
}

function assets(
  values: readonly DevelopAssetRef[],
): readonly [DevelopAssetRef, ...DevelopAssetRef[]] | null {
  if (values.length === 0 || values.length > MAX_DEVELOP_JOB_CANDIDATES) return null;
  const first = values[0];
  if (!first) return null;
  return [first, ...values.slice(1)];
}

function snapshotBase(job: DevelopJobSnapshot): DevelopJobBase {
  return {
    id: job.id,
    request: job.request,
    provenance: job.provenance,
    attempt: job.attempt,
    retryOf: job.retryOf,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
  };
}

export function transitionDevelopJob(
  job: DevelopJobSnapshot,
  event: DevelopJobTransitionEvent,
): DevelopJobTransitionResult {
  if (!validEventTime(job, event.atMs)) {
    return { kind: "invalid", reason: "Develop job transition time is invalid." };
  }
  const base = { ...snapshotBase(job), updatedAtMs: event.atMs };
  switch (event.kind) {
    case "prepare":
      return job.status === "queued"
        ? { kind: "changed", job: { ...base, status: "preparing", stage: "validating-input" } }
        : invalidTransition(job, event);
    case "run": {
      if (job.status !== "preparing") return invalidTransition(job, event);
      const initial = progress(0, event.total);
      return initial
        ? { kind: "changed", job: { ...base, status: "running", stage: event.stage, progress: initial } }
        : { kind: "invalid", reason: "Develop job progress total is invalid." };
    }
    case "progress": {
      if (job.status !== "running" && job.status !== "postprocess") {
        return invalidTransition(job, event);
      }
      const next = progress(event.completed, job.progress.total);
      if (!next || event.completed < job.progress.completed) {
        return { kind: "invalid", reason: "Develop job progress is invalid." };
      }
      return { kind: "changed", job: { ...job, updatedAtMs: event.atMs, progress: next } };
    }
    case "change-running-stage": {
      if (job.status !== "running") return invalidTransition(job, event);
      const stages: readonly DevelopJobRunningStage[] = [
        "decoding",
        "processing",
        "provider-request",
        "provider-response",
      ];
      if (stages.indexOf(event.stage) <= stages.indexOf(job.stage)) {
        return { kind: "invalid", reason: "Develop job stage must move forward." };
      }
      return {
        kind: "changed",
        job: { ...job, updatedAtMs: event.atMs, stage: event.stage },
      };
    }
    case "postprocess": {
      if (job.status !== "running" || job.progress.completed !== job.progress.total) {
        return invalidTransition(job, event);
      }
      const initial = progress(0, event.total);
      return initial
        ? { kind: "changed", job: { ...base, status: "postprocess", stage: "encoding-artifacts", progress: initial } }
        : { kind: "invalid", reason: "Develop job postprocess total is invalid." };
    }
    case "review": {
      if (job.status !== "postprocess" || job.progress.completed !== job.progress.total) {
        return invalidTransition(job, event);
      }
      const parsed = candidates(event.candidates);
      return parsed
        ? { kind: "changed", job: { ...base, status: "awaiting-review", candidates: parsed } }
        : { kind: "invalid", reason: "Develop job candidates are invalid." };
    }
    case "accept":
      if (
        job.status !== "awaiting-review" &&
        !(job.status === "interrupted" && job.reason === "acceptance-recovery")
      ) {
        return invalidTransition(job, event);
      }
      try {
        const selected = candidates(event.candidates);
        if (!selected) {
          return { kind: "invalid", reason: "Selected Develop job candidates are invalid." };
        }
        return {
          kind: "changed",
          job: {
            ...base,
            status: "accepting",
            candidates: selected,
            acceptanceId: boundedText(event.acceptanceId, "Acceptance ID"),
          },
        };
      } catch (error) {
        return invalidFromError(error);
      }
    case "accepted": {
      if (job.status !== "accepting") return invalidTransition(job, event);
      const acceptedAssets = assets(event.assets);
      return acceptedAssets
        ? {
            kind: "changed",
            job: {
              ...base,
              status: "accepted",
              assets: acceptedAssets,
              acceptanceId: job.acceptanceId,
            },
          }
        : { kind: "invalid", reason: "Accepted Develop job assets are invalid." };
    }
    case "cancel":
      if (
        job.status !== "queued" &&
        job.status !== "preparing" &&
        job.status !== "running" &&
        job.status !== "postprocess" &&
        job.status !== "awaiting-review"
      ) {
        return invalidTransition(job, event);
      }
      return { kind: "changed", job: { ...base, status: "cancelled", reason: event.reason } };
    case "fail":
      if (
        job.status !== "preparing" &&
        job.status !== "running" &&
        job.status !== "postprocess" &&
        job.status !== "accepting"
      ) {
        return invalidTransition(job, event);
      }
      if (event.failure.recovery !== recoveryActionForFailure(event.failure.code)) {
        return { kind: "invalid", reason: "Develop job failure recovery is invalid." };
      }
      return { kind: "changed", job: { ...base, status: "failed", failure: event.failure } };
    case "interrupt":
      if (job.status === "accepting") {
        return {
          kind: "changed",
          job: {
            ...base,
            status: "interrupted",
            reason: "acceptance-recovery",
            candidates: job.candidates,
            acceptanceId: job.acceptanceId,
          },
        };
      }
      if (
        job.status !== "queued" &&
        job.status !== "preparing" &&
        job.status !== "running" &&
        job.status !== "postprocess"
      ) {
        return invalidTransition(job, event);
      }
      return {
        kind: "changed",
        job: { ...base, status: "interrupted", reason: event.reason, candidates: [] },
      };
    case "mark-stale": {
      if (job.status !== "awaiting-review" && job.status !== "accepting") {
        return invalidTransition(job, event);
      }
      return {
        kind: "changed",
        job: {
          ...base,
          status: "stale",
          reason: event.reason,
          candidates: job.candidates,
        },
      };
    }
    case "discard":
      if (
        job.status !== "awaiting-review" &&
        job.status !== "cancelled" &&
        job.status !== "failed" &&
        job.status !== "interrupted" &&
        job.status !== "stale"
      ) {
        return invalidTransition(job, event);
      }
      return {
        kind: "changed",
        job: { ...base, status: "discarded", reason: "user-discarded" },
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function invalidTransition(
  job: DevelopJobSnapshot,
  event: DevelopJobTransitionEvent,
): DevelopJobTransitionResult {
  return {
    kind: "invalid",
    reason: `Cannot apply ${event.kind} to a ${job.status} Develop job.`,
  };
}

function invalidFromError(error: unknown): DevelopJobTransitionResult {
  return {
    kind: "invalid",
    reason: error instanceof Error ? error.message : "Develop job transition is invalid.",
  };
}

export function retryDevelopJob(input: {
  readonly previous: DevelopJobSnapshot;
  readonly id: DevelopJobId;
  readonly request: DevelopJobRequest;
  readonly nowMs: number;
}): DevelopJobTransitionResult {
  const { previous } = input;
  const retryable = previous.status === "cancelled" ||
    previous.status === "interrupted" ||
    previous.status === "stale" ||
    (previous.status === "failed" && previous.failure.retryable);
  if (!retryable) {
    return { kind: "invalid", reason: "This Develop job cannot be retried." };
  }
  if (input.request.kind !== previous.request.kind) {
    return { kind: "invalid", reason: "A retry cannot change the Develop operation." };
  }
  if (previous.attempt >= MAX_DEVELOP_JOB_ATTEMPTS) {
    return { kind: "invalid", reason: "Develop job retry limit reached." };
  }
  if (!validEventTime(previous, input.nowMs)) {
    return { kind: "invalid", reason: "Develop job retry time is invalid." };
  }
  if (input.id.value === previous.id.value) {
    return { kind: "invalid", reason: "A retry requires a new Develop job ID." };
  }
  return {
    kind: "changed",
    job: {
      id: input.id,
      request: input.request,
      provenance: provenanceForDevelopJob(input.request),
      attempt: previous.attempt + 1,
      retryOf: previous.id,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
      status: "queued",
    },
  };
}

function parseProgress(value: unknown): DevelopJobProgress {
  if (!isRecord(value)) throw new Error("Develop job progress is invalid.");
  const parsed = progress(
    boundedInteger(value.completed, "Develop job completed work", 0, Number.MAX_SAFE_INTEGER),
    boundedInteger(value.total, "Develop job total work", 1, Number.MAX_SAFE_INTEGER),
  );
  if (!parsed) throw new Error("Develop job progress is invalid.");
  return parsed;
}

function parseCandidates(value: unknown): readonly [DevelopAssetCandidate, ...DevelopAssetCandidate[]] {
  if (!Array.isArray(value)) throw new Error("Develop job candidates are invalid.");
  const parsed = candidates(value.map(parseDevelopAssetCandidate));
  if (!parsed) throw new Error("Develop job candidates are invalid.");
  return parsed;
}

function parseAssets(value: unknown): readonly [DevelopAssetRef, ...DevelopAssetRef[]] {
  if (!Array.isArray(value)) throw new Error("Develop job assets are invalid.");
  const parsed = assets(value.map(parseDevelopAssetRef));
  if (!parsed) throw new Error("Develop job assets are invalid.");
  return parsed;
}

function parseStaleCandidates(value: unknown): readonly DevelopAssetCandidate[] {
  if (!Array.isArray(value) || value.length > MAX_DEVELOP_JOB_CANDIDATES) {
    throw new Error("Develop job stale candidates are invalid.");
  }
  return value.map(parseDevelopAssetCandidate);
}

function revisionsEqual(
  left: DevelopJobProvenance,
  right: DevelopJobProvenance,
): boolean {
  return left.implementation === right.implementation &&
    left.operation === right.operation &&
    left.algorithmId === right.algorithmId &&
    left.algorithmRevision === right.algorithmRevision &&
    left.parameterHash === right.parameterHash &&
    left.sourceRevision.value === right.sourceRevision.value &&
    left.documentRevision.value === right.documentRevision.value &&
    left.frameRevision.value === right.frameRevision.value;
}

function parseProvenance(
  value: unknown,
  request: DevelopJobRequest,
): DevelopJobProvenance {
  if (!isRecord(value)) throw new Error("Develop job provenance is invalid.");
  const suppliedRequest = {
    ...request,
    parameterHash: parseSha256Digest(value.parameterHash),
    sourceRevision: parseSourceRevision(value.sourceRevision),
    documentRevision: parseDevelopDocumentRevision(value.documentRevision),
    frameRevision: parseCoordinateFrameRevision(value.frameRevision),
  } satisfies DevelopJobRequest;
  const supplied = provenanceForDevelopJob(suppliedRequest);
  if (
    value.implementation !== "prototype" ||
    value.operation !== supplied.operation ||
    value.algorithmId !== supplied.algorithmId ||
    value.algorithmRevision !== "1"
  ) {
    throw new Error("Develop job provenance is invalid.");
  }
  return supplied;
}

function parseSnapshotBase(value: Record<string, unknown>): DevelopJobBase {
  const request = parseDevelopJobRequest(value.request);
  const createdAtMs = boundedInteger(value.createdAtMs, "Develop job creation time", 0, Number.MAX_SAFE_INTEGER);
  const updatedAtMs = boundedInteger(value.updatedAtMs, "Develop job update time", createdAtMs, Number.MAX_SAFE_INTEGER);
  const retryOf = value.retryOf === null ? null : parseDevelopJobId(value.retryOf);
  const expected = provenanceForDevelopJob(request);
  const supplied = parseProvenance(value.provenance, request);
  if (!revisionsEqual(supplied, expected)) {
    throw new Error("Develop job provenance is invalid.");
  }
  return {
    id: parseDevelopJobId(value.id),
    request,
    provenance: expected,
    attempt: boundedInteger(value.attempt, "Develop job attempt", 1, MAX_DEVELOP_JOB_ATTEMPTS),
    retryOf,
    createdAtMs,
    updatedAtMs,
  };
}

export function parseDevelopJobSnapshot(value: unknown): DevelopJobSnapshot {
  if (!isRecord(value)) throw new Error("Develop job snapshot is invalid.");
  const base = parseSnapshotBase(value);
  switch (value.status) {
    case "queued":
      return { ...base, status: "queued" };
    case "preparing":
      if (value.stage !== "validating-input") throw new Error("Develop job stage is invalid.");
      return { ...base, status: "preparing", stage: "validating-input" };
    case "running":
      if (
        value.stage !== "decoding" &&
        value.stage !== "processing" &&
        value.stage !== "provider-request" &&
        value.stage !== "provider-response"
      ) {
        throw new Error("Develop job stage is invalid.");
      }
      return { ...base, status: "running", stage: value.stage, progress: parseProgress(value.progress) };
    case "postprocess":
      if (value.stage !== "encoding-artifacts") throw new Error("Develop job stage is invalid.");
      return { ...base, status: "postprocess", stage: "encoding-artifacts", progress: parseProgress(value.progress) };
    case "awaiting-review":
      return { ...base, status: "awaiting-review", candidates: parseCandidates(value.candidates) };
    case "accepting":
      return {
        ...base,
        status: "accepting",
        candidates: parseCandidates(value.candidates),
        acceptanceId: boundedText(value.acceptanceId, "Acceptance ID"),
      };
    case "accepted":
      return {
        ...base,
        status: "accepted",
        assets: parseAssets(value.assets),
        acceptanceId: boundedText(value.acceptanceId, "Acceptance ID"),
      };
    case "cancelled":
      if (value.reason !== "user-requested" && value.reason !== "superseded") {
        throw new Error("Develop job cancellation reason is invalid.");
      }
      return { ...base, status: "cancelled", reason: value.reason };
    case "failed":
      return { ...base, status: "failed", failure: parseDevelopJobFailure(value.failure) };
    case "interrupted":
      if (value.reason === "acceptance-recovery") {
        return {
          ...base,
          status: "interrupted",
          reason: "acceptance-recovery",
          candidates: parseCandidates(value.candidates),
          acceptanceId: boundedText(value.acceptanceId, "Acceptance ID"),
        };
      }
      if (
        value.reason !== "application-restart" &&
        value.reason !== "worker-exit" &&
        value.reason !== "provider-state-unknown"
      ) {
        throw new Error("Develop job interruption reason is invalid.");
      }
      if (!Array.isArray(value.candidates) || value.candidates.length !== 0) {
        throw new Error("Develop job interruption candidates are invalid.");
      }
      return { ...base, status: "interrupted", reason: value.reason, candidates: [] };
    case "stale":
      if (
        value.reason !== "source-revision" &&
        value.reason !== "document-revision" &&
        value.reason !== "frame-revision"
      ) {
        throw new Error("Develop job stale reason is invalid.");
      }
      return {
        ...base,
        status: "stale",
        reason: value.reason,
        candidates: parseStaleCandidates(value.candidates),
      };
    case "discarded":
      if (value.reason !== "user-discarded") {
        throw new Error("Develop job discarded reason is invalid.");
      }
      return { ...base, status: "discarded", reason: "user-discarded" };
    default:
      throw new Error("Develop job status is invalid.");
  }
}

export function developJobStatusLabel(status: DevelopJobSnapshot["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "preparing":
      return "Preparing";
    case "running":
      return "Processing";
    case "postprocess":
      return "Finishing";
    case "awaiting-review":
      return "Prototype ready to review";
    case "accepting":
      return "Saving prototype result";
    case "accepted":
      return "Prototype accepted";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "stale":
      return "Prototype result is stale";
    case "discarded":
      return "Discarded";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
