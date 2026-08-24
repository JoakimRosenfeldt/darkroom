import {
  parseCatalogId,
  parseRootId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "./ids.ts";
import {
  parseSessionId,
  type SessionId,
} from "./runtime.ts";

export const CATALOG_ADMIN_MAX_BLOCKING_ERRORS = 64;
export const CATALOG_ADMIN_MAX_ROOTS = 10_000;
export const CATALOG_ADMIN_MAX_BACKUP_RETENTION = 100;
export const CATALOG_ADMIN_MIN_INTERVAL_MS = 60_000;
export const CATALOG_ADMIN_MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;

export interface CatalogAdminRootView {
  readonly rootId: RootId;
  readonly label: string;
}

export interface CatalogAdminCatalogIdentity {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly appVersion: string;
  readonly schemaVersion: 3;
}

export interface CatalogAdminCounts {
  readonly assets: number;
  readonly metadata: number;
  readonly albums: number;
  readonly albumAssets: number;
  readonly fingerprints: number;
  readonly presets: number;
  readonly rules: number;
  readonly operations: number;
  readonly operationItems: number;
  readonly aliases: number;
  readonly auditEntries: number;
  readonly archived: number;
  readonly present: number;
  readonly missing: number;
  readonly ambiguous: number;
  readonly unreadable: number;
}

export interface CatalogAdminOrphanCounts {
  readonly assetMetadata: number;
  readonly fingerprints: number;
  readonly albums: number;
  readonly albumAssets: number;
  readonly presets: number;
  readonly rules: number;
  readonly operations: number;
  readonly operationItems: number;
  readonly aliases: number;
  readonly auditEntries: number;
  readonly archived: number;
  readonly albumPositions: number;
  readonly albumAssetPositions: number;
}

export interface CatalogAdminIntegrityReport {
  readonly integrityCheck: readonly string[];
  readonly foreignKeyViolationCount: number;
}

export interface CatalogAdminInspectReport {
  readonly catalogId: CatalogId | null;
  readonly schemaVersion: number | null;
  readonly applicationId: number | null;
  readonly userVersion: number | null;
  readonly clean: boolean;
  readonly sourceByteLength: number;
  readonly sourceSha256: string;
  readonly roots: readonly CatalogAdminRootView[];
  readonly counts: CatalogAdminCounts;
  readonly orphanCounts: CatalogAdminOrphanCounts;
  readonly integrity: CatalogAdminIntegrityReport;
  readonly blockingErrors: readonly string[];
}

export type CatalogBackupSchedule =
  | { readonly kind: "off" }
  | { readonly kind: "interval"; readonly intervalMs: number };

export interface CatalogBackupPolicy {
  readonly schedule: CatalogBackupSchedule;
  readonly retentionCount: number;
}

export interface CatalogBackupPolicyState {
  readonly catalogId: CatalogId;
  readonly policy: CatalogBackupPolicy;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastFailureMessage: string | null;
}

export interface CatalogAdminBackupResult {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly createdAt: number;
  readonly sourceSha256: string;
  readonly packageSha256: string;
  readonly byteLength: number;
}

export interface CatalogAdminCloneResult {
  readonly operationId: OperationId;
  readonly sourceCatalogId: CatalogId;
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly rootCount: number;
  readonly assetCount: number;
}

export interface CatalogAdminOptimizePreview {
  readonly catalogId: CatalogId;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly provenOrphanCounts: CatalogAdminOrphanCounts;
}

export interface CatalogAdminOptimizeResult {
  readonly catalogId: CatalogId;
  readonly sourceSha256: string;
  readonly compactSha256: string;
  readonly sourceByteLength: number;
  readonly compactByteLength: number;
}

export interface CatalogAdminRestoreRequest {
  readonly catalogId: CatalogId;
  readonly sourceCatalogId: CatalogId;
  readonly mode: "open-as-new" | "merge" | "replace";
  readonly dryRunId?: string;
  readonly confirmation?: string;
}

export interface CatalogAdminRestoreResult {
  readonly status: "completed" | "recovery-required" | "failed" | "rolled-back";
  readonly stage: string;
  readonly unresolvedFactCount: number;
  readonly error: string | null;
}

export interface CatalogAdminSessionRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

export interface CatalogAdminPolicyRequest extends CatalogAdminSessionRequest {
  readonly policy: CatalogBackupPolicy;
}

export interface CatalogAdminImportRequest {
  readonly displayName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000")) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

export function parseCatalogBackupPolicy(value: unknown): CatalogBackupPolicy {
  const input = record(value, "Catalog backup policy");
  const scheduleValue = record(input.schedule, "Catalog backup schedule");
  let schedule: CatalogBackupSchedule;
  if (scheduleValue.kind === "off") {
    schedule = { kind: "off" };
  } else if (scheduleValue.kind === "interval") {
    const intervalMs = integer(scheduleValue.intervalMs, "Catalog backup interval", CATALOG_ADMIN_MIN_INTERVAL_MS);
    if (intervalMs > CATALOG_ADMIN_MAX_INTERVAL_MS) {
      throw new Error("Catalog backup interval is too large.");
    }
    schedule = { kind: "interval", intervalMs };
  } else {
    throw new Error("Catalog backup schedule kind is invalid.");
  }
  const retentionCount = integer(input.retentionCount, "Catalog backup retention", 1);
  if (retentionCount > CATALOG_ADMIN_MAX_BACKUP_RETENTION) {
    throw new Error("Catalog backup retention is too large.");
  }
  return { schedule, retentionCount };
}

export function parseCatalogAdminSessionRequest(value: unknown): CatalogAdminSessionRequest {
  const input = record(value, "Catalog administration request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
  };
}

export function parseCatalogAdminPolicyRequest(value: unknown): CatalogAdminPolicyRequest {
  const input = record(value, "Catalog administration policy request");
  return {
    ...parseCatalogAdminSessionRequest(input),
    policy: parseCatalogBackupPolicy(input.policy),
  };
}

export function parseCatalogAdminImportRequest(value: unknown): CatalogAdminImportRequest {
  const input = record(value, "Catalog import request");
  return {
    displayName: boundedString(input.displayName, "Catalog import display name", 512),
  };
}

export function parseCatalogAdminRestoreRequest(value: unknown): CatalogAdminRestoreRequest {
  const input = record(value, "Catalog restore request");
  const mode = input.mode ?? "open-as-new";
  if (mode !== "open-as-new" && mode !== "merge" && mode !== "replace") {
    throw new Error("Catalog restore mode is invalid.");
  }
  const dryRunId = input.dryRunId === undefined ? undefined : boundedString(input.dryRunId, "Catalog restore dry-run ID", 128);
  const confirmation = input.confirmation === undefined ? undefined : boundedString(input.confirmation, "Catalog restore confirmation", 256);
  return {
    catalogId: parseCatalogId(input.catalogId),
    sourceCatalogId: parseCatalogId(input.sourceCatalogId),
    mode,
    ...(dryRunId === undefined ? {} : { dryRunId }),
    ...(confirmation === undefined ? {} : { confirmation }),
  };
}

export function parseCatalogAdminCloneDisplayName(value: unknown): string {
  return boundedString(value, "Catalog clone display name", 512);
}

export function parseCatalogAdminRootView(value: unknown): CatalogAdminRootView {
  const input = record(value, "Catalog root view");
  return {
    rootId: parseRootId(input.rootId),
    label: boundedString(input.label, "Catalog root label", 512),
  };
}
