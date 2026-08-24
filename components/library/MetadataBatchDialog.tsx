"use client";

import { useState, type FormEvent } from "react";
import type { MetadataOverride, MetadataOverrides, MetadataPreset } from "@/lib/metadata/types";
import { useLibraryStore } from "@/stores/library-store";

type FieldMode = "unchanged" | "set" | "clear";

interface TextFieldState {
  readonly mode: FieldMode;
  readonly value: string;
}

interface BatchState {
  readonly title: TextFieldState;
  readonly caption: TextFieldState;
  readonly copyright: TextFieldState;
  readonly keywords: TextFieldState;
  readonly captureTime: TextFieldState;
  readonly latitude: TextFieldState;
  readonly longitude: TextFieldState;
}

const EMPTY_FIELD: TextFieldState = { mode: "unchanged", value: "" };
const EMPTY_BATCH: BatchState = {
  title: EMPTY_FIELD,
  caption: EMPTY_FIELD,
  copyright: EMPTY_FIELD,
  keywords: EMPTY_FIELD,
  captureTime: EMPTY_FIELD,
  latitude: EMPTY_FIELD,
  longitude: EMPTY_FIELD,
};

function textOverride(field: TextFieldState): MetadataOverride<string> | undefined {
  if (field.mode === "unchanged") return undefined;
  if (field.mode === "clear") return { kind: "clear" };
  return { kind: "set", value: field.value.trim() };
}

function numberOverride(field: TextFieldState, min: number, max: number, label: string): MetadataOverride<number> | undefined {
  if (field.mode === "unchanged") return undefined;
  if (field.mode === "clear") return { kind: "clear" };
  const value = Number(field.value);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be from ${min} to ${max}.`);
  return { kind: "set", value };
}

function overridesFromState(state: BatchState): MetadataOverrides {
  const captureTime: MetadataOverrides["captureTime"] = state.captureTime.mode === "unchanged"
    ? undefined
    : state.captureTime.mode === "clear"
      ? { kind: "clear" }
      : (() => {
          const normalized = state.captureTime.value.length === 16 ? `${state.captureTime.value}:00` : state.captureTime.value;
          const sortKey = Date.parse(`${normalized}Z`);
          if (!Number.isFinite(sortKey)) throw new Error("Capture time is invalid.");
          return { kind: "set", value: { value: normalized, offset: null, sortKey } };
        })();
  const keywords: MetadataOverrides["keywords"] = state.keywords.mode === "unchanged"
    ? undefined
    : state.keywords.mode === "clear"
      ? { kind: "clear" }
      : {
          kind: "set",
          value: [...new Map(
            state.keywords.value.split(",").map((value) => value.trim()).filter(Boolean)
              .map((value) => [value.toLocaleLowerCase(), value]),
          ).values()],
        };
  return {
    title: textOverride(state.title),
    caption: textOverride(state.caption),
    copyright: textOverride(state.copyright),
    keywords,
    captureTime,
    latitude: numberOverride(state.latitude, -90, 90, "Latitude"),
    longitude: numberOverride(state.longitude, -180, 180, "Longitude"),
  };
}

function fieldState<T>(override: MetadataOverride<T> | undefined, serialize: (value: T) => string): TextFieldState {
  if (override === undefined) return EMPTY_FIELD;
  return override.kind === "clear"
    ? { mode: "clear", value: "" }
    : { mode: "set", value: serialize(override.value) };
}

function stateFromPreset(preset: MetadataPreset): BatchState {
  return {
    title: fieldState(preset.fields.title, String),
    caption: fieldState(preset.fields.caption, String),
    copyright: fieldState(preset.fields.copyright, String),
    keywords: fieldState(preset.fields.keywords, (value) => value.join(", ")),
    captureTime: fieldState(preset.fields.captureTime, (value) => value.value.slice(0, 19)),
    latitude: fieldState(preset.fields.latitude, String),
    longitude: fieldState(preset.fields.longitude, String),
  };
}

export function MetadataBatchDialog({ entryIds, onClose }: { entryIds: readonly string[]; onClose: () => void }) {
  const presets = useLibraryStore((state) => state.libraryWorkspace.metadataPresets);
  const applyOverrides = useLibraryStore((state) => state.applyMetadataOverrides);
  const publishXmp = useLibraryStore((state) => state.publishMetadataXmp);
  const savePreset = useLibraryStore((state) => state.saveMetadataPreset);
  const deletePreset = useLibraryStore((state) => state.deleteMetadataPreset);
  const [fields, setFields] = useState<BatchState>(EMPTY_BATCH);
  const [captionMode, setCaptionMode] = useState<"replace" | "append">("replace");
  const [keywordMode, setKeywordMode] = useState<"replace" | "append">("append");
  const [presetId, setPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [publishAfterSave, setPublishAfterSave] = useState(false);
  const [applying, setApplying] = useState(false);
  const photoLabel = entryIds.length === 1 ? "photo" : "photos";

  function updateField(field: keyof BatchState, patch: Partial<TextFieldState>) {
    setFields((current) => ({ ...current, [field]: { ...current[field], ...patch } }));
    setStatus(null);
  }

  function loadPreset(id: string) {
    setPresetId(id);
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    setFields(stateFromPreset(preset));
    setCaptionMode(preset.captionMode);
    setKeywordMode(preset.keywordMode);
    setPresetName(preset.name);
  }

  function persistPreset(mode: "new" | "update" | "duplicate") {
    try {
      const existing = presets.find((item) => item.id === presetId);
      const now = Date.now();
      const id = mode === "update" && existing ? existing.id : crypto.randomUUID();
      const name = (mode === "duplicate" && existing ? `${existing.name} copy` : presetName).trim();
      if (!name) throw new Error("Preset name is required.");
      savePreset({
        id,
        name,
        version: 1,
        fields: overridesFromState(fields),
        captionMode,
        keywordMode,
        createdAt: mode === "update" && existing ? existing.createdAt : now,
        updatedAt: now,
      });
      setPresetId(id);
      setPresetName(name);
      setError(null);
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : "Preset could not be saved.");
    }
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setApplying(true);
    try {
      const overrides = overridesFromState(fields);
      if (Object.values(overrides).every((value) => value === undefined)) throw new Error("Choose at least one field to change.");
      applyOverrides(entryIds, overrides, { captionMode, keywordMode });
      if (!publishAfterSave) {
        setStatus(`Saved catalog metadata for ${entryIds.length} ${photoLabel}. XMP unchanged.`);
      } else {
        let published = 0;
        let conflicts = 0;
        let failed = 0;
        for (const [index, entryId] of entryIds.entries()) {
          setStatus(`Saved catalog metadata. Publishing XMP ${index + 1} of ${entryIds.length}…`);
          try {
            const result = await publishXmp(entryId);
            if (result === "conflict") conflicts += 1;
            else published += 1;
          } catch {
            failed += 1;
          }
        }
        setStatus(`Saved ${entryIds.length} catalog records. Published ${published} XMP sidecars${conflicts > 0 ? `; ${conflicts} need conflict resolution` : ""}${failed > 0 ? `; ${failed} failed` : ""}.`);
      }
      setError(null);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Metadata could not be applied.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form onSubmit={apply} role="dialog" aria-modal="true" aria-labelledby="batch-metadata-title" className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-lr-border bg-lr-panel shadow-2xl">
        <header className="flex items-start gap-4 border-b border-lr-border-subtle p-5">
          <div>
            <h2 id="batch-metadata-title" className="text-base font-semibold text-lr-text">Edit metadata for {entryIds.length} {photoLabel}</h2>
            <p className="mt-1 text-xs text-lr-text-faint">Unchanged fields stay untouched. Catalog saves are atomic; XMP is never written implicitly.</p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto text-xl leading-none text-lr-text-muted hover:text-lr-text" aria-label="Close">×</button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr]">
          <aside className="space-y-3 border-r border-lr-border-subtle bg-lr-toolbar p-4">
            <label className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-lr-text-faint">
              Preset
              <select value={presetId} onChange={(event) => loadPreset(event.target.value)} className="mt-1.5 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-2 text-xs normal-case tracking-normal text-lr-text">
                <option value="">Custom</option>
                {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
            <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Preset name" className="w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2.5 py-2 text-xs text-lr-text outline-none focus:border-lr-accent" />
            <div className="grid grid-cols-2 gap-1.5">
              <SmallButton onClick={() => persistPreset("new")}>Save new</SmallButton>
              <SmallButton disabled={!presetId} onClick={() => persistPreset("update")}>Update</SmallButton>
              <SmallButton disabled={!presetId} onClick={() => persistPreset("duplicate")}>Duplicate</SmallButton>
              <SmallButton disabled={!presetId} onClick={() => { deletePreset(presetId); setPresetId(""); setPresetName(""); }}>Delete</SmallButton>
            </div>
            <div className="rounded-lg border border-lr-border-subtle bg-lr-panel p-3 text-[11px] leading-relaxed text-lr-text-faint">
              Preview
              <strong className="mt-1 block text-xs font-medium text-lr-text">{Object.values(fields).filter((field) => field.mode !== "unchanged").length} fields × {entryIds.length} {photoLabel}</strong>
              <span className="mt-1 block">Append modes combine with each photo’s effective catalog value.</span>
            </div>
          </aside>

          <div className="space-y-3 overflow-auto p-5">
            <BatchField label="Title" field={fields.title} onChange={(patch) => updateField("title", patch)} />
            <BatchField label="Caption" field={fields.caption} onChange={(patch) => updateField("caption", patch)} multiline>
              <ModeSelect label="Caption mode" value={captionMode} onChange={setCaptionMode} />
            </BatchField>
            <BatchField label="Copyright" field={fields.copyright} onChange={(patch) => updateField("copyright", patch)} />
            <BatchField label="Keywords" field={fields.keywords} onChange={(patch) => updateField("keywords", patch)} hint="Comma separated">
              <ModeSelect label="Keyword mode" value={keywordMode} onChange={setKeywordMode} />
            </BatchField>
            <BatchField label="Capture time" field={fields.captureTime} onChange={(patch) => updateField("captureTime", patch)} type="datetime-local" />
            <div className="grid grid-cols-2 gap-3">
              <BatchField label="Latitude" field={fields.latitude} onChange={(patch) => updateField("latitude", patch)} type="number" />
              <BatchField label="Longitude" field={fields.longitude} onChange={(patch) => updateField("longitude", patch)} type="number" />
            </div>
            <label className="flex items-start gap-3 rounded-lg border border-lr-border-subtle p-3 text-xs text-lr-text-muted">
              <input type="checkbox" checked={publishAfterSave} onChange={(event) => setPublishAfterSave(event.target.checked)} className="mt-0.5 accent-lr-accent" />
              <span>
                <strong className="block font-medium text-lr-text">Publish XMP after catalog save</strong>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-lr-text-faint">Writes sidecars one at a time with conflict checks and byte-exact backups.</span>
              </span>
            </label>
            {error ? <p role="alert" className="rounded-md border border-red-400/30 bg-red-950/30 px-3 py-2 text-xs text-red-200">{error}</p> : null}
            {status ? <p role="status" className="rounded-md border border-emerald-400/20 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">{status}</p> : null}
          </div>
        </div>

        <footer className="flex items-center gap-2 border-t border-lr-border-subtle p-4">
          <button type="button" onClick={() => { setFields(EMPTY_BATCH); setStatus(null); }} className="mr-auto px-2 py-2 text-xs text-lr-text-muted hover:text-lr-text">Clear form</button>
          <button type="button" onClick={onClose} className="rounded-md border border-lr-border-subtle px-4 py-2 text-xs text-lr-text-muted">Close</button>
          <button type="submit" disabled={applying} className="rounded-md bg-lr-accent px-4 py-2 text-xs font-medium text-[#14202a] disabled:opacity-50">{applying ? "Applying…" : `Apply to ${entryIds.length}`}</button>
        </footer>
      </form>
    </div>
  );
}

function BatchField({ label, field, onChange, multiline = false, hint, type = "text", children }: { label: string; field: TextFieldState; onChange: (patch: Partial<TextFieldState>) => void; multiline?: boolean; hint?: string; type?: "text" | "number" | "datetime-local"; children?: React.ReactNode }) {
  const inputClass = "w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2.5 py-2 text-xs text-lr-text outline-none disabled:opacity-35 focus:border-lr-accent";
  return (
    <div className="grid grid-cols-[112px_1fr] gap-3 rounded-lg border border-lr-border-subtle p-3">
      <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-lr-text-faint">
        {label}
        <select value={field.mode} onChange={(event) => onChange({ mode: event.target.value === "set" || event.target.value === "clear" ? event.target.value : "unchanged" })} className="mt-1.5 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] normal-case tracking-normal text-lr-text">
          <option value="unchanged">Unchanged</option>
          <option value="set">Set value</option>
          <option value="clear">Clear</option>
        </select>
      </label>
      <div className="space-y-2">
        {multiline ? <textarea value={field.value} onChange={(event) => onChange({ value: event.target.value })} disabled={field.mode !== "set"} rows={3} className={`${inputClass} resize-y`} /> : <input type={type} step={type === "number" ? "any" : undefined} value={field.value} onChange={(event) => onChange({ value: event.target.value })} disabled={field.mode !== "set"} className={inputClass} />}
        {hint ? <p className="text-[10px] text-lr-text-faint">{hint}</p> : null}
        {children}
      </div>
    </div>
  );
}

function ModeSelect({ label, value, onChange }: { label: string; value: "replace" | "append"; onChange: (value: "replace" | "append") => void }) {
  return <label className="flex items-center gap-2 text-[10px] text-lr-text-faint">{label}<select value={value} onChange={(event) => onChange(event.target.value === "append" ? "append" : "replace")} className="rounded-md border border-lr-border-subtle bg-lr-panel px-2 py-1 text-[10px] text-lr-text"><option value="replace">Replace</option><option value="append">Append</option></select></label>;
}

function SmallButton({ children, onClick, disabled = false }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="rounded-md border border-lr-border-subtle px-2 py-1.5 text-[10px] text-lr-text-muted hover:text-lr-text disabled:opacity-35">{children}</button>;
}
