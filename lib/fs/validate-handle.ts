import { clearLibrarySnapshot } from "./directory";
import { clearDirectoryHandle } from "./handles-store";

export async function isDirectoryHandleReadable(
  dirHandle: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    const permission = await dirHandle.queryPermission({ mode: "read" });
    if (permission !== "granted") {
      return false;
    }

    const iterator = dirHandle.values();
    try {
      await iterator.next();
    } finally {
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    }

    return true;
  } catch {
    return false;
  }
}

export async function clearPersistedLibrary(): Promise<void> {
  await Promise.all([clearDirectoryHandle(), clearLibrarySnapshot()]);
}
