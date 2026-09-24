import { getDarkroomAPI } from "@/lib/fs/platform";
import type { ExportPreferences } from "./types";

let pendingWrites = Promise.resolve();

export function readExportPreferences(): Promise<ExportPreferences> {
  return pendingWrites.then(() => getDarkroomAPI().getExportOptions());
}

export function saveExportPreferences(options: Partial<ExportPreferences>): Promise<void> {
  const write = pendingWrites.then(() => getDarkroomAPI().setExportOptions(options));
  pendingWrites = write.catch(() => undefined);
  return write;
}
