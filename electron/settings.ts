import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EXPORT_SUFFIX,
  type ExportConflictBehavior,
  type ExportFormatId,
  type ExportSizeOptions,
} from "../lib/export/types";

export interface ExportOptionsSettings {
  format: ExportFormatId;
  quality: number;
  lossless: boolean;
  size: ExportSizeOptions;
  suffix: string;
  conflict: ExportConflictBehavior;
}

export interface AppSettings {
  lastFolderPath: string | null;
  exportOptions: ExportOptionsSettings;
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
  exportOptions: DEFAULT_EXPORT_OPTIONS,
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
  return {
    lastFolderPath: typeof input.lastFolderPath === "string"
      ? input.lastFolderPath
      : null,
    exportOptions: normalizeExportOptions(input.exportOptions),
  };
}

export function createSettingsStore(userDataPath: string) {
  const settingsPath = path.join(userDataPath, "settings.json");

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
    await fs.writeFile(settingsPath, JSON.stringify(normalizeSettings(settings), null, 2), "utf8");
  }

  return {
    async getLastFolder(): Promise<string | null> {
      return (await read()).lastFolderPath;
    },

    async setLastFolder(folderPath: string | null): Promise<void> {
      const settings = await read();
      settings.lastFolderPath = folderPath;
      await write(settings);
    },

    async getExportOptions(): Promise<ExportOptionsSettings> {
      return (await read()).exportOptions;
    },

    async setExportOptions(options: ExportOptionsSettingsInput): Promise<void> {
      const settings = await read();
      settings.exportOptions = normalizeExportOptions({
        ...settings.exportOptions,
        ...(isRecord(options) ? options : {}),
      });
      await write(settings);
    },
  };
}
