import fsp from "node:fs/promises";
import path from "node:path";
import {
  parseCatalogId,
  parseRootId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import { parseRelativePath, parseSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import type { DirtyScope } from "../lib/catalog/watch.ts";
import { getFormatCapabilityForFileName } from "../lib/formats/index.ts";
import {
  normalizeAutoImportRelativePath,
  type AutoImportFileObservation,
} from "../lib/import/auto-import.ts";
import type { FileObservation, ImportSource } from "../lib/import/domain.ts";
import {
  fingerprintNoFollowFile,
  observeNoFollowFile,
  type FingerprintResult,
} from "./catalog-fingerprint-service.ts";
import type {
  CatalogImportDestinationObservationRequest,
  CatalogImportPathRequest,
  CatalogImportSourceRequest,
} from "./catalog-import-adapter.ts";
import type {
  CatalogAutoImportCandidatePage,
  CatalogAutoImportMonitorCandidate,
  CatalogAutoImportMonitorPorts,
} from "./catalog-auto-import-monitor.ts";
import type { CatalogAutoImportStatusRule } from "./catalog-auto-import-controller.ts";
import type { ResolvedTransactionPaths } from "./file-transaction-service.ts";

const DEFAULT_MAX_CANDIDATES = 1_000;
const DEFAULT_MAX_DIRECTORIES = 10_000;
const MAX_PAGED_CANDIDATES = 10_000;
const MAX_ENUMERATION_CANDIDATES = 100_000;
const MAX_ENUMERATION_PAGES = 16;

export interface CatalogAutoImportNativeRootResolver {
  readonly resolveRoot: (input: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
    readonly rootId: RootId;
  }) => Promise<unknown>;
}

export interface CatalogAutoImportNativeFilesOptions {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly roots: CatalogAutoImportNativeRootResolver;
  readonly assertCurrentSession: () => void | Promise<void>;
  readonly maxCandidates?: number;
  readonly maxDirectories?: number;
  readonly maxEnumerationCandidates?: number;
}

export class CatalogAutoImportNativeFilesError extends Error {
  public constructor(message = "Auto Import native file access is unavailable.") {
    super(message);
    this.name = "CatalogAutoImportNativeFilesError";
  }
}

interface DirectoryWork {
  readonly absolutePath: string;
  readonly relativePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value !== path.normalize(value) ||
    value.includes("\0") ||
    value === path.parse(value).root
  ) {
    throw new CatalogAutoImportNativeFilesError(`${label} is invalid.`);
  }
  return value;
}

function positiveBound(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new CatalogAutoImportNativeFilesError(`${label} is invalid.`);
  }
  return result;
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  return error.code;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CatalogAutoImportNativeFilesError("Auto Import native operation was cancelled.");
}

function assertContained(rootPath: string, candidatePath: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new CatalogAutoImportNativeFilesError("Auto Import path is outside the active root.");
  }
}

function absolutePathFor(rootPath: string, relativePath: string): string {
  const parsed = parseRelativePath(relativePath);
  const candidate = path.normalize(path.join(rootPath, ...parsed.split("/")));
  assertContained(rootPath, candidate);
  return candidate;
}

function pathIsWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function sidecarRelativePath(relativePath: string): string {
  const parsed = path.posix.parse(parseRelativePath(relativePath));
  const baseName = `${parsed.name}.xmp`;
  return parsed.dir === "" ? baseName : `${parsed.dir}/${baseName}`;
}

function fileFormat(relativePath: string): string {
  const format = getFormatCapabilityForFileName(relativePath);
  if (format === null || format.recognition !== "supported") {
    throw new CatalogAutoImportNativeFilesError("Auto Import file format is unavailable.");
  }
  return format.id;
}

function observationWithoutTime(observation: FileObservation): {
  readonly size: number;
  readonly modifiedAt: number;
  readonly localFileId: string | null;
} {
  return {
    size: observation.size,
    modifiedAt: observation.modifiedAt,
    localFileId: observation.localFileId,
  };
}

async function assertCanonicalDirectory(directoryPath: string): Promise<void> {
  const stat = await fsp.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CatalogAutoImportNativeFilesError("Auto Import root is unavailable.");
  }
  if (await fsp.realpath(directoryPath) !== directoryPath) {
    throw new CatalogAutoImportNativeFilesError("Auto Import root is not canonical.");
  }
}

async function assertNoSymlinkComponents(rootPath: string, targetPath: string): Promise<void> {
  assertContained(rootPath, targetPath);
  let current = rootPath;
  const relative = path.relative(rootPath, targetPath);
  for (const component of relative.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, component);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new CatalogAutoImportNativeFilesError("Auto Import path contains a symbolic link.");
      }
    } catch (error) {
      if (error instanceof CatalogAutoImportNativeFilesError) throw error;
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

async function inspectXmp(rootPath: string, relativePath: string): Promise<ImportSource["xmpState"]> {
  const xmpPath = absolutePathFor(rootPath, sidecarRelativePath(relativePath));
  try {
    const stat = await fsp.lstat(xmpPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return "unreadable";
    await assertNoSymlinkComponents(rootPath, xmpPath);
    return "present";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "absent";
    if (error instanceof CatalogAutoImportNativeFilesError) return "unreadable";
    return "unreadable";
  }
}

async function observeFile(filePath: string): Promise<FileObservation> {
  try {
    return await observeNoFollowFile(filePath);
  } catch {
    throw new CatalogAutoImportNativeFilesError("Auto Import file could not be observed.");
  }
}

function safeFingerprintResult(result: FingerprintResult): FingerprintResult {
  return result.reason === null
    ? result
    : { ...result, reason: "Auto Import file could not be fingerprinted." };
}

export class CatalogAutoImportNativeFiles implements CatalogAutoImportMonitorPorts {
  private readonly catalogId: CatalogId;
  private readonly sessionId: SessionId;
  private readonly roots: CatalogAutoImportNativeRootResolver;
  private readonly assertCurrentSession: () => void | Promise<void>;
  private readonly maxCandidates: number;
  private readonly maxDirectories: number;
  private readonly maxEnumerationCandidates: number;
  private readonly ingressPaths = new Map<RootId, string>();
  private readonly enumerationPages = new Map<string, {
    readonly candidates: readonly CatalogAutoImportMonitorCandidate[];
    readonly truncated: boolean;
    offset: number;
  }>();

  public constructor(options: CatalogAutoImportNativeFilesOptions) {
    this.catalogId = parseCatalogId(options.catalogId);
    this.sessionId = parseSessionId(options.sessionId);
    this.roots = options.roots;
    this.assertCurrentSession = options.assertCurrentSession;
    this.maxCandidates = positiveBound(options.maxCandidates, DEFAULT_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES, "Auto Import candidate bound");
    this.maxDirectories = positiveBound(options.maxDirectories, DEFAULT_MAX_DIRECTORIES, DEFAULT_MAX_DIRECTORIES, "Auto Import directory bound");
    this.maxEnumerationCandidates = positiveBound(options.maxEnumerationCandidates, MAX_PAGED_CANDIDATES, MAX_ENUMERATION_CANDIDATES, "Auto Import enumeration bound");
  }

  public async listCandidates(
    rule: CatalogAutoImportStatusRule,
    scopes: readonly DirtyScope[],
    signal: AbortSignal,
    limit = this.maxCandidates,
  ): Promise<CatalogAutoImportCandidatePage> {
    return this.nativeCall(async () => {
      throwIfAborted(signal);
      const parsedRule = this.parseRule(rule);
      const boundedLimit = Math.min(positiveBound(limit, this.maxCandidates, this.maxCandidates, "Auto Import candidate limit"), this.maxCandidates);
      const rootPath = await this.rootPath(parsedRule.ingressRootId);
      this.ingressPaths.set(parsedRule.ingressRootId, parsedRule.ingressRelativePath);
      const scopeKey = scopes.map((scope) => scope.kind === "root" ? "root" : `path:${scope.relativePath}`).sort().join("|");
      const pageKey = `${parsedRule.ingressRootId}\u0000${scopeKey}\u0000${boundedLimit}`;
      const cachedPage = this.enumerationPages.get(pageKey);
      if (cachedPage !== undefined) return this.nextCandidatePage(pageKey, cachedPage, boundedLimit);
      const candidates = new Map<string, CatalogAutoImportMonitorCandidate>();
      let overflowed = false;
      const gatherLimit = Math.max(this.maxEnumerationCandidates, boundedLimit);
      const work: DirectoryWork[] = [];
      for (const scope of scopes) {
        throwIfAborted(signal);
        const relativePath = scope.kind === "root" ? parsedRule.ingressRelativePath : parseRelativePath(scope.relativePath);
        if (!pathIsWithin(parsedRule.ingressRelativePath, relativePath)) continue;
        const absolutePath = absolutePathFor(rootPath, relativePath);
        await assertNoSymlinkComponents(rootPath, absolutePath);
        const stat = await fsp.lstat(absolutePath).catch((error: unknown) => {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        });
        if (stat === null) continue;
        if (stat.isSymbolicLink()) throw new CatalogAutoImportNativeFilesError("Auto Import path contains a symbolic link.");
        if (stat.isFile()) {
          if (getFormatCapabilityForFileName(relativePath)?.recognition === "supported") {
            candidates.set(`${parsedRule.ingressRootId}\u0000${relativePath}`, {
              rootId: parsedRule.ingressRootId,
              relativePath,
            });
            if (candidates.size > gatherLimit) {
              overflowed = true;
              break;
            }
          }
          continue;
        }
        if (!stat.isDirectory()) continue;
        work.push({ absolutePath, relativePath });
      }
      let directoriesVisited = 0;
      for (let index = 0; index < work.length && !overflowed; index += 1) {
        throwIfAborted(signal);
        const directory = work[index]!;
        directoriesVisited += 1;
        if (directoriesVisited > this.maxDirectories) {
          overflowed = true;
          break;
        }
        await assertCanonicalDirectory(directory.absolutePath);
        const entries = await fsp.readdir(directory.absolutePath, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          throwIfAborted(signal);
          if (entry.name.startsWith(".")) continue;
          const childRelativePath = parseRelativePath(`${directory.relativePath}/${entry.name}`);
          const childAbsolutePath = absolutePathFor(rootPath, childRelativePath);
          await assertNoSymlinkComponents(rootPath, childAbsolutePath);
          if (entry.isSymbolicLink()) {
            throw new CatalogAutoImportNativeFilesError("Auto Import path contains a symbolic link.");
          }
          if (entry.isDirectory()) {
            work.push({ absolutePath: childAbsolutePath, relativePath: childRelativePath });
          } else if (entry.isFile() && getFormatCapabilityForFileName(entry.name)?.recognition === "supported") {
            candidates.set(`${parsedRule.ingressRootId}\u0000${childRelativePath}`, {
              rootId: parsedRule.ingressRootId,
              relativePath: childRelativePath,
            });
            if (candidates.size > gatherLimit) {
              overflowed = true;
              break;
            }
          }
        }
      }
      const ordered = [...candidates.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const page = { candidates: ordered, truncated: overflowed, offset: 0 };
      if (this.enumerationPages.size >= MAX_ENUMERATION_PAGES) {
        const oldest = this.enumerationPages.keys().next().value;
        if (typeof oldest === "string") this.enumerationPages.delete(oldest);
      }
      this.enumerationPages.set(pageKey, page);
      return this.nextCandidatePage(pageKey, page, boundedLimit);
    });
  }

  private nextCandidatePage(
    pageKey: string,
    page: { readonly candidates: readonly CatalogAutoImportMonitorCandidate[]; readonly truncated: boolean; offset: number },
    limit: number,
  ): CatalogAutoImportCandidatePage {
    if (page.truncated && page.offset >= page.candidates.length) {
      this.enumerationPages.delete(pageKey);
      return { candidates: [], overflowed: false, degraded: true };
    }
    const candidates = page.candidates.slice(page.offset, page.offset + limit);
    page.offset += candidates.length;
    const hasMore = page.offset < page.candidates.length || page.truncated;
    if (!hasMore && !page.truncated) this.enumerationPages.delete(pageKey);
    return { candidates, overflowed: hasMore };
  }

  public async observe(
    rootId: RootId,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<AutoImportFileObservation> {
    return this.nativeCall(async () => {
      throwIfAborted(signal);
      const parsedRootId = parseRootId(rootId);
      const parsedPath = normalizeAutoImportRelativePath(parseRelativePath(relativePath));
      const ingressPath = this.ingressPaths.get(parsedRootId);
      if (ingressPath === undefined || !pathIsWithin(ingressPath, parsedPath)) {
        throw new CatalogAutoImportNativeFilesError("Auto Import path is outside the configured ingress.");
      }
      const rootPath = await this.rootPath(parsedRootId);
      const absolutePath = absolutePathFor(rootPath, parsedPath);
      await assertNoSymlinkComponents(rootPath, absolutePath);
      fileFormat(parsedPath);
      const observation = await observeFile(absolutePath);
      return { relativePath: parsedPath, observation, readable: true } satisfies AutoImportFileObservation;
    });
  }

  public async observeSource(request: CatalogImportSourceRequest): Promise<ImportSource> {
    return this.nativeCall(async () => {
      this.assertBinding(request.catalogId, request.sessionId);
      const rootPath = await this.rootPath(request.rootId);
      const relativePath = normalizeAutoImportRelativePath(parseRelativePath(request.relativePath));
      const absolutePath = absolutePathFor(rootPath, relativePath);
      await assertNoSymlinkComponents(rootPath, absolutePath);
      const observation = await observeFile(absolutePath);
      return {
        rootId: request.rootId,
        relativePath,
        observation,
        xmpState: await inspectXmp(rootPath, relativePath),
        formatId: fileFormat(relativePath),
      } satisfies ImportSource;
    });
  }

  public async observeDestination(request: CatalogImportDestinationObservationRequest): Promise<unknown> {
    return this.nativeCall(async () => {
      this.assertBinding(request.catalogId, request.sessionId);
      const rootPath = await this.rootPath(request.rootId);
      const relativePath = normalizeAutoImportRelativePath(parseRelativePath(request.relativePath));
      const absolutePath = absolutePathFor(rootPath, relativePath);
      await assertNoSymlinkComponents(rootPath, absolutePath);
      return { observation: await observeFile(absolutePath), formatId: fileFormat(relativePath) };
    });
  }

  public async resolvePaths(request: CatalogImportPathRequest): Promise<ResolvedTransactionPaths> {
    return this.nativeCall(async () => {
      this.assertBinding(request.catalogId, request.sessionId);
      if (request.action !== "copy") throw new CatalogAutoImportNativeFilesError("Auto Import supports Copy only.");
      const sourceRootPath = await this.rootPath(request.sourceRootId);
      const destinationRootPath = await this.rootPath(request.destinationRootId);
      const sourceRelativePath = normalizeAutoImportRelativePath(parseRelativePath(request.sourceRelativePath));
      const destinationRelativePath = normalizeAutoImportRelativePath(parseRelativePath(request.destinationRelativePath));
      const sourcePath = absolutePathFor(sourceRootPath, sourceRelativePath);
      const destinationPath = absolutePathFor(destinationRootPath, destinationRelativePath);
      await assertNoSymlinkComponents(sourceRootPath, sourcePath);
      await this.assertSafeParent(destinationRootPath, destinationPath);
      await this.assertSafeTarget(destinationRootPath, destinationPath);
      const xmp = request.xmpDestinationRelativePath === null
        ? null
        : await this.resolveXmp(sourceRootPath, sourceRelativePath, destinationRootPath, request.xmpDestinationRelativePath);
      return { sourcePath, destinationPath, xmp } satisfies ResolvedTransactionPaths;
    });
  }

  public async destinationExists(rootId: RootId, relativePath: string): Promise<boolean> {
    return this.nativeCall(async () => {
      const rootPath = await this.rootPath(parseRootId(rootId));
      const absolutePath = absolutePathFor(rootPath, parseRelativePath(relativePath));
      await assertNoSymlinkComponents(rootPath, absolutePath);
      try {
        const stat = await fsp.lstat(absolutePath);
        if (stat.isSymbolicLink()) throw new CatalogAutoImportNativeFilesError("Auto Import destination contains a symbolic link.");
        return stat.isFile() || stat.isDirectory();
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    });
  }

  public async fingerprint(
    rootId: RootId,
    relativePath: string,
    isCancelled?: () => boolean,
  ): Promise<FingerprintResult> {
    return this.nativeCall(async () => {
      const rootPath = await this.rootPath(parseRootId(rootId));
      const parsedPath = normalizeAutoImportRelativePath(parseRelativePath(relativePath));
      const absolutePath = absolutePathFor(rootPath, parsedPath);
      await assertNoSymlinkComponents(rootPath, absolutePath);
      fileFormat(parsedPath);
      return safeFingerprintResult(await fingerprintNoFollowFile(absolutePath, isCancelled));
    });
  }

  private parseRule(rule: CatalogAutoImportStatusRule): CatalogAutoImportStatusRule {
    const ingressRootId = parseRootId(rule.ingressRootId);
    const ingressRelativePath = normalizeAutoImportRelativePath(parseRelativePath(rule.ingressRelativePath));
    if (rule.destinationConflictPolicy === "replace") {
      throw new CatalogAutoImportNativeFilesError("Auto Import Replace conflicts are unavailable.");
    }
    return { ...rule, ingressRootId, ingressRelativePath };
  }

  private assertBinding(catalogId: CatalogId, sessionId: SessionId): void {
    if (parseCatalogId(catalogId) !== this.catalogId || parseSessionId(sessionId) !== this.sessionId) {
      throw new CatalogAutoImportNativeFilesError("Auto Import request does not belong to the active session.");
    }
  }

  private async rootPath(rootId: RootId): Promise<string> {
    const parsedRootId = parseRootId(rootId);
    const value = await this.roots.resolveRoot({ catalogId: this.catalogId, sessionId: this.sessionId, rootId: parsedRootId });
    if (!isRecord(value)) throw new CatalogAutoImportNativeFilesError("Auto Import root is invalid.");
    const catalogId = value.catalogId === undefined ? this.catalogId : parseCatalogId(value.catalogId);
    const returnedRootId = parseRootId(value.rootId);
    if (catalogId !== this.catalogId || returnedRootId !== parsedRootId) {
      throw new CatalogAutoImportNativeFilesError("Auto Import root identity is invalid.");
    }
    const canonicalPath = normalizedAbsolutePath(value.canonicalPath, "Auto Import root path");
    await assertCanonicalDirectory(canonicalPath);
    return canonicalPath;
  }

  private async assertSafeParent(rootPath: string, targetPath: string): Promise<void> {
    const parent = path.dirname(targetPath);
    assertContained(rootPath, parent);
    await assertNoSymlinkComponents(rootPath, parent);
    let current = rootPath;
    const relative = path.relative(rootPath, parent);
    for (const component of relative.split(path.sep).filter((part) => part.length > 0)) {
      current = path.join(current, component);
      try {
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new CatalogAutoImportNativeFilesError("Auto Import destination parent is unsafe.");
        }
      } catch (error) {
        if (error instanceof CatalogAutoImportNativeFilesError) throw error;
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
    }
  }

  private async assertSafeTarget(rootPath: string, targetPath: string): Promise<void> {
    try {
      const stat = await fsp.lstat(targetPath);
      if (stat.isSymbolicLink()) throw new CatalogAutoImportNativeFilesError("Auto Import destination contains a symbolic link.");
    } catch (error) {
      if (error instanceof CatalogAutoImportNativeFilesError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await assertNoSymlinkComponents(rootPath, targetPath);
  }

  private async resolveXmp(
    sourceRootPath: string,
    sourceRelativePath: string,
    destinationRootPath: string,
    destinationRelativePath: string,
  ): Promise<ResolvedTransactionPaths["xmp"]> {
    const sourceRelative = sidecarRelativePath(sourceRelativePath);
    const sourcePath = absolutePathFor(sourceRootPath, sourceRelative);
    const destinationPath = absolutePathFor(destinationRootPath, parseRelativePath(destinationRelativePath));
    await assertNoSymlinkComponents(sourceRootPath, sourcePath);
    await this.assertSafeParent(destinationRootPath, destinationPath);
    const sourceObservation = await observeFile(sourcePath);
    return {
      sourcePath,
      destinationPath,
      sourceObservation: observationWithoutTime(sourceObservation),
    };
  }

  private async nativeCall<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertCurrentSession();
    try {
      const value = await operation();
      await this.assertCurrentSession();
      return value;
    } catch (error) {
      await this.assertCurrentSession();
      if (error instanceof CatalogAutoImportNativeFilesError) throw error;
      throw new CatalogAutoImportNativeFilesError();
    }
  }
}
