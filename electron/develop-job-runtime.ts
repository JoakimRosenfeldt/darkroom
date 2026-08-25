import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  type DevelopJobAcceptanceResult,
  type DevelopJobAcceptRequest,
  type DevelopJobIntent,
  type DevelopJobRetryRequest,
  type DevelopJobStartRequest,
  type DevelopJobTargetRequest,
  type GenerativeRemoveConsentGrantRequest,
  type GenerativeRemoveConsentRevokeRequest,
} from "../lib/develop/v3/job-api.ts";
import {
  createQueuedDevelopJob,
  parseGenerativeRemoveConsentReceipt,
  parseDevelopJobRequest,
  parseDevelopJobSnapshot,
  retryDevelopJob,
  transitionDevelopJob,
  type DevelopJobFailure,
  type DevelopJobId,
  type DevelopJobRequest,
  type DevelopJobSnapshot,
  type DevelopJobTransitionEvent,
  type CoordinateFrameRevision,
  type GenerativeRemoveConsentReceipt,
  type SourceRevision,
} from "../lib/develop/v3/jobs.ts";
import {
  createPrototypeDepthMap,
  denoisePrototypeImage,
  enhancePrototypeRawDetails,
  generativeRemovePrototype,
  superResolvePrototypeImage,
  type PrototypeDepthOutput,
  type PrototypeImage,
  type PrototypeImageOutput,
  type PrototypeRemoveOutput,
} from "../lib/develop/v3/prototype-operations.ts";
import {
  COORDINATE_FRAME_REVISION,
  type SemanticStageId,
} from "../lib/develop/process.ts";
import { parseSha256Digest } from "../lib/develop/render-contract.ts";
import {
  DEPTH_MAP_CHANNELS,
  DEPTH_MAP_FLOAT32_LE,
  DEPTH_MAP_FORMAT_VERSION,
  DEPTH_MAP_HEADER_BYTES,
  DEPTH_MAP_MAGIC,
  sourceSignaturesMatch,
} from "../lib/develop/v3/asset-store.ts";
import {
  type DevelopAssetCandidate,
  type DevelopAssetDescriptor,
  type DevelopAssetRef,
} from "../lib/develop/v3/assets.ts";
import { DevelopAssetStore } from "./develop-asset-store.ts";

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_JOBS = 256;
const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const CONSENT_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_REMOVE_SELECTED_PIXELS = 262_144;

interface DevelopJobJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly jobs: readonly DevelopJobSnapshot[];
  readonly consents: readonly GenerativeRemoveConsentReceipt[];
}

interface ActiveCancellation {
  cancelled: boolean;
}

interface StagedCandidate {
  readonly candidate: DevelopAssetCandidate;
  readonly bytes: Uint8Array;
}

type ProcessorOutput =
  | PrototypeDepthOutput
  | PrototypeImageOutput
  | PrototypeRemoveOutput;

class PrototypeJobError extends Error {
  readonly code: DevelopJobFailure["code"];

  constructor(code: DevelopJobFailure["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJournal(value: unknown): DevelopJobJournal {
  if (
    !isRecord(value) ||
    value.version !== JOURNAL_VERSION ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > MAX_JOBS ||
    !Array.isArray(value.consents) ||
    value.consents.length > MAX_JOBS
  ) {
    throw new Error("Prototype job journal is invalid.");
  }
  const jobs = value.jobs.map(parseDevelopJobSnapshot);
  const consents = value.consents.map(parseGenerativeRemoveConsentReceipt);
  if (new Set(jobs.map((job) => job.id.value)).size !== jobs.length) {
    throw new Error("Prototype job journal contains duplicate IDs.");
  }
  if (new Set(consents.map((consent) => consent.id)).size !== consents.length) {
    throw new Error("Prototype job journal contains duplicate consent IDs.");
  }
  return { version: JOURNAL_VERSION, jobs, consents };
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function safeMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    error.message.length > 0 &&
    error.message.length <= 240 &&
    !error.message.includes("/") &&
    !error.message.includes("\\")
  ) {
    return error.message;
  }
  return fallback;
}

function canonicalHash(value: unknown): ReturnType<typeof parseSha256Digest> {
  return parseSha256Digest(
    createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  );
}

function deriveSourceRevision(source: DevelopJobIntent["source"]): SourceRevision {
  return {
    kind: "source-revision",
    value: canonicalHash([
      source.catalogId,
      source.entryId,
      source.assetRevision,
      source.relativePath,
      source.size,
      source.lastModified,
    ]),
  };
}

function generativeIntentHash(input: {
  readonly selectionAssetId: string;
  readonly seed: number;
  readonly searchRadius: number;
}): ReturnType<typeof parseSha256Digest> {
  return canonicalHash([
    "generative-remove",
    "local-mock-remove-v1",
    input.selectionAssetId,
    input.seed,
    input.searchRadius,
  ]);
}

function parameterHash(intent: DevelopJobIntent): ReturnType<typeof parseSha256Digest> {
  switch (intent.kind) {
    case "depth":
      return canonicalHash(["depth", "builtin-prototype-depth-v1"]);
    case "denoise":
      return canonicalHash(["denoise", "builtin-prototype-denoise-v1", intent.strength]);
    case "raw-details":
      return canonicalHash(["raw-details", "builtin-prototype-raw-details-v1", intent.amount]);
    case "super-resolution":
      return canonicalHash(["super-resolution", "builtin-prototype-super-resolution-v1", 2]);
    case "generative-remove":
      return generativeIntentHash({
        selectionAssetId: intent.selection.assetId,
        seed: intent.seed,
        searchRadius: intent.searchRadius,
      });
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Prototype job storage is unavailable.");
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await ensureDirectory(directoryPath);
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

function acceptedRef(candidate: DevelopAssetCandidate): DevelopAssetRef {
  const descriptor = candidate.descriptor;
  return {
    assetId: descriptor.sha256,
    kind: descriptor.kind,
    sha256: descriptor.sha256,
    producerRevision: descriptor.producerRevision,
    coordinateFrameRevision: descriptor.coordinateFrameRevision,
    colorStageId: descriptor.colorStageId,
  };
}

function validateCandidateSet(
  job: DevelopJobSnapshot,
  values: readonly DevelopAssetCandidate[],
  enforceProcessorCardinality = true,
): void {
  const expectedCount = job.request.kind === "generative-remove" ? 2 : 1;
  if (
    values.length === 0 ||
    (enforceProcessorCardinality && values.length !== expectedCount) ||
    new Set(values.map((candidate) => candidate.candidateId)).size !== values.length ||
    new Set(values.map((candidate) => candidate.descriptor.sha256)).size !== values.length
  ) {
    throw new PrototypeJobError(
      "integrity-error",
      "Prototype candidate count or identity is invalid.",
    );
  }
  const expectedKind = job.request.kind === "depth" ? "depth-map" : "repair-patch";
  for (const candidate of values) {
    const descriptor = candidate.descriptor;
    if (
      descriptor.kind !== expectedKind ||
      !sourceSignaturesMatch(descriptor.sourceSignature, job.request.source) ||
      descriptor.coordinateFrameRevision !== job.request.frameRevision.value ||
      descriptor.producerId !== job.provenance.algorithmId ||
      descriptor.producerRevision !== job.provenance.algorithmRevision
    ) {
      throw new PrototypeJobError(
        "integrity-error",
        "Prototype candidate provenance is invalid.",
      );
    }
  }
}

function validateWorkBudget(job: DevelopJobSnapshot, image: PrototypeImage): void {
  const pixels = image.dimensions.width * image.dimensions.height;
  const exceeds = job.request.kind === "denoise"
    ? pixels > 1_048_576
    : job.request.kind === "raw-details"
    ? pixels > 2_097_152
    : job.request.kind === "super-resolution"
    ? pixels > 1_048_576 ||
      image.dimensions.width > 1_024 ||
      image.dimensions.height > 1_024
    : job.request.kind === "generative-remove"
    ? pixels > 1_048_576
    : pixels > 4_194_304;
  if (exceeds) {
    throw new PrototypeJobError(
      "device-limit",
      "Image exceeds the synchronous prototype processing limit.",
    );
  }
}

function completedTransition(
  result: ReturnType<typeof transitionDevelopJob>,
): DevelopJobSnapshot {
  if (result.kind === "invalid") throw new Error(result.reason);
  return result.job;
}

function failure(
  code: DevelopJobFailure["code"],
  message: string,
  retryable: boolean,
): DevelopJobFailure {
  const recovery = code === "model-unavailable"
    ? "repair-model"
    : code === "unsupported-input"
    ? "choose-supported-input"
    : code === "device-limit"
    ? "reduce-work-or-change-device"
    : code === "privacy-limit"
    ? "review-consent"
    : code === "provider-error"
    ? "retry-provider"
    : code === "integrity-error"
    ? "restore-or-rebuild"
    : "repair-storage";
  return { code, message, retryable, recovery };
}

function encodeDepth(output: PrototypeDepthOutput): Uint8Array {
  const rowStride = output.dimensions.width * Float32Array.BYTES_PER_ELEMENT;
  const bytes = Buffer.alloc(
    DEPTH_MAP_HEADER_BYTES + rowStride * output.dimensions.height,
  );
  for (let index = 0; index < DEPTH_MAP_MAGIC.length; index += 1) {
    bytes[index] = DEPTH_MAP_MAGIC[index];
  }
  bytes.writeUInt16LE(DEPTH_MAP_FORMAT_VERSION, 8);
  bytes.writeUInt8(DEPTH_MAP_FLOAT32_LE, 10);
  bytes.writeUInt8(DEPTH_MAP_CHANNELS, 11);
  bytes.writeUInt32LE(output.dimensions.width, 12);
  bytes.writeUInt32LE(output.dimensions.height, 16);
  bytes.writeUInt32LE(rowStride, 20);
  for (let index = 0; index < output.values.length; index += 1) {
    bytes.writeFloatLE(
      output.values[index],
      DEPTH_MAP_HEADER_BYTES + index * Float32Array.BYTES_PER_ELEMENT,
    );
  }
  return Uint8Array.from(bytes);
}

async function encodeImage(image: PrototypeImage): Promise<Uint8Array> {
  const bytes = await sharp(Buffer.from(image.pixels), {
    raw: {
      width: image.dimensions.width,
      height: image.dimensions.height,
      channels: image.channels,
    },
  }).png({ compressionLevel: 6 }).toBuffer();
  return Uint8Array.from(bytes);
}

function descriptor(input: {
  readonly job: DevelopJobSnapshot;
  readonly bytes: Uint8Array;
  readonly dimensions: PrototypeImage["dimensions"];
  readonly kind: "depth-map" | "repair-patch";
  readonly colorStageId: SemanticStageId;
}): DevelopAssetDescriptor {
  return {
    kind: input.kind,
    sha256: parseSha256Digest(
      createHash("sha256").update(input.bytes).digest("hex"),
    ),
    sourceSignature: input.job.request.source,
    coordinateFrameRevision: COORDINATE_FRAME_REVISION,
    colorStageId: input.colorStageId,
    dimensions: input.dimensions,
    byteLength: input.bytes.byteLength,
    mimeType: input.kind === "depth-map"
      ? "application/x-darkroom-depth"
      : "image/png",
    producerId: input.job.provenance.algorithmId,
    producerRevision: input.job.provenance.algorithmRevision,
  };
}

async function stagedCandidates(
  job: DevelopJobSnapshot,
  output: ProcessorOutput,
): Promise<readonly [StagedCandidate, ...StagedCandidate[]]> {
  if (output.kind === "depth-map") {
    const bytes = encodeDepth(output);
    return [{
      bytes,
      candidate: {
        kind: "candidate",
        candidateId: `${job.id.value}:0`,
        descriptor: descriptor({
          job,
          bytes,
          dimensions: output.dimensions,
          kind: "depth-map",
          colorStageId: "canonical-geometry",
        }),
      },
    }];
  }
  const images: readonly PrototypeImage[] = output.kind === "alternatives"
    ? output.alternatives
    : [output.image];
  const staged: StagedCandidate[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (!image) continue;
    const bytes = await encodeImage(image);
    staged.push({
      bytes,
      candidate: {
        kind: "candidate",
        candidateId: `${job.id.value}:${index}`,
        descriptor: descriptor({
          job,
          bytes,
          dimensions: image.dimensions,
          kind: "repair-patch",
          colorStageId: "source-repair",
        }),
      },
    });
  }
  const first = staged[0];
  if (!first) throw new Error("Prototype processor produced no candidates.");
  return [first, ...staged.slice(1)];
}

async function decodeSelection(input: {
  readonly request: Extract<DevelopJobRequest, { readonly kind: "generative-remove" }>;
  readonly assetStore: DevelopAssetStore;
  readonly image: PrototypeImage;
}): Promise<Uint8Array> {
  const result = await input.assetStore.read({
    reference: input.request.selection,
    sourceSignature: input.request.source,
  });
  if (result.kind !== "ready") {
    throw new Error("Generative Remove selection is unavailable.");
  }
  const decoded = await sharp(result.bytes)
    .resize({
      width: input.image.dimensions.width,
      height: input.image.dimensions.height,
      fit: "fill",
      kernel: "nearest",
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== input.image.dimensions.width ||
    decoded.info.height !== input.image.dimensions.height ||
    decoded.info.channels !== 4
  ) {
    throw new Error("Generative Remove selection dimensions do not match.");
  }
  const selection = new Uint8Array(
    input.image.dimensions.width * input.image.dimensions.height,
  );
  let hasTransparency = false;
  for (let index = 0; index < selection.length; index += 1) {
    if (decoded.data[index * 4 + 3] !== 255) {
      hasTransparency = true;
      break;
    }
  }
  for (let index = 0; index < selection.length; index += 1) {
    selection[index] = decoded.data[index * 4 + (hasTransparency ? 3 : 0)];
  }
  return selection;
}

export class DevelopJobRuntime {
  private readonly journalPath: string;
  private readonly assetStore: DevelopAssetStore;
  private readonly onUpdate: (jobs: readonly DevelopJobSnapshot[]) => void;
  private jobs: DevelopJobSnapshot[] = [];
  private consents: GenerativeRemoveConsentReceipt[] = [];
  private initialized = false;
  private writable = true;
  private mutationQueue: Promise<void> = Promise.resolve();
  private executionQueue: Promise<void> = Promise.resolve();
  private readonly cancellations = new Map<string, ActiveCancellation>();

  constructor(input: {
    readonly journalPath: string;
    readonly assetStore: DevelopAssetStore;
    readonly onUpdate: (jobs: readonly DevelopJobSnapshot[]) => void;
  }) {
    if (!path.isAbsolute(input.journalPath) || path.normalize(input.journalPath) !== input.journalPath) {
      throw new Error("Prototype job journal path must be absolute and normalized.");
    }
    this.journalPath = input.journalPath;
    this.assetStore = input.assetStore;
    this.onUpdate = input.onUpdate;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await ensureDirectory(path.dirname(this.journalPath));
    let contents: string | null = null;
    try {
      const stat = await fs.lstat(this.journalPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) {
        throw new Error("Prototype job journal is invalid.");
      }
      const handle = await fs.open(
        this.journalPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        contents = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const journal = contents === null
      ? { version: JOURNAL_VERSION, jobs: [], consents: [] } satisfies DevelopJobJournal
      : parseJournal(JSON.parse(contents));
    this.jobs = [...journal.jobs];
    this.consents = [...journal.consents];
    const nowMs = Date.now();
    this.jobs = this.jobs.map((job) => {
      if (
        job.status !== "queued" &&
        job.status !== "preparing" &&
        job.status !== "running" &&
        job.status !== "postprocess" &&
        job.status !== "accepting"
      ) {
        return job;
      }
      return completedTransition(transitionDevelopJob(job, {
        kind: "interrupt",
        atMs: Math.max(nowMs, job.updatedAtMs),
        reason: job.request.kind === "generative-remove"
          ? "provider-state-unknown"
          : "application-restart",
      }));
    });
    this.initialized = true;
    await this.writeJournal();
  }

  list(): Promise<readonly DevelopJobSnapshot[]> {
    return this.serialized(async () => [...this.jobs]);
  }

  async start(input: DevelopJobStartRequest): Promise<DevelopJobSnapshot> {
    const job = await this.serialized(async () => {
      this.ensureJobCapacity();
      const nowMs = Date.now();
      const request = this.materializeIntent(input.intent, nowMs);
      const queued = createQueuedDevelopJob({
        id: { kind: "develop-job-id", value: randomUUID() },
        request,
        nowMs,
      });
      this.jobs.push(queued);
      await this.persistAndEmit();
      return queued;
    });
    this.schedule(job.id, input.image);
    return job;
  }

  async retry(input: DevelopJobRetryRequest): Promise<DevelopJobSnapshot> {
    const job = await this.serialized(async () => {
      const previous = this.requiredJob(input.jobId);
      this.ensureJobCapacity();
      const result = retryDevelopJob({
        previous,
        id: { kind: "develop-job-id", value: randomUUID() },
        request: this.materializeIntent(input.intent, Date.now()),
        nowMs: Date.now(),
      });
      if (result.kind === "invalid") throw new Error(result.reason);
      this.jobs.push(result.job);
      await this.persistAndEmit();
      return result.job;
    });
    this.schedule(job.id, input.image);
    return job;
  }

  cancel(input: DevelopJobTargetRequest): Promise<DevelopJobSnapshot> {
    const active = this.cancellations.get(input.jobId.value);
    if (active) active.cancelled = true;
    return this.serialized(async () => {
      const job = this.requiredJob(input.jobId);
      const result = transitionDevelopJob(job, {
        kind: "cancel",
        atMs: Math.max(Date.now(), job.updatedAtMs),
        reason: "user-requested",
      });
      if (result.kind === "invalid") throw new Error(result.reason);
      await this.finalizeCandidates(job, "cancelled");
      this.replace(result.job);
      await this.persistAndEmit();
      return result.job;
    });
  }

  grantGenerativeRemoveConsent(
    input: GenerativeRemoveConsentGrantRequest,
  ): Promise<GenerativeRemoveConsentReceipt> {
    return this.serialized(async () => {
      const read = await this.assetStore.read({
        reference: input.selection,
        sourceSignature: input.source,
      });
      if (read.kind !== "ready") {
        throw new Error("Generative Remove selection is unavailable.");
      }
      const nowMs = Date.now();
      const receipt = {
        kind: "generative-remove-consent",
        id: randomUUID(),
        provider: "local-mock-remove-v1",
        disclosure: "local-processing-no-network-v1",
        sourceRevision: deriveSourceRevision(input.source),
        selectionAssetId: input.selection.assetId,
        intentHash: generativeIntentHash({
          selectionAssetId: input.selection.assetId,
          seed: input.seed,
          searchRadius: input.searchRadius,
        }),
        grantedAtMs: nowMs,
        expiresAtMs: nowMs + CONSENT_LIFETIME_MS,
        revokedAtMs: null,
      } satisfies GenerativeRemoveConsentReceipt;
      this.consents.push(receipt);
      if (this.consents.length > MAX_JOBS) {
        this.consents = this.consents
          .filter((consent) => consent.revokedAtMs === null && consent.expiresAtMs > nowMs)
          .slice(-MAX_JOBS);
      }
      await this.persistAndEmit();
      return receipt;
    });
  }

  revokeGenerativeRemoveConsent(
    input: GenerativeRemoveConsentRevokeRequest,
  ): Promise<GenerativeRemoveConsentReceipt> {
    return this.serialized(async () => {
      const index = this.consents.findIndex((receipt) => receipt.id === input.receiptId);
      const current = this.consents[index];
      if (!current) throw new Error("Generative Remove consent receipt was not found.");
      if (current.revokedAtMs !== null) return current;
      const receipt = {
        ...current,
        revokedAtMs: Math.min(Date.now(), current.expiresAtMs),
      } satisfies GenerativeRemoveConsentReceipt;
      this.consents[index] = receipt;
      await this.persistAndEmit();
      return receipt;
    });
  }

  discard(input: DevelopJobTargetRequest): Promise<void> {
    return this.serialized(async () => {
      const job = this.requiredJob(input.jobId);
      if (!(job.status === "interrupted" && job.reason === "acceptance-recovery")) {
        await this.finalizeCandidates(job, "rejected");
      }
      const result = transitionDevelopJob(job, {
        kind: "discard",
        atMs: Math.max(Date.now(), job.updatedAtMs),
      });
      if (result.kind === "invalid") throw new Error(result.reason);
      this.replace(result.job);
      await this.persistAndEmit();
    });
  }

  accept(input: DevelopJobAcceptRequest): Promise<DevelopJobAcceptanceResult> {
    return this.serialized(async () => {
      const current = this.requiredJob(input.jobId);
      if (
        current.status !== "awaiting-review" &&
        !(current.status === "interrupted" && current.reason === "acceptance-recovery")
      ) {
        throw new Error("Only a prototype result awaiting review can be accepted.");
      }
      const reviewedCandidates = current.candidates;
      const currentSourceRevision = deriveSourceRevision(input.currentSource);
      const staleReason = current.request.sourceRevision.value !== currentSourceRevision.value
        ? "source-revision"
        : current.request.documentRevision.value !== input.currentDocumentRevision.value
        ? "document-revision"
        : current.request.frameRevision.value !== input.currentFrameRevision.value
        ? "frame-revision"
        : null;
      if (staleReason !== null) {
        const stale = completedTransition(transitionDevelopJob(current, {
          kind: "mark-stale",
          atMs: Math.max(Date.now(), current.updatedAtMs),
          reason: staleReason,
        }));
        this.replace(stale);
        await this.persistAndEmit();
        throw new Error("Prototype result is stale for the current Develop revision.");
      }
      validateCandidateSet(
        current,
        reviewedCandidates,
        current.status === "awaiting-review",
      );
      if (input.candidateIds.length !== 1) {
        throw new Error("Exactly one reviewed prototype candidate must be selected.");
      }
      const selected = reviewedCandidates.filter(
        (candidate) => candidate.candidateId === input.candidateIds[0],
      );
      if (selected.length !== 1) {
        throw new Error("Selected prototype candidate was not part of the review set.");
      }
      const acceptanceId = current.status === "interrupted"
        ? current.acceptanceId
        : randomUUID();
      const accepting = completedTransition(transitionDevelopJob(current, {
        kind: "accept",
        atMs: Math.max(Date.now(), current.updatedAtMs),
        acceptanceId,
        candidates: selected,
      }));
      this.replace(accepting);
      await this.persistAndEmit();
      const refs: DevelopAssetRef[] = [];
      for (const candidate of selected) {
        const reference = acceptedRef(candidate);
        const nowMs = Date.now();
        const result = await this.assetStore.transition({
          candidate,
          lifecycle: "accepted",
          reference,
          nowMs,
          recoveryUntilMs: nowMs + RECOVERY_WINDOW_MS,
        });
        if (result.kind !== "changed" && result.kind !== "unchanged") {
          const failed = completedTransition(transitionDevelopJob(accepting, {
            kind: "fail",
            atMs: Math.max(Date.now(), accepting.updatedAtMs),
            failure: failure(
              "integrity-error",
              "Prototype artifact could not be verified for acceptance.",
              true,
            ),
          }));
          this.replace(failed);
          await this.persistAndEmit();
          throw new Error("Prototype artifact could not be verified for acceptance.");
        }
        refs.push(reference);
      }
      const accepted = completedTransition(transitionDevelopJob(accepting, {
        kind: "accepted",
        atMs: Math.max(Date.now(), accepting.updatedAtMs),
        assets: refs,
      }));
      if (accepted.status !== "accepted") {
        throw new Error("Prototype acceptance did not complete.");
      }
      this.replace(accepted);
      await this.persistAndEmit();
      return { kind: "artifact-published-document-pending", job: accepted };
    });
  }

  private schedule(jobId: DevelopJobId, image: PrototypeImage): void {
    const run = () => this.run(jobId, image);
    this.executionQueue = this.executionQueue.then(run, run).catch(() => undefined);
  }

  private async run(jobId: DevelopJobId, image: PrototypeImage): Promise<void> {
    const cancellation = { cancelled: false } satisfies ActiveCancellation;
    const storedCandidates: DevelopAssetCandidate[] = [];
    this.cancellations.set(jobId.value, cancellation);
    try {
      let job = await this.apply(jobId, {
        kind: "prepare",
        atMs: Date.now(),
      });
      if (cancellation.cancelled) return;
      job = await this.apply(jobId, {
        kind: "run",
        atMs: Math.max(Date.now(), job.updatedAtMs),
        stage: job.request.kind === "generative-remove"
          ? "provider-request"
          : "processing",
        total: 1,
      });
      const processed = await this.process(job, image, cancellation);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (cancellation.cancelled || processed === null) return;
      job = await this.apply(jobId, {
        kind: "progress",
        atMs: Math.max(Date.now(), job.updatedAtMs),
        completed: 1,
      });
      job = await this.apply(jobId, {
        kind: "postprocess",
        atMs: Math.max(Date.now(), job.updatedAtMs),
        total: processed.kind === "alternatives" ? 2 : 1,
      });
      const staged = await stagedCandidates(job, processed);
      validateCandidateSet(job, staged.map((item) => item.candidate));
      for (let index = 0; index < staged.length; index += 1) {
        if (cancellation.cancelled) return;
        const item = staged[index];
        if (!item) continue;
        const nowMs = Date.now();
        const stored = await this.assetStore.put({
          candidate: item.candidate,
          bytes: item.bytes,
          nowMs,
          recoveryUntilMs: nowMs + RECOVERY_WINDOW_MS,
        });
        if (stored.kind === "rejected") {
          throw new Error("Prototype artifact failed integrity verification.");
        }
        storedCandidates.push(item.candidate);
        job = await this.apply(jobId, {
          kind: "progress",
          atMs: Math.max(Date.now(), job.updatedAtMs),
          completed: index + 1,
        });
      }
      await this.apply(jobId, {
        kind: "review",
        atMs: Math.max(Date.now(), job.updatedAtMs),
        candidates: staged.map((item) => item.candidate),
      });
    } catch (error) {
      await this.finalizeCandidateList(storedCandidates, "rejected");
      await this.failActiveJob(jobId, error);
    } finally {
      if (cancellation.cancelled) {
        await this.finalizeCandidateList(storedCandidates, "cancelled");
      }
      this.cancellations.delete(jobId.value);
    }
  }

  private async process(
    job: DevelopJobSnapshot,
    image: PrototypeImage,
    cancellation: ActiveCancellation,
  ): Promise<ProcessorOutput | null> {
    validateWorkBudget(job, image);
    const isCancelled = () => cancellation.cancelled;
    switch (job.request.kind) {
      case "depth": {
        const result = createPrototypeDepthMap({ image, isCancelled });
        return result.kind === "completed" ? result.output : null;
      }
      case "denoise": {
        const result = denoisePrototypeImage({
          image,
          parameters: { strength: job.request.strength },
          isCancelled,
        });
        return result.kind === "completed" ? result.output : null;
      }
      case "raw-details": {
        const result = enhancePrototypeRawDetails({
          image,
          parameters: { amount: job.request.amount },
          isCancelled,
        });
        return result.kind === "completed" ? result.output : null;
      }
      case "super-resolution": {
        const result = superResolvePrototypeImage({ image, isCancelled });
        return result.kind === "completed" ? result.output : null;
      }
      case "generative-remove": {
        const request = job.request;
        const currentConsent = this.consents.find(
          (receipt) => receipt.id === request.consent.id,
        );
        if (
          !currentConsent ||
          currentConsent.revokedAtMs !== null ||
          currentConsent.expiresAtMs <= Date.now() ||
          currentConsent.intentHash !== request.parameterHash ||
          currentConsent.selectionAssetId !== request.selection.assetId ||
          request.consent.provider !== "local-mock-remove-v1" ||
          request.consent.disclosure !== "local-processing-no-network-v1" ||
          request.consent.sourceRevision.value !== request.sourceRevision.value
        ) {
          throw new PrototypeJobError(
            "privacy-limit",
            "Generative Remove consent is invalid or stale.",
          );
        }
        const selection = await decodeSelection({
          request,
          assetStore: this.assetStore,
          image,
        });
        const consentAfterDecode = this.consents.find(
          (receipt) => receipt.id === request.consent.id,
        );
        if (
          !consentAfterDecode ||
          consentAfterDecode.revokedAtMs !== null ||
          consentAfterDecode.expiresAtMs <= Date.now() ||
          consentAfterDecode.intentHash !== request.parameterHash ||
          consentAfterDecode.selectionAssetId !== request.selection.assetId
        ) {
          throw new PrototypeJobError(
            "privacy-limit",
            "Generative Remove consent expired or was revoked.",
          );
        }
        await this.apply(job.id, {
          kind: "change-running-stage",
          atMs: Date.now(),
          stage: "provider-response",
        });
        let selectedPixels = 0;
        for (const value of selection) {
          if (value > 0) selectedPixels += 1;
        }
        if (selectedPixels === 0) {
          throw new PrototypeJobError(
            "unsupported-input",
            "Generative Remove selection is empty.",
          );
        }
        if (selectedPixels > MAX_REMOVE_SELECTED_PIXELS) {
          throw new PrototypeJobError(
            "device-limit",
            "Generative Remove selection exceeds the prototype limit.",
          );
        }
        const result = generativeRemovePrototype({
          image,
          parameters: {
            selection,
            seed: request.seed,
            searchRadius: request.searchRadius,
          },
          isCancelled,
        });
        return result.kind === "completed" ? result.output : null;
      }
      default: {
        const exhaustive: never = job.request;
        return exhaustive;
      }
    }
  }

  private async failActiveJob(jobId: DevelopJobId, error: unknown): Promise<void> {
    await this.serialized(async () => {
      const job = this.jobs.find((candidate) => candidate.id.value === jobId.value);
      if (
        !job ||
        job.status === "cancelled" ||
        job.status === "failed" ||
        job.status === "interrupted" ||
        job.status === "stale" ||
        job.status === "accepted"
      ) {
        return;
      }
      const result = transitionDevelopJob(job, {
        kind: "fail",
        atMs: Math.max(Date.now(), job.updatedAtMs),
        failure: failure(
          error instanceof PrototypeJobError
            ? error.code
            : job.request.kind === "generative-remove"
            ? "provider-error"
            : "integrity-error",
          safeMessage(error, "Prototype processing failed."),
          true,
        ),
      });
      if (result.kind === "invalid") return;
      this.replace(result.job);
      await this.persistAndEmit();
    });
  }

  private apply(
    jobId: DevelopJobId,
    event: DevelopJobTransitionEvent,
  ): Promise<DevelopJobSnapshot> {
    return this.serialized(async () => {
      const job = this.requiredJob(jobId);
      const result = transitionDevelopJob(job, {
        ...event,
        atMs: Math.max(event.atMs, job.updatedAtMs),
      });
      if (result.kind === "invalid") throw new Error(result.reason);
      this.replace(result.job);
      await this.persistAndEmit();
      return result.job;
    });
  }

  private async finalizeCandidates(
    job: DevelopJobSnapshot,
    lifecycle: "rejected" | "cancelled",
  ): Promise<void> {
    const values = job.status === "awaiting-review" ||
        job.status === "accepting"
      ? job.candidates
      : job.status === "stale"
      ? job.candidates
      : job.status === "interrupted" && job.reason === "acceptance-recovery"
      ? job.candidates
      : [];
    await this.finalizeCandidateList(values, lifecycle);
  }

  private async finalizeCandidateList(
    values: readonly DevelopAssetCandidate[],
    lifecycle: "rejected" | "cancelled",
  ): Promise<void> {
    for (const candidate of values) {
      const nowMs = Date.now();
      const result = await this.assetStore.transition({
        candidate,
        lifecycle,
        reference: null,
        nowMs,
        recoveryUntilMs: nowMs + RECOVERY_WINDOW_MS,
      });
      if (result.kind === "conflict") {
        throw new Error("Prototype artifact lifecycle is already final.");
      }
    }
  }

  private requiredJob(jobId: DevelopJobId): DevelopJobSnapshot {
    const job = this.jobs.find((candidate) => candidate.id.value === jobId.value);
    if (!job) throw new Error("Prototype job was not found.");
    return job;
  }

  private ensureJobCapacity(): void {
    if (this.jobs.length < MAX_JOBS) return;
    const discardedIndex = this.jobs.findIndex((job) => job.status === "discarded");
    if (discardedIndex < 0) {
      throw new Error("Prototype job history is full. Discard old jobs before continuing.");
    }
    this.jobs.splice(discardedIndex, 1);
  }

  private materializeIntent(intent: DevelopJobIntent, nowMs: number): DevelopJobRequest {
    const frameRevision = {
      kind: "coordinate-frame-revision",
      value: COORDINATE_FRAME_REVISION,
    } satisfies CoordinateFrameRevision;
    const base = {
      source: intent.source,
      sourceRevision: deriveSourceRevision(intent.source),
      documentRevision: intent.documentRevision,
      frameRevision,
      parameterHash: parameterHash(intent),
    };
    switch (intent.kind) {
      case "depth":
        return parseDevelopJobRequest({
          ...base,
          kind: "depth",
          implementation: "builtin-prototype-depth-v1",
        });
      case "denoise":
        return parseDevelopJobRequest({
          ...base,
          kind: "denoise",
          implementation: "builtin-prototype-denoise-v1",
          strength: intent.strength,
        });
      case "raw-details":
        return parseDevelopJobRequest({
          ...base,
          kind: "raw-details",
          implementation: "builtin-prototype-raw-details-v1",
          amount: intent.amount,
        });
      case "super-resolution":
        return parseDevelopJobRequest({
          ...base,
          kind: "super-resolution",
          implementation: "builtin-prototype-super-resolution-v1",
          scale: 2,
        });
      case "generative-remove": {
        const consent = this.consents.find(
          (receipt) => receipt.id === intent.consentReceiptId,
        );
        if (
          !consent ||
          consent.revokedAtMs !== null ||
          consent.expiresAtMs <= nowMs ||
          consent.sourceRevision.value !== base.sourceRevision.value ||
          consent.selectionAssetId !== intent.selection.assetId ||
          consent.intentHash !== base.parameterHash
        ) {
          throw new Error("Generative Remove consent is missing, expired, revoked, or stale.");
        }
        return parseDevelopJobRequest({
          ...base,
          kind: "generative-remove",
          implementation: "local-mock-remove-v1",
          selection: intent.selection,
          consent,
          seed: intent.seed,
          searchRadius: intent.searchRadius,
        });
      }
      default: {
        const exhaustive: never = intent;
        return exhaustive;
      }
    }
  }

  private replace(job: DevelopJobSnapshot): void {
    const index = this.jobs.findIndex((candidate) => candidate.id.value === job.id.value);
    if (index < 0) throw new Error("Prototype job was not found.");
    this.jobs[index] = job;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    if (!this.initialized) {
      return Promise.reject(new Error("Prototype job runtime is not initialized."));
    }
    const guarded = (): Promise<T> => this.writable
      ? task()
      : Promise.reject(new Error("Prototype job storage requires an application restart."));
    const result = this.mutationQueue.then(guarded, guarded);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persistAndEmit(): Promise<void> {
    try {
      await this.writeJournal();
    } catch (error) {
      this.writable = false;
      throw error;
    }
    try {
      this.onUpdate([...this.jobs]);
    } catch {
      // The journal remains authoritative when no renderer is available.
    }
  }

  private async writeJournal(): Promise<void> {
    const journal = {
      version: JOURNAL_VERSION,
      jobs: this.jobs,
      consents: this.consents,
    } satisfies DevelopJobJournal;
    const contents = `${JSON.stringify(journal)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_JOURNAL_BYTES) {
      throw new Error("Prototype job journal exceeds its size limit.");
    }
    await writeAtomic(this.journalPath, contents);
  }
}
