import type { DatabaseSync } from "node:sqlite";

export const DEVELOP_BATCH_STORAGE_SCHEMA_VERSION = 2;
export const DEVELOP_BATCH_TABLES = ["develop_batch_schema_meta", "develop_batch_jobs", "develop_batch_items", "develop_auto_sync"] as const;
type DevelopBatchTable = (typeof DEVELOP_BATCH_TABLES)[number];

const V1_COLUMNS = {
  develop_batch_jobs: ["catalog_id", "batch_id", "operation_id", "request_sha256", "schema_version", "kind", "source_entry_id", "source_revision_id", "operation_json", "targets_json", "cancellation_requested", "created_at", "updated_at"],
  develop_batch_items: ["catalog_id", "batch_id", "position", "entry_id", "operation_id", "planned_revision_id", "expected_revision_id", "before_revision_id", "after_revision_id", "restore_revision_id", "state_json", "attempts", "updated_at"],
  develop_auto_sync: ["catalog_id", "source_entry_id", "source_revision_id", "targets_json", "fields_json", "enabled", "updated_at"],
} as const;

const V2_COLUMNS: Readonly<Record<DevelopBatchTable, readonly string[]>> = {
  develop_batch_schema_meta: ["singleton", "schema_version"],
  develop_batch_jobs: [...V1_COLUMNS.develop_batch_jobs, "emission_sequence"],
  develop_batch_items: V1_COLUMNS.develop_batch_items,
  develop_auto_sync: [...V1_COLUMNS.develop_auto_sync, "source_emission_sequence"],
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

function columns(database: DatabaseSync, table: DevelopBatchTable): readonly string[] {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DevelopBatchSchemaIncompatibleError(`Develop batch table ${table} metadata is invalid.`);
    const name = Reflect.get(value, "name");
    if (typeof name !== "string") throw new DevelopBatchSchemaIncompatibleError(`Develop batch table ${table} has an invalid column.`);
    return name;
  });
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

function validateTable(database: DatabaseSync, table: DevelopBatchTable, expected: readonly string[]): void {
  if (!sameColumns(columns(database, table), expected)) {
    throw new DevelopBatchSchemaIncompatibleError(`Develop batch table ${table} has an incompatible shape.`);
  }
  const value = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const sql = typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, "sql") : null;
  if (typeof sql !== "string" || !/\bSTRICT\s*$/i.test(sql.trim())) throw new DevelopBatchSchemaIncompatibleError(`Develop batch table ${table} must be STRICT.`);
}

function createMetadata(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE develop_batch_schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = ${DEVELOP_BATCH_STORAGE_SCHEMA_VERSION})
    ) STRICT;
    INSERT INTO develop_batch_schema_meta (singleton, schema_version) VALUES (1, ${DEVELOP_BATCH_STORAGE_SCHEMA_VERSION});
  `);
}

function createSchema(database: DatabaseSync): void {
  createMetadata(database);
  database.exec(`
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
      emission_sequence INTEGER CHECK (emission_sequence IS NULL OR emission_sequence >= 1),
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
      source_emission_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_emission_sequence >= 0),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, source_entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
  `);
}

function integerField(value: unknown, field: string, label: string): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DevelopBatchSchemaIncompatibleError(`${label} row is invalid.`);
  }
  const result = Reflect.get(value, field);
  if (typeof result !== "number" || !Number.isSafeInteger(result)) {
    throw new DevelopBatchSchemaIncompatibleError(`${label} ${field} is invalid.`);
  }
  return result;
}

function stringField(value: unknown, field: string, label: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DevelopBatchSchemaIncompatibleError(`${label} row is invalid.`);
  }
  const result = Reflect.get(value, field);
  if (typeof result !== "string" || result.length === 0) {
    throw new DevelopBatchSchemaIncompatibleError(`${label} ${field} is invalid.`);
  }
  return result;
}

function migrateDataTables(database: DatabaseSync): void {
  const jobColumns = columns(database, "develop_batch_jobs");
  const autoColumns = columns(database, "develop_auto_sync");
  const jobsAreV1 = sameColumns(jobColumns, V1_COLUMNS.develop_batch_jobs);
  const autoIsV1 = sameColumns(autoColumns, V1_COLUMNS.develop_auto_sync);
  const jobsAreV2 = sameColumns(jobColumns, V2_COLUMNS.develop_batch_jobs);
  const autoIsV2 = sameColumns(autoColumns, V2_COLUMNS.develop_auto_sync);
  if ((jobsAreV1 && !autoIsV1) || (jobsAreV2 && !autoIsV2) || (!jobsAreV1 && !jobsAreV2)) {
    throw new DevelopBatchSchemaIncompatibleError("Develop batch schema versions are inconsistent.");
  }
  validateTable(database, "develop_batch_jobs", jobsAreV1 ? V1_COLUMNS.develop_batch_jobs : V2_COLUMNS.develop_batch_jobs);
  validateTable(database, "develop_batch_items", V2_COLUMNS.develop_batch_items);
  validateTable(database, "develop_auto_sync", autoIsV1 ? V1_COLUMNS.develop_auto_sync : V2_COLUMNS.develop_auto_sync);
  if (jobsAreV1) {
    database.exec(`
      ALTER TABLE develop_batch_jobs ADD COLUMN emission_sequence INTEGER;
      ALTER TABLE develop_auto_sync ADD COLUMN source_emission_sequence INTEGER NOT NULL DEFAULT 0;
    `);
  }
}

function normalizeEmissionSequences(database: DatabaseSync): void {
  const invalidSource = database.prepare(`
    SELECT 1 FROM develop_batch_jobs
    WHERE kind = 'auto-sync' AND (source_entry_id IS NULL OR source_revision_id IS NULL)
    LIMIT 1
  `).get();
  if (invalidSource !== undefined) throw new DevelopBatchSchemaIncompatibleError("Legacy Auto Sync Receipt source is incomplete.");
  const duplicate = database.prepare(`
    SELECT 1 FROM develop_batch_jobs
    WHERE kind = 'auto-sync'
    GROUP BY catalog_id, source_entry_id, source_revision_id HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  if (duplicate !== undefined) {
    throw new DevelopBatchSchemaIncompatibleError("Legacy Auto Sync Receipts repeat a source revision and cannot be collapsed safely.");
  }
  const rows = database.prepare(`
    SELECT rowid AS rowId, catalog_id AS catalogId, emission_sequence AS emissionSequence
    FROM develop_batch_jobs WHERE kind = 'auto-sync' ORDER BY catalog_id, rowid
  `).all();
  const hasNull = rows.some((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
    return Reflect.get(value, "emissionSequence") === null;
  });
  const hasValue = rows.some((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    return Reflect.get(value, "emissionSequence") !== null;
  });
  if (hasNull && hasValue) throw new DevelopBatchSchemaIncompatibleError("Auto Sync emission sequences are only partially populated.");
  if (hasNull) {
    const update = database.prepare("UPDATE develop_batch_jobs SET emission_sequence = ? WHERE rowid = ?");
    let previousCatalog = "";
    let sequence = 0;
    for (const value of rows) {
      const catalogId = stringField(value, "catalogId", "Auto Sync emission");
      if (catalogId !== previousCatalog) {
        previousCatalog = catalogId;
        sequence = 0;
      }
      sequence += 1;
      update.run(sequence, integerField(value, "rowId", "Auto Sync emission"));
    }
  }
  const invalidSequence = database.prepare(`
    SELECT 1 FROM develop_batch_jobs
    WHERE (kind = 'auto-sync' AND (emission_sequence IS NULL OR emission_sequence < 1))
       OR (kind <> 'auto-sync' AND emission_sequence IS NOT NULL)
    LIMIT 1
  `).get();
  if (invalidSequence !== undefined) throw new DevelopBatchSchemaIncompatibleError("Auto Sync emission sequence is invalid.");
  const duplicateSequence = database.prepare(`
    SELECT 1 FROM develop_batch_jobs WHERE kind = 'auto-sync'
    GROUP BY catalog_id, emission_sequence HAVING COUNT(*) > 1 LIMIT 1
  `).get();
  if (duplicateSequence !== undefined) throw new DevelopBatchSchemaIncompatibleError("Auto Sync emission sequence is duplicated.");
  database.exec(`
    UPDATE develop_auto_sync
    SET source_emission_sequence = COALESCE((
      SELECT emission_sequence FROM develop_batch_jobs AS job
      WHERE job.catalog_id = develop_auto_sync.catalog_id
        AND job.kind = 'auto-sync'
        AND job.source_entry_id = develop_auto_sync.source_entry_id
        AND job.source_revision_id = develop_auto_sync.source_revision_id
    ), (
      SELECT MAX(emission_sequence) FROM develop_batch_jobs AS job
      WHERE job.catalog_id = develop_auto_sync.catalog_id AND job.kind = 'auto-sync'
    ), 0)
    WHERE source_emission_sequence = 0;
  `);
}

function installIndexes(database: DatabaseSync): void {
  database.exec(`
    DROP INDEX IF EXISTS develop_auto_sync_source_revision_once;
    CREATE INDEX IF NOT EXISTS develop_batch_jobs_by_catalog ON develop_batch_jobs (catalog_id, created_at DESC, batch_id);
    CREATE UNIQUE INDEX develop_auto_sync_source_revision_once
      ON develop_batch_jobs (catalog_id, source_entry_id, source_revision_id) WHERE kind = 'auto-sync';
    CREATE UNIQUE INDEX IF NOT EXISTS develop_auto_sync_emission_sequence_once
      ON develop_batch_jobs (catalog_id, emission_sequence) WHERE kind = 'auto-sync';
    CREATE INDEX IF NOT EXISTS develop_batch_items_by_state ON develop_batch_items (catalog_id, batch_id, position);
  `);
}

function installMetadata(database: DatabaseSync): void {
  if (tableExists(database, "develop_batch_schema_meta")) {
    validateTable(database, "develop_batch_schema_meta", V2_COLUMNS.develop_batch_schema_meta);
    const value = database.prepare("SELECT schema_version AS schemaVersion FROM develop_batch_schema_meta WHERE singleton = 1").get();
    const version = typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, "schemaVersion") : null;
    if (version !== 1 && version !== DEVELOP_BATCH_STORAGE_SCHEMA_VERSION) {
      throw new DevelopBatchSchemaIncompatibleError(`Develop batch schema version ${String(version)} is unsupported.`);
    }
    if (version === DEVELOP_BATCH_STORAGE_SCHEMA_VERSION) return;
    database.exec("DROP TABLE develop_batch_schema_meta;");
  }
  createMetadata(database);
}

export function upgradeDevelopBatchSchema(database: DatabaseSync): void {
  const catalog = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_meta'").get();
  const entries = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edit_entries'").get();
  if (catalog === undefined || entries === undefined) return;
  let active = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    active = true;
    const dataTables = DEVELOP_BATCH_TABLES.filter((table) => table !== "develop_batch_schema_meta");
    const existingDataTables = dataTables.filter((table) => tableExists(database, table));
    const metadataExists = tableExists(database, "develop_batch_schema_meta");
    if (existingDataTables.length === 0 && !metadataExists) {
      createSchema(database);
    } else {
      if (existingDataTables.length !== dataTables.length) throw new DevelopBatchSchemaIncompatibleError("Develop batch schema is partial and cannot be upgraded safely.");
      migrateDataTables(database);
      normalizeEmissionSequences(database);
      installMetadata(database);
    }
    validateTable(database, "develop_batch_schema_meta", V2_COLUMNS.develop_batch_schema_meta);
    validateTable(database, "develop_batch_jobs", V2_COLUMNS.develop_batch_jobs);
    validateTable(database, "develop_batch_items", V2_COLUMNS.develop_batch_items);
    validateTable(database, "develop_auto_sync", V2_COLUMNS.develop_auto_sync);
    normalizeEmissionSequences(database);
    installIndexes(database);
    database.exec("COMMIT;");
    active = false;
  } catch (error) {
    if (active) try { database.exec("ROLLBACK;"); } catch { /* preserve the original failure */ }
    throw error;
  }
}
