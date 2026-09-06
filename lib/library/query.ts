import type { EntryMetadata } from "../catalog/types";
import type { LibraryEntry } from "../fs/types";
import {
  effectiveMetadataValue,
  metadataValue,
  type MetadataOverride,
  type MetadataSyncStatus,
  type MetadataValue,
} from "../metadata/types";
import type {
  EntryAnalysis,
  Keyword,
  LibraryWorkspaceState,
  SmartPredicate,
  SmartRuleGroup,
} from "./model";

export const UNKNOWN_FACET_VALUE = "__unknown__";

export interface NumericFacetRange {
  readonly min: number | null;
  readonly max: number | null;
  readonly includeUnknown: boolean;
}

export type EditedFacetValue = "edited" | "unedited";
export type KeywordFacetMode = "exact" | "descendants" | "ancestors";
export type MetadataAvailabilityFacetValue = "ready" | "pending" | "warning" | "error";

export interface LibraryFacets {
  readonly cameras: readonly string[];
  readonly lenses: readonly string[];
  readonly iso: NumericFacetRange;
  readonly focalLength: NumericFacetRange;
  readonly locations: readonly string[];
  readonly captureYears: readonly string[];
  readonly metadataAvailability: readonly MetadataAvailabilityFacetValue[];
  readonly metadataSync: readonly MetadataSyncStatus[];
  readonly edited: readonly EditedFacetValue[];
  readonly albums: readonly string[];
  readonly keywords: readonly string[];
  readonly keywordMode: KeywordFacetMode;
}

export interface NumericFacetSummary {
  readonly min: number | null;
  readonly max: number | null;
  readonly knownCount: number;
  readonly unknownCount: number;
}

export interface LibraryFacetCounts {
  readonly cameras: Readonly<Record<string, number>>;
  readonly lenses: Readonly<Record<string, number>>;
  readonly iso: NumericFacetSummary;
  readonly focalLength: NumericFacetSummary;
  readonly locations: Readonly<Record<string, number>>;
  readonly captureYears: Readonly<Record<string, number>>;
  readonly metadataAvailability: Readonly<Record<MetadataAvailabilityFacetValue, number>>;
  readonly metadataSync: Readonly<Record<MetadataSyncStatus, number>>;
  readonly edited: Readonly<Record<EditedFacetValue, number>>;
  readonly albums: Readonly<Record<string, number>>;
  readonly keywords: Readonly<Record<string, number>>;
}

export const EMPTY_LIBRARY_FACETS: LibraryFacets = {
  cameras: [],
  lenses: [],
  iso: { min: null, max: null, includeUnknown: false },
  focalLength: { min: null, max: null, includeUnknown: false },
  locations: [],
  captureYears: [],
  metadataAvailability: [],
  metadataSync: [],
  edited: [],
  albums: [],
  keywords: [],
  keywordMode: "exact",
};

export interface QueryIndexRecord {
  readonly entryId: string;
  readonly searchableText: string;
  readonly filename: string;
  readonly path: string;
  readonly format: string;
  readonly camera: string | null;
  readonly lens: string | null;
  readonly iso: number | null;
  readonly focalLength: number | null;
  readonly location: string | null;
  readonly captureYear: string | null;
  readonly metadataAvailability: MetadataAvailabilityFacetValue;
  readonly metadataSync: MetadataSyncStatus;
  readonly edited: boolean;
  readonly albumIds: ReadonlySet<string>;
  readonly albumNames: readonly string[];
  readonly keywordIds: ReadonlySet<string>;
  readonly keywordAncestorIds: ReadonlySet<string>;
  readonly keywordDescendantIds: ReadonlySet<string>;
  readonly keywordPaths: readonly string[];
}

export type QueryIndex = ReadonlyMap<string, QueryIndexRecord>;

let cachedInputs: Parameters<typeof buildQueryIndex> | null = null;
let cachedResult: ReturnType<typeof buildQueryIndex> | null = null;

export function getQueryIndex(...inputs: Parameters<typeof buildQueryIndex>): ReturnType<typeof buildQueryIndex> {
  const previous = cachedInputs;
  if (previous && cachedResult && inputs.every((value, index) => value === previous[index])) {
    return cachedResult;
  }
  cachedInputs = inputs;
  cachedResult = buildQueryIndex(...inputs);
  return cachedResult;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase();
}

export function tokenizeSearchQuery(value: string): string[] {
  return normalizeSearchText(value)
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function displayCamera(analysis: EntryAnalysis | undefined): string | null {
  const camera = [analysis?.cameraMake, analysis?.cameraModel]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .trim();
  return camera.length > 0 ? camera : null;
}

function effectiveValue<T>(
  source: MetadataValue<T> | undefined,
  override: MetadataOverride<T> | undefined,
  catalogValue: T | null,
): T | null {
  if (override !== undefined) {
    return source === undefined
      ? override.kind === "set" ? override.value : null
      : effectiveMetadataValue(source, override);
  }
  return catalogValue ?? (source === undefined ? null : metadataValue(source));
}

export function effectiveCaptureTimeKey(
  workspace: LibraryWorkspaceState,
  entryId: string,
): number | null {
  const analysis = workspace.analysisByEntryId[entryId];
  const override = workspace.metadataOverridesByEntryId[entryId]?.captureTime;
  if (override?.kind === "set") return override.value.sortKey;
  if (override?.kind === "clear") return null;
  return metadataValue(analysis?.source?.capture.time ?? { kind: "absent" })?.sortKey ??
    analysis?.captureTimeKey ??
    null;
}

export function displayLocation(analysis: EntryAnalysis | undefined): string | null {
  const location = [
    analysis?.location.city,
    analysis?.location.state,
    analysis?.location.country,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  if (location.length > 0) return location;
  return analysis?.hasGps ? "GPS present" : null;
}

function keywordPath(keyword: Keyword, byId: ReadonlyMap<string, Keyword>): string {
  const parts = [keyword.name];
  const seen = new Set([keyword.id]);
  let parentId = keyword.parentId;
  while (parentId !== null) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(" > ");
}

export function buildQueryIndex(
  entries: readonly LibraryEntry[],
  metadata: Readonly<Record<string, EntryMetadata>>,
  albums: readonly { readonly id: string; readonly name: string; readonly entryIds: readonly string[] }[],
  workspace: LibraryWorkspaceState,
): QueryIndex {
  const albumIdsByEntry = new Map<string, Set<string>>();
  const albumNameById = new Map(albums.map((album) => [album.id, album.name]));
  for (const album of albums) {
    for (const entryId of album.entryIds) {
      const ids = albumIdsByEntry.get(entryId) ?? new Set<string>();
      ids.add(album.id);
      albumIdsByEntry.set(entryId, ids);
    }
  }

  const keywordById = new Map(workspace.keywords.map((keyword) => [keyword.id, keyword]));
  const keywordChildren = new Map<string, string[]>();
  for (const keyword of workspace.keywords) {
    if (keyword.parentId === null) continue;
    const children = keywordChildren.get(keyword.parentId) ?? [];
    children.push(keyword.id);
    keywordChildren.set(keyword.parentId, children);
  }
  function ancestorIds(keywordId: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    let current: string | null = keywordId;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      ids.push(current);
      current = keywordById.get(current)?.parentId ?? null;
    }
    return ids;
  }
  function descendantIds(keywordId: string): string[] {
    const ids: string[] = [];
    const pending = [keywordId];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      ids.push(current);
      pending.push(...(keywordChildren.get(current) ?? []));
    }
    return ids;
  }
  const records = new Map<string, QueryIndexRecord>();
  for (const entry of entries) {
    const analysis = workspace.analysisByEntryId[entry.id];
    const source = analysis?.source;
    const overrides = workspace.metadataOverridesByEntryId[entry.id];
    const catalogMetadata = metadata[entry.id];
    const camera = displayCamera(analysis);
    const lens = analysis?.lens ?? null;
    const location = displayLocation(analysis);
    const albumIds = albumIdsByEntry.get(entry.id) ?? new Set<string>();
    const albumNames = [...albumIds]
      .map((id) => albumNameById.get(id))
      .filter((name): name is string => name !== undefined);
    const keywordIds = new Set(workspace.entryKeywordIds[entry.id] ?? []);
    const keywordAncestorIds = new Set([...keywordIds].flatMap(ancestorIds));
    const keywordDescendantIds = new Set([...keywordIds].flatMap(descendantIds));
    const keywords = [...keywordIds]
      .map((id) => keywordById.get(id))
      .filter((keyword): keyword is Keyword => keyword !== undefined);
    const keywordPaths = keywords.flatMap((keyword) => [
      keywordPath(keyword, keywordById),
      keyword.name,
      ...keyword.synonyms,
    ]);
    const title = effectiveValue(source?.description.title, overrides?.title, catalogMetadata?.title ?? null);
    const caption = effectiveValue(source?.description.caption, overrides?.caption, catalogMetadata?.caption ?? null);
    const copyright = effectiveValue(source?.description.copyright, overrides?.copyright, catalogMetadata?.copyright ?? null);
    const descriptiveKeywords = effectiveValue(
      source?.description.keywords,
      overrides?.keywords,
      catalogMetadata?.keywords ?? null,
    ) ?? [];
    const captureTimeKey = effectiveCaptureTimeKey(workspace, entry.id);
    const captureYear = captureTimeKey === null
      ? null
      : String(new Date(captureTimeKey).getUTCFullYear());
    const metadataAvailability: MetadataAvailabilityFacetValue = analysis === undefined
      ? "pending"
      : analysis.error !== null
        ? "error"
        : (source?.warnings.length ?? 0) > 0
          ? "warning"
          : "ready";
    const metadataSync = workspace.metadataSyncByEntryId[entry.id]?.status ?? "clean";
    const searchableText = normalizeSearchText([
      entry.name,
      entry.displayName,
      entry.relativePath,
      camera,
      lens,
      title,
      caption,
      copyright,
      ...descriptiveKeywords,
      ...albumNames,
      ...keywordPaths,
    ].filter((value): value is string => value !== null).join("\n"));
    records.set(entry.id, {
      entryId: entry.id,
      searchableText,
      filename: entry.name,
      path: entry.relativePath,
      format: entry.formatId ?? entry.name.split(".").at(-1) ?? "",
      camera,
      lens,
      iso: analysis?.iso ?? null,
      focalLength: analysis?.focalLength ?? null,
      location,
      captureYear,
      metadataAvailability,
      metadataSync,
      edited: metadata[entry.id]?.develop !== undefined,
      albumIds,
      albumNames,
      keywordIds,
      keywordAncestorIds,
      keywordDescendantIds,
      keywordPaths,
    });
  }
  return records;
}

export function matchesTextQuery(record: QueryIndexRecord, tokens: readonly string[]): boolean {
  return tokens.every((token) => record.searchableText.includes(token));
}

type FacetKey = keyof LibraryFacets;

function includesNormalized(values: readonly string[], candidate: string | null): boolean {
  if (values.length === 0) return true;
  if (candidate === null) return values.includes(UNKNOWN_FACET_VALUE);
  const normalized = normalizeSearchText(candidate);
  return values.some((value) => normalizeSearchText(value) === normalized);
}

function matchesNumericRange(value: number | null, range: NumericFacetRange): boolean {
  if (range.min === null && range.max === null && !range.includeUnknown) return true;
  if (value === null) return range.includeUnknown;
  return (range.min === null || value >= range.min) &&
    (range.max === null || value <= range.max);
}

export function matchesFacets(
  record: QueryIndexRecord,
  facets: LibraryFacets,
  excludedFacet?: FacetKey,
): boolean {
  if (excludedFacet !== "cameras" && !includesNormalized(facets.cameras, record.camera)) return false;
  if (excludedFacet !== "lenses" && !includesNormalized(facets.lenses, record.lens)) return false;
  if (excludedFacet !== "iso" && !matchesNumericRange(record.iso, facets.iso)) return false;
  if (
    excludedFacet !== "focalLength" &&
    !matchesNumericRange(record.focalLength, facets.focalLength)
  ) return false;
  if (excludedFacet !== "locations" && !includesNormalized(facets.locations, record.location)) return false;
  if (excludedFacet !== "captureYears" && !includesNormalized(facets.captureYears, record.captureYear)) return false;
  if (
    excludedFacet !== "metadataAvailability" &&
    facets.metadataAvailability.length > 0 &&
    !facets.metadataAvailability.includes(record.metadataAvailability)
  ) return false;
  if (
    excludedFacet !== "metadataSync" &&
    facets.metadataSync.length > 0 &&
    !facets.metadataSync.includes(record.metadataSync)
  ) return false;
  if (
    excludedFacet !== "edited" &&
    facets.edited.length > 0 &&
    !facets.edited.includes(record.edited ? "edited" : "unedited")
  ) return false;
  if (
    excludedFacet !== "albums" &&
    facets.albums.length > 0 &&
    !facets.albums.some((albumId) => record.albumIds.has(albumId))
  ) return false;
  if (
    excludedFacet !== "keywords" &&
    facets.keywords.length > 0 &&
    !facets.keywords.some((keywordId) => {
      if (keywordId === UNKNOWN_FACET_VALUE) return record.keywordIds.size === 0;
      if (facets.keywordMode === "descendants") return record.keywordAncestorIds.has(keywordId);
      if (facets.keywordMode === "ancestors") return record.keywordDescendantIds.has(keywordId);
      return record.keywordIds.has(keywordId);
    })
  ) return false;
  return true;
}

function increment(target: Record<string, number>, value: string | null): void {
  const key = value ?? UNKNOWN_FACET_VALUE;
  target[key] = (target[key] ?? 0) + 1;
}

function numericSummary(values: readonly (number | null)[]): NumericFacetSummary {
  const known = values.filter((value): value is number => value !== null);
  return {
    min: known.length > 0 ? Math.min(...known) : null,
    max: known.length > 0 ? Math.max(...known) : null,
    knownCount: known.length,
    unknownCount: values.length - known.length,
  };
}

export function computeFacetCounts(
  records: readonly QueryIndexRecord[],
  facets: LibraryFacets,
): LibraryFacetCounts {
  const cameras: Record<string, number> = {};
  const lenses: Record<string, number> = {};
  const locations: Record<string, number> = {};
  const captureYears: Record<string, number> = {};
  const albums: Record<string, number> = {};
  const keywords: Record<string, number> = {};
  const edited: Record<EditedFacetValue, number> = { edited: 0, unedited: 0 };
  const metadataAvailability: Record<MetadataAvailabilityFacetValue, number> = {
    ready: 0,
    pending: 0,
    warning: 0,
    error: 0,
  };
  const metadataSync: Record<MetadataSyncStatus, number> = {
    clean: 0,
    "catalog-only": 0,
    "sidecar-only": 0,
    pending: 0,
    conflict: 0,
    error: 0,
    disabled: 0,
  };

  for (const record of records) {
    if (matchesFacets(record, facets, "cameras")) increment(cameras, record.camera);
    if (matchesFacets(record, facets, "lenses")) increment(lenses, record.lens);
    if (matchesFacets(record, facets, "locations")) increment(locations, record.location);
    if (matchesFacets(record, facets, "captureYears")) increment(captureYears, record.captureYear);
    if (matchesFacets(record, facets, "metadataAvailability")) {
      metadataAvailability[record.metadataAvailability] += 1;
    }
    if (matchesFacets(record, facets, "metadataSync")) {
      metadataSync[record.metadataSync] += 1;
    }
    if (matchesFacets(record, facets, "edited")) {
      edited[record.edited ? "edited" : "unedited"] += 1;
    }
    if (matchesFacets(record, facets, "albums")) {
      if (record.albumIds.size === 0) increment(albums, null);
      for (const albumId of record.albumIds) increment(albums, albumId);
    }
    if (matchesFacets(record, facets, "keywords")) {
      if (record.keywordIds.size === 0) increment(keywords, null);
      for (const keywordId of record.keywordIds) increment(keywords, keywordId);
    }
  }

  const isoRecords = records.filter((record) => matchesFacets(record, facets, "iso"));
  const focalRecords = records.filter((record) => matchesFacets(record, facets, "focalLength"));
  return {
    cameras,
    lenses,
    iso: numericSummary(isoRecords.map((record) => record.iso)),
    focalLength: numericSummary(focalRecords.map((record) => record.focalLength)),
    locations,
    captureYears,
    metadataAvailability,
    metadataSync,
    edited,
    albums,
    keywords,
  };
}

function compareText(actual: string | null, predicate: Extract<SmartPredicate, { kind: "text" }>): boolean {
  if (predicate.operator === "missing") return actual === null || actual.length === 0;
  if (actual === null || predicate.value === null) return false;
  const left = normalizeSearchText(actual);
  const right = normalizeSearchText(predicate.value);
  return predicate.operator === "contains" ? left.includes(right) : left === right;
}

function compareNumber(actual: number | null, predicate: Extract<SmartPredicate, { kind: "number" }>): boolean {
  if (predicate.operator === "missing") return actual === null;
  if (actual === null || predicate.value === null) return false;
  if (predicate.operator === "atLeast") return actual >= predicate.value;
  if (predicate.operator === "atMost") return actual <= predicate.value;
  return actual === predicate.value;
}

function textField(record: QueryIndexRecord, field: Extract<SmartPredicate, { kind: "text" }>["field"]): string | null {
  if (field === "filename") return record.filename;
  if (field === "path") return record.path;
  if (field === "format") return record.format;
  if (field === "camera") return record.camera;
  if (field === "lens") return record.lens;
  if (field === "location") return record.location;
  if (field === "album") return record.albumNames.join("\n") || null;
  return record.keywordPaths.join("\n") || null;
}

export function evaluateSmartRule(
  group: SmartRuleGroup,
  entry: LibraryEntry,
  record: QueryIndexRecord,
  metadata: EntryMetadata,
  analysis: EntryAnalysis | undefined,
): boolean {
  const results = group.children.map((child) => {
    if ("version" in child) {
      return evaluateSmartRule(child, entry, record, metadata, analysis);
    }
    if (child.kind === "text") return compareText(textField(record, child.field), child);
    if (child.kind === "number") {
      const value = child.field === "rating"
        ? metadata.rating
        : child.field === "captureTime"
          ? analysis?.captureTimeKey ?? null
          : child.field === "iso"
            ? record.iso
            : record.focalLength;
      return compareNumber(value, child);
    }
    if (child.operator === "missing") {
      if (child.field === "edited") return false;
      if (child.field === "pick") return metadata.pick === "none";
      return metadata.colorLabel === null;
    }
    if (child.field === "edited") return record.edited === child.value;
    if (child.field === "pick") return metadata.pick === child.value;
    return metadata.colorLabel === child.value;
  });
  return group.match === "all" ? results.every(Boolean) : results.some(Boolean);
}

export function hasActiveFacets(facets: LibraryFacets): boolean {
  return facets.cameras.length > 0 ||
    facets.lenses.length > 0 ||
    facets.iso.min !== null ||
    facets.iso.max !== null ||
    facets.iso.includeUnknown ||
    facets.focalLength.min !== null ||
    facets.focalLength.max !== null ||
    facets.focalLength.includeUnknown ||
    facets.locations.length > 0 ||
    facets.captureYears.length > 0 ||
    facets.metadataAvailability.length > 0 ||
    facets.metadataSync.length > 0 ||
    facets.edited.length > 0 ||
    facets.albums.length > 0 ||
    facets.keywords.length > 0;
}
