import { isAssetId, type CatalogId } from "../catalog/ids";
import {
  LIBRARY_RESULT_VERSION,
  MAX_LIBRARY_RESULT_ENTRIES,
  parseLibraryResultQueryRecord,
  parseLibraryResultSnapshot,
  type LibraryResultQuery,
  type LibraryResultQueryRecord,
  type LibraryResultSnapshot,
} from "./result-contract";

const STORAGE_KEY = "darkroom:library-results:v1";
const MAX_STORED_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOTS = 12;
const MAX_QUERY_RECORDS = 32;
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const QUERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface RepositoryState {
  readonly version: typeof LIBRARY_RESULT_VERSION;
  readonly activeResultId: string | null;
  readonly snapshots: readonly LibraryResultSnapshot[];
  readonly queries: readonly LibraryResultQueryRecord[];
}

export type LibraryResultResolution =
  | {
      readonly status: "exact" | "reconstructed";
      readonly snapshot: LibraryResultSnapshot;
      readonly query: LibraryResultQueryRecord;
      readonly message: string | null;
    }
  | {
      readonly status: "expired" | "catalog-mismatch" | "invalid-entry" | "empty";
      readonly snapshot: null;
      readonly query: LibraryResultQueryRecord | null;
      readonly message: string;
    };

let memoryState: RepositoryState | null = null;

function emptyState(): RepositoryState {
  return {
    version: LIBRARY_RESULT_VERSION,
    activeResultId: null,
    snapshots: [],
    queries: [],
  };
}

function parseState(value: unknown): RepositoryState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = Object.fromEntries(Object.entries(value));
  if (
    input.version !== LIBRARY_RESULT_VERSION ||
    (input.activeResultId !== null && typeof input.activeResultId !== "string") ||
    !Array.isArray(input.snapshots) ||
    !Array.isArray(input.queries)
  ) return null;
  const snapshots = input.snapshots.map(parseLibraryResultSnapshot);
  const queries = input.queries.map(parseLibraryResultQueryRecord);
  if (snapshots.some((item) => item === null) || queries.some((item) => item === null)) return null;
  return {
    version: LIBRARY_RESULT_VERSION,
    activeResultId: input.activeResultId,
    snapshots: snapshots as LibraryResultSnapshot[],
    queries: queries as LibraryResultQueryRecord[],
  };
}

function pruneState(state: RepositoryState, now = Date.now()): RepositoryState {
  const activeExists = state.activeResultId !== null &&
    state.snapshots.some((snapshot) => snapshot.id === state.activeResultId);
  const activeResultId = activeExists ? state.activeResultId : null;
  const snapshots = state.snapshots
    .filter((snapshot) => snapshot.pinned || snapshot.updatedAt >= now - SNAPSHOT_RETENTION_MS)
    .map((snapshot) => ({
      ...snapshot,
      pinned: snapshot.id === activeResultId,
    }))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt)
    .slice(0, MAX_SNAPSHOTS);
  const retainedQueryIds = new Set(snapshots.map((snapshot) => snapshot.queryRecordId));
  const queries = state.queries
    .filter((query) => retainedQueryIds.has(query.id) || query.updatedAt >= now - QUERY_RETENTION_MS)
    .sort((left, right) => (
      Number(retainedQueryIds.has(right.id)) - Number(retainedQueryIds.has(left.id)) ||
      right.updatedAt - left.updatedAt
    ))
    .slice(0, Math.max(MAX_QUERY_RECORDS, retainedQueryIds.size));
  return {
    version: LIBRARY_RESULT_VERSION,
    activeResultId: snapshots.some((snapshot) => snapshot.id === activeResultId)
      ? activeResultId
      : null,
    snapshots,
    queries,
  };
}

function loadState(): RepositoryState {
  if (memoryState !== null) {
    memoryState = pruneState(memoryState);
    return memoryState;
  }
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw.length > MAX_STORED_BYTES) {
      memoryState = emptyState();
      return memoryState;
    }
    memoryState = pruneState(parseState(JSON.parse(raw)) ?? emptyState());
    return memoryState;
  } catch {
    memoryState = emptyState();
    return memoryState;
  }
}

function saveState(next: RepositoryState): void {
  const pruned = pruneState(next);
  const serialized = JSON.stringify(pruned);
  if (serialized.length > MAX_STORED_BYTES) {
    throw new Error("This Library result is too large to save. Narrow the Library filters and try again.");
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      throw new Error(
        "Darkroom could not save this Library result. Free browser storage and try again.",
        { cause: error },
      );
    }
  }
  memoryState = pruned;
}

function validateEntryIds(entryIds: readonly string[], label: string): string[] {
  if (entryIds.length === 0) throw new Error(`${label} cannot be empty.`);
  if (entryIds.length > MAX_LIBRARY_RESULT_ENTRIES) {
    throw new Error(`${label} exceeds the ${MAX_LIBRARY_RESULT_ENTRIES.toLocaleString()} photo limit.`);
  }
  const unique = [...new Set(entryIds)];
  if (unique.length !== entryIds.length || unique.some((entryId) => !isAssetId(entryId))) {
    throw new Error(`${label} is invalid.`);
  }
  return unique;
}

function queryRecord(query: LibraryResultQuery, id: string, now: number): LibraryResultQueryRecord {
  return {
    version: LIBRARY_RESULT_VERSION,
    id,
    ...query,
    facets: {
      ...query.facets,
      cameras: [...query.facets.cameras],
      lenses: [...query.facets.lenses],
      iso: { ...query.facets.iso },
      focalLength: { ...query.facets.focalLength },
      locations: [...query.facets.locations],
      captureYears: [...query.facets.captureYears],
      metadataAvailability: [...query.facets.metadataAvailability],
      metadataSync: [...query.facets.metadataSync],
      edited: [...query.facets.edited],
      albums: [...query.facets.albums],
      keywords: [...query.facets.keywords],
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function createLibraryResultSnapshot(input: {
  readonly query: LibraryResultQuery;
  readonly orderedEntryIds: readonly string[];
  readonly activeEntryId: string;
  readonly selectedEntryIds: readonly string[];
  readonly focusedEntryId?: string | null;
  readonly scrollAnchorEntryId?: string | null;
}): LibraryResultSnapshot {
  const orderedEntryIds = validateEntryIds(input.orderedEntryIds, "Library result");
  if (!orderedEntryIds.includes(input.activeEntryId)) {
    throw new Error("The active photo is not part of this Library result.");
  }
  const orderedEntryIdSet = new Set(orderedEntryIds);
  const selectedEntryIds = [...new Set(input.selectedEntryIds)].filter((entryId) =>
    orderedEntryIdSet.has(entryId)
  );
  const focusedEntryId = input.focusedEntryId ?? input.activeEntryId;
  const scrollAnchorEntryId = input.scrollAnchorEntryId ?? input.activeEntryId;
  if (!orderedEntryIdSet.has(focusedEntryId) || !orderedEntryIdSet.has(scrollAnchorEntryId)) {
    throw new Error("The saved Library focus is not part of this result.");
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const snapshot: LibraryResultSnapshot = {
    version: LIBRARY_RESULT_VERSION,
    id,
    queryRecordId: id,
    catalogId: input.query.catalogId,
    catalogRevision: input.query.catalogRevision,
    orderedEntryIds,
    missingEntryIds: [],
    activeEntryId: input.activeEntryId,
    origin: {
      selectedEntryIds,
      focusedEntryId,
      scrollAnchorEntryId,
    },
    pinned: true,
    createdAt: now,
    updatedAt: now,
  };
  const state = loadState();
  saveState({
    version: LIBRARY_RESULT_VERSION,
    activeResultId: id,
    snapshots: [snapshot, ...state.snapshots.map((item) => ({ ...item, pinned: false }))],
    queries: [
      queryRecord(input.query, id, now),
      ...state.queries.map((item) => item.id === state.activeResultId
        ? { ...item, updatedAt: now }
        : item),
    ],
  });
  return snapshot;
}

export function getLibraryResultQuery(resultId: string): LibraryResultQueryRecord | null {
  return loadState().queries.find((query) => query.id === resultId) ?? null;
}

export function getLibraryResultSnapshot(resultId: string): LibraryResultSnapshot | null {
  let state = loadState();
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const persisted = raw !== null && raw.length <= MAX_STORED_BYTES
        ? parseState(JSON.parse(raw))
        : null;
      state = pruneState(persisted ?? emptyState());
      memoryState = state;
    } catch {
      return null;
    }
  }
  const snapshot = state.snapshots.find((item) => item.id === resultId);
  return snapshot ? structuredClone(snapshot) : null;
}

function pinAndSave(
  state: RepositoryState,
  snapshot: LibraryResultSnapshot,
): LibraryResultSnapshot {
  const now = Date.now();
  const pinned = { ...snapshot, pinned: true, updatedAt: now };
  saveState({
    ...state,
    activeResultId: pinned.id,
    snapshots: state.snapshots.map((item) => item.id === pinned.id
      ? pinned
      : { ...item, pinned: false }),
    queries: state.queries.map((item) => item.id === pinned.queryRecordId
      ? { ...item, updatedAt: now }
      : item),
  });
  return pinned;
}

function missingIds(
  orderedEntryIds: readonly string[],
  availableEntryIds: readonly string[],
): string[] {
  const available = new Set(availableEntryIds);
  return orderedEntryIds.filter((entryId) => !available.has(entryId));
}

function readyMessage(snapshot: LibraryResultSnapshot, prefix: string | null): string | null {
  const count = snapshot.missingEntryIds.length;
  const missing = count === 0
    ? null
    : `${count} ${count === 1 ? "photo is" : "photos are"} missing from this saved result. Locate or re-link ${count === 1 ? "it" : "them"} in Library.`;
  return [prefix, missing].filter(Boolean).join(" ") || null;
}

function nearestAvailableEntryId(
  orderedEntryIds: readonly string[],
  requestedEntryId: string,
  availableEntryIds: readonly string[],
): string | null {
  const available = new Set(availableEntryIds);
  const requestedIndex = orderedEntryIds.indexOf(requestedEntryId);
  if (requestedIndex < 0) return orderedEntryIds.find((entryId) => available.has(entryId)) ?? null;
  if (available.has(requestedEntryId)) return requestedEntryId;
  for (let distance = 1; distance < orderedEntryIds.length; distance += 1) {
    const after = orderedEntryIds[requestedIndex + distance];
    if (after && available.has(after)) return after;
    const before = orderedEntryIds[requestedIndex - distance];
    if (before && available.has(before)) return before;
  }
  return null;
}

export function resolveLibraryResultSnapshot(input: {
  readonly resultId: string;
  readonly requestedEntryId: string;
  readonly catalogId: CatalogId | null;
  readonly catalogRevision: number;
  readonly availableEntryIds: readonly string[];
  readonly reconstructedEntryIds: readonly string[];
  readonly selectedEntryIds: readonly string[];
}): LibraryResultResolution {
  const state = loadState();
  const query = state.queries.find((item) => item.id === input.resultId) ?? null;
  const existing = state.snapshots.find((item) => item.id === input.resultId) ?? null;
  const expectedCatalogId = existing?.catalogId ?? query?.catalogId ?? null;
  if (expectedCatalogId !== null && input.catalogId !== expectedCatalogId) {
    return {
      status: "catalog-mismatch",
      snapshot: null,
      query,
      message: "This result belongs to another catalog. Return to Library and open that catalog first.",
    };
  }
  if (existing !== null && query !== null) {
    if (!existing.orderedEntryIds.includes(input.requestedEntryId)) {
      return {
        status: "invalid-entry",
        snapshot: null,
        query,
        message: "This photo is not part of the saved Library result. Return to Library and open it again.",
      };
    }
    const nextMissing = missingIds(existing.orderedEntryIds, input.availableEntryIds);
    const activeEntryId = nearestAvailableEntryId(
      existing.orderedEntryIds,
      input.requestedEntryId,
      input.availableEntryIds,
    );
    if (activeEntryId === null) {
      pinAndSave(state, { ...existing, missingEntryIds: nextMissing });
      return {
        status: "empty",
        snapshot: null,
        query,
        message: "Every photo in this saved result is missing. Return to Library to locate or re-link them.",
      };
    }
    const next = pinAndSave(state, {
      ...existing,
      missingEntryIds: nextMissing,
      activeEntryId,
    });
    const prefix = activeEntryId === input.requestedEntryId
      ? null
      : "The requested photo is missing. Showing the nearest available photo.";
    return { status: "exact", snapshot: next, query, message: readyMessage(next, prefix) };
  }
  if (query === null) {
    return {
      status: "expired",
      snapshot: null,
      query: null,
      message: "This Library result has expired. Return to Library and open the photo again.",
    };
  }
  if (input.reconstructedEntryIds.length === 0) {
    return {
      status: "empty",
      snapshot: null,
      query,
      message: "The saved Library filters no longer match any photos. Return to Library and update the filters.",
    };
  }
  const orderedEntryIds = validateEntryIds(input.reconstructedEntryIds, "Reconstructed Library result");
  const orderedEntryIdSet = new Set(orderedEntryIds);
  const activeEntryId = nearestAvailableEntryId(
    orderedEntryIds,
    input.requestedEntryId,
    input.availableEntryIds,
  );
  if (activeEntryId === null) {
    return {
      status: "empty",
      snapshot: null,
      query,
      message: "Every photo matching the saved Library filters is missing. Return to Library to locate or re-link them.",
    };
  }
  const now = Date.now();
  const reconstructedSelection = input.selectedEntryIds.filter((entryId) =>
    orderedEntryIdSet.has(entryId)
  );
  const snapshot: LibraryResultSnapshot = {
    version: LIBRARY_RESULT_VERSION,
    id: input.resultId,
    queryRecordId: query.id,
    catalogId: query.catalogId,
    catalogRevision: input.catalogRevision,
    orderedEntryIds,
    missingEntryIds: missingIds(orderedEntryIds, input.availableEntryIds),
    activeEntryId,
    origin: {
      selectedEntryIds: reconstructedSelection.length > 0
        ? reconstructedSelection
        : [activeEntryId],
      focusedEntryId: activeEntryId,
      scrollAnchorEntryId: activeEntryId,
    },
    pinned: true,
    createdAt: now,
    updatedAt: now,
  };
  const saved = pinAndSave({
    ...state,
    snapshots: [snapshot, ...state.snapshots],
  }, snapshot);
  return {
    status: "reconstructed",
    snapshot: saved,
    query,
    message: readyMessage(
      saved,
      activeEntryId === input.requestedEntryId
        ? "The exact snapshot expired, so Darkroom rebuilt it from its saved filters."
        : orderedEntryIdSet.has(input.requestedEntryId)
          ? "The exact snapshot expired, and the requested photo is missing. Showing the nearest available match."
          : "The exact snapshot expired, and the requested photo no longer matches the saved filters. Showing the first available match.",
    ),
  };
}

export function refreshLibraryResultSnapshot(input: {
  readonly resultId: string;
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly orderedEntryIds: readonly string[];
  readonly activeEntryId: string;
  readonly availableEntryIds: readonly string[];
  readonly selectedEntryIds: readonly string[];
}): LibraryResultSnapshot {
  const state = loadState();
  const current = state.snapshots.find((snapshot) => snapshot.id === input.resultId);
  const query = state.queries.find((item) => item.id === input.resultId);
  if (!current || !query || current.catalogId !== input.catalogId) {
    throw new Error("This Library result can no longer be refreshed. Return to Library and open it again.");
  }
  const orderedEntryIds = validateEntryIds(input.orderedEntryIds, "Refreshed Library result");
  const orderedEntryIdSet = new Set(orderedEntryIds);
  const activeEntryId = nearestAvailableEntryId(
    orderedEntryIds,
    input.activeEntryId,
    input.availableEntryIds,
  );
  if (activeEntryId === null) {
    throw new Error("The refreshed Library result contains no available photos. Locate or re-link them in Library.");
  }
  const refreshedSelection = input.selectedEntryIds.filter((entryId) =>
    orderedEntryIdSet.has(entryId)
  );
  return pinAndSave(state, {
    ...current,
    catalogRevision: input.catalogRevision,
    orderedEntryIds,
    missingEntryIds: missingIds(orderedEntryIds, input.availableEntryIds),
    activeEntryId,
    origin: {
      selectedEntryIds: refreshedSelection.length > 0
        ? refreshedSelection
        : [activeEntryId],
      focusedEntryId: activeEntryId,
      scrollAnchorEntryId: activeEntryId,
    },
  });
}

export function updateLibraryResultActive(resultId: string, activeEntryId: string): void {
  const state = loadState();
  const current = state.snapshots.find((snapshot) => snapshot.id === resultId);
  if (!current || current.activeEntryId === activeEntryId || !current.orderedEntryIds.includes(activeEntryId)) {
    return;
  }
  pinAndSave(state, { ...current, activeEntryId });
}

export const LIBRARY_RESULT_RETENTION = {
  maxSnapshots: MAX_SNAPSHOTS,
  maxQueryRecords: MAX_QUERY_RECORDS,
  snapshotRetentionMs: SNAPSHOT_RETENTION_MS,
  queryRetentionMs: QUERY_RETENTION_MS,
} as const;
