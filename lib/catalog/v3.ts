import {
  parseAssetId,
  parseCatalogId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type RootId,
} from "./ids.ts";
import type { ColorLabel, PickStatus, StarRating } from "./types.ts";

export const CATALOG_V3_SCHEMA_VERSION = 3;
export const CATALOG_V3_APPLICATION_ID = 1_146_243_891;
export const CATALOG_V3_MAX_ASSET_BATCH = 250;
export const CATALOG_V3_MAX_RELATION_BATCH = 250;
export const CATALOG_V3_MAX_PAGE_SIZE = 250;
export const CATALOG_V3_MAX_XMP_BYTES = 16 * 1024 * 1024;

export type CatalogV3InstallState = "staging" | "ready";
export type CatalogV3MigrationPhase =
  | "created"
  | "copying-assets"
  | "copying-relations"
  | "copied"
  | "validating"
  | "validated"
  | "failed";
export type CatalogV3AssetHealth = "present" | "missing" | "ambiguous" | "unreadable";
export type CatalogV3RootHealth = "online" | "missing" | "ambiguous" | "unreadable";
export type CatalogV3ScanState = "unknown" | "complete" | "partial" | "failed";
export type CatalogV3WatchState = "disabled" | "active" | "error";
export type CatalogV3FingerprintStatus =
  | "missing"
  | "hashing"
  | "valid"
  | "stale"
  | "failed";
export type CatalogV3XmpState = "unknown" | "absent" | "preserved" | "malformed";

export interface CatalogV3ExpectedCounts {
  readonly assets: number;
  readonly metadata: number;
  readonly albums: number;
  readonly albumAssets: number;
  readonly archived: number;
  readonly aliases: number;
  readonly fingerprints: number;
  readonly present: number;
  readonly missing: number;
}

export interface CatalogV3RootInput {
  readonly rootId: RootId;
  readonly label: string;
  readonly configuredPath: string;
  readonly canonicalPath: string | null;
  readonly health: CatalogV3RootHealth;
  readonly scanState: CatalogV3ScanState;
  readonly watchState: CatalogV3WatchState;
}

export interface CatalogV3MigrationInput {
  readonly migrationId: string;
  readonly sourceVersion: 1 | 2;
  readonly catalogPath: string;
  readonly settingsPath: string | null;
  readonly catalogSha256: string;
  readonly settingsSha256: string | null;
  readonly rootAvailable: boolean;
  readonly expectedCounts: CatalogV3ExpectedCounts;
  readonly expectedStateSha256: string;
}

export interface CatalogV3InstallInput {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly appVersion: string;
  readonly root: CatalogV3RootInput;
  readonly migration: CatalogV3MigrationInput;
  readonly now?: number;
}

export interface CatalogV3Observation {
  readonly byteLength: number | null;
  readonly modifiedAt: number | null;
  readonly observedAt: number;
  readonly localFileId: string | null;
}

export interface CatalogV3FingerprintInput {
  readonly status: CatalogV3FingerprintStatus;
  readonly sha256: string | null;
  readonly observedAt?: number | null;
  readonly observedByteLength?: number | null;
  readonly observedModifiedAt?: number | null;
  readonly localFileId?: string | null;
}

export interface CatalogV3MetadataInput {
  readonly archive: boolean;
  readonly pick: PickStatus;
  readonly rating: StarRating;
  readonly colorLabel: ColorLabel;
  readonly developJson: string | null;
  readonly developUpdatedAt: number;
  readonly updatedAt: number;
  readonly title: string | null;
  readonly caption: string | null;
  readonly copyright: string | null;
  readonly keywordsJson: string;
  readonly rawXmp: string | null;
  readonly xmpState: CatalogV3XmpState;
  readonly xmpMtime: number | null;
  readonly xmpSha256: string | null;
}

export interface CatalogV3AssetCandidate {
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly observation: CatalogV3Observation | null;
  readonly health: CatalogV3AssetHealth;
  readonly formatId: string;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  readonly lensModel: string | null;
  readonly legacyIds: readonly string[];
  readonly metadata: CatalogV3MetadataInput | null;
  readonly fingerprint?: CatalogV3FingerprintInput;
}

export interface CatalogV3AssetBatchInput {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly assets: readonly CatalogV3AssetCandidate[];
}

export interface CatalogV3AlbumInput {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly position: number;
  readonly positionOffset: number;
  readonly entryIds: readonly string[];
}

export interface CatalogV3RelationsBatchInput {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly albums: readonly CatalogV3AlbumInput[];
  readonly archiveLegacyIds: readonly string[];
}

export interface CatalogV3AssetMapping {
  readonly legacyIds: readonly string[];
  readonly relativePath: string;
  readonly assetId: AssetId;
  readonly fingerprintId: string;
}

export interface CatalogV3AssetBatchResult {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly revision: number;
  readonly assets: readonly CatalogV3AssetMapping[];
}

export interface CatalogV3InstallResult {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly created: boolean;
  readonly installState: CatalogV3InstallState;
  readonly revision: number;
  readonly schemaVersion: number;
}

export interface CatalogV3RelationsBatchResult {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly revision: number;
  readonly albums: number;
  readonly albumAssets: number;
  readonly archived: number;
}

export interface CatalogV3FinishCopyResult {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly phase: CatalogV3MigrationPhase;
  readonly revision: number;
}

export interface CatalogV3FingerprintCoverage {
  readonly total: number;
  readonly missing: number;
  readonly hashing: number;
  readonly valid: number;
  readonly stale: number;
  readonly failed: number;
}

export interface CatalogV3Counts extends CatalogV3ExpectedCounts {
  readonly ambiguous: number;
  readonly unreadable: number;
}

export interface CatalogV3IntegrityResult {
  readonly integrityCheck: readonly string[];
  readonly foreignKeyCheck: readonly {
    readonly table: string;
    readonly rowId: number | null;
    readonly parent: string;
    readonly foreignKeyIndex: number;
  }[];
}

export interface CatalogV3ValidationReport {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly clean: boolean;
  readonly before: CatalogV3ExpectedCounts;
  readonly after: CatalogV3Counts;
  readonly fingerprintCoverage: CatalogV3FingerprintCoverage;
  readonly expectedStateSha256: string;
  readonly actualStateSha256: string;
  readonly relationFailures: {
    readonly aliases: number;
    readonly albums: number;
    readonly albumAssets: number;
    readonly archived: number;
  };
  readonly integrity: CatalogV3IntegrityResult;
  readonly applicationId: number;
  readonly schemaVersion: number;
  readonly userVersion: number;
  readonly limitations: readonly string[];
  readonly blockingErrors: readonly string[];
}

export interface CatalogV3ValidationResult {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly phase: CatalogV3MigrationPhase;
  readonly report: CatalogV3ValidationReport;
  readonly revision: number;
}

export interface CatalogV3ActivationResult {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly installState: CatalogV3InstallState;
  readonly revision: number;
}

export interface CatalogV3SealForInstallResult {
  readonly catalogId: CatalogId;
  readonly migrationId: string;
  readonly busy: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
  readonly journalMode: "delete";
}

export interface CatalogV3Summary {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly appVersion: string;
  readonly installState: CatalogV3InstallState;
  readonly revision: number;
  readonly migrationId: string;
  readonly migrationPhase: CatalogV3MigrationPhase;
  readonly sourceVersion: 1 | 2;
  readonly migration: CatalogV3MigrationInput;
  readonly root: CatalogV3RootInput;
  readonly counts: CatalogV3Counts;
  readonly fingerprintCoverage: CatalogV3FingerprintCoverage;
}

export interface CatalogV3AssetMetadata {
  readonly archive: boolean;
  readonly pick: PickStatus;
  readonly rating: StarRating;
  readonly colorLabel: ColorLabel;
  readonly developJson: string | null;
  readonly developUpdatedAt: number;
  readonly updatedAt: number;
  readonly title: string | null;
  readonly caption: string | null;
  readonly copyright: string | null;
  readonly keywordsJson: string;
  readonly rawXmp: string | null;
  readonly xmpState: CatalogV3XmpState;
  readonly xmpMtime: number | null;
  readonly xmpSha256: string | null;
}

export interface CatalogV3AssetSnapshot {
  readonly catalogId: CatalogId;
  readonly assetId: AssetId;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly observation: CatalogV3Observation | null;
  readonly revision: number;
  readonly health: CatalogV3AssetHealth;
  readonly formatId: string | null;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  readonly lensModel: string | null;
  readonly fingerprintId: string;
  readonly fingerprintStatus: CatalogV3FingerprintStatus;
  readonly fingerprintSha256: string | null;
  readonly fingerprintObservedAt: number | null;
  readonly fingerprintObservedByteLength: number | null;
  readonly fingerprintObservedModifiedAt: number | null;
  readonly fingerprintLocalFileId: string | null;
  readonly metadata: CatalogV3AssetMetadata;
}

export interface CatalogV3AssetPageInput {
  readonly catalogId: CatalogId;
  readonly expectedRevision: number | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface CatalogV3AssetPage {
  readonly catalogId: CatalogId;
  readonly revision: number;
  readonly assets: readonly CatalogV3AssetSnapshot[];
  readonly nextCursor: string | null;
}

export interface CatalogV3AlbumPageInput {
  readonly catalogId: CatalogId;
  readonly expectedRevision: number | null;
  readonly cursor: number | null;
  readonly limit: number;
}

export interface CatalogV3AlbumSnapshot {
  readonly catalogId: CatalogId;
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly position: number;
}

export interface CatalogV3AlbumSnapshotResult {
  readonly catalogId: CatalogId;
  readonly revision: number;
  readonly albums: readonly CatalogV3AlbumSnapshot[];
  readonly nextCursor: number | null;
}

export interface CatalogV3AlbumAssetPageInput {
  readonly catalogId: CatalogId;
  readonly albumId: string;
  readonly expectedRevision: number | null;
  readonly cursor: number | null;
  readonly limit: number;
}

export interface CatalogV3AlbumAssetSnapshot {
  readonly position: number;
  readonly assetId: AssetId;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly health: CatalogV3AssetHealth;
  readonly revision: number;
}

export interface CatalogV3AlbumAssetPage {
  readonly catalogId: CatalogId;
  readonly albumId: string;
  readonly revision: number;
  readonly assets: readonly CatalogV3AlbumAssetSnapshot[];
  readonly nextCursor: number | null;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Catalog v3 ${message}.`);
}

function stringValue(record: RecordValue, key: string, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return fail(`${key} is invalid`);
  }
  return value;
}

function nullableString(record: RecordValue, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "string" ? value : fail(`${key} is invalid`);
}

function finiteNumber(record: RecordValue, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(`${key} is invalid`);
  }
  return value;
}

function nonnegativeInteger(record: RecordValue, key: string): number {
  const value = finiteNumber(record, key);
  if (!Number.isInteger(value) || value < 0) return fail(`${key} is invalid`);
  return value;
}

function nullableFiniteNumber(record: RecordValue, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(`${key} is invalid`);
}

function booleanValue(record: RecordValue, key: string): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fail(`${key} is invalid`);
}

function enumValue<T extends string>(record: RecordValue, key: string, values: readonly T[]): T {
  const value = record[key];
  return typeof value === "string" && values.includes(value as T)
    ? value as T
    : fail(`${key} is invalid`);
}

function nullableEnumValue<T extends string>(
  record: RecordValue,
  key: string,
  values: readonly T[],
): T | null {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "string" && values.includes(value as T)
    ? value as T
    : fail(`${key} is invalid`);
}

function stringArray(record: RecordValue, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return fail(`${key} is invalid`);
  }
  return value;
}

function uuidString(value: unknown, label: string): string {
  if (typeof value !== "string") return fail(`${label} is invalid`);
  const parsed = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(value);
  if (!parsed || value !== value.toLowerCase()) return fail(`${label} is invalid`);
  return value;
}

function hashString(record: RecordValue, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    return fail(`${key} is invalid`);
  }
  return value;
}

function requiredHash(record: RecordValue, key: string): string {
  const value = hashString(record, key);
  return value === null ? fail(`${key} is invalid`) : value;
}

function normalizedAbsolutePath(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    return fail(`${key} is invalid`);
  }
  if (value.startsWith("/")) {
    if (value === "/") return value;
    if (value.startsWith("//") || (value.length > 1 && value.endsWith("/"))) {
      return fail(`${key} is invalid`);
    }
    const segments = value.slice(1).split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      return fail(`${key} is invalid`);
    }
    return value;
  }
  const drive = /^([A-Za-z]):([\\/])/.exec(value);
  if (!drive) return fail(`${key} is invalid`);
  const separator = drive[2];
  if (value.includes(separator === "/" ? "\\" : "/")) return fail(`${key} is invalid`);
  if (value.length === 3) return value;
  if (value.length > 3 && value.endsWith(separator)) return fail(`${key} is invalid`);
  const segments = value.slice(3).split(separator);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return fail(`${key} is invalid`);
  }
  return value;
}

function normalizedRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    return fail("relativePath is invalid");
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return fail("relativePath is invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return fail("relativePath is invalid");
  }
  if (value.includes("\\")) return fail("relativePath is invalid");
  return value;
}

function jsonText(record: RecordValue, key: string, nullable: boolean): string | null {
  const value = record[key];
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !jsonValid(value)) return fail(`${key} is invalid`);
  return value;
}

function jsonValid(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

const rootHealth = ["online", "missing", "ambiguous", "unreadable"] as const;
const scanStates = ["unknown", "complete", "partial", "failed"] as const;
const watchStates = ["disabled", "active", "error"] as const;
const assetHealth = ["present", "missing", "ambiguous", "unreadable"] as const;
const fingerprintStatuses = ["missing", "hashing", "valid", "stale", "failed"] as const;
const xmpStates = ["unknown", "absent", "preserved", "malformed"] as const;

export function parseCatalogV3ExpectedCounts(value: unknown): CatalogV3ExpectedCounts {
  if (!isRecord(value)) return fail("expectedCounts must be an object");
  return {
    assets: nonnegativeInteger(value, "assets"),
    metadata: nonnegativeInteger(value, "metadata"),
    albums: nonnegativeInteger(value, "albums"),
    albumAssets: nonnegativeInteger(value, "albumAssets"),
    archived: nonnegativeInteger(value, "archived"),
    aliases: nonnegativeInteger(value, "aliases"),
    fingerprints: nonnegativeInteger(value, "fingerprints"),
    present: nonnegativeInteger(value, "present"),
    missing: nonnegativeInteger(value, "missing"),
  };
}

function parseRoot(value: unknown): CatalogV3RootInput {
  if (!isRecord(value)) return fail("root must be an object");
  const health = enumValue(value, "health", rootHealth);
  const canonicalPath = nullableString(value, "canonicalPath");
  if (health === "online" && canonicalPath === null) return fail("online roots need canonicalPath");
  return {
    rootId: parseRootId(value.rootId),
    label: stringValue(value, "label"),
    configuredPath: normalizedAbsolutePath(value.configuredPath, "configuredPath"),
    canonicalPath: canonicalPath === null
      ? null
      : normalizedAbsolutePath(canonicalPath, "canonicalPath"),
    health,
    scanState: enumValue(value, "scanState", scanStates),
    watchState: enumValue(value, "watchState", watchStates),
  };
}

function parseMigration(value: unknown): CatalogV3MigrationInput {
  if (!isRecord(value)) return fail("migration must be an object");
  const sourceVersion = value.sourceVersion;
  if (sourceVersion !== 1 && sourceVersion !== 2) return fail("sourceVersion is invalid");
  const settingsPath = nullableString(value, "settingsPath");
  const settingsSha256 = hashString(value, "settingsSha256");
  if ((settingsPath === null) !== (settingsSha256 === null)) return fail("settings path and hash must be paired");
  return {
    migrationId: uuidString(value.migrationId, "migrationId"),
    sourceVersion,
    catalogPath: normalizedAbsolutePath(value.catalogPath, "catalogPath"),
    settingsPath: settingsPath === null
      ? null
      : normalizedAbsolutePath(settingsPath, "settingsPath"),
    catalogSha256: requiredHash(value, "catalogSha256"),
    settingsSha256,
    rootAvailable: booleanValue(value, "rootAvailable"),
    expectedCounts: parseCatalogV3ExpectedCounts(value.expectedCounts),
    expectedStateSha256: requiredHash(value, "expectedStateSha256"),
  };
}

export function parseCatalogV3InstallInput(value: unknown): CatalogV3InstallInput {
  if (!isRecord(value)) return fail("install input must be an object");
  const now = value.now === undefined ? undefined : finiteNumber(value, "now");
  const root = parseRoot(value.root);
  const migration = parseMigration(value.migration);
  if (migration.rootAvailable !== (root.health === "online")) {
    return fail("root availability does not match root health");
  }
  return {
    catalogId: parseCatalogId(value.catalogId),
    displayName: stringValue(value, "displayName"),
    appVersion: stringValue(value, "appVersion"),
    root,
    migration,
    ...(now === undefined ? {} : { now }),
  };
}

function parseObservation(value: unknown): CatalogV3Observation | null {
  if (value === null) return null;
  if (!isRecord(value)) return fail("observation is invalid");
  return {
    byteLength: nonnegativeInteger(value, "byteLength"),
    modifiedAt: finiteNumber(value, "modifiedAt"),
    observedAt: finiteNumber(value, "observedAt"),
    localFileId: nullableString(value, "localFileId"),
  };
}

function parseFingerprint(value: unknown): CatalogV3FingerprintInput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return fail("fingerprint is invalid");
  const status = enumValue(value, "status", fingerprintStatuses);
  const sha256 = hashString(value, "sha256");
  const observedAt = value.observedAt === undefined ? null : nullableFiniteNumber(value, "observedAt");
  const observedByteLength = value.observedByteLength === undefined ? null : nullableFiniteNumber(value, "observedByteLength");
  const observedModifiedAt = value.observedModifiedAt === undefined ? null : nullableFiniteNumber(value, "observedModifiedAt");
  const localFileId = value.localFileId === undefined ? null : nullableString(value, "localFileId");
  if (observedByteLength !== null && (!Number.isInteger(observedByteLength) || observedByteLength < 0)) {
    return fail("observedByteLength is invalid");
  }
  if (status === "valid" && sha256 === null) return fail("valid fingerprint needs sha256");
  if (status !== "valid" && sha256 !== null) return fail("only valid fingerprints may have sha256");
  return { status, sha256, observedAt, observedByteLength, observedModifiedAt, localFileId };
}

function parseMetadata(value: unknown): CatalogV3MetadataInput | null {
  if (value === null) return null;
  if (!isRecord(value)) return fail("metadata is invalid");
  const pick = enumValue(value, "pick", ["none", "pick", "reject"] as const);
  const rating = nonnegativeInteger(value, "rating");
  if (rating > 5) return fail("rating is invalid");
  const colorLabel = nullableEnumValue(value, "colorLabel", ["red", "yellow", "green", "blue", "purple"] as const);
  const developJson = jsonText(value, "developJson", true);
  const keywordsJson = jsonText(value, "keywordsJson", false);
  if (keywordsJson === null) return fail("keywordsJson is invalid");
  const rawXmp = nullableString(value, "rawXmp");
  if (rawXmp !== null && new TextEncoder().encode(rawXmp).byteLength > CATALOG_V3_MAX_XMP_BYTES) {
    return fail("rawXmp is too large");
  }
  const xmpState = enumValue(value, "xmpState", xmpStates);
  const xmpSha256 = hashString(value, "xmpSha256");
  if (xmpState === "preserved" && rawXmp === null) return fail("preserved XMP needs rawXmp");
  if (xmpState === "absent" && rawXmp !== null) return fail("absent XMP cannot have rawXmp");
  return {
    archive: booleanValue(value, "archive"),
    pick,
    rating: rating as StarRating,
    colorLabel,
    developJson,
    developUpdatedAt: finiteNumber(value, "developUpdatedAt"),
    updatedAt: finiteNumber(value, "updatedAt"),
    title: nullableString(value, "title"),
    caption: nullableString(value, "caption"),
    copyright: nullableString(value, "copyright"),
    keywordsJson,
    rawXmp,
    xmpState,
    xmpMtime: nullableFiniteNumber(value, "xmpMtime"),
    xmpSha256,
  };
}

function parseAssetCandidate(value: unknown): CatalogV3AssetCandidate {
  if (!isRecord(value)) return fail("asset candidate is invalid");
  const legacyIds = stringArray(value, "legacyIds");
  const fingerprint = parseFingerprint(value.fingerprint);
  const observation = parseObservation(value.observation);
  const health = enumValue(value, "health", assetHealth);
  if ((health === "present") !== (observation !== null)) {
    return fail("asset health and observation do not match");
  }
  return {
    rootId: parseRootId(value.rootId),
    relativePath: normalizedRelativePath(value.relativePath),
    observation,
    health,
    formatId: stringValue(value, "formatId"),
    cameraMake: nullableString(value, "cameraMake"),
    cameraModel: nullableString(value, "cameraModel"),
    lensModel: nullableString(value, "lensModel"),
    legacyIds,
    metadata: parseMetadata(value.metadata),
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

export function parseCatalogV3AssetBatchInput(value: unknown): CatalogV3AssetBatchInput {
  if (!isRecord(value) || !Array.isArray(value.assets)) return fail("asset batch is invalid");
  if (value.assets.length > CATALOG_V3_MAX_ASSET_BATCH) {
    return fail("asset batch size is invalid");
  }
  return {
    catalogId: parseCatalogId(value.catalogId),
    migrationId: uuidString(value.migrationId, "migrationId"),
    assets: value.assets.map(parseAssetCandidate),
  };
}

function parseAlbum(value: unknown): CatalogV3AlbumInput {
  if (!isRecord(value)) return fail("album is invalid");
  const entryIds = stringArray(value, "entryIds");
  const positionOffset = value.positionOffset === undefined
    ? 0
    : nonnegativeInteger(value, "positionOffset");
  if (positionOffset > Number.MAX_SAFE_INTEGER - entryIds.length) {
    return fail("positionOffset is invalid");
  }
  return {
    id: stringValue(value, "id"),
    name: stringValue(value, "name", true),
    createdAt: finiteNumber(value, "createdAt"),
    updatedAt: finiteNumber(value, "updatedAt"),
    position: nonnegativeInteger(value, "position"),
    positionOffset,
    entryIds,
  };
}

export function parseCatalogV3RelationsBatchInput(value: unknown): CatalogV3RelationsBatchInput {
  if (!isRecord(value) || !Array.isArray(value.albums)) return fail("relations batch is invalid");
  const albums = value.albums.map(parseAlbum);
  const archiveLegacyIds = stringArray(value, "archiveLegacyIds");
  const relationCount = albums.reduce((total, album) => total + album.entryIds.length, 0) + albums.length + archiveLegacyIds.length;
  if (relationCount > CATALOG_V3_MAX_RELATION_BATCH) return fail("relations batch size is invalid");
  return {
    catalogId: parseCatalogId(value.catalogId),
    migrationId: uuidString(value.migrationId, "migrationId"),
    albums,
    archiveLegacyIds,
  };
}

export function parseCatalogV3AssetPageInput(value: unknown): CatalogV3AssetPageInput {
  if (!isRecord(value)) return fail("asset page input is invalid");
  const expectedRevision = value.expectedRevision === undefined || value.expectedRevision === null
    ? null
    : nonnegativeInteger(value, "expectedRevision");
  const cursor = value.cursor === undefined ? null : parseCursor(value.cursor);
  const limit = nonnegativeInteger(value, "limit");
  if (limit < 1 || limit > CATALOG_V3_MAX_PAGE_SIZE) return fail("limit is invalid");
  return {
    catalogId: parseCatalogId(value.catalogId),
    expectedRevision,
    cursor,
    limit,
  };
}

function parseCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return fail("cursor is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return fail("cursor is invalid");
  }
  if (!isRecord(decoded) || typeof decoded.relativePath !== "string" || decoded.relativePath.length === 0) {
    return fail("cursor is invalid");
  }
  parseAssetId(decoded.assetId);
  return value;
}

export function parseCatalogV3AssetCursor(value: unknown): string {
  const cursor = parseCursor(value);
  return cursor === null ? fail("cursor is invalid") : cursor;
}

export function parseCatalogV3AlbumPageInput(value: unknown): CatalogV3AlbumPageInput {
  if (!isRecord(value)) return fail("album page input is invalid");
  const limit = nonnegativeInteger(value, "limit");
  if (limit < 1 || limit > CATALOG_V3_MAX_PAGE_SIZE) return fail("limit is invalid");
  return {
    catalogId: parseCatalogId(value.catalogId),
    expectedRevision: value.expectedRevision === undefined || value.expectedRevision === null
      ? null
      : nonnegativeInteger(value, "expectedRevision"),
    cursor: value.cursor === undefined || value.cursor === null
      ? null
      : nonnegativeInteger(value, "cursor"),
    limit,
  };
}

export function parseCatalogV3AlbumAssetPageInput(value: unknown): CatalogV3AlbumAssetPageInput {
  if (!isRecord(value)) return fail("album asset page input is invalid");
  const limit = nonnegativeInteger(value, "limit");
  if (limit < 1 || limit > CATALOG_V3_MAX_PAGE_SIZE) return fail("limit is invalid");
  return {
    catalogId: parseCatalogId(value.catalogId),
    albumId: stringValue(value, "albumId"),
    expectedRevision: value.expectedRevision === undefined || value.expectedRevision === null
      ? null
      : nonnegativeInteger(value, "expectedRevision"),
    cursor: value.cursor === undefined || value.cursor === null
      ? null
      : nonnegativeInteger(value, "cursor"),
    limit,
  };
}

export function parseCatalogV3CatalogId(value: unknown): CatalogId {
  return parseCatalogId(value);
}

export function parseCatalogV3AssetId(value: unknown): AssetId {
  return parseAssetId(value);
}

export function parseCatalogV3RootId(value: unknown): RootId {
  return parseRootId(value);
}
