import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PhotoCatalog } from "../lib/catalog/types";

function catalogKeyForRootPath(rootPath: string): string {
  const normalized = path.resolve(rootPath);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function createCatalogStore(userDataPath: string) {
  const catalogsDir = path.join(userDataPath, "catalogs");

  function catalogPath(rootPath: string): string {
    return path.join(catalogsDir, `${catalogKeyForRootPath(rootPath)}.json`);
  }

  async function read(rootPath: string): Promise<PhotoCatalog | null> {
    try {
      const raw = await fs.readFile(catalogPath(rootPath), "utf8");
      const parsed = JSON.parse(raw) as PhotoCatalog;
      if (parsed.version !== 1 || typeof parsed.entries !== "object") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async function write(catalog: PhotoCatalog): Promise<void> {
    await fs.mkdir(catalogsDir, { recursive: true });
    await fs.writeFile(
      catalogPath(catalog.rootPath),
      JSON.stringify(catalog, null, 2),
      "utf8",
    );
  }

  async function remove(rootPath: string): Promise<void> {
    try {
      await fs.unlink(catalogPath(rootPath));
    } catch {
      // Catalog may not exist.
    }
  }

  return { read, write, remove };
}
