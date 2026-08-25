import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalDevelopHistoryJson, parseDevelopHistoryJson } from "../lib/develop/history.ts";

export const DEVELOP_HISTORY_TABLES = [
  "develop_history_revisions",
  "develop_history_heads",
  "develop_history_refs",
] as const;

function digest(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Develop history ${key} is invalid.`);
  return value;
}

export function upgradeDevelopHistorySchema(database: DatabaseSync): void {
  const editEntries = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edit_entries'",
  ).get();
  if (editEntries === undefined) return;
  let transaction = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transaction = true;
    database.exec(`
      CREATE TABLE IF NOT EXISTS develop_history_revisions (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        parent_revision_id TEXT,
        operation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        label TEXT NOT NULL CHECK (length(trim(label)) > 0 AND length(label) <= 120),
        document_sha256 TEXT NOT NULL CHECK (length(document_sha256) = 64),
        checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
        patch_json TEXT CHECK (patch_json IS NULL OR json_valid(patch_json)),
        created_at REAL NOT NULL,
        PRIMARY KEY (catalog_id, entry_id, revision_id),
        UNIQUE (catalog_id, entry_id, operation_id),
        UNIQUE (catalog_id, entry_id, ordinal),
        CHECK ((parent_revision_id IS NULL AND ordinal = 0 AND checkpoint_json IS NOT NULL AND patch_json IS NULL) OR
               (parent_revision_id IS NOT NULL AND ordinal > 0 AND ((checkpoint_json IS NULL) <> (patch_json IS NULL)))),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, parent_revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS develop_history_heads (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS develop_history_refs (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('version', 'snapshot')),
        name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 120),
        revision_id TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (catalog_id, entry_id, ref_id),
        UNIQUE (catalog_id, entry_id, kind, name),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS develop_history_revisions_by_entry
        ON develop_history_revisions (catalog_id, entry_id, ordinal DESC);
      CREATE INDEX IF NOT EXISTS develop_history_refs_by_entry
        ON develop_history_refs (catalog_id, entry_id, kind, created_at, ref_id);
    `);
    const rows = database.prepare(`
      SELECT e.catalog_id AS catalogId, e.entry_id AS entryId, m.develop_json AS developJson,
             COALESCE(m.develop_updated_at, e.created_at) AS createdAt
      FROM edit_entries AS e
      JOIN entry_metadata AS m ON m.catalog_id = e.catalog_id AND m.entry_id = e.entry_id
      LEFT JOIN develop_history_heads AS h ON h.catalog_id = e.catalog_id AND h.entry_id = e.entry_id
      WHERE h.entry_id IS NULL
      ORDER BY e.catalog_id, e.entry_id
    `).all();
    const insertRevision = database.prepare(`
      INSERT INTO develop_history_revisions (
        catalog_id, entry_id, revision_id, parent_revision_id, operation_id, ordinal,
        label, document_sha256, checkpoint_json, patch_json, created_at
      ) VALUES (?, ?, ?, NULL, ?, 0, 'Imported current edit', ?, ?, NULL, ?)
    `);
    const insertHead = database.prepare(`
      INSERT INTO develop_history_heads (catalog_id, entry_id, revision_id, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const value of rows) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Develop history migration row is invalid.");
      const row = value as Record<string, unknown>;
      const raw = row.developJson === null
        ? null
        : JSON.parse(rowString(row, "developJson")) as unknown;
      const checkpointJson = canonicalDevelopHistoryJson(parseDevelopHistoryJson(raw));
      const revisionId = randomUUID();
      const createdAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt)
        ? row.createdAt
        : 0;
      insertRevision.run(
        rowString(row, "catalogId"),
        rowString(row, "entryId"),
        revisionId,
        randomUUID(),
        digest(checkpointJson),
        checkpointJson,
        createdAt,
      );
      insertHead.run(rowString(row, "catalogId"), rowString(row, "entryId"), revisionId, createdAt);
    }
    database.exec("COMMIT;");
    transaction = false;
  } catch (error) {
    if (transaction) {
      try { database.exec("ROLLBACK;"); } catch { /* original error is actionable */ }
    }
    throw error;
  }
}
