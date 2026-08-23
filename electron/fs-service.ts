import path from "node:path";
import { shell } from "electron";

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
