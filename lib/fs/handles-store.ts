import { get, set, del } from "idb-keyval";

const DIRECTORY_HANDLE_KEY = "darkroom-directory-handle";

export async function saveDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await set(DIRECTORY_HANDLE_KEY, handle);
}

export async function getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await get<FileSystemDirectoryHandle>(DIRECTORY_HANDLE_KEY);
  return handle ?? null;
}

export async function clearDirectoryHandle(): Promise<void> {
  await del(DIRECTORY_HANDLE_KEY);
}

export async function getUsableDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getDirectoryHandle();
  if (!handle) {
    return null;
  }

  try {
    await handle.queryPermission({ mode: "read" });
    return handle;
  } catch {
    await clearDirectoryHandle();
    return null;
  }
}

export async function queryDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "read",
): Promise<PermissionState> {
  return handle.queryPermission({ mode });
}

export async function requestDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "read",
): Promise<boolean> {
  const current = await queryDirectoryPermission(handle, mode);
  if (current === "granted") {
    return true;
  }

  const requested = await handle.requestPermission({ mode });
  return requested === "granted";
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}
