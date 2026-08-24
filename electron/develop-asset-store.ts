import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  decideAssetRetention,
  MAX_DEVELOP_ASSET_BYTES,
  parseDevelopAssetCandidate,
  parseDevelopAssetDescriptor,
  type AssetLifecycle,
  type DevelopAssetCandidate,
  type DevelopAssetDescriptor,
} from "../lib/develop/v3/assets.ts";
import {
  DEPTH_MAP_CHANNELS,
  DEPTH_MAP_FLOAT32_LE,
  DEPTH_MAP_FORMAT_VERSION,
  DEPTH_MAP_HEADER_BYTES,
  DEPTH_MAP_MAGIC,
  MAX_ASSET_GC_FAILURES,
  MAX_ASSET_RECORDS_PER_OBJECT,
  descriptorMatchesReference,
  descriptorsMatch,
  sourceSignaturesMatch,
  type DevelopAssetGcFailure,
  type DevelopAssetGcRequest,
  type DevelopAssetGcResult,
  type DevelopAssetPutRequest,
  type DevelopAssetPutResult,
  type DevelopAssetReadRequest,
  type DevelopAssetReadResult,
  type DevelopAssetTransitionRequest,
  type DevelopAssetTransitionResult,
} from "../lib/develop/v3/asset-store.ts";
import { parseSha256Digest } from "../lib/develop/render-contract.ts";

const STORE_VERSION = 1;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_TRANSACTION_BYTES = 4 * 1024;
const MAX_GC_OBJECTS_PER_RUN = 10_000;
const ORPHAN_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

interface StoredAssetRecord {
  readonly candidate: DevelopAssetCandidate;
  readonly lifecycle: AssetLifecycle;
  readonly createdAtMs: number;
  readonly recoveryUntilMs: number;
}

interface StoredAssetManifest {
  readonly version: typeof STORE_VERSION;
  readonly records: readonly StoredAssetRecord[];
}

interface StoredAssetTransaction {
  readonly version: typeof STORE_VERSION;
  readonly assetId: string;
  readonly candidateId: string;
  readonly createdAtMs: number;
  readonly recoveryUntilMs: number;
}

type ManifestReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "ready"; readonly manifest: StoredAssetManifest }
  | { readonly kind: "corrupt"; readonly message: string };

type ObjectReadResult =
  | { readonly kind: "ready"; readonly bytes: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string };

type ObjectStatResult =
  | { readonly kind: "ready"; readonly lastModifiedMs: number }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string };

type TransactionReadResult =
  | {
      readonly kind: "ready";
      readonly path: string;
      readonly transaction: StoredAssetTransaction;
    }
  | { readonly kind: "corrupt"; readonly path: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT";
}

function validTime(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function parseLifecycle(value: unknown): AssetLifecycle {
  switch (value) {
    case "preview-candidate":
    case "accepted":
    case "rejected":
    case "cancelled":
    case "stale":
      return value;
    default:
      throw new Error("Stored develop asset lifecycle is invalid.");
  }
}

function parseStoredRecord(value: unknown): StoredAssetRecord {
  if (
    !isRecord(value) ||
    !validTime(value.createdAtMs) ||
    !validTime(value.recoveryUntilMs) ||
    value.recoveryUntilMs < value.createdAtMs
  ) {
    throw new Error("Stored develop asset record is invalid.");
  }
  return {
    candidate: parseDevelopAssetCandidate(value.candidate),
    lifecycle: parseLifecycle(value.lifecycle),
    createdAtMs: value.createdAtMs,
    recoveryUntilMs: value.recoveryUntilMs,
  };
}

function parseManifest(value: unknown): StoredAssetManifest {
  if (
    !isRecord(value) ||
    value.version !== STORE_VERSION ||
    !Array.isArray(value.records) ||
    value.records.length === 0 ||
    value.records.length > MAX_ASSET_RECORDS_PER_OBJECT
  ) {
    throw new Error("Develop asset manifest is invalid.");
  }
  const records = value.records.map(parseStoredRecord);
  const digest = records[0]?.candidate.descriptor.sha256;
  if (
    !digest ||
    records.some((record) => record.candidate.descriptor.sha256 !== digest) ||
    new Set(records.map((record) => record.candidate.candidateId)).size !==
      records.length
  ) {
    throw new Error("Develop asset manifest records conflict.");
  }
  return { version: STORE_VERSION, records };
}

function parseTransaction(value: unknown): StoredAssetTransaction {
  if (
    !isRecord(value) ||
    value.version !== STORE_VERSION ||
    typeof value.candidateId !== "string" ||
    value.candidateId.length === 0 ||
    value.candidateId.length > 256 ||
    value.candidateId.includes("\0") ||
    !validTime(value.createdAtMs) ||
    !validTime(value.recoveryUntilMs) ||
    value.recoveryUntilMs < value.createdAtMs
  ) {
    throw new Error("Develop asset transaction is invalid.");
  }
  return {
    version: STORE_VERSION,
    assetId: parseSha256Digest(value.assetId),
    candidateId: value.candidateId,
    createdAtMs: value.createdAtMs,
    recoveryUntilMs: value.recoveryUntilMs,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function validateContentMetadata(
  descriptor: DevelopAssetDescriptor,
  bytes: Uint8Array,
): Promise<boolean> {
  if (descriptor.kind === "depth-map") {
    if (
      descriptor.mimeType !== "application/x-darkroom-depth" ||
      bytes.byteLength < DEPTH_MAP_HEADER_BYTES ||
      DEPTH_MAP_MAGIC.some((value, index) => bytes[index] !== value)
    ) {
      return false;
    }
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const version = view.getUint16(8, true);
    const component = view.getUint8(10);
    const channels = view.getUint8(11);
    const width = view.getUint32(12, true);
    const height = view.getUint32(16, true);
    const rowStride = view.getUint32(20, true);
    const expectedStride = width * Float32Array.BYTES_PER_ELEMENT;
    const expectedLength = DEPTH_MAP_HEADER_BYTES + rowStride * height;
    if (
      version !== DEPTH_MAP_FORMAT_VERSION ||
      component !== DEPTH_MAP_FLOAT32_LE ||
      channels !== DEPTH_MAP_CHANNELS ||
      width !== descriptor.dimensions.width ||
      height !== descriptor.dimensions.height ||
      rowStride !== expectedStride ||
      expectedLength !== bytes.byteLength
    ) {
      return false;
    }
    for (
      let offset = DEPTH_MAP_HEADER_BYTES;
      offset < bytes.byteLength;
      offset += Float32Array.BYTES_PER_ELEMENT
    ) {
      const depth = view.getFloat32(offset, true);
      if (!Number.isFinite(depth) || depth < 0 || depth > 1) return false;
    }
    return true;
  }
  try {
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    const expectedFormat = descriptor.mimeType === "image/png" ? "png" : "webp";
    return metadata.format === expectedFormat &&
      metadata.width === descriptor.dimensions.width &&
      metadata.height === descriptor.dimensions.height;
  } catch {
    return false;
  }
}

async function ensureManagedDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Develop asset store directory is invalid.");
  }
}

async function readRegularFile(
  filePath: string,
  maximumBytes: number,
): Promise<ObjectReadResult> {
  let handle: fs.FileHandle | null = null;
  try {
    const before = await fs.lstat(filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1 ||
      before.size > maximumBytes
    ) {
      return { kind: "invalid", message: "Stored asset is not a bounded regular file." };
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(filePath, flags);
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size
    ) {
      return { kind: "invalid", message: "Stored asset changed while it was opened." };
    }
    return { kind: "ready", bytes: Uint8Array.from(await handle.readFile()) };
  } catch (error) {
    if (isNotFound(error)) return { kind: "missing" };
    return { kind: "invalid", message: "Stored asset could not be read." };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function statRegularFile(
  filePath: string,
  maximumBytes: number,
): Promise<ObjectStatResult> {
  try {
    const stat = await fs.lstat(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > maximumBytes ||
      !Number.isFinite(stat.mtimeMs) ||
      stat.mtimeMs < 0
    ) {
      return {
        kind: "invalid",
        message: "Stored asset is not a bounded regular file.",
      };
    }
    return { kind: "ready", lastModifiedMs: stat.mtimeMs };
  } catch (error) {
    return isNotFound(error)
      ? { kind: "missing" }
      : { kind: "invalid", message: "Stored asset could not be inspected." };
  }
}

async function writeAtomic(
  filePath: string,
  contents: Uint8Array | string,
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await ensureManagedDirectory(directoryPath);
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

function boundedMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    error.message.length > 0 &&
    error.message.length <= 1_024 &&
    !error.message.includes("/") &&
    !error.message.includes("\\")
  ) {
    return error.message;
  }
  return fallback;
}

export class DevelopAssetStore {
  private readonly rootPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(rootPath: string) {
    const normalized = path.resolve(rootPath);
    if (!path.isAbsolute(rootPath) || normalized !== rootPath) {
      throw new Error("Develop asset store path must be absolute and normalized.");
    }
    this.rootPath = normalized;
  }

  put(request: DevelopAssetPutRequest): Promise<DevelopAssetPutResult> {
    return this.serialized(() => this.putNow(request));
  }

  transition(
    request: DevelopAssetTransitionRequest,
  ): Promise<DevelopAssetTransitionResult> {
    return this.serialized(() => this.transitionNow(request));
  }

  read(request: DevelopAssetReadRequest): Promise<DevelopAssetReadResult> {
    return this.serialized(() => this.readNow(request));
  }

  collectGarbage(request: DevelopAssetGcRequest): Promise<DevelopAssetGcResult> {
    return this.serialized(() => this.collectGarbageNow(request));
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private objectPath(assetId: string): string {
    const digestValue = parseSha256Digest(assetId);
    return path.join(
      this.rootPath,
      "objects",
      digestValue.slice(0, 2),
      `${digestValue}.asset`,
    );
  }

  private manifestPath(assetId: string): string {
    const digestValue = parseSha256Digest(assetId);
    return path.join(
      this.rootPath,
      "manifests",
      digestValue.slice(0, 2),
      `${digestValue}.json`,
    );
  }

  private transactionDirectory(assetId: string): string {
    const digestValue = parseSha256Digest(assetId);
    return path.join(
      this.rootPath,
      "transactions",
      digestValue.slice(0, 2),
    );
  }

  private transactionPath(assetId: string, candidateId: string): string {
    const digestValue = parseSha256Digest(assetId);
    const candidateDigest = digest(Buffer.from(candidateId, "utf8"));
    return path.join(
      this.transactionDirectory(digestValue),
      `${digestValue}-${candidateDigest}.json`,
    );
  }

  private async initialize(): Promise<void> {
    await ensureManagedDirectory(this.rootPath);
    await ensureManagedDirectory(path.join(this.rootPath, "objects"));
    await ensureManagedDirectory(path.join(this.rootPath, "manifests"));
    await ensureManagedDirectory(path.join(this.rootPath, "transactions"));
  }

  private async readManifest(assetId: string): Promise<ManifestReadResult> {
    const result = await readRegularFile(this.manifestPath(assetId), MAX_MANIFEST_BYTES);
    if (result.kind === "missing") return result;
    if (result.kind === "invalid") {
      return { kind: "corrupt", message: result.message };
    }
    try {
      const value: unknown = JSON.parse(Buffer.from(result.bytes).toString("utf8"));
      const manifest = parseManifest(value);
      if (
        manifest.records.some(
          (record) => record.candidate.descriptor.sha256 !== assetId,
        )
      ) {
        throw new Error("Develop asset manifest address is invalid.");
      }
      return { kind: "ready", manifest };
    } catch (error) {
      return {
        kind: "corrupt",
        message: boundedMessage(error, "Develop asset metadata is corrupt."),
      };
    }
  }

  private async writeManifest(
    assetId: string,
    records: readonly StoredAssetRecord[],
  ): Promise<void> {
    const manifest = { version: STORE_VERSION, records } satisfies StoredAssetManifest;
    const contents = `${JSON.stringify(manifest)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error("Develop asset manifest is too large.");
    }
    await writeAtomic(this.manifestPath(assetId), contents);
  }

  private async writeTransaction(
    candidate: DevelopAssetCandidate,
    createdAtMs: number,
    recoveryUntilMs: number,
  ): Promise<string> {
    const transaction = {
      version: STORE_VERSION,
      assetId: candidate.descriptor.sha256,
      candidateId: candidate.candidateId,
      createdAtMs,
      recoveryUntilMs,
    } satisfies StoredAssetTransaction;
    const contents = `${JSON.stringify(transaction)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_TRANSACTION_BYTES) {
      throw new Error("Develop asset transaction is too large.");
    }
    const filePath = this.transactionPath(
      candidate.descriptor.sha256,
      candidate.candidateId,
    );
    await writeAtomic(filePath, contents);
    return filePath;
  }

  private async readTransactions(
    assetId: string,
  ): Promise<readonly TransactionReadResult[]> {
    const directoryPath = this.transactionDirectory(assetId);
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      return [{
        kind: "corrupt",
        path: directoryPath,
        message: "Develop asset transactions could not be listed.",
      }];
    }
    const results: TransactionReadResult[] = [];
    for (const entry of entries) {
      const match = /^([0-9a-f]{64})-([0-9a-f]{64})\.json$/.exec(entry.name);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !match?.[1] ||
        match[1] !== assetId
      ) {
        continue;
      }
      const filePath = path.join(directoryPath, entry.name);
      const file = await readRegularFile(filePath, MAX_TRANSACTION_BYTES);
      if (file.kind !== "ready") {
        results.push({
          kind: "corrupt",
          path: filePath,
          message: file.kind === "invalid"
            ? file.message
            : "Develop asset transaction disappeared during collection.",
        });
        continue;
      }
      try {
        const value: unknown = JSON.parse(Buffer.from(file.bytes).toString("utf8"));
        const transaction = parseTransaction(value);
        if (transaction.assetId !== assetId) {
          throw new Error("Develop asset transaction address is invalid.");
        }
        results.push({ kind: "ready", path: filePath, transaction });
      } catch (error) {
        results.push({
          kind: "corrupt",
          path: filePath,
          message: boundedMessage(error, "Develop asset transaction is corrupt."),
        });
      }
    }
    return results;
  }

  private async putNow(
    request: DevelopAssetPutRequest,
  ): Promise<DevelopAssetPutResult> {
    await this.initialize();
    const descriptor = parseDevelopAssetDescriptor(request.candidate.descriptor);
    if (request.bytes.byteLength !== descriptor.byteLength) {
      return {
        kind: "rejected",
        reason: "byte-length-mismatch",
        message: "Candidate bytes do not match the declared byte length.",
      };
    }
    if (digest(request.bytes) !== descriptor.sha256) {
      return {
        kind: "rejected",
        reason: "checksum-mismatch",
        message: "Candidate bytes do not match the declared checksum.",
      };
    }
    if (!(await validateContentMetadata(descriptor, request.bytes))) {
      return {
        kind: "rejected",
        reason: "content-metadata-mismatch",
        message: "Candidate bytes do not match the declared dimensions or MIME type.",
      };
    }

    const manifest = await this.readManifest(descriptor.sha256);
    if (manifest.kind === "corrupt") {
      return {
        kind: "rejected",
        reason: "candidate-conflict",
        message: "Existing candidate metadata is corrupt and must be restored.",
      };
    }
    let duplicate: StoredAssetRecord | undefined;
    if (manifest.kind === "ready") {
      duplicate = manifest.manifest.records.find(
        (record) => record.candidate.candidateId === request.candidate.candidateId,
      );
      if (
        duplicate &&
        !descriptorsMatch(duplicate.candidate.descriptor, descriptor)
      ) {
        return {
          kind: "rejected",
          reason: "candidate-conflict",
          message: "Candidate ID already belongs to different metadata.",
        };
      }
      if (
        !duplicate &&
        manifest.manifest.records.length >= MAX_ASSET_RECORDS_PER_OBJECT
      ) {
        return {
          kind: "rejected",
          reason: "record-limit",
          message: "This content object has too many candidate records.",
        };
      }
    }

    const objectPath = this.objectPath(descriptor.sha256);
    const currentObject = await readRegularFile(objectPath, descriptor.byteLength);
    let object: "created" | "reused" = "created";
    if (currentObject.kind === "ready") {
      if (
        currentObject.bytes.byteLength !== descriptor.byteLength ||
        digest(currentObject.bytes) !== descriptor.sha256
      ) {
        return {
          kind: "rejected",
          reason: "candidate-conflict",
          message: "Existing content-addressed bytes are corrupt.",
        };
      }
      object = "reused";
    } else if (currentObject.kind === "invalid") {
      return {
        kind: "rejected",
        reason: "candidate-conflict",
        message: currentObject.message,
      };
    }

    if (duplicate && object === "reused") {
      return { kind: "deduplicated", candidate: duplicate.candidate };
    }

    const candidate = parseDevelopAssetCandidate({
      ...request.candidate,
      descriptor,
    });
    const transactionPath = await this.writeTransaction(
      candidate,
      request.nowMs,
      request.recoveryUntilMs,
    );
    if (currentObject.kind === "missing") {
      await writeAtomic(objectPath, request.bytes);
    }
    if (duplicate) {
      await fs.unlink(transactionPath).catch(() => undefined);
      return { kind: "stored", candidate: duplicate.candidate, object };
    }
    const record = {
      candidate,
      lifecycle: "preview-candidate",
      createdAtMs: request.nowMs,
      recoveryUntilMs: request.recoveryUntilMs,
    } satisfies StoredAssetRecord;
    const records = manifest.kind === "ready"
      ? [...manifest.manifest.records, record]
      : [record];
    await this.writeManifest(descriptor.sha256, records);
    await fs.unlink(transactionPath).catch(() => undefined);
    return { kind: "stored", candidate, object };
  }

  private async transitionNow(
    request: DevelopAssetTransitionRequest,
  ): Promise<DevelopAssetTransitionResult> {
    await this.initialize();
    const descriptor = request.candidate.descriptor;
    const manifest = await this.readManifest(descriptor.sha256);
    if (manifest.kind === "missing") {
      return {
        kind: "missing",
        action: "rebuild-candidate",
        message: "Candidate metadata is missing.",
      };
    }
    if (manifest.kind === "corrupt") {
      return {
        kind: "conflict",
        action: "review-current-candidate",
        message: manifest.message,
      };
    }
    const index = manifest.manifest.records.findIndex(
      (record) => record.candidate.candidateId === request.candidate.candidateId,
    );
    const current = manifest.manifest.records[index];
    if (!current) {
      return {
        kind: "missing",
        action: "rebuild-candidate",
        message: "Candidate metadata is missing.",
      };
    }
    if (!descriptorsMatch(current.candidate.descriptor, descriptor)) {
      return {
        kind: "conflict",
        action: "review-current-candidate",
        message: "Candidate metadata changed before the lifecycle update.",
      };
    }
    if (
      request.lifecycle === "accepted" &&
      (!request.reference ||
        !descriptorMatchesReference(descriptor, request.reference))
    ) {
      return {
        kind: "conflict",
        action: "review-current-candidate",
        message: "Accepted reference does not match the candidate metadata.",
      };
    }
    if (request.lifecycle === "accepted") {
      const object = await readRegularFile(
        this.objectPath(descriptor.sha256),
        descriptor.byteLength,
      );
      if (
        object.kind !== "ready" ||
        object.bytes.byteLength !== descriptor.byteLength ||
        digest(object.bytes) !== descriptor.sha256 ||
        !(await validateContentMetadata(descriptor, object.bytes))
      ) {
        return {
          kind: "conflict",
          action: "review-current-candidate",
          message: "Candidate bytes are missing, corrupt, or do not match metadata.",
        };
      }
    }
    if (current.lifecycle === request.lifecycle) {
      return { kind: "unchanged", lifecycle: request.lifecycle };
    }
    if (current.lifecycle !== "preview-candidate") {
      return {
        kind: "conflict",
        action: "review-current-candidate",
        message: "Candidate lifecycle is already final.",
      };
    }
    const next = {
      ...current,
      lifecycle: request.lifecycle,
      recoveryUntilMs: Math.max(current.recoveryUntilMs, request.recoveryUntilMs),
    } satisfies StoredAssetRecord;
    const records = [...manifest.manifest.records];
    records[index] = next;
    await this.writeManifest(descriptor.sha256, records);
    return { kind: "changed", lifecycle: request.lifecycle };
  }

  private async readNow(
    request: DevelopAssetReadRequest,
  ): Promise<DevelopAssetReadResult> {
    await this.initialize();
    const manifest = await this.readManifest(request.reference.assetId);
    if (manifest.kind === "missing") {
      return {
        kind: "missing",
        reason: "metadata-missing",
        action: "restore-or-rebuild",
        message: "Accepted asset metadata is missing.",
      };
    }
    if (manifest.kind === "corrupt") {
      return {
        kind: "corrupt",
        reason: "metadata-invalid",
        action: "restore-or-rebuild",
        message: manifest.message,
      };
    }
    const matching = manifest.manifest.records.filter((record) =>
      descriptorMatchesReference(record.candidate.descriptor, request.reference) &&
      sourceSignaturesMatch(
        record.candidate.descriptor.sourceSignature,
        request.sourceSignature,
      )
    );
    if (matching.length === 0) {
      return {
        kind: "corrupt",
        reason: "reference-mismatch",
        action: "restore-or-rebuild",
        message: "Accepted reference does not match stored metadata.",
      };
    }
    const accepted = matching.find((record) => record.lifecycle === "accepted");
    if (!accepted) {
      return {
        kind: "missing",
        reason: "not-accepted",
        action: "accept-candidate",
        message: "Candidate bytes exist but have not been accepted.",
      };
    }
    const descriptor = accepted.candidate.descriptor;
    const object = await readRegularFile(
      this.objectPath(descriptor.sha256),
      descriptor.byteLength,
    );
    if (object.kind === "missing") {
      return {
        kind: "missing",
        reason: "bytes-missing",
        action: "restore-or-rebuild",
        message: "Accepted asset bytes are missing.",
      };
    }
    if (object.kind === "invalid") {
      return {
        kind: "corrupt",
        reason: "byte-length-mismatch",
        action: "restore-or-rebuild",
        message: object.message,
      };
    }
    if (object.bytes.byteLength !== descriptor.byteLength) {
      return {
        kind: "corrupt",
        reason: "byte-length-mismatch",
        action: "restore-or-rebuild",
        message: "Accepted asset byte length does not match its metadata.",
      };
    }
    if (digest(object.bytes) !== descriptor.sha256) {
      return {
        kind: "corrupt",
        reason: "checksum-mismatch",
        action: "restore-or-rebuild",
        message: "Accepted asset checksum does not match its content address.",
      };
    }
    if (!(await validateContentMetadata(descriptor, object.bytes))) {
      return {
        kind: "corrupt",
        reason: "content-metadata-mismatch",
        action: "restore-or-rebuild",
        message: "Accepted asset dimensions or MIME type do not match its metadata.",
      };
    }
    return { kind: "ready", descriptor, bytes: object.bytes };
  }

  private async collectGarbageNow(
    request: DevelopAssetGcRequest,
  ): Promise<DevelopAssetGcResult> {
    await this.initialize();
    const page = await this.assetIdPage(request.cursor);
    let deleted = 0;
    let protectedCount = 0;
    let candidateDeferred = 0;
    let recoveryDeferred = 0;
    let failed = 0;
    const failures: DevelopAssetGcFailure[] = [];
    for (const assetId of page.assetIds) {
      const protectedOwners = request.protectedReferences
        .filter((item) => item.reference.assetId === assetId)
        .map((item) => item.owner);
      if (protectedOwners.length > 0) {
        protectedCount += 1;
        continue;
      }

      const manifest = await this.readManifest(assetId);
      const transactions = await this.readTransactions(assetId);
      const corruptTransaction = transactions.find(
        (transaction) => transaction.kind === "corrupt",
      );
      if (corruptTransaction?.kind === "corrupt") {
        failed += 1;
        this.recordFailure(failures, {
          assetId,
          code: "metadata-invalid",
          message: corruptTransaction.message,
        });
        continue;
      }
      const completedCandidateIds = new Set(
        manifest.kind === "ready"
          ? manifest.manifest.records.map((record) => record.candidate.candidateId)
          : [],
      );
      const readyTransactions = transactions.filter(
        (transaction) => transaction.kind === "ready",
      );
      const removableTransactions = readyTransactions.filter((item) =>
        completedCandidateIds.has(item.transaction.candidateId) ||
        item.transaction.recoveryUntilMs <= request.nowMs
      );
      try {
        for (const transaction of removableTransactions) {
          await fs.unlink(transaction.path).catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
        }
      } catch (error) {
        failed += 1;
        this.recordFailure(failures, {
          assetId,
          code: "filesystem-error",
          message: boundedMessage(
            error,
            "Develop asset transaction could not be collected.",
          ),
        });
        continue;
      }
      const activeTransaction = readyTransactions.some((item) =>
        !completedCandidateIds.has(item.transaction.candidateId) &&
        item.transaction.recoveryUntilMs > request.nowMs
      );
      if (activeTransaction) {
        recoveryDeferred += 1;
        continue;
      }

      if (manifest.kind === "missing") {
        const object = await statRegularFile(
          this.objectPath(assetId),
          MAX_DEVELOP_ASSET_BYTES,
        );
        if (object.kind === "invalid") {
          failed += 1;
          this.recordFailure(failures, {
            assetId,
            code: "filesystem-error",
            message: object.message,
          });
          continue;
        }
        if (
          object.kind === "ready" &&
          object.lastModifiedMs + ORPHAN_RECOVERY_WINDOW_MS > request.nowMs
        ) {
          recoveryDeferred += 1;
          continue;
        }
        try {
          await fs.unlink(this.objectPath(assetId)).catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
          deleted += 1;
        } catch (error) {
          failed += 1;
          this.recordFailure(failures, {
            assetId,
            code: "filesystem-error",
            message: boundedMessage(error, "Orphan asset could not be collected."),
          });
        }
        continue;
      }
      if (manifest.kind === "corrupt") {
        failed += 1;
        this.recordFailure(failures, {
          assetId,
          code: "metadata-invalid",
          message: manifest.message,
        });
        continue;
      }

      const retained: StoredAssetRecord[] = [];
      let hasCandidateInReview = false;
      for (const record of manifest.manifest.records) {
        const decision = decideAssetRetention({
          lifecycle: record.lifecycle,
          references: [],
          recoveryUntilMs: record.recoveryUntilMs,
          nowMs: request.nowMs,
        });
        if (decision.kind === "invalid") {
          retained.push(record);
        } else if (decision.kind === "protected") {
          retained.push(record);
          if (decision.reason === "candidate-in-review") {
            hasCandidateInReview = true;
          }
        }
      }
      if (retained.length > 0) {
        if (retained.length < manifest.manifest.records.length) {
          try {
            await this.writeManifest(assetId, retained);
          } catch (error) {
            failed += 1;
            this.recordFailure(failures, {
              assetId,
              code: "filesystem-error",
              message: boundedMessage(
                error,
                "Develop asset metadata could not be collected.",
              ),
            });
            continue;
          }
        }
        if (hasCandidateInReview) {
          candidateDeferred += 1;
        } else {
          recoveryDeferred += 1;
        }
        continue;
      }
      try {
        await fs.unlink(this.manifestPath(assetId));
        await fs.unlink(this.objectPath(assetId)).catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
        deleted += 1;
      } catch (error) {
        failed += 1;
        this.recordFailure(failures, {
          assetId,
          code: "filesystem-error",
          message: boundedMessage(error, "Develop asset could not be collected."),
        });
      }
    }
    return {
      examined: page.assetIds.length,
      deleted,
      protected: protectedCount,
      candidateDeferred,
      recoveryDeferred,
      failed,
      failures,
      omittedFailures: failed - failures.length,
      nextCursor: page.nextCursor,
    };
  }

  private recordFailure(
    failures: DevelopAssetGcFailure[],
    failure: DevelopAssetGcFailure,
  ): void {
    if (failures.length < MAX_ASSET_GC_FAILURES) failures.push(failure);
  }

  private async assetIdPage(
    cursor: string | null,
  ): Promise<{
    readonly assetIds: readonly string[];
    readonly nextCursor: string | null;
  }> {
    const assetIds = new Set<string>();
    await this.addAssetIds(assetIds, "objects", /^([0-9a-f]{64})\.asset$/);
    await this.addAssetIds(assetIds, "manifests", /^([0-9a-f]{64})\.json$/);
    await this.addAssetIds(
      assetIds,
      "transactions",
      /^([0-9a-f]{64})-[0-9a-f]{64}\.json$/,
    );
    const remaining = [...assetIds]
      .filter((assetId) => cursor === null || assetId > cursor)
      .sort();
    const page = remaining.slice(0, MAX_GC_OBJECTS_PER_RUN);
    const last = page.at(-1);
    return {
      assetIds: page,
      nextCursor: remaining.length > page.length && last ? last : null,
    };
  }

  private async addAssetIds(
    assetIds: Set<string>,
    directoryName: "objects" | "manifests" | "transactions",
    filenamePattern: RegExp,
  ): Promise<void> {
    const root = path.join(this.rootPath, directoryName);
    const prefixes = await fs.readdir(root, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (
        !prefix.isDirectory() ||
        prefix.isSymbolicLink() ||
        !/^[0-9a-f]{2}$/.test(prefix.name)
      ) {
        continue;
      }
      const entries = await fs.readdir(
        path.join(root, prefix.name),
        { withFileTypes: true },
      );
      for (const entry of entries) {
        const match = filenamePattern.exec(entry.name);
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !match?.[1] ||
          match[1].slice(0, 2) !== prefix.name
        ) {
          continue;
        }
        assetIds.add(parseSha256Digest(match[1]));
      }
    }
  }
}
