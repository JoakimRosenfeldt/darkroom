import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fsp from "node:fs/promises";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAssetId,
  createCatalogId,
  createPresetId,
  createRootId,
  type AssetId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import { createSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import type { CatalogImportPrepareRequest } from "../lib/import/api.ts";
import { sameFileObservation, type JsonValue } from "../lib/import/domain.ts";
import { CatalogLiveRepository } from "../electron/catalog-live-repository.ts";
import {
  CatalogManualImportController,
  type CatalogManualImportControllerOptions,
} from "../electron/catalog-manual-import-controller.ts";
import { MemoryFileTransactionJournal } from "../electron/file-transaction-service.ts";
import type { FileTransactionFileSystem } from "../electron/file-transaction-service.ts";
import { fingerprintNoFollowFile, observeNoFollowFile } from "../electron/catalog-fingerprint-service.ts";

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
}

function request(
  fixture: Fixture,
  action: CatalogImportPrepareRequest["action"],
  presetId: CatalogImportPrepareRequest["presetId"] = null,
  duplicatePolicy: CatalogImportPrepareRequest["duplicatePolicy"] = "keep-both",
  destinationPolicy: CatalogImportPrepareRequest["destinationPolicy"] = "rename",
): CatalogImportPrepareRequest {
  return {
    catalogId: fixture.catalogId,
    sessionId: fixture.sessionId,
    action,
    destinationRootId: fixture.destinationRootId,
    presetId,
    duplicatePolicy,
    destinationPolicy,
  };
}

function liveWorker(fixture: Fixture): CatalogManualImportControllerOptions["worker"] {
  return {
    liveQuery: async (input) => fixture.repository.query(input),
    liveApply: async (input) => fixture.repository.apply(input),
  };
}

function controller(
  fixture: Fixture,
  selected: readonly string[],
  overrides: Partial<CatalogManualImportControllerOptions> = {},
): CatalogManualImportController {
  return new CatalogManualImportController({
    catalogId: fixture.catalogId,
    sessionId: fixture.sessionId,
    worker: liveWorker(fixture),
    assertCurrentSession: () => undefined,
    getNativeSessionRoots: () => [
      { catalogId: fixture.catalogId, rootId: fixture.sourceRootId, nativePath: fixture.sourceRootPath },
      { catalogId: fixture.catalogId, rootId: fixture.destinationRootId, nativePath: fixture.destinationRootPath },
    ],
    chooseFiles: async () => selected,
    journal: new MemoryFileTransactionJournal(),
    now: () => 100,
    ...overrides,
  });
}

function revision(fixture: Fixture): number {
  return fixture.repository.query({ catalogId: fixture.catalogId, expectedRevision: null }).catalog.revision;
}

function apply(fixture: Fixture, mutations: Parameters<CatalogLiveRepository["apply"]>[0]["mutations"]): void {
  fixture.repository.apply({ catalogId: fixture.catalogId, expectedRevision: revision(fixture), mutations, now: 100 });
}

async function fixture(): Promise<Fixture> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "darkroom-manual-import-"));
  let sourceRootPath = path.join(temporaryRoot, "source");
  let destinationRootPath = path.join(temporaryRoot, "destination");
  await import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(sourceRootPath);
    await mkdir(destinationRootPath);
  });
  sourceRootPath = await realpath(sourceRootPath);
  destinationRootPath = await realpath(destinationRootPath);
  const database = new DatabaseSync(path.join(temporaryRoot, "catalog.db"), { enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON;");
  const repository = new CatalogLiveRepository(database);
  const catalogId = createCatalogId();
  const sourceRootId = createRootId();
  const destinationRootId = createRootId();
  repository.create({
    catalogId,
    displayName: "Manual import test",
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
  apply(fixtureFrom({ temporaryRoot, sourceRootPath, destinationRootPath, database, repository, catalogId, sourceRootId, destinationRootId, sessionId: createSessionId() }), [{
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
  }]);
  return { temporaryRoot, sourceRootPath, destinationRootPath, database, repository, catalogId, sourceRootId, destinationRootId, sessionId: createSessionId() };
}

function fixtureFrom(value: Fixture): Fixture {
  return value;
}

async function cleanup(value: Fixture): Promise<void> {
  value.database.close();
  await rm(value.temporaryRoot, { recursive: true, force: true });
}

function addPreset(fixtureValue: Fixture, pattern: string, payload: JsonValue = { metadata: { keywords: [] } }): ReturnType<typeof createPresetId> {
  const presetId = createPresetId();
  apply(fixtureValue, [{
    kind: "preset-upsert",
    presetId,
    name: "Test preset",
    payload: { version: 1, template: { pattern }, payload, isDefault: false },
    createdAt: 1,
    updatedAt: 1,
  }]);
  return presetId;
}

async function seedAsset(fixtureValue: Fixture, relativePath: string, assetId = createAssetId()): Promise<AssetId> {
  return seedAssetAt(fixtureValue, fixtureValue.sourceRootId, fixtureValue.sourceRootPath, relativePath, assetId);
}

async function seedAssetAt(
  fixtureValue: Fixture,
  rootId: RootId,
  rootPath: string,
  relativePath: string,
  assetId = createAssetId(),
  localFileId: string | null | undefined = undefined,
): Promise<AssetId> {
  const filePath = path.join(rootPath, ...relativePath.split("/"));
  const stat = await import("node:fs/promises").then(({ stat: readStat }) => readStat(filePath));
  apply(fixtureValue, [{
    kind: "reconcile-complete",
    rootId,
    observations: [{
      assetId,
      relativePath,
      observation: {
        byteLength: stat.size,
        modifiedAt: stat.mtimeMs,
        observedAt: 100,
        localFileId: localFileId === undefined ? `${stat.dev}:${stat.ino}` : localFileId,
      },
      health: "present",
      formatId: "jpeg",
      cameraMake: null,
      cameraModel: null,
      lensModel: null,
    }],
  }]);
  return assetId;
}

test("prepare/review are path-free and do not write worker state", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    const presetId = addPreset(value, "{{stem}}-{{filename}}");
    let writes = 0;
    let picks = 0;
    const instance = controller(value, [source], {
      chooseFiles: async () => {
        picks += 1;
        return [source];
      },
      worker: {
        liveQuery: async (input) => value.repository.query(input),
        liveApply: async (input) => {
          writes += 1;
          return value.repository.apply(input);
        },
      },
    });
    const prepared = await instance.prepare(request(value, "add", presetId));
    const reviewed = await instance.review({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: prepared.operationId });
    assert.equal(writes, 0);
    assert.equal(picks, 1);
    assert.deepEqual(reviewed, prepared);
    assert.equal(prepared.canRun, true);
    assert.equal(prepared.items[0]?.destinationRelativePath, "photo.jpg");
    assert.equal(JSON.stringify(prepared).includes(value.temporaryRoot), false);
  } finally {
    await cleanup(value);
  }
});

test("rejects files outside active roots and symlink selections", async () => {
  const value = await fixture();
  try {
    const outside = path.join(value.temporaryRoot, "outside.jpg");
    await writeFile(outside, "outside");
    await assert.rejects(controller(value, [outside]).prepare(request(value, "add")), /outside the active catalog root/);
    const target = path.join(value.sourceRootPath, "target.jpg");
    const link = path.join(value.sourceRootPath, "link.jpg");
    await writeFile(target, "target");
    await import("node:fs/promises").then(({ symlink }) => symlink(target, link));
    await assert.rejects(controller(value, [link]).prepare(request(value, "add")), /symbolic link|regular file/);
  } finally {
    await cleanup(value);
  }
});

test("controller rejects a stale session around picker/native work", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    let current = true;
    const instance = controller(value, [source], {
      assertCurrentSession: () => {
        if (!current) throw new Error("Import session is stale.");
      },
      chooseFiles: async () => {
        current = false;
        return [source];
      },
    });
    await assert.rejects(instance.prepare(request(value, "add")), /stale/);
  } finally {
    await cleanup(value);
  }
});

test("Add executes with preset metadata and Develop defaults", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    const presetId = addPreset(value, "renamed-{{filename}}", {
      metadata: { title: "Imported", caption: "Caption", copyright: "Copyright", keywords: ["one", "two"] },
      develop: { exposure: 1, contrast: 2 },
    });
    const instance = controller(value, [source]);
    const draft = await instance.prepare(request(value, "add", presetId));
    const result = await instance.run({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: draft.operationId });
    assert.equal(result.state, "completed", result.error ?? "");
    const state = value.repository.query({ catalogId: value.catalogId, expectedRevision: null });
    const asset = state.assets.find((candidate) => candidate.relativePath === "photo.jpg" && candidate.rootId === value.sourceRootId);
    assert.ok(asset);
    assert.equal(state.assets.some((candidate) => candidate.relativePath === "renamed-photo.jpg"), false);
    assert.equal(asset.metadata.title, "Imported");
    assert.equal(asset.metadata.caption, "Caption");
    assert.equal(asset.metadata.copyright, "Copyright");
    assert.equal(asset.metadata.keywordsJson, '["one","two"]');
    assert.equal(asset.metadata.developJson, '{"contrast":2,"exposure":1}');
  } finally {
    await cleanup(value);
  }
});

test("Add reuses an already reconciled source AssetId", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    const sourceAssetId = await seedAsset(value, "photo.jpg");
    const instance = controller(value, [source]);
    const draft = await instance.prepare(request(value, "add"));
    assert.equal(draft.canRun, true);
    const result = await instance.run({
      catalogId: value.catalogId,
      sessionId: value.sessionId,
      operationId: draft.operationId,
    });
    assert.equal(result.state, "completed", result.error ?? "");
    assert.equal(result.items[0]?.destinationAssetId, sourceAssetId);
    const assets = value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets;
    assert.equal(assets.filter((asset) => asset.rootId === value.sourceRootId && asset.relativePath === "photo.jpg").length, 1);
    assert.equal(assets.find((asset) => asset.assetId === sourceAssetId)?.assetId, sourceAssetId);
  } finally {
    await cleanup(value);
  }
});

test("duplicate proof covers selected incoming files and explicit unchecked policy", async () => {
  const value = await fixture();
  try {
    const first = path.join(value.sourceRootPath, "first.jpg");
    const second = path.join(value.sourceRootPath, "second.jpg");
    await writeFile(first, "same");
    await writeFile(second, "same");
    const presetId = addPreset(value, "import-{{filename}}");
    const duplicateDraft = await controller(value, [first, second]).prepare(request(value, "add", presetId, "keep-both"));
    assert.equal(duplicateDraft.items.filter((item) => item.duplicate === "duplicate").length, 2);
    assert.equal(duplicateDraft.canRun, true);
    const skipController = controller(value, [first, second]);
    const skippedDraft = await skipController.prepare(request(value, "add", presetId, "skip-incoming"));
    const skippedResult = await skipController.run({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: skippedDraft.operationId });
    assert.equal(skippedResult.state, "completed", skippedResult.error ?? "");
    assert.equal(value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.some((asset) => asset.relativePath === "first.jpg" || asset.relativePath === "second.jpg"), false);

    const missing = path.join(value.destinationRootPath, "missing.jpg");
    await writeFile(missing, "same");
    const missingAssetId = await seedAssetAt(value, value.destinationRootId, value.destinationRootPath, "missing.jpg");
    await import("node:fs/promises").then(({ unlink }) => unlink(missing));
    const unchecked = await controller(value, [first]).prepare(request(value, "add", presetId, "keep-both"));
    assert.equal(unchecked.items[0]?.duplicate, "not-fully-checked");
    assert.equal(unchecked.canRun, false);
    const continueUnchecked = await controller(value, [first]).prepare(request(value, "add", presetId, "continue-unchecked"));
    assert.equal(continueUnchecked.items[0]?.duplicate, "not-fully-checked");
    assert.equal(continueUnchecked.canRun, true);
    assert.equal(typeof missingAssetId, "string");
  } finally {
    await cleanup(value);
  }
});

test("destination skip, replace, and deterministic rename are reviewed before freeze", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    await seedAsset(value, "photo.jpg");
    const destination = path.join(value.destinationRootPath, "copy-photo.jpg");
    await writeFile(destination, "old");
    await seedAssetAt(value, value.destinationRootId, value.destinationRootPath, "copy-photo.jpg");
    const presetId = addPreset(value, "copy-{{filename}}");
    const skipped = await controller(value, [source]).prepare(request(value, "copy", presetId, "keep-both", "skip"));
    assert.equal(skipped.items[0]?.destinationConflict, true);
    assert.equal(skipped.items[0]?.outcome, "skip");
    assert.equal(skipped.canRun, true);
    const replaced = await controller(value, [source]).prepare(request(value, "copy", presetId, "keep-both", "replace"));
    assert.equal(replaced.items[0]?.outcome, "replace");
    assert.equal(replaced.canRun, false);
    const renamed = await controller(value, [source]).prepare(request(value, "copy", presetId, "keep-both", "rename"));
    assert.equal(renamed.items[0]?.outcome, "rename");
    assert.equal(renamed.items[0]?.destinationRelativePath, "copy-photo (1).jpg");
    assert.equal(renamed.canRun, true);
  } finally {
    await cleanup(value);
  }
});

test("Copy and Move execute with planned AssetId behavior", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    const sourceAssetId = await seedAsset(value, "photo.jpg");
    const copyPreset = addPreset(value, "copy-{{filename}}");
    const copyController = controller(value, [source]);
    const copyDraft = await copyController.prepare(request(value, "copy", copyPreset));
    const copyResult = await copyController.run({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: copyDraft.operationId });
    assert.equal(copyResult.state, "completed", copyResult.error ?? "");
    const copied = value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.find((asset) => asset.rootId === value.destinationRootId && asset.relativePath === "copy-photo.jpg");
    assert.ok(copied);
    assert.notEqual(copied.assetId, sourceAssetId);
    const movePreset = addPreset(value, "move-{{filename}}");
    const moveController = controller(value, [source]);
    const moveDraft = await moveController.prepare(request(value, "move", movePreset));
    const moveResult = await moveController.run({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: moveDraft.operationId });
    assert.equal(moveResult.state, "completed", moveResult.error ?? "");
    const moved = value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.find((asset) => asset.assetId === sourceAssetId);
    assert.equal(moved?.rootId, value.destinationRootId);
    assert.equal(moved?.relativePath, "move-photo.jpg");
    assert.equal(moveResult.items[0]?.destinationAssetId, sourceAssetId);
  } finally {
    await cleanup(value);
  }
});

test("Copy accepts a legacy catalog observation without a local file identity", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    await seedAssetAt(value, value.sourceRootId, value.sourceRootPath, "photo.jpg", createAssetId(), null);
    const presetId = addPreset(value, "legacy-{{filename}}");
    const instance = controller(value, [source]);
    const draft = await instance.prepare(request(value, "copy", presetId));
    assert.equal(draft.canRun, true);
    const result = await instance.run({
      catalogId: value.catalogId,
      sessionId: value.sessionId,
      operationId: draft.operationId,
    });
    assert.equal(result.state, "completed", result.error ?? "");
  } finally {
    await cleanup(value);
  }
});

test("Move summary reports a retained source when cleanup cannot remove it", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    const sourceAssetId = await seedAsset(value, "photo.jpg");
    const fileSystem: FileTransactionFileSystem = {
      exists: async (filePath) => {
        try {
          await fsp.lstat(filePath);
          return true;
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
          throw error;
        }
      },
      mkdir: async (directoryPath) => { await fsp.mkdir(directoryPath, { recursive: true }); },
      copyFile: async (sourcePath, destinationPath) => { await fsp.copyFile(sourcePath, destinationPath); },
      rename: async (sourcePath, destinationPath) => { await fsp.rename(sourcePath, destinationPath); },
      removeFile: async (filePath) => {
        if (filePath === source) throw new Error("cleanup denied");
        await fsp.unlink(filePath).catch((error: unknown) => {
          if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        });
      },
      observe: observeNoFollowFile,
      digest: async (filePath) => {
        const result = await fingerprintNoFollowFile(filePath);
        if (result.status !== "valid" || result.sha256 === null || result.observation === null) throw new Error("digest failed");
        return { sha256: result.sha256, observation: result.observation };
      },
      verifyCopy: async (sourcePath, destinationPath, expectedSource) => {
        const sourceResult = await fingerprintNoFollowFile(sourcePath);
        const destinationResult = await fingerprintNoFollowFile(destinationPath);
        if (sourceResult.status !== "valid" || destinationResult.status !== "valid" || sourceResult.sha256 !== destinationResult.sha256 || sourceResult.observation === null || !sameFileObservation(expectedSource, sourceResult.observation)) {
          throw new Error("copy verification failed");
        }
      },
      verifyObservation: async (filePath, expected) => {
        const actual = await observeNoFollowFile(filePath);
        if (!sameFileObservation(expected, actual)) throw new Error("observation changed");
      },
    };
    const presetId = addPreset(value, "retained-{{filename}}");
    const instance = controller(value, [source], { fileSystem });
    const draft = await instance.prepare(request(value, "move", presetId));
    const result = await instance.run({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: draft.operationId });
    assert.equal(result.state, "completed", result.error ?? "");
    assert.equal(result.items[0]?.sourceRetained, true);
    assert.equal(result.items[0]?.destinationAssetId, sourceAssetId);
    assert.equal(await fsp.lstat(source).then(() => true).catch(() => false), true);
  } finally {
    await cleanup(value);
  }
});

test("manual shutdown waits for a blocked file transaction before settling", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    await seedAsset(value, "photo.jpg");
    const entered: { promise: Promise<void>; resolve: (() => void) | null } = {
      promise: Promise.resolve(),
      resolve: null,
    };
    entered.promise = new Promise<void>((resolve) => {
      entered.resolve = resolve;
    });
    const release: { current: (() => void) | null } = { current: null };
    const fileSystem: FileTransactionFileSystem = {
      exists: async (filePath) => fsp.lstat(filePath).then(() => true).catch(() => false),
      mkdir: async (directoryPath) => { await fsp.mkdir(directoryPath, { recursive: true }); },
      copyFile: async (sourcePath, destinationPath) => {
        entered.resolve?.();
        await new Promise<void>((resolve) => { release.current = resolve; });
        await fsp.copyFile(sourcePath, destinationPath);
      },
      rename: async (sourcePath, destinationPath) => { await fsp.rename(sourcePath, destinationPath); },
      removeFile: async (filePath) => { await fsp.unlink(filePath).catch(() => undefined); },
      observe: observeNoFollowFile,
      digest: async (filePath) => {
        const result = await fingerprintNoFollowFile(filePath);
        if (result.status !== "valid" || result.sha256 === null || result.observation === null) throw new Error("digest failed");
        return { sha256: result.sha256, observation: result.observation };
      },
      verifyCopy: async (sourcePath, destinationPath, expectedSource) => {
        const sourceResult = await fingerprintNoFollowFile(sourcePath);
        const destinationResult = await fingerprintNoFollowFile(destinationPath);
        if (sourceResult.status !== "valid" || destinationResult.status !== "valid" || sourceResult.sha256 !== destinationResult.sha256 || sourceResult.observation === null || !sameFileObservation(expectedSource, sourceResult.observation)) {
          throw new Error("copy verification failed");
        }
      },
      verifyObservation: async (filePath, expected) => {
        const actual = await observeNoFollowFile(filePath);
        if (!sameFileObservation(expected, actual)) throw new Error("observation changed");
      },
    };
    const instance = controller(value, [source], { fileSystem });
    const draft = await instance.prepare(request(value, "copy"));
    const running = instance.run({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: draft.operationId });
    await entered.promise;
    instance.dispose();
    let shutdownFinished = false;
    const shuttingDown = instance.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    assert.equal(shutdownFinished, false);
    release.current?.();
    const result = await running;
    await shuttingDown;
    assert.equal(result.state, "cancelled");
    assert.equal(shutdownFinished, true);
  } finally {
    await cleanup(value);
  }
});

test("Copy requires an existing source AssetId and DNG stays unavailable", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "unregistered.jpg");
    await writeFile(source, "photo");
    const copyDraft = await controller(value, [source]).prepare(request(value, "copy"));
    assert.equal(copyDraft.canRun, false);
    assert.equal(copyDraft.items[0]?.formatId, "jpeg");
    const dng = path.join(value.sourceRootPath, "photo.dng");
    await writeFile(dng, "dng");
    const dngDraft = await controller(value, [dng]).prepare(request(value, "add"));
    assert.equal(dngDraft.copyAsDng.status, "unavailable");
    assert.equal(dngDraft.items[0]?.formatId, "dng");
    assert.equal(dngDraft.items[0]?.outcome, "skip");
    assert.equal(dngDraft.canRun, false);
    assert.equal(value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.some((asset) => asset.relativePath === "photo.dng"), false);
    const unsupported = path.join(value.sourceRootPath, "photo.cr2");
    await writeFile(unsupported, "cr2");
    const unsupportedDraft = await controller(value, [unsupported]).prepare(request(value, "add"));
    assert.equal(unsupportedDraft.items[0]?.formatId, "cr2");
    assert.equal(unsupportedDraft.items[0]?.outcome, "skip");
    assert.equal(unsupportedDraft.canRun, false);
  } finally {
    await cleanup(value);
  }
});

test("cancel before freeze performs no worker write and restart runs persisted work", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.sourceRootPath, "photo.jpg");
    await writeFile(source, "photo");
    await seedAsset(value, "photo.jpg");
    const presetId = addPreset(value, "restart-{{filename}}");
    let writes = 0;
    const first = controller(value, [source], {
      worker: {
        liveQuery: async (input) => value.repository.query(input),
        liveApply: async (input) => {
          writes += 1;
          return value.repository.apply(input);
        },
      },
    });
    const draft = await first.prepare(request(value, "copy", presetId));
    first.cancel({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: draft.operationId });
    const cancelled = await first.run({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: draft.operationId });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(writes, 0);
    const runCancelController = controller(value, [source]);
    const runCancelDraft = await runCancelController.prepare(request(value, "copy", presetId));
    let cancellationChecks = 0;
    const runCancelled = await runCancelController.run(
      { catalogId: value.catalogId, sessionId: value.sessionId, operationId: runCancelDraft.operationId },
      { isCancelled: () => cancellationChecks++ > 0 },
    );
    assert.equal(runCancelled.state, "cancelled");
    assert.equal(value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).operations.find((operation) => operation.operationId === runCancelDraft.operationId)?.state, "cancelled");
    assert.equal(await import("node:fs/promises").then(({ access }) => access(path.join(value.destinationRootPath, "restart-photo.jpg")).then(() => true).catch(() => false)), false);
    let failAfterPersist = true;
    const persistController = controller(value, [source], {
      worker: {
        liveQuery: async (input) => value.repository.query(input),
        liveApply: async (input) => {
          const result = value.repository.apply(input);
          if (failAfterPersist) {
            failAfterPersist = false;
            throw new Error("worker reply lost after persistence");
          }
          return result;
        },
      },
    });
    const persistedDraft = await persistController.prepare(request(value, "copy", presetId));
    await assert.rejects(
      persistController.run({ catalogId: value.catalogId, sessionId: value.sessionId, operationId: persistedDraft.operationId }),
      /worker reply lost after persistence/,
    );
    const recreated = controller(value, []);
    const recovered = (await recreated.recoverPending()).find((item) => item.operationId === persistedDraft.operationId);
    assert.ok(recovered);
    assert.equal(recovered.state, "completed");
    assert.equal(await import("node:fs/promises").then(({ access }) => access(path.join(value.destinationRootPath, "restart-photo.jpg")).then(() => true).catch(() => false)), true);
  } finally {
    await cleanup(value);
  }
});
