import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { AssetId } from "../lib/catalog/ids.ts";
import {
  sameFileObservation,
  type FileObservation,
} from "../lib/import/domain.ts";

export const FINGERPRINT_CHUNK_BYTES = 1024 * 1024;

export type FingerprintStatus =
  | "valid"
  | "stale"
  | "not-fully-checked"
  | "failed"
  | "cancelled";

export interface FingerprintResult {
  readonly status: FingerprintStatus;
  readonly sha256: string | null;
  readonly observation: FileObservation | null;
  readonly reason: string | null;
}

export interface FingerprintCandidate {
  readonly assetId: AssetId;
  readonly filePath: string;
  readonly storedStatus: "missing" | "hashing" | "valid" | "stale" | "failed";
  readonly storedSha256: string | null;
  readonly storedObservation: FileObservation | null;
}

export interface FingerprintBackfillProgress {
  readonly indexed: number;
  readonly stale: number;
  readonly remaining: number;
  readonly processed: number;
  readonly failed: number;
  readonly unchecked: number;
  readonly nextIndex: number;
}

export interface FingerprintBackfillResult extends FingerprintBackfillProgress {
  readonly cancelled: boolean;
  readonly results: readonly FingerprintCandidateResult[];
}

export interface FingerprintCandidateResult {
  readonly assetId: AssetId;
  readonly result: FingerprintResult;
}

export interface FingerprintBackfillOptions {
  readonly candidates: readonly FingerprintCandidate[];
  readonly startIndex?: number;
  readonly onResult?: (result: FingerprintCandidateResult) => void;
  readonly onProgress?: (progress: FingerprintBackfillProgress) => void;
  readonly isCancelled?: () => boolean;
}

export interface DuplicateGroup {
  readonly sha256: string;
  readonly assetIds: readonly AssetId[];
}

export interface DuplicateReviewResult {
  readonly groups: readonly DuplicateGroup[];
  readonly unique: readonly AssetId[];
  readonly notFullyChecked: readonly AssetId[];
}

export interface FingerprintChunkInput {
  readonly before: FileObservation;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly after: () => Promise<FileObservation>;
  readonly isCancelled?: () => boolean;
}

export interface DuplicateCandidate {
  readonly assetId: AssetId;
  readonly filePath: string;
  readonly storedStatus: FingerprintCandidate["storedStatus"];
  readonly storedSha256: string | null;
  readonly storedObservation: FileObservation | null;
}

export interface DuplicateOnDemandInput {
  readonly incoming: FingerprintCandidate;
  readonly existing: readonly FingerprintCandidate[];
}

export class FingerprintCancelledError extends Error {
  constructor() {
    super("Fingerprint operation was cancelled.");
    this.name = "FingerprintCancelledError";
  }
}

function localFileId(stat: fs.Stats): string | null {
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) {
    return null;
  }
  return `${stat.dev}:${stat.ino}`;
}

function toObservation(stat: fs.Stats, observedAt = Date.now()): FileObservation {
  if (!stat.isFile()) {
    throw new Error("Fingerprint source is not a regular file.");
  }
  return {
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    localFileId: localFileId(stat),
    observedAt,
  };
}

function noFollowFlags(): number {
  return fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
}

function sameOpenedFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function readFailureStatus(error: unknown): FingerprintStatus {
  const code = errorCode(error);
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ELOOP"
    ? "not-fully-checked"
    : "failed";
}

export async function observeNoFollowFile(filePath: string): Promise<FileObservation> {
  const link = await fsp.lstat(filePath);
  if (!link.isFile() || link.isSymbolicLink()) {
    throw new Error("Fingerprint source is not a regular file.");
  }
  const handle = await fsp.open(filePath, noFollowFlags());
  try {
    const opened = await handle.stat();
    const pathAfter = await fsp.lstat(filePath);
    if (!opened.isFile() || !sameOpenedFile(link, opened) || !sameOpenedFile(opened, pathAfter)) {
      throw new Error("Fingerprint source changed while it was observed.");
    }
    return toObservation(opened);
  } finally {
    await handle.close();
  }
}

export async function fingerprintChunks(input: FingerprintChunkInput): Promise<FingerprintResult> {
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of input.chunks) {
      if (input.isCancelled?.() === true) {
        throw new FingerprintCancelledError();
      }
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
    if (input.isCancelled?.() === true) {
      throw new FingerprintCancelledError();
    }
    const after = await input.after();
    if (bytes !== input.before.size || !sameFileObservation(input.before, after)) {
      return {
        status: "stale",
        sha256: null,
        observation: after,
        reason: "File changed while it was being fingerprinted.",
      };
    }
    return {
      status: "valid",
      sha256: hash.digest("hex"),
      observation: after,
      reason: null,
    };
  } catch (error) {
    if (error instanceof FingerprintCancelledError) {
      return {
        status: "cancelled",
        sha256: null,
        observation: null,
        reason: null,
      };
    }
    return {
      status: readFailureStatus(error),
      sha256: null,
      observation: null,
      reason: error instanceof Error ? error.message : "File could not be read.",
    };
  }
}

export async function fingerprintNoFollowFile(
  filePath: string,
  isCancelled?: () => boolean,
): Promise<FingerprintResult> {
  let handle: fsp.FileHandle | null = null;
  try {
    const link = await fsp.lstat(filePath);
    if (!link.isFile() || link.isSymbolicLink()) {
      throw new Error("Fingerprint source is not a regular file.");
    }
    handle = await fsp.open(filePath, noFollowFlags());
    const opened = await handle.stat();
    if (!opened.isFile() || !sameOpenedFile(link, opened)) {
      throw new Error("Fingerprint source changed before it was opened.");
    }
    const before = toObservation(opened);
    async function* chunks(): AsyncIterable<Uint8Array> {
      const buffer = Buffer.allocUnsafe(FINGERPRINT_CHUNK_BYTES);
      let position = 0;
      while (true) {
        const read = await handle!.read(buffer, 0, buffer.byteLength, position);
        if (read.bytesRead === 0) {
          return;
        }
        position += read.bytesRead;
        yield buffer.subarray(0, read.bytesRead);
      }
    }
    return await fingerprintChunks({
      before,
      chunks: chunks(),
      after: async () => {
        const after = await handle!.stat();
        const pathAfter = await fsp.lstat(filePath);
        if (!sameOpenedFile(opened, after) || !sameOpenedFile(after, pathAfter)) {
          throw new Error("Fingerprint source changed while it was read.");
        }
        return toObservation(after);
      },
      isCancelled,
    });
  } catch (error) {
    return {
      status: readFailureStatus(error),
      sha256: null,
      observation: null,
      reason: error instanceof Error ? error.message : "File could not be read.",
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function fingerprintCandidate(
  candidate: FingerprintCandidate,
  isCancelled?: () => boolean,
): Promise<FingerprintCandidateResult> {
  let current: FileObservation;
  try {
    current = await observeNoFollowFile(candidate.filePath);
  } catch (error) {
    return {
      assetId: candidate.assetId,
      result: {
        status: readFailureStatus(error),
        sha256: null,
        observation: null,
        reason: error instanceof Error ? error.message : "File could not be observed.",
      },
    };
  }

  if (
    candidate.storedStatus === "valid" &&
    candidate.storedSha256 !== null &&
    candidate.storedObservation !== null &&
    sameFileObservation(candidate.storedObservation, current)
  ) {
    return {
      assetId: candidate.assetId,
      result: {
        status: "valid",
        sha256: candidate.storedSha256,
        observation: current,
        reason: null,
      },
    };
  }

  const result = await fingerprintNoFollowFile(candidate.filePath, isCancelled);
  return { assetId: candidate.assetId, result };
}

export async function runFingerprintBackfill(
  options: FingerprintBackfillOptions,
): Promise<FingerprintBackfillResult> {
  const startIndex = Math.min(
    Math.max(options.startIndex ?? 0, 0),
    options.candidates.length,
  );
  const results: FingerprintCandidateResult[] = [];
  let indexed = 0;
  let stale = 0;
  let failed = 0;
  let unchecked = 0;
  // A resumed scan starts after work that was already accounted for by the
  // caller. Preserve that coverage in the progress counters instead of
  // making non-valid rows disappear when the cursor advances.
  for (let index = 0; index < startIndex; index += 1) {
    const status = options.candidates[index]!.storedStatus;
    if (status === "valid") indexed += 1;
    else if (status === "stale") stale += 1;
    else if (status === "failed") failed += 1;
    else unchecked += 1;
  }
  let nextIndex = startIndex;
  let cancelled = false;
  for (; nextIndex < options.candidates.length;) {
    if (options.isCancelled?.() === true) {
      cancelled = true;
      break;
    }
    const result = await fingerprintCandidate(options.candidates[nextIndex]!, options.isCancelled);
    results.push(result);
    options.onResult?.(result);
    if (result.result.status === "cancelled") {
      unchecked += 1;
      cancelled = true;
      break;
    }
    if (result.result.status === "valid") {
      indexed += 1;
    } else if (result.result.status === "stale") {
      stale += 1;
    } else if (result.result.status === "failed") {
      failed += 1;
    } else if (result.result.status === "not-fully-checked") {
      unchecked += 1;
    }
    nextIndex += 1;
    const progress = {
      indexed,
      stale,
      remaining: options.candidates.length - nextIndex,
      processed: nextIndex,
      failed,
      unchecked,
      nextIndex,
    } satisfies FingerprintBackfillProgress;
    options.onProgress?.(progress);
  }
  return {
    indexed,
    stale,
    remaining: options.candidates.length - nextIndex,
    processed: nextIndex,
    failed,
    unchecked,
    nextIndex,
    cancelled,
    results,
  };
}

export function reviewDuplicates(
  results: readonly FingerprintCandidateResult[],
): DuplicateReviewResult {
  const byDigest = new Map<string, AssetId[]>();
  const notFullyChecked: AssetId[] = [];
  for (const candidate of results) {
    if (candidate.result.status !== "valid" || candidate.result.sha256 === null) {
      notFullyChecked.push(candidate.assetId);
      continue;
    }
    const group = byDigest.get(candidate.result.sha256) ?? [];
    group.push(candidate.assetId);
    byDigest.set(candidate.result.sha256, group);
  }
  const groups: DuplicateGroup[] = [];
  const unique: AssetId[] = [];
  for (const [sha256, assetIds] of [...byDigest.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (assetIds.length > 1) {
      groups.push({ sha256, assetIds: [...assetIds] });
    } else {
      unique.push(assetIds[0]!);
    }
  }
  return { groups, unique, notFullyChecked };
}

export async function reviewDuplicatesOnDemand(
  input: DuplicateOnDemandInput,
  hashCandidate: (candidate: FingerprintCandidate) => Promise<FingerprintCandidateResult> = async (candidate) =>
    fingerprintCandidate(candidate),
): Promise<DuplicateReviewResult> {
  const hash = async (candidate: FingerprintCandidate): Promise<FingerprintCandidateResult> => {
    try {
      return await hashCandidate(candidate);
    } catch (error) {
      return {
        assetId: candidate.assetId,
        result: {
          status: "failed",
          sha256: null,
          observation: null,
          reason: error instanceof Error ? error.message : "Fingerprint candidate failed.",
        },
      };
    }
  };
  const incomingResult = await hash({
    ...input.incoming,
    storedStatus: "missing",
    storedSha256: null,
    storedObservation: null,
  });
  const incomingSize = incomingResult.result.observation?.size ?? input.incoming.storedObservation?.size;
  const observedIncomingSize = incomingSize === undefined
    ? await observeNoFollowFile(input.incoming.filePath).then((observation) => observation.size).catch(() => undefined)
    : incomingSize;
  if (observedIncomingSize === undefined) {
    return reviewDuplicates([
      incomingResult,
      ...input.existing.map((candidate) => ({
        assetId: candidate.assetId,
        result: {
          status: "not-fully-checked",
          sha256: null,
          observation: null,
          reason: "Incoming source could not be fully checked.",
        } satisfies FingerprintResult,
      })),
    ]);
  }
  const resolved: FingerprintCandidateResult[] = [incomingResult];
  for (const candidate of input.existing) {
    const storedSize = candidate.storedObservation?.size;
    if (storedSize !== undefined && storedSize !== observedIncomingSize) {
      continue;
    }
    const candidateObservation = await observeNoFollowFile(candidate.filePath).catch(() => null);
    if (candidateObservation === null) {
      resolved.push({
        assetId: candidate.assetId,
        result: {
          status: "not-fully-checked",
          sha256: null,
          observation: null,
          reason: "Existing candidate could not be observed.",
        },
      });
      continue;
    }
    if (candidateObservation?.size !== observedIncomingSize) continue;
    if (
      candidate.storedStatus === "valid" &&
      candidate.storedSha256 !== null &&
      candidate.storedObservation !== null
    ) {
      if (candidateObservation !== null && sameFileObservation(candidate.storedObservation, candidateObservation)) {
        resolved.push({
          assetId: candidate.assetId,
          result: {
            status: "valid",
            sha256: candidate.storedSha256,
            observation: candidateObservation,
            reason: null,
          },
        });
      } else {
        resolved.push(await hash(candidate));
      }
    } else {
      resolved.push(await hash(candidate));
    }
  }
  return reviewDuplicates(resolved);
}
