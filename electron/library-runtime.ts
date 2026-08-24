import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertCurrentLibraryEvent,
  createPathGrantId,
  createSessionId,
  parseAssetHeadRequestInput,
  parseAssetRequestInput,
  parseAssetSidecarWriteRequestInput,
  parseOperationRequestInput,
  parsePathGrantRequestInput,
  parseRelativePath,
  parseScanRequestInput,
  parseSessionSelectionInput,
  type AssetHeadRequestInput,
  type AssetRequestInput,
  type AssetSidecarWriteRequest,
  type CatalogId,
  type ConsumedPickerGrant,
  type LibraryEvent,
  type LibraryOperationHandle,
  type LibraryOperationSnapshot,
  type LibraryOperationStatus,
  type LibrarySessionSnapshot,
  type PathGrantId,
  type PickerGrant,
  type RootId,
  type ScanProgressPayload,
  type ScanTerminalPayload,
  type SessionId,
} from "../lib/catalog/runtime.ts";
import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type AssetId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import {
  NativeAssetAccess,
  type NativeAssetLocation,
} from "./native-asset-access.ts";
import {
  NativeScanAbortError,
  scanNativeFolder,
  type NativeScanObservation,
  type NativeScanProgress,
  type NativeScanResult,
} from "./library-scan.ts";

export interface RuntimeRootProjection {
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly label: string;
  readonly nativePath: string | null;
}

export type RuntimeNativeRootProjection = RuntimeRootProjection & {
  readonly nativePath: string;
};

export function isRuntimeNativeRoot(
  root: RuntimeRootProjection,
): root is RuntimeNativeRootProjection {
  return root.nativePath !== null;
}

export interface RuntimeAssetProjection {
  readonly catalogId: CatalogId;
  readonly assetId: AssetId;
  readonly rootId: RootId;
  readonly relativePath: string;
}

export interface RuntimeCatalogProjection {
  readonly catalogId: CatalogId;
  readonly roots: readonly RuntimeRootProjection[];
}

export interface ScanCommitInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly signal: AbortSignal;
  readonly observations: readonly NativeScanObservation[];
}

export interface AdoptRootInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly grantId: PathGrantId;
  readonly canonicalPath: string;
  readonly label: string;
}

export interface LibraryRuntimeSource {
  loadCatalogProjection(catalogId: CatalogId): Promise<RuntimeCatalogProjection | null>;
  loadRootProjection(catalogId: CatalogId, rootId: RootId): Promise<RuntimeRootProjection | null>;
  loadAssetProjection(catalogId: CatalogId, assetId: AssetId): Promise<RuntimeAssetProjection | null>;
  commitScan(input: ScanCommitInput): Promise<void>;
  adoptRoot(input: AdoptRootInput): Promise<RootId>;
}

export interface NativeFolderPicker {
  chooseFolder(): Promise<{ readonly path: string; readonly label?: string } | null>;
}

export interface LibraryScanRunnerInput {
  readonly rootPath: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: NativeScanProgress) => void;
}

export type LibraryScanRunner = (
  input: LibraryScanRunnerInput,
) => Promise<NativeScanResult>;

export interface LibraryRuntimeOptions {
  readonly source: LibraryRuntimeSource;
  readonly picker?: NativeFolderPicker;
  readonly assetAccess?: NativeAssetAccess;
  readonly assetOperations?: AssetScopedOperations;
  readonly scanRunner?: LibraryScanRunner;
  readonly now?: () => number;
  readonly pickerGrantTtlMs?: number;
}

export interface AssetScopedOperations {
  readonly readSidecar: (location: NativeAssetLocation) => Promise<AssetSidecarResult | null>;
  readonly writeSidecar: (location: NativeAssetLocation, contents: string | null) => Promise<void>;
  readonly trash: (location: NativeAssetLocation) => Promise<void>;
  readonly decode: (location: NativeAssetLocation, request: unknown) => Promise<unknown>;
}

export interface AssetSidecarResult {
  readonly contents: string;
  readonly lastModified: number;
}

interface ActiveSession {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly roots: readonly RuntimeRootProjection[];
}

type OperationReason = "cancelled" | "timed-out" | "superseded" | null;

interface InternalOperation {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly controller: AbortController;
  readonly completion: Promise<LibraryOperationSnapshot>;
  readonly resolveCompletion: (snapshot: LibraryOperationSnapshot) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  reason: OperationReason;
  status: LibraryOperationStatus;
  directoriesVisited: number;
  filesConsidered: number;
  acceptedCount: number;
  currentPath: string | null;
  errorMessage: string | undefined;
}

interface InternalGrant {
  readonly grantId: PathGrantId;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly canonicalPath: string;
  readonly expiresAt: number;
  readonly label: string;
  consumed: boolean;
}

type LibraryEventListener = (event: LibraryEvent) => void;

const DEFAULT_PICKER_GRANT_TTL_MS = 60_000;
const MAX_RETAINED_OPERATIONS = 256;
const MAX_RETAINED_GRANTS = 256;

function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 500) {
    if (error.message.includes("/") || error.message.includes("\\")) return fallback;
    return error.message;
  }
  return fallback;
}

function validateCounter(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function validateProjectionCatalog(
  projectionCatalogId: CatalogId,
  expectedCatalogId: CatalogId,
): void {
  if (parseCatalogId(projectionCatalogId) !== expectedCatalogId) {
    throw new Error("Catalog projection belongs to a different catalog.");
  }
}

function validateRootProjection(
  root: RuntimeRootProjection,
  catalogId: CatalogId,
): RuntimeRootProjection {
  validateProjectionCatalog(root.catalogId, catalogId);
  if (parseRootId(root.rootId) !== root.rootId || (root.nativePath !== null && root.nativePath.length === 0)) {
    throw new Error("Root projection is invalid.");
  }
  return root;
}

function validateAssetProjection(
  asset: RuntimeAssetProjection,
  catalogId: CatalogId,
  assetId: AssetId,
): RuntimeAssetProjection {
  validateProjectionCatalog(asset.catalogId, catalogId);
  if (parseAssetId(asset.assetId) !== assetId || parseRootId(asset.rootId) !== asset.rootId) {
    throw new Error("Asset projection is invalid.");
  }
  parseRelativePath(asset.relativePath);
  return asset;
}

function snapshot(operation: InternalOperation): LibraryOperationSnapshot {
  return {
    operationId: operation.operationId,
    catalogId: operation.catalogId,
    sessionId: operation.sessionId,
    status: operation.status,
    directoriesVisited: operation.directoriesVisited,
    filesConsidered: operation.filesConsidered,
    acceptedCount: operation.acceptedCount,
    currentPath: operation.currentPath,
    ...(operation.errorMessage === undefined ? {} : { errorMessage: operation.errorMessage }),
  };
}

function currentOperationReason(operation: InternalOperation): OperationReason {
  return operation.reason;
}

export class LibraryRuntime {
  private readonly source: LibraryRuntimeSource;
  private readonly picker: NativeFolderPicker | undefined;
  private readonly assetAccess: NativeAssetAccess;
  private readonly assetOperations: AssetScopedOperations | undefined;
  private readonly scanRunner: LibraryScanRunner;
  private readonly now: () => number;
  private readonly pickerGrantTtlMs: number;
  private readonly listeners = new Set<LibraryEventListener>();
  private readonly operations = new Map<string, InternalOperation>();
  private readonly activeOperations = new Map<string, InternalOperation>();
  private readonly grants = new Map<string, InternalGrant>();
  private activeSession: ActiveSession | undefined;
  private selectionGeneration = 0;
  private sequence = 0;

  constructor(options: LibraryRuntimeOptions) {
    this.source = options.source;
    this.picker = options.picker;
    this.assetAccess = options.assetAccess ?? new NativeAssetAccess();
    this.assetOperations = options.assetOperations;
    this.scanRunner = options.scanRunner ?? ((input) => scanNativeFolder(input));
    this.now = options.now ?? Date.now;
    this.pickerGrantTtlMs = options.pickerGrantTtlMs ?? DEFAULT_PICKER_GRANT_TTL_MS;
    if (!Number.isSafeInteger(this.pickerGrantTtlMs) || this.pickerGrantTtlMs <= 0) {
      throw new Error("pickerGrantTtlMs must be a positive integer.");
    }
  }

  async selectSession(value: unknown): Promise<LibrarySessionSnapshot> {
    const { catalogId } = parseSessionSelectionInput(value);
    const generation = ++this.selectionGeneration;
    this.supersedeActiveOperations();
    this.grants.clear();
    const sessionId = createSessionId();
    this.activeSession = { catalogId, sessionId, roots: [] };
    this.sequence = 0;
    const projection = await this.source.loadCatalogProjection(catalogId);
    if (
      generation !== this.selectionGeneration ||
      this.activeSession?.sessionId !== sessionId
    ) {
      throw new Error("Session selection was superseded.");
    }
    if (projection === null) {
      this.activeSession = undefined;
      throw new Error("Catalog was not found.");
    }
    validateProjectionCatalog(projection.catalogId, catalogId);
    const roots = projection.roots.map((root) => validateRootProjection(root, catalogId));
    this.activeSession = { catalogId, sessionId, roots };
    return {
      catalogId,
      sessionId,
      roots: roots.map(({ catalogId: rootCatalogId, rootId, label }) => ({
        catalogId: rootCatalogId,
        rootId,
        label,
      })),
    };
  }

  closeSession(): void {
    this.selectionGeneration += 1;
    this.supersedeActiveOperations();
    this.grants.clear();
    this.activeSession = undefined;
    this.sequence = 0;
  }

  getSession(): LibrarySessionSnapshot | null {
    const session = this.activeSession;
    if (session === undefined) return null;
    return {
      catalogId: session.catalogId,
      sessionId: session.sessionId,
      roots: session.roots.map(({ catalogId, rootId, label }) => ({ catalogId, rootId, label })),
    };
  }

  getNativeSessionRoots(): readonly RuntimeNativeRootProjection[] {
    return this.activeSession?.roots.filter(isRuntimeNativeRoot).map((root) => ({ ...root })) ?? [];
  }

  subscribe(listener: LibraryEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async issuePathGrant(): Promise<PickerGrant> {
    const session = this.requireSession();
    if (this.picker === undefined) throw new Error("A native folder picker is unavailable.");
    const selection = await this.picker.chooseFolder();
    if (selection === null) throw new Error("Folder selection was cancelled.");
    let canonicalPath: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      canonicalPath = await fs.realpath(selection.path);
      stat = await fs.stat(canonicalPath);
    } catch {
      throw new Error("Selected folder is unavailable.");
    }
    if (!stat.isDirectory()) throw new Error("Selected path is not a folder.");
    if (!this.hasCurrentSession(session.catalogId, session.sessionId)) {
      throw new Error("Folder selection was superseded by a new session.");
    }
    this.pruneExpiredGrants();
    const grantId = createPathGrantId();
    const expiresAt = this.now() + this.pickerGrantTtlMs;
    const label = selection.label?.trim() || path.basename(canonicalPath) || "Selected folder";
    this.grants.set(grantId, {
      grantId,
      catalogId: session.catalogId,
      sessionId: session.sessionId,
      canonicalPath,
      expiresAt,
      label,
      consumed: false,
    });
    this.pruneGrantLimit();
    return { grantId, catalogId: session.catalogId, sessionId: session.sessionId, scope: "root", expiresAt, label };
  }

  async consumePathGrant(value: unknown): Promise<ConsumedPickerGrant> {
    const input = parsePathGrantRequestInput(value);
    const session = this.requireSession(input.catalogId, input.sessionId);
    const grant = this.grants.get(input.grantId);
    if (
      grant === undefined ||
      grant.catalogId !== session.catalogId ||
      grant.sessionId !== session.sessionId ||
      grant.consumed ||
      grant.expiresAt <= this.now()
    ) {
      throw new Error("Path grant is invalid, expired, or already consumed.");
    }
    grant.consumed = true;
    let rootId: RootId;
    try {
      rootId = parseRootId(await this.source.adoptRoot({
        catalogId: session.catalogId,
        sessionId: session.sessionId,
        grantId: grant.grantId,
        canonicalPath: grant.canonicalPath,
        label: grant.label,
      }));
    } catch {
      throw new Error("Could not register the selected folder.");
    }
    this.requireSession(session.catalogId, session.sessionId);
    const projection = await this.source.loadCatalogProjection(session.catalogId);
    this.requireSession(session.catalogId, session.sessionId);
    if (projection === null) throw new Error("Catalog was not found.");
    validateProjectionCatalog(projection.catalogId, session.catalogId);
    const roots = projection.roots.map((root) => validateRootProjection(root, session.catalogId));
    if (!roots.some((root) => root.rootId === rootId)) throw new Error("Registered root was not found.");
    this.activeSession = { catalogId: session.catalogId, sessionId: session.sessionId, roots };
    this.grants.delete(grant.grantId);
    return {
      grantId: grant.grantId,
      catalogId: session.catalogId,
      sessionId: session.sessionId,
      rootId,
    };
  }

  startScan(value: unknown): LibraryOperationHandle {
    const input = parseScanRequestInput(value);
    const session = this.requireSession(input.catalogId, input.sessionId);
    const root = session.roots.find((candidate) => candidate.rootId === input.rootId);
    if (root === undefined) {
      throw new Error("Scan root is not part of the active catalog session.");
    }
    if (!isRuntimeNativeRoot(root)) throw new Error("Scan root is offline.");
    let resolveCompletion: (result: LibraryOperationSnapshot) => void = () => undefined;
    const completion = new Promise<LibraryOperationSnapshot>((resolve) => {
      resolveCompletion = resolve;
    });
    const operationId = parseOperationId(randomUUID());
    const operation: InternalOperation = {
      operationId,
      catalogId: session.catalogId,
      sessionId: session.sessionId,
      rootId: input.rootId,
      controller: new AbortController(),
      completion,
      resolveCompletion,
      timeoutHandle: undefined,
      reason: null,
      status: "running",
      directoriesVisited: 0,
      filesConsidered: 0,
      acceptedCount: 0,
      currentPath: null,
      errorMessage: undefined,
    };
    this.operations.set(operationId, operation);
    this.activeOperations.set(operationId, operation);
    if (input.timeoutMs !== undefined) {
      operation.timeoutHandle = setTimeout(() => {
        if (operation.status !== "running") return;
        operation.reason = "timed-out";
        operation.controller.abort();
      }, input.timeoutMs);
    }
    void this.runScan(operation);
    return { operationId, catalogId: session.catalogId, sessionId: session.sessionId, status: "running" };
  }

  cancelScan(value: unknown): void {
    const input = parseOperationRequestInput(value);
    this.requireSession(input.catalogId, input.sessionId);
    const operation = this.operations.get(input.operationId);
    if (operation === undefined || operation.catalogId !== input.catalogId || operation.sessionId !== input.sessionId) {
      throw new Error("Operation was not found.");
    }
    if (operation.status !== "running") return;
    operation.reason = "cancelled";
    operation.controller.abort();
  }

  getOperation(value: unknown): LibraryOperationSnapshot {
    const input = parseOperationRequestInput(value);
    this.requireSession(input.catalogId, input.sessionId);
    const operation = this.operations.get(input.operationId);
    if (operation === undefined || operation.catalogId !== input.catalogId || operation.sessionId !== input.sessionId) {
      throw new Error("Operation was not found.");
    }
    return snapshot(operation);
  }

  async waitForOperation(value: unknown): Promise<LibraryOperationSnapshot> {
    const input = parseOperationRequestInput(value);
    this.requireSession(input.catalogId, input.sessionId);
    const operation = this.operations.get(input.operationId);
    if (operation === undefined || operation.catalogId !== input.catalogId || operation.sessionId !== input.sessionId) {
      throw new Error("Operation was not found.");
    }
    return operation.completion;
  }

  async readAsset(value: unknown): Promise<Uint8Array> {
    const input = parseAssetRequestInput(value);
    const location = await this.assetLocation(input);
    this.requireSession(input.catalogId, input.sessionId);
    const bytes = await this.assetAccess.read(location);
    this.requireSession(input.catalogId, input.sessionId);
    return bytes;
  }

  async readAssetHead(value: unknown): Promise<Uint8Array> {
    const input = parseAssetHeadRequestInput(value);
    const location = await this.assetLocation(input);
    this.requireSession(input.catalogId, input.sessionId);
    const bytes = await this.assetAccess.readHead(location, input.maxBytes);
    this.requireSession(input.catalogId, input.sessionId);
    return bytes;
  }

  async statAsset(value: unknown): Promise<{ readonly size: number; readonly lastModified: number }> {
    const input = parseAssetRequestInput(value);
    const location = await this.assetLocation(input);
    this.requireSession(input.catalogId, input.sessionId);
    const result = await this.assetAccess.stat(location);
    this.requireSession(input.catalogId, input.sessionId);
    return result;
  }

  async readAssetSidecar(value: unknown): Promise<AssetSidecarResult | null> {
    const operations = this.assetOperations;
    if (operations === undefined) throw new Error("Sidecar access is unavailable.");
    const input = parseAssetRequestInput(value);
    const location = await this.assetLocation(input);
    this.requireSession(input.catalogId, input.sessionId);
    const result = await operations.readSidecar(location);
    this.requireSession(input.catalogId, input.sessionId);
    return result;
  }

  async writeAssetSidecar(value: unknown): Promise<void> {
    const operations = this.assetOperations;
    if (operations === undefined) throw new Error("Sidecar access is unavailable.");
    const input: AssetSidecarWriteRequest = parseAssetSidecarWriteRequestInput(value);
    const location = await this.assetLocation(input);
    this.requireSession(input.catalogId, input.sessionId);
    await operations.writeSidecar(location, input.contents);
    this.requireSession(input.catalogId, input.sessionId);
  }

  async trashAsset(value: unknown): Promise<void> {
    const operations = this.assetOperations;
    if (operations === undefined) throw new Error("Asset trash access is unavailable.");
    const input = parseAssetRequestInput(value);
    const location = await this.assetLocation(input);
    this.requireSession(input.catalogId, input.sessionId);
    await operations.trash(location);
    this.requireSession(input.catalogId, input.sessionId);
  }

  async decodeAsset(value: unknown, request: unknown): Promise<unknown> {
    const operations = this.assetOperations;
    if (operations === undefined) throw new Error("Asset decode access is unavailable.");
    const input = parseAssetRequestInput(value);
    const location = await this.assetLocation(input);
    this.requireSession(input.catalogId, input.sessionId);
    const result = await operations.decode(location, request);
    this.requireSession(input.catalogId, input.sessionId);
    return result;
  }

  private async assetLocation(input: AssetRequestInput | AssetHeadRequestInput): Promise<NativeAssetLocation> {
    this.requireSession(input.catalogId, input.sessionId);
    const asset = await this.source.loadAssetProjection(input.catalogId, input.assetId);
    if (asset === null) throw new Error("Asset was not found in this catalog.");
    const validatedAsset = validateAssetProjection(asset, input.catalogId, input.assetId);
    const session = this.requireSession(input.catalogId, input.sessionId);
    if (!session.roots.some((root) => root.rootId === validatedAsset.rootId)) {
      throw new Error("Asset root is not part of the active catalog session.");
    }
    const root = await this.source.loadRootProjection(input.catalogId, validatedAsset.rootId);
    if (root === null) throw new Error("Asset root was not found in this catalog.");
    this.requireSession(input.catalogId, input.sessionId);
    const validatedRoot = validateRootProjection(root, input.catalogId);
    if (!isRuntimeNativeRoot(validatedRoot)) throw new Error("Asset root is offline.");
    return {
      catalogId: input.catalogId,
      assetId: input.assetId,
      rootId: validatedAsset.rootId,
      canonicalRootPath: validatedRoot.nativePath,
      relativePath: validatedAsset.relativePath,
    };
  }

  private requireSession(catalogId?: CatalogId, sessionId?: SessionId): ActiveSession {
    const session = this.activeSession;
    if (
      session === undefined ||
      (catalogId !== undefined && session.catalogId !== catalogId) ||
      (sessionId !== undefined && session.sessionId !== sessionId)
    ) {
      throw new Error("Library session is inactive.");
    }
    return session;
  }

  private async runScan(operation: InternalOperation): Promise<void> {
    try {
      const root = await this.source.loadRootProjection(operation.catalogId, operation.rootId);
      if (root === null) throw new Error("Scan root was not found in this catalog.");
      const validatedRoot = validateRootProjection(root, operation.catalogId);
      if (!isRuntimeNativeRoot(validatedRoot)) throw new Error("Scan root is offline.");
      if (!this.isRunningInCurrentSession(operation)) {
        this.finishOperation(operation, "superseded", false);
        return;
      }
      if (operation.reason === "timed-out") {
        this.finishOperation(operation, "timed-out", true);
        return;
      }
      if (operation.reason === "cancelled") {
        this.finishOperation(operation, "cancelled", true);
        return;
      }
      const result = await this.scanRunner({
        rootPath: validatedRoot.nativePath,
        signal: operation.controller.signal,
        onProgress: (progress) => this.updateProgress(operation, progress),
      });
      const reason = currentOperationReason(operation);
      if (reason !== null || operation.controller.signal.aborted) {
        if (reason === "timed-out") {
          this.finishOperation(operation, "timed-out", this.isCurrentSession(operation));
        } else if (reason === "cancelled") {
          this.finishOperation(operation, "cancelled", this.isCurrentSession(operation));
        } else {
          this.finishOperation(operation, "superseded", false);
        }
        return;
      }
      if (!this.isRunningInCurrentSession(operation)) {
        if (operation.status === "running") this.finishOperation(operation, "superseded", false);
        return;
      }
      this.applyResult(operation, result);
      await this.source.commitScan({
        catalogId: operation.catalogId,
        sessionId: operation.sessionId,
        rootId: operation.rootId,
        signal: operation.controller.signal,
        observations: result.observations,
      });
      const commitReason = currentOperationReason(operation);
      if (commitReason !== null || operation.controller.signal.aborted) {
        if (commitReason === "timed-out") {
          this.finishOperation(operation, "timed-out", this.isCurrentSession(operation));
        } else if (commitReason === "cancelled") {
          this.finishOperation(operation, "cancelled", this.isCurrentSession(operation));
        } else {
          this.finishOperation(operation, "superseded", false);
        }
        return;
      }
      if (!this.isRunningInCurrentSession(operation)) {
        if (operation.status === "running") this.finishOperation(operation, "superseded", false);
        return;
      }
      this.finishOperation(operation, "completed", true);
    } catch (error) {
      if (operation.status !== "running") return;
      if (!this.isCurrentSession(operation)) {
        this.finishOperation(operation, "superseded", false);
        return;
      }
      if (operation.reason === "cancelled") {
        this.finishOperation(operation, "cancelled", true);
      } else if (operation.reason === "timed-out") {
        this.finishOperation(operation, "timed-out", true);
      } else if (error instanceof NativeScanAbortError) {
        this.finishOperation(operation, "cancelled", true);
      } else {
        operation.errorMessage = safeErrorMessage(error, "Scan failed.");
        this.finishOperation(operation, "failed", true);
      }
    }
  }

  private updateProgress(operation: InternalOperation, progress: NativeScanProgress): void {
    if (!this.isRunningInCurrentSession(operation)) return;
    const currentPath = parseRelativePath(progress.currentPath, "currentPath", true);
    operation.directoriesVisited = validateCounter(progress.directoriesVisited, "directoriesVisited");
    operation.filesConsidered = validateCounter(progress.filesConsidered, "filesConsidered");
    operation.acceptedCount = validateCounter(progress.acceptedCount, "acceptedCount");
    operation.currentPath = currentPath;
    const payload: ScanProgressPayload = {
      phase: progress.phase,
      directoriesVisited: operation.directoriesVisited,
      filesConsidered: operation.filesConsidered,
      acceptedCount: operation.acceptedCount,
      currentPath,
    };
    this.emit(operation, "scan-progress", payload);
  }

  private applyResult(operation: InternalOperation, result: NativeScanResult): void {
    operation.directoriesVisited = validateCounter(result.directoriesVisited, "directoriesVisited");
    operation.filesConsidered = validateCounter(result.filesConsidered, "filesConsidered");
    operation.acceptedCount = validateCounter(result.acceptedCount, "acceptedCount");
    operation.currentPath =
      result.currentPath === null
        ? operation.currentPath
        : parseRelativePath(result.currentPath, "currentPath", true);
  }

  private finishOperation(
    operation: InternalOperation,
    status: Exclude<LibraryOperationStatus, "running">,
    publish: boolean,
  ): void {
    if (operation.status !== "running") return;
    operation.status = status;
    this.activeOperations.delete(operation.operationId);
    if (operation.timeoutHandle !== undefined) {
      clearTimeout(operation.timeoutHandle);
      operation.timeoutHandle = undefined;
    }
    operation.resolveCompletion(snapshot(operation));
    this.pruneRetainedOperations();
    if (publish && this.isCurrentSession(operation)) {
      this.emit(operation, "scan-terminal", {
        status,
        directoriesVisited: operation.directoriesVisited,
        filesConsidered: operation.filesConsidered,
        acceptedCount: operation.acceptedCount,
        currentPath: operation.currentPath,
        ...(operation.errorMessage === undefined ? {} : { errorMessage: operation.errorMessage }),
      });
    }
  }

  private emit(
    operation: InternalOperation,
    kind: "scan-progress" | "scan-terminal",
    payload: ScanProgressPayload | ScanTerminalPayload,
  ): void {
    if (!this.isCurrentSession(operation)) return;
    this.sequence += 1;
    const event: LibraryEvent = {
      catalogId: operation.catalogId,
      sessionId: operation.sessionId,
      operationId: operation.operationId,
      sequence: this.sequence,
      kind,
      payload,
    };
    for (const listener of this.listeners) {
      try {
        assertCurrentLibraryEvent(event, {
          catalogId: operation.catalogId,
          sessionId: operation.sessionId,
          lastSequence: this.sequence - 1,
        });
        listener(event);
      } catch {
        // A listener cannot interrupt the main-process operation.
      }
    }
  }

  private isCurrentSession(operation: InternalOperation): boolean {
    return this.activeSession?.catalogId === operation.catalogId && this.activeSession?.sessionId === operation.sessionId;
  }

  private hasCurrentSession(catalogId: CatalogId, sessionId: SessionId): boolean {
    return this.activeSession?.catalogId === catalogId && this.activeSession?.sessionId === sessionId;
  }

  private isRunningInCurrentSession(operation: InternalOperation): boolean {
    return operation.status === "running" && this.isCurrentSession(operation);
  }

  private supersedeActiveOperations(): void {
    for (const operation of this.activeOperations.values()) {
      operation.reason = "superseded";
      operation.controller.abort();
      this.finishOperation(operation, "superseded", false);
    }
    this.activeOperations.clear();
  }

  private pruneExpiredGrants(): void {
    const now = this.now();
    for (const [grantId, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(grantId);
    }
  }

  private pruneGrantLimit(): void {
    while (this.grants.size > MAX_RETAINED_GRANTS) {
      const first = this.grants.keys().next().value;
      if (typeof first !== "string") return;
      this.grants.delete(first);
    }
  }

  private pruneRetainedOperations(): void {
    while (this.operations.size > MAX_RETAINED_OPERATIONS) {
      const operationId = this.operations.keys().next().value;
      if (typeof operationId !== "string") return;
      const operation = this.operations.get(operationId);
      if (operation === undefined) return;
      if (operation.status === "running") return;
      this.operations.delete(operationId);
    }
  }
}
