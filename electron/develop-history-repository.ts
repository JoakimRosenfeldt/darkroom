import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { parseCatalogId, parseEntryId, type CatalogId, type EntryId } from "../lib/catalog/ids.ts";
import {
  DEVELOP_HISTORY_CHECKPOINT_INTERVAL,
  DEVELOP_HISTORY_EARLY_CHECKPOINT_BYTES,
  DEVELOP_HISTORY_MAX_REFS_PER_KIND,
  canonicalDevelopHistoryJson,
  diffDevelopHistory,
  parseDevelopDocumentHash,
  parseDevelopHistoryCommitInput,
  parseDevelopHistoryJson,
  parseDevelopHistoryListInput,
  parseDevelopHistoryLoadInput,
  parseDevelopHistoryPatch,
  parseDevelopHistoryRef,
  parseDevelopHistoryRefMutationInput,
  parseDevelopHistoryRevision,
  parseDevelopRevisionId,
  replayDevelopHistory,
  type DevelopHistoryCommitInput,
  type DevelopHistoryCommitResult,
  type DevelopHistoryJson,
  type DevelopHistoryListInput,
  type DevelopHistoryLoadInput,
  type DevelopHistoryLoadedRevision,
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
         ordinal, label, document_sha256 AS documentHash,
         checkpoint_json AS checkpointJson, patch_json AS patchJson, created_at AS createdAt
  FROM develop_history_revisions
`;

export class DevelopHistoryRepository {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
    upgradeDevelopHistorySchema(database);
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
          label, document_sha256, checkpoint_json, patch_json, created_at
        ) VALUES (?, ?, ?, NULL, ?, 0, 'Imported current edit', ?, ?, NULL, ?)
      `);
      const insertHead = this.database.prepare("INSERT INTO develop_history_heads (catalog_id, entry_id, revision_id, updated_at) VALUES (?, ?, ?, ?)");
      for (const value of missing) {
        const item = row(value, "Develop history root row");
        const document = item.developJson === null
          ? null
          : JSON.parse(string(item, "developJson")) as unknown;
        const checkpointJson = canonicalDevelopHistoryJson(document);
        const revisionId = randomUUID();
        const createdAt = number(item, "createdAt");
        insertRevision.run(string(item, "catalogId"), string(item, "entryId"), revisionId, randomUUID(), sha256(checkpointJson), checkpointJson, createdAt);
        insertHead.run(string(item, "catalogId"), string(item, "entryId"), revisionId, createdAt);
      }
    };
    if (alreadyInTransaction) run(); else this.transaction(run);
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

  private reconstruct(catalogId: CatalogId, entryId: EntryId, revisionId: DevelopRevisionId): DevelopHistoryJson {
    const chain: Row[] = [];
    const seen = new Set<string>();
    let current = revisionId;
    while (true) {
      if (seen.has(current)) throw new Error("Develop history contains a revision cycle.");
      seen.add(current);
      const item = this.revisionRow(catalogId, entryId, current);
      chain.push(item);
      if (item.checkpointJson !== null) break;
      const parent = nullableString(item, "parentRevisionId");
      if (parent === null || chain.length > DEVELOP_HISTORY_CHECKPOINT_INTERVAL) throw new Error("Develop history checkpoint chain is invalid.");
      current = parseDevelopRevisionId(parent);
    }
    const checkpoint = chain.pop()!;
    let document = parseDevelopHistoryJson(JSON.parse(string(checkpoint, "checkpointJson")));
    const checkpointHash = sha256(canonicalDevelopHistoryJson(document));
    if (checkpointHash !== parseDevelopDocumentHash(string(checkpoint, "documentHash"))) throw new Error("Develop history checkpoint hash is corrupt.");
    for (const item of chain.reverse()) {
      document = replayDevelopHistory(document, JSON.parse(string(item, "patchJson")));
      if (sha256(canonicalDevelopHistoryJson(document)) !== parseDevelopDocumentHash(string(item, "documentHash"))) throw new Error("Develop history revision hash is corrupt.");
    }
    return document;
  }

  load(inputValue: DevelopHistoryLoadInput): DevelopHistoryLoadedRevision {
    const input = parseDevelopHistoryLoadInput(inputValue);
    const headRevisionId = this.headId(input.catalogId, input.entryId);
    const revisionId = input.revisionId ?? headRevisionId;
    const item = this.revisionRow(input.catalogId, input.entryId, revisionId);
    return { ...this.revisionFromRow(item), document: this.reconstruct(input.catalogId, input.entryId, revisionId), headRevisionId };
  }

  list(inputValue: DevelopHistoryListInput): readonly DevelopHistoryRevision[] {
    const input = parseDevelopHistoryListInput(inputValue);
    return this.database.prepare(`${REVISION_SELECT} WHERE catalog_id = ? AND entry_id = ? ORDER BY ordinal DESC LIMIT ?`)
      .all(input.catalogId, input.entryId, input.limit).map((item) => this.revisionFromRow(item));
  }

  commit(inputValue: DevelopHistoryCommitInput): DevelopHistoryCommitResult {
    const input = parseDevelopHistoryCommitInput(inputValue);
    return this.transaction(() => {
      const existing = this.database.prepare(`${REVISION_SELECT} WHERE catalog_id = ? AND entry_id = ? AND operation_id = ?`).get(input.catalogId, input.entryId, input.operationId);
      if (existing !== undefined) return { revision: this.revisionFromRow(existing), idempotent: true };
      const headRevisionId = this.headId(input.catalogId, input.entryId);
      if (headRevisionId !== input.expectedParentRevisionId) throw new Error("Develop history parent is stale.");
      if (this.database.prepare("SELECT 1 FROM develop_history_revisions WHERE catalog_id = ? AND entry_id = ? AND revision_id = ?").get(input.catalogId, input.entryId, input.revisionId) !== undefined) throw new Error("Develop history revision ID already exists.");
      const parentRow = this.revisionRow(input.catalogId, input.entryId, headRevisionId);
      const ordinal = integer(parentRow, "ordinal") + 1;
      const before = this.reconstruct(input.catalogId, input.entryId, headRevisionId);
      const patch = diffDevelopHistory(before, input.document);
      const patchJson = JSON.stringify(patch);
      const checkpoint = ordinal % DEVELOP_HISTORY_CHECKPOINT_INTERVAL === 0 || new TextEncoder().encode(patchJson).byteLength >= DEVELOP_HISTORY_EARLY_CHECKPOINT_BYTES;
      const documentJson = canonicalDevelopHistoryJson(input.document);
      const hash = sha256(documentJson);
      this.database.prepare(`
        INSERT INTO develop_history_revisions (
          catalog_id, entry_id, revision_id, parent_revision_id, operation_id, ordinal,
          label, document_sha256, checkpoint_json, patch_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.catalogId, input.entryId, input.revisionId, headRevisionId, input.operationId, ordinal, input.label, hash, checkpoint ? documentJson : null, checkpoint ? null : JSON.stringify(parseDevelopHistoryPatch(patch)), input.createdAt);
      const headUpdate = this.database.prepare("UPDATE develop_history_heads SET revision_id = ?, updated_at = ? WHERE catalog_id = ? AND entry_id = ? AND revision_id = ?")
        .run(input.revisionId, input.createdAt, input.catalogId, input.entryId, headRevisionId);
      if (headUpdate.changes !== 1) throw new Error("Develop history parent is stale.");
      const metadataUpdate = this.database.prepare("UPDATE entry_metadata SET develop_json = ?, develop_updated_at = ?, updated_at = ? WHERE catalog_id = ? AND entry_id = ?")
        .run(documentJson, input.createdAt, input.createdAt, input.catalogId, input.entryId);
      if (metadataUpdate.changes !== 1) throw new Error("Develop history metadata is missing.");
      return { revision: this.revisionFromRow(this.revisionRow(input.catalogId, input.entryId, input.revisionId)), idempotent: false };
    });
  }

  refs(catalogIdValue: CatalogId, entryIdValue: EntryId): readonly DevelopHistoryRef[] {
    const catalogId = parseCatalogId(catalogIdValue);
    const entryId = parseEntryId(entryIdValue);
    return this.database.prepare(`
      SELECT catalog_id AS catalogId, entry_id AS entryId, ref_id AS refId, kind,
             name, revision_id AS revisionId, created_at AS createdAt, updated_at AS updatedAt
      FROM develop_history_refs WHERE catalog_id = ? AND entry_id = ? ORDER BY kind, created_at, ref_id
    `).all(catalogId, entryId).map(parseDevelopHistoryRef);
  }

  mutateRef(inputValue: DevelopHistoryRefMutationInput): readonly DevelopHistoryRef[] {
    const input = parseDevelopHistoryRefMutationInput(inputValue);
    return this.transaction(() => {
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
      } else {
        const result = this.database.prepare("DELETE FROM develop_history_refs WHERE catalog_id = ? AND entry_id = ? AND ref_id = ?")
          .run(input.catalogId, input.entryId, input.refId);
        if (result.changes !== 1) throw new Error("Develop history ref is missing.");
      }
      return this.refs(input.catalogId, input.entryId);
    });
  }
}
