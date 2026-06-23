import { create } from "zustand";
import { formatPickerError } from "@/lib/fs/access";
import {
  getEntryMetadata,
  createEntryMetadata,
} from "@/lib/catalog/defaults";
import {
  buildPhotoCatalog,
  deleteCatalog,
  loadCatalog,
  scheduleCatalogPersist,
} from "@/lib/catalog/persistence";
import type {
  Album,
  ColorLabel,
  EntryMetadata,
  PickStatus,
  StarRating,
} from "@/lib/catalog/types";
import { pruneMetadataForEntries } from "@/lib/library/curation";
import { filterArchivedEntries, filterOnlyArchivedEntries, pruneArchivedEntryIds } from "@/lib/library/archive";
import { pruneAlbumsForEntries } from "@/lib/library/folders";
import {
  getLibrarySnapshot,
  saveLibrarySnapshot,
  scanDirectory,
  type ScanProgress,
} from "@/lib/fs/directory";
import { fsDebug, fsDebugError, fsDebugWarn } from "@/lib/fs/debug";
import { deleteFilesFromDisk, getDarkroomAPI, joinRootPath } from "@/lib/fs/platform";
import {
  hasSessionCatalog,
  setSessionCatalog,
  getSessionCatalog,
} from "@/lib/fs/session-catalog";
import { clearPersistedLibrary, clearPersistedLibraryHandles } from "@/lib/fs/validate-handle";
import type { LibraryEntry } from "@/lib/fs/types";
import { withTimeout } from "@/lib/fs/timeout";
import { initializeProfiles } from "@/lib/raw/profiles";
import { resolveProfile } from "@/lib/raw/registry";

initializeProfiles();

export type ImportState = "idle" | "importing" | "restoring" | "error";

interface RestoreLastFolderOptions {
  interactive?: boolean;
}

export interface SelectEntryModifiers {
  shift?: boolean;
  toggle?: boolean;
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
  const validIds = previousIds.filter((id) =>
    entries.some((entry) => entry.id === id),
  );
  const selectedEntryIds =
    validIds.length > 0
      ? validIds
      : entries[0]
        ? [entries[0].id]
        : [];
  const anchorValid =
    previousAnchor &&
    entries.some((entry) => entry.id === previousAnchor);
  return {
    selectedEntryIds,
    selectedEntryId: selectedEntryIds.at(-1) ?? null,
    selectionAnchorId: anchorValid
      ? previousAnchor
      : (selectedEntryIds[0] ?? null),
  };
}

export type CatalogView =
  | { type: "all" }
  | { type: "folder"; path: string | null }
  | { type: "album"; albumId: string }
  | { type: "archive" };

interface LibraryStore {
  folderName: string | null;
  rootPath: string | null;
  entries: LibraryEntry[];
  albums: Album[];
  archivedEntryIds: string[];
  catalogView: CatalogView;
  importState: ImportState;
  importStatus: string | null;
  importError: string | null;
  needsFolderAccess: boolean;
  isDesktopApp: boolean;
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
  setEntryMetadata: (entryId: string, patch: Partial<EntryMetadata>) => void;
  applyMetadataToEntries: (
    entryIds: string[],
    patch: Partial<EntryMetadata>,
  ) => void;
  setPick: (entryId: string, pick: PickStatus) => void;
  setRating: (entryId: string, rating: StarRating) => void;
  setColorLabel: (entryId: string, label: ColorLabel) => void;
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
  loadCatalogForFolder: (
    rootPath: string,
    entryIds: string[],
  ) => Promise<void>;
  importFromFolderPath: (
    rootPath: string,
    folderName: string,
    mode?: "import" | "restore",
  ) => void;
  restoreLastFolder: (options?: RestoreLastFolderOptions) => void;
  cancelFolderOperation: () => void;
  clearLibrary: () => Promise<void>;
  bootstrapLibrary: () => Promise<void>;
  setDesktopApp: (desktop: boolean) => void;
}

const SCAN_TIMEOUT_MS = 90_000;

let folderOperationGeneration = 0;

function beginFolderOperation(): number {
  folderOperationGeneration += 1;
  fsDebug("beginFolderOperation", {
    generation: folderOperationGeneration,
  });
  return folderOperationGeneration;
}

function isActiveFolderOperation(generation: number): boolean {
  const active = generation === folderOperationGeneration;
  if (!active) {
    fsDebugWarn("isActiveFolderOperation: stale generation ignored", {
      generation,
      current: folderOperationGeneration,
    });
  }
  return active;
}

function attachProfiles(entries: LibraryEntry[]): LibraryEntry[] {
  return entries.map((entry) => ({
    ...entry,
    profileId: resolveProfile(entry)?.id ?? null,
  }));
}

function persistCatalogInBackground(
  rootPath: string,
  entryMetadata: Record<string, EntryMetadata>,
  albums: Album[],
  archivedEntryIds: string[],
): void {
  scheduleCatalogPersist(
    buildPhotoCatalog(rootPath, entryMetadata, albums, archivedEntryIds),
  );
}

async function loadAndMergeCatalog(
  rootPath: string,
  entries: LibraryEntry[],
): Promise<{
  entryMetadata: Record<string, EntryMetadata>;
  albums: Album[];
  archivedEntryIds: string[];
}> {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const catalog = await loadCatalog(rootPath);
  const stored = catalog?.entries ?? {};
  const entryMetadata = pruneMetadataForEntries(stored, entryIds);
  const albums = pruneAlbumsForEntries(catalog?.albums ?? [], entryIds);
  const archivedEntryIds = pruneArchivedEntryIds(
    catalog?.archivedEntryIds ?? [],
    entryIds,
  );
  return { entryMetadata, albums, archivedEntryIds };
}

function persistSnapshotInBackground(
  folderName: string,
  rootPath: string,
  entries: LibraryEntry[],
): void {
  void saveLibrarySnapshot(folderName, rootPath, entries).catch(() => {
    // Snapshot persistence is best-effort.
  });
}

async function loadFolderCatalog(
  rootPath: string,
  generation: number,
  onProgress: (progress: ScanProgress) => void,
): Promise<LibraryEntry[]> {
  fsDebug("loadFolderCatalog: start", {
    generation,
    rootPath,
  });

  return withTimeout(
    scanDirectory(rootPath, onProgress),
    SCAN_TIMEOUT_MS,
    "Timed out while reading the folder. Try a local folder that is not synced with iCloud, OneDrive, or Google Drive.",
  );
}

async function completeDirectoryImport(
  generation: number,
  rootPath: string,
  folderName: string,
  hadSavedFolder: boolean,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): Promise<void> {
  try {
    set({ importStatus: `Scanning "${folderName}"…` });
    let lastProgressStatusAt = 0;

    const scanned = attachProfiles(
      await loadFolderCatalog(rootPath, generation, (progress) => {
        if (!isActiveFolderOperation(generation)) {
          return;
        }
        const shouldUpdateStatus =
          progress.count === 1 ||
          progress.done ||
          progress.count - lastProgressStatusAt >= 25;

        if (shouldUpdateStatus) {
          lastProgressStatusAt = progress.count;
          fsDebug("completeDirectoryImport: scan progress", {
            generation,
            count: progress.count,
            latestPath: progress.latestPath,
            done: progress.done ?? false,
          });
          set({ importStatus: `Found ${progress.count} photos…` });
        }
      }),
    );

    if (!isActiveFolderOperation(generation)) {
      return;
    }

    if (scanned.length === 0) {
      throw new Error(
        "No supported photos found. Darkroom supports NEF, JPEG, PNG, and WebP.",
      );
    }

    const { entryMetadata, albums, archivedEntryIds } =
      await loadAndMergeCatalog(rootPath, scanned);

    setSessionCatalog(folderName, scanned, rootPath);

    fsDebug("completeDirectoryImport: success", {
      generation,
      folderName,
      rootPath,
      entryCount: scanned.length,
    });

    const activeEntries = filterArchivedEntries(scanned, archivedEntryIds);
    const selection = restoreSelection(
      activeEntries,
      get().selectedEntryIds,
      get().selectionAnchorId,
    );

    set({
      folderName,
      rootPath,
      entries: scanned,
      entryMetadata,
      albums,
      archivedEntryIds,
      catalogView: { type: "all" },
      ...selection,
      needsFolderAccess: false,
      importState: "idle",
      importStatus: null,
      importError: null,
    });

    persistSnapshotInBackground(folderName, rootPath, scanned);
  } catch (error) {
    if (!isActiveFolderOperation(generation)) {
      return;
    }

    fsDebugError("completeDirectoryImport: failed", error, { generation });
    set({
      importState: "idle",
      importError: formatPickerError(error),
      importStatus: null,
      needsFolderAccess: hadSavedFolder || get().entries.length === 0,
    });
  }
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  folderName: null,
  rootPath: null,
  entries: [],
  albums: [],
  archivedEntryIds: [],
  catalogView: { type: "all" },
  importState: "idle",
  importStatus: null,
  importError: null,
  needsFolderAccess: false,
  isDesktopApp: false,
  selectedEntryId: null,
  selectedEntryIds: [],
  selectionAnchorId: null,
  entryMetadata: {},

  setDesktopApp: (desktop) => set({ isDesktopApp: desktop }),

  setSelectedEntryId: (id) =>
    set({
      selectedEntryId: id,
      selectedEntryIds: id ? [id] : [],
      selectionAnchorId: id,
    }),

  clearSelection: () =>
    set({
      selectedEntryIds: [],
      selectedEntryId: null,
      selectionAnchorId: null,
    }),

  selectEntry: (id, modifiers, visibleOrder) => {
    const { selectedEntryIds, selectionAnchorId } = get();

    if (modifiers.toggle) {
      const next = selectedEntryIds.includes(id)
        ? selectedEntryIds.filter((entryId) => entryId !== id)
        : [...selectedEntryIds, id];
      set({
        selectedEntryIds: next,
        selectedEntryId: next.includes(id)
          ? id
          : (next.at(-1) ?? null),
        selectionAnchorId: selectionAnchorId ?? id,
      });
      return;
    }

    if (modifiers.shift) {
      const anchor = selectionAnchorId ?? get().selectedEntryId;
      if (anchor) {
        const anchorIdx = visibleOrder.indexOf(anchor);
        const targetIdx = visibleOrder.indexOf(id);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const start = Math.min(anchorIdx, targetIdx);
          const end = Math.max(anchorIdx, targetIdx);
          set({
            selectedEntryIds: visibleOrder.slice(start, end + 1),
            selectedEntryId: id,
          });
          return;
        }
      }
    }

    set({
      selectedEntryIds: [id],
      selectedEntryId: id,
      selectionAnchorId: id,
    });
  },

  loadCatalogForFolder: async (rootPath, entryIds) => {
    const entryIdSet = new Set(entryIds);
    const catalog = await loadCatalog(rootPath);
    const stored = catalog?.entries ?? {};
    const entryMetadata = pruneMetadataForEntries(stored, entryIdSet);
    const albums = pruneAlbumsForEntries(catalog?.albums ?? [], entryIdSet);
    const archivedEntryIds = pruneArchivedEntryIds(
      catalog?.archivedEntryIds ?? [],
      entryIdSet,
    );
    set({ entryMetadata, albums, archivedEntryIds });
  },

  setEntryMetadata: (entryId, patch) => {
    get().applyMetadataToEntries([entryId], patch);
  },

  applyMetadataToEntries: (entryIds, patch) => {
    if (entryIds.length === 0) {
      return;
    }

    const { rootPath, entryMetadata, albums, archivedEntryIds } = get();
    const updated = { ...entryMetadata };
    const updatedAt = Date.now();

    for (const entryId of entryIds) {
      const current = getEntryMetadata(updated, entryId);
      updated[entryId] = createEntryMetadata({
        ...current,
        ...patch,
        updatedAt,
      });
    }

    set({ entryMetadata: updated });

    if (rootPath) {
      persistCatalogInBackground(rootPath, updated, albums, archivedEntryIds);
    }
  },

  setCatalogView: (view) => set({ catalogView: view }),

  createAlbum: (name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return "";
    }

    const now = Date.now();
    const album: Album = {
      id: crypto.randomUUID(),
      name: trimmed,
      entryIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const albums = [...get().albums, album];
    set({ albums, catalogView: { type: "album", albumId: album.id } });

    const { rootPath, entryMetadata, archivedEntryIds } = get();
    if (rootPath) {
      persistCatalogInBackground(
        rootPath,
        entryMetadata,
        albums,
        archivedEntryIds,
      );
    }

    return album.id;
  },

  renameAlbum: (albumId, name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    const albums = get().albums.map((album) =>
      album.id === albumId
        ? { ...album, name: trimmed, updatedAt: Date.now() }
        : album,
    );
    set({ albums });

    const { rootPath, entryMetadata, archivedEntryIds } = get();
    if (rootPath) {
      persistCatalogInBackground(
        rootPath,
        entryMetadata,
        albums,
        archivedEntryIds,
      );
    }
  },

  deleteAlbum: (albumId) => {
    const albums = get().albums.filter((album) => album.id !== albumId);
    const currentView = get().catalogView;
    const catalogView =
      currentView.type === "album" && currentView.albumId === albumId
        ? { type: "all" as const }
        : currentView;
    set({ albums, catalogView });

    const { rootPath, entryMetadata, archivedEntryIds } = get();
    if (rootPath) {
      persistCatalogInBackground(
        rootPath,
        entryMetadata,
        albums,
        archivedEntryIds,
      );
    }
  },

  addEntriesToAlbum: (albumId, entryIds) => {
    if (entryIds.length === 0) {
      return;
    }

    const entryIdSet = new Set(entryIds);
    const albums = get().albums.map((album) => {
      if (album.id !== albumId) {
        return album;
      }

      const merged = new Set([...album.entryIds, ...entryIdSet]);
      return {
        ...album,
        entryIds: [...merged],
        updatedAt: Date.now(),
      };
    });
    set({ albums });

    const { rootPath, entryMetadata, archivedEntryIds } = get();
    if (rootPath) {
      persistCatalogInBackground(
        rootPath,
        entryMetadata,
        albums,
        archivedEntryIds,
      );
    }
  },

  removeEntriesFromAlbum: (albumId, entryIds) => {
    if (entryIds.length === 0) {
      return;
    }

    const removeSet = new Set(entryIds);
    const albums = get().albums.map((album) => {
      if (album.id !== albumId) {
        return album;
      }

      return {
        ...album,
        entryIds: album.entryIds.filter((id) => !removeSet.has(id)),
        updatedAt: Date.now(),
      };
    });
    set({ albums });

    const { rootPath, entryMetadata, archivedEntryIds } = get();
    if (rootPath) {
      persistCatalogInBackground(
        rootPath,
        entryMetadata,
        albums,
        archivedEntryIds,
      );
    }
  },

  removeEntriesFromAllAlbums: (entryIds) => {
    if (entryIds.length === 0) {
      return;
    }

    const removeSet = new Set(entryIds);
    const albums = get().albums.map((album) => ({
      ...album,
      entryIds: album.entryIds.filter((id) => !removeSet.has(id)),
      updatedAt: Date.now(),
    }));
    set({ albums });

    const { rootPath, entryMetadata, archivedEntryIds } = get();
    if (rootPath) {
      persistCatalogInBackground(
        rootPath,
        entryMetadata,
        albums,
        archivedEntryIds,
      );
    }
  },

  archiveEntries: (entryIds) => {
    if (entryIds.length === 0) {
      return;
    }

    const removeSet = new Set(entryIds);
    const archivedEntryIds = [
      ...new Set([...get().archivedEntryIds, ...entryIds]),
    ];
    const albums = get().albums.map((album) => ({
      ...album,
      entryIds: album.entryIds.filter((id) => !removeSet.has(id)),
      updatedAt: Date.now(),
    }));
    const activeEntries = filterArchivedEntries(get().entries, archivedEntryIds);
    const selection = restoreSelection(
      activeEntries,
      get().selectedEntryIds,
      get().selectionAnchorId,
    );

    set({
      archivedEntryIds,
      albums,
      ...selection,
    });

    const { rootPath, entryMetadata } = get();
    if (rootPath) {
      persistCatalogInBackground(
        rootPath,
        entryMetadata,
        albums,
        archivedEntryIds,
      );
    }
  },

  restoreEntries: (entryIds) => {
    if (entryIds.length === 0) {
      return;
    }

    const removeSet = new Set(entryIds);
    const archivedEntryIds = get().archivedEntryIds.filter(
      (id) => !removeSet.has(id),
    );
    const { entries, catalogView } = get();
    const activeEntries =
      catalogView.type === "archive"
        ? filterOnlyArchivedEntries(entries, archivedEntryIds)
        : filterArchivedEntries(entries, archivedEntryIds);
    const selection = restoreSelection(
      activeEntries,
      get().selectedEntryIds.filter((id) => !removeSet.has(id)),
      get().selectionAnchorId,
    );

    set({
      archivedEntryIds,
      ...selection,
    });

    const { rootPath, entryMetadata, albums } = get();
    if (rootPath) {
      persistCatalogInBackground(
        rootPath,
        entryMetadata,
        albums,
        archivedEntryIds,
      );
    }
  },

  deleteEntriesFromDisk: async (entryIds) => {
    if (entryIds.length === 0) {
      return;
    }

    const { rootPath, folderName, entries, catalogView } = get();
    if (!rootPath) {
      return;
    }

    const removeSet = new Set(entryIds);
    const toDelete = entries.filter((entry) => removeSet.has(entry.id));
    const absolutePaths = toDelete.map((entry) =>
      joinRootPath(rootPath, entry.relativePath),
    );

    try {
      await deleteFilesFromDisk(absolutePaths);
    } catch (error) {
      set({ importError: formatPickerError(error) });
      return;
    }

    const remainingEntries = entries.filter((entry) => !removeSet.has(entry.id));
    const remainingIds = new Set(remainingEntries.map((entry) => entry.id));
    const entryMetadata = pruneMetadataForEntries(
      get().entryMetadata,
      remainingIds,
    );
    const albums = pruneAlbumsForEntries(get().albums, remainingIds);
    const archivedEntryIds = get().archivedEntryIds.filter((id) =>
      remainingIds.has(id),
    );
    const activeEntries =
      catalogView.type === "archive"
        ? filterOnlyArchivedEntries(remainingEntries, archivedEntryIds)
        : filterArchivedEntries(remainingEntries, archivedEntryIds);
    const selection = restoreSelection(
      activeEntries,
      get().selectedEntryIds.filter((id) => remainingIds.has(id)),
      get().selectionAnchorId,
    );

    set({
      entries: remainingEntries,
      entryMetadata,
      albums,
      archivedEntryIds,
      importError: null,
      ...selection,
    });

    if (folderName) {
      setSessionCatalog(folderName, remainingEntries, rootPath);
      persistSnapshotInBackground(folderName, rootPath, remainingEntries);
    }

    persistCatalogInBackground(
      rootPath,
      entryMetadata,
      albums,
      archivedEntryIds,
    );
  },

  setPick: (entryId, pick) => {
    get().setEntryMetadata(entryId, { pick });
  },

  setRating: (entryId, rating) => {
    get().setEntryMetadata(entryId, { rating });
  },

  setColorLabel: (entryId, label) => {
    const { entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    const nextLabel = current.colorLabel === label ? null : label;
    get().setEntryMetadata(entryId, { colorLabel: nextLabel });
  },

  bootstrapLibrary: async () => {
    fsDebug("bootstrapLibrary: start");

    await clearPersistedLibraryHandles();

    if (hasSessionCatalog()) {
      const { rootPath, folderName, entries } = getSessionCatalog();
      if (rootPath && folderName) {
        fsDebug("bootstrapLibrary: restored from session memory", {
          folderName,
          rootPath,
          entryCount: entries.length,
        });
        const restoredEntries = attachProfiles(entries);
        const { entryMetadata, albums, archivedEntryIds } =
          await loadAndMergeCatalog(rootPath, restoredEntries);
        const activeEntries = filterArchivedEntries(
          restoredEntries,
          archivedEntryIds,
        );
        set({
          folderName,
          rootPath,
          entries: restoredEntries,
          entryMetadata,
          albums,
          archivedEntryIds,
          ...restoreSelection(
            activeEntries,
            get().selectedEntryIds,
            get().selectionAnchorId,
          ),
          needsFolderAccess: false,
          importState: "idle",
          importError: null,
          importStatus: null,
        });
        return;
      }
    }

    const api = getDarkroomAPI();
    const lastFolderPath = await api.getLastFolder();

    if (lastFolderPath && (await api.folderExists(lastFolderPath))) {
      const folderName = lastFolderPath.split(/[/\\]/).pop() ?? lastFolderPath;
      fsDebug("bootstrapLibrary: restoring last folder", {
        folderName,
        rootPath: lastFolderPath,
      });
      get().importFromFolderPath(lastFolderPath, folderName, "restore");
      return;
    }

    const snapshot = await getLibrarySnapshot();
    if (!snapshot) {
      fsDebug("bootstrapLibrary: no saved snapshot");
      if (lastFolderPath) {
        set({
          folderName: lastFolderPath.split(/[/\\]/).pop() ?? lastFolderPath,
          rootPath: lastFolderPath,
          entries: [],
          needsFolderAccess: true,
        });
      }
      return;
    }

    if (!snapshot.rootPath) {
      fsDebug("bootstrapLibrary: legacy snapshot without root path", {
        folderName: snapshot.folderName,
      });
      set({
        folderName: snapshot.folderName,
        rootPath: null,
        entries: [],
        needsFolderAccess: true,
        importState: "idle",
        importError: null,
        importStatus: null,
      });
      return;
    }

    const snapshotExists = await api.folderExists(snapshot.rootPath);
    if (snapshotExists) {
      fsDebug("bootstrapLibrary: restoring snapshot folder", {
        folderName: snapshot.folderName,
        rootPath: snapshot.rootPath,
      });
      get().importFromFolderPath(
        snapshot.rootPath,
        snapshot.folderName,
        "restore",
      );
      return;
    }

    fsDebug("bootstrapLibrary: snapshot folder missing", {
      folderName: snapshot.folderName,
      rootPath: snapshot.rootPath,
    });

    set({
      folderName: snapshot.folderName,
      rootPath: snapshot.rootPath,
      entries: [],
      needsFolderAccess: true,
      importState: "idle",
      importError: null,
      importStatus: null,
    });
  },

  importFromFolderPath: (rootPath, folderName, mode = "import") => {
    const generation = beginFolderOperation();
    const hadSavedFolder = Boolean(get().folderName);

    fsDebug("importFromFolderPath: start", {
      generation,
      mode,
      folderName,
      rootPath,
    });

    set({
      importState: mode === "restore" ? "restoring" : "importing",
      importError: null,
      importStatus: `Scanning "${folderName}"…`,
    });

    void completeDirectoryImport(
      generation,
      rootPath,
      folderName,
      hadSavedFolder,
      set,
      get,
    );
  },

  restoreLastFolder: ({ interactive = false } = {}) => {
    if (!interactive) {
      void get().bootstrapLibrary();
    }
  },

  cancelFolderOperation: () => {
    const hadSavedFolder = Boolean(get().folderName);

    fsDebug("cancelFolderOperation", {
      hadSavedFolder,
      currentGeneration: folderOperationGeneration,
    });

    beginFolderOperation();

    set({
      importState: "idle",
      importStatus: null,
      importError: null,
      needsFolderAccess: hadSavedFolder || get().entries.length === 0,
    });
  },

  clearLibrary: async () => {
    fsDebug("clearLibrary: start");
    const { rootPath } = get();
    beginFolderOperation();
    await clearPersistedLibrary();
    if (rootPath) {
      await deleteCatalog(rootPath);
    }
    set({
      folderName: null,
      rootPath: null,
      entries: [],
      entryMetadata: {},
      albums: [],
      archivedEntryIds: [],
      catalogView: { type: "all" },
      selectedEntryId: null,
      selectedEntryIds: [],
      selectionAnchorId: null,
      importState: "idle",
      importStatus: null,
      importError: null,
      needsFolderAccess: false,
    });
  },
}));

export function getEntryById(
  entries: LibraryEntry[],
  id: string,
): LibraryEntry | undefined {
  return entries.find((entry) => entry.id === id);
}
