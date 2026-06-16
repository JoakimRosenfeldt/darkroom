import { create } from "zustand";
import {
  getLibrarySnapshot,
  restoreEntriesFromSnapshot,
  saveLibrarySnapshot,
  scanDirectory,
} from "@/lib/fs/directory";
import {
  getDirectoryHandle,
  requestDirectoryPermission,
  saveDirectoryHandle,
} from "@/lib/fs/handles-store";
import type { LibraryEntry } from "@/lib/fs/types";
import { resolveProfile } from "@/lib/raw/decode";

export type ImportState = "idle" | "importing" | "restoring" | "error";

interface LibraryStore {
  folderName: string | null;
  entries: LibraryEntry[];
  importState: ImportState;
  importError: string | null;
  isSupportedBrowser: boolean;
  pickFolder: () => Promise<void>;
  restoreLastFolder: () => Promise<void>;
  clearLibrary: () => Promise<void>;
  setSupportedBrowser: (supported: boolean) => void;
}

function attachProfiles(entries: LibraryEntry[]): LibraryEntry[] {
  return entries.map((entry) => ({
    ...entry,
    profileId: resolveProfile(entry)?.id ?? null,
  }));
}

export const useLibraryStore = create<LibraryStore>((set) => ({
  folderName: null,
  entries: [],
  importState: "idle",
  importError: null,
  isSupportedBrowser: false,

  setSupportedBrowser: (supported) => set({ isSupportedBrowser: supported }),

  pickFolder: async () => {
    if (!("showDirectoryPicker" in window)) {
      set({
        importState: "error",
        importError: "Folder import requires a Chromium-based browser.",
      });
      return;
    }

    set({ importState: "importing", importError: null });

    try {
      const dirHandle = await window.showDirectoryPicker({ mode: "read" });
      const granted = await requestDirectoryPermission(dirHandle, "read");
      if (!granted) {
        throw new Error("Folder access was not granted.");
      }

      const scanned = attachProfiles(await scanDirectory(dirHandle));

      try {
        await saveDirectoryHandle(dirHandle);
        await saveLibrarySnapshot(dirHandle.name, scanned);
      } catch {
        // Directory handles cannot always be persisted (e.g. mocked environments).
      }

      set({
        folderName: dirHandle.name,
        entries: scanned,
        importState: "idle",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        set({ importState: "idle" });
        return;
      }

      set({
        importState: "error",
        importError:
          error instanceof Error ? error.message : "Failed to import folder.",
      });
    }
  },

  restoreLastFolder: async () => {
    const dirHandle = await getDirectoryHandle();
    const snapshot = await getLibrarySnapshot();

    if (!dirHandle || !snapshot) {
      return;
    }

    set({ importState: "restoring", importError: null });

    try {
      const granted = await requestDirectoryPermission(dirHandle, "read");
      if (!granted) {
        throw new Error("Please re-grant access to your photo folder.");
      }

      const restored = attachProfiles(
        await restoreEntriesFromSnapshot(dirHandle, snapshot),
      );

      set({
        folderName: snapshot.folderName,
        entries: restored,
        importState: "idle",
      });
    } catch (error) {
      set({
        importState: "error",
        importError:
          error instanceof Error
            ? error.message
            : "Failed to restore previous folder.",
      });
    }
  },

  clearLibrary: async () => {
    set({
      folderName: null,
      entries: [],
      importState: "idle",
      importError: null,
    });
  },
}));

export function getEntryById(
  entries: LibraryEntry[],
  id: string,
): LibraryEntry | undefined {
  return entries.find((entry) => entry.id === id);
}
