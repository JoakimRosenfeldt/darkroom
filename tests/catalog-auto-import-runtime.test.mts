import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdir, mkdtemp, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createCatalogId,
  createPresetId,
  createRootId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import { createSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import { CatalogLiveRepository } from "../electron/catalog-live-repository.ts";
import {
  AutoImportQueue,
  parseAutoImportRuleId,
  type AutoImportRule,
} from "../lib/import/auto-import.ts";
import { createAutoImportStore } from "../electron/auto-import-store.ts";
import {
  CatalogAutoImportRuntime,
  type CatalogAutoImportRuntimeOptions,
} from "../electron/catalog-auto-import-runtime.ts";
import type { CatalogAutoImportMonitorPorts } from "../electron/catalog-auto-import-monitor.ts";
import { MemoryFileTransactionJournal, type FileTransactionFileSystem } from "../electron/file-transaction-service.ts";

interface Fixture {
  readonly temporaryRoot: string;
  readonly sourceRootPath: string;
  readonly destinationRootPath: string;
  readonly database: DatabaseSync;
  readonly repository: CatalogLiveRepository;
  readonly catalogId: CatalogId;
  readonly sourceRootId: RootId;
  readonly destinationRootId: RootId;
  readonly sessionId: SessionId;
  readonly presetId: ReturnType<typeof createPresetId>;
  readonly storeDirectory: string;
}

function observation(observedAt: number) {
  return { size: 4, modifiedAt: 10, localFileId: null, observedAt };
}

function autoRule(fixture: Fixture, overrides: Partial<AutoImportRule> = {}): AutoImportRule {
  return {
    catalogId: fixture.catalogId,
    ruleId: parseAutoImportRuleId(randomUUID()),
    ingressRootId: fixture.sourceRootId,
    ingressRelativePath: "inbox",
    destinationRootId: fixture.destinationRootId,
    destinationRelativePath: "photos",
    placement: "copy",
    presetId: fixture.presetId,
    presetVersion: 1,
    presetSha256: "a".repeat(64),
    duplicatePolicy: "skip-incoming",
    destinationConflictPolicy: "rename",
    enabled: false,
    stabilityMs: 10,
    maxAttempts: 3,
    retryBackoffMs: 20,
    ...overrides,
  };
}

function worker(fixture: Fixture): CatalogAutoImportRuntimeOptions["worker"] {
  return {
    liveQuery: async (input) => fixture.repository.query(input),
    liveApply: async (input) => fixture.repository.apply(input),
  };
}

function runtime(
  fixture: Fixture,
  monitorPorts: CatalogAutoImportMonitorPorts = {
    listCandidates: async () => [],
    observe: async (_rootId, relativePath) => ({ relativePath, observation: observation(100), readable: true }),
  },
  fileSystem?: FileTransactionFileSystem,
): CatalogAutoImportRuntime {
  return new CatalogAutoImportRuntime({
    catalogId: fixture.catalogId,
    sessionId: fixture.sessionId,
    worker: worker(fixture),
    assertCurrentSession: () => undefined,
    applyLive: async (input) => fixture.repository.apply({
      catalogId: input.catalogId,
      expectedRevision: input.expectedRevision,
      mutations: input.mutations,
      now: 100,
    }),
    resolveNativeRoot: async (input) => {
      const nativePath = input.rootId === fixture.sourceRootId ? fixture.sourceRootPath : fixture.destinationRootPath;
      return { catalogId: input.catalogId, rootId: input.rootId, canonicalPath: nativePath };
    },
    store: createAutoImportStore(fixture.storeDirectory),
    journal: new MemoryFileTransactionJournal(),
    ...(fileSystem === undefined ? {} : { fileSystem }),
    openPath: async () => "",
    now: () => 100,
    monitorPorts,
  });
}

async function fixture(): Promise<Fixture> {
  const temporaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), "darkroom-auto-runtime-")));
  const sourceRootPath = path.join(temporaryRoot, "source");
  const destinationRootPath = path.join(temporaryRoot, "destination");
  const storeDirectory = path.join(temporaryRoot, "state");
  await mkdir(sourceRootPath);
  await mkdir(destinationRootPath);
  const database = new DatabaseSync(path.join(temporaryRoot, "catalog.db"), { enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON;");
  const repository = new CatalogLiveRepository(database);
  const catalogId = createCatalogId();
  const sourceRootId = createRootId();
  const destinationRootId = createRootId();
  const presetId = createPresetId();
  repository.create({
    catalogId,
    displayName: "Auto runtime test",
    appVersion: "test",
    root: {
      rootId: sourceRootId,
      label: "Source",
      configuredPath: sourceRootPath,
      canonicalPath: sourceRootPath,
      health: "online",
      scanState: "complete",
      watchState: "disabled",
    },
    now: 100,
  });
  const state = repository.query({ catalogId, expectedRevision: null });
  repository.apply({
    catalogId,
    expectedRevision: state.catalog.revision,
    mutations: [
      {
        kind: "root-upsert",
        root: {
          rootId: destinationRootId,
          label: "Destination",
          configuredPath: destinationRootPath,
          canonicalPath: destinationRootPath,
          health: "online",
          scanState: "complete",
          watchState: "disabled",
        },
      },
      {
        kind: "preset-upsert",
        presetId,
        name: "Auto preset",
        payload: {
          version: 1,
          template: { pattern: "{{filename}}" },
          payload: { metadata: { keywords: [] } },
          isDefault: true,
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    now: 100,
  });
  return {
    temporaryRoot,
    sourceRootPath,
    destinationRootPath,
    database,
    repository,
    catalogId,
    sourceRootId,
    destinationRootId,
    sessionId: createSessionId(),
    presetId,
    storeDirectory,
  };
}

async function cleanup(value: Fixture): Promise<void> {
  value.database.close();
  await rm(value.temporaryRoot, { recursive: true, force: true });
}

function applyRule(fixtureValue: Fixture, rule: AutoImportRule): void {
  if (rule.duplicatePolicy === "use-existing-location") {
    throw new Error("Test rule cannot use existing location.");
  }
  if (rule.destinationConflictPolicy === "replace") {
    throw new Error("Test rule cannot replace destinations.");
  }
  const state = fixtureValue.repository.query({ catalogId: fixtureValue.catalogId, expectedRevision: null });
  fixtureValue.repository.apply({
    catalogId: fixtureValue.catalogId,
    expectedRevision: state.catalog.revision,
    mutations: [{
      kind: "rule-upsert",
      ruleId: rule.ruleId,
      name: "Auto Import",
      enabled: rule.enabled,
      destinationRootId: rule.destinationRootId,
      presetId: rule.presetId,
      config: {
        version: 2,
        action: "copy",
        ingressRootId: rule.ingressRootId,
        ingressRelativePath: rule.ingressRelativePath,
        destinationRelativePath: rule.destinationRelativePath,
        presetVersion: rule.presetVersion,
        presetSha256: rule.presetSha256,
        duplicatePolicy: rule.duplicatePolicy,
        destinationConflictPolicy: rule.destinationConflictPolicy,
        stabilityMs: rule.stabilityMs,
        maxAttempts: rule.maxAttempts,
        retryBackoffMs: rule.retryBackoffMs,
      },
      createdAt: 1,
      updatedAt: 100,
    }],
    now: 100,
  });
}

test("V2 live authority replaces a changed same-ID sidecar and cancels stale work", async () => {
  const value = await fixture();
  try {
    const rule = autoRule(value, { enabled: false });
    applyRule(value, rule);
    const old = autoRule(value, { ruleId: rule.ruleId, ingressRelativePath: "old", enabled: true });
    const queue = new AutoImportQueue();
    queue.enqueue(old, {
      first: { relativePath: "old/photo.jpg", observation: observation(90), readable: true },
      second: { relativePath: "old/photo.jpg", observation: observation(100), readable: true },
    }, 100);
    const store = createAutoImportStore(value.storeDirectory);
    await store.save([old], queue, false);
    const instance = runtime(value);
    await instance.start();
    const status = await instance.status();
    assert.equal(status.state, "disabled");
    assert.equal(status.rule?.ingressRelativePath, "inbox");
    const sidecar = await store.load();
    assert.equal(sidecar.rules[0]?.ingressRelativePath, "inbox");
    assert.equal(sidecar.queue.list()[0]?.state, "cancelled");
    instance.dispose();
  } finally {
    await cleanup(value);
  }
});

test("legacy or missing live authority clears stale sidecar state", async () => {
  const value = await fixture();
  try {
    const stale = autoRule(value, { enabled: true });
    const queue = new AutoImportQueue();
    queue.pause();
    await createAutoImportStore(value.storeDirectory).save([stale], queue, true);
    const instance = runtime(value);
    await instance.start();
    const status = await instance.status();
    assert.equal(status.state, "unconfigured");
    const sidecar = await createAutoImportStore(value.storeDirectory).load();
    assert.deepEqual(sidecar.rules, []);
    assert.deepEqual(sidecar.queue.list(), []);
    assert.equal(sidecar.paused, false);
    instance.dispose();
  } finally {
    await cleanup(value);
  }
});

test("configure persists the frozen V2 rule and live enable/disable authority", async () => {
  const value = await fixture();
  try {
    const instance = runtime(value);
    await instance.start();
    const configured = await instance.configure({
      ingressRootId: value.sourceRootId,
      ingressRelativePath: "inbox",
      destinationRootId: value.destinationRootId,
      destinationRelativePath: "photos",
      presetId: value.presetId,
      duplicatePolicy: "skip-incoming",
      destinationConflictPolicy: "rename",
      stabilityMs: 100,
      maxAttempts: 3,
      retryBackoffMs: 200,
      enabled: false,
    });
    assert.equal(configured.state, "disabled");
    const live = value.repository.query({ catalogId: value.catalogId, expectedRevision: null });
    assert.equal(live.rules[0]?.config.version, 2);
    assert.equal(live.rules[0]?.enabled, false);
    const enabled = await instance.enable();
    assert.equal(enabled.state, "ready");
    assert.equal(value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).rules[0]?.enabled, true);
    const disabled = await instance.disable();
    assert.equal(disabled.state, "disabled");
    assert.equal(value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).rules[0]?.enabled, false);
    instance.dispose();
  } finally {
    await cleanup(value);
  }
});

test("live authority prefers one enabled V2 rule over retained disabled rows", async () => {
  const value = await fixture();
  try {
    const retained = autoRule(value, { ingressRelativePath: "retained", enabled: false });
    const active = autoRule(value, { ingressRelativePath: "active", enabled: true });
    applyRule(value, retained);
    applyRule(value, active);
    const instance = runtime(value);
    await instance.start();
    const status = await instance.status();
    assert.equal(status.rule?.ruleId, active.ruleId);
    assert.equal(status.rule?.ingressRelativePath, "active");
    instance.dispose();
  } finally {
    await cleanup(value);
  }
});

test("live authority chooses a deterministic disabled rule when no rule is enabled", async () => {
  const value = await fixture();
  try {
    const first = autoRule(value, { ingressRelativePath: "first", enabled: false });
    const second = autoRule(value, { ingressRelativePath: "second", enabled: false });
    applyRule(value, first);
    applyRule(value, second);
    const instance = runtime(value);
    await instance.start();
    const status = await instance.status();
    assert.equal(status.rule?.ruleId, [first.ruleId, second.ruleId].sort().at(-1));
    instance.dispose();
  } finally {
    await cleanup(value);
  }
});

test("live authority rejects multiple enabled rules", async () => {
  const value = await fixture();
  try {
    value.database.exec("DROP INDEX auto_import_one_enabled_per_catalog");
    applyRule(value, autoRule(value, { ingressRelativePath: "first", enabled: true }));
    applyRule(value, autoRule(value, { ingressRelativePath: "second", enabled: true }));
    const instance = runtime(value);
    await assert.rejects(instance.start(), /multiple enabled rules/);
    instance.dispose();
  } finally {
    await cleanup(value);
  }
});

test("runtime status exposes native enumeration degradation without a path", async () => {
  const value = await fixture();
  try {
    applyRule(value, autoRule(value, { enabled: true }));
    const instance = runtime(value, {
      listCandidates: async () => ({ candidates: [], overflowed: false, degraded: true }),
      observe: async (_rootId, relativePath) => ({ relativePath, observation: observation(100), readable: true }),
    });
    await instance.start();
    const status = await instance.status();
    assert.equal(status.degraded, true);
    instance.dispose();
  } finally {
    await cleanup(value);
  }
});

test("runtime dispose cancels an active executor before catalog switch", async () => {
  const value = await fixture();
  try {
    const ingressDirectory = path.join(value.sourceRootPath, "inbox");
    await mkdir(ingressDirectory);
    const sourcePath = path.join(ingressDirectory, "photo.jpg");
    await writeFile(sourcePath, "same");
    const sourceStat = await stat(sourcePath);
    const instance = runtime(value, undefined, undefined);
    await instance.start();
    await instance.configure({
      ingressRootId: value.sourceRootId,
      ingressRelativePath: "inbox",
      destinationRootId: value.destinationRootId,
      destinationRelativePath: "photos",
      presetId: value.presetId,
      duplicatePolicy: "continue-unchecked",
      destinationConflictPolicy: "rename",
      stabilityMs: 10,
      maxAttempts: 3,
      retryBackoffMs: 20,
      enabled: true,
    });
    instance.dispose();
    const rule = (await createAutoImportStore(value.storeDirectory).load()).rules[0];
    assert.ok(rule);
    const sourceObservation = {
      size: sourceStat.size,
      modifiedAt: sourceStat.mtimeMs,
      localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
      observedAt: 100,
    };
    const queue = new AutoImportQueue();
    queue.enqueue(rule, {
      first: { relativePath: "inbox/photo.jpg", observation: { ...sourceObservation, observedAt: 89 }, readable: true },
      second: { relativePath: "inbox/photo.jpg", observation: sourceObservation, readable: true },
    }, 100);
    assert.equal(queue.list().length, 1);
    const store = createAutoImportStore(value.storeDirectory);
    await store.save([rule], queue, false);
    const releaseCopy: { current: (() => void) | null } = { current: null };
    let markCopyEntered: (() => void) | null = null;
    const copyEntered = new Promise<void>((resolve) => { markCopyEntered = resolve; });
    let copyWasEntered = false;
    const fileSystem: FileTransactionFileSystem = {
      exists: async (filePath) => stat(filePath).then(() => true).catch(() => false),
      mkdir: async (directoryPath) => { await mkdir(directoryPath, { recursive: true }); },
      copyFile: async (source, destination) => {
        if (!copyWasEntered) {
          copyWasEntered = true;
          markCopyEntered?.();
          await new Promise<void>((resolve) => { releaseCopy.current = resolve; });
        }
        await copyFile(source, destination);
      },
      rename: async (source, destination) => {
        const { rename } = await import("node:fs/promises");
        await rename(source, destination);
      },
      removeFile: async (filePath) => { await unlink(filePath).catch(() => undefined); },
      observe: async (filePath) => {
        const current = await stat(filePath);
        return { size: current.size, modifiedAt: current.mtimeMs, localFileId: `${current.dev}:${current.ino}`, observedAt: 100 };
      },
      digest: async (filePath) => {
        const current = await stat(filePath);
        return { sha256: "a".repeat(64), observation: { size: current.size, modifiedAt: current.mtimeMs, localFileId: `${current.dev}:${current.ino}`, observedAt: 100 } };
      },
      verifyCopy: async () => undefined,
      verifyObservation: async () => undefined,
    };
    const runtimeWithBlockedCopy = runtime(value, undefined, fileSystem);
    await store.save([rule], new AutoImportQueue(), false);
    await runtimeWithBlockedCopy.start();
    await store.save([rule], queue, false);
    const starting = runtimeWithBlockedCopy.refresh();
    await copyEntered;
    let shutdownFinished = false;
    runtimeWithBlockedCopy.dispose();
    const shuttingDown = runtimeWithBlockedCopy.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    assert.equal(shutdownFinished, false);
    releaseCopy.current?.();
    await Promise.all([starting, shuttingDown]);
    const persisted = await store.load();
    assert.equal(persisted.queue.list()[0]?.state, "cancelled");
  } finally {
    await cleanup(value);
  }
});
