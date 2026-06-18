import { clearLibrarySnapshot } from "./directory";
import { getDarkroomAPI } from "./platform";
import { clearSessionCatalog } from "./session-catalog";

export async function clearPersistedLibraryHandles(): Promise<void> {
  // Legacy no-op — Electron stores the folder path in app settings.
}

export async function clearPersistedLibrary(): Promise<void> {
  clearSessionCatalog();
  await Promise.all([
    getDarkroomAPI().setLastFolder(null),
    clearLibrarySnapshot(),
  ]);
}
