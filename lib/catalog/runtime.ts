import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "./ids.ts";

export type { AssetId, CatalogId, OperationId, RootId } from "./ids.ts";

type RuntimeBrand<Name extends string> = string & {
  readonly __brand: Name;
};

export type SessionId = RuntimeBrand<"SessionId">;
export type PathGrantId = RuntimeBrand<"PathGrantId">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SCAN_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_ASSET_HEAD_BYTES = 16 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;

function parseUuid<Name extends string>(value: unknown, name: Name): RuntimeBrand<Name> {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return value.toLowerCase() as RuntimeBrand<Name>;
}

function createUuid<Name extends string>(name: Name): RuntimeBrand<Name> {
  return parseUuid(globalThis.crypto.randomUUID(), name);
}

export function parseSessionId(value: unknown): SessionId {
  return parseUuid(value, "SessionId");
}

export function createSessionId(): SessionId {
  return createUuid("SessionId");
}

export function parsePathGrantId(value: unknown): PathGrantId {
  return parseUuid(value, "PathGrantId");
}

export function createPathGrantId(): PathGrantId {
  return createUuid("PathGrantId");
}

export type LibraryOperationStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "timed-out"
  | "failed"
  | "superseded";

export type LibraryEventKind = "scan-progress" | "scan-terminal";
export type ScanProgressPhase = "scanning" | "statting";

export interface ScanProgressPayload {
  readonly phase: ScanProgressPhase;
  readonly directoriesVisited: number;
  readonly filesConsidered: number;
  readonly acceptedCount: number;
  readonly currentPath: string;
}

export interface ScanTerminalPayload {
  readonly status: Exclude<LibraryOperationStatus, "running">;
  readonly directoriesVisited: number;
  readonly filesConsidered: number;
  readonly acceptedCount: number;
  readonly currentPath: string | null;
  readonly errorMessage?: string;
}

export type LibraryEventPayload = ScanProgressPayload | ScanTerminalPayload;

export interface LibraryEvent {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly sequence: number;
  readonly kind: LibraryEventKind;
  readonly payload: LibraryEventPayload;
}

export interface LibraryRootSummary {
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly label: string;
}

export interface LibrarySessionSnapshot {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly roots: readonly LibraryRootSummary[];
}

export interface PickerGrant {
  readonly grantId: PathGrantId;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly scope: "root";
  readonly expiresAt: number;
  readonly label: string;
}

export interface ConsumedPickerGrant {
  readonly grantId: PathGrantId;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
}

export interface LibraryOperationHandle {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly status: "running";
}

export interface LibraryOperationSnapshot {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly status: LibraryOperationStatus;
  readonly directoriesVisited: number;
  readonly filesConsidered: number;
  readonly acceptedCount: number;
  readonly currentPath: string | null;
  readonly errorMessage?: string;
}

export interface SessionSelectionInput {
  readonly catalogId: CatalogId;
}

export interface AssetRequestInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly assetId: AssetId;
}

export interface AssetHeadRequestInput extends AssetRequestInput {
  readonly maxBytes: number;
}

export interface AssetSidecarWriteRequest extends AssetRequestInput {
  readonly contents: string | null;
  readonly expectedLastModified?: number | null;
}

export interface ScanRequestInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly timeoutMs: number | undefined;
}

export interface OperationRequestInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
}

export interface PathGrantRequestInput {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly grantId: PathGrantId;
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseFiniteInteger(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

export function parseSessionSelectionInput(value: unknown): SessionSelectionInput {
  const input = recordValue(value, "Session selection");
  return { catalogId: parseCatalogId(input.catalogId) };
}

export function parseAssetRequestInput(value: unknown): AssetRequestInput {
  const input = recordValue(value, "Asset request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    assetId: parseAssetId(input.assetId),
  };
}

export function parseAssetHeadRequestInput(value: unknown): AssetHeadRequestInput {
  const input = recordValue(value, "Asset head request");
  const maxBytes = parseFiniteInteger(input.maxBytes, "maxBytes", 1);
  if (maxBytes > MAX_ASSET_HEAD_BYTES) {
    throw new Error(`maxBytes must be less than or equal to ${MAX_ASSET_HEAD_BYTES}.`);
  }
  return {
    ...parseAssetRequestInput(input),
    maxBytes,
  };
}

export function parseAssetSidecarWriteRequestInput(value: unknown): AssetSidecarWriteRequest {
  const input = recordValue(value, "Asset sidecar write request");
  const contents = input.contents;
  const expectedLastModified = input.expectedLastModified;
  if (contents !== null && (typeof contents !== "string" || new TextEncoder().encode(contents).byteLength > MAX_SIDECAR_BYTES)) {
    throw new Error("Asset sidecar contents are invalid or too large.");
  }
  if (expectedLastModified !== undefined && expectedLastModified !== null && (typeof expectedLastModified !== "number" || !Number.isFinite(expectedLastModified))) {
    throw new Error("Asset sidecar expected modification time is invalid.");
  }
  return {
    ...parseAssetRequestInput(input),
    contents,
    expectedLastModified,
  };
}

export function parseScanRequestInput(value: unknown): ScanRequestInput {
  const input = recordValue(value, "Scan request");
  const timeoutValue = input.timeoutMs;
  const timeoutMs =
    timeoutValue === undefined
      ? undefined
      : parseFiniteInteger(timeoutValue, "timeoutMs", 1);
  if (timeoutMs !== undefined && timeoutMs > MAX_SCAN_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be less than or equal to ${MAX_SCAN_TIMEOUT_MS}.`);
  }
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    rootId: parseRootId(input.rootId),
    timeoutMs,
  };
}

export function parseOperationRequestInput(value: unknown): OperationRequestInput {
  const input = recordValue(value, "Operation request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseOperationId(input.operationId),
  };
}

export function parsePathGrantRequestInput(value: unknown): PathGrantRequestInput {
  const input = recordValue(value, "Path grant request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    grantId: parsePathGrantId(input.grantId),
  };
}

export function parseRelativePath(value: unknown, name = "relativePath", allowEmpty = false): string {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${name} must be a slash-separated relative path.`);
  }
  if (value === "") {
    if (allowEmpty) return value;
    throw new Error(`${name} must not be empty.`);
  }
  if (value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) {
    throw new Error(`${name} must be relative.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${name} contains an unsafe path segment.`);
  }
  return value;
}

function parseProgressPayload(value: unknown): ScanProgressPayload {
  const payload = recordValue(value, "Scan progress payload");
  const phase = payload.phase;
  if (phase !== "scanning" && phase !== "statting") {
    throw new Error("Scan progress phase is invalid.");
  }
  return {
    phase,
    directoriesVisited: parseFiniteInteger(payload.directoriesVisited, "directoriesVisited", 0),
    filesConsidered: parseFiniteInteger(payload.filesConsidered, "filesConsidered", 0),
    acceptedCount: parseFiniteInteger(payload.acceptedCount, "acceptedCount", 0),
    currentPath: parseRelativePath(payload.currentPath, "currentPath", true),
  };
}

function parseTerminalPayload(value: unknown): ScanTerminalPayload {
  const payload = recordValue(value, "Scan terminal payload");
  const status = payload.status;
  if (
    status !== "completed" &&
    status !== "cancelled" &&
    status !== "timed-out" &&
    status !== "failed" &&
    status !== "superseded"
  ) {
    throw new Error("Scan terminal status is invalid.");
  }
  const currentPathValue = payload.currentPath;
  return {
    status,
    directoriesVisited: parseFiniteInteger(payload.directoriesVisited, "directoriesVisited", 0),
    filesConsidered: parseFiniteInteger(payload.filesConsidered, "filesConsidered", 0),
    acceptedCount: parseFiniteInteger(payload.acceptedCount, "acceptedCount", 0),
    currentPath:
      currentPathValue === null
        ? null
        : parseRelativePath(currentPathValue, "currentPath", true),
    ...(payload.errorMessage === undefined
      ? {}
      : { errorMessage: parseErrorMessage(payload.errorMessage) }),
  };
}

function parseErrorMessage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new Error("errorMessage must be a short non-empty string.");
  }
  return value;
}

export function parseLibraryEvent(value: unknown): LibraryEvent {
  const event = recordValue(value, "Library event");
  const kind = event.kind;
  if (kind !== "scan-progress" && kind !== "scan-terminal") {
    throw new Error("Library event kind is invalid.");
  }
  const sequence = parseFiniteInteger(event.sequence, "sequence", 1);
  return {
    catalogId: parseCatalogId(event.catalogId),
    sessionId: parseSessionId(event.sessionId),
    operationId: parseOperationId(event.operationId),
    sequence,
    kind,
    payload: kind === "scan-progress"
      ? parseProgressPayload(event.payload)
      : parseTerminalPayload(event.payload),
  };
}

export function assertCurrentLibraryEvent(
  value: unknown,
  expected: { readonly catalogId: CatalogId; readonly sessionId: SessionId; readonly lastSequence: number },
): LibraryEvent {
  const event = parseLibraryEvent(value);
  if (event.catalogId !== expected.catalogId || event.sessionId !== expected.sessionId) {
    throw new Error("Library event belongs to an inactive session.");
  }
  if (event.sequence <= expected.lastSequence) {
    throw new Error("Library event sequence is not monotonic.");
  }
  return event;
}

export function isSafePublicRelativePath(value: string): boolean {
  try {
    parseRelativePath(value, "path", true);
    return true;
  } catch {
    return false;
  }
}
