import type { EntryMetadata } from "./types";
import type { LibraryEntry } from "@/lib/fs/types";

/** Phase 2: read XMP sidecar and merge into catalog metadata. */
export async function importXmpForEntry(
  _entry: LibraryEntry,
  _rootPath: string,
): Promise<Partial<EntryMetadata> | null> {
  return null;
}

/** Phase 2: write catalog metadata to XMP sidecar. */
export async function exportXmpForEntry(
  _entry: LibraryEntry,
  _rootPath: string,
  _metadata: EntryMetadata,
): Promise<void> {
  // Not implemented in v1.
}
