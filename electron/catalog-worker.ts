import { backup, DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import path from "node:path";
import { parentPort, threadId, workerData } from "node:worker_threads";
import {
  parseCatalogId,
  parseOperationId,
  parseAssetId,
  type AssetId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import {
  CATALOG_V3_IDENTITY_TABLES,
  CATALOG_V3_TABLES,
  upgradeCatalogV3IdentitySchema,
  verifyCatalogV3Schema,
} from "./catalog-v3-schema.ts";
import {
  CatalogFaultInjectedError,
  createCatalogFaultInjectorForTests,
  createNoopCatalogFaultInjector,
  parseCatalogFaultStage,
  parseCatalogWorkerTestHarnessData,
  type CatalogFaultStage,
  type CatalogWorkerTestHarnessData,
} from "./catalog-fault-injection.ts";
import {
  parseCatalogWorkerRequest,
  parseCatalogWorkerResponse,
  type CatalogForeignKeyViolation,
  type CatalogWorkerError,
  type CatalogWorkerRequest,
  type CatalogWorkerResponse,
  type CatalogWorkerTestTracerInspectRequest,
  type CatalogWorkerTestTracerRecoverRequest,
  type CatalogWorkerTestTracerRunRequest,
  type CatalogWorkerCloneCatalogRequest,
} from "./catalog-worker-protocol.ts";
import { CatalogV3Repository } from "./catalog-v3-repository.ts";
import { CatalogLiveRepository } from "./catalog-live-repository.ts";
import { DEVELOP_HISTORY_TABLES, upgradeDevelopHistorySchema } from "./develop-history-schema.ts";
import { DevelopHistoryRepository } from "./develop-history-repository.ts";

function requiredWorkerPort(): NonNullable<typeof parentPort> {
  if (!parentPort) {
    throw new Error("Catalog worker requires a parent port.");
  }
  return parentPort;
}

const workerPort = requiredWorkerPort();
const testHarness = parseCatalogWorkerTestHarnessData(workerData);
const faultInjector = testHarness?.faultPoint
  ? createCatalogFaultInjectorForTests([testHarness.faultPoint])
  : createNoopCatalogFaultInjector();

let database: DatabaseSync | null = null;
let databasePath: string | null = null;

class CatalogWorkerTestDisabledError extends Error {
  constructor() {
    super("Catalog worker test harness is disabled.");
    this.name = "CatalogWorkerTestDisabledError";
  }
}

interface TestTracerRow {
  readonly operationId: OperationId;
  readonly itemId: AssetId;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly stage: CatalogFaultStage;
}

function requestIdFromUnknown(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const requestId = Reflect.get(value, "requestId");
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Catalog worker operation failed.";
}

function post(response: CatalogWorkerResponse): void {
  parseCatalogWorkerResponse(response);
  workerPort.postMessage(response);
}

function postError(response: CatalogWorkerError): void {
  post(response);
}

function requireDatabase(): DatabaseSync {
  if (!database) {
    throw new Error("Catalog database is not open.");
  }
  return database;
}

function catalogV3Repository(): CatalogV3Repository {
  return new CatalogV3Repository(requireDatabase());
}

function catalogLiveRepository(): CatalogLiveRepository {
  return new CatalogLiveRepository(requireDatabase());
}

function rowValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = rowValue(row, key);
  if (typeof value !== "string") {
    throw new Error(`SQLite result ${key} is invalid.`);
  }
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = rowValue(row, key);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`SQLite result ${key} is invalid.`);
  }
  return value;
}

function rowNullableInteger(row: Record<string, unknown>, key: string): number | null {
  return rowValue(row, key) === null ? null : rowInteger(row, key);
}

function requireTestHarness(): CatalogWorkerTestHarnessData {
  if (!testHarness) {
    throw new CatalogWorkerTestDisabledError();
  }
  return testHarness;
}

function assertTestHarnessPath(rootPath: string, targetPath: string): void {
  const relative = path.relative(rootPath, targetPath);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Catalog tracer path must stay inside its test root.");
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function testTracerTemporaryPath(row: Pick<TestTracerRow, "itemId" | "destinationPath">): string {
  const parsed = path.parse(row.destinationPath);
  return path.join(parsed.dir, `.${parsed.base}.${row.itemId}.stage`);
}

function openDatabase(targetPath: string): boolean {
  if (database) {
    throw new Error("Catalog database is already open.");
  }
  const created = !existsSync(targetPath);
  const opened = new DatabaseSync(targetPath, {
    enableForeignKeyConstraints: true,
    timeout: 500,
  });
  try {
    opened.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    upgradeCatalogV3IdentitySchema(opened);
    upgradeDevelopHistorySchema(opened);
  } catch (error) {
    opened.close();
    throw error;
  }
  database = opened;
  databasePath = targetPath;
  return created;
}

function closeDatabase(): boolean {
  if (!database) {
    databasePath = null;
    return false;
  }
  database.close();
  database = null;
  databasePath = null;
  return true;
}

function transactionProbe(): { committed: boolean; rowCount: number } {
  const opened = requireDatabase();
  let inTransaction = false;
  try {
    opened.exec("BEGIN IMMEDIATE;");
    inTransaction = true;
    opened.exec(`
      CREATE TEMP TABLE IF NOT EXISTS darkroom_transaction_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      DELETE FROM darkroom_transaction_probe;
      INSERT INTO darkroom_transaction_probe (id, value) VALUES (1, 'ok');
      COMMIT;
    `);
    inTransaction = false;
    const row = opened.prepare(
      "SELECT COUNT(*) AS count FROM darkroom_transaction_probe",
    ).get();
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("SQLite transaction probe result is invalid.");
    }
    return { committed: true, rowCount: rowInteger(row, "count") };
  } catch (error) {
    if (inTransaction) {
      try {
        opened.exec("ROLLBACK;");
      } catch {
        // The original transaction error is the useful failure.
      }
    }
    throw error;
  }
}

async function backupDatabase(destinationPath: string): Promise<number> {
  const opened = requireDatabase();
  if (databasePath === destinationPath) {
    throw new Error("Catalog backup destination must differ from the open database.");
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  return backup(opened, destinationPath);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function vacuumIntoDatabase(destinationPath: string): Promise<number> {
  const opened = requireDatabase();
  if (databasePath === destinationPath) {
    throw new Error("Catalog compact destination must differ from the open database.");
  }
  if (existsSync(destinationPath)) {
    throw new Error("Catalog compact destination already exists.");
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    opened.exec(`VACUUM INTO ${sqlString(destinationPath)}`);
    const stat = await fs.stat(destinationPath);
    return stat.size;
  } catch (error) {
    await removeFileIfPresent(destinationPath).catch(() => undefined);
    throw error;
  }
}

function catalogMetaId(opened: DatabaseSync): ReturnType<typeof parseCatalogId> {
  const row = opened.prepare("SELECT catalog_id AS catalogId FROM catalog_meta").get();
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Catalog clone source identity is invalid.");
  }
  return parseCatalogId(rowString(row, "catalogId"));
}

async function cloneCatalogDatabase(request: CatalogWorkerCloneCatalogRequest): Promise<{
  readonly sourceCatalogId: ReturnType<typeof parseCatalogId>;
  readonly catalogId: ReturnType<typeof parseCatalogId>;
  readonly rootCount: number;
  readonly assetCount: number;
}> {
  if (request.sourcePath === request.destinationPath) {
    throw new Error("Catalog clone source and destination must differ.");
  }
  if (existsSync(request.destinationPath)) {
    throw new Error("Catalog clone destination already exists.");
  }
  let sourceCatalogId: ReturnType<typeof parseCatalogId>;
  try {
    const source = new DatabaseSync(request.sourcePath, { readOnly: true });
    try {
      verifyCatalogV3Schema(source);
      sourceCatalogId = catalogMetaId(source);
      if (sourceCatalogId === request.catalogId) {
        throw new Error("Catalog clone needs a new catalog ID.");
      }
      await backup(source, request.destinationPath);
    } finally {
      source.close();
    }
  } catch (error) {
    await removeFileIfPresent(request.destinationPath).catch(() => undefined);
    throw error;
  }

  let cloned: DatabaseSync | undefined;
  let completed = false;
  try {
    cloned = new DatabaseSync(request.destinationPath, {
      enableForeignKeyConstraints: true,
      timeout: 500,
    });
    upgradeCatalogV3IdentitySchema(cloned);
    upgradeDevelopHistorySchema(cloned);
    verifyCatalogV3Schema(cloned);
    cloned.exec("PRAGMA foreign_keys = ON; PRAGMA defer_foreign_keys = ON; BEGIN IMMEDIATE;");
    cloned.prepare(`
      UPDATE catalog_meta
      SET catalog_id = ?, display_name = ?, app_version = ?, revision = revision + 1
      WHERE catalog_id = ?
    `).run(request.catalogId, request.displayName, request.appVersion, sourceCatalogId);
    for (const table of CATALOG_V3_TABLES) {
      if (table === "catalog_meta") continue;
      cloned.prepare(`UPDATE ${table} SET catalog_id = ? WHERE catalog_id = ?`).run(
        request.catalogId,
        sourceCatalogId,
      );
    }
    for (const table of CATALOG_V3_IDENTITY_TABLES) {
      cloned.prepare(`UPDATE ${table} SET catalog_id = ? WHERE catalog_id = ?`).run(
        request.catalogId,
        sourceCatalogId,
      );
    }
    for (const table of DEVELOP_HISTORY_TABLES) {
      cloned.prepare(`UPDATE ${table} SET catalog_id = ? WHERE catalog_id = ?`).run(
        request.catalogId,
        sourceCatalogId,
      );
    }
    const libraryStateTable = cloned.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'library_state'",
    ).get();
    if (libraryStateTable !== undefined) {
      cloned.prepare(
        "UPDATE library_state SET catalog_id = ? WHERE catalog_id = ?",
      ).run(request.catalogId, sourceCatalogId);
    }
    // A package carries historical locations for display only. Never let a clone
    // inherit native authority or an enabled ingress rule.
    cloned.prepare(`
      UPDATE roots
      SET canonical_path = NULL,
          health = 'missing',
          scan_state = 'unknown',
          watch_state = 'disabled'
      WHERE catalog_id = ?
    `).run(request.catalogId);
    cloned.prepare(`
      UPDATE auto_import_rules
      SET enabled = 0
      WHERE catalog_id = ?
    `).run(request.catalogId);
    cloned.exec("COMMIT;");
    const integrity = integrityCheckFor(cloned);
    if (integrity.integrityCheck.length !== 1 || integrity.integrityCheck[0] !== "ok" || integrity.foreignKeyCheck.length > 0) {
      throw new Error("Cloned catalog integrity validation failed.");
    }
    const rootRow = cloned.prepare("SELECT COUNT(*) AS count FROM roots WHERE catalog_id = ?").get(request.catalogId);
    if (!rootRow || typeof rootRow !== "object" || Array.isArray(rootRow)) throw new Error("Cloned root count is invalid.");
    const assetRow = cloned.prepare("SELECT COUNT(*) AS count FROM assets WHERE catalog_id = ?").get(request.catalogId);
    if (!assetRow || typeof assetRow !== "object" || Array.isArray(assetRow)) throw new Error("Cloned asset count is invalid.");
    const rootCount = rowInteger(rootRow, "count");
    const assetCount = rowInteger(assetRow, "count");
    completed = true;
    return {
      sourceCatalogId,
      catalogId: request.catalogId,
      rootCount,
      assetCount,
    };
  } catch (error) {
    try {
      cloned?.exec("ROLLBACK;");
    } catch {
      // The transaction may already have ended.
    }
    throw error;
  } finally {
    cloned?.close();
    if (cloned !== undefined && !completed) {
      try {
        await fs.unlink(request.destinationPath);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
  }
}

function integrityCheckFor(opened: DatabaseSync): {
  readonly integrityCheck: readonly string[];
  readonly foreignKeyCheck: readonly CatalogForeignKeyViolation[];
} {
  const integrityRows = opened.prepare("PRAGMA integrity_check").all();
  const integrityResults = integrityRows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("SQLite integrity result is invalid.");
    }
    return rowString(row, "integrity_check");
  });
  const foreignKeyRows = opened.prepare("PRAGMA foreign_key_check").all();
  const foreignKeyResults = foreignKeyRows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("SQLite foreign-key result is invalid.");
    }
    return {
      table: rowString(row, "table"),
      rowId: rowNullableInteger(row, "rowid"),
      parent: rowString(row, "parent"),
      foreignKeyIndex: rowInteger(row, "fkid"),
    };
  });
  return { integrityCheck: integrityResults, foreignKeyCheck: foreignKeyResults };
}

function integrityCheck(): {
  readonly integrityCheck: readonly string[];
  readonly foreignKeyCheck: readonly CatalogForeignKeyViolation[];
} {
  return integrityCheckFor(requireDatabase());
}

function ensureTestTracerSchema(opened: DatabaseSync): void {
  opened.exec(`
    CREATE TABLE IF NOT EXISTS test_tracer_items (
      operation_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      destination_path TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (
        stage IN (
          'planned',
          'destination-prepared',
          'destination-published',
          'catalog-applied',
          'source-cleaned'
        )
      ),
      PRIMARY KEY (operation_id, item_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS test_tracer_assets (
      item_id TEXT PRIMARY KEY,
      destination_path TEXT NOT NULL
    ) STRICT;
  `);
}

function testTracerRow(
  opened: DatabaseSync,
  operationId: OperationId,
  itemId: AssetId,
): TestTracerRow {
  const row = opened.prepare(`
    SELECT
      operation_id AS operationId,
      item_id AS itemId,
      source_path AS sourcePath,
      destination_path AS destinationPath,
      stage
    FROM test_tracer_items
    WHERE operation_id = ? AND item_id = ?
  `).get(operationId, itemId);
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Catalog tracer item is missing.");
  }
  return {
    operationId: parseOperationId(rowString(row, "operationId")),
    itemId: parseAssetId(rowString(row, "itemId")),
    sourcePath: rowString(row, "sourcePath"),
    destinationPath: rowString(row, "destinationPath"),
    stage: parseCatalogFaultStage(rowString(row, "stage")),
  };
}

function testCatalogRowCount(opened: DatabaseSync, itemId: AssetId): number {
  const row = opened.prepare(
    "SELECT COUNT(*) AS count FROM test_tracer_assets WHERE item_id = ?",
  ).get(itemId);
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Catalog tracer asset count is invalid.");
  }
  return rowInteger(row, "count");
}

function updateTestTracerStage(
  opened: DatabaseSync,
  row: Pick<TestTracerRow, "operationId" | "itemId">,
  stage: CatalogFaultStage,
): void {
  const result = opened.prepare(`
    UPDATE test_tracer_items
    SET stage = ?
    WHERE operation_id = ? AND item_id = ?
  `).run(stage, row.operationId, row.itemId);
  if (result.changes !== 1) {
    throw new Error("Catalog tracer stage update did not affect one item.");
  }
}

function applyTestCatalogRow(opened: DatabaseSync, row: TestTracerRow): void {
  let inTransaction = false;
  try {
    opened.exec("BEGIN IMMEDIATE;");
    inTransaction = true;
    opened.prepare(`
      INSERT INTO test_tracer_assets (item_id, destination_path)
      VALUES (?, ?)
      ON CONFLICT(item_id) DO UPDATE SET destination_path = excluded.destination_path
    `).run(row.itemId, row.destinationPath);
    updateTestTracerStage(opened, row, "catalog-applied");
    opened.exec("COMMIT;");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try {
        opened.exec("ROLLBACK;");
      } catch {
      }
    }
    throw error;
  }
}

async function writeTestTracerStage(row: TestTracerRow): Promise<void> {
  const temporaryPath = testTracerTemporaryPath(row);
  await fs.mkdir(path.dirname(row.destinationPath), { recursive: true });
  try {
    await fs.copyFile(row.sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    const handle = await fs.open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await removeFileIfPresent(temporaryPath);
    throw error;
  }
}

function testTracerResult(opened: DatabaseSync, row: TestTracerRow): {
  readonly stage: CatalogFaultStage;
  readonly catalogRowCount: number;
} {
  return {
    stage: row.stage,
    catalogRowCount: testCatalogRowCount(opened, row.itemId),
  };
}

async function runTestTracer(
  request: CatalogWorkerTestTracerRunRequest,
): Promise<{ readonly stage: CatalogFaultStage; readonly catalogRowCount: number }> {
  const harness = requireTestHarness();
  assertTestHarnessPath(harness.rootPath, request.sourcePath);
  assertTestHarnessPath(harness.rootPath, request.destinationPath);
  if (request.sourcePath === request.destinationPath) {
    throw new Error("Catalog tracer source and destination must differ.");
  }
  const opened = requireDatabase();
  ensureTestTracerSchema(opened);
  opened.prepare(`
    INSERT INTO test_tracer_items (
      operation_id,
      item_id,
      source_path,
      destination_path,
      stage
    ) VALUES (?, ?, ?, ?, 'planned')
  `).run(
    request.operationId,
    request.itemId,
    request.sourcePath,
    request.destinationPath,
  );
  let row = testTracerRow(opened, request.operationId, request.itemId);
  faultInjector.afterStage({
    operationId: row.operationId,
    itemId: row.itemId,
    stage: row.stage,
  });

  await writeTestTracerStage(row);
  updateTestTracerStage(opened, row, "destination-prepared");
  row = testTracerRow(opened, request.operationId, request.itemId);
  faultInjector.afterStage({
    operationId: row.operationId,
    itemId: row.itemId,
    stage: row.stage,
  });

  await fs.rename(testTracerTemporaryPath(row), row.destinationPath);
  updateTestTracerStage(opened, row, "destination-published");
  row = testTracerRow(opened, request.operationId, request.itemId);
  faultInjector.afterStage({
    operationId: row.operationId,
    itemId: row.itemId,
    stage: row.stage,
  });

  applyTestCatalogRow(opened, row);
  row = testTracerRow(opened, request.operationId, request.itemId);
  faultInjector.afterStage({
    operationId: row.operationId,
    itemId: row.itemId,
    stage: row.stage,
  });

  await removeFileIfPresent(row.sourcePath);
  updateTestTracerStage(opened, row, "source-cleaned");
  row = testTracerRow(opened, request.operationId, request.itemId);
  faultInjector.afterStage({
    operationId: row.operationId,
    itemId: row.itemId,
    stage: row.stage,
  });
  return testTracerResult(opened, row);
}

async function recoverTestTracer(
  request: CatalogWorkerTestTracerRecoverRequest,
): Promise<{ readonly stage: CatalogFaultStage; readonly catalogRowCount: number }> {
  const harness = requireTestHarness();
  const opened = requireDatabase();
  ensureTestTracerSchema(opened);
  let row = testTracerRow(opened, request.operationId, request.itemId);
  assertTestHarnessPath(harness.rootPath, row.sourcePath);
  assertTestHarnessPath(harness.rootPath, row.destinationPath);
  const temporaryPath = testTracerTemporaryPath(row);

  if (row.stage === "planned") {
    if (await fileExists(row.destinationPath)) {
      updateTestTracerStage(opened, row, "destination-published");
    } else {
      if (!await fileExists(temporaryPath)) {
        await writeTestTracerStage(row);
      }
      updateTestTracerStage(opened, row, "destination-prepared");
    }
    row = testTracerRow(opened, request.operationId, request.itemId);
  }
  if (row.stage === "destination-prepared") {
    if (!await fileExists(row.destinationPath)) {
      if (!await fileExists(temporaryPath)) {
        throw new Error("Catalog tracer staged destination is missing.");
      }
      await fs.rename(temporaryPath, row.destinationPath);
    } else {
      await removeFileIfPresent(temporaryPath);
    }
    updateTestTracerStage(opened, row, "destination-published");
    row = testTracerRow(opened, request.operationId, request.itemId);
  }
  if (row.stage === "destination-published") {
    if (!await fileExists(row.destinationPath)) {
      throw new Error("Catalog tracer published destination is missing.");
    }
    applyTestCatalogRow(opened, row);
    row = testTracerRow(opened, request.operationId, request.itemId);
  }
  if (row.stage === "catalog-applied") {
    await removeFileIfPresent(row.sourcePath);
    updateTestTracerStage(opened, row, "source-cleaned");
    row = testTracerRow(opened, request.operationId, request.itemId);
  }
  if (!await fileExists(row.destinationPath) || testCatalogRowCount(opened, row.itemId) !== 1) {
    throw new Error("Catalog tracer terminal state is inconsistent.");
  }
  await removeFileIfPresent(temporaryPath);
  return testTracerResult(opened, row);
}

function inspectTestTracer(
  request: CatalogWorkerTestTracerInspectRequest,
): { readonly stage: CatalogFaultStage; readonly catalogRowCount: number } {
  const harness = requireTestHarness();
  const opened = requireDatabase();
  ensureTestTracerSchema(opened);
  const row = testTracerRow(opened, request.operationId, request.itemId);
  assertTestHarnessPath(harness.rootPath, row.sourcePath);
  assertTestHarnessPath(harness.rootPath, row.destinationPath);
  return testTracerResult(opened, row);
}

async function handleRequest(request: CatalogWorkerRequest): Promise<void> {
  switch (request.kind) {
    case "runtime-info":
      post({
        kind: "runtime-info",
        requestId: request.requestId,
        nodeVersion: process.versions.node,
        sqliteVersion: process.versions.sqlite ?? "unknown",
        workerThreadId: threadId,
      });
      return;
    case "open": {
      const created = openDatabase(request.databasePath);
      post({
        kind: "open",
        requestId: request.requestId,
        databasePath: request.databasePath,
        created,
      });
      return;
    }
    case "transaction-probe": {
      const result = transactionProbe();
      post({ kind: "transaction-probe", requestId: request.requestId, ...result });
      return;
    }
    case "backup": {
      const pages = await backupDatabase(request.destinationPath);
      post({
        kind: "backup",
        requestId: request.requestId,
        destinationPath: request.destinationPath,
        pages,
      });
      return;
    }
    case "vacuum-into": {
      const byteLength = await vacuumIntoDatabase(request.destinationPath);
      post({
        kind: "vacuum-into",
        requestId: request.requestId,
        destinationPath: request.destinationPath,
        byteLength,
      });
      return;
    }
    case "clone-catalog": {
      const result = await cloneCatalogDatabase(request);
      post({ kind: "clone-catalog", requestId: request.requestId, ...result });
      return;
    }
    case "integrity-check":
      post({ kind: "integrity-check", requestId: request.requestId, ...integrityCheck() });
      return;
    case "close": {
      const wasOpen = closeDatabase();
      post({ kind: "close", requestId: request.requestId, wasOpen });
      return;
    }
    case "shutdown": {
      const wasOpen = closeDatabase();
      post({ kind: "shutdown", requestId: request.requestId, wasOpen });
      workerPort.close();
      return;
    }
    case "v3-install":
      post({
        kind: "v3-install",
        requestId: request.requestId,
        result: catalogV3Repository().install(request.input),
      });
      return;
    case "v3-assets":
      post({
        kind: "v3-assets",
        requestId: request.requestId,
        result: catalogV3Repository().writeAssetBatch(request.input),
      });
      return;
    case "v3-relations":
      post({
        kind: "v3-relations",
        requestId: request.requestId,
        result: catalogV3Repository().writeRelationsBatch(request.input),
      });
      return;
    case "v3-finish-copy":
      post({
        kind: "v3-finish-copy",
        requestId: request.requestId,
        result: catalogV3Repository().finishCopy(request.catalogId, request.migrationId),
      });
      return;
    case "v3-validate":
      post({
        kind: "v3-validate",
        requestId: request.requestId,
        result: catalogV3Repository().validate(request.catalogId, request.migrationId),
      });
      return;
    case "v3-prepare-activation":
      post({
        kind: "v3-prepare-activation",
        requestId: request.requestId,
        result: catalogV3Repository().prepareActivation(request.catalogId, request.migrationId),
      });
      return;
    case "v3-seal-for-install":
      post({
        kind: "v3-seal-for-install",
        requestId: request.requestId,
        result: catalogV3Repository().sealForInstall(request.catalogId, request.migrationId),
      });
      return;
    case "v3-summary":
      post({
        kind: "v3-summary",
        requestId: request.requestId,
        result: catalogV3Repository().summary(request.catalogId),
      });
      return;
    case "v3-assets-page":
      post({
        kind: "v3-assets-page",
        requestId: request.requestId,
        result: catalogV3Repository().assetPage(request.input),
      });
      return;
    case "v3-albums":
      post({
        kind: "v3-albums",
        requestId: request.requestId,
        result: catalogV3Repository().albumSnapshots(request.input),
      });
      return;
    case "v3-album-assets-page":
      post({
        kind: "v3-album-assets-page",
        requestId: request.requestId,
        result: catalogV3Repository().albumAssetPage(request.input),
      });
      return;
    case "live-create":
      post({
        kind: "live-create",
        requestId: request.requestId,
        result: catalogLiveRepository().create(request.input),
      });
      return;
    case "live-query":
      post({
        kind: "live-query",
        requestId: request.requestId,
        result: catalogLiveRepository().query(request.input),
      });
      return;
    case "live-apply":
      post({
        kind: "live-apply",
        requestId: request.requestId,
        result: catalogLiveRepository().apply(request.input),
      });
      return;
    case "develop-history-load":
      post({ kind: "develop-history-load", requestId: request.requestId, result: new DevelopHistoryRepository(requireDatabase()).load(request.input) });
      return;
    case "develop-history-list":
      post({ kind: "develop-history-list", requestId: request.requestId, result: new DevelopHistoryRepository(requireDatabase()).list(request.input) });
      return;
    case "develop-history-commit":
      post({ kind: "develop-history-commit", requestId: request.requestId, result: new DevelopHistoryRepository(requireDatabase()).commit(request.input) });
      return;
    case "develop-history-refs":
      post({ kind: "develop-history-refs", requestId: request.requestId, result: new DevelopHistoryRepository(requireDatabase()).refs(request.catalogId, request.entryId) });
      return;
    case "develop-history-ref-mutate":
      post({ kind: "develop-history-ref-mutate", requestId: request.requestId, result: new DevelopHistoryRepository(requireDatabase()).mutateRef(request.input) });
      return;
    case "test-tracer-run": {
      const result = await runTestTracer(request);
      post({ kind: "test-tracer-run", requestId: request.requestId, ...result });
      return;
    }
    case "test-tracer-recover": {
      const result = await recoverTestTracer(request);
      post({ kind: "test-tracer-recover", requestId: request.requestId, ...result });
      return;
    }
    case "test-tracer-inspect": {
      const result = inspectTestTracer(request);
      post({ kind: "test-tracer-inspect", requestId: request.requestId, ...result });
      return;
    }
    default: {
      const _exhaustive: never = request;
      throw new Error(`Unknown catalog worker request: ${_exhaustive}.`);
    }
  }
}

let queue = Promise.resolve();

workerPort.on("message", (value: unknown) => {
  queue = queue.then(async () => {
    let request: CatalogWorkerRequest;
    try {
      request = parseCatalogWorkerRequest(value);
    } catch (error) {
      postError({
        kind: "error",
        requestId: requestIdFromUnknown(value),
        code: "protocol",
        message: safeErrorMessage(error),
      });
      return;
    }

    try {
      await handleRequest(request);
    } catch (error) {
      if (error instanceof CatalogFaultInjectedError) {
        postError({
          kind: "error",
          requestId: request.requestId,
          code: "injected-fault",
          message: safeErrorMessage(error),
          faultPoint: error.point,
        });
        return;
      }
      const code =
        error instanceof CatalogWorkerTestDisabledError
          ? "test-disabled"
          : error instanceof Error && error.message === "Catalog database is not open."
            ? "not-open"
            : error instanceof Error && error.message === "Catalog database is already open."
              ? "already-open"
              : "runtime";
      postError({ kind: "error", requestId: request.requestId, code, message: safeErrorMessage(error) });
    }
  });
});
