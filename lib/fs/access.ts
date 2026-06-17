import { withTimeout } from "./timeout";

const FOLDER_PROBE_TIMEOUT_MS = 20_000;
const PERMISSION_REQUEST_TIMEOUT_MS = 30_000;

async function probeDirectoryReadable(
  dirHandle: FileSystemDirectoryHandle,
): Promise<void> {
  await withTimeout(
    (async () => {
      const iterator = dirHandle.values();
      try {
        await iterator.next();
      } finally {
        if (typeof iterator.return === "function") {
          await iterator.return();
        }
      }
    })(),
    FOLDER_PROBE_TIMEOUT_MS,
    "The folder is not responding. Cloud-synced folders (iCloud, OneDrive, Google Drive) often block access — try a fully local folder.",
  );
}

export async function ensureFolderReadAccess(
  dirHandle: FileSystemDirectoryHandle,
): Promise<void> {
  const permission = await dirHandle.queryPermission({ mode: "read" });

  if (permission === "granted") {
    await probeDirectoryReadable(dirHandle);
    return;
  }

  if (permission === "denied") {
    throw new Error(
      "Folder access was denied. Reset site permissions for this page in Chrome settings and try again.",
    );
  }

  let requested: PermissionState;
  try {
    requested = await withTimeout(
      dirHandle.requestPermission({ mode: "read" }),
      PERMISSION_REQUEST_TIMEOUT_MS,
      "Folder permission request timed out. Click Re-link again and approve access in the dialog.",
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "SecurityError") {
      throw new Error(
        "Could not request folder access. Click Re-link again to grant permission.",
      );
    }
    throw error;
  }

  if (requested !== "granted") {
    throw new Error(`Folder access was not granted (${requested}).`);
  }

  await probeDirectoryReadable(dirHandle);
}

export async function pickPhotoFolder(): Promise<FileSystemDirectoryHandle> {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("Folder import requires a Chromium-based browser.");
  }

  const dirHandle = await window.showDirectoryPicker({
    mode: "read",
  });

  // The picker already grants read access. Do not call requestPermission here —
  // user activation may have expired and that call can hang indefinitely.
  await probeDirectoryReadable(dirHandle);
  return dirHandle;
}
