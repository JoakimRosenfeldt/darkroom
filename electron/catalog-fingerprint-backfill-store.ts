import fs, { type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  parseCatalogId,
  parseOperationId,
  type CatalogId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import {
  parseFingerprintBackfillSnapshot,
  type FingerprintBackfillPersistence,
  type FingerprintBackfillSnapshot,
} from "./catalog-fingerprint-backfill-service.ts";

export const CATALOG_FINGERPRINT_BACKFILL_STORE_VERSION = 1 as const;
export const CATALOG_FINGERPRINT_BACKFILL_DIRECTORY = "fingerprint-backfill";
export const CATALOG_FINGERPRINT_BACKFILL_FILENAME_SUFFIX = ".json";

const ENVELOPE_KIND = "darkroom-catalog-fingerprint-backfill";
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 10_000;

type RecordValue = Record<string, unknown>;

interface SnapshotEnvelope {
  readonly version: typeof CATALOG_FINGERPRINT_BACKFILL_STORE_VERSION;
  readonly kind: typeof ENVELOPE_KIND;
  readonly catalogId: CatalogId;
  readonly operationId: OperationId;
  readonly snapshot: FingerprintBackfillSnapshot;
}

interface SerialQueue {
  current: Promise<void>;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

const writeQueues = new Map<string, SerialQueue>();

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  return error.code;
}

function assertExactKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${label} contains unexpected fields.`);
  }
}

function assertStateDirectory(directoryPath: string): string {
  if (
    !path.isAbsolute(directoryPath) ||
    directoryPath !== path.normalize(directoryPath) ||
    directoryPath === path.parse(directoryPath).root ||
    directoryPath.includes("\0")
  ) {
    throw new Error("Fingerprint backfill state directory must be a normalized absolute non-root path.");
  }
  return directoryPath;
}

async function assertNoSymlinkComponents(targetPath: string): Promise<void> {
  const normalized = path.normalize(targetPath);
  const root = path.parse(normalized).root;
  let current = root;
  const components = normalized.slice(root.length).split(path.sep).filter((part) => part.length > 0);
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Fingerprint backfill persistence refuses symlink traversal.");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await assertNoSymlinkComponents(directoryPath);
  await fsp.mkdir(directoryPath, { recursive: true });
  await assertNoSymlinkComponents(directoryPath);
  const stat = await fsp.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Fingerprint backfill persistence directory is invalid.");
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "ENOSYS") throw error;
  } finally {
    await handle?.close();
  }
}

function noFollowFlags(): number {
  return fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
}

function fileIdentity(stat: fs.Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function lstatRegularFile(filePath: string): Promise<fs.Stats | null> {
  try {
    const stat = await fsp.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Fingerprint backfill snapshot target is not a regular file.");
    }
    return stat;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readBoundedJson(filePath: string): Promise<unknown | null> {
  await assertNoSymlinkComponents(path.dirname(filePath));
  let handle: FileHandle | undefined;
  try {
    const initial = await lstatRegularFile(filePath);
    if (initial === null) return null;
    handle = await fsp.open(filePath, noFollowFlags());
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(fileIdentity(initial), fileIdentity(opened))) {
      throw new Error("Fingerprint backfill snapshot changed while opening.");
    }
    if (opened.size > MAX_STORE_BYTES) throw new Error("Fingerprint backfill snapshot is too large.");
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_STORE_BYTES) throw new Error("Fingerprint backfill snapshot is too large.");
    const after = await handle.stat();
    if (!sameFileIdentity(fileIdentity(opened), fileIdentity(after))) {
      throw new Error("Fingerprint backfill snapshot changed while reading.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await ensureDirectory(directoryPath);
  const targetBefore = await lstatRegularFile(filePath);
  const targetIdentity = targetBefore === null ? null : fileIdentity(targetBefore);
  const contents = JSON.stringify(value);
  if (contents === undefined || Buffer.byteLength(contents, "utf8") > MAX_STORE_BYTES) {
    throw new Error("Fingerprint backfill snapshot is too large.");
  }
  const temporaryPath = path.join(directoryPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const targetBeforeRename = await lstatRegularFile(filePath);
    const targetBeforeRenameIdentity = targetBeforeRename === null ? null : fileIdentity(targetBeforeRename);
    if (targetIdentity === null ? targetBeforeRenameIdentity !== null :
      targetBeforeRenameIdentity === null || !sameFileIdentity(targetIdentity, targetBeforeRenameIdentity)) {
      throw new Error("Fingerprint backfill snapshot target changed during save.");
    }
    await fsp.rename(temporaryPath, filePath);
    await syncDirectory(directoryPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.unlink(temporaryPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

function serialize<T>(queue: SerialQueue, operation: () => Promise<T>): Promise<T> {
  const next = queue.current.then(operation, operation);
  queue.current = next.then(() => undefined, () => undefined);
  return next;
}

function queueFor(filePath: string): SerialQueue {
  const existing = writeQueues.get(filePath);
  if (existing !== undefined) return existing;
  const created: SerialQueue = { current: Promise.resolve() };
  writeQueues.set(filePath, created);
  return created;
}

function parseEnvelope(value: unknown): SnapshotEnvelope {
  if (!isRecord(value)) throw new Error("Fingerprint backfill snapshot envelope is invalid.");
  assertExactKeys(value, ["version", "kind", "catalogId", "operationId", "snapshot"], "Fingerprint backfill snapshot envelope");
  if (value.version !== CATALOG_FINGERPRINT_BACKFILL_STORE_VERSION || value.kind !== ENVELOPE_KIND) {
    throw new Error("Fingerprint backfill snapshot envelope version is invalid.");
  }
  const catalogId = parseCatalogId(value.catalogId);
  const operationId = parseOperationId(value.operationId);
  const snapshot = parseFingerprintBackfillSnapshot(value.snapshot);
  if (snapshot.catalogId !== catalogId || snapshot.operationId !== operationId) {
    throw new Error("Fingerprint backfill snapshot envelope identity does not match.");
  }
  return {
    version: CATALOG_FINGERPRINT_BACKFILL_STORE_VERSION,
    kind: ENVELOPE_KIND,
    catalogId,
    operationId,
    snapshot,
  };
}

function snapshotPath(stateDirectory: string, catalogId: CatalogId, operationId: OperationId): string {
  return path.join(
    stateDirectory,
    CATALOG_FINGERPRINT_BACKFILL_DIRECTORY,
    catalogId,
    `${operationId}${CATALOG_FINGERPRINT_BACKFILL_FILENAME_SUFFIX}`,
  );
}

export class CatalogFingerprintBackfillStore implements FingerprintBackfillPersistence {
  private readonly catalogId: CatalogId;
  private readonly stateDirectory: string;
  private readonly queue: SerialQueue;

  public constructor(stateDirectory: string, catalogId: CatalogId) {
    this.stateDirectory = assertStateDirectory(stateDirectory);
    this.catalogId = parseCatalogId(catalogId);
    this.queue = queueFor(this.namespacePath());
  }

  public load(operationId: OperationId): Promise<unknown | null> {
    const parsedOperationId = parseOperationId(operationId);
    const filePath = snapshotPath(this.stateDirectory, this.catalogId, parsedOperationId);
    return serialize(this.queue, async () => {
      const value = await readBoundedJson(filePath);
      if (value === null) return null;
      const envelope = parseEnvelope(value);
      if (envelope.catalogId !== this.catalogId || envelope.operationId !== parsedOperationId) {
        throw new Error("Fingerprint backfill snapshot belongs to another namespace.");
      }
      return envelope.snapshot;
    });
  }

  public save(snapshot: FingerprintBackfillSnapshot): Promise<void> {
    return serialize(this.queue, async () => {
      const parsed = parseFingerprintBackfillSnapshot(snapshot);
      if (parsed.catalogId !== this.catalogId) {
        throw new Error("Fingerprint backfill snapshot belongs to another catalog.");
      }
      const filePath = snapshotPath(this.stateDirectory, this.catalogId, parsed.operationId);
      await atomicWriteJson(filePath, {
        version: CATALOG_FINGERPRINT_BACKFILL_STORE_VERSION,
        kind: ENVELOPE_KIND,
        catalogId: this.catalogId,
        operationId: parsed.operationId,
        snapshot: parsed,
      } satisfies SnapshotEnvelope);
    });
  }

  public list(): Promise<readonly FingerprintBackfillSnapshot[]> {
    return serialize(this.queue, async () => {
      const namespacePath = this.namespacePath();
      await assertNoSymlinkComponents(namespacePath);
      let entries: readonly Dirent[];
      try {
        const stat = await fsp.lstat(namespacePath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("Fingerprint backfill catalog namespace is invalid.");
        }
        entries = await fsp.readdir(namespacePath, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
      if (entries.length > MAX_SNAPSHOT_FILES) throw new Error("Too many fingerprint backfill snapshots.");
      const snapshots: FingerprintBackfillSnapshot[] = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new Error("Fingerprint backfill catalog namespace contains an unsafe entry.");
        }
        if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(entry.name)) {
          throw new Error("Fingerprint backfill snapshot filename is invalid.");
        }
        const operationId = parseOperationId(entry.name.slice(0, -".json".length));
        const value = await readBoundedJson(path.join(namespacePath, entry.name));
        if (value === null) throw new Error("Fingerprint backfill snapshot disappeared while listing.");
        const envelope = parseEnvelope(value);
        if (envelope.catalogId !== this.catalogId || envelope.operationId !== operationId) {
          throw new Error("Fingerprint backfill snapshot namespace does not match its contents.");
        }
        snapshots.push(envelope.snapshot);
      }
      return snapshots.sort((left, right) => left.operationId.localeCompare(right.operationId));
    });
  }

  private namespacePath(): string {
    return path.join(this.stateDirectory, CATALOG_FINGERPRINT_BACKFILL_DIRECTORY, this.catalogId);
  }
}

export function createCatalogFingerprintBackfillStore(
  stateDirectory: string,
  catalogId: CatalogId,
): CatalogFingerprintBackfillStore {
  return new CatalogFingerprintBackfillStore(stateDirectory, catalogId);
}
