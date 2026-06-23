import fs from "node:fs/promises";
import path from "node:path";
import { shell } from "electron";
import { isSupportedFileName } from "../lib/fs/types";

const SUPPORTED_EXTENSIONS = [".nef", ".jpg", ".jpeg", ".png", ".webp"] as const;

export interface ScannedFile {
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
}

interface ScanQueueItem {
  dirPath: string;
  prefix: string;
}

const MAX_VISITED_DIRECTORIES = 10_000;

export async function scanFolderTree(rootPath: string): Promise<ScannedFile[]> {
  const entries: ScannedFile[] = [];
  const queue: ScanQueueItem[] = [{ dirPath: rootPath, prefix: "" }];
  let visitedDirs = 0;

  while (queue.length > 0) {
    const { dirPath, prefix } = queue.shift()!;
    visitedDirs += 1;

    if (visitedDirs > MAX_VISITED_DIRECTORIES) {
      throw new Error(
        "Folder is too large or contains too many subfolders to scan.",
      );
    }

    let dirEntries;
    try {
      dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to read folder.";
      throw new Error(message);
    }

    for (const dirent of dirEntries) {
      if (dirent.name.startsWith(".")) {
        continue;
      }

      const absolutePath = path.join(dirPath, dirent.name);
      const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        queue.push({ dirPath: absolutePath, prefix: relativePath });
        continue;
      }

      if (!dirent.isFile() || !isSupportedFileName(dirent.name)) {
        continue;
      }

      const stat = await fs.stat(absolutePath);
      entries.push({
        name: dirent.name,
        relativePath,
        size: stat.size,
        lastModified: stat.mtimeMs,
      });
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

export async function readFileBuffer(absolutePath: string): Promise<Buffer> {
  return fs.readFile(absolutePath);
}

export async function readFileHead(
  absolutePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(Math.max(1, maxBytes), stat.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function statFile(absolutePath: string): Promise<{
  size: number;
  lastModified: number;
}> {
  const stat = await fs.stat(absolutePath);
  return { size: stat.size, lastModified: stat.mtimeMs };
}

export async function folderExists(folderPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(folderPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function getFolderName(folderPath: string): string {
  return path.basename(folderPath);
}

export async function trashFiles(absolutePaths: string[]): Promise<void> {
  const failures: string[] = [];

  for (const filePath of absolutePaths) {
    try {
      await shell.trashItem(filePath);
    } catch {
      failures.push(path.basename(filePath));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      failures.length === 1
        ? `Could not move "${failures[0]}" to the trash.`
        : `Could not move ${failures.length} files to the trash.`,
    );
  }
}

export { SUPPORTED_EXTENSIONS };
