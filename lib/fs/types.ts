export interface LibraryEntry {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
  profileId: string | null;
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
