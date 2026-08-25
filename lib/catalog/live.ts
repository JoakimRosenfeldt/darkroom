import {
  parseAssetId,
  parseCatalogId,
  parseEntryId,
  parseOperationId,
  parsePresetId,
  parseRootId,
  parseSourceId,
  type AssetId,
  type CatalogId,
  type EntryId,
  type OperationId,
  type PresetId,
  type RootId,
  type SourceId,
} from "./ids.ts";
import {
  parseJsonValue,
  parseImportTemplate,
  type JsonValue,
  type ImportTemplate,
} from "../import/domain.ts";
import type {
  CatalogV3AssetHealth,
  CatalogV3AssetMetadata,
  CatalogV3AssetSnapshot,
  CatalogV3FingerprintCoverage,
  CatalogV3FingerprintStatus,
  CatalogV3Observation,
  CatalogV3RootHealth,
  CatalogV3ScanState,
  CatalogV3WatchState,
  CatalogV3XmpState,
} from "./v3.ts";
import type { ColorLabel, PickStatus, StarRating } from "./types.ts";

export const CATALOG_LIVE_PAYLOAD_VERSION = 1 as const;
export const CATALOG_LIVE_MAX_MUTATIONS = 250;
const MAX_EMBEDDED_JSON_BYTES = 16 * 1024 * 1024;

export type CatalogLiveOperationState =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type CatalogLiveOperationItemStatus = CatalogLiveOperationState | "skipped";

export type CatalogLiveOperationStage =
  | "planned"
  | "destination-prepared"
  | "destination-published"
  | "catalog-applied"
  | "source-cleaned";

export type CatalogLiveImportAction = "add" | "copy" | "move" | "rename";
export type CatalogLiveXmpStatus = "absent" | "preserved" | "mismatch";

function stageRank(stage: CatalogLiveOperationStage): number {
  return ["planned", "destination-prepared", "destination-published", "catalog-applied", "source-cleaned"].indexOf(stage);
}

export interface CatalogLiveRoot {
  readonly rootId: RootId;
  readonly label: string;
  readonly configuredPath: string;
  readonly canonicalPath: string | null;
  readonly health: CatalogV3RootHealth;
  readonly scanState: CatalogV3ScanState;
  readonly watchState: CatalogV3WatchState;
  readonly revision: number;
}

export interface CatalogLiveOperationPayload {
  readonly version: 1;
  readonly kind: string;
  readonly planHash: string;
  readonly plan: JsonValue;
  readonly error?: string | null;
}

export interface CatalogLiveOperationItemPayload {
  readonly version: 1;
  readonly stage: CatalogLiveOperationStage;
  readonly action: CatalogLiveImportAction;
  readonly sourceRootId: RootId | null;
  readonly sourceRelativePath: string | null;
  readonly destinationRootId: RootId | null;
  readonly destinationRelativePath: string | null;
  readonly xmpStatus: CatalogLiveXmpStatus | null;
  readonly status?: CatalogLiveOperationItemStatus;
  readonly error?: string | null;
  readonly updatedAt?: number;
}

export interface CatalogLiveOperationItem {
  readonly operationId: OperationId;
  readonly itemId: string;
  readonly assetId: AssetId | null;
  readonly state: CatalogLiveOperationState;
  readonly payload: CatalogLiveOperationItemPayload;
}

export interface CatalogLiveOperation {
  readonly operationId: OperationId;
  readonly kind: string;
  readonly state: CatalogLiveOperationState;
  readonly payload: CatalogLiveOperationPayload;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly items: readonly CatalogLiveOperationItem[];
}

export interface CatalogLivePresetPayload {
  readonly version: 1;
  readonly template: ImportTemplate;
  readonly payload: JsonValue;
  readonly isDefault: boolean;
}

export interface CatalogLivePreset {
  readonly presetId: PresetId;
  readonly name: string;
  readonly payload: CatalogLivePresetPayload;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CatalogLiveAutoImportConfigV1 {
  readonly version: 1;
  readonly action: "copy";
  readonly ingressRootId: RootId;
  readonly ingressRelativePath: string;
  readonly stabilityMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

export interface CatalogLiveAutoImportConfigV2 {
  readonly version: 2;
  readonly action: "copy";
  readonly ingressRootId: RootId;
  readonly ingressRelativePath: string;
  readonly destinationRelativePath: string;
  readonly presetVersion: number;
  readonly presetSha256: string;
  readonly duplicatePolicy: "skip-incoming" | "continue-unchecked" | "keep-both";
  readonly destinationConflictPolicy: "skip" | "rename";
  readonly stabilityMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

export type CatalogLiveAutoImportConfig =
  | CatalogLiveAutoImportConfigV1
  | CatalogLiveAutoImportConfigV2;

export interface CatalogLiveRule {
  readonly ruleId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly destinationRootId: RootId;
  readonly presetId: PresetId;
  readonly config: CatalogLiveAutoImportConfig;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CatalogLiveAlbum {
  readonly albumId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly position: number;
  readonly entryIds: readonly EntryId[];
  readonly assetIds: readonly AssetId[];
}

export interface CatalogLiveEntrySnapshot extends CatalogV3AssetSnapshot {
  readonly entryId?: EntryId;
  readonly sourceId?: SourceId;
  readonly entryKind?: "original" | "virtual";
  readonly parentEntryId?: EntryId | null;
  readonly displayName?: string | null;
  readonly entryCreatedAt?: number;
}

export interface CatalogLiveCatalogIdentity {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly appVersion: string;
  readonly installState: "ready";
  readonly revision: number;
}

export interface CatalogLiveFingerprintMatch {
  readonly fingerprintId: string;
  readonly assetId: AssetId;
  readonly sha256: string;
}

export interface CatalogLiveState {
  readonly catalog: CatalogLiveCatalogIdentity;
  readonly roots: readonly CatalogLiveRoot[];
  readonly assets: readonly CatalogLiveEntrySnapshot[];
  readonly albums: readonly CatalogLiveAlbum[];
  readonly operations: readonly CatalogLiveOperation[];
  readonly presets: readonly CatalogLivePreset[];
  readonly rules: readonly CatalogLiveRule[];
  readonly libraryStateJson?: string | null;
  readonly fingerprintCoverage: CatalogV3FingerprintCoverage;
  readonly fingerprintMatches: readonly CatalogLiveFingerprintMatch[];
}

export interface CatalogLiveQueryInput {
  readonly catalogId: CatalogId;
  readonly expectedRevision: number | null;
  readonly assetId?: AssetId;
  readonly entryId?: EntryId;
  readonly rootId?: RootId;
  readonly fingerprintSha256?: string;
}

export interface CatalogLiveApplyResult {
  readonly catalogId: CatalogId;
  readonly revision: number;
  readonly changed: boolean;
  readonly appliedMutations: number;
  readonly auditId: number | null;
}

export interface CatalogLiveApplyInput {
  readonly catalogId: CatalogId;
  readonly expectedRevision: number;
  readonly mutations: readonly CatalogLiveMutation[];
  readonly now?: number;
}

export interface CatalogLiveCreateInput {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly appVersion: string;
  readonly root: CatalogLiveRootInput;
  readonly now?: number;
}

export interface CatalogLiveRootInput {
  readonly rootId: RootId;
  readonly label: string;
  readonly configuredPath: string;
  readonly canonicalPath: string | null;
  readonly health: CatalogV3RootHealth;
  readonly scanState: CatalogV3ScanState;
  readonly watchState: CatalogV3WatchState;
}

export interface CatalogLiveObservation {
  readonly assetId?: AssetId;
  readonly relativePath: string;
  readonly observation: CatalogV3Observation | null;
  readonly health: CatalogV3AssetHealth;
  readonly formatId: string;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  readonly lensModel: string | null;
}

export interface CatalogLiveMetadataPatch {
  readonly version: 1;
  readonly archive?: boolean;
  readonly pick?: PickStatus;
  readonly rating?: StarRating;
  readonly colorLabel?: ColorLabel;
  readonly developJson?: string | null;
  readonly developUpdatedAt?: number;
  readonly updatedAt?: number;
  readonly title?: string | null;
  readonly caption?: string | null;
  readonly copyright?: string | null;
  readonly keywordsJson?: string;
  readonly rawXmp?: string | null;
  readonly xmpState?: CatalogV3XmpState;
  readonly xmpMtime?: number | null;
  readonly xmpSha256?: string | null;
}

export interface CatalogLiveFingerprintTransition {
  readonly assetId: AssetId;
  readonly status: CatalogV3FingerprintStatus;
  readonly sha256: string | null;
  readonly observedAt: number | null;
  readonly observedByteLength: number | null;
  readonly observedModifiedAt: number | null;
  readonly localFileId: string | null;
}

export interface CatalogLiveOperationInput {
  readonly operationId: OperationId;
  readonly kind: string;
  readonly state: CatalogLiveOperationState;
  readonly payload: CatalogLiveOperationPayload;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CatalogLiveOperationItemInput {
  readonly operationId: OperationId;
  readonly itemId: string;
  readonly assetId: AssetId | null;
  readonly state: CatalogLiveOperationState;
  readonly payload: CatalogLiveOperationItemPayload;
}

export type CatalogLiveMutation =
  | { readonly kind: "rename-catalog"; readonly displayName: string }
  | {
      readonly kind: "edit-entry-create";
      readonly sourceEntryId: EntryId;
      readonly entryId: EntryId;
      readonly displayName: string;
      readonly developJson: string | null;
      readonly expectedSourceMetadataUpdatedAt: number;
      readonly createdAt: number;
    }
  | {
      readonly kind: "edit-entry-rename";
      readonly entryId: EntryId;
      readonly displayName: string;
      readonly updatedAt: number;
    }
  | {
      readonly kind: "edit-entry-delete";
      readonly entryId: EntryId;
      readonly tombstonedAt: number;
    }
  | { readonly kind: "root-upsert"; readonly root: CatalogLiveRootInput }
  | {
      readonly kind: "root-health";
      readonly rootId: RootId;
      readonly health: CatalogV3RootHealth;
      readonly canonicalPath: string | null;
    }
  | { readonly kind: "root-scan"; readonly rootId: RootId; readonly scanState: CatalogV3ScanState }
  | { readonly kind: "root-watch"; readonly rootId: RootId; readonly watchState: CatalogV3WatchState }
  | {
      readonly kind: "root-relink";
      readonly rootId: RootId;
      readonly label: string;
      readonly configuredPath: string;
      readonly canonicalPath: string;
      readonly health: CatalogV3RootHealth;
    }
  | {
      readonly kind: "reconcile";
      readonly rootId: RootId;
      readonly complete: boolean;
      readonly observations: readonly CatalogLiveObservation[];
    }
  | {
      readonly kind: "reconcile-complete";
      readonly rootId: RootId;
      readonly observations: readonly CatalogLiveObservation[];
    }
  | { readonly kind: "metadata-patch"; readonly entryId: EntryId; readonly assetId?: never; readonly patch: CatalogLiveMetadataPatch }
  | { readonly kind: "metadata-patch"; readonly assetId: AssetId; readonly entryId?: never; readonly patch: CatalogLiveMetadataPatch }
  | {
      readonly kind: "album-create";
      readonly albumId: string;
      readonly name: string;
      readonly position: number;
      readonly createdAt: number;
      readonly updatedAt: number;
    }
  | { readonly kind: "album-rename"; readonly albumId: string; readonly name: string; readonly updatedAt: number }
  | { readonly kind: "album-delete"; readonly albumId: string }
  | { readonly kind: "album-membership-replace"; readonly albumId: string; readonly entryIds: readonly EntryId[]; readonly assetIds?: never }
  | { readonly kind: "album-membership-replace"; readonly albumId: string; readonly assetIds: readonly AssetId[]; readonly entryIds?: never }
  | { readonly kind: "archive-set"; readonly entryId: EntryId; readonly assetId?: never; readonly archived: boolean }
  | { readonly kind: "archive-set"; readonly assetId: AssetId; readonly entryId?: never; readonly archived: boolean }
  | { readonly kind: "library-state-replace"; readonly stateJson: string }
  | { readonly kind: "fingerprint-set"; readonly fingerprint: CatalogLiveFingerprintTransition }
  | {
      readonly kind: "preset-upsert";
      readonly presetId: PresetId;
      readonly name: string;
      readonly payload: CatalogLivePresetPayload;
      readonly createdAt: number;
      readonly updatedAt: number;
    }
  | { readonly kind: "preset-rename"; readonly presetId: PresetId; readonly name: string; readonly updatedAt: number }
  | { readonly kind: "preset-delete"; readonly presetId: PresetId }
  | { readonly kind: "preset-set-default"; readonly presetId: PresetId; readonly updatedAt: number }
  | {
      readonly kind: "rule-upsert";
      readonly ruleId: string;
      readonly name: string;
      readonly enabled: boolean;
      readonly destinationRootId: RootId;
      readonly presetId: PresetId;
      readonly config: CatalogLiveAutoImportConfig;
      readonly createdAt: number;
      readonly updatedAt: number;
    }
  | { readonly kind: "rule-delete"; readonly ruleId: string }
  | { readonly kind: "operation-upsert"; readonly operation: CatalogLiveOperationInput }
  | { readonly kind: "operation-item-upsert"; readonly item: CatalogLiveOperationItemInput }
  | {
      readonly kind: "asset-relocate";
      readonly assetId: AssetId;
      readonly rootId: RootId;
      readonly relativePath: string;
      readonly observation: CatalogV3Observation | null;
      readonly health: CatalogV3AssetHealth;
    }
  | {
      readonly kind: "asset-copy";
      readonly sourceAssetId: AssetId;
      readonly newAssetId: AssetId;
      readonly rootId: RootId;
      readonly relativePath: string;
      readonly observation: CatalogV3Observation | null;
      readonly health: CatalogV3AssetHealth;
    };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Catalog live ${message}.`);
}

function record(value: unknown, label: string): RecordValue {
  return isRecord(value) ? value : fail(`${label} must be an object`);
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\u0000")) {
    return fail(`${label} is invalid`);
  }
  return value;
}

function editEntryName(value: unknown, label: string): string {
  const name = stringValue(value, label).trim();
  if (name.length === 0 || name.length > 120) return fail(`${label} is invalid`);
  return name;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function optionalNullableString(value: unknown, label: string): string | null | undefined {
  return value === undefined ? undefined : nullableString(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return fail(`${label} is invalid`);
  return parsed;
}

function optionalValue<T>(input: RecordValue, key: string, parse: (value: unknown) => T): T | undefined {
  return key in input && input[key] !== undefined ? parse(input[key]) : undefined;
}

function booleanValue(value: unknown, label: string): boolean {
  return typeof value === "boolean" ? value : fail(`${label} is invalid`);
}

function enumValue<T extends string | number>(value: unknown, label: string, values: readonly T[]): T {
  return (typeof value === "string" || typeof value === "number") && values.includes(value as T)
    ? value as T
    : fail(`${label} is invalid`);
}

function normalizedAbsolutePath(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (parsed.startsWith("/")) {
    if (parsed !== normalizeAbsolutePath(parsed, "/")) return fail(`${label} is invalid`);
    return parsed;
  }
  const drive = /^[A-Za-z]:([\\/])/.exec(parsed);
  if (drive === null || parsed !== normalizeAbsolutePath(parsed, drive[1]!)) {
    return fail(`${label} is invalid`);
  }
  return parsed;
}

function normalizeAbsolutePath(value: string, separator: string): string {
  if (separator === "/") {
    if (value === "/") return value;
    if (/^[A-Za-z]:[\\/]/.test(value)) {
      if (value.includes("\\")) return "";
      if (value.length === 3) return value;
      if (value.endsWith("/")) return "";
      const driveParts = value.slice(3).split("/");
      return driveParts.some((part) => part.length === 0 || part === "." || part === "..") ? "" : value;
    }
    const parts = value.slice(1).split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return "";
    return value;
  }
  if (value.includes(separator === "/" ? "\\" : "/")) return "";
  if (value.length === 3) return value;
  if (value.endsWith(separator)) return "";
  const parts = value.slice(3).split(separator);
  return parts.some((part) => part.length === 0 || part === "." || part === "..") ? "" : value;
}

export function parseCatalogLiveRelativePath(value: unknown, label = "relativePath"): string {
  const parsed = stringValue(value, label);
  if (
    parsed.startsWith("/") ||
    parsed.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(parsed) ||
    parsed.includes("\\")
  ) return fail(`${label} is invalid`);
  const parts = parsed.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return fail(`${label} is invalid`);
  return parsed;
}

function hash(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  return /^[0-9a-f]{64}$/.test(parsed) ? parsed : fail(`${label} is invalid`);
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function fingerprintId(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed)
    ? parsed
    : fail(`${label} is invalid`);
}

function parseObservation(value: unknown, label: string): CatalogV3Observation | null {
  if (value === null) return null;
  const input = record(value, label);
  return {
    byteLength: input.byteLength === null ? null : integer(input.byteLength, `${label}.byteLength`),
    modifiedAt: input.modifiedAt === null ? null : finiteNumber(input.modifiedAt, `${label}.modifiedAt`),
    observedAt: finiteNumber(input.observedAt, `${label}.observedAt`),
    localFileId: nullableString(input.localFileId, `${label}.localFileId`),
  };
}

function parseAssetHealth(value: unknown, label: string): CatalogV3AssetHealth {
  return enumValue(value, label, ["present", "missing", "ambiguous", "unreadable"] as const);
}

function assertItemStateStage(state: CatalogLiveOperationState, stage: CatalogLiveOperationStage): void {
  if (state === "planned" && stage !== "planned") return fail("planned operation item cannot have an advanced stage");
  if (state === "completed" && stageRank(stage) < 3) return fail("completed operation item needs catalog-applied stage");
}

function parseRootInput(value: unknown): CatalogLiveRootInput {
  const input = record(value, "root");
  const health = enumValue(input.health, "root.health", ["online", "missing", "ambiguous", "unreadable"] as const);
  const canonicalPath = nullableString(input.canonicalPath, "root.canonicalPath");
  if (health === "online" && canonicalPath === null) return fail("online root needs canonicalPath");
  return {
    rootId: parseRootId(input.rootId),
    label: stringValue(input.label, "root.label"),
    configuredPath: normalizedAbsolutePath(input.configuredPath, "root.configuredPath"),
    canonicalPath: canonicalPath === null ? null : normalizedAbsolutePath(canonicalPath, "root.canonicalPath"),
    health,
    scanState: enumValue(input.scanState, "root.scanState", ["unknown", "complete", "partial", "failed"] as const),
    watchState: enumValue(input.watchState, "root.watchState", ["disabled", "active", "error"] as const),
  };
}

function parseRuleId(value: unknown): string {
  return parseCatalogId(value);
}

function parseMetadataPatch(value: unknown): CatalogLiveMetadataPatch {
  const input = record(value, "metadata patch");
  if (input.version !== CATALOG_LIVE_PAYLOAD_VERSION) return fail("metadata patch version is invalid");
  return {
    version: 1,
    archive: optionalValue(input, "archive", (item) => booleanValue(item, "metadata.archive")),
    pick: optionalValue(input, "pick", (item) => enumValue(item, "metadata.pick", ["none", "pick", "reject"] as const)),
    rating: optionalValue(input, "rating", (item) => enumValue(item, "metadata.rating", [0, 1, 2, 3, 4, 5] as const)),
    colorLabel: optionalValue(input, "colorLabel", (item) => item === null ? null : enumValue(item, "metadata.colorLabel", ["red", "yellow", "green", "blue", "purple"] as const)),
    developJson: optionalValue(input, "developJson", (item) => {
      if (item === null) return null;
      const parsed = stringValue(item, "metadata.developJson");
      if (new TextEncoder().encode(parsed).byteLength > MAX_EMBEDDED_JSON_BYTES) {
        return fail("metadata.developJson is too large");
      }
      try { JSON.parse(parsed); } catch { return fail("metadata.developJson is invalid"); }
      return parsed;
    }),
    developUpdatedAt: optionalValue(input, "developUpdatedAt", (item) => finiteNumber(item, "metadata.developUpdatedAt")),
    updatedAt: optionalValue(input, "updatedAt", (item) => finiteNumber(item, "metadata.updatedAt")),
    title: optionalValue(input, "title", (item) => nullableString(item, "metadata.title")),
    caption: optionalValue(input, "caption", (item) => nullableString(item, "metadata.caption")),
    copyright: optionalValue(input, "copyright", (item) => nullableString(item, "metadata.copyright")),
    keywordsJson: optionalValue(input, "keywordsJson", (item) => {
      const parsed = stringValue(item, "metadata.keywordsJson");
      let json: unknown;
      try { json = JSON.parse(parsed); } catch { return fail("metadata.keywordsJson is invalid"); }
      return Array.isArray(json) ? parsed : fail("metadata.keywordsJson is invalid");
    }),
    rawXmp: optionalValue(input, "rawXmp", (item) => {
      const parsed = nullableString(item, "metadata.rawXmp");
      if (parsed !== null && new TextEncoder().encode(parsed).byteLength > 16 * 1024 * 1024) return fail("metadata.rawXmp is too large");
      return parsed;
    }),
    xmpState: optionalValue(input, "xmpState", (item) => enumValue(item, "metadata.xmpState", ["unknown", "absent", "preserved", "malformed"] as const)),
    xmpMtime: optionalValue(input, "xmpMtime", (item) => item === null ? null : finiteNumber(item, "metadata.xmpMtime")),
    xmpSha256: optionalValue(input, "xmpSha256", (item) => nullableHash(item, "metadata.xmpSha256")),
  };
}

function parseLibraryStateJson(value: unknown, path: string): string {
  const json = stringValue(value, path);
  if (new TextEncoder().encode(json).byteLength > MAX_EMBEDDED_JSON_BYTES) {
    return fail(`${path} is too large`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail(`${path} is invalid`);
  }
  return isRecord(parsed) ? json : fail(`${path} must contain an object`);
}

function parseOperationPayload(value: unknown): CatalogLiveOperationPayload {
  const input = record(value, "operation payload");
  if (input.version !== CATALOG_LIVE_PAYLOAD_VERSION) return fail("operation payload version is invalid");
  return {
    version: 1,
    kind: stringValue(input.kind, "operation payload.kind"),
    planHash: hash(input.planHash, "operation payload.planHash"),
    plan: parseJsonValue(input.plan, "operation payload.plan"),
    ...(input.error === undefined ? {} : { error: optionalNullableString(input.error, "operation payload.error") }),
  };
}

function parseOperationItemPayload(value: unknown): CatalogLiveOperationItemPayload {
  const input = record(value, "operation item payload");
  if (input.version !== CATALOG_LIVE_PAYLOAD_VERSION) return fail("operation item payload version is invalid");
  return {
    version: 1,
    stage: enumValue(input.stage, "operation item payload.stage", ["planned", "destination-prepared", "destination-published", "catalog-applied", "source-cleaned"] as const),
    action: enumValue(input.action, "operation item payload.action", ["add", "copy", "move", "rename"] as const),
    sourceRootId: input.sourceRootId === null ? null : parseRootId(input.sourceRootId),
    sourceRelativePath: input.sourceRelativePath === null ? null : parseCatalogLiveRelativePath(input.sourceRelativePath, "operation sourceRelativePath"),
    destinationRootId: input.destinationRootId === null ? null : parseRootId(input.destinationRootId),
    destinationRelativePath: input.destinationRelativePath === null ? null : parseCatalogLiveRelativePath(input.destinationRelativePath, "operation destinationRelativePath"),
    xmpStatus: input.xmpStatus === null ? null : enumValue(input.xmpStatus, "operation item payload.xmpStatus", ["absent", "preserved", "mismatch"] as const),
    ...(input.status === undefined ? {} : { status: enumValue(input.status, "operation item payload.status", ["planned", "running", "completed", "skipped", "failed", "cancelled"] as const) }),
    ...(input.error === undefined ? {} : { error: optionalNullableString(input.error, "operation item payload.error") }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: finiteNumber(input.updatedAt, "operation item payload.updatedAt") }),
  };
}

function parsePresetPayload(value: unknown): CatalogLivePresetPayload {
  const input = record(value, "preset payload");
  if (input.version !== CATALOG_LIVE_PAYLOAD_VERSION) return fail("preset payload version is invalid");
  return {
    version: 1,
    template: parseImportTemplate(input.template),
    payload: parseJsonValue(input.payload, "preset payload.payload"),
    isDefault: booleanValue(input.isDefault, "preset payload.isDefault"),
  };
}

export function parseCatalogLiveAutoImportConfig(value: unknown): CatalogLiveAutoImportConfig {
  const input = record(value, "Auto Import config");
  if (input.action !== "copy") {
    return fail("Auto Import config only supports copy rules");
  }
  if (input.version === CATALOG_LIVE_PAYLOAD_VERSION) {
    return {
      version: 1,
      action: "copy",
      ingressRootId: parseRootId(input.ingressRootId),
      ingressRelativePath: parseCatalogLiveRelativePath(input.ingressRelativePath, "Auto Import ingressRelativePath"),
      stabilityMs: integer(input.stabilityMs, "Auto Import stabilityMs"),
      maxAttempts: integer(input.maxAttempts, "Auto Import maxAttempts", 1),
      retryBackoffMs: integer(input.retryBackoffMs, "Auto Import retryBackoffMs"),
    };
  }
  if (input.version !== 2) {
    return fail("Auto Import config version is invalid");
  }
  return {
    version: 2,
    action: "copy",
    ingressRootId: parseRootId(input.ingressRootId),
    ingressRelativePath: parseCatalogLiveRelativePath(input.ingressRelativePath, "Auto Import ingressRelativePath"),
    destinationRelativePath: parseCatalogLiveRelativePath(input.destinationRelativePath, "Auto Import destinationRelativePath"),
    presetVersion: integer(input.presetVersion, "Auto Import presetVersion", 1),
    presetSha256: hash(input.presetSha256, "Auto Import presetSha256"),
    duplicatePolicy: enumValue(input.duplicatePolicy, "Auto Import duplicatePolicy", ["skip-incoming", "continue-unchecked", "keep-both"] as const),
    destinationConflictPolicy: enumValue(input.destinationConflictPolicy, "Auto Import destinationConflictPolicy", ["skip", "rename"] as const),
    stabilityMs: integer(input.stabilityMs, "Auto Import stabilityMs"),
    maxAttempts: integer(input.maxAttempts, "Auto Import maxAttempts", 1),
    retryBackoffMs: integer(input.retryBackoffMs, "Auto Import retryBackoffMs"),
  };
}

function parseObservationInput(value: unknown): CatalogLiveObservation {
  const input = record(value, "reconcile observation");
  const observation = parseObservation(input.observation, "reconcile observation.observation");
  const health = enumValue(input.health, "reconcile observation.health", ["present", "missing", "ambiguous", "unreadable"] as const);
  if (health === "present" && observation === null) return fail("present observation needs file stats");
  return {
    ...(input.assetId === undefined ? {} : { assetId: parseAssetId(input.assetId) }),
    relativePath: parseCatalogLiveRelativePath(input.relativePath),
    observation,
    health,
    formatId: stringValue(input.formatId, "reconcile observation.formatId"),
    cameraMake: nullableString(input.cameraMake, "reconcile observation.cameraMake"),
    cameraModel: nullableString(input.cameraModel, "reconcile observation.cameraModel"),
    lensModel: nullableString(input.lensModel, "reconcile observation.lensModel"),
  };
}

function parseFingerprint(value: unknown): CatalogLiveFingerprintTransition {
  const input = record(value, "fingerprint");
  const status = enumValue(input.status, "fingerprint.status", ["missing", "hashing", "valid", "stale", "failed"] as const);
  const sha256 = nullableHash(input.sha256, "fingerprint.sha256");
  if ((status === "valid") !== (sha256 !== null)) return fail("fingerprint digest/status is inconsistent");
  return {
    assetId: parseAssetId(input.assetId),
    status,
    sha256,
    observedAt: input.observedAt === null ? null : finiteNumber(input.observedAt, "fingerprint.observedAt"),
    observedByteLength: input.observedByteLength === null ? null : integer(input.observedByteLength, "fingerprint.observedByteLength"),
    observedModifiedAt: input.observedModifiedAt === null ? null : finiteNumber(input.observedModifiedAt, "fingerprint.observedModifiedAt"),
    localFileId: nullableString(input.localFileId, "fingerprint.localFileId"),
  };
}

function parseState(value: unknown): CatalogLiveState {
  const input = record(value, "live state");
  const catalogValue = record(input.catalog, "live catalog");
  const roots = Array.isArray(input.roots) ? input.roots.map(parseRootOutput) : fail("live roots are invalid");
  const assets = Array.isArray(input.assets) ? input.assets.map(parseAssetSnapshot) : fail("live assets are invalid");
  const albums = Array.isArray(input.albums) ? input.albums.map(parseAlbumOutput) : fail("live albums are invalid");
  const operations = Array.isArray(input.operations) ? input.operations.map(parseOperationOutput) : fail("live operations are invalid");
  const presets = Array.isArray(input.presets) ? input.presets.map(parsePresetOutput) : fail("live presets are invalid");
  const rules = Array.isArray(input.rules) ? input.rules.map(parseRuleOutput) : fail("live rules are invalid");
  const libraryStateJson = input.libraryStateJson === undefined || input.libraryStateJson === null
    ? null
    : parseLibraryStateJson(input.libraryStateJson, "live libraryStateJson");
  const fingerprintCoverage = parseFingerprintCoverage(input.fingerprintCoverage);
  const fingerprintMatches = Array.isArray(input.fingerprintMatches)
    ? input.fingerprintMatches.map(parseFingerprintMatch)
    : fail("live fingerprintMatches are invalid");
  const catalogId = parseCatalogId(catalogValue.catalogId);
  if (assets.some((asset) => asset.catalogId !== catalogId)) return fail("live asset catalog identity is inconsistent");
  return {
    catalog: {
      catalogId,
      displayName: stringValue(catalogValue.displayName, "live catalog.displayName"),
      appVersion: stringValue(catalogValue.appVersion, "live catalog.appVersion"),
      installState: catalogValue.installState === "ready" ? "ready" : fail("live catalog.installState is invalid"),
      revision: integer(catalogValue.revision, "live catalog.revision"),
    },
    roots,
    assets,
    albums,
    operations,
    presets,
    rules,
    libraryStateJson,
    fingerprintCoverage,
    fingerprintMatches,
  };
}

function parseAlbumOutput(value: unknown): CatalogLiveAlbum {
  const input = record(value, "live album");
  const ids = input.entryIds ?? input.assetIds;
  if (!Array.isArray(ids)) return fail("live album.entryIds are invalid");
  const entryIds = ids.map((entryId) => parseEntryId(entryId));
  const assetIds = input.assetIds === undefined
    ? entryIds.map((entryId) => parseAssetId(entryId))
    : Array.isArray(input.assetIds)
      ? input.assetIds.map((assetId) => parseAssetId(assetId))
      : fail("live album.assetIds are invalid");
  if (assetIds.length !== entryIds.length) return fail("live album identities are inconsistent");
  return {
    albumId: stringValue(input.albumId, "live album.albumId"),
    name: stringValue(input.name, "live album.name", true),
    createdAt: finiteNumber(input.createdAt, "live album.createdAt"),
    updatedAt: finiteNumber(input.updatedAt, "live album.updatedAt"),
    position: integer(input.position, "live album.position"),
    entryIds,
    assetIds,
  };
}

function parseRootOutput(value: unknown): CatalogLiveRoot {
  const input = record(value, "live root");
  return {
    ...parseRootInput(input),
    revision: integer(input.revision, "live root.revision"),
  };
}

function parseFingerprintCoverage(value: unknown): CatalogV3FingerprintCoverage {
  const input = record(value, "fingerprint coverage");
  const result = {
    total: integer(input.total, "fingerprint coverage.total"),
    missing: integer(input.missing, "fingerprint coverage.missing"),
    hashing: integer(input.hashing, "fingerprint coverage.hashing"),
    valid: integer(input.valid, "fingerprint coverage.valid"),
    stale: integer(input.stale, "fingerprint coverage.stale"),
    failed: integer(input.failed, "fingerprint coverage.failed"),
  };
  if (result.total !== result.missing + result.hashing + result.valid + result.stale + result.failed) {
    return fail("fingerprint coverage totals are inconsistent");
  }
  return result;
}

function parseAssetSnapshot(value: unknown): CatalogLiveEntrySnapshot {
  const input = record(value, "live asset");
  const entryKind = input.entryKind === undefined
    ? input.entryId === undefined || input.entryId === input.assetId ? "original" : "virtual"
    : enumValue(input.entryKind, "live asset.entryKind", ["original", "virtual"] as const);
  const displayName = input.displayName === undefined || input.displayName === null
    ? null
    : editEntryName(input.displayName, "live asset.displayName");
  const parentEntryId = input.parentEntryId === undefined || input.parentEntryId === null
    ? null
    : parseEntryId(input.parentEntryId);
  if (entryKind === "virtual" && displayName === null) return fail("live virtual asset needs a displayName");
  if (entryKind === "virtual" && parentEntryId === null) return fail("live virtual asset needs a parentEntryId");
  if (entryKind === "original" && displayName !== null) return fail("live original asset cannot have a displayName");
  if (entryKind === "original" && parentEntryId !== null) return fail("live original asset cannot have a parentEntryId");
  const health = enumValue(input.health, "live asset.health", ["present", "missing", "ambiguous", "unreadable"] as const);
  const observation = parseObservation(input.observation, "live asset.observation");
  if (health === "present" && observation === null) return fail("live present asset needs an observation");
  const fingerprintStatus = enumValue(input.fingerprintStatus, "live asset.fingerprintStatus", ["missing", "hashing", "valid", "stale", "failed"] as const);
  const fingerprintSha256 = nullableHash(input.fingerprintSha256, "live asset.fingerprintSha256");
  if ((fingerprintStatus === "valid") !== (fingerprintSha256 !== null)) return fail("live asset fingerprint is inconsistent");
  const fingerprintObservedAt = input.fingerprintObservedAt === null ? null : finiteNumber(input.fingerprintObservedAt, "live asset.fingerprintObservedAt");
  const fingerprintObservedByteLength = input.fingerprintObservedByteLength === null ? null : integer(input.fingerprintObservedByteLength, "live asset.fingerprintObservedByteLength");
  const fingerprintObservedModifiedAt = input.fingerprintObservedModifiedAt === null ? null : finiteNumber(input.fingerprintObservedModifiedAt, "live asset.fingerprintObservedModifiedAt");
  const fingerprintLocalFileId = nullableString(input.fingerprintLocalFileId, "live asset.fingerprintLocalFileId");
  if (fingerprintStatus === "valid" && (fingerprintObservedAt === null || (fingerprintObservedByteLength === null && fingerprintObservedModifiedAt === null && fingerprintLocalFileId === null))) return fail("live valid fingerprint proof is missing");
  return {
    catalogId: parseCatalogId(input.catalogId),
    entryId: parseEntryId(input.entryId ?? input.assetId),
    sourceId: parseSourceId(input.sourceId ?? input.assetId),
    entryKind,
    parentEntryId,
    displayName,
    entryCreatedAt: input.entryCreatedAt === undefined
      ? 0
      : finiteNumber(input.entryCreatedAt, "live asset.entryCreatedAt"),
    assetId: parseAssetId(input.assetId),
    rootId: parseRootId(input.rootId),
    relativePath: parseCatalogLiveRelativePath(input.relativePath),
    observation,
    revision: integer(input.revision, "live asset.revision"),
    health,
    formatId: nullableString(input.formatId, "live asset.formatId"),
    cameraMake: nullableString(input.cameraMake, "live asset.cameraMake"),
    cameraModel: nullableString(input.cameraModel, "live asset.cameraModel"),
    lensModel: nullableString(input.lensModel, "live asset.lensModel"),
    fingerprintId: fingerprintId(input.fingerprintId, "live asset.fingerprintId"),
    fingerprintStatus,
    fingerprintSha256,
    fingerprintObservedAt,
    fingerprintObservedByteLength,
    fingerprintObservedModifiedAt,
    fingerprintLocalFileId,
    metadata: parseMetadataOutput(input.metadata),
  };
}

function parseMetadataOutput(value: unknown): CatalogV3AssetMetadata {
  const input = record(value, "live metadata");
  const xmpState = enumValue(input.xmpState, "live metadata.xmpState", ["unknown", "absent", "preserved", "malformed"] as const);
  const rawXmp = nullableString(input.rawXmp, "live metadata.rawXmp");
  if (rawXmp !== null && new TextEncoder().encode(rawXmp).byteLength > 16 * 1024 * 1024) return fail("live metadata.rawXmp is too large");
  if ((xmpState === "preserved") !== (rawXmp !== null)) return fail("live metadata XMP is inconsistent");
  const keywordsJson = stringValue(input.keywordsJson, "live metadata.keywordsJson");
  let parsedKeywords: unknown;
  try { parsedKeywords = JSON.parse(keywordsJson); } catch { return fail("live metadata.keywordsJson is invalid"); }
  if (!Array.isArray(parsedKeywords)) return fail("live metadata.keywordsJson is invalid");
  return {
    archive: booleanValue(input.archive, "live metadata.archive"),
    pick: enumValue(input.pick, "live metadata.pick", ["none", "pick", "reject"] as const),
    rating: enumValue(input.rating, "live metadata.rating", [0, 1, 2, 3, 4, 5] as const),
    colorLabel: input.colorLabel === null ? null : enumValue(input.colorLabel, "live metadata.colorLabel", ["red", "yellow", "green", "blue", "purple"] as const),
    developJson: (() => {
      if (input.developJson === null) return null;
      const parsed = stringValue(input.developJson, "live metadata.developJson");
      if (new TextEncoder().encode(parsed).byteLength > MAX_EMBEDDED_JSON_BYTES) {
        return fail("live metadata.developJson is too large");
      }
      try { JSON.parse(parsed); } catch { return fail("live metadata.developJson is invalid"); }
      return parsed;
    })(),
    developUpdatedAt: finiteNumber(input.developUpdatedAt, "live metadata.developUpdatedAt"),
    updatedAt: finiteNumber(input.updatedAt, "live metadata.updatedAt"),
    title: nullableString(input.title, "live metadata.title"),
    caption: nullableString(input.caption, "live metadata.caption"),
    copyright: nullableString(input.copyright, "live metadata.copyright"),
    keywordsJson,
    rawXmp,
    xmpState,
    xmpMtime: input.xmpMtime === null ? null : finiteNumber(input.xmpMtime, "live metadata.xmpMtime"),
    xmpSha256: nullableHash(input.xmpSha256, "live metadata.xmpSha256"),
  };
}

function parseOperationOutput(value: unknown): CatalogLiveOperation {
  const input = record(value, "live operation");
  const items = Array.isArray(input.items) ? input.items.map(parseOperationItemOutput) : fail("live operation.items are invalid");
  return {
    operationId: parseOperationId(input.operationId),
    kind: stringValue(input.kind, "live operation.kind"),
    state: enumValue(input.state, "live operation.state", ["planned", "running", "completed", "failed", "cancelled"] as const),
    payload: parseOperationPayload(input.payload),
    revision: integer(input.revision, "live operation.revision"),
    createdAt: finiteNumber(input.createdAt, "live operation.createdAt"),
    updatedAt: finiteNumber(input.updatedAt, "live operation.updatedAt"),
    items,
  };
}

function parseOperationItemOutput(value: unknown): CatalogLiveOperationItem {
  const input = record(value, "live operation item");
  const state = enumValue(input.state, "live operation item.state", ["planned", "running", "completed", "failed", "cancelled"] as const);
  const payload = parseOperationItemPayload(input.payload);
  assertItemStateStage(state, payload.stage);
  return {
    operationId: parseOperationId(input.operationId),
    itemId: stringValue(input.itemId, "live operation item.itemId"),
    assetId: input.assetId === null ? null : parseAssetId(input.assetId),
    state,
    payload,
  };
}

function parsePresetOutput(value: unknown): CatalogLivePreset {
  const input = record(value, "live preset");
  return {
    presetId: parsePresetId(input.presetId),
    name: stringValue(input.name, "live preset.name"),
    payload: parsePresetPayload(input.payload),
    revision: integer(input.revision, "live preset.revision"),
    createdAt: finiteNumber(input.createdAt, "live preset.createdAt"),
    updatedAt: finiteNumber(input.updatedAt, "live preset.updatedAt"),
  };
}

function parseRuleOutput(value: unknown): CatalogLiveRule {
  const input = record(value, "live rule");
  return {
    ruleId: parseRuleId(input.ruleId),
    name: stringValue(input.name, "live rule.name"),
    enabled: booleanValue(input.enabled, "live rule.enabled"),
    destinationRootId: parseRootId(input.destinationRootId),
    presetId: parsePresetId(input.presetId),
    config: parseCatalogLiveAutoImportConfig(input.config),
    revision: integer(input.revision, "live rule.revision"),
    createdAt: finiteNumber(input.createdAt, "live rule.createdAt"),
    updatedAt: finiteNumber(input.updatedAt, "live rule.updatedAt"),
  };
}

function parseFingerprintMatch(value: unknown): CatalogLiveFingerprintMatch {
  const input = record(value, "fingerprint match");
  return {
    fingerprintId: fingerprintId(input.fingerprintId, "fingerprint match.fingerprintId"),
    assetId: parseAssetId(input.assetId),
    sha256: hash(input.sha256, "fingerprint match.sha256"),
  };
}

function parseMutation(value: unknown): CatalogLiveMutation {
  const input = record(value, "mutation");
  const kind = stringValue(input.kind, "mutation.kind");
  switch (kind) {
    case "rename-catalog":
      return { kind, displayName: stringValue(input.displayName, "displayName") };
    case "edit-entry-create":
      return {
        kind,
        sourceEntryId: parseEntryId(input.sourceEntryId),
        entryId: parseEntryId(input.entryId),
        displayName: editEntryName(input.displayName, "displayName"),
        developJson: input.developJson === null
          ? null
          : (() => {
              const value = stringValue(input.developJson, "developJson");
              if (new TextEncoder().encode(value).byteLength > 2 * 1024 * 1024) {
                return fail("developJson is too large");
              }
              try { JSON.parse(value); } catch { return fail("developJson is invalid"); }
              return value;
            })(),
        expectedSourceMetadataUpdatedAt: finiteNumber(
          input.expectedSourceMetadataUpdatedAt,
          "expectedSourceMetadataUpdatedAt",
        ),
        createdAt: finiteNumber(input.createdAt, "createdAt"),
      };
    case "edit-entry-rename":
      return {
        kind,
        entryId: parseEntryId(input.entryId),
        displayName: editEntryName(input.displayName, "displayName"),
        updatedAt: finiteNumber(input.updatedAt, "updatedAt"),
      };
    case "edit-entry-delete":
      return {
        kind,
        entryId: parseEntryId(input.entryId),
        tombstonedAt: finiteNumber(input.tombstonedAt, "tombstonedAt"),
      };
    case "root-upsert":
      return { kind, root: parseRootInput(input.root) };
    case "root-health":
      {
        const canonicalPath = input.canonicalPath === null ? null : normalizedAbsolutePath(input.canonicalPath, "canonicalPath");
      return {
        kind,
        rootId: parseRootId(input.rootId),
        health: enumValue(input.health, "health", ["online", "missing", "ambiguous", "unreadable"] as const),
        canonicalPath,
      };
      }
    case "root-scan":
      return { kind, rootId: parseRootId(input.rootId), scanState: enumValue(input.scanState, "scanState", ["unknown", "complete", "partial", "failed"] as const) };
    case "root-watch":
      return { kind, rootId: parseRootId(input.rootId), watchState: enumValue(input.watchState, "watchState", ["disabled", "active", "error"] as const) };
    case "root-relink":
      return {
        kind,
        rootId: parseRootId(input.rootId),
        label: stringValue(input.label, "label"),
        configuredPath: normalizedAbsolutePath(input.configuredPath, "configuredPath"),
        canonicalPath: normalizedAbsolutePath(input.canonicalPath, "canonicalPath"),
        health: enumValue(input.health, "health", ["online", "missing", "ambiguous", "unreadable"] as const),
      };
    case "reconcile-complete": {
      if (!Array.isArray(input.observations)) return fail("reconcile observations are invalid");
      return { kind, rootId: parseRootId(input.rootId), observations: input.observations.map(parseObservationInput) };
    }
    case "reconcile": {
      if (!Array.isArray(input.observations)) return fail("reconcile observations are invalid");
      return { kind, rootId: parseRootId(input.rootId), complete: booleanValue(input.complete, "reconcile complete"), observations: input.observations.map(parseObservationInput) };
    }
    case "metadata-patch":
      return {
        kind,
        entryId: parseEntryId(input.entryId ?? input.assetId),
        patch: parseMetadataPatch(input.patch),
      };
    case "album-create":
      return {
        kind,
        albumId: stringValue(input.albumId, "albumId"),
        name: stringValue(input.name, "album name", true),
        position: integer(input.position, "album position"),
        createdAt: finiteNumber(input.createdAt, "album createdAt"),
        updatedAt: finiteNumber(input.updatedAt, "album updatedAt"),
      };
    case "album-rename":
      return { kind, albumId: stringValue(input.albumId, "albumId"), name: stringValue(input.name, "album name", true), updatedAt: finiteNumber(input.updatedAt, "album updatedAt") };
    case "album-delete":
      return { kind, albumId: stringValue(input.albumId, "albumId") };
    case "album-membership-replace": {
      const ids = input.entryIds ?? input.assetIds;
      if (!Array.isArray(ids)) return fail("album entryIds are invalid");
      return { kind, albumId: stringValue(input.albumId, "albumId"), entryIds: ids.map((item) => parseEntryId(item)) };
    }
    case "archive-set":
      return { kind, entryId: parseEntryId(input.entryId ?? input.assetId), archived: booleanValue(input.archived, "archived") };
    case "library-state-replace":
      return { kind, stateJson: parseLibraryStateJson(input.stateJson, "library state") };
    case "fingerprint-set":
      return { kind, fingerprint: parseFingerprint(input.fingerprint) };
    case "preset-upsert":
      return {
        kind,
        presetId: parsePresetId(input.presetId),
        name: stringValue(input.name, "preset name"),
        payload: parsePresetPayload(input.payload),
        createdAt: finiteNumber(input.createdAt, "preset createdAt"),
        updatedAt: finiteNumber(input.updatedAt, "preset updatedAt"),
      };
    case "preset-rename":
      return { kind, presetId: parsePresetId(input.presetId), name: stringValue(input.name, "preset name"), updatedAt: finiteNumber(input.updatedAt, "preset updatedAt") };
    case "preset-delete":
      return { kind, presetId: parsePresetId(input.presetId) };
    case "preset-set-default":
      return { kind, presetId: parsePresetId(input.presetId), updatedAt: finiteNumber(input.updatedAt, "preset updatedAt") };
    case "rule-upsert":
      return {
        kind,
        ruleId: parseRuleId(input.ruleId),
        name: stringValue(input.name, "rule name"),
        enabled: booleanValue(input.enabled, "rule enabled"),
        destinationRootId: parseRootId(input.destinationRootId),
        presetId: parsePresetId(input.presetId),
        config: parseCatalogLiveAutoImportConfig(input.config),
        createdAt: finiteNumber(input.createdAt, "rule createdAt"),
        updatedAt: finiteNumber(input.updatedAt, "rule updatedAt"),
      };
    case "rule-delete":
      return { kind, ruleId: parseRuleId(input.ruleId) };
    case "operation-upsert": {
      const operation = record(input.operation, "operation");
      return {
        kind,
        operation: {
          operationId: parseOperationId(operation.operationId),
          kind: stringValue(operation.kind, "operation.kind"),
          state: enumValue(operation.state, "operation.state", ["planned", "running", "completed", "failed", "cancelled"] as const),
          payload: parseOperationPayload(operation.payload),
          createdAt: finiteNumber(operation.createdAt, "operation.createdAt"),
          updatedAt: finiteNumber(operation.updatedAt, "operation.updatedAt"),
        },
      };
    }
    case "operation-item-upsert": {
      const item = record(input.item, "operation item");
      const state = enumValue(item.state, "operation item.state", ["planned", "running", "completed", "failed", "cancelled"] as const);
      const payload = parseOperationItemPayload(item.payload);
      assertItemStateStage(state, payload.stage);
      return {
        kind,
        item: {
          operationId: parseOperationId(item.operationId),
          itemId: stringValue(item.itemId, "operation item.itemId"),
          assetId: item.assetId === null ? null : parseAssetId(item.assetId),
          state,
          payload,
        },
      };
    }
    case "asset-relocate":
      {
        const observation = parseObservation(input.observation, "asset relocate observation");
        const health = parseAssetHealth(input.health, "asset relocate health");
        if (health === "present" && observation === null) return fail("present asset relocate needs an observation");
        return { kind, assetId: parseAssetId(input.assetId), rootId: parseRootId(input.rootId), relativePath: parseCatalogLiveRelativePath(input.relativePath), observation, health };
      }
    case "asset-copy":
      {
        const observation = parseObservation(input.observation, "asset copy observation");
        const health = parseAssetHealth(input.health, "asset copy health");
        if (health === "present" && observation === null) return fail("present asset copy needs an observation");
        return {
          kind,
          sourceAssetId: parseAssetId(input.sourceAssetId),
          newAssetId: parseAssetId(input.newAssetId),
          rootId: parseRootId(input.rootId),
          relativePath: parseCatalogLiveRelativePath(input.relativePath),
          observation,
          health,
        };
      }
    default:
      return fail(`unknown mutation ${kind}`);
  }
}

export function parseCatalogLiveQueryInput(value: unknown): CatalogLiveQueryInput {
  const input = record(value, "query input");
  return {
    catalogId: parseCatalogId(input.catalogId),
    expectedRevision: input.expectedRevision === undefined || input.expectedRevision === null
      ? null
      : integer(input.expectedRevision, "expectedRevision"),
    ...(input.assetId === undefined ? {} : { assetId: parseAssetId(input.assetId) }),
    ...(input.entryId === undefined ? {} : { entryId: parseEntryId(input.entryId) }),
    ...(input.rootId === undefined ? {} : { rootId: parseRootId(input.rootId) }),
    ...(input.fingerprintSha256 === undefined ? {} : { fingerprintSha256: hash(input.fingerprintSha256, "fingerprintSha256") }),
  };
}

export function parseCatalogLiveRootInput(value: unknown): CatalogLiveRootInput {
  return parseRootInput(value);
}

export function parseCatalogLiveCreateInput(value: unknown): CatalogLiveCreateInput {
  const input = record(value, "create input");
  return {
    catalogId: parseCatalogId(input.catalogId),
    displayName: stringValue(input.displayName, "displayName"),
    appVersion: stringValue(input.appVersion, "appVersion"),
    root: parseRootInput(input.root),
    ...(input.now === undefined ? {} : { now: finiteNumber(input.now, "now") }),
  };
}

export function parseCatalogLiveApplyInput(value: unknown): CatalogLiveApplyInput {
  const input = record(value, "apply input");
  if (!Array.isArray(input.mutations) || input.mutations.length > CATALOG_LIVE_MAX_MUTATIONS) return fail("mutation batch size is invalid");
  return {
    catalogId: parseCatalogId(input.catalogId),
    expectedRevision: integer(input.expectedRevision, "expectedRevision"),
    mutations: input.mutations.map(parseMutation),
    ...(input.now === undefined ? {} : { now: finiteNumber(input.now, "now") }),
  };
}

export function parseCatalogLiveQueryResult(value: unknown): CatalogLiveState {
  return parseState(value);
}

export function parseCatalogLiveApplyResult(value: unknown): CatalogLiveApplyResult {
  const input = record(value, "apply result");
  return {
    catalogId: parseCatalogId(input.catalogId),
    revision: integer(input.revision, "apply result.revision"),
    changed: booleanValue(input.changed, "apply result.changed"),
    appliedMutations: integer(input.appliedMutations, "apply result.appliedMutations"),
    auditId: input.auditId === null ? null : integer(input.auditId, "apply result.auditId"),
  };
}

export function defaultCatalogLiveMetadata(now: number): CatalogV3AssetMetadata {
  return {
    archive: false,
    pick: "none",
    rating: 0,
    colorLabel: null,
    developJson: null,
    developUpdatedAt: 0,
    updatedAt: now,
    title: null,
    caption: null,
    copyright: null,
    keywordsJson: "[]",
    rawXmp: null,
    xmpState: "unknown",
    xmpMtime: null,
    xmpSha256: null,
  };
}

export function parseCatalogLiveMutation(value: unknown): CatalogLiveMutation {
  return parseMutation(value);
}

export type { CatalogV3AssetHealth, CatalogV3FingerprintStatus, CatalogV3RootHealth, CatalogV3ScanState, CatalogV3WatchState, CatalogV3XmpState };

export function parseCatalogLiveOperationPayload(value: unknown): CatalogLiveOperationPayload {
  return parseOperationPayload(value);
}

export function parseCatalogLiveOperationItemPayload(value: unknown): CatalogLiveOperationItemPayload {
  return parseOperationItemPayload(value);
}

export function parseCatalogLivePresetPayload(value: unknown): CatalogLivePresetPayload {
  return parsePresetPayload(value);
}
