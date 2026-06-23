import type { LibraryEntry } from "@/lib/fs/types";

export function filterArchivedEntries(
  entries: LibraryEntry[],
  archivedEntryIds: string[],
): LibraryEntry[] {
  if (archivedEntryIds.length === 0) {
    return entries;
  }

  const archived = new Set(archivedEntryIds);
  return entries.filter((entry) => !archived.has(entry.id));
}

export function filterOnlyArchivedEntries(
  entries: LibraryEntry[],
  archivedEntryIds: string[],
): LibraryEntry[] {
  if (archivedEntryIds.length === 0) {
    return [];
  }

  const archived = new Set(archivedEntryIds);
  return entries.filter((entry) => archived.has(entry.id));
}

export function pruneArchivedEntryIds(
  archivedEntryIds: string[],
  entryIds: Set<string>,
): string[] {
  return archivedEntryIds.filter((id) => entryIds.has(id));
}
