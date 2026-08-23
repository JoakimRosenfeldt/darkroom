import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCatalogWorkerTestClient,
  CatalogWorkerRequestError,
  CatalogWorkerTimeoutError,
  type CatalogWorkerClient,
} from "../electron/catalog-worker-client.ts";
import {
  parseCatalogWorkerRequest,
  parseCatalogWorkerResponse,
} from "../electron/catalog-worker-protocol.ts";
import {
  createCatalogId,
  createAssetId,
  createOperationId,
  createRootId,
} from "../lib/catalog/ids.ts";
import { CATALOG_V3_APPLICATION_ID } from "../lib/catalog/v3.ts";
import {
  createCatalogRegistryStore,
  parseCatalogRegistry,
} from "../electron/catalog-registry.ts";
import {
  CATALOG_FAULT_STAGES,
  createNoopCatalogFaultInjector,
} from "../electron/catalog-fault-injection.ts";
import { runAllTracerRecoveries } from "./catalog-worker-harness.mts";

function workerOptions(): { workerPath: string; execArgv?: readonly string[] } {
  return {
    workerPath: path.resolve("electron/catalog-worker.ts"),
    execArgv: ["--no-warnings", "--experimental-strip-types"],
  };
}

function workerClient(requestTimeoutMs = 5_000) {
  return createCatalogWorkerTestClient({ ...workerOptions(), requestTimeoutMs });
}

test("catalog worker owns the SQLite lifecycle and online backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-worker-test-"));
  let client: CatalogWorkerClient | undefined;
  try {
    const databasePath = path.join(root, "catalog.db");
    const backupPath = path.join(root, "backup", "catalog.db");
    client = workerClient();
    const runtime = await client.runtimeInfo();
    assert.match(runtime.nodeVersion, /^24\./);
    assert.notEqual(runtime.sqliteVersion, "unknown");
    const opened = await client.open(databasePath);
    assert.equal(opened.created, true);
    const probe = await client.transactionProbe();
    assert.deepEqual(
      { committed: probe.committed, rowCount: probe.rowCount },
      { committed: true, rowCount: 1 },
    );
    const integrity = await client.integrityCheck();
    assert.deepEqual(integrity.integrityCheck, ["ok"]);
    assert.deepEqual(integrity.foreignKeyCheck, []);
    const backup = await client.backup(backupPath);
    assert.equal(backup.destinationPath, path.normalize(path.resolve(backupPath)));
    assert.ok((await readFile(backupPath)).byteLength > 0);
    await assert.rejects(
      client.runTestTracer({
        operationId: createOperationId(),
        itemId: createAssetId(),
        sourcePath: path.join(root, "source.bin"),
        destinationPath: path.join(root, "destination.bin"),
      }),
      (error: unknown) =>
        error instanceof CatalogWorkerRequestError && error.code === "test-disabled",
    );
    assert.equal((await client.close()).wasOpen, true);
    await client.shutdown();
  } finally {
    await client?.forceTerminate().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("worker protocol rejects unknown request and response shapes", () => {
  assert.throws(() => parseCatalogWorkerRequest(null));
  assert.throws(() => parseCatalogWorkerRequest({ kind: "not-a-request", requestId: "x" }));
  assert.throws(() => parseCatalogWorkerRequest({ kind: "open", requestId: "x", databasePath: "relative.db" }));
  assert.throws(() => parseCatalogWorkerResponse({ kind: "not-a-response", requestId: "x" }));
  assert.throws(() => parseCatalogWorkerResponse({ kind: "error", requestId: null, code: "wat", message: "no" }));
  const catalogId = createCatalogId();
  const migrationId = createOperationId();
  assert.throws(() => parseCatalogWorkerResponse({
    kind: "v3-assets",
    requestId: "request",
    result: {
      catalogId,
      migrationId,
      revision: 0,
      assets: [null],
    },
  }));
  assert.throws(() => parseCatalogWorkerResponse({
    kind: "v3-assets-page",
    requestId: "request",
    result: {
      catalogId,
      revision: 0,
      assets: [null],
      nextCursor: null,
    },
  }));

  const expectedCounts = {
    assets: 1,
    metadata: 1,
    albums: 0,
    albumAssets: 0,
    archived: 0,
    aliases: 1,
    fingerprints: 1,
    present: 0,
    missing: 1,
  };
  const cleanReport = {
    catalogId,
    migrationId,
    clean: true,
    before: expectedCounts,
    after: { ...expectedCounts, ambiguous: 0, unreadable: 0 },
    fingerprintCoverage: { total: 1, missing: 1, hashing: 0, valid: 0, stale: 0, failed: 0 },
    expectedStateSha256: "a".repeat(64),
    actualStateSha256: "a".repeat(64),
    relationFailures: { aliases: 0, albums: 0, albumAssets: 0, archived: 0 },
    integrity: { integrityCheck: ["ok"], foreignKeyCheck: [] },
    applicationId: CATALOG_V3_APPLICATION_ID,
    schemaVersion: 3,
    userVersion: 3,
    limitations: ["No asset has a proven digest; duplicate readiness is unavailable."],
    blockingErrors: [],
  };
  const contradictoryReports = [
    { ...cleanReport, actualStateSha256: "b".repeat(64) },
    {
      ...cleanReport,
      fingerprintCoverage: { total: 1, missing: 0, hashing: 1, valid: 0, stale: 0, failed: 0 },
    },
    { ...cleanReport, blockingErrors: ["contradiction"] },
  ];
  for (const report of contradictoryReports) {
    assert.throws(() => parseCatalogWorkerResponse({
      kind: "v3-validate",
      requestId: "request",
      result: { catalogId, migrationId, phase: "validated", report, revision: 0 },
    }));
  }

  const asset = {
    catalogId,
    assetId: createAssetId(),
    rootId: createRootId(),
    relativePath: "asset.jpg",
    observation: { byteLength: 1, modifiedAt: 2, observedAt: 3, localFileId: null },
    revision: 1,
    health: "missing",
    formatId: "jpeg",
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    fingerprintId: createAssetId(),
    fingerprintStatus: "missing",
    fingerprintSha256: null,
    fingerprintObservedAt: 3,
    fingerprintObservedByteLength: 1,
    fingerprintObservedModifiedAt: 2,
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
      rawXmp: null,
      xmpState: "unknown",
      xmpMtime: null,
      xmpSha256: null,
    },
  };
  assert.throws(() => parseCatalogWorkerResponse({
    kind: "v3-assets-page",
    requestId: "request",
    result: { catalogId, revision: 1, assets: [asset], nextCursor: null },
  }));

  const album = (id: string, position: number) => ({
    catalogId,
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    position,
  });
  assert.throws(() => parseCatalogWorkerResponse({
    kind: "v3-albums",
    requestId: "request",
    result: {
      catalogId,
      revision: 1,
      albums: [album("first", 0), album("second", 2)],
      nextCursor: null,
    },
  }));
  assert.throws(() => parseCatalogWorkerResponse({
    kind: "v3-album-assets-page",
    requestId: "request",
    result: {
      catalogId,
      albumId: "album",
      revision: 1,
      assets: [{
        position: 0,
        assetId: asset.assetId,
        rootId: asset.rootId,
        relativePath: "../escape.jpg",
        health: "missing",
        revision: 1,
      }],
      nextCursor: null,
    },
  }));
});

test("catalog worker client rejects valid v3 responses with mismatched identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-worker-identity-test-"));
  let client: CatalogWorkerClient | undefined;
  try {
    const fakeWorkerPath = path.join(root, "mismatched-worker.mjs");
    await writeFile(fakeWorkerPath, `
      import { parentPort } from "node:worker_threads";
      const wrongCatalogId = "00000000-0000-4000-8000-000000000001";
      const wrongMigrationId = "00000000-0000-4000-8000-000000000002";
      const rootId = "00000000-0000-4000-8000-000000000003";
      const rootPath = ${JSON.stringify(root)};
      const zeroCounts = {
        assets: 0, metadata: 0, albums: 0, albumAssets: 0, archived: 0,
        aliases: 0, fingerprints: 0, present: 0, missing: 0,
      };
      const counts = { ...zeroCounts, ambiguous: 0, unreadable: 0 };
      const fingerprintCoverage = { total: 0, missing: 0, hashing: 0, valid: 0, stale: 0, failed: 0 };
      const migration = {
        migrationId: wrongMigrationId,
        sourceVersion: 2,
        catalogPath: ${JSON.stringify(path.join(root, "legacy.json"))},
        settingsPath: null,
        catalogSha256: "a".repeat(64),
        settingsSha256: null,
        rootAvailable: true,
        expectedCounts: zeroCounts,
        expectedStateSha256: "b".repeat(64),
      };
      const validationReport = {
        catalogId: wrongCatalogId,
        migrationId: wrongMigrationId,
        clean: true,
        before: zeroCounts,
        after: counts,
        fingerprintCoverage,
        expectedStateSha256: "b".repeat(64),
        actualStateSha256: "b".repeat(64),
        relationFailures: { aliases: 0, albums: 0, albumAssets: 0, archived: 0 },
        integrity: { integrityCheck: ["ok"], foreignKeyCheck: [] },
        applicationId: 1146243891,
        schemaVersion: 3,
        userVersion: 3,
        limitations: [],
        blockingErrors: [],
      };
      parentPort.on("message", (request) => {
        let result;
        if (request.kind === "v3-install") {
          result = { catalogId: wrongCatalogId, migrationId: request.input.migration.migrationId,
            created: true, installState: "staging", revision: 0, schemaVersion: 3 };
        } else if (request.kind === "v3-assets") {
          result = { catalogId: request.input.catalogId, migrationId: wrongMigrationId, revision: 0, assets: [] };
        } else if (request.kind === "v3-relations") {
          result = { catalogId: request.input.catalogId, migrationId: wrongMigrationId, revision: 0,
            albums: 0, albumAssets: 0, archived: 0 };
        } else if (request.kind === "v3-finish-copy") {
          result = { catalogId: request.catalogId, migrationId: wrongMigrationId, phase: "copied", revision: 0 };
        } else if (request.kind === "v3-validate") {
          result = { catalogId: wrongCatalogId, migrationId: wrongMigrationId, phase: "validated",
            report: validationReport, revision: 0 };
        } else if (request.kind === "v3-prepare-activation") {
          result = { catalogId: request.catalogId, migrationId: wrongMigrationId,
            installState: "ready", revision: 0 };
        } else if (request.kind === "v3-seal-for-install") {
          result = { catalogId: request.catalogId, migrationId: wrongMigrationId, busy: 0,
            logFrames: 0, checkpointedFrames: 0, journalMode: "delete" };
        } else if (request.kind === "v3-summary") {
          result = {
            catalogId: wrongCatalogId,
            displayName: "Wrong",
            appVersion: "test",
            installState: "ready",
            revision: 0,
            migrationId: wrongMigrationId,
            migrationPhase: "validated",
            sourceVersion: 2,
            migration,
            root: { rootId, label: "Root", configuredPath: rootPath, canonicalPath: rootPath,
              health: "online", scanState: "complete", watchState: "disabled" },
            counts,
            fingerprintCoverage,
          };
        } else if (request.kind === "v3-assets-page") {
          result = request.input.limit === 2
            ? { catalogId: request.input.catalogId, revision: 8, assets: [], nextCursor: null }
            : { catalogId: wrongCatalogId, revision: 0, assets: [], nextCursor: null };
        } else if (request.kind === "v3-albums") {
          if (request.input.limit === 2) {
            result = { catalogId: request.input.catalogId, revision: 8, albums: [], nextCursor: null };
          } else if (request.input.limit === 3) {
            result = { catalogId: request.input.catalogId, revision: 0, albums: [{
              catalogId: request.input.catalogId, id: "album", name: "Album",
              createdAt: 0, updatedAt: 0, position: 2,
            }], nextCursor: null };
          } else {
            result = { catalogId: wrongCatalogId, revision: 0, albums: [], nextCursor: null };
          }
        } else if (request.kind === "v3-album-assets-page") {
          if (request.input.limit === 2) {
            result = { catalogId: request.input.catalogId, albumId: request.input.albumId,
              revision: 8, assets: [], nextCursor: null };
          } else if (request.input.limit === 3) {
            result = { catalogId: request.input.catalogId, albumId: request.input.albumId,
              revision: 0, assets: [{ position: 2, assetId: wrongCatalogId, rootId,
                relativePath: "asset.jpg", health: "missing", revision: 0 }], nextCursor: null };
          } else {
            result = { catalogId: request.input.catalogId, albumId: "wrong", revision: 0,
              assets: [], nextCursor: null };
          }
        }
        if (result) parentPort.postMessage({ kind: request.kind, requestId: request.requestId, result });
      });
    `);
    client = createCatalogWorkerTestClient({
      workerPath: fakeWorkerPath,
      requestTimeoutMs: 1_000,
    });
    const catalogId = createCatalogId();
    const migrationId = createOperationId();
    const input = {
      catalogId,
      displayName: "Identity test",
      appVersion: "test",
      root: {
        rootId: createRootId(),
        label: "Identity root",
        configuredPath: root,
        canonicalPath: root,
        health: "online" as const,
        scanState: "complete" as const,
        watchState: "disabled" as const,
      },
      migration: {
        migrationId,
        sourceVersion: 2 as const,
        catalogPath: path.join(root, "legacy.json"),
        settingsPath: null,
        catalogSha256: "a".repeat(64),
        settingsSha256: null,
        rootAvailable: true,
        expectedCounts: {
          assets: 0,
          metadata: 0,
          albums: 0,
          albumAssets: 0,
          archived: 0,
          aliases: 0,
          fingerprints: 0,
          present: 0,
          missing: 0,
        },
        expectedStateSha256: "b".repeat(64),
      },
    };
    const mismatches: readonly [string, () => Promise<unknown>, RegExp][] = [
      ["install", () => client!.installV3(input), /mismatched catalogId/],
      ["assets", () => client!.writeV3AssetBatch({ catalogId, migrationId, assets: [] }), /mismatched migrationId/],
      ["relations", () => client!.writeV3RelationsBatch({ catalogId, migrationId, albums: [], archiveLegacyIds: [] }), /mismatched migrationId/],
      ["finish", () => client!.finishV3Copy(catalogId, migrationId), /mismatched migrationId/],
      ["validate", () => client!.validateV3(catalogId, migrationId), /mismatched catalogId/],
      ["prepare", () => client!.prepareV3Activation(catalogId, migrationId), /mismatched migrationId/],
      ["seal", () => client!.sealV3ForInstall(catalogId, migrationId), /mismatched migrationId/],
      ["summary", () => client!.v3Summary(catalogId), /mismatched catalogId/],
      ["asset page", () => client!.v3AssetsPage({ catalogId, expectedRevision: null, cursor: null, limit: 1 }), /mismatched catalogId/],
      ["asset page revision", () => client!.v3AssetsPage({
        catalogId,
        expectedRevision: 7,
        cursor: null,
        limit: 2,
      }), /mismatched revision/],
      ["albums", () => client!.v3Albums({ catalogId, expectedRevision: null, cursor: null, limit: 1 }), /mismatched catalogId/],
      ["album revision", () => client!.v3Albums({
        catalogId,
        expectedRevision: 7,
        cursor: null,
        limit: 2,
      }), /mismatched revision/],
      ["album cursor", () => client!.v3Albums({
        catalogId,
        expectedRevision: null,
        cursor: 0,
        limit: 3,
      }), /mismatched cursor/],
      ["album assets", () => client!.v3AlbumAssetsPage({
        catalogId,
        albumId: "album",
        expectedRevision: null,
        cursor: null,
        limit: 1,
      }), /mismatched albumId/],
      ["album asset revision", () => client!.v3AlbumAssetsPage({
        catalogId,
        albumId: "album",
        expectedRevision: 7,
        cursor: null,
        limit: 2,
      }), /mismatched revision/],
      ["album asset cursor", () => client!.v3AlbumAssetsPage({
        catalogId,
        albumId: "album",
        expectedRevision: null,
        cursor: 0,
        limit: 3,
      }), /mismatched cursor/],
    ];
    for (const [label, operation, error] of mismatches) {
      await assert.rejects(operation(), error, label);
    }
  } finally {
    await client?.forceTerminate().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog registry validates persisted data and serializes atomic writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-registry-test-"));
  try {
    const store = createCatalogRegistryStore(root);
    const concurrentStore = createCatalogRegistryStore(root);
    const first = {
      catalogId: createCatalogId(),
      displayName: "First",
      databasePath: path.join(root, "first.db"),
      health: "healthy" as const,
      lastOpenedAt: Date.now(),
    };
    const second = {
      catalogId: createCatalogId(),
      displayName: "Second",
      databasePath: path.join(root, "second.db"),
      health: "degraded" as const,
      lastOpenedAt: Date.now(),
    };
    await Promise.all([store.upsert(first), concurrentStore.upsert(second)]);
    const document = await store.read();
    assert.equal(document.version, 1);
    assert.deepEqual(
      document.catalogs.map((catalog) => catalog.catalogId),
      [first.catalogId, second.catalogId],
    );
    assert.equal(document.catalogs[0]?.databasePath.startsWith(await realpath(root)), true);
    const names = await readdir(root);
    assert.equal(names.some((name) => name.endsWith(".tmp")), false);
    await writeFile(store.filePath, JSON.stringify({ version: 1, catalogs: [{ nope: true }] }));
    await assert.rejects(store.read());
    assert.throws(() => parseCatalogRegistry({ version: 1, catalogs: [{ nope: true }] }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request timeout removes pending work and clean shutdown is bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-timeout-test-"));
  const database = new DatabaseSync(path.join(root, "locked.db"));
  let client: CatalogWorkerClient | undefined;
  let transactionStarted = false;
  try {
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE lock_probe (value TEXT);");
    client = workerClient(500);
    await client.open(path.join(root, "locked.db"));
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    await assert.rejects(client.transactionProbe(20), CatalogWorkerTimeoutError);
  } finally {
    await client?.forceTerminate().catch(() => undefined);
    try {
      if (transactionStarted) {
        database.exec("ROLLBACK;");
      }
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  const cleanClient = workerClient();
  try {
    await cleanClient.runtimeInfo();
    await cleanClient.shutdown(1_000);
    await assert.rejects(cleanClient.runtimeInfo());
  } finally {
    await cleanClient.forceTerminate().catch(() => undefined);
  }
});

test("production fault boundary is a no-op and tracer recovery is idempotent", async () => {
  const injector = createNoopCatalogFaultInjector();
  injector.afterStage({
    operationId: createOperationId(),
    itemId: createAssetId(),
    stage: "planned",
  });
  const reports = await runAllTracerRecoveries();
  assert.deepEqual(
    reports.map((report) => report.injectedStage),
    [...CATALOG_FAULT_STAGES],
  );
  for (const report of reports) {
    assert.equal(report.catalogRowCount, 1);
    assert.equal(report.terminalStage, "source-cleaned");
  }
});
