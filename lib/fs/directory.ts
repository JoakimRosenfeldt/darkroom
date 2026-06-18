import { get, set, del } from "idb-keyval";
import { getDarkroomAPI, joinRootPath } from "./platform";
import {
  createEntryId,
  type LibraryEntry,
  type StoredLibrary,
} from "./types";
import { getSessionRootPath } from "./session-catalog";

const LIBRARY_KEY = "darkroom-library";

export interface ScanProgress {
  count: number;
  latestPath: string;
  latestEntry?: LibraryEntry;
  done?: boolean;
}

export async function scanDirectory(
  rootPath: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<LibraryEntry[]> {
  const api = getDarkroomAPI();
  const scanned = await api.scanFolder(rootPath);
  const entries: LibraryEntry[] = [];

  for (const file of scanned) {
    const libraryEntry: LibraryEntry = {
      id: createEntryId(file.relativePath),
      name: file.name,
      relativePath: file.relativePath,
      size: file.size,
      lastModified: file.lastModified,
      profileId: null,
    };
    entries.push(libraryEntry);
    onProgress?.({
      count: entries.length,
      latestPath: file.relativePath,
      latestEntry: libraryEntry,
    });
  }

  onProgress?.({
    count: entries.length,
    latestPath: "",
    done: true,
  });

  return entries;
}

export async function getFileFromEntry(
  entry: Pick<LibraryEntry, "name" | "relativePath">,
): Promise<File> {
  const rootPath = getSessionRootPath();
  if (!rootPath) {
    throw new Error("No folder is open.");
  }

  const api = getDarkroomAPI();
  const absolutePath = joinRootPath(rootPath, entry.relativePath);
  const buffer = await api.readFile(absolutePath);
  return new File([buffer], entry.name);
}

export async function getFileHeadFromEntry(
  entry: Pick<LibraryEntry, "relativePath">,
  maxBytes: number,
): Promise<Uint8Array> {
  const rootPath = getSessionRootPath();
  if (!rootPath) {
    throw new Error("No folder is open.");
  }

  const api = getDarkroomAPI();
  const absolutePath = joinRootPath(rootPath, entry.relativePath);
  const buffer = await api.readFileHead(absolutePath, maxBytes);
  return new Uint8Array(buffer);
}

export async function saveLibrarySnapshot(
  folderName: string,
  rootPath: string,
  entries: LibraryEntry[],
): Promise<void> {
  const snapshot: StoredLibrary = {
    folderName,
    rootPath,
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
  await getDarkroomAPI().setLastFolder(rootPath);
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
  const rootPath = getSessionRootPath();
  if (!rootPath) {
    return entries;
  }

  const api = getDarkroomAPI();
  const refreshed: LibraryEntry[] = [];

  for (const entry of entries) {
    try {
      const absolutePath = joinRootPath(rootPath, entry.relativePath);
      const stat = await api.statFile(absolutePath);
      refreshed.push({
        ...entry,
        size: stat.size,
        lastModified: stat.lastModified,
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
