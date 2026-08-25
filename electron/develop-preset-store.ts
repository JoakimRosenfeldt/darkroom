import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  DEVELOP_PRESET_MAX_AGGREGATE_BYTES,
  DEVELOP_PRESET_MAX_BYTES,
  DEVELOP_PRESET_MAX_RECORDS,
  cloneDevelopPreset,
  createDevelopPresetId,
  parseDevelopPresetId,
  parseDevelopPresetRecord,
  parseDevelopPresetSha256,
  type DevelopPresetId,
  type DevelopPresetRecord,
} from "../lib/develop/presets/schema.ts";
import type { DevelopPresetImportResult } from "../lib/develop/presets/api.ts";

const MANIFEST_VERSION = 1;
const MAX_PENDING_IMPORTS = 100;
const PENDING_IMPORT_TTL_MS = 15 * 60 * 1_000;

interface StoredPresetRevision {
  readonly preset: DevelopPresetRecord;
  readonly importedSourceSha256: string | null;
  readonly importedFileName: string | null;
}

interface PresetManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly records: readonly StoredPresetRevision[];
  readonly builtInFavorites: readonly DevelopPresetId[];
  readonly deletedPresetIds: readonly DevelopPresetId[];
}

interface PendingImport {
  readonly preset: DevelopPresetRecord;
  readonly sha256: string;
  readonly fileName: string;
  readonly createdAt: number;
}

export interface DevelopPresetSearch {
  readonly query: string;
  readonly category: string | null;
  readonly favoriteOnly: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
  const input = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail(`${label} has unknown fields.`);
  return input;
}

function optionalHash(value: unknown): string | null {
  return value === null ? null : parseDevelopPresetSha256(value);
}

function optionalFileName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || path.basename(value) !== value || value.includes("\0")) {
    return fail("Imported preset file name is invalid.");
  }
  return value;
}

function parseStored(value: unknown): StoredPresetRevision {
  const input = record(value, "Stored Develop preset", ["preset", "importedSourceSha256", "importedFileName"]);
  const preset = parseDevelopPresetRecord(input.preset);
  const importedSourceSha256 = optionalHash(input.importedSourceSha256);
  const importedFileName = optionalFileName(input.importedFileName);
  if ((importedSourceSha256 === null) !== (importedFileName === null)) fail("Stored imported preset metadata is incomplete.");
  if (preset.source === "imported" && importedSourceSha256 === null) fail("Imported preset source metadata is missing.");
  if (preset.source !== "imported" && importedSourceSha256 !== null) fail("Only imported presets can name a source copy.");
  return { preset, importedSourceSha256, importedFileName };
}

function parseManifest(value: unknown): PresetManifest {
  const input = record(value, "Develop preset manifest", ["version", "records", "builtInFavorites", "deletedPresetIds"]);
  if (input.version !== MANIFEST_VERSION || !Array.isArray(input.records) || input.records.length > DEVELOP_PRESET_MAX_RECORDS) {
    return fail("Develop preset manifest is invalid.");
  }
  const records = input.records.map(parseStored);
  if (!Array.isArray(input.builtInFavorites)) fail("Develop preset built-in favorites are invalid.");
  const builtInFavorites = input.builtInFavorites.map(parseDevelopPresetId);
  if (new Set(builtInFavorites).size !== builtInFavorites.length) fail("Develop preset built-in favorites contain duplicates.");
  const keys = new Set<string>();
  for (const item of records) {
    const key = `${item.preset.presetId}:${item.preset.revision}`;
    if (keys.has(key)) fail("Develop preset manifest contains duplicate revisions.");
    keys.add(key);
  }
  const deletedValue = input.deletedPresetIds ?? [];
  if (!Array.isArray(deletedValue)) fail("Develop preset tombstones are invalid.");
  const deletedPresetIds = deletedValue.map(parseDevelopPresetId);
  if (new Set(deletedPresetIds).size !== deletedPresetIds.length) fail("Develop preset tombstones contain duplicates.");
  return { version: MANIFEST_VERSION, records, builtInFavorites, deletedPresetIds };
}

function manifestBytes(value: PresetManifest): number {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > DEVELOP_PRESET_MAX_AGGREGATE_BYTES) fail("Develop preset store exceeds the aggregate byte limit.");
  return bytes;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

function unsupportedNoFollow(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

async function readBoundedFileHandle(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let position = 0;
  while (position <= maximumBytes) {
    const remaining = maximumBytes + 1 - position;
    const chunk = new Uint8Array(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position > maximumBytes) {
    throw new Error("Develop preset import exceeds the byte limit.");
  }
  const bytes = new Uint8Array(position);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

function newest(records: readonly StoredPresetRevision[]): Map<DevelopPresetId, StoredPresetRevision> {
  const latest = new Map<DevelopPresetId, StoredPresetRevision>();
  for (const item of records) {
    const current = latest.get(item.preset.presetId);
    if (!current || item.preset.revision > current.preset.revision) latest.set(item.preset.presetId, item);
  }
  return latest;
}

function normalizedImported(preset: DevelopPresetRecord, presetId = preset.presetId, revision = preset.revision): DevelopPresetRecord {
  return parseDevelopPresetRecord({ ...preset, presetId, revision, source: "imported" });
}

function searchInput(value: unknown): DevelopPresetSearch {
  const input = record(value, "Develop preset search", ["query", "category", "favoriteOnly"]);
  if (typeof input.query !== "string" || input.query.length > 256) fail("Develop preset search query is invalid.");
  if (input.category !== null && (typeof input.category !== "string" || input.category.length === 0 || input.category.length > 256)) fail("Develop preset search category is invalid.");
  if (typeof input.favoriteOnly !== "boolean") fail("Develop preset favorite filter is invalid.");
  return { query: input.query.trim(), category: input.category, favoriteOnly: input.favoriteOnly };
}

export class DevelopPresetStore {
  readonly #root: string;
  readonly #manifestPath: string;
  readonly #importsDirectory: string;
  readonly #builtIns: readonly DevelopPresetRecord[];
  readonly #pendingImports = new Map<string, PendingImport>();
  #queue: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string, builtIns: readonly unknown[] = []) {
    if (!path.isAbsolute(rootDirectory)) throw new Error("Develop preset store path must be absolute.");
    this.#root = path.resolve(rootDirectory);
    this.#manifestPath = path.join(this.#root, "manifest.json");
    this.#importsDirectory = path.join(this.#root, "imports");
    this.#builtIns = builtIns.map((value) => {
      const preset = parseDevelopPresetRecord(value);
      if (preset.source !== "built-in") throw new Error("Built-in preset definitions must use the built-in source.");
      return preset;
    });
    if (this.#builtIns.length > DEVELOP_PRESET_MAX_RECORDS) throw new Error("Built-in presets exceed the record limit.");
    const keys = new Set(this.#builtIns.map((preset) => `${preset.presetId}:${preset.revision}`));
    if (keys.size !== this.#builtIns.length) throw new Error("Built-in preset definitions contain duplicate revisions.");
  }

  initialize(): Promise<void> {
    return this.#serialize(async () => {
      await fs.mkdir(this.#importsDirectory, { recursive: true, mode: 0o700 });
      const manifest = await this.#readManifest();
      if (manifest === null) await this.#writeManifest({ version: MANIFEST_VERSION, records: [], builtInFavorites: [], deletedPresetIds: [] });
      else await this.#verifyImportCopies(manifest);
    });
  }

  list(searchValue: unknown = { query: "", category: null, favoriteOnly: false }): Promise<readonly DevelopPresetRecord[]> {
    return this.#serialize(async () => {
      const search = searchInput(searchValue);
      const manifest = await this.#requiredManifest();
      const all = newest([
        ...this.#builtIns.map((preset) => ({
          preset: manifest.builtInFavorites.includes(preset.presetId) ? { ...preset, favorite: true } : preset,
          importedSourceSha256: null,
          importedFileName: null,
        })),
        ...manifest.records,
      ]);
      const query = search.query.toLocaleLowerCase();
      return [...all.values()].map((item) => cloneDevelopPreset(item.preset)).filter((preset) => {
        if (manifest.deletedPresetIds.includes(preset.presetId)) return false;
        if (search.category !== null && preset.category !== search.category) return false;
        if (search.favoriteOnly && !preset.favorite) return false;
        return query.length === 0 || `${preset.name}\n${preset.author}\n${preset.category}`.toLocaleLowerCase().includes(query);
      }).sort((left, right) => left.name.localeCompare(right.name) || left.presetId.localeCompare(right.presetId));
    });
  }

  getRevision(presetIdValue: unknown, revisionValue: unknown): Promise<DevelopPresetRecord | null> {
    const presetId = parseDevelopPresetId(presetIdValue);
    if (typeof revisionValue !== "number" || !Number.isSafeInteger(revisionValue) || revisionValue < 1) {
      return Promise.reject(new Error("Develop preset revision is invalid."));
    }
    return this.#serialize(async () => {
      const manifest = await this.#requiredManifest();
      const stored = manifest.records.find((item) => item.preset.presetId === presetId && item.preset.revision === revisionValue)?.preset;
      const builtIn = this.#builtIns.find((item) => item.presetId === presetId && item.revision === revisionValue);
      const preset = stored ?? builtIn;
      return preset ? cloneDevelopPreset(preset) : null;
    });
  }

  create(value: unknown): Promise<DevelopPresetRecord> {
    return this.#mutate(async (manifest) => {
      const preset = parseDevelopPresetRecord(value);
      if (preset.source !== "user" || preset.revision !== 1) throw new Error("New user presets must start at revision 1.");
      if (this.#latest(manifest, preset.presetId) || this.#latestBuiltIn(preset.presetId)) throw new Error("Develop preset ID already exists.");
      return { manifest: { ...manifest, records: [...manifest.records, { preset, importedSourceSha256: null, importedFileName: null }] }, result: cloneDevelopPreset(preset) };
    });
  }

  update(value: unknown): Promise<DevelopPresetRecord> {
    return this.#mutate(async (manifest) => {
      const preset = parseDevelopPresetRecord(value);
      if (preset.source === "built-in") throw new Error("Built-in presets are immutable.");
      const current = this.#latest(manifest, preset.presetId);
      if (manifest.deletedPresetIds.includes(preset.presetId)) throw new Error("Deleted Develop presets are immutable.");
      if (!current || preset.revision !== current.preset.revision + 1) throw new Error("Develop preset revision is stale.");
      if (preset.source !== current.preset.source) throw new Error("Develop preset source provenance is immutable.");
      const importedSourceSha256 = preset.source === "imported" ? current.importedSourceSha256 : null;
      const importedFileName = preset.source === "imported" ? current.importedFileName : null;
      if (preset.source === "imported" && (!importedSourceSha256 || !importedFileName)) throw new Error("Imported preset source metadata is missing.");
      const item = { preset, importedSourceSha256, importedFileName };
      return { manifest: { ...manifest, records: [...manifest.records, item] }, result: cloneDevelopPreset(preset) };
    });
  }

  setFavorite(presetIdValue: unknown, favoriteValue: unknown): Promise<DevelopPresetRecord> {
    const presetId = parseDevelopPresetId(presetIdValue);
    if (typeof favoriteValue !== "boolean") return Promise.reject(new Error("Develop preset favorite is invalid."));
    return this.#mutate(async (manifest) => {
      if (manifest.deletedPresetIds.includes(presetId)) throw new Error("Develop preset is deleted.");
      const current = this.#latest(manifest, presetId);
      if (!current) {
        const builtIn = this.#latestBuiltIn(presetId);
        if (!builtIn) throw new Error("Develop preset is missing.");
        const favorites = new Set(manifest.builtInFavorites);
        if (favoriteValue) favorites.add(presetId); else favorites.delete(presetId);
        return {
          manifest: { ...manifest, builtInFavorites: [...favorites].sort() },
          result: cloneDevelopPreset({ ...builtIn.preset, favorite: favoriteValue }),
        };
      }
      if (current.preset.favorite === favoriteValue) return { manifest, result: cloneDevelopPreset(current.preset) };
      const preset = parseDevelopPresetRecord({ ...current.preset, revision: current.preset.revision + 1, favorite: favoriteValue });
      return { manifest: { ...manifest, records: [...manifest.records, { ...current, preset }] }, result: cloneDevelopPreset(preset) };
    });
  }

  delete(presetIdValue: unknown): Promise<void> {
    const presetId = parseDevelopPresetId(presetIdValue);
    return this.#mutate(async (manifest) => {
      if (!this.#latest(manifest, presetId) || manifest.deletedPresetIds.includes(presetId)) {
        throw new Error("Develop preset is missing or immutable.");
      }
      return {
        manifest: { ...manifest, deletedPresetIds: [...manifest.deletedPresetIds, presetId].sort() },
        result: undefined,
      };
    });
  }

  importFile(filePath: string): Promise<DevelopPresetImportResult> {
    return this.#serialize(async () => {
      const manifest = await this.#requiredManifest();
      await this.#prunePendingImports(manifest);
      if (this.#pendingImports.size >= MAX_PENDING_IMPORTS) {
        throw new Error("Too many unresolved Develop preset imports.");
      }
      const { bytes, sha256, fileName } = await this.#readImport(filePath);
      const parsed = parseDevelopPresetRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      const incoming = normalizedImported(parsed);
      const createdCopy = await this.#storeImportCopy(sha256, bytes);
      try {
        await this.#assertAggregateLimit(manifest);
      } catch (error) {
        if (createdCopy) await fs.unlink(path.join(this.#importsDirectory, `${sha256}.json`)).catch(() => undefined);
        throw error;
      }
      const duplicate = manifest.records.find((item) => item.importedSourceSha256 === sha256);
      if (duplicate) {
        if (manifest.deletedPresetIds.includes(duplicate.preset.presetId)) {
          await this.#writeManifest({
            ...manifest,
            deletedPresetIds: manifest.deletedPresetIds.filter(
              (presetId) => presetId !== duplicate.preset.presetId,
            ),
          });
        }
        return { kind: "exact-duplicate", preset: cloneDevelopPreset(duplicate.preset) };
      }
      const existing = this.#latest(manifest, incoming.presetId) ?? this.#latestBuiltIn(incoming.presetId);
      if (existing) {
        const token = randomUUID();
        this.#pendingImports.set(token, { preset: incoming, sha256, fileName, createdAt: Date.now() });
        const decisions = this.#latestBuiltIn(incoming.presetId) && !this.#latest(manifest, incoming.presetId)
          ? ["import-copy"] as const
          : ["replace", "import-copy"] as const;
        return { kind: "conflict", token, existing: cloneDevelopPreset(existing.preset), incoming: cloneDevelopPreset(incoming), decisions };
      }
      const item = { preset: incoming, importedSourceSha256: sha256, importedFileName: fileName };
      await this.#writeManifest({ ...manifest, records: [...manifest.records, item] });
      return { kind: "imported", preset: cloneDevelopPreset(incoming) };
    });
  }

  resolveImport(token: string, decision: "replace" | "import-copy"): Promise<DevelopPresetRecord> {
    return this.#serialize(async () => {
      const manifest = await this.#requiredManifest();
      await this.#prunePendingImports(manifest);
      const pending = this.#pendingImports.get(token);
      if (!pending) throw new Error("Develop preset import conflict is unavailable.");
      if (decision !== "replace" && decision !== "import-copy") throw new Error("Develop preset import decision is invalid.");
      const current = this.#latest(manifest, pending.preset.presetId) ?? this.#latestBuiltIn(pending.preset.presetId);
      if (
        decision === "replace" &&
        !this.#latest(manifest, pending.preset.presetId) &&
        this.#latestBuiltIn(pending.preset.presetId)
      ) {
        throw new Error("Built-in presets are immutable. Import this preset as a copy.");
      }
      const preset = decision === "import-copy"
        ? normalizedImported(pending.preset, createDevelopPresetId(), 1)
        : normalizedImported(pending.preset, pending.preset.presetId, (current?.preset.revision ?? 0) + 1);
      const item = { preset, importedSourceSha256: pending.sha256, importedFileName: pending.fileName };
      await this.#writeManifest({
        ...manifest,
        records: [...manifest.records, item],
        deletedPresetIds: manifest.deletedPresetIds.filter((presetId) => presetId !== preset.presetId),
      });
      this.#pendingImports.delete(token);
      return cloneDevelopPreset(preset);
    });
  }

  cancelImport(token: string): Promise<void> {
    return this.#serialize(async () => {
      const manifest = await this.#requiredManifest();
      await this.#prunePendingImports(manifest);
      const pending = this.#pendingImports.get(token);
      if (!pending) throw new Error("Develop preset import conflict is unavailable.");
      this.#pendingImports.delete(token);
      if (
        !manifest.records.some((item) => item.importedSourceSha256 === pending.sha256) &&
        ![...this.#pendingImports.values()].some((item) => item.sha256 === pending.sha256)
      ) {
        await fs.unlink(path.join(this.#importsDirectory, `${pending.sha256}.json`)).catch(
          (error: unknown) => {
            if (errorCode(error) !== "ENOENT") throw error;
          },
        );
      }
    });
  }

  #latest(manifest: PresetManifest, presetId: DevelopPresetId): StoredPresetRevision | undefined {
    return newest(manifest.records).get(presetId);
  }

  #latestBuiltIn(presetId: DevelopPresetId): StoredPresetRevision | undefined {
    const preset = this.#builtIns.filter((item) => item.presetId === presetId).sort((left, right) => right.revision - left.revision)[0];
    return preset ? { preset, importedSourceSha256: null, importedFileName: null } : undefined;
  }

  async #readImport(filePath: string): Promise<{ readonly bytes: Uint8Array; readonly sha256: string; readonly fileName: string }> {
    if (!path.isAbsolute(filePath)) throw new Error("Develop preset import path must be absolute.");
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (error) {
        if (errorCode(error) === "ELOOP") {
          throw new Error("Develop preset import cannot be a symbolic link.");
        }
        if (!unsupportedNoFollow(error)) throw error;
        const pathBeforeOpen = await fs.lstat(filePath);
        if (!pathBeforeOpen.isFile() || pathBeforeOpen.isSymbolicLink()) {
          throw new Error("Develop preset import is not a supported regular file.");
        }
        handle = await fs.open(filePath, fsConstants.O_RDONLY);
      }
      const before = await handle.stat();
      const pathBefore = await fs.lstat(filePath);
      if (
        !before.isFile() ||
        !pathBefore.isFile() ||
        pathBefore.isSymbolicLink() ||
        before.dev !== pathBefore.dev ||
        before.ino !== pathBefore.ino ||
        before.size > DEVELOP_PRESET_MAX_BYTES
      ) {
        throw new Error("Develop preset import is not a supported regular file.");
      }
      const bytes = await readBoundedFileHandle(handle, DEVELOP_PRESET_MAX_BYTES);
      const after = await handle.stat();
      const pathAfter = await fs.lstat(filePath);
      if (
        !sameFileIdentity(before, after) ||
        !sameFileIdentity(before, pathAfter) ||
        !pathAfter.isFile() ||
        pathAfter.isSymbolicLink()
      ) {
        throw new Error("Develop preset import changed while it was being read.");
      }
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), fileName: path.basename(filePath) };
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw new Error("Develop preset import cannot be a symbolic link.");
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async #storeImportCopy(sha256Value: string, bytes: Uint8Array): Promise<boolean> {
    const sha256 = parseDevelopPresetSha256(sha256Value);
    const destination = path.join(this.#importsDirectory, `${sha256}.json`);
    if (path.dirname(destination) !== this.#importsDirectory) throw new Error("Develop preset import destination escaped its store.");
    try {
      const existing = await fs.readFile(destination);
      if (createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("Stored Develop preset source copy is corrupt.");
      return false;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    let handle: FileHandle | undefined;
    let raced = false;
    try {
      handle = await fs.open(destination, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      raced = true;
    } finally {
      await handle?.close();
    }
    if (raced) {
      const existing = await fs.readFile(destination);
      if (createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("Stored Develop preset source copy is corrupt.");
    }
    await syncDirectory(this.#importsDirectory);
    return !raced;
  }

  async #verifyImportCopies(manifest: PresetManifest): Promise<void> {
    const hashes = new Set(manifest.records.flatMap((item) => item.importedSourceSha256 ? [item.importedSourceSha256] : []));
    for (const hash of hashes) {
      const filePath = path.join(this.#importsDirectory, `${hash}.json`);
      if (path.dirname(filePath) !== this.#importsDirectory) throw new Error("Develop preset import path escaped its store.");
      const info = await fs.lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > DEVELOP_PRESET_MAX_BYTES) throw new Error("Stored Develop preset source copy is invalid.");
      const bytes = await fs.readFile(filePath);
      if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Stored Develop preset source copy is corrupt.");
    }
    const entries = await fs.readdir(this.#importsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const hash = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (entry.isFile() && /^[0-9a-f]{64}$/.test(hash) && !hashes.has(hash)) {
        await fs.unlink(path.join(this.#importsDirectory, entry.name));
      }
    }
    await this.#assertAggregateLimit(manifest);
  }

  async #prunePendingImports(manifest: PresetManifest): Promise<void> {
    const cutoff = Date.now() - PENDING_IMPORT_TTL_MS;
    const expired = [...this.#pendingImports.entries()].filter(([, item]) => item.createdAt < cutoff);
    for (const [token, item] of expired) {
      this.#pendingImports.delete(token);
      if (
        !manifest.records.some((record) => record.importedSourceSha256 === item.sha256) &&
        ![...this.#pendingImports.values()].some((pending) => pending.sha256 === item.sha256)
      ) {
        await fs.unlink(path.join(this.#importsDirectory, `${item.sha256}.json`)).catch(
          (error: unknown) => {
            if (errorCode(error) !== "ENOENT") throw error;
          },
        );
      }
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #mutate<T>(operation: (manifest: PresetManifest) => Promise<{ readonly manifest: PresetManifest; readonly result: T }>): Promise<T> {
    return this.#serialize(async () => {
      const current = await this.#requiredManifest();
      const next = await operation(current);
      if (next.manifest !== current) await this.#writeManifest(next.manifest);
      return next.result;
    });
  }

  async #requiredManifest(): Promise<PresetManifest> {
    const manifest = await this.#readManifest();
    if (!manifest) throw new Error("Develop preset store is not initialized.");
    if (manifest.builtInFavorites.some((presetId) => !this.#builtIns.some((preset) => preset.presetId === presetId))) {
      throw new Error("Develop preset manifest references an unknown built-in favorite.");
    }
    return manifest;
  }

  async #readManifest(): Promise<PresetManifest | null> {
    try {
      const info = await fs.lstat(this.#manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > DEVELOP_PRESET_MAX_AGGREGATE_BYTES) throw new Error("Develop preset manifest is not a supported regular file.");
      const bytes = await fs.readFile(this.#manifestPath);
      if (bytes.byteLength > DEVELOP_PRESET_MAX_AGGREGATE_BYTES) throw new Error("Develop preset manifest exceeds the aggregate byte limit.");
      return parseManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async #writeManifest(manifest: PresetManifest): Promise<void> {
    if (manifest.records.length > DEVELOP_PRESET_MAX_RECORDS) throw new Error("Develop preset store exceeds the record limit.");
    await this.#assertAggregateLimit(manifest);
    await atomicWrite(this.#manifestPath, JSON.stringify(manifest));
  }

  async #assertAggregateLimit(manifest: PresetManifest): Promise<void> {
    let bytes = manifestBytes(manifest);
    const entries = await fs.readdir(this.#importsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const hash = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("Develop preset import store contains an unexpected file.");
      const info = await fs.lstat(path.join(this.#importsDirectory, entry.name));
      if (info.isSymbolicLink() || info.size > DEVELOP_PRESET_MAX_BYTES) throw new Error("Stored Develop preset source copy is invalid.");
      bytes += info.size;
      if (bytes > DEVELOP_PRESET_MAX_AGGREGATE_BYTES) throw new Error("Develop preset store exceeds the aggregate byte limit.");
    }
  }
}
