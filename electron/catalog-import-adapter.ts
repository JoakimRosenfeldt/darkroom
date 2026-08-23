import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  canonicalJson,
  parseFileObservation,
  parseJsonValue,
  parseFrozenImportPlan,
  sameFileObservation,
  type FileObservation,
  type FrozenImportPlan,
  type ImportPlanItem,
  type ImportSource,
  type JsonValue,
} from "../lib/import/domain.ts";
import {
  getFormatCapability,
} from "../lib/formats/index.ts";
import {
  CATALOG_LIVE_MAX_MUTATIONS,
  parseCatalogLiveApplyResult,
  parseCatalogLiveQueryResult,
  type CatalogLiveApplyInput,
  type CatalogLiveApplyResult,
  type CatalogLiveOperation,
  type CatalogLiveOperationItem,
  type CatalogLiveOperationItemPayload,
  type CatalogLiveOperationPayload,
  type CatalogLiveOperationState,
  type CatalogLiveState,
  type CatalogLiveObservation,
  type CatalogLiveMutation,
  type CatalogLiveQueryInput,
} from "../lib/catalog/live.ts";
import {
  parseRelativePath,
  parseSessionId,
  type SessionId,
} from "../lib/catalog/runtime.ts";
import {
  verifyFrozenImportPlan,
} from "./import-plan-service.ts";
import type {
  CatalogFaultInjector,
} from "./catalog-fault-injection.ts";
import {
  createNoopCatalogFaultInjector,
  type CatalogFaultStage,
} from "./catalog-fault-injection.ts";
import type {
  FileTransactionFileSystem,
  FileTransactionJournal,
  FileTransactionPathResolver,
  FileTransactionXmpStatus,
  ResolvedTransactionPaths,
} from "./file-transaction-service.ts";
import type {
  FrozenImportOperation,
  ImportMetadataDefaults,
  ImportOperationCatalogPort,
  ImportOperationFilePort,
  ImportOperationItemUpdate,
  ImportOperationMetadataPort,
  ImportOperationServiceDependencies,
  ImportOperationSourcePort,
  ImportOperationState,
} from "./import-operation-service.ts";
import type { CatalogLiveWorkerPort } from "./catalog-coordinator.ts";

export const CATALOG_IMPORT_OPERATION_KIND = "import" as const;

export interface CatalogImportSessionBinding {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

export type CatalogImportSessionAssertion = (
  binding: CatalogImportSessionBinding,
) => void | Promise<void>;

export interface CatalogImportSourceRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly relativePath: string;
}

export interface CatalogImportSourcePort {
  readonly observe: (request: CatalogImportSourceRequest) => Promise<unknown>;
}

export interface CatalogImportPathRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly action: ImportPlanItem["action"];
  readonly sourceRootId: RootId;
  readonly sourceRelativePath: string;
  readonly destinationRootId: RootId;
  readonly destinationRelativePath: string;
  readonly xmpDestinationRelativePath: string | null;
}

export interface CatalogImportPathPort {
  readonly resolve: (request: CatalogImportPathRequest) => Promise<ResolvedTransactionPaths>;
}

export interface CatalogImportDestinationObservationRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly relativePath: string;
}

export interface CatalogImportDestinationObservationPort {
  readonly observe: (request: CatalogImportDestinationObservationRequest) => Promise<unknown>;
}

export interface CatalogImportExternalSourceRegistration {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly item: ImportPlanItem;
  readonly observation: FileObservation;
  readonly xmpStatus: FileTransactionXmpStatus;
}

export interface CatalogImportExternalSourceRegistrar {
  readonly register: (input: CatalogImportExternalSourceRegistration) => Promise<unknown>;
}

export interface CatalogImportAdapterOptions {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  readonly assertCurrentSession: CatalogImportSessionAssertion;
  readonly source: CatalogImportSourcePort | CatalogImportSourcePort["observe"];
  readonly paths: CatalogImportPathPort | CatalogImportPathPort["resolve"];
  readonly destinationObservation?: CatalogImportDestinationObservationPort | CatalogImportDestinationObservationPort["observe"];
  readonly externalSourceRegistrar?: CatalogImportExternalSourceRegistrar;
  readonly journal: FileTransactionJournal;
  readonly fileSystem?: FileTransactionFileSystem;
  readonly faultInjector?: CatalogFaultInjector;
  readonly now?: () => number;
  readonly autoImport?: ImportOperationServiceDependencies["autoImport"];
}

type ImportOperationStatus = ImportOperationItemUpdate["status"];
type CatalogOperationItemStatus = NonNullable<CatalogLiveOperationItemPayload["status"]>;

interface CatalogImportRawDestinationObservation {
  readonly observation: FileObservation;
  readonly formatId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function metadataString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function parseImportSource(value: unknown): ImportSource {
  if (!isRecord(value)) throw new Error("Import source observation is invalid.");
  const xmpState = value.xmpState;
  if (xmpState !== "absent" && xmpState !== "present" && xmpState !== "unreadable") {
    throw new Error("Import source XMP state is invalid.");
  }
  return {
    rootId: parseRootId(value.rootId),
    relativePath: parseRelativePath(value.relativePath),
    observation: parseFileObservation(value.observation),
    xmpState,
    formatId: requiredString(value.formatId, "Import source formatId"),
  };
}

function parseDestinationObservation(value: unknown): CatalogImportRawDestinationObservation {
  if (isRecord(value) && "observation" in value) {
    return {
      observation: parseFileObservation(value.observation),
      ...(value.formatId === undefined ? {} : { formatId: requiredString(value.formatId, "Destination formatId") }),
    };
  }
  return { observation: parseFileObservation(value) };
}

function sameSourceObservation(expected: ImportSource, actual: ImportSource): boolean {
  return expected.rootId === actual.rootId &&
    expected.relativePath === actual.relativePath &&
    expected.xmpState === actual.xmpState &&
    expected.formatId === actual.formatId &&
    sameFileObservation(expected.observation, actual.observation);
}

function observationToLive(observation: FileObservation): NonNullable<CatalogLiveObservation["observation"]> {
  return {
    byteLength: observation.size,
    modifiedAt: observation.modifiedAt,
    observedAt: observation.observedAt,
    localFileId: observation.localFileId,
  };
}

function stageRank(stage: CatalogFaultStage): number {
  switch (stage) {
    case "planned": return 0;
    case "destination-prepared": return 1;
    case "destination-published": return 2;
    case "catalog-applied": return 3;
    case "source-cleaned": return 4;
  }
}

function statusRank(status: ImportOperationStatus): number {
  switch (status) {
    case "planned": return 0;
    case "running": return 1;
    case "completed":
    case "skipped":
    case "failed":
    case "cancelled": return 2;
  }
}

function catalogStatusRank(status: CatalogOperationItemStatus): number {
  switch (status) {
    case "planned": return 0;
    case "running": return 1;
    case "completed":
    case "skipped":
    case "failed":
    case "cancelled": return 2;
  }
}

function liveStateForItem(update: ImportOperationItemUpdate): CatalogLiveOperationState {
  return update.status === "skipped" ? "completed" : update.state;
}

function parseImportItemStatus(
  row: CatalogLiveOperationItem,
  fallback: ImportOperationStatus,
): ImportOperationStatus {
  const value = row.payload.status ?? fallback;
  if (value !== "planned" && value !== "running" && value !== "completed" && value !== "skipped" && value !== "failed" && value !== "cancelled") {
    throw new Error("Persisted import operation item status is invalid.");
  }
  return value;
}

function fallbackStatusForState(state: CatalogLiveOperationState): Exclude<ImportOperationStatus, "skipped"> {
  return state;
}

function ensureFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function clonePlan(plan: FrozenImportPlan): FrozenImportPlan {
  return parseFrozenImportPlan(structuredClone(plan));
}

function planValue(plan: FrozenImportPlan): JsonValue {
  return parseJsonValue(structuredClone(plan), "Frozen import plan");
}

function assertPlanIdentity(plan: FrozenImportPlan, binding: CatalogImportSessionBinding): void {
  verifyFrozenImportPlan(plan);
  if (plan.catalogId !== binding.catalogId) throw new Error("Import plan belongs to a different catalog.");
  const itemIds = new Set<AssetId>();
  for (const item of plan.items) {
    const itemId = parseAssetId(item.itemId);
    if (itemIds.has(itemId)) throw new Error("Frozen import plan contains duplicate item IDs.");
    itemIds.add(itemId);
    if (item.action === "move" || item.action === "rename") {
      if (item.sourceAssetId !== null && item.destinationAssetId !== item.sourceAssetId) {
        throw new Error("Move and rename plans must retain their source AssetId.");
      }
    }
  }
}

function operationState(value: CatalogLiveOperationState): ImportOperationState {
  return value;
}

function itemState(value: CatalogLiveOperationState): ImportOperationState {
  return value;
}

function operationPayloadFor(
  plan: FrozenImportPlan,
  error: string | null,
): CatalogLiveOperationPayload {
  return {
    version: 1,
    kind: CATALOG_IMPORT_OPERATION_KIND,
    planHash: plan.planSha256,
    plan: planValue(plan),
    error,
  };
}

function itemPayloadFor(
  plan: FrozenImportPlan,
  item: ImportPlanItem,
  update: ImportOperationItemUpdate,
): CatalogLiveOperationItemPayload {
  return {
    version: 1,
    stage: update.stage,
    action: item.action,
    sourceRootId: item.source.rootId,
    sourceRelativePath: item.source.relativePath,
    destinationRootId: plan.destinationRootId,
    destinationRelativePath: item.destinationRelativePath,
    xmpStatus: update.xmpStatus,
    status: update.status,
    error: update.error,
    updatedAt: ensureFinite(update.updatedAt, "Import item updatedAt"),
  };
}

function assertApplyCatalog(result: CatalogLiveApplyResult, catalogId: CatalogId): void {
  if (result.catalogId !== catalogId) throw new Error("Catalog import apply returned a mismatched catalog.");
}

function itemById(operation: CatalogLiveOperation, itemId: AssetId): CatalogLiveOperationItem {
  const item = operation.items.find((candidate) => candidate.itemId === itemId);
  if (item === undefined) throw new Error("Persisted import operation item is missing.");
  return item;
}

function operationById(state: CatalogLiveState, operationId: OperationId): CatalogLiveOperation | null {
  return state.operations.find((operation) => operation.operationId === operationId) ?? null;
}

function assertItemPayloadMatchesPlan(
  operation: CatalogLiveOperation,
  plan: FrozenImportPlan,
  planItem: ImportPlanItem,
  row: CatalogLiveOperationItem,
): void {
  if (row.operationId !== plan.operationId || row.itemId !== planItem.itemId) {
    throw new Error("Persisted import operation item identity is invalid.");
  }
  const payload = row.payload;
  if (
    payload.action !== planItem.action ||
    payload.sourceRootId !== planItem.source.rootId ||
    payload.sourceRelativePath !== planItem.source.relativePath ||
    payload.destinationRootId !== plan.destinationRootId ||
    payload.destinationRelativePath !== planItem.destinationRelativePath
  ) throw new Error("Persisted import operation item plan is invalid.");
  if (operation.operationId !== plan.operationId) throw new Error("Persisted import operation identity is invalid.");
}

function assetIdForPersistedItem(
  planItem: ImportPlanItem,
  row: CatalogLiveOperationItem,
): AssetId {
  if (row.assetId === null) {
    if (row.payload.status === "skipped") return planItem.destinationAssetId;
    if (stageRank(row.payload.stage) >= stageRank("catalog-applied")) {
      throw new Error("Persisted catalog-applied import item has no AssetId.");
    }
    return planItem.destinationAssetId;
  }
  const assetId = parseAssetId(row.assetId);
  if (assetId !== planItem.destinationAssetId) throw new Error("Persisted import item AssetId does not match the frozen plan.");
  return assetId;
}

function matchesAsset(
  asset: CatalogLiveState["assets"][number],
  rootId: RootId,
  relativePath: string,
  observation: FileObservation,
): boolean {
  return asset.rootId === rootId && asset.relativePath === relativePath && asset.health === "present" &&
    asset.observation !== null &&
    asset.observation.byteLength === observation.size &&
    asset.observation.modifiedAt === observation.modifiedAt &&
    asset.observation.localFileId === observation.localFileId;
}

export class CatalogImportAdapter implements ImportOperationCatalogPort, ImportOperationSourcePort, ImportOperationMetadataPort {
  private readonly binding: CatalogImportSessionBinding;
  private readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  private readonly assertCurrentSession: CatalogImportSessionAssertion;
  private readonly sourcePort: CatalogImportSourcePort["observe"];
  private readonly pathPort: CatalogImportPathPort["resolve"];
  private readonly destinationObservation: CatalogImportDestinationObservationPort["observe"] | undefined;
  private readonly externalRegistrar: CatalogImportExternalSourceRegistrar | undefined;
  private readonly journal: FileTransactionJournal;
  private readonly fileSystem: FileTransactionFileSystem | undefined;
  private readonly faultInjector: CatalogFaultInjector;
  private readonly now: () => number;
  private readonly destinationRootsByItem = new Map<AssetId, RootId>();

  public readonly files: ImportOperationFilePort;

  public constructor(options: CatalogImportAdapterOptions) {
    this.binding = {
      catalogId: parseCatalogId(options.catalogId),
      sessionId: parseSessionId(options.sessionId),
    };
    this.worker = options.worker;
    this.assertCurrentSession = options.assertCurrentSession;
    this.sourcePort = typeof options.source === "function" ? options.source : options.source.observe;
    this.pathPort = typeof options.paths === "function" ? options.paths : options.paths.resolve;
    this.destinationObservation = options.destinationObservation === undefined
      ? undefined
      : typeof options.destinationObservation === "function"
        ? options.destinationObservation
        : options.destinationObservation.observe;
    this.externalRegistrar = options.externalSourceRegistrar;
    this.journal = options.journal;
    this.fileSystem = options.fileSystem;
    this.faultInjector = options.faultInjector ?? createNoopCatalogFaultInjector();
    this.now = options.now ?? Date.now;
    this.files = {
      paths: {
        resolve: (item) => this.runNative("Import transaction paths are unavailable.", () => this.pathPort({
          catalogId: this.binding.catalogId,
          sessionId: this.binding.sessionId,
          action: item.action,
          sourceRootId: item.source.rootId,
          sourceRelativePath: item.source.relativePath,
          destinationRootId: this.destinationRootFor(item),
          destinationRelativePath: item.destinationRelativePath,
          xmpDestinationRelativePath: item.xmpDestinationRelativePath,
        })),
      } satisfies FileTransactionPathResolver,
      journal: {
        read: (operationId, itemId) => this.runNative("Import transaction journal is unavailable.", () => this.journal.read(operationId, itemId)),
        write: (record) => this.runNative("Import transaction journal is unavailable.", () => this.journal.write(record)),
        list: (operationId) => this.runNative("Import transaction journal is unavailable.", () => this.journal.list(operationId)),
      } satisfies FileTransactionJournal,
      faultInjector: this.faultInjector,
      ...(this.fileSystem === undefined ? {} : { fileSystem: this.guardedFileSystem(this.fileSystem) }),
    };
  }

  public dependencies(): ImportOperationServiceDependencies {
    return {
      catalog: this,
      metadata: this,
      source: this,
      files: this.files,
    };
  }

  public async observe(item: ImportPlanItem): Promise<ImportSource> {
    const observed = await this.runNative("Import source observation is unavailable.", () => this.sourcePort({
      catalogId: this.binding.catalogId,
      sessionId: this.binding.sessionId,
      rootId: item.source.rootId,
      relativePath: item.source.relativePath,
    }));
    const parsed = parseImportSource(observed);
    if (!sameSourceObservation(item.source, parsed)) {
      throw new Error(`Import source observation is stale for item ${item.itemId}.`);
    }
    if (getFormatCapability(parsed.formatId) === null) {
      throw new Error("Import source format is not recognized.");
    }
    return parsed;
  }

  public async persistFrozenPlan(operation: FrozenImportOperation): Promise<void> {
    assertPlanIdentity(operation.plan, this.binding);
    if (operation.operation.operationId !== operation.plan.operationId) throw new Error("Import operation identity does not match its plan.");
    if (operation.items.length !== operation.plan.items.length) throw new Error("Import operation items do not match its plan.");
    if (operation.items.length + 1 > CATALOG_LIVE_MAX_MUTATIONS) throw new Error("Frozen import plan is too large to persist atomically.");
    const byId = new Map(operation.items.map((item) => [item.itemId, item] as const));
    if (byId.size !== operation.items.length) throw new Error("Import operation contains duplicate item IDs.");
    for (const planItem of operation.plan.items) {
      const item = byId.get(planItem.itemId);
      if (
        item === undefined ||
        item.operationId !== operation.plan.operationId ||
        item.assetId !== planItem.destinationAssetId ||
        item.state !== "planned" ||
        item.status !== "planned" ||
        item.stage !== "planned"
      ) {
        throw new Error("Import operation item does not match its frozen plan.");
      }
    }
    for (const planItem of operation.plan.items) {
      this.destinationRootsByItem.set(planItem.itemId, operation.plan.destinationRootId);
    }
    const state = await this.query();
    const mutations: CatalogLiveMutation[] = [{
      kind: "operation-upsert",
      operation: {
        operationId: operation.plan.operationId,
        kind: CATALOG_IMPORT_OPERATION_KIND,
        state: operation.operation.state,
        payload: operationPayloadFor(operation.plan, operation.operation.error),
        createdAt: ensureFinite(operation.plan.createdAt, "Import plan createdAt"),
        updatedAt: ensureFinite(operation.operation.updatedAt, "Import operation updatedAt"),
      },
    }];
    for (const planItem of operation.plan.items) {
      const item = byId.get(planItem.itemId)!;
      mutations.push({
        kind: "operation-item-upsert",
        item: {
          operationId: operation.plan.operationId,
          itemId: planItem.itemId,
          assetId: null,
          state: liveStateForItem(item),
          payload: itemPayloadFor(operation.plan, planItem, item),
        },
      });
    }
    const result = await this.applyAtRevision(state.catalog.revision, mutations);
    assertApplyCatalog(result, this.binding.catalogId);
  }

  public async loadFrozenOperation(operationId: OperationId): Promise<FrozenImportOperation | null> {
    const parsedOperationId = parseOperationId(operationId);
    const state = await this.query();
    const operation = operationById(state, parsedOperationId);
    if (operation === null) return null;
    if (operation.kind !== CATALOG_IMPORT_OPERATION_KIND) throw new Error("Persisted import operation kind is invalid.");
    const plan = parseFrozenImportPlan(operation.payload.plan);
    assertPlanIdentity(plan, this.binding);
    if (plan.operationId !== parsedOperationId || operation.payload.planHash !== plan.planSha256) {
      throw new Error("Persisted frozen import plan hash does not match its operation.");
    }
    if (operation.payload.kind !== CATALOG_IMPORT_OPERATION_KIND) throw new Error("Persisted import operation payload kind is invalid.");
    if (operation.createdAt !== plan.createdAt) throw new Error("Persisted import operation timestamp does not match its plan.");
    for (const planItem of plan.items) this.destinationRootsByItem.set(planItem.itemId, plan.destinationRootId);
    const items = plan.items.map((planItem): ImportOperationItemUpdate => {
      const row = itemById(operation, parseAssetId(planItem.itemId));
      assertItemPayloadMatchesPlan(operation, plan, planItem, row);
      if (
        row.payload.stage === "planned" &&
        row.payload.xmpStatus !== (planItem.source.xmpState === "present" ? "preserved" : "absent")
      ) throw new Error("Persisted planned import item XMP status is invalid.");
      const fallback = fallbackStatusForState(itemState(row.state));
      const status = parseImportItemStatus(row, fallback);
      const expectedState = status === "skipped" ? "completed" : status;
      if (expectedState !== row.state) {
        throw new Error("Persisted import operation item state is invalid.");
      }
      return {
        operationId: plan.operationId,
        itemId: planItem.itemId,
        assetId: assetIdForPersistedItem(planItem, row),
        state: itemState(row.state),
        status,
        stage: row.payload.stage,
        xmpStatus: row.payload.xmpStatus ?? (planItem.source.xmpState === "present" ? "preserved" : "absent"),
        error: row.payload.error ?? null,
        updatedAt: row.payload.updatedAt ?? operation.updatedAt,
      };
    });
    if (operation.items.length !== plan.items.length) throw new Error("Persisted import operation item IDs do not match its plan.");
    return {
      plan: clonePlan(plan),
      operation: {
        operationId: plan.operationId,
        state: operationState(operation.state),
        error: operation.payload.error ?? null,
        updatedAt: operation.updatedAt,
      },
      items,
    };
  }

  public async updateOperation(update: FrozenImportOperation["operation"]): Promise<void> {
    const operationId = parseOperationId(update.operationId);
    const state = await this.query();
    const operation = operationById(state, operationId);
    if (operation === null) throw new Error("Persisted import operation is missing.");
    const plan = parseFrozenImportPlan(operation.payload.plan);
    assertPlanIdentity(plan, this.binding);
    for (const planItem of plan.items) this.destinationRootsByItem.set(planItem.itemId, plan.destinationRootId);
    if (operation.payload.planHash !== plan.planSha256 || operation.kind !== CATALOG_IMPORT_OPERATION_KIND) {
      throw new Error("Persisted frozen import plan hash does not match its operation.");
    }
    const result = await this.applyAtRevision(state.catalog.revision, [{
      kind: "operation-upsert",
      operation: {
        operationId,
        kind: operation.kind,
        state: update.state,
        payload: { ...operation.payload, error: update.error },
        createdAt: operation.createdAt,
        updatedAt: ensureFinite(update.updatedAt, "Import operation updatedAt"),
      },
    }]);
    assertApplyCatalog(result, this.binding.catalogId);
  }

  public async updateItem(update: ImportOperationItemUpdate): Promise<void> {
    const operationId = parseOperationId(update.operationId);
    const itemId = parseAssetId(update.itemId);
    const state = await this.query();
    const operation = operationById(state, operationId);
    if (operation === null) throw new Error("Persisted import operation is missing.");
    const plan = parseFrozenImportPlan(operation.payload.plan);
    assertPlanIdentity(plan, this.binding);
    for (const planItem of plan.items) this.destinationRootsByItem.set(planItem.itemId, plan.destinationRootId);
    const planItem = plan.items.find((item) => item.itemId === itemId);
    if (planItem === undefined) throw new Error("Import operation item is not in the frozen plan.");
    const row = itemById(operation, itemId);
    assertItemPayloadMatchesPlan(operation, plan, planItem, row);
    const oldStatus = row.payload.status ?? fallbackStatusForState(itemState(row.state));
    if (statusRank(update.status) < catalogStatusRank(oldStatus)) throw new Error("Import operation item status is not monotonic.");
    if (catalogStatusRank(oldStatus) === 2 && update.status !== oldStatus) throw new Error("Import operation item status is terminal.");
    const requestedAssetId = update.assetId === null ? null : parseAssetId(update.assetId);
    const oldAssetId = row.assetId === null ? null : parseAssetId(row.assetId);
    if (oldAssetId !== null && oldAssetId !== requestedAssetId) throw new Error("Import operation item AssetId is immutable.");
    const stageAtOrAfterCatalog = stageRank(update.stage) >= stageRank("catalog-applied");
    if (stageAtOrAfterCatalog && requestedAssetId !== planItem.destinationAssetId) {
      throw new Error("Catalog-applied import item must use its planned AssetId.");
    }
    const skippedWithoutAsset = update.status === "skipped" &&
      requestedAssetId === planItem.destinationAssetId &&
      !state.assets.some((asset) => asset.assetId === requestedAssetId);
    const persistedAssetId = skippedWithoutAsset
      ? null
      : stageAtOrAfterCatalog
        ? requestedAssetId
        : oldAssetId;
    const nextPayload: CatalogLiveOperationItemPayload = {
      ...row.payload,
      stage: update.stage,
      xmpStatus: update.xmpStatus,
      status: update.status,
      error: update.error,
      updatedAt: ensureFinite(update.updatedAt, "Import item updatedAt"),
    };
    const result = await this.applyAtRevision(state.catalog.revision, [{
      kind: "operation-item-upsert",
      item: {
        operationId,
        itemId,
        assetId: persistedAssetId,
        state: liveStateForItem(update),
        payload: nextPayload,
      },
    }]);
    assertApplyCatalog(result, this.binding.catalogId);
  }

  public async registerSource(item: ImportPlanItem): Promise<void> {
    if (item.action !== "add") throw new Error("Only Add imports can register a source.");
    const observed = await this.observe(item);
    const format = getFormatCapability(observed.formatId);
    if (format === null) throw new Error("Import source format is not recognized.");
    const state = await this.query();
    if (!state.roots.some((root) => root.rootId === item.source.rootId)) {
      throw new Error("Import source root is not in the active catalog.");
    }
    const existingAsset = state.assets.find((asset) => asset.assetId === item.destinationAssetId);
    if (existingAsset !== undefined && !matchesAsset(existingAsset, item.source.rootId, item.source.relativePath, observed.observation)) {
      throw new Error("Import source AssetId is already assigned to another location.");
    }
    const pathAsset = state.assets.find((asset) => asset.rootId === item.source.rootId && asset.relativePath === item.source.relativePath);
    if (pathAsset !== undefined && pathAsset.assetId !== item.destinationAssetId) {
      throw new Error("Import source location is already assigned to another AssetId.");
    }
    const mutation: CatalogLiveMutation = {
      kind: "reconcile",
      rootId: item.source.rootId,
      complete: false,
      observations: [{
        assetId: item.destinationAssetId,
        relativePath: item.source.relativePath,
        observation: observationToLive(observed.observation),
        health: "present",
        formatId: observed.formatId,
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
      }],
    };
    const result = await this.applyAtRevision(state.catalog.revision, [mutation]);
    assertApplyCatalog(result, this.binding.catalogId);
  }

  public async applyFileTransaction(item: ImportPlanItem, xmpStatus: FileTransactionXmpStatus): Promise<void> {
    if (item.action === "add") throw new Error("Add imports must register their source.");
    if (xmpStatus !== "absent" && xmpStatus !== "preserved" && xmpStatus !== "mismatch") {
      throw new Error("Import transaction XMP status is invalid.");
    }
    const destination = await this.destinationFor(item);
    const state = await this.query();
    const destinationRootId = this.destinationRootFor(item);
    if (!state.roots.some((root) => root.rootId === destinationRootId)) {
      throw new Error("Import destination root is not in the active catalog.");
    }
    const observation = destination.observation;
    const sourceAssetId = await this.ensureSourceAsset(item, xmpStatus, state);
    if (sourceAssetId === null) throw new Error("Import source is not registered in the active catalog.");
    const freshState = await this.query();
    const sourceAsset = freshState.assets.find((asset) => asset.assetId === sourceAssetId);
    if (sourceAsset === undefined) throw new Error("Import source is not registered in the active catalog.");
    const existingDestination = freshState.assets.find((asset) => asset.assetId === item.destinationAssetId);
    if (item.action === "move" || item.action === "rename") {
      if (sourceAssetId !== item.destinationAssetId) throw new Error("Move and rename imports must retain their AssetId.");
      if (existingDestination !== undefined && matchesAsset(existingDestination, destinationRootId, item.destinationRelativePath, observation)) return;
      const result = await this.applyAtRevision(freshState.catalog.revision, [{
        kind: "asset-relocate",
        assetId: item.destinationAssetId,
        rootId: destinationRootId,
        relativePath: item.destinationRelativePath,
        observation: observationToLive(observation),
        health: "present",
      }]);
      assertApplyCatalog(result, this.binding.catalogId);
      return;
    }
    if (item.action !== "copy") throw new Error("Import transaction action is invalid.");
    if (existingDestination !== undefined) {
      if (!matchesAsset(existingDestination, destinationRootId, item.destinationRelativePath, observation)) {
        throw new Error("Import destination AssetId is already assigned to another location.");
      }
      return;
    }
    const result = await this.applyAtRevision(freshState.catalog.revision, [{
      kind: "asset-copy",
      sourceAssetId,
      newAssetId: item.destinationAssetId,
      rootId: destinationRootId,
      relativePath: item.destinationRelativePath,
      observation: observationToLive(observation),
      health: "present",
    }]);
    assertApplyCatalog(result, this.binding.catalogId);
  }

  public async apply(assetId: AssetId, defaults: ImportMetadataDefaults): Promise<void> {
    const parsedAssetId = parseAssetId(assetId);
    if (!isRecord(defaults) || !Array.isArray(defaults.keywords)) throw new Error("Import metadata defaults are invalid.");
    const title = metadataString(defaults.title, "Import title");
    const caption = metadataString(defaults.caption, "Import caption");
    const copyright = metadataString(defaults.copyright, "Import copyright");
    const keywords = defaults.keywords.map((keyword) => {
      if (typeof keyword !== "string" || keyword.includes("\u0000")) throw new Error("Import keyword is invalid.");
      return keyword;
    });
    const develop = defaults.develop === null
      ? null
      : canonicalJson(parseJsonValue(defaults.develop, "Import Develop defaults"));
    const timestamp = ensureFinite(this.now(), "Import metadata timestamp");
    const state = await this.query();
    if (!state.assets.some((candidate) => candidate.assetId === parsedAssetId)) {
      throw new Error("Import metadata AssetId is not in the active catalog.");
    }
    const mutation: CatalogLiveMutation = {
      kind: "metadata-patch",
      assetId: parsedAssetId,
      patch: {
        version: 1,
        title,
        caption,
        copyright,
        keywordsJson: canonicalJson(keywords),
        developJson: develop,
        developUpdatedAt: timestamp,
        updatedAt: timestamp,
      },
    };
    const result = await this.applyAtRevision(state.catalog.revision, [mutation]);
    assertApplyCatalog(result, this.binding.catalogId);
  }

  private destinationRootFor(item: ImportPlanItem): RootId {
    if (item.action === "add") return item.source.rootId;
    const destinationRoot = this.destinationRootsByItem.get(item.itemId);
    if (destinationRoot === undefined) throw new Error("Import plan destination is unavailable.");
    return destinationRoot;
  }

  private async destinationFor(item: ImportPlanItem): Promise<CatalogImportRawDestinationObservation> {
    if (this.destinationObservation === undefined) {
      return { observation: item.source.observation, formatId: item.source.formatId };
    }
    const result = await this.runNative("Import destination observation is unavailable.", () => this.destinationObservation!({
      catalogId: this.binding.catalogId,
      sessionId: this.binding.sessionId,
      rootId: this.destinationRootFor(item),
      relativePath: item.destinationRelativePath,
    }));
    const parsed = parseDestinationObservation(result);
    if (parsed.formatId !== undefined && parsed.formatId !== item.source.formatId) {
      throw new Error("Import destination format does not match the frozen plan.");
    }
    if (getFormatCapability(parsed.formatId ?? item.source.formatId) === null) {
      throw new Error("Import destination format is not recognized.");
    }
    return { ...parsed, formatId: parsed.formatId ?? item.source.formatId };
  }

  private async ensureSourceAsset(
    item: ImportPlanItem,
    xmpStatus: FileTransactionXmpStatus,
    state: CatalogLiveState,
  ): Promise<AssetId> {
    const requested = item.sourceAssetId;
    if (requested !== null && state.assets.some((asset) => asset.assetId === requested)) return requested;
    if (this.externalRegistrar === undefined) {
      throw new Error("Import source is not registered in the active catalog.");
    }
    const result = await this.runNative("Import source registration is unavailable.", () => this.externalRegistrar!.register({
      catalogId: this.binding.catalogId,
      sessionId: this.binding.sessionId,
      item,
      observation: item.source.observation,
      xmpStatus,
    }));
    if (isRecord(result) && "assetId" in result) return parseAssetId(result.assetId);
    return parseAssetId(result);
  }

  private async query(): Promise<CatalogLiveState> {
    const input: CatalogLiveQueryInput = { catalogId: this.binding.catalogId, expectedRevision: null };
    const value = await this.runWorker("Catalog import query failed.", () => this.worker.liveQuery(input));
    const state = parseCatalogLiveQueryResult(value);
    if (state.catalog.catalogId !== this.binding.catalogId) throw new Error("Catalog import query returned a mismatched catalog.");
    return state;
  }

  private async applyAtRevision(
    expectedRevision: number,
    mutations: readonly CatalogLiveMutation[],
  ): Promise<CatalogLiveApplyResult> {
    const input: CatalogLiveApplyInput = {
      catalogId: this.binding.catalogId,
      expectedRevision,
      mutations,
      now: ensureFinite(this.now(), "Catalog import timestamp"),
    };
    const value = await this.runWorker("Catalog import apply failed.", () => this.worker.liveApply(input));
    return parseCatalogLiveApplyResult(value);
  }

  private async runWorker<T>(message: string, operation: () => Promise<T>): Promise<T> {
    return this.runGuarded(operation, message, false);
  }

  private async runNative<T>(message: string, operation: () => Promise<T>): Promise<T> {
    return this.runGuarded(operation, message, true);
  }

  private async runGuarded<T>(operation: () => Promise<T>, message: string, sanitizeError: boolean): Promise<T> {
    await this.assertCurrentSession(this.binding);
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      await this.assertCurrentSession(this.binding);
      if (!sanitizeError) throw error;
      throw new Error(message);
    }
    await this.assertCurrentSession(this.binding);
    return value;
  }

  private guardedFileSystem(fileSystem: FileTransactionFileSystem): FileTransactionFileSystem {
    return {
      exists: (filePath) => this.runNative("Import file access is unavailable.", () => fileSystem.exists(filePath)),
      mkdir: (directoryPath) => this.runNative("Import file access is unavailable.", () => fileSystem.mkdir(directoryPath)),
      copyFile: (sourcePath, destinationPath) => this.runNative("Import file access is unavailable.", () => fileSystem.copyFile(sourcePath, destinationPath)),
      rename: (sourcePath, destinationPath) => this.runNative("Import file access is unavailable.", () => fileSystem.rename(sourcePath, destinationPath)),
      removeFile: (filePath) => this.runNative("Import file access is unavailable.", () => fileSystem.removeFile(filePath)),
      observe: (filePath) => this.runNative("Import file access is unavailable.", () => fileSystem.observe(filePath)),
      digest: (filePath) => this.runNative("Import file access is unavailable.", () => fileSystem.digest(filePath)),
      verifyCopy: (sourcePath, destinationPath, expectedSource) => this.runNative("Import file access is unavailable.", () => fileSystem.verifyCopy(sourcePath, destinationPath, expectedSource)),
      verifyObservation: (filePath, expected) => this.runNative("Import file access is unavailable.", () => fileSystem.verifyObservation(filePath, expected)),
    };
  }
}

export function createCatalogImportAdapter(options: CatalogImportAdapterOptions): CatalogImportAdapter {
  return new CatalogImportAdapter(options);
}

export function createCatalogImportOperationDependencies(
  options: CatalogImportAdapterOptions,
): ImportOperationServiceDependencies {
  const adapter = new CatalogImportAdapter(options);
  return {
    ...adapter.dependencies(),
    ...(options.autoImport === undefined ? {} : { autoImport: options.autoImport }),
  };
}

export type CatalogImportOperationDependencies = ImportOperationServiceDependencies;
