import { clearLibrarySnapshot } from "./directory";
import { clearDirectoryHandle } from "./handles-store";
import { clearSessionCatalog } from "./session-catalog";

/** Remove legacy persisted handles only (keeps catalog snapshot). */
export async function clearPersistedLibraryHandles(): Promise<void> {
  await clearDirectoryHandle();
}

export async function clearPersistedLibrary(): Promise<void> {
  clearSessionCatalog();
  await Promise.all([clearDirectoryHandle(), clearLibrarySnapshot()]);
}
