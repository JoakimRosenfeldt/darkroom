import {
  createEntryId,
  isSupportedFileName,
  type FileRef,
  type LibraryEntry,
  type StoredLibrary,
} from "./types";
import { iterateDirectory } from "./iterate";
import { get, set } from "idb-keyval";

const LIBRARY_KEY = "darkroom-library";

async function collectFiles(
  dirHandle: FileSystemDirectoryHandle,
  prefix = "",
): Promise<FileRef[]> {
  const files: FileRef[] = [];

  for await (const entry of iterateDirectory(dirHandle)) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.kind === "directory") {
      const nested = await collectFiles(
        entry as FileSystemDirectoryHandle,
        relativePath,
      );
      files.push(...nested);
      continue;
    }

    if (entry.kind !== "file" || !isSupportedFileName(entry.name)) {
      continue;
    }

    const fileHandle = entry as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    files.push({
      id: createEntryId(relativePath),
      name: entry.name,
      relativePath,
      size: file.size,
      lastModified: file.lastModified,
      handle: fileHandle,
    });
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function scanDirectory(
  dirHandle: FileSystemDirectoryHandle,
): Promise<LibraryEntry[]> {
  const files = await collectFiles(dirHandle);
  return files.map((file) => ({
    ...file,
    profileId: null,
  }));
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

export async function resolveEntryHandle(
  dirHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemFileHandle | null> {
  const parts = relativePath.split("/");
  let currentDir = dirHandle;

  for (let i = 0; i < parts.length - 1; i += 1) {
    try {
      currentDir = await currentDir.getDirectoryHandle(parts[i]);
    } catch {
      return null;
    }
  }

  try {
    return await currentDir.getFileHandle(parts[parts.length - 1]);
  } catch {
    return null;
  }
}

export async function restoreEntriesFromSnapshot(
  dirHandle: FileSystemDirectoryHandle,
  snapshot: StoredLibrary,
): Promise<LibraryEntry[]> {
  const entries: LibraryEntry[] = [];

  for (const stored of snapshot.entries) {
    const handle = await resolveEntryHandle(dirHandle, stored.relativePath);
    if (!handle) {
      continue;
    }

    entries.push({
      ...stored,
      handle,
    });
  }

  return entries;
}
