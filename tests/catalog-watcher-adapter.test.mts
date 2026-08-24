import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CatalogWatcherReconcileAdapter,
  type CatalogWatcherScanPort,
} from "../electron/catalog-watcher-adapter.ts";
import {
  createAssetId,
  createCatalogId,
  createOperationId,
  createRootId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  defaultCatalogLiveMetadata,
  type CatalogLiveApplyInput,
  type CatalogLiveQueryInput,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import {
  createSessionId,
  type LibrarySessionSnapshot,
  type SessionId,
} from "../lib/catalog/runtime.ts";
import type { RuntimeNativeRootProjection, RuntimeRootProjection } from "../electron/library-runtime.ts";
import type {
  WatchReconcileInput,
} from "../electron/watcher-reconciliation.ts";
import type { NativeScanResult } from "../electron/library-scan.ts";

class SessionFixture {
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly root: RuntimeRootProjection & { readonly nativePath: string };
  sessionId: SessionId;

  constructor(rootPath: string) {
    this.catalogId = createCatalogId();
    this.rootId = createRootId();
    this.sessionId = createSessionId();
    this.root = {
      catalogId: this.catalogId,
      rootId: this.rootId,
      label: "Photos",
      nativePath: rootPath,
    };
  }

  getSession(): LibrarySessionSnapshot {
    return {
      catalogId: this.catalogId,
      sessionId: this.sessionId,
      roots: [{ catalogId: this.catalogId, rootId: this.rootId, label: this.root.label }],
    };
  }

  getNativeSessionRoots(): readonly RuntimeNativeRootProjection[] {
    return [this.root];
  }

  swapSession(): void {
    this.sessionId = createSessionId();
  }
}

class LiveWorkerFixture {
  state: CatalogLiveState;
  readonly applies: CatalogLiveApplyInput[] = [];

  constructor(session: SessionFixture, assetPath?: string) {
    this.state = {
      catalog: {
        catalogId: session.catalogId,
        displayName: "Fixture",
        appVersion: "test",
        installState: "ready",
        revision: 1,
      },
      roots: [{
        rootId: session.rootId,
        label: session.root.label,
        configuredPath: session.root.nativePath,
        canonicalPath: session.root.nativePath,
        health: "online",
        scanState: "complete",
        watchState: "active",
        revision: 1,
      }],
      assets: assetPath === undefined ? [] : [{
        catalogId: session.catalogId,
        assetId: createAssetId(),
        rootId: session.rootId,
        relativePath: assetPath,
        observation: { byteLength: 1, modifiedAt: 1, observedAt: 1, localFileId: null },
        revision: 1,
        health: "present",
        formatId: "jpeg",
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
        fingerprintId: createAssetId(),
        fingerprintStatus: "missing",
        fingerprintSha256: null,
        fingerprintObservedAt: null,
        fingerprintObservedByteLength: null,
        fingerprintObservedModifiedAt: null,
        fingerprintLocalFileId: null,
        metadata: defaultCatalogLiveMetadata(1),
      }],
      albums: [],
      operations: [],
      presets: [],
      rules: [],
      fingerprintCoverage: { total: 0, missing: 0, hashing: 0, valid: 0, stale: 0, failed: 0 },
      fingerprintMatches: [],
    };
  }

  async liveQuery(input: CatalogLiveQueryInput): Promise<unknown> {
    if (input.catalogId !== this.state.catalog.catalogId) throw new Error("Wrong catalog.");
    return this.state;
  }

  async liveApply(input: CatalogLiveApplyInput): Promise<unknown> {
    this.applies.push(input);
    const mutation = input.mutations[0];
    if (mutation?.kind === "reconcile-complete") {
      const observedPaths = new Set(mutation.observations.map((observation) => observation.relativePath));
      this.state = {
        ...this.state,
        catalog: { ...this.state.catalog, revision: this.state.catalog.revision + 1 },
        assets: this.state.assets.map((asset) => asset.rootId !== mutation.rootId || observedPaths.has(asset.relativePath)
          ? asset
          : { ...asset, health: "missing", observation: null, revision: asset.revision + 1 }),
      };
    }
    return {
      catalogId: input.catalogId,
      revision: this.state.catalog.revision,
      changed: true,
      appliedMutations: input.mutations.length,
      auditId: 1,
    };
  }
}

function inputFor(session: SessionFixture, signal: AbortSignal): WatchReconcileInput {
  return {
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    rootId: session.rootId,
    operationId: createOperationId(),
    scope: { kind: "root" },
    signal,
  };
}

function emptyScan(): NativeScanResult {
  return {
    observations: [],
    directoriesVisited: 1,
    filesConsidered: 0,
    acceptedCount: 0,
    currentPath: "",
  };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function fixture(assetPath?: string): Promise<{
  readonly directory: string;
  readonly session: SessionFixture;
  readonly worker: LiveWorkerFixture;
  readonly adapter: CatalogWatcherReconcileAdapter;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "darkroom-watch-adapter-"));
  const session = new SessionFixture(await realpath(directory));
  const worker = new LiveWorkerFixture(session, assetPath);
  const adapter = new CatalogWatcherReconcileAdapter({ worker, runtime: session, now: () => 10 });
  return { directory, session, worker, adapter };
}

async function cleanup(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

test("production adapter commits a full-root reconcile and marks deleted assets missing", async () => {
  const value = await fixture("gone.jpg");
  try {
    const input = inputFor(value.session, new AbortController().signal);
    const result = await value.adapter.reconcile(input);
    assert.equal(result.diff.changedCount, 1);
    await value.adapter.commit({ ...input, diff: result.diff });
    assert.equal(value.worker.applies.length, 1);
    assert.equal(value.worker.applies[0]?.mutations[0]?.kind, "reconcile-complete");
    assert.equal(value.worker.state.assets[0]?.health, "missing");
  } finally {
    await cleanup(value.directory);
  }
});

test("production adapter scans once when one watcher operation contains several dirty scopes", async () => {
  const value = await fixture();
  try {
    let scans = 0;
    const adapter = new CatalogWatcherReconcileAdapter({
      worker: value.worker,
      runtime: value.session,
      scan: async () => {
        scans += 1;
        return emptyScan();
      },
      now: () => 10,
    });
    const first = {
      ...inputFor(value.session, new AbortController().signal),
      scope: { kind: "path" as const, relativePath: "one.jpg" },
    };
    const firstResult = await adapter.reconcile(first);
    await adapter.commit({ ...first, diff: firstResult.diff });
    const second = {
      ...first,
      scope: { kind: "path" as const, relativePath: "two.jpg" },
    };
    const secondResult = await adapter.reconcile(second);
    await adapter.commit({ ...second, diff: secondResult.diff });
    assert.equal(scans, 1);
    assert.equal(value.worker.applies.length, 1);
    assert.equal(secondResult.diff.changedCount, 0);
  } finally {
    await cleanup(value.directory);
  }
});

test("production adapter keeps recognized unavailable formats in staged observations", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.directory, "camera.dng"), "raw");
    const input = inputFor(value.session, new AbortController().signal);
    const result = await value.adapter.reconcile(input);
    assert.equal(result.diff.changedCount, 1);
    await value.adapter.commit({ ...input, diff: result.diff });
    const mutation = value.worker.applies[0]?.mutations[0];
    assert.equal(mutation?.kind, "reconcile-complete");
    if (mutation?.kind !== "reconcile-complete") throw new Error("Expected reconcile mutation.");
    assert.equal(mutation.observations[0]?.formatId, "dng");
  } finally {
    await cleanup(value.directory);
  }
});

test("production adapter preserves unchanged observations and reports an exact zero diff", async () => {
  const value = await fixture("same.jpg");
  try {
    await writeFile(path.join(value.directory, "same.jpg"), "x");
    const sourceStat = await stat(path.join(value.directory, "same.jpg"));
    const existing = value.worker.state.assets[0]!;
    value.worker.state = {
      ...value.worker.state,
      assets: [{
        ...existing,
        observation: {
          byteLength: sourceStat.size,
          modifiedAt: sourceStat.mtimeMs,
          observedAt: 2,
          localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
        },
      }],
    };
    const input = inputFor(value.session, new AbortController().signal);
    const result = await value.adapter.reconcile(input);
    assert.equal(result.diff.changedCount, 0);
    await value.adapter.commit({ ...input, diff: result.diff });
    const mutation = value.worker.applies[0]?.mutations[0];
    assert.equal(mutation?.kind, "reconcile-complete");
    if (mutation?.kind !== "reconcile-complete") throw new Error("Expected reconcile mutation.");
    assert.equal(mutation.observations[0]?.assetId, existing.assetId);
    assert.equal(mutation.observations[0]?.observation?.observedAt, 2);
  } finally {
    await cleanup(value.directory);
  }
});

test("production adapter rejects stale sessions before commit", async () => {
  const value = await fixture();
  try {
    const input = inputFor(value.session, new AbortController().signal);
    const result = await value.adapter.reconcile(input);
    value.session.swapSession();
    await assert.rejects(
      value.adapter.commit({ ...input, diff: result.diff }),
      /inactive|changed/,
    );
    assert.equal(value.worker.applies.length, 0);
  } finally {
    await cleanup(value.directory);
  }
});

test("production adapter aborts a staged scan without committing", async () => {
  const value = await fixture();
  try {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const scan: CatalogWatcherScanPort = () => new Promise((resolve) => {
      release = () => resolve(emptyScan());
      markStarted?.();
    });
    const adapter = new CatalogWatcherReconcileAdapter({
      worker: value.worker,
      runtime: value.session,
      scan,
      now: () => 10,
    });
    const input = inputFor(value.session, controller.signal);
    const pending = adapter.reconcile(input);
    await started;
    controller.abort();
    release?.();
    await assert.rejects(pending, /aborted/);
    assert.equal(value.worker.applies.length, 0);
  } finally {
    await cleanup(value.directory);
  }
});

test("production adapter rejects a session switch during final root verification", async () => {
  const value = await fixture();
  try {
    const controller = new AbortController();
    const finalVerification = deferred<void>();
    const finalVerificationStarted = deferred<void>();
    let pauseCommitVerification = false;
    let commitVerificationCount = 0;
    const adapter = new CatalogWatcherReconcileAdapter({
      worker: value.worker,
      runtime: value.session,
      verifyRoot: async () => {
        if (!pauseCommitVerification) return;
        commitVerificationCount += 1;
        if (commitVerificationCount === 2) {
          finalVerificationStarted.resolve();
          await finalVerification.promise;
        }
      },
      now: () => 10,
    });
    const input = inputFor(value.session, controller.signal);
    const result = await adapter.reconcile(input);
    pauseCommitVerification = true;
    const pending = adapter.commit({ ...input, diff: result.diff });
    await finalVerificationStarted.promise;
    value.session.swapSession();
    controller.abort();
    finalVerification.resolve();
    await assert.rejects(pending, /aborted|inactive|changed/);
    assert.equal(value.worker.applies.length, 0);
  } finally {
    await cleanup(value.directory);
  }
});
