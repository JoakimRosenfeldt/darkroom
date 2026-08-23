import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCatalogId, createRootId, parseCatalogId, type CatalogId } from "../lib/catalog/ids.ts";
import { installCatalogV3Schema, CATALOG_V3_TABLES } from "../electron/catalog-v3-schema.ts";
import {
  CatalogAdminService,
  FileCatalogBackupPolicyStore,
  inspectCatalogDatabaseReadOnly,
  type CatalogAdminPathPort,
  type CatalogAdminMaintenancePort,
  type CatalogAdminWorkerPort,
} from "../electron/catalog-admin-service.ts";
import { CatalogWorkerClient } from "../electron/catalog-worker-client.ts";
import { validateCatalogPackage, writeCatalogPackage } from "../electron/catalog-package-service.ts";
import type { RestoreAdapter, RestoreEnvelope } from "../electron/catalog-package-service.ts";

interface Fixture {
  readonly directory: string;
  readonly databasePath: string;
  readonly catalogId: CatalogId;
  readonly rootId: ReturnType<typeof createRootId>;
}

async function makeFixture(): Promise<Fixture> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-admin-"));
  const databasePath = path.join(directory, "catalog.sqlite");
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const assetId = randomUUID();
  const albumId = randomUUID();
  const presetId = randomUUID();
  const ruleId = randomUUID();
  const operationId = randomUUID();
  const rootPath = path.join(directory, "photos");
  const database = new DatabaseSync(databasePath);
  installCatalogV3Schema(database);
  database.prepare(`
    INSERT INTO catalog_meta (
      catalog_id, display_name, schema_version, app_version, install_state,
      revision, created_at, updated_at
    ) VALUES (?, 'Test catalog', 3, 'test', 'ready', 1, 1, 1)
  `).run(catalogId);
  database.prepare(`
    INSERT INTO roots (
      catalog_id, root_id, label, configured_path, canonical_path,
      health, scan_state, watch_state, revision
    ) VALUES (?, ?, 'Photos', ?, NULL, 'missing', 'complete', 'disabled', 1)
  `).run(catalogId, rootId, rootPath);
  database.prepare(`
    INSERT INTO assets (
      catalog_id, asset_id, root_id, relative_path, observed_byte_length,
      observed_modified_at, observed_at, local_file_id, revision, health,
      format_id, camera_make, camera_model, lens_model
    ) VALUES (?, ?, ?, 'one.jpg', NULL, NULL, NULL, NULL, 1, 'missing', 'jpeg', NULL, NULL, NULL)
  `).run(catalogId, assetId, rootId);
  database.prepare(`
    INSERT INTO asset_metadata (
      catalog_id, asset_id, archive, pick, rating, color_label, develop_json,
      develop_updated_at, updated_at, title, caption, copyright, keywords_json,
      raw_xmp, xmp_state, xmp_mtime, xmp_sha256
    ) VALUES (?, ?, 1, 'pick', 3, NULL, NULL, 1, 1, 'One', NULL, NULL, '[]', NULL, 'absent', NULL, NULL)
  `).run(catalogId, assetId);
  database.prepare(`
    INSERT INTO albums (catalog_id, album_id, name, created_at, updated_at, position)
    VALUES (?, ?, 'Album', 1, 1, 0)
  `).run(catalogId, albumId);
  database.prepare(`
    INSERT INTO album_assets (catalog_id, album_id, asset_id, position)
    VALUES (?, ?, ?, 0)
  `).run(catalogId, albumId, assetId);
  database.prepare(`
    INSERT INTO fingerprints (
      catalog_id, fingerprint_id, asset_id, status, sha256,
      observed_at, observed_byte_length, observed_modified_at, local_file_id, updated_at
    ) VALUES (?, ?, ?, 'missing', NULL, NULL, NULL, NULL, NULL, 1)
  `).run(catalogId, randomUUID(), assetId);
  database.prepare(`
    INSERT INTO import_presets (catalog_id, preset_id, name, payload_json, revision, created_at, updated_at)
    VALUES (?, ?, 'Preset', '{}', 1, 1, 1)
  `).run(catalogId, presetId);
  database.prepare(`
    INSERT INTO auto_import_rules (
      catalog_id, rule_id, name, enabled, destination_root_id, preset_id,
      config_json, revision, created_at, updated_at
    ) VALUES (?, ?, 'Rule', 1, ?, ?, '{}', 1, 1, 1)
  `).run(catalogId, ruleId, rootId, presetId);
  database.prepare(`
    INSERT INTO operations (
      catalog_id, operation_id, kind, state, payload_json, revision, created_at, updated_at
    ) VALUES (?, ?, 'test', 'completed', '{}', 1, 1, 1)
  `).run(catalogId, operationId);
  database.prepare(`
    INSERT INTO operation_items (
      catalog_id, operation_id, item_id, asset_id, state, payload_json
    ) VALUES (?, ?, 'one', ?, 'completed', '{}')
  `).run(catalogId, operationId, assetId);
  database.prepare(`
    INSERT INTO audit_log (catalog_id, migration_id, event, payload_json, created_at)
    VALUES (?, NULL, 'test', '{}', 1)
  `).run(catalogId);
  database.close();
  return { directory, databasePath, catalogId, rootId };
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await fsp.rm(fixture.directory, { recursive: true, force: true });
}

function ports(fixture: Fixture, options: { readonly failBackup?: boolean } = {}): {
  readonly worker: CatalogAdminWorkerPort;
  readonly paths: CatalogAdminPathPort;
} {
  const worker: CatalogAdminWorkerPort = {
    async backup(destinationPath): Promise<{ readonly pages: number }> {
      if (options.failBackup) throw new Error("injected backup failure");
      await fsp.copyFile(fixture.databasePath, destinationPath);
      return { pages: 1 };
    },
    async vacuumInto(destinationPath) {
      await fsp.copyFile(fixture.databasePath, destinationPath);
      const stat = await fsp.stat(destinationPath);
      return { kind: "vacuum-into", requestId: randomUUID(), destinationPath, byteLength: stat.size };
    },
    async cloneCatalog(input) {
      await fsp.copyFile(input.sourcePath, input.destinationPath);
      const database = new DatabaseSync(input.destinationPath);
      try {
        const source = parseCatalogId(String(database.prepare("SELECT catalog_id FROM catalog_meta").get()?.catalog_id));
        database.exec("PRAGMA foreign_keys=ON; PRAGMA defer_foreign_keys=ON; BEGIN IMMEDIATE;");
        database.prepare("UPDATE catalog_meta SET catalog_id = ?, display_name = ?, app_version = ? WHERE catalog_id = ?")
          .run(input.catalogId, input.displayName, input.appVersion, source);
        for (const table of CATALOG_V3_TABLES) {
          if (table === "catalog_meta") continue;
          database.prepare(`UPDATE ${table} SET catalog_id = ? WHERE catalog_id = ?`).run(input.catalogId, source);
        }
        database.exec("COMMIT;");
        const rootCount = Number(database.prepare("SELECT COUNT(*) AS count FROM roots WHERE catalog_id = ?").get(input.catalogId)?.count);
        const assetCount = Number(database.prepare("SELECT COUNT(*) AS count FROM assets WHERE catalog_id = ?").get(input.catalogId)?.count);
        return { kind: "clone-catalog", requestId: randomUUID(), sourceCatalogId: source, catalogId: input.catalogId, rootCount, assetCount };
      } finally {
        database.close();
      }
    },
  };
  const paths: CatalogAdminPathPort = {
    async databasePath(catalogId) {
      return catalogId === fixture.catalogId ? fixture.databasePath : path.join(fixture.directory, `${catalogId}.sqlite`);
    },
    async backupDirectory(catalogId) {
      return path.join(fixture.directory, "backups", catalogId);
    },
    async temporaryDirectory(catalogId) {
      return path.join(fixture.directory, "temporary", catalogId);
    },
  };
  return { worker, paths };
}

function noopRestoreAdapter(): RestoreAdapter {
  return {
    async targetSha256() { return "a".repeat(64); },
    async makeSafetyBackup() { return { sha256: "b".repeat(64) }; },
    async restoreToTemp() { return undefined; },
    async applyForwardFact() { return "linked"; },
    async validateTemp() { return undefined; },
    async swapIntoPlace() { return undefined; },
    async reopenAndReconcile() { return []; },
    async rollback() { return undefined; },
  };
}

test("read-only inspection reports v3 data without changing source bytes or mtime", async () => {
  const fixture = await makeFixture();
  try {
    const before = await fsp.readFile(fixture.databasePath);
    const beforeStat = await fsp.stat(fixture.databasePath);
    const report = await inspectCatalogDatabaseReadOnly(fixture.databasePath);
    const after = await fsp.readFile(fixture.databasePath);
    const afterStat = await fsp.stat(fixture.databasePath);
    assert.equal(report.clean, true, report.blockingErrors.join("; "));
    assert.equal(report.catalogId, fixture.catalogId);
    assert.equal(report.roots.length, 1);
    assert.equal(report.counts.assets, 1);
    assert.deepEqual(after, before);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  } finally {
    await removeFixture(fixture);
  }
});

test("backup failure does not publish a package", async () => {
  const fixture = await makeFixture();
  try {
    const service = new CatalogAdminService({ ...ports(fixture, { failBackup: true }), appVersion: "test" });
    await assert.rejects(service.backup(fixture.catalogId));
    const backupDirectory = path.join(fixture.directory, "backups", fixture.catalogId);
    const entries = await fsp.readdir(backupDirectory);
    assert.equal(entries.some((entry) => entry.startsWith("backup-")), false);
  } finally {
    await removeFixture(fixture);
  }
});

test("package export and clone use a fresh catalog identity", async () => {
  const fixture = await makeFixture();
  try {
    const service = new CatalogAdminService({ ...ports(fixture), appVersion: "test" });
    const backup = await service.backup(fixture.catalogId);
    const backupDirectory = path.join(fixture.directory, "backups", fixture.catalogId);
    const entries = await fsp.readdir(backupDirectory);
    assert.equal(entries.length, 1);
    const packageDirectory = path.join(backupDirectory, entries[0]);
    assert.equal((await validateCatalogPackage(packageDirectory)).catalogId, fixture.catalogId);
    const sourceBefore = createHash("sha256").update(await fsp.readFile(fixture.databasePath)).digest("hex");
    const clone = await service.cloneAsNew(packageDirectory, "Cloned");
    assert.notEqual(clone.catalogId, fixture.catalogId);
    assert.equal(clone.rootCount, 1);
    assert.equal(clone.assetCount, 1);
    assert.equal(backup.catalogId, fixture.catalogId);
    const sourceAfter = createHash("sha256").update(await fsp.readFile(fixture.databasePath)).digest("hex");
    assert.equal(sourceAfter, sourceBefore);
  } finally {
    await removeFixture(fixture);
  }
});

test("backup policy persists and scheduled backups honor due state", async () => {
  const fixture = await makeFixture();
  try {
    const policyPath = path.join(fixture.directory, "settings", "backup-policy.json");
    const store = new FileCatalogBackupPolicyStore(policyPath);
    let now = 10_000;
    const service = new CatalogAdminService({ ...ports(fixture), appVersion: "test", policyStore: store, now: () => now });
    await service.setBackupPolicy(fixture.catalogId, { schedule: { kind: "interval", intervalMs: 60_000 }, retentionCount: 1 });
    assert.equal(await service.runScheduledBackup(fixture.catalogId) !== null, true);
    assert.equal(await service.runScheduledBackup(fixture.catalogId), null);
    now += 60_001;
    assert.equal(await service.runScheduledBackup(fixture.catalogId) !== null, true);
    const state = await store.read(fixture.catalogId);
    assert.equal(state?.lastSuccessAt, now);
  } finally {
    await removeFixture(fixture);
  }
});

test("manifest root mismatch is rejected before clone", async () => {
  const fixture = await makeFixture();
  try {
    const badPackage = path.join(fixture.directory, "bad-package");
    await writeCatalogPackage({
      targetDirectory: badPackage,
      catalogId: fixture.catalogId,
      appVersion: "test",
      roots: [{ rootId: fixture.rootId, label: "Wrong", configuredPath: path.join(fixture.directory, "other") }],
      payloads: [{ name: "catalog.sqlite", sourcePath: fixture.databasePath }],
      backupAndValidate: async () => undefined,
    });
    const service = new CatalogAdminService({ ...ports(fixture), appVersion: "test" });
    await assert.rejects(service.cloneAsNew(badPackage, "Cloned"), /root mapping|database/i);
  } finally {
    await removeFixture(fixture);
  }
});

test("worker vacuum and clone commands validate the cloned catalog", async () => {
  const fixture = await makeFixture();
  const worker = CatalogWorkerClient.createForTests({
    workerPath: path.resolve("electron/catalog-worker.ts"),
    execArgv: ["--no-warnings", "--experimental-strip-types"],
  });
  try {
    await worker.open(fixture.databasePath);
    const compactPath = path.join(fixture.directory, "compact.sqlite");
    const compact = await worker.vacuumInto(compactPath);
    assert.equal(compact.byteLength > 0, true);
    const cloneId = createCatalogId();
    const clonePath = path.join(fixture.directory, "clone.sqlite");
    const clone = await worker.cloneCatalog({
      sourcePath: fixture.databasePath,
      destinationPath: clonePath,
      catalogId: cloneId,
      displayName: "Clone",
      appVersion: "test",
    });
    assert.equal(clone.sourceCatalogId, fixture.catalogId);
    assert.equal(clone.catalogId, cloneId);
    const report = await inspectCatalogDatabaseReadOnly(clonePath);
    assert.equal(report.clean, true, report.blockingErrors.join("; "));
    assert.equal(report.catalogId, cloneId);
  } finally {
    await worker.shutdown().catch(() => undefined);
    await removeFixture(fixture);
  }
});

test("imported clones keep root labels and configured paths but have no native authority", async () => {
  const fixture = await makeFixture();
  const victimPath = path.join(fixture.directory, "victim-photos");
  const worker = CatalogWorkerClient.createForTests({
    workerPath: path.resolve("electron/catalog-worker.ts"),
    execArgv: ["--no-warnings", "--experimental-strip-types"],
  });
  try {
    await fsp.mkdir(victimPath);
    const source = new DatabaseSync(fixture.databasePath);
    source.prepare("UPDATE roots SET configured_path = ?, canonical_path = ?, health = 'online', watch_state = 'active' WHERE catalog_id = ?")
      .run(victimPath, victimPath, fixture.catalogId);
    source.close();

    const packageDirectory = path.join(fixture.directory, "package");
    await writeCatalogPackage({
      targetDirectory: packageDirectory,
      catalogId: fixture.catalogId,
      appVersion: "test",
      roots: [{ rootId: fixture.rootId, label: "Photos", configuredPath: victimPath }],
      payloads: [{ name: "catalog.sqlite", sourcePath: fixture.databasePath }],
      backupAndValidate: async () => undefined,
    });
    const service = new CatalogAdminService({
      worker,
      paths: ports(fixture).paths,
      appVersion: "test",
    });
    const clone = await service.cloneAsNew(packageDirectory, "Imported");
    const clonePath = path.join(fixture.directory, `${clone.catalogId}.sqlite`);
    const database = new DatabaseSync(clonePath);
    try {
      const root = database.prepare("SELECT label, configured_path AS configuredPath, canonical_path AS canonicalPath, health, scan_state AS scanState, watch_state AS watchState FROM roots WHERE catalog_id = ?")
        .get(clone.catalogId) as { label: string; configuredPath: string; canonicalPath: string | null; health: string; scanState: string; watchState: string };
      const rule = database.prepare("SELECT enabled FROM auto_import_rules WHERE catalog_id = ?")
        .get(clone.catalogId) as { enabled: number };
      assert.equal(root.label, "Photos");
      assert.equal(root.configuredPath, victimPath);
      assert.equal(root.canonicalPath, null);
      assert.equal(root.health, "missing");
      assert.equal(root.scanState, "unknown");
      assert.equal(root.watchState, "disabled");
      assert.equal(rule.enabled, 0);
    } finally {
      database.close();
    }
  } finally {
    await worker.shutdown().catch(() => undefined);
    await removeFixture(fixture);
  }
});

test("inspection reports schema and location corruption without mutating the source", async () => {
  const fixture = await makeFixture();
  try {
    const corruptPath = path.join(fixture.directory, "corrupt.sqlite");
    await fsp.copyFile(fixture.databasePath, corruptPath);
    const database = new DatabaseSync(corruptPath);
    database.exec("PRAGMA user_version = 2;");
    database.close();
    const schemaReport = await inspectCatalogDatabaseReadOnly(corruptPath);
    assert.equal(schemaReport.clean, false);
    assert.equal(schemaReport.schemaVersion, null);

    const locationPath = path.join(fixture.directory, "location.sqlite");
    await fsp.copyFile(fixture.databasePath, locationPath);
    const locationDatabase = new DatabaseSync(locationPath);
    locationDatabase.prepare("UPDATE roots SET configured_path = 'relative/path' WHERE catalog_id = ?").run(fixture.catalogId);
    locationDatabase.close();
    const locationReport = await inspectCatalogDatabaseReadOnly(locationPath);
    assert.equal(locationReport.clean, false);
    assert.equal(locationReport.blockingErrors.some((error) => error.includes("location")), true);
  } finally {
    await removeFixture(fixture);
  }
});

test("optimization validates a temporary database before swap", async () => {
  const fixture = await makeFixture();
  try {
    const base = ports(fixture);
    const failingWorker: CatalogAdminWorkerPort = {
      ...base.worker,
      async vacuumInto(destinationPath) {
        await fsp.writeFile(destinationPath, "not a sqlite database", "utf8");
        return { kind: "vacuum-into", requestId: randomUUID(), destinationPath, byteLength: 20 };
      },
    };
    const maintenance: CatalogAdminMaintenancePort = {
      async quiesce() { return { forwardFacts: [], adapter: noopRestoreAdapter() }; },
      async resume() { return undefined; },
      async swapOptimized() { throw new Error("swap should not run"); },
    };
    const failing = new CatalogAdminService({ paths: base.paths, worker: failingWorker, maintenance, appVersion: "test" });
    const sourceBefore = await fsp.readFile(fixture.databasePath);
    await assert.rejects(failing.optimize(fixture.catalogId), /optimization|validation/i);
    assert.deepEqual(await fsp.readFile(fixture.databasePath), sourceBefore);

    const successfulMaintenance: CatalogAdminMaintenancePort = {
      async quiesce() { return { forwardFacts: [], adapter: noopRestoreAdapter() }; },
      async resume() { return undefined; },
      async swapOptimized(input) { await fsp.copyFile(input.temporaryPath, input.sourcePath); },
    };
    const successful = new CatalogAdminService({ paths: base.paths, worker: base.worker, maintenance: successfulMaintenance, appVersion: "test" });
    const result = await successful.optimize(fixture.catalogId);
    assert.equal(result.catalogId, fixture.catalogId);
    assert.equal(result.compactByteLength > 0, true);
  } finally {
    await removeFixture(fixture);
  }
});

test("restore quiesces first and keeps unresolved forward facts in its envelope", async () => {
  const fixture = await makeFixture();
  try {
    const base = ports(fixture);
    const service = new CatalogAdminService({ ...base, appVersion: "test" });
    const backup = await service.backup(fixture.catalogId);
    const backupDirectory = path.join(fixture.directory, "backups", fixture.catalogId);
    const packageDirectory = path.join(backupDirectory, (await fsp.readdir(backupDirectory))[0]);
    const targetCatalogId = createCatalogId();
    const events: string[] = [];
    let reconcileCount = 0;
    const adapter: RestoreAdapter = {
      async targetSha256() { events.push("target"); return "a".repeat(64); },
      async makeSafetyBackup() { events.push("safety"); return { sha256: "b".repeat(64) }; },
      async restoreToTemp() { events.push("restore"); },
      async applyForwardFact() { events.push("fact"); return "linked"; },
      async validateTemp() { events.push("validate"); },
      async swapIntoPlace() { events.push("swap"); },
      async reopenAndReconcile() {
        events.push("reconcile");
        reconcileCount += 1;
        return reconcileCount === 1 ? ["fact-1"] : [];
      },
      async resolveForwardFact() { events.push("resolve"); return "linked"; },
      async rollback() { events.push("rollback"); },
    };
    const maintenanceEvents: string[] = [];
    const maintenance: CatalogAdminMaintenancePort = {
      async quiesce() { maintenanceEvents.push("quiesce"); return { forwardFacts: [], adapter }; },
      async resume() { maintenanceEvents.push("resume"); },
      async swapOptimized() { throw new Error("not used"); },
    };
    const envelopeStore: { value: RestoreEnvelope | null } = { value: null };
    const envelopes = {
      async read() { return envelopeStore.value; },
      async write(value: RestoreEnvelope) { envelopeStore.value = value; },
      async remove() { envelopeStore.value = null; },
    };
    const restoring = new CatalogAdminService({ ...base, appVersion: "test", maintenance, envelopes });
    const request = { catalogId: targetCatalogId, sourceCatalogId: fixture.catalogId, mode: "open-as-new" };
    const first = await restoring.restore({
      packageDirectory,
      sourcePackageSha256: backup.packageSha256,
      request,
      forwardFacts: [{ factId: "fact-1", kind: "asset", status: "pending" }],
    });
    assert.equal(first.status, "recovery-required");
    assert.equal(first.unresolvedFactCount, 1);
    assert.deepEqual(maintenanceEvents, ["quiesce", "resume"]);
    assert.equal(envelopeStore.value?.stage, "reconciled");
    const second = await restoring.restore({
      packageDirectory,
      sourcePackageSha256: backup.packageSha256,
      request,
      forwardFacts: [{ factId: "fact-1", kind: "asset", status: "pending" }],
      existingEnvelope: envelopeStore.value ?? undefined,
    });
    assert.equal(second.status, "completed");
    assert.equal(envelopeStore.value, null);
    assert.deepEqual(events.slice(0, 7), ["target", "restore", "fact", "validate", "swap", "reconcile", "resolve"].slice(0, 7));
  } finally {
    await removeFixture(fixture);
  }
});
