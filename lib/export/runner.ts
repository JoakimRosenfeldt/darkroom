import type { EntryMetadata } from "@/lib/catalog/types";
import {
  disposeDevelopImage,
  loadDevelopExportImage,
  type DevelopImage,
} from "@/lib/cache/develop-image-cache";
import {
  DevelopRenderer,
  renderDevelopExport,
} from "@/lib/develop/renderer";
import { readDevelopSidecar } from "@/lib/develop/sidecar";
import { getDarkroomAPI } from "@/lib/fs/platform";
import type { LibraryEntry } from "@/lib/fs/types";
import { useDevelopStore } from "@/stores/develop-store";
import { resolveDevelopSettings } from "./settings";
import { DEFAULT_EXPORT_SUFFIX } from "./types";
import type {
  ExportConflictBehavior,
  ExportFileResult,
  ExportFormatId,
  ExportJobOptions,
  ExportRevealCapability,
  ExportSizeOptions,
  RawExportRenderResult,
} from "./types";

export type ExportPhase = "decoding" | "rendering" | "encoding";

export interface ExportProgress {
  phase: ExportPhase;
  index: number;
  total: number;
  entry: LibraryEntry;
}

export interface ExportBatchSummary {
  results: ExportFileResult[];
  exported: number;
  skipped: number;
  failed: number;
  warnings: string[];
  cancelled: boolean;
  revealCapability: ExportRevealCapability | null;
  lastOutputPath: string | null;
}

export interface ExportRunnerOptions {
  entries: LibraryEntry[];
  metadata: Record<string, EntryMetadata>;
  rootPath: string | null;
  destinationToken: string;
  options: Omit<ExportJobOptions, "destinationToken">;
  onProgress?: (progress: ExportProgress) => void;
  isCancelled?: () => boolean;
}

interface EncodeOptions {
  format: ExportFormatId;
  size:
    | { mode: "original" }
    | { mode: "long-edge"; pixels: number; neverUpscale?: boolean }
    | { mode: "fit"; width: number; height: number; neverUpscale?: boolean };
  quality?: number;
  lossless?: boolean;
  suffix: string;
  conflict: ExportConflictBehavior;
}

function toEncodeSize(size: ExportSizeOptions): EncodeOptions["size"] {
  if (size.mode === "long-edge" || size.mode === "longEdge") {
    const pixels = Number(size.longEdge ?? size.pixels);
    if (!Number.isInteger(pixels) || pixels < 1) {
      throw new Error("Long edge must be a positive whole number.");
    }
    return {
      mode: "long-edge",
      pixels,
      neverUpscale: size.neverUpscale,
    };
  }
  if (size.mode === "fit") {
    if (!Number.isInteger(size.width) || !Number.isInteger(size.height)) {
      throw new Error("Fit dimensions must be positive whole numbers.");
    }
    return {
      mode: "fit",
      width: size.width,
      height: size.height,
      neverUpscale: size.neverUpscale,
    };
  }
  return { mode: "original" };
}

function sourceBasename(entry: LibraryEntry): string {
  return entry.name.replace(/\.[^.]+$/, "");
}

function getMetadata(
  metadata: Record<string, EntryMetadata>,
  entry: LibraryEntry,
): EntryMetadata {
  return (
    metadata[entry.id] ?? {
      pick: "none",
      rating: 0,
      colorLabel: null,
      updatedAt: entry.lastModified,
    }
  );
}

async function resolveSettings(
  entry: LibraryEntry,
  metadata: EntryMetadata,
  rootPath: string | null,
): Promise<ReturnType<typeof resolveDevelopSettings>> {
  const current = useDevelopStore.getState();
  if (current.activeEntryId === entry.id) {
    return structuredClone(current.settings);
  }

  const sidecar = rootPath
    ? await readDevelopSidecar(rootPath, entry.relativePath)
    : null;
  return resolveDevelopSettings(sidecar, metadata);
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Export failed.";
}

function toEncodeOptions(
  options: ExportRunnerOptions["options"],
): EncodeOptions {
  return {
    format: options.format,
    size: toEncodeSize(options.size),
    quality: options.quality,
    lossless: options.lossless,
    suffix: options.suffix ?? DEFAULT_EXPORT_SUFFIX,
    conflict: options.conflict,
  };
}

export async function runExportBatch(
  runnerOptions: ExportRunnerOptions,
): Promise<ExportBatchSummary> {
  const {
    entries,
    metadata,
    rootPath,
    destinationToken,
    options,
    onProgress,
    isCancelled = () => false,
  } = runnerOptions;
  const api = getDarkroomAPI();
  const results: ExportFileResult[] = [];
  const warnings: string[] = [];
  let renderer: DevelopRenderer | null = null;
  let lastOutputPath: string | null = null;
  let cancelled = false;
  let revealCapability: ExportRevealCapability | null = null;

  try {
    for (let index = 0; index < entries.length; index += 1) {
      if (isCancelled()) {
        cancelled = true;
        break;
      }

      const entry = entries[index]!;
      const progress = (phase: ExportPhase) =>
        onProgress?.({ phase, index, total: entries.length, entry });
      progress("decoding");

      let exportImage: DevelopImage | null = null;
      let pixels: RawExportRenderResult | null = null;
      try {
        const entryMetadata = getMetadata(metadata, entry);
        const settings = await resolveSettings(entry, entryMetadata, rootPath);
        exportImage = await loadDevelopExportImage(entry);

        progress("rendering");
        renderer ??= new DevelopRenderer(document.createElement("canvas"), true);
        pixels = await renderDevelopExport(exportImage, settings, renderer);

        progress("encoding");
        const encoded = await api.encodeAndSaveExport(
          destinationToken,
          sourceBasename(entry),
          {
            pixels: pixels.pixels,
            width: pixels.width,
            height: pixels.height,
          },
          toEncodeOptions(options),
        );
        if (encoded.status === "exported") {
          lastOutputPath = encoded.path ?? lastOutputPath;
        }
        const embeddedWarning =
          "warning" in pixels && pixels.warning
            ? pixels.warning
            : undefined;
        const warning = embeddedWarning ?? encoded.warning;
        if (warning) {
          warnings.push(`${entry.name}: ${warning}`);
        }
        results.push({
          entryId: entry.id,
          sourceName: entry.name,
          outputName: encoded.path,
          status: encoded.status === "skipped" ? "skipped" : warning ? "warning" : "success",
          ...(warning ? { warning } : {}),
        });
      } catch (error) {
        results.push({
          entryId: entry.id,
          sourceName: entry.name,
          status: "error",
          error: asErrorMessage(error),
        });
      } finally {
        pixels = null;
        if (exportImage) {
          disposeDevelopImage(exportImage);
          exportImage = null;
        }
      }
    }
  } finally {
    try {
      renderer?.dispose();
    } finally {
      const finalized = await api.finalizeExport(destinationToken);
      revealCapability = finalized.revealToken;
      lastOutputPath = finalized.outputPath ?? lastOutputPath;
    }
  }

  return {
    results,
    exported: results.filter(
      (result) => result.status === "success" || result.status === "warning",
    ).length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "error").length,
    warnings,
    cancelled,
    revealCapability,
    lastOutputPath,
  };
}
