import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AssetId, CatalogId } from "../lib/catalog/ids.ts";
import { parseEntryAnalysis, type EntryAnalysis } from "../lib/library/model.ts";

interface StoredMetadataAnalysis {
  readonly version: 1;
  readonly sourceSha256: string;
  readonly parserVersion: string;
  readonly adapterVersion: string;
  readonly analysis: EntryAnalysis;
}

function cacheFile(rootPath: string, catalogId: CatalogId, entryId: AssetId): string {
  return path.join(rootPath, catalogId, `${entryId}.json`);
}

function stored(value: unknown): StoredMetadataAnalysis {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Metadata cache entry must be an object.");
  }
  const input = Object.fromEntries(Object.entries(value));
  if (
    input.version !== 1 ||
    typeof input.sourceSha256 !== "string" ||
    typeof input.parserVersion !== "string" ||
    typeof input.adapterVersion !== "string"
  ) {
    throw new Error("Metadata cache entry is invalid.");
  }
  return {
    version: 1,
    sourceSha256: input.sourceSha256,
    parserVersion: input.parserVersion,
    adapterVersion: input.adapterVersion,
    analysis: parseEntryAnalysis(input.analysis, "metadata cache analysis"),
  };
}

export class MetadataCache {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async read(input: {
    readonly catalogId: CatalogId;
    readonly entryId: AssetId;
    readonly sourceSha256: string;
    readonly parserVersion: string;
    readonly adapterVersion: string;
  }): Promise<EntryAnalysis | null> {
    try {
      const contents = await fs.readFile(
        cacheFile(this.rootPath, input.catalogId, input.entryId),
        "utf8",
      );
      const parsed = stored(JSON.parse(contents));
      if (
        parsed.sourceSha256 !== input.sourceSha256 ||
        parsed.parserVersion !== input.parserVersion ||
        parsed.adapterVersion !== input.adapterVersion
      ) return null;
      return parsed.analysis;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) return null;
      return null;
    }
  }

  async write(input: {
    readonly catalogId: CatalogId;
    readonly entryId: AssetId;
    readonly analysis: EntryAnalysis;
  }): Promise<void> {
    if (
      input.analysis.sourceSha256 === null ||
      input.analysis.parserVersion === null ||
      input.analysis.adapterVersion === null
    ) return;
    const destination = cacheFile(this.rootPath, input.catalogId, input.entryId);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const payload: StoredMetadataAnalysis = {
      version: 1,
      sourceSha256: input.analysis.sourceSha256,
      parserVersion: input.analysis.parserVersion,
      adapterVersion: input.analysis.adapterVersion,
      analysis: input.analysis,
    };
    try {
      await fs.writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, destination);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  async clearCatalog(catalogId: CatalogId): Promise<void> {
    await fs.rm(path.join(this.rootPath, catalogId), { recursive: true, force: true });
  }
}
