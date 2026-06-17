import { createEntryId, isSupportedFileName, type LibraryEntry } from "./types";
import { fsDebug, fsDebugError } from "./debug";
import { withTimeout } from "./timeout";

export interface ScanProgress {
  count: number;
  latestPath: string;
  latestEntry?: LibraryEntry;
  done?: boolean;
}

interface ScanQueueItem {
  dir: FileSystemDirectoryHandle;
  prefix: string;
}

type DirectoryEntriesIterator = AsyncIterableIterator<
  [string, FileSystemHandle]
>;

const FIRST_ENTRY_TIMEOUT_MS = 20_000;
const MAX_VISITED_DIRECTORIES = 10_000;

function getEntriesIterator(
  dirHandle: FileSystemDirectoryHandle,
): DirectoryEntriesIterator {
  return (
    dirHandle as FileSystemDirectoryHandle & {
      entries(): DirectoryEntriesIterator;
    }
  ).entries();
}

async function yieldToMain(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

async function* iterateDirectoryEntries(
  dirHandle: FileSystemDirectoryHandle,
): AsyncGenerator<[string, FileSystemHandle]> {
  const iterator = getEntriesIterator(dirHandle);
  let first = true;

  while (true) {
    const nextPromise = iterator.next();
    const result = first
      ? await withTimeout(
          nextPromise,
          FIRST_ENTRY_TIMEOUT_MS,
          "Timed out while reading the folder. Cloud-synced folders (iCloud, OneDrive, Google Drive) may not work — try a local folder.",
        )
      : await nextPromise;
    first = false;

    if (result.done) {
      break;
    }

    const [name, handle] = result.value;
    if (!name) {
      continue;
    }

    yield [name, handle];
  }
}

export async function scanDirectoryTree(
  root: FileSystemDirectoryHandle,
  onProgress?: (progress: ScanProgress) => void,
): Promise<LibraryEntry[]> {
  fsDebug("scanDirectoryTree: start", { folderName: root.name });

  const entries: LibraryEntry[] = [];
  const queue: ScanQueueItem[] = [{ dir: root, prefix: "" }];
  let visitedDirs = 0;

  try {
    while (queue.length > 0) {
      const { dir, prefix } = queue.shift()!;
      visitedDirs += 1;

      if (visitedDirs === 1) {
        fsDebug("scanDirectoryTree: reading root directory", {
          folderName: root.name,
        });
      }

      if (visitedDirs > MAX_VISITED_DIRECTORIES) {
        throw new Error(
          "Folder is too large or contains too many subfolders to scan.",
        );
      }

      if (visitedDirs % 8 === 0) {
        await yieldToMain();
      }

      for await (const [name, handle] of iterateDirectoryEntries(dir)) {
        const relativePath = prefix ? `${prefix}/${name}` : name;

        if (handle.kind === "directory") {
          queue.push({
            dir: handle as FileSystemDirectoryHandle,
            prefix: relativePath,
          });
          continue;
        }

        if (handle.kind !== "file" || !isSupportedFileName(name)) {
          continue;
        }

        const libraryEntry: LibraryEntry = {
          id: createEntryId(relativePath),
          name,
          relativePath,
          size: 0,
          lastModified: 0,
          handle: handle as FileSystemFileHandle,
          profileId: null,
        };

        entries.push(libraryEntry);
        onProgress?.({
          count: entries.length,
          latestPath: relativePath,
          latestEntry: libraryEntry,
        });
      }
    }

    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    onProgress?.({
      count: entries.length,
      latestPath: "",
      done: true,
    });

    fsDebug("scanDirectoryTree: complete", {
      folderName: root.name,
      visitedDirs,
      photoCount: entries.length,
    });

    return entries;
  } catch (error) {
    fsDebugError("scanDirectoryTree: failed", error, {
      folderName: root.name,
      visitedDirs,
      photoCount: entries.length,
    });
    throw error;
  }
}
