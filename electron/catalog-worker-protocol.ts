import path from "node:path";
import {
  parseAssetId,
  parseCatalogId,
  parseEntryId,
  parseOperationId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import {
  CATALOG_V3_APPLICATION_ID,
  CATALOG_V3_MAX_XMP_BYTES,
  CATALOG_V3_SCHEMA_VERSION,
  parseCatalogV3AlbumAssetPageInput,
  parseCatalogV3AlbumPageInput,
  parseCatalogV3AssetBatchInput,
  parseCatalogV3AssetCursor,
  parseCatalogV3AssetPageInput,
  parseCatalogV3InstallInput,
  parseCatalogV3RelationsBatchInput,
  type CatalogV3ActivationResult,
  type CatalogV3AlbumAssetPage,
  type CatalogV3AlbumAssetPageInput,
  type CatalogV3AlbumAssetSnapshot,
  type CatalogV3AlbumPageInput,
  type CatalogV3AlbumSnapshot,
  type CatalogV3AlbumSnapshotResult,
  type CatalogV3AssetBatchInput,
  type CatalogV3AssetBatchResult,
  type CatalogV3AssetMetadata,
  type CatalogV3AssetPage,
  type CatalogV3AssetPageInput,
  type CatalogV3AssetSnapshot,
  type CatalogV3Counts,
  type CatalogV3ExpectedCounts,
  type CatalogV3FinishCopyResult,
  type CatalogV3FingerprintCoverage,
  type CatalogV3InstallInput,
  type CatalogV3InstallResult,
  type CatalogV3IntegrityResult,
  type CatalogV3MigrationInput,
  type CatalogV3RelationsBatchInput,
  type CatalogV3RelationsBatchResult,
  type CatalogV3RootInput,
  type CatalogV3SealForInstallResult,
  type CatalogV3Summary,
  type CatalogV3ValidationResult,
} from "../lib/catalog/v3.ts";
import {
  parseCatalogLiveApplyInput,
  parseCatalogLiveApplyResult,
  parseCatalogLiveCreateInput,
  parseCatalogLiveQueryInput,
  parseCatalogLiveQueryResult,
  type CatalogLiveApplyInput,
  type CatalogLiveApplyResult,
  type CatalogLiveCreateInput,
  type CatalogLiveQueryInput,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import {
  parseDevelopHistoryCommitInput,
  parseDevelopHistoryCommitResult,
  parseDevelopHistoryListInput,
  parseDevelopHistoryLoadInput,
  parseDevelopHistoryLoadedRevision,
  parseDevelopHistoryRef,
  parseDevelopHistoryRefMutationInput,
  parseDevelopHistoryRevision,
  type DevelopHistoryCommitInput,
  type DevelopHistoryCommitResult,
  type DevelopHistoryListInput,
  type DevelopHistoryLoadInput,
  type DevelopHistoryLoadedRevision,
  type DevelopHistoryRef,
  type DevelopHistoryRefMutationInput,
  type DevelopHistoryRevision,
} from "../lib/develop/history.ts";
import {
  parseCatalogFaultPoint,
  parseCatalogFaultStage,
  type CatalogFaultPoint,
  type CatalogFaultStage,
} from "./catalog-fault-injection.ts";

export type CatalogWorkerErrorCode =
  | "protocol"
  | "runtime"
  | "timeout"
  | "not-open"
  | "already-open"
  | "test-disabled"
  | "injected-fault"
  | "shutdown";

export interface CatalogWorkerRuntimeInfo {
  readonly kind: "runtime-info";
  readonly requestId: string;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly workerThreadId: number;
}

export interface CatalogWorkerOpenRequest {
  readonly kind: "open";
  readonly requestId: string;
  readonly databasePath: string;
}

export interface CatalogWorkerOpenResponse {
  readonly kind: "open";
  readonly requestId: string;
  readonly databasePath: string;
  readonly created: boolean;
}

export interface CatalogWorkerTransactionProbeRequest {
  readonly kind: "transaction-probe";
  readonly requestId: string;
}

export interface CatalogWorkerTransactionProbeResponse {
  readonly kind: "transaction-probe";
  readonly requestId: string;
  readonly committed: boolean;
  readonly rowCount: number;
}

export interface CatalogWorkerBackupRequest {
  readonly kind: "backup";
  readonly requestId: string;
  readonly destinationPath: string;
}

export interface CatalogWorkerBackupResponse {
  readonly kind: "backup";
  readonly requestId: string;
  readonly destinationPath: string;
  readonly pages: number;
}

export interface CatalogWorkerVacuumIntoRequest {
  readonly kind: "vacuum-into";
  readonly requestId: string;
  readonly destinationPath: string;
}

export interface CatalogWorkerVacuumIntoResponse {
  readonly kind: "vacuum-into";
  readonly requestId: string;
  readonly destinationPath: string;
  readonly byteLength: number;
}

export interface CatalogWorkerCloneCatalogRequest {
  readonly kind: "clone-catalog";
  readonly requestId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly appVersion: string;
}

export interface CatalogWorkerCloneCatalogResponse {
  readonly kind: "clone-catalog";
  readonly requestId: string;
  readonly sourceCatalogId: CatalogId;
  readonly catalogId: CatalogId;
  readonly rootCount: number;
  readonly assetCount: number;
}

export interface CatalogWorkerIntegrityCheckRequest {
  readonly kind: "integrity-check";
  readonly requestId: string;
}

export interface CatalogForeignKeyViolation {
  readonly table: string;
  readonly rowId: number | null;
  readonly parent: string;
  readonly foreignKeyIndex: number;
}

export interface CatalogWorkerIntegrityCheckResponse {
  readonly kind: "integrity-check";
  readonly requestId: string;
  readonly integrityCheck: readonly string[];
  readonly foreignKeyCheck: readonly CatalogForeignKeyViolation[];
}

export interface CatalogWorkerCloseRequest {
  readonly kind: "close";
  readonly requestId: string;
}

export interface CatalogWorkerCloseResponse {
  readonly kind: "close";
  readonly requestId: string;
  readonly wasOpen: boolean;
}

export interface CatalogWorkerShutdownRequest {
  readonly kind: "shutdown";
  readonly requestId: string;
}

export interface CatalogWorkerShutdownResponse {
  readonly kind: "shutdown";
  readonly requestId: string;
  readonly wasOpen: boolean;
}

export interface CatalogWorkerCatalogV3InstallRequest {
  readonly kind: "v3-install";
  readonly requestId: string;
  readonly input: CatalogV3InstallInput;
}

export interface CatalogWorkerCatalogV3InstallResponse {
  readonly kind: "v3-install";
  readonly requestId: string;
  readonly result: CatalogV3InstallResult;
}

export interface CatalogWorkerCatalogV3AssetBatchRequest {
  readonly kind: "v3-assets";
  readonly requestId: string;
  readonly input: CatalogV3AssetBatchInput;
}

export interface CatalogWorkerCatalogV3AssetBatchResponse {
  readonly kind: "v3-assets";
  readonly requestId: string;
  readonly result: CatalogV3AssetBatchResult;
}

export interface CatalogWorkerCatalogV3RelationsBatchRequest {
  readonly kind: "v3-relations";
  readonly requestId: string;
  readonly input: CatalogV3RelationsBatchInput;
}

export interface CatalogWorkerCatalogV3RelationsBatchResponse {
  readonly kind: "v3-relations";
  readonly requestId: string;
  readonly result: CatalogV3RelationsBatchResult;
}

export interface CatalogWorkerCatalogV3FinishCopyRequest {
  readonly kind: "v3-finish-copy";
  readonly requestId: string;
  readonly catalogId: CatalogId;
  readonly migrationId: string;
}

export interface CatalogWorkerCatalogV3FinishCopyResponse {
  readonly kind: "v3-finish-copy";
  readonly requestId: string;
  readonly result: CatalogV3FinishCopyResult;
}

export interface CatalogWorkerCatalogV3ValidateRequest {
  readonly kind: "v3-validate";
  readonly requestId: string;
  readonly catalogId: CatalogId;
  readonly migrationId: string;
}

export interface CatalogWorkerCatalogV3ValidateResponse {
  readonly kind: "v3-validate";
  readonly requestId: string;
  readonly result: CatalogV3ValidationResult;
}

export interface CatalogWorkerCatalogV3PrepareActivationRequest {
  readonly kind: "v3-prepare-activation";
  readonly requestId: string;
  readonly catalogId: CatalogId;
  readonly migrationId: string;
}

export interface CatalogWorkerCatalogV3PrepareActivationResponse {
  readonly kind: "v3-prepare-activation";
  readonly requestId: string;
  readonly result: CatalogV3ActivationResult;
}

export interface CatalogWorkerCatalogV3SealForInstallRequest {
  readonly kind: "v3-seal-for-install";
  readonly requestId: string;
  readonly catalogId: CatalogId;
  readonly migrationId: string;
}

export interface CatalogWorkerCatalogV3SealForInstallResponse {
  readonly kind: "v3-seal-for-install";
  readonly requestId: string;
  readonly result: CatalogV3SealForInstallResult;
}

export interface CatalogWorkerCatalogV3SummaryRequest {
  readonly kind: "v3-summary";
  readonly requestId: string;
  readonly catalogId: CatalogId;
}

export interface CatalogWorkerCatalogV3SummaryResponse {
  readonly kind: "v3-summary";
  readonly requestId: string;
  readonly result: CatalogV3Summary;
}

export interface CatalogWorkerCatalogV3AssetPageRequest {
  readonly kind: "v3-assets-page";
  readonly requestId: string;
  readonly input: CatalogV3AssetPageInput;
}

export interface CatalogWorkerCatalogV3AssetPageResponse {
  readonly kind: "v3-assets-page";
  readonly requestId: string;
  readonly result: CatalogV3AssetPage;
}

export interface CatalogWorkerCatalogV3AlbumSnapshotsRequest {
  readonly kind: "v3-albums";
  readonly requestId: string;
  readonly input: CatalogV3AlbumPageInput;
}

export interface CatalogWorkerCatalogV3AlbumSnapshotsResponse {
  readonly kind: "v3-albums";
  readonly requestId: string;
  readonly result: CatalogV3AlbumSnapshotResult;
}

export interface CatalogWorkerCatalogV3AlbumAssetPageRequest {
  readonly kind: "v3-album-assets-page";
  readonly requestId: string;
  readonly input: CatalogV3AlbumAssetPageInput;
}

export interface CatalogWorkerCatalogV3AlbumAssetPageResponse {
  readonly kind: "v3-album-assets-page";
  readonly requestId: string;
  readonly result: CatalogV3AlbumAssetPage;
}

export interface CatalogWorkerCatalogLiveCreateRequest {
  readonly kind: "live-create";
  readonly requestId: string;
  readonly input: CatalogLiveCreateInput;
}

export interface CatalogWorkerCatalogLiveCreateResponse {
  readonly kind: "live-create";
  readonly requestId: string;
  readonly result: CatalogLiveApplyResult;
}

export interface CatalogWorkerCatalogLiveQueryRequest {
  readonly kind: "live-query";
  readonly requestId: string;
  readonly input: CatalogLiveQueryInput;
}

export interface CatalogWorkerCatalogLiveQueryResponse {
  readonly kind: "live-query";
  readonly requestId: string;
  readonly result: CatalogLiveState;
}

export interface CatalogWorkerCatalogLiveApplyRequest {
  readonly kind: "live-apply";
  readonly requestId: string;
  readonly input: CatalogLiveApplyInput;
}

export interface CatalogWorkerCatalogLiveApplyResponse {
  readonly kind: "live-apply";
  readonly requestId: string;
  readonly result: CatalogLiveApplyResult;
}

export interface CatalogWorkerDevelopHistoryLoadRequest { readonly kind: "develop-history-load"; readonly requestId: string; readonly input: DevelopHistoryLoadInput }
export interface CatalogWorkerDevelopHistoryLoadResponse { readonly kind: "develop-history-load"; readonly requestId: string; readonly result: DevelopHistoryLoadedRevision }
export interface CatalogWorkerDevelopHistoryListRequest { readonly kind: "develop-history-list"; readonly requestId: string; readonly input: DevelopHistoryListInput }
export interface CatalogWorkerDevelopHistoryListResponse { readonly kind: "develop-history-list"; readonly requestId: string; readonly result: readonly DevelopHistoryRevision[] }
export interface CatalogWorkerDevelopHistoryCommitRequest { readonly kind: "develop-history-commit"; readonly requestId: string; readonly input: DevelopHistoryCommitInput }
export interface CatalogWorkerDevelopHistoryCommitResponse { readonly kind: "develop-history-commit"; readonly requestId: string; readonly result: DevelopHistoryCommitResult }
export interface CatalogWorkerDevelopHistoryRefsRequest { readonly kind: "develop-history-refs"; readonly requestId: string; readonly catalogId: CatalogId; readonly entryId: ReturnType<typeof parseEntryId> }
export interface CatalogWorkerDevelopHistoryRefsResponse { readonly kind: "develop-history-refs"; readonly requestId: string; readonly result: readonly DevelopHistoryRef[] }
export interface CatalogWorkerDevelopHistoryRefMutateRequest { readonly kind: "develop-history-ref-mutate"; readonly requestId: string; readonly input: DevelopHistoryRefMutationInput }
export interface CatalogWorkerDevelopHistoryRefMutateResponse { readonly kind: "develop-history-ref-mutate"; readonly requestId: string; readonly result: readonly DevelopHistoryRef[] }

export interface CatalogWorkerTestTracerRunRequest {
  readonly kind: "test-tracer-run";
  readonly requestId: string;
  readonly operationId: OperationId;
  readonly itemId: AssetId;
  readonly sourcePath: string;
  readonly destinationPath: string;
}

export interface CatalogWorkerTestTracerRunResponse {
  readonly kind: "test-tracer-run";
  readonly requestId: string;
  readonly stage: CatalogFaultStage;
  readonly catalogRowCount: number;
}

export interface CatalogWorkerTestTracerRecoverRequest {
  readonly kind: "test-tracer-recover";
  readonly requestId: string;
  readonly operationId: OperationId;
  readonly itemId: AssetId;
}

export interface CatalogWorkerTestTracerRecoverResponse {
  readonly kind: "test-tracer-recover";
  readonly requestId: string;
  readonly stage: CatalogFaultStage;
  readonly catalogRowCount: number;
}

export interface CatalogWorkerTestTracerInspectRequest {
  readonly kind: "test-tracer-inspect";
  readonly requestId: string;
  readonly operationId: OperationId;
  readonly itemId: AssetId;
}

export interface CatalogWorkerTestTracerInspectResponse {
  readonly kind: "test-tracer-inspect";
  readonly requestId: string;
  readonly stage: CatalogFaultStage;
  readonly catalogRowCount: number;
}

export type CatalogWorkerRequest =
  | CatalogWorkerRuntimeInfoRequest
  | CatalogWorkerOpenRequest
  | CatalogWorkerTransactionProbeRequest
  | CatalogWorkerBackupRequest
  | CatalogWorkerVacuumIntoRequest
  | CatalogWorkerCloneCatalogRequest
  | CatalogWorkerIntegrityCheckRequest
  | CatalogWorkerCloseRequest
  | CatalogWorkerShutdownRequest
  | CatalogWorkerCatalogV3InstallRequest
  | CatalogWorkerCatalogV3AssetBatchRequest
  | CatalogWorkerCatalogV3RelationsBatchRequest
  | CatalogWorkerCatalogV3FinishCopyRequest
  | CatalogWorkerCatalogV3ValidateRequest
  | CatalogWorkerCatalogV3PrepareActivationRequest
  | CatalogWorkerCatalogV3SealForInstallRequest
  | CatalogWorkerCatalogV3SummaryRequest
  | CatalogWorkerCatalogV3AssetPageRequest
  | CatalogWorkerCatalogV3AlbumSnapshotsRequest
  | CatalogWorkerCatalogV3AlbumAssetPageRequest
  | CatalogWorkerCatalogLiveCreateRequest
  | CatalogWorkerCatalogLiveQueryRequest
  | CatalogWorkerCatalogLiveApplyRequest
  | CatalogWorkerDevelopHistoryLoadRequest
  | CatalogWorkerDevelopHistoryListRequest
  | CatalogWorkerDevelopHistoryCommitRequest
  | CatalogWorkerDevelopHistoryRefsRequest
  | CatalogWorkerDevelopHistoryRefMutateRequest
  | CatalogWorkerTestTracerRunRequest
  | CatalogWorkerTestTracerRecoverRequest
  | CatalogWorkerTestTracerInspectRequest;

export interface CatalogWorkerRuntimeInfoRequest {
  readonly kind: "runtime-info";
  readonly requestId: string;
}

export type CatalogWorkerNonInjectedErrorCode = Exclude<
  CatalogWorkerErrorCode,
  "injected-fault"
>;

export interface CatalogWorkerErrorResponseBase {
  readonly kind: "error";
  readonly requestId: string | null;
  readonly message: string;
}

export interface CatalogWorkerErrorResponse extends CatalogWorkerErrorResponseBase {
  readonly code: CatalogWorkerNonInjectedErrorCode;
}

export interface CatalogWorkerInjectedFaultResponse extends CatalogWorkerErrorResponseBase {
  readonly code: "injected-fault";
  readonly faultPoint: CatalogFaultPoint;
}

export type CatalogWorkerError =
  | CatalogWorkerErrorResponse
  | CatalogWorkerInjectedFaultResponse;

export type CatalogWorkerResponse =
  | CatalogWorkerRuntimeInfo
  | CatalogWorkerOpenResponse
  | CatalogWorkerTransactionProbeResponse
  | CatalogWorkerBackupResponse
  | CatalogWorkerVacuumIntoResponse
  | CatalogWorkerCloneCatalogResponse
  | CatalogWorkerIntegrityCheckResponse
  | CatalogWorkerCloseResponse
  | CatalogWorkerShutdownResponse
  | CatalogWorkerCatalogV3InstallResponse
  | CatalogWorkerCatalogV3AssetBatchResponse
  | CatalogWorkerCatalogV3RelationsBatchResponse
  | CatalogWorkerCatalogV3FinishCopyResponse
  | CatalogWorkerCatalogV3ValidateResponse
  | CatalogWorkerCatalogV3PrepareActivationResponse
  | CatalogWorkerCatalogV3SealForInstallResponse
  | CatalogWorkerCatalogV3SummaryResponse
  | CatalogWorkerCatalogV3AssetPageResponse
  | CatalogWorkerCatalogV3AlbumSnapshotsResponse
  | CatalogWorkerCatalogV3AlbumAssetPageResponse
  | CatalogWorkerCatalogLiveCreateResponse
  | CatalogWorkerCatalogLiveQueryResponse
  | CatalogWorkerCatalogLiveApplyResponse
  | CatalogWorkerDevelopHistoryLoadResponse
  | CatalogWorkerDevelopHistoryListResponse
  | CatalogWorkerDevelopHistoryCommitResponse
  | CatalogWorkerDevelopHistoryRefsResponse
  | CatalogWorkerDevelopHistoryRefMutateResponse
  | CatalogWorkerTestTracerRunResponse
  | CatalogWorkerTestTracerRecoverResponse
  | CatalogWorkerTestTracerInspectResponse
  | CatalogWorkerError;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) {
    throw new Error(`Catalog worker ${label} is invalid.`);
  }
  return value;
}

function requiredString(record: RecordValue, key: string, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredBoundedString(record: RecordValue, key: string, maximum: number): string {
  const value = requiredString(record, key);
  if (value.length > maximum || value.includes("\u0000")) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredNullableString(record: RecordValue, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredAbsolutePath(record: RecordValue, key: string): string {
  const value = requiredString(record, key);
  if (!path.isAbsolute(value) || value !== path.normalize(value)) {
    throw new Error(`Catalog worker ${key} must be a normalized absolute path.`);
  }
  return value;
}

function requiredNonRootAbsolutePath(record: RecordValue, key: string): string {
  const value = requiredAbsolutePath(record, key);
  if (value === path.parse(value).root) {
    throw new Error(`Catalog worker ${key} must be a non-root absolute path.`);
  }
  return value;
}

function requiredRequestId(record: RecordValue): string {
  return requiredString(record, "requestId");
}

function requiredNumber(record: RecordValue, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredInteger(record: RecordValue, key: string): number {
  const value = requiredNumber(record, key);
  if (!Number.isInteger(value)) {
    throw new Error(`Catalog worker ${key} must be an integer.`);
  }
  return value;
}

function requiredNonnegativeInteger(record: RecordValue, key: string): number {
  const value = requiredInteger(record, key);
  if (value < 0) {
    throw new Error(`Catalog worker ${key} must be a nonnegative integer.`);
  }
  return value;
}

function requiredNullableInteger(record: RecordValue, key: string): number | null {
  return record[key] === null ? null : requiredInteger(record, key);
}

function requiredNullableNonnegativeInteger(record: RecordValue, key: string): number | null {
  return record[key] === null ? null : requiredNonnegativeInteger(record, key);
}

function requiredNullableNumber(record: RecordValue, key: string): number | null {
  return record[key] === null ? null : requiredNumber(record, key);
}

function requiredBoolean(record: RecordValue, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredStringArray(record: RecordValue, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredCatalogId(record: RecordValue, key = "catalogId"): CatalogId {
  return parseCatalogId(record[key]);
}

function requiredUuid(value: unknown, key: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
    value !== value.toLowerCase()
  ) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredMigrationId(record: RecordValue, key = "migrationId"): string {
  return requiredUuid(record[key], key);
}

function requiredHash(value: unknown, key: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredNullableHash(record: RecordValue, key: string): string | null {
  const value = record[key];
  return value === null ? null : requiredHash(value, key);
}

function requiredEnum<T extends string>(value: unknown, key: string, values: readonly T[]): T {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return match;
}

function requiredNullableEnum<T extends string>(
  value: unknown,
  key: string,
  values: readonly T[],
): T | null {
  return value === null ? null : requiredEnum(value, key, values);
}

function requiredRelativePath(value: unknown, key: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.includes("\\")
  ) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredJsonText(value: unknown, key: string, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string") {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`Catalog worker ${key} is invalid.`);
  }
  return value;
}

function requiredRating(value: unknown, key: string): 0 | 1 | 2 | 3 | 4 | 5 {
  const rating = typeof value === "number" && Number.isInteger(value) ? value : null;
  switch (rating) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return rating;
    default:
      throw new Error(`Catalog worker ${key} is invalid.`);
  }
}

function requiredV3Result(record: RecordValue): RecordValue {
  const result = record.result;
  const parsed = requiredRecord(result, "v3 result");
  requiredCatalogId(parsed);
  const revision = parsed.revision;
  if (revision !== undefined && (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0)) {
    throw new Error("Catalog worker v3 result revision is invalid.");
  }
  return parsed;
}

function parseExpectedCounts(value: unknown, key: string): CatalogV3ExpectedCounts {
  const record = requiredRecord(value, key);
  return {
    assets: requiredNonnegativeInteger(record, "assets"),
    metadata: requiredNonnegativeInteger(record, "metadata"),
    albums: requiredNonnegativeInteger(record, "albums"),
    albumAssets: requiredNonnegativeInteger(record, "albumAssets"),
    archived: requiredNonnegativeInteger(record, "archived"),
    aliases: requiredNonnegativeInteger(record, "aliases"),
    fingerprints: requiredNonnegativeInteger(record, "fingerprints"),
    present: requiredNonnegativeInteger(record, "present"),
    missing: requiredNonnegativeInteger(record, "missing"),
  };
}

function parseCounts(value: unknown): CatalogV3Counts {
  const record = requiredRecord(value, "counts");
  return {
    ...parseExpectedCounts(record, "counts"),
    ambiguous: requiredNonnegativeInteger(record, "ambiguous"),
    unreadable: requiredNonnegativeInteger(record, "unreadable"),
  };
}

function parseFingerprintCoverage(value: unknown): CatalogV3FingerprintCoverage {
  const record = requiredRecord(value, "fingerprintCoverage");
  const coverage = {
    total: requiredNonnegativeInteger(record, "total"),
    missing: requiredNonnegativeInteger(record, "missing"),
    hashing: requiredNonnegativeInteger(record, "hashing"),
    valid: requiredNonnegativeInteger(record, "valid"),
    stale: requiredNonnegativeInteger(record, "stale"),
    failed: requiredNonnegativeInteger(record, "failed"),
  };
  if (coverage.total !== coverage.missing + coverage.hashing + coverage.valid + coverage.stale + coverage.failed) {
    throw new Error("Catalog worker fingerprint coverage is inconsistent.");
  }
  return coverage;
}

function parseIntegrity(value: unknown): CatalogV3IntegrityResult {
  const record = requiredRecord(value, "integrity");
  const foreignKeyCheckValue = record.foreignKeyCheck;
  if (!Array.isArray(foreignKeyCheckValue)) {
    throw new Error("Catalog worker foreignKeyCheck is invalid.");
  }
  return {
    integrityCheck: requiredStringArray(record, "integrityCheck"),
    foreignKeyCheck: foreignKeyCheckValue.map((item) => {
      const violation = requiredRecord(item, "foreign-key result");
      return {
        table: requiredString(violation, "table"),
        rowId: requiredNullableNonnegativeInteger(violation, "rowId"),
        parent: requiredString(violation, "parent"),
        foreignKeyIndex: requiredNonnegativeInteger(violation, "foreignKeyIndex"),
      };
    }),
  };
}

function parseMetadata(value: unknown): CatalogV3AssetMetadata {
  const record = requiredRecord(value, "metadata");
  const rawXmp = requiredNullableString(record, "rawXmp");
  if (rawXmp !== null && new TextEncoder().encode(rawXmp).byteLength > CATALOG_V3_MAX_XMP_BYTES) {
    throw new Error("Catalog worker rawXmp is too large.");
  }
  const xmpState = requiredEnum(record.xmpState, "xmpState", ["unknown", "absent", "preserved", "malformed"] as const);
  if ((xmpState === "preserved") !== (rawXmp !== null)) {
    throw new Error("Catalog worker XMP state is inconsistent.");
  }
  const keywordsJson = requiredJsonText(record.keywordsJson, "keywordsJson", false);
  if (keywordsJson === null || !Array.isArray(JSON.parse(keywordsJson))) {
    throw new Error("Catalog worker keywordsJson is invalid.");
  }
  return {
    archive: requiredBoolean(record, "archive"),
    pick: requiredEnum(record.pick, "pick", ["none", "pick", "reject"] as const),
    rating: requiredRating(record.rating, "rating"),
    colorLabel: requiredNullableEnum(record.colorLabel, "colorLabel", ["red", "yellow", "green", "blue", "purple"] as const),
    developJson: requiredJsonText(record.developJson, "developJson", true),
    developUpdatedAt: requiredNumber(record, "developUpdatedAt"),
    updatedAt: requiredNumber(record, "updatedAt"),
    title: requiredNullableString(record, "title"),
    caption: requiredNullableString(record, "caption"),
    copyright: requiredNullableString(record, "copyright"),
    keywordsJson,
    rawXmp,
    xmpState,
    xmpMtime: requiredNullableNumber(record, "xmpMtime"),
    xmpSha256: requiredNullableHash(record, "xmpSha256"),
  };
}

function parseObservation(value: unknown): CatalogV3AssetSnapshot["observation"] {
  if (value === null) return null;
  const record = requiredRecord(value, "observation");
  return {
    byteLength: requiredNullableNonnegativeInteger(record, "byteLength"),
    modifiedAt: requiredNullableNumber(record, "modifiedAt"),
    observedAt: requiredNumber(record, "observedAt"),
    localFileId: requiredNullableString(record, "localFileId"),
  };
}

function parseAssetSnapshot(value: unknown): CatalogV3AssetSnapshot {
  const record = requiredRecord(value, "asset snapshot");
  const observation = parseObservation(record.observation);
  const health = requiredEnum(record.health, "health", ["present", "missing", "ambiguous", "unreadable"] as const);
  if ((health === "present") !== (observation !== null)) {
    throw new Error("Catalog worker asset health and observation are inconsistent.");
  }
  const fingerprintStatus = requiredEnum(record.fingerprintStatus, "fingerprintStatus", ["missing", "hashing", "valid", "stale", "failed"] as const);
  const fingerprintSha256 = requiredNullableHash(record, "fingerprintSha256");
  if (fingerprintStatus === "valid" && fingerprintSha256 === null) {
    throw new Error("Catalog worker valid fingerprint needs sha256.");
  }
  if (fingerprintStatus !== "valid" && fingerprintSha256 !== null) {
    throw new Error("Catalog worker non-valid fingerprint cannot have sha256.");
  }
  return {
    catalogId: requiredCatalogId(record),
    assetId: parseAssetId(record.assetId),
    rootId: parseRootId(record.rootId),
    relativePath: requiredRelativePath(record.relativePath, "relativePath"),
    observation,
    revision: requiredNonnegativeInteger(record, "revision"),
    health,
    formatId: requiredNullableString(record, "formatId"),
    cameraMake: requiredNullableString(record, "cameraMake"),
    cameraModel: requiredNullableString(record, "cameraModel"),
    lensModel: requiredNullableString(record, "lensModel"),
    fingerprintId: parseAssetId(record.fingerprintId),
    fingerprintStatus,
    fingerprintSha256,
    fingerprintObservedAt: requiredNullableNumber(record, "fingerprintObservedAt"),
    fingerprintObservedByteLength: requiredNullableNonnegativeInteger(record, "fingerprintObservedByteLength"),
    fingerprintObservedModifiedAt: requiredNullableNumber(record, "fingerprintObservedModifiedAt"),
    fingerprintLocalFileId: requiredNullableString(record, "fingerprintLocalFileId"),
    metadata: parseMetadata(record.metadata),
  };
}

function parseMigration(value: unknown): CatalogV3MigrationInput {
  const record = requiredRecord(value, "migration");
  const settingsPath = requiredNullableString(record, "settingsPath");
  const settingsSha256 = requiredNullableHash(record, "settingsSha256");
  if ((settingsPath === null) !== (settingsSha256 === null)) {
    throw new Error("Catalog worker settings path and hash must be paired.");
  }
  const sourceVersion = record.sourceVersion;
  if (sourceVersion !== 1 && sourceVersion !== 2) {
    throw new Error("Catalog worker sourceVersion is invalid.");
  }
  return {
    migrationId: requiredMigrationId(record),
    sourceVersion,
    catalogPath: requiredAbsolutePath(record, "catalogPath"),
    settingsPath: settingsPath === null ? null : requiredAbsolutePath({ settingsPath }, "settingsPath"),
    catalogSha256: requiredHash(record.catalogSha256, "catalogSha256"),
    settingsSha256,
    rootAvailable: requiredBoolean(record, "rootAvailable"),
    expectedCounts: parseExpectedCounts(record.expectedCounts, "expectedCounts"),
    expectedStateSha256: requiredHash(record.expectedStateSha256, "expectedStateSha256"),
  };
}

function parseRoot(value: unknown): CatalogV3RootInput {
  const record = requiredRecord(value, "root");
  const canonicalPath = requiredNullableString(record, "canonicalPath");
  const health = requiredEnum(record.health, "health", ["online", "missing", "ambiguous", "unreadable"] as const);
  if (health === "online" && canonicalPath === null) {
    throw new Error("Catalog worker online root needs canonicalPath.");
  }
  return {
    rootId: parseRootId(record.rootId),
    label: requiredString(record, "label"),
    configuredPath: requiredAbsolutePath(record, "configuredPath"),
    canonicalPath: canonicalPath === null ? null : requiredAbsolutePath({ canonicalPath }, "canonicalPath"),
    health,
    scanState: requiredEnum(record.scanState, "scanState", ["unknown", "complete", "partial", "failed"] as const),
    watchState: requiredEnum(record.watchState, "watchState", ["disabled", "active", "error"] as const),
  };
}

function parseValidationReport(value: unknown): CatalogV3ValidationResult["report"] {
  const record = requiredRecord(value, "validation report");
  const relationFailuresValue = requiredRecord(record.relationFailures, "relationFailures");
  const report = {
    catalogId: requiredCatalogId(record),
    migrationId: requiredMigrationId(record),
    clean: requiredBoolean(record, "clean"),
    before: parseExpectedCounts(record.before, "before"),
    after: parseCounts(record.after),
    fingerprintCoverage: parseFingerprintCoverage(record.fingerprintCoverage),
    expectedStateSha256: requiredHash(record.expectedStateSha256, "expectedStateSha256"),
    actualStateSha256: requiredHash(record.actualStateSha256, "actualStateSha256"),
    relationFailures: {
      aliases: requiredNonnegativeInteger(relationFailuresValue, "aliases"),
      albums: requiredNonnegativeInteger(relationFailuresValue, "albums"),
      albumAssets: requiredNonnegativeInteger(relationFailuresValue, "albumAssets"),
      archived: requiredNonnegativeInteger(relationFailuresValue, "archived"),
    },
    integrity: parseIntegrity(record.integrity),
    applicationId: requiredNonnegativeInteger(record, "applicationId"),
    schemaVersion: requiredNonnegativeInteger(record, "schemaVersion"),
    userVersion: requiredNonnegativeInteger(record, "userVersion"),
    limitations: requiredStringArray(record, "limitations"),
    blockingErrors: requiredStringArray(record, "blockingErrors"),
  };
  if (report.schemaVersion !== CATALOG_V3_SCHEMA_VERSION) {
    throw new Error("Catalog worker validation schemaVersion is invalid.");
  }
  if (report.applicationId !== CATALOG_V3_APPLICATION_ID || report.userVersion !== CATALOG_V3_SCHEMA_VERSION) {
    throw new Error("Catalog worker validation database identity is invalid.");
  }
  if (
    report.after.assets !== report.after.present + report.after.missing + report.after.ambiguous + report.after.unreadable ||
    report.fingerprintCoverage.total !== report.after.fingerprints
  ) {
    throw new Error("Catalog worker validation totals are inconsistent.");
  }
  if (report.clean) {
    const countKeys: readonly (keyof CatalogV3ExpectedCounts)[] = [
      "assets",
      "metadata",
      "albums",
      "albumAssets",
      "archived",
      "aliases",
      "fingerprints",
      "present",
      "missing",
    ];
    if (
      countKeys.some((key) => report.before[key] !== report.after[key]) ||
      report.expectedStateSha256 !== report.actualStateSha256 ||
      report.fingerprintCoverage.missing !== report.after.assets ||
      report.fingerprintCoverage.hashing !== 0 ||
      report.fingerprintCoverage.valid !== 0 ||
      report.fingerprintCoverage.stale !== 0 ||
      report.fingerprintCoverage.failed !== 0 ||
      Object.values(report.relationFailures).some((count) => count !== 0) ||
      report.integrity.integrityCheck.length !== 1 ||
      report.integrity.integrityCheck[0] !== "ok" ||
      report.integrity.foreignKeyCheck.length !== 0 ||
      report.blockingErrors.length !== 0
    ) {
      throw new Error("Catalog worker clean validation report is inconsistent.");
    }
  } else if (report.blockingErrors.length === 0) {
    throw new Error("Catalog worker failed validation report needs a blocking error.");
  }
  return report;
}

function parseAssetMapping(value: unknown): CatalogV3AssetBatchResult["assets"][number] {
  const record = requiredRecord(value, "asset mapping");
  return {
    legacyIds: requiredStringArray(record, "legacyIds"),
    relativePath: requiredRelativePath(record.relativePath, "relativePath"),
    assetId: parseAssetId(record.assetId),
    fingerprintId: parseAssetId(record.fingerprintId),
  };
}

function parseCatalogV3InstallResult(value: RecordValue): CatalogV3InstallResult {
  const schemaVersion = requiredInteger(value, "schemaVersion");
  if (schemaVersion !== CATALOG_V3_SCHEMA_VERSION) {
    throw new Error("Catalog worker install schemaVersion is invalid.");
  }
  return {
    catalogId: requiredCatalogId(value),
    migrationId: requiredMigrationId(value),
    created: requiredBoolean(value, "created"),
    installState: requiredEnum(value.installState, "installState", ["staging", "ready"] as const),
    revision: requiredNonnegativeInteger(value, "revision"),
    schemaVersion,
  };
}

function parseCatalogV3AssetBatchResult(value: RecordValue): CatalogV3AssetBatchResult {
  const assetsValue = value.assets;
  if (!Array.isArray(assetsValue)) throw new Error("Catalog worker asset result assets is invalid.");
  return {
    catalogId: requiredCatalogId(value),
    migrationId: requiredMigrationId(value),
    revision: requiredNonnegativeInteger(value, "revision"),
    assets: assetsValue.map(parseAssetMapping),
  };
}

function parseCatalogV3RelationsBatchResult(value: RecordValue): CatalogV3RelationsBatchResult {
  return {
    catalogId: requiredCatalogId(value),
    migrationId: requiredMigrationId(value),
    revision: requiredNonnegativeInteger(value, "revision"),
    albums: requiredNonnegativeInteger(value, "albums"),
    albumAssets: requiredNonnegativeInteger(value, "albumAssets"),
    archived: requiredNonnegativeInteger(value, "archived"),
  };
}

function parseCatalogV3FinishCopyResult(value: RecordValue): CatalogV3FinishCopyResult {
  if (value.phase !== "copied") {
    throw new Error("Catalog worker finish phase is invalid.");
  }
  return {
    catalogId: requiredCatalogId(value),
    migrationId: requiredMigrationId(value),
    phase: "copied",
    revision: requiredNonnegativeInteger(value, "revision"),
  };
}

function parseCatalogV3ValidationResult(value: RecordValue): CatalogV3ValidationResult {
  const catalogId = requiredCatalogId(value);
  const migrationId = requiredMigrationId(value);
  const report = parseValidationReport(value.report);
  if (report.catalogId !== catalogId || report.migrationId !== migrationId) {
    throw new Error("Catalog worker validation report identity does not match its result.");
  }
  const phase = requiredEnum(value.phase, "phase", ["created", "copying-assets", "copying-relations", "copied", "validating", "validated", "failed"] as const);
  if ((phase === "validated") !== report.clean || (!report.clean && phase !== "failed")) {
    throw new Error("Catalog worker validation phase does not match its report.");
  }
  return {
    catalogId,
    migrationId,
    phase,
    report,
    revision: requiredNonnegativeInteger(value, "revision"),
  };
}

function parseCatalogV3ActivationResult(value: RecordValue): CatalogV3ActivationResult {
  if (value.installState !== "ready") {
    throw new Error("Catalog worker activation installState is invalid.");
  }
  return {
    catalogId: requiredCatalogId(value),
    migrationId: requiredMigrationId(value),
    installState: "ready",
    revision: requiredNonnegativeInteger(value, "revision"),
  };
}

function parseCatalogV3SealForInstallResult(value: RecordValue): CatalogV3SealForInstallResult {
  const busy = requiredNonnegativeInteger(value, "busy");
  if (busy !== 0) throw new Error("Catalog worker seal busy is invalid.");
  return {
    catalogId: requiredCatalogId(value),
    migrationId: requiredMigrationId(value),
    busy,
    logFrames: requiredNonnegativeInteger(value, "logFrames"),
    checkpointedFrames: requiredNonnegativeInteger(value, "checkpointedFrames"),
    journalMode: value.journalMode === "delete" ? "delete" : (() => {
      throw new Error("Catalog worker journalMode is invalid.");
    })(),
  };
}

function parseCatalogV3Summary(value: RecordValue): CatalogV3Summary {
  const catalogId = requiredCatalogId(value);
  const migrationId = requiredMigrationId(value);
  const migration = parseMigration(value.migration);
  if (migration.migrationId !== migrationId || migration.sourceVersion !== value.sourceVersion) {
    throw new Error("Catalog worker summary migration identity does not match its result.");
  }
  const root = parseRoot(value.root);
  const counts = parseCounts(value.counts);
  const fingerprintCoverage = parseFingerprintCoverage(value.fingerprintCoverage);
  if (
    migration.rootAvailable !== (root.health === "online") ||
    counts.assets !== counts.present + counts.missing + counts.ambiguous + counts.unreadable ||
    fingerprintCoverage.total !== counts.fingerprints
  ) {
    throw new Error("Catalog worker summary totals are inconsistent.");
  }
  return {
    catalogId,
    displayName: requiredString(value, "displayName"),
    appVersion: requiredString(value, "appVersion"),
    installState: requiredEnum(value.installState, "installState", ["staging", "ready"] as const),
    revision: requiredNonnegativeInteger(value, "revision"),
    migrationId,
    migrationPhase: requiredEnum(value.migrationPhase, "migrationPhase", ["created", "copying-assets", "copying-relations", "copied", "validating", "validated", "failed"] as const),
    sourceVersion: value.sourceVersion === 1 || value.sourceVersion === 2 ? value.sourceVersion : (() => {
      throw new Error("Catalog worker sourceVersion is invalid.");
    })(),
    migration,
    root,
    counts,
    fingerprintCoverage,
  };
}

function parseCatalogV3AssetPage(value: RecordValue): CatalogV3AssetPage {
  const catalogId = requiredCatalogId(value);
  const assetsValue = value.assets;
  if (!Array.isArray(assetsValue)) throw new Error("Catalog worker asset page assets is invalid.");
  const assets = assetsValue.map(parseAssetSnapshot);
  if (assets.some((asset) => asset.catalogId !== catalogId)) {
    throw new Error("Catalog worker asset page asset identity does not match its result.");
  }
  const nextCursor = value.nextCursor === null ? null : parseCatalogV3AssetCursor(value.nextCursor);
  return {
    catalogId,
    revision: requiredNonnegativeInteger(value, "revision"),
    assets,
    nextCursor,
  };
}

function parseCatalogV3AlbumSnapshot(value: unknown): CatalogV3AlbumSnapshot {
  const record = requiredRecord(value, "album snapshot");
  return {
    catalogId: requiredCatalogId(record),
    id: requiredString(record, "id"),
    name: requiredString(record, "name", true),
    createdAt: requiredNumber(record, "createdAt"),
    updatedAt: requiredNumber(record, "updatedAt"),
    position: requiredNonnegativeInteger(record, "position"),
  };
}

function parseCatalogV3Albums(value: RecordValue): CatalogV3AlbumSnapshotResult {
  const catalogId = requiredCatalogId(value);
  const albumsValue = value.albums;
  if (!Array.isArray(albumsValue)) throw new Error("Catalog worker album result albums is invalid.");
  const albums = albumsValue.map(parseCatalogV3AlbumSnapshot);
  if (albums.some((album) => album.catalogId !== catalogId)) {
    throw new Error("Catalog worker album identity does not match its result.");
  }
  if (albums.some((album, index) => index > 0 && album.position !== albums[index - 1]!.position + 1)) {
    throw new Error("Catalog worker album positions are inconsistent.");
  }
  const nextCursor = requiredNullableNonnegativeInteger(value, "nextCursor");
  if (nextCursor !== null && nextCursor !== albums.at(-1)?.position) {
    throw new Error("Catalog worker album cursor is inconsistent.");
  }
  return {
    catalogId,
    revision: requiredNonnegativeInteger(value, "revision"),
    albums,
    nextCursor,
  };
}

function parseCatalogV3AlbumAssetPage(value: RecordValue): CatalogV3AlbumAssetPage {
  const catalogId = requiredCatalogId(value);
  const albumId = requiredString(value, "albumId");
  const assetsValue = value.assets;
  if (!Array.isArray(assetsValue)) throw new Error("Catalog worker album asset page assets is invalid.");
  const assets: CatalogV3AlbumAssetSnapshot[] = assetsValue.map((item) => {
    const member = requiredRecord(item, "album member");
    return {
      position: requiredNonnegativeInteger(member, "position"),
      assetId: parseAssetId(member.assetId),
      rootId: parseRootId(member.rootId),
      relativePath: requiredRelativePath(member.relativePath, "relativePath"),
      health: requiredEnum(member.health, "health", ["present", "missing", "ambiguous", "unreadable"] as const),
      revision: requiredNonnegativeInteger(member, "revision"),
    };
  });
  if (assets.some((asset, index) => index > 0 && asset.position !== assets[index - 1]!.position + 1)) {
    throw new Error("Catalog worker album asset positions are inconsistent.");
  }
  const nextCursor = requiredNullableNonnegativeInteger(value, "nextCursor");
  if (nextCursor !== null && nextCursor !== assets.at(-1)?.position) {
    throw new Error("Catalog worker album asset cursor is inconsistent.");
  }
  return {
    catalogId,
    albumId,
    revision: requiredNonnegativeInteger(value, "revision"),
    assets,
    nextCursor,
  };
}

function parseForeignKeyViolation(value: unknown): CatalogForeignKeyViolation {
  if (!isRecord(value)) {
    throw new Error("Catalog worker foreign-key result is invalid.");
  }
  return {
    table: requiredString(value, "table"),
    rowId: requiredNullableInteger(value, "rowId"),
    parent: requiredString(value, "parent"),
    foreignKeyIndex: requiredInteger(value, "foreignKeyIndex"),
  };
}

function parseRequestRecord(record: RecordValue): CatalogWorkerRequest {
  const kind = record.kind;
  if (typeof kind !== "string") {
    throw new Error("Catalog worker request kind is invalid.");
  }
  const requestId = requiredRequestId(record);
  switch (kind) {
    case "runtime-info":
      return { kind, requestId };
    case "open":
      return { kind, requestId, databasePath: requiredAbsolutePath(record, "databasePath") };
    case "transaction-probe":
      return { kind, requestId };
    case "backup":
      return { kind, requestId, destinationPath: requiredAbsolutePath(record, "destinationPath") };
    case "vacuum-into":
      return { kind, requestId, destinationPath: requiredNonRootAbsolutePath(record, "destinationPath") };
    case "clone-catalog":
      return {
        kind,
        requestId,
        sourcePath: requiredNonRootAbsolutePath(record, "sourcePath"),
        destinationPath: requiredNonRootAbsolutePath(record, "destinationPath"),
        catalogId: requiredCatalogId(record),
        displayName: requiredBoundedString(record, "displayName", 512),
        appVersion: requiredBoundedString(record, "appVersion", 256),
      };
    case "integrity-check":
      return { kind, requestId };
    case "close":
      return { kind, requestId };
    case "shutdown":
      return { kind, requestId };
    case "v3-install":
      return { kind, requestId, input: parseCatalogV3InstallInput(record.input) };
    case "v3-assets":
      return { kind, requestId, input: parseCatalogV3AssetBatchInput(record.input) };
    case "v3-relations":
      return { kind, requestId, input: parseCatalogV3RelationsBatchInput(record.input) };
    case "v3-finish-copy":
      return {
        kind,
        requestId,
        catalogId: requiredCatalogId(record),
        migrationId: requiredMigrationId(record),
      };
    case "v3-validate":
      return {
        kind,
        requestId,
        catalogId: requiredCatalogId(record),
        migrationId: requiredMigrationId(record),
      };
    case "v3-prepare-activation":
      return {
        kind,
        requestId,
        catalogId: requiredCatalogId(record),
        migrationId: requiredMigrationId(record),
      };
    case "v3-seal-for-install":
      return {
        kind,
        requestId,
        catalogId: requiredCatalogId(record),
        migrationId: requiredMigrationId(record),
      };
    case "v3-summary":
      return { kind, requestId, catalogId: requiredCatalogId(record) };
    case "v3-assets-page":
      return { kind, requestId, input: parseCatalogV3AssetPageInput(record.input) };
    case "v3-albums":
      return { kind, requestId, input: parseCatalogV3AlbumPageInput(record.input) };
    case "v3-album-assets-page":
      return { kind, requestId, input: parseCatalogV3AlbumAssetPageInput(record.input) };
    case "live-create":
      return { kind, requestId, input: parseCatalogLiveCreateInput(record.input) };
    case "live-query":
      return { kind, requestId, input: parseCatalogLiveQueryInput(record.input) };
    case "live-apply":
      return { kind, requestId, input: parseCatalogLiveApplyInput(record.input) };
    case "develop-history-load":
      return { kind, requestId, input: parseDevelopHistoryLoadInput(record.input) };
    case "develop-history-list":
      return { kind, requestId, input: parseDevelopHistoryListInput(record.input) };
    case "develop-history-commit":
      return { kind, requestId, input: parseDevelopHistoryCommitInput(record.input) };
    case "develop-history-refs":
      return { kind, requestId, catalogId: requiredCatalogId(record), entryId: parseEntryId(record.entryId) };
    case "develop-history-ref-mutate":
      return { kind, requestId, input: parseDevelopHistoryRefMutationInput(record.input) };
    case "test-tracer-run":
      return {
        kind,
        requestId,
        operationId: parseOperationId(record.operationId),
        itemId: parseAssetId(record.itemId),
        sourcePath: requiredAbsolutePath(record, "sourcePath"),
        destinationPath: requiredAbsolutePath(record, "destinationPath"),
      };
    case "test-tracer-recover":
      return {
        kind,
        requestId,
        operationId: parseOperationId(record.operationId),
        itemId: parseAssetId(record.itemId),
      };
    case "test-tracer-inspect":
      return {
        kind,
        requestId,
        operationId: parseOperationId(record.operationId),
        itemId: parseAssetId(record.itemId),
      };
    default:
      throw new Error(`Unknown catalog worker request kind: ${kind}.`);
  }
}

export function parseCatalogWorkerRequest(value: unknown): CatalogWorkerRequest {
  if (!isRecord(value)) {
    throw new Error("Catalog worker request must be an object.");
  }
  return parseRequestRecord(value);
}

export function isCatalogWorkerRequest(value: unknown): value is CatalogWorkerRequest {
  try {
    parseCatalogWorkerRequest(value);
    return true;
  } catch {
    return false;
  }
}

function parseResponseRecord(record: RecordValue): CatalogWorkerResponse {
  const kind = record.kind;
  if (typeof kind !== "string") {
    throw new Error("Catalog worker response kind is invalid.");
  }
  const requestValue = record.requestId;
  if (requestValue !== null && typeof requestValue !== "string") {
    throw new Error("Catalog worker response requestId is invalid.");
  }
  const requestId = requestValue;
  switch (kind) {
    case "runtime-info":
      if (requestId === null) throw new Error("Runtime info response needs a requestId.");
      return {
        kind,
        requestId,
        nodeVersion: requiredString(record, "nodeVersion"),
        sqliteVersion: requiredString(record, "sqliteVersion"),
        workerThreadId: requiredInteger(record, "workerThreadId"),
      };
    case "open":
      if (requestId === null) throw new Error("Open response needs a requestId.");
      return {
        kind,
        requestId,
        databasePath: requiredAbsolutePath(record, "databasePath"),
        created: requiredBoolean(record, "created"),
      };
    case "transaction-probe":
      if (requestId === null) throw new Error("Transaction response needs a requestId.");
      return {
        kind,
        requestId,
        committed: requiredBoolean(record, "committed"),
        rowCount: requiredInteger(record, "rowCount"),
      };
    case "backup":
      if (requestId === null) throw new Error("Backup response needs a requestId.");
      return {
        kind,
        requestId,
        destinationPath: requiredAbsolutePath(record, "destinationPath"),
        pages: requiredInteger(record, "pages"),
      };
    case "vacuum-into":
      if (requestId === null) throw new Error("Vacuum response needs a requestId.");
      return {
        kind,
        requestId,
        destinationPath: requiredNonRootAbsolutePath(record, "destinationPath"),
        byteLength: requiredNonnegativeInteger(record, "byteLength"),
      };
    case "clone-catalog":
      if (requestId === null) throw new Error("Clone response needs a requestId.");
      return {
        kind,
        requestId,
        sourceCatalogId: requiredCatalogId(record, "sourceCatalogId"),
        catalogId: requiredCatalogId(record),
        rootCount: requiredNonnegativeInteger(record, "rootCount"),
        assetCount: requiredNonnegativeInteger(record, "assetCount"),
      };
    case "integrity-check":
      if (requestId === null) throw new Error("Integrity response needs a requestId.");
      {
        const foreignKeyValue = record.foreignKeyCheck;
        if (!Array.isArray(foreignKeyValue)) {
          throw new Error("Catalog worker foreignKeyCheck is invalid.");
        }
        return {
          kind,
          requestId,
          integrityCheck: requiredStringArray(record, "integrityCheck"),
          foreignKeyCheck: foreignKeyValue.map(parseForeignKeyViolation),
        };
      }
    case "close":
      if (requestId === null) throw new Error("Close response needs a requestId.");
      return { kind, requestId, wasOpen: requiredBoolean(record, "wasOpen") };
    case "shutdown":
      if (requestId === null) throw new Error("Shutdown response needs a requestId.");
      return { kind, requestId, wasOpen: requiredBoolean(record, "wasOpen") };
    case "v3-install":
      if (requestId === null) throw new Error("Catalog v3 install response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3InstallResult(requiredV3Result(record)) };
    case "v3-assets":
      if (requestId === null) throw new Error("Catalog v3 asset response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3AssetBatchResult(requiredV3Result(record)) };
    case "v3-relations":
      if (requestId === null) throw new Error("Catalog v3 relation response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3RelationsBatchResult(requiredV3Result(record)) };
    case "v3-finish-copy":
      if (requestId === null) throw new Error("Catalog v3 finish response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3FinishCopyResult(requiredV3Result(record)) };
    case "v3-validate":
      if (requestId === null) throw new Error("Catalog v3 validate response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3ValidationResult(requiredV3Result(record)) };
    case "v3-prepare-activation":
      if (requestId === null) throw new Error("Catalog v3 activation response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3ActivationResult(requiredV3Result(record)) };
    case "v3-seal-for-install":
      if (requestId === null) throw new Error("Catalog v3 seal response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3SealForInstallResult(requiredV3Result(record)) };
    case "v3-summary":
      if (requestId === null) throw new Error("Catalog v3 summary response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3Summary(requiredV3Result(record)) };
    case "v3-assets-page":
      if (requestId === null) throw new Error("Catalog v3 asset page response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3AssetPage(requiredV3Result(record)) };
    case "v3-albums":
      if (requestId === null) throw new Error("Catalog v3 album response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3Albums(requiredV3Result(record)) };
    case "v3-album-assets-page":
      if (requestId === null) throw new Error("Catalog v3 album asset response needs a requestId.");
      return { kind, requestId, result: parseCatalogV3AlbumAssetPage(requiredV3Result(record)) };
    case "live-create":
      if (requestId === null) throw new Error("Catalog live create response needs a requestId.");
      return { kind, requestId, result: parseCatalogLiveApplyResult(requiredRecord(record.result, "live create result")) };
    case "live-query":
      if (requestId === null) throw new Error("Catalog live query response needs a requestId.");
      return { kind, requestId, result: parseCatalogLiveQueryResult(requiredRecord(record.result, "live query result")) };
    case "live-apply":
      if (requestId === null) throw new Error("Catalog live apply response needs a requestId.");
      return { kind, requestId, result: parseCatalogLiveApplyResult(requiredRecord(record.result, "live apply result")) };
    case "develop-history-load":
      if (requestId === null) throw new Error("Develop history load response needs a requestId.");
      return { kind, requestId, result: parseDevelopHistoryLoadedRevision(record.result) };
    case "develop-history-list":
      if (requestId === null || !Array.isArray(record.result)) throw new Error("Develop history list response is invalid.");
      return { kind, requestId, result: record.result.map(parseDevelopHistoryRevision) };
    case "develop-history-commit":
      if (requestId === null) throw new Error("Develop history commit response needs a requestId.");
      return { kind, requestId, result: parseDevelopHistoryCommitResult(record.result) };
    case "develop-history-refs":
    case "develop-history-ref-mutate":
      if (requestId === null || !Array.isArray(record.result)) throw new Error("Develop history refs response is invalid.");
      return { kind, requestId, result: record.result.map(parseDevelopHistoryRef) };
    case "test-tracer-run":
    case "test-tracer-recover":
    case "test-tracer-inspect":
      if (requestId === null) throw new Error("Tracer response needs a requestId.");
      return {
        kind,
        requestId,
        stage: parseCatalogFaultStage(record.stage),
        catalogRowCount: requiredInteger(record, "catalogRowCount"),
      };
    case "error": {
      const code = record.code;
      if (code === "injected-fault") {
        return {
          kind,
          requestId,
          code,
          message: requiredString(record, "message"),
          faultPoint: parseCatalogFaultPoint(record.faultPoint),
        };
      }
      if (
        code !== "protocol" &&
        code !== "runtime" &&
        code !== "timeout" &&
        code !== "not-open" &&
        code !== "already-open" &&
        code !== "test-disabled" &&
        code !== "shutdown"
      ) {
        throw new Error("Catalog worker error code is invalid.");
      }
      return { kind, requestId, code, message: requiredString(record, "message") };
    }
    default:
      throw new Error(`Unknown catalog worker response kind: ${kind}.`);
  }
}

export function parseCatalogWorkerResponse(value: unknown): CatalogWorkerResponse {
  if (!isRecord(value)) {
    throw new Error("Catalog worker response must be an object.");
  }
  return parseResponseRecord(value);
}

export function isCatalogWorkerResponse(value: unknown): value is CatalogWorkerResponse {
  try {
    parseCatalogWorkerResponse(value);
    return true;
  } catch {
    return false;
  }
}
