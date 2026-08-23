import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  MigrationRawSource,
  MigrationSourceDescriptor,
} from "../lib/catalog/legacy-migration.ts";

export interface MigrationSourcePaths {
  catalogPath: string;
  settingsPath?: string;
}

export type RawMigrationSnapshot = MigrationSourceDescriptor;

export interface RecoveryEvidenceFile {
  name: "catalog.json" | "settings.json";
  path: string;
  sha256: string;
  byteLength: number;
}

export interface RecoveryEvidence {
  directory: string;
  files: RecoveryEvidenceFile[];
}

export interface RecheckedMigrationSource {
  unchanged: boolean;
  catalog: MigrationRawSource;
  settings?: MigrationRawSource;
}

function isNodeError(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}

function requireAbsoluteNormalizedPath(value: string, name: string): string {
  if (value.length === 0 || value.includes("\0") || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${name} must be absolute, normalized, and NUL-free.`);
  }
  return value;
}

function requireMigrationId(value: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes(":") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error("migrationId must be one safe path segment.");
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function readRawSourceFile(
  sourcePath: string,
  optional: boolean,
): Promise<MigrationRawSource | undefined> {
  requireAbsoluteNormalizedPath(sourcePath, "source path");
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(sourcePath);
  } catch (error) {
    if (optional && isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  const copy = cloneBytes(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(copy);
  } catch {
    text = "";
  }
  return {
    path: sourcePath,
    bytes: copy,
    text,
    sha256: sha256(copy),
  };
}

export async function readMigrationSources(
  paths: MigrationSourcePaths,
): Promise<RawMigrationSnapshot> {
  const catalog = await readRawSourceFile(paths.catalogPath, false);
  if (!catalog) {
    throw new Error("Catalog source is missing.");
  }
  const settings = paths.settingsPath
    ? await readRawSourceFile(paths.settingsPath, true)
    : undefined;
  return settings ? { catalog, settings } : { catalog };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function recoveryDirectory(userDataPath: string, migrationId: string): string {
  const normalizedUserDataPath = requireAbsoluteNormalizedPath(userDataPath, "userDataPath");
  const safeMigrationId = requireMigrationId(migrationId);
  const root = path.join(normalizedUserDataPath, "catalog-migration-recovery");
  const directory = path.join(root, safeMigrationId);
  if (!isInside(root, directory)) {
    throw new Error("Recovery directory escaped its parent.");
  }
  return directory;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      isNodeError(error, "EINVAL") ||
      isNodeError(error, "ENOTSUP") ||
      isNodeError(error, "EISDIR") ||
      isNodeError(error, "EPERM")
    ) {
      return;
    }
    throw error;
  }
}

async function readExistingHash(filePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function writeExclusiveTemp(
  directory: string,
  finalPath: string,
  bytes: Uint8Array,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const temporaryPath = path.join(directory, `.${path.basename(finalPath)}.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      return temporaryPath;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      if (isNodeError(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not create an exclusive recovery temporary file.");
}

async function installEvidenceFile(
  directory: string,
  name: "catalog.json" | "settings.json",
  source: MigrationRawSource,
): Promise<RecoveryEvidenceFile> {
  if (sha256(source.bytes) !== source.sha256) {
    throw new Error(`Recovery evidence "${name}" has a mismatched source hash.`);
  }
  const finalPath = path.join(directory, name);
  const existingHash = await readExistingHash(finalPath);
  if (existingHash !== null) {
    if (existingHash !== source.sha256) {
      throw new Error(`Recovery evidence "${name}" already contains different bytes.`);
    }
    return {
      name,
      path: finalPath,
      sha256: existingHash,
      byteLength: source.bytes.byteLength,
    };
  }

  const temporaryPath = await writeExclusiveTemp(directory, finalPath, source.bytes);
  try {
    await fs.link(temporaryPath, finalPath);
  } catch (error) {
    const racedHash = await readExistingHash(finalPath);
    await fs.unlink(temporaryPath).catch(() => undefined);
    if (isNodeError(error, "EEXIST") && racedHash === source.sha256) {
      return {
        name,
        path: finalPath,
        sha256: racedHash,
        byteLength: source.bytes.byteLength,
      };
    }
    if (isNodeError(error, "EEXIST") && racedHash !== null) {
      throw new Error(`Recovery evidence "${name}" already contains different bytes.`);
    }
    throw error;
  }
  await fs.unlink(temporaryPath);
  await syncDirectory(directory);
  return {
    name,
    path: finalPath,
    sha256: source.sha256,
    byteLength: source.bytes.byteLength,
  };
}

export async function copyMigrationRecoveryEvidence(
  userDataPath: string,
  migrationId: string,
  snapshot: RawMigrationSnapshot,
): Promise<RecoveryEvidence> {
  const directory = recoveryDirectory(userDataPath, migrationId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(path.dirname(directory));
  const files = [await installEvidenceFile(directory, "catalog.json", snapshot.catalog)];
  if (snapshot.settings) {
    files.push(await installEvidenceFile(directory, "settings.json", snapshot.settings));
  }
  await syncDirectory(directory);
  return { directory, files };
}

export async function recheckMigrationSources(
  snapshot: RawMigrationSnapshot,
  paths: Pick<MigrationSourcePaths, "settingsPath"> = {},
): Promise<RecheckedMigrationSource> {
  const catalog = await readRawSourceFile(snapshot.catalog.path, false);
  if (!catalog) {
    throw new Error("Catalog source is missing during migration recheck.");
  }
  const settingsPath = paths.settingsPath ?? snapshot.settings?.path;
  if (snapshot.settings !== undefined && settingsPath !== snapshot.settings.path) {
    throw new Error("Settings source path changed during migration recheck.");
  }
  const settings = settingsPath
    ? await readRawSourceFile(settingsPath, true)
    : undefined;
  const unchanged = catalog.sha256 === snapshot.catalog.sha256 &&
    ((snapshot.settings === undefined && settings === undefined) ||
      (snapshot.settings !== undefined && settings !== undefined && settings.sha256 === snapshot.settings.sha256));
  return settings ? { unchanged, catalog, settings } : { unchanged, catalog };
}
