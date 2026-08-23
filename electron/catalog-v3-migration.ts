import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  copyMigrationRecoveryEvidence,
  readMigrationSources,
  recheckMigrationSources,
  type RecoveryEvidence,
} from "./catalog-migration-snapshot.ts";
import {
  createCatalogRegistryStore,
  type CatalogRegistryEntry,
} from "./catalog-registry.ts";
import {
  createCatalogWorkerClient,
  type CatalogWorkerClient,
} from "./catalog-worker-client.ts";
import {
  prepareLegacyMigration,
  type CompleteOnlineScan,
  type LegacyCatalogParser,
  type LegacyMigrationPlan,
  type XmpEvidence,
} from "../lib/catalog/legacy-migration.ts";
import {
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  CATALOG_V3_APPLICATION_ID,
  CATALOG_V3_SCHEMA_VERSION,
  type CatalogV3AssetCandidate,
  type CatalogV3ExpectedCounts,
  type CatalogV3FingerprintCoverage,
  type CatalogV3MetadataInput,
  type CatalogV3RootInput,
  type CatalogV3Summary,
  type CatalogV3ValidationReport,
} from "../lib/catalog/v3.ts";
import { catalogV3ExpectedStateSha256 } from "./catalog-v3-state.ts";

const ENVELOPE_VERSION = 1;
const ASSET_BATCH_SIZE = 250;
const ALBUM_MEMBERSHIP_CHUNK_SIZE = 249;
const ARCHIVE_CHUNK_SIZE = 250;

export type CatalogV3MigrationEnvelopePhase =
  | "source-snapshotted"
  | "database-building"
  | "database-ready"
  | "database-installed"
  | "registry-activated";

export interface CatalogV3MigrationInstallerInput {
  readonly userDataPath: string;
  readonly workerPath: string;
  readonly catalogPath: string;
  readonly settingsPath?: string;
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly migrationId: OperationId;
  readonly displayName: string;
  readonly appVersion: string;
  readonly parseCatalog: LegacyCatalogParser;
  readonly onlineScan?: CompleteOnlineScan;
  readonly xmpByRelativePath?: Readonly<Record<string, XmpEvidence>>;
  readonly afterFirstAssetBatch?: () => void | Promise<void>;
  readonly beforeSourceRecheck?: () => void | Promise<void>;
  readonly afterFinalDatabaseLink?: () => void | Promise<void>;
  readonly beforeRegistryActivation?: () => void | Promise<void>;
  readonly afterRegistryActivation?: () => void | Promise<void>;
}

export interface CatalogV3MigrationEnvelope {
  readonly version: 1;
  readonly phase: CatalogV3MigrationEnvelopePhase;
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly migrationId: OperationId;
  readonly displayName: string;
  readonly appVersion: string;
  readonly planSha256: string;
  readonly sources: {
    readonly catalog: {
      readonly path: string;
      readonly sha256: string;
      readonly byteLength: number;
    };
    readonly settings?: {
      readonly path: string;
      readonly sha256: string;
      readonly byteLength: number;
    };
  };
  readonly recoveryEvidence: RecoveryEvidence;
  readonly stagingDatabasePath: string;
  readonly finalDatabasePath: string;
  readonly validationReport?: CatalogV3ValidationReport;
}

export interface CatalogV3MigrationInstallerResult {
  readonly envelopePath: string;
  readonly phase: "registry-activated";
  readonly databasePath: string;
  readonly recoveryEvidence: RecoveryEvidence;
  readonly validationReport: CatalogV3ValidationReport;
  readonly before: LegacyMigrationPlan["counts"];
  readonly after: CatalogV3Summary["counts"];
  readonly fingerprintCoverage: CatalogV3FingerprintCoverage;
  readonly limitations: readonly string[];
  readonly registryEntry: CatalogRegistryEntry;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}

function requireAbsoluteNormalizedPath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw new Error(`${label} must be an absolute normalized path.`);
  }
  return value;
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty NUL-free string.`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  const hash = requireNonemptyString(value, label);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`${label} must be a lowercase SHA-256 hash.`);
  }
  return hash;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer.`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((item, index) => requireNonemptyString(item, `${label}[${index}]`));
}

function ensureInside(parent: string, child: string, label: string): string {
  const relative = path.relative(parent, child);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped its parent directory.`);
  }
  return child;
}

function pathsFor(input: CatalogV3MigrationInstallerInput): {
  readonly envelopePath: string;
  readonly stagingDatabasePath: string;
  readonly finalDatabasePath: string;
} {
  const userDataPath = requireAbsoluteNormalizedPath(input.userDataPath, "userDataPath");
  const catalogId = parseCatalogId(input.catalogId);
  const migrationId = parseOperationId(input.migrationId);
  const migrationDirectory = path.join(userDataPath, "catalog-migrations");
  const catalogDirectory = path.join(userDataPath, "catalogs-v3");
  const envelopePath = ensureInside(
    migrationDirectory,
    path.join(migrationDirectory, `${migrationId}.json`),
    "Migration envelope",
  );
  const stagingDatabasePath = ensureInside(
    catalogDirectory,
    path.join(catalogDirectory, `.${catalogId}.${migrationId}.sqlite.tmp`),
    "Staging database",
  );
  const finalDatabasePath = ensureInside(
    catalogDirectory,
    path.join(catalogDirectory, `${catalogId}.sqlite`),
    "Final database",
  );
  return { envelopePath, stagingDatabasePath, finalDatabasePath };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP") && !isNodeError(error, "ENOSYS")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

function parseExpectedCounts(value: unknown, label: string): CatalogV3ExpectedCounts {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return {
    assets: requireNonnegativeInteger(value.assets, `${label}.assets`),
    metadata: requireNonnegativeInteger(value.metadata, `${label}.metadata`),
    albums: requireNonnegativeInteger(value.albums, `${label}.albums`),
    albumAssets: requireNonnegativeInteger(value.albumAssets, `${label}.albumAssets`),
    archived: requireNonnegativeInteger(value.archived, `${label}.archived`),
    aliases: requireNonnegativeInteger(value.aliases, `${label}.aliases`),
    fingerprints: requireNonnegativeInteger(value.fingerprints, `${label}.fingerprints`),
    present: requireNonnegativeInteger(value.present, `${label}.present`),
    missing: requireNonnegativeInteger(value.missing, `${label}.missing`),
  };
}

function parseFingerprintCoverage(value: unknown, label: string): CatalogV3FingerprintCoverage {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return {
    total: requireNonnegativeInteger(value.total, `${label}.total`),
    missing: requireNonnegativeInteger(value.missing, `${label}.missing`),
    hashing: requireNonnegativeInteger(value.hashing, `${label}.hashing`),
    valid: requireNonnegativeInteger(value.valid, `${label}.valid`),
    stale: requireNonnegativeInteger(value.stale, `${label}.stale`),
    failed: requireNonnegativeInteger(value.failed, `${label}.failed`),
  };
}

function parseValidationReport(value: unknown): CatalogV3ValidationReport {
  if (!isRecord(value)) throw new Error("Migration validation report must be an object.");
  if (value.clean !== true) throw new Error("Migration validation report must be clean.");
  if (!isRecord(value.after) || !isRecord(value.relationFailures) || !isRecord(value.integrity)) {
    throw new Error("Migration validation report is malformed.");
  }
  const integrityCheck = requireStringArray(value.integrity.integrityCheck, "validationReport.integrity.integrityCheck");
  if (!Array.isArray(value.integrity.foreignKeyCheck)) {
    throw new Error("validationReport.integrity.foreignKeyCheck must be an array.");
  }
  const foreignKeyCheck = value.integrity.foreignKeyCheck.map((item, index) => {
    if (!isRecord(item)) throw new Error(`validationReport.integrity.foreignKeyCheck[${index}] is invalid.`);
    const rowId = item.rowId;
    if (rowId !== null && (typeof rowId !== "number" || !Number.isFinite(rowId))) {
      throw new Error(`validationReport.integrity.foreignKeyCheck[${index}].rowId is invalid.`);
    }
    return {
      table: requireNonemptyString(item.table, `validationReport.integrity.foreignKeyCheck[${index}].table`),
      rowId,
      parent: requireNonemptyString(item.parent, `validationReport.integrity.foreignKeyCheck[${index}].parent`),
      foreignKeyIndex: requireNonnegativeInteger(item.foreignKeyIndex, `validationReport.integrity.foreignKeyCheck[${index}].foreignKeyIndex`),
    };
  });
  const after = {
    ...parseExpectedCounts(value.after, "validationReport.after"),
    ambiguous: requireNonnegativeInteger(value.after.ambiguous, "validationReport.after.ambiguous"),
    unreadable: requireNonnegativeInteger(value.after.unreadable, "validationReport.after.unreadable"),
  };
  const report: CatalogV3ValidationReport = {
    catalogId: parseCatalogId(value.catalogId),
    migrationId: requireNonemptyString(value.migrationId, "validationReport.migrationId"),
    clean: true,
    before: parseExpectedCounts(value.before, "validationReport.before"),
    after,
    fingerprintCoverage: parseFingerprintCoverage(value.fingerprintCoverage, "validationReport.fingerprintCoverage"),
    expectedStateSha256: requireHash(value.expectedStateSha256, "validationReport.expectedStateSha256"),
    actualStateSha256: requireHash(value.actualStateSha256, "validationReport.actualStateSha256"),
    relationFailures: {
      aliases: requireNonnegativeInteger(value.relationFailures.aliases, "validationReport.relationFailures.aliases"),
      albums: requireNonnegativeInteger(value.relationFailures.albums, "validationReport.relationFailures.albums"),
      albumAssets: requireNonnegativeInteger(value.relationFailures.albumAssets, "validationReport.relationFailures.albumAssets"),
      archived: requireNonnegativeInteger(value.relationFailures.archived, "validationReport.relationFailures.archived"),
    },
    integrity: { integrityCheck, foreignKeyCheck },
    applicationId: requireNonnegativeInteger(value.applicationId, "validationReport.applicationId"),
    schemaVersion: requireNonnegativeInteger(value.schemaVersion, "validationReport.schemaVersion"),
    userVersion: requireNonnegativeInteger(value.userVersion, "validationReport.userVersion"),
    limitations: requireStringArray(value.limitations, "validationReport.limitations"),
    blockingErrors: requireStringArray(value.blockingErrors, "validationReport.blockingErrors"),
  };
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
    report.applicationId !== CATALOG_V3_APPLICATION_ID ||
    report.schemaVersion !== CATALOG_V3_SCHEMA_VERSION ||
    report.userVersion !== CATALOG_V3_SCHEMA_VERSION ||
    countKeys.some((key) => report.before[key] !== report.after[key]) ||
    report.after.assets !== report.after.present + report.after.missing + report.after.ambiguous + report.after.unreadable ||
    report.expectedStateSha256 !== report.actualStateSha256 ||
    report.fingerprintCoverage.total !== report.after.fingerprints ||
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
    throw new Error("Migration validation report is inconsistent.");
  }
  return report;
}

function parseRecoveryEvidence(value: unknown): RecoveryEvidence {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error("Migration recovery evidence is invalid.");
  }
  const directory = requireAbsoluteNormalizedPath(
    requireNonemptyString(value.directory, "recoveryEvidence.directory"),
    "recoveryEvidence.directory",
  );
  const names = new Set<string>();
  const files = value.files.map((item, index) => {
    if (!isRecord(item)) throw new Error(`recoveryEvidence.files[${index}] is invalid.`);
    const name: "catalog.json" | "settings.json" = item.name === "catalog.json"
      ? "catalog.json"
      : item.name === "settings.json"
        ? "settings.json"
        : (() => {
          throw new Error(`recoveryEvidence.files[${index}].name is invalid.`);
        })();
    if (names.has(name)) throw new Error("Migration recovery evidence duplicates a file.");
    names.add(name);
    return {
      name,
      path: requireAbsoluteNormalizedPath(
        requireNonemptyString(item.path, `recoveryEvidence.files[${index}].path`),
        `recoveryEvidence.files[${index}].path`,
      ),
      sha256: requireHash(item.sha256, `recoveryEvidence.files[${index}].sha256`),
      byteLength: requireNonnegativeInteger(item.byteLength, `recoveryEvidence.files[${index}].byteLength`),
    };
  });
  if (!names.has("catalog.json")) throw new Error("Migration recovery evidence is missing catalog.json.");
  return { directory, files };
}

function parseEnvelope(value: unknown): CatalogV3MigrationEnvelope {
  if (!isRecord(value) || value.version !== ENVELOPE_VERSION || !isRecord(value.sources)) {
    throw new Error("Catalog v3 migration envelope is invalid.");
  }
  const phase = value.phase;
  if (
    phase !== "source-snapshotted" &&
    phase !== "database-building" &&
    phase !== "database-ready" &&
    phase !== "database-installed" &&
    phase !== "registry-activated"
  ) {
    throw new Error("Catalog v3 migration envelope phase is invalid.");
  }
  const parseSource = (source: unknown, label: string) => {
    if (!isRecord(source)) throw new Error(`${label} is invalid.`);
    return {
      path: requireAbsoluteNormalizedPath(requireNonemptyString(source.path, `${label}.path`), `${label}.path`),
      sha256: requireHash(source.sha256, `${label}.sha256`),
      byteLength: requireNonnegativeInteger(source.byteLength, `${label}.byteLength`),
    };
  };
  const settings = value.sources.settings === undefined
    ? undefined
    : parseSource(value.sources.settings, "sources.settings");
  const validationReport = value.validationReport === undefined
    ? undefined
    : parseValidationReport(value.validationReport);
  return {
    version: 1,
    phase,
    catalogId: parseCatalogId(value.catalogId),
    rootId: parseRootId(value.rootId),
    migrationId: parseOperationId(value.migrationId),
    displayName: requireNonemptyString(value.displayName, "displayName"),
    appVersion: requireNonemptyString(value.appVersion, "appVersion"),
    planSha256: requireHash(value.planSha256, "planSha256"),
    sources: {
      catalog: parseSource(value.sources.catalog, "sources.catalog"),
      ...(settings === undefined ? {} : { settings }),
    },
    recoveryEvidence: parseRecoveryEvidence(value.recoveryEvidence),
    stagingDatabasePath: requireAbsoluteNormalizedPath(
      requireNonemptyString(value.stagingDatabasePath, "stagingDatabasePath"),
      "stagingDatabasePath",
    ),
    finalDatabasePath: requireAbsoluteNormalizedPath(
      requireNonemptyString(value.finalDatabasePath, "finalDatabasePath"),
      "finalDatabasePath",
    ),
    ...(validationReport === undefined ? {} : { validationReport }),
  };
}

async function readEnvelope(filePath: string): Promise<CatalogV3MigrationEnvelope | null> {
  try {
    return parseEnvelope(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

function sourceFromSnapshot(snapshot: Awaited<ReturnType<typeof readMigrationSources>>): CatalogV3MigrationEnvelope["sources"] {
  return {
    catalog: {
      path: snapshot.catalog.path,
      sha256: snapshot.catalog.sha256,
      byteLength: snapshot.catalog.bytes.byteLength,
    },
    ...(snapshot.settings === undefined
      ? {}
      : {
        settings: {
          path: snapshot.settings.path,
          sha256: snapshot.settings.sha256,
          byteLength: snapshot.settings.bytes.byteLength,
        },
      }),
  };
}

function createEnvelope(
  input: CatalogV3MigrationInstallerInput,
  paths: ReturnType<typeof pathsFor>,
  snapshot: Awaited<ReturnType<typeof readMigrationSources>>,
  recoveryEvidence: RecoveryEvidence,
  planSha256: string,
): CatalogV3MigrationEnvelope {
  return {
    version: 1,
    phase: "source-snapshotted",
    catalogId: parseCatalogId(input.catalogId),
    rootId: parseRootId(input.rootId),
    migrationId: parseOperationId(input.migrationId),
    displayName: requireNonemptyString(input.displayName, "displayName"),
    appVersion: requireNonemptyString(input.appVersion, "appVersion"),
    planSha256: requireHash(planSha256, "planSha256"),
    sources: sourceFromSnapshot(snapshot),
    recoveryEvidence,
    stagingDatabasePath: paths.stagingDatabasePath,
    finalDatabasePath: paths.finalDatabasePath,
  };
}

function assertSameEnvelope(
  existing: CatalogV3MigrationEnvelope,
  expected: CatalogV3MigrationEnvelope,
): CatalogV3MigrationEnvelope {
  if (
    existing.catalogId !== expected.catalogId ||
    existing.rootId !== expected.rootId ||
    existing.migrationId !== expected.migrationId ||
    existing.displayName !== expected.displayName ||
    existing.appVersion !== expected.appVersion ||
    existing.planSha256 !== expected.planSha256 ||
    existing.stagingDatabasePath !== expected.stagingDatabasePath ||
    existing.finalDatabasePath !== expected.finalDatabasePath ||
    existing.sources.catalog.path !== expected.sources.catalog.path ||
    existing.sources.catalog.sha256 !== expected.sources.catalog.sha256 ||
    existing.sources.catalog.byteLength !== expected.sources.catalog.byteLength ||
    existing.sources.settings?.path !== expected.sources.settings?.path ||
    existing.sources.settings?.sha256 !== expected.sources.settings?.sha256 ||
    existing.sources.settings?.byteLength !== expected.sources.settings?.byteLength ||
    existing.recoveryEvidence.directory !== expected.recoveryEvidence.directory
  ) {
    throw new Error("Catalog v3 migration envelope conflicts with this migration input.");
  }
  return existing;
}

function envelopeAtPhase(
  envelope: CatalogV3MigrationEnvelope,
  phase: CatalogV3MigrationEnvelopePhase,
  validationReport?: CatalogV3ValidationReport,
): CatalogV3MigrationEnvelope {
  return {
    ...envelope,
    phase,
    ...(validationReport === undefined ? {} : { validationReport }),
  };
}

function extensionFormat(relativePath: string): string {
  const extension = path.posix.extname(relativePath).slice(1).toLowerCase();
  return extension.length > 0 ? extension : "unknown";
}

function rootLabel(rootPath: string): string {
  const segments = rootPath.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? rootPath;
}

function serializeDevelop(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Legacy Develop metadata is not serializable.");
  return serialized;
}

function metadataForCandidate(candidate: LegacyMigrationPlan["candidates"][number]): CatalogV3MetadataInput {
  const metadata = candidate.metadata;
  const rawXmp = candidate.xmp.state === "preserved" ? candidate.xmp.contents ?? null : null;
  if (rawXmp !== null) {
    const digest = createHash("sha256").update(rawXmp, "utf8").digest("hex");
    if (digest !== candidate.xmp.sha256) {
      throw new Error(`XMP evidence hash does not match ${candidate.relativePath}.`);
    }
  }
  return {
    archive: candidate.sourceFlags.archive,
    pick: metadata?.pick ?? "none",
    rating: metadata?.rating ?? 0,
    colorLabel: metadata?.colorLabel ?? null,
    developJson: serializeDevelop(metadata?.develop),
    developUpdatedAt: metadata?.developUpdatedAt ?? 0,
    updatedAt: metadata?.updatedAt ?? 0,
    title: null,
    caption: null,
    copyright: null,
    keywordsJson: "[]",
    rawXmp,
    xmpState: candidate.xmp.state,
    xmpMtime: candidate.xmp.modifiedAt ?? null,
    xmpSha256: candidate.xmp.sha256 ?? null,
  };
}

function candidateForV3(
  candidate: LegacyMigrationPlan["candidates"][number],
  rootId: RootId,
): CatalogV3AssetCandidate {
  const observation = candidate.observation;
  return {
    rootId,
    relativePath: candidate.relativePath,
    observation: observation === null
      ? null
      : {
        byteLength: observation.byteLength,
        modifiedAt: observation.modifiedAt,
        observedAt: observation.observedAt,
        localFileId: observation.localFileId,
      },
    health: candidate.health,
    formatId: observation?.formatId ?? extensionFormat(candidate.relativePath),
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    legacyIds: [candidate.legacyIdAlias],
    metadata: metadataForCandidate(candidate),
    fingerprint: {
      status: "missing",
      sha256: null,
      observedAt: observation?.observedAt ?? null,
      observedByteLength: observation?.byteLength ?? null,
      observedModifiedAt: observation?.modifiedAt ?? null,
      localFileId: observation?.localFileId ?? null,
    },
  };
}

function candidatesForPlan(plan: LegacyMigrationPlan, rootId: RootId): readonly CatalogV3AssetCandidate[] {
  return plan.candidates.map((candidate) => candidateForV3(candidate, rootId));
}

function expectedCounts(plan: LegacyMigrationPlan): CatalogV3ExpectedCounts {
  return {
    assets: plan.counts.expectedTotalAssets,
    metadata: plan.counts.expectedTotalAssets,
    albums: plan.counts.albums,
    albumAssets: plan.counts.albumMemberships,
    archived: plan.counts.archiveReferences,
    aliases: plan.counts.expectedAliases,
    fingerprints: plan.counts.expectedTotalAssets,
    present: plan.counts.expectedPresentAssets,
    missing: plan.counts.expectedMissingAssets,
  };
}

function migrationPlanSha256(plan: LegacyMigrationPlan): string {
  const serialized = JSON.stringify({
    rawCatalogVersion: plan.rawCatalogVersion,
    rootPath: plan.catalog.rootPath,
    scan: plan.scan,
    candidates: plan.candidates,
    albums: plan.albums,
    archivedEntryIds: plan.archivedEntryIds,
    counts: plan.counts,
  });
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

async function rootForPlan(plan: LegacyMigrationPlan, rootId: RootId): Promise<CatalogV3RootInput> {
  const online = plan.scan === "online";
  let canonicalPath: string | null = null;
  if (online) {
    canonicalPath = await fs.realpath(plan.catalog.rootPath);
    const rootStat = await fs.stat(canonicalPath);
    if (!rootStat.isDirectory()) {
      throw new Error("Online migration root must be a directory.");
    }
  }
  return {
    rootId,
    label: rootLabel(plan.catalog.rootPath),
    configuredPath: plan.catalog.rootPath,
    canonicalPath,
    health: online ? "online" as const : "missing" as const,
    scanState: online ? "complete" as const : "unknown" as const,
    watchState: "disabled" as const,
  };
}

async function closeWorker(worker: CatalogWorkerClient | undefined): Promise<void> {
  if (!worker) return;
  try {
    await worker.close();
    await worker.shutdown();
  } catch {
    await worker.forceTerminate().catch(() => undefined);
  }
}

async function openWorker(workerPath: string, databasePath: string): Promise<CatalogWorkerClient> {
  const worker = createCatalogWorkerClient({
    workerPath: requireAbsoluteNormalizedPath(workerPath, "workerPath"),
    requestTimeoutMs: 20_000,
  });
  try {
    await worker.open(databasePath);
    return worker;
  } catch (error) {
    await worker.forceTerminate().catch(() => undefined);
    throw error;
  }
}

async function importPlan(
  worker: CatalogWorkerClient,
  plan: LegacyMigrationPlan,
  candidates: readonly CatalogV3AssetCandidate[],
  input: CatalogV3MigrationInstallerInput,
): Promise<void> {
  const catalogId = parseCatalogId(input.catalogId);
  const migrationId = parseOperationId(input.migrationId);
  let batchWritten = false;
  for (let start = 0; start < candidates.length; start += ASSET_BATCH_SIZE) {
    await worker.writeV3AssetBatch({
      catalogId,
      migrationId,
      assets: candidates.slice(start, start + ASSET_BATCH_SIZE),
    });
    if (!batchWritten) {
      batchWritten = true;
      await input.afterFirstAssetBatch?.();
    }
  }

  let relationRequestCount = 0;
  for (const [albumPosition, album] of plan.albums.entries()) {
    if (album.entryIds.length === 0) {
      await worker.writeV3RelationsBatch({
        catalogId,
        migrationId,
        albums: [{ ...album, position: albumPosition, positionOffset: 0 }],
        archiveLegacyIds: [],
      });
      relationRequestCount += 1;
      continue;
    }
    for (let start = 0; start < album.entryIds.length; start += ALBUM_MEMBERSHIP_CHUNK_SIZE) {
      await worker.writeV3RelationsBatch({
        catalogId,
        migrationId,
        albums: [{
          id: album.id,
          name: album.name,
          createdAt: album.createdAt,
          updatedAt: album.updatedAt,
          position: albumPosition,
          positionOffset: start,
          entryIds: album.entryIds.slice(start, start + ALBUM_MEMBERSHIP_CHUNK_SIZE),
        }],
        archiveLegacyIds: [],
      });
      relationRequestCount += 1;
    }
  }
  for (let start = 0; start < plan.archivedEntryIds.length; start += ARCHIVE_CHUNK_SIZE) {
    await worker.writeV3RelationsBatch({
      catalogId,
      migrationId,
      albums: [],
      archiveLegacyIds: plan.archivedEntryIds.slice(start, start + ARCHIVE_CHUNK_SIZE),
    });
    relationRequestCount += 1;
  }
  if (relationRequestCount === 0) {
    await worker.writeV3RelationsBatch({ catalogId, migrationId, albums: [], archiveLegacyIds: [] });
  }
}

function assertSummary(
  summary: CatalogV3Summary,
  envelope: CatalogV3MigrationEnvelope,
  expected: CatalogV3ExpectedCounts,
  expectedStateSha256: string,
  expectedRoot: CatalogV3RootInput,
): void {
  const migration = summary.migration;
  if (
    summary.catalogId !== envelope.catalogId ||
    summary.displayName !== envelope.displayName ||
    summary.appVersion !== envelope.appVersion ||
    summary.migrationId !== envelope.migrationId ||
    summary.installState !== "ready" ||
    summary.migrationPhase !== "validated" ||
    migration.migrationId !== envelope.migrationId ||
    migration.sourceVersion !== summary.sourceVersion ||
    migration.catalogPath !== envelope.sources.catalog.path ||
    migration.catalogSha256 !== envelope.sources.catalog.sha256 ||
    migration.settingsPath !== (envelope.sources.settings?.path ?? null) ||
    migration.settingsSha256 !== (envelope.sources.settings?.sha256 ?? null) ||
    migration.rootAvailable !== (expectedRoot.health === "online") ||
    JSON.stringify(migration.expectedCounts) !== JSON.stringify(expected) ||
    migration.expectedStateSha256 !== expectedStateSha256 ||
    JSON.stringify(summary.root) !== JSON.stringify(expectedRoot) ||
    summary.counts.assets !== expected.assets ||
    summary.counts.metadata !== expected.metadata ||
    summary.counts.albums !== expected.albums ||
    summary.counts.albumAssets !== expected.albumAssets ||
    summary.counts.archived !== expected.archived ||
    summary.counts.aliases !== expected.aliases ||
    summary.counts.fingerprints !== expected.fingerprints ||
    summary.counts.present !== expected.present ||
    summary.counts.missing !== expected.missing
  ) {
    throw new Error("Catalog v3 installed database does not match the migration envelope.");
  }
}

async function verifyFinalDatabase(
  input: CatalogV3MigrationInstallerInput,
  envelope: CatalogV3MigrationEnvelope,
  expected: CatalogV3ExpectedCounts,
  expectedStateSha256: string,
  expectedRoot: CatalogV3RootInput,
): Promise<CatalogV3Summary> {
  let worker: CatalogWorkerClient | undefined;
  try {
    worker = await openWorker(input.workerPath, envelope.finalDatabasePath);
    const validation = await worker.validateV3(envelope.catalogId, envelope.migrationId);
    if (
      !validation.report.clean ||
      validation.report.expectedStateSha256 !== expectedStateSha256 ||
      validation.report.actualStateSha256 !== expectedStateSha256
    ) {
      throw new Error("Catalog v3 final database no longer matches the frozen migration state.");
    }
    const summary = await worker.v3Summary(envelope.catalogId);
    assertSummary(summary, envelope, expected, expectedStateSha256, expectedRoot);
    const integrity = await worker.integrityCheck();
    if (integrity.integrityCheck.length !== 1 || integrity.integrityCheck[0] !== "ok" || integrity.foreignKeyCheck.length > 0) {
      throw new Error("Catalog v3 final database integrity verification failed.");
    }
    const seal = await worker.sealV3ForInstall(envelope.catalogId, envelope.migrationId);
    if (seal.busy !== 0 || seal.journalMode !== "delete") {
      throw new Error("Catalog v3 final database did not reseal cleanly after verification.");
    }
    return summary;
  } finally {
    await closeWorker(worker);
  }
}

async function publishStagingDatabase(
  envelope: CatalogV3MigrationEnvelope,
  afterLink?: () => void | Promise<void>,
): Promise<void> {
  await fs.mkdir(path.dirname(envelope.finalDatabasePath), { recursive: true, mode: 0o700 });
  await syncFile(envelope.stagingDatabasePath);
  try {
    await fs.link(envelope.stagingDatabasePath, envelope.finalDatabasePath);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new Error("Catalog v3 final database already exists and will not be overwritten.");
    }
    throw error;
  }
  await syncDirectory(path.dirname(envelope.finalDatabasePath));
  await afterLink?.();
  try {
    await fs.unlink(envelope.stagingDatabasePath);
  } catch (error) {
    throw new Error(
      `Catalog v3 final database was published but staging cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  await syncDirectory(path.dirname(envelope.finalDatabasePath));
}

async function recoverLinkedPublish(envelope: CatalogV3MigrationEnvelope): Promise<void> {
  if (envelope.phase !== "database-ready" || envelope.validationReport?.clean !== true) {
    throw new Error("Catalog v3 migration has both staging and final databases. Manual recovery is required.");
  }
  const [stagingStat, finalStat] = await Promise.all([
    fs.stat(envelope.stagingDatabasePath),
    fs.stat(envelope.finalDatabasePath),
  ]);
  if (stagingStat.dev !== finalStat.dev || stagingStat.ino !== finalStat.ino) {
    throw new Error("Catalog v3 staging and final databases differ. Manual recovery is required.");
  }
  await fs.unlink(envelope.stagingDatabasePath);
  await syncDirectory(path.dirname(envelope.finalDatabasePath));
}

async function assertMigrationSourcesUnchanged(
  input: CatalogV3MigrationInstallerInput,
  snapshot: Awaited<ReturnType<typeof readMigrationSources>>,
): Promise<void> {
  const rechecked = await recheckMigrationSources(
    snapshot,
    input.settingsPath === undefined ? {} : { settingsPath: input.settingsPath },
  );
  if (!rechecked.unchanged) {
    throw new Error("Legacy migration sources changed before activation. The registry was not updated.");
  }
}

function limitationsFor(plan: LegacyMigrationPlan, report: CatalogV3ValidationReport): readonly string[] {
  const limitations = [...report.limitations];
  if (plan.scan === "offline" && plan.rawCatalogVersion === 2) {
    limitations.push("offline-v2-incomplete-inventory");
  }
  if (plan.scan === "offline") {
    limitations.push("offline-xmp-state-unknown");
  }
  return [...new Set(limitations)];
}

async function activateRegistry(
  input: CatalogV3MigrationInstallerInput,
  envelope: CatalogV3MigrationEnvelope,
): Promise<CatalogRegistryEntry> {
  const store = createCatalogRegistryStore(input.userDataPath);
  const document = await store.read();
  const databasePath = await fs.realpath(envelope.finalDatabasePath);
  for (const catalog of document.catalogs) {
    if (catalog.catalogId === envelope.catalogId && catalog.databasePath !== databasePath) {
      throw new Error("Catalog registry already maps this catalog ID to a different database.");
    }
    if (catalog.catalogId !== envelope.catalogId && catalog.databasePath === databasePath) {
      throw new Error("Catalog registry already maps this database to a different catalog.");
    }
  }
  const existing = document.catalogs.find((catalog) => catalog.catalogId === envelope.catalogId);
  const entry: CatalogRegistryEntry = existing !== undefined &&
    existing.displayName === envelope.displayName &&
    existing.databasePath === databasePath &&
    existing.health === "healthy"
    ? existing
    : {
      catalogId: envelope.catalogId,
      displayName: envelope.displayName,
      databasePath,
      health: "healthy",
      lastOpenedAt: Date.now(),
    };
  await store.upsert(entry);
  return entry;
}

/**
 * Installs a fully validated v3 catalog. Main startup deliberately does not call this yet.
 */
export async function installCatalogV3Migration(
  input: CatalogV3MigrationInstallerInput,
): Promise<CatalogV3MigrationInstallerResult> {
  requireAbsoluteNormalizedPath(input.catalogPath, "catalogPath");
  if (input.settingsPath !== undefined) requireAbsoluteNormalizedPath(input.settingsPath, "settingsPath");
  requireAbsoluteNormalizedPath(input.userDataPath, "userDataPath");
  requireAbsoluteNormalizedPath(input.workerPath, "workerPath");
  const paths = pathsFor(input);
  const snapshot = await readMigrationSources({
    catalogPath: input.catalogPath,
    ...(input.settingsPath === undefined ? {} : { settingsPath: input.settingsPath }),
  });
  const recoveryEvidence = await copyMigrationRecoveryEvidence(
    input.userDataPath,
    input.migrationId,
    snapshot,
  );
  let rawCatalog: unknown;
  try {
    rawCatalog = JSON.parse(snapshot.catalog.text);
  } catch {
    throw new Error("Legacy catalog is not valid JSON. Recovery evidence was preserved.");
  }
  const plan = prepareLegacyMigration({
    catalog: rawCatalog,
    source: snapshot,
    parseCatalog: input.parseCatalog,
    ...(input.onlineScan === undefined ? {} : { onlineScan: input.onlineScan }),
    ...(input.xmpByRelativePath === undefined ? {} : { xmpByRelativePath: input.xmpByRelativePath }),
  });
  const expected = expectedCounts(plan);
  const rootId = parseRootId(input.rootId);
  const candidates = candidatesForPlan(plan, rootId);
  const expectedStateSha256 = catalogV3ExpectedStateSha256({
    assets: candidates,
    albums: plan.albums.map((album, position) => ({ ...album, position })),
    archiveLegacyIds: plan.archivedEntryIds,
  });
  const expectedEnvelope = createEnvelope(
    input,
    paths,
    snapshot,
    recoveryEvidence,
    migrationPlanSha256(plan),
  );
  let envelope = await readEnvelope(paths.envelopePath);
  if (envelope === null) {
    envelope = expectedEnvelope;
    await writeJsonAtomically(paths.envelopePath, envelope);
  } else {
    envelope = assertSameEnvelope(envelope, expectedEnvelope);
  }
  const expectedRoot = await rootForPlan(plan, envelope.rootId);

  const stagingExists = await exists(envelope.stagingDatabasePath);
  const finalExists = await exists(envelope.finalDatabasePath);
  if (stagingExists && finalExists) {
    await recoverLinkedPublish(envelope);
  }

  let report = envelope.validationReport;
  let summary: CatalogV3Summary;
  if (finalExists) {
    if (
      envelope.phase !== "database-ready" &&
      envelope.phase !== "database-installed" &&
      envelope.phase !== "registry-activated"
    ) {
      throw new Error("Catalog v3 final database exists without a ready migration envelope.");
    }
    if (report === undefined) throw new Error("Catalog v3 final database has no clean validation report.");
    summary = await verifyFinalDatabase(input, envelope, expected, expectedStateSha256, expectedRoot);
    if (envelope.phase === "database-ready") {
      envelope = envelopeAtPhase(envelope, "database-installed", report);
      await writeJsonAtomically(paths.envelopePath, envelope);
    }
  } else {
    if (envelope.phase === "database-installed" || envelope.phase === "registry-activated") {
      throw new Error("Catalog v3 migration envelope claims an installed database that is missing.");
    }
    if (envelope.phase === "source-snapshotted") {
      envelope = envelopeAtPhase(envelope, "database-building");
      await writeJsonAtomically(paths.envelopePath, envelope);
    }
    let worker: CatalogWorkerClient | undefined;
    let stagedWorkerCompleted = false;
    try {
      await fs.mkdir(path.dirname(envelope.stagingDatabasePath), { recursive: true, mode: 0o700 });
      worker = await openWorker(input.workerPath, envelope.stagingDatabasePath);
      await worker.installV3({
        catalogId: envelope.catalogId,
        displayName: envelope.displayName,
        appVersion: envelope.appVersion,
        root: expectedRoot,
        migration: {
          migrationId: envelope.migrationId,
          sourceVersion: plan.rawCatalogVersion,
          catalogPath: snapshot.catalog.path,
          settingsPath: snapshot.settings?.path ?? null,
          catalogSha256: snapshot.catalog.sha256,
          settingsSha256: snapshot.settings?.sha256 ?? null,
          rootAvailable: plan.scan === "online",
          expectedCounts: expected,
          expectedStateSha256,
        },
      });
      const current = await worker.v3Summary(envelope.catalogId);
      if (current.migrationPhase === "failed") {
        throw new Error("Catalog v3 staging database has a failed migration and cannot be replayed.");
      }
      if (
        current.migrationPhase === "created" ||
        current.migrationPhase === "copying-assets" ||
        current.migrationPhase === "copying-relations"
      ) {
        await importPlan(worker, plan, candidates, input);
        await worker.finishV3Copy(envelope.catalogId, envelope.migrationId);
      }
      let validated = await worker.v3Summary(envelope.catalogId);
      if (validated.migrationPhase === "copied" || validated.migrationPhase === "validating" || validated.migrationPhase === "validated") {
        const validation = await worker.validateV3(envelope.catalogId, envelope.migrationId);
        if (!validation.report.clean) {
          throw new Error(`Catalog v3 validation failed: ${validation.report.blockingErrors.join(" ")}`);
        }
        report = validation.report;
        validated = await worker.v3Summary(envelope.catalogId);
      }
      if (validated.installState !== "ready") {
        if (report === undefined || !report.clean) {
          throw new Error("Catalog v3 staging database has no clean validation report.");
        }
        await input.beforeSourceRecheck?.();
        await assertMigrationSourcesUnchanged(input, snapshot);
        await worker.prepareV3Activation(envelope.catalogId, envelope.migrationId);
      }
      if (report === undefined || !report.clean) {
        throw new Error("Catalog v3 staging database has no clean validation report.");
      }
      const seal = await worker.sealV3ForInstall(envelope.catalogId, envelope.migrationId);
      if (seal.busy !== 0 || seal.journalMode !== "delete") {
        throw new Error("Catalog v3 staging database did not seal cleanly.");
      }
      envelope = envelopeAtPhase(envelope, "database-ready", report);
      await writeJsonAtomically(paths.envelopePath, envelope);
      stagedWorkerCompleted = true;
    } finally {
      if (stagedWorkerCompleted) {
        await closeWorker(worker);
      } else {
        await worker?.forceTerminate().catch(() => undefined);
      }
    }
    if (await exists(`${envelope.stagingDatabasePath}-wal`) || await exists(`${envelope.stagingDatabasePath}-shm`)) {
      throw new Error("Catalog v3 staging database still has WAL state after sealing.");
    }
    await assertMigrationSourcesUnchanged(input, snapshot);
    await publishStagingDatabase(envelope, input.afterFinalDatabaseLink);
    envelope = envelopeAtPhase(envelope, "database-installed", report);
    await writeJsonAtomically(paths.envelopePath, envelope);
    summary = await verifyFinalDatabase(input, envelope, expected, expectedStateSha256, expectedRoot);
  }

  if (report === undefined || !report.clean) {
    throw new Error("Catalog v3 migration has no clean validation report.");
  }
  if (envelope.phase !== "registry-activated") {
    await assertMigrationSourcesUnchanged(input, snapshot);
  }
  await input.beforeRegistryActivation?.();
  const registryEntry = await activateRegistry(input, envelope);
  await input.afterRegistryActivation?.();
  if (envelope.phase !== "registry-activated") {
    envelope = envelopeAtPhase(envelope, "registry-activated", report);
    await writeJsonAtomically(paths.envelopePath, envelope);
  }
  return {
    envelopePath: paths.envelopePath,
    phase: "registry-activated",
    databasePath: envelope.finalDatabasePath,
    recoveryEvidence: envelope.recoveryEvidence,
    validationReport: report,
    before: plan.counts,
    after: summary.counts,
    fingerprintCoverage: summary.fingerprintCoverage,
    limitations: limitationsFor(plan, report),
    registryEntry,
  };
}
