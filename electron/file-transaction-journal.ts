import fs from "node:fs";
import { randomUUID } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  parseAssetId,
  parseOperationId,
  type AssetId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import { parseFileObservation } from "../lib/import/domain.ts";
import {
  CATALOG_FAULT_STAGES,
  type CatalogFaultStage,
} from "./catalog-fault-injection.ts";
import type {
  FileTransactionBackupProof,
  FileTransactionJournal,
  FileTransactionJournalRecord,
} from "./file-transaction-service.ts";
export type { FileTransactionJournal } from "./file-transaction-service.ts";

export const FILE_TRANSACTION_JOURNAL_VERSION = 1;
export const FILE_TRANSACTION_JOURNAL_DIRECTORY = "file-transactions";

const ENVELOPE_KIND = "darkroom-file-transaction-journal";
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RecordValue = Record<string, unknown>;

interface JournalEnvelope {
  readonly version: typeof FILE_TRANSACTION_JOURNAL_VERSION;
  readonly kind: typeof ENVELOPE_KIND;
  readonly record: FileTransactionJournalRecord;
}

interface SerializedQueue {
  current: Promise<void>;
}

const writeQueues = new Map<string, SerializedQueue>();

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
    throw new Error("Operation state directory must be a normalized absolute non-root path.");
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
      if (stat.isSymbolicLink()) {
        throw new Error("Operation persistence refuses symlink traversal.");
      }
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
    throw new Error("Operation persistence directory is not a regular directory.");
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

function sameOpenedFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedJson(filePath: string): Promise<unknown | null> {
  await assertNoSymlinkComponents(path.dirname(filePath));
  let handle: FileHandle | undefined;
  try {
    const initial = await fsp.lstat(filePath);
    if (initial.isSymbolicLink() || !initial.isFile()) {
      throw new Error("Operation persistence record is not a regular file.");
    }
    handle = await fsp.open(filePath, noFollowFlags());
    const opened = await handle.stat();
    if (!opened.isFile() || !sameOpenedFile(initial, opened)) {
      throw new Error("Operation persistence record changed while opening.");
    }
    if (opened.size > MAX_JOURNAL_BYTES) {
      throw new Error("Operation persistence record is too large.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_JOURNAL_BYTES) {
      throw new Error("Operation persistence record is too large.");
    }
    const after = await handle.stat();
    if (
      !sameOpenedFile(opened, after) ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("Operation persistence record changed while reading.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
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
  try {
    const target = await fsp.lstat(filePath);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error("Operation persistence target is not a regular file.");
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const contents = JSON.stringify(value);
  if (contents === undefined || Buffer.byteLength(contents, "utf8") > MAX_JOURNAL_BYTES) {
    throw new Error("Operation persistence record is too large.");
  }
  const temporaryPath = path.join(directoryPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(temporaryPath, filePath);
    await syncDirectory(directoryPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.unlink(temporaryPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

function serialize<T>(queue: SerializedQueue, operation: () => Promise<T>): Promise<T> {
  const next = queue.current.then(operation, operation);
  queue.current = next.then(() => undefined, () => undefined);
  return next;
}

function queueFor(directoryPath: string): SerializedQueue {
  const existing = writeQueues.get(directoryPath);
  if (existing !== undefined) return existing;
  const created: SerializedQueue = { current: Promise.resolve() };
  writeQueues.set(directoryPath, created);
  return created;
}

function parsePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    value !== path.normalize(value) ||
    value === path.parse(value).root
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseNullablePath(value: unknown, label: string): string | null {
  return value === null ? null : parsePath(value, label);
}

function parseStage(value: unknown): CatalogFaultStage {
  for (const stage of CATALOG_FAULT_STAGES) {
    if (stage === value) {
      return stage;
    }
  }
  throw new Error("Transaction journal stage is invalid.");
}

function parseAction(value: unknown): FileTransactionJournalRecord["action"] {
  if (value !== "add" && value !== "copy" && value !== "move" && value !== "rename") {
    throw new Error("Transaction journal action is invalid.");
  }
  return value;
}

function parseXmpStatus(value: unknown): FileTransactionJournalRecord["xmpStatus"] {
  if (value !== "absent" && value !== "preserved" && value !== "mismatch") {
    throw new Error("Transaction journal XMP status is invalid.");
  }
  return value;
}

function parseProof(value: unknown, label: string): FileTransactionBackupProof | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  assertExactKeys(value, ["sha256", "observation"], label);
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error(`${label} digest is invalid.`);
  }
  return {
    sha256: value.sha256,
    observation: parseFileObservation(value.observation),
  };
}

const JOURNAL_RECORD_KEYS = [
  "operationId",
  "itemId",
  "action",
  "destinationAssetId",
  "stage",
  "sourcePath",
  "destinationPath",
  "xmpSourcePath",
  "xmpDestinationPath",
  "imageStagePath",
  "xmpStagePath",
  "imageBackupPath",
  "xmpBackupPath",
  "imageBackupProof",
  "xmpBackupProof",
  "xmpStatus",
  "updatedAt",
] as const;

export function parseFileTransactionJournalRecord(value: unknown): FileTransactionJournalRecord {
  if (!isRecord(value)) throw new Error("Transaction journal record is invalid.");
  assertExactKeys(value, JOURNAL_RECORD_KEYS, "Transaction journal record");
  const operationId = parseOperationId(value.operationId);
  const itemId = parseAssetId(value.itemId);
  const xmpSourcePath = parseNullablePath(value.xmpSourcePath, "XMP source path");
  const xmpDestinationPath = parseNullablePath(value.xmpDestinationPath, "XMP destination path");
  const xmpStagePath = parseNullablePath(value.xmpStagePath, "XMP stage path");
  const xmpBackupPath = parseNullablePath(value.xmpBackupPath, "XMP backup path");
  if (
    (xmpSourcePath === null) !== (xmpDestinationPath === null) ||
    (xmpDestinationPath === null) !== (xmpStagePath === null) ||
    (xmpDestinationPath === null) !== (xmpBackupPath === null)
  ) {
    throw new Error("Transaction journal XMP paths are inconsistent.");
  }
  const imageBackupPath = parseNullablePath(value.imageBackupPath, "Image backup path");
  const imageBackupProof = parseProof(value.imageBackupProof, "Image backup proof");
  const xmpBackupProof = parseProof(value.xmpBackupProof, "XMP backup proof");
  if ((imageBackupPath === null && imageBackupProof !== null) || (xmpBackupPath === null && xmpBackupProof !== null)) {
    throw new Error("Transaction journal backup proof is inconsistent.");
  }
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) {
    throw new Error("Transaction journal timestamp is invalid.");
  }
  return {
    operationId,
    itemId,
    action: parseAction(value.action),
    destinationAssetId: parseAssetId(value.destinationAssetId),
    stage: parseStage(value.stage),
    sourcePath: parsePath(value.sourcePath, "Source path"),
    destinationPath: parsePath(value.destinationPath, "Destination path"),
    xmpSourcePath,
    xmpDestinationPath,
    imageStagePath: parsePath(value.imageStagePath, "Image stage path"),
    xmpStagePath,
    imageBackupPath,
    xmpBackupPath,
    imageBackupProof,
    xmpBackupProof,
    xmpStatus: parseXmpStatus(value.xmpStatus),
    updatedAt: value.updatedAt,
  };
}

function parseEnvelope(value: unknown): JournalEnvelope {
  if (!isRecord(value)) throw new Error("Transaction journal envelope is invalid.");
  assertExactKeys(value, ["version", "kind", "record"], "Transaction journal envelope");
  if (value.version !== FILE_TRANSACTION_JOURNAL_VERSION || value.kind !== ENVELOPE_KIND) {
    throw new Error("Transaction journal envelope version is invalid.");
  }
  return {
    version: FILE_TRANSACTION_JOURNAL_VERSION,
    kind: ENVELOPE_KIND,
    record: parseFileTransactionJournalRecord(value.record),
  };
}

function recordFileName(itemId: AssetId): string {
  return `${itemId}.json`;
}

function operationDirectory(stateDirectory: string, operationId: OperationId): string {
  return path.join(stateDirectory, FILE_TRANSACTION_JOURNAL_DIRECTORY, operationId);
}

function recordPath(stateDirectory: string, operationId: OperationId, itemId: AssetId): string {
  return path.join(operationDirectory(stateDirectory, operationId), recordFileName(itemId));
}

async function readRecordFile(filePath: string): Promise<FileTransactionJournalRecord | null> {
  const value = await readBoundedJson(filePath);
  if (value === null) return null;
  return parseEnvelope(value).record;
}

async function readOperationRecords(
  stateDirectory: string,
  operationId: OperationId,
): Promise<readonly FileTransactionJournalRecord[]> {
  const directoryPath = operationDirectory(stateDirectory, operationId);
  await assertNoSymlinkComponents(path.join(stateDirectory, FILE_TRANSACTION_JOURNAL_DIRECTORY));
  try {
    const stat = await fsp.lstat(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Transaction journal operation namespace is invalid.");
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  const records: FileTransactionJournalRecord[] = [];
  const seen = new Set<AssetId>();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Transaction journal refuses symlink entries.");
    if (entry.isDirectory() || !entry.isFile()) throw new Error("Transaction journal entry is invalid.");
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (!entry.name.endsWith(".json")) throw new Error("Transaction journal entry is invalid.");
    const encodedItemId = entry.name.slice(0, -".json".length);
    if (!UUID_PATTERN.test(encodedItemId)) throw new Error("Transaction journal record filename is invalid.");
    const itemId = parseAssetId(encodedItemId);
    if (itemId !== encodedItemId) throw new Error("Transaction journal record filename is not canonical.");
    if (seen.has(itemId)) throw new Error("Transaction journal contains a duplicate record.");
    const record = await readRecordFile(path.join(directoryPath, entry.name));
    if (record === null || record.operationId !== operationId || record.itemId !== itemId) {
      throw new Error("Transaction journal record namespace does not match its contents.");
    }
    seen.add(itemId);
    records.push(record);
  }
  return records.sort((left, right) => left.itemId.localeCompare(right.itemId));
}

export class FileTransactionJournalStore implements FileTransactionJournal {
  private readonly stateDirectory: string;
  private readonly queue: SerializedQueue;

  constructor(stateDirectory: string) {
    this.stateDirectory = assertStateDirectory(stateDirectory);
    this.queue = queueFor(this.stateDirectory);
  }

  read(operationId: OperationId, itemId: AssetId): Promise<FileTransactionJournalRecord | null> {
    const parsedOperationId = parseOperationId(operationId);
    const parsedItemId = parseAssetId(itemId);
    return serialize(this.queue, async () => {
      const records = await readOperationRecords(this.stateDirectory, parsedOperationId);
      return records.find((record) => record.itemId === parsedItemId) ?? null;
    });
  }

  write(record: FileTransactionJournalRecord): Promise<void> {
    return serialize(this.queue, async () => {
      const parsed = parseFileTransactionJournalRecord(record);
      const operationId = parseOperationId(parsed.operationId);
      const itemId = parseAssetId(parsed.itemId);
      const directoryPath = operationDirectory(this.stateDirectory, operationId);
      await ensureDirectory(directoryPath);
      await atomicWriteJson(recordPath(this.stateDirectory, operationId, itemId), {
        version: FILE_TRANSACTION_JOURNAL_VERSION,
        kind: ENVELOPE_KIND,
        record: parsed,
      } satisfies JournalEnvelope);
    });
  }

  list(operationId: OperationId): Promise<readonly FileTransactionJournalRecord[]> {
    const parsedOperationId = parseOperationId(operationId);
    return serialize(this.queue, () => readOperationRecords(this.stateDirectory, parsedOperationId));
  }
}

export function createFileTransactionJournal(stateDirectory: string): FileTransactionJournal {
  return new FileTransactionJournalStore(stateDirectory);
}
