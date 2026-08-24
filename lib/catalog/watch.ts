import {
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "./ids.ts";
import {
  parseRelativePath,
  parseSessionId,
  type SessionId,
} from "./runtime.ts";

export type DirtyScope =
  | { readonly kind: "root" }
  | { readonly kind: "path"; readonly relativePath: string };

export type WatchRootStatus =
  | "active"
  | "reconciling"
  | "degraded"
  | "missing"
  | "permission-denied";

export type WatchErrorCode = "overflow" | "missing" | "permission-denied" | "error";

export type CatalogWatchEventKind =
  | "watch-state"
  | "reconcile-started"
  | "reconcile-completed"
  | "reconcile-failed";

export interface WatchStatePayload {
  readonly status: WatchRootStatus;
  readonly retryAttempt: number;
  readonly errorCode: WatchErrorCode | null;
}

export interface ReconcileStartedPayload {
  readonly scopes: readonly DirtyScope[];
}

export interface ReconcileCompletedPayload {
  readonly scopes: readonly DirtyScope[];
  readonly changedCount: number;
}

export interface ReconcileFailedPayload {
  readonly scopes: readonly DirtyScope[];
  readonly retryAttempt: number;
  readonly errorCode: WatchErrorCode;
}

export type CatalogWatchEventPayload =
  | WatchStatePayload
  | ReconcileStartedPayload
  | ReconcileCompletedPayload
  | ReconcileFailedPayload;

export interface CatalogWatchEvent {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly operationId: OperationId;
  readonly sequence: number;
  readonly kind: CatalogWatchEventKind;
  readonly payload: CatalogWatchEventPayload;
}

export interface WatchRootSnapshot {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly status: WatchRootStatus;
  readonly retryAttempt: number;
  readonly pendingScopeCount: number;
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

export function parseDirtyScope(value: unknown): DirtyScope {
  const input = recordValue(value, "Dirty scope");
  if (input.kind === "root") return { kind: "root" };
  if (input.kind !== "path") throw new Error("Dirty scope kind is invalid.");
  return {
    kind: "path",
    relativePath: parseRelativePath(input.relativePath),
  };
}

function parseScopes(value: unknown): readonly DirtyScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Reconcile scopes must be a non-empty array.");
  }
  return value.map(parseDirtyScope);
}

function parseErrorCode(value: unknown): WatchErrorCode {
  if (
    value !== "overflow" &&
    value !== "missing" &&
    value !== "permission-denied" &&
    value !== "error"
  ) {
    throw new Error("Watch error code is invalid.");
  }
  return value;
}

export function parseCatalogWatchEvent(value: unknown): CatalogWatchEvent {
  const input = recordValue(value, "Catalog watch event");
  const kind = input.kind;
  if (
    kind !== "watch-state" &&
    kind !== "reconcile-started" &&
    kind !== "reconcile-completed" &&
    kind !== "reconcile-failed"
  ) {
    throw new Error("Catalog watch event kind is invalid.");
  }
  const payload = recordValue(input.payload, "Catalog watch event payload");
  let parsedPayload: CatalogWatchEventPayload;
  switch (kind) {
    case "watch-state": {
      const status = payload.status;
      if (
        status !== "active" &&
        status !== "reconciling" &&
        status !== "degraded" &&
        status !== "missing" &&
        status !== "permission-denied"
      ) {
        throw new Error("Watch state is invalid.");
      }
      const errorCode = payload.errorCode === null ? null : parseErrorCode(payload.errorCode);
      parsedPayload = {
        status,
        retryAttempt: integer(payload.retryAttempt, "retryAttempt"),
        errorCode,
      };
      break;
    }
    case "reconcile-started":
      parsedPayload = { scopes: parseScopes(payload.scopes) };
      break;
    case "reconcile-completed":
      parsedPayload = {
        scopes: parseScopes(payload.scopes),
        changedCount: integer(payload.changedCount, "changedCount"),
      };
      break;
    case "reconcile-failed":
      parsedPayload = {
        scopes: parseScopes(payload.scopes),
        retryAttempt: integer(payload.retryAttempt, "retryAttempt"),
        errorCode: parseErrorCode(payload.errorCode),
      };
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported watch event: ${exhaustive}`);
    }
  }
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    rootId: parseRootId(input.rootId),
    operationId: parseOperationId(input.operationId),
    sequence: integer(input.sequence, "sequence", 1),
    kind,
    payload: parsedPayload,
  };
}
