import {
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type EntryId,
  type OperationId,
  type RootId,
} from "./ids.ts";
import {
  parseAssetHeadRequestInput,
  parseAssetRequestInput,
  parseOperationRequestInput,
  parseScanRequestInput,
  parseSessionId,
  type AssetHeadRequestInput,
  type AssetRequestInput,
  type LibraryOperationHandle,
  type LibraryOperationSnapshot,
  type LibrarySessionSnapshot,
  type ScanProgressPayload,
  type ScanTerminalPayload,
  type SessionId,
} from "./runtime.ts";
import {
  parseCatalogLiveMutation,
  parseCatalogLiveQueryInput,
  type CatalogLiveAlbum,
  type CatalogLiveApplyResult,
  type CatalogLiveAutoImportConfig,
  type CatalogLiveCatalogIdentity,
  type CatalogLiveEntrySnapshot,
  type CatalogLiveFingerprintMatch,
  type CatalogLiveMutation,
  type CatalogLiveOperationItem,
  type CatalogLivePreset,
  type CatalogLiveRoot,
  type CatalogLiveState,
} from "./live.ts";
import {
  parseCatalogWatchEvent,
  type CatalogWatchEvent,
  type DirtyScope,
  type ReconcileCompletedPayload,
  type ReconcileFailedPayload,
  type ReconcileStartedPayload,
  type WatchStatePayload,
} from "./watch.ts";
import type { CatalogV3FingerprintCoverage } from "./v3.ts";

type RecordValue = Record<string, unknown>;
const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;
const MAX_DECODE_EDGE = 2_560;
const MAX_DECODE_DIMENSION = 65_535;
const MAX_DECODE_BYTES = 512 * 1024 * 1024;
const MAX_MUTATION_BYTES = 512 * 1024;
const MAX_STATE_MUTATION_BYTES = 34 * 1024 * 1024;
const MAX_MUTATION_BATCH_BYTES = 34 * 1024 * 1024;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  return value;
}

function stringValue(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > 512 || value.includes("\0")) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is invalid.`);
  return value;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

export interface CatalogSummary {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly health: "healthy" | "degraded" | "missing" | "corrupt";
  readonly lastOpenedAt: number;
}

export interface CatalogRootRef {
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly label: string;
}

export interface CatalogSession {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly roots: readonly CatalogRootRef[];
}

export interface CatalogBootstrapResult {
  readonly catalogs: readonly CatalogSummary[];
  readonly session: CatalogSession | null;
  readonly recovery: CatalogBootstrapRecovery | null;
}

export interface CatalogBootstrapRecovery {
  readonly kind: "missing" | "corrupt";
  readonly catalogId: CatalogId | null;
  readonly message: string;
}

export interface CatalogActivationResult {
  readonly catalog: CatalogSummary;
  readonly session: CatalogSession;
}

export interface CatalogCreateRequest {
  readonly displayName: string;
}

export interface CatalogSelectionRequest {
  readonly catalogId: CatalogId;
}

export interface CatalogSessionRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

export interface CatalogRootResult {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
}

export interface CatalogRootRequest extends CatalogSessionRequest {
  readonly rootId: RootId;
}

export interface CatalogRemoveRequest {
  readonly catalogId: CatalogId;
  readonly confirmation: string;
  readonly deleteFile: boolean;
}

export type CatalogOperationResult = LibraryOperationHandle;

export interface CatalogAssetStat {
  readonly size: number;
  readonly lastModified: number;
}

export interface CatalogSidecar {
  readonly contents: string;
  readonly lastModified: number;
}

export interface CatalogDecodeRequest {
  readonly kind: "nef";
  readonly mode: "preview" | "full";
  readonly maxEdge: number;
}

export interface CatalogDecodeFailure {
  readonly available: false;
  readonly code: string;
  readonly message: string;
}

export interface CatalogDecodeSuccess {
  readonly available: true;
  readonly provenance: "nikon-sdk" | "nikon-test-only";
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  readonly channels: 3;
  readonly bitDepth: 16;
  readonly byteCount: number;
  readonly pixelFormat: "rgb16le";
  readonly orientation: number;
  readonly colorSpace: "srgb";
  readonly transferFunction: "srgb";
  readonly pixels: ArrayBuffer;
}

export type CatalogDecodeResult = CatalogDecodeFailure | CatalogDecodeSuccess;

export interface CatalogSidecarWriteRequest extends CatalogAssetRequest {
  readonly contents: string | null;
  readonly expectedLastModified?: number | null;
}

export type CatalogAssetRequest = AssetRequestInput;

export type CatalogAssetHeadRequest = AssetHeadRequestInput;

export interface CatalogScanRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly timeoutMs: number | undefined;
}

export interface CatalogOperationRequest {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
}

export interface CatalogQueryRequest extends CatalogSessionRequest {
  readonly knownRevision?: number;
  readonly expectedRevision: number | null;
  readonly entryId?: EntryId;
  readonly assetId?: AssetId;
  readonly rootId?: RootId;
  readonly fingerprintSha256?: string;
}

export type CatalogApplyMutation =
  | Extract<CatalogLiveMutation, { readonly kind: "rename-catalog" }>
  | Extract<CatalogLiveMutation, { readonly kind: "edit-entry-create" }>
  | Extract<CatalogLiveMutation, { readonly kind: "edit-entry-rename" }>
  | Extract<CatalogLiveMutation, { readonly kind: "edit-entry-delete" }>
  | Extract<CatalogLiveMutation, { readonly kind: "metadata-patch" }>
  | Extract<CatalogLiveMutation, { readonly kind: "album-create" }>
  | Extract<CatalogLiveMutation, { readonly kind: "album-rename" }>
  | Extract<CatalogLiveMutation, { readonly kind: "album-delete" }>
  | Extract<CatalogLiveMutation, { readonly kind: "album-membership-replace" }>
  | Extract<CatalogLiveMutation, { readonly kind: "archive-set" }>
  | Extract<CatalogLiveMutation, { readonly kind: "library-state-replace" }>
  | Extract<CatalogLiveMutation, { readonly kind: "preset-upsert" }>
  | Extract<CatalogLiveMutation, { readonly kind: "preset-rename" }>
  | Extract<CatalogLiveMutation, { readonly kind: "preset-delete" }>
  | Extract<CatalogLiveMutation, { readonly kind: "preset-set-default" }>;

export type CatalogRuleMutation =
  | Extract<CatalogLiveMutation, { readonly kind: "rule-upsert" }>
  | Extract<CatalogLiveMutation, { readonly kind: "rule-delete" }>;

export interface CatalogApplyRequest extends CatalogSessionRequest {
  readonly expectedRevision: number;
  readonly mutations: readonly CatalogApplyMutation[];
}

export interface CatalogRuleApplyRequest extends CatalogSessionRequest {
  readonly expectedRevision: number;
  readonly mutations: readonly CatalogRuleMutation[];
}

export type CatalogLiveRootView = Omit<CatalogLiveRoot, "configuredPath" | "canonicalPath">;

export interface CatalogOperationItemView {
  readonly operationId: OperationId;
  readonly itemId: string;
  readonly assetId: AssetId | null;
  readonly state: CatalogLiveOperationItem["state"];
  readonly payload: CatalogLiveOperationItem["payload"];
}

export interface CatalogOperationView {
  readonly operationId: OperationId;
  readonly kind: string;
  readonly state: "planned" | "running" | "completed" | "failed" | "cancelled";
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly items: readonly CatalogOperationItemView[];
}

export interface CatalogPresetView {
  readonly presetId: string;
  readonly name: string;
  readonly template: CatalogLivePreset["payload"]["template"];
  readonly payload: CatalogLivePreset["payload"]["payload"];
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly isDefault: boolean;
}

export interface CatalogLiveStateView {
  readonly catalog: CatalogLiveCatalogIdentity;
  readonly roots: readonly CatalogLiveRootView[];
  readonly assets: readonly CatalogLiveEntrySnapshot[];
  readonly assetDelta?: CatalogLiveState["assetDelta"];
  readonly tombstonedEntryIds: readonly EntryId[];
  readonly albums: readonly CatalogLiveAlbum[];
  readonly operations: readonly CatalogOperationView[];
  readonly presets: readonly CatalogPresetView[];
  readonly rules: readonly {
    readonly ruleId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly destinationRootId: RootId;
    readonly presetId: string;
    readonly config: CatalogLiveAutoImportConfig;
    readonly revision: number;
    readonly createdAt: number;
    readonly updatedAt: number;
  }[];
  readonly libraryStateJson: string | null;
  readonly fingerprintCoverage: CatalogV3FingerprintCoverage;
  readonly fingerprintMatches: readonly CatalogLiveFingerprintMatch[];
}

export type CatalogApplyResult = CatalogLiveApplyResult;

export type CatalogEvent =
  | {
      readonly catalogId: CatalogId;
      readonly sessionId: SessionId;
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly kind: "scan-progress";
      readonly payload: ScanProgressPayload;
    }
  | {
      readonly catalogId: CatalogId;
      readonly sessionId: SessionId;
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly kind: "scan-terminal";
      readonly payload: ScanTerminalPayload;
    }
  | {
      readonly catalogId: CatalogId;
      readonly sessionId: SessionId;
      readonly rootId: RootId;
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly kind: "watch-state";
      readonly payload: WatchStatePayload;
    }
  | {
      readonly catalogId: CatalogId;
      readonly sessionId: SessionId;
      readonly rootId: RootId;
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly kind: "reconcile-started";
      readonly payload: ReconcileStartedPayload;
    }
  | {
      readonly catalogId: CatalogId;
      readonly sessionId: SessionId;
      readonly rootId: RootId;
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly kind: "reconcile-completed";
      readonly payload: ReconcileCompletedPayload;
    }
  | {
      readonly catalogId: CatalogId;
      readonly sessionId: SessionId;
      readonly rootId: RootId;
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly kind: "reconcile-failed";
      readonly payload: ReconcileFailedPayload;
    };

export type CatalogEventListener = (event: CatalogEvent) => void;

export function parseCatalogCreateRequest(value: unknown): CatalogCreateRequest {
  const input = record(value, "Catalog create request");
  return { displayName: stringValue(input.displayName, "displayName") };
}

export function parseCatalogSelectionRequest(value: unknown): CatalogSelectionRequest {
  const input = record(value, "Catalog selection request");
  return { catalogId: parseCatalogId(input.catalogId) };
}

export function parseCatalogSessionRequest(value: unknown): CatalogSessionRequest {
  const input = record(value, "Catalog session request");
  return { catalogId: parseCatalogId(input.catalogId), sessionId: parseSessionId(input.sessionId) };
}

export function parseCatalogRootRequest(value: unknown): CatalogRootRequest {
  const session = parseCatalogSessionRequest(value);
  const input = record(value, "Catalog root request");
  return { ...session, rootId: parseRootId(input.rootId) };
}

export function parseCatalogRemoveRequest(value: unknown): CatalogRemoveRequest {
  const input = record(value, "Catalog remove request");
  return {
    catalogId: parseCatalogId(input.catalogId),
    confirmation: stringValue(input.confirmation, "confirmation", true),
    deleteFile: booleanValue(input.deleteFile, "deleteFile"),
  };
}

export function parseCatalogAssetRequest(value: unknown): CatalogAssetRequest {
  return parseAssetRequestInput(value);
}

export function parseCatalogAssetHeadRequest(value: unknown): CatalogAssetHeadRequest {
  return parseAssetHeadRequestInput(value);
}

export function parseCatalogSidecarWriteRequest(value: unknown): CatalogSidecarWriteRequest {
  const input = record(value, "Catalog sidecar write request");
  const contents = input.contents;
  if (contents !== null && (typeof contents !== "string" || new TextEncoder().encode(contents).byteLength > MAX_SIDECAR_BYTES)) {
    throw new Error("Sidecar contents are invalid or too large.");
  }
  const expectedLastModified = input.expectedLastModified;
  if (expectedLastModified !== undefined && expectedLastModified !== null && (typeof expectedLastModified !== "number" || !Number.isFinite(expectedLastModified))) {
    throw new Error("Sidecar expected modification time is invalid.");
  }
  return { ...parseCatalogAssetRequest(input), contents, expectedLastModified };
}

export function parseCatalogDecodeRequest(value: unknown): CatalogDecodeRequest {
  const input = record(value, "Catalog decode request");
  if (input.kind !== "nef") throw new Error("Only NEF decode is supported.");
  const mode = input.mode;
  if (mode !== "preview" && mode !== "full") throw new Error("Decode mode is invalid.");
  const maxEdge = integer(input.maxEdge, "maxEdge", 1);
  if (maxEdge > MAX_DECODE_EDGE) throw new Error(`maxEdge must be less than or equal to ${MAX_DECODE_EDGE}.`);
  return { kind: "nef", mode, maxEdge };
}

export function parseCatalogScanRequest(value: unknown): CatalogScanRequest {
  return parseScanRequestInput(value);
}

export function parseCatalogOperationRequest(value: unknown): CatalogOperationRequest {
  return parseOperationRequestInput(value);
}

export function parseCatalogQueryRequest(value: unknown): CatalogQueryRequest {
  const input = record(value, "Catalog query request");
  const session = parseCatalogSessionRequest(input);
  const query = parseCatalogLiveQueryInput(input);
  return {
    ...session,
    expectedRevision: query.expectedRevision,
    ...(query.knownRevision === undefined ? {} : { knownRevision: query.knownRevision }),
    ...(query.entryId === undefined ? {} : { entryId: query.entryId }),
    ...(query.assetId === undefined ? {} : { assetId: query.assetId }),
    ...(query.rootId === undefined ? {} : { rootId: query.rootId }),
    ...(query.fingerprintSha256 === undefined ? {} : { fingerprintSha256: query.fingerprintSha256 }),
  };
}

function parsedSizedMutation(value: unknown): CatalogLiveMutation {
  const parsed = parseCatalogLiveMutation(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Catalog mutation is not serializable.");
  }
  const maximum = parsed.kind === "library-state-replace" ||
      parsed.kind === "edit-entry-create" ||
      (parsed.kind === "metadata-patch" &&
        (parsed.patch.developJson !== undefined || parsed.patch.rawXmp !== undefined))
    ? MAX_STATE_MUTATION_BYTES
    : MAX_MUTATION_BYTES;
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maximum) {
    throw new Error("Catalog mutation is too large.");
  }
  return parsed;
}

function safeMutation(value: unknown): CatalogApplyMutation {
  const parsed = parsedSizedMutation(value);
  switch (parsed.kind) {
    case "rename-catalog":
    case "edit-entry-create":
    case "edit-entry-rename":
    case "edit-entry-delete":
    case "metadata-patch":
    case "album-create":
    case "album-rename":
    case "album-delete":
    case "album-membership-replace":
    case "archive-set":
    case "library-state-replace":
    case "preset-upsert":
    case "preset-rename":
    case "preset-delete":
    case "preset-set-default":
      if (parsed.kind === "preset-upsert") {
        let payload: string;
        try {
          payload = JSON.stringify(parsed.payload);
        } catch {
          throw new Error("Preset payload is not serializable.");
        }
        if (new TextEncoder().encode(payload).byteLength > MAX_MUTATION_BYTES) {
          throw new Error("Preset payload is too large.");
        }
      }
      return parsed;
    default: {
      throw new Error(`Mutation ${parsed.kind} is not renderer-safe.`);
    }
  }
}

function safeRuleMutation(value: unknown): CatalogRuleMutation {
  const parsed = parsedSizedMutation(value);
  if (parsed.kind !== "rule-upsert" && parsed.kind !== "rule-delete") {
    throw new Error(`Mutation ${parsed.kind} is not an Auto Import rule mutation.`);
  }
  return parsed;
}

function parseApplyRequest<T extends CatalogLiveMutation>(
  value: unknown,
  mutationParser: (mutation: unknown) => T,
): CatalogSessionRequest & { readonly expectedRevision: number; readonly mutations: readonly T[] } {
  const input = record(value, "Catalog apply request");
  const session = parseCatalogSessionRequest(input);
  const expectedRevision = integer(input.expectedRevision, "expectedRevision");
  const rawMutations = array(input.mutations, "mutations");
  let serialized: string;
  try {
    serialized = JSON.stringify(rawMutations);
  } catch {
    throw new Error("Catalog mutations are not serializable.");
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_MUTATION_BATCH_BYTES) {
    throw new Error("Catalog mutation batch is too large.");
  }
  if (rawMutations.length > 250) throw new Error("Too many catalog mutations.");
  return { ...session, expectedRevision, mutations: rawMutations.map(mutationParser) };
}

export function parseCatalogApplyRequest(value: unknown): CatalogApplyRequest {
  return parseApplyRequest(value, safeMutation);
}

export function parseCatalogRuleApplyRequest(value: unknown): CatalogRuleApplyRequest {
  const parsed = parseApplyRequest(value, safeRuleMutation);
  if (parsed.mutations.length !== 1) {
    throw new Error("Auto Import rule updates require exactly one mutation.");
  }
  return parsed;
}

export function parseCatalogEvent(value: unknown): CatalogEvent {
  const input = record(value, "Catalog event");
  const kind = input.kind;
  if (kind === "scan-progress" || kind === "scan-terminal") {
    const event: {
      readonly catalogId: CatalogId;
      readonly sessionId: SessionId;
      readonly operationId: OperationId;
      readonly sequence: number;
      readonly kind: "scan-progress" | "scan-terminal";
      readonly payload: unknown;
    } = {
      catalogId: parseCatalogId(input.catalogId),
      sessionId: parseSessionId(input.sessionId),
      operationId: parseOperationId(input.operationId),
      sequence: integer(input.sequence, "sequence", 1),
      kind,
      payload: input.payload,
    };
    const parsed = kind === "scan-progress"
      ? parseLibraryProgressEvent(event)
      : parseLibraryTerminalEvent(event);
    return parsed;
  }
  if (
    kind === "watch-state" ||
    kind === "reconcile-started" ||
    kind === "reconcile-completed" ||
    kind === "reconcile-failed"
  ) {
    return parseWatchEvent(parseCatalogWatchEvent(value));
  }
  throw new Error("Catalog event kind is invalid.");
}

function parseLibraryProgressEvent(event: {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly sequence: number;
  readonly kind: "scan-progress" | "scan-terminal";
  readonly payload: unknown;
}): Extract<CatalogEvent, { kind: "scan-progress" }> {
  if (event.kind !== "scan-progress" || !isRecord(event.payload)) {
    throw new Error("Scan progress payload is invalid.");
  }
  const payload = event.payload;
  const phase = payload.phase;
  if (phase !== "scanning" && phase !== "statting") throw new Error("Scan progress phase is invalid.");
  return {
    catalogId: event.catalogId,
    sessionId: event.sessionId,
    operationId: event.operationId,
    sequence: event.sequence,
    kind: "scan-progress",
    payload: {
      phase,
      directoriesVisited: integer(payload.directoriesVisited, "directoriesVisited"),
      filesConsidered: integer(payload.filesConsidered, "filesConsidered"),
      acceptedCount: integer(payload.acceptedCount, "acceptedCount"),
      currentPath: stringValue(payload.currentPath, "currentPath", true),
    },
  };
}

function parseLibraryTerminalEvent(event: {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly operationId: OperationId;
  readonly sequence: number;
  readonly kind: "scan-progress" | "scan-terminal";
  readonly payload: unknown;
}): Extract<CatalogEvent, { kind: "scan-terminal" }> {
  if (event.kind !== "scan-terminal" || !isRecord(event.payload)) throw new Error("Scan terminal payload is invalid.");
  const payload = event.payload;
  const status = payload.status;
  if (status !== "completed" && status !== "cancelled" && status !== "timed-out" && status !== "failed" && status !== "superseded") {
    throw new Error("Scan terminal status is invalid.");
  }
  const currentPath = payload.currentPath;
  if (currentPath !== null && typeof currentPath !== "string") throw new Error("Scan terminal currentPath is invalid.");
  const errorMessage = payload.errorMessage;
  if (errorMessage !== undefined && typeof errorMessage !== "string") throw new Error("Scan terminal errorMessage is invalid.");
  return {
    catalogId: event.catalogId,
    sessionId: event.sessionId,
    operationId: event.operationId,
    sequence: event.sequence,
    kind: "scan-terminal",
    payload: {
      status,
      directoriesVisited: integer(payload.directoriesVisited, "directoriesVisited"),
      filesConsidered: integer(payload.filesConsidered, "filesConsidered"),
      acceptedCount: integer(payload.acceptedCount, "acceptedCount"),
      currentPath,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
  };
}

function parseWatchEvent(event: CatalogWatchEvent): CatalogEvent {
  const base = {
    catalogId: event.catalogId,
    sessionId: event.sessionId,
    rootId: event.rootId,
    operationId: event.operationId,
    sequence: event.sequence,
  };
  switch (event.kind) {
    case "watch-state":
      return { ...base, kind: event.kind, payload: parseWatchStatePayload(event.payload) };
    case "reconcile-started":
      return { ...base, kind: event.kind, payload: parseReconcileStartedPayload(event.payload) };
    case "reconcile-completed":
      return { ...base, kind: event.kind, payload: parseReconcileCompletedPayload(event.payload) };
    case "reconcile-failed":
      return { ...base, kind: event.kind, payload: parseReconcileFailedPayload(event.payload) };
    default: {
      const exhaustive: never = event.kind;
      throw new Error(`Unsupported catalog event: ${exhaustive}`);
    }
  }
}

function parseWatchStatePayload(value: unknown): WatchStatePayload {
  const input = record(value, "Watch state payload");
  const status = input.status;
  if (status !== "active" && status !== "reconciling" && status !== "degraded" && status !== "missing" && status !== "permission-denied") {
    throw new Error("Watch state is invalid.");
  }
  const errorCode = input.errorCode;
  if (errorCode !== null && errorCode !== "overflow" && errorCode !== "missing" && errorCode !== "permission-denied" && errorCode !== "error") {
    throw new Error("Watch error code is invalid.");
  }
  return {
    status,
    retryAttempt: integer(input.retryAttempt, "retryAttempt"),
    errorCode,
  };
}

function parseReconcileStartedPayload(value: unknown): ReconcileStartedPayload {
  const input = record(value, "Reconcile started payload");
  return { scopes: array(input.scopes, "scopes").map(parseScope) };
}

function parseReconcileCompletedPayload(value: unknown): ReconcileCompletedPayload {
  const input = record(value, "Reconcile completed payload");
  return { scopes: array(input.scopes, "scopes").map(parseScope), changedCount: integer(input.changedCount, "changedCount") };
}

function parseReconcileFailedPayload(value: unknown): ReconcileFailedPayload {
  const input = record(value, "Reconcile failed payload");
  const errorCode = input.errorCode;
  if (errorCode !== "overflow" && errorCode !== "missing" && errorCode !== "permission-denied" && errorCode !== "error") {
    throw new Error("Watch error code is invalid.");
  }
  return {
    scopes: array(input.scopes, "scopes").map(parseScope),
    retryAttempt: integer(input.retryAttempt, "retryAttempt"),
    errorCode,
  };
}

function parseScope(value: unknown): DirtyScope {
  const input = record(value, "Dirty scope");
  if (input.kind === "root") return { kind: "root" };
  if (input.kind !== "path") throw new Error("Dirty scope kind is invalid.");
  return { kind: "path", relativePath: stringValue(input.relativePath, "relativePath") };
}

export function parseCatalogDecodeResult(value: unknown): CatalogDecodeResult {
  const input = record(value, "Catalog decode result");
  if (input.available === false) {
    return {
      available: false,
      code: stringValue(input.code, "decode code"),
      message: stringValue(input.message, "decode message"),
    };
  }
  if (input.available !== true || input.version !== 1 || input.provenance !== "nikon-sdk" && input.provenance !== "nikon-test-only") {
    throw new Error("Catalog decode result is invalid.");
  }
  if (!(input.pixels instanceof ArrayBuffer)) throw new Error("Catalog decode pixels are invalid.");
  const width = integer(input.width, "decode width", 1);
  const height = integer(input.height, "decode height", 1);
  if (width > MAX_DECODE_DIMENSION || height > MAX_DECODE_DIMENSION) {
    throw new Error("Catalog decode dimensions are invalid.");
  }
  const byteCount = integer(input.byteCount, "decode byteCount");
  if (byteCount > MAX_DECODE_BYTES || input.pixels.byteLength > MAX_DECODE_BYTES) {
    throw new Error("Catalog decode output is too large.");
  }
  const expectedByteCount = width * height * 3 * 2;
  if (!Number.isSafeInteger(expectedByteCount) || byteCount !== expectedByteCount || byteCount !== input.pixels.byteLength) {
    throw new Error("Catalog decode byte count is inconsistent.");
  }
  const orientation = integer(input.orientation, "decode orientation", 1);
  if (orientation > 8) throw new Error("decode orientation is invalid.");
  return {
    available: true,
    provenance: input.provenance,
    version: 1,
    width,
    height,
    channels: input.channels === 3 ? 3 : (() => { throw new Error("decode channels are invalid."); })(),
    bitDepth: input.bitDepth === 16 ? 16 : (() => { throw new Error("decode bit depth is invalid."); })(),
    byteCount,
    pixelFormat: input.pixelFormat === "rgb16le" ? "rgb16le" : (() => { throw new Error("decode pixel format is invalid."); })(),
    orientation,
    colorSpace: input.colorSpace === "srgb" ? "srgb" : (() => { throw new Error("decode color space is invalid."); })(),
    transferFunction: input.transferFunction === "srgb" ? "srgb" : (() => { throw new Error("decode transfer function is invalid."); })(),
    pixels: input.pixels,
  };
}

export function parseCatalogSidecar(value: unknown): CatalogSidecar | null {
  if (value === null) return null;
  const input = record(value, "Catalog sidecar");
  if (typeof input.contents !== "string" || new TextEncoder().encode(input.contents).byteLength > MAX_SIDECAR_BYTES) {
    throw new Error("Sidecar contents are invalid or too large.");
  }
  return { contents: input.contents, lastModified: finiteNumber(input.lastModified, "sidecar lastModified") };
}

export function parseCatalogSession(value: unknown): CatalogSession {
  const input = record(value, "Catalog session");
  const catalogId = parseCatalogId(input.catalogId);
  const roots = array(input.roots, "Catalog session roots").map((rootValue) => {
    const root = record(rootValue, "Catalog root");
    const rootCatalogId = parseCatalogId(root.catalogId);
    if (rootCatalogId !== catalogId) throw new Error("Catalog root belongs to a different catalog.");
    return {
      catalogId: rootCatalogId,
      rootId: parseRootId(root.rootId),
      label: stringValue(root.label, "root label"),
    };
  });
  return { catalogId, sessionId: parseSessionId(input.sessionId), roots };
}

export function toCatalogSession(value: LibrarySessionSnapshot): CatalogSession {
  return parseCatalogSession(value);
}

export function parseCatalogOperationSnapshot(value: unknown): LibraryOperationSnapshot {
  const input = record(value, "Catalog operation snapshot");
  return {
    operationId: parseOperationId(input.operationId),
    catalogId: parseCatalogId(input.catalogId),
    sessionId: parseSessionId(input.sessionId),
    status: input.status === "running" || input.status === "completed" || input.status === "cancelled" || input.status === "timed-out" || input.status === "failed" || input.status === "superseded"
      ? input.status
      : (() => { throw new Error("Catalog operation status is invalid."); })(),
    directoriesVisited: integer(input.directoriesVisited, "directoriesVisited"),
    filesConsidered: integer(input.filesConsidered, "filesConsidered"),
    acceptedCount: integer(input.acceptedCount, "acceptedCount"),
    currentPath: input.currentPath === null ? null : stringValue(input.currentPath, "currentPath", true),
    ...(input.errorMessage === undefined ? {} : { errorMessage: stringValue(input.errorMessage, "errorMessage") }),
  };
}

export function parseCatalogOperationResult(value: LibraryOperationHandle): CatalogOperationResult {
  return {
    operationId: parseOperationId(value.operationId),
    catalogId: parseCatalogId(value.catalogId),
    sessionId: parseSessionId(value.sessionId),
    status: "running",
  };
}

export function parseCatalogApplyResult(value: unknown): CatalogApplyResult {
  const input = record(value, "Catalog apply result");
  return {
    catalogId: parseCatalogId(input.catalogId),
    revision: integer(input.revision, "revision"),
    changed: booleanValue(input.changed, "changed"),
    appliedMutations: integer(input.appliedMutations, "appliedMutations"),
    auditId: input.auditId === null ? null : integer(input.auditId, "auditId"),
  };
}

export function toCatalogLiveStateView(value: CatalogLiveState): CatalogLiveStateView {
  return {
    catalog: value.catalog,
    roots: value.roots.map((root) => ({
      rootId: root.rootId,
      label: root.label,
      health: root.health,
      scanState: root.scanState,
      watchState: root.watchState,
      revision: root.revision,
    })),
    assets: value.assets.map((asset) => ({
      ...asset,
      metadata: { ...asset.metadata, rawXmp: null },
    })),
    ...(value.assetDelta ? { assetDelta: value.assetDelta } : {}),
    tombstonedEntryIds: value.tombstonedEntryIds ?? [],
    albums: value.albums,
    operations: value.operations.map((operation) => ({
      operationId: operation.operationId,
      kind: operation.kind,
      state: operation.state,
      revision: operation.revision,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      items: operation.items.map((item) => ({
        operationId: item.operationId,
        itemId: item.itemId,
        assetId: item.assetId,
        state: item.state,
        payload: item.payload,
      })),
    })),
    presets: value.presets.map((preset) => ({
      presetId: preset.presetId,
      name: preset.name,
      template: preset.payload.template,
      payload: preset.payload.payload,
      revision: preset.revision,
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
      isDefault: preset.payload.isDefault,
    })),
    rules: value.rules,
    libraryStateJson: value.libraryStateJson ?? null,
    fingerprintCoverage: value.fingerprintCoverage,
    fingerprintMatches: value.fingerprintMatches,
  };
}
