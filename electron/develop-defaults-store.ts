import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  DEVELOP_DEFAULT_RULE_MAX_AGGREGATE_BYTES,
  DEVELOP_DEFAULT_RULE_MAX_RECORDS,
  cloneDevelopDefaultRule,
  parseDevelopDefaultRule,
  parseDevelopDefaultRuleId,
  type DevelopDefaultRule,
  type DevelopDefaultRuleId,
} from "../lib/develop/defaults/schema.ts";

const MANIFEST_VERSION = 1;

interface DevelopDefaultsManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly rules: readonly DevelopDefaultRule[];
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(`${label} must be an object.`);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) fail(`${label} has unknown fields.`);
  return input;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function manifestBytes(manifest: DevelopDefaultsManifest): number {
  const bytes = Buffer.byteLength(JSON.stringify(manifest), "utf8");
  if (bytes > DEVELOP_DEFAULT_RULE_MAX_AGGREGATE_BYTES) fail("Develop defaults store exceeds the aggregate byte limit.");
  return bytes;
}

function parseManifest(value: unknown): DevelopDefaultsManifest {
  const input = record(value, "Develop defaults manifest", ["version", "rules"]);
  if (input.version !== MANIFEST_VERSION || !Array.isArray(input.rules) || input.rules.length > DEVELOP_DEFAULT_RULE_MAX_RECORDS) {
    return fail("Develop defaults manifest is invalid.");
  }
  const rules = input.rules.map(parseDevelopDefaultRule);
  const revisions = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.ruleId}:${rule.revision}`;
    if (revisions.has(key)) fail("Develop defaults manifest contains duplicate revisions.");
    revisions.add(key);
  }
  const manifest = { version: MANIFEST_VERSION, rules } satisfies DevelopDefaultsManifest;
  manifestBytes(manifest);
  return manifest;
}

function newest(rules: readonly DevelopDefaultRule[]): Map<DevelopDefaultRuleId, DevelopDefaultRule> {
  const latest = new Map<DevelopDefaultRuleId, DevelopDefaultRule>();
  for (const rule of rules) {
    const current = latest.get(rule.ruleId);
    if (!current || rule.revision > current.revision) latest.set(rule.ruleId, rule);
  }
  return latest;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertNoSymlinkComponents(targetPath: string): Promise<void> {
  const normalized = path.resolve(targetPath);
  const root = path.parse(normalized).root;
  let current = root;
  for (const component of normalized.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error("Develop defaults store refuses symlink traversal.");
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const backup = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.backup`);
  let handle: FileHandle | undefined;
  let backupCreated = false;
  let published = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(filePath, backup);
      backupCreated = true;
      await syncDirectory(directory);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await fs.rename(temporary, filePath);
    published = true;
    await syncDirectory(directory);
    published = false;
    if (backupCreated) {
      await fs.unlink(backup);
      backupCreated = false;
      await syncDirectory(directory);
    }
  } catch (error) {
    if (published && backupCreated) {
      await fs.rename(backup, filePath);
      backupCreated = false;
      await syncDirectory(directory);
    } else if (published) {
      await fs.unlink(filePath).catch((unlinkError: unknown) => {
        if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
      });
      await syncDirectory(directory);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    await fs.unlink(backup).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

export class DevelopDefaultsStore {
  readonly #root: string;
  readonly #manifestPath: string;
  #rootIdentity: FileIdentity | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string) {
    if (!path.isAbsolute(rootDirectory)) throw new Error("Develop defaults store path must be absolute.");
    this.#root = path.resolve(rootDirectory);
    this.#manifestPath = path.join(this.#root, "manifest.json");
  }

  initialize(): Promise<void> {
    return this.#serialize(async () => {
      await this.#ensureRoot();
      const manifest = await this.#readManifest();
      if (manifest === null) await this.#writeManifest({ version: MANIFEST_VERSION, rules: [] });
    });
  }

  list(): Promise<readonly DevelopDefaultRule[]> {
    return this.#serialize(async () => {
      const manifest = await this.#requiredManifest();
      return [...newest(manifest.rules).values()]
        .sort((left, right) => left.ruleId.localeCompare(right.ruleId))
        .map(cloneDevelopDefaultRule);
    });
  }

  create(value: unknown): Promise<DevelopDefaultRule> {
    return this.#mutate((manifest) => {
      const rule = parseDevelopDefaultRule(value);
      if (rule.revision !== 1) throw new Error("New Develop default rules must start at revision 1.");
      if (newest(manifest.rules).has(rule.ruleId)) throw new Error("Develop default rule ID already exists.");
      return {
        manifest: { ...manifest, rules: [...manifest.rules, rule] },
        result: cloneDevelopDefaultRule(rule),
      };
    });
  }

  update(value: unknown): Promise<DevelopDefaultRule> {
    return this.#mutate((manifest) => {
      const rule = parseDevelopDefaultRule(value);
      const current = newest(manifest.rules).get(rule.ruleId);
      if (!current || rule.revision !== current.revision + 1) throw new Error("Develop default rule revision is stale.");
      if (rule.createdAt !== current.createdAt) throw new Error("Develop default rule creation timestamp is immutable.");
      if (rule.updatedAt < current.updatedAt) throw new Error("Develop default rule updated timestamp is stale.");
      return {
        manifest: { ...manifest, rules: [...manifest.rules, rule] },
        result: cloneDevelopDefaultRule(rule),
      };
    });
  }

  setEnabled(ruleIdValue: unknown, enabledValue: unknown, updatedAtValue: unknown): Promise<DevelopDefaultRule> {
    const ruleId = parseDevelopDefaultRuleId(ruleIdValue);
    if (typeof enabledValue !== "boolean") return Promise.reject(new Error("Develop default enabled state is invalid."));
    return this.#mutate((manifest) => {
      const current = newest(manifest.rules).get(ruleId);
      if (!current) throw new Error("Develop default rule is missing.");
      if (current.enabled === enabledValue) return { manifest, result: cloneDevelopDefaultRule(current) };
      const rule = parseDevelopDefaultRule({
        ...current,
        revision: current.revision + 1,
        enabled: enabledValue,
        updatedAt: updatedAtValue,
      });
      if (rule.updatedAt < current.updatedAt) throw new Error("Develop default rule updated timestamp is stale.");
      return {
        manifest: { ...manifest, rules: [...manifest.rules, rule] },
        result: cloneDevelopDefaultRule(rule),
      };
    });
  }

  delete(ruleIdValue: unknown): Promise<void> {
    const ruleId = parseDevelopDefaultRuleId(ruleIdValue);
    return this.#mutate((manifest) => {
      const rules = manifest.rules.filter((rule) => rule.ruleId !== ruleId);
      if (rules.length === manifest.rules.length) throw new Error("Develop default rule is missing.");
      return { manifest: { ...manifest, rules }, result: undefined };
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #mutate<T>(
    operation: (manifest: DevelopDefaultsManifest) => {
      readonly manifest: DevelopDefaultsManifest;
      readonly result: T;
    },
  ): Promise<T> {
    return this.#serialize(async () => {
      const current = await this.#requiredManifest();
      const next = operation(current);
      if (next.manifest !== current) await this.#writeManifest(next.manifest);
      return next.result;
    });
  }

  async #ensureRoot(): Promise<void> {
    await assertNoSymlinkComponents(this.#root);
    try {
      const existing = await fs.lstat(this.#root);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Develop defaults store root is not a supported directory.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
      const created = await fs.lstat(this.#root);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("Develop defaults store root is not a supported directory.");
    }
    await assertNoSymlinkComponents(this.#root);
    const current = await fs.lstat(this.#root);
    if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("Develop defaults store root is not a supported directory.");
    const identity = { dev: current.dev, ino: current.ino };
    if (this.#rootIdentity !== null && !sameIdentity(this.#rootIdentity, identity)) {
      throw new Error("Develop defaults store root identity changed.");
    }
    this.#rootIdentity ??= identity;
  }

  async #requiredManifest(): Promise<DevelopDefaultsManifest> {
    await this.#ensureRoot();
    const manifest = await this.#readManifest();
    if (!manifest) throw new Error("Develop defaults store is not initialized.");
    return manifest;
  }

  async #readManifest(): Promise<DevelopDefaultsManifest | null> {
    await this.#ensureRoot();
    let handle: FileHandle | undefined;
    try {
      const info = await fs.lstat(this.#manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > DEVELOP_DEFAULT_RULE_MAX_AGGREGATE_BYTES) {
        throw new Error("Develop defaults manifest is not a supported regular file.");
      }
      try {
        handle = await fs.open(this.#manifestPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (errorCode(error) === "ELOOP") throw new Error("Develop defaults manifest cannot be a symbolic link.");
        throw error;
      }
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(info, opened) || opened.size > DEVELOP_DEFAULT_RULE_MAX_AGGREGATE_BYTES) {
        throw new Error("Develop defaults manifest changed while opening.");
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > DEVELOP_DEFAULT_RULE_MAX_AGGREGATE_BYTES) throw new Error("Develop defaults manifest exceeds the aggregate byte limit.");
      const after = await handle.stat();
      const pathAfter = await fs.lstat(this.#manifestPath);
      if (
        !sameIdentity(opened, after) ||
        !sameIdentity(after, pathAfter) ||
        opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs
      ) {
        throw new Error("Develop defaults manifest changed while it was read.");
      }
      await this.#ensureRoot();
      return parseManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async #writeManifest(manifest: DevelopDefaultsManifest): Promise<void> {
    if (manifest.rules.length > DEVELOP_DEFAULT_RULE_MAX_RECORDS) throw new Error("Develop defaults store exceeds the rule limit.");
    manifestBytes(manifest);
    await this.#ensureRoot();
    try {
      const target = await fs.lstat(this.#manifestPath);
      if (!target.isFile() || target.isSymbolicLink()) throw new Error("Develop defaults manifest is not a supported regular file.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await atomicWrite(this.#manifestPath, JSON.stringify(manifest));
    await this.#ensureRoot();
  }
}
