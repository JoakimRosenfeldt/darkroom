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
  ExportFormatId,
  ExportPreferences,
  ExportRevealCapability,
  ExportSizeOptions,
} from "@/lib/export/types";
import { runExportBatch, type ExportBatchSummary, type ExportPhase } from "@/lib/export/runner";

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
    case "decoding":
      return "Decoding";
    case "rendering":
      return "Rendering";
    case "encoding":
      return "Encoding";
    default:
      return "Preparing";
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
  return `${base}${safeSuffix}.${format.extensions[0] ?? "jpg"}`;
}

export function ExportDialog({ entries, onClose }: ExportDialogProps) {
  const rootPath = useLibraryStore((state) => state.rootPath);
  const metadata = useLibraryStore((state) => state.entryMetadata);
  const [formats, setFormats] = useState<ExportFormatDescriptor[]>([]);
  const [format, setFormat] = useState<ExportFormatId>(DEFAULT_PREFERENCES.format);
  const [quality, setQuality] = useState(DEFAULT_PREFERENCES.quality);
  const [lossless, setLossless] = useState(DEFAULT_PREFERENCES.lossless);
  const [size, setSize] = useState<ExportSizeOptions>(defaultSize);
  const [suffix, setSuffix] = useState(DEFAULT_PREFERENCES.suffix);
  const [conflict, setConflict] = useState<ExportConflictBehavior>(DEFAULT_PREFERENCES.conflict);
  const [dialogState, setDialogState] = useState<DialogState>("idle");
  const [formatsLoading, setFormatsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ExportPhase | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentEntry, setCurrentEntry] = useState<LibraryEntry | null>(null);
  const [summary, setSummary] = useState<ExportBatchSummary | null>(null);
  const cancelledRef = useRef(false);

  const selectedFormat = useMemo(
    () => formats.find((candidate) => candidate.id === format) ?? null,
    [formats, format],
  );

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

  const startExport = useCallback(async () => {
    if (!selectedFormat || entries.length === 0) {
      return;
    }
    if (!rootPath) {
      setError("No approved photo folder is open.");
      return;
    }
    const sizeError = validateSize(size);
    const suffixError = validateSuffix(suffix);
    if (sizeError || suffixError) {
      setError(sizeError ?? suffixError);
      return;
    }
    if (selectedFormat.supportsQuality && (!Number.isInteger(quality) || quality < 1 || quality > 100)) {
      setError("Quality must be a whole number from 1 to 100.");
      return;
    }

    setError(null);
    setSummary(null);
    setDialogState("running");
    setCurrentIndex(0);
    setCurrentEntry(null);
    setPhase(null);
    cancelledRef.current = false;

    try {
      const api = getDarkroomAPI();
      const destinationRequest: ExportDestinationRequest = {
        count: entries.length,
        format: selectedFormat.id,
        suggestedFilename: safeSuggestedFilename(entries[0], suffix, selectedFormat),
        sources: entries.map((entry) => ({
          rootPath: rootPath ?? "",
          relativePath: entry.relativePath,
        })),
      };
      const destination = await api.chooseExportDestination(destinationRequest);
      if (!destination) {
        setDialogState("idle");
        return;
      }

      const persisted: ExportPreferences = {
        format,
        quality,
        lossless,
        size,
        suffix,
        conflict,
      };
      await api.setExportOptions(persisted).catch(() => undefined);

      const result = await runExportBatch({
        entries,
        metadata,
        rootPath,
        destinationToken: destination.token,
        options: {
          format,
          size,
          quality: selectedFormat.supportsQuality ? quality : undefined,
          lossless: selectedFormat.supportsLossless ? lossless : undefined,
          suffix,
          conflict,
        },
        onProgress: ({ phase: nextPhase, index, entry }) => {
          setPhase(nextPhase);
          setCurrentIndex(index);
          setCurrentEntry(entry);
        },
        isCancelled: () => cancelledRef.current,
      });
      setSummary(result);
      setDialogState("done");
    } catch (exportError) {
      setError(errorMessage(exportError));
      setDialogState("idle");
    }
  }, [
    conflict,
    entries,
    format,
    lossless,
    metadata,
    quality,
    rootPath,
    selectedFormat,
    size,
    suffix,
  ]);

  const showInFolder = useCallback(() => {
    const capability: ExportRevealCapability | null = summary?.revealCapability ?? null;
    if (!capability) {
      return;
    }
    void getDarkroomAPI()
      .showInFolder(capability)
      .catch((showError: unknown) => setError(errorMessage(showError)));
  }, [summary]);

  const content = (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#0a0908]/62 p-4" role="presentation">
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-xl border border-lr-border bg-lr-panel-raised shadow-[0_32px_64px_rgba(0,0,0,.6)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
      >
        <div className="flex items-center justify-between border-b border-lr-border-subtle px-4 py-3">
          <div>
            <h2 id="export-dialog-title" className="text-sm font-semibold text-lr-text">
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
          <div className="space-y-3 p-4">
            {!isElectronApp() ? (
              <p className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
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
            {selectedFormat?.supportsQuality ? (
              <Field label={`Quality · ${quality}`}>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={quality}
                  onChange={(event) => setQuality(Number(event.target.value))}
                  className="h-1 w-full cursor-pointer accent-lr-accent"
                />
              </Field>
            ) : null}
            {selectedFormat?.supportsLossless ? (
              <label className="flex items-center gap-2 text-xs text-lr-text-muted">
                <input
                  type="checkbox"
                  checked={lossless}
                  onChange={(event) => setLossless(event.target.checked)}
                  className="accent-lr-accent"
                />
                WebP lossless
              </label>
            ) : null}
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
            {size.mode === "long-edge" ? (
              <Field label="Long edge (px)">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={size.longEdge ?? ""}
                  onChange={(event) => setSize({ ...size, longEdge: Number(event.target.value) })}
                  className="control"
                />
              </Field>
            ) : null}
            {size.mode === "fit" ? (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Width (px)">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={size.width ?? ""}
                    onChange={(event) => setSize({ ...size, width: Number(event.target.value) })}
                    className="control"
                  />
                </Field>
                <Field label="Height (px)">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={size.height ?? ""}
                    onChange={(event) => setSize({ ...size, height: Number(event.target.value) })}
                    className="control"
                  />
                </Field>
              </div>
            ) : null}
            {size.mode !== "original" ? (
              <label className="flex items-center gap-2 text-xs text-lr-text-muted">
                <input
                  type="checkbox"
                  checked={size.neverUpscale !== false}
                  onChange={(event) => setSize({ ...size, neverUpscale: event.target.checked })}
                  className="accent-lr-accent"
                />
                Never upscale
              </label>
            ) : null}
            <Field label="Filename suffix">
              <input
                type="text"
                value={suffix}
                onChange={(event) => setSuffix(event.target.value)}
                className="control"
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
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="button-secondary">Cancel</button>
              <button
                type="button"
                onClick={() => void startExport()}
                disabled={formatsLoading || !selectedFormat || entries.length === 0}
                className="button-primary"
              >
                Start export
              </button>
            </div>
          </div>
        ) : null}

        {dialogState === "running" ? (
          <div className="space-y-4 p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-lr-accent">{phaseLabel(phase)}</span>
              <span className="text-lr-text-muted">{currentIndex + 1} of {entries.length}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-lr-panel-raised">
              <div className="h-full bg-lr-accent transition-all" style={{ width: `${Math.min(100, (currentIndex / Math.max(1, entries.length)) * 100)}%` }} />
            </div>
            <p className="truncate text-xs text-lr-text-muted">{currentEntry?.name ?? "Preparing export…"}</p>
            <div className="flex justify-end">
              <button type="button" onClick={() => { cancelledRef.current = true; }} className="button-secondary">Cancel after this file</button>
            </div>
          </div>
        ) : null}

        {dialogState === "done" && summary ? (
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <SummaryStat label="Exported" value={summary.exported} tone="good" />
              <SummaryStat label="Skipped" value={summary.skipped} tone="muted" />
              <SummaryStat label="Failed" value={summary.failed} tone="bad" />
            </div>
            {summary.cancelled ? <p className="text-xs text-amber-300">Stopped before the next file.</p> : null}
            {summary.warnings.length > 0 ? (
              <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                <p className="font-medium">Embedded preview warning</p>
                <p className="mt-1">{summary.warnings.join(" ")}</p>
              </div>
            ) : null}
            {summary.results.some((result) => result.status === "error") ? (
              <div className="max-h-28 overflow-auto rounded border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-300">
                {summary.results.filter((result) => result.status === "error").map((result) => (
                  <p key={result.entryId}>{result.sourceName}: {result.error}</p>
                ))}
              </div>
            ) : null}
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
            <div className="flex items-center justify-end gap-2">
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

function SummaryStat({ label, value, tone }: { label: string; value: number; tone: "good" | "muted" | "bad" }) {
  const textClass = tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-lr-text-muted";
  return (
    <div className="rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-2">
      <div className={`text-lg font-semibold ${textClass}`}>{value}</div>
      <div className="text-[10px] text-lr-text-dim">{label}</div>
    </div>
  );
}
