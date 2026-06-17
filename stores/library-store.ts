import { create } from "zustand";
import { formatPickerError, isPhotoFolderPickerActive } from "@/lib/fs/access";
import {
  getLibrarySnapshot,
  refreshEntryMetadata,
  saveLibrarySnapshot,
  scanDirectory,
  type ScanProgress,
} from "@/lib/fs/directory";
import { fsDebug, fsDebugError, fsDebugWarn } from "@/lib/fs/debug";
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
  entries: LibraryEntry[];
  importState: ImportState;
  importStatus: string | null;
  importError: string | null;
  needsFolderAccess: boolean;
  isSupportedBrowser: boolean;
  importFromDirectoryHandle: (
    dirHandle: FileSystemDirectoryHandle,
    mode?: "import" | "restore",
  ) => void;
  restoreLastFolder: (options?: RestoreLastFolderOptions) => void;
  cancelFolderOperation: () => void;
  clearLibrary: () => Promise<void>;
  bootstrapLibrary: () => Promise<void>;
  setSupportedBrowser: (supported: boolean) => void;
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
  entries: LibraryEntry[],
): void {
  void saveLibrarySnapshot(folderName, entries).catch(() => {
    // Snapshot persistence is best-effort.
  });
}

async function loadFolderCatalog(
  dirHandle: FileSystemDirectoryHandle,
  generation: number,
  onProgress: (progress: ScanProgress) => void,
): Promise<LibraryEntry[]> {
  fsDebug("loadFolderCatalog: start", {
    generation,
    folderName: dirHandle.name,
  });

  return withTimeout(
    scanDirectory(dirHandle, onProgress),
    SCAN_TIMEOUT_MS,
    "Timed out while reading the folder. Try a local folder that is not synced with iCloud, OneDrive, or Google Drive.",
  );
}

async function completeDirectoryImport(
  generation: number,
  dirHandle: FileSystemDirectoryHandle,
  hadSavedFolder: boolean,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): Promise<void> {
  try {
    set({ importStatus: `Scanning "${dirHandle.name}"…` });

    const scanned = attachProfiles(
      await loadFolderCatalog(dirHandle, generation, (progress) => {
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

    setSessionCatalog(dirHandle.name, scanned, dirHandle);

    fsDebug("completeDirectoryImport: success", {
      generation,
      folderName: dirHandle.name,
      entryCount: scanned.length,
    });

    set({
      folderName: dirHandle.name,
      entries: scanned,
      needsFolderAccess: false,
      importState: "idle",
      importStatus: null,
      importError: null,
    });

    persistSnapshotInBackground(dirHandle.name, scanned);

    void refreshEntryMetadata(scanned).then((refreshed) => {
      if (!isActiveFolderOperation(generation)) {
        return;
      }
      const withProfiles = attachProfiles(refreshed);
      if (get().folderName === dirHandle.name) {
        setSessionCatalog(dirHandle.name, withProfiles, dirHandle);
        set({ entries: withProfiles });
        persistSnapshotInBackground(dirHandle.name, withProfiles);
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
  entries: [],
  importState: "idle",
  importStatus: null,
  importError: null,
  needsFolderAccess: false,
  isSupportedBrowser: false,

  setSupportedBrowser: (supported) => set({ isSupportedBrowser: supported }),

  bootstrapLibrary: async () => {
    fsDebug("bootstrapLibrary: start", {
      origin: typeof window !== "undefined" ? window.location.origin : "ssr",
    });

    // Legacy directory handles in IndexedDB can leave Chrome's picker stuck.
    await clearPersistedLibraryHandles();

    if (hasSessionCatalog()) {
      const { dirHandle, folderName, entries } = getSessionCatalog();
      if (folderName) {
        fsDebug("bootstrapLibrary: restored from session memory", {
          folderName,
          entryCount: entries.length,
          hasDirHandle: Boolean(dirHandle),
        });
        set({
          folderName,
          entries: attachProfiles(entries),
          needsFolderAccess: false,
          importState: "idle",
          importError: null,
          importStatus: null,
        });
        return;
      }
    }

    const snapshot = await getLibrarySnapshot();
    if (!snapshot) {
      fsDebug("bootstrapLibrary: no saved snapshot");
      return;
    }

    fsDebug("bootstrapLibrary: snapshot found, needs re-link", {
      folderName: snapshot.folderName,
      savedEntryCount: snapshot.entries.length,
    });

    set({
      folderName: snapshot.folderName,
      entries: [],
      needsFolderAccess: true,
      importState: "idle",
      importError: null,
      importStatus: null,
    });
  },

  importFromDirectoryHandle: (dirHandle, mode = "import") => {
    const generation = beginFolderOperation();
    const hadSavedFolder = Boolean(get().folderName);

    fsDebug("importFromDirectoryHandle: start", {
      generation,
      mode,
      folderName: dirHandle.name,
    });

    set({
      importState: mode === "restore" ? "restoring" : "importing",
      importError: null,
      importStatus: `Scanning "${dirHandle.name}"…`,
    });

    void completeDirectoryImport(
      generation,
      dirHandle,
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
    const pickerActive = isPhotoFolderPickerActive();

    fsDebug("cancelFolderOperation", {
      hadSavedFolder,
      pickerActive,
      currentGeneration: folderOperationGeneration,
    });

    set({
      importState: "idle",
      importStatus: pickerActive
        ? "Folder dialog is still open — select a folder and click Open, or close the dialog."
        : null,
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
