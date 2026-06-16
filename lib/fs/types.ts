export interface FileRef {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
  handle: FileSystemFileHandle;
}

export interface LibraryEntry extends FileRef {
  profileId: string | null;
}

export interface StoredLibrary {
  folderName: string;
  entries: Array<Omit<LibraryEntry, "handle">>;
  importedAt: number;
}

export const SUPPORTED_EXTENSIONS = [
  ".nef",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
] as const;

export function isSupportedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function createEntryId(relativePath: string): string {
  return encodeURIComponent(relativePath);
}

export function decodeEntryId(id: string): string {
  return decodeURIComponent(id);
}
