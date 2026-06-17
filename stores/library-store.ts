import { create } from "zustand";
import { ensureFolderReadAccess, pickPhotoFolder } from "@/lib/fs/access";
import {
  getLibrarySnapshot,
  refreshEntryMetadata,
  saveLibrarySnapshot,
  scanDirectory,
  type ScanProgress,
} from "@/lib/fs/directory";
import {
  getDirectoryHandle,
  queryDirectoryPermission,
  saveDirectoryHandle,
} from "@/lib/fs/handles-store";
import {
  clearPersistedLibrary,
  isDirectoryHandleReadable,
} from "@/lib/fs/validate-handle";
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
  pickFolder: () => Promise<void>;
  restoreLastFolder: (options?: RestoreLastFolderOptions) => Promise<void>;
  clearLibrary: () => Promise<void>;
  setSupportedBrowser: (supported: boolean) => void;
}

const SCAN_TIMEOUT_MS = 90_000;
const PICKER_TIMEOUT_MS = 120_000;

function attachProfiles(entries: LibraryEntry[]): LibraryEntry[] {
  return entries.map((entry) => ({
    ...entry,
    profileId: resolveProfile(entry)?.id ?? null,
  }));
}

function formatError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") {
      return "Folder selection was cancelled.";
    }
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred.";
}

function persistLibraryInBackground(
  dirHandle: FileSystemDirectoryHandle,
  entries: LibraryEntry[],
): void {
  void (async () => {
    try {
      await saveDirectoryHandle(dirHandle);
      await saveLibrarySnapshot(dirHandle.name, entries);
    } catch {
      // Directory handles cannot always be persisted (e.g. mocked environments).
    }
  })();
}

async function loadFolderCatalog(
  dirHandle: FileSystemDirectoryHandle,
  onProgress: (progress: ScanProgress) => void,
): Promise<LibraryEntry[]> {
  return withTimeout(
    scanDirectory(dirHandle, onProgress),
    SCAN_TIMEOUT_MS,
    "Timed out while reading the folder. Try a local folder that is not synced with iCloud, OneDrive, or Google Drive.",
  );
}

async function resolveStoredDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const storedHandle = await getDirectoryHandle();
  if (!storedHandle) {
    return null;
  }

  if (!(await isDirectoryHandleReadable(storedHandle))) {
    await clearPersistedLibrary();
    return null;
  }

  return storedHandle;
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

  pickFolder: async () => {
    const state = get();
    if (state.importState === "importing" || state.importState === "restoring") {
      return;
    }

    set({
      importState: "importing",
      importError: null,
      importStatus: "Choose a folder in the system dialog…",
    });

    try {
      const dirHandle = await withTimeout(
        pickPhotoFolder(),
        PICKER_TIMEOUT_MS,
        "Folder selection timed out. If a dialog is open behind this window, complete it and try again.",
      );

      set({
        folderName: dirHandle.name,
        entries: [],
        needsFolderAccess: false,
        importStatus: "Scanning folder…",
      });

      const scanned = attachProfiles(
        await loadFolderCatalog(dirHandle, (progress) => {
          set({ importStatus: `Found ${progress.count} photos…` });
        }),
      );

      if (scanned.length === 0) {
        throw new Error(
          "No supported photos found. Darkroom supports NEF, JPEG, PNG, and WebP.",
        );
      }

      set({
        folderName: dirHandle.name,
        entries: scanned,
        needsFolderAccess: false,
        importState: "idle",
        importStatus: null,
        importError: null,
      });

      persistLibraryInBackground(dirHandle, scanned);

      void refreshEntryMetadata(scanned).then((refreshed) => {
        const withProfiles = attachProfiles(refreshed);
        if (get().folderName === dirHandle.name) {
          set({ entries: withProfiles });
          persistLibraryInBackground(dirHandle, withProfiles);
        }
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        set({
          importState: "idle",
          importStatus: null,
          importError: null,
          needsFolderAccess: get().entries.length === 0,
        });
        return;
      }

      set({
        importState: "idle",
        importError: formatError(error),
        importStatus: null,
        needsFolderAccess: get().entries.length === 0,
      });
    }
  },

  restoreLastFolder: async ({ interactive = false } = {}) => {
    if (!interactive) {
      const snapshot = await getLibrarySnapshot();
      if (!snapshot) {
        return;
      }

      const storedHandle = await getDirectoryHandle();
      if (!storedHandle) {
        set({
          folderName: snapshot.folderName,
          entries: [],
          needsFolderAccess: true,
          importState: "idle",
          importError: null,
          importStatus: null,
        });
        return;
      }

      if (!(await isDirectoryHandleReadable(storedHandle))) {
        await clearPersistedLibrary();
        set({
          folderName: snapshot.folderName,
          entries: [],
          needsFolderAccess: true,
          importState: "idle",
          importError: null,
          importStatus: null,
        });
        return;
      }

      set({
        folderName: snapshot.folderName,
        importState: "restoring",
        importError: null,
        importStatus: "Loading library…",
        needsFolderAccess: false,
      });

      try {
        const scanned = attachProfiles(
          await loadFolderCatalog(storedHandle, (progress) => {
            set({ importStatus: `Found ${progress.count} photos…` });
          }),
        );

        if (scanned.length === 0) {
          throw new Error("No supported photos found in the saved folder.");
        }

        set({
          folderName: storedHandle.name,
          entries: scanned,
          needsFolderAccess: false,
          importState: "idle",
          importStatus: null,
          importError: null,
        });
      } catch (error) {
        await clearPersistedLibrary();
        set({
          folderName: snapshot.folderName,
          entries: [],
          needsFolderAccess: true,
          importState: "idle",
          importError: formatError(error),
          importStatus: null,
        });
      }

      return;
    }

    const state = get();
    if (state.importState === "importing" || state.importState === "restoring") {
      return;
    }

    set({
      importState: "restoring",
      importError: null,
      importStatus: "Preparing folder access…",
      needsFolderAccess: false,
    });

    try {
      let dirHandle = await resolveStoredDirectoryHandle();

      if (dirHandle) {
        const permission = await queryDirectoryPermission(dirHandle, "read");
        if (permission === "granted") {
          set({ importStatus: "Scanning folder…" });
        } else {
          set({ importStatus: "Approve folder access in the browser prompt…" });
          await ensureFolderReadAccess(dirHandle);
        }
      }

      if (!dirHandle) {
        set({ importStatus: "Choose your photo folder in the system dialog…" });
        dirHandle = await withTimeout(
          pickPhotoFolder(),
          PICKER_TIMEOUT_MS,
          "Folder selection timed out. If a dialog is open behind this window, complete it and try again.",
        );
      }

      set({
        folderName: dirHandle.name,
        entries: [],
        importStatus: "Scanning folder…",
      });

      const scanned = attachProfiles(
        await loadFolderCatalog(dirHandle, (progress) => {
          set({ importStatus: `Found ${progress.count} photos…` });
        }),
      );

      if (scanned.length === 0) {
        throw new Error(
          "No supported photos found in the selected folder. Darkroom supports NEF, JPEG, PNG, and WebP.",
        );
      }

      set({
        folderName: dirHandle.name,
        entries: scanned,
        needsFolderAccess: false,
        importState: "idle",
        importStatus: null,
        importError: null,
      });

      persistLibraryInBackground(dirHandle, scanned);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        set({
          importState: "idle",
          importStatus: null,
          importError: null,
          needsFolderAccess: true,
        });
        return;
      }

      await clearPersistedLibrary();

      set({
        importState: "idle",
        importError: formatError(error),
        importStatus: null,
        needsFolderAccess: true,
      });
    }
  },

  clearLibrary: async () => {
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
