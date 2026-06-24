import { getDarkroomAPI, joinRootPath } from "./platform";
import { createEntryId, type LibraryEntry } from "./types";
import { clearSessionCatalog, getSessionRootPath } from "./session-catalog";

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

export async function persistLastFolder(rootPath: string): Promise<void> {
  await getDarkroomAPI().setLastFolder(rootPath);
}

export async function clearPersistedLibrary(): Promise<void> {
  clearSessionCatalog();
  await getDarkroomAPI().setLastFolder(null);
}
