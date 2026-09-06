"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LibraryEntry } from "@/lib/fs/types";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import { useLibraryStore } from "@/stores/library-store";
import {
  DEFAULT_EXPORT_PREFERENCES as DEFAULT_PREFERENCES,
  EXPORT_FORMAT_IDS,
} from "@/lib/export/types";
import type {
  ExportConflictBehavior,
  ExportDestinationRequest,
  ExportFormatDescriptor,
  ExportFileResult,
  ExportFormatId,
  ExportPreferences,
  ExportRevealCapability,
  ExportSizeOptions,
} from "@/lib/export/types";
import {
  mergeExportBatchSummaries,
  mergeResumedExportBatchSummaries,
  runExportBatch,
  validateExportEntries,
  virtualCopyFilenameSuffix,
  type ExportBatchSummary,
  type ExportPhase,
} from "@/lib/export/runner";
import { useDevelopJobStore } from "@/stores/develop-job-store";

interface ExportDialogProps {
  entries: LibraryEntry[];
  onClose: () => void;
}

type DialogState = "idle" | "running" | "done";

type PersistedExportOptions = Partial<ExportPreferences>;

function defaultSize(): ExportSizeOptions {
  return { mode: "original" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Export failed.";
}

function phaseLabel(phase: ExportPhase | null): string {
  switch (phase) {
    case "decode":
      return "Decoding";
    case "render":
      return "Rendering";
    case "encode":
      return "Preparing encode";
    case "write":
      return "Encoding and writing";
    default:
      return "Preparing";
  }
}

function mergeProgressRows(
  previous: readonly ExportFileResult[],
  retry: readonly ExportFileResult[],
): readonly ExportFileResult[] {
  const retryById = new Map(retry.map((result) => [result.entryId, result]));
  return previous.map((result) => retryById.get(result.entryId) ?? result);
}

function stateLabel(result: ExportFileResult): string {
  switch (result.state.kind) {
    case "queued": return "Queued";
    case "active": return phaseLabel(result.state.phase);
    case "completed": return result.state.warnings.length > 0 ? "Completed with warning" : "Completed";
    case "skipped": return "Skipped";
    case "cancelled": return "Cancelled";
    case "failed": return result.state.retryable ? "Failed, retryable" : "Failed";
    default: {
      const exhaustive: never = result.state;
      return exhaustive;
    }
  }
}

function validateSuffix(suffix: string): string | null {
  if (suffix.length > 200) {
    return "Filename suffix is too long.";
  }
  if (suffix.includes("\0") || suffix.includes("/") || suffix.includes("\\") || suffix.includes("..")) {
    return "Filename suffix cannot contain path separators or '..'.";
  }
  return null;
}

function validateSize(size: ExportSizeOptions): string | null {
  if (size.mode === "long-edge" || size.mode === "longEdge") {
    const longEdge = size.longEdge ?? size.pixels;
    if (typeof longEdge !== "number" || !Number.isInteger(longEdge) || longEdge < 1) {
      return "Long edge must be a positive whole number.";
    }
  }
  if (size.mode === "fit") {
    if (!Number.isInteger(size.width) || Number(size.width) < 1) {
      return "Fit width must be a positive whole number.";
    }
    if (!Number.isInteger(size.height) || Number(size.height) < 1) {
      return "Fit height must be a positive whole number.";
    }
  }
  return null;
}

function isFormatId(value: unknown): value is ExportFormatId {
  return typeof value === "string" && (EXPORT_FORMAT_IDS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function normalizeSize(value: unknown): ExportSizeOptions {
  const record = asRecord(value);
  if (!record) {
    return defaultSize();
  }

  if (record.mode === "long-edge" || record.mode === "longEdge") {
    const longEdge = record.longEdge ?? record.pixels;
    if (Number.isInteger(longEdge) && Number(longEdge) > 0) {
      return {
        mode: "long-edge",
        longEdge: Number(longEdge),
        neverUpscale: record.neverUpscale !== false,
      };
    }
  }

  if (record.mode === "fit") {
    const width = record.width;
    const height = record.height;
    if (
      Number.isInteger(width) && Number(width) > 0 &&
      Number.isInteger(height) && Number(height) > 0
    ) {
      return {
        mode: "fit",
        width: Number(width),
        height: Number(height),
        neverUpscale: record.neverUpscale !== false,
      };
    }
  }

  return defaultSize();
}

function normalizePreferences(
  persisted: PersistedExportOptions | null,
  available: ExportFormatDescriptor[],
): ExportPreferences {
  const next: ExportPreferences = {
    ...DEFAULT_PREFERENCES,
    size: defaultSize(),
  };
  if (!persisted) {
    const first = available[0];
    if (first) {
      next.format = first.id;
      next.quality = first.defaultQuality ?? next.quality;
    }
    return next;
  }

  if (
    isFormatId(persisted.format) &&
    available.some((candidate) => candidate.id === persisted.format)
  ) {
    next.format = persisted.format;
  } else if (available[0]) {
    next.format = available[0].id;
  }

  const selected = available.find((candidate) => candidate.id === next.format);
  if (
    typeof persisted.quality === "number" &&
    Number.isInteger(persisted.quality) &&
    persisted.quality >= 1 &&
    persisted.quality <= 100
  ) {
    next.quality = persisted.quality;
  } else {
    next.quality = selected?.defaultQuality ?? next.quality;
  }
  if (typeof persisted.lossless === "boolean") {
    next.lossless = persisted.lossless && Boolean(selected?.supportsLossless);
  }
  next.metadata = persisted.metadata === "none" || persisted.metadata === "copyright" ? persisted.metadata : "all";
  next.includeLocation = persisted.includeLocation === true;
  next.size = normalizeSize(persisted.size);
  if (typeof persisted.suffix === "string" && !validateSuffix(persisted.suffix)) {
    next.suffix = persisted.suffix;
  }
  if (
    persisted.conflict === "rename" ||
    persisted.conflict === "skip" ||
    persisted.conflict === "replace"
  ) {
    next.conflict = persisted.conflict;
  }
  return next;
}

function safeSuggestedFilename(
  entry: LibraryEntry | undefined,
  suffix: string,
  format: ExportFormatDescriptor,
): string {
  const source = entry?.name.replace(/\.[^.]+$/, "") ?? "darkroom-export";
  const base = source
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.\./g, "_")
    .trim() || "darkroom-export";
  const safeSuffix = suffix
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.\./g, "_");
  const filenameSuffix = entry
    ? virtualCopyFilenameSuffix(entry, safeSuffix) ?? safeSuffix
    : safeSuffix;
  return `${base}${filenameSuffix}.${format.extensions[0] ?? "jpg"}`;
}

function freezeExportEntry(entry: LibraryEntry): LibraryEntry {
  return { ...entry, formatAvailability: { ...entry.formatAvailability } };
}

export function ExportDialog({ entries, onClose }: ExportDialogProps) {
  const metadata = useLibraryStore((state) => state.entryMetadata);
  const metadataOverrides = useLibraryStore((state) => state.libraryWorkspace.metadataOverridesByEntryId);
  const [formats, setFormats] = useState<ExportFormatDescriptor[]>([]);
  const [format, setFormat] = useState<ExportFormatId>(DEFAULT_PREFERENCES.format);
  const [quality, setQuality] = useState(DEFAULT_PREFERENCES.quality);
  const [lossless, setLossless] = useState(DEFAULT_PREFERENCES.lossless);
  const [size, setSize] = useState<ExportSizeOptions>(defaultSize);
  const [metadataMode, setMetadataMode] = useState<"all" | "copyright" | "none">("all");
  const [includeLocation, setIncludeLocation] = useState(false);
  const [suffix, setSuffix] = useState(DEFAULT_PREFERENCES.suffix);
  const [conflict, setConflict] = useState<ExportConflictBehavior>(DEFAULT_PREFERENCES.conflict);
  const [dialogState, setDialogState] = useState<DialogState>("idle");
  const [formatsLoading, setFormatsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ExportPhase | null>(null);
  const [currentEntry, setCurrentEntry] = useState<LibraryEntry | null>(null);
  const [liveResults, setLiveResults] = useState<readonly ExportFileResult[]>([]);
  const [summary, setSummary] = useState<ExportBatchSummary | null>(null);
  const [prototypeAcknowledged, setPrototypeAcknowledged] = useState(false);
  const cancelledRef = useRef(false);
  const inFlightRef = useRef(false);
  const frozenEntriesRef = useRef<readonly LibraryEntry[] | null>(null);
  const jobs = useDevelopJobStore((state) => state.jobs);
  const jobsHydrated = useDevelopJobStore((state) => state.hydrated);
  const jobsError = useDevelopJobStore((state) => state.error);
  const initializeJobs = useDevelopJobStore((state) => state.initialize);
  const entryIds = useMemo(() => new Set<string>(entries.map((entry) => `${entry.catalogId}\0${entry.id}`)), [entries]);
  const unappliedPrototypeJobs = useMemo(() => jobs.filter((job) =>
    job.status === "accepted" && job.request.kind !== "depth" &&
    entryIds.has(`${job.request.source.catalogId}\0${job.request.source.entryId}`)
  ), [entryIds, jobs]);

  const selectedFormat = useMemo(
    () => formats.find((candidate) => candidate.id === format) ?? null,
    [formats, format],
  );

  useEffect(() => {
    return initializeJobs();
  }, [initializeJobs]);

  useEffect(() => {
    if (!isElectronApp()) {
      return;
    }

    let active = true;
    const api = getDarkroomAPI();
    void Promise.all([
      api.getExportFormats(),
      api.getExportOptions(),
    ])
      .then(([available, persisted]) => {
        if (!active) {
          return;
        }
        setFormats(available);
        const next = normalizePreferences(persisted, available);
        setFormat(next.format);
        setQuality(next.quality);
        setLossless(next.lossless);
        setSize(next.size);
        setMetadataMode(next.metadata ?? "all");
        setIncludeLocation(next.includeLocation === true);
        setSuffix(next.suffix);
        setConflict(next.conflict);
      })
      .catch((loadError) => {
        if (active) {
          setError(errorMessage(loadError));
        }
      })
      .finally(() => {
        if (active) {
          setFormatsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (dialogState === "running") {
        // The current file is allowed to finish; the runner checks this
        // before starting the next file and leaves the dialog mounted.
        cancelledRef.current = true;
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogState, onClose]);

  const close = useCallback(() => {
    if (dialogState === "running") {
      return;
    }
    onClose();
  }, [dialogState, onClose]);

  const executeExport = useCallback(async (
    selectedEntries: readonly LibraryEntry[],
    previous: ExportBatchSummary | null,
    mode: "start" | "retry" | "resume",
  ) => {
    if (!selectedFormat || inFlightRef.current) return;
    inFlightRef.current = true;
    const frozenEntries = selectedEntries.map(freezeExportEntry);
    try {
      validateExportEntries(frozenEntries);
    } catch (validationError) {
      setError(errorMessage(validationError));
      inFlightRef.current = false;
      return;
    }
    if (mode === "start") frozenEntriesRef.current = frozenEntries;
    setError(null);
    if (!previous) setSummary(null);
    setDialogState("running");
    setCurrentEntry(null);
    setPhase(null);
    setLiveResults(previous?.results ?? []);
    cancelledRef.current = false;

    try {
      const api = getDarkroomAPI();
      const destinationRequest: ExportDestinationRequest = {
        catalogId: frozenEntries[0]!.catalogId,
        sessionId: frozenEntries[0]!.sessionId,
        assetIds: [...new Set(frozenEntries.map((entry) => entry.assetId))],
        count: frozenEntries.length,
        format: selectedFormat.id,
        suggestedFilename: safeSuggestedFilename(frozenEntries[0], suffix, selectedFormat),
      };
      const destination = await api.chooseExportDestination(destinationRequest);
      if (!destination) {
        setDialogState(previous ? "done" : "idle");
        return;
      }

      const persisted: ExportPreferences = {
        format,
        quality,
        lossless,
        size,
        suffix,
        conflict,
        metadata: metadataMode,
        includeLocation,
      };
      await api.setExportOptions(persisted).catch(() => undefined);

      const result = await runExportBatch({
        entries: frozenEntries,
        metadata,
        metadataOverrides,
        destinationToken: destination.token,
        options: {
          format,
          size,
          quality: selectedFormat.supportsQuality ? quality : undefined,
          lossless: selectedFormat.supportsLossless ? lossless : undefined,
          suffix,
          conflict,
          metadata: metadataMode,
          includeLocation,
        },
        onProgress: ({ phase: nextPhase, entry, results }) => {
          setPhase(nextPhase);
          setCurrentEntry(entry);
          setLiveResults(previous ? mergeProgressRows(previous.results, results) : results);
        },
        sourceMetadata: Object.fromEntries(Object.entries(useLibraryStore.getState().libraryWorkspace.analysisByEntryId).map(([id, analysis]) => [id, analysis.source])),
        isCancelled: () => cancelledRef.current,
      });
      const nextSummary = previous
        ? mode === "resume"
          ? mergeResumedExportBatchSummaries(previous, result)
          : mergeExportBatchSummaries(previous, result)
        : result;
      setSummary(nextSummary);
      setLiveResults(nextSummary.results);
      setDialogState("done");
    } catch (exportError) {
      const message = errorMessage(exportError);
      const failed: ExportBatchSummary = {
        results: frozenEntries.map((entry) => ({
          entryId: entry.id,
          sourceName: entry.name,
          state: { kind: "failed", error: message, retryable: true },
        })),
        exported: 0,
        skipped: 0,
        failed: frozenEntries.length,
        cancelled: 0,
        warnings: [],
        cancellationRequested: cancelledRef.current,
        finalizationError: message,
        revealCapability: null,
        lastOutputPath: null,
      };
      let complete = failed;
      if (previous) {
        try {
          complete = mode === "resume"
            ? mergeResumedExportBatchSummaries(previous, failed)
            : mergeExportBatchSummaries(previous, failed);
        } catch {
          complete = previous;
        }
      }
      setSummary(complete);
      setLiveResults(complete.results);
      setError(message);
      setDialogState("done");
    } finally {
      inFlightRef.current = false;
    }
  }, [
    metadataMode,
    includeLocation,
    conflict,
    format,
    lossless,
    metadata,
    metadataOverrides,
    quality,
    selectedFormat,
    size,
    suffix,
  ]);

  const startExport = useCallback(async () => {
    if (!selectedFormat || entries.length === 0) return;
    const sizeError = validateSize(size);
    const suffixError = validateSuffix(suffix);
    if (sizeError || suffixError) {
      setError(sizeError ?? suffixError);
      return;
    }
    if (
      selectedFormat.supportsQuality &&
      (!Number.isInteger(quality) || quality < 1 || quality > 100)
    ) {
      setError("Quality must be a whole number from 1 to 100.");
      return;
    }
    await executeExport(entries, null, "start");
  }, [entries, executeExport, quality, selectedFormat, size, suffix]);

  const retryFailed = useCallback(async () => {
    if (!summary) return;
    const retryableIds = new Set(summary.results.flatMap((result) =>
      result.state.kind === "failed" && result.state.retryable ? [result.entryId] : [],
    ));
    const frozenEntries = frozenEntriesRef.current ?? [];
    const retryEntries = frozenEntries.filter((entry) => retryableIds.has(entry.id));
    if (retryEntries.length !== retryableIds.size) {
      setError("A failed photo is no longer in the frozen export selection.");
      return;
    }
    await executeExport(retryEntries, summary, "retry");
  }, [executeExport, summary]);

  const resumeCancelled = useCallback(async () => {
    if (!summary) return;
    const cancelledIds = new Set(summary.results.flatMap((result) =>
      result.state.kind === "cancelled" && result.state.reason === "not-started" ? [result.entryId] : [],
    ));
    const frozenEntries = frozenEntriesRef.current ?? [];
    const resumeEntries = frozenEntries.filter((entry) => cancelledIds.has(entry.id));
    if (resumeEntries.length !== cancelledIds.size) {
      setError("A cancelled photo is missing from the frozen export selection.");
      return;
    }
    await executeExport(resumeEntries, summary, "resume");
  }, [executeExport, summary]);

  const showInFolder = useCallback(() => {
    const capability: ExportRevealCapability | null = summary?.revealCapability ?? null;
    if (!capability) {
      return;
    }
    void getDarkroomAPI()
      .showInFolder(capability)
      .catch((showError: unknown) => setError(errorMessage(showError)));
  }, [summary]);

  const progressFraction = useMemo(() => {
    const terminal = liveResults.filter((result) =>
      result.state.kind !== "queued" && result.state.kind !== "active",
    ).length;
    const phaseFraction = phase === "decode"
      ? 0.15
      : phase === "render"
        ? 0.55
        : phase === "encode"
          ? 0.75
          : phase === "write"
            ? 0.9
            : 0;
    return Math.min(
      1,
      (terminal + phaseFraction) / Math.max(1, liveResults.length),
    );
  }, [liveResults, phase]);

  const content = (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#0a0908]/62 p-4" role="presentation">
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-xl border border-lr-border bg-lr-panel-raised shadow-[0_32px_64px_rgba(0,0,0,.6)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
      >
        <div className="flex items-center justify-between border-b border-lr-border-subtle px-[18px] py-4">
          <div>
            <h2 id="export-dialog-title" className="text-[15px] font-semibold tracking-[-0.01em] text-lr-text">
              Export {entries.length} photo{entries.length === 1 ? "" : "s"}
            </h2>
            <p className="mt-0.5 text-[11px] text-lr-text-dim">
              Developed pixels · destination chosen on start
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={dialogState === "running"}
            className="rounded px-2 py-1 text-lg leading-none text-lr-text-dim transition hover:bg-lr-panel-raised hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Close export dialog"
          >
            ×
          </button>
        </div>

        {dialogState === "idle" ? (
          <div>
            <div className="grid grid-cols-2 gap-x-3.5 gap-y-3 p-[18px]">
              {!isElectronApp() ? (
                <p className="col-span-2 rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                  Export is available in the Darkroom desktop app only.
                </p>
              ) : null}
              <Field label="Format">
                <select
                  value={format}
                  disabled={formatsLoading || formats.length === 0}
                  onChange={(event) => {
                    const next = event.target.value as ExportFormatId;
                    const descriptor = formats.find((item) => item.id === next);
                    setFormat(next);
                    setLossless(false);
                    if (descriptor?.defaultQuality) {
                      setQuality(descriptor.defaultQuality);
                    }
                  }}
                  className="control"
                >
                  {formats.length === 0 ? <option>Loading formats…</option> : null}
                  {formats.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Size">
                <select
                  value={size.mode}
                  onChange={(event) => {
                    const mode = event.target.value as ExportSizeOptions["mode"];
                    setSize(mode === "long-edge"
                      ? { mode, longEdge: 2048, neverUpscale: true }
                      : mode === "fit"
                        ? { mode, width: 2048, height: 2048, neverUpscale: true }
                        : defaultSize());
                  }}
                  className="control"
                >
                  <option value="original">Original</option>
                  <option value="long-edge">Long edge</option>
                  <option value="fit">Fit within</option>
                </select>
              </Field>
              {selectedFormat?.supportsQuality ? (
                <Field label={`Quality · ${quality}`}>
                  <div className="flex h-[34px] items-center">
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={quality}
                      onChange={(event) => setQuality(Number(event.target.value))}
                      className="h-1 w-full cursor-pointer accent-lr-accent"
                    />
                  </div>
                </Field>
              ) : <div />}
              {size.mode === "long-edge" ? (
                <Field label="Long edge (px)">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={size.longEdge ?? ""}
                    onChange={(event) => setSize({ ...size, longEdge: Number(event.target.value) })}
                    className="control font-mono"
                  />
                </Field>
              ) : null}
              {size.mode === "fit" ? (
                <>
                  <Field label="Width (px)">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={size.width ?? ""}
                      onChange={(event) => setSize({ ...size, width: Number(event.target.value) })}
                      className="control font-mono"
                    />
                  </Field>
                  <Field label="Height (px)">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={size.height ?? ""}
                      onChange={(event) => setSize({ ...size, height: Number(event.target.value) })}
                      className="control font-mono"
                    />
                  </Field>
                </>
              ) : null}
              {selectedFormat?.supportsLossless ? (
                <label className="col-span-2 flex items-center gap-2 text-xs text-lr-text-muted">
                  <input
                    type="checkbox"
                    checked={lossless}
                    onChange={(event) => setLossless(event.target.checked)}
                    className="accent-lr-accent"
                  />
                  WebP lossless
                </label>
              ) : null}
              <p className="col-span-2 text-xs text-lr-text-muted">8-bit sRGB with an embedded color profile. JPEG quality 90 is a good everyday starting point.</p>
              <Field label="Metadata">
                <select className="control" value={metadataMode} onChange={(event) => setMetadataMode(event.target.value as "all" | "copyright" | "none")}>
                  <option value="all">Camera and description</option><option value="copyright">Copyright only</option><option value="none">None</option>
                </select>
              </Field>
              <label className="flex items-center gap-2 text-xs text-lr-text-muted"><input type="checkbox" disabled={metadataMode !== "all"} checked={includeLocation} onChange={(event) => setIncludeLocation(event.target.checked)} />Include GPS location</label>
              <Field label="Filename suffix">
                <input
                  type="text"
                  value={suffix}
                  onChange={(event) => setSuffix(event.target.value)}
                  className="control font-mono"
                  spellCheck={false}
                />
              </Field>
              <Field label="Existing files">
                <select
                  value={conflict}
                  onChange={(event) => setConflict(event.target.value as ExportConflictBehavior)}
                  className="control"
                >
                  <option value="rename">Rename with -2, -3…</option>
                  <option value="skip">Skip</option>
                  <option value="replace">Replace</option>
                </select>
              </Field>
              {size.mode !== "original" ? (
                <label className="col-span-2 flex items-center gap-2 border-t border-lr-border-subtle pt-3.5 text-xs text-lr-text-muted">
                  <input
                    type="checkbox"
                    checked={size.neverUpscale !== false}
                    onChange={(event) => setSize({ ...size, neverUpscale: event.target.checked })}
                    className="accent-lr-accent"
                  />
                  Never upscale
                </label>
              ) : null}
              {unappliedPrototypeJobs.length > 0 ? (
                <label className="col-span-2 rounded border border-amber-700/40 bg-amber-950/20 p-3 text-[11px] leading-4 text-amber-200">
                  <span className="block font-semibold">Prototype output is not applied to exported pixels</span>
                  <span className="mt-1 block">{unappliedPrototypeJobs.length} accepted Denoise, Raw Details, Super Resolution, or Mock Remove artifact{unappliedPrototypeJobs.length === 1 ? " is" : "s are"} still waiting for renderer integration.</span>
                  <span className="mt-2 flex items-start gap-2"><input type="checkbox" checked={prototypeAcknowledged} onChange={(event) => setPrototypeAcknowledged(event.target.checked)} className="mt-0.5 accent-lr-accent" />Export without those prototype results.</span>
                </label>
              ) : null}
              {!jobsHydrated ? <p className="col-span-2 text-[10px] text-lr-text-faint">Checking prototype jobs…</p> : null}
              {jobsError ? <p className="col-span-2 text-[10px] text-red-400">Prototype job status unavailable: {jobsError}</p> : null}
              {error ? <p className="col-span-2 text-xs text-red-400">{error}</p> : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-lr-border-subtle px-[18px] py-3.5">
              <button type="button" onClick={onClose} className="button-secondary">Cancel</button>
              <button
                type="button"
                onClick={() => void startExport()}
                disabled={formatsLoading || !selectedFormat || entries.length === 0 || !jobsHydrated || Boolean(jobsError) || (unappliedPrototypeJobs.length > 0 && !prototypeAcknowledged)}
                className="button-primary"
              >
                Start export
              </button>
            </div>
          </div>
        ) : null}

        {dialogState === "running" ? (
          <div className="space-y-3.5 px-[18px] py-3.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-lr-accent">{phaseLabel(phase)}</span>
              <span className="text-lr-text-muted">
                {liveResults.filter((result) => result.state.kind !== "queued" && result.state.kind !== "active").length} of {liveResults.length} terminal
              </span>
            </div>
            <div className="h-[5px] overflow-hidden rounded-full bg-lr-panel">
              <div className="h-full bg-lr-accent transition-all" style={{ width: `${progressFraction * 100}%` }} />
            </div>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-lr-text-muted">{currentEntry?.name ?? "Preparing export…"}</p>
              <button type="button" onClick={() => { cancelledRef.current = true; }} className="button-secondary">Stop export</button>
            </div>
            <div className="max-h-44 space-y-1 overflow-auto rounded border border-lr-border-subtle bg-lr-panel p-1.5">
              {liveResults.map((result) => <ExportResultRow key={result.entryId} result={result} />)}
            </div>
          </div>
        ) : null}

        {dialogState === "done" && summary ? (
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-4 gap-2 text-center">
              <SummaryStat label="Exported" value={summary.exported} tone="good" />
              <SummaryStat label="Skipped" value={summary.skipped} tone="muted" />
              <SummaryStat label="Failed" value={summary.failed} tone="bad" />
              <SummaryStat label="Cancelled" value={summary.cancelled} tone="muted" />
            </div>
            {summary.cancelled > 0 ? (
              <p className="text-xs text-amber-300">
                Export stopped. {summary.cancelled} file{summary.cancelled === 1 ? " was" : "s were"} not written.
              </p>
            ) : null}
            {summary.warnings.length > 0 ? (
              <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                <p className="font-medium">Completed with warnings</p>
                <p className="mt-1">{summary.warnings.join(" ")}</p>
              </div>
            ) : null}
            {summary.finalizationError ? (
              <p className="rounded border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-300">
                Destination finalization failed: {summary.finalizationError}
              </p>
            ) : null}
            <div className="max-h-52 space-y-1 overflow-auto rounded border border-lr-border-subtle bg-lr-panel p-1.5">
              {summary.results.map((result) => <ExportResultRow key={result.entryId} result={result} />)}
            </div>
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
            <div className="flex items-center justify-end gap-2">
              {summary.results.some((result) => result.state.kind === "cancelled" && result.state.reason === "not-started") ? (
                <button type="button" onClick={() => void resumeCancelled()} className="button-secondary">
                  Resume remaining
                </button>
              ) : null}
              {summary.results.some((result) =>
                result.state.kind === "failed" && result.state.retryable
              ) ? (
                <button type="button" onClick={() => void retryFailed()} className="button-secondary">
                  Retry failed
                </button>
              ) : null}
              {summary.revealCapability ? (
                <button type="button" onClick={showInFolder} className="button-secondary">Show in folder</button>
              ) : null}
              <button type="button" onClick={onClose} className="button-primary">Done</button>
            </div>
          </div>
        ) : null}
      </div>
      <style jsx>{`
        .control { width: 100%; height: 34px; border: 1px solid #3a3633; border-radius: 8px; background: #1b1917; padding: 0 10px; color: #ece7e3; font-size: 12px; outline: none; }
        .control:focus { border-color: #8fb8e0; }
        .button-primary, .button-secondary { height: 32px; border-radius: 8px; padding: 0 12px; font-size: 12px; transition: background .15s, color .15s; }
        .button-primary { background: #8fb8e0; color: #14202a; }
        .button-primary:hover { background: #a6c9ec; }
        .button-primary:disabled { cursor: not-allowed; opacity: .45; }
        .button-secondary { border: 1px solid #3a3633; color: #b9b1ab; }
        .button-secondary:hover { background: #2b2827; color: #ece7e3; }
      `}</style>
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(content, document.body);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-[11px] text-lr-text-dim">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ExportResultRow({ result }: { readonly result: ExportFileResult }) {
  const detail = result.state.kind === "completed"
    ? result.state.outputPath
    : result.state.kind === "skipped"
      ? result.state.reason
      : result.state.kind === "failed"
        ? result.state.error
        : result.state.kind === "cancelled"
          ? "Cancellation was requested before this file started."
          : null;
  const tone = result.state.kind === "completed"
    ? "text-green-400"
    : result.state.kind === "failed"
      ? "text-red-400"
      : result.state.kind === "active"
        ? "text-lr-accent"
        : "text-lr-text-dim";
  return (
    <div className="rounded px-2 py-1.5 hover:bg-lr-panel-raised">
      <div className="flex items-center gap-2 text-[10px]">
        <span className="min-w-0 flex-1 truncate font-mono text-lr-text-muted">{result.sourceName}</span>
        <span className={tone}>{stateLabel(result)}</span>
      </div>
      {detail ? <p className="mt-0.5 truncate text-[9px] text-lr-text-faint">{detail}</p> : null}
    </div>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone: "good" | "muted" | "bad" }) {
  const textClass = tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-lr-text-muted";
  return (
    <div className="rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-2">
      <div className={`text-lg font-semibold ${textClass}`}>{value}</div>
      <div className="text-[10px] text-lr-text-dim">{label}</div>
    </div>
  );
}
