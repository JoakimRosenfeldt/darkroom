import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "./ids.ts";
import { parseRelativePath, parseSessionId, type SessionId } from "./runtime.ts";

export type RelinkMatchRank =
  | "exact-sha256"
  | "local-file-identity"
  | "relative-observation"
  | "filename-size";

export type RelinkFingerprintStatus = "missing" | "hashing" | "valid" | "stale" | "failed";

export interface RelinkObservation {
  readonly byteLength: number | null;
  readonly modifiedAt: number | null;
  readonly localFileId: string | null;
}

export interface RelinkFingerprint {
  readonly status: RelinkFingerprintStatus;
  readonly sha256: string | null;
}

export interface RelinkMissingAsset {
  readonly assetId: AssetId;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly filename: string;
  readonly observation: RelinkObservation | null;
  readonly fingerprint: RelinkFingerprint;
}

export interface RelinkCandidate {
  readonly candidateId: string;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly filename: string;
  readonly observation: RelinkObservation;
  readonly fingerprint: RelinkFingerprint;
}

export interface RelinkPlanInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly missingAssets: readonly RelinkMissingAsset[];
  readonly candidates: readonly RelinkCandidate[];
}

export interface RelinkPair {
  readonly assetId: AssetId;
  readonly candidateId: string;
  readonly rank: RelinkMatchRank;
}

export interface RelinkSuggestion {
  readonly assetId: AssetId;
  readonly rank: RelinkMatchRank | null;
  readonly candidateIds: readonly string[];
  readonly preselectedCandidateId: string | null;
}

export interface RelinkDraft {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly missingAssets: readonly RelinkMissingAsset[];
  readonly candidates: readonly RelinkCandidate[];
  readonly suggestions: readonly RelinkSuggestion[];
  readonly preselectedPairs: readonly RelinkPair[];
  readonly unresolvedAssetCount: number;
  readonly ambiguousAssetCount: number;
}

export interface RelinkAcceptedPairInput {
  readonly assetId: AssetId;
  readonly candidateId: string;
}

export interface RelinkApplyResult {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly acceptedPairs: readonly RelinkPair[];
  readonly unresolvedAssetIds: readonly AssetId[];
  readonly unresolvedAssetCount: number;
  readonly unresolvedCandidateCount: number;
  readonly ambiguousAssetCount: number;
}

export const RELINK_MAX_ACCEPTED_PAIRS = 250;

export interface RelinkPrepareRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

export interface RelinkApplyRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly acceptedPairs: readonly RelinkAcceptedPairInput[];
}

export interface RelinkCancelRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
}

export interface RelinkServiceDraft extends RelinkDraft {
  readonly expiresAt: number;
}

export interface RelinkServiceApplyResult extends RelinkApplyResult {
  readonly revision: number;
  readonly changed: boolean;
  readonly appliedMutations: number;
  readonly auditId: number | null;
}

type RecordValue = Record<string, unknown>;

const FINGERPRINT_STATUSES: readonly RelinkFingerprintStatus[] = [
  "missing",
  "hashing",
  "valid",
  "stale",
  "failed",
];

function recordValue(value: unknown, name: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as RecordValue;
}

function assertKnownKeys(
  input: RecordValue,
  allowed: readonly string[],
  name: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error(`${name} contains unsupported fields.`);
  }
}

function stringValue(value: unknown, name: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function candidateId(value: unknown): string {
  const parsed = stringValue(value, "candidateId");
  if (
    parsed.includes("/") ||
    parsed.includes("\\") ||
    parsed.startsWith(".") ||
    /^[A-Za-z]:/.test(parsed)
  ) {
    throw new Error("candidateId must not contain a native path.");
  }
  return parsed;
}

function filename(value: unknown): string {
  const parsed = stringValue(value, "filename");
  if (parsed === "." || parsed === ".." || parsed.includes("/") || parsed.includes("\\")) {
    throw new Error("filename is invalid.");
  }
  return parsed;
}

function numberValue(value: unknown, name: string, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < 0
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : stringValue(value, name, true);
}

function parseObservation(value: unknown, name: string): RelinkObservation | null {
  if (value === null) return null;
  const input = recordValue(value, name);
  return {
    byteLength: input.byteLength === null ? null : numberValue(input.byteLength, `${name}.byteLength`, true),
    modifiedAt: input.modifiedAt === null ? null : numberValue(input.modifiedAt, `${name}.modifiedAt`),
    localFileId: nullableString(input.localFileId, `${name}.localFileId`),
  };
}

function parseFingerprint(value: unknown, name: string): RelinkFingerprint {
  const input = recordValue(value, name);
  const status = FINGERPRINT_STATUSES.find((item) => item === input.status);
  if (status === undefined) {
    throw new Error(`${name}.status is invalid.`);
  }
  const sha256 = nullableString(input.sha256, `${name}.sha256`);
  if (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${name}.sha256 is invalid.`);
  }
  if ((status === "valid") !== (sha256 !== null)) {
    throw new Error(`${name} status and sha256 do not agree.`);
  }
  return { status, sha256 };
}

function parseMissingAsset(value: unknown): RelinkMissingAsset {
  const input = recordValue(value, "missing asset");
  const relativePath = parseRelativePath(input.relativePath);
  const parsedFilename = filename(input.filename);
  if (relativePath.split("/").at(-1) !== parsedFilename) {
    throw new Error("missing asset filename does not match relativePath.");
  }
  return {
    assetId: parseAssetId(input.assetId),
    rootId: parseRootId(input.rootId),
    relativePath,
    filename: parsedFilename,
    observation: parseObservation(input.observation, "missing asset.observation"),
    fingerprint: parseFingerprint(input.fingerprint, "missing asset.fingerprint"),
  };
}

function parseCandidate(value: unknown): RelinkCandidate {
  const input = recordValue(value, "relink candidate");
  const relativePath = parseRelativePath(input.relativePath);
  const parsedFilename = filename(input.filename);
  if (relativePath.split("/").at(-1) !== parsedFilename) {
    throw new Error("candidate filename does not match relativePath.");
  }
  return {
    candidateId: candidateId(input.candidateId),
    rootId: parseRootId(input.rootId),
    relativePath,
    filename: parsedFilename,
    observation: (input.observation === undefined
      ? null
      : parseObservation(input.observation, "candidate.observation")) ?? {
      byteLength: null,
      modifiedAt: null,
      localFileId: null,
    },
    fingerprint: parseFingerprint(input.fingerprint, "candidate.fingerprint"),
  };
}

function parseArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function parsePlanInput(value: unknown): RelinkPlanInput {
  const input = recordValue(value, "relink plan");
  const missingAssets = parseArray(input.missingAssets, "missingAssets").map(parseMissingAsset);
  const candidates = parseArray(input.candidates, "candidates").map(parseCandidate);
  const assetIds = new Set<string>();
  for (const asset of missingAssets) {
    if (assetIds.has(asset.assetId)) throw new Error("missingAssets contains a duplicate asset.");
    assetIds.add(asset.assetId);
  }
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) throw new Error("candidates contains a duplicate candidate.");
    candidateIds.add(candidate.candidateId);
  }
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
    missingAssets,
    candidates,
  };
}

function validHash(fingerprint: RelinkFingerprint): string | null {
  return fingerprint.status === "valid" ? fingerprint.sha256 : null;
}

function localIdentityMatches(asset: RelinkMissingAsset, candidate: RelinkCandidate): boolean {
  const assetId = asset.observation?.localFileId;
  return assetId !== null && assetId !== undefined && assetId !== "" && assetId === candidate.observation.localFileId;
}

function compatibleObservation(asset: RelinkMissingAsset, candidate: RelinkCandidate): boolean {
  const observation = asset.observation;
  return (
    observation !== null &&
    observation.byteLength !== null &&
    observation.modifiedAt !== null &&
    candidate.observation.byteLength === observation.byteLength &&
    candidate.observation.modifiedAt === observation.modifiedAt
  );
}

function filenameSizeMatches(asset: RelinkMissingAsset, candidate: RelinkCandidate): boolean {
  return (
    asset.filename === candidate.filename &&
    asset.observation?.byteLength !== null &&
    asset.observation?.byteLength !== undefined &&
    candidate.observation.byteLength === asset.observation.byteLength
  );
}

function candidateIds(candidates: readonly RelinkCandidate[]): readonly string[] {
  return candidates.map((candidate) => candidate.candidateId);
}

function suggestionFor(
  asset: RelinkMissingAsset,
  candidates: readonly RelinkCandidate[],
  usedCandidateIds: ReadonlySet<string>,
): RelinkSuggestion {
  const available = candidates.filter((candidate) => !usedCandidateIds.has(candidate.candidateId));
  const hash = validHash(asset.fingerprint);
  const exactHash =
    hash === null
      ? []
      : available.filter((candidate) => validHash(candidate.fingerprint) === hash);
  if (exactHash.length > 0) {
    return {
      assetId: asset.assetId,
      rank: "exact-sha256",
      candidateIds: candidateIds(exactHash),
      preselectedCandidateId: null,
    };
  }
  const local = available.filter((candidate) => localIdentityMatches(asset, candidate));
  if (local.length > 0) {
    return {
      assetId: asset.assetId,
      rank: "local-file-identity",
      candidateIds: candidateIds(local),
      preselectedCandidateId: null,
    };
  }
  const relative = available.filter(
    (candidate) => candidate.relativePath === asset.relativePath && compatibleObservation(asset, candidate),
  );
  if (relative.length > 0) {
    return {
      assetId: asset.assetId,
      rank: "relative-observation",
      candidateIds: candidateIds(relative),
      preselectedCandidateId: null,
    };
  }
  const filenameMatches = available.filter((candidate) => filenameSizeMatches(asset, candidate));
  return {
    assetId: asset.assetId,
    rank: filenameMatches.length > 0 ? "filename-size" : null,
    candidateIds: candidateIds(filenameMatches),
    preselectedCandidateId: null,
  };
}

export function planRelink(value: unknown): RelinkDraft {
  const input = parsePlanInput(value);
  const exactMatches = new Map<string, readonly RelinkCandidate[]>();
  const exactOwners = new Map<string, number>();
  for (const asset of input.missingAssets) {
    const hash = validHash(asset.fingerprint);
    const matches =
      hash === null
        ? []
        : input.candidates.filter((candidate) => validHash(candidate.fingerprint) === hash);
    exactMatches.set(asset.assetId, matches);
    for (const candidate of matches) {
      exactOwners.set(candidate.candidateId, (exactOwners.get(candidate.candidateId) ?? 0) + 1);
    }
  }

  const preselectedPairs: RelinkPair[] = [];
  const usedCandidateIds = new Set<string>();
  for (const asset of input.missingAssets) {
    const matches = exactMatches.get(asset.assetId) ?? [];
    if (matches.length === 1 && exactOwners.get(matches[0]!.candidateId) === 1) {
      const candidate = matches[0]!;
      preselectedPairs.push({ assetId: asset.assetId, candidateId: candidate.candidateId, rank: "exact-sha256" });
      usedCandidateIds.add(candidate.candidateId);
    }
  }

  const suggestions = input.missingAssets.map((asset) => {
    const preselected = preselectedPairs.find((pair) => pair.assetId === asset.assetId);
    if (preselected !== undefined) {
      return {
        assetId: asset.assetId,
        rank: "exact-sha256" as const,
        candidateIds: [preselected.candidateId],
        preselectedCandidateId: preselected.candidateId,
      };
    }
    const exact = exactMatches.get(asset.assetId) ?? [];
    if (exact.length > 0) {
      return {
        assetId: asset.assetId,
        rank: "exact-sha256" as const,
        candidateIds: candidateIds(exact),
        preselectedCandidateId: null,
      };
    }
    return suggestionFor(asset, input.candidates, usedCandidateIds);
  });
  const ambiguousAssetCount = suggestions.filter(
    (suggestion) => suggestion.preselectedCandidateId === null && suggestion.candidateIds.length > 1,
  ).length;
  return {
    catalogId: input.catalogId,
    sessionId: input.sessionId,
    operationId: input.operationId,
    missingAssets: input.missingAssets,
    candidates: input.candidates,
    suggestions,
    preselectedPairs,
    unresolvedAssetCount: input.missingAssets.length - preselectedPairs.length,
    ambiguousAssetCount,
  };
}

function parseAcceptedPairs(value: unknown): readonly RelinkAcceptedPairInput[] {
  const acceptedPairs = parseArray(value, "acceptedPairs").map((item) => {
    const input = recordValue(item, "accepted pair");
    assertKnownKeys(input, ["assetId", "candidateId"], "Accepted pair");
    return { assetId: parseAssetId(input.assetId), candidateId: candidateId(input.candidateId) };
  });
  if (acceptedPairs.length > RELINK_MAX_ACCEPTED_PAIRS) {
    throw new Error("acceptedPairs is too large.");
  }
  return acceptedPairs;
}

export function parseRelinkPrepareRequest(value: unknown): RelinkPrepareRequest {
  const input = recordValue(value, "relink prepare request");
  assertKnownKeys(input, ["catalogId", "sessionId"], "Relink prepare request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
  };
}

export function parseRelinkApplyRequest(value: unknown): RelinkApplyRequest {
  const input = recordValue(value, "relink apply request");
  assertKnownKeys(input, ["catalogId", "sessionId", "operationId", "acceptedPairs"], "Relink apply request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
    acceptedPairs: parseAcceptedPairs(input.acceptedPairs),
  };
}

export function parseRelinkCancelRequest(value: unknown): RelinkCancelRequest {
  const input = recordValue(value, "relink cancel request");
  assertKnownKeys(input, ["catalogId", "sessionId", "operationId"], "Relink cancel request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
  };
}

export function applyRelinkDraft(
  draftValue: unknown,
  acceptedValue: unknown,
): RelinkApplyResult {
  const draft = planRelink(draftValue);
  const requested = parseAcceptedPairs(acceptedValue);
  const suggestionByAsset = new Map(draft.suggestions.map((suggestion) => [suggestion.assetId, suggestion]));
  const acceptedPairs = [...draft.preselectedPairs];
  const acceptedAssetIds = new Set(acceptedPairs.map((pair) => pair.assetId));
  const acceptedCandidateIds = new Set(acceptedPairs.map((pair) => pair.candidateId));
  for (const pair of requested) {
    const suggestion = suggestionByAsset.get(pair.assetId);
    if (suggestion === undefined || !suggestion.candidateIds.includes(pair.candidateId)) {
      throw new Error("Accepted relink pair is not in the draft.");
    }
    if (acceptedAssetIds.has(pair.assetId)) {
      const existing = acceptedPairs.find((item) => item.assetId === pair.assetId);
      if (existing?.candidateId === pair.candidateId) continue;
      throw new Error("Relink asset is already paired.");
    }
    if (acceptedCandidateIds.has(pair.candidateId)) {
      throw new Error("Relink candidates are one-to-one.");
    }
    if (suggestion.rank === null) throw new Error("Accepted relink pair has no ranked match.");
    acceptedPairs.push({ assetId: pair.assetId, candidateId: pair.candidateId, rank: suggestion.rank });
    acceptedAssetIds.add(pair.assetId);
    acceptedCandidateIds.add(pair.candidateId);
  }
  const unresolvedAssetIds = draft.missingAssets
    .map((asset) => asset.assetId)
    .filter((assetId) => !acceptedAssetIds.has(assetId));
  const unresolvedCandidateCount = draft.candidates.length - acceptedCandidateIds.size;
  return {
    catalogId: draft.catalogId,
    sessionId: draft.sessionId,
    operationId: draft.operationId,
    acceptedPairs,
    unresolvedAssetIds,
    unresolvedAssetCount: unresolvedAssetIds.length,
    unresolvedCandidateCount,
    ambiguousAssetCount: draft.ambiguousAssetCount,
  };
}

export function cancelRelinkDraft(value: unknown): RelinkDraft {
  return planRelink(value);
}
