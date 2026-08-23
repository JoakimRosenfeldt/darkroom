import type { RootId } from "../catalog/ids";
import {
  cancelCatalogScan,
  getAssetRequest,
  scanCatalogRoot,
  clearSessionCatalog,
  type ScanProgress,
} from "./session-catalog";
import { getDarkroomAPI } from "./platform";
import type { LibraryEntry } from "./types";

export type { ScanProgress } from "./session-catalog";

export async function scanDirectory(
  rootId: RootId,
  onProgress?: (progress: ScanProgress) => void,
): Promise<LibraryEntry[]> {
  const state = await scanCatalogRoot(rootId, onProgress);
  return state.entries;
}

export async function getFileFromEntry(entry: LibraryEntry): Promise<File> {
  const buffer = await getDarkroomAPI().catalogReadAsset(getAssetRequest(entry));
  return new File([buffer], entry.name);
}

export async function getFileHeadFromEntry(
  entry: LibraryEntry,
  maxBytes: number,
): Promise<Uint8Array> {
  const buffer = await getDarkroomAPI().catalogReadAssetHead({
    ...getAssetRequest(entry),
    maxBytes,
  });
  return new Uint8Array(buffer);
}

export async function cancelDirectoryScan(): Promise<void> {
  await cancelCatalogScan();
}

export async function clearPersistedLibrary(): Promise<void> {
  clearSessionCatalog();
}
