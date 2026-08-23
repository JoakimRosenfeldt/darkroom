import type {
  ExportConflictBehavior,
  ExportFormatId,
  ExportSizeOptions,
} from "../export/types.ts";
import type {
  Album,
  EntryMetadata,
  PhotoCatalog,
} from "./types.ts";

export interface MigrationRawSource {
  path: string;
  bytes: Uint8Array;
  text: string;
  sha256: string;
}

export interface MigrationSourceDescriptor {
  catalog: MigrationRawSource;
  settings?: MigrationRawSource;
}

export interface StrictMigrationSettings {
  lastFolderPath?: string | null;
  exportOptions?: {
    format: ExportFormatId;
    quality: number;
    lossless: boolean;
    size: ExportSizeOptions;
    suffix: string;
    conflict: ExportConflictBehavior;
  };
}

export interface OnlineScanObservation {
  relativePath: string;
  byteLength: number;
  modifiedAt: number;
  observedAt: number;
  localFileId: string | null;
  formatId: string;
}

export interface CompleteOnlineScan {
  complete: boolean;
  xmpComplete: boolean;
  observations: readonly OnlineScanObservation[];
  error?: string | null;
}

export type XmpEvidenceState = "unknown" | "absent" | "preserved" | "malformed";

export interface XmpEvidence {
  state: XmpEvidenceState;
  contents?: string;
  modifiedAt?: number;
  sha256?: string;
}

export interface LegacyCandidateSourceFlags {
  entries: boolean;
  albums: boolean;
  archive: boolean;
  scan: boolean;
}

export interface LegacyAssetObservation {
  byteLength: number;
  modifiedAt: number;
  observedAt: number;
  localFileId: string | null;
  formatId: string;
}

export interface LegacyAssetCandidate {
  relativePath: string;
  legacyIdAlias: string;
  sourceFlags: LegacyCandidateSourceFlags;
  metadata?: EntryMetadata;
  observation: LegacyAssetObservation | null;
  health: "present" | "missing";
  xmp: XmpEvidence;
}

export interface LegacyAlbumRelation {
  id: string;
  name: string;
  entryIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MigrationCounts {
  metadataEntries: number;
  albums: number;
  albumMemberships: number;
  archiveReferences: number;
  distinctReferencedIds: number;
  scannedAssetCount: number | null;
  expectedTotalAssets: number;
  expectedPresentAssets: number;
  expectedMissingAssets: number;
  expectedAliases: number;
  offlineInventoryLimited: boolean;
}

export interface LegacyMigrationPlan {
  rawCatalogVersion: 1 | 2;
  source: MigrationSourceDescriptor;
  catalog: PhotoCatalog;
  settings: StrictMigrationSettings | null;
  scan: "offline" | "online";
  candidates: LegacyAssetCandidate[];
  albums: LegacyAlbumRelation[];
  archivedEntryIds: string[];
  counts: MigrationCounts;
}

export type LegacyCatalogParser = (value: unknown) => PhotoCatalog;

export interface LegacyMigrationInput {
  catalog: unknown;
  source: MigrationSourceDescriptor;
  parseCatalog: LegacyCatalogParser;
  settings?: unknown;
  onlineScan?: CompleteOnlineScan;
  xmpByRelativePath?: Readonly<Record<string, XmpEvidence>>;
}

const MAX_EXPORT_EDGE = 100_000;
const MAX_SUFFIX_LENGTH = 200;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message: string): never {
  throw new Error(message);
}

function requireSha256(value: string, path: string): string {
  if (!SHA256_PATTERN.test(value)) {
    fail(`${path} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function validateSourceDescriptor(source: MigrationSourceDescriptor): void {
  if (!source || !source.catalog) {
    fail("source.catalog is required.");
  }
  const sources: Array<[string, MigrationRawSource | undefined]> = [
    ["source.catalog", source.catalog],
    ["source.settings", source.settings],
  ];
  for (const [sourcePath, item] of sources) {
    if (item === undefined) continue;
    if (typeof item !== "object" || item === null) {
      fail(`${sourcePath} must be an object.`);
    }
    if (typeof item.path !== "string") {
      fail(`${sourcePath}.path must be a string.`);
    }
    validateAbsoluteRootPath(item.path);
    if (!(item.bytes instanceof Uint8Array)) {
      fail(`${sourcePath}.bytes must be a byte array.`);
    }
    if (typeof item.text !== "string") {
      fail(`${sourcePath}.text must be a string.`);
    }
    if (typeof item.sha256 !== "string") {
      fail(`${sourcePath}.sha256 must be a string.`);
    }
    requireSha256(item.sha256, `${sourcePath}.sha256`);
  }
}

function validateAbsoluteRootPath(rootPath: string): string {
  if (typeof rootPath !== "string" || rootPath.length === 0 || rootPath.includes("\0")) {
    fail("Catalog rootPath must be an absolute, normalized path without NUL.");
  }

  if (rootPath.startsWith("/")) {
    if (rootPath !== "/" && rootPath.endsWith("/")) {
      fail("Catalog rootPath must be normalized.");
    }
    if (rootPath.startsWith("//")) {
      fail("Catalog rootPath must not use an ambiguous UNC-style prefix.");
    }
    const segments = rootPath.slice(1).split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      fail("Catalog rootPath contains a noncanonical segment.");
    }
    return rootPath;
  }

  const driveMatch = /^([A-Za-z]):([\\/])/.exec(rootPath);
  if (!driveMatch) {
    fail("Catalog rootPath must be absolute.");
  }
  const separator = driveMatch[2];
  if (rootPath.length === 3) {
    return rootPath;
  }
  if (rootPath.includes(separator === "/" ? "\\" : "/")) {
    fail("Catalog rootPath must use one normalized separator style.");
  }
  if (rootPath.length > 3 && rootPath.endsWith(separator)) {
    fail("Catalog rootPath must be normalized.");
  }
  const segments = rootPath.slice(3).split(separator);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("Catalog rootPath contains a noncanonical segment.");
  }
  return rootPath;
}

export function canonicalRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("Relative path must be nonempty and NUL-free.");
  }
  if (value.includes("\\") || value.startsWith("/") || value.startsWith("//")) {
    fail(`Relative path "${value}" is not a safe POSIX path.`);
  }
  if (/^[A-Za-z]:/.test(value)) {
    fail(`Relative path "${value}" must not use a Windows drive prefix.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(`Relative path "${value}" contains a noncanonical segment.`);
  }
  return segments.join("/");
}

export function decodeLegacyId(legacyId: string): { legacyId: string; relativePath: string } {
  if (typeof legacyId !== "string" || legacyId.length === 0 || legacyId.includes("\0")) {
    fail("Legacy ID must be nonempty and NUL-free.");
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(legacyId);
  } catch {
    fail(`Legacy ID "${legacyId}" contains malformed percent escapes.`);
  }
  if (encodeURIComponent(relativePath) !== legacyId) {
    fail(`Legacy ID "${legacyId}" is not canonically encoded.`);
  }
  return { legacyId, relativePath: canonicalRelativePath(relativePath) };
}

function requireKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(`${path}.${key} is not supported.`);
    }
  }
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

function parseStrictSize(value: unknown): ExportSizeOptions {
  if (!isRecord(value) || typeof value.mode !== "string") {
    fail("settings.exportOptions.size must be an object with a mode.");
  }
  if (value.mode === "original") {
    requireKnownKeys(value, ["mode"], "settings.exportOptions.size");
    return { mode: "original" };
  }
  if (value.mode === "long-edge" || value.mode === "longEdge") {
    requireKnownKeys(value, ["mode", "pixels", "longEdge", "neverUpscale"], "settings.exportOptions.size");
    const hasPixels = hasOwn(value, "pixels");
    const hasLongEdge = hasOwn(value, "longEdge");
    if (hasPixels === hasLongEdge) {
      fail("settings.exportOptions.size must contain exactly one edge field.");
    }
    const edge = hasPixels ? value.pixels : value.longEdge;
    if (!positiveInteger(edge, MAX_EXPORT_EDGE)) {
      fail("settings.exportOptions.size edge must be a positive integer.");
    }
    if (hasOwn(value, "neverUpscale") && typeof value.neverUpscale !== "boolean") {
      fail("settings.exportOptions.size.neverUpscale must be a boolean.");
    }
    const neverUpscale = typeof value.neverUpscale === "boolean"
      ? value.neverUpscale
      : undefined;
    return value.mode === "long-edge"
      ? { mode: "long-edge", pixels: edge, ...(neverUpscale === undefined ? {} : { neverUpscale }) }
      : { mode: "longEdge", longEdge: edge, ...(neverUpscale === undefined ? {} : { neverUpscale }) };
  }
  if (value.mode === "fit") {
    requireKnownKeys(value, ["mode", "width", "height", "neverUpscale"], "settings.exportOptions.size");
    if (!positiveInteger(value.width, MAX_EXPORT_EDGE) || !positiveInteger(value.height, MAX_EXPORT_EDGE)) {
      fail("settings.exportOptions.size width and height must be positive integers.");
    }
    if (hasOwn(value, "neverUpscale") && typeof value.neverUpscale !== "boolean") {
      fail("settings.exportOptions.size.neverUpscale must be a boolean.");
    }
    const neverUpscale = typeof value.neverUpscale === "boolean"
      ? value.neverUpscale
      : undefined;
    return {
      mode: "fit",
      width: value.width,
      height: value.height,
      ...(neverUpscale === undefined ? {} : { neverUpscale }),
    };
  }
  fail(`settings.exportOptions.size.mode "${value.mode}" is unsupported.`);
}

function parseStrictExportOptions(value: unknown): NonNullable<StrictMigrationSettings["exportOptions"]> {
  if (!isRecord(value)) {
    fail("settings.exportOptions must be an object.");
  }
  requireKnownKeys(value, ["format", "quality", "lossless", "size", "suffix", "conflict"], "settings.exportOptions");
  const format = value.format;
  const isFormat = format === "jpeg" || format === "png" || format === "webp" || format === "avif" || format === "tiff";
  if (!isFormat) {
    fail("settings.exportOptions.format is unsupported.");
  }
  if (!positiveInteger(value.quality, 100)) {
    fail("settings.exportOptions.quality must be an integer from 1 to 100.");
  }
  if (typeof value.lossless !== "boolean") {
    fail("settings.exportOptions.lossless must be a boolean.");
  }
  if (typeof value.suffix !== "string" || value.suffix.length > MAX_SUFFIX_LENGTH || value.suffix.includes("\0") || value.suffix.includes("/") || value.suffix.includes("\\") || value.suffix.includes("..")) {
    fail("settings.exportOptions.suffix is invalid.");
  }
  const conflict = value.conflict;
  const isConflict = conflict === "rename" || conflict === "skip" || conflict === "replace";
  if (!isConflict) {
    fail("settings.exportOptions.conflict is unsupported.");
  }
  return {
    format,
    quality: value.quality,
    lossless: value.lossless,
    size: parseStrictSize(value.size),
    suffix: value.suffix,
    conflict,
  };
}

export function parseStrictMigrationSettings(value: unknown): StrictMigrationSettings {
  if (!isRecord(value)) {
    fail("Settings must be a plain object.");
  }
  requireKnownKeys(value, ["lastFolderPath", "exportOptions"], "settings");
  const result: StrictMigrationSettings = {};
  if (hasOwn(value, "lastFolderPath")) {
    if (value.lastFolderPath !== null && typeof value.lastFolderPath !== "string") {
      fail("settings.lastFolderPath must be a string or null.");
    }
    result.lastFolderPath = value.lastFolderPath;
  }
  if (hasOwn(value, "exportOptions")) {
    result.exportOptions = parseStrictExportOptions(value.exportOptions);
  }
  return result;
}

function rawCatalogVersion(value: unknown): 1 | 2 {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    fail("Legacy catalog must declare version 1 or 2.");
  }
  return value.version;
}

function copyFlags(flags: LegacyCandidateSourceFlags): LegacyCandidateSourceFlags {
  return { ...flags };
}

interface CandidateBuilder {
  relativePath: string;
  legacyIdAlias: string;
  sourceFlags: LegacyCandidateSourceFlags;
  metadata?: EntryMetadata;
  observation: LegacyAssetObservation | null;
  health: "present" | "missing";
}

function createCandidate(relativePath: string): CandidateBuilder {
  return {
    relativePath,
    legacyIdAlias: encodeURIComponent(relativePath),
    sourceFlags: { entries: false, albums: false, archive: false, scan: false },
    observation: null,
    health: "missing",
  };
}

function setLegacyAlias(candidate: CandidateBuilder, legacyId: string): void {
  if (candidate.legacyIdAlias !== encodeURIComponent(candidate.relativePath) && candidate.legacyIdAlias !== legacyId) {
    fail(`Relative path "${candidate.relativePath}" has conflicting legacy IDs.`);
  }
  candidate.legacyIdAlias = legacyId;
}

function addReferencedCandidate(
  candidates: Map<string, CandidateBuilder>,
  legacyId: string,
  flag: keyof LegacyCandidateSourceFlags,
  metadata?: EntryMetadata,
): void {
  const decoded = decodeLegacyId(legacyId);
  const candidate = candidates.get(decoded.relativePath) ?? createCandidate(decoded.relativePath);
  setLegacyAlias(candidate, decoded.legacyId);
  candidate.sourceFlags[flag] = true;
  if (metadata !== undefined) {
    candidate.metadata = metadata;
  }
  candidates.set(decoded.relativePath, candidate);
}

function parseXmpEvidence(value: unknown, path: string): XmpEvidence {
  if (!isRecord(value)) {
    fail(`${path} must be an object.`);
  }
  const state = value.state;
  if (state !== "unknown" && state !== "absent" && state !== "preserved" && state !== "malformed") {
    fail(`${path}.state is invalid.`);
  }
  if (hasOwn(value, "modifiedAt") && (typeof value.modifiedAt !== "number" || !Number.isFinite(value.modifiedAt))) {
    fail(`${path}.modifiedAt must be finite.`);
  }
  if (hasOwn(value, "sha256")) {
    if (typeof value.sha256 !== "string") fail(`${path}.sha256 must be a string.`);
    requireSha256(value.sha256, `${path}.sha256`);
  }
  if (hasOwn(value, "contents") && typeof value.contents !== "string") {
    fail(`${path}.contents must be a string.`);
  }
  if (state === "preserved" && (!hasOwn(value, "contents") || !hasOwn(value, "modifiedAt") || !hasOwn(value, "sha256"))) {
    fail(`${path} preserved evidence must include contents, modifiedAt, and sha256.`);
  }
  return {
    state,
    ...(typeof value.contents === "string" ? { contents: value.contents } : {}),
    ...(typeof value.modifiedAt === "number" ? { modifiedAt: value.modifiedAt } : {}),
    ...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
  };
}

function validateObservation(observation: OnlineScanObservation, path: string): LegacyAssetObservation {
  if (typeof observation.relativePath !== "string") {
    fail(`${path}.relativePath must be a string.`);
  }
  canonicalRelativePath(observation.relativePath);
  if (!Number.isInteger(observation.byteLength) || observation.byteLength < 0) {
    fail(`${path}.byteLength must be a nonnegative integer.`);
  }
  if (!Number.isFinite(observation.modifiedAt) || !Number.isFinite(observation.observedAt)) {
    fail(`${path} timestamps must be finite.`);
  }
  if (observation.localFileId !== null && (typeof observation.localFileId !== "string" || observation.localFileId.includes("\0"))) {
    fail(`${path}.localFileId must be a NUL-free string or null.`);
  }
  if (typeof observation.formatId !== "string" || observation.formatId.length === 0 || observation.formatId.includes("\0")) {
    fail(`${path}.formatId must be a nonempty NUL-free string.`);
  }
  return {
    byteLength: observation.byteLength,
    modifiedAt: observation.modifiedAt,
    observedAt: observation.observedAt,
    localFileId: observation.localFileId,
    formatId: observation.formatId,
  };
}

function relationFromAlbum(album: Album): LegacyAlbumRelation {
  return {
    id: album.id,
    name: album.name,
    entryIds: [...album.entryIds],
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
  };
}

function defaultXmp(online: boolean): XmpEvidence {
  return online ? { state: "absent" } : { state: "unknown" };
}

export function prepareLegacyMigration(input: LegacyMigrationInput): LegacyMigrationPlan {
  if (typeof input.parseCatalog !== "function") {
    fail("parseCatalog must be a function.");
  }
  if (input.onlineScan === null) {
    fail("onlineScan must be omitted or a complete scan descriptor.");
  }
  validateSourceDescriptor(input.source);
  const version = rawCatalogVersion(input.catalog);
  const catalog = input.parseCatalog(input.catalog);
  if (catalog.version !== 2) {
    fail("Strict catalog parser must return normalized version 2 data.");
  }
  validateAbsoluteRootPath(catalog.rootPath);

  let settings: StrictMigrationSettings | null = null;
  if (input.settings !== undefined) {
    settings = parseStrictMigrationSettings(input.settings);
  } else if (input.source.settings) {
    let parsedSettings: unknown;
    try {
      parsedSettings = JSON.parse(input.source.settings.text);
    } catch {
    fail("Raw settings source is not valid JSON.");
    }
    settings = parseStrictMigrationSettings(parsedSettings);
  }

  const candidates = new Map<string, CandidateBuilder>();
  for (const [legacyId, metadata] of Object.entries(catalog.entries)) {
    addReferencedCandidate(candidates, legacyId, "entries", metadata);
  }

  const albums: LegacyAlbumRelation[] = [];
  const albumIds = new Set<string>();
  let albumMemberships = 0;
  for (const [index, album] of catalog.albums.entries()) {
    if (albumIds.has(album.id)) {
      fail(`albums[${index}].id is duplicated.`);
    }
    albumIds.add(album.id);
    const membershipIds = new Set<string>();
    for (const [membershipIndex, legacyId] of album.entryIds.entries()) {
      const decoded = decodeLegacyId(legacyId);
      if (membershipIds.has(decoded.relativePath)) {
        fail(`albums[${index}].entryIds[${membershipIndex}] duplicates a membership.`);
      }
      membershipIds.add(decoded.relativePath);
      addReferencedCandidate(candidates, legacyId, "albums");
      albumMemberships += 1;
    }
    albums.push(relationFromAlbum(album));
  }

  const archivedEntryIds = [...catalog.archivedEntryIds];
  const archiveIds = new Set<string>();
  for (const [index, legacyId] of archivedEntryIds.entries()) {
    const decoded = decodeLegacyId(legacyId);
    if (archiveIds.has(decoded.relativePath)) {
      fail(`archivedEntryIds[${index}] duplicates an archive reference.`);
    }
    archiveIds.add(decoded.relativePath);
    addReferencedCandidate(candidates, legacyId, "archive");
  }

  const online = input.onlineScan !== undefined;
  if (input.onlineScan) {
    if (input.onlineScan.complete !== true ||
      (input.onlineScan.error !== undefined && input.onlineScan.error !== null)) {
      fail("Online scan must be explicitly complete and error-free.");
    }
    if (typeof input.onlineScan.xmpComplete !== "boolean") {
      fail("Online scan must declare whether XMP coverage is complete.");
    }
    if (!Array.isArray(input.onlineScan.observations)) {
      fail("Online scan observations must be an array.");
    }
  }
  const scanPaths = new Set<string>();
  if (input.onlineScan) {
    for (const [index, observation] of input.onlineScan.observations.entries()) {
      const validated = validateObservation(observation, `onlineScan.observations[${index}]`);
      const relativePath = canonicalRelativePath(observation.relativePath);
      if (scanPaths.has(relativePath)) {
        fail(`onlineScan.observations[${index}] duplicates a scan path.`);
      }
      scanPaths.add(relativePath);
      const candidate = candidates.get(relativePath) ?? createCandidate(relativePath);
      candidate.sourceFlags.scan = true;
      candidate.observation = validated;
      candidate.health = "present";
      candidates.set(relativePath, candidate);
    }
  }

  const xmpEvidence = new Map<string, XmpEvidence>();
  for (const [relativePath, evidence] of Object.entries(input.xmpByRelativePath ?? {})) {
    const canonicalPath = canonicalRelativePath(relativePath);
    if (xmpEvidence.has(canonicalPath)) {
      fail(`XMP evidence duplicates "${canonicalPath}".`);
    }
    xmpEvidence.set(canonicalPath, parseXmpEvidence(evidence, `xmpByRelativePath.${relativePath}`));
  }

  const orderedCandidates = [...candidates.values()]
    .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
    .map((candidate) => {
      const evidence = xmpEvidence.get(candidate.relativePath) ?? defaultXmp(input.onlineScan?.xmpComplete === true);
      if (online && !candidate.observation) {
        candidate.health = "missing";
      }
      return {
        relativePath: candidate.relativePath,
        legacyIdAlias: candidate.legacyIdAlias,
        sourceFlags: copyFlags(candidate.sourceFlags),
        ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
        observation: candidate.observation,
        health: candidate.health,
        xmp: evidence,
      } satisfies LegacyAssetCandidate;
    });

  for (const relativePath of xmpEvidence.keys()) {
    if (!candidates.has(relativePath)) {
      fail(`XMP evidence references unknown path "${relativePath}".`);
    }
  }

  const presentCount = online
    ? orderedCandidates.filter((candidate) => candidate.observation !== null).length
    : 0;
  const missingCount = online
    ? orderedCandidates.filter((candidate) => candidate.observation === null).length
    : orderedCandidates.length;
  const counts: MigrationCounts = {
    metadataEntries: Object.keys(catalog.entries).length,
    albums: catalog.albums.length,
    albumMemberships,
    archiveReferences: archivedEntryIds.length,
    distinctReferencedIds: orderedCandidates.filter((candidate) => candidate.sourceFlags.entries || candidate.sourceFlags.albums || candidate.sourceFlags.archive).length,
    scannedAssetCount: input.onlineScan?.observations.length ?? null,
    expectedTotalAssets: orderedCandidates.length,
    expectedPresentAssets: presentCount,
    expectedMissingAssets: missingCount,
    expectedAliases: orderedCandidates.length,
    offlineInventoryLimited: !online,
  };

  return {
    rawCatalogVersion: version,
    source: input.source,
    catalog,
    settings,
    scan: online ? "online" : "offline",
    candidates: orderedCandidates,
    albums,
    archivedEntryIds,
    counts,
  };
}
