import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  parseCatalogId,
  type CatalogId,
} from "../lib/catalog/ids.ts";

export const CATALOG_REGISTRY_FILENAME = "catalog-registry.json";

export type CatalogHealth = "healthy" | "degraded" | "missing" | "corrupt";

export interface CatalogRegistryEntry {
  readonly catalogId: CatalogId;
  readonly displayName: string;
  readonly databasePath: string;
  readonly health: CatalogHealth;
  readonly lastOpenedAt: number;
}

export interface CatalogRegistryDocument {
  readonly version: 1;
  readonly catalogs: readonly CatalogRegistryEntry[];
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: RecordValue, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Catalog registry ${key} is invalid.`);
  }
  return value;
}

function canonicalPath(record: RecordValue, key: string): string {
  const value = requiredString(record, key);
  if (
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    value !== path.normalize(value)
  ) {
    throw new Error(`Catalog registry ${key} must be a normalized absolute path.`);
  }
  return value;
}

function parseHealth(value: unknown): CatalogHealth {
  if (
    value !== "healthy" &&
    value !== "degraded" &&
    value !== "missing" &&
    value !== "corrupt"
  ) {
    throw new Error("Catalog registry health is invalid.");
  }
  return value;
}

function parseEntry(value: unknown): CatalogRegistryEntry {
  if (!isRecord(value)) {
    throw new Error("Catalog registry entry must be an object.");
  }
  const lastOpenedAt = value.lastOpenedAt;
  if (typeof lastOpenedAt !== "number" || !Number.isFinite(lastOpenedAt) || lastOpenedAt < 0) {
    throw new Error("Catalog registry lastOpenedAt is invalid.");
  }
  return {
    catalogId: parseCatalogId(value.catalogId),
    displayName: requiredString(value, "displayName"),
    databasePath: canonicalPath(value, "databasePath"),
    health: parseHealth(value.health),
    lastOpenedAt,
  };
}

export function parseCatalogRegistry(value: unknown): CatalogRegistryDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.catalogs)) {
    throw new Error("Catalog registry document is invalid.");
  }
  const catalogs = value.catalogs.map(parseEntry);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const catalog of catalogs) {
    if (ids.has(catalog.catalogId)) {
      throw new Error("Catalog registry contains a duplicate catalog ID.");
    }
    ids.add(catalog.catalogId);
    if (paths.has(catalog.databasePath)) {
      throw new Error("Catalog registry contains a duplicate database path.");
    }
    paths.add(catalog.databasePath);
  }
  return { version: 1, catalogs };
}

export function emptyCatalogRegistry(): CatalogRegistryDocument {
  return { version: 1, catalogs: [] };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  let directory: FileHandle | undefined;
  try {
    directory = await fs.open(directoryPath, "r");
    await directory.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "ENOSYS") {
      throw error;
    }
  } finally {
    await directory?.close();
  }
}

async function canonicalizeEntry(value: CatalogRegistryEntry): Promise<CatalogRegistryEntry> {
  const entry = parseEntry(value);
  try {
    return { ...entry, databasePath: await fs.realpath(entry.databasePath) };
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    try {
      const parent = await fs.realpath(path.dirname(entry.databasePath));
      return { ...entry, databasePath: path.join(parent, path.basename(entry.databasePath)) };
    } catch (parentError) {
      if (entry.health === "missing" && isMissingFileError(parentError)) {
        return entry;
      }
      throw parentError;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

async function canonicalizeDocument(
  value: CatalogRegistryDocument,
): Promise<CatalogRegistryDocument> {
  const parsed = parseCatalogRegistry(value);
  return parseCatalogRegistry({
    version: 1,
    catalogs: await Promise.all(parsed.catalogs.map(canonicalizeEntry)),
  });
}

async function writeAtomically(filePath: string, document: CatalogRegistryDocument): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true });
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directoryPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function readFile(filePath: string): Promise<CatalogRegistryDocument> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    const value: unknown = JSON.parse(contents);
    return parseCatalogRegistry(value);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return emptyCatalogRegistry();
    }
    throw error;
  }
}

function serialize<T>(queue: { current: Promise<void> }, operation: () => Promise<T>): Promise<T> {
  const next = queue.current.then(operation, operation);
  queue.current = next.then(() => undefined, () => undefined);
  return next;
}

const registryQueues = new Map<string, { current: Promise<void> }>();

function registryQueue(filePath: string): { current: Promise<void> } {
  const existing = registryQueues.get(filePath);
  if (existing) return existing;
  const created = { current: Promise.resolve() };
  registryQueues.set(filePath, created);
  return created;
}

export interface CatalogRegistryStore {
  readonly filePath: string;
  read(): Promise<CatalogRegistryDocument>;
  write(value: CatalogRegistryDocument): Promise<void>;
  upsert(value: CatalogRegistryEntry): Promise<void>;
  remove(catalogId: CatalogId): Promise<void>;
}

export function createCatalogRegistryStore(userDataPath: string): CatalogRegistryStore {
  const filePath = path.join(path.resolve(userDataPath), CATALOG_REGISTRY_FILENAME);
  const queue = registryQueue(filePath);
  return {
    filePath,
    read: () => serialize(queue, () => readFile(filePath)),
    write: (value) => serialize(queue, async () => {
      const document = await canonicalizeDocument(value);
      await writeAtomically(filePath, document);
    }),
    upsert: (value) => serialize(queue, async () => {
      const entry = await canonicalizeEntry(value);
      const document = await readFile(filePath);
      const catalogs = document.catalogs.filter((item) => item.catalogId !== entry.catalogId);
      const updated = parseCatalogRegistry({
        version: 1,
        catalogs: [...catalogs, entry],
      });
      await writeAtomically(filePath, updated);
    }),
    remove: (catalogId) => serialize(queue, async () => {
      const parsedId = parseCatalogId(catalogId);
      const document = await readFile(filePath);
      const catalogs = document.catalogs.filter((item) => item.catalogId !== parsedId);
      if (catalogs.length !== document.catalogs.length) {
        await writeAtomically(filePath, { version: 1, catalogs });
      }
    }),
  };
}
