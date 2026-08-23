import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  createCatalogId,
  createOperationId,
  parseCatalogId,
  parseRootId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  CATALOG_ADMIN_MAX_BLOCKING_ERRORS,
  parseCatalogAdminCloneDisplayName,
  parseCatalogAdminRestoreRequest,
  parseCatalogBackupPolicy,
  type CatalogAdminBackupResult,
  type CatalogAdminCatalogIdentity,
  type CatalogAdminCloneResult,
  type CatalogAdminCounts,
  type CatalogAdminInspectReport,
  type CatalogAdminIntegrityReport,
  type CatalogAdminOptimizePreview,
  type CatalogAdminOptimizeResult,
  type CatalogAdminOrphanCounts,
  type CatalogAdminRestoreResult,
  type CatalogAdminRootView,
  type CatalogBackupPolicy,
  type CatalogBackupPolicyState,
} from "../lib/catalog/admin.ts";
import { verifyCatalogV3Schema } from "./catalog-v3-schema.ts";
import {
  runRestore,
  restoreConfirmation,
  validateCatalogPackage,
  writeCatalogPackage,
  type RestoreAdapter,
  type RestoreEnvelope,
  type RestoreEnvelopeStore,
  type RestoreForwardFact,
} from "./catalog-package-service.ts";
import type {
  CatalogWorkerCloneCatalogResponse,
  CatalogWorkerVacuumIntoResponse,
} from "./catalog-worker-protocol.ts";

const MAX_PACKAGE_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_BACKUP_POLICY: CatalogBackupPolicy = {
  schedule: { kind: "off" },
  retentionCount: 3,
};

export interface CatalogAdminWorkerPort {
  backup(destinationPath: string): Promise<{ readonly pages: number }>;
  vacuumInto(destinationPath: string): Promise<CatalogWorkerVacuumIntoResponse>;
  cloneCatalog(input: {
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly catalogId: CatalogId;
    readonly displayName: string;
    readonly appVersion: string;
  }): Promise<CatalogWorkerCloneCatalogResponse>;
}

export interface CatalogAdminPathPort {
  databasePath(catalogId: CatalogId): Promise<string>;
  backupDirectory(catalogId: CatalogId): Promise<string>;
  temporaryDirectory(catalogId: CatalogId): Promise<string>;
}

export interface CatalogAdminPolicyStore {
  read(catalogId: CatalogId): Promise<CatalogBackupPolicyState | null>;
  write(value: CatalogBackupPolicyState): Promise<void>;
}

export interface CatalogAdminMaintenancePort {
  quiesce(input: {
    readonly catalogId: CatalogId;
    readonly mode: "open-as-new" | "merge" | "replace";
  }): Promise<{
    readonly forwardFacts: readonly RestoreForwardFact[];
    readonly adapter: RestoreAdapter;
  }>;
  resume(input: { readonly catalogId: CatalogId }): Promise<void>;
  swapOptimized(input: {
    readonly catalogId: CatalogId;
    readonly temporaryPath: string;
    readonly sourcePath: string;
  }): Promise<void>;
}

export interface CatalogAdminServiceOptions {
  readonly worker: CatalogAdminWorkerPort;
  readonly paths: CatalogAdminPathPort;
  readonly appVersion: string;
  readonly policyStore?: CatalogAdminPolicyStore;
  readonly maintenance?: CatalogAdminMaintenancePort;
  readonly envelopes?: RestoreEnvelopeStore;
  readonly now?: () => number;
}

interface InternalRoot {
  readonly rootId: RootId;
  readonly label: string;
  readonly configuredPath: string;
  readonly canonicalPath: string | null;
}

interface InternalInspection extends CatalogAdminInspectReport {
  readonly catalog: CatalogAdminCatalogIdentity | null;
  readonly internalRoots: readonly InternalRoot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function safeError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 500) {
    if (!error.message.includes("/") && !error.message.includes("\\")) return new Error(error.message);
  }
  return new Error(fallback);
}

function safeAbsolutePath(value: string, label: string): string {
  const normalized = path.normalize(path.resolve(value));
  if (!path.isAbsolute(normalized) || normalized === path.parse(normalized).root) {
    throw new Error(`${label} must be a normalized non-root absolute path.`);
  }
  return normalized;
}

async function ensureRegularFile(filePath: string, label: string): Promise<Stats> {
  const normalized = safeAbsolutePath(filePath, label);
  const stat = await fsp.lstat(normalized);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  return stat;
}

async function ensureDirectory(directoryPath: string, label: string): Promise<string> {
  const normalized = safeAbsolutePath(directoryPath, label);
  try {
    const existing = await fsp.lstat(normalized);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`${label} must be a regular directory.`);
    return normalized;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await fsp.mkdir(normalized, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(normalized);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  return normalized;
}

function emptyCounts(): CatalogAdminCounts {
  return {
    assets: 0,
    metadata: 0,
    albums: 0,
    albumAssets: 0,
    fingerprints: 0,
    presets: 0,
    rules: 0,
    operations: 0,
    operationItems: 0,
    aliases: 0,
    auditEntries: 0,
    archived: 0,
    present: 0,
    missing: 0,
    ambiguous: 0,
    unreadable: 0,
  };
}

function emptyOrphans(): CatalogAdminOrphanCounts {
  return {
    assetMetadata: 0,
    fingerprints: 0,
    albums: 0,
    albumAssets: 0,
    presets: 0,
    rules: 0,
    operations: 0,
    operationItems: 0,
    aliases: 0,
    auditEntries: 0,
    archived: 0,
    albumPositions: 0,
    albumAssetPositions: 0,
  };
}

function row(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} row is invalid.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`${label} is invalid.`);
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function count(database: DatabaseSync, sql: string, ...parameters: readonly string[]): number {
  const result = database.prepare(sql).get(...parameters);
  return integerValue(row(result, "count").count, "count");
}

function integrity(database: DatabaseSync): CatalogAdminIntegrityReport {
  const integrityCheck = database.prepare("PRAGMA integrity_check").all().map((value) => {
    return stringValue(row(value, "integrity").integrity_check, "integrity_check");
  });
  const foreignKeyViolationCount = database.prepare("PRAGMA foreign_key_check").all().length;
  return { integrityCheck, foreignKeyViolationCount };
}

function inspectCounts(database: DatabaseSync, catalogId: CatalogId): {
  readonly counts: CatalogAdminCounts;
  readonly orphanCounts: CatalogAdminOrphanCounts;
} {
  const counts: CatalogAdminCounts = {
    assets: count(database, "SELECT COUNT(*) AS count FROM assets WHERE catalog_id = ?", catalogId),
    metadata: count(database, "SELECT COUNT(*) AS count FROM asset_metadata WHERE catalog_id = ?", catalogId),
    albums: count(database, "SELECT COUNT(*) AS count FROM albums WHERE catalog_id = ?", catalogId),
    albumAssets: count(database, "SELECT COUNT(*) AS count FROM album_assets WHERE catalog_id = ?", catalogId),
    fingerprints: count(database, "SELECT COUNT(*) AS count FROM fingerprints WHERE catalog_id = ?", catalogId),
    presets: count(database, "SELECT COUNT(*) AS count FROM import_presets WHERE catalog_id = ?", catalogId),
    rules: count(database, "SELECT COUNT(*) AS count FROM auto_import_rules WHERE catalog_id = ?", catalogId),
    operations: count(database, "SELECT COUNT(*) AS count FROM operations WHERE catalog_id = ?", catalogId),
    operationItems: count(database, "SELECT COUNT(*) AS count FROM operation_items WHERE catalog_id = ?", catalogId),
    aliases: count(database, "SELECT COUNT(*) AS count FROM migration_aliases WHERE catalog_id = ?", catalogId),
    auditEntries: count(database, "SELECT COUNT(*) AS count FROM audit_log WHERE catalog_id = ?", catalogId),
    archived: count(database, "SELECT COUNT(*) AS count FROM asset_metadata WHERE catalog_id = ? AND archive = 1", catalogId),
    present: count(database, "SELECT COUNT(*) AS count FROM assets WHERE catalog_id = ? AND health = 'present'", catalogId),
    missing: count(database, "SELECT COUNT(*) AS count FROM assets WHERE catalog_id = ? AND health = 'missing'", catalogId),
    ambiguous: count(database, "SELECT COUNT(*) AS count FROM assets WHERE catalog_id = ? AND health = 'ambiguous'", catalogId),
    unreadable: count(database, "SELECT COUNT(*) AS count FROM assets WHERE catalog_id = ? AND health = 'unreadable'", catalogId),
  };
  const orphanCounts: CatalogAdminOrphanCounts = {
    assetMetadata: count(database, "SELECT COUNT(*) AS count FROM asset_metadata m LEFT JOIN assets a ON a.catalog_id = m.catalog_id AND a.asset_id = m.asset_id WHERE m.catalog_id = ? AND a.asset_id IS NULL", catalogId),
    fingerprints: count(database, "SELECT COUNT(*) AS count FROM fingerprints f LEFT JOIN assets a ON a.catalog_id = f.catalog_id AND a.asset_id = f.asset_id WHERE f.catalog_id = ? AND a.asset_id IS NULL", catalogId),
    albums: count(database, "SELECT COUNT(*) AS count FROM albums a LEFT JOIN catalog_meta c ON c.catalog_id = a.catalog_id WHERE a.catalog_id = ? AND c.catalog_id IS NULL", catalogId),
    albumAssets: count(database, "SELECT COUNT(*) AS count FROM album_assets aa LEFT JOIN albums a ON a.catalog_id = aa.catalog_id AND a.album_id = aa.album_id LEFT JOIN assets x ON x.catalog_id = aa.catalog_id AND x.asset_id = aa.asset_id WHERE aa.catalog_id = ? AND (a.album_id IS NULL OR x.asset_id IS NULL)", catalogId),
    presets: count(database, "SELECT COUNT(*) AS count FROM import_presets p LEFT JOIN catalog_meta c ON c.catalog_id = p.catalog_id WHERE p.catalog_id = ? AND c.catalog_id IS NULL", catalogId),
    rules: count(database, "SELECT COUNT(*) AS count FROM auto_import_rules r LEFT JOIN roots d ON d.catalog_id = r.catalog_id AND d.root_id = r.destination_root_id LEFT JOIN import_presets p ON p.catalog_id = r.catalog_id AND p.preset_id = r.preset_id WHERE r.catalog_id = ? AND (d.root_id IS NULL OR p.preset_id IS NULL)", catalogId),
    operations: count(database, "SELECT COUNT(*) AS count FROM operations o LEFT JOIN catalog_meta c ON c.catalog_id = o.catalog_id WHERE o.catalog_id = ? AND c.catalog_id IS NULL", catalogId),
    operationItems: count(database, "SELECT COUNT(*) AS count FROM operation_items i LEFT JOIN operations o ON o.catalog_id = i.catalog_id AND o.operation_id = i.operation_id LEFT JOIN assets a ON a.catalog_id = i.catalog_id AND a.asset_id = i.asset_id WHERE i.catalog_id = ? AND (o.operation_id IS NULL OR (i.asset_id IS NOT NULL AND a.asset_id IS NULL))", catalogId),
    aliases: count(database, "SELECT COUNT(*) AS count FROM migration_aliases m LEFT JOIN assets a ON a.catalog_id = m.catalog_id AND a.asset_id = m.asset_id LEFT JOIN roots r ON r.catalog_id = m.catalog_id AND r.root_id = m.root_id WHERE m.catalog_id = ? AND (a.asset_id IS NULL OR r.root_id IS NULL)", catalogId),
    auditEntries: count(database, "SELECT COUNT(*) AS count FROM audit_log l LEFT JOIN catalog_meta c ON c.catalog_id = l.catalog_id WHERE l.catalog_id = ? AND c.catalog_id IS NULL", catalogId),
    archived: count(database, "SELECT COUNT(*) AS count FROM asset_metadata m LEFT JOIN assets a ON a.catalog_id = m.catalog_id AND a.asset_id = m.asset_id WHERE m.catalog_id = ? AND m.archive = 1 AND a.asset_id IS NULL", catalogId),
    albumPositions: count(database, "SELECT COUNT(*) AS count FROM (SELECT catalog_id FROM albums WHERE catalog_id = ? GROUP BY catalog_id HAVING MIN(position) <> 0 OR MAX(position) <> COUNT(*) - 1)", catalogId),
    albumAssetPositions: count(database, "SELECT COUNT(*) AS count FROM (SELECT catalog_id, album_id FROM album_assets WHERE catalog_id = ? GROUP BY catalog_id, album_id HAVING MIN(position) <> 0 OR MAX(position) <> COUNT(*) - 1)", catalogId),
  };
  return { counts, orphanCounts };
}

interface PackageRootMapping {
  readonly rootId: RootId;
  readonly label: string;
  readonly configuredPath: string;
}

interface ValidatedPackage {
  readonly directory: string;
  readonly databasePath: string;
  readonly catalogId: CatalogId;
  readonly appVersion: string;
  readonly manifestSha256: string;
  readonly roots: readonly PackageRootMapping[];
  readonly inspection: InternalInspection;
}

function emptyIntegrity(): CatalogAdminIntegrityReport {
  return { integrityCheck: [], foreignKeyViolationCount: 0 };
}

function errorText(errors: string[], message: string): void {
  if (errors.length >= CATALOG_ADMIN_MAX_BLOCKING_ERRORS) return;
  errors.push(message.slice(0, 256));
}

function storedPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) return null;
  const normalized = path.normalize(value);
  if (!path.isAbsolute(value) || value !== normalized || normalized === path.parse(normalized).root) return null;
  return normalized;
}

function orphanTotal(orphanCounts: CatalogAdminOrphanCounts): number {
  return Object.values(orphanCounts).reduce((sum, value) => sum + value, 0);
}

function safeDatabaseError(error: unknown, fallback: string): string {
  return safeError(error, fallback).message;
}

async function readDigestWithStableStat(filePath: string): Promise<{
  readonly byteLength: number;
  readonly sha256: string;
}> {
  const normalized = safeAbsolutePath(filePath, "Catalog database");
  const beforePath = await ensureRegularFile(normalized, "Catalog database");
  const handle = await fsp.open(normalized, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error("Catalog database changed before it was read.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let byteLength = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await ensureRegularFile(normalized, "Catalog database");
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== afterPath.dev ||
      after.ino !== afterPath.ino ||
      byteLength !== after.size
    ) {
      throw new Error("Catalog database changed while it was read.");
    }
    return { byteLength, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function readStableUtf8File(filePath: string, maximumBytes: number, label: string): Promise<string> {
  const normalized = safeAbsolutePath(filePath, label);
  const beforePath = await ensureRegularFile(normalized, label);
  if (beforePath.size > maximumBytes) throw new Error(`${label} is too large.`);
  const handle = await fsp.open(normalized, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error(`${label} changed before it was read.`);
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (true) {
      const remaining = maximumBytes + 1 - byteLength;
      if (remaining <= 0) throw new Error(`${label} is too large.`);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, remaining), null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      byteLength += bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await ensureRegularFile(normalized, label);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== afterPath.dev ||
      after.ino !== afterPath.ino ||
      byteLength !== after.size
    ) {
      throw new Error(`${label} changed while it was read.`);
    }
    return Buffer.concat(chunks, byteLength).toString("utf8");
  } finally {
    await handle.close();
  }
}

function metaIdentity(database: DatabaseSync): CatalogAdminCatalogIdentity {
  const value = row(database.prepare(`
    SELECT catalog_id AS catalogId, display_name AS displayName,
      schema_version AS schemaVersion, app_version AS appVersion
    FROM catalog_meta
    WHERE singleton = 1
  `).get(), "catalog metadata");
  const schemaVersion = integerValue(value.schemaVersion, "catalog schema version");
  if (schemaVersion !== 3) throw new Error("Catalog schema version is invalid.");
  return {
    catalogId: parseCatalogId(value.catalogId),
    displayName: stringValue(value.displayName, "catalog display name"),
    appVersion: stringValue(value.appVersion, "catalog app version"),
    schemaVersion: 3,
  };
}

function rootRows(database: DatabaseSync, catalogId: CatalogId): InternalRoot[] {
  const values = database.prepare(`
    SELECT root_id AS rootId, label, configured_path AS configuredPath,
      canonical_path AS canonicalPath, health
    FROM roots
    WHERE catalog_id = ?
    ORDER BY root_id
  `).all(catalogId);
  if (values.length > 10_000) throw new Error("Catalog contains too many roots.");
  return values.map((value): InternalRoot => {
    const item = row(value, "catalog root");
    const configuredPath = stringValue(item.configuredPath, "configured root path");
    const canonicalValue = item.canonicalPath;
    const canonicalPath = canonicalValue === null
      ? null
      : stringValue(canonicalValue, "canonical root path");
    return {
      rootId: parseRootId(item.rootId),
      label: stringValue(item.label, "root label"),
      configuredPath,
      canonicalPath,
    };
  });
}

function validateRootLocations(
  database: DatabaseSync,
  catalogId: CatalogId,
  roots: readonly InternalRoot[],
  errors: string[],
): void {
  const healthRows = database.prepare(
    "SELECT root_id AS rootId, health FROM roots WHERE catalog_id = ?",
  ).all(catalogId);
  const health = new Map<string, string>();
  for (const value of healthRows) {
    const item = row(value, "root health");
    health.set(String(item.rootId), stringValue(item.health, "root health"));
  }
  for (const root of roots) {
    if (storedPath(root.configuredPath) === null) errorText(errors, "Catalog contains an invalid configured root location.");
    if (root.canonicalPath !== null && storedPath(root.canonicalPath) === null) {
      errorText(errors, "Catalog contains an invalid canonical root location.");
    }
    if (health.get(root.rootId) === "online" && root.canonicalPath === null) {
      errorText(errors, "An online catalog root has no canonical location.");
    }
  }
}

async function inspectInternal(databasePath: string): Promise<InternalInspection> {
  const normalized = safeAbsolutePath(databasePath, "Catalog database");
  let sourceByteLength = 0;
  let sourceSha256 = "";
  const errors: string[] = [];
  try {
    const digest = await readDigestWithStableStat(normalized);
    sourceByteLength = digest.byteLength;
    sourceSha256 = digest.sha256;
  } catch (error) {
    errorText(errors, safeDatabaseError(error, "Catalog database cannot be read."));
  }

  let database: DatabaseSync | undefined;
  let catalog: CatalogAdminCatalogIdentity | null = null;
  let internalRoots: InternalRoot[] = [];
  let schemaVersion: number | null = null;
  let applicationId: number | null = null;
  let userVersion: number | null = null;
  let counts = emptyCounts();
  let orphanCounts = emptyOrphans();
  let integrityReport = emptyIntegrity();
  try {
    database = new DatabaseSync(normalized, { readOnly: true });
    const schema = verifyCatalogV3Schema(database);
    schemaVersion = schema.schemaVersion;
    applicationId = schema.applicationId;
    userVersion = schema.userVersion;
    catalog = metaIdentity(database);
    internalRoots = rootRows(database, catalog.catalogId);
    validateRootLocations(database, catalog.catalogId, internalRoots, errors);
    const observed = inspectCounts(database, catalog.catalogId);
    counts = observed.counts;
    orphanCounts = observed.orphanCounts;
    integrityReport = integrity(database);
  } catch (error) {
    errorText(errors, safeDatabaseError(error, "Catalog database validation failed."));
  } finally {
    database?.close();
  }

  const publicRoots: CatalogAdminRootView[] = internalRoots.map((root) => ({
    rootId: root.rootId,
    label: root.label,
  }));
  if (integrityReport.integrityCheck.length > 0 &&
      (integrityReport.integrityCheck.length !== 1 || integrityReport.integrityCheck[0] !== "ok")) {
    errorText(errors, "Catalog integrity check failed.");
  }
  if (integrityReport.foreignKeyViolationCount > 0) errorText(errors, "Catalog foreign-key check failed.");
  if (orphanTotal(orphanCounts) > 0) errorText(errors, "Catalog contains orphaned or invalid relations.");
  const report: CatalogAdminInspectReport = {
    catalogId: catalog?.catalogId ?? null,
    schemaVersion,
    applicationId,
    userVersion,
    clean: errors.length === 0 && catalog !== null && schemaVersion === 3 &&
      integrityReport.integrityCheck.length === 1 && integrityReport.integrityCheck[0] === "ok" &&
      integrityReport.foreignKeyViolationCount === 0 && orphanTotal(orphanCounts) === 0,
    sourceByteLength,
    sourceSha256,
    roots: publicRoots,
    counts,
    orphanCounts,
    integrity: integrityReport,
    blockingErrors: errors.slice(0, CATALOG_ADMIN_MAX_BLOCKING_ERRORS),
  };
  return { ...report, catalog, internalRoots };
}

export async function inspectCatalogDatabaseReadOnly(databasePath: string): Promise<CatalogAdminInspectReport> {
  const report = await inspectInternal(databasePath);
  return report;
}

function manifestRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.kind !== "darkroom-catalog-package" || value.version !== 1 || value.schemaVersion !== 3) {
    throw new Error("Catalog package manifest is invalid.");
  }
  return value;
}

async function readPackageManifest(directory: string): Promise<{
  readonly catalogId: CatalogId;
  readonly appVersion: string;
  readonly roots: readonly PackageRootMapping[];
}> {
  const manifestPath = path.join(directory, "manifest.json");
  const text = await readStableUtf8File(
    manifestPath,
    MAX_PACKAGE_MANIFEST_BYTES,
    "Catalog package manifest",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Catalog package manifest is not JSON.");
  }
  const value = manifestRecord(parsed);
  if (typeof value.appVersion !== "string" || value.appVersion.length === 0 || value.appVersion.length > 256) {
    throw new Error("Catalog package app version is invalid.");
  }
  if (!Array.isArray(value.roots) || value.roots.length === 0 || value.roots.length > 10_000) {
    throw new Error("Catalog package roots are invalid.");
  }
  const roots = value.roots.map((root): PackageRootMapping => {
    const item = row(root, "package root");
    const configuredPath = stringValue(item.configuredPath, "package root path");
    if (storedPath(configuredPath) === null) throw new Error("Catalog package root path is invalid.");
    return {
      rootId: parseRootId(item.rootId),
      label: stringValue(item.label, "package root label"),
      configuredPath: path.normalize(configuredPath),
    };
  });
  if (new Set(roots.map((root) => root.rootId)).size !== roots.length) {
    throw new Error("Catalog package contains duplicate roots.");
  }
  return {
    catalogId: parseCatalogId(value.catalogId),
    appVersion: value.appVersion,
    roots,
  };
}

async function validatePackageForService(packageDirectory: string): Promise<ValidatedPackage> {
  const directory = safeAbsolutePath(packageDirectory, "Catalog package directory");
  const directoryStat = await fsp.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Catalog package directory is invalid.");
  const summary = await validateCatalogPackage(directory);
  const manifest = await readPackageManifest(directory);
  if (manifest.catalogId !== summary.catalogId) throw new Error("Catalog package identity is inconsistent.");
  const databasePath = path.join(directory, "catalog.sqlite");
  const inspection = await inspectInternal(databasePath);
  if (!inspection.clean || inspection.catalog === null) throw new Error("Catalog package database is not clean.");
  if (inspection.catalog.catalogId !== manifest.catalogId) throw new Error("Catalog package database identity does not match its manifest.");
  if (inspection.internalRoots.length !== manifest.roots.length) throw new Error("Catalog package root mapping does not match its database.");
  const rootsById = new Map(inspection.internalRoots.map((root) => [root.rootId, root]));
  for (const root of manifest.roots) {
    const actual = rootsById.get(root.rootId);
    if (actual === undefined || actual.label !== root.label || actual.configuredPath !== root.configuredPath) {
      throw new Error("Catalog package root mapping does not match its database.");
    }
  }
  return {
    directory,
    databasePath,
    catalogId: manifest.catalogId,
    appVersion: manifest.appVersion,
    manifestSha256: summary.manifestSha256,
    roots: manifest.roots,
    inspection,
  };
}

async function removeOwnedPath(targetPath: string, prefix: string): Promise<void> {
  const normalized = safeAbsolutePath(targetPath, "Catalog temporary path");
  if (!path.basename(normalized).startsWith(prefix)) throw new Error("Refusing to remove an unowned catalog path.");
  try {
    const stat = await fsp.lstat(normalized);
    if (stat.isSymbolicLink()) throw new Error("Refusing to remove a symbolic-link catalog path.");
    await fsp.rm(normalized, { recursive: stat.isDirectory(), force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function removeOwnedFile(targetPath: string): Promise<void> {
  const normalized = safeAbsolutePath(targetPath, "Catalog temporary path");
  try {
    const stat = await fsp.lstat(normalized);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Refusing to remove an unsafe catalog file.");
    await fsp.unlink(normalized);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function removePublishedPackage(targetPath: string, expected: Stats): Promise<void> {
  const normalized = safeAbsolutePath(targetPath, "Catalog package path");
  try {
    const stat = await fsp.lstat(normalized);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    ) {
      throw new Error("Refusing to remove a changed catalog package.");
    }
    await fsp.rm(normalized, { recursive: true, force: false });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function uniqueChild(parent: string, prefix: string): Promise<string> {
  const directory = await ensureDirectory(parent, "Catalog administration directory");
  return path.join(directory, `${prefix}${randomUUID()}`);
}

function defaultPolicyState(catalogId: CatalogId): CatalogBackupPolicyState {
  return {
    catalogId,
    policy: DEFAULT_BACKUP_POLICY,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureMessage: null,
  };
}

function validTimestamp(value: number | null): number | null {
  return value === null || (Number.isFinite(value) && value >= 0) ? value : null;
}

export class FileCatalogBackupPolicyStore implements CatalogAdminPolicyStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = safeAbsolutePath(filePath, "Catalog backup policy file");
  }

  private async readAll(): Promise<Map<CatalogId, CatalogBackupPolicyState>> {
    try {
      const parsed: unknown = JSON.parse(await readStableUtf8File(
        this.filePath,
        2 * 1024 * 1024,
        "Catalog backup policy file",
      ));
      if (!isRecord(parsed)) throw new Error("Catalog backup policy file is invalid.");
      const result = new Map<CatalogId, CatalogBackupPolicyState>();
      for (const [key, value] of Object.entries(parsed)) {
        const catalogId = parseCatalogId(key);
        if (!isRecord(value)) throw new Error("Catalog backup policy entry is invalid.");
        const policy = parseCatalogBackupPolicy(value.policy);
        result.set(catalogId, {
          catalogId,
          policy,
          lastSuccessAt: validTimestamp(value.lastSuccessAt === null ? null : numberValue(value.lastSuccessAt, "last success")),
          lastFailureAt: validTimestamp(value.lastFailureAt === null ? null : numberValue(value.lastFailureAt, "last failure")),
          lastFailureMessage: value.lastFailureMessage === null ? null : stringValue(value.lastFailureMessage, "failure message").slice(0, 500),
        });
      }
      return result;
    } catch (error) {
      if (isMissing(error)) return new Map();
      throw safeError(error, "Catalog backup policy could not be read.");
    }
  }

  async read(catalogId: CatalogId): Promise<CatalogBackupPolicyState | null> {
    return (await this.readAll()).get(parseCatalogId(catalogId)) ?? null;
  }

  async write(value: CatalogBackupPolicyState): Promise<void> {
    const write = this.writeChain.then(() => this.writeInternal(value));
    this.writeChain = write.catch(() => undefined);
    return write;
  }

  private async writeInternal(value: CatalogBackupPolicyState): Promise<void> {
    const parsedCatalogId = parseCatalogId(value.catalogId);
    const policy = parseCatalogBackupPolicy(value.policy);
    const state: CatalogBackupPolicyState = {
      catalogId: parsedCatalogId,
      policy,
      lastSuccessAt: validTimestamp(value.lastSuccessAt),
      lastFailureAt: validTimestamp(value.lastFailureAt),
      lastFailureMessage: value.lastFailureMessage === null ? null : value.lastFailureMessage.slice(0, 500),
    };
    const all = await this.readAll();
    all.set(parsedCatalogId, state);
    const object: Record<string, CatalogBackupPolicyState> = {};
    for (const [key, item] of all) object[key] = item;
    const directory = await ensureDirectory(path.dirname(this.filePath), "Catalog backup policy directory");
    try {
      const existing = await fsp.lstat(this.filePath);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error("Catalog backup policy file is unsafe.");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const temporary = `${this.filePath}.tmp-${randomUUID()}`;
    const handle = await fsp.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(object));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.rename(temporary, this.filePath);
      const directoryHandle = await fsp.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await fsp.unlink(temporary).catch(() => undefined);
      throw safeError(error, "Catalog backup policy could not be stored.");
    }
  }
}

export interface CatalogAdminClonePublishInput {
  readonly catalogId: CatalogId;
  readonly databasePath: string;
  readonly displayName: string;
}

export interface CatalogAdminRestoreInput {
  readonly packageDirectory: string;
  readonly sourcePackageSha256: string;
  readonly request: unknown;
  readonly forwardFacts?: readonly RestoreForwardFact[];
  readonly existingEnvelope?: RestoreEnvelope;
}

export class CatalogAdminService {
  private readonly worker: CatalogAdminWorkerPort;
  private readonly paths: CatalogAdminPathPort;
  private readonly appVersion: string;
  private readonly policyStore: CatalogAdminPolicyStore;
  private readonly maintenance: CatalogAdminMaintenancePort | undefined;
  private readonly envelopes: RestoreEnvelopeStore | undefined;
  private readonly now: () => number;
  private readonly publishClone: ((input: CatalogAdminClonePublishInput) => Promise<void>) | undefined;

  constructor(options: CatalogAdminServiceOptions & {
    readonly publishClone?: (input: CatalogAdminClonePublishInput) => Promise<void>;
  }) {
    if (options.appVersion.length === 0 || options.appVersion.length > 256) throw new Error("Catalog app version is invalid.");
    this.worker = options.worker;
    this.paths = options.paths;
    this.appVersion = options.appVersion;
    this.policyStore = options.policyStore ?? new InMemoryCatalogBackupPolicyStore();
    this.maintenance = options.maintenance;
    this.envelopes = options.envelopes;
    this.now = options.now ?? Date.now;
    this.publishClone = options.publishClone;
  }

  async inspectDatabase(databasePath: string): Promise<CatalogAdminInspectReport> {
    return inspectCatalogDatabaseReadOnly(databasePath);
  }

  async inspectCatalog(databasePath: string): Promise<CatalogAdminInspectReport> {
    return this.inspectDatabase(databasePath);
  }

  async validateDatabase(databasePath: string): Promise<CatalogAdminInspectReport> {
    const report = await this.inspectDatabase(databasePath);
    if (!report.clean) throw new Error("Catalog database validation failed.");
    return report;
  }

  private async createBackupPackage(
    catalogId: CatalogId,
    requestedPackageDirectory?: string,
  ): Promise<{ readonly result: CatalogAdminBackupResult; readonly packageDirectory: string }> {
    const parsedCatalogId = parseCatalogId(catalogId);
    const operationId = createOperationId();
    const sourcePath = safeAbsolutePath(await this.paths.databasePath(parsedCatalogId), "Catalog database");
    const source = await inspectInternal(sourcePath);
    if (!source.clean || source.catalog === null) throw new Error("Catalog database validation failed.");
    const temporaryDirectory = await this.paths.temporaryDirectory(parsedCatalogId);
    const temporaryPath = await uniqueChild(temporaryDirectory, ".backup-");
    const packageDirectory = requestedPackageDirectory === undefined
      ? await uniqueChild(await this.paths.backupDirectory(parsedCatalogId), "backup-")
      : safeAbsolutePath(requestedPackageDirectory, "Catalog export package");
    let published: Stats | null = null;
    try {
      await this.worker.backup(temporaryPath);
      const temporary = await inspectInternal(temporaryPath);
      this.assertSameCatalog(source, temporary);
      const summary = await writeCatalogPackage({
        targetDirectory: packageDirectory,
        catalogId: parsedCatalogId,
        appVersion: this.appVersion,
        roots: source.internalRoots.map((root) => ({ rootId: root.rootId, label: root.label, configuredPath: root.configuredPath })),
        payloads: [{ name: "catalog.sqlite", sourcePath: temporaryPath }],
        backupAndValidate: async () => {
          const checked = await inspectInternal(temporaryPath);
          if (!checked.clean || checked.catalog?.catalogId !== parsedCatalogId) throw new Error("Catalog backup validation failed.");
        },
        now: this.now(),
      });
      published = await fsp.lstat(packageDirectory);
      if (!published.isDirectory() || published.isSymbolicLink()) {
        throw new Error("Catalog package publication is invalid.");
      }
      const checkedPackage = await validatePackageForService(packageDirectory);
      if (checkedPackage.catalogId !== parsedCatalogId) throw new Error("Catalog backup identity is invalid.");
      const packageDatabase = await readDigestWithStableStat(checkedPackage.databasePath);
      return {
        packageDirectory,
        result: {
          operationId,
          catalogId: parsedCatalogId,
          createdAt: this.now(),
          sourceSha256: source.sourceSha256,
          packageSha256: summary.manifestSha256,
          byteLength: packageDatabase.byteLength,
        },
      };
    } catch (error) {
      if (published !== null) {
        await removePublishedPackage(packageDirectory, published).catch(() => undefined);
      }
      throw safeError(error, "Catalog backup failed.");
    } finally {
      await removeOwnedPath(temporaryPath, ".backup-").catch(() => undefined);
    }
  }

  async backupCatalog(catalogId: CatalogId): Promise<CatalogAdminBackupResult> {
    return (await this.createBackupPackage(catalogId)).result;
  }

  async backup(catalogId: CatalogId): Promise<CatalogAdminBackupResult> {
    return this.backupCatalog(catalogId);
  }

  async exportCatalogPackage(
    catalogId: CatalogId,
    packageDirectory?: string,
  ): Promise<CatalogAdminBackupResult> {
    return (await this.createBackupPackage(catalogId, packageDirectory)).result;
  }

  async inspectCatalogPackage(packageDirectory: string): Promise<CatalogAdminInspectReport> {
    return (await validatePackageForService(packageDirectory)).inspection;
  }

  async cloneCatalogPackage(packageDirectory: string, displayName: unknown): Promise<CatalogAdminCloneResult> {
    const name = parseCatalogAdminCloneDisplayName(displayName);
    const source = await validatePackageForService(packageDirectory);
    const catalogId = createCatalogId();
    const operationId = createOperationId();
    const destinationPath = safeAbsolutePath(await this.paths.databasePath(catalogId), "Cloned catalog database");
    let published = false;
    try {
      if (await fsp.lstat(destinationPath).then(() => true).catch((error) => {
        if (isMissing(error)) return false;
        throw error;
      })) throw new Error("Cloned catalog destination already exists.");
      const before = await readDigestWithStableStat(source.databasePath);
      const clone = await this.worker.cloneCatalog({
        sourcePath: source.databasePath,
        destinationPath,
        catalogId,
        displayName: name,
        appVersion: this.appVersion,
      });
      const cloned = await inspectInternal(destinationPath);
      if (!cloned.clean || cloned.catalog?.catalogId !== catalogId) throw new Error("Cloned catalog validation failed.");
      if (clone.catalogId !== catalogId || clone.sourceCatalogId !== source.catalogId || clone.rootCount !== cloned.internalRoots.length || clone.assetCount !== cloned.counts.assets) {
        throw new Error("Cloned catalog identity or counts are invalid.");
      }
      const after = await readDigestWithStableStat(source.databasePath);
      if (before.sha256 !== after.sha256 || before.byteLength !== after.byteLength) throw new Error("Source catalog changed while it was cloned.");
      if (this.publishClone !== undefined) {
        await this.publishClone({ catalogId, databasePath: destinationPath, displayName: name });
        published = true;
      }
      return { operationId, sourceCatalogId: source.catalogId, catalogId, displayName: name, rootCount: clone.rootCount, assetCount: clone.assetCount };
    } catch (error) {
      if (!published) await removeOwnedFile(destinationPath).catch(() => undefined);
      throw safeError(error, "Catalog clone failed.");
    }
  }

  async cloneAsNew(packageDirectory: string, displayName: unknown): Promise<CatalogAdminCloneResult> {
    return this.cloneCatalogPackage(packageDirectory, displayName);
  }

  private assertSameCatalog(left: InternalInspection, right: InternalInspection): void {
    if (!right.clean || left.catalog === null || right.catalog === null || left.catalog.catalogId !== right.catalog.catalogId || left.internalRoots.length !== right.internalRoots.length) {
      throw new Error("Catalog backup identity or root mapping is invalid.");
    }
    const roots = new Map(right.internalRoots.map((root) => [root.rootId, root]));
    for (const root of left.internalRoots) {
      const candidate = roots.get(root.rootId);
      if (candidate === undefined || candidate.configuredPath !== root.configuredPath || candidate.label !== root.label) throw new Error("Catalog root mapping is invalid.");
    }
  }

  async optimizePreview(catalogId: CatalogId): Promise<CatalogAdminOptimizePreview> {
    const parsedCatalogId = parseCatalogId(catalogId);
    const sourcePath = safeAbsolutePath(await this.paths.databasePath(parsedCatalogId), "Catalog database");
    const source = await inspectInternal(sourcePath);
    if (!source.clean || source.catalog?.catalogId !== parsedCatalogId) throw new Error("Catalog database validation failed.");
    return { catalogId: parsedCatalogId, sourceSha256: source.sourceSha256, sourceByteLength: source.sourceByteLength, provenOrphanCounts: source.orphanCounts };
  }

  async previewOptimize(catalogId: CatalogId): Promise<CatalogAdminOptimizePreview> {
    return this.optimizePreview(catalogId);
  }

  async optimize(catalogId: CatalogId): Promise<CatalogAdminOptimizeResult> {
    const preview = await this.optimizePreview(catalogId);
    if (this.maintenance === undefined) throw new Error("Catalog maintenance is unavailable.");
    const sourcePath = safeAbsolutePath(await this.paths.databasePath(preview.catalogId), "Catalog database");
    const temporaryPath = await uniqueChild(await this.paths.temporaryDirectory(preview.catalogId), ".compact-");
    let swapped = false;
    try {
      await this.worker.vacuumInto(temporaryPath);
      const compactInspection = await inspectInternal(temporaryPath);
      if (!compactInspection.clean || compactInspection.catalog?.catalogId !== preview.catalogId) throw new Error("Compacted catalog validation failed.");
      const compactDigest = await readDigestWithStableStat(temporaryPath);
      const sourceAfter = await inspectInternal(sourcePath);
      if (sourceAfter.sourceSha256 !== preview.sourceSha256 || sourceAfter.sourceByteLength !== preview.sourceByteLength) throw new Error("Catalog changed during optimization.");
      await this.maintenance.swapOptimized({ catalogId: preview.catalogId, temporaryPath, sourcePath });
      swapped = true;
      return { catalogId: preview.catalogId, sourceSha256: preview.sourceSha256, compactSha256: compactDigest.sha256, sourceByteLength: preview.sourceByteLength, compactByteLength: compactDigest.byteLength };
    } catch (error) {
      throw safeError(error, "Catalog optimization failed.");
    } finally {
      if (!swapped) await removeOwnedPath(temporaryPath, ".compact-").catch(() => undefined);
      else await removeOwnedFile(temporaryPath).catch(() => undefined);
    }
  }

  async optimizeCatalog(catalogId: CatalogId): Promise<CatalogAdminOptimizeResult> {
    return this.optimize(catalogId);
  }

  async getBackupPolicy(catalogId: CatalogId): Promise<CatalogBackupPolicyState> {
    const parsedCatalogId = parseCatalogId(catalogId);
    return (await this.policyStore.read(parsedCatalogId)) ?? defaultPolicyState(parsedCatalogId);
  }

  async setBackupPolicy(catalogId: CatalogId, value: unknown): Promise<CatalogBackupPolicyState> {
    const parsedCatalogId = parseCatalogId(catalogId);
    const current = await this.getBackupPolicy(parsedCatalogId);
    const next: CatalogBackupPolicyState = { ...current, catalogId: parsedCatalogId, policy: parseCatalogBackupPolicy(value) };
    await this.policyStore.write(next);
    return next;
  }

  async runScheduledBackup(catalogId: CatalogId): Promise<CatalogAdminBackupResult | null> {
    const parsedCatalogId = parseCatalogId(catalogId);
    const state = await this.getBackupPolicy(parsedCatalogId);
    if (state.policy.schedule.kind === "off") return null;
    const now = this.now();
    if (state.lastSuccessAt !== null && now - state.lastSuccessAt < state.policy.schedule.intervalMs) return null;
    try {
      const result = await this.backupCatalog(parsedCatalogId);
      await this.policyStore.write({ ...state, lastSuccessAt: now, lastFailureAt: null, lastFailureMessage: null });
      await this.pruneBackups(parsedCatalogId, state.policy.retentionCount);
      return result;
    } catch (error) {
      const message = safeError(error, "Scheduled catalog backup failed.").message;
      await this.policyStore.write({ ...state, lastFailureAt: now, lastFailureMessage: message });
      throw new Error(message);
    }
  }

  private async pruneBackups(catalogId: CatalogId, retentionCount: number): Promise<void> {
    const directory = await ensureDirectory(await this.paths.backupDirectory(catalogId), "Catalog backup directory");
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    const owned: { readonly path: string; readonly mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.name.startsWith("backup-") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      try {
        const packageValue = await validatePackageForService(candidate);
        if (packageValue.catalogId !== catalogId) continue;
        const stat = await fsp.lstat(candidate);
        owned.push({ path: candidate, mtimeMs: stat.mtimeMs });
      } catch {
        // Unvalidated or foreign directories are never pruned.
      }
    }
    owned.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const old of owned.slice(retentionCount)) await removeOwnedPath(old.path, "backup-");
  }

  async restoreCatalog(input: CatalogAdminRestoreInput): Promise<CatalogAdminRestoreResult> {
    const request = parseCatalogAdminRestoreRequest(input.request);
    if (this.maintenance === undefined || this.envelopes === undefined) throw new Error("Catalog maintenance is unavailable.");
    const envelopes = this.envelopes;
    if (!/^[0-9a-f]{64}$/.test(input.sourcePackageSha256)) throw new Error("Catalog package checksum is invalid.");
    if (request.mode !== "open-as-new" &&
        (request.dryRunId === undefined || request.confirmation !== restoreConfirmation(request.mode, request.dryRunId))) {
      throw new Error("Merge and Replace require the matching dry-run ID and explicit confirmation.");
    }
    let quiesced = false;
    try {
      const state = await this.maintenance.quiesce({ catalogId: request.catalogId, mode: request.mode });
      quiesced = true;
      const facts = input.forwardFacts ?? state.forwardFacts;
      if (facts.length > 100_000) throw new Error("Catalog restore contains too many forward facts.");
      const result = await runRestore({
        packageDirectory: safeAbsolutePath(input.packageDirectory, "Catalog package directory"),
        sourcePackageSha256: input.sourcePackageSha256,
        sourceCatalogId: request.sourceCatalogId,
        targetCatalogId: request.catalogId,
        mode: request.mode,
        ...(request.dryRunId === undefined ? {} : { dryRunId: request.dryRunId }),
        ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
        forwardFacts: facts,
        adapter: state.adapter,
        envelopes,
        existingEnvelope: input.existingEnvelope,
        now: this.now,
      });
      return {
        status: result.status,
        stage: result.stage,
        unresolvedFactCount: result.unresolvedFactIds.length,
        error: result.error === null ? null : safeError(new Error(result.error), "Catalog restore failed.").message,
      };
    } catch (error) {
      throw safeError(error, "Catalog restore failed.");
    } finally {
      if (quiesced) await this.maintenance.resume({ catalogId: request.catalogId }).catch(() => undefined);
    }
  }

  async restore(input: CatalogAdminRestoreInput): Promise<CatalogAdminRestoreResult> {
    return this.restoreCatalog(input);
  }
}

class InMemoryCatalogBackupPolicyStore implements CatalogAdminPolicyStore {
  private readonly values = new Map<CatalogId, CatalogBackupPolicyState>();

  async read(catalogId: CatalogId): Promise<CatalogBackupPolicyState | null> {
    return this.values.get(catalogId) ?? null;
  }

  async write(value: CatalogBackupPolicyState): Promise<void> {
    this.values.set(value.catalogId, value);
  }
}
