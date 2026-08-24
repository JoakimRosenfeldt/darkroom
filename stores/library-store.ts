import { create } from "zustand";
import { formatPickerError } from "@/lib/fs/access";
import {
  activateCatalog,
  addCatalogRoot as addCatalogRootSession,
  bootstrapCatalog,
  cancelCatalogScan,
  clearSessionCatalog,
  closeActiveCatalog,
  createCatalog as createCatalogSession,
  getActiveCatalogView,
  queryActiveCatalog,
  relinkCatalogRoot as relinkCatalogRootSession,
  removeCatalog as removeCatalogSession,
  renameActiveCatalog,
  scanCatalogRoot,
  scheduleCatalogStateSync,
  subscribeCatalogState,
  switchCatalog as switchCatalogSession,
  type CatalogRootState,
  type HydratedCatalogState,
  type ScanProgress,
} from "@/lib/fs/session-catalog";
import type {
  CatalogActivationResult,
  CatalogPresetView,
  CatalogSummary,
} from "@/lib/catalog/api";
import {
  createOperationId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "@/lib/catalog/ids";
import type { CatalogV3FingerprintCoverage } from "@/lib/catalog/v3";
import type { SessionId } from "@/lib/catalog/runtime";
import {
  getEntryMetadata,
  createEntryMetadata,
} from "@/lib/catalog/defaults";
import type {
  Album,
  EntryMetadata,
} from "@/lib/catalog/types";
import { filterArchivedEntries, filterOnlyArchivedEntries } from "@/lib/library/archive";
import { pruneMetadataForEntries } from "@/lib/library/curation";
import { pruneAlbumsForEntries } from "@/lib/library/folders";
import {
  createLibraryWorkspaceState,
  entryAnalysisCacheSignature,
  type LibraryWorkspaceState,
} from "@/lib/library/model";
import type { MetadataAnalysisProgress } from "@/lib/library/metadata-analysis";
import { reconcileSelectionToResult } from "@/lib/library/result";
import { getDarkroomAPI } from "@/lib/fs/platform";
import { getAssetRequest } from "@/lib/fs/session-catalog";
import type { LibraryEntry } from "@/lib/fs/types";
import { createDefaultDevelopDocument } from "@/lib/develop/document";
import { setDevelopMetadataWriter, useDevelopStore } from "@/stores/develop-store";

const fsDebug = (...args: unknown[]) => console.log("[darkroom:fs]", ...args);
const fsDebugError = (step: string, error: unknown) =>
  console.error("[darkroom:fs]", step, error);

export type ImportState = "idle" | "importing" | "restoring" | "error";

export interface SelectEntryModifiers {
  shift?: boolean;
  toggle?: boolean;
}

export interface MetadataAnalysisState {
  operationId: OperationId;
  total: number;
  completed: number;
  failed: number;
  cancelled: boolean;
}

type SidecarMetadataPatch = Partial<Pick<EntryMetadata, "rating" | "colorLabel">>;

export type CatalogView =
  | { type: "all" }
  | { type: "folder"; path: string | null }
  | { type: "album"; albumId: string }
  | { type: "archive" };

interface LibraryStore {
  catalogId: CatalogId | null;
  sessionId: SessionId | null;
  catalogRevision: number;
  folderName: string | null;
  entries: LibraryEntry[];
  unresolvedEntries: LibraryEntry[];
  fingerprintCoverage: CatalogV3FingerprintCoverage;
  importPresets: readonly CatalogPresetView[];
  albums: Album[];
  archivedEntryIds: string[];
  libraryWorkspace: LibraryWorkspaceState;
  catalogs: readonly CatalogSummary[];
  catalogRoots: readonly CatalogRootState[];
  catalogManagerOpen: boolean;
  catalogView: CatalogView;
  importState: ImportState;
  importStatus: string | null;
  importError: string | null;
  metadataAnalysis: MetadataAnalysisState | null;
  catalogRecovery: string | null;
  needsFolderAccess: boolean;
  selectedEntryId: string | null;
  selectedEntryIds: string[];
  selectionAnchorId: string | null;
  entryMetadata: Record<string, EntryMetadata>;
  setSelectedEntryId: (id: string | null) => void;
  clearSelection: () => void;
  selectEntry: (
    id: string,
    modifiers: SelectEntryModifiers,
    visibleOrder: string[],
  ) => void;
  reconcileSelection: (visibleEntryIds: readonly string[]) => void;
  setEntryMetadata: (entryId: string, patch: Partial<EntryMetadata>) => void;
  applyMetadataToEntries: (
    entryIds: string[],
    patch: Partial<EntryMetadata>,
  ) => void;
  mirrorDevelopDocument: (
    entryId: string,
    develop: EntryMetadata["develop"],
    sourceUpdatedAt?: number,
    metadataPatch?: SidecarMetadataPatch,
  ) => void;
  hydrateEntryMetadata: (
    entryId: string,
    patch: SidecarMetadataPatch,
    sourceUpdatedAt: number,
  ) => void;
  restoreEntryMetadata: (
    entryId: string,
    patch: Pick<EntryMetadata, "pick" | "rating" | "colorLabel">,
  ) => void;
  setCatalogView: (view: CatalogView) => void;
  createAlbum: (name: string) => string;
  renameAlbum: (albumId: string, name: string) => void;
  deleteAlbum: (albumId: string) => void;
  addEntriesToAlbum: (albumId: string, entryIds: string[]) => void;
  removeEntriesFromAlbum: (albumId: string, entryIds: string[]) => void;
  removeEntriesFromAllAlbums: (entryIds: string[]) => void;
  archiveEntries: (entryIds: string[]) => void;
  restoreEntries: (entryIds: string[]) => void;
  deleteEntriesFromDisk: (entryIds: string[]) => Promise<void>;
  createCatalog: (displayName: string) => Promise<void>;
  addCatalogRoot: () => Promise<void>;
  relinkCatalogRoot: (rootId?: RootId) => Promise<void>;
  renameCatalog: (displayName: string) => Promise<void>;
  removeCatalogRecent: (catalogId: CatalogId) => Promise<void>;
  deleteCatalog: (catalogId: CatalogId, confirmation: string) => Promise<void>;
  switchCatalog: (catalogId: CatalogId) => Promise<void>;
  openCatalogManager: () => void;
  closeCatalogManager: () => void;
  refreshCatalogs: () => Promise<void>;
  cancelFolderOperation: () => void;
  refreshMetadataAnalysis: () => void;
  cancelMetadataAnalysis: () => void;
  clearLibrary: () => Promise<void>;
  bootstrapLibrary: () => Promise<void>;
}

let folderOperationGeneration = 0;
let metadataProgressUnsubscribe: (() => void) | null = null;

const EMPTY_FINGERPRINT_COVERAGE: CatalogV3FingerprintCoverage = {
  total: 0,
  missing: 0,
  hashing: 0,
  valid: 0,
  stale: 0,
  failed: 0,
};

function beginFolderOperation(): number {
  folderOperationGeneration += 1;
  return folderOperationGeneration;
}

function isActiveFolderOperation(generation: number): boolean {
  return generation === folderOperationGeneration;
}

function restoreSelection(
  entries: LibraryEntry[],
  previousIds: string[],
  previousAnchor: string | null,
): {
  selectedEntryIds: string[];
  selectedEntryId: string | null;
  selectionAnchorId: string | null;
} {
  const validIds = previousIds.filter((id) => entries.some((entry) => entry.id === id));
  const selectedEntryIds = validIds.length > 0
    ? validIds
    : entries[0] ? [entries[0].id] : [];
  const anchorValid = previousAnchor !== null && entries.some((entry) => entry.id === previousAnchor);
  return {
    selectedEntryIds,
    selectedEntryId: selectedEntryIds.at(-1) ?? null,
    selectionAnchorId: anchorValid ? previousAnchor : selectedEntryIds[0] ?? null,
  };
}

function applyHydratedState(
  state: HydratedCatalogState,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  const catalogChanged = get().catalogId !== state.catalogId;
  const sessionChanged = catalogChanged || get().sessionId !== state.sessionId;
  if (catalogChanged) {
    useDevelopStore.getState().clearLibrarySessions();
  }
  const activeEntries = filterArchivedEntries(state.entries, state.archivedEntryIds);
  set({
    catalogId: state.catalogId,
    sessionId: state.sessionId,
    catalogRevision: state.revision,
    folderName: state.displayName,
    entries: state.entries,
    unresolvedEntries: state.unresolvedEntries,
    fingerprintCoverage: state.fingerprintCoverage,
    importPresets: state.importPresets,
    catalogRoots: state.roots,
    entryMetadata: state.entryMetadata,
    albums: state.albums,
    archivedEntryIds: state.archivedEntryIds,
    libraryWorkspace: state.libraryWorkspace,
    ...restoreSelection(activeEntries, get().selectedEntryIds, get().selectionAnchorId),
    needsFolderAccess: false,
    importError: null,
    catalogRecovery: null,
    metadataAnalysis: sessionChanged ? null : get().metadataAnalysis,
  });
}

function scheduleStateSync(
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  const catalogId = get().catalogId;
  const sessionId = get().sessionId;
  if (catalogId === null || sessionId === null) {
    return;
  }
  const { entryMetadata, albums, archivedEntryIds, libraryWorkspace } = get();
  void scheduleCatalogStateSync(
    entryMetadata,
    albums,
    archivedEntryIds,
    libraryWorkspace,
  ).then(
    (revision) => {
      if (get().catalogId === catalogId && get().sessionId === sessionId) {
        set({ catalogRevision: revision });
      }
    },
    (error: unknown) => {
      if (get().catalogId !== catalogId || get().sessionId !== sessionId) {
        return;
      }
      void queryActiveCatalog().then(
        (state) => {
          if (get().catalogId === catalogId && get().sessionId === sessionId) {
            applyHydratedState(state, set, get);
          }
          set({ importError: formatPickerError(error) });
        },
        () => {
          set({ importError: formatPickerError(error) });
        },
      );
    },
  );
}

function applyLocalMetadata(
  entryIds: string[],
  patch: Partial<EntryMetadata>,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  if (entryIds.length === 0) return;
  const { entryMetadata } = get();
  const updated = { ...entryMetadata };
  const updatedAt = Date.now();
  const history: Array<{ entryId: string; before: EntryMetadata; after: EntryMetadata }> = [];
  for (const entryId of entryIds) {
    const before = getEntryMetadata(updated, entryId);
    const after = createEntryMetadata({ ...before, ...patch, updatedAt });
    updated[entryId] = after;
    history.push({ entryId, before, after });
  }
  set({ entryMetadata: updated });
  for (const item of history) {
    useDevelopStore.getState().recordMetadataEdit(
      item.entryId,
      item.before,
      item.after,
      item.before.develop ?? createDefaultDevelopDocument(),
    );
  }
  scheduleStateSync(set, get);
}

function receiveMetadataProgress(
  progress: MetadataAnalysisProgress,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  const current = get();
  if (
    current.catalogId !== progress.catalogId ||
    current.sessionId !== progress.sessionId ||
    current.metadataAnalysis?.operationId !== progress.operationId
  ) {
    return;
  }
  set({
    metadataAnalysis: {
      operationId: progress.operationId,
      total: progress.total,
      completed: progress.completed,
      failed: progress.failed,
      cancelled: progress.cancelled,
    },
  });
}

function startMetadataAnalysis(
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  const current = get();
  if (
    current.catalogId === null ||
    current.sessionId === null ||
    current.metadataAnalysis !== null
  ) {
    return;
  }
  const entryIds = current.entries
    .filter((entry) => (
      current.libraryWorkspace.analysisByEntryId[entry.id]?.cacheSignature !==
      entryAnalysisCacheSignature(entry.size, entry.lastModified)
    ))
    .map((entry) => entry.id);
  if (entryIds.length === 0) return;

  let api: ReturnType<typeof getDarkroomAPI>;
  try {
    api = getDarkroomAPI();
  } catch {
    return;
  }

  if (metadataProgressUnsubscribe === null) {
    metadataProgressUnsubscribe = api.onCatalogMetadataAnalysisProgress((progress) => {
      receiveMetadataProgress(progress, set, get);
    });
  }

  const operationId = createOperationId();
  const catalogId = current.catalogId;
  const sessionId = current.sessionId;
  set({
    metadataAnalysis: {
      operationId,
      total: entryIds.length,
      completed: 0,
      failed: 0,
      cancelled: false,
    },
  });

  void api.catalogAnalyzeMetadata({ catalogId, sessionId, operationId, entryIds }).then(
    (result) => {
      const latest = get();
      if (
        latest.catalogId !== catalogId ||
        latest.sessionId !== sessionId ||
        latest.metadataAnalysis?.operationId !== operationId
      ) {
        return;
      }
      const analysisByEntryId = { ...latest.libraryWorkspace.analysisByEntryId };
      for (const item of result.items) {
        analysisByEntryId[item.entryId] = item.analysis;
      }
      set({
        libraryWorkspace: { ...latest.libraryWorkspace, analysisByEntryId },
        metadataAnalysis: null,
      });
      scheduleStateSync(set, get);
    },
    (error: unknown) => {
      const latest = get();
      if (
        latest.catalogId !== catalogId ||
        latest.sessionId !== sessionId ||
        latest.metadataAnalysis?.operationId !== operationId
      ) {
        return;
      }
      set({ metadataAnalysis: null, importError: formatPickerError(error) });
    },
  );
}

async function scanRoots(
  generation: number,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): Promise<void> {
  const roots = getActiveCatalogView()?.roots ?? [];
  for (const root of roots) {
    if (!isActiveFolderOperation(generation)) return;
    if (root.scanState === "complete") continue;
    const scanned = await scanCatalogRoot(root.rootId, (progress: ScanProgress) => {
      if (!isActiveFolderOperation(generation)) return;
      const phase = progress.phase === "statting" ? "Indexing" : "Scanning";
      const counts = `${progress.count} accepted · ${progress.filesConsidered ?? 0} files · ${progress.directoriesVisited ?? 0} folders`;
      const terminal = progress.status && progress.status !== "completed"
        ? `Scan ${progress.status}${progress.errorMessage ? `: ${progress.errorMessage}` : ""}`
        : `${phase} · ${counts}`;
      set({ importStatus: progress.done ? terminal : `${phase} · ${counts}` });
    });
    if (!isActiveFolderOperation(generation)) return;
    applyHydratedState(scanned, set, get);
  }
}

async function finishImport(
  generation: number,
  load: () => Promise<HydratedCatalogState>,
  mode: "import" | "restore",
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): Promise<void> {
  try {
    set({
      importState: mode === "restore" ? "restoring" : "importing",
      importStatus: "Opening catalog…",
      importError: null,
    });
    const state = await load();
    if (!isActiveFolderOperation(generation)) return;
    applyHydratedState(state, set, get);
    set({ importStatus: "Scanning catalog…" });
    await scanRoots(generation, set, get);
    if (!isActiveFolderOperation(generation)) return;
    set({ importState: "idle", importStatus: null, needsFolderAccess: false });
    startMetadataAnalysis(set, get);
  } catch (error) {
    if (!isActiveFolderOperation(generation)) return;
    fsDebugError("catalog import failed", error);
    set({
      importState: "idle",
      importStatus: get().importStatus?.startsWith("Scan ")
        ? get().importStatus
        : null,
      importError: formatPickerError(error),
      needsFolderAccess: get().entries.length === 0,
    });
  }
}

async function refreshCatalogSummaries(
  set: (partial: Partial<LibraryStore>) => void,
): Promise<readonly CatalogSummary[]> {
  const result = await bootstrapCatalog();
  set({ catalogs: result.catalogs });
  return result.catalogs;
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  catalogId: null,
  sessionId: null,
  catalogRevision: 0,
  folderName: null,
  entries: [],
  unresolvedEntries: [],
  fingerprintCoverage: EMPTY_FINGERPRINT_COVERAGE,
  importPresets: [],
  albums: [],
  archivedEntryIds: [],
  libraryWorkspace: createLibraryWorkspaceState([]),
  catalogs: [],
  catalogRoots: [],
  catalogManagerOpen: false,
  catalogView: { type: "all" },
  importState: "idle",
  importStatus: null,
  importError: null,
  metadataAnalysis: null,
  catalogRecovery: null,
  needsFolderAccess: false,
  selectedEntryId: null,
  selectedEntryIds: [],
  selectionAnchorId: null,
  entryMetadata: {},

  setSelectedEntryId: (id) => set({
    selectedEntryId: id,
    selectedEntryIds: id ? [id] : [],
    selectionAnchorId: id,
  }),

  clearSelection: () => set({ selectedEntryIds: [], selectedEntryId: null, selectionAnchorId: null }),

  selectEntry: (id, modifiers, visibleOrder) => {
    const { selectedEntryIds, selectionAnchorId } = get();
    if (modifiers.toggle) {
      const next = selectedEntryIds.includes(id)
        ? selectedEntryIds.filter((entryId) => entryId !== id)
        : [...selectedEntryIds, id];
      set({
        selectedEntryIds: next,
        selectedEntryId: next.includes(id) ? id : next.at(-1) ?? null,
        selectionAnchorId: selectionAnchorId ?? id,
      });
      return;
    }
    if (modifiers.shift) {
      const anchor = selectionAnchorId ?? get().selectedEntryId;
      if (anchor) {
        const anchorIndex = visibleOrder.indexOf(anchor);
        const targetIndex = visibleOrder.indexOf(id);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const start = Math.min(anchorIndex, targetIndex);
          const end = Math.max(anchorIndex, targetIndex);
          set({ selectedEntryIds: visibleOrder.slice(start, end + 1), selectedEntryId: id });
          return;
        }
      }
    }
    set({ selectedEntryIds: [id], selectedEntryId: id, selectionAnchorId: id });
  },

  reconcileSelection: (visibleEntryIds) => {
    const current = get();
    const next = reconcileSelectionToResult(
      current.selectedEntryIds,
      current.selectedEntryId,
      visibleEntryIds,
    );
    if (
      next.selectedEntryId === current.selectedEntryId &&
      next.selectedEntryIds.join("\u001f") === current.selectedEntryIds.join("\u001f")
    ) return;
    set({
      ...next,
      selectionAnchorId: next.selectedEntryIds.includes(current.selectionAnchorId ?? "")
        ? current.selectionAnchorId
        : next.selectedEntryIds[0] ?? null,
    });
  },

  setEntryMetadata: (entryId, patch) => applyLocalMetadata([entryId], patch, set, get),
  applyMetadataToEntries: (entryIds, patch) => applyLocalMetadata(entryIds, patch, set, get),

  mirrorDevelopDocument: (entryId, develop, sourceUpdatedAt = Date.now(), metadataPatch = {}) => {
    const { entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    const developUpdatedAt = Math.max(sourceUpdatedAt, current.developUpdatedAt + 1);
    const metadataChanged = Object.keys(metadataPatch).length > 0;
    const updatedAt = metadataChanged ? Math.max(sourceUpdatedAt, current.updatedAt + 1) : current.updatedAt;
    set({
      entryMetadata: {
        ...entryMetadata,
        [entryId]: createEntryMetadata({
          ...current,
          ...metadataPatch,
          develop,
          developUpdatedAt,
          updatedAt,
        }),
      },
    });
    scheduleStateSync(set, get);
  },

  hydrateEntryMetadata: (entryId, patch, sourceUpdatedAt) => {
    const { entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    set({
      entryMetadata: {
        ...entryMetadata,
        [entryId]: createEntryMetadata({
          ...current,
          ...patch,
          updatedAt: Math.max(sourceUpdatedAt, current.updatedAt + 1),
        }),
      },
    });
    scheduleStateSync(set, get);
  },

  restoreEntryMetadata: (entryId, patch) => {
    const { entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    set({
      entryMetadata: {
        ...entryMetadata,
        [entryId]: createEntryMetadata({ ...current, ...patch, updatedAt: Date.now() }),
      },
    });
    scheduleStateSync(set, get);
  },

  setCatalogView: (view) => set({ catalogView: view }),

  createAlbum: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    const now = Date.now();
    const album: Album = {
      id: crypto.randomUUID(),
      name: trimmed,
      entryIds: [],
      createdAt: now,
      updatedAt: now,
    };
    set({ albums: [...get().albums, album], catalogView: { type: "album", albumId: album.id } });
    scheduleStateSync(set, get);
    return album.id;
  },

  renameAlbum: (albumId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set({
      albums: get().albums.map((album) => album.id === albumId
        ? { ...album, name: trimmed, updatedAt: Date.now() }
        : album),
    });
    scheduleStateSync(set, get);
  },

  deleteAlbum: (albumId) => {
    const currentView = get().catalogView;
    const catalogView = currentView.type === "album" && currentView.albumId === albumId
      ? { type: "all" as const }
      : currentView;
    set({ albums: get().albums.filter((album) => album.id !== albumId), catalogView });
    scheduleStateSync(set, get);
  },

  addEntriesToAlbum: (albumId, entryIds) => {
    if (entryIds.length === 0) return;
    const entryIdSet = new Set(entryIds);
    set({
      albums: get().albums.map((album) => album.id !== albumId
        ? album
        : { ...album, entryIds: [...new Set([...album.entryIds, ...entryIdSet])], updatedAt: Date.now() }),
    });
    scheduleStateSync(set, get);
  },

  removeEntriesFromAlbum: (albumId, entryIds) => {
    if (entryIds.length === 0) return;
    const removeSet = new Set(entryIds);
    set({
      albums: get().albums.map((album) => album.id !== albumId
        ? album
        : { ...album, entryIds: album.entryIds.filter((id) => !removeSet.has(id)), updatedAt: Date.now() }),
    });
    scheduleStateSync(set, get);
  },

  removeEntriesFromAllAlbums: (entryIds) => {
    if (entryIds.length === 0) return;
    const removeSet = new Set(entryIds);
    set({ albums: get().albums.map((album) => ({
      ...album,
      entryIds: album.entryIds.filter((id) => !removeSet.has(id)),
      updatedAt: Date.now(),
    })) });
    scheduleStateSync(set, get);
  },

  archiveEntries: (entryIds) => {
    if (entryIds.length === 0) return;
    const removeSet = new Set(entryIds);
    const archivedEntryIds = [...new Set([...get().archivedEntryIds, ...entryIds])];
    const albums = get().albums.map((album) => ({
      ...album,
      entryIds: album.entryIds.filter((id) => !removeSet.has(id)),
      updatedAt: Date.now(),
    }));
    const activeEntries = filterArchivedEntries(get().entries, archivedEntryIds);
    set({ archivedEntryIds, albums, ...restoreSelection(activeEntries, get().selectedEntryIds, get().selectionAnchorId) });
    scheduleStateSync(set, get);
  },

  restoreEntries: (entryIds) => {
    if (entryIds.length === 0) return;
    const removeSet = new Set(entryIds);
    const archivedEntryIds = get().archivedEntryIds.filter((id) => !removeSet.has(id));
    const { entries, catalogView } = get();
    const activeEntries = catalogView.type === "archive"
      ? filterOnlyArchivedEntries(entries, archivedEntryIds)
      : filterArchivedEntries(entries, archivedEntryIds);
    set({ archivedEntryIds, ...restoreSelection(activeEntries, get().selectedEntryIds.filter((id) => !removeSet.has(id)), get().selectionAnchorId) });
    scheduleStateSync(set, get);
  },

  deleteEntriesFromDisk: async (entryIds) => {
    if (entryIds.length === 0) return;
    const targets = get().entries.filter((entry) => entryIds.includes(entry.id));
    try {
      await Promise.all(targets.map((entry) => getDarkroomAPI().catalogTrashAsset(getAssetRequest(entry))));
    } catch (error) {
      const message = formatPickerError(error);
      set({ importError: message });
      throw new Error(message);
    }
    const removeSet = new Set(entryIds);
    const entries = get().entries.filter((entry) => !removeSet.has(entry.id));
    const remainingIds = new Set<string>(entries.map((entry) => entry.id));
    const entryMetadata = pruneMetadataForEntries(get().entryMetadata, remainingIds);
    const albums = pruneAlbumsForEntries(get().albums, remainingIds);
    const archivedEntryIds = get().archivedEntryIds.filter((id) => remainingIds.has(id));
    const visible = get().catalogView.type === "archive"
      ? filterOnlyArchivedEntries(entries, archivedEntryIds)
      : filterArchivedEntries(entries, archivedEntryIds);
    set({ entries, entryMetadata, albums, archivedEntryIds, importError: null, ...restoreSelection(visible, get().selectedEntryIds.filter((id) => remainingIds.has(id)), get().selectionAnchorId) });
    scheduleStateSync(set, get);
  },

  createCatalog: async (displayName) => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      set({ importError: "Catalog name is required." });
      return;
    }
    const generation = beginFolderOperation();
    await finishImport(generation, () => createCatalogSession(trimmed), "import", set, get);
    await refreshCatalogSummaries(set).catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
  },

  addCatalogRoot: async () => {
    const generation = beginFolderOperation();
    await finishImport(generation, async () => (await addCatalogRootSession()).state, "restore", set, get);
    await refreshCatalogSummaries(set).catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
  },

  relinkCatalogRoot: async (rootId) => {
    const target = rootId ?? get().catalogRoots.find((root) => root.health !== "online")?.rootId;
    if (!target) {
      set({ importError: "No catalog root is available to relink." });
      return;
    }
    const generation = beginFolderOperation();
    await finishImport(generation, () => relinkCatalogRootSession(target), "restore", set, get);
    await refreshCatalogSummaries(set).catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
  },

  renameCatalog: async (displayName) => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      set({ importError: "Catalog name is required." });
      return;
    }
    try {
      const state = await renameActiveCatalog(trimmed);
      applyHydratedState(state, set, get);
      await refreshCatalogSummaries(set);
    } catch (error) {
      set({ importError: formatPickerError(error) });
    }
  },

  removeCatalogRecent: async (catalogId) => {
    const catalog = get().catalogs.find((item) => item.catalogId === catalogId);
    if (!catalog) return;
    if (get().catalogId === catalogId) {
      set({ importError: "Close the active catalog before removing it from recents." });
      return;
    }
    try {
      await removeCatalogSession(catalogId, catalog.displayName, false);
      await refreshCatalogSummaries(set);
    } catch (error) {
      set({ importError: formatPickerError(error) });
    }
  },

  deleteCatalog: async (catalogId, confirmation) => {
    const catalog = get().catalogs.find((item) => item.catalogId === catalogId);
    if (!catalog) return;
    if (confirmation !== catalog.displayName) {
      set({ importError: "Type the exact catalog name to delete it." });
      return;
    }
    try {
      await removeCatalogSession(catalogId, confirmation, true);
      if (get().catalogId === catalogId) {
        useDevelopStore.getState().clearLibrarySessions();
        set({
          catalogId: null,
          sessionId: null,
          catalogRevision: 0,
          folderName: null,
          entries: [],
          unresolvedEntries: [],
          fingerprintCoverage: EMPTY_FINGERPRINT_COVERAGE,
          importPresets: [],
          catalogRoots: [],
          entryMetadata: {},
          albums: [],
          archivedEntryIds: [],
          libraryWorkspace: createLibraryWorkspaceState([]),
          catalogView: { type: "all" },
          selectedEntryId: null,
          selectedEntryIds: [],
          selectionAnchorId: null,
          needsFolderAccess: true,
          metadataAnalysis: null,
        });
      }
      await refreshCatalogSummaries(set);
    } catch (error) {
      set({ importError: formatPickerError(error) });
    }
  },

  switchCatalog: async (catalogId) => {
    const generation = beginFolderOperation();
    await finishImport(generation, () => switchCatalogSession(catalogId), "restore", set, get);
    await refreshCatalogSummaries(set).catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
  },

  openCatalogManager: () => set({ catalogManagerOpen: true }),
  closeCatalogManager: () => set({ catalogManagerOpen: false }),
  refreshCatalogs: async () => {
    await refreshCatalogSummaries(set);
  },

  cancelFolderOperation: () => {
    beginFolderOperation();
    void cancelCatalogScan().catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
    set({ importState: "idle", importStatus: null, needsFolderAccess: get().entries.length === 0 });
  },

  refreshMetadataAnalysis: () => startMetadataAnalysis(set, get),

  cancelMetadataAnalysis: () => {
    const current = get();
    if (
      current.catalogId === null ||
      current.sessionId === null ||
      current.metadataAnalysis === null ||
      current.metadataAnalysis.cancelled
    ) {
      return;
    }
    const operationId = current.metadataAnalysis.operationId;
    set({ metadataAnalysis: { ...current.metadataAnalysis, cancelled: true } });
    void getDarkroomAPI().catalogCancelMetadataAnalysis({
      catalogId: current.catalogId,
      sessionId: current.sessionId,
      operationId,
    }).catch((error: unknown) => {
      if (get().metadataAnalysis?.operationId === operationId) {
        set({ importError: formatPickerError(error) });
      }
    });
  },

  clearLibrary: async () => {
    beginFolderOperation();
    try {
      await closeActiveCatalog();
    } catch (error) {
      set({ importError: formatPickerError(error) });
      return;
    }
    useDevelopStore.getState().clearLibrarySessions();
    set({
      catalogId: null,
      sessionId: null,
      catalogRevision: 0,
      folderName: null,
      entries: [],
      unresolvedEntries: [],
      fingerprintCoverage: EMPTY_FINGERPRINT_COVERAGE,
      importPresets: [],
      catalogRoots: [],
      entryMetadata: {},
      albums: [],
      archivedEntryIds: [],
      libraryWorkspace: createLibraryWorkspaceState([]),
      catalogView: { type: "all" },
      selectedEntryId: null,
      selectedEntryIds: [],
      selectionAnchorId: null,
      importState: "idle",
      importStatus: null,
      importError: null,
      metadataAnalysis: null,
      catalogRecovery: null,
      needsFolderAccess: false,
    });
  },

  bootstrapLibrary: async () => {
    fsDebug("bootstrapLibrary: start");
    try {
      const result = await bootstrapCatalog();
      if (!result.session) {
        clearSessionCatalog();
        useDevelopStore.getState().clearLibrarySessions();
        set({
          catalogId: null,
          sessionId: null,
          catalogRevision: 0,
          folderName: null,
          entries: [],
          unresolvedEntries: [],
          fingerprintCoverage: EMPTY_FINGERPRINT_COVERAGE,
          importPresets: [],
          catalogRoots: [],
          entryMetadata: {},
          albums: [],
          archivedEntryIds: [],
          libraryWorkspace: createLibraryWorkspaceState([]),
          selectedEntryId: null,
          selectedEntryIds: [],
          selectionAnchorId: null,
          needsFolderAccess: true,
          catalogs: result.catalogs,
          catalogRecovery: result.recovery?.message ?? null,
          importError: null,
          metadataAnalysis: null,
        });
        return;
      }
      const catalog = result.catalogs.find((item) => item.catalogId === result.session?.catalogId);
      if (!catalog) throw new Error("The active catalog is not registered.");
      const activation: CatalogActivationResult = { catalog, session: result.session };
      const generation = beginFolderOperation();
      set({ catalogs: result.catalogs });
      await finishImport(generation, () => activateCatalog(activation), "restore", set, get);
    } catch (error) {
      set({ importError: formatPickerError(error), needsFolderAccess: true });
    }
  },
}));

subscribeCatalogState((state) => {
  const current = useLibraryStore.getState();
  if (
    current.catalogId !== state.catalogId ||
    current.sessionId !== state.sessionId
  ) {
    return;
  }
  applyHydratedState(state, useLibraryStore.setState, useLibraryStore.getState);
});

setDevelopMetadataWriter((entryId, values) => {
  useLibraryStore.getState().restoreEntryMetadata(entryId, values);
});

export function getEntryById(
  entries: LibraryEntry[],
  id: string,
): LibraryEntry | undefined {
  return entries.find((entry) => entry.id === id);
}
