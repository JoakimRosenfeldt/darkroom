import type { LibraryEntry, StoredLibrary } from "./types";
import { scanDirectoryTree, type ScanProgress } from "./scan";
import { get, set, del } from "idb-keyval";

const LIBRARY_KEY = "darkroom-library";
const DIRECTORY_PICKER_ID = "darkroom-library";

export type { ScanProgress };

export { scanDirectoryTree as scanDirectory };

export function getDirectoryPickerId(): string {
  return DIRECTORY_PICKER_ID;
}

export async function getFileFromEntry(
  entry: Pick<LibraryEntry, "handle">,
): Promise<File> {
  return entry.handle.getFile();
}

export async function saveLibrarySnapshot(
  folderName: string,
  entries: LibraryEntry[],
): Promise<void> {
  const snapshot: StoredLibrary = {
    folderName,
    importedAt: Date.now(),
    entries: entries.map(
      ({ id, name, relativePath, size, lastModified, profileId }) => ({
        id,
        name,
        relativePath,
        size,
        lastModified,
        profileId,
      }),
    ),
  };
  await set(LIBRARY_KEY, snapshot);
}

export async function getLibrarySnapshot(): Promise<StoredLibrary | null> {
  const snapshot = await get<StoredLibrary>(LIBRARY_KEY);
  return snapshot ?? null;
}

export async function clearLibrarySnapshot(): Promise<void> {
  await del(LIBRARY_KEY);
}

export async function refreshEntryMetadata(
  entries: LibraryEntry[],
): Promise<LibraryEntry[]> {
  const refreshed: LibraryEntry[] = [];

  for (const entry of entries) {
    try {
      const file = await entry.handle.getFile();
      refreshed.push({
        ...entry,
        size: file.size,
        lastModified: file.lastModified,
      });
    } catch {
      refreshed.push(entry);
    }

    if (refreshed.length % 32 === 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
    }
  }

  return refreshed;
}
