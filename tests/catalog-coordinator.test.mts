import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CatalogCoordinator,
  createCatalogRuntimeSource,
  type CatalogFilesystemPort,
  type CatalogLiveWorkerPort,
  type CatalogPathAllocatorPort,
  type CatalogPickerPort,
  type CatalogRegistryPort,
  type CatalogRegistryRecord,
  type CatalogRuntimePort,
  type CatalogSettingsPort,
  type CatalogWatcherPort,
} from "../electron/catalog-coordinator.ts";
import {
  parseCatalogApplyRequest,
  type CatalogEvent,
} from "../lib/catalog/api.ts";
import {
  createAssetId,
  createCatalogId,
  createOperationId,
  createPresetId,
  createRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  createPathGrantId,
  createSessionId,
  type LibraryEvent,
  type LibraryOperationHandle,
  type LibraryOperationSnapshot,
  type LibrarySessionSnapshot,
  type PathGrantId,
  type SessionId,
} from "../lib/catalog/runtime.ts";
import type { CatalogLiveMutation, CatalogLiveState, CatalogLiveRoot } from "../lib/catalog/live.ts";
import type { CatalogWatchEvent } from "../lib/catalog/watch.ts";
import type { WatchSessionInput } from "../electron/watcher-reconciliation.ts";
import type {
  RuntimeNativeRootProjection,
  RuntimeRootProjection,
} from "../electron/library-runtime.ts";
import { isRuntimeNativeRoot } from "../electron/library-runtime.ts";
import { createSettingsStore } from "../electron/settings.ts";

interface CatalogRecord {
  readonly catalogId: CatalogId;
  roots: RuntimeRootProjection[];
}

function emptyState(catalogId: CatalogId, roots: readonly CatalogLiveRoot[]): CatalogLiveState {
  return {
    catalog: { catalogId, displayName: "Fixture", appVersion: "test", installState: "ready", revision: 1 },
    roots: [...roots],
    assets: [],
    albums: [],
    operations: [],
    presets: [],
    rules: [],
    fingerprintCoverage: { total: 0, missing: 0, hashing: 0, valid: 0, stale: 0, failed: 0 },
    fingerprintMatches: [],
  };
}

class FakeRegistry implements CatalogRegistryPort {
  readonly records: CatalogRegistryRecord[] = [];
  failUpserts = 0;
  failRemoves = 0;

  async read(): Promise<readonly CatalogRegistryRecord[]> {
    return this.records.map((record) => ({ ...record }));
  }

  async upsert(value: CatalogRegistryRecord): Promise<void> {
    if (this.failUpserts > 0) {
      this.failUpserts -= 1;
      throw new Error("registry unavailable");
    }
    const index = this.records.findIndex((record) => record.catalogId === value.catalogId);
    if (index < 0) this.records.push({ ...value });
    else this.records[index] = { ...value };
  }

  async remove(catalogId: CatalogId): Promise<void> {
    if (this.failRemoves > 0) {
      this.failRemoves -= 1;
      throw new Error("registry unavailable");
    }
    const index = this.records.findIndex((record) => record.catalogId === catalogId);
    if (index >= 0) this.records.splice(index, 1);
  }
}

class FakePicker implements CatalogPickerPort {
  readonly paths: string[] = [];

  async chooseFolder(): Promise<{ readonly path: string; readonly label?: string } | null> {
    const path = this.paths.shift();
    return path === undefined ? null : { path, label: path.split("/").at(-1) };
  }
}

class FakeFilesystem implements CatalogFilesystemPort {
  readonly deletedPaths: string[] = [];
  failDeletes = 0;

  async canonicalizeDirectory(inputPath: string): Promise<{ readonly canonicalPath: string; readonly label?: string }> {
    return { canonicalPath: inputPath, label: inputPath.split("/").at(-1) };
  }

  async deleteCatalogFile(databasePath: string): Promise<void> {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("catalog deletion failed");
    }
    this.deletedPaths.push(databasePath);
  }
}

class FakePaths implements CatalogPathAllocatorPort {
  readonly allocated: string[] = [];

  async allocateDatabasePath(catalogId: CatalogId): Promise<string> {
    const value = `/private/catalog-database/${catalogId}.db`;
    this.allocated.push(value);
    return value;
  }
}

class FakeSettings implements CatalogSettingsPort {
  lastCatalogId: CatalogId | null = null;

  async getLastCatalogId(): Promise<CatalogId | null> {
    return this.lastCatalogId;
  }

  async setLastCatalogId(catalogId: CatalogId | null): Promise<void> {
    this.lastCatalogId = catalogId;
  }
}

class FakeWorker implements CatalogLiveWorkerPort {
  readonly states = new Map<string, CatalogLiveState>();
  readonly paths = new Map<string, string>();
  readonly openedPaths: string[] = [];
  currentCatalogId: CatalogId | null = null;
  pendingQuery: Promise<unknown> | null = null;
  pendingQueryCatalogId: CatalogId | null = null;
  lastApplyMutations: readonly CatalogLiveMutation[] = [];
  private pendingCreatePath: string | null = null;
  private readonly runtimeCatalogs: Map<string, CatalogRecord>;

  constructor(runtimeCatalogs: Map<string, CatalogRecord>) {
    this.runtimeCatalogs = runtimeCatalogs;
  }

  async open(databasePath: string): Promise<void> {
    this.openedPaths.push(databasePath);
    this.pendingCreatePath = databasePath;
    const catalogId = [...this.paths.entries()].find(([, value]) => value === databasePath)?.[0];
    this.currentCatalogId = catalogId === undefined ? null : createCatalogId(catalogId);
  }

  async close(): Promise<void> {
    this.currentCatalogId = null;
    this.pendingCreatePath = null;
  }

  async liveCreate(input: { readonly catalogId: CatalogId; readonly root: { readonly rootId: RootId; readonly label: string; readonly configuredPath: string; readonly canonicalPath: string | null; readonly health: "online" | "missing" | "ambiguous" | "unreadable"; readonly scanState: "unknown" | "complete" | "partial" | "failed"; readonly watchState: "disabled" | "active" | "error" }; readonly displayName: string; readonly appVersion: string; readonly now?: number }): Promise<unknown> {
    const root: CatalogLiveRoot = { ...input.root, revision: 1 };
    this.states.set(input.catalogId, emptyState(input.catalogId, [root]));
    this.runtimeCatalogs.set(input.catalogId, {
      catalogId: input.catalogId,
      roots: [{ catalogId: input.catalogId, rootId: input.root.rootId, label: input.root.label, nativePath: input.root.canonicalPath ?? input.root.configuredPath }],
    });
    if (this.pendingCreatePath === null) throw new Error("Missing create path.");
    this.paths.set(input.catalogId, this.pendingCreatePath);
    this.currentCatalogId = input.catalogId;
    return { catalogId: input.catalogId, revision: 1, changed: true, appliedMutations: 1, auditId: 1 };
  }

  async liveQuery(input: { readonly catalogId: CatalogId }): Promise<unknown> {
    if (this.pendingQuery !== null && this.pendingQueryCatalogId === input.catalogId) return this.pendingQuery;
    const state = this.states.get(input.catalogId);
    if (state === undefined) throw new Error("Missing worker state.");
    return state;
  }

  async liveApply(input: { readonly catalogId: CatalogId; readonly mutations: readonly { readonly kind: string }[] }): Promise<unknown> {
    const state = this.states.get(input.catalogId);
    if (state === undefined) throw new Error("Missing worker state.");
    this.lastApplyMutations = input.mutations as readonly CatalogLiveMutation[];
    const renamed = [...this.lastApplyMutations].reverse().find((mutation) => mutation.kind === "rename-catalog");
    if (renamed?.kind === "rename-catalog") {
      this.states.set(input.catalogId, {
        ...state,
        catalog: {
          ...state.catalog,
          displayName: renamed.displayName,
          revision: state.catalog.revision + 1,
        },
      });
    }
    const relinked = [...this.lastApplyMutations].reverse().find((mutation) => mutation.kind === "root-relink");
    if (relinked?.kind === "root-relink") {
      const current = this.states.get(input.catalogId);
      if (current === undefined) throw new Error("Missing worker state.");
      if (!current.roots.some((root) => root.rootId === relinked.rootId)) throw new Error("Missing worker root.");
      this.states.set(input.catalogId, {
        ...current,
        catalog: { ...current.catalog, revision: current.catalog.revision + 1 },
        roots: current.roots.map((root) => root.rootId === relinked.rootId ? {
          ...root,
          label: relinked.label,
          configuredPath: relinked.configuredPath,
          canonicalPath: relinked.canonicalPath,
          health: relinked.health,
          revision: root.revision + 1,
        } : root),
      });
      const runtimeCatalog = this.runtimeCatalogs.get(input.catalogId);
      if (runtimeCatalog === undefined) throw new Error("Missing runtime catalog.");
      runtimeCatalog.roots = runtimeCatalog.roots.map((root) => root.rootId === relinked.rootId ? {
        ...root,
        label: relinked.label,
        nativePath: relinked.canonicalPath,
      } : root);
    }
    const nextState = this.states.get(input.catalogId);
    if (nextState === undefined) throw new Error("Missing worker state.");
    return { catalogId: input.catalogId, revision: nextState.catalog.revision, changed: input.mutations.length > 0, appliedMutations: input.mutations.length, auditId: 2 };
  }
}

class FakeRuntime implements CatalogRuntimePort {
  readonly catalogs: Map<string, CatalogRecord>;
  readonly events = new Set<(event: LibraryEvent) => void>();
  readonly cancelled: OperationId[] = [];
  readonly assets = new Map<string, Uint8Array>();
  readonly sidecars = new Map<string, { readonly contents: string; readonly lastModified: number }>();
  current: { readonly catalogId: CatalogId; readonly sessionId: SessionId } | null = null;
  pendingRoot: RuntimeNativeRootProjection | null = null;
  pendingWait: Promise<LibraryOperationSnapshot> | null = null;
  lastOperation: LibraryOperationHandle | null = null;
  trashCount = 0;

  constructor(catalogs: Map<string, CatalogRecord>) {
    this.catalogs = catalogs;
  }

  async selectSession(value: unknown): Promise<LibrarySessionSnapshot> {
    const input = value as { readonly catalogId: CatalogId };
    const catalog = this.catalogs.get(input.catalogId);
    if (catalog === undefined) throw new Error("Missing runtime catalog.");
    const sessionId = createSessionId();
    this.current = { catalogId: input.catalogId, sessionId };
    return {
      catalogId: input.catalogId,
      sessionId,
      roots: catalog.roots.map((root) => ({ catalogId: root.catalogId, rootId: root.rootId, label: root.label })),
    };
  }

  closeSession(): void {
    this.current = null;
  }

  getSession(): LibrarySessionSnapshot | null {
    const current = this.current;
    if (current === null) return null;
    const catalog = this.catalogs.get(current.catalogId);
    if (catalog === undefined) return null;
    return {
      catalogId: current.catalogId,
      sessionId: current.sessionId,
      roots: catalog.roots.map((root) => ({ catalogId: root.catalogId, rootId: root.rootId, label: root.label })),
    };
  }

  getNativeSessionRoots(): readonly RuntimeNativeRootProjection[] {
    return (this.current === null ? [] : this.catalogs.get(this.current.catalogId)?.roots ?? []).filter(isRuntimeNativeRoot);
  }

  async issuePathGrant(): Promise<{ readonly grantId: PathGrantId; readonly catalogId: CatalogId; readonly sessionId: SessionId; readonly scope: "root"; readonly expiresAt: number; readonly label: string }> {
    if (this.current === null || this.pendingRoot === null) throw new Error("No pending root.");
    return { grantId: createPathGrantId(), catalogId: this.current.catalogId, sessionId: this.current.sessionId, scope: "root", expiresAt: Date.now() + 1000, label: this.pendingRoot.label };
  }

  async consumePathGrant(): Promise<{ readonly grantId: PathGrantId; readonly catalogId: CatalogId; readonly sessionId: SessionId; readonly rootId: RootId }> {
    if (this.current === null || this.pendingRoot === null) throw new Error("No pending root.");
    const root = this.pendingRoot;
    this.catalogs.get(this.current.catalogId)?.roots.push(root);
    this.pendingRoot = null;
    return { grantId: createPathGrantId(), catalogId: this.current.catalogId, sessionId: this.current.sessionId, rootId: root.rootId };
  }

  startScan(value: unknown): LibraryOperationHandle {
    const input = value as { readonly catalogId: CatalogId; readonly sessionId: SessionId; readonly rootId: RootId };
    const operation = { operationId: createOperationId(), catalogId: input.catalogId, sessionId: input.sessionId, rootId: input.rootId, status: "running" as const };
    this.lastOperation = operation;
    return operation;
  }

  cancelScan(value: unknown): void {
    const input = value as { readonly operationId: OperationId };
    this.cancelled.push(input.operationId);
  }

  getOperation(): LibraryOperationSnapshot {
    if (this.lastOperation === null) throw new Error("No operation.");
    return { ...this.lastOperation, directoriesVisited: 0, filesConsidered: 0, acceptedCount: 0, currentPath: null };
  }

  async waitForOperation(): Promise<LibraryOperationSnapshot> {
    if (this.pendingWait !== null) return this.pendingWait;
    return this.getOperation();
  }

  subscribe(listener: (event: LibraryEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  async readAsset(value: unknown): Promise<Uint8Array> {
    const input = value as { readonly assetId: AssetId };
    return this.assets.get(input.assetId) ?? Uint8Array.from([1, 2, 3]);
  }

  async readAssetHead(value: unknown): Promise<Uint8Array> {
    return this.readAsset(value);
  }

  async statAsset(): Promise<{ readonly size: number; readonly lastModified: number }> {
    return { size: 3, lastModified: 1 };
  }

  async readAssetSidecar(): Promise<unknown> {
    return { contents: "<xmp/>", lastModified: 1 };
  }

  async writeAssetSidecar(): Promise<void> {}
  async trashAsset(): Promise<void> {
    this.trashCount += 1;
  }

  async decodeAsset(): Promise<unknown> {
    return {
      available: true,
      provenance: "nikon-test-only",
      version: 1,
      width: 1,
      height: 1,
      channels: 3,
      bitDepth: 16,
      byteCount: 6,
      pixelFormat: "rgb16le",
      orientation: 1,
      colorSpace: "srgb",
      transferFunction: "srgb",
      pixels: Uint8Array.from([0, 0, 0, 0, 0, 0]).buffer,
    };
  }

  emit(event: LibraryEvent): void {
    for (const listener of this.events) listener(event);
  }
}

class FakeWatchers implements CatalogWatcherPort {
  readonly activations: WatchSessionInput[] = [];
  readonly events = new Set<(event: CatalogWatchEvent) => void>();
  closeCount = 0;

  activateSession(input: WatchSessionInput): void {
    this.activations.push(input);
  }

  closeSession(): void {
    this.closeCount += 1;
  }

  subscribe(listener: (event: CatalogWatchEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  emit(event: CatalogWatchEvent): void {
    for (const listener of this.events) listener(event);
  }
}

function runtimeRoot(
  catalogId: CatalogId,
  label: string,
  nativePath: string,
): RuntimeNativeRootProjection {
  return { catalogId, rootId: createRootId(), label, nativePath };
}

function fixture(): {
  readonly coordinator: CatalogCoordinator;
  readonly picker: FakePicker;
  readonly registry: FakeRegistry;
  readonly worker: FakeWorker;
  readonly runtime: FakeRuntime;
  readonly watchers: FakeWatchers;
  readonly settings: FakeSettings;
  readonly filesystem: FakeFilesystem;
  readonly catalogs: Map<string, CatalogRecord>;
} {
  const catalogs = new Map<string, CatalogRecord>();
  const registry = new FakeRegistry();
  const picker = new FakePicker();
  const worker = new FakeWorker(catalogs);
  const runtime = new FakeRuntime(catalogs);
  const watchers = new FakeWatchers();
  const settings = new FakeSettings();
  const filesystem = new FakeFilesystem();
  const coordinator = new CatalogCoordinator({
    picker,
    registry,
    worker,
    runtime,
    watchers,
    settings,
    filesystem,
    paths: new FakePaths(),
  });
  return { coordinator, picker, registry, worker, runtime, watchers, settings, filesystem, catalogs };
}

async function createFixture() {
  const value = fixture();
  value.picker.paths.push("/photos/one");
  const created = await value.coordinator.createCatalog({ displayName: "One" });
  return { ...value, created };
}

test("create and root management keep native/database paths main-owned", async () => {
  const value = await createFixture();
  assert.equal(JSON.stringify(value.created).includes("/private"), false);
  assert.equal(value.registry.records.length, 1);
  value.runtime.pendingRoot = runtimeRoot(value.created.session.catalogId, "Second", "/photos/two");
  const added = await value.coordinator.addRoot({ catalogId: value.created.session.catalogId, sessionId: value.created.session.sessionId });
  assert.equal(added.rootId, value.runtime.getSession()?.roots[1]?.rootId);
  assert.equal(value.watchers.activations.at(-1)?.roots.length, 2);
});

test("root relink restores native authority without changing RootId", async () => {
  const value = await createFixture();
  const catalogId = value.created.catalog.catalogId;
  const session = value.created.session;
  const rootId = session.roots[0]!.rootId;
  const runtimeCatalog = value.catalogs.get(catalogId);
  if (runtimeCatalog === undefined) throw new Error("Missing runtime catalog.");
  runtimeCatalog.roots = runtimeCatalog.roots.map((root) => ({ ...root, nativePath: null }));
  const workerState = value.worker.states.get(catalogId);
  if (workerState === undefined) throw new Error("Missing worker state.");
  value.worker.states.set(catalogId, {
    ...workerState,
    roots: workerState.roots.map((root) => ({
      ...root,
      canonicalPath: null,
      health: "missing",
      scanState: "unknown",
      watchState: "disabled",
    })),
  });
  assert.equal(value.runtime.getNativeSessionRoots().length, 0);

  value.picker.paths.push("/photos/relinked");
  const relinked = await value.coordinator.relinkRoot({ catalogId, sessionId: session.sessionId, rootId });

  assert.equal(relinked.session.roots.length, 1);
  assert.equal(relinked.session.roots[0]?.rootId, rootId);
  const nativeRoots = value.runtime.getNativeSessionRoots();
  assert.equal(nativeRoots.length, 1);
  assert.equal(nativeRoots[0]?.rootId, rootId);
  assert.equal(nativeRoots[0]?.nativePath, "/photos/relinked");
});

test("bootstrap reopens the valid last catalog and reports a missing one safely", async () => {
  const value = await createFixture();
  const first = value.created;
  await value.coordinator.closeCatalog(first.session);
  value.settings.lastCatalogId = first.catalog.catalogId;
  const reopened = await value.coordinator.bootstrap();
  assert.equal(reopened.session?.catalogId, first.catalog.catalogId);
  assert.equal(reopened.recovery, null);

  await value.coordinator.closeCatalog(reopened.session!);
  value.settings.lastCatalogId = createCatalogId();
  const missing = await value.coordinator.bootstrap();
  assert.equal(missing.session, null);
  assert.equal(missing.recovery?.kind, "missing");
});

test("SQLite rename remains authoritative when the derived registry update fails", async () => {
  const value = await createFixture();
  const session = value.created.session;
  value.registry.failUpserts = 1;
  const result = await value.coordinator.applyLive({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: 1,
    mutations: [{ kind: "rename-catalog", displayName: "Renamed" }],
  });
  assert.equal(result.changed, true);
  const active = await value.coordinator.bootstrap();
  assert.equal(active.catalogs.find((catalog) => catalog.catalogId === session.catalogId)?.displayName, "Renamed");
  const reopened = await value.coordinator.openCatalog({ catalogId: session.catalogId });
  assert.equal(reopened.catalog.displayName, "Renamed");
  assert.equal(value.registry.records.find((catalog) => catalog.catalogId === session.catalogId)?.displayName, "Renamed");
});

test("catalog deletion cannot remove the database before registry removal succeeds", async () => {
  const value = await createFixture();
  await assert.rejects(value.coordinator.removeCatalog({
    catalogId: value.created.catalog.catalogId,
    deleteFile: true,
    confirmation: value.created.catalog.displayName,
  }), /Close the active catalog/);
  assert.deepEqual(value.filesystem.deletedPaths, []);
  await value.coordinator.closeCatalog(value.created.session);
  value.registry.failRemoves = 1;
  await assert.rejects(value.coordinator.removeCatalog({
    catalogId: value.created.catalog.catalogId,
    deleteFile: true,
    confirmation: value.created.catalog.displayName,
  }), /registry/);
  assert.deepEqual(value.filesystem.deletedPaths, []);
  assert.equal(value.registry.records.some((record) => record.catalogId === value.created.catalog.catalogId), true);

  value.filesystem.failDeletes = 1;
  await assert.rejects(value.coordinator.removeCatalog({
    catalogId: value.created.catalog.catalogId,
    deleteFile: true,
    confirmation: value.created.catalog.displayName,
  }), /deletion/);
  assert.equal(value.registry.records.some((record) => record.catalogId === value.created.catalog.catalogId), true);
});

test("startup migration recovery is renderer-safe and blocks implicit reopen", async () => {
  const value = fixture();
  value.registry.read = async () => {
    throw new Error("/private/catalog-registry.json is corrupt");
  };
  const recovery = {
    kind: "corrupt" as const,
    catalogId: null,
    message: "The existing library could not be migrated safely.",
  };
  const coordinator = new CatalogCoordinator({
    picker: value.picker,
    registry: value.registry,
    worker: value.worker,
    runtime: value.runtime,
    watchers: value.watchers,
    settings: value.settings,
    filesystem: new FakeFilesystem(),
    paths: new FakePaths(),
    startupRecovery: recovery,
  });
  try {
    const result = await coordinator.bootstrap();
    assert.deepEqual(result.recovery, recovery);
    assert.equal(result.session, null);
    assert.equal(JSON.stringify(result).includes("/private"), false);
  } finally {
    await coordinator.close();
  }
});

test("recognized but unavailable DNGs remain catalogable with their format id", async () => {
  const value = await createFixture();
  const session = value.created.session;
  const source = createCatalogRuntimeSource(value.worker, () => 10);
  await source.commitScan({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    rootId: session.roots[0]!.rootId,
    signal: new AbortController().signal,
    observations: [{ name: "camera.dng", relativePath: "camera.dng", size: 12, lastModified: 4, formatId: "dng" }],
  });
  const mutation = value.worker.lastApplyMutations[0];
  assert.equal(mutation?.kind, "reconcile-complete");
  if (mutation?.kind !== "reconcile-complete") throw new Error("Expected reconcile mutation.");
  assert.equal(mutation.observations[0]?.formatId, "dng");
});

test("settings updates serialize and preserve unrelated catalog/export fields", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "darkroom-settings-"));
  try {
    const settings = createSettingsStore(directory);
    const catalogId = createCatalogId();
    await Promise.all([
      settings.setLastCatalogId(catalogId),
      settings.setLastFolder("/photos/one"),
      settings.setExportOptions({ quality: 81 }),
    ]);
    const parsed = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(parsed.lastCatalogId, catalogId);
    assert.equal(parsed.lastFolderPath, "/photos/one");
    assert.equal((parsed.exportOptions as Record<string, unknown>).quality, 81);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed requests and main-only mutations are rejected", () => {
  assert.throws(() => parseCatalogApplyRequest({ catalogId: createCatalogId(), sessionId: createSessionId(), expectedRevision: 1, mutations: [{ kind: "root-scan", rootId: createRootId(), scanState: "complete" }] }), /renderer-safe/);
  assert.throws(() => parseCatalogApplyRequest({ catalogId: createCatalogId(), sessionId: createSessionId(), expectedRevision: 1, mutations: [{ kind: "root-watch", rootId: createRootId(), watchState: "active" }] }), /renderer-safe/);
  assert.throws(() => parseCatalogApplyRequest({ catalogId: createCatalogId(), sessionId: createSessionId(), expectedRevision: 1, mutations: [{ kind: "fingerprint-set", fingerprint: { assetId: createAssetId(), status: "valid", sha256: "a".repeat(64), observedAt: 1, observedByteLength: 1, observedModifiedAt: 1, localFileId: null } }] }), /renderer-safe/);
  assert.throws(() => parseCatalogApplyRequest({ catalogId: createCatalogId(), sessionId: createSessionId(), expectedRevision: 1, mutations: [{ kind: "asset-relocate", assetId: createAssetId(), rootId: createRootId(), relativePath: "one.jpg", observation: null, health: "missing" }] }), /renderer-safe/);
  assert.throws(() => parseCatalogApplyRequest({ catalogId: createCatalogId(), sessionId: createSessionId(), expectedRevision: 1, mutations: [{ kind: "asset-copy", sourceAssetId: createAssetId(), newAssetId: createAssetId(), rootId: createRootId(), relativePath: "one.jpg", observation: null, health: "missing" }] }), /renderer-safe/);
  assert.throws(() => parseCatalogApplyRequest({ catalogId: createCatalogId(), sessionId: createSessionId(), expectedRevision: 1, mutations: [{ kind: "rule-delete", ruleId: createCatalogId() }] }), /renderer-safe/);
  assert.throws(() => parseCatalogApplyRequest({ catalogId: "bad", sessionId: createSessionId(), expectedRevision: 1, mutations: [] }), /CatalogId/);
});

test("rapid switch invalidates stale queries, operations, asset calls, and events", async () => {
  const value = await createFixture();
  const first = value.created;
  value.picker.paths.push("/photos/two");
  let resolvePendingQuery: (result: unknown) => void = () => undefined;
  value.worker.pendingQuery = new Promise((resolve) => {
    resolvePendingQuery = resolve;
  });
  value.worker.pendingQueryCatalogId = first.session.catalogId;
  const query = value.coordinator.queryLive({ catalogId: first.session.catalogId, sessionId: first.session.sessionId, expectedRevision: null });
  const second = await value.coordinator.createCatalog({ displayName: "Two" });
  assert.ok(value.watchers.closeCount > 0);
  resolvePendingQuery(value.worker.states.get(first.session.catalogId));
  await assert.rejects(query, /inactive|superseded/);
  await assert.rejects(value.coordinator.readAsset({ catalogId: first.session.catalogId, sessionId: first.session.sessionId, assetId: createAssetId() }), /inactive/);
  const events: CatalogEvent[] = [];
  value.coordinator.subscribe((event) => events.push(event));
  value.runtime.emit({ catalogId: first.session.catalogId, sessionId: first.session.sessionId, operationId: createOperationId(), sequence: 99, kind: "scan-terminal", payload: { status: "completed", directoriesVisited: 1, filesConsidered: 1, acceptedCount: 1, currentPath: null } });
  assert.equal(events.length, 0);
  assert.equal(second.session.catalogId === first.session.catalogId, false);
});

test("scan cancel and merged runtime/watcher events use one monotonic sequence", async () => {
  const value = await createFixture();
  const session = value.created.session;
  const events: CatalogEvent[] = [];
  value.coordinator.subscribe((event) => events.push(event));
  const operation = value.coordinator.startScan({ catalogId: session.catalogId, sessionId: session.sessionId, rootId: session.roots[0]!.rootId, timeoutMs: undefined });
  value.coordinator.cancelScan({ catalogId: session.catalogId, sessionId: session.sessionId, operationId: operation.operationId });
  assert.deepEqual(value.runtime.cancelled, [operation.operationId]);
  value.runtime.emit({ catalogId: session.catalogId, sessionId: session.sessionId, operationId: operation.operationId, sequence: 10, kind: "scan-progress", payload: { phase: "scanning", directoriesVisited: 1, filesConsidered: 0, acceptedCount: 0, currentPath: "" } });
  value.watchers.emit({ catalogId: session.catalogId, sessionId: session.sessionId, rootId: session.roots[0]!.rootId, operationId: createOperationId(), sequence: 1, kind: "watch-state", payload: { status: "active", retryAttempt: 0, errorCode: null } });
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal(events[1]?.kind === "watch-state" ? events[1].rootId : null, session.roots[0]!.rootId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(value.worker.lastApplyMutations, [{
    kind: "root-watch",
    rootId: session.roots[0]!.rootId,
    watchState: "active",
  }]);
});

test("asset reads/stat/decode/sidecar are ID-scoped and return structured safe data", async () => {
  const value = await createFixture();
  const session = value.created.session;
  const request = { catalogId: session.catalogId, sessionId: session.sessionId, assetId: createAssetId() };
  assert.deepEqual(new Uint8Array(await value.coordinator.readAsset(request)), Uint8Array.from([1, 2, 3]));
  assert.deepEqual(await value.coordinator.statAsset(request), { size: 3, lastModified: 1 });
  assert.equal((await value.coordinator.readSidecar(request))?.contents, "<xmp/>");
  assert.equal((await value.coordinator.decodeAsset(request, { kind: "nef", mode: "preview", maxEdge: 2560 })).available, true);
  await assert.rejects(value.coordinator.readAsset({ ...request, sessionId: createSessionId() }), /inactive/);
});

test("disk removal is gated before native or catalog mutation", async () => {
  const value = await createFixture();
  const session = value.created.session;
  await assert.rejects(value.coordinator.trashAsset({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    assetId: createAssetId(),
  }), /unavailable/);
  assert.equal(value.runtime.trashCount, 0);
  assert.deepEqual(value.worker.lastApplyMutations, []);
});

test("live apply keeps renderer mutations safe, rejects overlap, and redacts bulk paths/XMP", async () => {
  const value = await createFixture();
  const session = value.created.session;
  const firstRoot = session.roots[0]!;
  const secondRoot = runtimeRoot(session.catalogId, "Second", "/photos/two");
  value.catalogs.get(session.catalogId)!.roots.push(secondRoot);
  const state = value.worker.states.get(session.catalogId)!;
  (state.roots as CatalogLiveRoot[]).push({
    rootId: secondRoot.rootId,
    label: secondRoot.label,
    configuredPath: secondRoot.nativePath,
    canonicalPath: secondRoot.nativePath,
    health: "online",
    scanState: "unknown",
    watchState: "disabled",
    revision: 1,
  });
  const assetId = createAssetId();
  (state.assets as unknown as Array<CatalogLiveState["assets"][number]>).push({
    catalogId: session.catalogId,
    assetId,
    rootId: firstRoot.rootId,
    relativePath: "one.nef",
    observation: null,
    revision: 1,
    health: "missing",
    formatId: "nef",
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    fingerprintId: "00000000-0000-1000-8000-000000000000",
    fingerprintStatus: "missing",
    fingerprintSha256: null,
    fingerprintObservedAt: null,
    fingerprintObservedByteLength: null,
    fingerprintObservedModifiedAt: null,
    fingerprintLocalFileId: null,
    metadata: {
      archive: false,
      pick: "none",
      rating: 0,
      colorLabel: null,
      developJson: null,
      developUpdatedAt: 0,
      updatedAt: 0,
      title: null,
      caption: null,
      copyright: null,
      keywordsJson: "[]",
      rawXmp: "<x:xmpmeta>bulk secret</x:xmpmeta>",
      xmpState: "preserved",
      xmpMtime: 1,
      xmpSha256: null,
    },
  });

  const presetId = createPresetId();
  const firstRuleId = createCatalogId();
  const secondRuleId = createCatalogId();
  const apply = await value.coordinator.applyLive({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: 1,
    mutations: [
      { kind: "metadata-patch", assetId, patch: { version: 1, title: "Edited" } },
      {
        kind: "preset-upsert",
        presetId,
        name: "Default",
        payload: { version: 1, template: { pattern: "photos/{{year}}" }, payload: { mode: "copy" }, isDefault: true },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  assert.equal(apply.appliedMutations, 2);
  const firstRule = await value.coordinator.applyAutoImportRule({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: 1,
    mutations: [{
      kind: "rule-upsert",
      ruleId: firstRuleId,
      name: "Ingress",
      enabled: true,
      destinationRootId: firstRoot.rootId,
      presetId,
      config: { version: 1, action: "copy", ingressRootId: secondRoot.rootId, ingressRelativePath: "inbox", stabilityMs: 1, maxAttempts: 1, retryBackoffMs: 1 },
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  assert.equal(firstRule.appliedMutations, 1);

  const nestedRoot = value.catalogs.get(session.catalogId)!.roots[1]!;
  value.catalogs.get(session.catalogId)!.roots[1] = { ...nestedRoot, nativePath: "/photos/one/nested" };
  await assert.rejects(value.coordinator.applyAutoImportRule({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: 1,
    mutations: [{
      kind: "rule-upsert",
      ruleId: secondRuleId,
      name: "Overlap",
      enabled: true,
      destinationRootId: firstRoot.rootId,
      presetId,
      config: { version: 1, action: "copy", ingressRootId: secondRoot.rootId, ingressRelativePath: "inbox", stabilityMs: 1, maxAttempts: 1, retryBackoffMs: 1 },
      createdAt: 1,
      updatedAt: 1,
    }],
  }), /overlap/);

  const sameRootRule = await value.coordinator.applyAutoImportRule({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: 1,
    mutations: [{
      kind: "rule-upsert",
      ruleId: secondRuleId,
      name: "Same root, separate folders",
      enabled: false,
      destinationRootId: firstRoot.rootId,
      presetId,
      config: {
        version: 2,
        action: "copy",
        ingressRootId: firstRoot.rootId,
        ingressRelativePath: "incoming",
        destinationRelativePath: "output",
        presetVersion: 1,
        presetSha256: "a".repeat(64),
        duplicatePolicy: "skip-incoming",
        destinationConflictPolicy: "rename",
        stabilityMs: 1,
        maxAttempts: 1,
        retryBackoffMs: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  assert.equal(sameRootRule.appliedMutations, 1);

  const queried = await value.coordinator.queryLive({ catalogId: session.catalogId, sessionId: session.sessionId, expectedRevision: null });
  assert.equal(JSON.stringify(queried).includes("/photos"), false);
  assert.equal(JSON.stringify(queried).includes("bulk secret"), false);
  assert.equal(queried.assets[0]?.metadata.rawXmp, null);
  assert.throws(() => parseCatalogApplyRequest({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: 1,
    mutations: [{ kind: "preset-upsert", presetId, name: "Huge", payload: { version: 1, template: { pattern: "x" }, payload: { text: "x".repeat(600_000) }, isDefault: false }, createdAt: 1, updatedAt: 1 }],
  }), /too large/);
});
