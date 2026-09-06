import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_EXPORT_SUFFIX,
  type ExportConflictBehavior,
  type ExportFormatId,
  type ExportSizeOptions,
} from "../lib/export/types.ts";
import { parseCatalogId, type CatalogId } from "../lib/catalog/ids.ts";
import {
  DEFAULT_DEVELOP_CLIPBOARD_GROUPS,
  parseDevelopClipboardGroups,
  type DevelopClipboardGroup,
} from "../lib/develop/clipboard/schema.ts";

export interface ExportOptionsSettings {
  metadata?: "all" | "copyright" | "none";
  includeLocation?: boolean;
  format: ExportFormatId;
  quality: number;
  lossless: boolean;
  size: ExportSizeOptions;
  suffix: string;
  conflict: ExportConflictBehavior;
}

export interface AppSettings {
  lastFolderPath: string | null;
  lastCatalogId: CatalogId | null;
  exportOptions: ExportOptionsSettings;
  developClipboardGroups: readonly DevelopClipboardGroup[];
}

export type ExportOptionsSettingsInput = Partial<ExportOptionsSettings>;

const DEFAULT_EXPORT_OPTIONS: ExportOptionsSettings = {
  format: "jpeg",
  quality: 90,
  lossless: false,
  size: { mode: "original" },
  suffix: DEFAULT_EXPORT_SUFFIX,
  conflict: "rename",
};

const DEFAULT_SETTINGS: AppSettings = {
  lastFolderPath: null,
  lastCatalogId: null,
  exportOptions: DEFAULT_EXPORT_OPTIONS,
  developClipboardGroups: DEFAULT_DEVELOP_CLIPBOARD_GROUPS,
};

const MAX_EXPORT_EDGE = 100_000;
const MAX_SUFFIX_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFormat(value: unknown): value is ExportFormatId {
  return value === "jpeg" || value === "png" || value === "webp" || value === "avif" || value === "tiff";
}

function isConflict(value: unknown): value is ExportConflictBehavior {
  return value === "rename" || value === "skip" || value === "replace";
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

function normalizeSize(value: unknown): ExportSizeOptions {
  if (!isRecord(value) || typeof value.mode !== "string") {
    return { ...DEFAULT_EXPORT_OPTIONS.size };
  }
  if (value.mode === "original") {
    return { mode: "original" };
  }
  if (value.mode === "long-edge" || value.mode === "longEdge") {
    const pixels = value.pixels ?? value.longEdge;
    if (!positiveInteger(pixels, MAX_EXPORT_EDGE)) {
      return { ...DEFAULT_EXPORT_OPTIONS.size };
    }
    return {
      mode: "long-edge",
      pixels,
      ...(typeof value.neverUpscale === "boolean"
        ? { neverUpscale: value.neverUpscale }
        : {}),
    };
  }
  if (value.mode === "fit") {
    if (!positiveInteger(value.width, MAX_EXPORT_EDGE) || !positiveInteger(value.height, MAX_EXPORT_EDGE)) {
      return { ...DEFAULT_EXPORT_OPTIONS.size };
    }
    return {
      mode: "fit",
      width: value.width,
      height: value.height,
      ...(typeof value.neverUpscale === "boolean"
        ? { neverUpscale: value.neverUpscale }
        : {}),
    };
  }
  return { ...DEFAULT_EXPORT_OPTIONS.size };
}

function normalizeSuffix(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_SUFFIX_LENGTH ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..")
  ) {
    return DEFAULT_EXPORT_SUFFIX;
  }
  return value;
}

function normalizeExportOptions(value: unknown): ExportOptionsSettings {
  const input = isRecord(value) ? value : {};
  const format = isFormat(input.format)
    ? input.format
    : DEFAULT_EXPORT_OPTIONS.format;
  const quality = Number.isInteger(input.quality) && Number(input.quality) >= 1 && Number(input.quality) <= 100
    ? Number(input.quality)
    : DEFAULT_EXPORT_OPTIONS.quality;
  return {
    format,
    quality,
    metadata: input.metadata === "none" || input.metadata === "copyright" ? input.metadata : "all",
    includeLocation: input.includeLocation === true,
    lossless: typeof input.lossless === "boolean"
      ? input.lossless
      : DEFAULT_EXPORT_OPTIONS.lossless,
    size: normalizeSize(input.size),
    suffix: normalizeSuffix(input.suffix),
    conflict: isConflict(input.conflict)
      ? input.conflict
      : DEFAULT_EXPORT_OPTIONS.conflict,
  };
}

function normalizeSettings(value: unknown): AppSettings {
  const input = isRecord(value) ? value : {};
  let lastCatalogId: CatalogId | null = null;
  if (typeof input.lastCatalogId === "string") {
    try {
      lastCatalogId = parseCatalogId(input.lastCatalogId);
    } catch {
      lastCatalogId = null;
    }
  }
  return {
    lastFolderPath: typeof input.lastFolderPath === "string"
      ? input.lastFolderPath
      : null,
    lastCatalogId,
    exportOptions: normalizeExportOptions(input.exportOptions),
    developClipboardGroups: (() => {
      try {
        return parseDevelopClipboardGroups(input.developClipboardGroups);
      } catch {
        return DEFAULT_DEVELOP_CLIPBOARD_GROUPS;
      }
    })(),
  };
}

export function createSettingsStore(userDataPath: string) {
  const settingsPath = path.join(userDataPath, "settings.json");
  let writes: Promise<void> = Promise.resolve();

  async function read(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(settingsPath, "utf8");
      return normalizeSettings(JSON.parse(raw) as unknown);
    } catch {
      return normalizeSettings(DEFAULT_SETTINGS);
    }
  }

  async function write(settings: AppSettings): Promise<void> {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
    const contents = JSON.stringify(normalizeSettings(settings), null, 2);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, settingsPath);
      await syncDirectory(path.dirname(settingsPath));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async function syncDirectory(directoryPath: string): Promise<void> {
    try {
      const handle = await fs.open(directoryPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is unavailable on some platforms; the file rename remains atomic.
    }
  }

  async function update(mutator: (settings: AppSettings) => void): Promise<void> {
    const result = writes.then(async () => {
      const settings = await read();
      mutator(settings);
      await write(settings);
    }, async () => {
      const settings = await read();
      mutator(settings);
      await write(settings);
    });
    writes = result.then(() => undefined, () => undefined);
    await result;
  }

  return {
    async getLastFolder(): Promise<string | null> {
      await writes;
      return (await read()).lastFolderPath;
    },

    async setLastFolder(folderPath: string | null): Promise<void> {
      await update((settings) => { settings.lastFolderPath = folderPath; });
    },

    async getLastCatalogId(): Promise<CatalogId | null> {
      await writes;
      return (await read()).lastCatalogId;
    },

    async setLastCatalogId(catalogId: CatalogId | null): Promise<void> {
      await update((settings) => { settings.lastCatalogId = catalogId; });
    },

    async getExportOptions(): Promise<ExportOptionsSettings> {
      await writes;
      return (await read()).exportOptions;
    },

    async setExportOptions(options: ExportOptionsSettingsInput): Promise<void> {
      await update((settings) => {
        settings.exportOptions = normalizeExportOptions({
          ...settings.exportOptions,
          ...(isRecord(options) ? options : {}),
        });
      });
    },

    async getDevelopClipboardGroups(): Promise<readonly DevelopClipboardGroup[]> {
      await writes;
      return (await read()).developClipboardGroups;
    },

    async setDevelopClipboardGroups(groups: unknown): Promise<void> {
      const parsed = parseDevelopClipboardGroups(groups);
      await update((settings) => {
        settings.developClipboardGroups = parsed;
      });
    },
  };
}
