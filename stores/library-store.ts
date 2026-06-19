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
  ColorLabel,
  EntryMetadata,
  PickStatus,
  StarRating,
} from "@/lib/catalog/types";
import { pruneMetadataForEntries } from "@/lib/library/curation";
import {
  getLibrarySnapshot,
  saveLibrarySnapshot,
  scanDirectory,
  type ScanProgress,
} from "@/lib/fs/directory";
import { fsDebug, fsDebugError, fsDebugWarn } from "@/lib/fs/debug";
import { getDarkroomAPI } from "@/lib/fs/platform";
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

interface LibraryStore {
  folderName: string | null;
  rootPath: string | null;
  entries: LibraryEntry[];
  importState: ImportState;
  importStatus: string | null;
  importError: string | null;
  needsFolderAccess: boolean;
  isDesktopApp: boolean;
  selectedEntryId: string | null;
  entryMetadata: Record<string, EntryMetadata>;
  setSelectedEntryId: (id: string | null) => void;
  setEntryMetadata: (entryId: string, patch: Partial<EntryMetadata>) => void;
  setPick: (entryId: string, pick: PickStatus) => void;
  setRating: (entryId: string, rating: StarRating) => void;
  setColorLabel: (entryId: string, label: ColorLabel) => void;
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

function persistMetadataInBackground(
  rootPath: string,
  entryMetadata: Record<string, EntryMetadata>,
): void {
  scheduleCatalogPersist(buildPhotoCatalog(rootPath, entryMetadata));
}

async function loadAndMergeCatalog(
  rootPath: string,
  entries: LibraryEntry[],
): Promise<Record<string, EntryMetadata>> {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const catalog = await loadCatalog(rootPath);
  const stored = catalog?.entries ?? {};
  return pruneMetadataForEntries(stored, entryIds);
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

    const entryMetadata = await loadAndMergeCatalog(rootPath, scanned);

    setSessionCatalog(folderName, scanned, rootPath);

    fsDebug("completeDirectoryImport: success", {
      generation,
      folderName,
      rootPath,
      entryCount: scanned.length,
    });

    const previousSelection = get().selectedEntryId;
    const selectedEntryId =
      previousSelection && scanned.some((entry) => entry.id === previousSelection)
        ? previousSelection
        : (scanned[0]?.id ?? null);

    set({
      folderName,
      rootPath,
      entries: scanned,
      entryMetadata,
      selectedEntryId,
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
  importState: "idle",
  importStatus: null,
  importError: null,
  needsFolderAccess: false,
  isDesktopApp: false,
  selectedEntryId: null,
  entryMetadata: {},

  setDesktopApp: (desktop) => set({ isDesktopApp: desktop }),

  setSelectedEntryId: (id) => set({ selectedEntryId: id }),

  loadCatalogForFolder: async (rootPath, entryIds) => {
    const entryIdSet = new Set(entryIds);
    const catalog = await loadCatalog(rootPath);
    const stored = catalog?.entries ?? {};
    const entryMetadata = pruneMetadataForEntries(stored, entryIdSet);
    set({ entryMetadata });
  },

  setEntryMetadata: (entryId, patch) => {
    const { rootPath, entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    const next = createEntryMetadata({ ...current, ...patch });

    const updated = { ...entryMetadata, [entryId]: next };
    set({ entryMetadata: updated });

    if (rootPath) {
      persistMetadataInBackground(rootPath, updated);
    }
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
        const entryMetadata = await loadAndMergeCatalog(
          rootPath,
          restoredEntries,
        );
        set({
          folderName,
          rootPath,
          entries: restoredEntries,
          entryMetadata,
          selectedEntryId:
            get().selectedEntryId &&
            restoredEntries.some((entry) => entry.id === get().selectedEntryId)
              ? get().selectedEntryId
              : (restoredEntries[0]?.id ?? null),
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
      selectedEntryId: null,
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
