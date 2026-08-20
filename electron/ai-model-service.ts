import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import path from "node:path";

import type {
  AiModelId,
  AiModelProgress,
  AiModelState,
} from "../lib/ai/types";
import {
  getAiModelManifestEntry,
  type AiModelManifestEntry,
} from "./ai-model-manifest";

const MAX_REDIRECTS = 5;
const DOWNLOAD_USER_AGENT = "Darkroom/0.1 model downloader";

class ModelCacheMissingError extends Error {}

class ModelServiceError extends Error {}

interface ActiveDownload {
  readonly controller: AbortController;
  receivedBytes: number;
  promise: Promise<void>;
  temporaryPath?: string;
}

export interface VerifiedAiModelFile {
  readonly handle: FileHandle;
  readonly bytes: number;
}

interface AiModelServiceOptions {
  readonly userDataPath: string;
  readonly onProgress: (progress: AiModelProgress) => void;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten === 0) {
      throw new ModelServiceError("Darkroom could not write the model download.");
    }
    offset += result.bytesWritten;
  }
}

function assertAllowedDownloadUrl(
  target: URL,
  entry: AiModelManifestEntry,
): void {
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    !entry.allowedRedirectHosts.includes(target.hostname)
  ) {
    throw new ModelServiceError("The model server redirected to an unapproved location.");
  }
}

function requestDownload(target: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      target,
      {
        method: "GET",
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": DOWNLOAD_USER_AGENT,
        },
        signal,
      },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
}

function discardResponse(response: IncomingMessage): void {
  response.on("error", () => undefined);
  response.resume();
}

async function openDownloadResponse(
  entry: AiModelManifestEntry,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  let target = new URL(entry.artifactUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertAllowedDownloadUrl(target, entry);
    const response = await requestDownload(target, signal);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      discardResponse(response);
      if (!location || redirects === MAX_REDIRECTS) {
        throw new ModelServiceError("The model server returned too many redirects.");
      }
      target = new URL(location, target);
      continue;
    }
    if (status < 200 || status >= 300) {
      discardResponse(response);
      throw new ModelServiceError(`The model server returned HTTP ${status}.`);
    }
    return response;
  }
  throw new ModelServiceError("The model server returned too many redirects.");
}

function safeDownloadError(error: unknown, signal: AbortSignal): ModelServiceError {
  if (signal.aborted) {
    return new ModelServiceError("Model download was cancelled.");
  }
  if (error instanceof ModelServiceError) {
    return error;
  }
  return new ModelServiceError("The model download failed.");
}

interface ModelArtifactPaths {
  readonly finalPath: string;
  readonly backupPath: string;
}

interface ReconciledModelArtifacts extends ModelArtifactPaths {
  readonly cleanupError?: ModelServiceError;
}

function modelArtifactPaths(directory: string, filename: string): ModelArtifactPaths {
  return {
    finalPath: path.join(directory, filename),
    backupPath: path.join(directory, `.${filename}.previous`),
  };
}

async function regularFileAt(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    const identity = await fs.lstat(filePath);
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new ModelServiceError("The cached model is not a regular file.");
    }
    return identity;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function staleTemporaryName(filename: string, name: string): boolean {
  return name.startsWith(`.${filename}.`) && name.endsWith(".tmp");
}

/** Reconcile files left by an interrupted model installation. */
export async function reconcileAiModelArtifacts(
  directory: string,
  filename: string,
  activeTemporaryPath?: string,
): Promise<ReconciledModelArtifacts> {
  const artifacts = modelArtifactPaths(directory, filename);
  const final = await regularFileAt(artifacts.finalPath);
  const backup = await regularFileAt(artifacts.backupPath);
  let cleanupError: ModelServiceError | undefined;

  if (!final && backup) {
    try {
      await fs.rename(artifacts.backupPath, artifacts.finalPath);
    } catch {
      throw new ModelServiceError("Darkroom could not restore the cached model.");
    }
  } else if (final && backup) {
    try {
      await fs.unlink(artifacts.backupPath);
    } catch {
      cleanupError = new ModelServiceError("Darkroom could not clean the previous model file.");
    }
  }

  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    throw new ModelServiceError("The private model cache is unavailable.");
  }
  for (const name of names) {
    if (!staleTemporaryName(filename, name)) {
      continue;
    }
    const temporaryPath = path.join(directory, name);
    if (temporaryPath === activeTemporaryPath) {
      continue;
    }
    await regularFileAt(temporaryPath);
    try {
      await fs.unlink(temporaryPath);
    } catch {
      cleanupError ??= new ModelServiceError("Darkroom could not clean a model download.");
    }
  }

  return cleanupError ? { ...artifacts, cleanupError } : artifacts;
}

/**
 * Windows does not replace an existing destination with rename(). Move the
 * old file aside first, then restore it if placing the verified download fails.
 */
export async function replaceVerifiedModel(
  directory: string,
  finalPath: string,
  temporaryPath: string,
): Promise<void> {
  const previousPath = modelArtifactPaths(
    directory,
    path.basename(finalPath),
  ).backupPath;
  let movedPrevious = false;
  let installed = false;

  try {
    const existing = await regularFileAt(finalPath);

    if (existing) {
      if (await regularFileAt(previousPath)) {
        throw new ModelServiceError("The private model cache is unavailable.");
      }
      await fs.rename(finalPath, previousPath);
      movedPrevious = true;
    }

    try {
      await fs.rename(temporaryPath, finalPath);
      installed = true;
    } catch (error) {
      if (movedPrevious) {
        try {
          await fs.rename(previousPath, finalPath);
          movedPrevious = false;
        } catch {
          throw new ModelServiceError("Darkroom could not restore the cached model.");
        }
      }
      throw error;
    }
  } finally {
    if (installed && movedPrevious) {
      try {
        await fs.unlink(previousPath);
      } catch {
        throw new ModelServiceError("Darkroom could not clean the previous model file.");
      }
    }
  }
}

export function createAiModelService(options: AiModelServiceOptions) {
  const modelDirectory = path.resolve(options.userDataPath, "models");
  const activeDownloads = new Map<AiModelId, ActiveDownload>();
  const lastErrors = new Map<AiModelId, string>();
  const cleanupErrors = new Map<AiModelId, string>();
  const recoveryTasks = new Map<AiModelId, Promise<ModelArtifactPaths>>();

  async function ensureModelDirectory(): Promise<string> {
    try {
      await fs.mkdir(modelDirectory, { recursive: true, mode: 0o700 });
      const identity = await fs.lstat(modelDirectory);
      if (!identity.isDirectory() || identity.isSymbolicLink()) {
        throw new ModelServiceError("The private model cache is unavailable.");
      }
      const canonicalDirectory = await fs.realpath(modelDirectory);
      const canonicalUserData = await fs.realpath(options.userDataPath);
      if (!isPathWithin(canonicalUserData, canonicalDirectory)) {
        throw new ModelServiceError("The private model cache is outside app storage.");
      }
      return canonicalDirectory;
    } catch (error) {
      if (error instanceof ModelServiceError) {
        throw error;
      }
      throw new ModelServiceError("The private model cache is unavailable.");
    }
  }

  async function reconcileModelArtifacts(
    modelId: AiModelId,
    includeActiveDownload = false,
  ): Promise<ModelArtifactPaths> {
    const entry = getAiModelManifestEntry(modelId);
    const directory = await ensureModelDirectory();
    const active = activeDownloads.get(modelId);
    if (active && !includeActiveDownload) {
      return modelArtifactPaths(directory, entry.filename);
    }

    const existingRecovery = recoveryTasks.get(modelId);
    if (existingRecovery) {
      return existingRecovery;
    }
    const recovery = reconcileAiModelArtifacts(
      directory,
      entry.filename,
      active?.temporaryPath,
    ).then((artifacts) => {
      if (artifacts.cleanupError) {
        cleanupErrors.set(modelId, artifacts.cleanupError.message);
      } else {
        cleanupErrors.delete(modelId);
      }
      return artifacts;
    });
    recoveryTasks.set(modelId, recovery);
    try {
      return await recovery;
    } finally {
      if (recoveryTasks.get(modelId) === recovery) {
        recoveryTasks.delete(modelId);
      }
    }
  }

  async function openVerifiedModel(modelId: AiModelId): Promise<VerifiedAiModelFile> {
    const entry = getAiModelManifestEntry(modelId);
    const { finalPath: cachePath } = await reconcileModelArtifacts(modelId);
    const directory = path.dirname(cachePath);
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(cachePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new ModelCacheMissingError();
      }
      throw new ModelServiceError("The cached model is unavailable.");
    }
    if (!isPathWithin(directory, canonicalPath)) {
      throw new ModelServiceError("The cached model is outside private app storage.");
    }

    const identity = await fs.lstat(cachePath);
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new ModelServiceError("The cached model is not a regular file.");
    }
    if (identity.size !== entry.disclosure.bytes) {
      throw new ModelServiceError("The cached model has the wrong size.");
    }

    let handle: FileHandle;
    try {
      handle = await fs.open(
        cachePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch {
      throw new ModelServiceError("The cached model is unavailable.");
    }

    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== identity.dev ||
        opened.ino !== identity.ino ||
        opened.size !== identity.size
      ) {
        throw new ModelServiceError("The cached model changed while it was opened.");
      }

      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < opened.size) {
        const result = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, opened.size - offset),
          offset,
        );
        if (result.bytesRead === 0) {
          throw new ModelServiceError("The cached model changed during verification.");
        }
        hash.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
      }

      const after = await handle.stat();
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        hash.digest("hex") !== entry.sha256
      ) {
        throw new ModelServiceError("The cached model failed verification.");
      }
      return { handle, bytes: opened.size };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async function isReady(modelId: AiModelId): Promise<boolean> {
    try {
      const verified = await openVerifiedModel(modelId);
      await verified.handle.close();
      return true;
    } catch (error) {
      if (error instanceof ModelCacheMissingError) {
        return false;
      }
      throw error;
    }
  }

  async function runDownload(
    modelId: AiModelId,
    active: ActiveDownload,
  ): Promise<void> {
    const entry = getAiModelManifestEntry(modelId);
    await reconcileModelArtifacts(modelId, true);
    try {
      if (await isReady(modelId)) {
        if (!cleanupErrors.has(modelId)) {
          lastErrors.delete(modelId);
        }
        return;
      }
    } catch {
      // A complete verified download may replace a damaged cache entry.
    }

    const directory = await ensureModelDirectory();
    const finalPath = path.join(directory, entry.filename);
    const temporaryPath = path.join(
      directory,
      `.${entry.filename}.${randomUUID()}.tmp`,
    );
    active.temporaryPath = temporaryPath;
    let temporary: FileHandle | null = null;

    try {
      temporary = await fs.open(temporaryPath, "wx", 0o600);
      const response = await openDownloadResponse(entry, active.controller.signal);
      const declaredLength = response.headers["content-length"];
      if (
        declaredLength !== undefined &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== entry.disclosure.bytes)
      ) {
        response.destroy();
        throw new ModelServiceError("The model server returned the wrong file size.");
      }

      const hash = createHash("sha256");
      active.receivedBytes = 0;
      options.onProgress({
        modelId,
        receivedBytes: 0,
        totalBytes: entry.disclosure.bytes,
      });

      for await (const value of response) {
        if (active.controller.signal.aborted) {
          response.destroy();
          throw new ModelServiceError("Model download was cancelled.");
        }
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const receivedBytes = active.receivedBytes + chunk.byteLength;
        if (receivedBytes > entry.disclosure.bytes) {
          response.destroy();
          throw new ModelServiceError("The model server returned too many bytes.");
        }
        await writeAll(temporary, chunk);
        hash.update(chunk);
        active.receivedBytes = receivedBytes;
        options.onProgress({
          modelId,
          receivedBytes,
          totalBytes: entry.disclosure.bytes,
        });
      }

      if (
        active.receivedBytes !== entry.disclosure.bytes ||
        hash.digest("hex") !== entry.sha256
      ) {
        throw new ModelServiceError("The downloaded model failed verification.");
      }

      await temporary.sync();
      await temporary.close();
      temporary = null;
      if (active.controller.signal.aborted) {
        throw new ModelServiceError("Model download was cancelled.");
      }
      const currentDirectory = await ensureModelDirectory();
      if (currentDirectory !== directory) {
        throw new ModelServiceError("The private model cache changed during download.");
      }
      await replaceVerifiedModel(directory, finalPath, temporaryPath);
      lastErrors.delete(modelId);
    } catch (error) {
      const safeError = safeDownloadError(error, active.controller.signal);
      if (!active.controller.signal.aborted) {
        lastErrors.set(modelId, safeError.message);
      }
      throw safeError;
    } finally {
      await temporary?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      active.temporaryPath = undefined;
    }
  }

  function downloadAiModel(modelId: AiModelId): Promise<void> {
    const existing = activeDownloads.get(modelId);
    if (existing) {
      return existing.promise;
    }
    lastErrors.delete(modelId);

    const active: ActiveDownload = {
      controller: new AbortController(),
      receivedBytes: 0,
      promise: Promise.resolve(),
    };
    active.promise = runDownload(modelId, active).finally(() => {
      if (activeDownloads.get(modelId) === active) {
        activeDownloads.delete(modelId);
      }
    });
    activeDownloads.set(modelId, active);
    return active.promise;
  }

  async function cancelAiModelDownload(modelId: AiModelId): Promise<void> {
    const active = activeDownloads.get(modelId);
    if (!active) {
      return;
    }
    active.controller.abort();
    await active.promise.catch(() => undefined);
  }

  async function removeAiModel(modelId: AiModelId): Promise<void> {
    await cancelAiModelDownload(modelId);
    const { finalPath, backupPath } = await reconcileModelArtifacts(modelId);
    try {
      for (const artifactPath of [backupPath, finalPath]) {
        if (await regularFileAt(artifactPath)) {
          await fs.unlink(artifactPath);
        }
      }
    } catch (error) {
      if (error instanceof ModelServiceError) {
        throw error;
      }
      if (!isNodeError(error, "ENOENT")) {
        throw new ModelServiceError("Darkroom could not remove the cached model.");
      }
    }
    lastErrors.delete(modelId);
    cleanupErrors.delete(modelId);
  }

  async function getAiModelState(modelId: AiModelId): Promise<AiModelState> {
    const entry = getAiModelManifestEntry(modelId);
    const active = activeDownloads.get(modelId);
    if (active) {
      return {
        status: "downloading",
        model: entry.disclosure,
        receivedBytes: active.receivedBytes,
        totalBytes: entry.disclosure.bytes,
      };
    }

    try {
      if (await isReady(modelId)) {
        const cleanupError = cleanupErrors.get(modelId);
        if (cleanupError) {
          return {
            status: "error",
            model: entry.disclosure,
            message: cleanupError,
          };
        }
        lastErrors.delete(modelId);
        return { status: "ready", model: entry.disclosure };
      }
    } catch (error) {
      const message =
        error instanceof ModelServiceError
          ? error.message
          : "The cached model is unavailable.";
      return { status: "error", model: entry.disclosure, message };
    }

    const lastError = lastErrors.get(modelId);
    return lastError
      ? { status: "error", model: entry.disclosure, message: lastError }
      : { status: "missing", model: entry.disclosure };
  }

  return {
    getAiModelState,
    downloadAiModel,
    cancelAiModelDownload,
    removeAiModel,
    openVerifiedModel,
  };
}

export type AiModelService = ReturnType<typeof createAiModelService>;
