"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ExportFormatDescriptor,
  ExportPreferences as ExportOptions,
} from "@/lib/export/types";
import { getDarkroomAPI, isDesktopApp } from "@/lib/fs/platform";
import { readExportPreferences, saveExportPreferences } from "@/lib/export/preferences";

type EditableExportOptions = Pick<
  ExportOptions,
  "format" | "quality" | "lossless" | "metadata" | "includeLocation" | "conflict"
>;

const rowClass = "flex items-center justify-between gap-6 py-3 text-xs text-lr-text";
const controlClass = "h-9 w-44 rounded-md border border-lr-border bg-lr-panel px-2 text-xs text-lr-text focus-visible:outline-2 focus-visible:outline-lr-accent disabled:opacity-40";

export function ExportPreferences() {
  const [desktop] = useState(isDesktopApp);
  const [formats, setFormats] = useState<ExportFormatDescriptor[]>([]);
  const [options, setOptions] = useState<EditableExportOptions | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const latestOptions = useRef<EditableExportOptions | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    mounted.current = true;
    const api = getDarkroomAPI();
    void Promise.all([api.getExportFormats(), readExportPreferences()])
      .then(([available, persisted]) => {
        if (!active) return;
        const next: EditableExportOptions = {
          format: persisted.format,
          quality: persisted.quality,
          lossless: persisted.lossless,
          metadata: persisted.metadata ?? "all",
          includeLocation: persisted.includeLocation === true,
          conflict: persisted.conflict,
        };
        setFormats(available);
        latestOptions.current = next;
        setOptions(next);
        setStatus("ready");
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load export defaults.");
        setStatus("error");
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [desktop]);

  function updateOptions(patch: Partial<EditableExportOptions>) {
    if (!latestOptions.current) return;
    const next = { ...latestOptions.current, ...patch };
    latestOptions.current = next;
    setOptions(next);
    setStatus("saving");
    setError(null);
    const currentRevision = ++revision.current;
    void saveExportPreferences(next).then(
      () => {
        if (mounted.current && currentRevision === revision.current) setStatus("saved");
      },
      (saveError: unknown) => {
        if (!mounted.current || currentRevision !== revision.current) return;
        setError(saveError instanceof Error ? saveError.message : "Could not save export defaults.");
        setStatus("error");
      },
    );
  }

  const selectedFormat = formats.find((format) => format.id === options?.format);

  return (
    <fieldset disabled={!desktop || !options || formats.length === 0}>
      <legend className="sr-only">Export defaults</legend>
      <p className="py-3 text-[11px] leading-4 text-lr-text-dim">
        {desktop
          ? "Used when opening Export. Export also remembers the options you use."
          : "Export defaults are available in the desktop app."}
      </p>
      {desktop && options ? (
        <>
          <label className={rowClass}>
            <span>Format</span>
            <select
              value={options.format}
              className={controlClass}
              onChange={(event) => {
                const format = formats.find((candidate) => candidate.id === event.target.value);
                if (!format) return;
                updateOptions({
                  format: format.id,
                  lossless: false,
                  quality: format.defaultQuality ?? options.quality,
                });
              }}
            >
              {!selectedFormat ? <option value={options.format} disabled>{options.format.toUpperCase()} (unavailable)</option> : null}
              {formats.map((format) => <option key={format.id} value={format.id}>{format.label}</option>)}
            </select>
          </label>
          <label className={rowClass}>
            <span>Quality</span>
            <span className="flex w-44 items-center gap-3">
              <input
                type="range"
                aria-label="Quality"
                min={1}
                max={100}
                step={1}
                value={options.quality}
                disabled={!selectedFormat?.supportsQuality || (selectedFormat.supportsLossless && options.lossless)}
                onChange={(event) => updateOptions({ quality: Number(event.target.value) })}
                className="thin-slider min-w-0 flex-1 disabled:opacity-40"
              />
              <span className="w-6 text-right font-mono text-[11px] text-lr-text-muted">{options.quality}</span>
            </span>
          </label>
          {selectedFormat?.supportsLossless ? (
            <label className={rowClass}>
              <span>Lossless compression</span>
              <input type="checkbox" checked={options.lossless} onChange={(event) => updateOptions({ lossless: event.target.checked })} className="h-4 w-4 shrink-0 accent-lr-accent" />
            </label>
          ) : null}
          <label className={rowClass}>
            <span>Metadata</span>
            <select
              value={options.metadata}
              className={controlClass}
              onChange={(event) => {
                const metadata = event.target.value;
                if (metadata === "all" || metadata === "copyright" || metadata === "none") updateOptions({ metadata });
              }}
            >
              <option value="all">Camera and description</option>
              <option value="copyright">Copyright only</option>
              <option value="none">None</option>
            </select>
          </label>
          <label className={rowClass}>
            <span>Include GPS location</span>
            <input
              type="checkbox"
              checked={options.includeLocation === true}
              disabled={options.metadata !== "all"}
              onChange={(event) => updateOptions({ includeLocation: event.target.checked })}
              className="h-4 w-4 shrink-0 accent-lr-accent disabled:opacity-40"
            />
          </label>
          <label className={rowClass}>
            <span>Existing files</span>
            <select
              value={options.conflict}
              className={controlClass}
              onChange={(event) => {
                const conflict = event.target.value;
                if (conflict === "rename" || conflict === "skip" || conflict === "replace") updateOptions({ conflict });
              }}
            >
              <option value="rename">Rename with -2, -3…</option>
              <option value="skip">Skip</option>
              <option value="replace">Replace</option>
            </select>
          </label>
          {formats.length === 0 ? <p className="text-[11px] text-lr-text-dim">No export formats are available.</p> : null}
        </>
      ) : null}
      {desktop ? (
        <div className="min-h-4 text-[11px]" role="status" aria-live="polite">
          {error ? (
            <span className="text-red-400">
              {error}
              {options ? <button type="button" onClick={() => updateOptions({})} className="ml-2 underline">Retry save</button> : null}
            </span>
          ) : (
            <span className="text-lr-text-dim">{status === "loading" ? "Loading export defaults…" : status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}</span>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
