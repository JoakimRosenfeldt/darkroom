import type { LibraryEntry } from "./types";

let activeDirectoryHandle: FileSystemDirectoryHandle | null = null;
let activeFolderName: string | null = null;
let activeEntries: LibraryEntry[] = [];

export function setSessionCatalog(
  folderName: string,
  entries: LibraryEntry[],
  dirHandle: FileSystemDirectoryHandle | null = null,
): void {
  activeFolderName = folderName;
  activeEntries = entries;
  activeDirectoryHandle = dirHandle;
}

export function getSessionCatalog(): {
  dirHandle: FileSystemDirectoryHandle | null;
  folderName: string | null;
  entries: LibraryEntry[];
} {
  return {
    dirHandle: activeDirectoryHandle,
    folderName: activeFolderName,
    entries: activeEntries,
  };
}

export function hasSessionCatalog(): boolean {
  return activeFolderName !== null && activeEntries.length > 0;
}

export function clearSessionCatalog(): void {
  activeDirectoryHandle = null;
  activeFolderName = null;
  activeEntries = [];
}
