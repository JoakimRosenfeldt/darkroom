import { create } from "zustand";
import { formatPickerError } from "@/lib/fs/access";
import {
  getLibrarySnapshot,
  refreshEntryMetadata,
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

    const scanned = attachProfiles(
      await loadFolderCatalog(rootPath, generation, (progress) => {
        if (!isActiveFolderOperation(generation)) {
          return;
        }
        if (progress.count === 1 || progress.done || progress.count % 25 === 0) {
          fsDebug("completeDirectoryImport: scan progress", {
            generation,
            count: progress.count,
            latestPath: progress.latestPath,
            done: progress.done ?? false,
          });
        }
        set({ importStatus: `Found ${progress.count} photos…` });
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

    setSessionCatalog(folderName, scanned, rootPath);

    fsDebug("completeDirectoryImport: success", {
      generation,
      folderName,
      rootPath,
      entryCount: scanned.length,
    });

    set({
      folderName,
      rootPath,
      entries: scanned,
      needsFolderAccess: false,
      importState: "idle",
      importStatus: null,
      importError: null,
    });

    persistSnapshotInBackground(folderName, rootPath, scanned);

    void refreshEntryMetadata(scanned).then((refreshed) => {
      if (!isActiveFolderOperation(generation)) {
        return;
      }
      const withProfiles = attachProfiles(refreshed);
      if (get().rootPath === rootPath) {
        setSessionCatalog(folderName, withProfiles, rootPath);
        set({ entries: withProfiles });
        persistSnapshotInBackground(folderName, rootPath, withProfiles);
      }
    });
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

  setDesktopApp: (desktop) => set({ isDesktopApp: desktop }),

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
        set({
          folderName,
          rootPath,
          entries: attachProfiles(entries),
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
    beginFolderOperation();
    await clearPersistedLibrary();
    set({
      folderName: null,
      rootPath: null,
      entries: [],
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
