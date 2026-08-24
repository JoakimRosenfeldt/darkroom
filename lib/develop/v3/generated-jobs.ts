import {
  COORDINATE_FRAME_REVISION,
  type SemanticStageId,
  type V3SourceSignature,
} from "../process";
import {
  parseSha256Digest,
  type Sha256Digest,
} from "../render-contract";
import {
  MAX_DEVELOP_ASSET_REFS,
  parseDevelopAssetDescriptor,
  type DevelopAssetCandidate,
  type DevelopAssetDescriptor,
  type DevelopAssetRef,
} from "./assets";

export type GeneratedJobKind = "people" | "reflection" | "dust" | "depth";

export type GeneratedJobCapability =
  | {
      readonly kind: "available";
      readonly jobKind: GeneratedJobKind;
      readonly modelRevision: string;
      readonly evidence: readonly [string, ...string[]];
    }
  | {
      readonly kind: "manual-cleanup";
      readonly jobKind: "people" | "reflection" | "dust";
      readonly reason: string;
    }
  | {
      readonly kind: "disabled";
      readonly jobKind: "depth";
      readonly reason: string;
    };

export interface GeneratedInputFingerprint {
  readonly inputFingerprint: Sha256Digest;
  readonly sourceSignature: V3SourceSignature;
  readonly documentRevision: string;
  readonly coordinateFrameRevision: typeof COORDINATE_FRAME_REVISION;
  readonly colorStageId: SemanticStageId;
  readonly targetComponentId: string;
  readonly producerId: string;
  readonly producerRevision: string;
  readonly modelRevision: string;
}

interface GeneratedJobBase {
  readonly id: string;
  readonly jobKind: GeneratedJobKind;
  readonly input: GeneratedInputFingerprint;
}

export type GeneratedJobError =
  | {
      readonly kind: "model-unavailable";
      readonly message: string;
      readonly retryable: false;
    }
  | {
      readonly kind: "execution-failed" | "invalid-output";
      readonly message: string;
      readonly retryable: boolean;
    };

export type GeneratedJob =
  | GeneratedJobBase & { readonly status: "queued" }
  | GeneratedJobBase & {
      readonly status: "running";
      readonly progress: number;
    }
  | GeneratedJobBase & {
      readonly status: "failed";
      readonly error: GeneratedJobError;
    }
  | GeneratedJobBase & { readonly status: "cancelled" }
  | GeneratedJobBase & {
      readonly status: "candidate";
      readonly candidates: readonly [
        DevelopAssetCandidate,
        ...DevelopAssetCandidate[],
      ];
    }
  | GeneratedJobBase & { readonly status: "rejected" }
  | GeneratedJobBase & {
      readonly status: "stale";
      readonly candidates: readonly [
        DevelopAssetCandidate,
        ...DevelopAssetCandidate[],
      ];
      readonly reasons: readonly [StaleGeneratedInput, ...StaleGeneratedInput[]];
    }
  | GeneratedJobBase & {
      readonly status: "accepted";
      readonly assetRefs: readonly [DevelopAssetRef, ...DevelopAssetRef[]];
    };

export type StaleGeneratedInput =
  | "input-fingerprint"
  | "source-signature"
  | "document-revision"
  | "coordinate-frame-revision"
  | "color-stage-id"
  | "target-component"
  | "producer-revision"
  | "model-revision";

export type GeneratedJobTransition =
  | { readonly kind: "changed"; readonly job: GeneratedJob }
  | { readonly kind: "invalid"; readonly reason: string };

export type GeneratedJobRequestResult =
  | { readonly kind: "queued"; readonly job: GeneratedJob }
  | {
      readonly kind: "manual-cleanup";
      readonly jobKind: "people" | "reflection" | "dust";
      readonly reason: string;
    }
  | {
      readonly kind: "disabled";
      readonly jobKind: "depth";
      readonly reason: string;
    }
  | { readonly kind: "invalid"; readonly reason: string };

export type GeneratedAcceptanceResult =
  | {
      readonly kind: "accepted";
      readonly job: Extract<GeneratedJob, { readonly status: "accepted" }>;
      readonly targetComponentId: string;
      readonly assetRefs: readonly [DevelopAssetRef, ...DevelopAssetRef[]];
    }
  | {
      readonly kind: "stale";
      readonly job: Extract<GeneratedJob, { readonly status: "stale" }>;
    }
  | { readonly kind: "invalid"; readonly reason: string };

function boundedText(value: string, label: string): string {
  if (value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
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

function validSourceSignature(signature: V3SourceSignature): boolean {
  return signature.entryId.length > 0 && signature.entryId.length <= 1_024 &&
    signature.catalogId.length > 0 && signature.catalogId.length <= 1_024 &&
    signature.relativePath.length > 0 && signature.relativePath.length <= 4_096 &&
    Number.isSafeInteger(signature.assetRevision) && signature.assetRevision >= 0 &&
    Number.isSafeInteger(signature.size) && signature.size >= 0 &&
    Number.isSafeInteger(signature.lastModified) && signature.lastModified >= 0;
}

function validateInput(input: GeneratedInputFingerprint): string | null {
  try {
    parseSha256Digest(input.inputFingerprint);
    boundedText(input.documentRevision, "Document revision");
    boundedText(input.targetComponentId, "Target component ID");
    boundedText(input.producerId, "Producer ID");
    boundedText(input.producerRevision, "Producer revision");
    boundedText(input.modelRevision, "Model revision");
  } catch (error) {
    return error instanceof Error ? error.message : "Generated input is invalid.";
  }
  if (
    input.coordinateFrameRevision !== COORDINATE_FRAME_REVISION ||
    !validSourceSignature(input.sourceSignature)
  ) {
    return "Generated input fingerprint is invalid.";
  }
  return null;
}

function candidateMatchesInput(
  descriptor: DevelopAssetDescriptor,
  input: GeneratedInputFingerprint,
): boolean {
  return sourceSignaturesEqual(descriptor.sourceSignature, input.sourceSignature) &&
    descriptor.coordinateFrameRevision === input.coordinateFrameRevision &&
    descriptor.colorStageId === input.colorStageId &&
    descriptor.producerId === input.producerId &&
    descriptor.producerRevision === input.producerRevision;
}

function assetRefFromDescriptor(
  descriptor: DevelopAssetDescriptor,
): DevelopAssetRef {
  return {
    assetId: descriptor.sha256,
    kind: descriptor.kind,
    sha256: descriptor.sha256,
    producerRevision: descriptor.producerRevision,
    coordinateFrameRevision: descriptor.coordinateFrameRevision,
    colorStageId: descriptor.colorStageId,
  };
}

function parsedCandidates(
  candidates: readonly DevelopAssetCandidate[],
  input: GeneratedInputFingerprint,
): readonly [DevelopAssetCandidate, ...DevelopAssetCandidate[]] | null {
  if (candidates.length === 0 || candidates.length > MAX_DEVELOP_ASSET_REFS) {
    return null;
  }
  const parsed: DevelopAssetCandidate[] = [];
  try {
    for (const candidate of candidates) {
      const descriptor = parseDevelopAssetDescriptor(candidate.descriptor);
      if (
        candidate.kind !== "candidate" ||
        candidate.candidateId.length === 0 ||
        candidate.candidateId.length > 256 ||
        !candidateMatchesInput(descriptor, input)
      ) {
        return null;
      }
      parsed.push({
        kind: "candidate",
        candidateId: candidate.candidateId,
        descriptor,
      });
    }
  } catch {
    return null;
  }
  const first = parsed[0];
  if (!first) return null;
  return [first, ...parsed.slice(1)];
}

export function currentGeneratedJobCapability(
  jobKind: GeneratedJobKind,
): GeneratedJobCapability {
  switch (jobKind) {
    case "people":
    case "reflection":
    case "dust":
      return {
        kind: "manual-cleanup",
        jobKind,
        reason: `No accepted local ${jobKind} removal model is available.`,
      };
    case "depth":
      return {
        kind: "disabled",
        jobKind,
        reason: "No accepted local depth model is available.",
      };
    default: {
      const exhaustive: never = jobKind;
      return exhaustive;
    }
  }
}

export function requestGeneratedJob(input: {
  readonly id: string;
  readonly jobKind: GeneratedJobKind;
  readonly fingerprint: GeneratedInputFingerprint;
  readonly capability?: GeneratedJobCapability;
}): GeneratedJobRequestResult {
  const capability = input.capability ?? currentGeneratedJobCapability(input.jobKind);
  if (capability.jobKind !== input.jobKind) {
    return { kind: "invalid", reason: "Generated capability kind does not match." };
  }
  if (capability.kind === "manual-cleanup") return capability;
  if (capability.kind === "disabled") return capability;
  const inputError = validateInput(input.fingerprint);
  try {
    boundedText(input.id, "Generated job ID");
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : "Generated job ID is invalid.",
    };
  }
  if (inputError) return { kind: "invalid", reason: inputError };
  if (capability.modelRevision !== input.fingerprint.modelRevision) {
    return { kind: "invalid", reason: "Generated model revision does not match." };
  }
  return {
    kind: "queued",
    job: {
      id: input.id,
      jobKind: input.jobKind,
      input: input.fingerprint,
      status: "queued",
    },
  };
}

export function startGeneratedJob(job: GeneratedJob): GeneratedJobTransition {
  if (job.status !== "queued") {
    return { kind: "invalid", reason: "Only a queued generated job can start." };
  }
  return { kind: "changed", job: { ...job, status: "running", progress: 0 } };
}

export function updateGeneratedJobProgress(
  job: GeneratedJob,
  progress: number,
): GeneratedJobTransition {
  if (job.status !== "running") {
    return { kind: "invalid", reason: "Only a running generated job has progress." };
  }
  if (!Number.isFinite(progress) || progress < job.progress || progress < 0 || progress > 1) {
    return { kind: "invalid", reason: "Generated job progress is invalid." };
  }
  return { kind: "changed", job: { ...job, progress } };
}

export function completeGeneratedJob(
  job: GeneratedJob,
  candidates: readonly DevelopAssetCandidate[],
): GeneratedJobTransition {
  if (job.status !== "running") {
    return { kind: "invalid", reason: "Only a running generated job can complete." };
  }
  const acceptedCandidates = parsedCandidates(candidates, job.input);
  if (!acceptedCandidates) {
    return { kind: "invalid", reason: "Generated candidates are invalid or stale." };
  }
  return {
    kind: "changed",
    job: { ...job, status: "candidate", candidates: acceptedCandidates },
  };
}

export function failGeneratedJob(
  job: GeneratedJob,
  error: GeneratedJobError,
): GeneratedJobTransition {
  if (job.status !== "running") {
    return { kind: "invalid", reason: "Only a running generated job can fail." };
  }
  if (error.message.length === 0 || error.message.length > 1_024) {
    return { kind: "invalid", reason: "Generated job error is invalid." };
  }
  return { kind: "changed", job: { ...job, status: "failed", error } };
}

export function cancelGeneratedJob(job: GeneratedJob): GeneratedJobTransition {
  if (job.status !== "queued" && job.status !== "running") {
    return { kind: "invalid", reason: "This generated job cannot be cancelled." };
  }
  return { kind: "changed", job: { ...job, status: "cancelled" } };
}

export function rejectGeneratedCandidate(job: GeneratedJob): GeneratedJobTransition {
  if (job.status !== "candidate") {
    return { kind: "invalid", reason: "Only a generated candidate can be rejected." };
  }
  return {
    kind: "changed",
    job: { id: job.id, jobKind: job.jobKind, input: job.input, status: "rejected" },
  };
}

function staleInputs(
  original: GeneratedInputFingerprint,
  current: GeneratedInputFingerprint,
): readonly StaleGeneratedInput[] {
  const reasons: StaleGeneratedInput[] = [];
  if (original.inputFingerprint !== current.inputFingerprint) reasons.push("input-fingerprint");
  if (!sourceSignaturesEqual(original.sourceSignature, current.sourceSignature)) {
    reasons.push("source-signature");
  }
  if (original.documentRevision !== current.documentRevision) reasons.push("document-revision");
  if (original.coordinateFrameRevision !== current.coordinateFrameRevision) {
    reasons.push("coordinate-frame-revision");
  }
  if (original.colorStageId !== current.colorStageId) reasons.push("color-stage-id");
  if (original.targetComponentId !== current.targetComponentId) reasons.push("target-component");
  if (
    original.producerId !== current.producerId ||
    original.producerRevision !== current.producerRevision
  ) {
    reasons.push("producer-revision");
  }
  if (original.modelRevision !== current.modelRevision) reasons.push("model-revision");
  return reasons;
}

export function acceptGeneratedCandidate(
  job: GeneratedJob,
  current: GeneratedInputFingerprint,
): GeneratedAcceptanceResult {
  if (job.status !== "candidate") {
    return { kind: "invalid", reason: "Only a current candidate can be accepted." };
  }
  const currentError = validateInput(current);
  if (currentError) return { kind: "invalid", reason: currentError };
  const reasons = staleInputs(job.input, current);
  const firstReason = reasons[0];
  if (firstReason) {
    return {
      kind: "stale",
      job: {
        ...job,
        status: "stale",
        reasons: [firstReason, ...reasons.slice(1)],
      },
    };
  }
  const references = job.candidates.map((candidate) =>
    assetRefFromDescriptor(candidate.descriptor)
  );
  const firstReference = references[0];
  if (!firstReference) {
    return { kind: "invalid", reason: "Generated candidate has no assets." };
  }
  const assetRefs: readonly [DevelopAssetRef, ...DevelopAssetRef[]] = [
    firstReference,
    ...references.slice(1),
  ];
  const acceptedJob = { ...job, status: "accepted", assetRefs } satisfies Extract<
    GeneratedJob,
    { readonly status: "accepted" }
  >;
  return {
    kind: "accepted",
    job: acceptedJob,
    targetComponentId: current.targetComponentId,
    assetRefs,
  };
}

export function retryGeneratedJob(input: {
  readonly previous: GeneratedJob;
  readonly id: string;
  readonly fingerprint: GeneratedInputFingerprint;
  readonly capability?: GeneratedJobCapability;
}): GeneratedJobRequestResult {
  switch (input.previous.status) {
    case "failed":
    case "cancelled":
    case "rejected":
    case "stale":
      return requestGeneratedJob({
        id: input.id,
        jobKind: input.previous.jobKind,
        fingerprint: input.fingerprint,
        capability: input.capability,
      });
    case "queued":
    case "running":
    case "candidate":
    case "accepted":
      return { kind: "invalid", reason: "This generated job cannot be retried." };
    default: {
      const exhaustive: never = input.previous;
      return exhaustive;
    }
  }
}
