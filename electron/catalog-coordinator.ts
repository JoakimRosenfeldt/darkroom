import path from "node:path";
import {
  createCatalogId,
  createRootId,
  parseCatalogId,
  type AssetId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  getFormatCapabilityForFileName,
} from "../lib/formats/registry.ts";
import {
  parseCatalogLiveApplyResult,
  parseCatalogLiveQueryResult,
  type CatalogLiveApplyInput,
  type CatalogLiveMutation,
  type CatalogLiveCreateInput,
  type CatalogLiveQueryInput,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import {
  type ConsumedPickerGrant,
  type LibraryEvent,
  type LibraryOperationHandle,
  type LibraryOperationSnapshot,
  type LibrarySessionSnapshot,
  type PathGrantId,
  type PickerGrant,
  type SessionId,
} from "../lib/catalog/runtime.ts";
import {
  parseCatalogEvent,
  parseCatalogApplyRequest,
  parseCatalogRuleApplyRequest,
  parseCatalogApplyResult,
  parseCatalogAssetHeadRequest,
  parseCatalogAssetRequest,
  parseCatalogCreateRequest,
  parseCatalogDecodeRequest,
  parseCatalogOperationRequest,
  parseCatalogQueryRequest,
  parseCatalogRemoveRequest,
  parseCatalogRootRequest,
  parseCatalogScanRequest,
  parseCatalogSelectionRequest,
  parseCatalogSessionRequest,
  parseCatalogSidecar,
  parseCatalogSidecarWriteRequest,
  parseCatalogDecodeResult,
  toCatalogLiveStateView,
  toCatalogSession,
  type CatalogActivationResult,
  type CatalogApplyRequest,
  type CatalogApplyResult,
  type CatalogBootstrapResult,
  type CatalogDecodeResult,
  type CatalogEvent,
  type CatalogEventListener,
  type CatalogRootResult,
  type CatalogSession,
  type CatalogSummary,
  type CatalogSidecar,
  type CatalogOperationResult,
  type CatalogQueryRequest,
  type CatalogRuleApplyRequest,
} from "../lib/catalog/api.ts";
import {
  type WatchRootInput,
  type WatchSessionInput,
} from "./watcher-reconciliation.ts";
import type { CatalogWatchEvent } from "../lib/catalog/watch.ts";
import { LibraryRuntime } from "./library-runtime.ts";
import {
  isRuntimeNativeRoot,
  type AssetScopedOperations,
  type LibraryRuntimeSource,
  type RuntimeAssetProjection,
  type RuntimeCatalogProjection,
  type RuntimeNativeRootProjection,
  type RuntimeRootProjection,
  type ScanCommitInput,
} from "./library-runtime.ts";
import type { CatalogLiveRoot, CatalogLiveObservation } from "../lib/catalog/live.ts";
import type { NativeAssetLocation } from "./native-asset-access.ts";

export interface CatalogRegistryRecord {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly databasePath: string;
  readonly health: "healthy" | "degraded" | "missing" | "corrupt";
  readonly lastOpenedAt: number;
}

export interface CatalogRegistryPort {
  read(): Promise<readonly CatalogRegistryRecord[]>;
  upsert(value: CatalogRegistryRecord): Promise<void>;
  remove?(catalogId: CatalogId): Promise<void>;
}

export interface CatalogPickerPort {
  chooseFolder(): Promise<{ readonly path: string; readonly label?: string } | null>;
}

export interface CatalogFilesystemPort {
  canonicalizeDirectory(inputPath: string): Promise<{ readonly canonicalPath: string; readonly label?: string }>;
  deleteCatalogFile?(databasePath: string): Promise<void>;
}

export interface CatalogPathAllocatorPort {
  allocateDatabasePath(catalogId: CatalogId): Promise<string>;
}

export interface CatalogSettingsPort {
  getLastCatalogId?: () => Promise<CatalogId | null>;
  setLastCatalogId?: (catalogId: CatalogId | null) => Promise<void>;
}

export interface CatalogLiveWorkerPort {
  open(databasePath: string): Promise<unknown>;
  close(): Promise<unknown>;
  liveCreate(input: CatalogLiveCreateInput): Promise<unknown>;
  liveQuery(input: CatalogLiveQueryInput): Promise<unknown>;
  liveApply(input: CatalogLiveApplyInput): Promise<unknown>;
}

export interface CatalogWatcherPort {
  activateSession(input: WatchSessionInput): void;
  closeSession(): void;
  subscribe(listener: (event: CatalogWatchEvent) => void): () => void;
}

export interface CatalogRuntimePort {
  selectSession(value: unknown): Promise<LibrarySessionSnapshot>;
  closeSession(): void;
  getSession(): LibrarySessionSnapshot | null;
  getNativeSessionRoots(): readonly RuntimeNativeRootProjection[];
  issuePathGrant(): Promise<PickerGrant>;
  consumePathGrant(value: unknown): Promise<ConsumedPickerGrant>;
  startScan(value: unknown): LibraryOperationHandle;
  cancelScan(value: unknown): void;
  getOperation(value: unknown): LibraryOperationSnapshot;
  waitForOperation(value: unknown): Promise<LibraryOperationSnapshot>;
  subscribe(listener: (event: LibraryEvent) => void): () => void;
  readAsset(value: unknown): Promise<Uint8Array>;
  readAssetHead(value: unknown): Promise<Uint8Array>;
  statAsset(value: unknown): Promise<{ readonly size: number; readonly lastModified: number }>;
  readAssetSidecar(value: unknown): Promise<unknown>;
  writeAssetSidecar(value: unknown): Promise<void>;
  trashAsset(value: unknown): Promise<void>;
  decodeAsset(value: unknown, request: unknown): Promise<unknown>;
}

export interface CatalogCoordinatorOptions {
  readonly picker: CatalogPickerPort;
  readonly registry: CatalogRegistryPort;
  readonly worker: CatalogLiveWorkerPort;
  readonly runtime: CatalogRuntimePort;
  readonly watchers?: CatalogWatcherPort;
  readonly settings?: CatalogSettingsPort;
  readonly filesystem: CatalogFilesystemPort;
  readonly paths: CatalogPathAllocatorPort;
  readonly startupRecovery?: CatalogBootstrapResult["recovery"];
  readonly now?: () => number;
}

interface ActiveCatalog {
  readonly catalog: CatalogSummary;
  readonly session: CatalogSession;
  readonly databasePath: string;
}

export interface CatalogNativeAdminLease {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly displayName: string;
  readonly databasePath: string;
  readonly quiesce: () => Promise<void>;
  readonly resume: () => Promise<CatalogActivationResult>;
}

class LiveWorkerRuntimeSource implements LibraryRuntimeSource {
  private readonly worker: CatalogLiveWorkerPort;
  private readonly now: () => number;

  constructor(worker: CatalogLiveWorkerPort, now: () => number) {
    this.worker = worker;
    this.now = now;
  }

  async loadCatalogProjection(catalogId: CatalogId): Promise<RuntimeCatalogProjection | null> {
    const state = await this.state(catalogId);
    if (state.catalog.catalogId !== catalogId) throw new Error("Catalog projection identity mismatch.");
    return {
      catalogId,
      roots: state.roots.map((root) => this.rootProjection(catalogId, root)),
    };
  }

  async loadRootProjection(catalogId: CatalogId, rootId: RootId): Promise<RuntimeRootProjection | null> {
    const state = await this.state(catalogId);
    const root = state.roots.find((candidate) => candidate.rootId === rootId);
    return root === undefined ? null : this.rootProjection(catalogId, root);
  }

  async loadAssetProjection(catalogId: CatalogId, assetId: AssetId): Promise<RuntimeAssetProjection | null> {
    const state = await this.state(catalogId);
    const asset = state.assets.find((candidate) => candidate.assetId === assetId);
    return asset === undefined
      ? null
      : { catalogId, assetId, rootId: asset.rootId, relativePath: asset.relativePath };
  }

  async commitScan(input: ScanCommitInput): Promise<void> {
    if (input.signal.aborted) throw new Error("Scan was cancelled.");
    const state = await this.state(input.catalogId);
    if (input.signal.aborted) throw new Error("Scan was cancelled.");
    const observations: CatalogLiveObservation[] = input.observations.map((observation) => {
      const format = getFormatCapabilityForFileName(observation.name);
      if (format === null) {
        throw new Error("Scan produced an unsupported format.");
      }
      if (observation.formatId !== undefined && observation.formatId !== format.id) {
        throw new Error("Scan produced a mismatched format id.");
      }
      return {
        relativePath: observation.relativePath,
        observation: {
          byteLength: observation.size,
          modifiedAt: observation.lastModified,
          observedAt: this.now(),
          localFileId: observation.localFileId ?? null,
        },
        health: "present",
        formatId: observation.formatId ?? format.id,
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
      };
    });
    const result = await this.worker.liveApply({
      catalogId: input.catalogId,
      expectedRevision: state.catalog.revision,
      mutations: [{ kind: "reconcile-complete", rootId: input.rootId, observations }],
      now: this.now(),
    });
    parseCatalogLiveApplyResult(result);
  }

  async adoptRoot(input: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
    readonly grantId: PathGrantId;
    readonly canonicalPath: string;
    readonly label: string;
  }): Promise<RootId> {
    void input.sessionId;
    void input.grantId;
    const state = await this.state(input.catalogId);
    const rootId = createRootId();
    const result = await this.worker.liveApply({
      catalogId: input.catalogId,
      expectedRevision: state.catalog.revision,
      mutations: [{
        kind: "root-upsert",
        root: {
          rootId,
          label: input.label,
          configuredPath: input.canonicalPath,
          canonicalPath: input.canonicalPath,
          health: "online",
          scanState: "unknown",
          watchState: "disabled",
        },
      }],
      now: this.now(),
    });
    parseCatalogLiveApplyResult(result);
    return rootId;
  }

  private async state(catalogId: CatalogId): Promise<CatalogLiveState> {
    const value = await this.worker.liveQuery({ catalogId, expectedRevision: null });
    return parseCatalogLiveQueryResult(value);
  }

  private rootProjection(catalogId: CatalogId, root: CatalogLiveRoot): RuntimeRootProjection {
    return {
      catalogId,
      rootId: root.rootId,
      label: root.label,
      nativePath: root.health === "online" ? root.canonicalPath : null,
    };
  }
}

export function createCatalogRuntimeSource(
  worker: CatalogLiveWorkerPort,
  now = Date.now,
): LibraryRuntimeSource {
  return new LiveWorkerRuntimeSource(worker, now);
}

export class CatalogCoordinator {
  private readonly picker: CatalogPickerPort;
  private readonly registry: CatalogRegistryPort;
  private readonly worker: CatalogLiveWorkerPort;
  private readonly runtime: CatalogRuntimePort;
  private readonly watchers: CatalogWatcherPort | undefined;
  private readonly settings: CatalogSettingsPort | undefined;
  private readonly filesystem: CatalogFilesystemPort;
  private readonly paths: CatalogPathAllocatorPort;
  private readonly now: () => number;
  private startupRecovery: CatalogBootstrapResult["recovery"];
  private readonly listeners = new Set<CatalogEventListener>();
  private readonly unsubscribeRuntime: () => void;
  private readonly unsubscribeWatchers: (() => void) | undefined;
  private transition: Promise<void> = Promise.resolve();
  private watchPersistence: Promise<void> = Promise.resolve();
  private active: ActiveCatalog | undefined;
  private maintenanceCatalogId: CatalogId | undefined;
  private sequence = 0;
  private workerOpen = false;

  constructor(options: CatalogCoordinatorOptions) {
    this.picker = options.picker;
    this.registry = options.registry;
    this.worker = options.worker;
    this.runtime = options.runtime;
    this.watchers = options.watchers;
    this.settings = options.settings;
    this.filesystem = options.filesystem;
    this.paths = options.paths;
    this.now = options.now ?? Date.now;
    this.startupRecovery = options.startupRecovery ?? null;
    this.unsubscribeRuntime = this.runtime.subscribe((event) => this.forwardRuntimeEvent(event));
    this.unsubscribeWatchers = this.watchers?.subscribe((event) => this.forwardWatcherEvent(event));
  }

  async bootstrap(): Promise<CatalogBootstrapResult> {
    return this.enqueue(async () => {
      if (this.active !== undefined) {
        return {
          catalogs: await this.publicCatalogs(),
          session: this.active.session,
          recovery: null,
        };
      }
      let catalogs: readonly CatalogSummary[];
      try {
        catalogs = await this.publicCatalogs();
      } catch {
        if (this.startupRecovery !== null) {
          return { catalogs: [], session: null, recovery: this.startupRecovery };
        }
        throw new Error("Catalog registry could not be read.");
      }
      if (this.startupRecovery !== null) {
        return { catalogs, session: null, recovery: this.startupRecovery };
      }

      let lastCatalogId: CatalogId | null = null;
      try {
        lastCatalogId = (await this.settings?.getLastCatalogId?.()) ?? null;
      } catch {
        return {
          catalogs,
          session: null,
          recovery: { kind: "corrupt", catalogId: null, message: "The last catalog setting could not be read." },
        };
      }
      if (lastCatalogId === null) return { catalogs, session: null, recovery: null };

      const entry = catalogs.find((catalog) => catalog.catalogId === lastCatalogId);
      if (entry === undefined) {
        return {
          catalogs,
          session: null,
          recovery: { kind: "missing", catalogId: lastCatalogId, message: "The last catalog is no longer registered." },
        };
      }
      const internalEntry = await this.findRegistryEntry(lastCatalogId);
      if (internalEntry === null) {
        return {
          catalogs,
          session: null,
          recovery: { kind: "missing", catalogId: lastCatalogId, message: "The last catalog is no longer registered." },
        };
      }
      try {
        const activation = await this.activate(internalEntry);
        return { catalogs: await this.publicCatalogs(), session: activation.session, recovery: null };
      } catch {
        await this.registry.upsert({ ...internalEntry, health: "corrupt" });
        return {
          catalogs: await this.publicCatalogs(),
          session: null,
          recovery: { kind: "corrupt", catalogId: lastCatalogId, message: "The last catalog could not be opened." },
        };
      }
    });
  }

  subscribe(listener: CatalogEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createCatalog(value: unknown): Promise<CatalogActivationResult> {
    const input = parseCatalogCreateRequest(value);
    return this.enqueue(async () => {
      if (this.maintenanceCatalogId !== undefined) {
        throw new Error("Catalog maintenance is active.");
      }
      const selected = await this.picker.chooseFolder();
      if (selected === null) throw new Error("Folder selection was cancelled.");
      const resolved = await this.filesystem.canonicalizeDirectory(selected.path);
      const catalogId = createCatalogId();
      const rootId = createRootId();
      const databasePath = await this.paths.allocateDatabasePath(catalogId);
      await this.deactivate();
      try {
        await this.worker.open(databasePath);
        this.workerOpen = true;
        const result = await this.worker.liveCreate({
          catalogId,
          displayName: input.displayName,
          appVersion: "0.1.0",
          root: {
            rootId,
            label: selected.label?.trim() || resolved.label?.trim() || path.basename(resolved.canonicalPath) || "Library",
            configuredPath: resolved.canonicalPath,
            canonicalPath: resolved.canonicalPath,
            health: "online",
            scanState: "unknown",
            watchState: "disabled",
          },
          now: this.now(),
        });
        const created = parseCatalogLiveApplyResult(result);
        if (created.catalogId !== catalogId) throw new Error("Created catalog identity mismatch.");
        const entry: CatalogRegistryRecord = {
          catalogId,
          displayName: input.displayName,
          databasePath,
          health: "healthy",
          lastOpenedAt: this.now(),
        };
        await this.registry.upsert(entry);
        const activation = await this.activate(entry);
        this.startupRecovery = null;
        return activation;
      } catch (error) {
        await this.deactivate();
        throw error;
      }
    });
  }

  async openCatalog(value: unknown): Promise<CatalogActivationResult> {
    const { catalogId } = parseCatalogSelectionRequest(value);
    return this.enqueue(async () => {
      const entry = await this.findRegistryEntry(catalogId);
      if (entry === null) throw new Error("Catalog was not found.");
      const activation = await this.activate(entry);
      this.startupRecovery = null;
      return activation;
    });
  }

  switchCatalog(value: unknown): Promise<CatalogActivationResult> {
    return this.openCatalog(value);
  }

  async closeCatalog(value: unknown): Promise<void> {
    const input = parseCatalogSessionRequest(value);
    return this.enqueue(async () => {
      this.requireCurrent(input.catalogId, input.sessionId);
      await this.deactivate();
      await this.settings?.setLastCatalogId?.(null);
    });
  }

  async addRoot(value: unknown): Promise<CatalogRootResult> {
    const input = parseCatalogSessionRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const grant = await this.runtime.issuePathGrant();
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    const consumed = await this.runtime.consumePathGrant({
      catalogId: input.catalogId,
      sessionId: input.sessionId,
      grantId: grant.grantId,
    });
    this.requireCurrent(input.catalogId, input.sessionId);
    if (consumed.catalogId !== input.catalogId || consumed.sessionId !== input.sessionId) {
      throw new Error("Path grant belongs to a different catalog session.");
    }
    const refreshed = this.runtime.getSession();
    if (refreshed === null) throw new Error("Library session is inactive.");
    if (!refreshed.roots.some((root) => root.rootId === consumed.rootId)) {
      throw new Error("Registered root was not found in the active session.");
    }
    this.active = { ...active, session: toCatalogSession(refreshed) };
    this.activateWatchers(this.active);
    return consumed;
  }

  async relinkRoot(value: unknown): Promise<CatalogActivationResult> {
    const input = parseCatalogRootRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    if (!active.session.roots.some((root) => root.rootId === input.rootId)) {
      throw new Error("Catalog root was not found in the active session.");
    }
    const selected = await this.picker.chooseFolder();
    if (selected === null) throw new Error("Folder selection was cancelled.");
    const resolved = await this.filesystem.canonicalizeDirectory(selected.path);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    const state = parseCatalogLiveQueryResult(await this.worker.liveQuery({
      catalogId: input.catalogId,
      expectedRevision: null,
    }));
    const root = state.roots.find((candidate) => candidate.rootId === input.rootId);
    if (root === undefined) throw new Error("Catalog root was not found.");
    await this.worker.liveApply({
      catalogId: input.catalogId,
      expectedRevision: state.catalog.revision,
      mutations: [{
        kind: "root-relink",
        rootId: input.rootId,
        label: selected.label?.trim() || resolved.label?.trim() || root.label,
        configuredPath: resolved.canonicalPath,
        canonicalPath: resolved.canonicalPath,
        health: "online",
      }],
      now: this.now(),
    });
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    const snapshot = await this.runtime.selectSession({ catalogId: input.catalogId });
    const session = toCatalogSession(snapshot);
    this.active = { ...active, session };
    this.activateWatchers(this.active, this.runtime.getNativeSessionRoots());
    return { catalog: this.active.catalog, session };
  }

  async removeCatalog(value: unknown): Promise<void> {
    const input = parseCatalogRemoveRequest(value);
    return this.enqueue(async () => {
      if (this.maintenanceCatalogId !== undefined) {
        throw new Error("Catalog maintenance is active.");
      }
      const entry = await this.findRegistryEntry(input.catalogId);
      if (entry === null) throw new Error("Catalog was not found.");
      if (input.deleteFile && input.confirmation !== entry.displayName) {
        throw new Error("Catalog deletion confirmation does not match its name.");
      }
      if (this.registry.remove === undefined) {
        throw new Error("Removing a catalog from recents is unavailable.");
      }
      if (input.deleteFile && this.filesystem.deleteCatalogFile === undefined) {
        throw new Error("Catalog deletion is unavailable.");
      }
      const wasActive = this.active?.catalog.catalogId === input.catalogId;
      if (wasActive) throw new Error("Close the active catalog before removing it.");
      try {
        await this.registry.remove(input.catalogId);
        if (input.deleteFile) {
          await this.filesystem.deleteCatalogFile!(entry.databasePath);
        }
      } catch (error) {
        await this.registry.upsert(entry).catch(() => undefined);
        throw error;
      }
    });
  }

  startScan(value: unknown): CatalogOperationResult {
    const input = parseCatalogScanRequest(value);
    this.requireCurrent(input.catalogId, input.sessionId);
    return this.runtime.startScan(input);
  }

  cancelScan(value: unknown): void {
    const input = parseCatalogOperationRequest(value);
    this.requireCurrent(input.catalogId, input.sessionId);
    this.runtime.cancelScan(input);
  }

  getOperation(value: unknown): LibraryOperationSnapshot {
    const input = parseCatalogOperationRequest(value);
    this.requireCurrent(input.catalogId, input.sessionId);
    return this.runtime.getOperation(input);
  }

  async waitForOperation(value: unknown): Promise<LibraryOperationSnapshot> {
    const input = parseCatalogOperationRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const result = await this.runtime.waitForOperation(input);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    return result;
  }

  async queryLive(value: unknown): Promise<ReturnType<typeof toCatalogLiveStateView>> {
    const input = parseCatalogQueryRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const result = await this.worker.liveQuery(this.queryInput(input));
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    return toCatalogLiveStateView(parseCatalogLiveQueryResult(result));
  }

  async applyLive(value: unknown): Promise<CatalogApplyResult> {
    const input = parseCatalogApplyRequest(value);
    return this.applyMutations(input);
  }

  async applyAutoImportRule(value: unknown): Promise<CatalogApplyResult> {
    const input = parseCatalogRuleApplyRequest(value);
    return this.applyMutations(input);
  }

  private async applyMutations(
    input: CatalogApplyRequest | CatalogRuleApplyRequest,
  ): Promise<CatalogApplyResult> {
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    await this.validateMutations(input);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    const result = await this.worker.liveApply({
      catalogId: input.catalogId,
      expectedRevision: input.expectedRevision,
      mutations: input.mutations,
      now: this.now(),
    });
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    const parsed = parseCatalogApplyResult(result);
    const renamed = [...input.mutations]
      .reverse()
      .find((mutation) => mutation.kind === "rename-catalog");
    if (renamed?.kind === "rename-catalog") {
      const updated = {
        ...active,
        catalog: { ...active.catalog, displayName: renamed.displayName },
      };
      this.active = updated;
      await this.registry.upsert({
        ...updated.catalog,
        databasePath: active.databasePath,
      }).catch(() => undefined);
    }
    return parsed;
  }

  async readAsset(value: unknown): Promise<ArrayBuffer> {
    const input = parseCatalogAssetRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const result = await this.runtime.readAsset(input);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    return copyBuffer(result);
  }

  async readAssetHead(value: unknown): Promise<ArrayBuffer> {
    const input = parseCatalogAssetHeadRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const result = await this.runtime.readAssetHead(input);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    return copyBuffer(result);
  }

  async statAsset(value: unknown): Promise<{ readonly size: number; readonly lastModified: number }> {
    const input = parseCatalogAssetRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const result = await this.runtime.statAsset(input);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    return result;
  }

  async readSidecar(value: unknown): Promise<CatalogSidecar | null> {
    const input = parseCatalogAssetRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const result = await this.runtime.readAssetSidecar(input);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    return parseCatalogSidecar(result);
  }

  async writeSidecar(value: unknown): Promise<void> {
    const input = parseCatalogSidecarWriteRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    await this.runtime.writeAssetSidecar(input);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
  }

  async decodeAsset(value: unknown, requestValue: unknown): Promise<CatalogDecodeResult> {
    const input = parseCatalogAssetRequest(value);
    const request = parseCatalogDecodeRequest(requestValue);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const result = await this.runtime.decodeAsset(input, request);
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    return parseCatalogDecodeResult(result);
  }

  async trashAsset(value: unknown): Promise<void> {
    const input = parseCatalogAssetRequest(value);
    this.requireCurrent(input.catalogId, input.sessionId);
    throw new Error("Removing files from disk is unavailable until recovery can be guaranteed.");
  }

  async exportAssetLocations(value: unknown): Promise<readonly NativeAssetLocation[]> {
    const input = parseCatalogSessionRequest(value);
    const active = this.requireCurrent(input.catalogId, input.sessionId);
    const state = parseCatalogLiveQueryResult(await this.worker.liveQuery({
      catalogId: input.catalogId,
      expectedRevision: null,
    }));
    this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
    const roots = new Map(
      state.roots
        .filter((root) => root.health === "online" && root.canonicalPath !== null)
        .map((root) => [root.rootId, root.canonicalPath!] as const),
    );
    const locations = new Map<AssetId, NativeAssetLocation>();
    for (const asset of state.assets) {
      if (asset.health !== "present") continue;
      const canonicalRootPath = roots.get(asset.rootId);
      if (canonicalRootPath === undefined || locations.has(asset.assetId)) continue;
      locations.set(asset.assetId, {
        catalogId: input.catalogId,
        assetId: asset.assetId,
        rootId: asset.rootId,
        canonicalRootPath,
        relativePath: asset.relativePath,
      });
    }
    return [...locations.values()];
  }

  runCatalogAdmin<T>(
    value: unknown,
    task: (lease: CatalogNativeAdminLease) => Promise<T>,
  ): Promise<T> {
    const input = parseCatalogSessionRequest(value);
    return this.enqueue(async () => {
      const active = this.requireCurrent(input.catalogId, input.sessionId);
      return task(this.createAdminLease(active));
    });
  }

  runScheduledCatalogAdmin<T>(
    task: (lease: CatalogNativeAdminLease) => Promise<T>,
  ): Promise<T | null> {
    return this.enqueue(async () => {
      if (this.active === undefined || this.maintenanceCatalogId !== undefined) return null;
      return task(this.createAdminLease(this.active));
    });
  }

  runCatalogManagement<T>(task: () => Promise<T>): Promise<T> {
    return this.enqueue(task);
  }

  async close(): Promise<void> {
    this.unsubscribeRuntime();
    this.unsubscribeWatchers?.();
    await this.enqueue(() => this.deactivate());
    this.listeners.clear();
  }

  private async activate(
    entry: CatalogRegistryRecord,
    allowMaintenance = false,
  ): Promise<CatalogActivationResult> {
    if (this.maintenanceCatalogId !== undefined && !allowMaintenance) {
      throw new Error("Catalog maintenance is active.");
    }
    await this.deactivate();
    try {
      await this.worker.open(entry.databasePath);
      this.workerOpen = true;
      const live = parseCatalogLiveQueryResult(await this.worker.liveQuery({
        catalogId: entry.catalogId,
        expectedRevision: null,
      }));
      const snapshot = await this.runtime.selectSession({ catalogId: entry.catalogId });
      const session = toCatalogSession(snapshot);
      if (session.catalogId !== entry.catalogId) throw new Error("Catalog session identity mismatch.");
      const roots = this.runtime.getNativeSessionRoots();
      const updated: CatalogRegistryRecord = {
        ...entry,
        displayName: live.catalog.displayName,
        health: "healthy",
        lastOpenedAt: this.now(),
      };
      this.active = {
        catalog: toCatalogSummary(updated),
        session,
        databasePath: entry.databasePath,
      };
      this.activateWatchers(this.active, roots);
      await this.registry.upsert(updated);
      await this.settings?.setLastCatalogId?.(entry.catalogId);
      return { catalog: toCatalogSummary(updated), session };
    } catch (error) {
      await this.deactivate();
      throw error;
    }
  }

  private createAdminLease(active: ActiveCatalog): CatalogNativeAdminLease {
    let quiesced = false;
    const entry: CatalogRegistryRecord = {
      ...active.catalog,
      databasePath: active.databasePath,
    };
    return {
      catalogId: active.catalog.catalogId,
      sessionId: active.session.sessionId,
      displayName: active.catalog.displayName,
      databasePath: active.databasePath,
      quiesce: async () => {
        if (quiesced) return;
        this.requireCurrent(active.catalog.catalogId, active.session.sessionId);
        if (this.maintenanceCatalogId !== undefined) {
          throw new Error("Catalog maintenance is already active.");
        }
        this.maintenanceCatalogId = active.catalog.catalogId;
        await this.deactivate();
        quiesced = true;
      },
      resume: async () => {
        if (!quiesced || this.maintenanceCatalogId !== active.catalog.catalogId) {
          throw new Error("Catalog maintenance is inactive.");
        }
        this.maintenanceCatalogId = undefined;
        try {
          const activation = await this.activate(entry, true);
          quiesced = false;
          return activation;
        } catch (error) {
          this.maintenanceCatalogId = active.catalog.catalogId;
          throw error;
        }
      },
    };
  }

  private activateWatchers(active: ActiveCatalog, roots = this.runtime.getNativeSessionRoots()): void {
    if (this.watchers === undefined) return;
    const watchRoots: WatchRootInput[] = roots
      .filter((root) => root.catalogId === active.catalog.catalogId && active.session.roots.some((item) => item.rootId === root.rootId))
      .filter(isRuntimeNativeRoot)
      .map((root) => ({
        catalogId: active.catalog.catalogId,
        sessionId: active.session.sessionId,
        rootId: root.rootId,
        nativePath: root.nativePath,
      }));
    this.watchers.activateSession({
      catalogId: active.catalog.catalogId,
      sessionId: active.session.sessionId,
      roots: watchRoots,
    });
  }

  private async deactivate(): Promise<void> {
    this.active = undefined;
    this.sequence = 0;
    this.watchers?.closeSession();
    this.runtime.closeSession();
    if (this.workerOpen) {
      this.workerOpen = false;
      await this.worker.close().catch(() => undefined);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.transition.then(task, task);
    this.transition = result.then(() => undefined, () => undefined);
    return result;
  }

  private async publicCatalogs(): Promise<readonly CatalogSummary[]> {
    const records = await this.registry.read();
    return records.map((record) => record.catalogId === this.active?.catalog.catalogId
      ? this.active.catalog
      : toCatalogSummary(record));
  }

  private async findRegistryEntry(catalogId: CatalogId): Promise<CatalogRegistryRecord | null> {
    const records = await this.registry.read();
    return records.find((entry) => parseCatalogId(entry.catalogId) === catalogId) ?? null;
  }

  private requireCurrent(catalogId: CatalogId, sessionId: SessionId): ActiveCatalog {
    const active = this.active;
    if (active === undefined || active.catalog.catalogId !== catalogId || active.session.sessionId !== sessionId) {
      throw new Error("Catalog session is inactive.");
    }
    return active;
  }

  private queryInput(input: CatalogQueryRequest): CatalogLiveQueryInput {
    return {
      catalogId: input.catalogId,
      expectedRevision: input.expectedRevision,
      ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
      ...(input.rootId === undefined ? {} : { rootId: input.rootId }),
      ...(input.fingerprintSha256 === undefined ? {} : { fingerprintSha256: input.fingerprintSha256 }),
    };
  }

  private async validateMutations(input: CatalogApplyRequest | CatalogRuleApplyRequest): Promise<void> {
    const state = parseCatalogLiveQueryResult(await this.worker.liveQuery({ catalogId: input.catalogId, expectedRevision: null }));
    this.requireCurrent(input.catalogId, input.sessionId);
    const rootIds = new Set(state.roots.map((root) => root.rootId));
    const nativeRoots = new Map(
      this.runtime.getNativeSessionRoots()
        .filter(isRuntimeNativeRoot)
        .map((root) => [root.rootId, root.nativePath] as const),
    );
    for (const mutation of input.mutations) {
      if (mutation.kind !== "rule-upsert") continue;
      const destinationRootPath = nativeRoots.get(mutation.destinationRootId);
      const ingressRootPath = nativeRoots.get(mutation.config.ingressRootId);
      if (
        !rootIds.has(mutation.destinationRootId) ||
        !rootIds.has(mutation.config.ingressRootId) ||
        destinationRootPath === undefined ||
        ingressRootPath === undefined
      ) {
        throw new Error("Rule references a root outside the active catalog.");
      }
      const ingressPath = path.resolve(ingressRootPath, mutation.config.ingressRelativePath);
      const destinationPath = mutation.config.version === 2
        ? path.resolve(destinationRootPath, mutation.config.destinationRelativePath)
        : destinationRootPath;
      if (isPathWithin(destinationPath, ingressPath) || isPathWithin(ingressPath, destinationPath)) {
        throw new Error("Rule source and destination overlap.");
      }
    }
  }

  private forwardRuntimeEvent(event: LibraryEvent): void {
    const active = this.active;
    if (active === undefined || active.catalog.catalogId !== event.catalogId || active.session.sessionId !== event.sessionId) return;
    this.sequence += 1;
    this.emit(parseCatalogEvent({ ...event, sequence: this.sequence }));
  }

  private forwardWatcherEvent(event: CatalogWatchEvent): void {
    const active = this.active;
    if (active === undefined || active.catalog.catalogId !== event.catalogId || active.session.sessionId !== event.sessionId) return;
    this.sequence += 1;
    this.emit(parseCatalogEvent({ ...event, sequence: this.sequence }));
    if (event.kind === "watch-state") {
      const update = this.watchPersistence.then(
        () => this.persistWatchState(event),
        () => this.persistWatchState(event),
      );
      this.watchPersistence = update.then(() => undefined, () => undefined);
    }
  }

  private async persistWatchState(event: CatalogWatchEvent): Promise<void> {
    if (event.kind !== "watch-state" || !("status" in event.payload)) return;
    const active = this.active;
    if (
      active === undefined ||
      active.catalog.catalogId !== event.catalogId ||
      active.session.sessionId !== event.sessionId ||
      !active.session.roots.some((root) => root.rootId === event.rootId)
    ) {
      return;
    }
    const state = parseCatalogLiveQueryResult(await this.worker.liveQuery({
      catalogId: event.catalogId,
      expectedRevision: null,
    }));
    if (!this.isCurrent(event.catalogId, event.sessionId)) return;
    const root = state.roots.find((candidate) => candidate.rootId === event.rootId);
    if (root === undefined) return;
    const watchState = event.payload.status === "active" || event.payload.status === "reconciling"
      ? "active"
      : "error";
    const mutations: CatalogLiveMutation[] = [];
    if (root.watchState !== watchState) {
      mutations.push({ kind: "root-watch", rootId: event.rootId, watchState });
    }
    if (event.payload.status === "missing" && root.health !== "missing") {
      mutations.push({ kind: "root-health", rootId: event.rootId, health: "missing", canonicalPath: null });
    } else if (event.payload.status === "permission-denied" && root.health !== "unreadable") {
      mutations.push({ kind: "root-health", rootId: event.rootId, health: "unreadable", canonicalPath: null });
    } else if (event.payload.status === "active" && root.health !== "online") {
      const nativeRoot = this.runtime.getNativeSessionRoots()
        .filter(isRuntimeNativeRoot)
        .find((candidate) => candidate.rootId === event.rootId);
      if (nativeRoot !== undefined) {
        mutations.push({ kind: "root-health", rootId: event.rootId, health: "online", canonicalPath: nativeRoot.nativePath });
      }
    }
    if (mutations.length === 0) return;
    await this.worker.liveApply({
      catalogId: event.catalogId,
      expectedRevision: state.catalog.revision,
      mutations,
      now: this.now(),
    });
  }

  private isCurrent(catalogId: CatalogId, sessionId: SessionId): boolean {
    return this.active?.catalog.catalogId === catalogId && this.active.session.sessionId === sessionId;
  }

  private emit(event: CatalogEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A renderer listener cannot interrupt catalog ownership.
      }
    }
  }
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toCatalogSummary(record: CatalogRegistryRecord): CatalogSummary {
  return {
    catalogId: parseCatalogId(record.catalogId),
    displayName: record.displayName,
    health: record.health,
    lastOpenedAt: record.lastOpenedAt,
  };
}

function copyBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

export function createCatalogCoordinatorRuntime(options: {
  readonly worker: CatalogLiveWorkerPort;
  readonly picker?: CatalogPickerPort;
  readonly assetOperations?: AssetScopedOperations;
  readonly now?: () => number;
}): LibraryRuntime {
  if (options.picker === undefined) throw new Error("Library runtime needs a folder picker.");
  return new LibraryRuntime({
    source: createCatalogRuntimeSource(options.worker, options.now),
    picker: options.picker,
    assetOperations: options.assetOperations,
    now: options.now,
  });
}
