import {
  parseJsonValue,
  sameFileObservation,
  type FrozenImportPlan,
  type ImportPlanDraft,
  type ImportPlanItem,
  type ImportPlanReview,
  type ImportSource,
  type JsonValue,
} from "../lib/import/domain.ts";
import {
  type AutoImportQueueItem,
  type AutoImportRule,
  normalizeAutoImportRelativePath,
} from "../lib/import/auto-import.ts";
import {
  parseOperationId,
  type AssetId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import {
  reviewDuplicatesOnDemand,
  type DuplicateCandidate,
  type DuplicateReviewResult,
  type FingerprintCandidateResult,
} from "./catalog-fingerprint-service.ts";
import {
  createImportPlan,
  freezeImportPlan,
  reviewImportPlan,
  verifyFrozenImportPlan,
  type CreateImportPlanInput,
  type DngAdapter,
  type FreezeImportPlanInput,
  type ImportPlanReviewInput,
} from "./import-plan-service.ts";
import {
  executeFileTransactions,
  registerImportSources,
  type FileTransactionCatalogAdapter,
  type FileTransactionFileSystem,
  type FileTransactionJournal,
  type FileTransactionPathResolver,
  type FileTransactionResult,
  type FileTransactionXmpStatus,
} from "./file-transaction-service.ts";
import type {
  CatalogFaultInjector,
  CatalogFaultStage,
} from "./catalog-fault-injection.ts";

export type ImportOperationState = "planned" | "running" | "completed" | "failed" | "cancelled";
export type ImportOperationItemStatus = "planned" | "running" | "completed" | "skipped" | "failed" | "cancelled";

export interface ImportOperationItemUpdate {
  readonly operationId: OperationId;
  readonly itemId: AssetId;
  readonly assetId: AssetId | null;
  readonly state: ImportOperationState;
  readonly status: ImportOperationItemStatus;
  readonly stage: CatalogFaultStage;
  readonly xmpStatus: FileTransactionXmpStatus;
  readonly error: string | null;
  readonly updatedAt: number;
}

export interface ImportOperationUpdate {
  readonly operationId: OperationId;
  readonly state: ImportOperationState;
  readonly error: string | null;
  readonly updatedAt: number;
}

export interface FrozenImportOperation {
  readonly plan: FrozenImportPlan;
  readonly operation: ImportOperationUpdate;
  readonly items: readonly ImportOperationItemUpdate[];
}

export interface ImportOperationCatalogPort {
  readonly persistFrozenPlan: (operation: FrozenImportOperation) => Promise<void>;
  readonly loadFrozenOperation: (operationId: OperationId) => Promise<FrozenImportOperation | null>;
  readonly updateOperation: (operation: ImportOperationUpdate) => Promise<void>;
  readonly updateItem: (item: ImportOperationItemUpdate) => Promise<void>;
  readonly applyFileTransaction: (item: ImportPlanItem, xmpStatus: FileTransactionXmpStatus) => Promise<void>;
  readonly registerSource: (item: ImportPlanItem) => Promise<void>;
}

export interface ImportMetadataDefaults {
  readonly title: string | null;
  readonly caption: string | null;
  readonly copyright: string | null;
  readonly keywords: readonly string[];
  readonly develop: JsonValue | null;
}

export interface ImportOperationMetadataPort {
  readonly apply: (assetId: AssetId, defaults: ImportMetadataDefaults) => Promise<void>;
}

export interface ImportOperationSourcePort {
  readonly observe: (item: ImportPlanItem) => Promise<ImportSource>;
}

export interface ImportOperationFilePort {
  readonly paths: FileTransactionPathResolver;
  readonly journal: FileTransactionJournal;
  readonly faultInjector: CatalogFaultInjector;
  readonly fileSystem?: FileTransactionFileSystem;
}

export interface ImportAutoImportPlanPort {
  readonly createPlan: (item: AutoImportQueueItem, rule: AutoImportRule) => Promise<FrozenImportPlan>;
}

export interface ImportOperationServiceDependencies {
  readonly catalog: ImportOperationCatalogPort;
  readonly metadata: ImportOperationMetadataPort;
  readonly source: ImportOperationSourcePort;
  readonly files: ImportOperationFilePort;
  readonly autoImport?: ImportAutoImportPlanPort;
  readonly now?: () => number;
}

export interface ExecuteFrozenPlanOptions {
  readonly isCancelled?: () => boolean;
  readonly now?: () => number;
  readonly retryableFailure?: boolean;
}

export interface ImportOperationItemResult {
  readonly itemId: AssetId;
  readonly destinationAssetId: AssetId;
  readonly stage: CatalogFaultStage;
  readonly status: Exclude<ImportOperationItemStatus, "planned" | "running">;
  readonly xmpStatus: FileTransactionXmpStatus;
  readonly sourceRetained: boolean;
  readonly error: string | null;
}

export interface ImportOperationExecution {
  readonly operationId: OperationId;
  readonly state: ImportOperationState;
  readonly items: readonly ImportOperationItemResult[];
  readonly error: string | null;
  /** The catalog apply may have committed even though the transaction acknowledgement failed. */
  readonly retryable?: boolean;
}

export class ImportOperationCancelledError extends Error {
  public constructor() {
    super("Import operation was cancelled.");
    this.name = "ImportOperationCancelledError";
  }
}

function sameSourceObservation(expected: ImportSource, actual: ImportSource): boolean {
  return expected.rootId === actual.rootId &&
    expected.relativePath === actual.relativePath &&
    expected.xmpState === actual.xmpState &&
    expected.formatId === actual.formatId &&
    sameFileObservation(expected.observation, actual.observation);
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: JsonValue | undefined, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Frozen preset ${label} is invalid.`);
  return value;
}

function stringArray(value: JsonValue | undefined, label: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Frozen preset ${label} is invalid.`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`Frozen preset ${label} is invalid.`);
    strings.push(item);
  }
  return strings;
}

function metadataDefaults(plan: FrozenImportPlan): ImportMetadataDefaults {
  let frozen: JsonValue;
  try {
    frozen = parseJsonValue(JSON.parse(plan.preset.canonicalJson), "Frozen preset JSON");
  } catch {
    throw new Error("Frozen preset canonical JSON is invalid.");
  }
  if (!isRecord(frozen)) throw new Error("Frozen preset canonical JSON is invalid.");
  const payload = frozen.payload;
  if (!isRecord(payload)) {
    return { title: null, caption: null, copyright: null, keywords: [], develop: null };
  }
  const metadata = isRecord(payload.metadata) ? payload.metadata : payload;
  const developValue = payload.develop ?? payload.developDefaults ?? metadata.develop ?? null;
  return {
    title: nullableString(metadata.title, "title"),
    caption: nullableString(metadata.caption, "caption"),
    copyright: nullableString(metadata.copyright, "copyright"),
    keywords: stringArray(metadata.keywords, "keywords"),
    develop: developValue,
  };
}

function initialItemUpdate(
  plan: FrozenImportPlan,
  item: ImportPlanItem,
  now: number,
): ImportOperationItemUpdate {
  return {
    operationId: plan.operationId,
    itemId: item.itemId,
    assetId: item.destinationAssetId,
    state: "planned",
    status: "planned",
    stage: "planned",
    xmpStatus: item.source.xmpState === "present" ? "preserved" : "absent",
    error: null,
    updatedAt: now,
  };
}

function initialOperationUpdate(plan: FrozenImportPlan, now: number): ImportOperationUpdate {
  return {
    operationId: plan.operationId,
    state: "planned",
    error: null,
    updatedAt: now,
  };
}

function resultFromFileTransaction(
  result: FileTransactionResult,
  action: ImportPlanItem["action"],
): ImportOperationItemResult {
  return {
    itemId: result.itemId,
    destinationAssetId: result.destinationAssetId,
    stage: result.stage,
    status: result.status,
    xmpStatus: result.xmpStatus,
    sourceRetained: (action === "move" || action === "rename") && !result.sourceCleaned && result.stage === "catalog-applied",
    error: result.error,
  };
}

function resultFromUpdate(
  item: ImportOperationItemUpdate,
  action: ImportPlanItem["action"],
): ImportOperationItemResult {
  if (item.status === "planned" || item.status === "running") {
    throw new Error("Import operation item is not terminal.");
  }
  return {
    itemId: item.itemId,
    destinationAssetId: item.assetId ?? item.itemId,
    stage: item.stage,
    status: item.status,
    xmpStatus: item.xmpStatus,
    sourceRetained: (action === "move" || action === "rename") && item.stage === "catalog-applied",
    error: item.error,
  };
}

function operationItemsById(operation: FrozenImportOperation): Map<AssetId, ImportOperationItemUpdate> {
  return new Map(operation.items.map((item) => [item.itemId, item]));
}

function assertSameFrozenPlan(expected: FrozenImportPlan, actual: FrozenImportPlan): void {
  verifyFrozenImportPlan(actual);
  if (expected.operationId !== actual.operationId || expected.planSha256 !== actual.planSha256) {
    throw new Error("Persisted frozen import plan does not match the requested plan.");
  }
}

function assertAutoImportPlanMatches(
  plan: FrozenImportPlan,
  item: AutoImportQueueItem,
  rule: AutoImportRule,
): void {
  verifyFrozenImportPlan(plan);
  if (
    plan.operationId !== item.queueId ||
    plan.catalogId !== item.catalogId ||
    plan.destinationRootId !== rule.destinationRootId ||
    plan.preset.catalogId !== rule.catalogId ||
    plan.preset.presetId !== rule.presetId ||
    plan.preset.version !== rule.presetVersion ||
    plan.preset.sha256 !== rule.presetSha256 ||
    plan.items.length !== 1
  ) {
    throw new Error("Persisted Auto Import plan does not match its queue item and rule.");
  }
  const planItem = plan.items[0]!;
  const sourcePath = normalizeAutoImportRelativePath(item.relativePath);
  const destinationBase = normalizeAutoImportRelativePath(rule.destinationRelativePath);
  if (
    planItem.action !== "copy" ||
    planItem.sourceAssetId !== null ||
    planItem.source.rootId !== rule.ingressRootId ||
    normalizeAutoImportRelativePath(planItem.source.relativePath) !== sourcePath ||
    !sameFileObservation(planItem.source.observation, item.observation) ||
    (planItem.destinationRelativePath !== destinationBase &&
      !planItem.destinationRelativePath.startsWith(`${destinationBase}/`))
  ) {
    throw new Error("Persisted Auto Import plan does not match its queue item and rule.");
  }
}

export class ImportOperationService {
  private readonly dependencies: ImportOperationServiceDependencies;

  public constructor(dependencies: ImportOperationServiceDependencies) {
    this.dependencies = dependencies;
  }

  public prepare(input: CreateImportPlanInput): ImportPlanDraft {
    return createImportPlan(input);
  }

  public review(draft: ImportPlanDraft, input: ImportPlanReviewInput = {}): ImportPlanReview {
    return reviewImportPlan(draft, input);
  }

  public async reviewDuplicatesOnDemand(
    input: Parameters<typeof reviewDuplicatesOnDemand>[0],
    hashCandidate?: Parameters<typeof reviewDuplicatesOnDemand>[1],
  ): Promise<DuplicateReviewResult> {
    return reviewDuplicatesOnDemand(input, hashCandidate);
  }

  public async freeze(input: FreezeImportPlanInput): Promise<FrozenImportPlan> {
    const plan = freezeImportPlan(input);
    for (const item of plan.items) {
      const observed = await this.dependencies.source.observe(item);
      if (!sameSourceObservation(item.source, observed)) {
        throw new Error(`Import source observation is stale for item ${item.itemId}.`);
      }
    }
    const now = this.dependencies.now?.() ?? Date.now();
    await this.dependencies.catalog.persistFrozenPlan({
      plan,
      operation: initialOperationUpdate(plan, now),
      items: plan.items.map((item) => initialItemUpdate(plan, item, now)),
    });
    return plan;
  }

  public async executeFrozenPlan(
    planOrOperationId: FrozenImportPlan | OperationId,
    options: ExecuteFrozenPlanOptions = {},
  ): Promise<ImportOperationExecution> {
    return this.executeFrozenPlanInternal(planOrOperationId, options, options.retryableFailure === true);
  }

  private async executeFrozenPlanInternal(
    planOrOperationId: FrozenImportPlan | OperationId,
    options: ExecuteFrozenPlanOptions,
    retryableFailure: boolean,
  ): Promise<ImportOperationExecution> {
    const requestedPlan = typeof planOrOperationId === "string" ? null : planOrOperationId;
    if (requestedPlan !== null) verifyFrozenImportPlan(requestedPlan);
    const operationId = requestedPlan?.operationId ?? parseOperationId(planOrOperationId);
    const persisted = await this.dependencies.catalog.loadFrozenOperation(operationId);
    if (persisted === null) throw new Error("Frozen import operation does not exist.");
    if (requestedPlan === null) {
      verifyFrozenImportPlan(persisted.plan);
    } else {
      assertSameFrozenPlan(requestedPlan, persisted.plan);
    }
    if (
      persisted.operation.state === "completed" ||
      persisted.operation.state === "failed" ||
      persisted.operation.state === "cancelled"
    ) {
      return this.executionFromPersisted(persisted);
    }
    const metadata = metadataDefaults(persisted.plan);
    const now = options.now ?? this.dependencies.now ?? Date.now;
    const isCancelled = options.isCancelled;
    const itemUpdates = operationItemsById(persisted);
    const results: ImportOperationItemResult[] = [];
    await this.dependencies.catalog.updateOperation({
      ...persisted.operation,
      state: "running",
      error: null,
      updatedAt: now(),
    });
    for (const item of persisted.plan.items) {
      const previous = itemUpdates.get(item.itemId);
      if (previous?.status === "completed" || previous?.status === "skipped") {
        results.push(resultFromUpdate(previous, item.action));
        continue;
      }
      await this.dependencies.catalog.updateItem({
        ...(previous ?? initialItemUpdate(persisted.plan, item, now())),
        state: "running",
        status: "running",
        error: null,
        updatedAt: now(),
      });
    }
    if (isCancelled?.() === true) {
      await this.cancelPendingItems(persisted.plan, itemUpdates, now, results);
      await this.dependencies.catalog.updateOperation({
        operationId,
        state: "cancelled",
        error: null,
        updatedAt: now(),
      });
      return { operationId, state: "cancelled", items: results, error: null };
    }

    for (const item of persisted.plan.items) {
      const previous = itemUpdates.get(item.itemId);
      if (
        previous === undefined ||
        previous.status === "completed" ||
        previous.status === "skipped" ||
        previous.status === "cancelled"
      ) continue;
      if (
        item.conflictDecisions.duplicate?.kind !== "skip-incoming" &&
        item.conflictDecisions.destination?.kind !== "skip"
      ) continue;
      const skipped: ImportOperationItemUpdate = {
        ...previous,
        state: "completed",
        status: "skipped",
        stage: "catalog-applied",
        xmpStatus: item.source.xmpState === "present" ? "preserved" : "absent",
        error: null,
        updatedAt: now(),
      };
      await this.dependencies.catalog.updateItem(skipped);
      itemUpdates.set(item.itemId, skipped);
      results.push(resultFromUpdate(skipped, item.action));
    }

    const addItems = persisted.plan.items.filter((item) => item.action === "add");
    const activeAddIds = new Set(addItems
      .filter((item) => itemUpdates.get(item.itemId)?.status !== "completed" && itemUpdates.get(item.itemId)?.status !== "skipped")
      .map((item) => item.itemId));
    if (activeAddIds.size > 0) {
      try {
        await registerImportSources(persisted.plan, {
          registerSource: async (item) => {
            if (!activeAddIds.has(item.itemId)) return;
            if (isCancelled?.() === true) throw new ImportOperationCancelledError();
            await this.dependencies.catalog.registerSource(item);
          },
        });
        for (const item of addItems) {
          if (!activeAddIds.has(item.itemId)) continue;
          if (isCancelled?.() === true) throw new ImportOperationCancelledError();
          await this.dependencies.catalog.updateItem({
            operationId,
            itemId: item.itemId,
            assetId: item.destinationAssetId,
            state: "running",
            status: "running",
            stage: "catalog-applied",
            xmpStatus: item.source.xmpState === "present" ? "preserved" : "absent",
            error: null,
            updatedAt: now(),
          });
          await this.dependencies.metadata.apply(item.destinationAssetId, metadata);
          const completed: ImportOperationItemUpdate = {
            operationId,
            itemId: item.itemId,
            assetId: item.destinationAssetId,
            state: "completed",
            status: "completed",
            stage: "catalog-applied",
            xmpStatus: item.source.xmpState === "present" ? "preserved" : "absent",
            error: null,
            updatedAt: now(),
          };
          await this.dependencies.catalog.updateItem(completed);
          itemUpdates.set(item.itemId, completed);
          results.push(resultFromUpdate(completed, item.action));
        }
      } catch (error) {
        if (!(error instanceof ImportOperationCancelledError)) throw error;
        await this.cancelPendingItems(persisted.plan, itemUpdates, now, results);
        await this.dependencies.catalog.updateOperation({ operationId, state: "cancelled", error: null, updatedAt: now() });
        return { operationId, state: "cancelled", items: results, error: null };
      }
    }

    const fileItems = persisted.plan.items.filter((item) => item.action !== "add");
    const activeFileIds = new Set(fileItems
      .filter((item) => itemUpdates.get(item.itemId)?.status !== "completed" && itemUpdates.get(item.itemId)?.status !== "skipped")
      .map((item) => item.itemId));
    if (activeFileIds.size > 0) {
      const journal = this.journalWithStagePersistence(itemUpdates, now);
      const catalog: FileTransactionCatalogAdapter = {
        apply: (item, xmpStatus) => this.dependencies.catalog.applyFileTransaction(item, xmpStatus),
      };
      const transactionResults = await executeFileTransactions({
        plan: persisted.plan,
        itemIds: activeFileIds,
        paths: this.dependencies.files.paths,
        journal,
        catalog,
        faultInjector: this.dependencies.files.faultInjector,
        fileSystem: this.dependencies.files.fileSystem,
        isCancelled,
        now,
      });
      for (const result of transactionResults) {
        const item = persisted.plan.items.find((candidate) => candidate.itemId === result.itemId);
        if (item === undefined) throw new Error("File transaction returned an unknown item.");
        const publicResult = resultFromFileTransaction(result, item.action);
        results.push(publicResult);
        if (result.status === "completed") {
          await this.dependencies.metadata.apply(item.destinationAssetId, metadata);
        }
        const terminalState: ImportOperationState = result.status === "cancelled"
          ? "cancelled"
          : result.status === "failed"
            ? "failed"
            : "completed";
        const retryingFailure = (retryableFailure || result.retryable === true) && result.status === "failed";
        const finalState: ImportOperationState = retryingFailure ? "running" : terminalState;
        const finalStatus: ImportOperationItemStatus = retryingFailure ? "running" : result.status;
        await this.dependencies.catalog.updateItem({
          operationId,
          itemId: result.itemId,
          assetId: result.destinationAssetId,
          state: finalState,
          status: finalStatus,
          stage: result.status === "skipped" ? "catalog-applied" : result.stage,
          xmpStatus: result.xmpStatus,
          error: result.error,
          updatedAt: now(),
        });
        itemUpdates.set(result.itemId, {
          operationId,
          itemId: result.itemId,
          assetId: result.destinationAssetId,
          state: finalState,
          status: finalStatus,
          stage: result.status === "skipped" ? "catalog-applied" : result.stage,
          xmpStatus: result.xmpStatus,
          error: result.error,
          updatedAt: now(),
        });
        if (result.status === "failed" || result.status === "cancelled") break;
      }
      if (transactionResults.some((result) => result.status === "failed")) {
        const failedResult = transactionResults.find((result) => result.status === "failed");
        const error = failedResult?.error ?? "Import transaction failed.";
        const recoverableFailure = retryableFailure || failedResult?.retryable === true;
        if (recoverableFailure) {
          if (failedResult === undefined) throw new Error("Import transaction failure result is missing.");
          await this.dependencies.catalog.updateItem({
            operationId,
            itemId: failedResult.itemId,
            assetId: failedResult.destinationAssetId,
            state: "running",
            status: "running",
            stage: failedResult.stage,
            xmpStatus: failedResult.xmpStatus,
            error,
            updatedAt: now(),
          });
          await this.dependencies.catalog.updateOperation({ operationId, state: "running", error, updatedAt: now() });
          itemUpdates.set(failedResult.itemId, {
            operationId,
            itemId: failedResult.itemId,
            assetId: failedResult.destinationAssetId,
            state: "running",
            status: "running",
            stage: failedResult.stage,
            xmpStatus: failedResult.xmpStatus,
            error,
            updatedAt: now(),
          });
          return {
            operationId,
            state: "failed",
            items: results,
            error,
            ...(failedResult.retryable === true ? { retryable: true } : {}),
          };
        }
        await this.dependencies.catalog.updateOperation({ operationId, state: "failed", error, updatedAt: now() });
        return { operationId, state: "failed", items: results, error };
      }
      if (transactionResults.length === 0 && isCancelled?.() === true) {
        await this.cancelPendingItems(persisted.plan, itemUpdates, now, results);
        await this.dependencies.catalog.updateOperation({ operationId, state: "cancelled", error: null, updatedAt: now() });
        return { operationId, state: "cancelled", items: results, error: null };
      }
      if (transactionResults.some((result) => result.status === "cancelled") || isCancelled?.() === true) {
        await this.cancelPendingItems(persisted.plan, itemUpdates, now, results);
        await this.dependencies.catalog.updateOperation({ operationId, state: "cancelled", error: null, updatedAt: now() });
        return { operationId, state: "cancelled", items: results, error: null };
      }
    }

    await this.dependencies.catalog.updateOperation({ operationId, state: "completed", error: null, updatedAt: now() });
    return { operationId, state: "completed", items: results, error: null };
  }

  public async executeAutoImport(
    item: AutoImportQueueItem,
    rule: AutoImportRule,
    options: ExecuteFrozenPlanOptions = {},
  ): Promise<ImportOperationExecution> {
    if (this.dependencies.autoImport === undefined) {
      throw new Error("Auto Import execution is not configured.");
    }
    const operationId = parseOperationId(item.queueId);
    const persisted = await this.dependencies.catalog.loadFrozenOperation(operationId);
    const retryableFailure = item.attempts < item.maxAttempts;
    if (persisted !== null) {
      assertAutoImportPlanMatches(persisted.plan, item, rule);
      return this.executeFrozenPlan(persisted.plan, { ...options, retryableFailure });
    }
    const plan = await this.dependencies.autoImport.createPlan(item, rule);
    assertAutoImportPlanMatches(plan, item, rule);
    return this.executeFrozenPlan(plan, { ...options, retryableFailure });
  }

  private async cancelPendingItems(
    plan: FrozenImportPlan,
    existing: Map<AssetId, ImportOperationItemUpdate>,
    now: () => number,
    results: ImportOperationItemResult[],
  ): Promise<void> {
    for (const item of plan.items) {
      const previous = existing.get(item.itemId);
      if (previous?.status === "completed" || previous?.status === "skipped" || previous?.status === "cancelled") continue;
      const cancelled: ImportOperationItemUpdate = {
        operationId: plan.operationId,
        itemId: item.itemId,
        assetId: item.destinationAssetId,
        state: "cancelled",
        status: "cancelled",
        stage: previous?.stage ?? "planned",
        xmpStatus: previous?.xmpStatus ?? (item.source.xmpState === "present" ? "preserved" : "absent"),
        error: null,
        updatedAt: now(),
      };
      await this.dependencies.catalog.updateItem(cancelled);
      results.push(resultFromUpdate(cancelled, item.action));
    }
  }

  private journalWithStagePersistence(
    itemUpdates: Map<AssetId, ImportOperationItemUpdate>,
    now: () => number,
  ): FileTransactionJournal {
    const base = this.dependencies.files.journal;
    return {
      read: (operationId, itemId) => base.read(operationId, itemId),
      list: (operationId) => base.list(operationId),
      write: async (record) => {
        await base.write(record);
        const previous = itemUpdates.get(record.itemId);
        if (previous === undefined) throw new Error("Transaction journal returned an unknown item.");
        itemUpdates.set(record.itemId, {
          ...previous,
          operationId: record.operationId,
          assetId: record.destinationAssetId,
          state: "running",
          status: "running",
          stage: record.stage,
          xmpStatus: record.xmpStatus,
          error: null,
          updatedAt: now(),
        });
        await this.dependencies.catalog.updateItem(itemUpdates.get(record.itemId)!);
      },
    };
  }

  private executionFromPersisted(operation: FrozenImportOperation): ImportOperationExecution {
    const items = operation.items
      .filter((item) => item.status !== "planned" && item.status !== "running")
      .map((item) => {
        const planItem = operation.plan.items.find((candidate) => candidate.itemId === item.itemId);
        if (planItem === undefined) throw new Error("Persisted import item is missing from its frozen plan.");
        return resultFromUpdate(item, planItem.action);
      });
    return {
      operationId: operation.plan.operationId,
      state: operation.operation.state,
      items,
      error: operation.operation.error,
    };
  }
}

export type ImportOperationDuplicateInput = Parameters<typeof reviewDuplicatesOnDemand>[0];
export type ImportOperationDuplicateHasher = (
  candidate: DuplicateCandidate,
) => Promise<FingerprintCandidateResult>;
export type ImportOperationDngAdapter = DngAdapter;
