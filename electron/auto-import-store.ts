import fs from "node:fs";
import { type FileHandle } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseOperationId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import {
  AutoImportQueue,
  parseAutoImportRuleId,
  parseAutoImportQueueItem,
  parseAutoImportRule,
  validateAutoImportRules,
  type AutoImportQueueItem,
  type AutoImportRule,
  type AutoImportRuleId,
  type StableFileGateInput,
} from "../lib/import/auto-import.ts";

export const AUTO_IMPORT_STORE_VERSION = 1;
export const AUTO_IMPORT_STORE_FILENAME = "auto-import.json";

const ENVELOPE_KIND = "darkroom-auto-import-state";
const MAX_STATE_BYTES = 4 * 1024 * 1024;

type RecordValue = Record<string, unknown>;

export interface AutoImportStoreState {
  readonly rules: readonly AutoImportRule[];
  readonly queue: AutoImportQueue;
  readonly paused: boolean;
}

interface AutoImportStateEnvelope {
  readonly version: typeof AUTO_IMPORT_STORE_VERSION;
  readonly kind: typeof ENVELOPE_KIND;
  readonly rules: readonly AutoImportRule[];
  readonly items: readonly AutoImportQueueItem[];
  readonly paused: boolean;
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
    throw new Error("Auto Import state directory must be a normalized absolute non-root path.");
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
        throw new Error("Auto Import persistence refuses symlink traversal.");
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
    throw new Error("Auto Import state path is not a regular directory.");
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
      throw new Error("Auto Import state file is not a regular file.");
    }
    handle = await fsp.open(filePath, noFollowFlags());
    const opened = await handle.stat();
    if (!opened.isFile() || !sameOpenedFile(initial, opened)) {
      throw new Error("Auto Import state file changed while opening.");
    }
    if (opened.size > MAX_STATE_BYTES) {
      throw new Error("Auto Import state file is too large.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_STATE_BYTES) {
      throw new Error("Auto Import state file is too large.");
    }
    const after = await handle.stat();
    if (
      !sameOpenedFile(opened, after) ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("Auto Import state file changed while reading.");
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
  try {
    const target = await fsp.lstat(filePath);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error("Auto Import state target is not a regular file.");
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const contents = JSON.stringify(value);
  if (contents === undefined || Buffer.byteLength(contents, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Auto Import state file is too large.");
  }
  const temporaryPath = path.join(directoryPath, `.${path.basename(filePath)}.${cryptoRandomUuid()}.tmp`);
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

function queueFor(filePath: string): SerializedQueue {
  const existing = writeQueues.get(filePath);
  if (existing !== undefined) return existing;
  const created: SerializedQueue = { current: Promise.resolve() };
  writeQueues.set(filePath, created);
  return created;
}

const RULE_KEYS = [
  "catalogId",
  "ruleId",
  "ingressRootId",
  "ingressRelativePath",
  "destinationRootId",
  "destinationRelativePath",
  "placement",
  "presetId",
  "presetVersion",
  "presetSha256",
  "duplicatePolicy",
  "destinationConflictPolicy",
  "enabled",
  "stabilityMs",
  "maxAttempts",
  "retryBackoffMs",
] as const;

const ITEM_KEYS = [
  "queueId",
  "catalogId",
  "ruleId",
  "relativePath",
  "placement",
  "observation",
  "dedupeKey",
  "state",
  "attempts",
  "maxAttempts",
  "recoveryRequired",
  "retryBackoffMs",
  "nextAttemptAt",
  "leaseUntil",
  "error",
  "createdAt",
  "updatedAt",
] as const;

const ENVELOPE_KEYS = ["version", "kind", "rules", "items", "paused"] as const;

function parseStrictRule(value: unknown): AutoImportRule {
  if (!isRecord(value)) throw new Error("Auto Import rule is invalid.");
  assertExactKeys(value, RULE_KEYS, "Auto Import rule");
  return parseAutoImportRule(value);
}

function parseStrictItem(value: unknown): AutoImportQueueItem {
  if (!isRecord(value)) throw new Error("Auto Import queue item is invalid.");
  const keys = "recoveryRequired" in value
    ? ITEM_KEYS
    : ITEM_KEYS.filter((key) => key !== "recoveryRequired");
  assertExactKeys(value, keys, "Auto Import queue item");
  return parseAutoImportQueueItem(value);
}

function validateSnapshotOwnership(
  rules: readonly AutoImportRule[],
  items: readonly AutoImportQueueItem[],
): void {
  const ruleIds = new Set<AutoImportRuleId>();
  for (const rule of rules) {
    if (ruleIds.has(rule.ruleId)) throw new Error("Auto Import state contains a duplicate rule ID.");
    ruleIds.add(rule.ruleId);
  }
  validateAutoImportRules(rules);
  const queueIds = new Set<OperationId>();
  const dedupeKeys = new Set<string>();
  for (const item of items) {
    if (queueIds.has(item.queueId)) throw new Error("Auto Import state contains a duplicate queue ID.");
    queueIds.add(item.queueId);
    if (dedupeKeys.has(item.dedupeKey)) throw new Error("Auto Import state contains a duplicate queue item.");
    dedupeKeys.add(item.dedupeKey);
    const owner = rules.find((rule) => rule.ruleId === item.ruleId);
    if (owner === undefined || owner.catalogId !== item.catalogId || item.placement !== "copy") {
      throw new Error("Auto Import queue item has no matching Copy rule owner.");
    }
  }
}

export function parseAutoImportStoreSnapshot(value: unknown): AutoImportStoreState {
  if (!isRecord(value)) throw new Error("Auto Import state envelope is invalid.");
  assertExactKeys(value, ENVELOPE_KEYS, "Auto Import state envelope");
  if (value.version !== AUTO_IMPORT_STORE_VERSION || value.kind !== ENVELOPE_KIND) {
    throw new Error("Auto Import state envelope version is invalid.");
  }
  if (!Array.isArray(value.rules) || !Array.isArray(value.items) || typeof value.paused !== "boolean") {
    throw new Error("Auto Import state envelope fields are invalid.");
  }
  const rules = value.rules.map(parseStrictRule);
  const items = value.items.map(parseStrictItem);
  validateSnapshotOwnership(rules, items);
  const queue = new AutoImportQueue(items);
  if (value.paused) queue.pause();
  return { rules, queue, paused: value.paused };
}

function emptyState(): AutoImportStoreState {
  return { rules: [], queue: new AutoImportQueue(), paused: false };
}

function snapshotEnvelope(state: AutoImportStoreState): AutoImportStateEnvelope {
  if (!isRecord(state) || !Array.isArray(state.rules) || !(state.queue instanceof AutoImportQueue) || typeof state.paused !== "boolean") {
    throw new Error("Auto Import state is invalid.");
  }
  const rules = state.rules.map(parseStrictRule);
  const items = state.queue.list().map(parseStrictItem);
  validateSnapshotOwnership(rules, items);
  if (state.queue.isPaused !== state.paused) {
    throw new Error("Auto Import paused state is inconsistent.");
  }
  return {
    version: AUTO_IMPORT_STORE_VERSION,
    kind: ENVELOPE_KIND,
    rules,
    items,
    paused: state.paused,
  };
}

function cryptoRandomUuid(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  throw new Error("Secure UUID generation is unavailable.");
}

export class AutoImportStore {
  private readonly filePath: string;
  private readonly queue: SerializedQueue;

  constructor(stateDirectory: string) {
    const normalizedStateDirectory = assertStateDirectory(stateDirectory);
    this.filePath = path.join(normalizedStateDirectory, AUTO_IMPORT_STORE_FILENAME);
    this.queue = queueFor(this.filePath);
  }

  load(): Promise<AutoImportStoreState> {
    return serialize(this.queue, () => this.readState());
  }

  save(state: AutoImportStoreState): Promise<void>;
  save(rules: readonly AutoImportRule[], queue: AutoImportQueue, paused?: boolean): Promise<void>;
  save(
    stateOrRules: AutoImportStoreState | readonly AutoImportRule[],
    queue?: AutoImportQueue,
    paused?: boolean,
  ): Promise<void> {
    return serialize(this.queue, async () => {
      let state: AutoImportStoreState;
      if (!("queue" in stateOrRules)) {
        state = {
          rules: stateOrRules,
          queue: queue ?? new AutoImportQueue(),
          paused: paused ?? queue?.isPaused ?? false,
        };
      } else {
        state = stateOrRules;
      }
      await this.writeState(state);
    });
  }

  setRules(rules: readonly AutoImportRule[]): Promise<void> {
    return serialize(this.queue, async () => {
      const state = await this.readState();
      const nextRules = rules.map(parseStrictRule);
      validateSnapshotOwnership(nextRules, state.queue.list());
      await this.writeState({ ...state, rules: nextRules });
    });
  }

  enqueue(
    ruleId: AutoImportRuleId,
    gate: StableFileGateInput,
    now = Date.now(),
  ): Promise<AutoImportQueueItem | null> {
    return serialize(this.queue, async () => {
      const state = await this.readState();
      const parsedRuleId = parseAutoImportRuleId(ruleId);
      const rule = state.rules.find((candidate) => candidate.ruleId === parsedRuleId);
      if (rule === undefined) throw new Error("Auto Import rule does not exist.");
      const item = state.queue.enqueue(rule, gate, now);
      await this.writeState(state);
      return item;
    });
  }

  claimNext(now = Date.now(), leaseMs = 30_000): Promise<AutoImportQueueItem | null> {
    return serialize(this.queue, async () => {
      const state = await this.readState();
      const item = state.queue.claimNext(now, leaseMs);
      await this.writeState(state);
      return item;
    });
  }

  complete(queueId: OperationId, now = Date.now()): Promise<void> {
    return this.mutate((state) => state.queue.complete(parseOperationId(queueId), now));
  }

  fail(queueId: OperationId, error: string, now = Date.now()): Promise<void> {
    return this.mutate((state) => {
      const parsedQueueId = parseOperationId(queueId);
      const item = state.queue.list().find((candidate) => candidate.queueId === parsedQueueId);
      if (item === undefined) throw new Error("Auto Import queue item does not exist.");
      const rule = state.rules.find((candidate) => candidate.ruleId === item.ruleId);
      if (rule === undefined) throw new Error("Auto Import rule does not exist.");
      state.queue.fail(parsedQueueId, error, rule, now);
    });
  }

  recover(queueId: OperationId, error: string, now = Date.now()): Promise<void> {
    return this.mutate((state) => {
      state.queue.recover(parseOperationId(queueId), error, now);
    });
  }

  cancel(queueId: OperationId, now = Date.now()): Promise<void> {
    return this.mutate((state) => state.queue.cancel(parseOperationId(queueId), now));
  }

  pause(): Promise<void> {
    return this.mutate((state) => {
      state.queue.pause();
      return { ...state, paused: true };
    });
  }

  resume(): Promise<void> {
    return this.mutate((state) => {
      state.queue.resume();
      return { ...state, paused: false };
    });
  }

  disable(ruleId: AutoImportRuleId, now = Date.now()): Promise<void> {
    return this.mutate((state) => state.queue.disable(parseAutoImportRuleId(ruleId), now));
  }

  retryFailed(now = Date.now()): Promise<void> {
    return this.mutate((state) => state.queue.retryFailed(now));
  }

  clearFailed(): Promise<void> {
    return this.mutate((state) => state.queue.clearFailed());
  }

  private mutate(operation: (state: AutoImportStoreState) => AutoImportStoreState | void): Promise<void> {
    return serialize(this.queue, async () => {
      const state = await this.readState();
      const nextState = operation(state) ?? state;
      await this.writeState(nextState);
    });
  }

  private async readState(): Promise<AutoImportStoreState> {
    const value = await readBoundedJson(this.filePath);
    return value === null ? emptyState() : parseAutoImportStoreSnapshot(value);
  }

  private async writeState(state: AutoImportStoreState): Promise<void> {
    await atomicWriteJson(this.filePath, snapshotEnvelope(state));
  }
}

export function createAutoImportStore(stateDirectory: string): AutoImportStore {
  return new AutoImportStore(stateDirectory);
}
