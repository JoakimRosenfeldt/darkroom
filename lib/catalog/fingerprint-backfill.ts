import {
  parseCatalogId,
  parseOperationId,
  type CatalogId,
  type OperationId,
} from "./ids.ts";
import { parseSessionId, type SessionId } from "./runtime.ts";

export type CatalogFingerprintBackfillState =
  | "planned"
  | "running"
  | "completed"
  | "cancelled";

export interface CatalogFingerprintBackfillRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

export interface CatalogFingerprintBackfillOperationRequest
  extends CatalogFingerprintBackfillRequest {
  readonly operationId: OperationId;
}

export interface CatalogFingerprintBackfillResumeRequest
  extends CatalogFingerprintBackfillRequest {
  readonly sourceOperationId: OperationId;
}

export interface CatalogFingerprintBackfillProgress {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly state: CatalogFingerprintBackfillState;
  readonly total: number;
  readonly indexed: number;
  readonly stale: number;
  readonly remaining: number;
  readonly processed: number;
  readonly failed: number;
  readonly unchecked: number;
}

const BACKFILL_STATES: readonly CatalogFingerprintBackfillState[] = [
  "planned",
  "running",
  "completed",
  "cancelled",
];

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

export function parseCatalogFingerprintBackfillRequest(
  value: unknown,
): CatalogFingerprintBackfillRequest {
  const input = record(value, "Fingerprint backfill request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
  };
}

export function parseCatalogFingerprintBackfillOperationRequest(
  value: unknown,
): CatalogFingerprintBackfillOperationRequest {
  const input = record(value, "Fingerprint backfill operation request");
  return {
    ...parseCatalogFingerprintBackfillRequest(input),
    operationId: parseOperationId(input.operationId),
  };
}

export function parseCatalogFingerprintBackfillResumeRequest(
  value: unknown,
): CatalogFingerprintBackfillResumeRequest {
  const input = record(value, "Fingerprint backfill resume request");
  return {
    ...parseCatalogFingerprintBackfillRequest(input),
    sourceOperationId: parseOperationId(input.sourceOperationId),
  };
}

export function parseCatalogFingerprintBackfillProgress(
  value: unknown,
): CatalogFingerprintBackfillProgress {
  const input = record(value, "Fingerprint backfill progress");
  const state = BACKFILL_STATES.find((candidate) => candidate === input.state);
  if (state === undefined) throw new Error("Fingerprint backfill state is invalid.");
  const progress: CatalogFingerprintBackfillProgress = {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
    state,
    total: nonNegativeInteger(input.total, "Fingerprint backfill total"),
    indexed: nonNegativeInteger(input.indexed, "Fingerprint backfill indexed count"),
    stale: nonNegativeInteger(input.stale, "Fingerprint backfill stale count"),
    remaining: nonNegativeInteger(input.remaining, "Fingerprint backfill remaining count"),
    processed: nonNegativeInteger(input.processed, "Fingerprint backfill processed count"),
    failed: nonNegativeInteger(input.failed, "Fingerprint backfill failed count"),
    unchecked: nonNegativeInteger(input.unchecked, "Fingerprint backfill unchecked count"),
  };
  if (
    progress.processed + progress.remaining !== progress.total ||
    progress.indexed + progress.stale + progress.failed + progress.unchecked !== progress.processed
  ) {
    throw new Error("Fingerprint backfill progress counts are inconsistent.");
  }
  return progress;
}
