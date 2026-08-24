import { createHash } from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { FileObservation } from "../lib/import/domain.ts";
import type { FileTransactionBackupProof, FileTransactionFileSystem } from "./file-transaction-service.ts";

export const NATIVE_FILE_TRANSACTION_UNAVAILABLE_MESSAGE =
  "Native file transactions are unavailable on this build.";

export class NativeFileTransactionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeFileTransactionError";
    this.code = code;
  }
}

export class NativeFileTransactionUnavailableError extends NativeFileTransactionError {
  constructor() {
    super("UNAVAILABLE", NATIVE_FILE_TRANSACTION_UNAVAILABLE_MESSAGE);
    this.name = "NativeFileTransactionUnavailableError";
  }
}

interface HelperCommandResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

interface NativeFileTransactionFileSystemOptions {
  readonly helperPath?: string | null;
}

type HelperPathResolver = () => string | null;

const MAX_CONTROL_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_OUTPUT_BYTES = 4 * 1024;

function helperName(): string {
  const suffix = `${process.platform}-${process.arch}`;
  return process.platform === "win32"
    ? `file-transaction-helper-${suffix}.exe`
    : `file-transaction-helper-${suffix}`;
}

function helperCandidates(): readonly string[] {
  if (process.platform === "win32") return [];
  const name = helperName();
  const candidates: string[] = [];
  const packagedModule = typeof __dirname === "string" &&
    __dirname.split(path.sep).includes("app.asar");
  const resourcesPath = process.resourcesPath;
  if (typeof resourcesPath === "string" && path.isAbsolute(resourcesPath)) {
    candidates.push(path.join(resourcesPath, "app.asar.unpacked", "electron-dist", name));
    candidates.push(path.join(resourcesPath, "electron-dist", name));
  }
  if (packagedModule) return candidates;
  if (typeof __dirname === "string") candidates.push(path.join(__dirname, name));
  candidates.push(path.join(process.cwd(), "electron-dist", name));
  return candidates;
}

function resolveHelperPath(): string | null {
  for (const candidate of helperCandidates()) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) continue;
      return candidate;
    } catch {
      // A missing host helper is a typed capability result, not a path fallback.
    }
  }
  return null;
}

export function hasNativeFileTransactionSupport(): boolean {
  return resolveHelperPath() !== null;
}

function errorMessage(code: string): string {
  switch (code) {
    case "EACCES": return "Native file transaction permission was denied.";
    case "EEXIST": return "Transaction destination already exists.";
    case "ENOENT": return "Transaction file is missing.";
    case "ENOSPC": return "Native file transaction storage is full.";
    case "EXDEV": return "Transaction rename crosses filesystems.";
    case "ELOOP":
    case "UNSAFE":
    case "CHANGED": return "Transaction path or file changed during the operation.";
    case "PAUSE_TIMEOUT": return "Native file transaction test pause timed out.";
    case "INVALID_ARGUMENT": return "Native file transaction arguments are invalid.";
    default: return "Native file transaction failed.";
  }
}

function helperError(stderr: string): NativeFileTransactionError {
  const firstLine = stderr.split(/\r?\n/, 1)[0] ?? "";
  const match = /^ERR ([A-Z0-9_]{1,32})$/.exec(firstLine.trim());
  const code = match?.[1] ?? "IO";
  return new NativeFileTransactionError(code, errorMessage(code));
}

function boundedText(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").slice(0, MAX_ERROR_OUTPUT_BYTES);
}

function helperProcess(command: string, args: readonly string[], resolvePath: HelperPathResolver) {
  const helperPath = resolvePath();
  if (helperPath === null) throw new NativeFileTransactionUnavailableError();
  try {
    return spawn(helperPath, [command, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new NativeFileTransactionUnavailableError();
  }
}

async function runHelper(
  command: string,
  args: readonly string[],
  resolvePath: HelperPathResolver,
): Promise<HelperCommandResult> {
  const child = helperProcess(command, args, resolvePath);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputError: NativeFileTransactionError | null = null;
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes <= MAX_CONTROL_OUTPUT_BYTES) stdoutChunks.push(bytes);
      else outputError ??= new NativeFileTransactionError("OUTPUT_LIMIT", "Native file transaction output was invalid.");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes <= MAX_ERROR_OUTPUT_BYTES) stderrChunks.push(bytes);
    });
    child.once("error", () => {
      reject(new NativeFileTransactionUnavailableError());
    });
    child.once("close", (exitCode) => {
      if (outputError !== null) {
        reject(outputError);
        return;
      }
      const stderr = boundedText(stderrChunks);
      if (exitCode !== 0) {
        reject(helperError(stderr));
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}

function parseObservationLine(line: string, prefix: "OBS" | "META"): FileObservation {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] !== prefix) {
    throw new NativeFileTransactionError("PROTOCOL", "Native file transaction returned invalid metadata.");
  }
  const [, device, inode, sizeValue, modifiedAtNsValue] = fields;
  if (!/^[0-9]+$/.test(device) || !/^[0-9]+$/.test(inode) || !/^[0-9]+$/.test(sizeValue ?? "") ||
      !/^-?[0-9]+$/.test(modifiedAtNsValue ?? "")) {
    throw new NativeFileTransactionError("PROTOCOL", "Native file transaction returned invalid metadata.");
  }
  let size: number;
  let modifiedAtNs: bigint;
  try {
    const sizeBigInt = BigInt(sizeValue!);
    if (sizeBigInt > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("size");
    size = Number(sizeBigInt);
    modifiedAtNs = BigInt(modifiedAtNsValue!);
  } catch {
    throw new NativeFileTransactionError("PROTOCOL", "Native file transaction returned invalid metadata.");
  }
  const nanosecondsPerSecond = BigInt(1_000_000_000);
  const seconds = modifiedAtNs / nanosecondsPerSecond;
  const nanoseconds = modifiedAtNs % nanosecondsPerSecond;
  const modifiedAt = Number(seconds) * 1_000 + Number(nanoseconds) / 1_000_000;
  if (!Number.isSafeInteger(size) || !Number.isFinite(modifiedAt)) {
    throw new NativeFileTransactionError("PROTOCOL", "Native file transaction returned invalid metadata.");
  }
  return {
    size,
    modifiedAt,
    localFileId: `${device}:${inode}`,
    observedAt: Date.now(),
  };
}

function parseMetadata(stderr: string, prefix: "OBS" | "META"): FileObservation {
  const line = stderr.split(/\r?\n/).find((value) => value.startsWith(`${prefix} `));
  if (line === undefined) {
    throw new NativeFileTransactionError("PROTOCOL", "Native file transaction returned no metadata.");
  }
  return parseObservationLine(line, prefix);
}

async function nativeExists(filePath: string, resolvePath: HelperPathResolver): Promise<boolean> {
  const result = await runHelper("exists", [filePath], resolvePath);
  const value = result.stdout.toString("utf8").trim();
  if (value === "EXISTS 1") return true;
  if (value === "EXISTS 0") return false;
  throw new NativeFileTransactionError("PROTOCOL", "Native file transaction returned an invalid existence result.");
}

async function nativeMkdir(directoryPath: string, resolvePath: HelperPathResolver): Promise<void> {
  await runHelper("mkdir", [directoryPath], resolvePath);
}

async function nativeCopyFile(
  sourcePath: string,
  destinationPath: string,
  resolvePath: HelperPathResolver,
): Promise<void> {
  await runHelper("copy", [sourcePath, destinationPath], resolvePath);
}

async function nativeRename(
  sourcePath: string,
  destinationPath: string,
  resolvePath: HelperPathResolver,
): Promise<void> {
  await runHelper("rename", [sourcePath, destinationPath], resolvePath);
}

async function nativeRemoveFile(filePath: string, resolvePath: HelperPathResolver): Promise<void> {
  await runHelper("remove", [filePath], resolvePath);
}

async function nativeObserve(filePath: string, resolvePath: HelperPathResolver): Promise<FileObservation> {
  const result = await runHelper("observe", [filePath], resolvePath);
  return parseMetadata(result.stderr, "OBS");
}

async function nativeDigest(
  filePath: string,
  resolvePath: HelperPathResolver,
): Promise<FileTransactionBackupProof> {
  const helperPath = resolvePath();
  if (helperPath === null) throw new NativeFileTransactionUnavailableError();
  const child = helperProcess("digest", [filePath], resolvePath);
  const hash = createHash("sha256");
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes <= MAX_ERROR_OUTPUT_BYTES) stderrChunks.push(bytes);
    });
    child.once("error", () => {
      reject(new NativeFileTransactionUnavailableError());
    });
    child.once("close", (exitCode) => {
      const stderr = boundedText(stderrChunks);
      if (exitCode !== 0) {
        reject(helperError(stderr));
        return;
      }
      try {
        resolve({
          sha256: hash.digest("hex"),
          observation: parseMetadata(stderr, "META"),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function nativeVerifyCopy(
  sourcePath: string,
  destinationPath: string,
  expectedSource: FileObservation,
  resolvePath: HelperPathResolver,
): Promise<void> {
  const source = await nativeDigest(sourcePath, resolvePath);
  if (!sameFileObservationForHelper(expectedSource, source.observation)) {
    throw new NativeFileTransactionError("CHANGED", "Transaction source changed before publish.");
  }
  const destination = await nativeDigest(destinationPath, resolvePath);
  if (source.sha256 !== destination.sha256 || source.observation.size !== destination.observation.size) {
    throw new NativeFileTransactionError("CHANGED", "Staged file verification failed.");
  }
}

function sameFileObservationForHelper(expected: FileObservation, actual: FileObservation): boolean {
  return expected.size === actual.size &&
    expected.modifiedAt === actual.modifiedAt &&
    expected.localFileId === actual.localFileId;
}

async function nativeVerifyObservation(
  filePath: string,
  expected: FileObservation,
  resolvePath: HelperPathResolver,
): Promise<void> {
  const actual = await nativeObserve(filePath, resolvePath);
  if (!sameFileObservationForHelper(expected, actual)) {
    throw new NativeFileTransactionError("CHANGED", "Source changed before cleanup.");
  }
}

export function createNativeFileTransactionFileSystem(
  options: NativeFileTransactionFileSystemOptions = {},
): FileTransactionFileSystem {
  const resolvePath: HelperPathResolver = () => options.helperPath === undefined
    ? resolveHelperPath()
    : options.helperPath;
  return {
    exists: (filePath) => nativeExists(filePath, resolvePath),
    mkdir: (directoryPath) => nativeMkdir(directoryPath, resolvePath),
    copyFile: (sourcePath, destinationPath) => nativeCopyFile(sourcePath, destinationPath, resolvePath),
    rename: (sourcePath, destinationPath) => nativeRename(sourcePath, destinationPath, resolvePath),
    removeFile: (filePath) => nativeRemoveFile(filePath, resolvePath),
    observe: (filePath) => nativeObserve(filePath, resolvePath),
    digest: (filePath) => nativeDigest(filePath, resolvePath),
    verifyCopy: (sourcePath, destinationPath, expectedSource) => nativeVerifyCopy(
      sourcePath,
      destinationPath,
      expectedSource,
      resolvePath,
    ),
    verifyObservation: (filePath, expected) => nativeVerifyObservation(filePath, expected, resolvePath),
  };
}
