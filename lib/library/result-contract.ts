import { isAssetId, isCatalogId, type CatalogId } from "../catalog/ids";
import type { CurationFilter, FilterOption, SortOption } from "./curation";
import type { LibraryFacets, NumericFacetRange } from "./query";
import type { LibraryPrimaryScope } from "./result";

export const LIBRARY_RESULT_VERSION = 1;
export const MAX_LIBRARY_RESULT_ENTRIES = 100_000;

export interface LibraryResultQuery {
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly primaryScope: LibraryPrimaryScope;
  readonly archivePolicy: "exclude" | "only";
  readonly textQuery: string;
  readonly facets: LibraryFacets;
  readonly curationFilter: CurationFilter;
  readonly formatFilter: FilterOption;
  readonly sort: SortOption;
  readonly sortDirection: "ascending" | "descending";
}

export interface LibraryResultQueryRecord extends LibraryResultQuery {
  readonly version: typeof LIBRARY_RESULT_VERSION;
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LibraryResultSnapshot {
  readonly version: typeof LIBRARY_RESULT_VERSION;
  readonly id: string;
  readonly queryRecordId: string;
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly orderedEntryIds: readonly string[];
  readonly missingEntryIds: readonly string[];
  readonly activeEntryId: string;
  readonly origin: {
    readonly selectedEntryIds: readonly string[];
    readonly focusedEntryId: string | null;
    readonly scrollAnchorEntryId: string | null;
  };
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type RecordValue = Record<string, unknown>;

const CURATION_FILTERS: ReadonlySet<string> = new Set([
  "all", "picked", "rejected", "unpicked", "rated",
  "rating-1", "rating-2", "rating-3", "rating-4", "rating-5",
  "label-red", "label-yellow", "label-green", "label-blue", "label-purple",
]);
const METADATA_AVAILABILITY = new Set(["ready", "pending", "warning", "error"]);
const METADATA_SYNC = new Set([
  "clean", "catalog-only", "sidecar-only", "pending", "conflict", "error", "disabled",
]);
const RESULT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isLibraryResultId(value: unknown): value is string {
  return typeof value === "string" && RESULT_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = 4_096): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function stringArray(value: unknown, limit = 512): string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const values: string[] = [];
  for (const item of value) {
    const parsed = boundedString(item, 1_024);
    if (parsed === null) return null;
    values.push(parsed);
  }
  return values;
}

function uniqueStringArray(value: unknown, limit: number): string[] | null {
  const values = stringArray(value, limit);
  return values !== null && new Set(values).size === values.length ? values : null;
}

function numericRange(value: unknown): NumericFacetRange | null {
  if (!isRecord(value)) return null;
  const min = value.min === null || (typeof value.min === "number" && Number.isFinite(value.min))
    ? value.min
    : undefined;
  const max = value.max === null || (typeof value.max === "number" && Number.isFinite(value.max))
    ? value.max
    : undefined;
  if (min === undefined || max === undefined || typeof value.includeUnknown !== "boolean") return null;
  if (typeof min === "number" && typeof max === "number" && min > max) return null;
  return { min, max, includeUnknown: value.includeUnknown };
}

function enumArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T[] | null {
  const values = uniqueStringArray(value, allowed.size);
  return values !== null && values.every((item) => allowed.has(item))
    ? values as T[]
    : null;
}

function parseFacets(value: unknown): LibraryFacets | null {
  if (!isRecord(value)) return null;
  const cameras = stringArray(value.cameras);
  const lenses = stringArray(value.lenses);
  const iso = numericRange(value.iso);
  const focalLength = numericRange(value.focalLength);
  const locations = stringArray(value.locations);
  const captureYears = stringArray(value.captureYears);
  const metadataAvailability = enumArray<LibraryFacets["metadataAvailability"][number]>(
    value.metadataAvailability,
    METADATA_AVAILABILITY,
  );
  const metadataSync = enumArray<LibraryFacets["metadataSync"][number]>(
    value.metadataSync,
    METADATA_SYNC,
  );
  const edited = enumArray<LibraryFacets["edited"][number]>(
    value.edited,
    new Set(["edited", "unedited"]),
  );
  const albums = stringArray(value.albums);
  const keywords = stringArray(value.keywords);
  if (
    cameras === null || lenses === null || iso === null || focalLength === null ||
    locations === null || captureYears === null || metadataAvailability === null ||
    metadataSync === null || edited === null || albums === null || keywords === null ||
    (value.keywordMode !== "exact" && value.keywordMode !== "descendants" && value.keywordMode !== "ancestors")
  ) return null;
  return {
    cameras,
    lenses,
    iso,
    focalLength,
    locations,
    captureYears,
    metadataAvailability,
    metadataSync,
    edited,
    albums,
    keywords,
    keywordMode: value.keywordMode,
  };
}

function parsePrimaryScope(value: unknown): LibraryPrimaryScope | null {
  if (!isRecord(value)) return null;
  if (value.type === "all" || value.type === "quick" || value.type === "archive" || value.type === "duplicates") {
    return { type: value.type };
  }
  if (value.type === "folder") {
    if (value.path === null) return { type: "folder", path: null };
    const path = boundedString(value.path);
    return path === null ? null : { type: "folder", path };
  }
  if (value.type === "album") {
    const albumId = boundedString(value.albumId, 256);
    return albumId === null ? null : { type: "album", albumId };
  }
  if (value.type === "smart") {
    const collectionId = boundedString(value.collectionId, 256);
    return collectionId === null ? null : { type: "smart", collectionId };
  }
  return null;
}

function parseQuery(value: RecordValue): LibraryResultQuery | null {
  const primaryScope = parsePrimaryScope(value.primaryScope);
  const facets = parseFacets(value.facets);
  if (
    !isCatalogId(value.catalogId) ||
    typeof value.catalogRevision !== "number" ||
    !Number.isSafeInteger(value.catalogRevision) ||
    value.catalogRevision < 0 ||
    primaryScope === null ||
    (value.archivePolicy !== "exclude" && value.archivePolicy !== "only") ||
    value.archivePolicy !== (primaryScope.type === "archive" ? "only" : "exclude") ||
    typeof value.textQuery !== "string" ||
    value.textQuery.length > 500 ||
    facets === null ||
    !CURATION_FILTERS.has(String(value.curationFilter)) ||
    (value.formatFilter !== "all" && value.formatFilter !== "raw" && value.formatFilter !== "standard") ||
    (value.sort !== "name" && value.sort !== "date" && value.sort !== "rating" && value.sort !== "pick") ||
    (value.sortDirection !== "ascending" && value.sortDirection !== "descending")
  ) return null;
  return {
    catalogId: value.catalogId,
    catalogRevision: value.catalogRevision,
    primaryScope,
    archivePolicy: value.archivePolicy,
    textQuery: value.textQuery,
    facets,
    curationFilter: value.curationFilter as CurationFilter,
    formatFilter: value.formatFilter,
    sort: value.sort,
    sortDirection: value.sortDirection,
  };
}

export function parseLibraryResultQueryRecord(value: unknown): LibraryResultQueryRecord | null {
  if (!isRecord(value) || value.version !== LIBRARY_RESULT_VERSION) return null;
  const id = isLibraryResultId(value.id) ? value.id : null;
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const query = parseQuery(value);
  if (id === null || createdAt === null || updatedAt === null || updatedAt < createdAt || query === null) {
    return null;
  }
  return { version: LIBRARY_RESULT_VERSION, id, ...query, createdAt, updatedAt };
}

export function parseLibraryResultSnapshot(value: unknown): LibraryResultSnapshot | null {
  if (!isRecord(value) || value.version !== LIBRARY_RESULT_VERSION || !isCatalogId(value.catalogId)) {
    return null;
  }
  const id = isLibraryResultId(value.id) ? value.id : null;
  const queryRecordId = isLibraryResultId(value.queryRecordId) ? value.queryRecordId : null;
  const orderedEntryIds = uniqueStringArray(value.orderedEntryIds, MAX_LIBRARY_RESULT_ENTRIES);
  const missingEntryIds = uniqueStringArray(value.missingEntryIds, MAX_LIBRARY_RESULT_ENTRIES);
  const activeEntryId = boundedString(value.activeEntryId, 1_024);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const orderedEntryIdSet = orderedEntryIds === null ? null : new Set(orderedEntryIds);
  if (
    id === null || queryRecordId !== id || orderedEntryIds === null || orderedEntryIds.length === 0 ||
    orderedEntryIds.some((entryId) => !isAssetId(entryId)) ||
    missingEntryIds === null || missingEntryIds.some((entryId) => !orderedEntryIdSet?.has(entryId)) ||
    activeEntryId === null || !orderedEntryIdSet?.has(activeEntryId) ||
    typeof value.catalogRevision !== "number" || !Number.isSafeInteger(value.catalogRevision) || value.catalogRevision < 0 ||
    !isRecord(value.origin) || typeof value.pinned !== "boolean" ||
    createdAt === null || updatedAt === null || updatedAt < createdAt
  ) return null;
  const selectedEntryIds = uniqueStringArray(value.origin.selectedEntryIds, MAX_LIBRARY_RESULT_ENTRIES);
  const focusedEntryId = value.origin.focusedEntryId === null
    ? null
    : boundedString(value.origin.focusedEntryId, 1_024);
  const scrollAnchorEntryId = value.origin.scrollAnchorEntryId === null
    ? null
    : boundedString(value.origin.scrollAnchorEntryId, 1_024);
  if (
    selectedEntryIds === null || selectedEntryIds.some((entryId) => !orderedEntryIdSet?.has(entryId)) ||
    focusedEntryId === null && value.origin.focusedEntryId !== null ||
    scrollAnchorEntryId === null && value.origin.scrollAnchorEntryId !== null ||
    focusedEntryId !== null && !orderedEntryIdSet?.has(focusedEntryId) ||
    scrollAnchorEntryId !== null && !orderedEntryIdSet?.has(scrollAnchorEntryId)
  ) return null;
  return {
    version: LIBRARY_RESULT_VERSION,
    id,
    queryRecordId,
    catalogId: value.catalogId,
    catalogRevision: value.catalogRevision,
    orderedEntryIds,
    missingEntryIds,
    activeEntryId,
    origin: { selectedEntryIds, focusedEntryId, scrollAnchorEntryId },
    pinned: value.pinned,
    createdAt,
    updatedAt,
  };
}
