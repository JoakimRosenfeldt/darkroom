import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEVELOP_HISTORY_MAX_CATALOG_BYTES,
  DEVELOP_HISTORY_MAX_ENTRY_BYTES,
  canonicalDevelopHistoryDocument,
  collectDevelopHistoryAssetHashes,
  parseDevelopHistoryDocument,
} from "../lib/develop/history.ts";

export const DEVELOP_HISTORY_TABLES = [
  "develop_history_revisions",
  "develop_revision_assets",
  "develop_history_heads",
  "develop_history_refs",
  "develop_xmp_projections",
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
  const historyAlreadyInstalled = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'develop_history_heads'",
  ).get() !== undefined;
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
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
        assets_indexed INTEGER NOT NULL DEFAULT 0 CHECK (assets_indexed IN (0, 1)),
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
        retention_floor_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (retention_floor_ordinal >= 0),
        PRIMARY KEY (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS develop_revision_assets (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        asset_sha256 TEXT NOT NULL CHECK (length(asset_sha256) = 64),
        PRIMARY KEY (catalog_id, entry_id, revision_id, asset_sha256),
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
      CREATE TABLE IF NOT EXISTS develop_xmp_projections (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        projected_at REAL NOT NULL,
        PRIMARY KEY (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS develop_history_revisions_by_entry
        ON develop_history_revisions (catalog_id, entry_id, ordinal DESC);
      CREATE INDEX IF NOT EXISTS develop_history_refs_by_entry
        ON develop_history_refs (catalog_id, entry_id, kind, created_at, ref_id);
      CREATE INDEX IF NOT EXISTS develop_revision_assets_by_hash
        ON develop_revision_assets (catalog_id, asset_sha256);
    `);
    const revisionColumns = database.prepare("PRAGMA table_info(develop_history_revisions)").all() as readonly Record<string, unknown>[];
    if (!revisionColumns.some((column) => column.name === "request_sha256")) {
      database.exec("ALTER TABLE develop_history_revisions ADD COLUMN request_sha256 TEXT;");
    }
    if (!revisionColumns.some((column) => column.name === "assets_indexed")) {
      database.exec("ALTER TABLE develop_history_revisions ADD COLUMN assets_indexed INTEGER NOT NULL DEFAULT 0;");
    }
    const headColumns = database.prepare("PRAGMA table_info(develop_history_heads)").all() as readonly Record<string, unknown>[];
    if (!headColumns.some((column) => column.name === "retention_floor_ordinal")) {
      database.exec("ALTER TABLE develop_history_heads ADD COLUMN retention_floor_ordinal INTEGER NOT NULL DEFAULT 0;");
    }
    if (historyAlreadyInstalled) {
      database.exec("COMMIT;");
      transaction = false;
      return;
    }
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
        label, request_sha256, assets_indexed, document_sha256, checkpoint_json, patch_json, created_at
      ) VALUES (?, ?, ?, NULL, ?, 0, 'Imported current edit', ?, 1, ?, ?, NULL, ?)
    `);
    const insertHead = database.prepare(`
      INSERT INTO develop_history_heads (catalog_id, entry_id, revision_id, updated_at, retention_floor_ordinal)
      VALUES (?, ?, ?, ?, 0)
    `);
    const insertAsset = database.prepare(`
      INSERT INTO develop_revision_assets (catalog_id, entry_id, revision_id, asset_sha256)
      VALUES (?, ?, ?, ?)
    `);
    let catalogBytes = 0;
    let currentCatalogId: string | null = null;
    for (const value of rows) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Develop history migration row is invalid.");
      const row = value as Record<string, unknown>;
      const raw = row.developJson === null
        ? null
        : JSON.parse(rowString(row, "developJson")) as unknown;
      const document = parseDevelopHistoryDocument(raw);
      const checkpointJson = canonicalDevelopHistoryDocument(document);
      const serializedBytes = new TextEncoder().encode(checkpointJson).byteLength;
      if (serializedBytes > DEVELOP_HISTORY_MAX_ENTRY_BYTES) throw new Error("Develop history entry metadata limit exceeded.");
      const catalogId = rowString(row, "catalogId");
      if (currentCatalogId !== catalogId) {
        currentCatalogId = catalogId;
        catalogBytes = 0;
      }
      catalogBytes += serializedBytes;
      if (catalogBytes > DEVELOP_HISTORY_MAX_CATALOG_BYTES) throw new Error("Develop history catalog metadata limit exceeded.");
      const revisionId = randomUUID();
      const createdAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt)
        ? row.createdAt
        : 0;
      insertRevision.run(
        catalogId,
        rowString(row, "entryId"),
        revisionId,
        randomUUID(),
        digest(JSON.stringify({ kind: "root", revisionId, document: JSON.parse(checkpointJson), createdAt })),
        digest(checkpointJson),
        checkpointJson,
        createdAt,
      );
      insertHead.run(catalogId, rowString(row, "entryId"), revisionId, createdAt);
      for (const assetHash of collectDevelopHistoryAssetHashes(document)) {
        insertAsset.run(catalogId, rowString(row, "entryId"), revisionId, assetHash);
      }
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
