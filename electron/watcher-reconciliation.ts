import fs from "node:fs";
import path from "node:path";
import { createOperationId, parseCatalogId, parseRootId, type CatalogId, type OperationId, type RootId } from "../lib/catalog/ids.ts";
import { getFormatCapabilityForFileName } from "../lib/formats/index.ts";
import {
  parseRelativePath,
  parseSessionId,
  type SessionId,
} from "../lib/catalog/runtime.ts";
import {
  type CatalogWatchEvent,
  type DirtyScope,
  type ReconcileCompletedPayload,
  type ReconcileFailedPayload,
  type ReconcileStartedPayload,
  type WatchErrorCode,
  type WatchRootSnapshot,
  type WatchRootStatus,
  type WatchStatePayload,
} from "../lib/catalog/watch.ts";

export interface WatchAdapterEvent {
  readonly eventType: "rename" | "change";
  readonly filename: string | Buffer | null;
}

export interface WatchAdapterCallbacks {
  readonly onEvent: (event: WatchAdapterEvent) => void;
  readonly onError: (error: unknown) => void;
}

export interface WatchHandle {
  close(): void;
}

export interface WatchAdapter {
  open(nativePath: string, callbacks: WatchAdapterCallbacks): WatchHandle;
}

export interface WatchTimerHandle {
  readonly id: string;
}

export interface WatchTimerAdapter {
  schedule(delayMs: number, callback: () => void): WatchTimerHandle;
  cancel(handle: WatchTimerHandle): void;
}

export interface WatchRootInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly nativePath: string;
}

export interface WatchSessionInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly roots: readonly WatchRootInput[];
}

export interface WatchReconcileInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly operationId: OperationId;
  readonly scope: DirtyScope;
  readonly signal: AbortSignal;
}

export interface WatchReconcileDiff {
  readonly scope: DirtyScope;
  readonly changedCount: number;
}

export interface WatchReconcileResult {
  readonly status: "completed";
  readonly diff: WatchReconcileDiff;
}

export interface WatchReconcileCommitInput extends WatchReconcileInput {
  readonly diff: WatchReconcileDiff;
}

export interface WatchReconcileAdapter {
  reconcile(input: WatchReconcileInput): Promise<WatchReconcileResult>;
  commit(input: WatchReconcileCommitInput): Promise<void>;
}

export interface WatcherReconciliationOptions {
  readonly watchAdapter?: WatchAdapter;
  readonly timerAdapter?: WatchTimerAdapter;
  readonly reconcileAdapter: WatchReconcileAdapter;
  readonly debounceMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly maxRetryAttempts?: number;
}

interface ActiveSession {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly generation: number;
}

interface RootRuntime {
  readonly input: WatchRootInput;
  readonly generation: number;
  handle: WatchHandle | undefined;
  debounceTimer: WatchTimerHandle | undefined;
  retryTimer: WatchTimerHandle | undefined;
  reconcileController: AbortController | undefined;
  pendingScopes: DirtyScope[];
  status: WatchRootStatus;
  errorCode: WatchErrorCode | null;
  retryAttempt: number;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
const MAX_PENDING_SCOPES = 512;

class NativeWatchAdapter implements WatchAdapter {
  open(nativePath: string, callbacks: WatchAdapterCallbacks): WatchHandle {
    const watcher = fs.watch(nativePath, { recursive: true, encoding: "utf8" }, (eventType, filename) => {
      callbacks.onEvent({
        eventType,
        filename: typeof filename === "string" ? filename : null,
      });
    });
    watcher.on("error", callbacks.onError);
    return { close: () => watcher.close() };
  }
}

class NativeWatchTimerAdapter implements WatchTimerAdapter {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(delayMs: number, callback: () => void): WatchTimerHandle {
    const id = createOperationId();
    const timer = setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, delayMs);
    this.timers.set(id, timer);
    return { id };
  }

  cancel(handle: WatchTimerHandle): void {
    const timer = this.timers.get(handle.id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(handle.id);
  }
}

function recordErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code.toUpperCase() : null;
}

function classifyError(error: unknown): WatchErrorCode {
  const code = recordErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (code === "ENOSPC" || code === "OVERFLOW") return "overflow";
  return "error";
}

function validateDelay(value: number | undefined, fallback: number, name: string): number {
  const delay = value ?? fallback;
  if (!Number.isSafeInteger(delay) || delay < 0) throw new Error(`${name} must be a non-negative integer.`);
  return delay;
}

function validateAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error("maxRetryAttempts must be a non-negative integer.");
  return attempts;
}

function scopeKey(scope: DirtyScope): string {
  return scope.kind === "root" ? "" : scope.relativePath;
}

export function collapseDirtyScopes(scopes: readonly DirtyScope[]): readonly DirtyScope[] {
  if (scopes.some((scope) => scope.kind === "root")) return [{ kind: "root" }];
  const paths = [...new Set(scopes.map((scope) => scopeKey(scope)))].sort((left, right) => {
    const leftDepth = left.split("/").length;
    const rightDepth = right.split("/").length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
  const collapsed: string[] = [];
  for (const value of paths) {
    if (collapsed.some((parent) => value === parent || value.startsWith(`${parent}/`))) continue;
    collapsed.push(value);
  }
  return collapsed.map((relativePath) => ({ kind: "path", relativePath }));
}

function normalizeWatchFilename(filename: string | Buffer | null): string | null {
  if (filename === null) return "";
  const value = typeof filename === "string" ? filename : filename.toString("utf8");
  if (value.length === 0) return "";
  const normalized = path.sep === "/" ? value : value.split(path.sep).join("/");
  if (normalized.includes("\\")) return null;
  return parseRelativePath(normalized);
}

function isHiddenOrUnsupported(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => part.startsWith("."))) return true;
  const name = parts.at(-1);
  if (name === undefined) return true;
  const extension = path.posix.extname(name);
  return extension.length > 0 && getFormatCapabilityForFileName(name) === null;
}

export class WatcherReconciliationService {
  private readonly watchAdapter: WatchAdapter;
  private readonly timerAdapter: WatchTimerAdapter;
  private readonly reconcileAdapter: WatchReconcileAdapter;
  private readonly debounceMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxRetryAttempts: number;
  private readonly listeners = new Set<(event: CatalogWatchEvent) => void>();
  private readonly roots = new Map<string, RootRuntime>();
  private activeSession: ActiveSession | undefined;
  private generation = 0;
  private sequence = 0;

  constructor(options: WatcherReconciliationOptions) {
    this.watchAdapter = options.watchAdapter ?? new NativeWatchAdapter();
    this.timerAdapter = options.timerAdapter ?? new NativeWatchTimerAdapter();
    this.reconcileAdapter = options.reconcileAdapter;
    this.debounceMs = validateDelay(options.debounceMs, DEFAULT_DEBOUNCE_MS, "debounceMs");
    this.maxRetryDelayMs = validateDelay(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS, "maxRetryDelayMs");
    this.maxRetryAttempts = validateAttempts(options.maxRetryAttempts);
  }

  activateSession(input: WatchSessionInput): void {
    this.closeSession();
    const catalogId = parseCatalogId(input.catalogId);
    const sessionId = parseSessionId(input.sessionId);
    const rootIds = new Set<string>();
    const generation = ++this.generation;
    this.activeSession = { catalogId, sessionId, generation };
    this.sequence = 0;
    for (const root of input.roots) {
      if (root.catalogId !== catalogId || root.sessionId !== sessionId) {
        throw new Error("Watcher root belongs to a different session.");
      }
      const rootId = parseRootId(root.rootId);
      if (rootIds.has(rootId)) throw new Error("Watcher roots contain a duplicate root.");
      if (!path.isAbsolute(root.nativePath)) throw new Error("Watcher root path must be absolute.");
      rootIds.add(rootId);
      const runtime: RootRuntime = {
        input: { ...root, catalogId, sessionId, rootId },
        generation,
        handle: undefined,
        debounceTimer: undefined,
        retryTimer: undefined,
        reconcileController: undefined,
        pendingScopes: [],
        status: "degraded",
        errorCode: null,
        retryAttempt: 0,
      };
      this.roots.set(rootId, runtime);
      this.openRoot(runtime);
    }
  }

  closeSession(): void {
    this.generation += 1;
    for (const root of this.roots.values()) this.closeRoot(root);
    this.roots.clear();
    this.activeSession = undefined;
    this.sequence = 0;
  }

  subscribe(listener: (event: CatalogWatchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRootStates(): readonly WatchRootSnapshot[] {
    return [...this.roots.values()].map((root) => ({
      catalogId: root.input.catalogId,
      sessionId: root.input.sessionId,
      rootId: root.input.rootId,
      status: root.status,
      retryAttempt: root.retryAttempt,
      pendingScopeCount: root.pendingScopes.length,
    }));
  }

  markDirty(rootId: RootId, scope: DirtyScope): void {
    const root = this.roots.get(rootId);
    if (root === undefined || !this.isCurrent(root)) return;
    this.addScope(root, scope);
    this.scheduleDebounce(root);
  }

  private openRoot(root: RootRuntime): void {
    if (!this.isCurrent(root)) return;
    try {
      root.handle = this.watchAdapter.open(root.input.nativePath, {
        onEvent: (event) => this.handleWatchEvent(root, event),
        onError: (error) => this.handleWatchError(root, error),
      });
      root.status = "active";
      root.errorCode = null;
      root.retryAttempt = 0;
      this.emitState(root);
      if (root.pendingScopes.length > 0) this.scheduleDebounce(root);
    } catch (error) {
      this.handleWatchError(root, error);
    }
  }

  private handleWatchEvent(root: RootRuntime, event: WatchAdapterEvent): void {
    if (!this.isCurrent(root)) return;
    let normalized: string | null;
    try {
      normalized = normalizeWatchFilename(event.filename);
    } catch {
      this.handleWatchError(root, { code: "OVERFLOW" });
      return;
    }
    if (normalized === null) {
      this.handleWatchError(root, { code: "OVERFLOW" });
      return;
    }
    if (normalized !== "" && isHiddenOrUnsupported(normalized)) return;
    this.markDirty(root.input.rootId, normalized === "" ? { kind: "root" } : { kind: "path", relativePath: normalized });
  }

  private handleWatchError(root: RootRuntime, error: unknown): void {
    if (!this.isCurrent(root)) return;
    root.handle?.close();
    root.handle = undefined;
    root.errorCode = classifyError(error);
    root.status = root.errorCode === "missing"
      ? "missing"
      : root.errorCode === "permission-denied"
        ? "permission-denied"
        : "degraded";
    root.retryAttempt += 1;
    this.addScope(root, { kind: "root" });
    this.emitState(root);
    if (root.retryAttempt > this.maxRetryAttempts) return;
    this.scheduleRetry(root, () => this.openRoot(root));
  }

  private addScope(root: RootRuntime, scope: DirtyScope): void {
    const normalized = scope.kind === "root"
      ? { kind: "root" as const }
      : { kind: "path" as const, relativePath: parseRelativePath(scope.relativePath) };
    root.pendingScopes = [...collapseDirtyScopes([...root.pendingScopes, normalized])];
    if (root.pendingScopes.length > MAX_PENDING_SCOPES) root.pendingScopes = [{ kind: "root" }];
    if (root.retryTimer !== undefined) {
      this.timerAdapter.cancel(root.retryTimer);
      root.retryTimer = undefined;
    }
  }

  private scheduleDebounce(root: RootRuntime): void {
    if (!this.isCurrent(root) || root.pendingScopes.length === 0) return;
    if (root.debounceTimer !== undefined) this.timerAdapter.cancel(root.debounceTimer);
    root.debounceTimer = this.timerAdapter.schedule(this.debounceMs, () => {
      root.debounceTimer = undefined;
      void this.reconcileRoot(root);
    });
  }

  private scheduleRetry(root: RootRuntime, callback: () => void): void {
    if (!this.isCurrent(root)) return;
    if (root.retryTimer !== undefined) this.timerAdapter.cancel(root.retryTimer);
    const exponent = Math.max(0, root.retryAttempt - 1);
    const delay = Math.min(this.maxRetryDelayMs, this.debounceMs * (2 ** exponent));
    root.retryTimer = this.timerAdapter.schedule(delay, () => {
      root.retryTimer = undefined;
      callback();
    });
  }

  private async reconcileRoot(root: RootRuntime): Promise<void> {
    if (!this.isCurrent(root) || root.reconcileController !== undefined) return;
    const scopes = collapseDirtyScopes(root.pendingScopes);
    root.pendingScopes = [];
    if (scopes.length === 0) return;
    const operationId = createOperationId();
    const controller = new AbortController();
    root.reconcileController = controller;
    root.status = "reconciling";
    this.emitState(root, operationId);
    this.emit(root, operationId, "reconcile-started", { scopes } satisfies ReconcileStartedPayload);
    let changedCount = 0;
    try {
      for (const scope of scopes) {
        if (!this.isCurrent(root)) return;
        const input: WatchReconcileInput = {
          catalogId: root.input.catalogId,
          sessionId: root.input.sessionId,
          rootId: root.input.rootId,
          operationId,
          scope,
          signal: controller.signal,
        };
        const result = await this.reconcileAdapter.reconcile(input);
        if (!this.isCurrent(root) || controller.signal.aborted) return;
        if (result.status !== "completed") throw new Error("Reconcile did not complete.");
        if (!Number.isSafeInteger(result.diff.changedCount) || result.diff.changedCount < 0) {
          throw new Error("Reconcile changedCount is invalid.");
        }
        await this.reconcileAdapter.commit({ ...input, diff: result.diff });
        if (!this.isCurrent(root) || controller.signal.aborted) return;
        changedCount += result.diff.changedCount;
      }
      root.retryAttempt = 0;
      root.status = "active";
      root.errorCode = null;
      this.emit(root, operationId, "reconcile-completed", {
        scopes,
        changedCount,
      } satisfies ReconcileCompletedPayload);
      this.emitState(root, operationId);
    } catch (error) {
      if (!this.isCurrent(root) || controller.signal.aborted) return;
      root.errorCode = classifyError(error);
      root.status = root.errorCode === "missing"
        ? "missing"
        : root.errorCode === "permission-denied"
          ? "permission-denied"
          : "degraded";
      root.retryAttempt += 1;
      root.pendingScopes = [...collapseDirtyScopes([...root.pendingScopes, ...scopes])];
      this.emit(root, operationId, "reconcile-failed", {
        scopes,
        retryAttempt: root.retryAttempt,
        errorCode: root.errorCode,
      } satisfies ReconcileFailedPayload);
      this.emitState(root, operationId);
      if (root.retryAttempt <= this.maxRetryAttempts) this.scheduleRetry(root, () => void this.reconcileRoot(root));
    } finally {
      if (root.reconcileController === controller) root.reconcileController = undefined;
      if (this.isCurrent(root) && root.pendingScopes.length > 0 && root.retryTimer === undefined) {
        this.scheduleDebounce(root);
      }
    }
  }

  private closeRoot(root: RootRuntime): void {
    root.handle?.close();
    root.handle = undefined;
    if (root.debounceTimer !== undefined) this.timerAdapter.cancel(root.debounceTimer);
    if (root.retryTimer !== undefined) this.timerAdapter.cancel(root.retryTimer);
    root.debounceTimer = undefined;
    root.retryTimer = undefined;
    root.reconcileController?.abort();
    root.reconcileController = undefined;
    root.pendingScopes = [];
  }

  private isCurrent(root: RootRuntime): boolean {
    return this.activeSession?.generation === root.generation &&
      this.activeSession.catalogId === root.input.catalogId &&
      this.activeSession.sessionId === root.input.sessionId &&
      this.roots.get(root.input.rootId) === root;
  }

  private emitState(root: RootRuntime, operationId = createOperationId()): void {
    const payload: WatchStatePayload = {
      status: root.status,
      retryAttempt: root.retryAttempt,
      errorCode: root.errorCode,
    };
    this.emit(root, operationId, "watch-state", payload);
  }

  private emit(
    root: RootRuntime,
    operationId: OperationId,
    kind: CatalogWatchEvent["kind"],
    payload: CatalogWatchEvent["payload"],
  ): void {
    if (!this.isCurrent(root)) return;
    this.sequence += 1;
    const event: CatalogWatchEvent = {
      catalogId: root.input.catalogId,
      sessionId: root.input.sessionId,
      rootId: root.input.rootId,
      operationId,
      sequence: this.sequence,
      kind,
      payload,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A renderer listener cannot interrupt watcher ownership.
      }
    }
  }
}
