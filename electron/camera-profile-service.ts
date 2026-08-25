import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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

interface PendingConflict {
  readonly record: ReadyCameraProfileRecord;
  readonly bytes: Uint8Array;
}

interface StoredRegistry {
  readonly version: typeof CAMERA_PROFILE_REGISTRY_VERSION;
  readonly generation: number;
  readonly profiles: readonly CameraProfileRecord[];
  readonly replacements: Readonly<Record<string, string>>;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
  return {
    version: CAMERA_PROFILE_REGISTRY_VERSION,
    generation: Number(input.generation),
    profiles: snapshot.profiles,
    replacements: snapshot.replacements,
  };
}

export class CameraProfileService {
  private readonly directory: string;
  private readonly indexPath: string;
  private state: StoredRegistry = {
    version: CAMERA_PROFILE_REGISTRY_VERSION,
    generation: 0,
    profiles: [],
    replacements: {},
  };
  private readonly pending = new Map<string, PendingConflict>();

  constructor(userDataPath: string) {
    if (!path.isAbsolute(userDataPath)) throw new Error("Camera profile storage needs an absolute path.");
    this.directory = path.join(userDataPath, "camera-profiles");
    this.indexPath = path.join(this.directory, "registry.json");
  }

  async initialize(): Promise<CameraProfileRegistrySnapshot> {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const contents = await fs.readFile(this.indexPath, "utf8");
      this.state = parseStoredRegistry(JSON.parse(contents));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return this.rescan();
  }

  list(): CameraProfileRegistrySnapshot {
    return registrySnapshot(this.state);
  }

  async importFile(filePath: string): Promise<CameraProfileImportResult> {
    const filename = sourceFilename(filePath);
    const profileFormat = cameraProfileFormatFromFilename(filename);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Camera profile import must be a regular file.");
    }
    if (stat.size > CAMERA_PROFILE_FILE_LIMIT) {
      throw new Error("Camera profile file exceeds the 16 MiB limit.");
    }
    const bytes = await fs.readFile(filePath);
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
      const token = randomUUID();
      this.pending.set(token, { record: incoming, bytes });
      return { kind: "conflict", token, existing, incoming };
    }
    await this.install(incoming, bytes);
    return { kind: "imported", record: incoming };
  }

  async resolveConflict(value: unknown): Promise<CameraProfileImportResult> {
    const request: CameraProfileConflictRequest = parseCameraProfileConflictRequest(value);
    const pending = this.pending.get(request.token);
    if (!pending) throw new Error("Camera profile import conflict expired.");
    this.pending.delete(request.token);
    if (request.action === "cancel") return { kind: "cancelled" };
    const existing = this.state.profiles.find(
      (record): record is ReadyCameraProfileRecord =>
        record.kind === "ready" && record.profile.id === pending.record.profile.id,
    );
    if (!existing) throw new Error("The conflicting camera profile changed. Import it again.");
    if (request.action === "replace") {
      await this.install(pending.record, pending.bytes, existing.profile.id);
      await this.deleteIfUnused(existing.storedFilename, existing.hash);
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
    return { kind: "imported", record: copy };
  }

  async remove(value: unknown): Promise<CameraProfileRegistrySnapshot> {
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
    this.state = {
      ...this.state,
      generation: this.state.generation + 1,
      profiles: this.state.profiles.filter((record) => record !== removed),
      replacements: Object.fromEntries([
        ...Object.entries(this.state.replacements).map(([profileId, replacementId]) => [
          profileId,
          replacementId === removed.profile.id ? replacement.profile.id : replacementId,
        ]),
        [removed.profile.id, replacement.profile.id],
      ]),
    };
    await this.persist();
    await this.deleteIfUnused(removed.storedFilename, removed.hash);
    return this.list();
  }

  async rescan(): Promise<CameraProfileRegistrySnapshot> {
    await fs.mkdir(this.directory, { recursive: true });
    const existingByHash = new Map<string, CameraProfileRecord[]>();
    for (const record of this.state.profiles) {
      const records = existingByHash.get(record.hash) ?? [];
      records.push(record);
      existingByHash.set(record.hash, records);
    }
    const records: CameraProfileRecord[] = [];
    const names = (await fs.readdir(this.directory)).sort();
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.(dcp|xmp)$/.exec(name);
      if (!match) continue;
      const hash = match[1]!;
      const profileFormat: CameraProfileFormat = match[2] === "dcp" ? "dcp" : "xmp";
      const absolutePath = path.join(this.directory, name);
      const previous = existingByHash.get(hash) ?? [];
      try {
        const stat = await fs.lstat(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Stored profile is not a regular file.");
        if (stat.size > CAMERA_PROFILE_FILE_LIMIT) throw new Error("Stored profile exceeds the 16 MiB limit.");
        const bytes = await fs.readFile(absolutePath);
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
    this.state = {
      ...this.state,
      generation: changed ? this.state.generation + 1 : this.state.generation,
      profiles: records,
    };
    if (changed || !(await this.indexExists())) await this.persist();
    return this.list();
  }

  private async install(
    record: ReadyCameraProfileRecord,
    bytes: Uint8Array,
    replaceProfileId?: string,
  ): Promise<void> {
    const destination = path.join(this.directory, record.storedFilename);
    try {
      await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isMissing(error) && !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const stored = await fs.readFile(destination);
      if (digest(stored) !== record.hash) throw new Error("Stored camera profile hash collision.");
    }
    const profiles = replaceProfileId === undefined
      ? [...this.state.profiles, record]
      : this.state.profiles.map((candidate) =>
          candidate.kind === "ready" && candidate.profile.id === replaceProfileId
            ? record
            : candidate,
        );
    this.state = {
      ...this.state,
      generation: this.state.generation + 1,
      profiles,
    };
    await this.persist();
  }

  private async deleteIfUnused(filename: string, hash: string): Promise<void> {
    if (this.state.profiles.some((record) => record.hash === hash)) return;
    try {
      await fs.unlink(path.join(this.directory, filename));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
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

  private async persist(): Promise<void> {
    const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, this.indexPath);
  }
}
