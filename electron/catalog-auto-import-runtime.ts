import path from "node:path";
import {
  parseAssetId,
  parseCatalogId,
  parsePresetId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type PresetId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  parseCatalogLiveApplyResult,
  parseCatalogLiveQueryResult,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import type { CatalogRuleMutation } from "../lib/catalog/api.ts";
import { parseRelativePath, parseSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import type { DirtyScope } from "../lib/catalog/watch.ts";
import type { OperationId } from "../lib/catalog/ids.ts";
import {
  AutoImportQueue,
  normalizeAutoImportRelativePath,
  parseAutoImportRuleId,
  validateAutoImportRules,
  type AutoImportRule,
} from "../lib/import/auto-import.ts";
import type { CatalogLiveWorkerPort } from "./catalog-coordinator.ts";
import {
  CatalogAutoImportController,
  type CatalogAutoImportConfigureInput,
  type CatalogAutoImportStatus,
} from "./catalog-auto-import-controller.ts";
import {
  CatalogAutoImportExecutor,
  type CatalogAutoImportExecutorOptions,
} from "./catalog-auto-import-executor.ts";
import {
  CatalogAutoImportMonitor,
  type CatalogAutoImportMonitorPorts,
} from "./catalog-auto-import-monitor.ts";
import {
  CatalogAutoImportNativeFiles,
  type CatalogAutoImportNativeRootResolver,
} from "./catalog-auto-import-native-files.ts";
import {
  AutoImportStore,
  type AutoImportStoreState,
} from "./auto-import-store.ts";
import type {
  CatalogImportExternalSourceRegistration,
} from "./catalog-import-adapter.ts";
import type {
  CatalogFaultInjector,
} from "./catalog-fault-injection.ts";
import type {
  FileTransactionFileSystem,
  FileTransactionJournal,
} from "./file-transaction-service.ts";

const AUTHORITY_RULE_NAME = "Auto Import";
const MAX_LIVE_RETRIES = 3;

export interface CatalogAutoImportLiveApplyInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly expectedRevision: number;
  readonly mutations: readonly CatalogRuleMutation[];
}

export interface CatalogAutoImportRuntimeOptions {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  readonly assertCurrentSession: () => void | Promise<void>;
  readonly applyLive: (input: CatalogAutoImportLiveApplyInput) => Promise<unknown>;
  readonly resolveNativeRoot: CatalogAutoImportNativeRootResolver["resolveRoot"];
  readonly store: AutoImportStore;
  readonly journal: FileTransactionJournal;
  readonly fileSystem?: FileTransactionFileSystem;
  readonly faultInjector?: CatalogFaultInjector;
  readonly openPath: (nativePath: string) => Promise<string>;
  readonly now?: () => number;
  readonly monitorPorts?: CatalogAutoImportMonitorPorts;
}

interface LiveAuthority {
  readonly rule: AutoImportRule | null;
  readonly legacy: boolean;
}

interface AuthoritySyncResult extends LiveAuthority {
  readonly changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /revision|stale/i.test(error.message);
}

function sameObservation(
  asset: CatalogLiveState["assets"][number],
  observation: CatalogImportExternalSourceRegistration["observation"],
): boolean {
  return asset.health === "present" &&
    asset.observation !== null &&
    asset.observation.byteLength === observation.size &&
    asset.observation.modifiedAt === observation.modifiedAt &&
    (asset.observation.localFileId === null ||
      observation.localFileId === null ||
      asset.observation.localFileId === observation.localFileId);
}

function observationValue(
  observation: CatalogImportExternalSourceRegistration["observation"],
): {
  readonly byteLength: number;
  readonly modifiedAt: number;
  readonly observedAt: number;
  readonly localFileId: string | null;
} {
  return {
    byteLength: observation.size,
    modifiedAt: observation.modifiedAt,
    observedAt: observation.observedAt,
    localFileId: observation.localFileId,
  };
}

function sameRule(left: AutoImportRule, right: AutoImportRule): boolean {
  return left.catalogId === right.catalogId &&
    left.ruleId === right.ruleId &&
    left.ingressRootId === right.ingressRootId &&
    left.ingressRelativePath === right.ingressRelativePath &&
    left.destinationRootId === right.destinationRootId &&
    left.destinationRelativePath === right.destinationRelativePath &&
    left.placement === right.placement &&
    left.presetId === right.presetId &&
    left.presetVersion === right.presetVersion &&
    left.presetSha256 === right.presetSha256 &&
    left.duplicatePolicy === right.duplicatePolicy &&
    left.destinationConflictPolicy === right.destinationConflictPolicy &&
    left.enabled === right.enabled &&
    left.stabilityMs === right.stabilityMs &&
    left.maxAttempts === right.maxAttempts &&
    left.retryBackoffMs === right.retryBackoffMs;
}

function liveRule(state: CatalogLiveState, catalogId: CatalogId): LiveAuthority {
  const enabled = state.rules.filter((candidate) => candidate.enabled);
  if (enabled.length > 1) throw new Error("Auto Import has multiple enabled rules.");
  const row = enabled[0] ?? [...state.rules].sort((left, right) =>
    right.updatedAt - left.updatedAt || right.ruleId.localeCompare(left.ruleId),
  )[0];
  if (row === undefined) return { rule: null, legacy: false };
  if (row.config.version !== 2) return { rule: null, legacy: true };
  const config = row.config;
  const rule: AutoImportRule = {
    catalogId,
    ruleId: parseAutoImportRuleId(row.ruleId),
    ingressRootId: parseRootId(config.ingressRootId),
    ingressRelativePath: normalizeAutoImportRelativePath(parseRelativePath(config.ingressRelativePath)),
    destinationRootId: parseRootId(row.destinationRootId),
    destinationRelativePath: normalizeAutoImportRelativePath(parseRelativePath(config.destinationRelativePath)),
    placement: "copy",
    presetId: parsePresetId(row.presetId),
    presetVersion: config.presetVersion,
    presetSha256: config.presetSha256,
    duplicatePolicy: config.duplicatePolicy,
    destinationConflictPolicy: config.destinationConflictPolicy,
    enabled: row.enabled,
    stabilityMs: config.stabilityMs,
    maxAttempts: config.maxAttempts,
    retryBackoffMs: config.retryBackoffMs,
  };
  validateAutoImportRules([rule]);
  return { rule, legacy: false };
}

function sidecarRule(state: AutoImportStoreState, catalogId: CatalogId): AutoImportRule | null {
  if (state.rules.length > 1) throw new Error("Auto Import sidecar has multiple rules.");
  const rule = state.rules[0] ?? null;
  if (rule !== null && rule.catalogId !== catalogId) {
    throw new Error("Auto Import sidecar belongs to another catalog.");
  }
  return rule;
}

function emptyQueue(paused: boolean): AutoImportQueue {
  const queue = new AutoImportQueue();
  if (paused) queue.pause();
  return queue;
}

function liveConfig(rule: AutoImportRule) {
  if (rule.duplicatePolicy === "use-existing-location") {
    throw new Error("Auto Import use-existing-location duplicates are unavailable.");
  }
  if (rule.destinationConflictPolicy === "replace") {
    throw new Error("Auto Import Replace conflicts are unavailable.");
  }
  return {
    version: 2 as const,
    action: "copy" as const,
    ingressRootId: rule.ingressRootId,
    ingressRelativePath: rule.ingressRelativePath,
    destinationRelativePath: rule.destinationRelativePath,
    presetVersion: rule.presetVersion,
    presetSha256: rule.presetSha256,
    duplicatePolicy: rule.duplicatePolicy,
    destinationConflictPolicy: rule.destinationConflictPolicy,
    stabilityMs: rule.stabilityMs,
    maxAttempts: rule.maxAttempts,
    retryBackoffMs: rule.retryBackoffMs,
  };
}

function nativeRootPath(value: unknown, catalogId: CatalogId, rootId: RootId): string {
  if (!isRecord(value)) throw new Error("Auto Import root is unavailable.");
  if (parseCatalogId(value.catalogId) !== catalogId || parseRootId(value.rootId) !== rootId) {
    throw new Error("Auto Import root identity is invalid.");
  }
  const canonicalPath = value.canonicalPath;
  if (typeof canonicalPath !== "string" || !path.isAbsolute(canonicalPath) || path.normalize(canonicalPath) !== canonicalPath) {
    throw new Error("Auto Import root is unavailable.");
  }
  return canonicalPath;
}

export class CatalogAutoImportRuntime {
  private readonly catalogId: CatalogId;
  private readonly sessionId: SessionId;
  private readonly worker: Pick<CatalogLiveWorkerPort, "liveQuery" | "liveApply">;
  private readonly assertCurrentSession: () => void | Promise<void>;
  private readonly applyLive: CatalogAutoImportRuntimeOptions["applyLive"];
  private readonly resolveNativeRoot: CatalogAutoImportRuntimeOptions["resolveNativeRoot"];
  private readonly store: AutoImportStore;
  private readonly openPath: CatalogAutoImportRuntimeOptions["openPath"];
  private readonly now: () => number;
  private readonly controller: CatalogAutoImportController;
  private readonly monitor: CatalogAutoImportMonitor;
  private readonly serial: { current: Promise<void> } = { current: Promise.resolve() };
  private started = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;

  public constructor(options: CatalogAutoImportRuntimeOptions) {
    this.catalogId = parseCatalogId(options.catalogId);
    this.sessionId = parseSessionId(options.sessionId);
    this.worker = options.worker;
    this.assertCurrentSession = options.assertCurrentSession;
    this.applyLive = options.applyLive;
    this.resolveNativeRoot = options.resolveNativeRoot;
    this.store = options.store;
    this.openPath = options.openPath;
    this.now = options.now ?? Date.now;
    const nativeFiles = new CatalogAutoImportNativeFiles({
      catalogId: this.catalogId,
      sessionId: this.sessionId,
      roots: { resolveRoot: (input) => this.resolveNativeRoot(input) },
      assertCurrentSession: this.assertCurrentSession,
    });
    const executorOptions: CatalogAutoImportExecutorOptions = {
      catalogId: this.catalogId,
      sessionId: this.sessionId,
      worker: this.worker,
      assertCurrentSession: this.assertCurrentSession,
      nativeFiles,
      presetResolver: { resolvePreset: (input) => this.resolvePreset(input.catalogId, input.presetId) },
      externalSourceRegistrar: { register: (input) => this.registerSource(input) },
      journal: options.journal,
      ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      now: this.now,
    };
    const executor = new CatalogAutoImportExecutor(executorOptions);
    this.controller = new CatalogAutoImportController({
      catalogId: this.catalogId,
      store: this.store,
      resolver: {
        resolveRoot: (input) => this.resolveNativeRoot({
          catalogId: input.catalogId,
          sessionId: this.sessionId,
          rootId: input.rootId,
        }),
        resolvePreset: (input) => this.resolvePreset(input.catalogId, input.presetId),
      },
      executor,
      assertCurrentSession: this.assertCurrentSession,
      now: this.now,
    });
    this.monitor = new CatalogAutoImportMonitor({
      catalogId: this.catalogId,
      controller: this.controller,
      ports: options.monitorPorts ?? nativeFiles,
      now: this.now,
    });
  }

  public async start(): Promise<void> {
    await this.serialize(async () => {
      this.assertOpen();
      await this.synchronizeAuthority();
      if (this.started) return;
      await this.monitor.start();
      this.started = true;
    });
  }

  public async status(): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      const synced = await this.synchronizeAuthority();
      const status = await this.statusWithHealth();
      if (this.started && synced.changed) await this.monitor.refresh();
      return status;
    });
  }

  public async configure(input: CatalogAutoImportConfigureInput): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      await this.synchronizeAuthority();
      const before = await this.controller.status();
      await this.controller.pause();
      try {
        const rule = await this.controller.configure(input);
        try {
          await this.applyLiveRule(rule);
        } catch (error) {
          await this.synchronizeAuthority();
          throw error;
        }
      } finally {
        if (before.paused) await this.controller.pause();
        else await this.controller.resume();
      }
      if (this.started) await this.monitor.refresh();
      return this.statusWithHealth();
    });
  }

  public async enable(): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      const synced = await this.synchronizeAuthority();
      if (synced.rule === null) throw new Error(synced.legacy ? "Auto Import requires reconfiguration." : "Auto Import rule is not configured.");
      const enabled = { ...synced.rule, enabled: true } satisfies AutoImportRule;
      try {
        await this.applyLiveRule(enabled);
        await this.controller.enable();
      } catch (error) {
        await this.synchronizeAuthority();
        throw error;
      }
      if (this.started) await this.monitor.refresh();
      return this.statusWithHealth();
    });
  }

  public async disable(): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      const synced = await this.synchronizeAuthority();
      if (synced.rule === null) throw new Error(synced.legacy ? "Auto Import requires reconfiguration." : "Auto Import rule is not configured.");
      const before = await this.controller.status();
      await this.controller.pause();
      try {
        await this.applyLiveRule({ ...synced.rule, enabled: false });
        await this.controller.disable();
      } catch (error) {
        await this.synchronizeAuthority();
        throw error;
      } finally {
        if (before.paused) await this.controller.pause();
        else await this.controller.resume();
      }
      if (this.started) await this.monitor.refresh();
      return this.statusWithHealth();
    });
  }

  public async pause(): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      await this.synchronizeAuthority();
      await this.controller.pause();
      return this.statusWithHealth();
    });
  }

  public async resume(): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      await this.synchronizeAuthority();
      await this.controller.resume();
      if (this.started) await this.monitor.refresh();
      return this.statusWithHealth();
    });
  }

  public async cancel(queueId: OperationId): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      await this.synchronizeAuthority();
      await this.controller.cancel(queueId);
      return this.statusWithHealth();
    });
  }

  public async retryFailed(): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      await this.synchronizeAuthority();
      await this.controller.retryFailed();
      if (this.started) await this.monitor.refresh();
      return this.statusWithHealth();
    });
  }

  public async clearFailed(): Promise<CatalogAutoImportStatus> {
    return this.serialize(async () => {
      this.assertOpen();
      await this.synchronizeAuthority();
      await this.controller.clearFailed();
      return this.statusWithHealth();
    });
  }

  public async openIngress(): Promise<void> {
    await this.serialize(async () => {
      this.assertOpen();
      const state = await this.queryState();
      const authority = liveRule(state, this.catalogId);
      if (authority.rule === null) throw new Error(authority.legacy ? "Auto Import requires reconfiguration." : "Auto Import rule is not configured.");
      const rootValue = await this.resolveNativeRoot({
        catalogId: this.catalogId,
        sessionId: this.sessionId,
        rootId: authority.rule.ingressRootId,
      });
      const rootPath = nativeRootPath(rootValue, this.catalogId, authority.rule.ingressRootId);
      const target = path.resolve(rootPath, ...authority.rule.ingressRelativePath.split("/"));
      const relative = path.relative(rootPath, target);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        throw new Error("Auto Import ingress is unavailable.");
      }
      const result = await this.openPath(target);
      await this.assertCurrentSession();
      if (result.length > 0) throw new Error("Auto Import ingress could not be opened.");
    });
  }

  public async reconcile(rootId: RootId, scopes: readonly DirtyScope[]): Promise<void> {
    await this.assertCurrentSession();
    await this.monitor.reconcile(parseRootId(rootId), scopes);
  }

  public async refresh(): Promise<void> {
    await this.assertCurrentSession();
    await this.monitor.refresh();
  }

  public dispose(): void {
    void this.shutdown().catch(() => undefined);
  }

  public async shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      await this.shutdownPromise;
      return;
    }
    this.closed = true;
    this.controller.dispose();
    this.monitor.close();
    this.shutdownPromise = Promise.allSettled([
      this.monitor.waitForIdle(),
      this.serial.current,
    ]).then(() => undefined);
    await this.shutdownPromise;
  }

  private async statusWithHealth(): Promise<CatalogAutoImportStatus> {
    const status = await this.controller.status();
    return {
      ...status,
      degraded: this.monitor.hasEnumerationOverflow || this.monitor.hasEnumerationDegraded,
    };
  }

  private async synchronizeAuthority(): Promise<AuthoritySyncResult> {
    const state = await this.queryState();
    const authority = liveRule(state, this.catalogId);
    const sidecar = await this.store.load();
    const previous = sidecarRule(sidecar, this.catalogId);
    if (authority.rule === null) {
      if (sidecar.rules.length > 0 || sidecar.queue.list().length > 0 || sidecar.paused) {
        this.controller.dispose();
        await this.store.save([], new AutoImportQueue(), false);
        return { ...authority, changed: true };
      }
      return { ...authority, changed: false };
    }
    if (previous === null) {
      if (sidecar.queue.list().length > 0) this.controller.dispose();
      await this.store.save([authority.rule], emptyQueue(sidecar.paused), sidecar.paused);
      return { ...authority, changed: true };
    }
    if (sameRule(previous, authority.rule)) return { ...authority, changed: false };
    if (previous.ruleId === authority.rule.ruleId) {
      this.controller.dispose();
      await this.store.disable(previous.ruleId, this.now());
      await this.store.setRules([authority.rule]);
    } else {
      this.controller.dispose();
      await this.store.save([authority.rule], emptyQueue(sidecar.paused), sidecar.paused);
    }
    return { ...authority, changed: true };
  }

  private async applyLiveRule(rule: AutoImportRule): Promise<void> {
    for (let attempt = 0; attempt < MAX_LIVE_RETRIES; attempt += 1) {
      const state = await this.queryState();
      const current = state.rules.find((candidate) => candidate.ruleId === rule.ruleId);
      const mutation: Extract<CatalogRuleMutation, { kind: "rule-upsert" }> = {
        kind: "rule-upsert",
        ruleId: rule.ruleId,
        name: current?.name ?? AUTHORITY_RULE_NAME,
        enabled: rule.enabled,
        destinationRootId: rule.destinationRootId,
        presetId: rule.presetId,
        config: liveConfig(rule),
        createdAt: current?.createdAt ?? this.now(),
        updatedAt: this.now(),
      };
      try {
        const result = await this.applyLive({
          catalogId: this.catalogId,
          sessionId: this.sessionId,
          expectedRevision: state.catalog.revision,
          mutations: [mutation],
        });
        parseCatalogLiveApplyResult(result);
        return;
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === MAX_LIVE_RETRIES - 1) throw error;
      }
    }
    throw new Error("Auto Import configuration could not be saved.");
  }

  private async resolvePreset(catalogId: CatalogId, presetId: PresetId): Promise<unknown> {
    await this.assertCurrentSession();
    if (catalogId !== this.catalogId) throw new Error("Auto Import preset belongs to another catalog.");
    const state = await this.queryState();
    const preset = state.presets.find((candidate) => candidate.presetId === presetId);
    if (preset === undefined) throw new Error("Auto Import preset is unavailable.");
    return {
      catalogId,
      presetId,
      name: preset.name,
      revision: preset.revision,
      payload: preset.payload,
      updatedAt: preset.updatedAt,
    };
  }

  private async registerSource(input: CatalogImportExternalSourceRegistration): Promise<AssetId> {
    await this.assertCurrentSession();
    if (input.catalogId !== this.catalogId || input.sessionId !== this.sessionId) {
      throw new Error("Auto Import source belongs to another catalog session.");
    }
    const source = input.item.source;
    for (let attempt = 0; attempt < MAX_LIVE_RETRIES; attempt += 1) {
      const state = await this.queryState();
      const root = state.roots.find((candidate) => candidate.rootId === source.rootId);
      if (root === undefined) throw new Error("Auto Import source root is not active.");
      const pathAsset = state.assets.find((asset) => asset.rootId === source.rootId && asset.relativePath === source.relativePath);
      if (pathAsset !== undefined && sameObservation(pathAsset, input.observation)) return parseAssetId(pathAsset.assetId);
      if (
        pathAsset?.observation?.localFileId !== null &&
        pathAsset?.observation?.localFileId !== undefined &&
        input.observation.localFileId !== null &&
        pathAsset.observation.localFileId !== input.observation.localFileId
      ) {
        throw new Error("Auto Import source identity conflicts with the catalog.");
      }
      const observation = {
        assetId: pathAsset?.assetId,
        relativePath: source.relativePath,
        observation: observationValue(input.observation),
        health: "present" as const,
        formatId: source.formatId,
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
      };
      try {
        const result = await this.worker.liveApply({
          catalogId: this.catalogId,
          expectedRevision: state.catalog.revision,
          mutations: [{ kind: "reconcile", rootId: source.rootId, complete: false, observations: [observation] }],
          now: this.now(),
        });
        parseCatalogLiveApplyResult(result);
        const refreshed = await this.queryState();
        const registered = refreshed.assets.find((asset) => asset.rootId === source.rootId && asset.relativePath === source.relativePath);
        if (registered === undefined) throw new Error("Auto Import source registration did not persist.");
        return parseAssetId(registered.assetId);
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === MAX_LIVE_RETRIES - 1) throw error;
      }
    }
    throw new Error("Auto Import source registration failed.");
  }

  private async queryState(): Promise<CatalogLiveState> {
    await this.assertCurrentSession();
    const value = await this.worker.liveQuery({ catalogId: this.catalogId, expectedRevision: null });
    await this.assertCurrentSession();
    const state = parseCatalogLiveQueryResult(value);
    if (state.catalog.catalogId !== this.catalogId) throw new Error("Auto Import catalog identity is invalid.");
    return state;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Auto Import runtime is closed.");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.current.then(operation, operation);
    this.serial.current = next.then(() => undefined, () => undefined);
    return next;
  }
}

export function createCatalogAutoImportRuntime(
  options: CatalogAutoImportRuntimeOptions,
): CatalogAutoImportRuntime {
  return new CatalogAutoImportRuntime(options);
}
