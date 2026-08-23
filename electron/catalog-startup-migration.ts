import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createCatalogId,
  createOperationId,
  createRootId,
  type CatalogId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import type {
  CompleteOnlineScan,
  XmpEvidence,
} from "../lib/catalog/legacy-migration.ts";
import { parsePhotoCatalog } from "../lib/catalog/types.ts";
import { getFormatCapabilityForFileName } from "../lib/formats/registry.ts";
import { getLegacyCatalogPath } from "./catalog-store.ts";
import {
  installCatalogV3Migration,
  type CatalogV3MigrationInstallerInput,
} from "./catalog-v3-migration.ts";
import {
  createCatalogRegistryStore,
  type CatalogRegistryStore,
} from "./catalog-registry.ts";
import { scanNativeFolder, type NativeScanResult } from "./library-scan.ts";

const MAX_XMP_BYTES = 16 * 1024 * 1024;

export interface CatalogStartupSettingsPort {
  getLastFolder(): Promise<string | null>;
  setLastCatalogId(catalogId: CatalogId | null): Promise<void>;
}

export type CatalogStartupMigrationResult =
  | {
      readonly state: "not-needed";
      readonly reason: "catalogs-exist" | "no-legacy-library";
    }
  | {
      readonly state: "migrated";
      readonly catalogId: CatalogId;
      readonly databasePath: string;
      readonly scan: "online" | "offline";
      readonly limitations: readonly string[];
    }
  | {
      readonly state: "recovery-required";
      readonly catalogId: CatalogId | null;
      readonly migrationId: OperationId | null;
      readonly message: string;
      readonly diagnostic: string;
      readonly recoveryDirectory: string | null;
    };

export interface CatalogStartupMigrationOptions {
  readonly userDataPath: string;
  readonly workerPath: string;
  readonly appVersion: string;
  readonly settings: CatalogStartupSettingsPort;
  readonly registry?: CatalogRegistryStore;
  readonly install?: (
    input: CatalogV3MigrationInstallerInput,
  ) => Promise<{
    readonly databasePath: string;
    readonly limitations: readonly string[];
  }>;
  readonly scan?: (rootPath: string) => Promise<NativeScanResult>;
  readonly now?: () => number;
}

function stableUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256").update(namespace).update("\0").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function optionalRegularFile(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${path.basename(filePath)} is not a regular file.`);
    }
    return filePath;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function legacyCatalogCandidates(userDataPath: string): Promise<readonly string[]> {
  const directoryPath = path.join(userDataPath, "catalogs");
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".json")) continue;
    const candidate = path.join(directoryPath, entry.name);
    if (await optionalRegularFile(candidate) !== undefined) candidates.push(candidate);
  }
  return candidates.sort((left, right) => left.localeCompare(right));
}

async function resolveLegacyCatalogPath(
  userDataPath: string,
  lastFolderPath: string | null,
): Promise<string | null> {
  if (lastFolderPath !== null) {
    const expected = getLegacyCatalogPath(userDataPath, path.resolve(lastFolderPath));
    if (await optionalRegularFile(expected) !== undefined) return expected;
  }
  const candidates = await legacyCatalogCandidates(userDataPath);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  throw new Error("More than one legacy catalog exists and the last opened catalog cannot be identified.");
}

function isNodeError(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}

function sidecarPath(rootPath: string, relativePath: string): string {
  const source = path.join(rootPath, ...relativePath.split("/"));
  const parsed = path.parse(source);
  return path.join(
    parsed.dir,
    parsed.ext.toLowerCase() === ".nef" ? `${parsed.name}.xmp` : `${parsed.base}.xmp`,
  );
}

async function readXmpEvidence(filePath: string): Promise<XmpEvidence> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_XMP_BYTES) {
      return { state: "malformed" };
    }
    const bytes = await fs.readFile(filePath);
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { state: "malformed" };
    }
    return {
      state: "preserved",
      contents,
      modifiedAt: stat.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { state: "absent" };
    throw error;
  }
}

async function scanForMigration(
  rootPath: string,
  scan: (rootPath: string) => Promise<NativeScanResult>,
  now: () => number,
): Promise<{
  readonly onlineScan: CompleteOnlineScan;
  readonly xmpByRelativePath: Readonly<Record<string, XmpEvidence>>;
}> {
  const result = await scan(rootPath);
  const observedAt = now();
  const xmpByRelativePath: Record<string, XmpEvidence> = {};
  let xmpComplete = true;
  for (const observation of result.observations) {
    try {
      xmpByRelativePath[observation.relativePath] = await readXmpEvidence(
        sidecarPath(rootPath, observation.relativePath),
      );
    } catch {
      xmpComplete = false;
    }
  }
  return {
    onlineScan: {
      complete: true,
      xmpComplete,
      observations: result.observations.map((observation) => {
        const format = getFormatCapabilityForFileName(observation.name);
        if (format === null) {
          throw new Error("Migration scan returned an unrecognized file format.");
        }
        return {
          relativePath: observation.relativePath,
          byteLength: observation.size,
          modifiedAt: observation.lastModified,
          observedAt,
          localFileId: observation.localFileId ?? null,
          formatId: format.id,
        };
      }),
    },
    xmpByRelativePath,
  };
}

async function defaultScan(rootPath: string): Promise<NativeScanResult> {
  return scanNativeFolder({ rootPath, signal: new AbortController().signal });
}

function displayName(rootPath: string): string {
  return path.basename(rootPath) || "Migrated catalog";
}

export async function migrateLegacyCatalogAtStartup(
  options: CatalogStartupMigrationOptions,
): Promise<CatalogStartupMigrationResult> {
  const registry = options.registry ?? createCatalogRegistryStore(options.userDataPath);
  const install = options.install ?? installCatalogV3Migration;
  const scan = options.scan ?? defaultScan;
  const now = options.now ?? Date.now;
  let catalogId: CatalogId | null = null;
  let migrationId: OperationId | null = null;

  try {
    const registered = await registry.read();
    if (registered.catalogs.length > 0) {
      return { state: "not-needed", reason: "catalogs-exist" };
    }

    const lastFolderPath = await options.settings.getLastFolder();
    const catalogPath = await resolveLegacyCatalogPath(options.userDataPath, lastFolderPath);
    if (catalogPath === null) {
      return { state: "not-needed", reason: "no-legacy-library" };
    }

    const rawCatalog = JSON.parse(await fs.readFile(catalogPath, "utf8")) as unknown;
    const catalog = parsePhotoCatalog(rawCatalog);
    if (lastFolderPath !== null && path.resolve(catalog.rootPath) !== path.resolve(lastFolderPath)) {
      throw new Error("Legacy catalog root does not match the last opened folder.");
    }
    catalogId = createCatalogId(stableUuid("darkroom.catalog-v3", catalog.rootPath));
    const rootId = createRootId(stableUuid("darkroom.catalog-v3.root", catalog.rootPath));
    const settingsPath = await optionalRegularFile(path.join(options.userDataPath, "settings.json"));
    const catalogSha256 = await sha256File(catalogPath);
    const settingsSha256 = settingsPath === undefined ? "none" : await sha256File(settingsPath);
    migrationId = createOperationId(stableUuid(
      "darkroom.catalog-v3.migration",
      `${catalogPath}\0${catalogSha256}\0${settingsSha256}`,
    ));

    let migrationScan: Awaited<ReturnType<typeof scanForMigration>> | undefined;
    try {
      migrationScan = await scanForMigration(catalog.rootPath, scan, now);
    } catch {
      migrationScan = undefined;
    }

    const installed = await install({
      userDataPath: path.resolve(options.userDataPath),
      workerPath: path.resolve(options.workerPath),
      catalogPath,
      ...(settingsPath === undefined ? {} : { settingsPath }),
      catalogId,
      rootId,
      migrationId,
      displayName: displayName(catalog.rootPath),
      appVersion: options.appVersion,
      parseCatalog: parsePhotoCatalog,
      ...(migrationScan === undefined ? {} : migrationScan),
    });
    await options.settings.setLastCatalogId(catalogId);
    return {
      state: "migrated",
      catalogId,
      databasePath: installed.databasePath,
      scan: migrationScan === undefined ? "offline" : "online",
      limitations: installed.limitations,
    };
  } catch (error) {
    return {
      state: "recovery-required",
      catalogId,
      migrationId,
      message: "The existing library could not be migrated safely. Its original files were not changed.",
      diagnostic: error instanceof Error ? error.message : "Legacy catalog migration failed.",
      recoveryDirectory: migrationId === null
        ? null
        : path.join(options.userDataPath, "catalog-migration-recovery", migrationId),
    };
  }
}
