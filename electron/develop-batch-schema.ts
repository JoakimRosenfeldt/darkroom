import type { DatabaseSync } from "node:sqlite";

export const DEVELOP_BATCH_TABLES = [
  "develop_batch_jobs",
  "develop_batch_items",
  "develop_auto_sync",
] as const;

export function upgradeDevelopBatchSchema(database: DatabaseSync): void {
  const catalog = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_meta'").get();
  const entries = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edit_entries'").get();
  if (catalog === undefined || entries === undefined) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS develop_batch_jobs (
      catalog_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      kind TEXT NOT NULL CHECK (kind IN ('previous', 'sync', 'auto-sync', 'batch', 'undo')),
      source_entry_id TEXT,
      source_revision_id TEXT,
      operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
      cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, batch_id),
      UNIQUE (catalog_id, operation_id),
      CHECK ((source_entry_id IS NULL) = (source_revision_id IS NULL)),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, source_entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS develop_batch_items (
      catalog_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      entry_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      planned_revision_id TEXT NOT NULL,
      expected_revision_id TEXT NOT NULL,
      before_revision_id TEXT,
      after_revision_id TEXT,
      restore_revision_id TEXT,
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, batch_id, position),
      UNIQUE (catalog_id, batch_id, entry_id),
      UNIQUE (catalog_id, batch_id, operation_id),
      FOREIGN KEY (catalog_id, batch_id) REFERENCES develop_batch_jobs (catalog_id, batch_id),
      FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS develop_auto_sync (
      catalog_id TEXT NOT NULL PRIMARY KEY,
      source_entry_id TEXT NOT NULL,
      source_revision_id TEXT NOT NULL,
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
      fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      updated_at REAL NOT NULL,
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, source_entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS develop_batch_jobs_by_catalog
      ON develop_batch_jobs (catalog_id, created_at DESC, batch_id);
    CREATE INDEX IF NOT EXISTS develop_batch_items_by_state
      ON develop_batch_items (catalog_id, batch_id, position);
  `);
}
