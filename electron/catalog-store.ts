import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parsePhotoCatalog, type PhotoCatalog } from "../lib/catalog/types";

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
      const parsed = parsePhotoCatalog(JSON.parse(raw));
      if (path.resolve(parsed.rootPath) !== path.resolve(rootPath)) return null;
      return parsed;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function write(catalog: PhotoCatalog): Promise<void> {
    const parsed = parsePhotoCatalog(catalog);
    if (catalog.version !== 2) throw new Error("Darkroom only writes catalog version 2.");
    await fs.mkdir(catalogsDir, { recursive: true });
    await fs.writeFile(
      catalogPath(parsed.rootPath),
      JSON.stringify(parsed, null, 2),
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
