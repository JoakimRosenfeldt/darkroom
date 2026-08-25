import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { parseCatalogId, parseEntryId, type CatalogId, type EntryId } from "../lib/catalog/ids.ts";
import {
  DEVELOP_HISTORY_CHECKPOINT_INTERVAL,
  DEVELOP_HISTORY_EARLY_CHECKPOINT_BYTES,
  DEVELOP_HISTORY_MAX_CATALOG_BYTES,
  DEVELOP_HISTORY_MAX_ENTRY_BYTES,
  DEVELOP_HISTORY_MAX_REFS_PER_KIND,
  DEVELOP_HISTORY_RETAINED_REVISIONS,
  canonicalDevelopHistoryDocument,
  canonicalDevelopHistoryJson,
  collectDevelopHistoryAssetHashes,
  diffDevelopHistory,
  parseDevelopDocumentHash,
  parseDevelopHistoryCommitInput,
  parseDevelopHistoryDocument,
  parseDevelopHistoryListInput,
  parseDevelopHistoryLoadInput,
  parseDevelopHistoryPatch,
  parseDevelopHistoryProjectionWriteInput,
  parseDevelopHistoryRef,
  parseDevelopHistoryRefMutationInput,
  parseDevelopHistoryRevision,
  parseDevelopRevisionId,
  replayDevelopHistory,
  type DevelopHistoryCommitInput,
  type DevelopHistoryCommitResult,
  type DevelopHistoryListInput,
  type DevelopHistoryLoadInput,
  type DevelopHistoryLoadResult,
  type DevelopHistoryProjection,
  type DevelopHistoryProjectionWriteInput,
  type DevelopHistoryRecoveryRevision,
  type DevelopHistoryRef,
  type DevelopHistoryRefMutationInput,
  type DevelopHistoryRevision,
  type DevelopRevisionId,
} from "../lib/develop/history.ts";
import { upgradeDevelopHistorySchema } from "./develop-history-schema.ts";

type Row = Record<string, unknown>;

function row(value: unknown, label: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Row;
}
function string(value: Row, key: string): string {
  const item = value[key];
  if (typeof item !== "string") throw new Error(`Develop history ${key} is invalid.`);
  return item;
}
function number(value: Row, key: string): number {
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item)) throw new Error(`Develop history ${key} is invalid.`);
  return item;
}
function integer(value: Row, key: string): number {
  const item = number(value, key);
  if (!Number.isSafeInteger(item)) throw new Error(`Develop history ${key} is invalid.`);
  return item;
}
function nullableString(value: Row, key: string): string | null {
  return value[key] === null ? null : string(value, key);
}
function sha256(json: string): ReturnType<typeof parseDevelopDocumentHash> {
  return parseDevelopDocumentHash(createHash("sha256").update(json).digest("hex"));
}

const REVISION_SELECT = `
  SELECT catalog_id AS catalogId, entry_id AS entryId, revision_id AS revisionId,
         parent_revision_id AS parentRevisionId, operation_id AS operationId,
         request_sha256 AS requestHash,
         ordinal, label, document_sha256 AS documentHash,
         checkpoint_json AS checkpointJson, patch_json AS patchJson, created_at AS createdAt
  FROM develop_history_revisions
`;

export class DevelopHistoryRepository {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
    upgradeDevelopHistorySchema(database);
    this.backfillAssetReferences();
  }

  private transaction<T>(run: () => T): T {
    let active = false;
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      active = true;
      const result = run();
      this.database.exec("COMMIT;");
      active = false;
      return result;
    } catch (error) {
      if (active) try { this.database.exec("ROLLBACK;"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  assertHeadsComplete(catalogId: CatalogId): void {
    const missing = this.database.prepare(`
      SELECT e.entry_id AS entryId
      FROM edit_entries AS e
      LEFT JOIN develop_history_heads AS h
        ON h.catalog_id = e.catalog_id AND h.entry_id = e.entry_id
      WHERE e.catalog_id = ? AND h.entry_id IS NULL
      LIMIT 1
    `).get(catalogId);
    if (missing !== undefined) throw new Error("Develop history Head is missing; recovery is required.");
  }

  ensureRoots(catalogId?: CatalogId, alreadyInTransaction = false): void {
    const run = () => {
      const conditions = catalogId === undefined ? "" : "AND e.catalog_id = ?";
      const parameters: SQLInputValue[] = catalogId === undefined ? [] : [catalogId];
      const missing = this.database.prepare(`
        SELECT e.catalog_id AS catalogId, e.entry_id AS entryId, m.develop_json AS developJson,
               COALESCE(m.develop_updated_at, e.created_at) AS createdAt
        FROM edit_entries AS e
        JOIN entry_metadata AS m ON m.catalog_id = e.catalog_id AND m.entry_id = e.entry_id
        LEFT JOIN develop_history_heads AS h ON h.catalog_id = e.catalog_id AND h.entry_id = e.entry_id
        WHERE h.entry_id IS NULL ${conditions}
        ORDER BY e.catalog_id, e.entry_id
      `).all(...parameters);
      const insertRevision = this.database.prepare(`
        INSERT INTO develop_history_revisions (
          catalog_id, entry_id, revision_id, parent_revision_id, operation_id, ordinal,
          label, request_sha256, assets_indexed, document_sha256, checkpoint_json, patch_json, created_at
        ) VALUES (?, ?, ?, NULL, ?, 0, 'Imported current edit', ?, 1, ?, ?, NULL, ?)
      `);
      const insertHead = this.database.prepare("INSERT INTO develop_history_heads (catalog_id, entry_id, revision_id, updated_at, retention_floor_ordinal) VALUES (?, ?, ?, ?, 0)");
      const insertAsset = this.database.prepare("INSERT INTO develop_revision_assets (catalog_id, entry_id, revision_id, asset_sha256) VALUES (?, ?, ?, ?)");
      for (const value of missing) {
        const item = row(value, "Develop history root row");
        const document = item.developJson === null
          ? null
          : JSON.parse(string(item, "developJson")) as unknown;
        const parsedDocument = parseDevelopHistoryDocument(document);
        const checkpointJson = canonicalDevelopHistoryDocument(parsedDocument);
        this.assertStorageCapacity(
          parseCatalogId(string(item, "catalogId")),
          parseEntryId(string(item, "entryId")),
          new TextEncoder().encode(checkpointJson).byteLength,
        );
        const revisionId = randomUUID();
        const createdAt = number(item, "createdAt");
        const requestHash = sha256(JSON.stringify({ kind: "root", revisionId, document: JSON.parse(checkpointJson), createdAt }));
        insertRevision.run(string(item, "catalogId"), string(item, "entryId"), revisionId, randomUUID(), requestHash, sha256(checkpointJson), checkpointJson, createdAt);
        insertHead.run(string(item, "catalogId"), string(item, "entryId"), revisionId, createdAt);
        for (const assetHash of collectDevelopHistoryAssetHashes(parsedDocument)) {
          insertAsset.run(string(item, "catalogId"), string(item, "entryId"), revisionId, assetHash);
        }
      }
    };
    if (alreadyInTransaction) run(); else this.transaction(run);
  }

  private assertActiveEntry(catalogId: CatalogId, entryId: EntryId): void {
    const entry = this.database.prepare(`
      SELECT 1 FROM edit_entries
      WHERE catalog_id = ? AND entry_id = ? AND tombstoned_at IS NULL
    `).get(catalogId, entryId);
    if (entry === undefined) throw new Error("Develop history entry is inactive or missing.");
  }

  private backfillAssetReferences(): void {
    const pending = this.database.prepare(`${REVISION_SELECT} WHERE assets_indexed = 0 ORDER BY catalog_id, entry_id, ordinal`).all();
    if (pending.length === 0) return;
    this.transaction(() => {
      const insert = this.database.prepare("INSERT OR IGNORE INTO develop_revision_assets (catalog_id, entry_id, revision_id, asset_sha256) VALUES (?, ?, ?, ?)");
      const mark = this.database.prepare("UPDATE develop_history_revisions SET assets_indexed = 1 WHERE catalog_id = ? AND entry_id = ? AND revision_id = ? AND assets_indexed = 0");
      for (const value of pending) {
        const item = row(value, "Develop history asset backfill revision");
        const catalogId = parseCatalogId(string(item, "catalogId"));
        const entryId = parseEntryId(string(item, "entryId"));
        const revisionId = parseDevelopRevisionId(string(item, "revisionId"));
        const reconstruction = this.tryReconstruct(catalogId, entryId, revisionId);
        if (!reconstruction.ok) continue;
        for (const assetHash of collectDevelopHistoryAssetHashes(reconstruction.document)) insert.run(catalogId, entryId, revisionId, assetHash);
        mark.run(catalogId, entryId, revisionId);
      }
    });
  }

  private revisionFromRow(value: unknown): DevelopHistoryRevision {
    const item = row(value, "Develop history revision row");
    return parseDevelopHistoryRevision({
      catalogId: string(item, "catalogId"), entryId: string(item, "entryId"),
      revisionId: string(item, "revisionId"), parentRevisionId: nullableString(item, "parentRevisionId"),
      operationId: string(item, "operationId"), ordinal: integer(item, "ordinal"),
      label: string(item, "label"), documentHash: string(item, "documentHash"),
      checkpoint: item.checkpointJson !== null, createdAt: number(item, "createdAt"),
    });
  }

  private revisionRow(catalogId: CatalogId, entryId: EntryId, revisionId: DevelopRevisionId): Row {
    const value = this.database.prepare(`${REVISION_SELECT} WHERE catalog_id = ? AND entry_id = ? AND revision_id = ?`).get(catalogId, entryId, revisionId);
    if (value === undefined) throw new Error("Develop history revision is missing.");
    return row(value, "Develop history revision row");
  }

  private headId(catalogId: CatalogId, entryId: EntryId): DevelopRevisionId {
    const value = this.database.prepare("SELECT revision_id AS revisionId FROM develop_history_heads WHERE catalog_id = ? AND entry_id = ?").get(catalogId, entryId);
    if (value === undefined) throw new Error("Develop history Head is missing.");
    return parseDevelopRevisionId(string(row(value, "Develop history Head"), "revisionId"));
  }

  private metadataBytes(catalogId: CatalogId, entryId?: EntryId): number {
    const condition = entryId === undefined ? "catalog_id = ?" : "catalog_id = ? AND entry_id = ?";
    const parameters: SQLInputValue[] = entryId === undefined ? [catalogId] : [catalogId, entryId];
    const value = this.database.prepare(`
      SELECT COALESCE(SUM(
        COALESCE(length(CAST(checkpoint_json AS BLOB)), 0) +
        COALESCE(length(CAST(patch_json AS BLOB)), 0)
      ), 0) AS bytes
      FROM develop_history_revisions WHERE ${condition}
    `).get(...parameters);
    return integer(row(value, "Develop history metadata size"), "bytes");
  }

  private assertStorageCapacity(catalogId: CatalogId, entryId: EntryId, addedBytes: number): void {
    if (this.metadataBytes(catalogId, entryId) + addedBytes > DEVELOP_HISTORY_MAX_ENTRY_BYTES) {
      throw new Error("Develop history entry metadata limit exceeded.");
    }
    if (this.metadataBytes(catalogId) + addedBytes > DEVELOP_HISTORY_MAX_CATALOG_BYTES) {
      throw new Error("Develop history catalog metadata limit exceeded.");
    }
  }

  private reconstructionFailure(
    kind: "missing-revision" | "cycle" | "checkpoint" | "patch" | "hash" | "document",
    message: string,
    failedRevisionId: DevelopRevisionId | null,
    lastValidRevisionId: DevelopRevisionId | null,
  ) {
    return { ok: false as const, corruption: { kind, message, failedRevisionId }, lastValidRevisionId };
  }

  private tryReconstruct(catalogId: CatalogId, entryId: EntryId, revisionId: DevelopRevisionId) {
    const chain: Row[] = [];
    const seen = new Set<string>();
    let current = revisionId;
    while (true) {
      if (seen.has(current)) return this.reconstructionFailure("cycle", "Develop history contains a revision cycle.", current, null);
      seen.add(current);
      let item: Row;
      try {
        item = this.revisionRow(catalogId, entryId, current);
      } catch {
        return this.reconstructionFailure("missing-revision", "Develop history revision is missing.", current, null);
      }
      chain.push(item);
      if (item.checkpointJson !== null) break;
      const parent = nullableString(item, "parentRevisionId");
      if (parent === null || chain.length > DEVELOP_HISTORY_CHECKPOINT_INTERVAL) {
        return this.reconstructionFailure("checkpoint", "Develop history checkpoint chain is invalid.", current, null);
      }
      current = parseDevelopRevisionId(parent);
    }
    const checkpoint = chain.pop()!;
    let document;
    const checkpointRevisionId = parseDevelopRevisionId(string(checkpoint, "revisionId"));
    try {
      document = parseDevelopHistoryDocument(JSON.parse(string(checkpoint, "checkpointJson")));
    } catch (error) {
      return this.reconstructionFailure("document", error instanceof Error ? error.message : "Develop history document is invalid.", checkpointRevisionId, null);
    }
    const checkpointHash = sha256(canonicalDevelopHistoryDocument(document));
    if (checkpointHash !== parseDevelopDocumentHash(string(checkpoint, "documentHash"))) {
      return this.reconstructionFailure("hash", "Develop history checkpoint hash is corrupt.", checkpointRevisionId, null);
    }
    let lastValidRevisionId = checkpointRevisionId;
    for (const item of chain.reverse()) {
      const itemRevisionId = parseDevelopRevisionId(string(item, "revisionId"));
      try {
        document = parseDevelopHistoryDocument(replayDevelopHistory(document, JSON.parse(string(item, "patchJson"))));
      } catch (error) {
        return this.reconstructionFailure("patch", error instanceof Error ? error.message : "Develop history patch is corrupt.", itemRevisionId, lastValidRevisionId);
      }
      if (sha256(canonicalDevelopHistoryDocument(document)) !== parseDevelopDocumentHash(string(item, "documentHash"))) {
        return this.reconstructionFailure("hash", "Develop history revision hash is corrupt.", itemRevisionId, lastValidRevisionId);
      }
      lastValidRevisionId = itemRevisionId;
    }
    return { ok: true as const, document };
  }

  private reconstruct(catalogId: CatalogId, entryId: EntryId, revisionId: DevelopRevisionId) {
    const result = this.tryReconstruct(catalogId, entryId, revisionId);
    if (!result.ok) throw new Error(result.corruption.message);
    return result.document;
  }

  private recoveryRevision(catalogId: CatalogId, entryId: EntryId, revisionId: DevelopRevisionId): DevelopHistoryRecoveryRevision | null {
    const result = this.tryReconstruct(catalogId, entryId, revisionId);
    if (!result.ok) return null;
    return { ...this.revisionFromRow(this.revisionRow(catalogId, entryId, revisionId)), document: result.document };
  }

  loadRetainedRevision(catalogId: CatalogId, entryId: EntryId, revisionId: DevelopRevisionId): DevelopHistoryRecoveryRevision {
    this.assertActiveEntry(catalogId, entryId);
    const revision = this.recoveryRevision(catalogId, entryId, revisionId);
    if (revision === null) throw new Error("Develop history Receipt revision needs recovery.");
    return revision;
  }

  private latestValidRecoveryRevision(catalogId: CatalogId, entryId: EntryId): DevelopHistoryRecoveryRevision | null {
    const candidates = this.database.prepare(`${REVISION_SELECT} WHERE catalog_id = ? AND entry_id = ? ORDER BY ordinal DESC`)
      .all(catalogId, entryId);
    for (const candidate of candidates) {
      const item = row(candidate, "Develop history recovery candidate");
      const revision = this.recoveryRevision(catalogId, entryId, parseDevelopRevisionId(string(item, "revisionId")));
      if (revision !== null) return revision;
    }
    return null;
  }

  load(inputValue: DevelopHistoryLoadInput): DevelopHistoryLoadResult {
    const input = parseDevelopHistoryLoadInput(inputValue);
    this.assertActiveEntry(input.catalogId, input.entryId);
    let headRevisionId: DevelopRevisionId;
    try {
      headRevisionId = this.headId(input.catalogId, input.entryId);
    } catch {
      const lastValidRevision = this.latestValidRecoveryRevision(input.catalogId, input.entryId);
      return { kind: "recovery", catalogId: input.catalogId, entryId: input.entryId, requestedRevisionId: input.revisionId, headRevisionId: null, lastValidRevision, corruption: { kind: "missing-head", message: "Develop history Head is missing.", failedRevisionId: null } };
    }
    const revisionId = input.revisionId ?? headRevisionId;
    if (input.revisionId !== null && input.revisionId !== headRevisionId) {
      const visible = this.database.prepare(`
        SELECT 1
        FROM develop_history_revisions AS r
        JOIN develop_history_heads AS h
          ON h.catalog_id = r.catalog_id AND h.entry_id = r.entry_id
        WHERE r.catalog_id = ? AND r.entry_id = ? AND r.revision_id = ?
          AND (r.ordinal >= h.retention_floor_ordinal OR EXISTS (
            SELECT 1 FROM develop_history_refs AS f
            WHERE f.catalog_id = r.catalog_id AND f.entry_id = r.entry_id
              AND f.revision_id = r.revision_id
          ))
      `).get(input.catalogId, input.entryId, input.revisionId);
      if (visible === undefined) throw new Error("Develop history revision is outside the retained history window.");
    }
    const result = this.tryReconstruct(input.catalogId, input.entryId, revisionId);
    if (!result.ok) {
      const lastValidRevision = result.lastValidRevisionId === null
        ? this.latestValidRecoveryRevision(input.catalogId, input.entryId)
        : this.recoveryRevision(input.catalogId, input.entryId, result.lastValidRevisionId);
      return { kind: "recovery", catalogId: input.catalogId, entryId: input.entryId, requestedRevisionId: input.revisionId, headRevisionId, lastValidRevision, corruption: result.corruption };
    }
    const item = this.revisionRow(input.catalogId, input.entryId, revisionId);
    return { kind: "loaded", value: { ...this.revisionFromRow(item), document: result.document, headRevisionId } };
  }

  list(inputValue: DevelopHistoryListInput): readonly DevelopHistoryRevision[] {
    const input = parseDevelopHistoryListInput(inputValue);
    this.assertActiveEntry(input.catalogId, input.entryId);
    return this.database.prepare(`${REVISION_SELECT}
      WHERE catalog_id = ? AND entry_id = ? AND ordinal >= COALESCE((
        SELECT retention_floor_ordinal FROM develop_history_heads WHERE catalog_id = ? AND entry_id = ?
      ), 0)
      ORDER BY ordinal DESC LIMIT ?`)
      .all(input.catalogId, input.entryId, input.catalogId, input.entryId, input.limit).map((item) => this.revisionFromRow(item));
  }

  projection(catalogIdValue: CatalogId, entryIdValue: EntryId): DevelopHistoryProjection | null {
    const catalogId = parseCatalogId(catalogIdValue);
    const entryId = parseEntryId(entryIdValue);
    this.assertActiveEntry(catalogId, entryId);
    const value = this.database.prepare(`
      SELECT catalog_id AS catalogId, entry_id AS entryId, revision_id AS revisionId,
             content_sha256 AS contentSha256, projected_at AS projectedAt
      FROM develop_xmp_projections WHERE catalog_id = ? AND entry_id = ?
    `).get(catalogId, entryId);
    return value === undefined ? null : parseDevelopHistoryProjectionWriteInput(value);
  }

  recordProjection(inputValue: DevelopHistoryProjectionWriteInput): DevelopHistoryProjection {
    const input = parseDevelopHistoryProjectionWriteInput(inputValue);
    return this.transaction(() => {
      this.assertActiveEntry(input.catalogId, input.entryId);
      this.revisionRow(input.catalogId, input.entryId, input.revisionId);
      this.database.prepare(`
        INSERT INTO develop_xmp_projections (
          catalog_id, entry_id, revision_id, content_sha256, projected_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (catalog_id, entry_id) DO UPDATE SET
          revision_id = excluded.revision_id,
          content_sha256 = excluded.content_sha256,
          projected_at = excluded.projected_at
      `).run(input.catalogId, input.entryId, input.revisionId, input.contentSha256, input.projectedAt);
      return input;
    });
  }

  commit(inputValue: DevelopHistoryCommitInput, alreadyInTransaction = false): DevelopHistoryCommitResult {
    const input = parseDevelopHistoryCommitInput(inputValue);
    const run = () => {
      this.assertActiveEntry(input.catalogId, input.entryId);
      const documentJson = canonicalDevelopHistoryDocument(input.document);
      const requestHash = sha256(canonicalDevelopHistoryJson({
        revisionId: input.revisionId,
        expectedParentRevisionId: input.expectedParentRevisionId,
        operationId: input.operationId,
        label: input.label,
        document: JSON.parse(documentJson),
        createdAt: input.createdAt,
      }));
      const existing = this.database.prepare(`${REVISION_SELECT} WHERE catalog_id = ? AND entry_id = ? AND operation_id = ?`).get(input.catalogId, input.entryId, input.operationId);
      if (existing !== undefined) {
        const existingRow = row(existing, "Develop history idempotent revision");
        let existingRequestHash = existingRow.requestHash === null ? null : string(existingRow, "requestHash");
        if (existingRequestHash === null) {
          const existingRevision = this.revisionFromRow(existingRow);
          const existingDocument = this.reconstruct(input.catalogId, input.entryId, existingRevision.revisionId);
          existingRequestHash = sha256(canonicalDevelopHistoryJson({
            revisionId: existingRevision.revisionId,
            expectedParentRevisionId: existingRevision.parentRevisionId,
            operationId: existingRevision.operationId,
            label: existingRevision.label,
            document: JSON.parse(canonicalDevelopHistoryDocument(existingDocument)),
            createdAt: existingRevision.createdAt,
          }));
          this.database.prepare("UPDATE develop_history_revisions SET request_sha256 = ? WHERE catalog_id = ? AND entry_id = ? AND revision_id = ? AND request_sha256 IS NULL")
            .run(existingRequestHash, input.catalogId, input.entryId, existingRevision.revisionId);
        }
        if (existingRequestHash !== requestHash) throw new Error("Develop history operation ID conflicts with a different request.");
        return { revision: this.revisionFromRow(existing), idempotent: true };
      }
      const headRevisionId = this.headId(input.catalogId, input.entryId);
      if (headRevisionId !== input.expectedParentRevisionId) throw new Error("Develop history parent is stale.");
      if (this.database.prepare("SELECT 1 FROM develop_history_revisions WHERE catalog_id = ? AND entry_id = ? AND revision_id = ?").get(input.catalogId, input.entryId, input.revisionId) !== undefined) throw new Error("Develop history revision ID already exists.");
      const parentRow = this.revisionRow(input.catalogId, input.entryId, headRevisionId);
      const ordinal = integer(parentRow, "ordinal") + 1;
      const before = this.reconstruct(input.catalogId, input.entryId, headRevisionId);
      const patch = diffDevelopHistory(before, input.document);
      const patchJson = JSON.stringify(patch);
      const patchBytes = new TextEncoder().encode(patchJson).byteLength;
      const accumulatedRow = this.database.prepare(`
        SELECT COALESCE(SUM(length(CAST(patch_json AS BLOB))), 0) AS bytes
        FROM develop_history_revisions
        WHERE catalog_id = ? AND entry_id = ? AND ordinal > COALESCE((
          SELECT MAX(ordinal) FROM develop_history_revisions
          WHERE catalog_id = ? AND entry_id = ? AND checkpoint_json IS NOT NULL
        ), 0)
      `).get(input.catalogId, input.entryId, input.catalogId, input.entryId);
      const accumulatedPatchBytes = integer(row(accumulatedRow, "Develop history accumulated patch size"), "bytes");
      const checkpoint = ordinal % DEVELOP_HISTORY_CHECKPOINT_INTERVAL === 0 || accumulatedPatchBytes + patchBytes >= DEVELOP_HISTORY_EARLY_CHECKPOINT_BYTES;
      const storedJson = checkpoint ? documentJson : JSON.stringify(parseDevelopHistoryPatch(patch));
      const storedBytes = new TextEncoder().encode(storedJson).byteLength;
      this.assertStorageCapacity(input.catalogId, input.entryId, storedBytes);
      const hash = sha256(documentJson);
      this.database.prepare(`
        INSERT INTO develop_history_revisions (
          catalog_id, entry_id, revision_id, parent_revision_id, operation_id, ordinal,
          label, request_sha256, assets_indexed, document_sha256, checkpoint_json, patch_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(input.catalogId, input.entryId, input.revisionId, headRevisionId, input.operationId, ordinal, input.label, requestHash, hash, checkpoint ? storedJson : null, checkpoint ? null : storedJson, input.createdAt);
      for (const assetHash of collectDevelopHistoryAssetHashes(input.document)) {
        this.database.prepare("INSERT INTO develop_revision_assets (catalog_id, entry_id, revision_id, asset_sha256) VALUES (?, ?, ?, ?)")
          .run(input.catalogId, input.entryId, input.revisionId, assetHash);
      }
      const retentionFloor = Math.max(0, ordinal - DEVELOP_HISTORY_RETAINED_REVISIONS + 1);
      const headUpdate = this.database.prepare("UPDATE develop_history_heads SET revision_id = ?, updated_at = ?, retention_floor_ordinal = ? WHERE catalog_id = ? AND entry_id = ? AND revision_id = ?")
        .run(input.revisionId, input.createdAt, retentionFloor, input.catalogId, input.entryId, headRevisionId);
      if (headUpdate.changes !== 1) throw new Error("Develop history parent is stale.");
      const metadataUpdate = this.database.prepare("UPDATE entry_metadata SET develop_json = ?, develop_updated_at = ?, updated_at = ? WHERE catalog_id = ? AND entry_id = ?")
        .run(documentJson, input.createdAt, input.createdAt, input.catalogId, input.entryId);
      if (metadataUpdate.changes !== 1) throw new Error("Develop history metadata is missing.");
      return { revision: this.revisionFromRow(this.revisionRow(input.catalogId, input.entryId, input.revisionId)), idempotent: false };
    };
    return alreadyInTransaction ? run() : this.transaction(run);
  }

  refs(catalogIdValue: CatalogId, entryIdValue: EntryId): readonly DevelopHistoryRef[] {
    const catalogId = parseCatalogId(catalogIdValue);
    const entryId = parseEntryId(entryIdValue);
    this.assertActiveEntry(catalogId, entryId);
    return this.database.prepare(`
      SELECT catalog_id AS catalogId, entry_id AS entryId, ref_id AS refId, kind,
             name, revision_id AS revisionId, created_at AS createdAt, updated_at AS updatedAt
      FROM develop_history_refs WHERE catalog_id = ? AND entry_id = ? ORDER BY kind, created_at, ref_id
    `).all(catalogId, entryId).map(parseDevelopHistoryRef);
  }

  mutateRef(inputValue: DevelopHistoryRefMutationInput): readonly DevelopHistoryRef[] {
    const input = parseDevelopHistoryRefMutationInput(inputValue);
    return this.transaction(() => {
      this.assertActiveEntry(input.catalogId, input.entryId);
      if (input.kind === "create") {
        const countRow = row(this.database.prepare("SELECT COUNT(*) AS count FROM develop_history_refs WHERE catalog_id = ? AND entry_id = ? AND kind = ?").get(input.catalogId, input.entryId, input.refKind), "Develop history ref count");
        if (integer(countRow, "count") >= DEVELOP_HISTORY_MAX_REFS_PER_KIND) throw new Error(`Develop history ${input.refKind} limit reached.`);
        this.revisionRow(input.catalogId, input.entryId, input.revisionId);
        this.database.prepare("INSERT INTO develop_history_refs (catalog_id, entry_id, ref_id, kind, name, revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(input.catalogId, input.entryId, input.refId, input.refKind, input.name, input.revisionId, input.createdAt, input.createdAt);
      } else if (input.kind === "rename") {
        const result = this.database.prepare("UPDATE develop_history_refs SET name = ?, updated_at = ? WHERE catalog_id = ? AND entry_id = ? AND ref_id = ?")
          .run(input.name, input.updatedAt, input.catalogId, input.entryId, input.refId);
        if (result.changes !== 1) throw new Error("Develop history ref is missing.");
      } else if (input.kind === "move") {
        const existing = this.database.prepare("SELECT kind FROM develop_history_refs WHERE catalog_id = ? AND entry_id = ? AND ref_id = ?")
          .get(input.catalogId, input.entryId, input.refId);
        if (existing === undefined) throw new Error("Develop history ref is missing.");
        if (string(row(existing, "Develop history ref"), "kind") === "snapshot") throw new Error("Develop history snapshots are fixed and cannot move.");
        this.revisionRow(input.catalogId, input.entryId, input.revisionId);
        this.database.prepare("UPDATE develop_history_refs SET revision_id = ?, updated_at = ? WHERE catalog_id = ? AND entry_id = ? AND ref_id = ?")
          .run(input.revisionId, input.updatedAt, input.catalogId, input.entryId, input.refId);
      } else {
        const result = this.database.prepare("DELETE FROM develop_history_refs WHERE catalog_id = ? AND entry_id = ? AND ref_id = ?")
          .run(input.catalogId, input.entryId, input.refId);
        if (result.changes !== 1) throw new Error("Develop history ref is missing.");
      }
      return this.refs(input.catalogId, input.entryId);
    });
  }
}
