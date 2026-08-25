import type { EntryMetadata } from "@/lib/catalog/types";
import {
  disposeDevelopImage,
  loadDevelopExportImage,
  loadDevelopInferenceImage,
  type DevelopImage,
} from "@/lib/cache/develop-image-cache";
import {
  FrozenV2Renderer,
} from "@/lib/develop/frozen-v2-backend";
import { resolveDevelopDocumentFromRepository } from "@/lib/develop/repository";
import {
  DevelopSessionCore,
  getActiveDevelopSession,
} from "@/lib/develop/session";
import type { CpuRenderResult } from "@/lib/develop/v3/cpu-backend";
import { sourceSignatureForEntry } from "@/lib/develop/source-transform";
import { serializeDevelopXmp, serializeMetadataXmp } from "@/lib/develop/xmp";
import type { MetadataOverrides } from "@/lib/metadata/types";
import { getDarkroomAPI } from "@/lib/fs/platform";
import type { LibraryEntry } from "@/lib/fs/types";
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
  metadataOverrides: Readonly<Record<string, MetadataOverrides>>;
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

export function virtualCopyFilenameSuffix(entry: LibraryEntry, suffix: string): string | null {
  if (entry.entryKind === "original") return null;
  const name = entry.displayName
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${suffix}-${name || "copy"}-${entry.id.slice(0, 8)}`;
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
      developUpdatedAt: 0,
      updatedAt: entry.lastModified,
    }
  );
}

async function resolveSession(
  entry: LibraryEntry,
  metadata: EntryMetadata,
): Promise<DevelopSessionCore> {
  const activeSession = getActiveDevelopSession(entry.catalogId, entry.id);
  if (activeSession) return activeSession;
  const process = await resolveDevelopDocumentFromRepository(entry, metadata);
  return new DevelopSessionCore(entry.catalogId, entry.id, process);
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Export failed.";
}

function v3RenderError(result: Exclude<CpuRenderResult, { readonly kind: "rendered" }>): string {
  if (result.kind === "cancelled") return "V3 export was cancelled.";
  if (result.kind === "blocked") {
    const diagnostic = result.diagnostics[0];
    return "reason" in diagnostic
      ? `V3 export is blocked: ${diagnostic.reason}`
      : `V3 export is blocked: ${diagnostic.kind}.`;
  }
  const issue = result.issues[0];
  return "reason" in issue
    ? `V3 export request is invalid: ${issue.reason}`
    : `V3 export request is invalid: ${issue.kind}.`;
}

function hasCompleteSourcePixels(image: DevelopImage): boolean {
  const expected = image.sourceWidth * image.sourceHeight * image.colors;
  return Number.isSafeInteger(expected) && expected > 0 && image.rgb.length === expected;
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
    metadataOverrides,
    destinationToken,
    options,
    onProgress,
    isCancelled = () => false,
  } = runnerOptions;
  const api = getDarkroomAPI();
  const results: ExportFileResult[] = [];
  const warnings: string[] = [];
  let renderer: FrozenV2Renderer | null = null;
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
        const developSession = await resolveSession(entry, entryMetadata);
        const developSnapshot = developSession.snapshot();
        if (developSnapshot.processKind === "read-only-newer") {
          throw new Error(developSnapshot.readOnly.message);
        }
        const descriptive: MetadataOverrides = {
          ...(entryMetadata.title === null ? {} : { title: { kind: "set", value: entryMetadata.title } }),
          ...(entryMetadata.caption === null ? {} : { caption: { kind: "set", value: entryMetadata.caption } }),
          ...(entryMetadata.copyright === null ? {} : { copyright: { kind: "set", value: entryMetadata.copyright } }),
          ...(entryMetadata.keywords.length === 0 ? {} : { keywords: { kind: "set", value: entryMetadata.keywords } }),
          ...metadataOverrides[entry.id],
        };
        exportImage = await loadDevelopExportImage(entry, {
          rawColorMode: developSnapshot.processKind === "v3"
            ? "libraw-camera-matrix"
            : "decoder-rendered",
        });

        progress("rendering");
        let renderSnapshot = developSession.snapshot();
        if (renderSnapshot.processKind === "v3" && !hasCompleteSourcePixels(exportImage)) {
          const pixelImage = await loadDevelopInferenceImage(entry);
          exportImage = {
            ...pixelImage,
            blob: exportImage.blob,
            objectUrl: exportImage.objectUrl,
          };
          renderSnapshot = developSession.snapshot();
        }
        if (renderSnapshot.processKind === "read-only-newer") {
          throw new Error(renderSnapshot.readOnly.message);
        }
        const developXmp = serializeDevelopXmp(renderSnapshot.document, entryMetadata, null);
        const outputXmp = serializeMetadataXmp(developXmp, descriptive);
        if (renderSnapshot.processKind === "v2") {
          renderer ??= new FrozenV2Renderer(document.createElement("canvas"), true);
          pixels = await developSession.render({
            kind: "export",
            image: exportImage,
            sourceSignature: sourceSignatureForEntry(entry),
            size: toEncodeSize(options.size),
            renderer,
          });
        } else {
          const rendered = await developSession.render({
            kind: "v3-export",
            entry,
            image: exportImage,
            size: options.size,
            format: options.format,
            quality: options.quality,
            lossless: options.lossless,
            cancellation: {
              isCancelled,
              reason: () => isCancelled() ? "The export was cancelled." : null,
            },
          });
          if (rendered.kind !== "rendered") throw new Error(v3RenderError(rendered));
          const embeddedPreview = exportImage.metadata.decoderProvenance === "embedded";
          pixels = {
            pixels: rendered.pixels.pixels,
            width: rendered.dimensions.width,
            height: rendered.dimensions.height,
            provenance: embeddedPreview ? "embedded-preview" : "decoded",
            embeddedPreview,
            ...(embeddedPreview
              ? { warning: "RAW export uses its embedded preview." }
              : {}),
          };
        }

        progress("encoding");
        const encodeOptions = toEncodeOptions(options);
        const copySuffix = virtualCopyFilenameSuffix(entry, encodeOptions.suffix ?? DEFAULT_EXPORT_SUFFIX);
        const encoded = await api.encodeAndSaveExport(
          destinationToken,
          sourceBasename(entry),
          {
            pixels: pixels.pixels,
            width: pixels.width,
            height: pixels.height,
          },
          {
            ...encodeOptions,
            ...(copySuffix === null ? {} : { filenameSuffix: copySuffix }),
            size: { mode: "original" },
            xmp: outputXmp,
          },
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
