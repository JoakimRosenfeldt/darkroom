import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_EXPORT_SUFFIX,
  type ExportEncodeOptions,
  type ExportEncodeResult,
  type ExportFormatDescriptor,
  type ExportFormatId,
  type ExportPixelPayload,
  type ExportPixels,
} from "../lib/export/types";

export type {
  ExportConflictBehavior,
  ExportEncodeOptions,
  ExportEncodeResult,
  ExportFormatDescriptor,
  ExportFormatId,
  ExportPixelPayload,
  ExportPixels,
  ExportSizeOptions,
} from "../lib/export/types";
import { scanFolderTree } from "./fs-service";
export type ExportResult = ExportEncodeResult;

export interface ExportDialog {
  showSaveDialog(options: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog(options: {
    title?: string;
    properties: Array<"openDirectory">;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface ExportDestinationRequest {
  count: number;
  format: ExportFormatId;
  suggestedFilename: string;
  /** Renderer-selected sources, validated against the main-process scan. */
  sources?: Array<{
    rootPath: string;
    relativePath: string;
  }>;
}

export interface ExportFinalizeResult {
  revealToken: string | null;
  outputPath: string | null;
}

export interface ApprovedExportSource {
  path: string;
  directory: string;
  basename: string;
  device?: number;
  inode?: number;
}

const MAX_EXPORT_PIXELS = 50_000_000;
const MAX_EXPORT_EDGE = 100_000;
const MAX_FILENAME_LENGTH = 240;
const MAX_RENAME_ATTEMPTS = 999;
const MAX_DESTINATIONS = 64;
const MAX_REVEAL_CAPABILITIES = 64;
const MAX_PROVENANCE_RECORDS = 4096;
const DESTINATION_IDLE_TTL_MS = 15 * 60 * 1000;
const DESTINATION_FINALIZE_GRACE_MS = 30 * 60 * 1000;
const REVEAL_IDLE_TTL_MS = 30 * 60 * 1000;

const FORMAT_DEFINITIONS: readonly ExportFormatDescriptor[] = [
  {
    id: "jpeg",
    label: "JPEG",
    extensions: ["jpg", "jpeg"],
    supportsQuality: true,
    supportsLossless: false,
    defaultQuality: 90,
  },
  {
    id: "png",
    label: "PNG",
    extensions: ["png"],
    supportsQuality: false,
    supportsLossless: false,
  },
  {
    id: "webp",
    label: "WebP",
    extensions: ["webp"],
    supportsQuality: true,
    supportsLossless: true,
    defaultQuality: 85,
  },
  {
    id: "avif",
    label: "AVIF",
    extensions: ["avif"],
    supportsQuality: true,
    supportsLossless: false,
    defaultQuality: 55,
  },
  {
    id: "tiff",
    label: "TIFF",
    extensions: ["tif", "tiff"],
    supportsQuality: false,
    supportsLossless: false,
  },
];

type SharpModule = typeof import("sharp");
type SharpFactory = SharpModule;

let sharpModulePromise: Promise<SharpFactory> | null = null;

async function loadSharp(): Promise<SharpFactory> {
  sharpModulePromise ??= import("sharp").then((module) => {
    const factory = (module as unknown as { default?: SharpFactory }).default ?? module;
    return factory as SharpFactory;
  });
  return sharpModulePromise;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isAbsolutePathWithin(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizedPathKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isWithinRoot(root: string, candidate: string): boolean {
  return isAbsolutePathWithin(root, path.resolve(candidate));
}

function statIdentity(stat: {
  dev?: number;
  ino?: number;
}): Pick<ApprovedExportSource, "device" | "inode"> {
  const identity: Pick<ApprovedExportSource, "device" | "inode"> = {};
  if (typeof stat.dev === "number" && Number.isFinite(stat.dev)) {
    identity.device = stat.dev;
  }
  if (typeof stat.ino === "number" && Number.isFinite(stat.ino)) {
    identity.inode = stat.ino;
  }
  return identity;
}

function sameFileIdentity(
  left: Pick<ApprovedExportSource, "device" | "inode">,
  right: Pick<ApprovedExportSource, "device" | "inode">,
): boolean {
  return (
    left.device !== undefined &&
    left.inode !== undefined &&
    right.device !== undefined &&
    right.inode !== undefined &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function assertPixelDimensions(width: unknown, height: unknown): {
  width: number;
  height: number;
} {
  const validWidth = assertPositiveInteger(width, "Export width");
  const validHeight = assertPositiveInteger(height, "Export height");
  if (validWidth > MAX_EXPORT_EDGE || validHeight > MAX_EXPORT_EDGE) {
    throw new Error("Export dimensions are too large.");
  }
  if (validWidth * validHeight > MAX_EXPORT_PIXELS) {
    throw new Error("This edit exceeds the 50 megapixel export limit.");
  }
  return { width: validWidth, height: validHeight };
}

function toBuffer(pixels: ArrayBuffer | Uint8Array): Buffer {
  if (pixels instanceof Uint8Array) {
    return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  }
  if (pixels instanceof ArrayBuffer) {
    return Buffer.from(pixels);
  }
  throw new Error("Export pixels must be an ArrayBuffer.");
}

function normalizePixels(
  payload: ExportPixels,
  options: ExportEncodeOptions,
): { buffer: Buffer; width: number; height: number } {
  const isPayload =
    typeof payload === "object" &&
    payload !== null &&
    "pixels" in payload &&
    "width" in payload &&
    "height" in payload;
  const pixels = isPayload
    ? (payload as ExportPixelPayload).pixels
    : payload;
  const width = isPayload
    ? (payload as ExportPixelPayload).width
    : options.width;
  const height = isPayload
    ? (payload as ExportPixelPayload).height
    : options.height;
  const dimensions = assertPixelDimensions(width, height);
  const buffer = toBuffer(pixels as ArrayBuffer | Uint8Array);
  const expectedBytes = dimensions.width * dimensions.height * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error("Export pixel data does not match its dimensions.");
  }
  return { buffer, ...dimensions };
}

function sanitizeFilenamePart(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (
    !value ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..")
  ) {
    throw new Error(`${label} contains an invalid path sequence.`);
  }

  let sanitized = value;
  if (process.platform === "win32") {
    sanitized = sanitized.replace(/[<>:"|?*\u0000-\u001f]/g, "_");
    sanitized = sanitized.replace(/[. ]+$/g, "");
  } else {
    sanitized = sanitized.replace(/[\u0000]/g, "_");
  }
  sanitized = sanitized.trim();
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error(`${label} is empty after sanitization.`);
  }
  if (sanitized.length > MAX_FILENAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_FILENAME_LENGTH).trim();
  }
  if (process.platform === "win32" && /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return sanitized;
}

function sanitizeSuffix(value: unknown): string {
  if (value === undefined) {
    return "-darkroom";
  }
  if (typeof value !== "string") {
    throw new Error("Filename suffix must be a string.");
  }
  if (value === "") {
    return "";
  }
  return sanitizeFilenamePart(value, "Filename suffix");
}

function getExtensionForFormat(format: ExportFormatDescriptor): string {
  return `.${format.extensions[0]}`;
}

function stripKnownExtension(value: string): string {
  const extension = path.extname(value).toLowerCase();
  const knownExtensions = new Set(
    FORMAT_DEFINITIONS.flatMap((format) =>
      format.extensions.map((item) => `.${item}`),
    ),
  );
  return knownExtensions.has(extension) ? value.slice(0, -extension.length) : value;
}

/**
 * Resolve every supported source in the main-owned active library. The
 * renderer's selection is intentionally not part of this capability: it may
 * omit a file or lie about a path, so the complete scan is what protects
 * source photos from replacement.
 */
export async function resolveApprovedExportSources(
  activeLibraryRoot: string | null,
): Promise<ApprovedExportSource[]> {
  if (!activeLibraryRoot || !isNodePath(activeLibraryRoot) || !path.isAbsolute(activeLibraryRoot)) {
    throw new Error("No approved library folder is open.");
  }

  const root = await fs.realpath(activeLibraryRoot);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error("Approved library root is not a directory.");
  }

  const scannedFiles = await scanFolderTree(root);
  const sources: ApprovedExportSource[] = [];
  for (const file of scannedFiles) {
    const requestedPath = path.resolve(root, file.relativePath);
    if (!isWithinRoot(root, requestedPath)) {
      throw new Error("Approved source must stay inside the active library.");
    }

    const sourcePath = await fs.realpath(requestedPath);
    if (!isWithinRoot(root, sourcePath)) {
      throw new Error("Approved source cannot follow a symlink outside the library.");
    }
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error("Approved source is not a regular file.");
    }
    sources.push({
      path: sourcePath,
      directory: path.dirname(sourcePath),
      basename: path.basename(sourcePath),
      ...statIdentity(sourceStat),
    });
  }
  return sources;
}

function normalizeFormatOptions(
  format: ExportFormatDescriptor,
  options: ExportEncodeOptions,
  sourceWidth: number,
  sourceHeight: number,
): {
  quality?: number;
  lossless: boolean;
  resize?: { width?: number; height?: number; withoutEnlargement: boolean };
} {
  const quality = options.quality ?? format.defaultQuality;
  if (format.supportsQuality) {
    if (
      quality !== undefined &&
      (!Number.isInteger(quality) || quality < 1 || quality > 100)
    ) {
      throw new Error("Export quality must be an integer from 1 to 100.");
    }
  } else if (options.quality !== undefined) {
    throw new Error(`${format.label} does not support quality.`);
  }

  const lossless = options.lossless ?? false;
  if (lossless && !format.supportsLossless) {
    throw new Error(`${format.label} does not support lossless mode.`);
  }

  const size = options.size;
  const neverUpscale = options.neverUpscale ?? true;
  if (!size || size.mode === "original") {
    return { quality, lossless };
  }

  if (size.mode === "long-edge" || size.mode === "longEdge") {
    const edge = assertPositiveInteger(
      size.longEdge ?? size.pixels,
      "Long edge",
    );
    if (edge > MAX_EXPORT_EDGE) {
      throw new Error("Long edge is too large.");
    }
    const sourceEdge = Math.max(sourceWidth, sourceHeight);
    const constrainedNeverUpscale = size.neverUpscale ?? neverUpscale;
    if (constrainedNeverUpscale && edge >= sourceEdge) {
      return { quality, lossless };
    }
    const ratio = edge / sourceEdge;
    const width = Math.max(1, Math.round(sourceWidth * ratio));
    const height = Math.max(1, Math.round(sourceHeight * ratio));
    assertPixelDimensions(width, height);
    return {
      quality,
      lossless,
      resize: { width, height, withoutEnlargement: constrainedNeverUpscale },
    };
  }

  if (size.mode === "fit") {
    const width = assertPositiveInteger(size.width, "Fit width");
    const height = assertPositiveInteger(size.height, "Fit height");
    if (width > MAX_EXPORT_EDGE || height > MAX_EXPORT_EDGE) {
      throw new Error("Fit dimensions are too large.");
    }
    const constrainedNeverUpscale = size.neverUpscale ?? neverUpscale;
    if (
      constrainedNeverUpscale &&
      sourceWidth <= width &&
      sourceHeight <= height
    ) {
      return { quality, lossless };
    }
    const ratio = Math.min(width / sourceWidth, height / sourceHeight);
    const resizedWidth = Math.max(1, Math.round(sourceWidth * ratio));
    const resizedHeight = Math.max(1, Math.round(sourceHeight * ratio));
    assertPixelDimensions(resizedWidth, resizedHeight);
    return {
      quality,
      lossless,
      resize: {
        width,
        height,
        withoutEnlargement: constrainedNeverUpscale,
      },
    };
  }

  throw new Error("Unsupported export size mode.");
}

function toDestinationPath(
  directory: string,
  basename: string,
  format: ExportFormatDescriptor,
  suffix: string,
): string {
  const safeBase = sanitizeFilenamePart(stripKnownExtension(basename), "Filename");
  const safeSuffix = sanitizeSuffix(suffix);
  const fullBase = sanitizeFilenamePart(`${safeBase}${safeSuffix}`, "Filename");
  return path.resolve(directory, `${fullBase}${getExtensionForFormat(format)}`);
}

function toSelectedDestinationFilename(
  basename: string,
  format: ExportFormatDescriptor,
): string {
  const safeBasename = sanitizeFilenamePart(basename, "Filename");
  const lowerBasename = safeBasename.toLowerCase();
  const compatible = format.extensions.some((candidate) =>
    lowerBasename.endsWith(`.${candidate.toLowerCase()}`),
  );
  return compatible
    ? safeBasename
    : `${safeBasename}${getExtensionForFormat(format)}`;
}

async function assertDirectory(directory: string): Promise<string> {
  const resolved = await fs.realpath(directory);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Export destination is not a directory.");
  }
  return resolved;
}

async function assertSafeTarget(
  directory: string,
  targetPath: string,
  sources: readonly ApprovedExportSource[],
  options: {
    selectedSources?: ReadonlySet<string>;
    isKnownProducedPath?: (
      targetPath: string,
      targetIdentity: Pick<ApprovedExportSource, "device" | "inode">,
    ) => boolean;
  } = {},
): Promise<void> {
  const resolvedTarget = path.resolve(targetPath);
  if (!isAbsolutePathWithin(directory, resolvedTarget)) {
    throw new Error("Export target must stay inside the approved folder.");
  }

  // Compare both canonical paths and filesystem identity. The identity check
  // catches case-only aliases on case-insensitive filesystems (notably macOS)
  // where a textual path comparison is insufficient.
  let targetRealPath: string | null = null;
  let targetIdentity: Pick<ApprovedExportSource, "device" | "inode"> = {};
  try {
    targetRealPath = await fs.realpath(resolvedTarget);
    const targetStat = await fs.stat(targetRealPath);
    targetIdentity = statIdentity(targetStat);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  let matchingSource: ApprovedExportSource | null = null;
  for (const source of sources) {
    if (
      pathsEqual(source.path, resolvedTarget) ||
      (targetRealPath !== null && pathsEqual(source.path, targetRealPath)) ||
      sameFileIdentity(source, targetIdentity)
    ) {
      matchingSource = source;
    }

    // A missing target cannot have an inode yet. Resolve its parent and retain
    // the exact source path check above so a raced case-only alias is still
    // rejected when it becomes visible before the write.
    try {
      const targetParent = await fs.realpath(path.dirname(resolvedTarget));
      if (
        pathsEqual(targetParent, source.directory) &&
        pathsEqual(path.basename(resolvedTarget), source.basename)
      ) {
        matchingSource = source;
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }

  if (!matchingSource) {
    return;
  }
  const selected = options.selectedSources?.has(normalizedPathKey(matchingSource.path)) ?? false;
  const knownProduced = options.isKnownProducedPath?.(resolvedTarget, targetIdentity) ?? false;
  if (selected || !knownProduced) {
    throw new Error("Export cannot overwrite a source photo.");
  }
}

async function assertExistingTargetIsSafe(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error("Refusing to write through a symbolic-link export target.");
    }
    if (!stat.isFile()) {
      throw new Error("Export target is not a regular file.");
    }
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function writeTempAndRename(
  targetPath: string,
  contents: Buffer,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function claimTarget(targetPath: string): Promise<fs.FileHandle | null> {
  try {
    return await fs.open(targetPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      return null;
    }
    throw error;
  }
}

async function chooseRenameTarget(
  targetPath: string,
): Promise<{ path: string; claim: fs.FileHandle }> {
  const extension = path.extname(targetPath);
  const base = targetPath.slice(0, -extension.length);
  for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? targetPath : `${base}-${attempt + 1}${extension}`;
    const claim = await claimTarget(candidate);
    if (claim) {
      return { path: candidate, claim };
    }
  }
  throw new Error("Could not find an available export filename.");
}

async function removeClaimIfOwned(
  targetPath: string,
  claimIdentity: Pick<ApprovedExportSource, "device" | "inode">,
): Promise<void> {
  try {
    const current = await fs.stat(targetPath);
    if (
      (claimIdentity.device === undefined || claimIdentity.inode === undefined) ||
      sameFileIdentity(claimIdentity, statIdentity(current))
    ) {
      await fs.unlink(targetPath);
    }
  } catch {
    // The claim may already have been replaced or cleaned up.
  }
}

async function writeClaimedTarget(
  targetPath: string,
  claim: fs.FileHandle,
  contents: Buffer,
): Promise<void> {
  let claimIdentity: Pick<ApprovedExportSource, "device" | "inode"> = {};
  try {
    try {
      claimIdentity = statIdentity(await claim.stat());
    } finally {
      await claim.close();
    }
    await writeTempAndRename(targetPath, contents);
  } catch (error) {
    await removeClaimIfOwned(targetPath, claimIdentity);
    throw error;
  }
}

async function encodePixels(
  raw: { buffer: Buffer; width: number; height: number },
  format: ExportFormatDescriptor,
  options: ExportEncodeOptions,
): Promise<Buffer> {
  const sharp = await loadSharp();
  const normalized = normalizeFormatOptions(format, options, raw.width, raw.height);
  let image = sharp(raw.buffer, {
    raw: { width: raw.width, height: raw.height, channels: 4 },
  }).removeAlpha();
  if (normalized.resize) {
    image = image.resize({
      ...normalized.resize,
      fit: normalized.resize.width && normalized.resize.height ? "inside" : "cover",
      kernel: "lanczos3",
    });
  }

  switch (format.id) {
    case "jpeg":
      return image.jpeg({
        quality: normalized.quality,
        mozjpeg: true,
      }).toBuffer();
    case "png":
      return image.png().toBuffer();
    case "webp":
      return image.webp({
        quality: normalized.quality,
        lossless: normalized.lossless,
      }).toBuffer();
    case "avif":
      return image.avif({ quality: normalized.quality }).toBuffer();
    case "tiff":
      return image.tiff({ compression: "lzw", predictor: "horizontal" }).toBuffer();
    default:
      throw new Error(`Unsupported export format: ${format.id}`);
  }
}

function getSharpCapability(
  sharp: SharpFactory,
  formatId: string,
): boolean {
  const formats = (sharp as unknown as {
    format?: Record<
      string,
      { output?: boolean | { buffer?: boolean } }
    >;
  }).format;
  const sharpFormatId = formatId === "avif" ? "heif" : formatId;
  const output = formats?.[sharpFormatId]?.output;
  return output === true || (typeof output === "object" && output.buffer === true);
}

export type ShowExportItemInFolder = (exportedPath: string) => void;

export interface ExportServiceOptions {
  /** Main-owned registry used to recognize outputs across app restarts. */
  provenancePath?: string;
}

interface ExportProvenanceRecord {
  path: string;
  device?: number;
  inode?: number;
}

interface ExportDestination {
  directory: string;
  format: ExportFormatId;
  selectedPath?: string;
  selectedSources: Set<string>;
  sources: ApprovedExportSource[];
  producedPaths: Set<string>;
  expiresAt: number;
  finalizeGraceAt: number | null;
  closing: boolean;
  inFlight: number;
  idleWaiters: Set<() => void>;
  finalizePromise: Promise<ExportFinalizeResult> | null;
}

interface RevealCapability {
  directory: string;
  exportedPath: string;
  expiresAt: number;
}

export function createExportService(
  dialog: ExportDialog,
  showItemInFolder: ShowExportItemInFolder = () => undefined,
  serviceOptions: ExportServiceOptions = {},
) {
  const destinations = new Map<string, ExportDestination>();
  const revealCapabilities = new Map<string, RevealCapability>();
  const knownProducedPaths = new Map<string, ExportProvenanceRecord>();
  const provenancePath = serviceOptions.provenancePath;
  let provenanceReady: Promise<void> | null = null;
  let provenanceWriteChain = Promise.resolve();

  function provenanceKey(value: string): string {
    return normalizedPathKey(value);
  }

  function isValidProvenanceRecord(value: unknown): value is ExportProvenanceRecord {
    if (typeof value === "string") {
      return isNodePath(value) && path.isAbsolute(value);
    }
    if (typeof value !== "object" || value === null || !("path" in value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      isNodePath(record.path) &&
      path.isAbsolute(record.path) &&
      (record.device === undefined ||
        (typeof record.device === "number" && Number.isFinite(record.device))) &&
      (record.inode === undefined ||
        (typeof record.inode === "number" && Number.isFinite(record.inode)))
    );
  }

  async function loadProvenance(): Promise<void> {
    if (!provenancePath || !isNodePath(provenancePath) || !path.isAbsolute(provenancePath)) {
      return;
    }
    try {
      const raw = JSON.parse(await fs.readFile(provenancePath, "utf8")) as unknown;
      const records = Array.isArray(raw)
        ? raw
        : typeof raw === "object" && raw !== null && "outputs" in raw &&
            Array.isArray((raw as { outputs?: unknown }).outputs)
          ? (raw as { outputs: unknown[] }).outputs
          : [];
      for (const value of records.slice(-MAX_PROVENANCE_RECORDS)) {
        if (!isValidProvenanceRecord(value)) {
          continue;
        }
        const record = typeof value === "string"
          ? { path: path.resolve(value) }
          : {
              path: path.resolve(value.path),
              ...(value.device === undefined ? {} : { device: value.device }),
              ...(value.inode === undefined ? {} : { inode: value.inode }),
            };
        knownProducedPaths.set(provenanceKey(record.path), record);
      }
    } catch {
      // A missing or damaged registry must not make exporting unavailable.
    }
  }

  function ensureProvenanceReady(): Promise<void> {
    provenanceReady ??= loadProvenance();
    return provenanceReady;
  }

  async function persistProvenance(): Promise<void> {
    if (!provenancePath || !isNodePath(provenancePath) || !path.isAbsolute(provenancePath)) {
      return;
    }
    const records = [...knownProducedPaths.values()].slice(-MAX_PROVENANCE_RECORDS);
    await fs.mkdir(path.dirname(provenancePath), { recursive: true });
    await writeTempAndRename(
      provenancePath,
      Buffer.from(JSON.stringify({ version: 1, outputs: records }), "utf8"),
    );
  }

  async function rememberProducedPath(targetPath: string): Promise<void> {
    const resolvedPath = path.resolve(targetPath);
    let identity: Pick<ApprovedExportSource, "device" | "inode"> = {};
    try {
      identity = statIdentity(await fs.stat(resolvedPath));
    } catch {
      // Without a stable identity, this output cannot authorize replacing a
      // scanned source.
    }
    const key = provenanceKey(resolvedPath);
    if (identity.device === undefined || identity.inode === undefined) {
      // A path without a stable filesystem identity must never authorize a
      // replacement of a scanned source.
      knownProducedPaths.delete(key);
      if (provenancePath) {
        await ensureProvenanceReady();
        const write = provenanceWriteChain.then(
          () => persistProvenance(),
          () => persistProvenance(),
        );
        provenanceWriteChain = write.catch(() => undefined);
        await write.catch(() => undefined);
      }
      return;
    }
    knownProducedPaths.set(key, {
      path: resolvedPath,
      ...identity,
    });
    if (!provenancePath) {
      return;
    }
    await ensureProvenanceReady();
    const write = provenanceWriteChain.then(
      () => persistProvenance(),
      () => persistProvenance(),
    );
    provenanceWriteChain = write.catch(() => undefined);
    await write.catch(() => undefined);
  }

  function isKnownProducedPath(
    targetPath: string,
    targetIdentity: Pick<ApprovedExportSource, "device" | "inode">,
  ): boolean {
    const record = knownProducedPaths.get(provenanceKey(targetPath));
    if (
      !record ||
      record.device === undefined ||
      record.inode === undefined ||
      targetIdentity.device === undefined ||
      targetIdentity.inode === undefined ||
      !Number.isFinite(record.device) ||
      !Number.isFinite(record.inode) ||
      !Number.isFinite(targetIdentity.device) ||
      !Number.isFinite(targetIdentity.inode)
    ) {
      return false;
    }
    return sameFileIdentity(record, targetIdentity);
  }

  function pruneExpiredCapabilities(now = Date.now()): void {
    for (const [token, destination] of destinations) {
      if (destination.inFlight > 0 || destination.closing || destination.expiresAt > now) {
        continue;
      }
      // Keep a completed destination briefly after expiry so a delayed
      // finalize can still return the output it already wrote.
      if (destination.producedPaths.size > 0) {
        destination.finalizeGraceAt ??= now + DESTINATION_FINALIZE_GRACE_MS;
        if (destination.finalizeGraceAt > now) {
          continue;
        }
      }
      destinations.delete(token);
    }
    for (const [token, capability] of revealCapabilities) {
      if (capability.expiresAt <= now) {
        revealCapabilities.delete(token);
      }
    }
  }

  function limitMapSize<K, V>(map: Map<K, V>, maxSize: number): void {
    while (map.size > maxSize) {
      let removable: K | undefined;
      for (const [key, value] of map) {
        if (
          map !== destinations ||
          (value as ExportDestination).inFlight === 0 &&
            !(value as ExportDestination).closing
        ) {
          removable = key;
          break;
        }
      }
      if (removable === undefined) {
        return;
      }
      map.delete(removable);
    }
  }

  function assertDestinationToken(token: string): ExportDestination {
    if (typeof token !== "string" || token.length < 16) {
      throw new Error("Invalid export destination token.");
    }
    pruneExpiredCapabilities();
    const destination = destinations.get(token);
    if (
      !destination ||
      destination.closing ||
      destination.expiresAt <= Date.now()
    ) {
      throw new Error("Export destination is no longer approved.");
    }
    return destination;
  }

  function touchDestination(destination: ExportDestination): void {
    destination.expiresAt = Date.now() + DESTINATION_IDLE_TTL_MS;
    destination.finalizeGraceAt = null;
  }

  function beginEncode(token: string): ExportDestination {
    const destination = assertDestinationToken(token);
    destination.inFlight += 1;
    touchDestination(destination);
    return destination;
  }

  function endEncode(destination: ExportDestination): void {
    destination.inFlight = Math.max(0, destination.inFlight - 1);
    if (destination.inFlight !== 0) {
      return;
    }
    const waiters = [...destination.idleWaiters];
    destination.idleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  function waitForEncodes(destination: ExportDestination): Promise<void> {
    if (destination.inFlight === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      destination.idleWaiters.add(resolve);
    });
  }

  function destinationSourceKey(source: ApprovedExportSource): string {
    return provenanceKey(source.path);
  }

  async function resolveSelectedSources(
    requested: ExportDestinationRequest["sources"],
    sources: readonly ApprovedExportSource[],
  ): Promise<Set<string>> {
    const selected = new Set<string>();
    if (!requested) {
      return selected;
    }
    for (const item of requested) {
      if (
        typeof item !== "object" ||
        item === null ||
        !isNodePath(item.rootPath) ||
        !path.isAbsolute(item.rootPath) ||
        !isNodePath(item.relativePath) ||
        path.isAbsolute(item.relativePath)
      ) {
        throw new Error("Selected export source is invalid.");
      }
      const root = await fs.realpath(item.rootPath);
      const candidate = path.resolve(root, item.relativePath);
      if (!isWithinRoot(root, candidate)) {
        throw new Error("Selected export source must stay inside the approved library.");
      }
      const sourcePath = await fs.realpath(candidate);
      const approved = sources.find((source) => pathsEqual(source.path, sourcePath));
      if (!approved) {
        throw new Error("Selected export source is not in the approved library scan.");
      }
      selected.add(destinationSourceKey(approved));
    }
    return selected;
  }

  async function getExportFormats(): Promise<ExportFormatDescriptor[]> {
    const sharp = await loadSharp();
    return FORMAT_DEFINITIONS.filter((format) =>
      getSharpCapability(sharp, format.id),
    ).map((format) => ({
      ...format,
      extensions: [...format.extensions],
    }));
  }

  async function chooseExportDestination(
    request: ExportDestinationRequest,
    sources: ApprovedExportSource[],
  ): Promise<{ token: string } | null> {
    pruneExpiredCapabilities();
    if (
      typeof request !== "object" ||
      request === null ||
      !Number.isInteger(request.count) ||
      request.count <= 0 ||
      !Array.isArray(sources)
    ) {
      throw new Error("Export destination request is invalid.");
    }
    await ensureProvenanceReady();
    const selectedSources = await resolveSelectedSources(request.sources, sources);
    const availableFormats = await getExportFormats();
    const format = availableFormats.find((candidate) => candidate.id === request.format);
    if (!format) {
      throw new Error(`Export format is unavailable: ${String(request.format)}`);
    }

    if (request.count === 1) {
      const suggestedBase = sanitizeFilenamePart(
        stripKnownExtension(request.suggestedFilename),
        "Suggested filename",
      );
      const result = await dialog.showSaveDialog({
        title: "Export edited photo",
        defaultPath: `${suggestedBase}${getExtensionForFormat(format)}`,
        filters: [{
          name: format.label,
          extensions: [...format.extensions],
        }],
      });
      if (result.canceled || !result.filePath) {
        return null;
      }

      if (!isNodePath(result.filePath) || !path.isAbsolute(result.filePath)) {
        throw new Error("The selected export path is invalid.");
      }
      const selectedPath = path.resolve(result.filePath);
      const directory = await assertDirectory(path.dirname(selectedPath));
      const selectedFilename = toSelectedDestinationFilename(
        path.basename(selectedPath),
        format,
      );
      const approvedSelectedPath = path.resolve(directory, selectedFilename);
      if (!isAbsolutePathWithin(directory, approvedSelectedPath)) {
        throw new Error("Export target must stay inside the approved folder.");
      }
      const token = randomUUID();
      destinations.set(token, {
        directory,
        format: format.id,
        selectedPath: approvedSelectedPath,
        selectedSources,
        sources: [...sources],
        producedPaths: new Set(),
        expiresAt: Date.now() + DESTINATION_IDLE_TTL_MS,
        finalizeGraceAt: null,
        closing: false,
        inFlight: 0,
        idleWaiters: new Set(),
        finalizePromise: null,
      });
      limitMapSize(destinations, MAX_DESTINATIONS);
      return { token };
    }

    const result = await dialog.showOpenDialog({
      title: "Choose export folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const directory = await assertDirectory(result.filePaths[0]!);
    const token = randomUUID();
    destinations.set(token, {
      directory,
      format: format.id,
      selectedSources,
      sources: [...sources],
      producedPaths: new Set(),
      expiresAt: Date.now() + DESTINATION_IDLE_TTL_MS,
      finalizeGraceAt: null,
      closing: false,
      inFlight: 0,
      idleWaiters: new Set(),
      finalizePromise: null,
    });
    limitMapSize(destinations, MAX_DESTINATIONS);
    return { token };
  }

  async function encodeAndSaveExport(
    token: string,
    basename: string,
    pixels: ExportPixels,
    options: ExportEncodeOptions,
  ): Promise<ExportResult> {
    if (typeof options !== "object" || options === null) {
      throw new Error("Export options are required.");
    }
    const destination = beginEncode(token);
    try {
      if (options.format !== destination.format) {
        throw new Error("Export format does not match the selected destination.");
      }
      const currentDirectory = await assertDirectory(destination.directory);
      if (!pathsEqual(currentDirectory, destination.directory)) {
        throw new Error("Export destination changed after it was approved.");
      }
      const raw = normalizePixels(pixels, options);
      const formats = await getExportFormats();
      const format = formats.find((candidate) => candidate.id === options.format);
      if (!format) {
        throw new Error(`Export format is unavailable: ${String(options.format)}`);
      }

      const targetPath = destination.selectedPath
        ? destination.selectedPath
        : toDestinationPath(
            currentDirectory,
            basename,
            format,
            options.filenameSuffix ?? options.suffix ?? DEFAULT_EXPORT_SUFFIX,
          );
      const resolvedTargetPath = path.resolve(targetPath);
      const safeTargetOptions = {
        selectedSources: destination.selectedSources,
        isKnownProducedPath,
      };
      await assertSafeTarget(
        currentDirectory,
        resolvedTargetPath,
        destination.sources,
        safeTargetOptions,
      );

      const encoded = await encodePixels(raw, format, options);
      const conflict = options.conflict ?? "rename";

      if (conflict === "skip") {
        await assertSafeTarget(
          currentDirectory,
          resolvedTargetPath,
          destination.sources,
          safeTargetOptions,
        );
        const claim = await claimTarget(resolvedTargetPath);
        if (!claim) {
          return { status: "skipped", path: resolvedTargetPath };
        }
        await writeClaimedTarget(resolvedTargetPath, claim, encoded);
        destination.producedPaths.add(resolvedTargetPath);
        await rememberProducedPath(resolvedTargetPath);
        return { status: "exported", path: resolvedTargetPath };
      }

      if (conflict === "rename") {
        const target = await chooseRenameTarget(resolvedTargetPath);
        let handedOffClaim = false;
        try {
          await assertSafeTarget(
            currentDirectory,
            target.path,
            destination.sources,
            safeTargetOptions,
          );
          handedOffClaim = true;
          await writeClaimedTarget(target.path, target.claim, encoded);
        } finally {
          if (!handedOffClaim) {
            let claimIdentity: Pick<ApprovedExportSource, "device" | "inode"> = {};
            try {
              claimIdentity = statIdentity(await target.claim.stat());
            } finally {
              await target.claim.close().catch(() => undefined);
            }
            await removeClaimIfOwned(target.path, claimIdentity);
          }
        }
        destination.producedPaths.add(target.path);
        await rememberProducedPath(target.path);
        return { status: "exported", path: target.path };
      }

      if (conflict !== "replace") {
        throw new Error("Unsupported export conflict behavior.");
      }
      await assertSafeTarget(
        currentDirectory,
        resolvedTargetPath,
        destination.sources,
        safeTargetOptions,
      );
      await assertExistingTargetIsSafe(resolvedTargetPath);
      await writeTempAndRename(resolvedTargetPath, encoded);
      // Do not re-check the token after rename. A destination may expire while
      // the write is in flight, but the successful output must be tracked.
      destination.producedPaths.add(resolvedTargetPath);
      await rememberProducedPath(resolvedTargetPath);
      return { status: "exported", path: resolvedTargetPath };
    } finally {
      if (!destination.closing) {
        touchDestination(destination);
      }
      endEncode(destination);
    }
  }

  function finalizeExport(token: string): Promise<ExportFinalizeResult> {
    if (typeof token !== "string" || token.length < 16) {
      throw new Error("Invalid export destination token.");
    }
    pruneExpiredCapabilities();
    const destination = destinations.get(token);
    if (!destination) {
      throw new Error("Export destination is no longer approved.");
    }
    if (destination.finalizePromise) {
      return destination.finalizePromise;
    }
    destination.closing = true;
    touchDestination(destination);
    const finalization = (async (): Promise<ExportFinalizeResult> => {
      await waitForEncodes(destination);
      destinations.delete(token);

      const outputPath = [...destination.producedPaths].at(-1) ?? null;
      if (!outputPath) {
        return { revealToken: null, outputPath: null };
      }

      const revealToken = randomUUID();
      revealCapabilities.set(revealToken, {
        directory: destination.directory,
        exportedPath: outputPath,
        expiresAt: Date.now() + REVEAL_IDLE_TTL_MS,
      });
      pruneExpiredCapabilities();
      limitMapSize(revealCapabilities, MAX_REVEAL_CAPABILITIES);
      return { revealToken, outputPath };
    })();
    destination.finalizePromise = finalization;
    return finalization;
  }

  function showInFolder(revealToken: string): void {
    if (typeof revealToken !== "string" || revealToken.length < 16) {
      throw new Error("Invalid export reveal capability.");
    }
    pruneExpiredCapabilities();
    const capability = revealCapabilities.get(revealToken);
    if (!capability) {
      throw new Error("Export reveal capability is no longer valid.");
    }
    if (!isAbsolutePathWithin(capability.directory, capability.exportedPath)) {
      throw new Error("The requested file was not produced by this export.");
    }
    // Reveal capabilities are deliberately one-shot. Removing it before the
    // shell call also prevents concurrent renderer calls from duplicating it.
    revealCapabilities.delete(revealToken);
    showItemInFolder(capability.exportedPath);
  }

  return {
    getExportFormats,
    chooseExportDestination,
    encodeAndSaveExport,
    finalizeExport,
    showInFolder,
  };
}

export { MAX_EXPORT_PIXELS };
