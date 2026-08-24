import { createHash } from "node:crypto";
import path from "node:path";

function catalogKeyForRootPath(rootPath: string): string {
  const normalized = path.resolve(rootPath);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function getLegacyCatalogPath(userDataPath: string, rootPath: string): string {
  return path.join(userDataPath, "catalogs", `${catalogKeyForRootPath(rootPath)}.json`);
}
