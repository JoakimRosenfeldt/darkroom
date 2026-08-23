import { backup, DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import path from "node:path";
import { parentPort, threadId, workerData } from "node:worker_threads";
import {
  parseOperationId,
  parseAssetId,
  type AssetId,
  type OperationId,
} from "../lib/catalog/ids.ts";
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
} from "./catalog-worker-protocol.ts";

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

function integrityCheck(): {
  readonly integrityCheck: readonly string[];
  readonly foreignKeyCheck: readonly CatalogForeignKeyViolation[];
} {
  const opened = requireDatabase();
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
