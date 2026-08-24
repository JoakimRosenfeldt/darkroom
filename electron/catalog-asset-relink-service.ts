import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  createOperationId,
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  parseCatalogLiveApplyResult,
  parseCatalogLiveQueryResult,
  type CatalogLiveApplyInput,
  type CatalogLiveApplyResult,
  type CatalogLiveMutation,
  type CatalogLiveQueryInput,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import { parseRelativePath, parseSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import {
  applyRelinkDraft,
  planRelink,
  type RelinkAcceptedPairInput,
  type RelinkApplyResult,
  type RelinkCandidate,
  type RelinkDraft,
  type RelinkFingerprint,
  type RelinkMatchRank,
  type RelinkMissingAsset,
  type RelinkObservation,
  type RelinkPlanInput,
} from "../lib/catalog/relink.ts";
import type { CatalogV3AssetSnapshot, CatalogV3Observation } from "../lib/catalog/v3.ts";
import {
  fingerprintNoFollowFile,
  observeNoFollowFile,
  type FingerprintResult,
} from "./catalog-fingerprint-service.ts";
import { sameFileObservation, type FileObservation } from "../lib/import/domain.ts";

export const DEFAULT_CATALOG_RELINK_DRAFT_TTL_MS = 5 * 60 * 1_000;
export const MAX_CATALOG_RELINK_DRAFT_TTL_MS = 30 * 60 * 1_000;
export const MAX_CATALOG_RELINK_DRAFTS = 32;
export const MAX_CATALOG_RELINK_CANDIDATES = 250;
export const MAX_CATALOG_RELINK_MISSING_ASSETS = 250;

export interface CatalogRelinkActiveRoot {
  readonly rootId: RootId;
  readonly canonicalPath: string;
}

export interface CatalogRelinkSessionContext {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

export interface CatalogRelinkSessionPort {
  readonly assertActive: (input: CatalogRelinkSessionContext) => void | Promise<void>;
  readonly getActiveRoots: (
    input: CatalogRelinkSessionContext,
  ) => readonly CatalogRelinkActiveRoot[] | Promise<readonly CatalogRelinkActiveRoot[]>;
}

export interface CatalogRelinkWorkerPort {
  readonly liveQuery: (input: CatalogLiveQueryInput) => Promise<unknown>;
  readonly liveApply: (input: CatalogLiveApplyInput) => Promise<unknown>;
}

/**
 * This is deliberately main-private. The absolute path is retained only in
 * the service's in-memory draft record and is never part of a public result.
 */
export interface CatalogRelinkSelectedCandidate {
  readonly candidateId?: string;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface CatalogAssetRelinkPrepareInput extends CatalogRelinkSessionContext {
  readonly selectedCandidates: readonly CatalogRelinkSelectedCandidate[];
  readonly operationId?: OperationId;
}

export interface CatalogAssetRelinkDraft extends RelinkDraft {
  readonly expiresAt: number;
}

export interface CatalogAssetRelinkApplyInput extends CatalogRelinkSessionContext {
  readonly operationId: OperationId;
  readonly acceptedPairs: readonly RelinkAcceptedPairInput[];
}

export interface CatalogAssetRelinkApplyResult extends RelinkApplyResult, CatalogLiveApplyResult {}

export interface CatalogAssetRelinkServiceOptions {
  readonly session: CatalogRelinkSessionPort;
  readonly worker: CatalogRelinkWorkerPort;
  readonly now?: () => number;
  readonly draftTtlMs?: number;
  readonly maxDrafts?: number;
  readonly reobserveFile?: (absolutePath: string) => Promise<FileObservation>;
}

interface PreparedCandidate {
  readonly candidateId: string;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly observation: FileObservation;
}

interface StoredDraft {
  readonly draft: CatalogAssetRelinkDraft;
  readonly candidates: ReadonlyMap<string, PreparedCandidate>;
}

type RootPathMap = ReadonlyMap<RootId, string>;

function safePublicError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 500) {
    if (!error.message.includes("/") && !error.message.includes("\\")) {
      return new Error(error.message);
    }
  }
  return new Error(fallback);
}

function context(value: CatalogRelinkSessionContext): CatalogRelinkSessionContext {
  return {
    catalogId: parseCatalogId(value.catalogId),
    sessionId: parseSessionId(value.sessionId),
  };
}

function candidateId(value: string | undefined): string {
  const result = value ?? randomUUID();
  if (
    typeof result !== "string" ||
    result.length === 0 ||
    result.length > 512 ||
    result.includes("\0") ||
    result.includes("/") ||
    result.includes("\\") ||
    result.startsWith(".") ||
    /^[A-Za-z]:/.test(result)
  ) {
    throw new Error("Relink candidate id is invalid.");
  }
  return result;
}

function validAbsolutePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error("Relink candidate is outside its active root.");
  }
  const normalized = path.resolve(value);
  if (normalized !== value) throw new Error("Relink candidate is outside its active root.");
  return normalized;
}

function validRootPath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error("Relink active root is invalid.");
  }
  const normalized = path.resolve(value);
  if (normalized !== value) throw new Error("Relink active root is invalid.");
  return normalized;
}

function pathKey(rootId: RootId, relativePath: string): string {
  return `${rootId}\0${relativePath}`;
}

function observation(value: CatalogV3Observation | null): RelinkObservation | null {
  return value === null
    ? null
    : {
        byteLength: value.byteLength,
        modifiedAt: value.modifiedAt,
        localFileId: value.localFileId,
      };
}

function fingerprint(
  status: CatalogV3AssetSnapshot["fingerprintStatus"],
  sha256: string | null,
): RelinkFingerprint {
  return { status, sha256 };
}

function missingAsset(asset: CatalogV3AssetSnapshot): RelinkMissingAsset {
  const filename = asset.relativePath.split("/").at(-1);
  if (filename === undefined || filename.length === 0) {
    throw new Error("Catalog contains an invalid missing asset path.");
  }
  return {
    assetId: asset.assetId,
    rootId: asset.rootId,
    relativePath: asset.relativePath,
    filename,
    observation: observation(asset.observation),
    fingerprint: fingerprint(asset.fingerprintStatus, asset.fingerprintSha256),
  };
}

function candidateFingerprint(result: FingerprintResult): RelinkFingerprint {
  switch (result.status) {
    case "valid":
      return result.sha256 === null
        ? { status: "failed", sha256: null }
        : { status: "valid", sha256: result.sha256 };
    case "stale":
      return { status: "stale", sha256: null };
    case "not-fully-checked":
    case "failed":
    case "cancelled":
      return { status: "failed", sha256: null };
  }
}

function toCatalogObservation(value: FileObservation, observedAt: number): CatalogV3Observation {
  return {
    byteLength: value.size,
    modifiedAt: value.modifiedAt,
    observedAt,
    localFileId: value.localFileId,
  };
}

function ensureContained(rootPath: string, candidatePath: string, relativePath: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Relink candidate is outside its active root.");
  }
  const expected = path.resolve(rootPath, ...relativePath.split("/"));
  if (expected !== candidatePath) throw new Error("Relink candidate path is not normalized.");
}

async function ensureNoSymlinkPath(rootPath: string, candidatePath: string): Promise<void> {
  try {
    const rootStat = await fsp.lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Relink active root is unavailable.");
    }
    const relative = path.relative(rootPath, candidatePath);
    let current = rootPath;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Relink candidate is unavailable.");
    }
  } catch (error) {
    throw safePublicError(error, "Relink candidate is unavailable.");
  }
}

function rootMap(value: readonly CatalogRelinkActiveRoot[]): RootPathMap {
  if (!Array.isArray(value)) throw new Error("Relink active roots are invalid.");
  const result = new Map<RootId, string>();
  for (const root of value) {
    const rootId = parseRootId(root.rootId);
    if (result.has(rootId)) throw new Error("Relink active roots contain a duplicate root.");
    result.set(rootId, validRootPath(root.canonicalPath));
  }
  return result;
}

function validateCandidatePath(
  input: CatalogRelinkSelectedCandidate,
  roots: RootPathMap,
): { readonly candidateId: string; readonly rootId: RootId; readonly relativePath: string; readonly absolutePath: string } {
  const candidateIdValue = candidateId(input.candidateId);
  const rootId = parseRootId(input.rootId);
  const relativePath = parseRelativePath(input.relativePath);
  const rootPath = roots.get(rootId);
  if (rootPath === undefined) throw new Error("Relink candidate root is not active.");
  const absolutePath = validAbsolutePath(input.absolutePath);
  ensureContained(rootPath, absolutePath, relativePath);
  return { candidateId: candidateIdValue, rootId, relativePath, absolutePath };
}

function assertCatalog(state: CatalogLiveState, catalogId: CatalogId): void {
  if (state.catalog.catalogId !== catalogId) throw new Error("Catalog relink state belongs to a different catalog.");
}

function assertDraftIdentity(draft: CatalogAssetRelinkDraft, contextValue: CatalogRelinkSessionContext): void {
  if (draft.catalogId !== contextValue.catalogId || draft.sessionId !== contextValue.sessionId) {
    throw new Error("Relink draft belongs to a different catalog session.");
  }
}

function assertAcceptedPairCount(value: readonly RelinkAcceptedPairInput[]): void {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_RELINK_CANDIDATES) {
    throw new Error("Relink accepted pair count is invalid.");
  }
}

function assertNotCancelled(isCancelled: (() => boolean) | undefined): void {
  if (isCancelled?.() === true) throw new Error("Relink operation was cancelled.");
}

export class CatalogAssetRelinkService {
  private readonly session: CatalogRelinkSessionPort;
  private readonly worker: CatalogRelinkWorkerPort;
  private readonly now: () => number;
  private readonly draftTtlMs: number;
  private readonly maxDrafts: number;
  private readonly reobserveFile: (absolutePath: string) => Promise<FileObservation>;
  private readonly drafts = new Map<OperationId, StoredDraft>();

  constructor(options: CatalogAssetRelinkServiceOptions) {
    this.session = options.session;
    this.worker = options.worker;
    this.now = options.now ?? Date.now;
    this.draftTtlMs = options.draftTtlMs ?? DEFAULT_CATALOG_RELINK_DRAFT_TTL_MS;
    this.maxDrafts = options.maxDrafts ?? MAX_CATALOG_RELINK_DRAFTS;
    this.reobserveFile = options.reobserveFile ?? observeNoFollowFile;
    if (
      !Number.isSafeInteger(this.draftTtlMs) ||
      this.draftTtlMs < 1 ||
      this.draftTtlMs > MAX_CATALOG_RELINK_DRAFT_TTL_MS
    ) {
      throw new Error("Relink draft TTL is invalid.");
    }
    if (!Number.isSafeInteger(this.maxDrafts) || this.maxDrafts < 1 || this.maxDrafts > MAX_CATALOG_RELINK_DRAFTS) {
      throw new Error("Relink draft limit is invalid.");
    }
  }

  async prepare(
    input: CatalogAssetRelinkPrepareInput,
    isCancelled?: () => boolean,
  ): Promise<CatalogAssetRelinkDraft> {
    const session = context(input);
    assertNotCancelled(isCancelled);
    await this.assertActive(session);
    assertNotCancelled(isCancelled);
    this.purgeExpired();
    if (!Array.isArray(input.selectedCandidates) || input.selectedCandidates.length === 0) {
      throw new Error("Relink needs at least one selected candidate.");
    }
    if (input.selectedCandidates.length > MAX_CATALOG_RELINK_CANDIDATES) {
      throw new Error("Relink candidate count is too large.");
    }
    if (this.drafts.size >= this.maxDrafts) throw new Error("Too many relink drafts are active.");

    const roots = rootMap(await this.activeRoots(session));
    assertNotCancelled(isCancelled);
    const selected: PreparedCandidate[] = [];
    const candidates: RelinkCandidate[] = [];
    const ids = new Set<string>();
    for (const item of input.selectedCandidates) {
      const normalized = validateCandidatePath(item, roots);
      if (ids.has(normalized.candidateId)) throw new Error("Relink candidate ids must be unique.");
      ids.add(normalized.candidateId);
      const rootPath = roots.get(normalized.rootId);
      if (rootPath === undefined) throw new Error("Relink candidate root is not active.");
      await ensureNoSymlinkPath(rootPath, normalized.absolutePath);
      assertNotCancelled(isCancelled);
      let observed: FileObservation;
      let hashed: FingerprintResult;
      try {
        observed = await observeNoFollowFile(normalized.absolutePath);
        assertNotCancelled(isCancelled);
        hashed = await fingerprintNoFollowFile(normalized.absolutePath);
        assertNotCancelled(isCancelled);
      } catch (error) {
        throw safePublicError(error, "Relink candidate could not be observed.");
      }
      const filename = normalized.relativePath.split("/").at(-1);
      if (filename === undefined) throw new Error("Relink candidate path is invalid.");
      selected.push({ ...normalized, observation: observed });
      candidates.push({
        candidateId: normalized.candidateId,
        rootId: normalized.rootId,
        relativePath: normalized.relativePath,
        filename,
        observation: {
          byteLength: observed.size,
          modifiedAt: observed.modifiedAt,
          localFileId: observed.localFileId,
        },
        fingerprint: candidateFingerprint(hashed),
      });
    }

    await this.assertActive(session);
    assertNotCancelled(isCancelled);
    const state = await this.queryState(session.catalogId);
    assertNotCancelled(isCancelled);
    await this.assertActive(session);
    assertNotCancelled(isCancelled);
    assertCatalog(state, session.catalogId);
    const missingAssets = state.assets
      .filter((asset) => asset.health === "missing")
      .map(missingAsset);
    if (missingAssets.length > MAX_CATALOG_RELINK_MISSING_ASSETS) {
      throw new Error("Relink missing asset count is too large.");
    }
    const operationId = input.operationId === undefined
      ? createOperationId()
      : parseOperationId(input.operationId);
    if (this.drafts.has(operationId)) throw new Error("Relink operation is already active.");
    const planInput: RelinkPlanInput = {
      catalogId: session.catalogId,
      sessionId: session.sessionId,
      operationId,
      missingAssets,
      candidates,
    };
    const expiresAt = this.now() + this.draftTtlMs;
    const draft: CatalogAssetRelinkDraft = { ...planRelink(planInput), expiresAt };
    assertNotCancelled(isCancelled);
    this.drafts.set(operationId, {
      draft,
      candidates: new Map(selected.map((candidate) => [candidate.candidateId, candidate] as const)),
    });
    return draft;
  }

  async apply(
    input: CatalogAssetRelinkApplyInput,
    isCancelled?: () => boolean,
  ): Promise<CatalogAssetRelinkApplyResult> {
    const session = context(input);
    assertNotCancelled(isCancelled);
    await this.assertActive(session);
    assertNotCancelled(isCancelled);
    this.purgeExpired();
    const operationId = parseOperationId(input.operationId);
    const stored = this.drafts.get(operationId);
    if (stored === undefined) throw new Error("Relink draft is missing or expired.");
    assertDraftIdentity(stored.draft, session);
    assertAcceptedPairCount(input.acceptedPairs);

    const applied = applyRelinkDraft(stored.draft, input.acceptedPairs);
    const state = await this.queryState(session.catalogId);
    assertNotCancelled(isCancelled);
    await this.assertActive(session);
    assertNotCancelled(isCancelled);
    assertCatalog(state, session.catalogId);
    const roots = rootMap(await this.activeRoots(session));
    assertNotCancelled(isCancelled);
    await this.assertActive(session);
    assertNotCancelled(isCancelled);
    this.assertSourcesAndDestinations(applied.acceptedPairs, stored.candidates, state, roots);

    const mutations: CatalogLiveMutation[] = [];
    for (const pair of applied.acceptedPairs) {
      const selected = stored.candidates.get(pair.candidateId);
      if (selected === undefined) throw new Error("Relink candidate is not in the draft.");
      const current = await this.reobserve(selected, roots);
      assertNotCancelled(isCancelled);
      mutations.push({
        kind: "asset-relocate",
        assetId: pair.assetId,
        rootId: selected.rootId,
        relativePath: selected.relativePath,
        observation: toCatalogObservation(current, this.now()),
        health: "present",
      });
    }

    await this.assertActive(session);
    assertNotCancelled(isCancelled);

    if (mutations.length === 0) {
      this.drafts.delete(operationId);
      return {
        ...applied,
        catalogId: session.catalogId,
        revision: state.catalog.revision,
        changed: false,
        appliedMutations: 0,
        auditId: null,
      };
    }

    this.drafts.delete(operationId);
    let result: CatalogLiveApplyResult;
    try {
      result = parseCatalogLiveApplyResult(await this.worker.liveApply({
        catalogId: session.catalogId,
        expectedRevision: state.catalog.revision,
        mutations,
        now: this.now(),
      }));
    } catch (error) {
      throw safePublicError(error, "Relink could not be applied.");
    }
    if (result.catalogId !== session.catalogId) throw new Error("Relink apply returned a different catalog.");
    return { ...applied, ...result };
  }

  async cancel(
    input: CatalogRelinkSessionContext & { readonly operationId: OperationId },
    isCancelled?: () => boolean,
  ): Promise<void> {
    const session = context(input);
    assertNotCancelled(isCancelled);
    await this.assertActive(session);
    assertNotCancelled(isCancelled);
    this.purgeExpired();
    const operationId = parseOperationId(input.operationId);
    const stored = this.drafts.get(operationId);
    if (stored === undefined) return;
    assertDraftIdentity(stored.draft, session);
    assertNotCancelled(isCancelled);
    this.drafts.delete(operationId);
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [operationId, stored] of this.drafts) {
      if (now >= stored.draft.expiresAt) this.drafts.delete(operationId);
    }
  }

  private async assertActive(input: CatalogRelinkSessionContext): Promise<void> {
    try {
      await this.session.assertActive(input);
    } catch (error) {
      throw safePublicError(error, "Catalog session is inactive.");
    }
  }

  private async activeRoots(input: CatalogRelinkSessionContext): Promise<readonly CatalogRelinkActiveRoot[]> {
    try {
      return await this.session.getActiveRoots(input);
    } catch (error) {
      throw safePublicError(error, "Catalog session roots are unavailable.");
    }
  }

  private async queryState(catalogId: CatalogId): Promise<CatalogLiveState> {
    try {
      return parseCatalogLiveQueryResult(await this.worker.liveQuery({ catalogId, expectedRevision: null }));
    } catch (error) {
      throw safePublicError(error, "Relink catalog state could not be read.");
    }
  }

  private assertSourcesAndDestinations(
    pairs: readonly { readonly assetId: AssetId; readonly candidateId: string; readonly rank: RelinkMatchRank }[],
    candidates: ReadonlyMap<string, PreparedCandidate>,
    state: CatalogLiveState,
    roots: RootPathMap,
  ): void {
    const assets = new Map(state.assets.map((asset) => [asset.assetId, asset] as const));
    const destinations = new Map<string, AssetId>();
    for (const pair of pairs) {
      const asset = assets.get(pair.assetId);
      if (asset === undefined || asset.health !== "missing") {
        throw new Error("Relink source asset is no longer missing.");
      }
      const selected = candidates.get(pair.candidateId);
      if (selected === undefined) throw new Error("Relink candidate is not in the draft.");
      const activeRootPath = roots.get(selected.rootId);
      if (activeRootPath === undefined) throw new Error("Relink candidate root is not active.");
      const liveRoot = state.roots.find((root) => root.rootId === selected.rootId);
      if (
        liveRoot === undefined ||
        liveRoot.health !== "online" ||
        liveRoot.canonicalPath === null ||
        liveRoot.canonicalPath !== activeRootPath
      ) {
        throw new Error("Relink destination root is unavailable.");
      }
      const destination = pathKey(selected.rootId, selected.relativePath);
      const previous = destinations.get(destination);
      if (previous !== undefined && previous !== pair.assetId) {
        throw new Error("Relink destinations conflict.");
      }
      destinations.set(destination, pair.assetId);
      const occupied = state.assets.find(
        (candidate) =>
          candidate.rootId === selected.rootId &&
          candidate.relativePath === selected.relativePath &&
          candidate.assetId !== pair.assetId,
      );
      if (occupied !== undefined) throw new Error("Relink destination is already occupied.");
    }
  }

  private async reobserve(candidate: PreparedCandidate, roots: RootPathMap): Promise<FileObservation> {
    const rootPath = roots.get(candidate.rootId);
    if (rootPath === undefined) throw new Error("Relink candidate root is not active.");
    try {
      ensureContained(rootPath, validAbsolutePath(candidate.absolutePath), candidate.relativePath);
      await ensureNoSymlinkPath(rootPath, candidate.absolutePath);
      const current = await this.reobserveFile(candidate.absolutePath);
      if (!sameFileObservation(candidate.observation, current)) {
        throw new Error("Relink candidate changed.");
      }
      return current;
    } catch (error) {
      throw safePublicError(error, "Relink candidate changed or is unavailable.");
    }
  }
}
