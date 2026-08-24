import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseRelativePath } from "../lib/catalog/runtime.ts";
import type { AssetId, CatalogId, RootId } from "../lib/catalog/ids.ts";

const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;

export interface NativeAssetLocation {
  readonly catalogId: CatalogId;
  readonly assetId: AssetId;
  readonly rootId: RootId;
  readonly canonicalRootPath: string;
  readonly relativePath: string;
}

export interface NativeAssetStat {
  readonly size: number;
  readonly lastModified: number;
}

export class NativeAssetAccessError extends Error {
  constructor(message = "Asset is unavailable.") {
    super(message);
    this.name = "NativeAssetAccessError";
  }
}

function assertContained(rootPath: string, candidatePath: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === "" ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new NativeAssetAccessError("Asset path is outside its root.");
  }
}

async function assertNoSymlinkPath(rootPath: string, candidatePath: string): Promise<void> {
  try {
    const relative = path.relative(rootPath, candidatePath);
    assertContained(rootPath, candidatePath);
    const rootStat = await fs.lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new NativeAssetAccessError("Asset root changed.");
    }
    let currentPath = rootPath;
    for (const segment of relative.split(path.sep)) {
      currentPath = path.join(currentPath, segment);
      const stat = await fs.lstat(currentPath);
      if (stat.isSymbolicLink()) {
        throw new NativeAssetAccessError("Symlinked asset paths are not allowed.");
      }
    }
  } catch (error) {
    if (error instanceof NativeAssetAccessError) throw error;
    throw new NativeAssetAccessError("Asset path is unavailable.");
  }
}

async function verifiedRootPath(canonicalRootPath: string): Promise<string> {
  try {
    const expectedRootPath = path.resolve(canonicalRootPath);
    if (expectedRootPath !== canonicalRootPath) {
      throw new NativeAssetAccessError("Asset root is not canonical.");
    }
    const rootPath = await fs.realpath(expectedRootPath);
    if (rootPath !== expectedRootPath) {
      throw new NativeAssetAccessError("Asset root is unavailable.");
    }
    const rootStat = await fs.lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new NativeAssetAccessError("Asset root is unavailable.");
    }
    return rootPath;
  } catch (error) {
    if (error instanceof NativeAssetAccessError) throw error;
    throw new NativeAssetAccessError("Asset root is unavailable.");
  }
}

function candidatePath(rootPath: string, relativePath: string): string {
  const parsedRelativePath = parseRelativePath(relativePath);
  const candidate = path.resolve(rootPath, ...parsedRelativePath.split("/"));
  assertContained(rootPath, candidate);
  return candidate;
}

function sidecarRelativePath(relativePath: string): string {
  const parsed = path.posix.parse(parseRelativePath(relativePath));
  const baseName = parsed.ext.toLowerCase() === ".nef" ? parsed.name : parsed.base;
  return parsed.dir === "" ? `${baseName}.xmp` : `${parsed.dir}/${baseName}.xmp`;
}

function sameFile(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openVerified(location: NativeAssetLocation): Promise<fs.FileHandle> {
  const relativePath = parseRelativePath(location.relativePath);
  const rootPath = await verifiedRootPath(location.canonicalRootPath);
  const absolutePath = candidatePath(rootPath, relativePath);
  await assertNoSymlinkPath(rootPath, absolutePath);
  const before = await fs.lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new NativeAssetAccessError("Asset is not a regular file.");
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absolutePath, flags);
  } catch {
    throw new NativeAssetAccessError();
  }
  try {
    const after = await handle.stat();
    if (!after.isFile() || !sameFile(before, after)) {
      throw new NativeAssetAccessError("Asset changed while it was opened.");
    }
    if (await fs.realpath(location.canonicalRootPath) !== location.canonicalRootPath) {
      throw new NativeAssetAccessError("Asset root changed while it was opened.");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof NativeAssetAccessError) throw error;
    throw new NativeAssetAccessError();
  }
}

async function withHandle<T>(
  location: NativeAssetLocation,
  operation: (handle: fs.FileHandle) => Promise<T>,
): Promise<T> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await openVerified(location);
    return await operation(handle);
  } catch (error) {
    if (error instanceof NativeAssetAccessError) throw error;
    throw new NativeAssetAccessError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class NativeAssetAccess {
  async read(location: NativeAssetLocation): Promise<Uint8Array> {
    return withHandle(location, async (handle) => {
      const buffer = await handle.readFile();
      return new Uint8Array(buffer);
    });
  }

  async readHead(location: NativeAssetLocation, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new NativeAssetAccessError("Asset head size is invalid.");
    }
    return withHandle(location, async (handle) => {
      const stat = await handle.stat();
      const length = Math.min(maxBytes, stat.size);
      const buffer = Buffer.alloc(length);
      if (length > 0) {
        await handle.read(buffer, 0, length, 0);
      }
      return new Uint8Array(buffer);
    });
  }

  async stat(location: NativeAssetLocation): Promise<NativeAssetStat> {
    return withHandle(location, async (handle) => {
      const stat = await handle.stat();
      return { size: stat.size, lastModified: stat.mtimeMs };
    });
  }

  async resolvePath(location: NativeAssetLocation): Promise<string> {
    const rootPath = await verifiedRootPath(location.canonicalRootPath);
    const absolutePath = candidatePath(rootPath, location.relativePath);
    await withHandle(location, async (handle) => {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new NativeAssetAccessError("Asset is not a regular file.");
    });
    return absolutePath;
  }

  async readSidecar(location: NativeAssetLocation): Promise<{ readonly contents: string; readonly lastModified: number } | null> {
    await withHandle(location, async () => undefined);
    const rootPath = await verifiedRootPath(location.canonicalRootPath);
    const relativePath = sidecarRelativePath(location.relativePath);
    const absolutePath = candidatePath(rootPath, relativePath);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new NativeAssetAccessError("Sidecar is unavailable.");
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new NativeAssetAccessError("Sidecar is not a regular file.");
    }
    if (stat.size > MAX_SIDECAR_BYTES) {
      throw new NativeAssetAccessError("Sidecar is too large.");
    }
    const sidecarLocation: NativeAssetLocation = { ...location, relativePath };
    return withHandle(sidecarLocation, async (handle) => {
      const current = await handle.stat();
      if (current.size > MAX_SIDECAR_BYTES) throw new NativeAssetAccessError("Sidecar is too large.");
      const contents = (await handle.readFile()).toString("utf8");
      return { contents, lastModified: current.mtimeMs };
    });
  }

  async writeSidecar(
    location: NativeAssetLocation,
    contents: string | null,
    expectedLastModified?: number | null,
  ): Promise<void> {
    if (contents !== null && Buffer.byteLength(contents, "utf8") > MAX_SIDECAR_BYTES) {
      throw new NativeAssetAccessError("Sidecar is too large.");
    }
    await withHandle(location, async () => undefined);
    const rootPath = await verifiedRootPath(location.canonicalRootPath);
    const relativePath = sidecarRelativePath(location.relativePath);
    const absolutePath = candidatePath(rootPath, relativePath);
    const parentPath = path.dirname(absolutePath);
    if (parentPath !== rootPath) await assertNoSymlinkPath(rootPath, parentPath);
    await assertSidecarVersion(absolutePath, expectedLastModified);
    if (contents === null) {
      await fs.unlink(absolutePath).catch((error: unknown) => {
        if (!isNotFound(error)) throw new NativeAssetAccessError("Could not remove sidecar.");
      });
      return;
    }
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await verifiedRootPath(location.canonicalRootPath);
      await assertSidecarVersion(absolutePath, expectedLastModified);
      await fs.rename(temporaryPath, absolutePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof NativeAssetAccessError) throw error;
      throw new NativeAssetAccessError("Could not write sidecar.");
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function assertSidecarVersion(
  absolutePath: string,
  expectedLastModified: number | null | undefined,
): Promise<void> {
  if (expectedLastModified === undefined) {
    await assertExistingRegularSidecar(absolutePath);
    return;
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new NativeAssetAccessError("Sidecar is not a regular file.");
    if (expectedLastModified === null || stat.mtimeMs !== expectedLastModified) {
      throw new NativeAssetAccessError("Sidecar changed after it was read. Reload before saving keywords.");
    }
  } catch (error) {
    if (isNotFound(error) && expectedLastModified === null) return;
    if (isNotFound(error)) throw new NativeAssetAccessError("Sidecar changed after it was read. Reload before saving keywords.");
    if (error instanceof NativeAssetAccessError) throw error;
    throw new NativeAssetAccessError("Sidecar is unavailable.");
  }
}

async function assertExistingRegularSidecar(absolutePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new NativeAssetAccessError("Sidecar is not a regular file.");
  } catch (error) {
    if (isNotFound(error)) return;
    if (error instanceof NativeAssetAccessError) throw error;
    throw new NativeAssetAccessError("Sidecar is unavailable.");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
