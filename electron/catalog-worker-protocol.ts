import path from "node:path";
import {
  parseAssetId,
  parseOperationId,
  type AssetId,
  type OperationId,
} from "../lib/catalog/ids.ts";
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
  | CatalogWorkerIntegrityCheckRequest
  | CatalogWorkerCloseRequest
  | CatalogWorkerShutdownRequest
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
  | CatalogWorkerIntegrityCheckResponse
  | CatalogWorkerCloseResponse
  | CatalogWorkerShutdownResponse
  | CatalogWorkerTestTracerRunResponse
  | CatalogWorkerTestTracerRecoverResponse
  | CatalogWorkerTestTracerInspectResponse
  | CatalogWorkerError;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: RecordValue, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
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

function requiredNullableInteger(record: RecordValue, key: string): number | null {
  return record[key] === null ? null : requiredInteger(record, key);
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
    case "integrity-check":
      return { kind, requestId };
    case "close":
      return { kind, requestId };
    case "shutdown":
      return { kind, requestId };
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
