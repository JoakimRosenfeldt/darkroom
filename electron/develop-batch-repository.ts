import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseCatalogId, parseEntryId, parseOperationId, parseSourceId, type CatalogId, type EntryId, type SourceId } from "../lib/catalog/ids.ts";
import {
  DEVELOP_BATCH_MAX_CATALOG_BYTES,
  DEVELOP_BATCH_MAX_JOBS_PER_CATALOG,
  DEVELOP_BATCH_MAX_JOB_BYTES,
  DEVELOP_BATCH_SCHEMA_VERSION,
  canonicalDevelopBatchJson,
  createDevelopBatchOperationId,
  parseDevelopBatchCreateInput,
  parseDevelopBatchId,
  parseDevelopBatchItemState,
  parseDevelopBatchOperation,
  parseDevelopBatchReceipt,
  type DevelopBatchCreateInput,
  type DevelopBatchId,
  type DevelopBatchItemState,
  type DevelopBatchOperation,
  type DevelopBatchOperationId,
  type DevelopBatchReceipt,
  type DevelopBatchReceiptItem,
} from "../lib/develop/batch/domain.ts";
import { runDurableDevelopBatch } from "../lib/develop/batch/runner.ts";
import { createDevelopRevisionId, parseDevelopRevisionId, type DevelopHistoryDocument, type DevelopRevisionId } from "../lib/develop/history.ts";
import type { DevelopPresetField } from "../lib/develop/presets/policy.ts";
import type { DevelopDocumentV3 } from "../lib/develop/v3/document.ts";
import { upgradeDevelopBatchSchema } from "./develop-batch-schema.ts";
import type { DevelopBatchExecutionInput, DevelopBatchExecutionResult } from "./develop-batch-executor.ts";
import { DevelopHistoryRepository } from "./develop-history-repository.ts";

type Row = Record<string, unknown>;
export type DevelopBatchOperationExecutor = (input: DevelopBatchExecutionInput) => DevelopBatchExecutionResult;

type PreparedBatchItem =
  | { readonly kind: "terminal"; readonly state: DevelopBatchItemState }
  | { readonly kind: "ready"; readonly document: DevelopHistoryDocument; readonly warnings: readonly string[] };

export interface DevelopBatchFreezeInput {
  readonly catalogId: CatalogId;
  readonly batchId: DevelopBatchId;
  readonly operationId: DevelopBatchOperationId;
  readonly kind: "sync" | "batch";
  readonly sourceEntryId: EntryId | null;
  readonly targetEntryIds: readonly EntryId[];
  readonly operation: Exclude<DevelopBatchOperation, { readonly kind: "undo" }>;
  readonly createdAt: number;
}

function row(value: unknown, label: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Row;
}
function string(value: Row, key: string): string {
  const item = value[key];
  if (typeof item !== "string") throw new Error(`Develop batch ${key} is invalid.`);
  return item;
}
function number(value: Row, key: string): number {
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item)) throw new Error(`Develop batch ${key} is invalid.`);
  return item;
}
function integer(value: Row, key: string): number {
  const item = number(value, key);
  if (!Number.isSafeInteger(item)) throw new Error(`Develop batch ${key} is invalid.`);
  return item;
}
function nullableString(value: Row, key: string): string | null { return value[key] === null ? null : string(value, key); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalDevelopBatchJson(value)).digest("hex"); }
function stateJson(state: DevelopBatchItemState): string { return canonicalDevelopBatchJson(state); }
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Develop batch execution failed.").replaceAll("\0", "").slice(0, 1_024) || "Develop batch execution failed.";
}
function v3Document(value: DevelopHistoryDocument): DevelopDocumentV3 | null {
  return value !== null && value.version === 3 && value.process === "darkroom-v3" && "tone" in value
    ? value as unknown as DevelopDocumentV3
    : null;
}

export class DevelopBatchRepository {
  private readonly database: DatabaseSync;
  private readonly history: DevelopHistoryRepository;
  private readonly executeOperation: DevelopBatchOperationExecutor;
  private transactionDepth = 0;

  constructor(database: DatabaseSync, executeOperation: DevelopBatchOperationExecutor) {
    this.database = database;
    upgradeDevelopBatchSchema(database);
    this.history = new DevelopHistoryRepository(database);
    this.executeOperation = executeOperation;
    this.reclaimActive();
  }

  private transaction<T>(run: () => T): T {
    if (this.transactionDepth > 0) return run();
    let active = false;
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      active = true;
      this.transactionDepth += 1;
      const result = run();
      this.transactionDepth -= 1;
      this.database.exec("COMMIT;");
      active = false;
      return result;
    } catch (error) {
      this.transactionDepth = 0;
      if (active) try { this.database.exec("ROLLBACK;"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private reclaimActive(): void {
    this.database.prepare(`
      UPDATE develop_batch_items
      SET state_json = '{"kind":"queued"}', before_revision_id = NULL, after_revision_id = NULL
      WHERE json_extract(state_json, '$.kind') = 'active'
    `).run();
  }

  private activeHead(catalogId: CatalogId, entryId: EntryId): DevelopRevisionId {
    const loaded = this.history.load({ catalogId, entryId, revisionId: null });
    if (loaded.kind !== "loaded") throw new Error("Develop history needs recovery.");
    return loaded.value.headRevisionId;
  }

  private sourceId(catalogId: CatalogId, entryId: EntryId): SourceId {
    const value = this.database.prepare(`
      SELECT source_id AS sourceId FROM edit_entries
      WHERE catalog_id = ? AND entry_id = ? AND tombstoned_at IS NULL
    `).get(catalogId, entryId);
    if (value === undefined) throw new Error("Develop batch entry is inactive or missing.");
    return parseSourceId(string(row(value, "Develop batch source"), "sourceId"));
  }

  private metadataBytes(catalogId: CatalogId): number {
    const jobs = row(this.database.prepare(`
      SELECT COALESCE(SUM(length(CAST(operation_json AS BLOB)) + length(CAST(targets_json AS BLOB))), 0) AS bytes
      FROM develop_batch_jobs WHERE catalog_id = ?
    `).get(catalogId), "Develop batch job bytes");
    const items = row(this.database.prepare(`
      SELECT COALESCE(SUM(length(CAST(state_json AS BLOB))), 0) AS bytes
      FROM develop_batch_items WHERE catalog_id = ?
    `).get(catalogId), "Develop batch item bytes");
    return integer(jobs, "bytes") + integer(items, "bytes");
  }

  private jobRow(catalogId: CatalogId, batchId: DevelopBatchId): Row {
    const value = this.database.prepare(`
      SELECT catalog_id AS catalogId, batch_id AS batchId, operation_id AS operationId,
             request_sha256 AS requestHash, kind, source_entry_id AS sourceEntryId,
             source_revision_id AS sourceRevisionId, operation_json AS operationJson,
             targets_json AS targetsJson, cancellation_requested AS cancellationRequested,
             created_at AS createdAt, updated_at AS updatedAt
      FROM develop_batch_jobs WHERE catalog_id = ? AND batch_id = ?
    `).get(catalogId, batchId);
    if (value === undefined) throw new Error("Develop batch Receipt is missing.");
    return row(value, "Develop batch job");
  }

  private itemRows(catalogId: CatalogId, batchId: DevelopBatchId): readonly Row[] {
    return this.database.prepare(`
      SELECT position, entry_id AS entryId, operation_id AS operationId,
             planned_revision_id AS plannedRevisionId, expected_revision_id AS expectedRevisionId,
             before_revision_id AS beforeRevisionId, after_revision_id AS afterRevisionId,
             restore_revision_id AS restoreRevisionId, state_json AS stateJson,
             attempts, updated_at AS updatedAt
      FROM develop_batch_items WHERE catalog_id = ? AND batch_id = ? ORDER BY position
    `).all(catalogId, batchId).map((value) => row(value, "Develop batch item"));
  }

  private existingReceipt(catalogId: CatalogId, operationId: DevelopBatchOperationId): DevelopBatchReceipt | null {
    const value = this.database.prepare(`
      SELECT batch_id AS batchId FROM develop_batch_jobs
      WHERE catalog_id = ? AND operation_id = ?
    `).get(catalogId, operationId);
    return value === undefined
      ? null
      : this.get(catalogId, parseDevelopBatchId(string(row(value, "Develop batch replay"), "batchId")));
  }

  get(catalogIdValue: CatalogId, batchIdValue: DevelopBatchId): DevelopBatchReceipt {
    const catalogId = parseCatalogId(catalogIdValue);
    const batchId = parseDevelopBatchId(batchIdValue);
    const job = this.jobRow(catalogId, batchId);
    const targetEntryIds = JSON.parse(string(job, "targetsJson")) as unknown;
    const operation = JSON.parse(string(job, "operationJson")) as unknown;
    const items = this.itemRows(catalogId, batchId).map((item) => ({
      position: integer(item, "position"), entryId: string(item, "entryId"), operationId: string(item, "operationId"),
      plannedRevisionId: string(item, "plannedRevisionId"), expectedRevisionId: string(item, "expectedRevisionId"),
      beforeRevisionId: nullableString(item, "beforeRevisionId"), afterRevisionId: nullableString(item, "afterRevisionId"),
      restoreRevisionId: nullableString(item, "restoreRevisionId"), state: JSON.parse(string(item, "stateJson")) as unknown,
      attempts: integer(item, "attempts"), updatedAt: number(item, "updatedAt"),
    }));
    return parseDevelopBatchReceipt({
      schemaVersion: DEVELOP_BATCH_SCHEMA_VERSION, catalogId: string(job, "catalogId"), batchId: string(job, "batchId"),
      operationId: string(job, "operationId"), kind: string(job, "kind"), sourceEntryId: nullableString(job, "sourceEntryId"),
      sourceRevisionId: nullableString(job, "sourceRevisionId"), targetEntryIds, operation, items,
      cancellationRequested: integer(job, "cancellationRequested") === 1,
      createdAt: number(job, "createdAt"), updatedAt: number(job, "updatedAt"),
    });
  }

  list(catalogIdValue: CatalogId, limitValue = 100): readonly DevelopBatchReceipt[] {
    const catalogId = parseCatalogId(catalogIdValue);
    const limit = Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 1_000 ? limitValue : 100;
    return this.database.prepare("SELECT batch_id AS batchId FROM develop_batch_jobs WHERE catalog_id = ? ORDER BY created_at DESC, batch_id LIMIT ?")
      .all(catalogId, limit).map((value) => this.get(catalogId, parseDevelopBatchId(string(row(value, "Develop batch list row"), "batchId"))));
  }

  create(inputValue: DevelopBatchCreateInput): DevelopBatchReceipt {
    const input = parseDevelopBatchCreateInput(inputValue);
    const requestHash = digest(input);
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT batch_id AS batchId, request_sha256 AS requestHash FROM develop_batch_jobs WHERE catalog_id = ? AND operation_id = ?")
        .get(input.catalogId, input.operationId);
      if (existing !== undefined) {
        const existingRow = row(existing, "Develop batch idempotent job");
        if (string(existingRow, "requestHash") !== requestHash || string(existingRow, "batchId") !== input.batchId) {
          throw new Error("Develop batch operation ID conflicts with a different request.");
        }
        return this.get(input.catalogId, input.batchId);
      }
      const count = integer(row(this.database.prepare("SELECT COUNT(*) AS count FROM develop_batch_jobs WHERE catalog_id = ?").get(input.catalogId), "Develop batch job count"), "count");
      if (count >= DEVELOP_BATCH_MAX_JOBS_PER_CATALOG) throw new Error("Develop batch catalog job limit reached.");
      if (input.sourceEntryId !== null) {
        this.sourceId(input.catalogId, input.sourceEntryId);
        if (this.activeHead(input.catalogId, input.sourceEntryId) !== input.sourceRevisionId) throw new Error("Develop batch source revision is stale.");
      }
      for (const target of input.targets) {
        this.sourceId(input.catalogId, target.entryId);
        if (input.kind !== "auto-sync" && this.activeHead(input.catalogId, target.entryId) !== target.expectedRevisionId) {
          throw new Error("Develop batch target revision is stale.");
        }
      }
      const operationJson = canonicalDevelopBatchJson(input.operation);
      const targetsJson = canonicalDevelopBatchJson(input.targets.map((target) => target.entryId));
      const queuedJson = stateJson({ kind: "queued" });
      const addedBytes = new TextEncoder().encode(operationJson + targetsJson).byteLength + input.targets.length * new TextEncoder().encode(queuedJson).byteLength;
      if (addedBytes > DEVELOP_BATCH_MAX_JOB_BYTES || this.metadataBytes(input.catalogId) + addedBytes > DEVELOP_BATCH_MAX_CATALOG_BYTES) throw new Error("Develop batch metadata limit exceeded.");
      this.database.prepare(`
        INSERT INTO develop_batch_jobs (
          catalog_id, batch_id, operation_id, request_sha256, schema_version, kind,
          source_entry_id, source_revision_id, operation_json, targets_json,
          cancellation_requested, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(input.catalogId, input.batchId, input.operationId, requestHash, input.kind, input.sourceEntryId, input.sourceRevisionId, operationJson, targetsJson, input.createdAt, input.createdAt);
      const insert = this.database.prepare(`
        INSERT INTO develop_batch_items (
          catalog_id, batch_id, position, entry_id, operation_id, planned_revision_id,
          expected_revision_id, before_revision_id, after_revision_id, restore_revision_id,
          state_json, attempts, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, ?)
      `);
      input.targets.forEach((target, position) => insert.run(
        input.catalogId, input.batchId, position, target.entryId, createDevelopBatchOperationId(),
        createDevelopRevisionId(), target.expectedRevisionId, queuedJson, input.createdAt,
      ));
      return this.get(input.catalogId, input.batchId);
    });
  }

  freeze(input: DevelopBatchFreezeInput): DevelopBatchReceipt {
    if (input.targetEntryIds.length === 0 || new Set(input.targetEntryIds).size !== input.targetEntryIds.length) throw new Error("Develop batch target selection is invalid.");
    const existing = this.existingReceipt(input.catalogId, input.operationId);
    if (existing !== null) {
      const matches = existing.batchId === input.batchId && existing.kind === input.kind
        && existing.sourceEntryId === input.sourceEntryId && existing.createdAt === input.createdAt
        && canonicalDevelopBatchJson(existing.targetEntryIds) === canonicalDevelopBatchJson(input.targetEntryIds)
        && canonicalDevelopBatchJson(existing.operation) === canonicalDevelopBatchJson(input.operation);
      if (!matches) throw new Error("Develop batch operation ID conflicts with a different request.");
      return existing;
    }
    const sourceRevisionId = input.sourceEntryId === null ? null : this.activeHead(input.catalogId, input.sourceEntryId);
    return this.create({
      schemaVersion: DEVELOP_BATCH_SCHEMA_VERSION, catalogId: input.catalogId, batchId: input.batchId,
      operationId: input.operationId, kind: input.kind, sourceEntryId: input.sourceEntryId, sourceRevisionId,
      targets: input.targetEntryIds.map((entryId) => ({ entryId, expectedRevisionId: this.activeHead(input.catalogId, entryId) })),
      operation: input.operation, createdAt: input.createdAt,
    });
  }

  previous(input: {
    readonly catalogId: CatalogId; readonly batchId: DevelopBatchId; readonly operationId: DevelopBatchOperationId;
    readonly currentEntryId: EntryId; readonly fields: readonly DevelopPresetField[]; readonly createdAt: number;
  }): DevelopBatchReceipt {
    const existing = this.existingReceipt(input.catalogId, input.operationId);
    if (existing !== null) {
      const matches = existing.batchId === input.batchId && existing.kind === "previous"
        && existing.createdAt === input.createdAt && existing.targetEntryIds.length === 1
        && existing.targetEntryIds[0] === input.currentEntryId && existing.operation.kind === "copy-fields"
        && canonicalDevelopBatchJson(existing.operation.fields) === canonicalDevelopBatchJson(input.fields);
      if (!matches) throw new Error("Previous Develop operation ID conflicts with a different request.");
      return existing;
    }
    const source = this.database.prepare(`
      SELECT h.entry_id AS entryId, h.revision_id AS revisionId
      FROM develop_history_heads AS h
      JOIN edit_entries AS e ON e.catalog_id = h.catalog_id AND e.entry_id = h.entry_id
      WHERE h.catalog_id = ? AND h.entry_id <> ? AND e.tombstoned_at IS NULL
      ORDER BY h.updated_at DESC, h.entry_id LIMIT 1
    `).get(input.catalogId, input.currentEntryId);
    if (source === undefined) throw new Error("No previous committed Develop entry is available.");
    const sourceRow = row(source, "Previous Develop source");
    return this.create({
      schemaVersion: DEVELOP_BATCH_SCHEMA_VERSION, catalogId: input.catalogId, batchId: input.batchId,
      operationId: input.operationId, kind: "previous", sourceEntryId: parseEntryId(string(sourceRow, "entryId")),
      sourceRevisionId: parseDevelopRevisionId(string(sourceRow, "revisionId")),
      targets: [{ entryId: input.currentEntryId, expectedRevisionId: this.activeHead(input.catalogId, input.currentEntryId) }],
      operation: { kind: "copy-fields", fields: input.fields }, createdAt: input.createdAt,
    });
  }

  private updateItemState(catalogId: CatalogId, batchId: DevelopBatchId, position: number, state: DevelopBatchItemState, now: number): void {
    const result = this.database.prepare(`
      UPDATE develop_batch_items SET state_json = ?, updated_at = ?
      WHERE catalog_id = ? AND batch_id = ? AND position = ?
    `).run(stateJson(state), now, catalogId, batchId, position);
    if (result.changes !== 1) throw new Error("Develop batch item is missing.");
    this.database.prepare("UPDATE develop_batch_jobs SET updated_at = ? WHERE catalog_id = ? AND batch_id = ?").run(now, catalogId, batchId);
  }

  private markActive(catalogId: CatalogId, batchId: DevelopBatchId, position: number): void {
    this.transaction(() => {
      const item = this.itemRows(catalogId, batchId)[position];
      if (!item || parseDevelopBatchItemState(JSON.parse(string(item, "stateJson")) as unknown).kind !== "queued") throw new Error("Develop batch item is not queued.");
      const now = Date.now();
      this.updateItemState(catalogId, batchId, position, { kind: "active", phase: "reconcile" }, now);
      this.database.prepare("UPDATE develop_batch_items SET attempts = attempts + 1 WHERE catalog_id = ? AND batch_id = ? AND position = ?").run(catalogId, batchId, position);
    });
  }

  private markPhase(
    catalogId: CatalogId,
    batchId: DevelopBatchId,
    position: number,
    phase: "apply" | "commit",
  ): void {
    this.transaction(() => {
      const item = this.itemRows(catalogId, batchId)[position];
      const current = item ? parseDevelopBatchItemState(JSON.parse(string(item, "stateJson")) as unknown) : null;
      const expected = phase === "apply" ? "reconcile" : "apply";
      if (current?.kind !== "active" || current.phase !== expected) throw new Error("Develop batch item phase is stale.");
      const now = Date.now();
      if (phase === "commit") {
        this.database.prepare(`
          UPDATE develop_batch_items SET state_json = ?, before_revision_id = expected_revision_id, updated_at = ?
          WHERE catalog_id = ? AND batch_id = ? AND position = ?
        `).run(stateJson({ kind: "active", phase }), now, catalogId, batchId, position);
        this.database.prepare("UPDATE develop_batch_jobs SET updated_at = ? WHERE catalog_id = ? AND batch_id = ?").run(now, catalogId, batchId);
      } else {
        this.updateItemState(catalogId, batchId, position, { kind: "active", phase }, now);
      }
    });
  }

  private prepareItem(receipt: DevelopBatchReceipt, item: DevelopBatchReceiptItem): PreparedBatchItem {
    let current;
    try {
      current = this.history.load({ catalogId: receipt.catalogId, entryId: item.entryId, revisionId: null });
    } catch {
      return { kind: "terminal", state: { kind: "skipped", reason: "Target entry is inactive or missing." } };
    }
    if (current.kind !== "loaded") {
      return { kind: "terminal", state: { kind: "skipped", reason: "Target Develop history needs recovery." } };
    }
    if (current.value.headRevisionId === item.plannedRevisionId) {
      return { kind: "terminal", state: { kind: "completed", entryId: item.entryId, revisionId: item.plannedRevisionId, warnings: [] } };
    }
    if (current.value.headRevisionId !== item.expectedRevisionId) {
      return { kind: "terminal", state: { kind: "skipped", reason: "Target Develop revision changed after the batch was frozen." } };
    }
      let nextDocument: DevelopHistoryDocument;
      let warnings: readonly string[] = [];
      if (receipt.operation.kind === "undo") {
        if (item.restoreRevisionId === null) {
          return { kind: "terminal", state: { kind: "skipped", reason: "Undo has no recorded before revision." } };
        }
        nextDocument = this.history.loadRetainedRevision(receipt.catalogId, item.entryId, item.restoreRevisionId).document;
      } else {
        const targetDocument = v3Document(current.value.document);
        if (!targetDocument) {
          return { kind: "terminal", state: { kind: "skipped", reason: "Target is not an editable V3 Develop document." } };
        }
        let sourceDocument: DevelopDocumentV3 | null = null;
        let sourceId: SourceId | null = null;
        if (receipt.sourceEntryId !== null && receipt.sourceRevisionId !== null) {
          try {
            sourceDocument = v3Document(this.history.loadRetainedRevision(receipt.catalogId, receipt.sourceEntryId, receipt.sourceRevisionId).document);
            sourceId = this.sourceId(receipt.catalogId, receipt.sourceEntryId);
          } catch {
            return { kind: "terminal", state: { kind: "skipped", reason: "Source entry is inactive, missing, or needs recovery." } };
          }
          if (!sourceDocument) {
            return { kind: "terminal", state: { kind: "skipped", reason: "Source is not an editable V3 Develop document." } };
          }
        }
        const application = this.executeOperation({
          operationId: receipt.operationId, operation: receipt.operation, sourceDocument, sourceId,
          targetDocument, targetSourceId: this.sourceId(receipt.catalogId, item.entryId),
          targetCameraProfile: {
            kind: "unavailable",
            reason: "Batch profile application requires a verified before-tone registry snapshot.",
          },
        });
        if (application.kind === "skipped") {
          return { kind: "terminal", state: { kind: "skipped", reason: application.reason } };
        }
        nextDocument = application.document;
        warnings = application.warnings;
      }
    return { kind: "ready", document: nextDocument, warnings };
  }

  private commitPrepared(receipt: DevelopBatchReceipt, item: DevelopBatchReceiptItem, prepared: Extract<PreparedBatchItem, { readonly kind: "ready" }>): void {
    const now = Date.now();
    const current = this.history.load({ catalogId: receipt.catalogId, entryId: item.entryId, revisionId: null });
    if (current.kind !== "loaded" || current.value.headRevisionId !== item.expectedRevisionId) {
      throw new Error("Target Develop revision changed before the batch commit.");
    }
      const commit = this.history.commit({
        catalogId: receipt.catalogId, entryId: item.entryId, revisionId: item.plannedRevisionId,
        expectedParentRevisionId: item.expectedRevisionId, operationId: parseOperationId(item.operationId),
        label: receipt.operation.kind === "undo" ? "Undo Develop batch" : "Develop batch",
        document: prepared.document, createdAt: receipt.createdAt + item.position / 100_000,
      }, true);
      this.database.prepare(`
        UPDATE develop_batch_items
        SET state_json = ?, before_revision_id = ?, after_revision_id = ?, updated_at = ?
        WHERE catalog_id = ? AND batch_id = ? AND position = ?
      `).run(stateJson({ kind: "completed", entryId: item.entryId, revisionId: commit.revision.revisionId, warnings: prepared.warnings }), item.expectedRevisionId, commit.revision.revisionId, now, receipt.catalogId, receipt.batchId, item.position);
      this.database.prepare("UPDATE develop_batch_jobs SET updated_at = ? WHERE catalog_id = ? AND batch_id = ?").run(now, receipt.catalogId, receipt.batchId);
    if (receipt.kind === "auto-sync") this.advanceAutoSyncTarget(receipt.catalogId, item.entryId, commit.revision.revisionId, now);
  }

  private persistPreparedTerminal(receipt: DevelopBatchReceipt, item: DevelopBatchReceiptItem, state: DevelopBatchItemState): void {
    const now = Date.now();
    if (state.kind === "completed") {
      this.database.prepare(`
        UPDATE develop_batch_items SET state_json = ?, before_revision_id = expected_revision_id,
          after_revision_id = planned_revision_id, updated_at = ?
        WHERE catalog_id = ? AND batch_id = ? AND position = ?
      `).run(stateJson(state), now, receipt.catalogId, receipt.batchId, item.position);
      this.database.prepare("UPDATE develop_batch_jobs SET updated_at = ? WHERE catalog_id = ? AND batch_id = ?").run(now, receipt.catalogId, receipt.batchId);
      return;
    }
    this.updateItemState(receipt.catalogId, receipt.batchId, item.position, state, now);
  }

  private async executeAndPersist(receipt: DevelopBatchReceipt, item: DevelopBatchReceiptItem): Promise<void> {
    try {
      this.markPhase(receipt.catalogId, receipt.batchId, item.position, "apply");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const prepared = this.prepareItem(receipt, item);
      if (prepared.kind === "terminal") {
        this.transaction(() => this.persistPreparedTerminal(receipt, item, prepared.state));
        return;
      }
      this.markPhase(receipt.catalogId, receipt.batchId, item.position, "commit");
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.transaction(() => this.commitPrepared(receipt, item, prepared));
    } catch (error) {
      this.transaction(() => this.updateItemState(
        receipt.catalogId,
        receipt.batchId,
        item.position,
        { kind: "failed", error: safeError(error), retryable: true },
        Date.now(),
      ));
    }
  }

  async run(catalogIdValue: CatalogId, batchIdValue: DevelopBatchId): Promise<DevelopBatchReceipt> {
    const catalogId = parseCatalogId(catalogIdValue);
    const batchId = parseDevelopBatchId(batchIdValue);
    return runDurableDevelopBatch(batchId, {
      load: async (requested) => this.get(catalogId, requested),
      markActive: async (requested, position) => this.markActive(catalogId, requested, position),
      executeAndPersist: async (receipt, item) => this.executeAndPersist(receipt, item),
      cancelQueued: async (requested) => this.cancelQueued(catalogId, requested),
      yieldControl: () => new Promise<void>((resolve) => setImmediate(resolve)),
    });
  }

  private cancelQueued(catalogId: CatalogId, batchId: DevelopBatchId): void {
    this.transaction(() => {
      const now = Date.now();
      for (const item of this.itemRows(catalogId, batchId)) {
        const state = parseDevelopBatchItemState(JSON.parse(string(item, "stateJson")) as unknown);
        if (state.kind === "queued") this.updateItemState(catalogId, batchId, integer(item, "position"), { kind: "cancelled", reason: "not-started" }, now);
      }
    });
  }

  cancel(catalogIdValue: CatalogId, batchIdValue: DevelopBatchId, now = Date.now()): DevelopBatchReceipt {
    const catalogId = parseCatalogId(catalogIdValue), batchId = parseDevelopBatchId(batchIdValue);
    this.transaction(() => {
      this.database.prepare("UPDATE develop_batch_jobs SET cancellation_requested = 1, updated_at = ? WHERE catalog_id = ? AND batch_id = ?").run(now, catalogId, batchId);
      for (const item of this.itemRows(catalogId, batchId)) {
        if (parseDevelopBatchItemState(JSON.parse(string(item, "stateJson")) as unknown).kind === "queued") {
          this.updateItemState(catalogId, batchId, integer(item, "position"), { kind: "cancelled", reason: "not-started" }, now);
        }
      }
    });
    return this.get(catalogId, batchId);
  }

  retry(catalogIdValue: CatalogId, batchIdValue: DevelopBatchId, now = Date.now()): DevelopBatchReceipt {
    const catalogId = parseCatalogId(catalogIdValue), batchId = parseDevelopBatchId(batchIdValue);
    this.transaction(() => {
      this.database.prepare("UPDATE develop_batch_jobs SET cancellation_requested = 0, updated_at = ? WHERE catalog_id = ? AND batch_id = ?").run(now, catalogId, batchId);
      for (const item of this.itemRows(catalogId, batchId)) {
        const state = parseDevelopBatchItemState(JSON.parse(string(item, "stateJson")) as unknown);
        if (state.kind === "cancelled" || (state.kind === "failed" && state.retryable)) {
          this.updateItemState(catalogId, batchId, integer(item, "position"), { kind: "queued" }, now);
        }
      }
    });
    return this.get(catalogId, batchId);
  }

  undo(input: {
    readonly catalogId: CatalogId; readonly sourceBatchId: DevelopBatchId; readonly batchId: DevelopBatchId;
    readonly operationId: DevelopBatchOperationId; readonly createdAt: number;
  }): DevelopBatchReceipt {
    const source = this.get(input.catalogId, input.sourceBatchId);
    const completed = source.items.filter((item): item is DevelopBatchReceiptItem & { readonly state: Extract<DevelopBatchItemState, { readonly kind: "completed" }> } => item.state.kind === "completed");
    if (completed.length === 0) throw new Error("Develop batch has no completed targets to undo.");
    return this.transaction(() => {
      const operation = { kind: "undo" as const, sourceBatchId: source.batchId };
      const requestHash = digest({ ...input, operation });
      const existing = this.database.prepare("SELECT batch_id AS batchId, request_sha256 AS requestHash FROM develop_batch_jobs WHERE catalog_id = ? AND operation_id = ?").get(input.catalogId, input.operationId);
      if (existing !== undefined) {
        const existingRow = row(existing, "Develop batch undo replay");
        if (string(existingRow, "requestHash") !== requestHash || string(existingRow, "batchId") !== input.batchId) throw new Error("Develop batch undo operation conflicts.");
        return this.get(input.catalogId, input.batchId);
      }
      const targetIds = completed.map((item) => item.entryId);
      const count = integer(row(this.database.prepare("SELECT COUNT(*) AS count FROM develop_batch_jobs WHERE catalog_id = ?").get(input.catalogId), "Develop batch job count"), "count");
      if (count >= DEVELOP_BATCH_MAX_JOBS_PER_CATALOG) throw new Error("Develop batch catalog job limit reached.");
      const operationJson = canonicalDevelopBatchJson(operation);
      const targetsJson = canonicalDevelopBatchJson(targetIds);
      const queuedJson = stateJson({ kind: "queued" });
      const addedBytes = new TextEncoder().encode(operationJson + targetsJson).byteLength + completed.length * new TextEncoder().encode(queuedJson).byteLength;
      if (addedBytes > DEVELOP_BATCH_MAX_JOB_BYTES || this.metadataBytes(input.catalogId) + addedBytes > DEVELOP_BATCH_MAX_CATALOG_BYTES) {
        throw new Error("Develop batch metadata limit exceeded.");
      }
      this.database.prepare(`
        INSERT INTO develop_batch_jobs (
          catalog_id, batch_id, operation_id, request_sha256, schema_version, kind,
          source_entry_id, source_revision_id, operation_json, targets_json,
          cancellation_requested, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 'undo', NULL, NULL, ?, ?, 0, ?, ?)
      `).run(input.catalogId, input.batchId, input.operationId, requestHash, operationJson, targetsJson, input.createdAt, input.createdAt);
      const insert = this.database.prepare(`
        INSERT INTO develop_batch_items (
          catalog_id, batch_id, position, entry_id, operation_id, planned_revision_id,
          expected_revision_id, before_revision_id, after_revision_id, restore_revision_id,
          state_json, attempts, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?)
      `);
      completed.forEach((item, position) => {
        if (item.beforeRevisionId === null) throw new Error("Develop batch completed item has no before revision.");
        insert.run(input.catalogId, input.batchId, position, item.entryId, createDevelopBatchOperationId(), createDevelopRevisionId(), item.state.revisionId, item.beforeRevisionId, queuedJson, input.createdAt);
      });
      return this.get(input.catalogId, input.batchId);
    });
  }

  enableAutoSync(input: {
    readonly catalogId: CatalogId; readonly sourceEntryId: EntryId; readonly targetEntryIds: readonly EntryId[];
    readonly fields: readonly DevelopPresetField[]; readonly updatedAt: number;
  }): void {
    if (input.targetEntryIds.length === 0 || input.targetEntryIds.includes(input.sourceEntryId) || new Set(input.targetEntryIds).size !== input.targetEntryIds.length) throw new Error("Auto Sync target selection is invalid.");
    const targets = input.targetEntryIds.map((entryId) => ({ entryId, expectedRevisionId: this.activeHead(input.catalogId, entryId) }));
    const sourceRevisionId = this.activeHead(input.catalogId, input.sourceEntryId);
    const latest = row(this.database.prepare(`
      SELECT COALESCE(MAX(emission_sequence), 0) AS emissionSequence
      FROM develop_batch_jobs WHERE catalog_id = ? AND kind = 'auto-sync'
    `).get(input.catalogId), "Auto Sync latest emission");
    const sourceEmissionSequence = integer(latest, "emissionSequence");
    this.transaction(() => this.database.prepare(`
      INSERT INTO develop_auto_sync (
        catalog_id, source_entry_id, source_revision_id, targets_json, fields_json,
        enabled, updated_at, source_emission_sequence
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (catalog_id) DO UPDATE SET source_entry_id = excluded.source_entry_id,
        source_revision_id = excluded.source_revision_id, targets_json = excluded.targets_json,
        fields_json = excluded.fields_json, enabled = 1, updated_at = excluded.updated_at,
        source_emission_sequence = excluded.source_emission_sequence
    `).run(input.catalogId, input.sourceEntryId, sourceRevisionId, canonicalDevelopBatchJson(targets), canonicalDevelopBatchJson(input.fields), input.updatedAt, sourceEmissionSequence));
  }

  disableAutoSync(catalogIdValue: CatalogId, updatedAt = Date.now()): void {
    const catalogId = parseCatalogId(catalogIdValue);
    this.database.prepare("UPDATE develop_auto_sync SET enabled = 0, updated_at = ? WHERE catalog_id = ?").run(updatedAt, catalogId);
  }

  emitAutoSync(input: {
    readonly catalogId: CatalogId; readonly batchId: DevelopBatchId; readonly operationId: DevelopBatchOperationId;
    readonly sourceRevisionId: DevelopRevisionId; readonly createdAt: number;
  }): DevelopBatchReceipt {
    return this.transaction(() => {
      const value = this.database.prepare(`
        SELECT source_entry_id AS sourceEntryId, source_revision_id AS previousSourceRevisionId,
               targets_json AS targetsJson, fields_json AS fieldsJson,
               source_emission_sequence AS sourceEmissionSequence
        FROM develop_auto_sync WHERE catalog_id = ? AND enabled = 1
      `).get(input.catalogId);
      if (value === undefined) throw new Error("Auto Sync is not enabled.");
      const config = row(value, "Auto Sync state");
      const sourceEntryId = parseEntryId(string(config, "sourceEntryId"));
      const existing = this.existingReceipt(input.catalogId, input.operationId);
      if (existing !== null) {
        if (existing.batchId !== input.batchId || existing.kind !== "auto-sync" || existing.sourceRevisionId !== input.sourceRevisionId || existing.createdAt !== input.createdAt) {
          throw new Error("Auto Sync operation ID conflicts with a different request.");
        }
        const emissionValue = this.database.prepare(`
          SELECT source_entry_id AS sourceEntryId, emission_sequence AS emissionSequence
          FROM develop_batch_jobs
          WHERE catalog_id = ? AND operation_id = ? AND kind = 'auto-sync'
        `).get(input.catalogId, input.operationId);
        if (emissionValue === undefined) throw new Error("Auto Sync replay has no durable emission sequence.");
        const emission = row(emissionValue, "Auto Sync replay emission");
        const emissionSequence = integer(emission, "emissionSequence");
        const cursorSequence = integer(config, "sourceEmissionSequence");
        const sameSource = parseEntryId(string(emission, "sourceEntryId")) === sourceEntryId;
        if (sameSource && cursorSequence === emissionSequence && string(config, "previousSourceRevisionId") !== input.sourceRevisionId) {
          throw new Error("Auto Sync cursor revision conflicts with its emission sequence.");
        }
        if (sameSource && cursorSequence < emissionSequence) {
          this.database.prepare(`
            UPDATE develop_auto_sync
            SET source_revision_id = ?, source_emission_sequence = ?, updated_at = ?
            WHERE catalog_id = ? AND source_emission_sequence = ?
          `).run(input.sourceRevisionId, emissionSequence, input.createdAt, input.catalogId, cursorSequence);
        }
        return existing;
      }
      const duplicate = this.database.prepare(`
        SELECT operation_id AS operationId FROM develop_batch_jobs
        WHERE catalog_id = ? AND kind = 'auto-sync' AND source_entry_id = ? AND source_revision_id = ?
      `).get(input.catalogId, sourceEntryId, input.sourceRevisionId);
      if (duplicate !== undefined) throw new Error("Auto Sync source revision was already emitted by another operation.");
      if (this.activeHead(input.catalogId, sourceEntryId) !== input.sourceRevisionId) throw new Error("Auto Sync source revision is stale.");
      if (string(config, "previousSourceRevisionId") === input.sourceRevisionId) throw new Error("Auto Sync already emitted this source revision.");
      const targetsValue = JSON.parse(string(config, "targetsJson")) as unknown;
      if (!Array.isArray(targetsValue)) throw new Error("Auto Sync targets are invalid.");
      const targets = targetsValue.map((target) => {
        const item = row(target, "Auto Sync target");
        return { entryId: parseEntryId(item.entryId), expectedRevisionId: parseDevelopRevisionId(item.expectedRevisionId) };
      });
      const operation = parseDevelopBatchOperation({ kind: "copy-fields", fields: JSON.parse(string(config, "fieldsJson")) as unknown });
      if (operation.kind !== "copy-fields") throw new Error("Auto Sync fields are invalid.");
      const latest = row(this.database.prepare(`
        SELECT COALESCE(MAX(emission_sequence), 0) AS emissionSequence
        FROM develop_batch_jobs WHERE catalog_id = ? AND kind = 'auto-sync'
      `).get(input.catalogId), "Auto Sync latest emission");
      const emissionSequence = integer(latest, "emissionSequence") + 1;
      const receipt = this.create({
        schemaVersion: DEVELOP_BATCH_SCHEMA_VERSION, catalogId: input.catalogId, batchId: input.batchId,
        operationId: input.operationId, kind: "auto-sync", sourceEntryId, sourceRevisionId: input.sourceRevisionId,
        targets, operation, createdAt: input.createdAt,
      });
      const emitted = this.database.prepare(`
        UPDATE develop_batch_jobs SET emission_sequence = ?
        WHERE catalog_id = ? AND operation_id = ? AND kind = 'auto-sync' AND emission_sequence IS NULL
      `).run(emissionSequence, input.catalogId, input.operationId);
      if (emitted.changes !== 1) throw new Error("Auto Sync Receipt emission sequence was not recorded.");
      const updated = this.database.prepare(`
        UPDATE develop_auto_sync
        SET source_revision_id = ?, source_emission_sequence = ?, updated_at = ?
        WHERE catalog_id = ? AND source_revision_id = ? AND source_emission_sequence = ? AND enabled = 1
      `).run(
        input.sourceRevisionId,
        emissionSequence,
        input.createdAt,
        input.catalogId,
        string(config, "previousSourceRevisionId"),
        integer(config, "sourceEmissionSequence"),
      );
      if (updated.changes !== 1) throw new Error("Auto Sync cursor changed while emitting a Receipt.");
      return receipt;
    });
  }

  private advanceAutoSyncTarget(catalogId: CatalogId, entryId: EntryId, revisionId: DevelopRevisionId, updatedAt: number): void {
    const value = this.database.prepare("SELECT targets_json AS targetsJson FROM develop_auto_sync WHERE catalog_id = ? AND enabled = 1").get(catalogId);
    if (value === undefined) return;
    const targetsValue = JSON.parse(string(row(value, "Auto Sync targets"), "targetsJson")) as unknown;
    if (!Array.isArray(targetsValue)) return;
    const targets = targetsValue.map((target) => {
      const item = row(target, "Auto Sync target");
      return { entryId: parseEntryId(item.entryId), expectedRevisionId: parseDevelopRevisionId(item.expectedRevisionId) };
    });
    const next = targets.map((target) => target.entryId === entryId ? { ...target, expectedRevisionId: revisionId } : target);
    this.database.prepare("UPDATE develop_auto_sync SET targets_json = ?, updated_at = ? WHERE catalog_id = ?")
      .run(canonicalDevelopBatchJson(next), updatedAt, catalogId);
  }
}
