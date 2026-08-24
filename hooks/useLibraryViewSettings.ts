"use client";

import { useCallback, useSyncExternalStore } from "react";
import type {
  CurationFilter,
  FilterOption,
  GridViewMode,
  SortOption,
} from "@/lib/library/curation";
import {
  EMPTY_LIBRARY_FACETS,
  type EditedFacetValue,
  type LibraryFacets,
  type MetadataAvailabilityFacetValue,
  type NumericFacetRange,
} from "@/lib/library/query";
import type { MetadataSyncStatus } from "@/lib/metadata/types";

export interface LibraryViewSettings {
  readonly sort: SortOption;
  readonly sortDirection: "ascending" | "descending";
  readonly filter: FilterOption;
  readonly curationFilter: CurationFilter;
  readonly textQuery: string;
  readonly facets: LibraryFacets;
  readonly thumbSize: number;
  readonly viewMode: GridViewMode;
  readonly expandedStackIds: readonly string[];
  readonly expandedCollectionIds: readonly string[];
  readonly autoAdvance: boolean;
}

const STORAGE_KEY = "darkroom:library-view-settings";
const CHANGE_EVENT = "darkroom:library-view-settings-change";
const DEFAULT_SETTINGS: LibraryViewSettings = {
  sort: "name",
  sortDirection: "ascending",
  filter: "all",
  curationFilter: "all",
  textQuery: "",
  facets: EMPTY_LIBRARY_FACETS,
  thumbSize: 180,
  viewMode: "dynamic",
  expandedStackIds: [],
  expandedCollectionIds: [],
  autoAdvance: false,
};

type RecordValue = Record<string, unknown>;

let cachedRaw: string | null | undefined;
let cachedSettings = DEFAULT_SETTINGS;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numericRange(value: unknown): NumericFacetRange {
  if (!isRecord(value)) return { min: null, max: null, includeUnknown: false };
  return {
    min: typeof value.min === "number" && Number.isFinite(value.min) ? value.min : null,
    max: typeof value.max === "number" && Number.isFinite(value.max) ? value.max : null,
    includeUnknown: value.includeUnknown === true,
  };
}

function parseFacets(value: unknown): LibraryFacets {
  if (!isRecord(value)) return EMPTY_LIBRARY_FACETS;
  const edited = stringArray(value.edited).filter(
    (item): item is EditedFacetValue => item === "edited" || item === "unedited",
  );
  const metadataAvailability = stringArray(value.metadataAvailability).filter(
    (item): item is MetadataAvailabilityFacetValue => (
      item === "ready" || item === "pending" || item === "warning" || item === "error"
    ),
  );
  const metadataSync = stringArray(value.metadataSync).filter(
    (item): item is MetadataSyncStatus => (
      item === "clean" || item === "catalog-only" || item === "sidecar-only" ||
      item === "pending" || item === "conflict" || item === "error" || item === "disabled"
    ),
  );
  return {
    cameras: stringArray(value.cameras),
    lenses: stringArray(value.lenses),
    iso: numericRange(value.iso),
    focalLength: numericRange(value.focalLength),
    locations: stringArray(value.locations),
    captureYears: stringArray(value.captureYears),
    metadataAvailability,
    metadataSync,
    edited,
    albums: stringArray(value.albums),
    keywords: stringArray(value.keywords),
    keywordMode: value.keywordMode === "descendants" || value.keywordMode === "ancestors"
      ? value.keywordMode
      : "exact",
  };
}

function parseSort(value: unknown): SortOption {
  return value === "name" || value === "date" || value === "rating" || value === "pick"
    ? value
    : DEFAULT_SETTINGS.sort;
}

function parseFilter(value: unknown): FilterOption {
  return value === "all" || value === "raw" || value === "standard"
    ? value
    : DEFAULT_SETTINGS.filter;
}

function parseCurationFilter(value: unknown): CurationFilter {
  if (
    value === "all" ||
    value === "picked" ||
    value === "rejected" ||
    value === "unpicked" ||
    value === "rated" ||
    value === "rating-1" ||
    value === "rating-2" ||
    value === "rating-3" ||
    value === "rating-4" ||
    value === "rating-5" ||
    value === "label-red" ||
    value === "label-yellow" ||
    value === "label-green" ||
    value === "label-blue" ||
    value === "label-purple"
  ) {
    return value;
  }
  return DEFAULT_SETTINGS.curationFilter;
}

function parseSettings(raw: string | null): LibraryViewSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_SETTINGS;
    const sort = parseSort(parsed.sort);
    const thumbSize = typeof parsed.thumbSize === "number" &&
      parsed.thumbSize >= 120 &&
      parsed.thumbSize <= 320
      ? parsed.thumbSize
      : DEFAULT_SETTINGS.thumbSize;
    return {
      sort,
      sortDirection: parsed.sortDirection === "ascending" || parsed.sortDirection === "descending"
        ? parsed.sortDirection
        : sort === "date" ? "descending" : "ascending",
      filter: parseFilter(parsed.filter),
      curationFilter: parseCurationFilter(parsed.curationFilter),
      textQuery: typeof parsed.textQuery === "string" ? parsed.textQuery.slice(0, 500) : "",
      facets: parseFacets(parsed.facets),
      thumbSize,
      viewMode: parsed.viewMode === "grid" || parsed.viewMode === "dynamic"
        ? parsed.viewMode
        : DEFAULT_SETTINGS.viewMode,
      expandedStackIds: stringArray(parsed.expandedStackIds),
      expandedCollectionIds: stringArray(parsed.expandedCollectionIds),
      autoAdvance: parsed.autoAdvance === true,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function getSnapshot(): LibraryViewSettings {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSettings = parseSettings(raw);
  }
  return cachedSettings;
}

function subscribe(onStoreChange: () => void): () => void {
  function onStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) {
      cachedRaw = undefined;
      onStoreChange();
    }
  }
  function onLocalChange() {
    cachedRaw = undefined;
    onStoreChange();
  }
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onLocalChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onLocalChange);
  };
}

export function useLibraryViewSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_SETTINGS,
  );
  const updateSettings = useCallback((patch: Partial<LibraryViewSettings>) => {
    const next = { ...getSnapshot(), ...patch };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [settings, updateSettings] as const;
}
