import fs from "node:fs/promises";
import path from "node:path";
import { getFormatCapabilityForFileName } from "../lib/formats/index.ts";
import { parseRelativePath } from "../lib/catalog/runtime.ts";

export interface NativeScanObservation {
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly lastModified: number;
  readonly localFileId?: string | null;
  readonly formatId?: string;
}

export interface NativeScanProgress {
  readonly phase: "scanning" | "statting";
  readonly directoriesVisited: number;
  readonly filesConsidered: number;
  readonly acceptedCount: number;
  readonly currentPath: string;
}

export interface NativeScanResult {
  readonly observations: readonly NativeScanObservation[];
  readonly directoriesVisited: number;
  readonly filesConsidered: number;
  readonly acceptedCount: number;
  readonly currentPath: string | null;
}

export interface NativeScanOptions {
  readonly rootPath: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: NativeScanProgress) => void;
  readonly maxDirectories?: number;
  readonly statBatchSize?: number;
}

interface DirectoryQueueItem {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface FileCandidate {
  readonly absolutePath: string;
  readonly name: string;
  readonly relativePath: string;
  readonly formatId: string;
}

const DEFAULT_MAX_DIRECTORIES = 10_000;
const DEFAULT_STAT_BATCH_SIZE = 32;

export class NativeScanAbortError extends Error {
  constructor() {
    super("Native scan was aborted.");
    this.name = "NativeScanAbortError";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new NativeScanAbortError();
  }
}

function validatePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}

function relativePath(prefix: string, name: string): string {
  return parseRelativePath(prefix === "" ? name : `${prefix}/${name}`);
}

function assertContained(rootPath: string, candidatePath: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === "" ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Scan path escaped its root.");
  }
}

async function canonicalRoot(rootPath: string): Promise<string> {
  const canonicalPath = await fs.realpath(rootPath);
  const stat = await fs.lstat(canonicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Scan root is not a directory.");
  }
  return canonicalPath;
}

async function assertCanonicalDirectory(directoryPath: string): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Scan directory changed to a non-directory.");
  }
  if (await fs.realpath(directoryPath) !== directoryPath) {
    throw new Error("Scan directory changed to a symlink.");
  }
}

function emitProgress(
  onProgress: ((progress: NativeScanProgress) => void) | undefined,
  progress: NativeScanProgress,
): void {
  onProgress?.(progress);
}

function localFileId(stat: Awaited<ReturnType<typeof fs.lstat>>): string | null {
  return Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino)
    ? `${stat.dev}:${stat.ino}`
    : null;
}

export async function scanNativeFolder(options: NativeScanOptions): Promise<NativeScanResult> {
  const maxDirectories = validatePositiveInteger(
    options.maxDirectories,
    DEFAULT_MAX_DIRECTORIES,
    "maxDirectories",
  );
  const statBatchSize = validatePositiveInteger(
    options.statBatchSize,
    DEFAULT_STAT_BATCH_SIZE,
    "statBatchSize",
  );
  const rootPath = await canonicalRoot(options.rootPath);
  const queue: DirectoryQueueItem[] = [{ absolutePath: rootPath, relativePath: "" }];
  const observations: NativeScanObservation[] = [];
  let queueIndex = 0;
  let directoriesVisited = 0;
  let filesConsidered = 0;
  let currentPath: string | null = null;

  while (queueIndex < queue.length) {
    throwIfAborted(options.signal);
    const directory = queue[queueIndex]!;
    queueIndex += 1;
    directoriesVisited += 1;
    if (directoriesVisited > maxDirectories) {
      throw new Error("Folder is too large or contains too many subfolders to scan.");
    }
    currentPath = directory.relativePath;
    await assertCanonicalDirectory(directory.absolutePath);
    emitProgress(options.onProgress, {
      phase: "scanning",
      directoriesVisited,
      filesConsidered,
      acceptedCount: observations.length,
      currentPath,
    });

    const entries = await fs.readdir(directory.absolutePath, { withFileTypes: true });
    await assertCanonicalDirectory(directory.absolutePath);
    const files: FileCandidate[] = [];
    for (const dirent of entries) {
      throwIfAborted(options.signal);
      if (dirent.name.startsWith(".")) continue;
      const candidatePath = path.join(directory.absolutePath, dirent.name);
      assertContained(rootPath, candidatePath);
      const candidateRelativePath = relativePath(directory.relativePath, dirent.name);
      if (dirent.isDirectory()) {
        queue.push({ absolutePath: candidatePath, relativePath: candidateRelativePath });
      } else if (dirent.isFile()) {
        const format = getFormatCapabilityForFileName(dirent.name);
        if (format === null) continue;
        files.push({
          absolutePath: candidatePath,
          name: dirent.name,
          relativePath: candidateRelativePath,
          formatId: format.id,
        });
      }
    }

    for (let start = 0; start < files.length; start += statBatchSize) {
      throwIfAborted(options.signal);
      const batch = files.slice(start, start + statBatchSize);
      for (const file of batch) {
        throwIfAborted(options.signal);
        filesConsidered += 1;
        const stat = await fs.lstat(file.absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        observations.push({
          name: file.name,
          relativePath: file.relativePath,
          size: stat.size,
          lastModified: stat.mtimeMs,
          localFileId: localFileId(stat),
          formatId: file.formatId,
        });
      }
      emitProgress(options.onProgress, {
        phase: "statting",
        directoriesVisited,
        filesConsidered,
        acceptedCount: observations.length,
        currentPath,
      });
    }
  }

  observations.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    observations,
    directoriesVisited,
    filesConsidered,
    acceptedCount: observations.length,
    currentPath,
  };
}
