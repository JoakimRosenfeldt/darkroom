import { getDarkroomAPI } from "@/lib/fs/platform";
import type { Album, EntryMetadata, PhotoCatalog } from "./types";

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCatalog: PhotoCatalog | null = null;

const PERSIST_DEBOUNCE_MS = 300;

async function flushCatalog(): Promise<void> {
  const catalog = pendingCatalog;
  pendingCatalog = null;
  persistTimer = null;

  if (!catalog) {
    return;
  }

  await getDarkroomAPI().writeCatalog(catalog);
}

export function scheduleCatalogPersist(catalog: PhotoCatalog): void {
  pendingCatalog = catalog;

  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    void flushCatalog().catch(() => {
      // Catalog persistence is best-effort.
    });
  }, PERSIST_DEBOUNCE_MS);
}

export async function loadCatalog(rootPath: string): Promise<PhotoCatalog | null> {
  return getDarkroomAPI().readCatalog(rootPath);
}

export async function deleteCatalog(rootPath: string): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    pendingCatalog = null;
  }

  await getDarkroomAPI().deleteCatalog(rootPath);
}

export function buildPhotoCatalog(
  rootPath: string,
  entries: Record<string, EntryMetadata>,
  albums: Album[] = [],
  archivedEntryIds: string[] = [],
): PhotoCatalog {
  return {
    version: 1,
    rootPath,
    entries,
    albums,
    archivedEntryIds,
  };
}
