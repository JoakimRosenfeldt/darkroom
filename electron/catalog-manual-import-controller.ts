import fs from "node:fs/promises";
import path from "node:path";
import {
  createAssetId,
  createPresetId,
  parseCatalogId,
  parsePresetId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type PresetId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  parseCatalogImportOperationRequest,
  parseCatalogImportPrepareRequest,
  type CatalogImportDraftView,
  type CatalogImportExecutionView,
  type CatalogImportItemResultView,
  type CatalogImportPrepareRequest,
  type CatalogImportPreparedItemView,
} from "../lib/import/api.ts";
import {
  parseJsonValue,
  type FileObservation,
  type ImportDestinationDecision,
  type ImportPlanDraft,
  type ImportPlanItem,
  type ImportPlanReview,
  type ImportPreset,
  type ImportSource,
} from "../lib/import/domain.ts";
import { getFormatCapabilityForFileName } from "../lib/formats/index.ts";
import {
  parseCatalogLiveQueryResult,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import { parseRelativePath, parseSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import type { CatalogLiveWorkerPort } from "./catalog-coordinator.ts";
import {
  fingerprintCandidate,
  observeNoFollowFile,
  reviewDuplicatesOnDemand,
  type DuplicateCandidate,
} from "./catalog-fingerprint-service.ts";
import {
  CatalogImportAdapter,
  CATALOG_IMPORT_OPERATION_KIND,
  type CatalogImportSessionAssertion,
  type CatalogImportSessionBinding,
} from "./catalog-import-adapter.ts";
import type { CatalogFaultInjector } from "./catalog-fault-injection.ts";
import {
  createNoopCatalogFaultInjector,
} from "./catalog-fault-injection.ts";
import {
  ImportOperationCancelledError,
  ImportOperationService,
  type ImportOperationExecution,
} from "./import-operation-service.ts";
import {
  randomOperationId,
  type ImportPlanSourceInput,
} from "./import-plan-service.ts";
import type {
  FileTransactionFileSystem,
  FileTransactionJournal,
  ResolvedTransactionPaths,
} from "./file-transaction-service.ts";

const MAX_SELECTION = 500;
const DEFAULT_DRAFT_TTL_MS = 15 * 60 * 1000;
const DNG_UNAVAILABLE_REASON = "DNG import is unavailable until a conversion backend exists.";

export interface CatalogManualImportRoot {
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly nativePath: string;
}

export interface CatalogManualImportPickerRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

export type CatalogManualImportPickedFile = string | { readonly path: string };
export type CatalogManualImportPickerResult =
  | readonly CatalogManualImportPickedFile[]
  | { readonly paths: readonly CatalogManualImportPickedFile[] }
  | { readonly files: readonly CatalogManualImportPickedFile[] }
  | null;

export interface CatalogManualImportControllerOptions {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  readonly assertCurrentSession: CatalogImportSessionAssertion;
  readonly getNativeSessionRoots: () => readonly CatalogManualImportRoot[];
  readonly chooseFiles: (
    request: CatalogManualImportPickerRequest,
  ) => Promise<CatalogManualImportPickerResult>;
  readonly journal: FileTransactionJournal;
  readonly fileSystem?: FileTransactionFileSystem;
  readonly faultInjector?: CatalogFaultInjector;
  readonly now?: () => number;
  readonly draftTtlMs?: number;
}

export interface CatalogManualImportRunOptions {
  readonly isCancelled?: () => boolean;
}

interface RootPath {
  readonly rootId: RootId;
  readonly nativePath: string;
}

interface PickedSource {
  readonly absolutePath: string;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly observation: FileObservation;
  readonly xmpState: ImportSource["xmpState"];
  readonly formatId: string;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  readonly sourceAssetId: AssetId | null;
  readonly blockingReason: string | null;
  readonly dng: boolean;
  readonly unsupported: boolean;
}

interface DraftContext {
  readonly request: CatalogImportPrepareRequest;
  readonly operationId: OperationId;
  readonly draft: ImportPlanDraft;
  readonly review: ImportPlanReview;
  readonly items: readonly CatalogImportPreparedItemView[];
  readonly view: CatalogImportDraftView;
  readonly canRun: boolean;
  readonly roots: readonly RootPath[];
  readonly expiresAt: number;
  cancelled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  return error.code;
}

function safeError(error: unknown, fallback = "Import operation failed."): Error {
  const message = error instanceof Error ? error.message : "";
  if (message.length === 0 || message.length > 500 || message.includes("/") || message.includes("\\")) {
    return new Error(fallback);
  }
  return new Error(message);
}

function safePublicMessage(message: string | null): string | null {
  if (message === null || message.length === 0 || message.length > 500 || message.includes("/") || message.includes("\\")) {
    return message === null ? null : "Import operation failed.";
  }
  return message;
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value === path.parse(value).root
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function normalizedRootPath(value: string): string {
  if (value === path.parse(value).root) return value;
  return normalizedAbsolutePath(value, "Import root path");
}

function relativePathForAbsolute(rootPath: string, absolutePath: string): string {
  const relative = path.relative(rootPath, absolutePath).replaceAll(path.sep, "/");
  if (relative.length === 0 || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Selected file is outside the active catalog root.");
  }
  return parseRelativePath(relative);
}

function absolutePathForRelative(rootPath: string, relativePath: string): string {
  const parsed = parseRelativePath(relativePath);
  const target = path.normalize(path.join(rootPath, ...parsed.split("/")));
  const relative = path.relative(rootPath, target);
  if (relative.length === 0 || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Import path escapes the active catalog root.");
  }
  return target;
}

function sourceName(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

function asFileObservation(value: CatalogLiveState["assets"][number]["observation"]): FileObservation | null {
  if (value === null || value.byteLength === null || value.modifiedAt === null) return null;
  return {
    size: value.byteLength,
    modifiedAt: value.modifiedAt,
    localFileId: value.localFileId,
    observedAt: value.observedAt,
  };
}

function sameObservation(
  left: FileObservation,
  right: CatalogLiveState["assets"][number]["observation"],
): boolean {
  return right !== null &&
    right.byteLength === left.size &&
    right.modifiedAt === left.modifiedAt &&
    (right.localFileId === null || left.localFileId === null || right.localFileId === left.localFileId);
}

async function inspectXmp(filePath: string): Promise<ImportSource["xmpState"]> {
  const sidecarPath = `${filePath.slice(0, -path.extname(filePath).length)}.xmp`;
  try {
    const stat = await fs.lstat(sidecarPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return "unreadable";
    return "present";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "absent";
    return "unreadable";
  }
}

async function assertNoSymlinkComponents(rootPath: string, targetPath: string): Promise<void> {
  const root = path.parse(rootPath).root;
  const relative = path.relative(root, targetPath);
  let current = root;
  for (const component of relative.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Import path traverses a symbolic link.");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

async function assertSafeParent(rootPath: string, targetPath: string): Promise<void> {
  const parent = path.dirname(targetPath);
  const relative = path.relative(rootPath, parent);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Import destination escapes the active catalog root.");
  }
  let current = rootPath;
  for (const component of relative.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Import destination parent is unsafe.");
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error("Import destination is a symbolic link.");
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function effectiveDestination(item: ImportPlanItem, review: ImportPlanReview): string {
  const decision = review.decisions.find((entry) => entry.itemId === item.itemId)?.decisions.destination;
  return decision?.kind === "rename" ? decision.destinationRelativePath : item.destinationRelativePath;
}

function decisionForItem(
  item: ImportPlanItem,
  review: ImportPlanReview,
): ImportPlanReview["decisions"][number]["decisions"] {
  return review.decisions.find((entry) => entry.itemId === item.itemId)?.decisions ?? {
    duplicate: null,
    destination: null,
  };
}

function itemOutcome(item: ImportPlanItem, review: ImportPlanReview): CatalogImportPreparedItemView["outcome"] {
  const decisions = decisionForItem(item, review);
  if (decisions.duplicate?.kind === "skip-incoming" || decisions.destination?.kind === "skip") return "skip";
  if (decisions.destination?.kind === "replace") return "replace";
  if (decisions.destination?.kind === "rename") return "rename";
  return "run";
}

function duplicateKind(
  itemId: AssetId,
  duplicateItems: ReadonlySet<AssetId>,
  uncheckedItems: ReadonlySet<AssetId>,
): CatalogImportPreparedItemView["duplicate"] {
  if (duplicateItems.has(itemId)) return "duplicate";
  if (uncheckedItems.has(itemId)) return "not-fully-checked";
  return "unique";
}

function itemResultView(item: ImportOperationExecution["items"][number]): CatalogImportItemResultView {
  return {
    itemId: item.itemId,
    destinationAssetId: item.destinationAssetId,
    stage: item.stage,
    status: item.status,
    xmpStatus: item.xmpStatus,
    sourceRetained: item.sourceRetained,
    error: safePublicMessage(item.error),
  };
}

function publicExecution(
  binding: CatalogImportSessionBinding,
  execution: ImportOperationExecution,
): CatalogImportExecutionView {
  return {
    catalogId: binding.catalogId,
    sessionId: binding.sessionId,
    operationId: execution.operationId,
    state: execution.state,
    items: execution.items.map(itemResultView),
    error: safePublicMessage(execution.error),
  };
}

export class CatalogManualImportController {
  private readonly binding: CatalogImportSessionBinding;
  private readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  private readonly assertCurrentSession: CatalogImportSessionAssertion;
  private readonly getNativeSessionRoots: CatalogManualImportControllerOptions["getNativeSessionRoots"];
  private readonly chooseFiles: CatalogManualImportControllerOptions["chooseFiles"];
  private readonly journal: FileTransactionJournal;
  private readonly fileSystem: FileTransactionFileSystem | undefined;
  private readonly faultInjector: CatalogFaultInjector;
  private readonly now: () => number;
  private readonly draftTtlMs: number;
  private readonly drafts = new Map<OperationId, DraftContext>();
  private readonly activeOperations = new Set<Promise<void>>();
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;

  public constructor(options: CatalogManualImportControllerOptions) {
    this.binding = {
      catalogId: parseCatalogId(options.catalogId),
      sessionId: parseSessionId(options.sessionId),
    };
    this.worker = options.worker;
    this.assertCurrentSession = options.assertCurrentSession;
    this.getNativeSessionRoots = options.getNativeSessionRoots;
    this.chooseFiles = options.chooseFiles;
    this.journal = options.journal;
    this.fileSystem = options.fileSystem;
    this.faultInjector = options.faultInjector ?? createNoopCatalogFaultInjector();
    this.now = options.now ?? Date.now;
    this.draftTtlMs = options.draftTtlMs ?? DEFAULT_DRAFT_TTL_MS;
    if (!Number.isSafeInteger(this.draftTtlMs) || this.draftTtlMs <= 0) {
      throw new Error("Import draft TTL is invalid.");
    }
  }

  public async prepare(value: unknown): Promise<CatalogImportDraftView> {
    const request = parseCatalogImportPrepareRequest(value);
    this.assertBinding(request.catalogId, request.sessionId);
    await this.assertCurrentSession(this.binding);
    try {
      const roots = await this.readRoots();
      const destinationRoot = roots.find((root) => root.rootId === request.destinationRootId);
      if (destinationRoot === undefined) throw new Error("Destination root is not active for this catalog.");
      await this.validateRoot(destinationRoot);
      const picked = await this.nativeCall("File selection is unavailable.", async () => {
        const selected = await this.chooseFiles({ catalogId: this.binding.catalogId, sessionId: this.binding.sessionId });
        if (selected === null) return [];
        if (Array.isArray(selected)) return selected;
        if ("paths" in selected && Array.isArray(selected.paths)) return selected.paths;
        if ("files" in selected && Array.isArray(selected.files)) return selected.files;
        throw new Error("File selection is invalid.");
      });
      if (picked.length === 0) throw new Error("No import files were selected.");
      if (picked.length > MAX_SELECTION) throw new Error("Import selection is limited to 500 files.");
      const state = await this.query();
      if (!state.roots.some((root) => root.rootId === request.destinationRootId)) {
        throw new Error("Destination root is not in the active catalog.");
      }
      const preset = this.presetFor(state, request.presetId);
      const pickedSources = await this.inspectPicked(picked, roots, state, request.action);
      const operationId = randomOperationId();
      const planInputs: ImportPlanSourceInput[] = [];
      const blocked = pickedSources.some((source) => source.blockingReason !== null || source.dng || source.unsupported);
      for (const source of pickedSources) {
        if (source.dng || source.unsupported) continue;
        planInputs.push({
          source: {
            rootId: source.rootId,
            relativePath: source.relativePath,
            observation: source.observation,
            xmpState: source.xmpState,
            formatId: source.formatId,
          },
          action: request.action,
          ...(source.sourceAssetId === null ? {} : { sourceAssetId: source.sourceAssetId }),
          cameraMake: source.cameraMake ?? undefined,
          cameraModel: source.cameraModel ?? undefined,
        });
      }
      const adapter = this.createAdapter(roots);
      const service = new ImportOperationService({ ...adapter.dependencies(), now: this.now });
      const draft = service.prepare({
        operationId,
        catalogId: this.binding.catalogId,
        destinationRootId: request.destinationRootId,
        preset,
        sources: planInputs,
        now: this.now(),
      });
      const destinationExists = await this.destinationConflicts(draft, destinationRoot, roots, state, request.action);
      const duplicate = await this.duplicateReview(draft, pickedSources, state, roots);
      const duplicateItems = new Set(duplicate.groups.flatMap((group) => group.assetIds).filter((itemId) => draft.items.some((item) => item.itemId === itemId)));
      const uncheckedItems = new Set(duplicate.notFullyChecked.filter((itemId) => draft.items.some((item) => item.itemId === itemId)));
      const duplicateDecisionMap = new Map<AssetId, { readonly kind: "skip-incoming" | "continue-unchecked" | "keep-both" }>();
      for (const item of draft.items) {
        if (duplicateItems.has(item.itemId) && request.duplicatePolicy !== "continue-unchecked") {
          duplicateDecisionMap.set(item.itemId, { kind: request.duplicatePolicy === "skip-incoming" ? "skip-incoming" : "keep-both" });
        } else if (uncheckedItems.has(item.itemId) && request.duplicatePolicy !== "keep-both") {
          duplicateDecisionMap.set(item.itemId, { kind: request.duplicatePolicy });
        }
      }
      const destinationDecisionMap = await this.destinationDecisions(
        draft,
        destinationExists,
        destinationRoot,
        request.destinationPolicy,
      );
      const review = service.review(draft, {
        destinationExists,
        duplicateItems,
        notFullyCheckedItems: uncheckedItems,
        duplicateDecisions: duplicateDecisionMap,
        destinationDecisions: destinationDecisionMap,
      });
      const items = this.viewItems(
        draft,
        review,
        pickedSources,
        duplicateItems,
        uncheckedItems,
        destinationExists,
      );
      const replaceUnsupported = request.destinationPolicy === "replace" && destinationExists.size > 0;
      const canRun = !blocked && !replaceUnsupported && planInputs.length > 0 && review.canFreeze;
      const view = {
        catalogId: this.binding.catalogId,
        sessionId: this.binding.sessionId,
        operationId,
        action: request.action,
        presetName: safePublicMessage(preset.name) ?? "Import preset",
        items,
        canRun,
        copyAsDng: { status: "unavailable", reason: DNG_UNAVAILABLE_REASON },
      } satisfies CatalogImportDraftView;
      const context: DraftContext = {
        request,
        operationId,
        draft,
        review,
        items,
        view,
        canRun,
        roots,
        expiresAt: this.now() + this.draftTtlMs,
        cancelled: false,
      };
      this.drafts.set(operationId, context);
      return view;
    } catch (error) {
      throw safeError(error);
    }
  }

  public async review(value: unknown): Promise<CatalogImportDraftView> {
    if (isRecord(value) && "operationId" in value) {
      const request = parseCatalogImportOperationRequest(value);
      this.assertBinding(request.catalogId, request.sessionId);
      await this.assertCurrentSession(this.binding);
      const context = this.liveDraft(request.operationId);
      if (context === undefined) throw new Error("Import draft is no longer available.");
      return context.view;
    }
    const request = parseCatalogImportPrepareRequest(value);
    this.assertBinding(request.catalogId, request.sessionId);
    await this.assertCurrentSession(this.binding);
    const candidates = [...this.drafts.values()].reverse();
    const context = candidates.find((candidate) =>
      candidate.request.catalogId === request.catalogId &&
      candidate.request.sessionId === request.sessionId &&
      candidate.request.action === request.action &&
      candidate.request.destinationRootId === request.destinationRootId &&
      candidate.request.presetId === request.presetId &&
      candidate.request.duplicatePolicy === request.duplicatePolicy &&
      candidate.request.destinationPolicy === request.destinationPolicy &&
      candidate.expiresAt > this.now(),
    );
    if (context === undefined) throw new Error("Import review requires a prepared draft.");
    return context.view;
  }

  public run(
    value: unknown,
    options: CatalogManualImportRunOptions = {},
  ): Promise<CatalogImportExecutionView> {
    if (this.shutdownRequested) return Promise.reject(new Error("Catalog import controller is closed."));
    return this.trackOperation(this.runInternal(value, options));
  }

  private async runInternal(
    value: unknown,
    options: CatalogManualImportRunOptions,
  ): Promise<CatalogImportExecutionView> {
    const request = parseCatalogImportOperationRequest(value);
    this.assertBinding(request.catalogId, request.sessionId);
    await this.assertCurrentSession(this.binding);
    const context = this.liveDraft(request.operationId);
    if (context?.cancelled === true) {
      this.drafts.delete(request.operationId);
      return this.cancelledExecution(request.operationId, context.draft.items);
    }
    if (context !== undefined && !context.canRun) {
      throw new Error("Import plan has blocking review conflicts.");
    }
    try {
      const roots = context?.roots ?? await this.readRoots();
      const adapter = this.createAdapter(roots);
      const service = new ImportOperationService({ ...adapter.dependencies(), now: this.now });
      const isCancelled = () => this.shutdownRequested || context?.cancelled === true || options.isCancelled?.() === true;
      if (isCancelled()) {
        return this.cancelledExecution(request.operationId, context?.draft.items ?? []);
      }
      let execution: ImportOperationExecution;
      if (context === undefined) {
        execution = await service.executeFrozenPlan(request.operationId, { isCancelled, now: this.now });
      } else {
        const plan = await service.freeze({ draft: context.draft, review: context.review });
        execution = await service.executeFrozenPlan(plan, { isCancelled, now: this.now });
      }
      return publicExecution(this.binding, execution);
    } catch (error) {
      if (error instanceof ImportOperationCancelledError) {
        return this.cancelledExecution(request.operationId, context?.draft.items ?? []);
      }
      throw safeError(error);
    } finally {
      this.drafts.delete(request.operationId);
    }
  }

  public recoverPending(): Promise<readonly CatalogImportExecutionView[]> {
    if (this.shutdownRequested) return Promise.reject(new Error("Catalog import controller is closed."));
    return this.trackOperation(this.recoverPendingInternal());
  }

  private async recoverPendingInternal(): Promise<readonly CatalogImportExecutionView[]> {
    await this.assertCurrentSession(this.binding);
    const state = await this.query();
    const pending = state.operations.filter((operation) =>
      operation.kind === CATALOG_IMPORT_OPERATION_KIND &&
      (operation.state === "planned" || operation.state === "running" || operation.state === "failed")
    );
    if (pending.length === 0) return [];
    const roots = await this.readRoots();
    const adapter = this.createAdapter(roots);
    const service = new ImportOperationService({ ...adapter.dependencies(), now: this.now });
    const results: CatalogImportExecutionView[] = [];
    let firstError: Error | null = null;
    for (const operation of pending) {
      await this.assertCurrentSession(this.binding);
      try {
        const execution = await service.executeFrozenPlan(operation.operationId, {
          isCancelled: () => this.shutdownRequested,
          now: this.now,
        });
        results.push(publicExecution(this.binding, execution));
        if (this.shutdownRequested) break;
      } catch (error) {
        firstError ??= safeError(error);
      }
    }
    if (firstError !== null) throw firstError;
    return results;
  }

  public cancel(value: unknown): void {
    const request = parseCatalogImportOperationRequest(value);
    this.assertBinding(request.catalogId, request.sessionId);
    const context = this.drafts.get(request.operationId);
    if (context !== undefined) context.cancelled = true;
  }

  public dispose(): void {
    this.shutdownRequested = true;
    for (const context of this.drafts.values()) context.cancelled = true;
    this.drafts.clear();
  }

  public async shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      await this.shutdownPromise;
      return;
    }
    this.dispose();
    this.shutdownPromise = Promise.allSettled([...this.activeOperations]).then(() => undefined);
    await this.shutdownPromise;
  }

  public prepareImport(value: unknown): Promise<CatalogImportDraftView> {
    return this.prepare(value);
  }

  public reviewImport(value: unknown): Promise<CatalogImportDraftView> {
    return this.review(value);
  }

  public runImport(value: unknown, options?: CatalogManualImportRunOptions): Promise<CatalogImportExecutionView> {
    return this.run(value, options);
  }

  public cancelImport(value: unknown): void {
    this.cancel(value);
  }

  private assertBinding(catalogId: CatalogId, sessionId: SessionId): void {
    if (catalogId !== this.binding.catalogId || sessionId !== this.binding.sessionId) {
      throw new Error("Import request does not belong to the active session.");
    }
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(() => undefined, () => undefined);
    this.activeOperations.add(settled);
    void settled.then(() => {
      this.activeOperations.delete(settled);
    });
    return operation;
  }

  private async query(): Promise<CatalogLiveState> {
    await this.assertCurrentSession(this.binding);
    let value: unknown;
    try {
      value = await this.worker.liveQuery({ catalogId: this.binding.catalogId, expectedRevision: null });
    } catch {
      await this.assertCurrentSession(this.binding);
      throw new Error("Catalog import query failed.");
    }
    await this.assertCurrentSession(this.binding);
    const state = parseCatalogLiveQueryResult(value);
    if (state.catalog.catalogId !== this.binding.catalogId) throw new Error("Catalog query returned a mismatched catalog.");
    return state;
  }

  private async readRoots(): Promise<readonly RootPath[]> {
    await this.assertCurrentSession(this.binding);
    let roots: readonly CatalogManualImportRoot[];
    try {
      roots = this.getNativeSessionRoots();
    } catch {
      await this.assertCurrentSession(this.binding);
      throw new Error("Catalog roots are unavailable.");
    }
    await this.assertCurrentSession(this.binding);
    const result: RootPath[] = [];
    const ids = new Set<RootId>();
    for (const root of roots) {
      const catalogId = parseCatalogId(root.catalogId);
      const rootId = parseRootId(root.rootId);
      if (catalogId !== this.binding.catalogId) continue;
      if (ids.has(rootId)) throw new Error("Active catalog roots contain a duplicate RootId.");
      ids.add(rootId);
      result.push({ rootId, nativePath: normalizedRootPath(root.nativePath) });
    }
    return result;
  }

  private async validateRoot(root: RootPath): Promise<void> {
    await this.nativeCall("Catalog root is unavailable.", async () => {
      const stat = await fs.lstat(root.nativePath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Catalog root is unavailable.");
      const canonical = await fs.realpath(root.nativePath);
      if (path.normalize(canonical) !== root.nativePath) throw new Error("Catalog root is not canonical.");
    });
  }

  private async inspectPicked(
    picked: readonly CatalogManualImportPickedFile[],
    roots: readonly RootPath[],
    state: CatalogLiveState,
    action: CatalogImportPrepareRequest["action"],
  ): Promise<readonly PickedSource[]> {
    const seen = new Set<string>();
    const result: PickedSource[] = [];
    for (const entry of picked) {
      const absolutePath = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.path === "string" ? entry.path : "";
      const inspected = await this.nativeCall("Selected file is unavailable.", async () => {
        const normalized = normalizedAbsolutePath(absolutePath, "Selected file");
        const matches = roots.filter((root) => normalized === root.nativePath || normalized.startsWith(`${root.nativePath}${path.sep}`));
        for (const root of matches) {
          await assertNoSymlinkComponents(root.nativePath, normalized);
          const relativePath = relativePathForAbsolute(root.nativePath, normalized);
          if (!state.roots.some((catalogRoot) => catalogRoot.rootId === root.rootId)) {
            throw new Error("Selected file root is not in the active catalog.");
          }
          const stat = await fs.lstat(normalized);
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Selected path is not a regular file.");
          const canonical = await fs.realpath(normalized);
          if (canonical !== normalized) throw new Error("Selected file is a symbolic link.");
          const observation = await observeNoFollowFile(normalized);
          const format = getFormatCapabilityForFileName(relativePath);
          if (format === null) throw new Error("Selected file format is unsupported.");
          const key = `${root.rootId}:${relativePath}`;
          if (seen.has(key)) throw new Error("Import selection contains duplicate files.");
          seen.add(key);
          const existing = state.assets.find((asset) => asset.rootId === root.rootId && asset.relativePath === relativePath);
          let sourceAssetId: AssetId | null = null;
          let blockingReason: string | null = null;
          if (action === "copy" || action === "move") {
            if (existing === undefined) {
              blockingReason = "Copy and Move require a source AssetId in the active catalog.";
            } else if (existing.health !== "present" || !sameObservation(observation, existing.observation)) {
              throw new Error("Selected source observation is stale.");
            } else {
              sourceAssetId = existing.assetId;
            }
          } else if (existing !== undefined) {
            if (existing.health !== "present" || !sameObservation(observation, existing.observation)) {
              blockingReason = "Selected Add source observation is stale.";
            } else {
              sourceAssetId = existing.assetId;
            }
          }
          return {
            absolutePath: normalized,
            rootId: root.rootId,
            relativePath,
            observation,
            xmpState: await inspectXmp(normalized),
            formatId: format.id,
            cameraMake: existing?.cameraMake ?? null,
            cameraModel: existing?.cameraModel ?? null,
            sourceAssetId,
            blockingReason,
            dng: format.id === "dng",
            unsupported: format.recognition !== "supported",
          } satisfies PickedSource;
        }
        throw new Error("Selected file is outside the active catalog roots.");
      });
      result.push(inspected);
    }
    return result;
  }

  private presetFor(state: CatalogLiveState, presetId: PresetId | null): ImportPreset {
    if (presetId === null) {
      return {
        catalogId: this.binding.catalogId,
        presetId: createPresetId(),
        name: "Default import",
        version: 1,
        template: { pattern: "{{filename}}" },
        payload: { metadata: { keywords: [] } },
        updatedAt: this.now(),
      };
    }
    const preset = state.presets.find((candidate) => candidate.presetId === presetId);
    if (preset === undefined) throw new Error("Import preset is missing from the active catalog.");
    const payload = parseJsonValue(structuredClone(preset.payload.payload), "Import preset payload");
    return {
      catalogId: this.binding.catalogId,
      presetId: parsePresetId(preset.presetId),
      name: preset.name,
      version: preset.revision,
      template: structuredClone(preset.payload.template),
      payload,
      updatedAt: preset.updatedAt,
    };
  }

  private async duplicateReview(
    draft: ImportPlanDraft,
    picked: readonly PickedSource[],
    state: CatalogLiveState,
    roots: readonly RootPath[],
  ) {
    const byRelative = new Map(picked.map((source) => [`${source.rootId}:${source.relativePath}`, source] as const));
    const rootMap = new Map(roots.map((root) => [root.rootId, root.nativePath] as const));
    const incomingCandidates = new Map<AssetId, DuplicateCandidate>();
    for (const item of draft.items) {
      const selected = byRelative.get(`${item.source.rootId}:${item.source.relativePath}`);
      if (selected === undefined) continue;
      incomingCandidates.set(item.itemId, {
        assetId: item.itemId,
        filePath: selected.absolutePath,
        storedStatus: "missing",
        storedSha256: null,
        storedObservation: selected.observation,
      });
    }
    const catalogCandidates: DuplicateCandidate[] = [];
    for (const asset of state.assets) {
      const rootPath = rootMap.get(asset.rootId);
      if (rootPath === undefined) continue;
      catalogCandidates.push({
        assetId: asset.assetId,
        filePath: absolutePathForRelative(rootPath, asset.relativePath),
        storedStatus: asset.fingerprintStatus,
        storedSha256: asset.fingerprintSha256,
        storedObservation: asFileObservation(asset.observation),
      });
    }
    const results: { readonly itemId: AssetId; readonly review: Awaited<ReturnType<typeof reviewDuplicatesOnDemand>> }[] = [];
    for (const item of draft.items) {
      const selected = byRelative.get(`${item.source.rootId}:${item.source.relativePath}`);
      if (selected === undefined) continue;
      const incoming = incomingCandidates.get(item.itemId);
      if (incoming === undefined) continue;
      const existing = [
        ...catalogCandidates.filter((candidate) => candidate.assetId !== selected.sourceAssetId),
        ...[...incomingCandidates.values()].filter((candidate) => candidate.assetId !== item.itemId),
      ];
      const review = await this.nativeCall("Duplicate check is unavailable.", () => reviewDuplicatesOnDemand(
        { incoming, existing },
        (candidate) => this.nativeCall("Duplicate check is unavailable.", () => fingerprintCandidate(candidate)),
      ));
      results.push({ itemId: item.itemId, review });
    }
    const groups = results.flatMap((entry) => entry.review.groups);
    const uniqueGroups = new Map<string, AssetId[]>();
    const unchecked = new Set<AssetId>();
    for (const entry of results) {
      for (const itemId of entry.review.notFullyChecked) unchecked.add(itemId);
      for (const group of entry.review.groups) {
        const ids = uniqueGroups.get(group.sha256) ?? [];
        for (const itemId of group.assetIds) if (!ids.includes(itemId)) ids.push(itemId);
        uniqueGroups.set(group.sha256, ids);
      }
    }
    return {
      groups: [...uniqueGroups.entries()].map(([sha256, assetIds]) => ({ sha256, assetIds })),
      unique: results.flatMap((entry) => entry.review.unique),
      notFullyChecked: [
        ...unchecked,
        ...results
          .filter((entry) => entry.review.notFullyChecked.length > 0)
          .map((entry) => entry.itemId),
      ],
      sourceGroups: groups,
    };
  }

  private async destinationConflicts(
    draft: ImportPlanDraft,
    destinationRoot: RootPath,
    roots: readonly RootPath[],
    state: CatalogLiveState,
    action: CatalogImportPrepareRequest["action"],
  ): Promise<ReadonlySet<string>> {
    const conflicts = new Set<string>();
    if (action === "add") return conflicts;
    for (const asset of state.assets) {
      if (asset.rootId === destinationRoot.rootId) conflicts.add(asset.relativePath);
    }
    for (const item of draft.items) {
      const target = absolutePathForRelative(destinationRoot.nativePath, item.destinationRelativePath);
      const sourceRoot = roots.find((root) => root.rootId === item.source.rootId);
      if (sourceRoot !== undefined) {
        const source = absolutePathForRelative(sourceRoot.nativePath, item.source.relativePath);
        if (source === target) throw new Error("Import source and destination are the same file.");
      }
      await this.nativeCall("Destination check is unavailable.", async () => {
        await assertSafeParent(destinationRoot.nativePath, target);
        const imageExists = await pathExists(target);
        const xmpExists = item.xmpDestinationRelativePath === null
          ? false
          : await pathExists(absolutePathForRelative(destinationRoot.nativePath, item.xmpDestinationRelativePath));
        if (imageExists || xmpExists) conflicts.add(item.destinationRelativePath);
      });
    }
    return conflicts;
  }

  private async destinationDecisions(
    draft: ImportPlanDraft,
    destinationExists: ReadonlySet<string>,
    destinationRoot: RootPath,
    policy: CatalogImportPrepareRequest["destinationPolicy"],
  ) {
    const decisions = new Map<AssetId, ImportDestinationDecision>();
    const reserved = new Set<string>();
    for (const item of draft.items) {
      const base = item.destinationRelativePath;
      const conflict = destinationExists.has(base) || reserved.has(base);
      if (!conflict) {
        reserved.add(base);
        continue;
      }
      if (policy === "skip") {
        decisions.set(item.itemId, { kind: "skip" });
        continue;
      }
      if (policy === "replace") {
        decisions.set(item.itemId, { kind: "replace" });
        reserved.add(base);
        continue;
      }
      const renamed = await this.uniqueDestinationName(base, reserved, destinationExists, destinationRoot);
      decisions.set(item.itemId, { kind: "rename", destinationRelativePath: renamed });
      reserved.add(renamed);
    }
    return decisions;
  }

  private async uniqueDestinationName(
    relativePath: string,
    reserved: ReadonlySet<string>,
    existing: ReadonlySet<string>,
    root: RootPath,
  ): Promise<string> {
    const extension = path.posix.extname(relativePath);
    const stem = extension.length > 0 ? relativePath.slice(0, -extension.length) : relativePath;
    for (let index = 1; index <= MAX_SELECTION; index += 1) {
      const candidate = `${stem} (${index})${extension}`;
      if (reserved.has(candidate) || existing.has(candidate)) continue;
      const target = absolutePathForRelative(root.nativePath, candidate);
      const available = await this.nativeCall("Destination check is unavailable.", async () => {
        await assertSafeParent(root.nativePath, target);
        return !(await pathExists(target));
      });
      if (available) return candidate;
    }
    throw new Error("No safe destination name is available.");
  }

  private viewItems(
    draft: ImportPlanDraft,
    review: ImportPlanReview,
    picked: readonly PickedSource[],
    duplicateItems: ReadonlySet<AssetId>,
    uncheckedItems: ReadonlySet<AssetId>,
    destinationExists: ReadonlySet<string>,
  ): readonly CatalogImportPreparedItemView[] {
    const views = draft.items.map((item) => {
      const destination = effectiveDestination(item, review);
      const destinationDecision = decisionForItem(item, review).destination;
      return {
        itemId: item.itemId,
        sourceName: sourceName(item.source.relativePath),
        sourceRelativePath: item.source.relativePath,
        destinationRelativePath: destination,
        formatId: item.source.formatId,
        duplicate: duplicateKind(item.itemId, duplicateItems, uncheckedItems),
        destinationConflict: destinationExists.has(item.destinationRelativePath) || destinationDecision !== null,
        outcome: itemOutcome(item, review),
      } satisfies CatalogImportPreparedItemView;
    });
    for (const source of picked) {
      if (!source.dng && !source.unsupported) continue;
      views.push({
        itemId: createAssetId(),
        sourceName: sourceName(source.relativePath),
        sourceRelativePath: source.relativePath,
        destinationRelativePath: source.relativePath,
        formatId: source.formatId,
        duplicate: "unique",
        destinationConflict: false,
        outcome: "skip",
      });
    }
    return views;
  }

  private createAdapter(roots: readonly RootPath[]): CatalogImportAdapter {
    const rootMap = new Map(roots.map((root) => [root.rootId, root.nativePath] as const));
    const sourcePath = (rootId: RootId, relativePath: string): string => {
      const root = rootMap.get(rootId);
      if (root === undefined) throw new Error("Import root is not active for this catalog.");
      return absolutePathForRelative(root, relativePath);
    };
    const source = async (rootId: RootId, relativePath: string): Promise<ImportSource> => {
      const absolute = sourcePath(rootId, relativePath);
      const observation = await this.nativeCall("Import source observation is unavailable.", () => observeNoFollowFile(absolute));
      const xmpState = await this.nativeCall("Import source observation is unavailable.", () => inspectXmp(absolute));
      const format = getFormatCapabilityForFileName(relativePath);
      if (format === null) throw new Error("Import source format is unsupported.");
      return { rootId, relativePath: parseRelativePath(relativePath), observation, xmpState, formatId: format.id };
    };
    const destination = async (rootId: RootId, relativePath: string): Promise<FileObservation> => {
      const absolute = sourcePath(rootId, relativePath);
      return this.nativeCall("Import destination observation is unavailable.", () => observeNoFollowFile(absolute));
    };
    const paths = {
      resolve: async (request: {
        readonly sourceRootId: RootId;
        readonly sourceRelativePath: string;
        readonly destinationRootId: RootId;
        readonly destinationRelativePath: string;
        readonly xmpDestinationRelativePath: string | null;
      }): Promise<ResolvedTransactionPaths> => {
        const sourceAbsolute = sourcePath(request.sourceRootId, request.sourceRelativePath);
        const destinationAbsolute = sourcePath(request.destinationRootId, request.destinationRelativePath);
        const destinationRootPath = rootMap.get(request.destinationRootId);
        if (destinationRootPath === undefined) throw new Error("Import destination root is not active for this catalog.");
        await this.nativeCall("Import destination path is unsafe.", () => assertSafeParent(destinationRootPath, destinationAbsolute));
        const xmp = request.xmpDestinationRelativePath === null
          ? null
          : await this.resolveXmp(sourceAbsolute, sourcePath(request.destinationRootId, request.xmpDestinationRelativePath));
        return { sourcePath: sourceAbsolute, destinationPath: destinationAbsolute, xmp } satisfies ResolvedTransactionPaths;
      },
    };
    return new CatalogImportAdapter({
      catalogId: this.binding.catalogId,
      sessionId: this.binding.sessionId,
      worker: this.worker,
      assertCurrentSession: this.assertCurrentSession,
      source: ({ rootId, relativePath }) => source(rootId, relativePath),
      destinationObservation: ({ rootId, relativePath }) => destination(rootId, relativePath),
      paths,
      journal: this.journal,
      ...(this.fileSystem === undefined ? {} : { fileSystem: this.fileSystem }),
      faultInjector: this.faultInjector,
      now: this.now,
    });
  }

  private async resolveXmp(sourcePath: string, destinationPath: string) {
    const sourceObservation = await this.nativeCall("Import XMP sidecar is unavailable.", () => observeNoFollowFile(sourcePath.replace(/\.[^/.]+$/, ".xmp")));
    return {
      sourcePath: sourcePath.replace(/\.[^/.]+$/, ".xmp"),
      destinationPath,
      sourceObservation: {
        size: sourceObservation.size,
        modifiedAt: sourceObservation.modifiedAt,
        localFileId: sourceObservation.localFileId,
      },
    };
  }

  private liveDraft(operationId: OperationId): DraftContext | undefined {
    const context = this.drafts.get(operationId);
    if (context === undefined) return undefined;
    if (context.expiresAt <= this.now()) {
      this.drafts.delete(operationId);
      return undefined;
    }
    return context;
  }

  private cancelledExecution(operationId: OperationId, items: readonly ImportPlanItem[]): CatalogImportExecutionView {
    return {
      catalogId: this.binding.catalogId,
      sessionId: this.binding.sessionId,
      operationId,
      state: "cancelled",
      items: items.map((item): CatalogImportItemResultView => ({
        itemId: item.itemId,
        destinationAssetId: item.destinationAssetId,
        stage: "planned",
        status: "cancelled",
        xmpStatus: item.source.xmpState === "present" ? "preserved" : "absent",
        sourceRetained: false,
        error: null,
      })),
      error: null,
    };
  }

  private async nativeCall<T>(fallback: string, operation: () => Promise<T>): Promise<T> {
    await this.assertCurrentSession(this.binding);
    try {
      const value = await operation();
      await this.assertCurrentSession(this.binding);
      return value;
    } catch (error) {
      await this.assertCurrentSession(this.binding);
      if (error instanceof Error && error.message.length > 0 && !error.message.includes("/") && !error.message.includes("\\")) {
        throw error;
      }
      throw new Error(fallback);
    }
  }
}

export function createCatalogManualImportController(
  options: CatalogManualImportControllerOptions,
): CatalogManualImportController {
  return new CatalogManualImportController(options);
}
