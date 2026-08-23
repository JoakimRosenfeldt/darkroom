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
} from "../lib/catalog/ids.ts";
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
});

test("catalog registry validates persisted data and serializes atomic writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-registry-test-"));
  try {
    const store = createCatalogRegistryStore(root);
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
    await Promise.all([store.upsert(first), store.upsert(second)]);
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
