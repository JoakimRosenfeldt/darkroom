import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseCatalogId,
  parseOperationId,
  parseRootId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";
import { canonicalJson, type JsonObject, type JsonValue } from "../lib/import/domain.ts";

export const CATALOG_PACKAGE_VERSION = 1;
export const RESTORE_ENVELOPE_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_IO_CHUNK_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RESTORE_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 100_000;

export type CatalogPackagePayload =
  | { readonly name: string; readonly bytes: Uint8Array; readonly sourcePath?: never }
  | { readonly name: string; readonly sourcePath: string; readonly bytes?: never };

export interface CatalogPackageFile {
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface CatalogPackageManifest {
  readonly kind: "darkroom-catalog-package";
  readonly version: 1;
  readonly catalogId: CatalogId;
  readonly schemaVersion: 3;
  readonly appVersion: string;
  readonly createdAt: number;
  readonly roots: readonly CatalogPackageRoot[];
  readonly files: readonly CatalogPackageFile[];
}

export interface CatalogPackageRoot {
  readonly rootId: RootId;
  readonly label: string;
  readonly configuredPath: string;
}

export interface CatalogPackageSummary {
  readonly catalogId: CatalogId;
  readonly version: 1;
  readonly schemaVersion: 3;
  readonly appVersion: string;
  readonly rootCount: number;
  readonly fileCount: number;
  readonly manifestSha256: string;
}

export interface CreateCatalogPackageInput {
  readonly targetDirectory: string;
  readonly catalogId: CatalogId;
  readonly appVersion: string;
  readonly roots: readonly CatalogPackageRoot[];
  readonly payloads: readonly CatalogPackagePayload[];
  readonly backupAndValidate: () => Promise<void>;
  readonly now?: number;
}

export type RestoreMode = "open-as-new" | "merge" | "replace";
export type RestoreEnvelopeStage =
  | "created"
  | "safety-backup-created"
  | "restored-to-temp"
  | "forward-facts-applied"
  | "validated"
  | "swapped"
  | "reconciled"
  | "completed"
  | "rolled-back";

export type RestoreFactStatus = "pending" | "linked" | "queued";

export interface RestoreForwardFact {
  readonly factId: string;
  readonly kind: string;
  readonly status: RestoreFactStatus;
}

export interface RestoreEnvelope {
  readonly kind: "darkroom-restore-recovery";
  readonly version: 1;
  readonly restoreId: OperationId;
  readonly sourceCatalogId: CatalogId;
  readonly targetCatalogId: CatalogId;
  readonly sourcePackageSha256: string;
  readonly mode: RestoreMode;
  readonly dryRunId: string | null;
  readonly targetSha256: string | null;
  readonly safetyBackupSha256: string | null;
  readonly forwardFacts: readonly RestoreForwardFact[];
  readonly stage: RestoreEnvelopeStage;
  readonly updatedAt: number;
}

export interface RestoreDryRun {
  readonly dryRunId: string;
  readonly mode: RestoreMode;
  readonly targetCatalogId: CatalogId;
  readonly sourceCatalogId: CatalogId;
  readonly forwardFactCount: number;
}

export interface RestoreAdapter {
  targetSha256(): Promise<string>;
  makeSafetyBackup(): Promise<{ readonly sha256: string }>;
  restoreToTemp(packageDirectory: string, mode: RestoreMode): Promise<void>;
  applyForwardFact(fact: RestoreForwardFact): Promise<"linked" | "queued">;
  resolveForwardFact?(fact: RestoreForwardFact): Promise<"linked" | "queued">;
  validateTemp(): Promise<void>;
  swapIntoPlace(): Promise<void>;
  reopenAndReconcile(): Promise<readonly string[]>;
  rollback(): Promise<void>;
}

export interface RestoreEnvelopeStore {
  read(restoreId: OperationId): Promise<RestoreEnvelope | null>;
  write(envelope: RestoreEnvelope): Promise<void>;
  remove(restoreId: OperationId): Promise<void>;
}

export interface RunRestoreInput {
  readonly packageDirectory: string;
  readonly sourcePackageSha256: string;
  readonly sourceCatalogId: CatalogId;
  readonly targetCatalogId: CatalogId;
  readonly mode: RestoreMode;
  readonly dryRunId?: string;
  readonly confirmation?: string;
  readonly forwardFacts: readonly RestoreForwardFact[];
  readonly adapter: RestoreAdapter;
  readonly envelopes: RestoreEnvelopeStore;
  readonly restoreId?: OperationId;
  readonly now?: () => number;
  readonly existingEnvelope?: RestoreEnvelope;
}

export interface RestoreRunResult {
  readonly status: "completed" | "recovery-required" | "failed" | "rolled-back";
  readonly stage: RestoreEnvelopeStage;
  readonly unresolvedFactIds: readonly string[];
  readonly envelope: RestoreEnvelope;
  readonly error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parsePackageRoots(value: unknown): readonly CatalogPackageRoot[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new Error("Catalog package roots are invalid.");
  }
  const roots = value.map((item): CatalogPackageRoot => {
    if (!isRecord(item)) throw new Error("Catalog package root is invalid.");
    return {
      rootId: parseRootId(item.rootId),
      label: parseBoundedString(item.label, "Catalog package root label", 512),
      configuredPath: parseBoundedString(
        item.configuredPath,
        "Catalog package configured path",
        16_384,
      ),
    };
  });
  if (new Set(roots.map((root) => root.rootId)).size !== roots.length) {
    throw new Error("Catalog package contains duplicate root IDs.");
  }
  return roots;
}

function sha256String(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertSafeAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value !== path.normalize(value) || value === path.parse(value).root) {
    throw new Error(`${label} must be a normalized non-root absolute path.`);
  }
  return value;
}

function normalizePackageEntryName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("Package entry name must be relative.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Package entry name contains an invalid segment.");
  }
  return segments.join("/");
}

function manifestJson(manifest: CatalogPackageManifest): string {
  const files: JsonValue[] = manifest.files.map((file) => ({
    name: file.name,
    byteLength: file.byteLength,
    sha256: file.sha256,
  }));
  const object: JsonObject = {
    kind: manifest.kind,
    version: manifest.version,
    catalogId: manifest.catalogId,
    schemaVersion: manifest.schemaVersion,
    appVersion: manifest.appVersion,
    createdAt: manifest.createdAt,
    roots: manifest.roots.map((root) => ({
      rootId: root.rootId,
      label: root.label,
      configuredPath: root.configuredPath,
    })),
    files,
  };
  return `${canonicalJson(object)}\n`;
}

async function writeFileSyncToDisk(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await fsp.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface FileDigest {
  readonly byteLength: number;
  readonly sha256: string;
}

function sameFileIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function copyPayloadToDisk(
  filePath: string,
  payload: CatalogPackagePayload,
): Promise<FileDigest> {
  if ("bytes" in payload && payload.bytes !== undefined) {
    await writeFileSyncToDisk(filePath, payload.bytes);
    return {
      byteLength: payload.bytes.byteLength,
      sha256: createHash("sha256").update(payload.bytes).digest("hex"),
    };
  }

  const sourcePath = assertSafeAbsolutePath(payload.sourcePath, "Package payload source");
  const link = await fsp.lstat(sourcePath);
  if (!link.isFile() || link.isSymbolicLink() || !Number.isSafeInteger(link.size)) {
    throw new Error("Package payload source must be a regular non-symlink file.");
  }
  const source = await fsp.open(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let target: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || !sameFileIdentity(link, before) || before.size !== link.size) {
      throw new Error("Package payload source changed while it was opened.");
    }
    target = await fsp.open(filePath, "wx", 0o600);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(PACKAGE_IO_CHUNK_BYTES);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (bytesRead <= 0) throw new Error("Package payload source changed while it was copied.");
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error("Catalog package payload could not be written.");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const after = await source.stat();
    if (
      !sameFileIdentity(before, after) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Package payload source changed while it was copied.");
    }
    await target.sync();
    return { byteLength: offset, sha256: digest.digest("hex") };
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await fsp.open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every supported platform.
  }
}

async function readNoFollowFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const linkStat = await fsp.lstat(filePath);
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size > maximumBytes) {
    throw new Error("Package entry is not a regular file.");
  }
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(linkStat, before) || before.size > maximumBytes) {
      throw new Error("Package entry is not a regular file.");
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      !sameFileIdentity(before, after) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      contents.byteLength !== before.size
    ) {
      throw new Error("Package entry changed while it was read.");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function assertRegularDirectory(directoryPath: string, label: string): Promise<void> {
  const stat = await fsp.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory.`);
  }
}

async function digestNoFollowFile(filePath: string): Promise<FileDigest> {
  const link = await fsp.lstat(filePath);
  if (!link.isFile() || link.isSymbolicLink() || !Number.isSafeInteger(link.size)) {
    throw new Error("Package entry is not a regular file.");
  }
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(link, before) || before.size !== link.size) {
      throw new Error("Package entry changed while it was opened.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(PACKAGE_IO_CHUNK_BYTES);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (bytesRead <= 0) throw new Error("Package entry changed while it was read.");
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      !sameFileIdentity(before, after) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Package entry changed while it was read.");
    }
    return { byteLength: offset, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function listPackageEntries(
  directory: string,
  prefix = "",
  names: string[] = [],
): Promise<readonly string[]> {
  const entries = await fsp.readdir(path.join(directory, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error("Catalog package may not contain symbolic links.");
    }
    if (entry.isDirectory()) {
      await listPackageEntries(directory, relative, names);
    } else if (entry.isFile()) {
      names.push(relative);
      if (names.length > MAX_PACKAGE_ENTRIES) {
        throw new Error("Catalog package contains too many entries.");
      }
    } else {
      throw new Error("Catalog package contains an unsupported filesystem entry.");
    }
  }
  return names;
}

async function removeExactTemporaryDirectory(directoryPath: string): Promise<void> {
  if (!directoryPath.includes(".staging-")) {
    throw new Error("Refusing to remove an unmarked package temporary directory.");
  }
  await fsp.rm(directoryPath, { recursive: true, force: true });
}

export async function writeCatalogPackage(
  input: CreateCatalogPackageInput,
): Promise<CatalogPackageSummary> {
  const targetDirectory = assertSafeAbsolutePath(input.targetDirectory, "Package directory");
  const catalogId = parseCatalogId(input.catalogId);
  await input.backupAndValidate();
  const seen = new Set<string>();
  const files: CatalogPackageFile[] = [];
  const stagedDirectory = `${targetDirectory}.staging-${randomUUID()}`;
  try {
    await fsp.mkdir(stagedDirectory, { recursive: false, mode: 0o700 });
    for (const payload of input.payloads) {
      const name = normalizePackageEntryName(payload.name);
      if (seen.has(name) || name === "manifest.json") {
        throw new Error("Package contains duplicate or reserved entries.");
      }
      seen.add(name);
      const target = path.join(stagedDirectory, name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const digest = await copyPayloadToDisk(target, payload);
      files.push({ name, ...digest });
    }
    if (!seen.has("catalog.sqlite")) {
      throw new Error("Catalog package must contain catalog.sqlite.");
    }
    files.sort((left, right) => left.name.localeCompare(right.name));
    const roots = parsePackageRoots(input.roots);
    const appVersion = parseBoundedString(input.appVersion, "Catalog package app version", 256);
    const createdAt = input.now ?? Date.now();
    if (!Number.isFinite(createdAt) || createdAt < 0) {
      throw new Error("Catalog package timestamp is invalid.");
    }
    const manifest: CatalogPackageManifest = {
      kind: "darkroom-catalog-package",
      version: 1,
      catalogId,
      schemaVersion: 3,
      appVersion,
      createdAt,
      roots,
      files,
    };
    await writeFileSyncToDisk(path.join(stagedDirectory, "manifest.json"), Buffer.from(manifestJson(manifest)));
    await syncDirectory(stagedDirectory);
    if (await pathExists(targetDirectory)) {
      throw new Error("Package destination already exists.");
    }
    try {
      await fsp.rename(stagedDirectory, targetDirectory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("Package destination already exists.");
      }
      throw error;
    }
    await syncDirectory(path.dirname(targetDirectory));
    const manifestText = manifestJson(manifest);
    return {
      catalogId,
      version: 1,
      schemaVersion: 3,
      appVersion,
      rootCount: roots.length,
      fileCount: files.length,
      manifestSha256: sha256String(manifestText),
    };
  } catch (error) {
    await removeExactTemporaryDirectory(stagedDirectory).catch(() => undefined);
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function parsePackageManifest(value: unknown): CatalogPackageManifest {
  if (
    !isRecord(value) ||
    value.kind !== "darkroom-catalog-package" ||
    value.version !== 1 ||
    value.schemaVersion !== 3 ||
    !Array.isArray(value.roots) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("Catalog package manifest is invalid.");
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0) {
    throw new Error("Catalog package manifest timestamp is invalid.");
  }
  const roots = parsePackageRoots(value.roots);
  const appVersion = parseBoundedString(value.appVersion, "Catalog package app version", 256);
  const files = value.files.map((file): CatalogPackageFile => {
    if (
      !isRecord(file) ||
      typeof file.name !== "string" ||
      typeof file.byteLength !== "number" ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error("Catalog package file manifest is invalid.");
    }
    return {
      name: normalizePackageEntryName(file.name),
      byteLength: file.byteLength,
      sha256: file.sha256,
    };
  });
  return {
    kind: "darkroom-catalog-package",
    version: 1,
    catalogId: parseCatalogId(value.catalogId),
    schemaVersion: 3,
    appVersion,
    createdAt: value.createdAt,
    roots,
    files,
  };
}

export async function validateCatalogPackage(
  packageDirectory: string,
): Promise<CatalogPackageSummary> {
  const directory = assertSafeAbsolutePath(packageDirectory, "Package directory");
  await assertRegularDirectory(directory, "Package directory");
  const manifestPath = path.join(directory, "manifest.json");
  const manifestText = (await readNoFollowFile(manifestPath, MAX_MANIFEST_BYTES)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error("Catalog package manifest is not JSON.");
  }
  const manifest = parsePackageManifest(parsed);
  const seen = new Set<string>();
  const listed = new Set(manifest.files.map((file) => file.name));
  const actual = new Set(await listPackageEntries(directory));
  actual.delete("manifest.json");
  if (!listed.has("catalog.sqlite")) {
    throw new Error("Catalog package is missing catalog.sqlite.");
  }
  if (actual.size !== listed.size || [...actual].some((name) => !listed.has(name))) {
    throw new Error("Catalog package contains unlisted or missing entries.");
  }
  for (const file of manifest.files) {
    if (seen.has(file.name) || file.name === "manifest.json") {
      throw new Error("Catalog package contains duplicate entries.");
    }
    seen.add(file.name);
    const digest = await digestNoFollowFile(path.join(directory, file.name));
    if (digest.byteLength !== file.byteLength || digest.sha256 !== file.sha256) {
      throw new Error(`Catalog package checksum mismatch for ${file.name}.`);
    }
  }
  return {
    catalogId: manifest.catalogId,
    version: 1,
    schemaVersion: 3,
    appVersion: manifest.appVersion,
    rootCount: manifest.roots.length,
    fileCount: manifest.files.length,
    manifestSha256: sha256String(manifestText),
  };
}

export function restoreConfirmation(mode: Exclude<RestoreMode, "open-as-new">, dryRunId: string): string {
  return `RESTORE ${mode.toUpperCase()} ${dryRunId}`;
}

export function createRestoreDryRun(
  targetCatalogId: CatalogId,
  sourceCatalogId: CatalogId,
  mode: RestoreMode,
  forwardFacts: readonly RestoreForwardFact[],
): RestoreDryRun {
  return {
    dryRunId: randomUUID(),
    mode,
    targetCatalogId,
    sourceCatalogId,
    forwardFactCount: forwardFacts.length,
  };
}

function requireRestoreGate(input: RunRestoreInput): void {
  if (input.mode === "open-as-new") {
    return;
  }
  if (input.dryRunId === undefined || input.confirmation !== restoreConfirmation(input.mode, input.dryRunId)) {
    throw new Error("Merge and Replace require the matching dry-run ID and explicit confirmation.");
  }
}

function parseRestoreStage(value: unknown): RestoreEnvelopeStage {
  const stages: readonly RestoreEnvelopeStage[] = [
    "created",
    "safety-backup-created",
    "restored-to-temp",
    "forward-facts-applied",
    "validated",
    "swapped",
    "reconciled",
    "completed",
    "rolled-back",
  ];
  for (const stage of stages) {
    if (stage === value) return stage;
  }
  throw new Error("Restore envelope stage is invalid.");
}

function parseRestoreMode(value: unknown): RestoreMode {
  if (value !== "open-as-new" && value !== "merge" && value !== "replace") {
    throw new Error("Restore mode is invalid.");
  }
  return value;
}

function parseRestoreFactStatus(value: unknown): RestoreFactStatus {
  if (value === "pending" || value === "linked" || value === "queued") {
    return value;
  }
  throw new Error("Restore forward fact status is invalid.");
}

function parseRestoreFact(value: unknown): RestoreForwardFact {
  if (
    !isRecord(value) ||
    typeof value.factId !== "string" ||
    value.factId.length === 0 ||
    value.factId.length > 256 ||
    typeof value.kind !== "string" ||
    value.kind.length === 0 ||
    value.kind.length > 256 ||
    typeof value.status !== "string"
  ) {
    throw new Error("Restore forward fact is invalid.");
  }
  return { factId: value.factId, kind: value.kind, status: parseRestoreFactStatus(value.status) };
}

function validateRestoreFacts(facts: readonly RestoreForwardFact[]): readonly RestoreForwardFact[] {
  const parsed = facts.map((fact) => parseRestoreFact(fact));
  if (new Set(parsed.map((fact) => fact.factId)).size !== parsed.length) {
    throw new Error("Restore forward facts contain duplicate IDs.");
  }
  return parsed;
}

export function parseRestoreEnvelope(value: unknown): RestoreEnvelope {
  if (
    !isRecord(value) ||
    value.kind !== "darkroom-restore-recovery" ||
    value.version !== 1 ||
    typeof value.sourcePackageSha256 !== "string" ||
    !SHA256_PATTERN.test(value.sourcePackageSha256) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    !Array.isArray(value.forwardFacts)
  ) {
    throw new Error("Restore envelope is invalid.");
  }
  const dryRunId = value.dryRunId === null ? null : String(value.dryRunId);
  if (dryRunId !== null && !UUID_PATTERN.test(dryRunId)) {
    throw new Error("Restore dry-run ID is invalid.");
  }
  const targetSha256 = value.targetSha256 === null ? null : String(value.targetSha256);
  const safetyBackupSha256 = value.safetyBackupSha256 === null ? null : String(value.safetyBackupSha256);
  if (
    (targetSha256 !== null && !SHA256_PATTERN.test(targetSha256)) ||
    (safetyBackupSha256 !== null && !SHA256_PATTERN.test(safetyBackupSha256))
  ) {
    throw new Error("Restore envelope checksum is invalid.");
  }
  const forwardFacts = value.forwardFacts.map((fact) => parseRestoreFact(fact));
  if (new Set(forwardFacts.map((fact) => fact.factId)).size !== forwardFacts.length) {
    throw new Error("Restore envelope contains duplicate forward facts.");
  }
  return {
    kind: "darkroom-restore-recovery",
    version: 1,
    restoreId: parseOperationId(value.restoreId),
    sourceCatalogId: parseCatalogId(value.sourceCatalogId),
    targetCatalogId: parseCatalogId(value.targetCatalogId),
    sourcePackageSha256: value.sourcePackageSha256,
    mode: parseRestoreMode(value.mode),
    dryRunId,
    targetSha256,
    safetyBackupSha256,
    forwardFacts,
    stage: parseRestoreStage(value.stage),
    updatedAt: value.updatedAt,
  };
}

function envelopeJson(envelope: RestoreEnvelope): string {
  const value: JsonObject = {
    kind: envelope.kind,
    version: envelope.version,
    restoreId: envelope.restoreId,
    sourceCatalogId: envelope.sourceCatalogId,
    targetCatalogId: envelope.targetCatalogId,
    sourcePackageSha256: envelope.sourcePackageSha256,
    mode: envelope.mode,
    dryRunId: envelope.dryRunId,
    targetSha256: envelope.targetSha256,
    safetyBackupSha256: envelope.safetyBackupSha256,
    forwardFacts: envelope.forwardFacts.map((fact) => ({
      factId: fact.factId,
      kind: fact.kind,
      status: fact.status,
    })),
    stage: envelope.stage,
    updatedAt: envelope.updatedAt,
  };
  return `${canonicalJson(value)}\n`;
}

export class FileRestoreEnvelopeStore implements RestoreEnvelopeStore {
  private readonly directory: string;
  private currentWrite = Promise.resolve();

  constructor(directory: string) {
    this.directory = assertSafeAbsolutePath(directory, "Restore envelope directory");
  }

  async read(restoreId: OperationId): Promise<RestoreEnvelope | null> {
    try {
      await this.currentWrite;
      const text = (await readNoFollowFile(
        this.filePath(restoreId),
        MAX_RESTORE_ENVELOPE_BYTES,
      )).toString("utf8");
      const parsed: unknown = JSON.parse(text);
      return parseRestoreEnvelope(parsed);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async write(envelope: RestoreEnvelope): Promise<void> {
    const validated = parseRestoreEnvelope(envelope);
    const task = this.currentWrite.then(async () => {
      await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directoryStat = await fsp.lstat(this.directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("Restore envelope directory must be a regular directory.");
      }
      const target = this.filePath(validated.restoreId);
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        await writeFileSyncToDisk(temporary, Buffer.from(envelopeJson(validated)));
        await fsp.rename(temporary, target);
        await syncDirectory(this.directory);
      } finally {
        await fsp.unlink(temporary).catch(() => undefined);
      }
    });
    this.currentWrite = task.then(() => undefined, () => undefined);
    await task;
  }

  async remove(restoreId: OperationId): Promise<void> {
    await this.currentWrite;
    try {
      const target = this.filePath(restoreId);
      const stat = await fsp.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Restore envelope must be a regular file.");
      }
      await fsp.unlink(target);
      await syncDirectory(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  private filePath(restoreId: OperationId): string {
    return path.join(this.directory, `${parseOperationId(restoreId)}.json`);
  }
}

function replaceFactStatus(
  facts: readonly RestoreForwardFact[],
  factId: string,
  status: RestoreFactStatus,
): readonly RestoreForwardFact[] {
  return facts.map((fact) => fact.factId === factId ? { ...fact, status } : fact);
}

function unresolvedFactIds(facts: readonly RestoreForwardFact[]): readonly string[] {
  return facts.filter((fact) => fact.status !== "linked").map((fact) => fact.factId);
}

function assertResumeEnvelope(input: RunRestoreInput, envelope: RestoreEnvelope): void {
  if (
    envelope.sourceCatalogId !== input.sourceCatalogId ||
    envelope.targetCatalogId !== input.targetCatalogId ||
    envelope.mode !== input.mode ||
    envelope.dryRunId !== (input.dryRunId ?? null) ||
    envelope.sourcePackageSha256 !== input.sourcePackageSha256 ||
    (input.restoreId !== undefined && input.restoreId !== envelope.restoreId)
  ) {
    throw new Error("Restore resume inputs do not match the external envelope.");
  }
  const expected = new Map(input.forwardFacts.map((fact) => [fact.factId, fact.kind]));
  if (
    expected.size !== envelope.forwardFacts.length ||
    envelope.forwardFacts.some((fact) => expected.get(fact.factId) !== fact.kind)
  ) {
    throw new Error("Restore forward facts do not match the external envelope.");
  }
}

export async function runRestore(input: RunRestoreInput): Promise<RestoreRunResult> {
  if (input.dryRunId !== undefined && !UUID_PATTERN.test(input.dryRunId)) {
    throw new Error("Restore dry-run ID is invalid.");
  }
  const inputFacts = validateRestoreFacts(input.forwardFacts);
  const existingEnvelope = input.existingEnvelope === undefined
    ? undefined
    : parseRestoreEnvelope(input.existingEnvelope);
  requireRestoreGate(input);
  if (!SHA256_PATTERN.test(input.sourcePackageSha256)) {
    throw new Error("Restore source package checksum is invalid.");
  }
  const packageSummary = await validateCatalogPackage(input.packageDirectory);
  if (packageSummary.catalogId !== input.sourceCatalogId || packageSummary.manifestSha256 !== input.sourcePackageSha256) {
    throw new Error("Restore source package identity does not match the request.");
  }
  if (existingEnvelope !== undefined) {
    assertResumeEnvelope(input, existingEnvelope);
  }
  const now = input.now ?? Date.now;
  const requestedRestoreId = input.restoreId === undefined ? undefined : parseOperationId(input.restoreId);
  const restoreId = existingEnvelope?.restoreId ?? requestedRestoreId ?? parseOperationId(randomUUID());
  let envelope: RestoreEnvelope = existingEnvelope ?? {
    kind: "darkroom-restore-recovery",
    version: 1,
    restoreId,
    sourceCatalogId: input.sourceCatalogId,
    targetCatalogId: input.targetCatalogId,
    sourcePackageSha256: input.sourcePackageSha256,
    mode: input.mode,
    dryRunId: input.dryRunId ?? null,
    targetSha256: null,
    safetyBackupSha256: null,
    forwardFacts: inputFacts.map((fact) => ({ ...fact })),
    stage: "created",
    updatedAt: now(),
  };
  const resumedFromReconciled = envelope.stage === "reconciled";
  const save = async (): Promise<void> => {
    envelope = { ...envelope, updatedAt: now() };
    await input.envelopes.write(envelope);
  };
  try {
    if (envelope.stage === "created") {
      envelope = {
        ...envelope,
        targetSha256: assertSha256(await input.adapter.targetSha256(), "Target catalog checksum"),
      };
      await save();
      if (input.mode === "replace") {
        const safety = await input.adapter.makeSafetyBackup();
        envelope = {
          ...envelope,
          safetyBackupSha256: assertSha256(safety.sha256, "Safety backup checksum"),
          stage: "safety-backup-created",
        };
        await save();
      }
    }
    if (envelope.stage === "created" || envelope.stage === "safety-backup-created") {
      await input.adapter.restoreToTemp(input.packageDirectory, input.mode);
      envelope = { ...envelope, stage: "restored-to-temp" };
      await save();
    }
    if (envelope.stage === "restored-to-temp") {
      for (const fact of envelope.forwardFacts) {
        if (fact.status !== "pending") continue;
        const status = parseRestoreFactStatus(await input.adapter.applyForwardFact(fact));
        envelope = { ...envelope, forwardFacts: replaceFactStatus(envelope.forwardFacts, fact.factId, status) };
        await save();
      }
      envelope = { ...envelope, stage: "forward-facts-applied" };
      await save();
    }
    if (envelope.stage === "forward-facts-applied") {
      await input.adapter.validateTemp();
      envelope = { ...envelope, stage: "validated" };
      await save();
    }
    if (envelope.stage === "validated") {
      await input.adapter.swapIntoPlace();
      envelope = { ...envelope, stage: "swapped" };
      await save();
    }
    if (envelope.stage === "swapped") {
      const unresolved = await input.adapter.reopenAndReconcile();
      for (const factId of unresolved) {
        if (!envelope.forwardFacts.some((fact) => fact.factId === factId)) {
          throw new Error("Restore reconciliation returned an unknown forward fact ID.");
        }
        envelope = { ...envelope, forwardFacts: replaceFactStatus(envelope.forwardFacts, factId, "queued") };
      }
      envelope = { ...envelope, stage: "reconciled" };
      await save();
    }
    if (resumedFromReconciled && envelope.stage === "reconciled") {
      for (const fact of envelope.forwardFacts) {
        if (fact.status !== "queued") continue;
        const status = parseRestoreFactStatus(
          input.adapter.resolveForwardFact !== undefined
            ? await input.adapter.resolveForwardFact(fact)
            : await input.adapter.applyForwardFact(fact),
        );
        envelope = {
          ...envelope,
          forwardFacts: replaceFactStatus(envelope.forwardFacts, fact.factId, status),
        };
        await save();
      }
    }
    const unresolved = unresolvedFactIds(envelope.forwardFacts);
    if (unresolved.length > 0) {
      return { status: "recovery-required", stage: envelope.stage, unresolvedFactIds: unresolved, envelope, error: null };
    }
    envelope = { ...envelope, stage: "completed" };
    await save();
    await input.envelopes.remove(envelope.restoreId);
    return { status: "completed", stage: envelope.stage, unresolvedFactIds: [], envelope, error: null };
  } catch (error) {
    await save().catch(() => undefined);
    return {
      status: "failed",
      stage: envelope.stage,
      unresolvedFactIds: unresolvedFactIds(envelope.forwardFacts),
      envelope,
      error: error instanceof Error ? error.message : "Restore failed.",
    };
  }
}

export async function rollbackRestore(
  envelope: RestoreEnvelope,
  adapter: RestoreAdapter,
  envelopes: RestoreEnvelopeStore,
  now = Date.now,
): Promise<RestoreRunResult> {
  const validated = parseRestoreEnvelope(envelope);
  await adapter.rollback();
  const rolledBack: RestoreEnvelope = { ...validated, stage: "rolled-back", updatedAt: now() };
  await envelopes.write(rolledBack);
  return {
    status: "rolled-back",
    stage: rolledBack.stage,
    unresolvedFactIds: unresolvedFactIds(rolledBack.forwardFacts),
    envelope: rolledBack,
    error: null,
  };
}

export interface CatalogOptimizePreview {
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
}

export interface CatalogOptimizeResult {
  readonly tempSha256: string;
  readonly tempByteLength: number;
}

export interface CatalogAdminAdapter {
  validateReadOnly(): Promise<void>;
  previewOptimize(): Promise<CatalogOptimizePreview>;
  optimizeToTemp(preview: CatalogOptimizePreview): Promise<CatalogOptimizeResult>;
  validateTemp(result: CatalogOptimizeResult): Promise<void>;
  swapOptimized(result: CatalogOptimizeResult): Promise<void>;
}

export async function validateCatalogReadOnly(adapter: CatalogAdminAdapter): Promise<void> {
  await adapter.validateReadOnly();
}

export async function optimizeCatalog(adapter: CatalogAdminAdapter): Promise<void> {
  const preview = await adapter.previewOptimize();
  const result = await adapter.optimizeToTemp(preview);
  await adapter.validateTemp(result);
  await adapter.swapOptimized(result);
}
