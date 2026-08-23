"use client";

import { useState } from "react";
import type { CatalogPresetView } from "@/lib/catalog/api";
import { parsePresetId, parseRootId, type PresetId, type RootId } from "@/lib/catalog/ids";
import { parseSessionId } from "@/lib/catalog/runtime";
import {
  cancelCatalogImport,
  deleteImportPreset,
  prepareCatalogImport,
  refreshActiveCatalog,
  runCatalogImport,
  saveImportPreset,
  setDefaultImportPreset,
  type CatalogRootState,
} from "@/lib/fs/session-catalog";
import { parseJsonValue, type JsonValue } from "@/lib/import/domain";
import type {
  CatalogImportDraftView,
  CatalogImportExecutionView,
  CatalogImportPrepareRequest,
} from "@/lib/import/api";
import { useLibraryStore } from "@/stores/library-store";

type Action = CatalogImportPrepareRequest["action"];
type DuplicatePolicy = CatalogImportPrepareRequest["duplicatePolicy"];
type DestinationPolicy = CatalogImportPrepareRequest["destinationPolicy"];

const BUTTON_CLASS = "rounded border border-lr-border-subtle px-2.5 py-1.5 text-[11px] text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40";
const PRIMARY_BUTTON_CLASS = "rounded bg-lr-accent px-2.5 py-1.5 text-[11px] text-white transition hover:bg-lr-accent/90 disabled:opacity-40";

function isRecord(value: JsonValue | null): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function keywordsValue(value: JsonValue | undefined): string {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.join(", ")
    : "";
}

function presetFields(preset: CatalogPresetView | undefined): {
  readonly name: string;
  readonly pattern: string;
  readonly title: string;
  readonly caption: string;
  readonly copyright: string;
  readonly keywords: string;
  readonly develop: string;
} {
  if (preset === undefined) {
    return {
      name: "",
      pattern: "{{filename}}",
      title: "",
      caption: "",
      copyright: "",
      keywords: "",
      develop: "",
    };
  }
  const payload = isRecord(preset.payload) ? preset.payload : null;
  const metadata = payload !== null && isRecord(payload.metadata) ? payload.metadata : payload;
  const develop = payload?.develop ?? payload?.developDefaults ?? metadata?.develop;
  return {
    name: preset.name,
    pattern: preset.template.pattern,
    title: textValue(metadata?.title),
    caption: textValue(metadata?.caption),
    copyright: textValue(metadata?.copyright),
    keywords: keywordsValue(metadata?.keywords),
    develop: develop === undefined || develop === null ? "" : JSON.stringify(develop, null, 2),
  };
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.length > 0 ? reason.message : fallback;
}

function rootLabel(root: CatalogRootState): string {
  return root.label + " · " + root.health;
}

export function CatalogManualImportPanel({ disabled }: { readonly disabled: boolean }) {
  const catalogId = useLibraryStore((state) => state.catalogId);
  const sessionId = useLibraryStore((state) => state.sessionId);
  const roots = useLibraryStore((state) => state.catalogRoots);
  const presets = useLibraryStore((state) => state.importPresets);
  const addCatalogRoot = useLibraryStore((state) => state.addCatalogRoot);
  const [action, setAction] = useState<Action>("add");
  const [destinationRootId, setDestinationRootId] = useState<RootId | null | undefined>(undefined);
  const [presetId, setPresetId] = useState<PresetId | null | undefined>(undefined);
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>("skip-incoming");
  const [destinationPolicy, setDestinationPolicy] = useState<DestinationPolicy>("skip");
  const [draft, setDraft] = useState<CatalogImportDraftView | null>(null);
  const [result, setResult] = useState<CatalogImportExecutionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [editingPresetId, setEditingPresetId] = useState<PresetId | null>(null);
  const [presetName, setPresetName] = useState("");
  const [pattern, setPattern] = useState("{{filename}}");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [copyright, setCopyright] = useState("");
  const [keywords, setKeywords] = useState("");
  const [develop, setDevelop] = useState("");
  const [presetDefault, setPresetDefault] = useState(false);

  const activeSessionId = sessionId === null ? null : parseSessionId(sessionId);
  const onlineRoots = roots.filter((root) => root.health === "online");
  const effectiveDestinationRootId = destinationRootId !== undefined && destinationRootId !== null && onlineRoots.some((root) => root.rootId === destinationRootId)
    ? destinationRootId
    : onlineRoots[0]?.rootId ?? null;
  const defaultPreset = presets.find((preset) => preset.isDefault) ?? presets[0];
  const effectivePresetId = presetId === undefined
    ? defaultPreset === undefined ? null : parsePresetId(defaultPreset.presetId)
    : presetId;
  const activeRoot = effectiveDestinationRootId === null
    ? null
    : onlineRoots.find((root) => root.rootId === effectiveDestinationRootId) ?? null;
  const operationBusy = disabled || busy || running;

  function selectPreset(value: string): void {
    if (value.length === 0) {
      setPresetId(null);
      return;
    }
    const selected = presets.find((preset) => preset.presetId === value);
    if (selected === undefined) return;
    setPresetId(parsePresetId(value));
    loadPreset(selected);
  }

  function loadPreset(preset: CatalogPresetView): void {
    const fields = presetFields(preset);
    setEditingPresetId(parsePresetId(preset.presetId));
    setPresetName(fields.name);
    setPattern(fields.pattern);
    setTitle(fields.title);
    setCaption(fields.caption);
    setCopyright(fields.copyright);
    setKeywords(fields.keywords);
    setDevelop(fields.develop);
    setPresetDefault(preset.isDefault);
  }

  function newPreset(): void {
    const fields = presetFields(undefined);
    setEditingPresetId(null);
    setPresetName("");
    setPattern(fields.pattern);
    setTitle("");
    setCaption("");
    setCopyright("");
    setKeywords("");
    setDevelop("");
    setPresetDefault(false);
  }

  async function handlePrepare(): Promise<void> {
    if (catalogId === null || activeSessionId === null || effectiveDestinationRootId === null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setResult(null);
    try {
      const next = await prepareCatalogImport({
        catalogId,
        sessionId: activeSessionId,
        action,
        destinationRootId: effectiveDestinationRootId,
        presetId: effectivePresetId,
        duplicatePolicy,
        destinationPolicy,
      });
      setDraft(next);
      setStatus("Review the placement before running.");
    } catch (reason) {
      setError(errorMessage(reason, "Import could not be prepared."));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (draft === null) return;
    if (running) {
      setCancelling(true);
      setError(null);
      try {
        await cancelCatalogImport(draft.operationId);
        setStatus("Cancellation requested.");
      } catch (reason) {
        setError(errorMessage(reason, "Import cancellation failed."));
      } finally {
        setCancelling(false);
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await cancelCatalogImport(draft.operationId);
      setDraft(null);
      setResult(null);
      setStatus("Import cancelled.");
    } catch (reason) {
      setError(errorMessage(reason, "Import cancellation failed."));
    } finally {
      setBusy(false);
    }
  }

  async function handleRun(): Promise<void> {
    if (draft === null || !draft.canRun) return;
    setRunning(true);
    setError(null);
    setStatus(null);
    try {
      const next = await runCatalogImport(draft.operationId);
      setResult(next);
      setDraft(null);
      setStatus(next.state === "completed" ? "Import complete." : "Import " + next.state + ".");
    } catch (reason) {
      setError(errorMessage(reason, "Import failed."));
    } finally {
      setRunning(false);
      setBusy(false);
    }
  }

  async function handleSavePreset(): Promise<void> {
    if (catalogId === null || activeSessionId === null || presetName.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const parsedDevelop: JsonValue | null = develop.trim().length === 0
        ? null
        : parseJsonValue(JSON.parse(develop), "Develop defaults");
      const payload: JsonValue = {
        metadata: {
          title: title.trim().length === 0 ? null : title.trim(),
          caption: caption.trim().length === 0 ? null : caption.trim(),
          copyright: copyright.trim().length === 0 ? null : copyright.trim(),
          keywords: keywords.split(",").map((item) => item.trim()).filter((item) => item.length > 0),
        },
        develop: parsedDevelop,
      };
      await saveImportPreset({
        ...(editingPresetId === null ? {} : { presetId: editingPresetId }),
        name: presetName.trim(),
        templatePattern: pattern,
        payload,
        isDefault: presetDefault,
      });
      await refreshActiveCatalog();
      setStatus("Import preset saved.");
    } catch (reason) {
      setError(errorMessage(reason, "Import preset could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePreset(): Promise<void> {
    if (editingPresetId === null) return;
    setBusy(true);
    setError(null);
    try {
      await deleteImportPreset(editingPresetId);
      await refreshActiveCatalog();
      newPreset();
      setPresetId(null);
      setStatus("Import preset deleted.");
    } catch (reason) {
      setError(errorMessage(reason, "Import preset could not be deleted."));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetDefault(): Promise<void> {
    if (editingPresetId === null) return;
    setBusy(true);
    setError(null);
    try {
      await setDefaultImportPreset(editingPresetId);
      await refreshActiveCatalog();
      setPresetDefault(true);
      setStatus("Default import preset updated.");
    } catch (reason) {
      setError(errorMessage(reason, "Default import preset could not be updated."));
    } finally {
      setBusy(false);
    }
  }

  if (catalogId === null || activeSessionId === null) return null;

  return (
    <details className="rounded-lg border border-lr-border-subtle bg-lr-panel px-3 py-2.5">
      <summary className="cursor-pointer text-xs font-medium text-lr-text">Manual import</summary>
      <div className="mt-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] leading-4 text-lr-text-faint">
            Add, Copy, and Move use files already inside a linked root. Add a root first when a picker source is external.
          </p>
          <button type="button" onClick={() => void addCatalogRoot()} disabled={operationBusy} className={BUTTON_CLASS}>Link source root</button>
        </div>

        <section aria-labelledby="manual-import-source-title" className="space-y-2">
          <h3 id="manual-import-source-title" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Source and placement</h3>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-lr-text-muted">
              Action
              <select value={action} onChange={(event) => setAction(event.target.value as Action)} disabled={operationBusy || draft !== null} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                <option value="add">Add</option>
                <option value="copy">Copy</option>
                <option value="move">Move</option>
              </select>
            </label>
            <label className="text-[11px] text-lr-text-muted">
              Destination root
              <select value={effectiveDestinationRootId ?? ""} onChange={(event) => setDestinationRootId(event.target.value.length === 0 ? null : parseRootId(event.target.value))} disabled={operationBusy || draft !== null || onlineRoots.length === 0} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                {onlineRoots.map((root) => <option key={root.rootId} value={root.rootId}>{rootLabel(root)}</option>)}
              </select>
            </label>
          </div>
          <label className="block text-[11px] text-lr-text-muted">
            Import preset
            <select value={effectivePresetId ?? ""} onChange={(event) => selectPreset(event.target.value)} disabled={operationBusy || draft !== null} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
              <option value="">Built-in · {"{{filename}}"}</option>
              {presets.map((preset) => <option key={preset.presetId} value={preset.presetId}>{preset.name}{preset.isDefault ? " · default" : ""}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-lr-text-muted">
              Duplicates
              <select value={duplicatePolicy} onChange={(event) => setDuplicatePolicy(event.target.value as DuplicatePolicy)} disabled={operationBusy || draft !== null} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                <option value="skip-incoming">Skip incoming</option>
                <option value="keep-both">Keep both</option>
                <option value="continue-unchecked">Continue unchecked</option>
              </select>
            </label>
            <label className="text-[11px] text-lr-text-muted">
              Destination conflicts
              <select value={destinationPolicy} onChange={(event) => setDestinationPolicy(event.target.value as DestinationPolicy)} disabled={operationBusy || draft !== null} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                <option value="skip">Skip</option>
                <option value="rename">Rename</option>
                <option value="replace" disabled>Replace · unavailable</option>
              </select>
            </label>
          </div>
          {onlineRoots.length === 0 ? (
            <p className="text-[11px] text-amber-300">Link an active root before preparing an import.</p>
          ) : null}
          {activeRoot === null && onlineRoots.length > 0 ? <p className="text-[11px] text-amber-300">Choose an online destination root.</p> : null}
        </section>

        <div className="flex items-center justify-end gap-2">
          {draft === null ? (
            <button type="button" onClick={() => void handlePrepare()} disabled={operationBusy || activeRoot === null} className={PRIMARY_BUTTON_CLASS}>Prepare review</button>
          ) : (
            <>
              <button type="button" onClick={() => void handleCancel()} disabled={disabled || (!running && busy) || cancelling} className={BUTTON_CLASS}>{cancelling ? "Cancelling…" : "Cancel"}</button>
              <button type="button" onClick={() => void handleRun()} disabled={operationBusy || !draft.canRun} className={PRIMARY_BUTTON_CLASS}>Run import</button>
            </>
          )}
        </div>

        {draft !== null ? (
          <section aria-labelledby="manual-import-review-title" className="rounded border border-lr-border-subtle bg-lr-panel-raised p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 id="manual-import-review-title" className="text-xs font-medium text-lr-text">Review</h3>
                <p className="mt-0.5 text-[10px] text-lr-text-faint">Preset: {draft.presetName} · {draft.items.length} selected</p>
              </div>
              <span className={draft.canRun ? "text-[10px] text-emerald-300" : "text-[10px] text-amber-300"}>{draft.canRun ? "Ready" : "Blocked"}</span>
            </div>
            <p className="mt-2 text-[10px] leading-4 text-lr-text-faint">Copy as DNG: unavailable · {draft.copyAsDng.reason}</p>
            <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">
              {draft.items.map((item) => (
                <li key={item.itemId} className="rounded border border-lr-border-subtle px-2 py-1.5 text-[10px]">
                  <div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-lr-text" title={item.sourceRelativePath}>{item.sourceName}</span><span className="shrink-0 text-lr-text-faint">{item.formatId}</span></div>
                  <p className="mt-0.5 truncate text-lr-text-faint" title={item.destinationRelativePath}>{item.sourceRelativePath} → {item.destinationRelativePath}</p>
                  <p className="mt-0.5 text-lr-text-muted">{item.duplicate} · {item.destinationConflict ? "conflict" : "clear"} · {item.outcome}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {result !== null ? (
          <section aria-labelledby="manual-import-summary-title" className="rounded border border-lr-border-subtle bg-lr-panel-raised p-2.5">
            <h3 id="manual-import-summary-title" className="text-xs font-medium text-lr-text">Summary · {result.state}</h3>
            <ul className="mt-2 space-y-1 text-[10px] text-lr-text-muted">
              {result.items.map((item) => <li key={item.itemId}>{item.status} · {item.stage}{item.sourceRetained ? " · source retained" : ""}{item.error ? " · " + item.error : ""}</li>)}
            </ul>
          </section>
        ) : null}

        <details className="border-t border-lr-border-subtle pt-2.5">
          <summary className="cursor-pointer text-xs text-lr-text">Preset editor</summary>
          <div className="mt-2 space-y-2">
            <div className="flex gap-2">
              <select value={editingPresetId ?? ""} onChange={(event) => {
                const selected = presets.find((preset) => preset.presetId === event.target.value);
                if (selected === undefined) newPreset(); else loadPreset(selected);
              }} disabled={operationBusy} className="min-w-0 flex-1 rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                <option value="">New preset</option>
                {presets.map((preset) => <option key={preset.presetId} value={preset.presetId}>{preset.name}</option>)}
              </select>
              <button type="button" onClick={newPreset} disabled={operationBusy} className={BUTTON_CLASS}>New</button>
            </div>
            <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Preset name" aria-label="Preset name" disabled={operationBusy} className="w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" />
            <input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="Pattern, e.g. {{filename}}" aria-label="Import filename pattern" disabled={operationBusy} className="w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" />
            <div className="grid grid-cols-2 gap-2">
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" aria-label="Preset title" disabled={operationBusy} className="rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" />
              <input value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Caption" aria-label="Preset caption" disabled={operationBusy} className="rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" />
              <input value={copyright} onChange={(event) => setCopyright(event.target.value)} placeholder="Copyright" aria-label="Preset copyright" disabled={operationBusy} className="rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" />
              <input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="Keywords, comma-separated" aria-label="Preset keywords" disabled={operationBusy} className="rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" />
            </div>
            <textarea value={develop} onChange={(event) => setDevelop(event.target.value)} placeholder="Develop defaults JSON" aria-label="Develop defaults JSON" disabled={operationBusy} rows={3} className="w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 font-mono text-[10px] text-lr-text" />
            <label className="flex items-center gap-2 text-[11px] text-lr-text-muted"><input type="checkbox" checked={presetDefault} onChange={(event) => setPresetDefault(event.target.checked)} disabled={operationBusy} /> Default preset</label>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => void handleDeletePreset()} disabled={operationBusy || editingPresetId === null} className={BUTTON_CLASS}>Delete</button>
              <button type="button" onClick={() => void handleSetDefault()} disabled={operationBusy || editingPresetId === null || presetDefault} className={BUTTON_CLASS}>Set default</button>
              <button type="button" onClick={() => void handleSavePreset()} disabled={operationBusy || presetName.trim().length === 0} className={PRIMARY_BUTTON_CLASS}>Save preset</button>
            </div>
          </div>
        </details>

        {status ? <p className="text-[11px] text-lr-text-muted" role="status">{status}</p> : null}
        {error ? <p className="text-[11px] text-red-300" role="alert">{error}</p> : null}
      </div>
    </details>
  );
}
