import type { EntryMetadata } from "@/lib/catalog/types";
import {
  disposeDevelopImage,
  loadDevelopExportImage,
  loadDevelopInferenceImage,
  type DevelopImage,
} from "@/lib/cache/develop-image-cache";
import { FrozenV2Renderer } from "@/lib/develop/frozen-v2-backend";
import { resolveDevelopDocumentFromRepository } from "@/lib/develop/repository";
import { DevelopSessionCore, getActiveDevelopSession } from "@/lib/develop/session";
import type { CpuRenderResult } from "@/lib/develop/v3/cpu-backend";
import { sourceSignatureForEntry } from "@/lib/develop/source-transform";
import { serializeDevelopXmp, serializeMetadataXmp } from "@/lib/develop/xmp";
import type { MetadataOverrides } from "@/lib/metadata/types";
import { getDarkroomAPI } from "@/lib/fs/platform";
import type { LibraryEntry } from "@/lib/fs/types";
import { DEFAULT_EXPORT_SUFFIX } from "./types";
import type {
  ExportActivePhase,
  ExportConflictBehavior,
  ExportFileResult,
  ExportFormatId,
  ExportItemState,
  ExportJobOptions,
  ExportRevealCapability,
  ExportSizeOptions,
  RawExportRenderResult,
} from "./types";

export type ExportPhase = ExportActivePhase;

export interface ExportProgress {
  readonly phase: ExportPhase | null;
  readonly index: number | null;
  readonly total: number;
  readonly entry: LibraryEntry | null;
  readonly results: readonly ExportFileResult[];
}

export interface ExportBatchSummary {
  readonly results: readonly ExportFileResult[];
  readonly exported: number;
  readonly skipped: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly warnings: readonly string[];
  readonly cancellationRequested: boolean;
  readonly finalizationError: string | null;
  readonly revealCapability: ExportRevealCapability | null;
  readonly lastOutputPath: string | null;
}

export interface ExportRunnerOptions {
  readonly entries: readonly LibraryEntry[];
  readonly metadata: Readonly<Record<string, EntryMetadata>>;
  readonly metadataOverrides: Readonly<Record<string, MetadataOverrides>>;
  readonly destinationToken: string;
  readonly options: Omit<ExportJobOptions, "destinationToken">;
  readonly onProgress?: (progress: ExportProgress) => void;
  readonly isCancelled?: () => boolean;
  readonly adapter?: ExportRunnerAdapter;
}

export type ExportEntryExecutionResult =
  | {
      readonly kind: "completed";
      readonly outputPath: string;
      readonly warnings: readonly string[];
    }
  | { readonly kind: "skipped"; readonly reason: string };

export interface ExportEntryExecutionInput {
  readonly entry: LibraryEntry;
  readonly metadata: Readonly<Record<string, EntryMetadata>>;
  readonly metadataOverrides: Readonly<Record<string, MetadataOverrides>>;
  readonly destinationToken: string;
  readonly options: Omit<ExportJobOptions, "destinationToken">;
  readonly setPhase: (phase: ExportPhase) => void;
}

export interface ExportRunnerAdapter {
  readonly executeEntry: (
    input: ExportEntryExecutionInput,
  ) => Promise<ExportEntryExecutionResult>;
  readonly finalizeDestination: (
    destinationToken: string,
  ) => Promise<{
    readonly revealToken: ExportRevealCapability | null;
    readonly outputPath: string | null;
  }>;
  readonly dispose?: () => void;
}

interface EncodeOptions {
  readonly format: ExportFormatId;
  readonly size:
    | { readonly mode: "original" }
    | {
        readonly mode: "long-edge";
        readonly pixels: number;
        readonly neverUpscale?: boolean;
      }
    | {
        readonly mode: "fit";
        readonly width: number;
        readonly height: number;
        readonly neverUpscale?: boolean;
      };
  readonly quality?: number;
  readonly lossless?: boolean;
  readonly suffix: string;
  readonly conflict: ExportConflictBehavior;
}

const PHASE_ORDER = {
  decode: 0,
  render: 1,
  encode: 2,
  write: 3,
} as const satisfies Record<ExportPhase, number>;

function toEncodeSize(size: ExportSizeOptions): EncodeOptions["size"] {
  if (size.mode === "long-edge" || size.mode === "longEdge") {
    const pixels = Number(size.longEdge ?? size.pixels);
    if (!Number.isInteger(pixels) || pixels < 1) {
      throw new Error("Long edge must be a positive whole number.");
    }
    return { mode: "long-edge", pixels, neverUpscale: size.neverUpscale };
  }
  if (size.mode === "fit") {
    if (
      !Number.isInteger(size.width) ||
      !Number.isInteger(size.height) ||
      size.width < 1 ||
      size.height < 1
    ) {
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

export function virtualCopyFilenameSuffix(
  entry: LibraryEntry,
  suffix: string,
): string | null {
  if (entry.entryKind === "original") return null;
  const name = entry.displayName
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${suffix}-${name || "copy"}-${entry.id.slice(0, 8)}`;
}

export function validateExportEntries(entries: readonly LibraryEntry[]): void {
  if (entries.length === 0) throw new Error("Choose at least one photo to export.");
  const entryIds = new Set<string>();
  const first = entries[0]!;
  for (const entry of entries) {
    if (entryIds.has(entry.id)) throw new Error(`Export selection repeats EntryId ${entry.id}.`);
    entryIds.add(entry.id);
    if (entry.catalogId !== first.catalogId || entry.sessionId !== first.sessionId) {
      throw new Error("Export selection must belong to one catalog session.");
    }
  }
}

function getMetadata(
  metadata: Readonly<Record<string, EntryMetadata>>,
  entry: LibraryEntry,
): EntryMetadata {
  return metadata[entry.id] ?? {
    pick: "none",
    rating: 0,
    colorLabel: null,
    developUpdatedAt: 0,
    updatedAt: entry.lastModified,
  };
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

function v3RenderError(
  result: Exclude<CpuRenderResult, { readonly kind: "rendered" }>,
): string {
  if (result.kind === "cancelled") return "V3 export stopped without producing pixels.";
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

function toEncodeOptions(options: ExportRunnerOptions["options"]): EncodeOptions {
  return {
    format: options.format,
    size: toEncodeSize(options.size),
    quality: options.quality,
    lossless: options.lossless,
    suffix: options.suffix ?? DEFAULT_EXPORT_SUFFIX,
    conflict: options.conflict,
  };
}

function createDefaultAdapter(): ExportRunnerAdapter {
  const api = getDarkroomAPI();
  let renderer: FrozenV2Renderer | null = null;
  return {
    async executeEntry(input) {
      const { entry, metadata, metadataOverrides, destinationToken, options, setPhase } = input;
      let exportImage: DevelopImage | null = null;
      try {
        const entryMetadata = getMetadata(metadata, entry);
        const developSession = await resolveSession(entry, entryMetadata);
        const developSnapshot = developSession.snapshot();
        if (developSnapshot.processKind === "read-only-newer") {
          throw new Error(developSnapshot.readOnly.message);
        }
        exportImage = await loadDevelopExportImage(entry, {
          rawColorMode: developSnapshot.processKind === "v3"
            ? "libraw-camera-matrix"
            : "decoder-rendered",
        });

        setPhase("render");
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

        let pixels: RawExportRenderResult;
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

        setPhase("encode");
        const descriptive: MetadataOverrides = {
          ...(entryMetadata.title === null
            ? {}
            : { title: { kind: "set" as const, value: entryMetadata.title } }),
          ...(entryMetadata.caption === null
            ? {}
            : { caption: { kind: "set" as const, value: entryMetadata.caption } }),
          ...(entryMetadata.copyright === null
            ? {}
            : { copyright: { kind: "set" as const, value: entryMetadata.copyright } }),
          ...(entryMetadata.keywords.length === 0
            ? {}
            : { keywords: { kind: "set" as const, value: entryMetadata.keywords } }),
          ...metadataOverrides[entry.id],
        };
        const developXmp = serializeDevelopXmp(renderSnapshot.document, entryMetadata, null);
        const outputXmp = serializeMetadataXmp(developXmp, descriptive);
        const encodeOptions = toEncodeOptions(options);
        const copySuffix = virtualCopyFilenameSuffix(entry, encodeOptions.suffix);

        setPhase("write");
        const encoded = await api.encodeAndSaveExport(
          destinationToken,
          sourceBasename(entry),
          { pixels: pixels.pixels, width: pixels.width, height: pixels.height },
          {
            ...encodeOptions,
            ...(copySuffix === null ? {} : { filenameSuffix: copySuffix }),
            size: { mode: "original" },
            xmp: outputXmp,
          },
        );
        if (encoded.status === "skipped") {
          return {
            kind: "skipped",
            reason: encoded.warning ?? "The destination file already exists.",
          };
        }
        if (!encoded.path) throw new Error("Native export completed without an output path.");
        const warnings = [pixels.warning, encoded.warning].filter(
          (warning): warning is string => typeof warning === "string" && warning.length > 0,
        );
        return { kind: "completed", outputPath: encoded.path, warnings };
      } finally {
        if (exportImage) disposeDevelopImage(exportImage);
      }
    },
    finalizeDestination: (destinationToken) => api.finalizeExport(destinationToken),
    dispose() {
      renderer?.dispose();
      renderer = null;
    },
  };
}

function initialResults(entries: readonly LibraryEntry[]): ExportFileResult[] {
  return entries.map((entry) => ({
    entryId: entry.id,
    sourceName: entry.name,
    state: { kind: "queued" },
  }));
}

function completedWarnings(results: readonly ExportFileResult[]): string[] {
  return results.flatMap((result) =>
    result.state.kind === "completed"
      ? result.state.warnings.map((warning) => `${result.sourceName}: ${warning}`)
      : [],
  );
}

function lastCompletedPath(results: readonly ExportFileResult[]): string | null {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const state = results[index]!.state;
    if (state.kind === "completed") return state.outputPath;
  }
  return null;
}

function summarize(input: {
  readonly results: readonly ExportFileResult[];
  readonly cancellationRequested: boolean;
  readonly finalizationError: string | null;
  readonly revealCapability: ExportRevealCapability | null;
  readonly finalizedOutputPath: string | null;
}): ExportBatchSummary {
  return {
    results: input.results,
    exported: input.results.filter((result) => result.state.kind === "completed").length,
    skipped: input.results.filter((result) => result.state.kind === "skipped").length,
    failed: input.results.filter((result) => result.state.kind === "failed").length,
    cancelled: input.results.filter((result) => result.state.kind === "cancelled").length,
    warnings: completedWarnings(input.results),
    cancellationRequested: input.cancellationRequested,
    finalizationError: input.finalizationError,
    revealCapability: input.revealCapability,
    lastOutputPath: input.finalizedOutputPath ?? lastCompletedPath(input.results),
  };
}

function failureIsRetryable(error: unknown, phase: ExportPhase): boolean {
  if (phase === "write") return true;
  const message = asErrorMessage(error).toLocaleLowerCase();
  return !/read-only|newer develop|is blocked|request is invalid|unsupported|exceeds the|does not match|incompatible/.test(message);
}

export async function runExportBatch(
  runnerOptions: ExportRunnerOptions,
): Promise<ExportBatchSummary> {
  const entries = [...runnerOptions.entries];
  validateExportEntries(entries);
  const isCancelled = runnerOptions.isCancelled ?? (() => false);
  const results = initialResults(entries);
  let adapter: ExportRunnerAdapter | null = null;
  let activeIndex: number | null = null;
  let activePhase: ExportPhase | null = null;
  let finalizationError: string | null = null;
  let revealCapability: ExportRevealCapability | null = null;
  let finalizedOutputPath: string | null = null;
  let progressError: string | null = null;

  const publish = () => {
    try {
      runnerOptions.onProgress?.({
        phase: activePhase,
        index: activeIndex,
        total: entries.length,
        entry: activeIndex === null ? null : entries[activeIndex]!,
        results: results.map((result) => ({ ...result, state: { ...result.state } })),
      });
    } catch (error) {
      progressError ??= asErrorMessage(error);
    }
  };
  const setState = (index: number, state: ExportItemState) => {
    results[index] = { ...results[index]!, state };
    publish();
  };

  try {
    adapter = runnerOptions.adapter ?? createDefaultAdapter();
    publish();
    for (let index = 0; index < entries.length; index += 1) {
      if (isCancelled()) break;
      const entry = entries[index]!;
      activeIndex = index;
      activePhase = "decode";
      setState(index, { kind: "active", phase: "decode" });
      try {
        const execution = await adapter.executeEntry({
          entry,
          metadata: runnerOptions.metadata,
          metadataOverrides: runnerOptions.metadataOverrides,
          destinationToken: runnerOptions.destinationToken,
          options: runnerOptions.options,
          setPhase(nextPhase) {
            if (PHASE_ORDER[nextPhase] < PHASE_ORDER[activePhase ?? "decode"]) {
              throw new Error("Export phase cannot move backwards.");
            }
            activePhase = nextPhase;
            setState(index, { kind: "active", phase: nextPhase });
          },
        });
        setState(index, execution.kind === "completed"
          ? {
              kind: "completed",
              outputPath: execution.outputPath,
              warnings: [...execution.warnings],
            }
          : { kind: "skipped", reason: execution.reason });
      } catch (error) {
        const phase = activePhase ?? "decode";
        setState(index, {
          kind: "failed",
          error: asErrorMessage(error),
          retryable: failureIsRetryable(error, phase),
        });
      } finally {
        activeIndex = null;
        activePhase = null;
      }
    }
    if (isCancelled()) {
      for (let index = 0; index < results.length; index += 1) {
        if (results[index]!.state.kind === "queued") {
          setState(index, { kind: "cancelled", reason: "not-started" });
        }
      }
    }
  } catch (error) {
    const message = asErrorMessage(error);
    for (let index = 0; index < results.length; index += 1) {
      if (results[index]!.state.kind === "queued" || results[index]!.state.kind === "active") {
        results[index] = {
          ...results[index]!,
          state: { kind: "failed", error: message, retryable: failureIsRetryable(error, activePhase ?? "decode") },
        };
      }
    }
  } finally {
    try {
      adapter?.dispose?.();
    } catch (error) {
      finalizationError = asErrorMessage(error);
    }
    try {
      if (adapter) {
        const finalized = await adapter.finalizeDestination(runnerOptions.destinationToken);
        revealCapability = finalized.revealToken;
        finalizedOutputPath = finalized.outputPath;
      }
    } catch (error) {
      const message = asErrorMessage(error);
      finalizationError = finalizationError ? `${finalizationError} ${message}` : message;
    }
  }

  activeIndex = null;
  activePhase = null;
  publish();
  if (progressError) {
    finalizationError = finalizationError ? `${finalizationError} ${progressError}` : progressError;
  }
  let cancellationRequested = false;
  try {
    cancellationRequested = isCancelled();
  } catch (error) {
    const message = asErrorMessage(error);
    finalizationError = finalizationError ? `${finalizationError} ${message}` : message;
  }
  return summarize({
    results,
    cancellationRequested,
    finalizationError,
    revealCapability,
    finalizedOutputPath,
  });
}

export function mergeExportBatchSummaries(
  previous: ExportBatchSummary,
  retry: ExportBatchSummary,
): ExportBatchSummary {
  const previousById = new Map(previous.results.map((result) => [result.entryId, result]));
  const retryById = new Map<string, ExportFileResult>();
  for (const result of retry.results) {
    if (retryById.has(result.entryId)) throw new Error(`Retry repeats EntryId ${result.entryId}.`);
    const prior = previousById.get(result.entryId);
    if (!prior || prior.state.kind !== "failed" || !prior.state.retryable) {
      throw new Error(`Retry may include only retryable failed EntryIds: ${result.entryId}.`);
    }
    retryById.set(result.entryId, result);
  }
  const merged = previous.results.map((result) => retryById.get(result.entryId) ?? result);
  return summarize({
    results: merged,
    cancellationRequested: retry.cancellationRequested,
    finalizationError: retry.finalizationError,
    revealCapability: retry.revealCapability ?? previous.revealCapability,
    finalizedOutputPath: retry.lastOutputPath ?? previous.lastOutputPath,
  });
}

export function mergeResumedExportBatchSummaries(
  previous: ExportBatchSummary,
  resumed: ExportBatchSummary,
): ExportBatchSummary {
  const previousById = new Map(previous.results.map((result) => [result.entryId, result]));
  const resumedById = new Map<string, ExportFileResult>();
  for (const result of resumed.results) {
    if (resumedById.has(result.entryId)) throw new Error(`Resume repeats EntryId ${result.entryId}.`);
    const prior = previousById.get(result.entryId);
    if (!prior || prior.state.kind !== "cancelled" || prior.state.reason !== "not-started") {
      throw new Error(`Resume may include only cancelled, not-started EntryIds: ${result.entryId}.`);
    }
    resumedById.set(result.entryId, result);
  }
  return summarize({
    results: previous.results.map((result) => resumedById.get(result.entryId) ?? result),
    cancellationRequested: resumed.cancellationRequested,
    finalizationError: resumed.finalizationError,
    revealCapability: resumed.revealCapability ?? previous.revealCapability,
    finalizedOutputPath: resumed.lastOutputPath ?? previous.lastOutputPath,
  });
}
