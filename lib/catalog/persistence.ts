import { getDarkroomAPI } from "@/lib/fs/platform";
import type { Album, EntryMetadata, PhotoCatalog } from "./types";

interface PendingCatalog {
  timer: ReturnType<typeof setTimeout> | null;
  catalog: PhotoCatalog | null;
  queue: Promise<void>;
}

const pendingByRoot = new Map<string, PendingCatalog>();
const PERSIST_DEBOUNCE_MS = 300;

function pendingFor(rootPath: string): PendingCatalog {
  const current = pendingByRoot.get(rootPath);
  if (current) return current;
  const created: PendingCatalog = { timer: null, catalog: null, queue: Promise.resolve() };
  pendingByRoot.set(rootPath, created);
  return created;
}

async function flushCatalog(rootPath: string): Promise<void> {
  const pending = pendingByRoot.get(rootPath);
  if (!pending) return;
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  const catalog = pending.catalog;
  pending.catalog = null;
  if (!catalog) return pending.queue;
  const write = () => getDarkroomAPI().writeCatalog(catalog);
  pending.queue = pending.queue.then(write, write);
  await pending.queue;
}

export function scheduleCatalogPersist(catalog: PhotoCatalog): void {
  const pending = pendingFor(catalog.rootPath);
  pending.catalog = catalog;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pending.timer = null;
    void flushCatalog(catalog.rootPath).catch(() => undefined);
  }, PERSIST_DEBOUNCE_MS);
}

export async function loadCatalog(rootPath: string): Promise<PhotoCatalog | null> {
  return getDarkroomAPI().readCatalog(rootPath);
}

export async function deleteCatalog(rootPath: string): Promise<void> {
  const pending = pendingByRoot.get(rootPath);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingByRoot.delete(rootPath);
  await getDarkroomAPI().deleteCatalog(rootPath);
}

export function buildPhotoCatalog(
  rootPath: string,
  entries: Record<string, EntryMetadata>,
  albums: Album[] = [],
  archivedEntryIds: string[] = [],
): PhotoCatalog {
  return { version: 2, rootPath, entries, albums, archivedEntryIds };
}
