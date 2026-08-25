import type { DatabaseSync } from "node:sqlite";

export const DEVELOP_BATCH_STORAGE_SCHEMA_VERSION = 1;
export const DEVELOP_BATCH_TABLES = ["develop_batch_schema_meta", "develop_batch_jobs", "develop_batch_items", "develop_auto_sync"] as const;
type DevelopBatchTable = (typeof DEVELOP_BATCH_TABLES)[number];

const EXPECTED_COLUMNS: Readonly<Record<DevelopBatchTable, readonly string[]>> = {
  develop_batch_schema_meta: ["singleton", "schema_version"],
  develop_batch_jobs: ["catalog_id", "batch_id", "operation_id", "request_sha256", "schema_version", "kind", "source_entry_id", "source_revision_id", "operation_json", "targets_json", "cancellation_requested", "created_at", "updated_at"],
  develop_batch_items: ["catalog_id", "batch_id", "position", "entry_id", "operation_id", "planned_revision_id", "expected_revision_id", "before_revision_id", "after_revision_id", "restore_revision_id", "state_json", "attempts", "updated_at"],
  develop_auto_sync: ["catalog_id", "source_entry_id", "source_revision_id", "targets_json", "fields_json", "enabled", "updated_at"],
};

export class DevelopBatchSchemaIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopBatchSchemaIncompatibleError";
  }
}

function tableExists(database: DatabaseSync, table: DevelopBatchTable): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function validateTable(database: DatabaseSync, table: DevelopBatchTable): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DevelopBatchSchemaIncompatibleError(`Develop batch table ${table} metadata is invalid.`);
    const name = Reflect.get(value, "name");
    if (typeof name !== "string") throw new DevelopBatchSchemaIncompatibleError(`Develop batch table ${table} has an invalid column.`);
    return name;
  });
  const expected = EXPECTED_COLUMNS[table];
  if (columns.length !== expected.length || columns.some((column, index) => column !== expected[index])) {
    throw new DevelopBatchSchemaIncompatibleError(`Develop batch table ${table} has an incompatible shape.`);
  }
  const value = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const sql = typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, "sql") : null;
  if (typeof sql !== "string" || !/\bSTRICT\s*$/i.test(sql.trim())) throw new DevelopBatchSchemaIncompatibleError(`Develop batch table ${table} must be STRICT.`);
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE develop_batch_schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = ${DEVELOP_BATCH_STORAGE_SCHEMA_VERSION})
    ) STRICT;
    INSERT INTO develop_batch_schema_meta (singleton, schema_version) VALUES (1, ${DEVELOP_BATCH_STORAGE_SCHEMA_VERSION});
    CREATE TABLE develop_batch_jobs (
      catalog_id TEXT NOT NULL, batch_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      kind TEXT NOT NULL CHECK (kind IN ('previous', 'sync', 'auto-sync', 'batch', 'undo')),
      source_entry_id TEXT, source_revision_id TEXT,
      operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
      cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
      created_at REAL NOT NULL, updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, batch_id), UNIQUE (catalog_id, operation_id),
      CHECK ((source_entry_id IS NULL) = (source_revision_id IS NULL)),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, source_entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
    CREATE TABLE develop_batch_items (
      catalog_id TEXT NOT NULL, batch_id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 0),
      entry_id TEXT NOT NULL, operation_id TEXT NOT NULL, planned_revision_id TEXT NOT NULL,
      expected_revision_id TEXT NOT NULL, before_revision_id TEXT, after_revision_id TEXT, restore_revision_id TEXT,
      state_json TEXT NOT NULL CHECK (json_valid(state_json)), attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      updated_at REAL NOT NULL, PRIMARY KEY (catalog_id, batch_id, position),
      UNIQUE (catalog_id, batch_id, entry_id), UNIQUE (catalog_id, batch_id, operation_id),
      UNIQUE (catalog_id, batch_id, planned_revision_id),
      FOREIGN KEY (catalog_id, batch_id) REFERENCES develop_batch_jobs (catalog_id, batch_id),
      FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
    CREATE TABLE develop_auto_sync (
      catalog_id TEXT NOT NULL PRIMARY KEY, source_entry_id TEXT NOT NULL, source_revision_id TEXT NOT NULL,
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)), fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), updated_at REAL NOT NULL,
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, source_entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
  `);
}

function installIndexes(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS develop_batch_jobs_by_catalog ON develop_batch_jobs (catalog_id, created_at DESC, batch_id);
    CREATE UNIQUE INDEX IF NOT EXISTS develop_auto_sync_source_revision_once ON develop_batch_jobs (catalog_id, source_revision_id) WHERE kind = 'auto-sync';
    CREATE INDEX IF NOT EXISTS develop_batch_items_by_state ON develop_batch_items (catalog_id, batch_id, position);
  `);
}

export function upgradeDevelopBatchSchema(database: DatabaseSync): void {
  const catalog = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_meta'").get();
  const entries = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edit_entries'").get();
  if (catalog === undefined || entries === undefined) return;
  const dataTables = DEVELOP_BATCH_TABLES.filter((table) => table !== "develop_batch_schema_meta");
  const existingDataTables = dataTables.filter((table) => tableExists(database, table));
  const metadataExists = tableExists(database, "develop_batch_schema_meta");
  if (existingDataTables.length === 0 && !metadataExists) {
    createSchema(database);
  } else {
    if (existingDataTables.length !== dataTables.length) throw new DevelopBatchSchemaIncompatibleError("Develop batch schema is partial and cannot be upgraded safely.");
    for (const table of dataTables) validateTable(database, table);
    if (!metadataExists) {
      database.exec(`
        CREATE TABLE develop_batch_schema_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL CHECK (schema_version = ${DEVELOP_BATCH_STORAGE_SCHEMA_VERSION})
        ) STRICT;
        INSERT INTO develop_batch_schema_meta (singleton, schema_version) VALUES (1, ${DEVELOP_BATCH_STORAGE_SCHEMA_VERSION});
      `);
    }
  }
  validateTable(database, "develop_batch_schema_meta");
  const value = database.prepare("SELECT schema_version AS schemaVersion FROM develop_batch_schema_meta WHERE singleton = 1").get();
  const version = typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, "schemaVersion") : null;
  if (version !== DEVELOP_BATCH_STORAGE_SCHEMA_VERSION) throw new DevelopBatchSchemaIncompatibleError(`Develop batch schema version ${String(version)} is unsupported.`);
  installIndexes(database);
}
