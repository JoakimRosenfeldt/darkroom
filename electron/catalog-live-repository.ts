import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  createAssetId,
  createOperationId,
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
  type PresetId,
  type RootId,
} from "../lib/catalog/ids.ts";
import type {
  CatalogV3AssetHealth,
  CatalogV3AssetMetadata,
  CatalogV3FingerprintStatus,
  CatalogV3Observation,
} from "../lib/catalog/v3.ts";
import { canonicalJson } from "../lib/import/domain.ts";
import {
  CATALOG_LIVE_PAYLOAD_VERSION,
  defaultCatalogLiveMetadata,
  parseCatalogLiveApplyInput,
  parseCatalogLiveApplyResult,
  parseCatalogLiveAutoImportConfig,
  parseCatalogLiveCreateInput,
  parseCatalogLiveMutation,
  parseCatalogLiveOperationItemPayload,
  parseCatalogLiveOperationPayload,
  parseCatalogLivePresetPayload,
  parseCatalogLiveQueryInput,
  parseCatalogLiveQueryResult,
  type CatalogLiveApplyInput,
  type CatalogLiveApplyResult,
  type CatalogLiveAlbum,
  type CatalogLiveCatalogIdentity,
  type CatalogLiveEntrySnapshot,
  type CatalogLiveCreateInput,
  type CatalogLiveFingerprintTransition,
  type CatalogLiveMutation,
  type CatalogLiveObservation,
  type CatalogLiveOperation,
  type CatalogLiveOperationInput,
  type CatalogLiveOperationItem,
  type CatalogLiveOperationItemInput,
  type CatalogLiveOperationItemPayload,
  type CatalogLiveOperationState,
  type CatalogLivePreset,
  type CatalogLiveQueryInput,
  type CatalogLiveRoot,
  type CatalogLiveRootInput,
  type CatalogLiveRule,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import {
  CATALOG_V3_IDENTITY_TABLES,
  CATALOG_V3_TABLES,
  installCatalogV3Schema,
  isCatalogV3DatabaseEmpty,
  upgradeCatalogV3IdentitySchema,
  verifyCatalogV3Schema,
} from "./catalog-v3-schema.ts";
import { upgradeDevelopHistorySchema } from "./develop-history-schema.ts";
import { DevelopHistoryRepository } from "./develop-history-repository.ts";
import {
  canonicalDevelopHistoryDocument,
  createDevelopRevisionId,
  parseDevelopHistoryDocument,
} from "../lib/develop/history.ts";

type Row = Record<string, unknown>;

interface AssetRecord {
  readonly assetId: AssetId;
  readonly rootId: RootId;
  readonly relativePath: string;
  readonly observedByteLength: number | null;
  readonly observedModifiedAt: number | null;
  readonly observedAt: number | null;
  readonly localFileId: string | null;
  readonly revision: number;
  readonly health: CatalogV3AssetHealth;
  readonly formatId: string;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  readonly lensModel: string | null;
}

interface FingerprintRecord {
  readonly fingerprintId: string;
  readonly status: CatalogV3FingerprintStatus;
  readonly sha256: string | null;
  readonly observedAt: number | null;
  readonly observedByteLength: number | null;
  readonly observedModifiedAt: number | null;
  readonly localFileId: string | null;
}

type RootRecord = CatalogLiveRoot;

const ASSET_SNAPSHOT_SELECT = `
  SELECT
    a.catalog_id AS catalogId,
    e.entry_id AS entryId,
    e.source_id AS sourceId,
    e.is_original AS isOriginal,
    e.parent_entry_id AS parentEntryId,
    e.display_name AS displayName,
    e.created_at AS entryCreatedAt,
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
  FROM edit_entries AS e
  JOIN assets AS a
    ON a.catalog_id = e.catalog_id AND a.asset_id = e.source_id
  JOIN entry_metadata AS m
    ON m.catalog_id = e.catalog_id AND m.entry_id = e.entry_id
  JOIN fingerprints AS f
    ON f.catalog_id = a.catalog_id AND f.asset_id = a.asset_id
`;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowValue(row: Row, key: string): unknown {
  return Reflect.get(row, key);
}

function requiredString(row: Row, key: string, allowEmpty = false): string {
  const value = rowValue(row, key);
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\u0000")) {
    throw new Error(`Catalog live ${key} is invalid.`);
  }
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = rowValue(row, key);
  if (value === null) return null;
  return typeof value === "string" ? value : (() => {
    throw new Error(`Catalog live ${key} is invalid.`);
  })();
}

function numberValue(row: Row, key: string): number {
  const value = rowValue(row, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Catalog live ${key} is invalid.`);
  }
  return value;
}

function integerValue(row: Row, key: string): number {
  const value = numberValue(row, key);
  if (!Number.isSafeInteger(value)) throw new Error(`Catalog live ${key} is invalid.`);
  return value;
}

function nullableNumber(row: Row, key: string): number | null {
  const value = rowValue(row, key);
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : (() => { throw new Error(`Catalog live ${key} is invalid.`); })();
}

function booleanValue(row: Row, key: string): boolean {
  const value = integerValue(row, key);
  if (value !== 0 && value !== 1) throw new Error(`Catalog live ${key} is invalid.`);
  return value === 1;
}

function jsonString(value: unknown, key: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`Catalog live ${key} is not JSON.`);
  return serialized;
}

function parseJsonColumn(row: Row, key: string): unknown {
  const raw = requiredString(row, key);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Catalog live ${key} is invalid JSON.`);
  }
}

function enumString<T extends string>(value: string, key: string, values: readonly T[]): T {
  if (values.includes(value as T)) return value as T;
  throw new Error(`Catalog live ${key} is invalid.`);
}

function assertNonEmpty(value: string, key: string): void {
  if (value.length === 0 || value.includes("\u0000")) throw new Error(`Catalog live ${key} is invalid.`);
}

function assertUuid(value: string, key: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`Catalog live ${key} is invalid.`);
  }
}

function same(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function observationFromAsset(asset: AssetRecord): CatalogV3Observation | null {
  if (asset.observedAt === null && asset.observedByteLength === null && asset.observedModifiedAt === null && asset.localFileId === null) {
    return null;
  }
  if (asset.observedAt === null) throw new Error("Catalog live asset observation is incomplete.");
  return {
    byteLength: asset.observedByteLength,
    modifiedAt: asset.observedModifiedAt,
    observedAt: asset.observedAt,
    localFileId: asset.localFileId,
  };
}

function observationValues(observation: CatalogV3Observation | null): readonly SQLInputValue[] {
  return [
    observation?.byteLength ?? null,
    observation?.modifiedAt ?? null,
    observation?.observedAt ?? null,
    observation?.localFileId ?? null,
  ];
}

function observationEqual(asset: AssetRecord, observation: CatalogV3Observation | null): boolean {
  return same(asset.observedByteLength, observation?.byteLength ?? null) &&
    same(asset.observedModifiedAt, observation?.modifiedAt ?? null) &&
    same(asset.observedAt, observation?.observedAt ?? null) &&
    same(asset.localFileId, observation?.localFileId ?? null);
}

function observationIdentityEqual(asset: AssetRecord, observation: CatalogV3Observation | null): boolean {
  return same(asset.observedByteLength, observation?.byteLength ?? null) &&
    same(asset.observedModifiedAt, observation?.modifiedAt ?? null) &&
    same(asset.localFileId, observation?.localFileId ?? null);
}

function stateRank(state: CatalogLiveOperation["state"]): number {
  switch (state) {
    case "planned": return 0;
    case "running": return 1;
    case "completed":
    case "failed":
    case "cancelled": return 2;
  }
}

function stageRank(stage: CatalogLiveOperationItemPayload["stage"]): number {
  switch (stage) {
    case "planned": return 0;
    case "destination-prepared": return 1;
    case "destination-published": return 2;
    case "catalog-applied": return 3;
    case "source-cleaned": return 4;
  }
}

function metadataEqual(left: CatalogV3AssetMetadata, right: CatalogV3AssetMetadata): boolean {
  return left.archive === right.archive && left.pick === right.pick && left.rating === right.rating &&
    left.colorLabel === right.colorLabel && left.developJson === right.developJson &&
    left.developUpdatedAt === right.developUpdatedAt && left.updatedAt === right.updatedAt &&
    left.title === right.title && left.caption === right.caption && left.copyright === right.copyright &&
    left.keywordsJson === right.keywordsJson && left.rawXmp === right.rawXmp &&
    left.xmpState === right.xmpState && left.xmpMtime === right.xmpMtime && left.xmpSha256 === right.xmpSha256;
}

function metadataValues(metadata: CatalogV3AssetMetadata): readonly SQLInputValue[] {
  return [
    metadata.archive ? 1 : 0,
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

function mutationEntryId(
  mutation: Extract<CatalogLiveMutation, { kind: "metadata-patch" | "archive-set" }>,
): EntryId {
  return mutation.entryId ?? parseEntryId(mutation.assetId);
}

function mutationEntryIds(
  mutation: Extract<CatalogLiveMutation, { kind: "album-membership-replace" }>,
): readonly EntryId[] {
  return mutation.entryIds ?? mutation.assetIds.map(parseEntryId);
}

function fingerprintEqual(left: FingerprintRecord, right: CatalogLiveFingerprintTransition): boolean {
  return left.status === right.status && left.sha256 === right.sha256 &&
    left.observedAt === right.observedAt && left.observedByteLength === right.observedByteLength &&
    left.observedModifiedAt === right.observedModifiedAt && left.localFileId === right.localFileId;
}

function hasCatalogV3TablesOnly(database: DatabaseSync): boolean {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  const names = new Set<string>();
  for (const value of rows) {
    if (!isRow(value)) throw new Error("Catalog live database table manifest is invalid.");
    const name = requiredString(value, "name");
    names.add(name);
  }
  const expected = [...CATALOG_V3_TABLES, ...CATALOG_V3_IDENTITY_TABLES];
  return names.size === expected.length && expected.every((table) => names.has(table));
}

function hasRows(database: DatabaseSync, table: string): boolean {
  const row = database.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get();
  return row !== undefined;
}

function ensureLibraryStateTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS library_state (
      catalog_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL CHECK (
        json_valid(state_json) AND json_type(state_json) = 'object'
      ),
      updated_at REAL NOT NULL,
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id)
    ) STRICT;
  `);
}

function prepareFreshCatalogV3Database(database: DatabaseSync): void {
  if (isCatalogV3DatabaseEmpty(database)) {
    installCatalogV3Schema(database);
    return;
  }
  try {
    verifyCatalogV3Schema(database);
  } catch {
    throw new Error("Catalog live create requires an empty file or verified empty catalog v3 schema.");
  }
  if (!hasCatalogV3TablesOnly(database)) {
    throw new Error("Catalog live create rejects a foreign database schema.");
  }
  const populatedTable = CATALOG_V3_TABLES.find((table) => hasRows(database, table));
  if (populatedTable !== undefined) {
    throw new Error(`Catalog live create requires an empty catalog v3 schema; ${populatedTable} is populated.`);
  }
}

export class CatalogLiveRepository {
  private readonly database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
  }

  private schema(): void {
    upgradeCatalogV3IdentitySchema(this.database);
    upgradeDevelopHistorySchema(this.database);
    verifyCatalogV3Schema(this.database);
    ensureLibraryStateTable(this.database);
  }

  private transaction<T>(operation: () => T): T {
    let active = false;
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      active = true;
      const value = operation();
      this.database.exec("COMMIT;");
      active = false;
      return value;
    } catch (error) {
      if (active) {
        try { this.database.exec("ROLLBACK;"); } catch { /* preserve the original error */ }
      }
      throw error;
    }
  }

  private catalog(catalogId: CatalogId): CatalogLiveCatalogIdentity {
    const row = this.database.prepare(`
      SELECT catalog_id AS catalogId, display_name AS displayName, app_version AS appVersion,
             install_state AS installState, revision
      FROM catalog_meta WHERE catalog_id = ?
    `).get(catalogId);
    if (!isRow(row)) throw new Error("Catalog live catalog is missing.");
    const installState = requiredString(row, "installState");
    if (installState !== "ready") throw new Error("Catalog live catalog is not ready.");
    return {
      catalogId: parseCatalogId(requiredString(row, "catalogId")),
      displayName: requiredString(row, "displayName"),
      appVersion: requiredString(row, "appVersion"),
      installState: "ready",
      revision: integerValue(row, "revision"),
    };
  }

  private root(catalogId: CatalogId, rootId: RootId): RootRecord {
    const row = this.database.prepare(`
      SELECT root_id AS rootId, label, configured_path AS configuredPath,
             canonical_path AS canonicalPath, health, scan_state AS scanState,
             watch_state AS watchState, revision
      FROM roots WHERE catalog_id = ? AND root_id = ?
    `).get(catalogId, rootId);
    if (!isRow(row)) throw new Error("Catalog live root is missing.");
    const health = enumString(requiredString(row, "health"), "root health", ["online", "missing", "ambiguous", "unreadable"] as const);
    const scanState = enumString(requiredString(row, "scanState"), "root scan state", ["unknown", "complete", "partial", "failed"] as const);
    const watchState = enumString(requiredString(row, "watchState"), "root watch state", ["disabled", "active", "error"] as const);
    return {
      rootId: parseRootId(requiredString(row, "rootId")),
      label: requiredString(row, "label"),
      configuredPath: requiredString(row, "configuredPath"),
      canonicalPath: nullableString(row, "canonicalPath"),
      health,
      scanState,
      watchState,
      revision: integerValue(row, "revision"),
    };
  }

  private roots(catalogId: CatalogId): readonly RootRecord[] {
    const rows = this.database.prepare(`
      SELECT root_id AS rootId, label, configured_path AS configuredPath,
             canonical_path AS canonicalPath, health, scan_state AS scanState,
             watch_state AS watchState, revision
      FROM roots WHERE catalog_id = ? ORDER BY root_id
    `).all(catalogId);
    return rows.map((row) => this.rootFromRow(row));
  }

  private albums(catalogId: CatalogId): readonly CatalogLiveAlbum[] {
    const albums = this.database.prepare("SELECT album_id AS albumId, name, created_at AS createdAt, updated_at AS updatedAt, position FROM albums WHERE catalog_id = ? ORDER BY position").all(catalogId);
    return albums.map((value) => {
      if (!isRow(value)) throw new Error("Catalog live album row is invalid.");
      const albumId = requiredString(value, "albumId");
      const members = this.database.prepare(`
        SELECT ae.entry_id AS entryId, ee.source_id AS sourceId
        FROM album_entries AS ae
        JOIN edit_entries AS ee
          ON ee.catalog_id = ae.catalog_id AND ee.entry_id = ae.entry_id
        WHERE ae.catalog_id = ? AND ae.album_id = ? AND ee.tombstoned_at IS NULL
        ORDER BY ae.position
      `).all(catalogId, albumId).map((member) => {
        if (!isRow(member)) throw new Error("Catalog live album member row is invalid.");
        return {
          entryId: parseEntryId(requiredString(member, "entryId")),
          assetId: parseAssetId(requiredString(member, "sourceId")),
        };
      });
      return {
        albumId,
        name: requiredString(value, "name", true),
        createdAt: numberValue(value, "createdAt"),
        updatedAt: numberValue(value, "updatedAt"),
        position: integerValue(value, "position"),
        entryIds: members.map((member) => member.entryId),
        assetIds: members.map((member) => member.assetId),
      };
    });
  }

  private libraryStateJson(catalogId: CatalogId): string | null {
    const row = this.database.prepare(
      "SELECT state_json AS stateJson FROM library_state WHERE catalog_id = ?",
    ).get(catalogId);
    if (row === undefined) return null;
    if (!isRow(row)) throw new Error("Catalog live library state row is invalid.");
    return requiredString(row, "stateJson");
  }

  private applyLibraryState(
    catalogId: CatalogId,
    stateJson: string,
    now: number,
  ): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stateJson);
    } catch {
      throw new Error("Catalog live library state JSON is invalid.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Catalog live library state must be an object.");
    }
    const current = this.libraryStateJson(catalogId);
    if (current === stateJson) return false;
    this.database.prepare(`
      INSERT INTO library_state (catalog_id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (catalog_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(catalogId, stateJson, now);
    return true;
  }

  private rootFromRow(value: unknown): RootRecord {
    if (!isRow(value)) throw new Error("Catalog live root row is invalid.");
    const health = enumString(requiredString(value, "health"), "root health", ["online", "missing", "ambiguous", "unreadable"] as const);
    const scanState = enumString(requiredString(value, "scanState"), "root scan state", ["unknown", "complete", "partial", "failed"] as const);
    const watchState = enumString(requiredString(value, "watchState"), "root watch state", ["disabled", "active", "error"] as const);
    return {
      rootId: parseRootId(requiredString(value, "rootId")),
      label: requiredString(value, "label"),
      configuredPath: requiredString(value, "configuredPath"),
      canonicalPath: nullableString(value, "canonicalPath"),
      health,
      scanState,
      watchState,
      revision: integerValue(value, "revision"),
    };
  }

  private findAsset(catalogId: CatalogId, assetId: AssetId): AssetRecord | null {
    const row = this.database.prepare(`
      SELECT asset_id AS assetId, root_id AS rootId, relative_path AS relativePath,
             observed_byte_length AS observedByteLength, observed_modified_at AS observedModifiedAt,
             observed_at AS observedAt, local_file_id AS localFileId, revision, health,
             format_id AS formatId, camera_make AS cameraMake, camera_model AS cameraModel,
             lens_model AS lensModel
      FROM assets WHERE catalog_id = ? AND asset_id = ?
    `).get(catalogId, assetId);
    if (row === undefined) return null;
    if (!isRow(row)) throw new Error("Catalog live asset row is invalid.");
    return {
      assetId: parseAssetId(requiredString(row, "assetId")),
      rootId: parseRootId(requiredString(row, "rootId")),
      relativePath: requiredString(row, "relativePath"),
      observedByteLength: nullableNumber(row, "observedByteLength"),
      observedModifiedAt: nullableNumber(row, "observedModifiedAt"),
      observedAt: nullableNumber(row, "observedAt"),
      localFileId: nullableString(row, "localFileId"),
      revision: integerValue(row, "revision"),
      health: enumString(requiredString(row, "health"), "asset health", ["present", "missing", "ambiguous", "unreadable"] as const),
      formatId: requiredString(row, "formatId"),
      cameraMake: nullableString(row, "cameraMake"),
      cameraModel: nullableString(row, "cameraModel"),
      lensModel: nullableString(row, "lensModel"),
    };
  }

  private asset(catalogId: CatalogId, assetId: AssetId): AssetRecord {
    const result = this.findAsset(catalogId, assetId);
    if (result === null) throw new Error("Catalog live asset is missing.");
    return result;
  }

  private findAssetByPath(catalogId: CatalogId, rootId: RootId, relativePath: string): AssetRecord | null {
    const row = this.database.prepare(`
      SELECT asset_id AS assetId FROM assets
      WHERE catalog_id = ? AND root_id = ? AND relative_path = ?
    `).get(catalogId, rootId, relativePath);
    if (!isRow(row)) return null;
    return this.findAsset(catalogId, parseAssetId(requiredString(row, "assetId")));
  }

  private fingerprint(catalogId: CatalogId, assetId: AssetId): FingerprintRecord {
    const row = this.database.prepare(`
      SELECT fingerprint_id AS fingerprintId, status, sha256,
             observed_at AS observedAt, observed_byte_length AS observedByteLength,
             observed_modified_at AS observedModifiedAt, local_file_id AS localFileId
      FROM fingerprints WHERE catalog_id = ? AND asset_id = ?
    `).get(catalogId, assetId);
    if (!isRow(row)) throw new Error("Catalog live fingerprint is missing.");
    return {
      fingerprintId: requiredString(row, "fingerprintId"),
      status: enumString(requiredString(row, "status"), "fingerprint status", ["missing", "hashing", "valid", "stale", "failed"] as const),
      sha256: nullableString(row, "sha256"),
      observedAt: nullableNumber(row, "observedAt"),
      observedByteLength: nullableNumber(row, "observedByteLength"),
      observedModifiedAt: nullableNumber(row, "observedModifiedAt"),
      localFileId: nullableString(row, "localFileId"),
    };
  }

  private metadata(catalogId: CatalogId, entryId: EntryId): CatalogV3AssetMetadata {
    const row = this.database.prepare(`
      SELECT archive, pick, rating, color_label AS colorLabel,
             develop_json AS developJson, develop_updated_at AS developUpdatedAt,
             updated_at AS updatedAt, title, caption, copyright,
             keywords_json AS keywordsJson, raw_xmp AS rawXmp, xmp_state AS xmpState,
             xmp_mtime AS xmpMtime, xmp_sha256 AS xmpSha256
      FROM entry_metadata WHERE catalog_id = ? AND entry_id = ?
    `).get(catalogId, entryId);
    if (!isRow(row)) throw new Error("Catalog live metadata is missing.");
    const xmpState = enumString(requiredString(row, "xmpState"), "metadata XMP state", ["unknown", "absent", "preserved", "malformed"] as const);
    const rawXmp = nullableString(row, "rawXmp");
    if ((xmpState === "preserved") !== (rawXmp !== null)) throw new Error("Catalog live metadata XMP is inconsistent.");
    const keywordsJson = requiredString(row, "keywordsJson");
    let keywords: unknown;
    try { keywords = JSON.parse(keywordsJson) as unknown; } catch { throw new Error("Catalog live metadata keywords are invalid."); }
    if (!Array.isArray(keywords)) throw new Error("Catalog live metadata keywords are invalid.");
    const developJson = nullableString(row, "developJson");
    if (developJson !== null) {
      try { JSON.parse(developJson); } catch { throw new Error("Catalog live metadata develop JSON is invalid."); }
    }
    return {
      archive: booleanValue(row, "archive"),
      pick: enumString(requiredString(row, "pick"), "metadata pick", ["none", "pick", "reject"] as const),
      rating: integerValue(row, "rating") as CatalogV3AssetMetadata["rating"],
      colorLabel: nullableString(row, "colorLabel") as CatalogV3AssetMetadata["colorLabel"],
      developJson,
      developUpdatedAt: numberValue(row, "developUpdatedAt"),
      updatedAt: numberValue(row, "updatedAt"),
      title: nullableString(row, "title"),
      caption: nullableString(row, "caption"),
      copyright: nullableString(row, "copyright"),
      keywordsJson,
      rawXmp,
      xmpState,
      xmpMtime: nullableNumber(row, "xmpMtime"),
      xmpSha256: nullableString(row, "xmpSha256"),
    };
  }

  private upsertMetadata(catalogId: CatalogId, entryId: EntryId, metadata: CatalogV3AssetMetadata): boolean {
    const current = this.metadata(catalogId, entryId);
    if (metadataEqual(current, metadata)) return false;
    const result = this.database.prepare(`
      UPDATE entry_metadata SET archive = ?, pick = ?, rating = ?, color_label = ?,
        develop_json = ?, develop_updated_at = ?, updated_at = ?, title = ?, caption = ?,
        copyright = ?, keywords_json = ?, raw_xmp = ?, xmp_state = ?, xmp_mtime = ?, xmp_sha256 = ?
      WHERE catalog_id = ? AND entry_id = ?
    `).run(...metadataValues(metadata), catalogId, entryId);
    if (result.changes !== 1) throw new Error("Catalog live metadata update failed.");
    this.database.prepare(`
      UPDATE asset_metadata SET archive = ?, pick = ?, rating = ?, color_label = ?,
        develop_json = ?, develop_updated_at = ?, updated_at = ?, title = ?, caption = ?,
        copyright = ?, keywords_json = ?, raw_xmp = ?, xmp_state = ?, xmp_mtime = ?, xmp_sha256 = ?
      WHERE catalog_id = ? AND asset_id = (
        SELECT source_id FROM edit_entries
        WHERE catalog_id = ? AND entry_id = ? AND is_original = 1
      )
    `).run(...metadataValues(metadata), catalogId, catalogId, entryId);
    return true;
  }

  private invalidateFingerprint(catalogId: CatalogId, assetId: AssetId, now: number): boolean {
    const fingerprint = this.fingerprint(catalogId, assetId);
    if (fingerprint.status === "missing" && fingerprint.sha256 === null) return false;
    const result = this.database.prepare(`
      UPDATE fingerprints SET status = 'stale', sha256 = NULL, updated_at = ?
      WHERE catalog_id = ? AND asset_id = ?
    `).run(now, catalogId, assetId);
    return result.changes === 1;
  }

  private refreshFingerprintObservation(catalogId: CatalogId, assetId: AssetId, observation: CatalogV3Observation | null, now: number): boolean {
    if (observation === null) return false;
    const fingerprint = this.fingerprint(catalogId, assetId);
    if (fingerprint.status !== "valid" || fingerprint.observedAt === observation.observedAt) return false;
    const result = this.database.prepare("UPDATE fingerprints SET observed_at = ?, updated_at = ? WHERE catalog_id = ? AND asset_id = ?").run(observation.observedAt, now, catalogId, assetId);
    return result.changes === 1;
  }

  private upsertObservation(
    catalogId: CatalogId,
    assetId: AssetId,
    rootId: RootId,
    relativePath: string,
    observation: CatalogV3Observation | null,
    health: CatalogV3AssetHealth,
    formatId: string,
    cameraMake: string | null,
    cameraModel: string | null,
    lensModel: string | null,
    now: number,
  ): boolean {
    const current = this.asset(catalogId, assetId);
    if (current.rootId !== rootId || current.relativePath !== relativePath) {
      throw new Error("Catalog live asset identity conflicts with its path.");
    }
    const changed = !observationEqual(current, observation) || current.health !== health ||
      current.formatId !== formatId || current.cameraMake !== cameraMake ||
      current.cameraModel !== cameraModel || current.lensModel !== lensModel;
    if (!changed) return false;
    const identityChanged = !observationIdentityEqual(current, observation);
    const result = this.database.prepare(`
      UPDATE assets SET observed_byte_length = ?, observed_modified_at = ?, observed_at = ?,
        local_file_id = ?, health = ?, format_id = ?, camera_make = ?, camera_model = ?,
        lens_model = ?, revision = revision + 1
      WHERE catalog_id = ? AND asset_id = ?
    `).run(
      ...observationValues(observation), health, formatId, cameraMake, cameraModel, lensModel,
      catalogId, assetId,
    );
    if (result.changes !== 1) throw new Error("Catalog live asset update failed.");
    if (identityChanged) this.invalidateFingerprint(catalogId, assetId, now);
    else this.refreshFingerprintObservation(catalogId, assetId, observation, now);
    return true;
  }

  private insertAsset(
    catalogId: CatalogId,
    assetId: AssetId,
    rootId: RootId,
    relativePath: string,
    observation: CatalogV3Observation | null,
    health: CatalogV3AssetHealth,
    formatId: string,
    cameraMake: string | null,
    cameraModel: string | null,
    lensModel: string | null,
    metadata: CatalogV3AssetMetadata,
    now: number,
  ): void {
    this.database.prepare(`
      INSERT INTO assets (
        catalog_id, asset_id, root_id, relative_path, observed_byte_length,
        observed_modified_at, observed_at, local_file_id, revision, health,
        format_id, camera_make, camera_model, lens_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      catalogId, assetId, rootId, relativePath, ...observationValues(observation),
      health, formatId, cameraMake, cameraModel, lensModel,
    );
    this.database.prepare(`
      INSERT INTO asset_metadata (
        catalog_id, asset_id, archive, pick, rating, color_label, develop_json,
        develop_updated_at, updated_at, title, caption, copyright, keywords_json,
        raw_xmp, xmp_state, xmp_mtime, xmp_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(catalogId, assetId, ...metadataValues(metadata));
    const fingerprintId = createAssetId();
    this.database.prepare(`
      INSERT INTO fingerprints (
        catalog_id, fingerprint_id, asset_id, status, sha256, observed_at,
        observed_byte_length, observed_modified_at, local_file_id, updated_at
      ) VALUES (?, ?, ?, 'missing', NULL, ?, ?, ?, ?, ?)
    `).run(catalogId, fingerprintId, assetId, observation?.observedAt ?? null,
      observation?.byteLength ?? null, observation?.modifiedAt ?? null, observation?.localFileId ?? null, now);
  }

  private updateRoot(catalogId: CatalogId, rootId: RootId, next: CatalogLiveRootInput): boolean {
    const current = this.root(catalogId, rootId);
    if (current.label === next.label && current.configuredPath === next.configuredPath &&
      current.canonicalPath === next.canonicalPath && current.health === next.health &&
      current.scanState === next.scanState && current.watchState === next.watchState) return false;
    const result = this.database.prepare(`
      UPDATE roots SET label = ?, configured_path = ?, canonical_path = ?, health = ?,
        scan_state = ?, watch_state = ?, revision = revision + 1
      WHERE catalog_id = ? AND root_id = ?
    `).run(next.label, next.configuredPath, next.canonicalPath, next.health, next.scanState, next.watchState, catalogId, rootId);
    if (result.changes !== 1) throw new Error("Catalog live root update failed.");
    return true;
  }

  private applyRootUpsert(catalogId: CatalogId, input: CatalogLiveRootInput): boolean {
    const current = this.findRoot(catalogId, input.rootId);
    if (current !== null) return this.updateRoot(catalogId, input.rootId, input);
    this.database.prepare(`
      INSERT INTO roots (catalog_id, root_id, label, configured_path, canonical_path,
        health, scan_state, watch_state, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(catalogId, input.rootId, input.label, input.configuredPath, input.canonicalPath,
      input.health, input.scanState, input.watchState);
    return true;
  }

  private findRoot(catalogId: CatalogId, rootId: RootId): RootRecord | null {
    const row = this.database.prepare("SELECT root_id AS rootId, label, configured_path AS configuredPath, canonical_path AS canonicalPath, health, scan_state AS scanState, watch_state AS watchState, revision FROM roots WHERE catalog_id = ? AND root_id = ?").get(catalogId, rootId);
    return row === undefined ? null : this.rootFromRow(row);
  }

  private requireRoot(catalogId: CatalogId, rootId: RootId): RootRecord {
    return this.root(catalogId, rootId);
  }

  private applyReconcile(catalogId: CatalogId, rootId: RootId, observations: readonly CatalogLiveObservation[], complete: boolean, now: number): boolean {
    this.requireRoot(catalogId, rootId);
    const seen = new Set<string>();
    const seenAssets = new Set<string>();
    let changed = false;
    for (const entry of observations) {
      if (seen.has(entry.relativePath)) throw new Error("Catalog live reconcile contains a duplicate path.");
      seen.add(entry.relativePath);
      const pathAsset = this.findAssetByPath(catalogId, rootId, entry.relativePath);
      const idAsset = entry.assetId === undefined ? null : this.findAsset(catalogId, entry.assetId);
      if (entry.assetId !== undefined && idAsset === null) {
        const createdId = entry.assetId;
        if (pathAsset !== null) throw new Error("Catalog live reconcile asset ID conflicts with its path.");
        this.insertAsset(catalogId, createdId, rootId, entry.relativePath, entry.observation, entry.health,
          entry.formatId, entry.cameraMake, entry.cameraModel, entry.lensModel,
          defaultCatalogLiveMetadata(now), now);
        changed = true;
        seenAssets.add(createdId);
        continue;
      }
      if (idAsset !== null && (idAsset.rootId !== rootId || idAsset.relativePath !== entry.relativePath)) {
        throw new Error("Catalog live reconcile asset ID conflicts with its path.");
      }
      const asset = idAsset ?? pathAsset;
      if (asset === null) {
        const createdId = createAssetId();
        this.insertAsset(catalogId, createdId, rootId, entry.relativePath, entry.observation, entry.health,
          entry.formatId, entry.cameraMake, entry.cameraModel, entry.lensModel,
          defaultCatalogLiveMetadata(now), now);
        changed = true;
        seenAssets.add(createdId);
      } else {
        if (entry.observation === null) {
          if (asset.rootId !== rootId || asset.relativePath !== entry.relativePath) {
            throw new Error("Catalog live reconcile asset identity conflicts with its path.");
          }
          if (asset.health !== entry.health) {
            this.database.prepare("UPDATE assets SET health = ?, revision = revision + 1 WHERE catalog_id = ? AND asset_id = ?").run(entry.health, catalogId, asset.assetId);
            changed = true;
          }
          seenAssets.add(asset.assetId);
          continue;
        }
        changed = this.upsertObservation(catalogId, asset.assetId, rootId, entry.relativePath,
          entry.observation, entry.health, entry.formatId, entry.cameraMake, entry.cameraModel,
          entry.lensModel, now) || changed;
        seenAssets.add(asset.assetId);
      }
    }
    if (complete) {
    const absentRows = this.database.prepare(`
      SELECT asset_id AS assetId, root_id AS rootId, relative_path AS relativePath,
        observed_byte_length AS observedByteLength, observed_modified_at AS observedModifiedAt,
        observed_at AS observedAt, local_file_id AS localFileId, revision, health,
        format_id AS formatId, camera_make AS cameraMake, camera_model AS cameraModel,
        lens_model AS lensModel
      FROM assets WHERE catalog_id = ? AND root_id = ?
    `).all(catalogId, rootId);
    for (const row of absentRows) {
      const asset = this.assetFromRow(row);
      if (seenAssets.has(asset.assetId)) continue;
      if (asset.health === "missing") continue;
      const result = this.database.prepare("UPDATE assets SET health = 'missing', revision = revision + 1 WHERE catalog_id = ? AND asset_id = ?").run(catalogId, asset.assetId);
      if (result.changes === 1) changed = true;
    }
    }
    const root = this.root(catalogId, rootId);
    const nextScanState = complete ? "complete" : "partial";
    if (root.scanState !== nextScanState) {
      this.database.prepare("UPDATE roots SET scan_state = ?, revision = revision + 1 WHERE catalog_id = ? AND root_id = ?").run(nextScanState, catalogId, rootId);
      changed = true;
    }
    return changed;
  }

  private assetFromRow(value: unknown): AssetRecord {
    if (!isRow(value)) throw new Error("Catalog live asset row is invalid.");
    return {
      assetId: parseAssetId(requiredString(value, "assetId")),
      rootId: parseRootId(requiredString(value, "rootId")),
      relativePath: requiredString(value, "relativePath"),
      observedByteLength: nullableNumber(value, "observedByteLength"),
      observedModifiedAt: nullableNumber(value, "observedModifiedAt"),
      observedAt: nullableNumber(value, "observedAt"),
      localFileId: nullableString(value, "localFileId"),
      revision: integerValue(value, "revision"),
      health: enumString(requiredString(value, "health"), "asset health", ["present", "missing", "ambiguous", "unreadable"] as const),
      formatId: requiredString(value, "formatId"),
      cameraMake: nullableString(value, "cameraMake"),
      cameraModel: nullableString(value, "cameraModel"),
      lensModel: nullableString(value, "lensModel"),
    };
  }

  private applyMetadataPatch(catalogId: CatalogId, entryId: EntryId, patch: CatalogLiveMutation & { kind: "metadata-patch" }, now: number): boolean {
    const current = this.metadata(catalogId, entryId);
    const next: CatalogV3AssetMetadata = {
      ...current,
      ...(patch.patch.archive === undefined ? {} : { archive: patch.patch.archive }),
      ...(patch.patch.pick === undefined ? {} : { pick: patch.patch.pick }),
      ...(patch.patch.rating === undefined ? {} : { rating: patch.patch.rating }),
      ...(patch.patch.colorLabel === undefined ? {} : { colorLabel: patch.patch.colorLabel }),
      ...(patch.patch.developJson === undefined ? {} : { developJson: patch.patch.developJson }),
      ...(patch.patch.developUpdatedAt === undefined ? {} : { developUpdatedAt: Math.max(current.developUpdatedAt, patch.patch.developUpdatedAt) }),
      updatedAt: patch.patch.updatedAt ?? now,
      ...(patch.patch.title === undefined ? {} : { title: patch.patch.title }),
      ...(patch.patch.caption === undefined ? {} : { caption: patch.patch.caption }),
      ...(patch.patch.copyright === undefined ? {} : { copyright: patch.patch.copyright }),
      ...(patch.patch.keywordsJson === undefined ? {} : { keywordsJson: patch.patch.keywordsJson }),
      ...(patch.patch.rawXmp === undefined ? {} : { rawXmp: patch.patch.rawXmp }),
      ...(patch.patch.xmpState === undefined ? {} : { xmpState: patch.patch.xmpState }),
      ...(patch.patch.xmpMtime === undefined ? {} : { xmpMtime: patch.patch.xmpMtime }),
      ...(patch.patch.xmpSha256 === undefined ? {} : { xmpSha256: patch.patch.xmpSha256 }),
    };
    if ((next.xmpState === "preserved") !== (next.rawXmp !== null) || (next.xmpState === "absent" && next.rawXmp !== null)) {
      throw new Error("Catalog live metadata XMP state is inconsistent.");
    }
    if (next.developJson !== null) {
      try { JSON.parse(next.developJson); } catch { throw new Error("Catalog live develop JSON is invalid."); }
    }
    let keywords: unknown;
    try { keywords = JSON.parse(next.keywordsJson); } catch { throw new Error("Catalog live keywords JSON is invalid."); }
    if (!Array.isArray(keywords)) throw new Error("Catalog live keywords JSON is invalid.");
    return this.upsertMetadata(catalogId, entryId, next);
  }

  private applyEditEntryCreate(
    catalogId: CatalogId,
    mutation: Extract<CatalogLiveMutation, { kind: "edit-entry-create" }>,
  ): boolean {
    const existing = this.database.prepare(
      "SELECT 1 FROM edit_entries WHERE catalog_id = ? AND entry_id = ?",
    ).get(catalogId, mutation.entryId);
    if (existing !== undefined) throw new Error("Catalog live edit entry already exists.");
    const source = this.database.prepare(`
      SELECT source_id AS sourceId
      FROM edit_entries
      WHERE catalog_id = ? AND entry_id = ? AND tombstoned_at IS NULL
    `).get(catalogId, mutation.sourceEntryId);
    if (!isRow(source)) throw new Error("Catalog live source edit entry is missing.");
    const sourceId = parseSourceId(requiredString(source, "sourceId"));
    const original = this.database.prepare(`
      SELECT entry_id AS entryId
      FROM edit_entries
      WHERE catalog_id = ? AND source_id = ? AND is_original = 1 AND tombstoned_at IS NULL
    `).get(catalogId, sourceId);
    if (!isRow(original)) throw new Error("Catalog live original edit entry is missing.");
    const parentEntryId = parseEntryId(requiredString(original, "entryId"));
    const sourceMetadata = this.database.prepare(`
      SELECT updated_at AS updatedAt
      FROM entry_metadata
      WHERE catalog_id = ? AND entry_id = ?
    `).get(catalogId, mutation.sourceEntryId);
    if (!isRow(sourceMetadata)) throw new Error("Catalog live source edit metadata is missing.");
    if (numberValue(sourceMetadata, "updatedAt") !== mutation.expectedSourceMetadataUpdatedAt) {
      throw new Error("Catalog live source edit metadata changed before the copy was created.");
    }
    this.database.prepare(`
      INSERT INTO edit_entries (
        catalog_id, entry_id, source_id, is_original, parent_entry_id, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      catalogId,
      mutation.entryId,
      sourceId,
      parentEntryId,
      mutation.displayName,
      mutation.createdAt,
      mutation.createdAt,
    );
    const metadata = this.database.prepare(`
      INSERT INTO entry_metadata (
        catalog_id, entry_id, archive, pick, rating, color_label, develop_json,
        develop_updated_at, updated_at, title, caption, copyright, keywords_json,
        raw_xmp, xmp_state, xmp_mtime, xmp_sha256
      )
      SELECT catalog_id, ?, archive, pick, rating, color_label, ?,
        ?, ?, title, caption, copyright, keywords_json,
        NULL, 'absent', NULL, NULL
      FROM entry_metadata
      WHERE catalog_id = ? AND entry_id = ?
    `).run(
      mutation.entryId,
      mutation.developJson,
      mutation.createdAt,
      mutation.createdAt,
      catalogId,
      mutation.sourceEntryId,
    );
    if (metadata.changes !== 1) throw new Error("Catalog live source edit metadata is missing.");

    const albums = this.database.prepare(`
      SELECT album_id AS albumId
      FROM album_entries
      WHERE catalog_id = ? AND entry_id = ?
      ORDER BY album_id
    `).all(catalogId, mutation.sourceEntryId);
    for (const album of albums) {
      if (!isRow(album)) throw new Error("Catalog live source album membership is invalid.");
      const albumId = requiredString(album, "albumId");
      const rows = this.database.prepare(`
        SELECT entry_id AS entryId
        FROM album_entries
        WHERE catalog_id = ? AND album_id = ?
        ORDER BY position
      `).all(catalogId, albumId);
      const entryIds = rows.map((row) => {
        if (!isRow(row)) throw new Error("Catalog live album membership is invalid.");
        return parseEntryId(requiredString(row, "entryId"));
      });
      const sourceIndex = entryIds.indexOf(mutation.sourceEntryId);
      entryIds.splice(sourceIndex + 1, 0, mutation.entryId);
      this.applyAlbumMembership(catalogId, {
        kind: "album-membership-replace",
        albumId,
        entryIds,
      });
    }
    return true;
  }

  private applyEditEntryRename(
    catalogId: CatalogId,
    mutation: Extract<CatalogLiveMutation, { kind: "edit-entry-rename" }>,
  ): boolean {
    const current = this.database.prepare(`
      SELECT is_original AS isOriginal, display_name AS displayName
      FROM edit_entries
      WHERE catalog_id = ? AND entry_id = ? AND tombstoned_at IS NULL
    `).get(catalogId, mutation.entryId);
    if (!isRow(current)) throw new Error("Catalog live edit entry is missing.");
    if (booleanValue(current, "isOriginal")) {
      throw new Error("Catalog live original edit entry cannot be renamed.");
    }
    if (nullableString(current, "displayName") === mutation.displayName) return false;
    const result = this.database.prepare(`
      UPDATE edit_entries SET display_name = ?, updated_at = ?
      WHERE catalog_id = ? AND entry_id = ? AND is_original = 0
    `).run(mutation.displayName, mutation.updatedAt, catalogId, mutation.entryId);
    if (result.changes !== 1) throw new Error("Catalog live edit entry rename failed.");
    return true;
  }

  private applyEditEntryDelete(
    catalogId: CatalogId,
    mutation: Extract<CatalogLiveMutation, { kind: "edit-entry-delete" }>,
  ): boolean {
    const current = this.database.prepare(`
      SELECT is_original AS isOriginal, tombstoned_at AS tombstonedAt
      FROM edit_entries
      WHERE catalog_id = ? AND entry_id = ?
    `).get(catalogId, mutation.entryId);
    if (current === undefined) return false;
    if (!isRow(current)) throw new Error("Catalog live edit entry is invalid.");
    if (booleanValue(current, "isOriginal")) {
      throw new Error("Catalog live original edit entry cannot be deleted.");
    }
    if (nullableNumber(current, "tombstonedAt") !== null) return false;
    const result = this.database.prepare(
      "UPDATE edit_entries SET tombstoned_at = ?, updated_at = ? WHERE catalog_id = ? AND entry_id = ? AND is_original = 0 AND tombstoned_at IS NULL",
    ).run(mutation.tombstonedAt, mutation.tombstonedAt, catalogId, mutation.entryId);
    if (result.changes !== 1) throw new Error("Catalog live edit entry tombstone failed.");
    return true;
  }

  private applyFingerprint(catalogId: CatalogId, transition: CatalogLiveFingerprintTransition, now: number): boolean {
    const asset = this.asset(catalogId, transition.assetId);
    const fingerprint = this.fingerprint(catalogId, transition.assetId);
    if (transition.status === "valid") {
      if (transition.sha256 === null || transition.observedAt === null ||
        (transition.observedByteLength === null && transition.observedModifiedAt === null && transition.localFileId === null)) {
        throw new Error("Catalog live valid fingerprint needs observation proof.");
      }
      const observation = observationFromAsset(asset);
      if (observation === null || observation.observedAt !== transition.observedAt ||
        observation.byteLength !== transition.observedByteLength || observation.modifiedAt !== transition.observedModifiedAt ||
        observation.localFileId !== transition.localFileId) {
        throw new Error("Catalog live fingerprint proof does not match the asset observation.");
      }
    } else if (transition.sha256 !== null) {
      throw new Error("Catalog live non-valid fingerprint cannot have a digest.");
    }
    if (fingerprintEqual(fingerprint, transition)) return false;
    const result = this.database.prepare(`
      UPDATE fingerprints SET status = ?, sha256 = ?, observed_at = ?, observed_byte_length = ?,
        observed_modified_at = ?, local_file_id = ?, updated_at = ?
      WHERE catalog_id = ? AND asset_id = ?
    `).run(transition.status, transition.sha256, transition.observedAt, transition.observedByteLength,
      transition.observedModifiedAt, transition.localFileId, now, catalogId, transition.assetId);
    if (result.changes !== 1) throw new Error("Catalog live fingerprint update failed.");
    return true;
  }

  private applyAlbumCreate(catalogId: CatalogId, mutation: Extract<CatalogLiveMutation, { kind: "album-create" }>): boolean {
    assertNonEmpty(mutation.albumId, "albumId");
    const current = this.database.prepare("SELECT name, created_at AS createdAt, updated_at AS updatedAt, position FROM albums WHERE catalog_id = ? AND album_id = ?").get(catalogId, mutation.albumId);
    if (current !== undefined) {
      if (!isRow(current) || requiredString(current, "name", true) !== mutation.name || numberValue(current, "createdAt") !== mutation.createdAt || numberValue(current, "updatedAt") !== mutation.updatedAt || integerValue(current, "position") !== mutation.position) throw new Error("Catalog live album create conflicts with existing album.");
      return false;
    }
    this.database.prepare("INSERT INTO albums (catalog_id, album_id, name, created_at, updated_at, position) VALUES (?, ?, ?, ?, ?, ?)").run(catalogId, mutation.albumId, mutation.name, mutation.createdAt, mutation.updatedAt, mutation.position);
    return true;
  }

  private applyAlbumRename(catalogId: CatalogId, mutation: Extract<CatalogLiveMutation, { kind: "album-rename" }>): boolean {
    const current = this.database.prepare("SELECT name, updated_at AS updatedAt FROM albums WHERE catalog_id = ? AND album_id = ?").get(catalogId, mutation.albumId);
    if (!isRow(current)) throw new Error("Catalog live album is missing.");
    if (requiredString(current, "name", true) === mutation.name && numberValue(current, "updatedAt") === mutation.updatedAt) return false;
    this.database.prepare("UPDATE albums SET name = ?, updated_at = ? WHERE catalog_id = ? AND album_id = ?").run(mutation.name, mutation.updatedAt, catalogId, mutation.albumId);
    return true;
  }

  private applyAlbumDelete(catalogId: CatalogId, albumId: string): boolean {
    const current = this.database.prepare("SELECT 1 FROM albums WHERE catalog_id = ? AND album_id = ?").get(catalogId, albumId);
    if (current === undefined) return false;
    this.database.prepare("DELETE FROM album_entries WHERE catalog_id = ? AND album_id = ?").run(catalogId, albumId);
    this.database.prepare("DELETE FROM album_assets WHERE catalog_id = ? AND album_id = ?").run(catalogId, albumId);
    this.database.prepare("DELETE FROM albums WHERE catalog_id = ? AND album_id = ?").run(catalogId, albumId);
    return true;
  }

  private applyAlbumMembership(catalogId: CatalogId, mutation: Extract<CatalogLiveMutation, { kind: "album-membership-replace" }>): boolean {
    const album = this.database.prepare("SELECT 1 FROM albums WHERE catalog_id = ? AND album_id = ?").get(catalogId, mutation.albumId);
    if (album === undefined) throw new Error("Catalog live album is missing.");
    const seen = new Set<string>();
    const entryIds = mutationEntryIds(mutation);
    for (const entryId of entryIds) {
      if (seen.has(entryId)) throw new Error("Catalog live album membership contains duplicate entries.");
      seen.add(entryId);
      if (this.database.prepare("SELECT 1 FROM edit_entries WHERE catalog_id = ? AND entry_id = ?").get(catalogId, entryId) === undefined) {
        throw new Error("Catalog live album entry is missing.");
      }
    }
    const currentRows = this.database.prepare("SELECT entry_id AS entryId FROM album_entries WHERE catalog_id = ? AND album_id = ? ORDER BY position").all(catalogId, mutation.albumId);
    const current = currentRows.map((row) => isRow(row) ? parseEntryId(requiredString(row, "entryId")) : (() => { throw new Error("Catalog live album membership is invalid."); })());
    if (current.length === entryIds.length && current.every((id, index) => id === entryIds[index])) return false;
    this.database.prepare("DELETE FROM album_entries WHERE catalog_id = ? AND album_id = ?").run(catalogId, mutation.albumId);
    this.database.prepare("DELETE FROM album_assets WHERE catalog_id = ? AND album_id = ?").run(catalogId, mutation.albumId);
    const insertEntry = this.database.prepare("INSERT INTO album_entries (catalog_id, album_id, entry_id, position) VALUES (?, ?, ?, ?)");
    const insertAsset = this.database.prepare(`
      INSERT INTO album_assets (catalog_id, album_id, asset_id, position)
      SELECT catalog_id, ?, source_id, ? FROM edit_entries
      WHERE catalog_id = ? AND entry_id = ? AND is_original = 1
    `);
    entryIds.forEach((entryId, position) => {
      insertEntry.run(catalogId, mutation.albumId, entryId, position);
      insertAsset.run(mutation.albumId, position, catalogId, entryId);
    });
    return true;
  }

  private applyPresetUpsert(catalogId: CatalogId, mutation: Extract<CatalogLiveMutation, { kind: "preset-upsert" }>, now: number): boolean {
    const current = this.database.prepare("SELECT name, payload_json AS payloadJson, revision, created_at AS createdAt, updated_at AS updatedAt FROM import_presets WHERE catalog_id = ? AND preset_id = ?").get(catalogId, mutation.presetId);
    const payloadJson = jsonString(mutation.payload, "preset payload");
    if (current === undefined) {
      this.database.prepare("INSERT INTO import_presets (catalog_id, preset_id, name, payload_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").run(catalogId, mutation.presetId, mutation.name, payloadJson, mutation.createdAt, mutation.updatedAt);
      if (mutation.payload.isDefault) this.clearOtherPresetDefaults(catalogId, mutation.presetId, now);
      return true;
    }
    if (!isRow(current)) throw new Error("Catalog live preset row is invalid.");
    parseCatalogLivePresetPayload(parseJsonColumn(current, "payloadJson"));
    const sameValue = requiredString(current, "name") === mutation.name && requiredString(current, "payloadJson") === payloadJson;
    let changed = false;
    if (!sameValue) {
      this.database.prepare("UPDATE import_presets SET name = ?, payload_json = ?, revision = revision + 1, updated_at = ? WHERE catalog_id = ? AND preset_id = ?").run(mutation.name, payloadJson, mutation.updatedAt, catalogId, mutation.presetId);
      changed = true;
    }
    if (mutation.payload.isDefault) changed = this.clearOtherPresetDefaults(catalogId, mutation.presetId, now) || changed;
    return changed;
  }

  private clearOtherPresetDefaults(catalogId: CatalogId, exceptPresetId: PresetId, now: number): boolean {
    const rows = this.database.prepare("SELECT preset_id AS presetId, payload_json AS payloadJson FROM import_presets WHERE catalog_id = ? AND preset_id <> ?").all(catalogId, exceptPresetId);
    let changed = false;
    for (const row of rows) {
      if (!isRow(row)) throw new Error("Catalog live preset row is invalid.");
      const payload = parseCatalogLivePresetPayload(parseJsonColumn(row, "payloadJson"));
      if (!payload.isDefault) continue;
      const next = { ...payload, isDefault: false };
      this.database.prepare("UPDATE import_presets SET payload_json = ?, revision = revision + 1, updated_at = ? WHERE catalog_id = ? AND preset_id = ?").run(jsonString(next, "preset payload"), now, catalogId, requiredString(row, "presetId"));
      changed = true;
    }
    return changed;
  }

  private applyPresetDefault(catalogId: CatalogId, presetId: PresetId, now: number): boolean {
    const row = this.database.prepare("SELECT payload_json AS payloadJson FROM import_presets WHERE catalog_id = ? AND preset_id = ?").get(catalogId, presetId);
    if (!isRow(row)) throw new Error("Catalog live preset is missing.");
    const payload = parseCatalogLivePresetPayload(parseJsonColumn(row, "payloadJson"));
    let changed = false;
    if (payload.isDefault !== true) {
      this.database.prepare("UPDATE import_presets SET payload_json = ?, revision = revision + 1, updated_at = ? WHERE catalog_id = ? AND preset_id = ?").run(jsonString({ ...payload, isDefault: true }, "preset payload"), now, catalogId, presetId);
      changed = true;
    }
    return this.clearOtherPresetDefaults(catalogId, presetId, now) || changed;
  }

  private applyRuleUpsert(catalogId: CatalogId, mutation: Extract<CatalogLiveMutation, { kind: "rule-upsert" }>): boolean {
    assertUuid(mutation.ruleId, "ruleId");
    this.requireRoot(catalogId, mutation.destinationRootId);
    this.requireRoot(catalogId, mutation.config.ingressRootId);
    const preset = this.database.prepare("SELECT payload_json AS payloadJson FROM import_presets WHERE catalog_id = ? AND preset_id = ?").get(catalogId, mutation.presetId);
    if (!isRow(preset)) throw new Error("Catalog live rule preset is missing.");
    parseCatalogLivePresetPayload(parseJsonColumn(preset, "payloadJson"));
    const configJson = jsonString(mutation.config, "Auto Import config");
    const current = this.database.prepare("SELECT name, enabled, destination_root_id AS destinationRootId, preset_id AS presetId, config_json AS configJson, created_at AS createdAt, updated_at AS updatedAt FROM auto_import_rules WHERE catalog_id = ? AND rule_id = ?").get(catalogId, mutation.ruleId);
    if (current === undefined) {
      this.database.prepare("INSERT INTO auto_import_rules (catalog_id, rule_id, name, enabled, destination_root_id, preset_id, config_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").run(catalogId, mutation.ruleId, mutation.name, mutation.enabled ? 1 : 0, mutation.destinationRootId, mutation.presetId, configJson, mutation.createdAt, mutation.updatedAt);
      return true;
    }
    if (!isRow(current)) throw new Error("Catalog live rule row is invalid.");
    parseCatalogLiveAutoImportConfig(parseJsonColumn(current, "configJson"));
    const unchanged = requiredString(current, "name") === mutation.name && booleanValue(current, "enabled") === mutation.enabled && requiredString(current, "destinationRootId") === mutation.destinationRootId && requiredString(current, "presetId") === mutation.presetId && requiredString(current, "configJson") === configJson;
    if (unchanged) return false;
    this.database.prepare("UPDATE auto_import_rules SET name = ?, enabled = ?, destination_root_id = ?, preset_id = ?, config_json = ?, revision = revision + 1, updated_at = ? WHERE catalog_id = ? AND rule_id = ?").run(mutation.name, mutation.enabled ? 1 : 0, mutation.destinationRootId, mutation.presetId, configJson, mutation.updatedAt, catalogId, mutation.ruleId);
    return true;
  }

  private applyOperation(catalogId: CatalogId, operation: CatalogLiveOperationInput): boolean {
    const existing = this.database.prepare("SELECT kind, state, payload_json AS payloadJson, revision, created_at AS createdAt, updated_at AS updatedAt FROM operations WHERE catalog_id = ? AND operation_id = ?").get(catalogId, operation.operationId);
    const payloadJson = jsonString(operation.payload, "operation payload");
    if (existing === undefined) {
      this.database.prepare("INSERT INTO operations (catalog_id, operation_id, kind, state, payload_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(catalogId, operation.operationId, operation.kind, operation.state, payloadJson, operation.createdAt, operation.updatedAt);
      return true;
    }
    if (!isRow(existing)) throw new Error("Catalog live operation row is invalid.");
    const existingPayload = parseCatalogLiveOperationPayload(parseJsonColumn(existing, "payloadJson"));
    if (
      existingPayload.planHash !== operation.payload.planHash ||
      existingPayload.kind !== operation.payload.kind ||
      requiredString(existing, "kind") !== operation.kind ||
      canonicalJson(existingPayload.plan) !== canonicalJson(operation.payload.plan)
    ) throw new Error("Catalog live operation plan is immutable.");
    const oldState = enumString(requiredString(existing, "state"), "operation state", ["planned", "running", "completed", "failed", "cancelled"] as const);
    if (stateRank(operation.state) < stateRank(oldState) || (stateRank(oldState) === 2 && operation.state !== oldState)) throw new Error("Catalog live operation state is not monotonic.");
    if (
      requiredString(existing, "payloadJson") === payloadJson &&
      oldState === operation.state &&
      numberValue(existing, "updatedAt") === operation.updatedAt
    ) return false;
    this.database.prepare("UPDATE operations SET state = ?, payload_json = ?, revision = revision + 1, updated_at = ? WHERE catalog_id = ? AND operation_id = ?").run(operation.state, payloadJson, operation.updatedAt, catalogId, operation.operationId);
    return true;
  }

  private applyOperationItem(catalogId: CatalogId, item: CatalogLiveOperationItemInput): boolean {
    const operation = this.database.prepare("SELECT payload_json AS payloadJson FROM operations WHERE catalog_id = ? AND operation_id = ?").get(catalogId, item.operationId);
    if (!isRow(operation)) throw new Error("Catalog live operation is missing.");
    parseCatalogLiveOperationPayload(parseJsonColumn(operation, "payloadJson"));
    if (item.assetId !== null) this.asset(catalogId, item.assetId);
    if (item.payload.sourceRootId !== null) this.requireRoot(catalogId, item.payload.sourceRootId);
    if (item.payload.destinationRootId !== null) this.requireRoot(catalogId, item.payload.destinationRootId);
    const existing = this.database.prepare("SELECT asset_id AS assetId, state, payload_json AS payloadJson FROM operation_items WHERE catalog_id = ? AND operation_id = ? AND item_id = ?").get(catalogId, item.operationId, item.itemId);
    const payloadJson = jsonString(item.payload, "operation item payload");
    if (existing === undefined) {
      this.database.prepare("INSERT INTO operation_items (catalog_id, operation_id, item_id, asset_id, state, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(catalogId, item.operationId, item.itemId, item.assetId, item.state, payloadJson);
      return true;
    }
    if (!isRow(existing)) throw new Error("Catalog live operation item row is invalid.");
    const oldPayload = parseCatalogLiveOperationItemPayload(parseJsonColumn(existing, "payloadJson"));
    const oldStage = oldPayload.stage;
    if (stageRank(item.payload.stage) < stageRank(oldStage)) throw new Error("Catalog live operation item stage is not monotonic.");
    if (oldPayload.action !== item.payload.action || oldPayload.sourceRootId !== item.payload.sourceRootId ||
      oldPayload.sourceRelativePath !== item.payload.sourceRelativePath || oldPayload.destinationRootId !== item.payload.destinationRootId ||
      oldPayload.destinationRelativePath !== item.payload.destinationRelativePath) {
      throw new Error("Catalog live operation item plan is immutable.");
    }
    if (oldPayload.xmpStatus !== item.payload.xmpStatus &&
      (oldPayload.xmpStatus !== null || item.payload.xmpStatus === null || stageRank(item.payload.stage) <= stageRank(oldStage))) {
      throw new Error("Catalog live operation item XMP result is not a safe stage transition.");
    }
    const oldState = enumString(requiredString(existing, "state"), "operation item state", ["planned", "running", "completed", "failed", "cancelled"] as const);
    if (stateRank(item.state) < stateRank(oldState) || (stateRank(oldState) === 2 && item.state !== oldState)) throw new Error("Catalog live operation item state is not monotonic.");
    const statusRank = (status: CatalogLiveOperationState | "skipped"): number => {
      switch (status) {
        case "planned": return 0;
        case "running": return 1;
        case "completed":
        case "skipped":
        case "failed":
        case "cancelled": return 2;
      }
    };
    const oldStatus = oldPayload.status ?? oldState;
    const nextStatus = item.payload.status ?? item.state;
    if (
      statusRank(nextStatus) < statusRank(oldStatus) ||
      (statusRank(oldStatus) === 2 && nextStatus !== oldStatus)
    ) throw new Error("Catalog live operation item status is not monotonic.");
    const oldAssetIdValue = nullableString(existing, "assetId");
    const oldAssetId = oldAssetIdValue === null ? null : parseAssetId(oldAssetIdValue);
    if (oldAssetId === null && item.assetId !== null) {
      if (stageRank(item.payload.stage) < stageRank("catalog-applied")) {
        throw new Error("Catalog live operation item asset can only be assigned at catalog-applied stage.");
      }
      this.asset(catalogId, item.assetId);
    } else if (oldAssetId !== item.assetId) {
      throw new Error("Catalog live operation item asset is immutable.");
    }
    if (requiredString(existing, "payloadJson") === payloadJson && oldState === item.state) return false;
    this.database.prepare("UPDATE operation_items SET asset_id = ?, state = ?, payload_json = ? WHERE catalog_id = ? AND operation_id = ? AND item_id = ?").run(item.assetId, item.state, payloadJson, catalogId, item.operationId, item.itemId);
    return true;
  }

  private applyRelocate(catalogId: CatalogId, assetId: AssetId, rootId: RootId, relativePath: string, observation: CatalogV3Observation | null, health: CatalogV3AssetHealth, now: number): boolean {
    const asset = this.asset(catalogId, assetId);
    this.requireRoot(catalogId, rootId);
    const conflict = this.findAssetByPath(catalogId, rootId, relativePath);
    if (conflict !== null && conflict.assetId !== assetId) throw new Error("Catalog live destination path is already occupied.");
    const pathChanged = asset.rootId !== rootId || asset.relativePath !== relativePath;
    const observationChanged = !observationEqual(asset, observation);
    const healthChanged = asset.health !== health;
    if (!pathChanged && !observationChanged && !healthChanged) return false;
    this.database.prepare(`
      UPDATE assets SET root_id = ?, relative_path = ?, observed_byte_length = ?,
        observed_modified_at = ?, observed_at = ?, local_file_id = ?, health = ?,
        revision = revision + 1
      WHERE catalog_id = ? AND asset_id = ?
    `).run(rootId, relativePath, ...observationValues(observation), health, catalogId, assetId);
    if (!observationIdentityEqual(asset, observation)) this.invalidateFingerprint(catalogId, assetId, now);
    else this.refreshFingerprintObservation(catalogId, assetId, observation, now);
    return true;
  }

  private applyCopy(catalogId: CatalogId, mutation: Extract<CatalogLiveMutation, { kind: "asset-copy" }>, now: number): boolean {
    if (mutation.sourceAssetId === mutation.newAssetId) throw new Error("Catalog live asset copy needs a new AssetId.");
    const source = this.asset(catalogId, mutation.sourceAssetId);
    if (this.findAsset(catalogId, mutation.newAssetId) !== null) throw new Error("Catalog live copied AssetId already exists.");
    this.requireRoot(catalogId, mutation.rootId);
    if (this.findAssetByPath(catalogId, mutation.rootId, mutation.relativePath) !== null) throw new Error("Catalog live copied destination path is already occupied.");
    const observation = mutation.observation;
    if (mutation.health === "present" && observation === null) throw new Error("Catalog live present copy needs an observation.");
    this.insertAsset(catalogId, mutation.newAssetId, mutation.rootId, mutation.relativePath, observation,
      mutation.health, source.formatId, source.cameraMake, source.cameraModel, source.lensModel,
      this.metadata(catalogId, parseEntryId(mutation.sourceAssetId)), now);
    return true;
  }

  private applyMutation(catalogId: CatalogId, mutation: CatalogLiveMutation, now: number): boolean {
    switch (mutation.kind) {
      case "rename-catalog": {
        const current = this.catalog(catalogId);
        if (current.displayName === mutation.displayName) return false;
        this.database.prepare("UPDATE catalog_meta SET display_name = ?, updated_at = ? WHERE catalog_id = ?").run(mutation.displayName, now, catalogId);
        return true;
      }
      case "edit-entry-create": return this.applyEditEntryCreate(catalogId, mutation);
      case "edit-entry-rename": return this.applyEditEntryRename(catalogId, mutation);
      case "edit-entry-delete": return this.applyEditEntryDelete(catalogId, mutation);
      case "root-upsert": return this.applyRootUpsert(catalogId, mutation.root);
      case "root-health": {
        const current = this.requireRoot(catalogId, mutation.rootId);
        if (mutation.health === "online" && mutation.canonicalPath === null) throw new Error("Catalog live online root needs canonicalPath.");
        if (current.health === mutation.health && current.canonicalPath === mutation.canonicalPath) return false;
        this.database.prepare("UPDATE roots SET health = ?, canonical_path = ?, revision = revision + 1 WHERE catalog_id = ? AND root_id = ?").run(mutation.health, mutation.canonicalPath, catalogId, mutation.rootId);
        return true;
      }
      case "root-scan": {
        const current = this.requireRoot(catalogId, mutation.rootId);
        if (current.scanState === mutation.scanState) return false;
        this.database.prepare("UPDATE roots SET scan_state = ?, revision = revision + 1 WHERE catalog_id = ? AND root_id = ?").run(mutation.scanState, catalogId, mutation.rootId);
        return true;
      }
      case "root-watch": {
        const current = this.requireRoot(catalogId, mutation.rootId);
        if (current.watchState === mutation.watchState) return false;
        this.database.prepare("UPDATE roots SET watch_state = ?, revision = revision + 1 WHERE catalog_id = ? AND root_id = ?").run(mutation.watchState, catalogId, mutation.rootId);
        return true;
      }
      case "root-relink": {
        if (mutation.health === "online" && mutation.canonicalPath.length === 0) throw new Error("Catalog live online root needs canonicalPath.");
        const current = this.requireRoot(catalogId, mutation.rootId);
        const next: CatalogLiveRootInput = { rootId: mutation.rootId, label: mutation.label, configuredPath: mutation.configuredPath, canonicalPath: mutation.canonicalPath, health: mutation.health, scanState: current.scanState, watchState: current.watchState };
        return this.updateRoot(catalogId, mutation.rootId, next);
      }
      case "reconcile-complete": return this.applyReconcile(catalogId, mutation.rootId, mutation.observations, true, now);
      case "reconcile": return this.applyReconcile(catalogId, mutation.rootId, mutation.observations, mutation.complete, now);
      case "metadata-patch": return this.applyMetadataPatch(catalogId, mutationEntryId(mutation), mutation, now);
      case "album-create": return this.applyAlbumCreate(catalogId, mutation);
      case "album-rename": return this.applyAlbumRename(catalogId, mutation);
      case "album-delete": return this.applyAlbumDelete(catalogId, mutation.albumId);
      case "album-membership-replace": return this.applyAlbumMembership(catalogId, mutation);
      case "archive-set": {
        const entryId = mutationEntryId(mutation);
        return this.applyMetadataPatch(catalogId, entryId, { kind: "metadata-patch", entryId, patch: { version: 1, archive: mutation.archived } }, now);
      }
      case "library-state-replace": return this.applyLibraryState(catalogId, mutation.stateJson, now);
      case "fingerprint-set": return this.applyFingerprint(catalogId, mutation.fingerprint, now);
      case "preset-upsert": return this.applyPresetUpsert(catalogId, mutation, now);
      case "preset-rename": {
        const row = this.database.prepare("SELECT name FROM import_presets WHERE catalog_id = ? AND preset_id = ?").get(catalogId, mutation.presetId);
        if (!isRow(row)) throw new Error("Catalog live preset is missing.");
        if (requiredString(row, "name") === mutation.name) return false;
        this.database.prepare("UPDATE import_presets SET name = ?, revision = revision + 1, updated_at = ? WHERE catalog_id = ? AND preset_id = ?").run(mutation.name, mutation.updatedAt, catalogId, mutation.presetId);
        return true;
      }
      case "preset-delete": {
        const result = this.database.prepare("DELETE FROM import_presets WHERE catalog_id = ? AND preset_id = ?").run(catalogId, mutation.presetId);
        return result.changes === 1;
      }
      case "preset-set-default": return this.applyPresetDefault(catalogId, mutation.presetId, mutation.updatedAt);
      case "rule-upsert": return this.applyRuleUpsert(catalogId, mutation);
      case "rule-delete": return this.database.prepare("DELETE FROM auto_import_rules WHERE catalog_id = ? AND rule_id = ?").run(catalogId, mutation.ruleId).changes === 1;
      case "operation-upsert": return this.applyOperation(catalogId, mutation.operation);
      case "operation-item-upsert": return this.applyOperationItem(catalogId, mutation.item);
      case "asset-relocate": return this.applyRelocate(catalogId, mutation.assetId, mutation.rootId, mutation.relativePath, mutation.observation, mutation.health, now);
      case "asset-copy": return this.applyCopy(catalogId, mutation, now);
    }
  }

  private assetSnapshotFromRow(value: unknown): CatalogLiveEntrySnapshot {
    if (!isRow(value)) throw new Error("Catalog live asset snapshot row is invalid.");
    const observedAt = nullableNumber(value, "observedAt");
    const byteLength = nullableNumber(value, "observedByteLength");
    const modifiedAt = nullableNumber(value, "observedModifiedAt");
    const localFileId = nullableString(value, "localFileId");
    const observation = observedAt === null && byteLength === null && modifiedAt === null && localFileId === null
      ? null
      : observedAt === null ? (() => { throw new Error("Catalog live asset observation is incomplete."); })() : { byteLength, modifiedAt, observedAt, localFileId };
    return {
      catalogId: parseCatalogId(requiredString(value, "catalogId")),
      entryId: parseEntryId(requiredString(value, "entryId")),
      sourceId: parseSourceId(requiredString(value, "sourceId")),
      entryKind: booleanValue(value, "isOriginal") ? "original" : "virtual",
      parentEntryId: nullableString(value, "parentEntryId") === null
        ? null
        : parseEntryId(nullableString(value, "parentEntryId")),
      displayName: nullableString(value, "displayName"),
      entryCreatedAt: numberValue(value, "entryCreatedAt"),
      assetId: parseAssetId(requiredString(value, "assetId")),
      rootId: parseRootId(requiredString(value, "rootId")),
      relativePath: requiredString(value, "relativePath"),
      observation,
      revision: integerValue(value, "assetRevision"),
      health: enumString(requiredString(value, "health"), "asset health", ["present", "missing", "ambiguous", "unreadable"] as const),
      formatId: nullableString(value, "formatId"),
      cameraMake: nullableString(value, "cameraMake"),
      cameraModel: nullableString(value, "cameraModel"),
      lensModel: nullableString(value, "lensModel"),
      fingerprintId: requiredString(value, "fingerprintId"),
      fingerprintStatus: enumString(requiredString(value, "fingerprintStatus"), "fingerprint status", ["missing", "hashing", "valid", "stale", "failed"] as const),
      fingerprintSha256: nullableString(value, "fingerprintSha256"),
      fingerprintObservedAt: nullableNumber(value, "fingerprintObservedAt"),
      fingerprintObservedByteLength: nullableNumber(value, "fingerprintObservedByteLength"),
      fingerprintObservedModifiedAt: nullableNumber(value, "fingerprintObservedModifiedAt"),
      fingerprintLocalFileId: nullableString(value, "fingerprintLocalFileId"),
      metadata: {
        archive: booleanValue(value, "archive"),
        pick: enumString(requiredString(value, "pick"), "metadata pick", ["none", "pick", "reject"] as const),
        rating: integerValue(value, "rating") as CatalogV3AssetMetadata["rating"],
        colorLabel: nullableString(value, "colorLabel") as CatalogV3AssetMetadata["colorLabel"],
        developJson: nullableString(value, "developJson"),
        developUpdatedAt: numberValue(value, "developUpdatedAt"),
        updatedAt: numberValue(value, "updatedAt"),
        title: nullableString(value, "title"),
        caption: nullableString(value, "caption"),
        copyright: nullableString(value, "copyright"),
        keywordsJson: requiredString(value, "keywordsJson"),
        rawXmp: nullableString(value, "rawXmp"),
        xmpState: enumString(requiredString(value, "xmpState"), "metadata XMP state", ["unknown", "absent", "preserved", "malformed"] as const),
        xmpMtime: nullableNumber(value, "xmpMtime"),
        xmpSha256: nullableString(value, "xmpSha256"),
      },
    };
  }

  private operationRows(catalogId: CatalogId): readonly CatalogLiveOperation[] {
    const rows = this.database.prepare("SELECT operation_id AS operationId, kind, state, payload_json AS payloadJson, revision, created_at AS createdAt, updated_at AS updatedAt FROM operations WHERE catalog_id = ? ORDER BY created_at, operation_id").all(catalogId);
    return rows.map((value) => {
      if (!isRow(value)) throw new Error("Catalog live operation row is invalid.");
      const operationId = parseOperationId(requiredString(value, "operationId"));
      const items = this.database.prepare("SELECT operation_id AS operationId, item_id AS itemId, asset_id AS assetId, state, payload_json AS payloadJson FROM operation_items WHERE catalog_id = ? AND operation_id = ? ORDER BY item_id").all(catalogId, operationId).map((itemValue): CatalogLiveOperationItem => {
        if (!isRow(itemValue)) throw new Error("Catalog live operation item row is invalid.");
        return {
          operationId: parseOperationId(requiredString(itemValue, "operationId")),
          itemId: requiredString(itemValue, "itemId"),
          assetId: nullableString(itemValue, "assetId") === null ? null : parseAssetId(nullableString(itemValue, "assetId")!),
          state: enumString(requiredString(itemValue, "state"), "operation item state", ["planned", "running", "completed", "failed", "cancelled"] as const),
          payload: parseCatalogLiveOperationItemPayload(parseJsonColumn(itemValue, "payloadJson")),
        };
      });
      return {
        operationId,
        kind: requiredString(value, "kind"),
        state: enumString(requiredString(value, "state"), "operation state", ["planned", "running", "completed", "failed", "cancelled"] as const),
        payload: parseCatalogLiveOperationPayload(parseJsonColumn(value, "payloadJson")),
        revision: integerValue(value, "revision"),
        createdAt: numberValue(value, "createdAt"),
        updatedAt: numberValue(value, "updatedAt"),
        items,
      };
    });
  }

  private presetRows(catalogId: CatalogId): readonly CatalogLivePreset[] {
    return this.database.prepare("SELECT preset_id AS presetId, name, payload_json AS payloadJson, revision, created_at AS createdAt, updated_at AS updatedAt FROM import_presets WHERE catalog_id = ? ORDER BY created_at, preset_id").all(catalogId).map((value) => {
      if (!isRow(value)) throw new Error("Catalog live preset row is invalid.");
      return {
        presetId: parsePresetId(requiredString(value, "presetId")),
        name: requiredString(value, "name"),
        payload: parseCatalogLivePresetPayload(parseJsonColumn(value, "payloadJson")),
        revision: integerValue(value, "revision"),
        createdAt: numberValue(value, "createdAt"),
        updatedAt: numberValue(value, "updatedAt"),
      };
    });
  }

  private ruleRows(catalogId: CatalogId): readonly CatalogLiveRule[] {
    return this.database.prepare("SELECT rule_id AS ruleId, name, enabled, destination_root_id AS destinationRootId, preset_id AS presetId, config_json AS configJson, revision, created_at AS createdAt, updated_at AS updatedAt FROM auto_import_rules WHERE catalog_id = ? ORDER BY rule_id").all(catalogId).map((value) => {
      if (!isRow(value)) throw new Error("Catalog live rule row is invalid.");
      return {
        ruleId: requiredString(value, "ruleId"),
        name: requiredString(value, "name"),
        enabled: booleanValue(value, "enabled"),
        destinationRootId: parseRootId(requiredString(value, "destinationRootId")),
        presetId: parsePresetId(requiredString(value, "presetId")),
        config: parseCatalogLiveAutoImportConfig(parseJsonColumn(value, "configJson")),
        revision: integerValue(value, "revision"),
        createdAt: numberValue(value, "createdAt"),
        updatedAt: numberValue(value, "updatedAt"),
      };
    });
  }

  private queryState(input: CatalogLiveQueryInput): CatalogLiveState {
    const catalog = this.catalog(input.catalogId);
    if (input.expectedRevision !== null && input.expectedRevision !== catalog.revision) {
      throw new Error(`Catalog live revision ${input.expectedRevision} is stale; current revision is ${catalog.revision}.`);
    }
    const conditions = ["a.catalog_id = ?", "e.tombstoned_at IS NULL"];
    const parameters: SQLInputValue[] = [input.catalogId];
    if (input.entryId !== undefined) { conditions.push("e.entry_id = ?"); parameters.push(input.entryId); }
    if (input.assetId !== undefined) { conditions.push("a.asset_id = ?"); parameters.push(input.assetId); }
    if (input.rootId !== undefined) { conditions.push("a.root_id = ?"); parameters.push(input.rootId); }
    const assets = this.database.prepare(`${ASSET_SNAPSHOT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY a.relative_path, a.asset_id, e.is_original DESC, e.created_at, e.entry_id`).all(...parameters).map((value) => this.assetSnapshotFromRow(value));
    const tombstonedEntryIds = this.database.prepare(`
      SELECT entry_id AS entryId
      FROM edit_entries
      WHERE catalog_id = ? AND tombstoned_at IS NOT NULL
      ORDER BY entry_id
    `).all(input.catalogId).map((value) => {
      if (!isRow(value)) throw new Error("Catalog live tombstoned edit entry row is invalid.");
      return parseEntryId(requiredString(value, "entryId"));
    });
    const fingerprintMatches = input.fingerprintSha256 === undefined
      ? []
      : this.database.prepare("SELECT fingerprint_id AS fingerprintId, asset_id AS assetId, sha256 FROM fingerprints WHERE catalog_id = ? AND status = 'valid' AND sha256 = ? ORDER BY asset_id").all(input.catalogId, input.fingerprintSha256).map((value) => {
        if (!isRow(value)) throw new Error("Catalog live fingerprint match row is invalid.");
        return { fingerprintId: requiredString(value, "fingerprintId"), assetId: parseAssetId(requiredString(value, "assetId")), sha256: requiredString(value, "sha256") };
      });
    const coverageRow = this.database.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'missing'), 0) AS missing, COALESCE(SUM(status = 'hashing'), 0) AS hashing, COALESCE(SUM(status = 'valid'), 0) AS valid, COALESCE(SUM(status = 'stale'), 0) AS stale, COALESCE(SUM(status = 'failed'), 0) AS failed FROM fingerprints WHERE catalog_id = ?").get(input.catalogId);
    if (!isRow(coverageRow)) throw new Error("Catalog live fingerprint coverage is missing.");
    const coverage = {
      total: integerValue(coverageRow, "total"),
      missing: integerValue(coverageRow, "missing"),
      hashing: integerValue(coverageRow, "hashing"),
      valid: integerValue(coverageRow, "valid"),
      stale: integerValue(coverageRow, "stale"),
      failed: integerValue(coverageRow, "failed"),
    };
    const raw = {
      catalog,
      roots: this.roots(input.catalogId),
      assets,
      tombstonedEntryIds,
      albums: this.albums(input.catalogId),
      operations: this.operationRows(input.catalogId),
      presets: this.presetRows(input.catalogId),
      rules: this.ruleRows(input.catalogId),
      libraryStateJson: this.libraryStateJson(input.catalogId),
      fingerprintCoverage: coverage,
      fingerprintMatches,
    };
    return parseCatalogLiveQueryResult(raw);
  }

  public query(input: CatalogLiveQueryInput): CatalogLiveState {
    this.schema();
    return this.queryState(parseCatalogLiveQueryInput(input));
  }

  public create(input: CatalogLiveCreateInput): CatalogLiveApplyResult {
    const validated = parseCatalogLiveCreateInput(input);
    prepareFreshCatalogV3Database(this.database);
    ensureLibraryStateTable(this.database);
    upgradeCatalogV3IdentitySchema(this.database);
    upgradeDevelopHistorySchema(this.database);
    const now = validated.now ?? Date.now();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO catalog_meta (
          catalog_id, singleton, display_name, schema_version, app_version,
          install_state, revision, created_at, updated_at
        ) VALUES (?, 1, ?, 3, ?, 'ready', 1, ?, ?)
      `).run(validated.catalogId, validated.displayName, validated.appVersion, now, now);
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
      this.database.prepare("INSERT INTO audit_log (catalog_id, migration_id, event, payload_json, created_at) VALUES (?, NULL, 'live-create', ?, ?)").run(validated.catalogId, jsonString({ version: CATALOG_LIVE_PAYLOAD_VERSION, revision: 1, rootId: validated.root.rootId }, "live create audit payload"), now);
      const auditRow = this.database.prepare("SELECT last_insert_rowid() AS auditId").get();
      if (!isRow(auditRow)) throw new Error("Catalog live create audit row is missing.");
      return parseCatalogLiveApplyResult({
        catalogId: validated.catalogId,
        revision: 1,
        changed: true,
        appliedMutations: 1,
        auditId: integerValue(auditRow, "auditId"),
      });
    });
  }

  public apply(input: CatalogLiveApplyInput): CatalogLiveApplyResult {
    this.schema();
    const history = new DevelopHistoryRepository(this.database);
    const validated = parseCatalogLiveApplyInput(input);
    return this.transaction(() => {
      const catalog = this.catalog(validated.catalogId);
      if (catalog.revision !== validated.expectedRevision) {
        throw new Error(`Catalog live revision ${validated.expectedRevision} is stale; current revision is ${catalog.revision}.`);
      }
      history.assertHeadsComplete(validated.catalogId);
      const now = validated.now ?? Date.now();
      let changed = false;
      const kinds: string[] = [];
      for (const mutation of validated.mutations) {
        const parsed = parseCatalogLiveMutation(mutation);
        kinds.push(parsed.kind);
        if (parsed.kind === "metadata-patch" && parsed.patch.developJson !== undefined) {
          const entryId = mutationEntryId(parsed);
          const current = this.metadata(validated.catalogId, entryId);
          const document = parseDevelopHistoryDocument(
            parsed.patch.developJson === null ? null : JSON.parse(parsed.patch.developJson) as unknown,
          );
          const staleDevelop = parsed.patch.developUpdatedAt !== undefined &&
            parsed.patch.developUpdatedAt <= current.developUpdatedAt;
          const metadataMutation = {
            ...parsed,
            patch: { ...parsed.patch, developJson: undefined, ...(staleDevelop ? { developUpdatedAt: undefined } : {}) },
          };
          changed = this.applyMutation(validated.catalogId, metadataMutation, now) || changed;
          const currentJson = current.developJson === null
            ? "null"
            : canonicalDevelopHistoryDocument(JSON.parse(current.developJson) as unknown);
          const nextJson = canonicalDevelopHistoryDocument(document);
          if (!staleDevelop && currentJson !== nextJson) {
            const head = history.load({ catalogId: validated.catalogId, entryId, revisionId: null });
            if (head.kind !== "loaded") throw new Error("Develop history needs recovery before this edit can be saved.");
            const createdAt = parsed.patch.developUpdatedAt ?? parsed.patch.updatedAt ?? now;
            history.commit({
              catalogId: validated.catalogId,
              entryId,
              revisionId: createDevelopRevisionId(),
              expectedParentRevisionId: head.value.headRevisionId,
              operationId: createOperationId(),
              label: "Edit",
              document,
              createdAt,
            }, true);
            changed = true;
          }
        } else {
          changed = this.applyMutation(validated.catalogId, parsed, now) || changed;
        }
        if (parsed.kind === "edit-entry-create" || parsed.kind === "reconcile" || parsed.kind === "reconcile-complete") {
          history.ensureRoots(validated.catalogId, true);
        }
      }
      history.ensureRoots(validated.catalogId, true);
      if (!changed) {
        return parseCatalogLiveApplyResult({ catalogId: validated.catalogId, revision: catalog.revision, changed: false, appliedMutations: validated.mutations.length, auditId: null });
      }
      const revision = catalog.revision + 1;
      const revisionResult = this.database.prepare("UPDATE catalog_meta SET revision = ?, updated_at = ? WHERE catalog_id = ? AND revision = ?").run(revision, now, validated.catalogId, catalog.revision);
      if (revisionResult.changes !== 1) throw new Error("Catalog live revision update failed.");
      this.database.prepare("INSERT INTO audit_log (catalog_id, migration_id, event, payload_json, created_at) VALUES (?, NULL, 'live-apply', ?, ?)").run(validated.catalogId, jsonString({ version: CATALOG_LIVE_PAYLOAD_VERSION, expectedRevision: validated.expectedRevision, revision, mutationKinds: kinds }, "live audit payload"), now);
      const auditRow = this.database.prepare("SELECT last_insert_rowid() AS auditId").get();
      if (!isRow(auditRow)) throw new Error("Catalog live audit row is missing.");
      return parseCatalogLiveApplyResult({ catalogId: validated.catalogId, revision, changed: true, appliedMutations: validated.mutations.length, auditId: integerValue(auditRow, "auditId") });
    });
  }
}
