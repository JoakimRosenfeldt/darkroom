import fs from "node:fs/promises";
import path from "node:path";
import {
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  getFormatCapabilityForFileName,
} from "../lib/formats/index.ts";
import {
  parseCatalogLiveApplyResult,
  parseCatalogLiveQueryResult,
  type CatalogLiveApplyInput,
  type CatalogLiveApplyResult,
  type CatalogLiveObservation,
  type CatalogLiveQueryInput,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import {
  parseDirtyScope,
  type DirtyScope,
} from "../lib/catalog/watch.ts";
import {
  parseRelativePath,
  parseSessionId,
  type SessionId,
} from "../lib/catalog/runtime.ts";
import {
  NativeScanAbortError,
  scanNativeFolder,
  type NativeScanObservation,
  type NativeScanOptions,
  type NativeScanResult,
} from "./library-scan.ts";
import type {
  CatalogLiveWorkerPort,
  CatalogRuntimePort,
} from "./catalog-coordinator.ts";
import { isRuntimeNativeRoot } from "./library-runtime.ts";
import type {
  WatchReconcileAdapter,
  WatchReconcileCommitInput,
  WatchReconcileInput,
  WatchReconcileResult,
} from "./watcher-reconciliation.ts";

export interface CatalogWatcherScanPort {
  (options: NativeScanOptions): Promise<NativeScanResult>;
}

export interface CatalogWatcherReconcileOptions {
  readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  readonly runtime: Pick<CatalogRuntimePort, "getSession" | "getNativeSessionRoots">;
  readonly scan?: CatalogWatcherScanPort;
  readonly verifyRoot?: (nativePath: string) => Promise<void>;
  readonly now?: () => number;
}

interface CurrentRoot {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly nativePath: string;
}

interface StagedReconcile {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly operationId: OperationId;
  readonly scope: DirtyScope;
  readonly observations: readonly CatalogLiveObservation[];
  readonly changedCount: number;
  readonly skipCommit: boolean;
}

const MAX_STAGED_RECONCILES = 256;

async function verifyCanonicalRoot(nativePath: string): Promise<void> {
  if (!path.isAbsolute(nativePath) || nativePath !== path.normalize(nativePath)) {
    throw new Error("Watch root path is invalid.");
  }
  try {
    const canonicalPath = await fs.realpath(nativePath);
    const stat = await fs.lstat(nativePath);
    if (canonicalPath !== nativePath || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Watch root changed.");
    }
  } catch {
    throw new Error("Watch root is unavailable.");
  }
}

function stageKey(
  catalogId: CatalogId,
  sessionId: SessionId,
  rootId: RootId,
  operationId: OperationId,
): string {
  return `${catalogId}\0${sessionId}\0${rootId}\0${operationId}`;
}

function relativeScopeKey(scope: DirtyScope): string {
  return scope.kind === "root" ? "root" : `path:${scope.relativePath}`;
}

function validateScanObservation(
  observation: NativeScanObservation,
  observedAt: number,
  existing: CatalogLiveState["assets"][number] | undefined,
): CatalogLiveObservation {
  const format = getFormatCapabilityForFileName(observation.name);
  if (format === null) throw new Error("Watch scan returned an unrecognized file format.");
  const formatId = observation.formatId ?? format.id;
  const localFileId = observation.localFileId ?? null;
  if (formatId !== format.id) throw new Error("Watch scan returned a mismatched format id.");
  const sameObservation =
    existing?.observation !== null &&
    existing?.observation !== undefined &&
    existing.observation.byteLength === observation.size &&
    existing.observation.modifiedAt === observation.lastModified &&
    (localFileId === null || existing.observation.localFileId === localFileId);
  return {
    ...(existing === undefined ? {} : { assetId: existing.assetId }),
    relativePath: parseRelativePath(observation.relativePath),
    observation: sameObservation
      ? existing.observation
      : {
          byteLength: observation.size,
          modifiedAt: observation.lastModified,
          observedAt,
          localFileId,
        },
    health: "present",
    formatId,
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
  };
}

function observationChanged(
  existing: CatalogLiveState["assets"][number] | undefined,
  observation: CatalogLiveObservation,
): boolean {
  if (existing === undefined || existing.health !== "present" || existing.formatId !== observation.formatId) {
    return true;
  }
  const before = existing.observation;
  const after = observation.observation;
  return before === null || after === null ||
    before.byteLength !== after.byteLength ||
    before.modifiedAt !== after.modifiedAt ||
    before.localFileId !== after.localFileId;
}

export class CatalogWatcherReconcileAdapter implements WatchReconcileAdapter {
  private readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  private readonly runtime: Pick<CatalogRuntimePort, "getSession" | "getNativeSessionRoots">;
  private readonly scan: CatalogWatcherScanPort;
  private readonly verifyRoot: (nativePath: string) => Promise<void>;
  private readonly now: () => number;
  private readonly staged = new Map<string, StagedReconcile>();
  private readonly completedOperations = new Set<string>();

  constructor(options: CatalogWatcherReconcileOptions) {
    this.worker = options.worker;
    this.runtime = options.runtime;
    this.scan = options.scan ?? ((input) => scanNativeFolder(input));
    this.verifyRoot = options.verifyRoot ?? verifyCanonicalRoot;
    this.now = options.now ?? Date.now;
  }

  async reconcile(input: WatchReconcileInput): Promise<WatchReconcileResult> {
    const current = this.currentRoot(input);
    const operationId = parseOperationId(input.operationId);
    const scope = parseDirtyScope(input.scope);
    const key = stageKey(current.catalogId, current.sessionId, current.rootId, operationId);
    if (this.completedOperations.has(key)) {
      this.staged.set(key, {
        catalogId: current.catalogId,
        sessionId: current.sessionId,
        rootId: current.rootId,
        operationId,
        scope,
        observations: [],
        changedCount: 0,
        skipCommit: true,
      });
      return { status: "completed", diff: { scope, changedCount: 0 } };
    }
    if (input.signal.aborted) throw new NativeScanAbortError();
    await this.verifyRoot(current.nativePath);
    const result = await this.scan({
      rootPath: current.nativePath,
      signal: input.signal,
    });
    if (input.signal.aborted) throw new NativeScanAbortError();
    this.assertCurrent(input, current);
    await this.verifyRoot(current.nativePath);
    const state = parseCatalogLiveQueryResult(await this.worker.liveQuery({
      catalogId: current.catalogId,
      expectedRevision: null,
    }));
    if (input.signal.aborted) throw new NativeScanAbortError();
    this.assertCurrent(input, current);
    if (!state.roots.some((root) => root.rootId === current.rootId)) {
      throw new Error("Watch root is no longer in the active catalog.");
    }
    const existingByPath = new Map(
      state.assets
        .filter((asset) => asset.rootId === current.rootId)
        .map((asset) => [asset.relativePath, asset] as const),
    );
    const observedAt = this.now();
    const observations = result.observations.map((observation) => (
      validateScanObservation(
        observation,
        observedAt,
        existingByPath.get(observation.relativePath),
      )
    ));
    const observedPaths = new Set(observations.map((observation) => observation.relativePath));
    const changedCount = observations.filter((observation) => (
      observationChanged(existingByPath.get(observation.relativePath), observation)
    )).length + state.assets.filter((asset) => (
      asset.rootId === current.rootId &&
      asset.health !== "missing" &&
      !observedPaths.has(asset.relativePath)
    )).length;
    this.staged.set(key, {
      catalogId: current.catalogId,
      sessionId: current.sessionId,
      rootId: current.rootId,
      operationId,
      scope,
      observations,
      changedCount,
      skipCommit: false,
    });
    this.trimStages();
    return {
      status: "completed",
      diff: {
        scope,
        changedCount,
      },
    };
  }

  async commit(input: WatchReconcileCommitInput): Promise<void> {
    const current = this.currentRoot(input);
    const operationId = parseOperationId(input.operationId);
    const scope = parseDirtyScope(input.scope);
    const key = stageKey(current.catalogId, current.sessionId, current.rootId, operationId);
    const staged = this.staged.get(key);
    if (staged === undefined || relativeScopeKey(staged.scope) !== relativeScopeKey(scope)) {
      throw new Error("Watch reconcile result is unavailable.");
    }
    if (input.diff.changedCount !== staged.changedCount) {
      throw new Error("Watch reconcile diff does not match its staged result.");
    }
    try {
      if (input.signal.aborted) throw new NativeScanAbortError();
      if (staged.skipCommit) return;
      await this.verifyRoot(current.nativePath);
      const queryInput: CatalogLiveQueryInput = {
        catalogId: current.catalogId,
        expectedRevision: null,
      };
      const state = parseCatalogLiveQueryResult(await this.worker.liveQuery(queryInput));
      if (input.signal.aborted) throw new NativeScanAbortError();
      this.assertCurrent(input, current);
      if (state.catalog.catalogId !== current.catalogId || !state.roots.some((root) => root.rootId === current.rootId)) {
        throw new Error("Watch root is no longer in the active catalog.");
      }
      await this.verifyRoot(current.nativePath);
      if (input.signal.aborted) throw new NativeScanAbortError();
      this.assertCurrent(input, current);
      const applyInput: CatalogLiveApplyInput = {
        catalogId: current.catalogId,
        expectedRevision: state.catalog.revision,
        mutations: [{
          kind: "reconcile-complete",
          rootId: current.rootId,
          observations: staged.observations,
        }],
        now: this.now(),
      };
      if (input.signal.aborted) throw new NativeScanAbortError();
      this.assertCurrent(input, current);
      const result = parseCatalogLiveApplyResult(await this.worker.liveApply(applyInput));
      validateApplyResult(result, current.catalogId);
      this.completedOperations.add(key);
      this.trimStages();
    } finally {
      this.staged.delete(key);
    }
  }

  private currentRoot(input: WatchReconcileInput): CurrentRoot {
    const catalogId = parseCatalogId(input.catalogId);
    const sessionId = parseSessionId(input.sessionId);
    const rootId = parseRootId(input.rootId);
    const session = this.runtime.getSession();
    if (session === null || session.catalogId !== catalogId || session.sessionId !== sessionId) {
      throw new Error("Watch session is inactive.");
    }
    if (!session.roots.some((root) => root.catalogId === catalogId && root.rootId === rootId)) {
      throw new Error("Watch root is not in the active session.");
    }
    const root = this.runtime.getNativeSessionRoots()
      .filter(isRuntimeNativeRoot)
      .find(
        (candidate) => candidate.catalogId === catalogId && candidate.rootId === rootId,
      );
    if (root === undefined) throw new Error("Watch root is unavailable.");
    return {
      catalogId,
      sessionId,
      rootId,
      nativePath: root.nativePath,
    };
  }

  private assertCurrent(input: WatchReconcileInput, expected: CurrentRoot): void {
    const current = this.currentRoot(input);
    if (
      current.catalogId !== expected.catalogId ||
      current.sessionId !== expected.sessionId ||
      current.rootId !== expected.rootId ||
      current.nativePath !== expected.nativePath
    ) {
      throw new Error("Watch session or root changed.");
    }
  }

  private trimStages(): void {
    while (this.staged.size > MAX_STAGED_RECONCILES) {
      const oldest = this.staged.keys().next().value;
      if (oldest === undefined) return;
      this.staged.delete(oldest);
    }
    while (this.completedOperations.size > MAX_STAGED_RECONCILES) {
      const oldest = this.completedOperations.values().next().value;
      if (oldest === undefined) return;
      this.completedOperations.delete(oldest);
    }
  }
}

function validateApplyResult(result: CatalogLiveApplyResult, catalogId: CatalogId): void {
  if (result.catalogId !== catalogId) throw new Error("Watch apply returned a mismatched catalog.");
}
