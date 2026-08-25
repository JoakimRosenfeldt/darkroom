import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  CAMERA_PROFILE_FILE_LIMIT,
  CAMERA_PROFILE_REGISTRY_VERSION,
  cameraProfileCapabilities,
  cameraProfileFormatFromFilename,
  deterministicCameraProfileCopyId,
  parseCameraProfileConflictRequest,
  parseCameraProfileFile,
  parseCameraProfileRegistrySnapshot,
  parseCameraProfileRemoveRequest,
  type CameraProfileConflictRequest,
  type CameraProfileFormat,
  type CameraProfileImportResult,
  type CameraProfileRecord,
  type CameraProfileRegistrySnapshot,
  type ReadyCameraProfileRecord,
} from "../lib/camera-profiles/registry.ts";
import { parseMatrixCameraProfile, type MatrixCameraProfile } from "../lib/camera-profiles/matrix.ts";
import {
  hasNativeFileTransactionSupport,
  nativeAtomicWriteFile,
} from "./native-file-transaction-helper.ts";

interface PendingConflict {
  readonly record: ReadyCameraProfileRecord;
  readonly bytes: Uint8Array;
  readonly createdAt: number;
}

interface StoredRegistry {
  readonly version: typeof CAMERA_PROFILE_REGISTRY_VERSION;
  readonly generation: number;
  readonly profiles: readonly CameraProfileRecord[];
  readonly retiredProfiles: readonly CameraProfileRecord[];
  readonly replacements: Readonly<Record<string, string>>;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

const CAMERA_PROFILE_REGISTRY_LIMIT = 16 * 1024 * 1024;
const CAMERA_PROFILE_PENDING_LIMIT = 100;
const CAMERA_PROFILE_PENDING_TTL_MS = 15 * 60 * 1_000;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function stableDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity | null,
  label: string,
): Promise<DirectoryIdentity> {
  const pathBefore = await fs.lstat(directory);
  if (!pathBefore.isDirectory() || pathBefore.isSymbolicLink()) {
    throw new Error(`${label} is not a supported directory.`);
  }
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await fs.open(directory, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes(errorCode(error) ?? "")) {
        if (errorCode(error) === "ELOOP") throw new Error(`${label} cannot be a symbolic link.`);
        throw error;
      }
      handle = await fs.open(directory, fsConstants.O_RDONLY);
    }
    const opened = await handle.stat();
    const pathAfter = await fs.lstat(directory);
    const identity = { dev: opened.dev, ino: opened.ino };
    if (
      !opened.isDirectory() || !pathAfter.isDirectory() || pathAfter.isSymbolicLink() ||
      !sameIdentity(pathBefore, identity) || !sameIdentity(identity, pathAfter) ||
      (expected !== null && !sameIdentity(expected, identity))
    ) {
      throw new Error(`${label} identity changed.`);
    }
    return identity;
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(directory: string, expected: DirectoryIdentity): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameIdentity(expected, opened)) {
      throw new Error("Camera profile storage directory identity changed.");
    }
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes(errorCode(error) ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

async function boundedRegularFile(filePath: string, limit: number, label: string): Promise<Uint8Array> {
  const pathBefore = await fs.lstat(filePath);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > limit) {
    throw new Error(`${label} is not a supported regular file.`);
  }
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes(errorCode(error) ?? "")) {
        if (errorCode(error) === "ELOOP") throw new Error(`${label} cannot be a symbolic link.`);
        throw error;
      }
      handle = await fs.open(filePath, fsConstants.O_RDONLY);
    }
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) {
      throw new Error(`${label} changed before it was read.`);
    }
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) throw new Error(`${label} changed while it was read.`);
      offset += read.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, offset)).bytesRead !== 0) throw new Error(`${label} exceeds its byte limit or changed while it was read.`);
    const after = await handle.stat();
    const pathAfter = await fs.lstat(filePath);
    if (
      !pathAfter.isFile() || pathAfter.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      after.dev !== pathAfter.dev || after.ino !== pathAfter.ino
    ) {
      throw new Error(`${label} changed while it was read.`);
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

function sameProfileIdentity(left: MatrixCameraProfile, right: MatrixCameraProfile): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return left.kind === right.kind &&
    normalize(left.compatibility.make) === normalize(right.compatibility.make) &&
    normalize(left.compatibility.model) === normalize(right.compatibility.model);
}

function sourceFilename(value: string): string {
  const basename = path.basename(value).trim();
  if (!basename || basename.length > 256 || basename.includes("\0")) {
    throw new Error("Camera profile filename is invalid.");
  }
  return basename;
}

function storedFilename(hash: string, format: CameraProfileFormat): string {
  return `${hash}.${format}`;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function withDcpRevision(
  profile: MatrixCameraProfile,
  format: CameraProfileFormat,
  hash: string,
): MatrixCameraProfile {
  if (format !== "dcp") return profile;
  return parseMatrixCameraProfile({
    ...profile,
    revision: `sha256-${hash.slice(0, 24)}`,
    unsupportedTags: [],
    opcodes: [],
  });
}

function registrySnapshot(state: StoredRegistry): CameraProfileRegistrySnapshot {
  return {
    version: CAMERA_PROFILE_REGISTRY_VERSION,
    revision: `camera-profile-registry-${state.generation}`,
    profiles: [...state.profiles].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "ready" ? -1 : 1;
      const leftLabel = left.kind === "ready" ? left.profile.label : left.sourceFilename;
      const rightLabel = right.kind === "ready" ? right.profile.label : right.sourceFilename;
      return leftLabel.localeCompare(rightLabel);
    }),
    replacements: { ...state.replacements },
  };
}

function parseStoredRegistry(value: unknown): StoredRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Camera profile registry index must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== CAMERA_PROFILE_REGISTRY_VERSION) {
    throw new Error("Camera profile registry index version is unsupported.");
  }
  if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 0) {
    throw new Error("Camera profile registry generation is invalid.");
  }
  const snapshot = parseCameraProfileRegistrySnapshot({
    version: input.version,
    revision: `camera-profile-registry-${input.generation}`,
    profiles: input.profiles,
    replacements: input.replacements,
  });
  if (input.retiredProfiles !== undefined && (!Array.isArray(input.retiredProfiles) || input.retiredProfiles.length > 10_000)) {
    throw new Error("Camera profile retired registry is invalid.");
  }
  return {
    version: CAMERA_PROFILE_REGISTRY_VERSION,
    generation: Number(input.generation),
    profiles: snapshot.profiles,
    retiredProfiles: Array.isArray(input.retiredProfiles)
      ? input.retiredProfiles.map((item) => parseCameraProfileRegistrySnapshot({
          version: CAMERA_PROFILE_REGISTRY_VERSION,
          revision: "retired-profile",
          profiles: [item],
          replacements: {},
        }).profiles[0]!)
      : [],
    replacements: snapshot.replacements,
  };
}

export class CameraProfileService {
  private readonly userDataPath: string;
  private readonly directory: string;
  private readonly indexPath: string;
  private userDataIdentity: DirectoryIdentity | null = null;
  private directoryIdentity: DirectoryIdentity | null = null;
  private state: StoredRegistry = {
    version: CAMERA_PROFILE_REGISTRY_VERSION,
    generation: 0,
    profiles: [],
    retiredProfiles: [],
    replacements: {},
  };
  private readonly pending = new Map<string, PendingConflict>();
  private mutations: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    if (!path.isAbsolute(userDataPath)) throw new Error("Camera profile storage needs an absolute path.");
    this.userDataPath = path.resolve(userDataPath);
    this.directory = path.join(this.userDataPath, "camera-profiles");
    this.indexPath = path.join(this.directory, "registry.json");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  initialize(): Promise<CameraProfileRegistrySnapshot> {
    return this.serialize(() => this.initializeInternal());
  }

  private async initializeInternal(): Promise<CameraProfileRegistrySnapshot> {
    await this.ensureStorageRoot(true);
    try {
      const contents = await boundedRegularFile(this.indexPath, CAMERA_PROFILE_REGISTRY_LIMIT, "Camera profile registry");
      this.state = parseStoredRegistry(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return this.rescanInternal();
  }

  list(): CameraProfileRegistrySnapshot {
    return registrySnapshot(this.state);
  }

  importFile(filePath: string): Promise<CameraProfileImportResult> {
    return this.serialize(() => this.importFileInternal(filePath));
  }

  private async importFileInternal(filePath: string): Promise<CameraProfileImportResult> {
    await this.ensureStorageRoot(false);
    const filename = sourceFilename(filePath);
    const profileFormat = cameraProfileFormatFromFilename(filename);
    const bytes = await boundedRegularFile(filePath, CAMERA_PROFILE_FILE_LIMIT, "Camera profile import");
    const hash = digest(bytes);
    const duplicate = this.state.profiles.find(
      (record): record is ReadyCameraProfileRecord => record.kind === "ready" && record.hash === hash,
    );
    if (duplicate) return { kind: "duplicate", record: duplicate };
    const profile = withDcpRevision(
      parseCameraProfileFile({ bytes, format: profileFormat }),
      profileFormat,
      hash,
    );
    const incoming: ReadyCameraProfileRecord = {
      kind: "ready",
      hash,
      sourceFilename: filename,
      storedFilename: storedFilename(hash, profileFormat),
      format: profileFormat,
      profile,
      capabilities: cameraProfileCapabilities(),
      unsupportedOperations: [],
    };
    const existing = this.state.profiles.find(
      (record): record is ReadyCameraProfileRecord =>
        record.kind === "ready" && record.profile.id === profile.id,
    );
    if (existing) {
      this.prunePending();
      if (this.pending.size >= CAMERA_PROFILE_PENDING_LIMIT) throw new Error("Too many pending camera profile conflicts.");
      const token = randomUUID();
      this.pending.set(token, { record: incoming, bytes, createdAt: Date.now() });
      return { kind: "conflict", token, existing, incoming };
    }
    await this.install(incoming, bytes);
    return { kind: "imported", record: incoming };
  }

  resolveConflict(value: unknown): Promise<CameraProfileImportResult> {
    return this.serialize(() => this.resolveConflictInternal(value));
  }

  private async resolveConflictInternal(value: unknown): Promise<CameraProfileImportResult> {
    const request: CameraProfileConflictRequest = parseCameraProfileConflictRequest(value);
    this.prunePending();
    const pending = this.pending.get(request.token);
    if (!pending) throw new Error("Camera profile import conflict expired.");
    if (request.action === "cancel") {
      this.pending.delete(request.token);
      return { kind: "cancelled" };
    }
    const existing = this.state.profiles.find(
      (record): record is ReadyCameraProfileRecord =>
        record.kind === "ready" && record.profile.id === pending.record.profile.id,
    );
    if (!existing) throw new Error("The conflicting camera profile changed. Import it again.");
    if (request.action === "replace") {
      if (!sameProfileIdentity(existing.profile, pending.record.profile)) {
        throw new Error("Replace requires the same normalized camera make, model, and profile kind. Import a copy instead.");
      }
      await this.install(pending.record, pending.bytes, existing.profile.id);
      this.pending.delete(request.token);
      return { kind: "imported", record: pending.record };
    }
    const copyId = deterministicCameraProfileCopyId(
      pending.record.profile.id,
      pending.record.hash,
    );
    const copyProfile = parseMatrixCameraProfile({
      ...pending.record.profile,
      id: copyId,
      label: `${pending.record.profile.label} copy`,
      unsupportedTags: [],
      opcodes: [],
    });
    const copy = { ...pending.record, profile: copyProfile } satisfies ReadyCameraProfileRecord;
    await this.install(copy, pending.bytes);
    this.pending.delete(request.token);
    return { kind: "imported", record: copy };
  }

  remove(value: unknown): Promise<CameraProfileRegistrySnapshot> {
    return this.serialize(() => this.removeInternal(value));
  }

  private async removeInternal(value: unknown): Promise<CameraProfileRegistrySnapshot> {
    const request = parseCameraProfileRemoveRequest(value);
    const removed = this.state.profiles.find(
      (record): record is ReadyCameraProfileRecord =>
        record.kind === "ready" && record.profile.id === request.profileId,
    );
    if (!removed) throw new Error("Camera profile is not installed.");
    const replacement = this.state.profiles.find(
      (record): record is ReadyCameraProfileRecord =>
        record.kind === "ready" && record.profile.id === request.replacementProfileId,
    );
    if (!replacement) throw new Error("Replacement camera profile is not installed.");
    if (
      removed.profile.compatibility.make.trim().toLocaleLowerCase() !==
        replacement.profile.compatibility.make.trim().toLocaleLowerCase() ||
      removed.profile.compatibility.model.trim().toLocaleLowerCase() !==
        replacement.profile.compatibility.model.trim().toLocaleLowerCase()
    ) {
      throw new Error("Replacement camera profile must match the same camera.");
    }
    const nextState: StoredRegistry = {
      ...this.state,
      generation: this.state.generation + 1,
      profiles: this.state.profiles.filter((record) => record !== removed),
      retiredProfiles: [...this.state.retiredProfiles, removed],
      replacements: Object.fromEntries([
        ...Object.entries(this.state.replacements).map(([profileId, replacementId]) => [
          profileId,
          replacementId === removed.profile.id ? replacement.profile.id : replacementId,
        ]),
        [removed.profile.id, replacement.profile.id],
      ]),
    };
    await this.persist(nextState);
    this.state = nextState;
    return this.list();
  }

  rescan(): Promise<CameraProfileRegistrySnapshot> {
    return this.serialize(() => this.rescanInternal());
  }

  private async rescanInternal(): Promise<CameraProfileRegistrySnapshot> {
    await this.ensureStorageRoot(false);
    const existingByHash = new Map<string, CameraProfileRecord[]>();
    for (const record of this.state.profiles) {
      const records = existingByHash.get(record.hash) ?? [];
      records.push(record);
      existingByHash.set(record.hash, records);
    }
    const records: CameraProfileRecord[] = [];
    const activeHashes = new Set(this.state.profiles.map((record) => record.hash));
    const retiredHashes = new Set(this.state.retiredProfiles
      .filter((record) => !activeHashes.has(record.hash))
      .map((record) => record.hash));
    const names = (await fs.readdir(this.directory)).sort();
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.(dcp|xmp)$/.exec(name);
      if (!match) continue;
      const hash = match[1]!;
      if (retiredHashes.has(hash)) continue;
      const profileFormat: CameraProfileFormat = match[2] === "dcp" ? "dcp" : "xmp";
      const absolutePath = path.join(this.directory, name);
      const previous = existingByHash.get(hash) ?? [];
      try {
        const bytes = await boundedRegularFile(absolutePath, CAMERA_PROFILE_FILE_LIMIT, "Stored camera profile");
        if (digest(bytes) !== hash) throw new Error("Stored profile content does not match its SHA-256 filename.");
        const profile = withDcpRevision(
          parseCameraProfileFile({ bytes, format: profileFormat }),
          profileFormat,
          hash,
        );
        const previousReady = previous.filter(
          (record): record is ReadyCameraProfileRecord => record.kind === "ready",
        );
        const variants = previousReady.length > 0 ? previousReady : [null];
        for (const prior of variants) {
          const restoredProfile = prior && prior.profile.id !== profile.id
            ? parseMatrixCameraProfile({
                ...profile,
                id: prior.profile.id,
                label: prior.profile.label,
                unsupportedTags: [],
                opcodes: [],
              })
            : profile;
          records.push({
            kind: "ready",
            hash,
            sourceFilename: prior?.sourceFilename ?? name,
            storedFilename: name,
            format: profileFormat,
            profile: restoredProfile,
            capabilities: cameraProfileCapabilities(),
            unsupportedOperations: [],
          });
        }
      } catch (error) {
        const prior = previous[0];
        records.push({
          kind: "invalid",
          hash,
          sourceFilename: prior?.sourceFilename ?? name,
          storedFilename: name,
          format: profileFormat,
          parseError: error instanceof Error ? error.message : "Stored profile is invalid.",
          unsupportedOperations: prior?.unsupportedOperations ?? [],
        });
      }
    }
    const changed = JSON.stringify(records) !== JSON.stringify(this.state.profiles);
    const nextState: StoredRegistry = {
      ...this.state,
      generation: changed ? this.state.generation + 1 : this.state.generation,
      profiles: records,
    };
    if (changed || !(await this.indexExists())) await this.persist(nextState);
    this.state = nextState;
    return this.list();
  }

  private prunePending(now = Date.now()): void {
    for (const [token, pending] of this.pending) {
      if (now - pending.createdAt >= CAMERA_PROFILE_PENDING_TTL_MS) this.pending.delete(token);
    }
  }

  private async install(
    record: ReadyCameraProfileRecord,
    bytes: Uint8Array,
    replaceProfileId?: string,
  ): Promise<void> {
    await this.ensureStorageRoot(false);
    const destination = path.join(this.directory, record.storedFilename);
    let created = false;
    try {
      if (hasNativeFileTransactionSupport()) {
        await nativeAtomicWriteFile(
          destination,
          bytes,
          this.requiredDirectoryIdentity(),
          "exclusive",
        );
        created = true;
      } else {
        let handle: FileHandle | undefined;
        try {
          handle = await fs.open(destination, "wx", 0o600);
          await handle.writeFile(bytes);
          await handle.sync();
          created = true;
        } finally {
          await handle?.close();
        }
      }
      await this.ensureStorageRoot(false);
      await syncDirectory(this.directory, this.requiredDirectoryIdentity());
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const stored = await boundedRegularFile(destination, CAMERA_PROFILE_FILE_LIMIT, "Stored camera profile");
      if (digest(stored) !== record.hash) throw new Error("Stored camera profile hash collision.");
    }
    const profiles = replaceProfileId === undefined
      ? [...this.state.profiles, record]
      : this.state.profiles.map((candidate) =>
          candidate.kind === "ready" && candidate.profile.id === replaceProfileId
            ? record
            : candidate,
        );
    const nextState: StoredRegistry = {
      ...this.state,
      generation: this.state.generation + 1,
      profiles,
      retiredProfiles: replaceProfileId === undefined
        ? this.state.retiredProfiles.filter((candidate) => candidate.hash !== record.hash)
        : [
            ...this.state.retiredProfiles.filter((candidate) => candidate.hash !== record.hash),
            ...this.state.profiles.filter((candidate) =>
              candidate.kind === "ready" && candidate.profile.id === replaceProfileId,
            ),
          ],
    };
    try {
      await this.persist(nextState);
      this.state = nextState;
    } catch (error) {
      if (created) {
        await this.ensureStorageRoot(false);
        await fs.unlink(destination).catch(() => undefined);
        await syncDirectory(this.directory, this.requiredDirectoryIdentity()).catch(() => undefined);
      }
      throw error;
    }
  }

  private requiredDirectoryIdentity(): DirectoryIdentity {
    if (this.directoryIdentity === null) throw new Error("Camera profile storage is not initialized.");
    return this.directoryIdentity;
  }

  private async ensureStorageRoot(create: boolean): Promise<void> {
    if (create) await fs.mkdir(this.userDataPath, { recursive: true, mode: 0o700 });
    this.userDataIdentity = await stableDirectoryIdentity(
      this.userDataPath,
      this.userDataIdentity,
      "Camera profile user-data root",
    );
    if (create) {
      try {
        await fs.mkdir(this.directory, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    this.directoryIdentity = await stableDirectoryIdentity(
      this.directory,
      this.directoryIdentity,
      "Camera profile storage root",
    );
    await stableDirectoryIdentity(
      this.userDataPath,
      this.userDataIdentity,
      "Camera profile user-data root",
    );
  }

  private async indexExists(): Promise<boolean> {
    try {
      const stat = await fs.lstat(this.indexPath);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async persist(state: StoredRegistry): Promise<void> {
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(contents, "utf8") > CAMERA_PROFILE_REGISTRY_LIMIT) {
      throw new Error("Camera profile registry exceeds the 16 MiB limit.");
    }
    await this.ensureStorageRoot(false);
    if (hasNativeFileTransactionSupport()) {
      await nativeAtomicWriteFile(
        this.indexPath,
        new TextEncoder().encode(contents),
        this.requiredDirectoryIdentity(),
        "replace",
      );
      return;
    }
    const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    const backup = `${this.indexPath}.${process.pid}.${randomUUID()}.backup`;
    let handle: FileHandle | undefined;
    let backupCreated = false;
    let published = false;
    let committed = false;
    try {
      const existing = await fs.lstat(this.indexPath).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (existing?.isSymbolicLink()) throw new Error("Camera profile registry cannot be a symbolic link.");
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (existing !== null) {
        await fs.link(this.indexPath, backup);
        backupCreated = true;
        await syncDirectory(this.directory, this.requiredDirectoryIdentity());
      }
      await this.ensureStorageRoot(false);
      await fs.rename(temporary, this.indexPath);
      published = true;
      await this.ensureStorageRoot(false);
      await syncDirectory(this.directory, this.requiredDirectoryIdentity());
      committed = true;
      published = false;
    } catch (error) {
      if (published) {
        try {
          await this.ensureStorageRoot(false);
          if (backupCreated) {
            await fs.rename(backup, this.indexPath);
            backupCreated = false;
          } else {
            await fs.unlink(this.indexPath);
          }
          await syncDirectory(this.directory, this.requiredDirectoryIdentity());
          published = false;
        } catch (rollbackError) {
          try {
            const current = await boundedRegularFile(
              this.indexPath,
              CAMERA_PROFILE_REGISTRY_LIMIT,
              "Camera profile registry",
            );
            if (new TextDecoder("utf-8", { fatal: true }).decode(current) === contents) {
              committed = true;
              published = false;
            } else {
              throw rollbackError;
            }
          } catch {
            throw new Error("Camera profile registry rollback failed after publish.", { cause: rollbackError });
          }
        }
      }
      if (!committed) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      if (committed && backupCreated) {
        await fs.unlink(backup).catch(() => undefined);
        await syncDirectory(this.directory, this.requiredDirectoryIdentity()).catch(() => undefined);
      } else if (!published) {
        await fs.unlink(backup).catch(() => undefined);
      }
    }
  }
}
