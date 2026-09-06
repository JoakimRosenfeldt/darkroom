"use client";

import { useState, type FormEvent } from "react";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import type { EntryMetadata } from "@/lib/catalog/types";
import { getDecoderProvenanceLabel, getFormatCapability, getFormatLabelForEntry } from "@/lib/formats/registry";
import type { LibraryEntry } from "@/lib/fs/types";
import type { EntryAnalysis } from "@/lib/library/model";
import {
  effectiveMetadataValue,
  metadataValue,
  type MetadataOverride,
  type MetadataOverrides,
  type MetadataValue,
} from "@/lib/metadata/types";
import { formatMetadataValue } from "@/lib/raw/utils";
import { useLibraryStore } from "@/stores/library-store";
import { IconInfo } from "@/components/shell/icons";

interface MetadataPanelProps {
  entry: LibraryEntry;
  decodedMetadata: Record<string, unknown>;
}

interface MetadataDraft {
  readonly title: string;
  readonly caption: string;
  readonly copyright: string;
  readonly keywords: string;
  readonly captureTime: string;
  readonly latitude: string;
  readonly longitude: string;
}

const EMPTY_METADATA_OVERRIDES: MetadataOverrides = {};

function display<T>(source: MetadataValue<T> | undefined, override: MetadataOverride<T> | undefined, catalog: T | null): T | null {
  if (override !== undefined) {
    return source === undefined
      ? override.kind === "set" ? override.value : null
      : effectiveMetadataValue(source, override);
  }
  return catalog ?? (source === undefined ? null : metadataValue(source));
}

function sourceLabel<T>(source: MetadataValue<T> | undefined, override: MetadataOverride<T> | undefined, catalog: T | null): string {
  if (override?.kind === "clear") return "Cleared";
  if (override?.kind === "set" || catalog !== null) return "Catalog";
  if (source?.kind === "value") return `${source.source} · ${source.tag}`;
  if (source?.kind === "malformed") return "Malformed";
  if (source?.kind === "unavailable") return "Unavailable";
  return "Not present";
}

function initialDraft(analysis: EntryAnalysis | undefined, overrides: MetadataOverrides, catalog: EntryMetadata): MetadataDraft {
  const source = analysis?.source;
  const captureTime = display(source?.capture.time, overrides.captureTime, null);
  return {
    title: display(source?.description.title, overrides.title, catalog.title) ?? "",
    caption: display(source?.description.caption, overrides.caption, catalog.caption) ?? "",
    copyright: display(source?.description.copyright, overrides.copyright, catalog.copyright) ?? "",
    keywords: (display(source?.description.keywords, overrides.keywords, catalog.keywords) ?? []).join(", "),
    captureTime: captureTime?.value.slice(0, 19) ?? "",
    latitude: String(display(source?.location.latitude, overrides.latitude, null) ?? ""),
    longitude: String(display(source?.location.longitude, overrides.longitude, null) ?? ""),
  };
}

function textOverride(value: string): MetadataOverride<string> {
  const trimmed = value.trim();
  return trimmed.length === 0 ? { kind: "clear" } : { kind: "set", value: trimmed };
}

function numberOverride(value: string, min: number, max: number, label: string): MetadataOverride<number> {
  if (value.trim().length === 0) return { kind: "clear" };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be from ${min} to ${max}.`);
  return { kind: "set", value: parsed };
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function formatShutter(value: number | null): string {
  if (value === null) return "—";
  return value >= 1 ? `${value}s` : `1/${Math.round(1 / value)}s`;
}

export function MetadataPanel({ entry, decodedMetadata }: MetadataPanelProps) {
  const analysis = useLibraryStore((state) => state.libraryWorkspace.analysisByEntryId[entry.id]);
  const overrides = useLibraryStore((state) => state.libraryWorkspace.metadataOverridesByEntryId[entry.id] ?? EMPTY_METADATA_OVERRIDES);
  const sync = useLibraryStore((state) => state.libraryWorkspace.metadataSyncByEntryId[entry.id]);
  const catalog = useLibraryStore((state) => getEntryMetadata(state.entryMetadata, entry.id));
  const applyOverrides = useLibraryStore((state) => state.applyMetadataOverrides);
  const resetFields = useLibraryStore((state) => state.resetMetadataFields);
  const reread = useLibraryStore((state) => state.refreshEntryMetadataAnalysis);
  const publishXmp = useLibraryStore((state) => state.publishMetadataXmp);
  const metadataAnalysis = useLibraryStore((state) => state.metadataAnalysis);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MetadataDraft>(() => initialDraft(analysis, overrides, catalog));
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const source = analysis?.source;
  const title = display(source?.description.title, overrides.title, catalog.title);
  const caption = display(source?.description.caption, overrides.caption, catalog.caption);
  const copyright = display(source?.description.copyright, overrides.copyright, catalog.copyright);
  const keywords = display(source?.description.keywords, overrides.keywords, catalog.keywords) ?? [];
  const captureTime = display(source?.capture.time, overrides.captureTime, null);
  const latitude = display(source?.location.latitude, overrides.latitude, null);
  const longitude = display(source?.location.longitude, overrides.longitude, null);
  const decoderLabel = getDecoderProvenanceLabel(decodedMetadata.decoderProvenance);
  const formatLabel = entry.formatId
    ? getFormatCapability(entry.formatId)?.label ?? getFormatLabelForEntry(entry.name, entry.profileId)
    : getFormatLabelForEntry(entry.name, entry.profileId);
  const unavailableReason = entry.formatAvailability.status === "supported" ? null : entry.formatAvailability.reason;

  function beginEdit() {
    setDraft(initialDraft(analysis, overrides, catalog));
    setError(null);
    setEditing(true);
  }

  function update(field: keyof MetadataDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const captureTimeOverride: MetadataOverrides["captureTime"] = draft.captureTime.trim().length === 0
        ? { kind: "clear" }
        : (() => {
            const normalized = draft.captureTime.length === 16 ? `${draft.captureTime}:00` : draft.captureTime;
            const sortKey = Date.parse(`${normalized}Z`);
            if (!Number.isFinite(sortKey)) throw new Error("Capture time is invalid.");
            return { kind: "set", value: { value: normalized, offset: null, sortKey } };
          })();
      applyOverrides([entry.id], {
        title: textOverride(draft.title),
        caption: textOverride(draft.caption),
        copyright: textOverride(draft.copyright),
        keywords: draft.keywords.trim().length === 0
          ? { kind: "clear" }
          : {
              kind: "set",
              value: [...new Map(
                draft.keywords.split(",").map((value) => value.trim()).filter(Boolean)
                  .map((value) => [value.toLocaleLowerCase(), value]),
              ).values()],
            },
        captureTime: captureTimeOverride,
        latitude: numberOverride(draft.latitude, -90, 90, "Latitude"),
        longitude: numberOverride(draft.longitude, -180, 180, "Longitude"),
      });
      setEditing(false);
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Metadata could not be saved.");
    }
  }

  async function publish(resolution: "merge" | "catalog-wins" | "sidecar-wins" = "merge") {
    setPublishing(true);
    setError(null);
    try {
      await publishXmp(entry.id, resolution);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "XMP could not be published.");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <aside className="relative flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex items-center gap-2 border-b border-lr-border-subtle px-4 py-3">
        <IconInfo className="h-3.5 w-3.5 text-lr-text-dim" />
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Metadata</h2>
        <span className="ml-auto rounded-md border border-lr-border-subtle px-1.5 py-0.5 font-mono text-[9px] uppercase text-lr-text-faint">
          {sync?.status ?? (analysis ? "clean" : "pending")}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        <MetadataSection title="File">
          <MetadataRow label="File name" value={entry.name} />
          <MetadataRow label="Format" value={unavailableReason ? `${formatLabel} · unavailable` : formatLabel} />
          <MetadataRow label="Size" value={formatBytes(entry.size)} />
          {source?.file.width.kind === "value" && source.file.height.kind === "value" ? <MetadataRow label="Dimensions" value={`${source.file.width.value} × ${source.file.height.value}`} /> : null}
          {decoderLabel ? <MetadataRow label="Decoder" value={decoderLabel} /> : null}
        </MetadataSection>

        <MetadataSection title="Capture">
          <MetadataRow label="Date time" value={captureTime ? `${captureTime.value}${captureTime.offset ?? ""}` : "—"} source={sourceLabel(source?.capture.time, overrides.captureTime, null)} />
          <MetadataRow label="Camera" value={[metadataValue(source?.capture.cameraMake ?? { kind: "absent" }), metadataValue(source?.capture.cameraModel ?? { kind: "absent" })].filter(Boolean).join(" ") || "—"} />
          <MetadataRow label="Lens" value={metadataValue(source?.capture.lens ?? { kind: "absent" }) ?? "—"} />
          <MetadataRow label="Exposure" value={formatShutter(metadataValue(source?.capture.shutter ?? { kind: "absent" }))} />
          <MetadataRow label="Aperture" value={source?.capture.aperture.kind === "value" ? `f/${source.capture.aperture.value}` : "—"} />
          <MetadataRow label="ISO" value={String(metadataValue(source?.capture.iso ?? { kind: "absent" }) ?? "—")} />
          <MetadataRow label="Focal length" value={source?.capture.focalLength.kind === "value" ? `${source.capture.focalLength.value} mm` : "—"} />
        </MetadataSection>

        <MetadataSection title="Description">
          <MetadataRow label="Title" value={title ?? "—"} source={sourceLabel(source?.description.title, overrides.title, catalog.title)} />
          <MetadataRow label="Caption" value={caption ?? "—"} source={sourceLabel(source?.description.caption, overrides.caption, catalog.caption)} />
          <MetadataRow label="Copyright" value={copyright ?? "—"} source={sourceLabel(source?.description.copyright, overrides.copyright, catalog.copyright)} />
          <MetadataRow label="Keywords" value={keywords.length > 0 ? keywords.join(" · ") : "—"} source={sourceLabel(source?.description.keywords, overrides.keywords, catalog.keywords.length > 0 ? catalog.keywords : null)} />
        </MetadataSection>

        <MetadataSection title="Location">
          <MetadataRow label="Coordinates" value={latitude === null || longitude === null ? "—" : `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`} source={sourceLabel(source?.location.latitude, overrides.latitude, null)} />
          <MetadataRow label="Place" value={[metadataValue(source?.location.city ?? { kind: "absent" }), metadataValue(source?.location.state ?? { kind: "absent" }), metadataValue(source?.location.country ?? { kind: "absent" })].filter(Boolean).join(", ") || "—"} />
        </MetadataSection>

        <MetadataSection title="Develop & sync">
          <MetadataRow label="Develop" value={catalog.develop ? "Edited" : "Original"} />
          <MetadataRow label="XMP" value={sync?.message ?? "No unpublished catalog changes"} />
          <MetadataRow label="Revision" value={String(sync?.catalogRevision ?? "—")} mono />
        </MetadataSection>

        <MetadataSection title="Diagnostics" defaultOpen={false}>
          <MetadataRow label="Source hash" value={analysis?.sourceSha256?.slice(0, 16) ?? "—"} mono />
          <MetadataRow label="Parser" value={analysis?.parserVersion ?? "—"} mono />
          <MetadataRow label="Adapter" value={analysis?.adapterVersion ?? "—"} mono />
          <MetadataRow label="Cache" value={analysis?.cacheHit ? "Hit" : "Fresh read"} />
          {analysis?.error ? <MetadataRow label="Error" value={analysis.error} /> : null}
          {source?.warnings.map((warning) => <MetadataRow key={warning} label="Warning" value={warning} />)}
          {Object.entries(decodedMetadata).slice(0, 24).map(([key, value]) => <MetadataRow key={key} label={key.replaceAll("_", " ")} value={formatMetadataValue(value)} mono />)}
        </MetadataSection>
      </div>

      {editing ? (
        <form onSubmit={save} className="absolute inset-0 z-20 flex flex-col bg-lr-panel shadow-[-20px_0_50px_rgba(0,0,0,.35)]">
          <div className="border-b border-lr-border-subtle px-4 py-3">
            <h3 className="text-sm font-semibold text-lr-text">Edit metadata</h3>
            <p className="mt-1 text-[11px] text-lr-text-faint">Saves to the catalog. XMP remains unchanged until published.</p>
          </div>
          <div className="flex-1 space-y-3 overflow-auto p-4">
            <MetadataInput label="Title" value={draft.title} onChange={(value) => update("title", value)} />
            <MetadataInput label="Caption" value={draft.caption} onChange={(value) => update("caption", value)} multiline />
            <MetadataInput label="Copyright" value={draft.copyright} onChange={(value) => update("copyright", value)} />
            <MetadataInput label="Keywords" value={draft.keywords} onChange={(value) => update("keywords", value)} hint="Comma separated" />
            <MetadataInput label="Capture time" value={draft.captureTime} onChange={(value) => update("captureTime", value)} type="datetime-local" />
            <div className="grid grid-cols-2 gap-2">
              <MetadataInput label="Latitude" value={draft.latitude} onChange={(value) => update("latitude", value)} type="number" />
              <MetadataInput label="Longitude" value={draft.longitude} onChange={(value) => update("longitude", value)} type="number" />
            </div>
            {error ? <p role="alert" className="rounded-md border border-red-400/30 bg-red-950/30 px-3 py-2 text-[11px] text-red-200">{error}</p> : null}
          </div>
          <div className="flex gap-2 border-t border-lr-border-subtle p-3">
            <button type="button" onClick={() => { resetFields([entry.id], ["title", "caption", "copyright", "keywords", "captureTime", "latitude", "longitude"]); setEditing(false); }} className="mr-auto rounded-md px-2.5 py-1.5 text-[11px] text-lr-text-muted hover:text-lr-text">Reset to source</button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted">Cancel</button>
            <button type="submit" className="rounded-md bg-lr-accent px-3 py-1.5 text-xs font-medium text-[#14202a]">Save</button>
          </div>
        </form>
      ) : null}

      <div className="flex gap-2 border-t border-lr-border-subtle p-3">
        <button type="button" onClick={beginEdit} className="flex-1 rounded-md bg-lr-accent px-3 py-2 text-xs font-medium text-[#14202a]">Edit metadata</button>
        <button type="button" disabled={metadataAnalysis !== null} onClick={() => reread(entry.id)} className="rounded-md border border-lr-border-subtle px-3 py-2 text-xs text-lr-text-muted hover:text-lr-text disabled:opacity-40">{metadataAnalysis ? "Reading…" : "Re-read"}</button>
      </div>
      {entry.entryKind === "original" && (sync?.status === "catalog-only" || sync?.status === "conflict") ? (
        <div className="space-y-2 border-t border-lr-border-subtle p-3">
          {error ? <p role="alert" className="text-[11px] text-red-300">{error}</p> : null}
          {sync.status === "conflict" ? (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={publishing} onClick={() => void publish("catalog-wins")} className="rounded-md border border-lr-border-subtle px-2 py-2 text-[11px] text-lr-text-muted disabled:opacity-40">Use catalog</button>
              <button type="button" disabled={publishing} onClick={() => void publish("sidecar-wins")} className="rounded-md border border-lr-border-subtle px-2 py-2 text-[11px] text-lr-text-muted disabled:opacity-40">Reload XMP</button>
            </div>
          ) : (
            <button type="button" disabled={publishing} onClick={() => void publish()} className="w-full rounded-md border border-lr-accent/40 bg-lr-selection px-3 py-2 text-xs text-lr-accent disabled:opacity-40">{publishing ? "Publishing…" : "Publish catalog metadata to XMP"}</button>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function MetadataSection({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="border-b border-lr-border-subtle">
      <summary className="cursor-pointer select-none px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted hover:text-lr-text">{title}</summary>
      <dl className="px-4 pb-3">{children}</dl>
    </details>
  );
}

function MetadataRow({ label, value, source, mono = false }: { label: string; value: string; source?: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1.5 text-xs">
      <dt className="text-lr-text-muted">{label}</dt>
      <dd className={mono ? "break-words font-mono text-[10px] leading-relaxed text-lr-text" : "break-words text-lr-text"}>
        {value}
        {source ? <span className="mt-0.5 block font-mono text-[9px] text-lr-text-faint">{source}</span> : null}
      </dd>
    </div>
  );
}

function MetadataInput({ label, value, onChange, multiline = false, hint, type = "text" }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; hint?: string; type?: "text" | "number" | "datetime-local" }) {
  const className = "w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2.5 py-2 text-xs text-lr-text outline-none focus:border-lr-accent";
  return (
    <label className="block space-y-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-lr-text-faint">
      <span>{label}</span>
      {multiline ? (
        <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={4} className={`${className} resize-y normal-case tracking-normal`} />
      ) : (
        <input type={type} value={value} step={type === "number" ? "any" : undefined} onChange={(event) => onChange(event.target.value)} className={`${className} normal-case tracking-normal`} />
      )}
      {hint ? <span className="block font-normal normal-case tracking-normal text-lr-text-faint">{hint}</span> : null}
    </label>
  );
}
