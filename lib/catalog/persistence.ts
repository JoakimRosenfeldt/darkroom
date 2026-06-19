import { get, set, del } from "idb-keyval";
import type { EntryMetadata, PhotoCatalog } from "./types";
import { isElectronApp, getDarkroomAPI } from "@/lib/fs/platform";

const CATALOG_PREFIX = "darkroom-catalog:";

function catalogIdbKey(rootPath: string): string {
  return `${CATALOG_PREFIX}${rootPath}`;
}

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

  if (isElectronApp()) {
    await getDarkroomAPI().writeCatalog(catalog);
    return;
  }

  await set(catalogIdbKey(catalog.rootPath), catalog);
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
  if (isElectronApp()) {
    return getDarkroomAPI().readCatalog(rootPath);
  }

  const stored = await get<PhotoCatalog>(catalogIdbKey(rootPath));
  return stored ?? null;
}

export async function saveCatalog(catalog: PhotoCatalog): Promise<void> {
  if (isElectronApp()) {
    await getDarkroomAPI().writeCatalog(catalog);
    return;
  }

  await set(catalogIdbKey(catalog.rootPath), catalog);
}

export async function deleteCatalog(rootPath: string): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    pendingCatalog = null;
  }

  if (isElectronApp()) {
    await getDarkroomAPI().deleteCatalog(rootPath);
    return;
  }

  await del(catalogIdbKey(rootPath));
}

export function buildPhotoCatalog(
  rootPath: string,
  entries: Record<string, EntryMetadata>,
): PhotoCatalog {
  return {
    version: 1,
    rootPath,
    entries,
  };
}
