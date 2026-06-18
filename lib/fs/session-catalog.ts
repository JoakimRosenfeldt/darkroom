import type { LibraryEntry } from "./types";

let activeRootPath: string | null = null;
let activeFolderName: string | null = null;
let activeEntries: LibraryEntry[] = [];

export function setSessionCatalog(
  folderName: string,
  entries: LibraryEntry[],
  rootPath: string | null = null,
): void {
  activeFolderName = folderName;
  activeEntries = entries;
  activeRootPath = rootPath;
}

export function getSessionCatalog(): {
  rootPath: string | null;
  folderName: string | null;
  entries: LibraryEntry[];
} {
  return {
    rootPath: activeRootPath,
    folderName: activeFolderName,
    entries: activeEntries,
  };
}

export function getSessionRootPath(): string | null {
  return activeRootPath;
}

export function hasSessionCatalog(): boolean {
  return activeRootPath !== null && activeEntries.length > 0;
}

export function clearSessionCatalog(): void {
  activeRootPath = null;
  activeFolderName = null;
  activeEntries = [];
}
