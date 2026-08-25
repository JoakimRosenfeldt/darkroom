import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  createAssetId,
  parseAssetId,
  parseCatalogId,
  parseRootId,
  type AssetId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  CATALOG_V3_MAX_ASSET_BATCH,
  parseCatalogV3AlbumAssetPageInput,
  parseCatalogV3AlbumPageInput,
  parseCatalogV3AssetBatchInput,
  parseCatalogV3AssetPageInput,
  parseCatalogV3ExpectedCounts,
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
  type CatalogV3AssetCandidate,
  type CatalogV3AssetMapping,
  type CatalogV3AssetMetadata,
  type CatalogV3AssetPage,
  type CatalogV3AssetPageInput,
  type CatalogV3AssetSnapshot,
  type CatalogV3Counts,
  type CatalogV3ExpectedCounts,
  type CatalogV3FinishCopyResult,
  type CatalogV3FingerprintCoverage,
  type CatalogV3FingerprintInput,
  type CatalogV3InstallInput,
  type CatalogV3InstallResult,
  type CatalogV3IntegrityResult,
  type CatalogV3MigrationInput,
  type CatalogV3MigrationPhase,
  type CatalogV3MetadataInput,
  type CatalogV3RelationsBatchInput,
  type CatalogV3RelationsBatchResult,
  type CatalogV3RootInput,
  type CatalogV3SealForInstallResult,
  type CatalogV3Summary,
  type CatalogV3ValidationReport,
  type CatalogV3ValidationResult,
  type CatalogV3XmpState,
} from "../lib/catalog/v3.ts";
import type { ColorLabel, PickStatus, StarRating } from "../lib/catalog/types.ts";
import {
  installCatalogV3Schema,
  isCatalogV3DatabaseEmpty,
  upgradeCatalogV3IdentitySchema,
  verifyCatalogV3Schema,
} from "./catalog-v3-schema.ts";
import {
  CatalogV3StateDigest,
  CATALOG_V3_DEFAULT_METADATA,
  type CatalogV3StateLocation,
} from "./catalog-v3-state.ts";

type Row = Record<string, unknown>;

interface CatalogRow {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly appVersion: string;
  readonly installState: "staging" | "ready";
  readonly revision: number;
}

interface MigrationRow extends CatalogV3MigrationInput {
  readonly phase: CatalogV3MigrationPhase;
  readonly validationReportJson: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ExistingAsset {
  readonly assetId: AssetId;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly observedByteLength: number | null;
  readonly observedModifiedAt: number | null;
  readonly observedAt: number | null;
  readonly localFileId: string | null;
  readonly revision: number;
  readonly health: CatalogV3AssetCandidate["health"];
  readonly formatId: string;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  readonly lensModel: string | null;
}

type ExistingMetadata = CatalogV3AssetMetadata;

interface ExistingFingerprint {
  readonly fingerprintId: string;
  readonly status: CatalogV3FingerprintInput["status"];
  readonly sha256: string | null;
  readonly observedAt: number | null;
  readonly observedByteLength: number | null;
  readonly observedModifiedAt: number | null;
  readonly localFileId: string | null;
}

interface LegacyAlias {
  readonly assetId: AssetId;
  readonly rootId: RootId;
  readonly relativePath: string;
}

interface Cursor {
  readonly relativePath: string;
  readonly assetId: AssetId;
}

const ASSET_SNAPSHOT_SELECT = `
  SELECT
    a.catalog_id AS catalogId,
    a.asset_id AS assetId,
    a.root_id AS rootId,
    a.relative_path AS relativePath,
    a.observed_byte_length AS observedByteLength,
    a.observed_modified_at AS observedModifiedAt,
    a.observed_at AS observedAt,
    a.local_file_id AS localFileId,
    a.revision AS assetRevision,
    a.health,
    a.format_id AS formatId,
    a.camera_make AS cameraMake,
    a.camera_model AS cameraModel,
    a.lens_model AS lensModel,
    f.fingerprint_id AS fingerprintId,
    f.status AS fingerprintStatus,
    f.sha256 AS fingerprintSha256,
    f.observed_at AS fingerprintObservedAt,
    f.observed_byte_length AS fingerprintObservedByteLength,
    f.observed_modified_at AS fingerprintObservedModifiedAt,
    f.local_file_id AS fingerprintLocalFileId,
    m.archive,
    m.pick,
    m.rating,
    m.color_label AS colorLabel,
    m.develop_json AS developJson,
    m.develop_updated_at AS developUpdatedAt,
    m.updated_at AS updatedAt,
    m.title,
    m.caption,
    m.copyright,
    m.keywords_json AS keywordsJson,
    m.raw_xmp AS rawXmp,
    m.xmp_state AS xmpState,
    m.xmp_mtime AS xmpMtime,
    m.xmp_sha256 AS xmpSha256
  FROM assets AS a
  JOIN asset_metadata AS m ON m.catalog_id = a.catalog_id AND m.asset_id = a.asset_id
  JOIN fingerprints AS f ON f.catalog_id = a.catalog_id AND f.asset_id = a.asset_id
`;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function value(row: Row, key: string): unknown {
  return Reflect.get(row, key);
}

function stringValue(row: Row, key: string): string {
  const item = value(row, key);
  if (typeof item !== "string") throw new Error(`Catalog v3 ${key} result is invalid.`);
  return item;
}

function nullableStringValue(row: Row, key: string): string | null {
  const item = value(row, key);
  if (item === null) return null;
  return typeof item === "string" ? item : (() => {
    throw new Error(`Catalog v3 ${key} result is invalid.`);
  })();
}

function numberValue(row: Row, key: string): number {
  const item = value(row, key);
  if (typeof item !== "number" || !Number.isFinite(item)) {
    throw new Error(`Catalog v3 ${key} result is invalid.`);
  }
  return item;
}

function integerValue(row: Row, key: string): number {
  const item = numberValue(row, key);
  if (!Number.isInteger(item)) throw new Error(`Catalog v3 ${key} result is invalid.`);
  return item;
}

function nullableNumberValue(row: Row, key: string): number | null {
  const item = value(row, key);
  if (item === null) return null;
  return typeof item === "number" && Number.isFinite(item)
    ? item
    : (() => {
      throw new Error(`Catalog v3 ${key} result is invalid.`);
    })();
}

function booleanInteger(valueToParse: boolean): number {
  return valueToParse ? 1 : 0;
}

function boolFromInteger(row: Row, key: string): boolean {
  const item = integerValue(row, key);
  if (item !== 0 && item !== 1) throw new Error(`Catalog v3 ${key} result is invalid.`);
  return item === 1;
}

function jsonString(valueToSerialize: unknown, key: string): string {
  const serialized = JSON.stringify(valueToSerialize);
  if (serialized === undefined) throw new Error(`Catalog v3 ${key} must be JSON.`);
  return serialized;
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  return left === right || (left !== left && right !== right);
}

function assertNonnegativeInteger(valueToCheck: number, key: string): void {
  if (!Number.isInteger(valueToCheck) || valueToCheck < 0) {
    throw new Error(`Catalog v3 ${key} is invalid.`);
  }
}

function assertRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\u0000") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    /^[A-Za-z]:[\\/]/.test(relativePath)
  ) {
    throw new Error("Catalog v3 relative path is unsafe.");
  }
}

function assertHash(valueToCheck: string | null, key: string): void {
  if (valueToCheck !== null && !/^[0-9a-f]{64}$/.test(valueToCheck)) {
    throw new Error(`Catalog v3 ${key} is invalid.`);
  }
}

function metadataFromCandidate(candidate: CatalogV3AssetCandidate): CatalogV3AssetMetadata {
  return candidate.metadata ?? CATALOG_V3_DEFAULT_METADATA;
}

function fingerprintFromCandidate(candidate: CatalogV3AssetCandidate): CatalogV3FingerprintInput {
  const observation = candidate.observation;
  return candidate.fingerprint ?? {
    status: "missing",
    sha256: null,
    observedAt: observation?.observedAt ?? null,
    observedByteLength: observation?.byteLength ?? null,
    observedModifiedAt: observation?.modifiedAt ?? null,
    localFileId: observation?.localFileId ?? null,
  };
}

function parseCatalogRow(row: unknown): CatalogRow {
  if (!isRow(row)) throw new Error("Catalog v3 catalog row is missing.");
  const installState = stringValue(row, "installState");
  if (installState !== "staging" && installState !== "ready") {
    throw new Error("Catalog v3 install state is invalid.");
  }
  return {
    catalogId: parseCatalogId(stringValue(row, "catalogId")),
    displayName: stringValue(row, "displayName"),
    appVersion: stringValue(row, "appVersion"),
    installState,
    revision: integerValue(row, "revision"),
  };
}

function parseMigrationPhase(valueToParse: string): CatalogV3MigrationPhase {
  if (
    valueToParse !== "created" &&
    valueToParse !== "copying-assets" &&
    valueToParse !== "copying-relations" &&
    valueToParse !== "copied" &&
    valueToParse !== "validating" &&
    valueToParse !== "validated" &&
    valueToParse !== "failed"
  ) {
    throw new Error("Catalog v3 migration phase is invalid.");
  }
  return valueToParse;
}

function parseExpectedCountsJson(valueToParse: string): CatalogV3ExpectedCounts {
  try {
    return parseCatalogV3ExpectedCounts(JSON.parse(valueToParse));
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Catalog v3 expected counts are invalid.",
    );
  }
}

function parseMigrationRow(row: unknown): MigrationRow {
  if (!isRow(row)) throw new Error("Catalog v3 migration row is missing.");
  const sourceVersion = integerValue(row, "sourceVersion");
  if (sourceVersion !== 1 && sourceVersion !== 2) throw new Error("Catalog v3 source version is invalid.");
  const catalogSha256 = stringValue(row, "catalogSha256");
  const settingsSha256 = nullableStringValue(row, "settingsSha256");
  const expectedStateSha256 = stringValue(row, "expectedStateSha256");
  assertHash(catalogSha256, "catalogSha256");
  assertHash(settingsSha256, "settingsSha256");
  assertHash(expectedStateSha256, "expectedStateSha256");
  const catalogPath = stringValue(row, "catalogPath");
  const settingsPath = nullableStringValue(row, "settingsPath");
  if ((settingsPath === null) !== (settingsSha256 === null)) {
    throw new Error("Catalog v3 settings path and hash must be paired.");
  }
  return {
    migrationId: stringValue(row, "migrationId"),
    sourceVersion,
    catalogPath,
    settingsPath,
    catalogSha256,
    settingsSha256,
    rootAvailable: boolFromInteger(row, "rootAvailable"),
    expectedCounts: parseExpectedCountsJson(stringValue(row, "expectedCountsJson")),
    expectedStateSha256,
    phase: parseMigrationPhase(stringValue(row, "phase")),
    validationReportJson: nullableStringValue(row, "validationReportJson"),
    errorMessage: nullableStringValue(row, "errorMessage"),
    createdAt: numberValue(row, "createdAt"),
    updatedAt: numberValue(row, "updatedAt"),
  };
}

function parseExistingAsset(row: unknown): ExistingAsset {
  if (!isRow(row)) throw new Error("Catalog v3 asset row is missing.");
  const health = stringValue(row, "health");
  if (health !== "present" && health !== "missing" && health !== "ambiguous" && health !== "unreadable") {
    throw new Error("Catalog v3 asset health is invalid.");
  }
  return {
    assetId: parseAssetId(stringValue(row, "assetId")),
    rootId: parseRootId(stringValue(row, "rootId")),
    relativePath: stringValue(row, "relativePath"),
    observedByteLength: nullableNumberValue(row, "observedByteLength"),
    observedModifiedAt: nullableNumberValue(row, "observedModifiedAt"),
    observedAt: nullableNumberValue(row, "observedAt"),
    localFileId: nullableStringValue(row, "localFileId"),
    revision: integerValue(row, "revision"),
    health,
    formatId: stringValue(row, "formatId"),
    cameraMake: nullableStringValue(row, "cameraMake"),
    cameraModel: nullableStringValue(row, "cameraModel"),
    lensModel: nullableStringValue(row, "lensModel"),
  };
}

function parseExistingMetadata(row: unknown): ExistingMetadata {
  if (!isRow(row)) throw new Error("Catalog v3 metadata row is missing.");
  const pick = stringValue(row, "pick");
  const rating = integerValue(row, "rating");
  const colorLabel = nullableStringValue(row, "colorLabel");
  const xmpState = stringValue(row, "xmpState");
  if (pick !== "none" && pick !== "pick" && pick !== "reject") throw new Error("Catalog v3 pick is invalid.");
  if (rating < 0 || rating > 5) throw new Error("Catalog v3 rating is invalid.");
  if (colorLabel !== null && !["red", "yellow", "green", "blue", "purple"].includes(colorLabel)) {
    throw new Error("Catalog v3 color label is invalid.");
  }
  if (xmpState !== "unknown" && xmpState !== "absent" && xmpState !== "preserved" && xmpState !== "malformed") {
    throw new Error("Catalog v3 XMP state is invalid.");
  }
  return {
    archive: boolFromInteger(row, "archive"),
    pick: pick as PickStatus,
    rating: rating as StarRating,
    colorLabel: colorLabel as ColorLabel,
    developJson: nullableStringValue(row, "developJson"),
    developUpdatedAt: numberValue(row, "developUpdatedAt"),
    updatedAt: numberValue(row, "updatedAt"),
    title: nullableStringValue(row, "title"),
    caption: nullableStringValue(row, "caption"),
    copyright: nullableStringValue(row, "copyright"),
    keywordsJson: stringValue(row, "keywordsJson"),
    rawXmp: nullableStringValue(row, "rawXmp"),
    xmpState: xmpState as CatalogV3XmpState,
    xmpMtime: nullableNumberValue(row, "xmpMtime"),
    xmpSha256: nullableStringValue(row, "xmpSha256"),
  };
}

function parseExistingFingerprint(row: unknown): ExistingFingerprint {
  if (!isRow(row)) throw new Error("Catalog v3 fingerprint row is missing.");
  const status = stringValue(row, "status");
  if (status !== "missing" && status !== "hashing" && status !== "valid" && status !== "stale" && status !== "failed") {
    throw new Error("Catalog v3 fingerprint status is invalid.");
  }
  return {
    fingerprintId: stringValue(row, "fingerprintId"),
    status,
    sha256: nullableStringValue(row, "sha256"),
    observedAt: nullableNumberValue(row, "observedAt"),
    observedByteLength: nullableNumberValue(row, "observedByteLength"),
    observedModifiedAt: nullableNumberValue(row, "observedModifiedAt"),
    localFileId: nullableStringValue(row, "localFileId"),
  };
}

function parseAssetSnapshotRow(row: unknown): CatalogV3AssetSnapshot {
  if (!isRow(row)) throw new Error("Catalog v3 snapshot asset is missing its rows.");
  const health = stringValue(row, "health");
  const fingerprintStatus = stringValue(row, "fingerprintStatus");
  const xmpState = stringValue(row, "xmpState");
  if (![
    "present",
    "missing",
    "ambiguous",
    "unreadable",
  ].includes(health) || ![
    "missing",
    "hashing",
    "valid",
    "stale",
    "failed",
  ].includes(fingerprintStatus) || ![
    "unknown",
    "absent",
    "preserved",
    "malformed",
  ].includes(xmpState)) {
    throw new Error("Catalog v3 snapshot enum is invalid.");
  }
  return {
    catalogId: parseCatalogId(stringValue(row, "catalogId")),
    assetId: parseAssetId(stringValue(row, "assetId")),
    rootId: parseRootId(stringValue(row, "rootId")),
    relativePath: stringValue(row, "relativePath"),
    observation: nullableNumberValue(row, "observedAt") === null &&
        nullableNumberValue(row, "observedByteLength") === null &&
        nullableNumberValue(row, "observedModifiedAt") === null &&
        nullableStringValue(row, "localFileId") === null
      ? null
      : {
        byteLength: nullableNumberValue(row, "observedByteLength"),
        modifiedAt: nullableNumberValue(row, "observedModifiedAt"),
        observedAt: numberValue(row, "observedAt"),
        localFileId: nullableStringValue(row, "localFileId"),
      },
    revision: integerValue(row, "assetRevision"),
    health: health as CatalogV3AssetSnapshot["health"],
    formatId: stringValue(row, "formatId"),
    cameraMake: nullableStringValue(row, "cameraMake"),
    cameraModel: nullableStringValue(row, "cameraModel"),
    lensModel: nullableStringValue(row, "lensModel"),
    fingerprintId: stringValue(row, "fingerprintId"),
    fingerprintStatus: fingerprintStatus as CatalogV3AssetSnapshot["fingerprintStatus"],
    fingerprintSha256: nullableStringValue(row, "fingerprintSha256"),
    fingerprintObservedAt: nullableNumberValue(row, "fingerprintObservedAt"),
    fingerprintObservedByteLength: nullableNumberValue(row, "fingerprintObservedByteLength"),
    fingerprintObservedModifiedAt: nullableNumberValue(row, "fingerprintObservedModifiedAt"),
    fingerprintLocalFileId: nullableStringValue(row, "fingerprintLocalFileId"),
    metadata: {
      archive: boolFromInteger(row, "archive"),
      pick: stringValue(row, "pick") as CatalogV3AssetMetadata["pick"],
      rating: integerValue(row, "rating") as CatalogV3AssetMetadata["rating"],
      colorLabel: nullableStringValue(row, "colorLabel") as CatalogV3AssetMetadata["colorLabel"],
      developJson: nullableStringValue(row, "developJson"),
      developUpdatedAt: numberValue(row, "developUpdatedAt"),
      updatedAt: numberValue(row, "updatedAt"),
      title: nullableStringValue(row, "title"),
      caption: nullableStringValue(row, "caption"),
      copyright: nullableStringValue(row, "copyright"),
      keywordsJson: stringValue(row, "keywordsJson"),
      rawXmp: nullableStringValue(row, "rawXmp"),
      xmpState: xmpState as CatalogV3XmpState,
      xmpMtime: nullableNumberValue(row, "xmpMtime"),
      xmpSha256: nullableStringValue(row, "xmpSha256"),
    },
  };
}

function metadataValues(metadata: CatalogV3AssetMetadata): readonly SQLInputValue[] {
  return [
    booleanInteger(metadata.archive),
    metadata.pick,
    metadata.rating,
    metadata.colorLabel,
    metadata.developJson,
    metadata.developUpdatedAt,
    metadata.updatedAt,
    metadata.title,
    metadata.caption,
    metadata.copyright,
    metadata.keywordsJson,
    metadata.rawXmp,
    metadata.xmpState,
    metadata.xmpMtime,
    metadata.xmpSha256,
  ];
}

function metadataEqual(left: ExistingMetadata, right: CatalogV3AssetMetadata): boolean {
  return left.archive === right.archive &&
    left.pick === right.pick &&
    left.rating === right.rating &&
    left.colorLabel === right.colorLabel &&
    left.developJson === right.developJson &&
    left.developUpdatedAt === right.developUpdatedAt &&
    left.updatedAt === right.updatedAt &&
    left.title === right.title &&
    left.caption === right.caption &&
    left.copyright === right.copyright &&
    left.keywordsJson === right.keywordsJson &&
    left.rawXmp === right.rawXmp &&
    left.xmpState === right.xmpState &&
    sameNullableNumber(left.xmpMtime, right.xmpMtime) &&
    left.xmpSha256 === right.xmpSha256;
}

function observationEqual(left: ExistingAsset, right: CatalogV3AssetCandidate): boolean {
  const observation = right.observation;
  return sameNullableNumber(left.observedByteLength, observation?.byteLength ?? null) &&
    sameNullableNumber(left.observedModifiedAt, observation?.modifiedAt ?? null) &&
    sameNullableNumber(left.observedAt, observation?.observedAt ?? null) &&
    left.localFileId === (observation?.localFileId ?? null) &&
    left.health === right.health &&
    left.formatId === right.formatId &&
    left.cameraMake === right.cameraMake &&
    left.cameraModel === right.cameraModel &&
    left.lensModel === right.lensModel;
}

function fingerprintEqual(left: ExistingFingerprint, right: CatalogV3FingerprintInput): boolean {
  return left.status === right.status &&
    left.sha256 === right.sha256 &&
    left.observedAt === (right.observedAt ?? null) &&
    left.observedByteLength === (right.observedByteLength ?? null) &&
    left.observedModifiedAt === (right.observedModifiedAt ?? null) &&
    left.localFileId === (right.localFileId ?? null);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(valueToDecode: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(valueToDecode, "base64url").toString("utf8"));
  } catch {
    throw new Error("Catalog v3 asset cursor is invalid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Catalog v3 asset cursor is invalid.");
  }
  const relativePath = Reflect.get(parsed, "relativePath");
  const assetId = parseAssetId(Reflect.get(parsed, "assetId"));
  if (typeof relativePath !== "string") throw new Error("Catalog v3 asset cursor is invalid.");
  assertRelativePath(relativePath);
  return { relativePath, assetId };
}

function phaseAllowsAssetCopy(phase: CatalogV3MigrationPhase): boolean {
  return phase === "created" || phase === "copying-assets" || phase === "copying-relations";
}

function phaseAllowsRelationsCopy(phase: CatalogV3MigrationPhase): boolean {
  return phase === "created" || phase === "copying-assets" || phase === "copying-relations" || phase === "copied";
}

function migrationKey(catalogId: CatalogId, migrationId: string): readonly [CatalogId, string] {
  return [catalogId, migrationId];
}

export class CatalogV3Repository {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  private schema(): void {
    upgradeCatalogV3IdentitySchema(this.database);
    verifyCatalogV3Schema(this.database);
  }

  private transaction<T>(operation: () => T): T {
    let inTransaction = false;
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      inTransaction = true;
      const result = operation();
      this.database.exec("COMMIT;");
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        try {
          this.database.exec("ROLLBACK;");
        } catch {
          // Preserve the original database error.
        }
      }
      throw error;
    }
  }

  private catalog(catalogId: CatalogId): CatalogRow {
    const row = this.database.prepare(`
      SELECT
        catalog_id AS catalogId,
        display_name AS displayName,
        app_version AS appVersion,
        install_state AS installState,
        revision
      FROM catalog_meta
      WHERE catalog_id = ?
    `).get(catalogId);
    return parseCatalogRow(row);
  }

  private migration(catalogId: CatalogId, migrationId: string): MigrationRow {
    const row = this.database.prepare(`
      SELECT
        migration_id AS migrationId,
        source_version AS sourceVersion,
        catalog_path AS catalogPath,
        settings_path AS settingsPath,
        catalog_sha256 AS catalogSha256,
        settings_sha256 AS settingsSha256,
        root_available AS rootAvailable,
        expected_counts_json AS expectedCountsJson,
        expected_state_sha256 AS expectedStateSha256,
        phase,
        validation_report_json AS validationReportJson,
        error_message AS errorMessage,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM migration_runs
      WHERE catalog_id = ? AND migration_id = ?
    `).get(...migrationKey(catalogId, migrationId));
    return parseMigrationRow(row);
  }

  private requireMigration(
    catalogId: CatalogId,
    migrationId: string,
    phaseCheck: (phase: CatalogV3MigrationPhase) => boolean,
  ): MigrationRow {
    this.catalog(catalogId);
    const migration = this.migration(catalogId, migrationId);
    if (!phaseCheck(migration.phase)) {
      throw new Error(`Catalog v3 migration phase ${migration.phase} does not allow this operation.`);
    }
    return migration;
  }

  private revision(catalogId: CatalogId): number {
    return this.catalog(catalogId).revision;
  }

  private bumpRevision(catalogId: CatalogId, now: number): number {
    const result = this.database.prepare(`
      UPDATE catalog_meta
      SET revision = revision + 1, updated_at = ?
      WHERE catalog_id = ?
    `).run(now, catalogId);
    if (result.changes !== 1) throw new Error("Catalog v3 revision update failed.");
    return this.revision(catalogId);
  }

  install(input: CatalogV3InstallInput): CatalogV3InstallResult {
    const validated = parseCatalogV3InstallInput(input);
    if (isCatalogV3DatabaseEmpty(this.database)) {
      installCatalogV3Schema(this.database);
    } else {
      this.schema();
    }
    const now = validated.now ?? Date.now();
    const existing = this.database.prepare(`
      SELECT catalog_id AS catalogId, display_name AS displayName, app_version AS appVersion,
             install_state AS installState, revision
      FROM catalog_meta WHERE catalog_id = ?
    `).get(validated.catalogId);
    if (existing !== undefined) {
      const catalog = parseCatalogRow(existing);
      const migration = this.migration(validated.catalogId, validated.migration.migrationId);
      if (catalog.displayName !== validated.displayName || catalog.appVersion !== validated.appVersion) {
        throw new Error("Catalog v3 install conflicts with the existing catalog identity.");
      }
      if (migration.sourceVersion !== validated.migration.sourceVersion ||
          migration.catalogPath !== validated.migration.catalogPath ||
          migration.settingsPath !== validated.migration.settingsPath ||
          migration.catalogSha256 !== validated.migration.catalogSha256 ||
          migration.settingsSha256 !== validated.migration.settingsSha256 ||
          migration.rootAvailable !== validated.migration.rootAvailable ||
          migration.expectedStateSha256 !== validated.migration.expectedStateSha256 ||
          JSON.stringify(migration.expectedCounts) !== JSON.stringify(validated.migration.expectedCounts)) {
        throw new Error("Catalog v3 install conflicts with the existing migration source.");
      }
      const existingRoot = this.root(validated.catalogId, validated.root.rootId);
      if (existingRoot.configuredPath !== validated.root.configuredPath ||
          existingRoot.label !== validated.root.label ||
          existingRoot.canonicalPath !== validated.root.canonicalPath ||
          existingRoot.health !== validated.root.health ||
          existingRoot.scanState !== validated.root.scanState ||
          existingRoot.watchState !== validated.root.watchState) {
        throw new Error("Catalog v3 install conflicts with the existing root identity.");
      }
      return {
        catalogId: validated.catalogId,
        migrationId: validated.migration.migrationId,
        created: false,
        installState: catalog.installState,
        revision: catalog.revision,
        schemaVersion: 3,
      };
    }

    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO catalog_meta (
          catalog_id, singleton, display_name, schema_version, app_version,
          install_state, revision, created_at, updated_at
        ) VALUES (?, 1, ?, 3, ?, 'staging', 0, ?, ?)
      `).run(
        validated.catalogId,
        validated.displayName,
        validated.appVersion,
        now,
        now,
      );
      this.database.prepare(`
        INSERT INTO roots (
          catalog_id, root_id, label, configured_path, canonical_path,
          health, scan_state, watch_state, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        validated.catalogId,
        validated.root.rootId,
        validated.root.label,
        validated.root.configuredPath,
        validated.root.canonicalPath,
        validated.root.health,
        validated.root.scanState,
        validated.root.watchState,
      );
      this.database.prepare(`
        INSERT INTO migration_runs (
          catalog_id, migration_id, source_version, catalog_path, settings_path,
          catalog_sha256, settings_sha256, root_available, expected_counts_json,
          expected_state_sha256,
          phase, validation_report_json, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', NULL, NULL, ?, ?)
      `).run(
        validated.catalogId,
        validated.migration.migrationId,
        validated.migration.sourceVersion,
        validated.migration.catalogPath,
        validated.migration.settingsPath,
        validated.migration.catalogSha256,
        validated.migration.settingsSha256,
        booleanInteger(validated.migration.rootAvailable),
        jsonString(validated.migration.expectedCounts, "expectedCounts"),
        validated.migration.expectedStateSha256,
        now,
        now,
      );
      return {
        catalogId: validated.catalogId,
        migrationId: validated.migration.migrationId,
        created: true,
        installState: "staging",
        revision: 0,
        schemaVersion: 3,
      };
    });
  }

  private findAlias(catalogId: CatalogId, migrationId: string, legacyId: string): LegacyAlias | null {
    const row = this.database.prepare(`
      SELECT asset_id AS assetId, root_id AS rootId, relative_path AS relativePath
      FROM migration_aliases
      WHERE catalog_id = ? AND migration_id = ? AND legacy_id = ?
    `).get(catalogId, migrationId, legacyId);
    if (row === undefined) return null;
    if (!isRow(row)) throw new Error("Catalog v3 alias row is invalid.");
    return {
      assetId: parseAssetId(stringValue(row, "assetId")),
      rootId: parseRootId(stringValue(row, "rootId")),
      relativePath: stringValue(row, "relativePath"),
    };
  }

  private findAssetByPath(catalogId: CatalogId, rootId: RootId, relativePath: string): ExistingAsset | null {
    const row = this.database.prepare(`
      SELECT
        asset_id AS assetId,
        root_id AS rootId,
        relative_path AS relativePath,
        observed_byte_length AS observedByteLength,
        observed_modified_at AS observedModifiedAt,
        observed_at AS observedAt,
        local_file_id AS localFileId,
        revision,
        health,
        format_id AS formatId,
        camera_make AS cameraMake,
        camera_model AS cameraModel,
        lens_model AS lensModel
      FROM assets
      WHERE catalog_id = ? AND root_id = ? AND relative_path = ?
    `).get(catalogId, rootId, relativePath);
    return row === undefined ? null : parseExistingAsset(row);
  }

  private findAsset(catalogId: CatalogId, assetId: AssetId): ExistingAsset | null {
    const row = this.database.prepare(`
      SELECT
        asset_id AS assetId,
        root_id AS rootId,
        relative_path AS relativePath,
        observed_byte_length AS observedByteLength,
        observed_modified_at AS observedModifiedAt,
        observed_at AS observedAt,
        local_file_id AS localFileId,
        revision,
        health,
        format_id AS formatId,
        camera_make AS cameraMake,
        camera_model AS cameraModel,
        lens_model AS lensModel
      FROM assets
      WHERE catalog_id = ? AND asset_id = ?
    `).get(catalogId, assetId);
    return row === undefined ? null : parseExistingAsset(row);
  }

  private findMetadata(catalogId: CatalogId, assetId: AssetId): ExistingMetadata | null {
    const row = this.database.prepare(`
      SELECT
        archive, pick, rating, color_label AS colorLabel,
        develop_json AS developJson, develop_updated_at AS developUpdatedAt,
        updated_at AS updatedAt, title, caption, copyright, keywords_json AS keywordsJson,
        raw_xmp AS rawXmp, xmp_state AS xmpState, xmp_mtime AS xmpMtime, xmp_sha256 AS xmpSha256
      FROM asset_metadata
      WHERE catalog_id = ? AND asset_id = ?
    `).get(catalogId, assetId);
    return row === undefined ? null : parseExistingMetadata(row);
  }

  private findFingerprint(catalogId: CatalogId, assetId: AssetId): ExistingFingerprint | null {
    const row = this.database.prepare(`
      SELECT fingerprint_id AS fingerprintId, status, sha256,
             observed_at AS observedAt, observed_byte_length AS observedByteLength,
             observed_modified_at AS observedModifiedAt, local_file_id AS localFileId
      FROM fingerprints
      WHERE catalog_id = ? AND asset_id = ?
    `).get(catalogId, assetId);
    return row === undefined ? null : parseExistingFingerprint(row);
  }

  private assertCandidate(candidate: CatalogV3AssetCandidate): void {
    assertRelativePath(candidate.relativePath);
    if (candidate.formatId.length === 0) throw new Error("Catalog v3 formatId is invalid.");
    if (candidate.observation !== null) {
      if (candidate.observation.byteLength !== null) assertNonnegativeInteger(candidate.observation.byteLength, "byteLength");
      if (candidate.observation.modifiedAt !== null && !Number.isFinite(candidate.observation.modifiedAt)) {
        throw new Error("Catalog v3 modifiedAt is invalid.");
      }
    }
    for (const legacyId of candidate.legacyIds) {
      if (legacyId.length === 0) throw new Error("Catalog v3 legacy ID is invalid.");
    }
    const metadata = metadataFromCandidate(candidate);
    if (metadata.developJson !== null) JSON.parse(metadata.developJson);
    JSON.parse(metadata.keywordsJson);
    if (metadata.rawXmp !== null && new TextEncoder().encode(metadata.rawXmp).byteLength > 16 * 1024 * 1024) {
      throw new Error("Catalog v3 raw XMP is too large.");
    }
    assertHash(metadata.xmpSha256, "xmpSha256");
    const fingerprint = fingerprintFromCandidate(candidate);
    if (fingerprint.status === "valid" && fingerprint.sha256 === null) {
      throw new Error("Catalog v3 valid fingerprint needs a digest.");
    }
    if (fingerprint.status !== "valid" && fingerprint.sha256 !== null) {
      throw new Error("Catalog v3 non-valid fingerprint cannot have a digest.");
    }
    const fingerprintObservedAt = fingerprint.observedAt ?? candidate.observation?.observedAt ?? null;
    const fingerprintByteLength = fingerprint.observedByteLength ?? candidate.observation?.byteLength ?? null;
    const fingerprintModifiedAt = fingerprint.observedModifiedAt ?? candidate.observation?.modifiedAt ?? null;
    const fingerprintLocalFileId = fingerprint.localFileId ?? candidate.observation?.localFileId ?? null;
    if (fingerprint.status === "valid" &&
        (fingerprintObservedAt === null || (fingerprintByteLength === null && fingerprintModifiedAt === null && fingerprintLocalFileId === null))) {
      throw new Error("Catalog v3 valid fingerprint needs observation proof.");
    }
    assertHash(fingerprint.sha256, "sha256");
  }

  private upsertAsset(
    catalogId: CatalogId,
    assetId: AssetId,
    candidate: CatalogV3AssetCandidate,
  ): { readonly changed: boolean; readonly created: boolean } {
    const existing = this.findAsset(catalogId, assetId);
    const observation = candidate.observation;
    const values = [
      observation?.byteLength ?? null,
      observation?.modifiedAt ?? null,
      observation?.observedAt ?? null,
      observation?.localFileId ?? null,
      candidate.health,
      candidate.formatId,
      candidate.cameraMake,
      candidate.cameraModel,
      candidate.lensModel,
    ];
    if (existing === null) {
      this.database.prepare(`
        INSERT INTO assets (
          catalog_id, asset_id, root_id, relative_path,
          observed_byte_length, observed_modified_at, observed_at, local_file_id, revision, health,
          format_id, camera_make, camera_model, lens_model
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        catalogId,
        assetId,
        candidate.rootId,
        candidate.relativePath,
        ...values,
      );
      return { changed: true, created: true };
    }
    if (existing.rootId !== candidate.rootId || existing.relativePath !== candidate.relativePath) {
      throw new Error("Catalog v3 AssetId conflicts with its stored path.");
    }
    if (observationEqual(existing, candidate)) return { changed: false, created: false };
    const result = this.database.prepare(`
      UPDATE assets
      SET observed_byte_length = ?, observed_modified_at = ?, observed_at = ?, local_file_id = ?, health = ?,
          format_id = ?, camera_make = ?, camera_model = ?, lens_model = ?
      WHERE catalog_id = ? AND asset_id = ?
    `).run(...values, catalogId, assetId);
    return { changed: result.changes === 1, created: false };
  }

  private bumpAssetRevision(catalogId: CatalogId, assetId: AssetId): void {
    const result = this.database.prepare(`
      UPDATE assets SET revision = revision + 1
      WHERE catalog_id = ? AND asset_id = ?
    `).run(catalogId, assetId);
    if (result.changes !== 1) throw new Error("Catalog v3 asset revision update failed.");
  }

  private upsertMetadata(
    catalogId: CatalogId,
    assetId: AssetId,
    metadata: CatalogV3MetadataInput | null,
  ): boolean {
    const next = metadata ?? CATALOG_V3_DEFAULT_METADATA;
    const existing = this.findMetadata(catalogId, assetId);
    if (existing === null) {
      this.database.prepare(`
        INSERT INTO asset_metadata (
          catalog_id, asset_id, archive, pick, rating, color_label,
          develop_json, develop_updated_at, updated_at, title, caption, copyright,
          keywords_json, raw_xmp, xmp_state, xmp_mtime, xmp_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(catalogId, assetId, ...metadataValues(next));
      return true;
    }
    if (metadata === null || metadataEqual(existing, next)) return false;
    const result = this.database.prepare(`
      UPDATE asset_metadata
      SET archive = ?, pick = ?, rating = ?, color_label = ?, develop_json = ?,
          develop_updated_at = ?, updated_at = ?, title = ?, caption = ?, copyright = ?,
          keywords_json = ?, raw_xmp = ?, xmp_state = ?, xmp_mtime = ?, xmp_sha256 = ?
      WHERE catalog_id = ? AND asset_id = ?
    `).run(...metadataValues(next), catalogId, assetId);
    return result.changes === 1;
  }

  private upsertFingerprint(
    catalogId: CatalogId,
    assetId: AssetId,
    candidate: CatalogV3AssetCandidate,
    now: number,
  ): { readonly fingerprintId: string; readonly changed: boolean } {
    const raw = fingerprintFromCandidate(candidate);
    const next: CatalogV3FingerprintInput = {
      status: raw.status,
      sha256: raw.sha256,
      observedAt: raw.observedAt ?? candidate.observation?.observedAt ?? null,
      observedByteLength: raw.observedByteLength ?? candidate.observation?.byteLength ?? null,
      observedModifiedAt: raw.observedModifiedAt ?? candidate.observation?.modifiedAt ?? null,
      localFileId: raw.localFileId ?? candidate.observation?.localFileId ?? null,
    };
    const existing = this.findFingerprint(catalogId, assetId);
    if (existing === null) {
      const fingerprintId = createAssetId();
      this.database.prepare(`
        INSERT INTO fingerprints (
          catalog_id, fingerprint_id, asset_id, status, sha256,
          observed_at, observed_byte_length, observed_modified_at, local_file_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        catalogId,
        fingerprintId,
        assetId,
        next.status,
        next.sha256,
        next.observedAt ?? null,
        next.observedByteLength ?? null,
        next.observedModifiedAt ?? null,
        next.localFileId ?? null,
        now,
      );
      return { fingerprintId, changed: true };
    }
    if (next.status === "missing" && existing.status !== "missing") {
      return { fingerprintId: existing.fingerprintId, changed: false };
    }
    if (fingerprintEqual(existing, next)) {
      return { fingerprintId: existing.fingerprintId, changed: false };
    }
    this.database.prepare(`
      UPDATE fingerprints
      SET status = ?, sha256 = ?, observed_at = ?, observed_byte_length = ?,
          observed_modified_at = ?, local_file_id = ?, updated_at = ?
      WHERE catalog_id = ? AND fingerprint_id = ?
    `).run(
      next.status,
      next.sha256,
      next.observedAt ?? null,
      next.observedByteLength ?? null,
      next.observedModifiedAt ?? null,
      next.localFileId ?? null,
      now,
      catalogId,
      existing.fingerprintId,
    );
    return { fingerprintId: existing.fingerprintId, changed: true };
  }

  private upsertAlias(
    catalogId: CatalogId,
    migrationId: string,
    legacyId: string,
    candidate: CatalogV3AssetCandidate,
    assetId: AssetId,
    now: number,
  ): boolean {
    const existing = this.findAlias(catalogId, migrationId, legacyId);
    if (existing !== null) {
      if (existing.assetId !== assetId || existing.rootId !== candidate.rootId || existing.relativePath !== candidate.relativePath) {
        throw new Error("Catalog v3 legacy alias conflicts with its stored path.");
      }
      return false;
    }
    this.database.prepare(`
      INSERT INTO migration_aliases (
        catalog_id, migration_id, legacy_id, root_id, relative_path, asset_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      catalogId,
      migrationId,
      legacyId,
      candidate.rootId,
      candidate.relativePath,
      assetId,
      now,
    );
    return true;
  }

  writeAssetBatch(input: CatalogV3AssetBatchInput): CatalogV3AssetBatchResult {
    const validated = parseCatalogV3AssetBatchInput(input);
    if (validated.assets.length > CATALOG_V3_MAX_ASSET_BATCH) {
      throw new Error("Catalog v3 asset batch exceeds 250 assets.");
    }
    this.schema();
    return this.transaction(() => {
      const migration = this.requireMigration(validated.catalogId, validated.migrationId, phaseAllowsAssetCopy);
      const now = Date.now();
      const paths = new Set<string>();
      const aliases = new Set<string>();
      let changed = false;
      const mappings: CatalogV3AssetMapping[] = [];
      for (const candidate of validated.assets) {
        this.assertCandidate(candidate);
        const pathKey = `${candidate.rootId}\u0000${candidate.relativePath}`;
        if (paths.has(pathKey)) throw new Error("Catalog v3 asset batch contains a duplicate path.");
        paths.add(pathKey);
        for (const legacyId of candidate.legacyIds) {
          if (aliases.has(legacyId)) throw new Error("Catalog v3 asset batch contains a duplicate legacy ID.");
          aliases.add(legacyId);
        }

        let assetId: AssetId | null = null;
        for (const legacyId of candidate.legacyIds) {
          const alias = this.findAlias(validated.catalogId, validated.migrationId, legacyId);
          if (alias === null) continue;
          if (alias.rootId !== candidate.rootId || alias.relativePath !== candidate.relativePath) {
            throw new Error("Catalog v3 legacy alias path does not match the retry candidate.");
          }
          if (assetId !== null && assetId !== alias.assetId) {
            throw new Error("Catalog v3 candidate aliases resolve to different assets.");
          }
          assetId = alias.assetId;
        }
        const pathAsset = this.findAssetByPath(validated.catalogId, candidate.rootId, candidate.relativePath);
        if (assetId !== null && pathAsset !== null && pathAsset.assetId !== assetId) {
          throw new Error("Catalog v3 path already belongs to another AssetId.");
        }
        if (assetId === null && pathAsset !== null) assetId = pathAsset.assetId;
        if (assetId === null) assetId = createAssetId();
        const assetChange = this.upsertAsset(validated.catalogId, assetId, candidate);
        const metadataChanged = this.upsertMetadata(validated.catalogId, assetId, candidate.metadata);
        const fingerprint = this.upsertFingerprint(validated.catalogId, assetId, candidate, now);
        if (!assetChange.created && (assetChange.changed || metadataChanged || fingerprint.changed)) {
          this.bumpAssetRevision(validated.catalogId, assetId);
        }
        changed = assetChange.changed || metadataChanged || fingerprint.changed || changed;
        for (const legacyId of candidate.legacyIds) {
          changed = this.upsertAlias(
            validated.catalogId,
            validated.migrationId,
            legacyId,
            candidate,
            assetId,
            now,
          ) || changed;
        }
        mappings.push({
          legacyIds: candidate.legacyIds,
          relativePath: candidate.relativePath,
          assetId,
          fingerprintId: fingerprint.fingerprintId,
        });
      }
      if (migration.phase === "created") {
        this.database.prepare(`
          UPDATE migration_runs SET phase = 'copying-assets', updated_at = ?
          WHERE catalog_id = ? AND migration_id = ?
        `).run(now, ...migrationKey(validated.catalogId, validated.migrationId));
      }
      const revision = changed ? this.bumpRevision(validated.catalogId, now) : this.revision(validated.catalogId);
      return {
        catalogId: validated.catalogId,
        migrationId: validated.migrationId,
        revision,
        assets: mappings,
      };
    });
  }

  private resolveAlias(catalogId: CatalogId, migrationId: string, legacyId: string): AssetId {
    const alias = this.findAlias(catalogId, migrationId, legacyId);
    if (alias === null) throw new Error(`Catalog v3 relation references unknown legacy ID ${legacyId}.`);
    return alias.assetId;
  }

  writeRelationsBatch(input: CatalogV3RelationsBatchInput): CatalogV3RelationsBatchResult {
    const validated = parseCatalogV3RelationsBatchInput(input);
    this.schema();
    return this.transaction(() => {
      const migration = this.requireMigration(validated.catalogId, validated.migrationId, phaseAllowsRelationsCopy);
      const now = Date.now();
      const albumIds = new Set<string>();
      const albumPositions = new Set<number>();
      let changed = false;
      let albumAssets = 0;
      const resolvedAlbums = validated.albums.map((album) => {
        if (albumIds.has(album.id)) throw new Error("Catalog v3 relations contain a duplicate album ID.");
        albumIds.add(album.id);
        if (albumPositions.has(album.position)) throw new Error("Catalog v3 relations contain a duplicate album position.");
        albumPositions.add(album.position);
        const members = new Set<string>();
        for (const entryId of album.entryIds) {
          if (members.has(entryId)) throw new Error("Catalog v3 album contains a duplicate membership.");
          members.add(entryId);
        }
        return {
          album,
          assetIds: album.entryIds.map((entryId) => this.resolveAlias(validated.catalogId, validated.migrationId, entryId)),
        };
      });
      for (const resolved of resolvedAlbums) {
        const existingAlbum = this.database.prepare(`
          SELECT name, created_at AS createdAt, updated_at AS updatedAt, position
          FROM albums WHERE catalog_id = ? AND album_id = ?
        `).get(validated.catalogId, resolved.album.id);
        if (existingAlbum === undefined) {
          this.database.prepare(`
            INSERT INTO albums (catalog_id, album_id, name, created_at, updated_at, position)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            validated.catalogId,
            resolved.album.id,
            resolved.album.name,
            resolved.album.createdAt,
            resolved.album.updatedAt,
            resolved.album.position,
          );
          changed = true;
        } else {
          if (!isRow(existingAlbum) || stringValue(existingAlbum, "name") !== resolved.album.name ||
              numberValue(existingAlbum, "createdAt") !== resolved.album.createdAt ||
              numberValue(existingAlbum, "updatedAt") !== resolved.album.updatedAt ||
              integerValue(existingAlbum, "position") !== resolved.album.position) {
            throw new Error("Catalog v3 album conflicts with its retry payload.");
          }
        }
        for (const [index, assetId] of resolved.assetIds.entries()) {
          const position = resolved.album.positionOffset + index;
          const byPosition = this.database.prepare(`
            SELECT asset_id AS assetId FROM album_assets
            WHERE catalog_id = ? AND album_id = ? AND position = ?
          `).get(validated.catalogId, resolved.album.id, position);
          const byAsset = this.database.prepare(`
            SELECT position FROM album_assets
            WHERE catalog_id = ? AND album_id = ? AND asset_id = ?
          `).get(validated.catalogId, resolved.album.id, assetId);
          if (byPosition !== undefined) {
            if (!isRow(byPosition) || parseAssetId(stringValue(byPosition, "assetId")) !== assetId) {
              throw new Error("Catalog v3 album position conflicts with its retry payload.");
            }
            if (byAsset !== undefined) {
              const existingPosition = isRow(byAsset) ? integerValue(byAsset, "position") : -1;
              if (existingPosition !== position) throw new Error("Catalog v3 album membership is duplicated at another position.");
            }
            continue;
          }
          if (byAsset !== undefined) throw new Error("Catalog v3 album membership is duplicated at another position.");
          this.database.prepare(`
            INSERT INTO album_assets (catalog_id, album_id, asset_id, position)
            VALUES (?, ?, ?, ?)
          `).run(validated.catalogId, resolved.album.id, assetId, position);
          changed = true;
          albumAssets += 1;
        }
      }
      const archiveIds = new Set(validated.archiveLegacyIds);
      let archived = 0;
      for (const legacyId of archiveIds) {
        const assetId = this.resolveAlias(validated.catalogId, validated.migrationId, legacyId);
        const existing = this.findMetadata(validated.catalogId, assetId);
        if (existing === null) throw new Error("Catalog v3 archive target has no metadata row.");
        if (!existing.archive) {
          this.database.prepare(`
            UPDATE asset_metadata SET archive = 1
            WHERE catalog_id = ? AND asset_id = ?
          `).run(validated.catalogId, assetId);
          changed = true;
          archived += 1;
        }
      }
      const nextPhase = migration.phase === "created" || migration.phase === "copying-assets"
        ? "copying-relations"
        : migration.phase;
      if (nextPhase !== migration.phase) {
        this.database.prepare(`
          UPDATE migration_runs SET phase = ?, updated_at = ?
          WHERE catalog_id = ? AND migration_id = ?
        `).run(nextPhase, now, ...migrationKey(validated.catalogId, validated.migrationId));
      }
      const revision = changed ? this.bumpRevision(validated.catalogId, now) : this.revision(validated.catalogId);
      return {
        catalogId: validated.catalogId,
        migrationId: validated.migrationId,
        revision,
        albums: resolvedAlbums.length,
        albumAssets,
        archived,
      };
    });
  }

  finishCopy(catalogId: CatalogId, migrationId: string): CatalogV3FinishCopyResult {
    this.schema();
    return this.transaction(() => {
      const migration = this.requireMigration(catalogId, migrationId, phaseAllowsRelationsCopy);
      const now = Date.now();
      if (migration.phase !== "copied") {
        this.database.prepare(`
          UPDATE migration_runs SET phase = 'copied', updated_at = ?
          WHERE catalog_id = ? AND migration_id = ?
        `).run(now, ...migrationKey(catalogId, migrationId));
      }
      return {
        catalogId,
        migrationId,
        phase: "copied",
        revision: this.revision(catalogId),
      };
    });
  }

  private counts(catalogId: CatalogId): CatalogV3Counts {
    const rowFor = (sql: string): Row => {
      const row = this.database.prepare(sql).get(catalogId);
      if (!isRow(row)) throw new Error("Catalog v3 count row is invalid.");
      return row;
    };
    const count = (sql: string): number => integerValue(rowFor(sql), "count");
    const assets = count("SELECT COUNT(*) AS count FROM assets WHERE catalog_id = ?");
    const metadata = count("SELECT COUNT(*) AS count FROM asset_metadata WHERE catalog_id = ?");
    const albums = count("SELECT COUNT(*) AS count FROM albums WHERE catalog_id = ?");
    const albumAssets = count("SELECT COUNT(*) AS count FROM album_assets WHERE catalog_id = ?");
    const archived = count("SELECT COUNT(*) AS count FROM asset_metadata WHERE catalog_id = ? AND archive = 1");
    const aliases = count("SELECT COUNT(*) AS count FROM migration_aliases WHERE catalog_id = ?");
    const fingerprints = count("SELECT COUNT(*) AS count FROM fingerprints WHERE catalog_id = ?");
    const healthRows = this.database.prepare(`
      SELECT health, COUNT(*) AS count FROM assets WHERE catalog_id = ? GROUP BY health
    `).all(catalogId);
    const healthCounts = { present: 0, missing: 0, ambiguous: 0, unreadable: 0 };
    for (const row of healthRows) {
      if (!isRow(row)) throw new Error("Catalog v3 health count row is invalid.");
      const health = stringValue(row, "health");
      if (!(health in healthCounts)) throw new Error("Catalog v3 health count is invalid.");
      healthCounts[health as keyof typeof healthCounts] = integerValue(row, "count");
    }
    return {
      assets,
      metadata,
      albums,
      albumAssets,
      archived,
      aliases,
      fingerprints,
      ...healthCounts,
    };
  }

  private fingerprintCoverage(catalogId: CatalogId): CatalogV3FingerprintCoverage {
    const rows = this.database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM fingerprints WHERE catalog_id = ? GROUP BY status
    `).all(catalogId);
    const result: Record<CatalogV3FingerprintInput["status"], number> = {
      missing: 0,
      hashing: 0,
      valid: 0,
      stale: 0,
      failed: 0,
    };
    for (const row of rows) {
      if (!isRow(row)) throw new Error("Catalog v3 fingerprint count row is invalid.");
      const status = stringValue(row, "status");
      if (!(status in result)) throw new Error("Catalog v3 fingerprint status count is invalid.");
      result[status as CatalogV3FingerprintInput["status"]] = integerValue(row, "count");
    }
    return {
      total: result.missing + result.hashing + result.valid + result.stale + result.failed,
      ...result,
    };
  }

  private integrity(): CatalogV3IntegrityResult {
    const integrityRows = this.database.prepare("PRAGMA integrity_check").all();
    const integrityCheck = integrityRows.map((row) => {
      if (!isRow(row)) throw new Error("Catalog v3 integrity row is invalid.");
      return stringValue(row, "integrity_check");
    });
    const foreignKeyRows = this.database.prepare("PRAGMA foreign_key_check").all();
    const foreignKeyCheck = foreignKeyRows.map((row) => {
      if (!isRow(row)) throw new Error("Catalog v3 foreign-key row is invalid.");
      return {
        table: stringValue(row, "table"),
        rowId: nullableNumberValue(row, "rowid"),
        parent: stringValue(row, "parent"),
        foreignKeyIndex: integerValue(row, "fkid"),
      };
    });
    return { integrityCheck, foreignKeyCheck };
  }

  private root(catalogId: CatalogId, rootId: RootId): CatalogV3RootInput {
    const row = this.database.prepare(`
      SELECT root_id AS rootId, label, configured_path AS configuredPath, canonical_path AS canonicalPath,
             health, scan_state AS scanState, watch_state AS watchState
      FROM roots WHERE catalog_id = ? AND root_id = ?
    `).get(catalogId, rootId);
    if (!isRow(row)) throw new Error("Catalog v3 root row is missing.");
    const health = stringValue(row, "health");
    const scanState = stringValue(row, "scanState");
    const watchState = stringValue(row, "watchState");
    if (!["online", "missing", "ambiguous", "unreadable"].includes(health) ||
        !["unknown", "complete", "partial", "failed"].includes(scanState) ||
        !["disabled", "active", "error"].includes(watchState)) {
      throw new Error("Catalog v3 root state is invalid.");
    }
    return {
      rootId: parseRootId(stringValue(row, "rootId")),
      label: stringValue(row, "label"),
      configuredPath: stringValue(row, "configuredPath"),
      canonicalPath: nullableStringValue(row, "canonicalPath"),
      health: health as CatalogV3RootInput["health"],
      scanState: scanState as CatalogV3RootInput["scanState"],
      watchState: watchState as CatalogV3RootInput["watchState"],
    };
  }

  private migrationStateSha256(catalogId: CatalogId, migrationId: string): string {
    const digest = new CatalogV3StateDigest();
    const assetRows = this.database.prepare(`
      SELECT snapshot.*,
             COALESCE((
               SELECT json_group_array(ma.legacy_id ORDER BY ma.legacy_id)
               FROM migration_aliases AS ma
               WHERE ma.catalog_id = ?1 AND ma.migration_id = ?2 AND ma.asset_id = snapshot.assetId
             ), '[]') AS legacyIdsJson
      FROM (${ASSET_SNAPSHOT_SELECT} WHERE a.catalog_id = ?1) AS snapshot
      ORDER BY snapshot.rootId, snapshot.relativePath
    `).iterate(catalogId, migrationId);
    for (const row of assetRows) {
      const snapshot = parseAssetSnapshotRow(row);
      if (snapshot.formatId === null) throw new Error("Catalog v3 state asset format is missing.");
      if (!isRow(row)) throw new Error("Catalog v3 state asset row is invalid.");
      const legacyIdsValue: unknown = JSON.parse(stringValue(row, "legacyIdsJson"));
      if (!Array.isArray(legacyIdsValue) || legacyIdsValue.some((value) => typeof value !== "string")) {
        throw new Error("Catalog v3 state aliases are invalid.");
      }
      digest.addAsset({
        rootId: snapshot.rootId,
        relativePath: snapshot.relativePath,
        observation: snapshot.observation,
        health: snapshot.health,
        formatId: snapshot.formatId,
        cameraMake: snapshot.cameraMake,
        cameraModel: snapshot.cameraModel,
        lensModel: snapshot.lensModel,
        legacyIds: legacyIdsValue,
        metadata: snapshot.metadata,
        fingerprint: {
          status: snapshot.fingerprintStatus,
          sha256: snapshot.fingerprintSha256,
          observedAt: snapshot.fingerprintObservedAt,
          observedByteLength: snapshot.fingerprintObservedByteLength,
          observedModifiedAt: snapshot.fingerprintObservedModifiedAt,
          localFileId: snapshot.fingerprintLocalFileId,
        },
      });
    }

    const albumRows = this.database.prepare(`
      SELECT album_id AS albumId, name, created_at AS createdAt, updated_at AS updatedAt, position
      FROM albums
      WHERE catalog_id = ?
      ORDER BY position
    `).iterate(catalogId);
    const memberStatement = this.database.prepare(`
      SELECT a.root_id AS rootId, a.relative_path AS relativePath
      FROM album_assets AS aa
      JOIN assets AS a ON a.catalog_id = aa.catalog_id AND a.asset_id = aa.asset_id
      WHERE aa.catalog_id = ? AND aa.album_id = ?
      ORDER BY aa.position
    `);
    for (const row of albumRows) {
      if (!isRow(row)) throw new Error("Catalog v3 state album row is invalid.");
      const albumId = stringValue(row, "albumId");
      const members = function* (): Generator<CatalogV3StateLocation> {
        for (const member of memberStatement.iterate(catalogId, albumId)) {
          if (!isRow(member)) throw new Error("Catalog v3 state album member row is invalid.");
          yield {
            rootId: parseRootId(stringValue(member, "rootId")),
            relativePath: stringValue(member, "relativePath"),
          };
        }
      };
      digest.addAlbum({
        id: albumId,
        name: stringValue(row, "name"),
        createdAt: numberValue(row, "createdAt"),
        updatedAt: numberValue(row, "updatedAt"),
        position: integerValue(row, "position"),
      }, members());
    }
    return digest.digest();
  }

  validate(catalogId: CatalogId, migrationId: string): CatalogV3ValidationResult {
    this.schema();
    const migration = this.requireMigration(
      catalogId,
      migrationId,
      (phase) => phase === "copied" || phase === "validating" || phase === "validated" || phase === "failed",
    );
    const now = Date.now();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE migration_runs SET phase = 'validating', updated_at = ?
        WHERE catalog_id = ? AND migration_id = ?
      `).run(now, ...migrationKey(catalogId, migrationId));
    });

    let report: CatalogV3ValidationReport;
    try {
      const before = migration.expectedCounts;
      const after = this.counts(catalogId);
      const fingerprintCoverage = this.fingerprintCoverage(catalogId);
      const expectedStateSha256 = migration.expectedStateSha256;
      const actualStateSha256 = this.migrationStateSha256(catalogId, migrationId);
      const integrity = this.integrity();
      const relationFailures = {
        aliases: this.relationFailureCount(catalogId, "aliases"),
        albums: this.relationFailureCount(catalogId, "albums"),
        albumAssets: this.relationFailureCount(catalogId, "albumAssets"),
        archived: this.relationFailureCount(catalogId, "archived"),
      };
      const blockingErrors: string[] = [];
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
      for (const key of countKeys) {
        if (after[key] !== before[key]) {
          blockingErrors.push(`Count ${key} expected ${before[key]} but found ${after[key]}.`);
        }
      }
      if (integrity.integrityCheck.length !== 1 || integrity.integrityCheck[0] !== "ok") {
        blockingErrors.push("SQLite integrity check failed.");
      }
      if (integrity.foreignKeyCheck.length > 0) blockingErrors.push("SQLite foreign-key check failed.");
      if (Object.values(relationFailures).some((count) => count > 0)) {
        blockingErrors.push("Catalog v3 relation checks failed.");
      }
      if (actualStateSha256 !== expectedStateSha256) {
        blockingErrors.push("Catalog v3 migrated state does not match the frozen migration plan.");
      }
      if (
        fingerprintCoverage.missing !== after.assets ||
        fingerprintCoverage.hashing !== 0 ||
        fingerprintCoverage.valid !== 0 ||
        fingerprintCoverage.stale !== 0 ||
        fingerprintCoverage.failed !== 0
      ) {
        blockingErrors.push("Every legacy migration fingerprint must remain missing until post-migration hashing.");
      }
      const limitations = after.assets > 0
        ? ["No asset has a proven digest; duplicate readiness is unavailable."]
        : [];
      report = {
        catalogId,
        migrationId,
        clean: blockingErrors.length === 0,
        before,
        after,
        fingerprintCoverage,
        expectedStateSha256,
        actualStateSha256,
        relationFailures,
        integrity,
        applicationId: verifyCatalogV3Schema(this.database).applicationId,
        schemaVersion: 3,
        userVersion: verifyCatalogV3Schema(this.database).userVersion,
        limitations,
        blockingErrors,
      };
    } catch (error) {
      report = {
        catalogId,
        migrationId,
        clean: false,
        before: migration.expectedCounts,
        after: this.counts(catalogId),
        fingerprintCoverage: this.fingerprintCoverage(catalogId),
        expectedStateSha256: migration.expectedStateSha256,
        actualStateSha256: "0".repeat(64),
        relationFailures: { aliases: 0, albums: 0, albumAssets: 0, archived: 0 },
        integrity: this.integrity(),
        applicationId: 0,
        schemaVersion: 3,
        userVersion: 3,
        limitations: [],
        blockingErrors: [error instanceof Error ? error.message : "Catalog v3 validation failed."],
      };
    }

    return this.transaction(() => {
      const phase: CatalogV3MigrationPhase = report.clean ? "validated" : "failed";
      this.database.prepare(`
        UPDATE migration_runs
        SET phase = ?, validation_report_json = ?, error_message = ?, updated_at = ?
        WHERE catalog_id = ? AND migration_id = ?
      `).run(
        phase,
        jsonString(report, "validationReport"),
        report.clean ? null : report.blockingErrors.join(" "),
        Date.now(),
        ...migrationKey(catalogId, migrationId),
      );
      return {
        catalogId,
        migrationId,
        phase,
        report,
        revision: this.revision(catalogId),
      };
    });
  }

  private relationFailureCount(catalogId: CatalogId, relation: "aliases" | "albums" | "albumAssets" | "archived"): number {
    switch (relation) {
      case "aliases":
        return this.scalarCount(`
          SELECT COUNT(*) AS count FROM migration_aliases AS a
          LEFT JOIN assets AS x ON x.catalog_id = a.catalog_id AND x.asset_id = a.asset_id
          WHERE a.catalog_id = ? AND (
            x.asset_id IS NULL
            OR x.root_id <> a.root_id
            OR x.relative_path <> a.relative_path
          )
        `, catalogId);
      case "albums":
        return this.scalarCount(`
          SELECT COUNT(*) AS count FROM (
            SELECT a.album_id AS failure
            FROM albums AS a
            LEFT JOIN catalog_meta AS c ON c.catalog_id = a.catalog_id
            WHERE a.catalog_id = ?1 AND c.catalog_id IS NULL
            UNION ALL
            SELECT 'album-position-gap' AS failure
            FROM albums
            WHERE catalog_id = ?1
            GROUP BY catalog_id
            HAVING MIN(position) <> 0 OR MAX(position) <> COUNT(*) - 1
          )
        `, catalogId);
      case "albumAssets":
        return this.scalarCount(`
          SELECT COUNT(*) AS count FROM (
            SELECT aa.album_id
            FROM album_assets AS aa
            LEFT JOIN albums AS a ON a.catalog_id = aa.catalog_id AND a.album_id = aa.album_id
            LEFT JOIN assets AS x ON x.catalog_id = aa.catalog_id AND x.asset_id = aa.asset_id
            WHERE aa.catalog_id = ?
            GROUP BY aa.album_id
            HAVING
              SUM(CASE WHEN a.album_id IS NULL OR x.asset_id IS NULL THEN 1 ELSE 0 END) > 0
              OR MIN(aa.position) <> 0
              OR MAX(aa.position) <> COUNT(*) - 1
          )
        `, catalogId);
      case "archived":
        return this.scalarCount(`
          SELECT COUNT(*) AS count FROM asset_metadata AS m
          LEFT JOIN assets AS a ON a.catalog_id = m.catalog_id AND a.asset_id = m.asset_id
          WHERE m.catalog_id = ? AND m.archive = 1 AND a.asset_id IS NULL
        `, catalogId);
      default: {
        const _exhaustive: never = relation;
        throw new Error(`Unknown Catalog v3 relation ${_exhaustive}.`);
      }
    }
  }

  private scalarCount(sql: string, catalogId: CatalogId): number {
    const row = this.database.prepare(sql).get(catalogId);
    if (!isRow(row)) throw new Error("Catalog v3 scalar count row is invalid.");
    return integerValue(row, "count");
  }

  prepareActivation(catalogId: CatalogId, migrationId: string): CatalogV3ActivationResult {
    this.schema();
    return this.transaction(() => {
      const migration = this.migration(catalogId, migrationId);
      if (migration.phase !== "validated" || migration.validationReportJson === null) {
        throw new Error("Catalog v3 migration must have a clean validation before activation.");
      }
      let reportValue: unknown;
      try {
        reportValue = JSON.parse(migration.validationReportJson);
      } catch {
        throw new Error("Catalog v3 validation report is malformed.");
      }
      if (typeof reportValue !== "object" || reportValue === null || Reflect.get(reportValue, "clean") !== true) {
        throw new Error("Catalog v3 validation report is not clean.");
      }
      const now = Date.now();
      this.database.prepare(`
        UPDATE catalog_meta SET install_state = 'ready', updated_at = ?
        WHERE catalog_id = ?
      `).run(now, catalogId);
      return {
        catalogId,
        migrationId,
        installState: "ready",
        revision: this.revision(catalogId),
      };
    });
  }

  sealForInstall(catalogId: CatalogId, migrationId: string): CatalogV3SealForInstallResult {
    this.schema();
    const catalog = this.catalog(catalogId);
    if (catalog.installState !== "ready") {
      throw new Error("Catalog v3 catalog must be ready before sealing for install.");
    }
    const migration = this.requireMigration(catalogId, migrationId, (phase) => phase === "validated");
    if (migration.validationReportJson === null) {
      throw new Error("Catalog v3 migration must have a clean validation before sealing for install.");
    }
    let reportValue: unknown;
    try {
      reportValue = JSON.parse(migration.validationReportJson);
    } catch {
      throw new Error("Catalog v3 validation report is malformed.");
    }
    if (typeof reportValue !== "object" || reportValue === null || Reflect.get(reportValue, "clean") !== true) {
      throw new Error("Catalog v3 validation report is not clean.");
    }

    const checkpoint = this.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (!isRow(checkpoint)) throw new Error("Catalog v3 WAL checkpoint result is invalid.");
    const busy = integerValue(checkpoint, "busy");
    const logFrames = integerValue(checkpoint, "log");
    const checkpointedFrames = integerValue(checkpoint, "checkpointed");
    if (busy !== 0) throw new Error("Catalog v3 WAL checkpoint is busy.");

    const journal = this.database.prepare("PRAGMA journal_mode = DELETE").get();
    if (!isRow(journal) || stringValue(journal, "journal_mode") !== "delete") {
      throw new Error("Catalog v3 journal mode did not switch to delete.");
    }
    return {
      catalogId,
      migrationId,
      busy,
      logFrames,
      checkpointedFrames,
      journalMode: "delete",
    };
  }

  summary(catalogId: CatalogId): CatalogV3Summary {
    this.schema();
    const catalog = this.catalog(catalogId);
    const migrationRow = this.database.prepare(`
      SELECT
        migration_id AS migrationId, source_version AS sourceVersion,
        catalog_path AS catalogPath, settings_path AS settingsPath,
        catalog_sha256 AS catalogSha256, settings_sha256 AS settingsSha256,
        root_available AS rootAvailable, expected_counts_json AS expectedCountsJson,
        expected_state_sha256 AS expectedStateSha256,
        phase, validation_report_json AS validationReportJson, error_message AS errorMessage,
        created_at AS createdAt, updated_at AS updatedAt
      FROM migration_runs WHERE catalog_id = ? ORDER BY created_at, migration_id LIMIT 1
    `).get(catalogId);
    const migration = parseMigrationRow(migrationRow);
    const rootRow = this.database.prepare(
      "SELECT root_id AS rootId FROM roots WHERE catalog_id = ? ORDER BY root_id LIMIT 1",
    ).get(catalogId);
    if (!isRow(rootRow)) throw new Error("Catalog v3 root row is missing.");
    const root = this.root(catalogId, parseRootId(stringValue(rootRow, "rootId")));
    return {
      catalogId,
      displayName: catalog.displayName,
      appVersion: catalog.appVersion,
      installState: catalog.installState,
      revision: catalog.revision,
      migrationId: migration.migrationId,
      migrationPhase: migration.phase,
      sourceVersion: migration.sourceVersion,
      migration: {
        migrationId: migration.migrationId,
        sourceVersion: migration.sourceVersion,
        catalogPath: migration.catalogPath,
        settingsPath: migration.settingsPath,
        catalogSha256: migration.catalogSha256,
        settingsSha256: migration.settingsSha256,
        rootAvailable: migration.rootAvailable,
        expectedCounts: migration.expectedCounts,
        expectedStateSha256: migration.expectedStateSha256,
      },
      root,
      counts: this.counts(catalogId),
      fingerprintCoverage: this.fingerprintCoverage(catalogId),
    };
  }

  private assetSnapshot(catalogId: CatalogId, assetId: AssetId): CatalogV3AssetSnapshot {
    const row = this.database.prepare(`${ASSET_SNAPSHOT_SELECT}
      WHERE a.catalog_id = ? AND a.asset_id = ?
    `).get(catalogId, assetId);
    return parseAssetSnapshotRow(row);
  }

  assetPage(input: CatalogV3AssetPageInput): CatalogV3AssetPage {
    const validated = parseCatalogV3AssetPageInput(input);
    this.schema();
    const currentRevision = this.revision(validated.catalogId);
    if (validated.expectedRevision !== null && validated.expectedRevision !== currentRevision) {
      throw new Error(`Catalog v3 snapshot revision ${validated.expectedRevision} is stale; current revision is ${currentRevision}.`);
    }
    const cursor = validated.cursor === null ? null : decodeCursor(validated.cursor);
    const rows = cursor === null
      ? this.database.prepare(`
          SELECT asset_id AS assetId, relative_path AS relativePath
          FROM assets WHERE catalog_id = ?
          ORDER BY relative_path, asset_id LIMIT ?
        `).all(validated.catalogId, validated.limit + 1)
      : this.database.prepare(`
          SELECT asset_id AS assetId, relative_path AS relativePath
          FROM assets
          WHERE catalog_id = ? AND (relative_path > ? OR (relative_path = ? AND asset_id > ?))
          ORDER BY relative_path, asset_id LIMIT ?
        `).all(validated.catalogId, cursor.relativePath, cursor.relativePath, cursor.assetId, validated.limit + 1);
    const parsedRows = rows.map((row) => {
      if (!isRow(row)) throw new Error("Catalog v3 asset page row is invalid.");
      return {
        assetId: parseAssetId(stringValue(row, "assetId")),
        relativePath: stringValue(row, "relativePath"),
      };
    });
    const hasNext = parsedRows.length > validated.limit;
    const visible = hasNext ? parsedRows.slice(0, validated.limit) : parsedRows;
    const assets = visible.map((item) => this.assetSnapshot(validated.catalogId, item.assetId));
    const last = visible.at(-1);
    return {
      catalogId: validated.catalogId,
      revision: currentRevision,
      assets,
      nextCursor: hasNext && last !== undefined
        ? encodeCursor({ relativePath: last.relativePath, assetId: last.assetId })
        : null,
    };
  }

  albumSnapshots(input: CatalogV3AlbumPageInput): CatalogV3AlbumSnapshotResult {
    const validated = parseCatalogV3AlbumPageInput(input);
    this.schema();
    const currentRevision = this.revision(validated.catalogId);
    if (validated.expectedRevision !== null && validated.expectedRevision !== currentRevision) {
      throw new Error(`Catalog v3 album snapshot revision ${validated.expectedRevision} is stale; current revision is ${currentRevision}.`);
    }
    const rows = validated.cursor === null
      ? this.database.prepare(`
          SELECT album_id AS albumId, name, created_at AS createdAt, updated_at AS updatedAt, position
          FROM albums WHERE catalog_id = ? ORDER BY position LIMIT ?
        `).all(validated.catalogId, validated.limit + 1)
      : this.database.prepare(`
          SELECT album_id AS albumId, name, created_at AS createdAt, updated_at AS updatedAt, position
          FROM albums WHERE catalog_id = ? AND position > ? ORDER BY position LIMIT ?
        `).all(validated.catalogId, validated.cursor, validated.limit + 1);
    const parsedRows: CatalogV3AlbumSnapshot[] = rows.map((row) => {
      if (!isRow(row)) throw new Error("Catalog v3 album snapshot row is invalid.");
      return {
        catalogId: validated.catalogId,
        id: stringValue(row, "albumId"),
        name: stringValue(row, "name"),
        createdAt: numberValue(row, "createdAt"),
        updatedAt: numberValue(row, "updatedAt"),
        position: integerValue(row, "position"),
      };
    });
    const hasNext = parsedRows.length > validated.limit;
    const albums = hasNext ? parsedRows.slice(0, validated.limit) : parsedRows;
    return {
      catalogId: validated.catalogId,
      revision: currentRevision,
      albums,
      nextCursor: hasNext ? (albums.at(-1)?.position ?? null) : null,
    };
  }

  albumAssetPage(input: CatalogV3AlbumAssetPageInput): CatalogV3AlbumAssetPage {
    const validated = parseCatalogV3AlbumAssetPageInput(input);
    this.schema();
    const currentRevision = this.revision(validated.catalogId);
    if (validated.expectedRevision !== null && validated.expectedRevision !== currentRevision) {
      throw new Error(`Catalog v3 album asset snapshot revision ${validated.expectedRevision} is stale; current revision is ${currentRevision}.`);
    }
    const album = this.database.prepare(`
      SELECT 1 FROM albums WHERE catalog_id = ? AND album_id = ?
    `).get(validated.catalogId, validated.albumId);
    if (album === undefined) throw new Error("Catalog v3 album is missing.");
    const rows = validated.cursor === null
      ? this.database.prepare(`
          SELECT aa.position, a.asset_id AS assetId, a.root_id AS rootId,
                 a.relative_path AS relativePath, a.health, a.revision
          FROM album_assets AS aa
          JOIN assets AS a ON a.catalog_id = aa.catalog_id AND a.asset_id = aa.asset_id
          WHERE aa.catalog_id = ? AND aa.album_id = ?
          ORDER BY aa.position LIMIT ?
        `).all(validated.catalogId, validated.albumId, validated.limit + 1)
      : this.database.prepare(`
          SELECT aa.position, a.asset_id AS assetId, a.root_id AS rootId,
                 a.relative_path AS relativePath, a.health, a.revision
          FROM album_assets AS aa
          JOIN assets AS a ON a.catalog_id = aa.catalog_id AND a.asset_id = aa.asset_id
          WHERE aa.catalog_id = ? AND aa.album_id = ? AND aa.position > ?
          ORDER BY aa.position LIMIT ?
        `).all(validated.catalogId, validated.albumId, validated.cursor, validated.limit + 1);
    const parsedRows: CatalogV3AlbumAssetSnapshot[] = rows.map((row) => {
      if (!isRow(row)) throw new Error("Catalog v3 album membership row is invalid.");
      const health = stringValue(row, "health");
      if (!["present", "missing", "ambiguous", "unreadable"].includes(health)) {
        throw new Error("Catalog v3 album membership health is invalid.");
      }
      return {
        position: integerValue(row, "position"),
        assetId: parseAssetId(stringValue(row, "assetId")),
        rootId: parseRootId(stringValue(row, "rootId")),
        relativePath: stringValue(row, "relativePath"),
        health: health as CatalogV3AlbumAssetSnapshot["health"],
        revision: integerValue(row, "revision"),
      };
    });
    const hasNext = parsedRows.length > validated.limit;
    const assets = hasNext ? parsedRows.slice(0, validated.limit) : parsedRows;
    return {
      catalogId: validated.catalogId,
      albumId: validated.albumId,
      revision: currentRevision,
      assets,
      nextCursor: hasNext ? (assets.at(-1)?.position ?? null) : null,
    };
  }
}

export function catalogV3Repository(database: DatabaseSync): CatalogV3Repository {
  return new CatalogV3Repository(database);
}
