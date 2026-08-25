"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { parseEntryId } from "@/lib/catalog/ids";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import { refreshActiveCatalog } from "@/lib/fs/session-catalog";
import { DEVELOP_PRESET_FIELDS, type DevelopPresetField } from "@/lib/develop/presets/policy";
import type { DevelopPresetRecord } from "@/lib/develop/presets/schema";
import { createDevelopBatchId, createDevelopBatchOperationId, developBatchPreparationIsPending, DEVELOP_BATCH_CONTROLS, parseDevelopBatchControl, type DevelopBatchControl, type DevelopBatchId, type DevelopBatchReceipt } from "@/lib/develop/batch/domain";
import type { DevelopBatchSelectedOperation } from "@/lib/develop/batch/api";
import { useLibraryStore } from "@/stores/library-store";

const FIELD_LABELS = {
  basic: "Basic",
  mixer: "Color mixer",
  effects: "Effects",
  "tone-curves": "Tone curves",
  "camera-profile": "Camera profile",
  crop: "Crop",
  "manual-masks": "Manual masks",
  "ai-masks": "AI masks",
} as const satisfies Record<DevelopPresetField, string>;

const DEFAULT_FIELDS: readonly DevelopPresetField[] = ["basic", "mixer", "effects", "tone-curves"];
const CONTROL_LABELS = {
  exposure: "Exposure", contrast: "Contrast", highlights: "Highlights", shadows: "Shadows", whites: "Whites", blacks: "Blacks",
  vibrance: "Vibrance", saturation: "Saturation", texture: "Texture", clarity: "Clarity", dehaze: "Dehaze",
} as const satisfies Record<DevelopBatchControl, string>;

type Mode = "previous" | "sync" | "batch";
type BatchAction = "preset" | "clipboard" | "section-reset" | "selected-control";

function batchActionFromValue(value: string): BatchAction {
  if (value === "preset" || value === "clipboard" || value === "section-reset" || value === "selected-control") return value;
  return "section-reset";
}

function terminal(receipt: DevelopBatchReceipt): boolean {
  return receipt.items.every((item) => item.state.kind !== "queued" && item.state.kind !== "active");
}

function actionLabel(receipt: DevelopBatchReceipt): string {
  const operation = receipt.operation.kind === "frozen" ? receipt.operation.action : receipt.operation;
  if (receipt.kind === "previous") return "Previous";
  if (receipt.kind === "sync") return "Sync";
  if (receipt.kind === "auto-sync") return "Auto Sync";
  if (receipt.kind === "undo") return "Undo batch";
  switch (operation.kind) {
    case "preset": return "Preset";
    case "paste-settings": return "Paste settings";
    case "section-reset": return "Reset section";
    case "selected-control": return "Copy control";
    case "copy-fields": return "Copy fields";
    case "undo": return "Undo batch";
    default: { const exhaustive: never = operation; return exhaustive; }
  }
}

function stateLabel(receipt: DevelopBatchReceipt): string {
  if (developBatchPreparationIsPending(receipt.operation) && receipt.items.some((item) => item.state.kind === "queued")) return "preparing";
  const active = receipt.items.find((item) => item.state.kind === "active");
  if (active?.state.kind === "active") return active.state.phase;
  const counts = new Map<string, number>();
  for (const item of receipt.items) counts.set(item.state.kind, (counts.get(item.state.kind) ?? 0) + 1);
  return ["completed", "skipped", "cancelled", "failed", "queued"].flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    return count > 0 ? [`${count} ${kind}`] : [];
  }).join(" · ");
}

export function DevelopBatchPanel({ sourceEntry, onClose }: { readonly sourceEntry: LibraryEntry; readonly onClose: () => void }) {
  const selection = useLibraryStore((state) => state.selectedEntryIds);
  const [mode, setMode] = useState<Mode>(selection.length > 1 ? "sync" : "previous");
  const [fields, setFields] = useState<ReadonlySet<DevelopPresetField>>(() => new Set(DEFAULT_FIELDS));
  const [batchAction, setBatchAction] = useState<BatchAction>("section-reset");
  const [control, setControl] = useState<DevelopBatchControl>("exposure");
  const [presets, setPresets] = useState<readonly DevelopPresetRecord[]>([]);
  const [presetId, setPresetId] = useState<string>("");
  const [receipts, setReceipts] = useState<readonly DevelopBatchReceipt[]>([]);
  const [autoSync, setAutoSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparingBatchId, setPreparingBatchId] = useState<DevelopBatchId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const available = isElectronApp();
  const frozenTargets = useMemo(() => selection.filter((entryId) => entryId !== sourceEntry.id), [selection, sourceEntry.id]);
  const selectedFields = useMemo(() => DEVELOP_PRESET_FIELDS.filter((field) => fields.has(field)), [fields]);
  const fieldsRequired = mode !== "batch" || batchAction !== "selected-control";

  const refresh = useCallback(async () => {
    if (!available) return;
    const next = await getDarkroomAPI().developBatchList({ catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId, limit: 100 });
    setReceipts(next);
  }, [available, sourceEntry.catalogId, sourceEntry.sessionId]);

  useEffect(() => {
    if (!available) return;
    const initial = window.setTimeout(() => {
      void Promise.all([
        refresh(),
        getDarkroomAPI().developPresetsList({ query: "", category: null, favoriteOnly: false }),
        getDarkroomAPI().developBatchAutoState({ catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId }),
      ]).then(([, nextPresets, autoState]) => {
        setPresets(nextPresets);
        setPresetId((current) => current || nextPresets[0]?.presetId || "");
        setAutoSync(autoState.enabled && autoState.sourceEntryId === sourceEntry.id);
        if (autoState.enabled && autoState.sourceEntryId === sourceEntry.id) setFields(new Set(autoState.fields));
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Batch controls are unavailable."));
    }, 0);
    const unsubscribe = getDarkroomAPI().onDevelopBatchUpdated((update) => {
      if (update.catalogId === sourceEntry.catalogId) setReceipts(update.receipts);
    });
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 700);
    return () => { unsubscribe(); window.clearInterval(timer); window.clearTimeout(initial); };
  }, [available, refresh, sourceEntry.catalogId, sourceEntry.id, sourceEntry.sessionId]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>("button, input, select")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab") return;
      const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])].filter((element) => element.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (event.shiftKey && (active === first || !active || !controls.includes(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !active || !controls.includes(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [busy, onClose]);

  const run = async (): Promise<void> => {
    if (!available || (fieldsRequired && selectedFields.length === 0)) return;
    setBusy(true);
    setError(null);
    const batchId = createDevelopBatchId();
    const operationId = createDevelopBatchOperationId();
    setPreparingBatchId(batchId);
    try {
      if (mode === "previous") {
        await getDarkroomAPI().developBatchStart({ kind: "previous", catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId, batchId, operationId, currentEntryId: sourceEntry.id, fields: selectedFields });
      } else if (mode === "sync") {
        if (frozenTargets.length === 0) throw new Error("Select at least one target in Library.");
        await getDarkroomAPI().developBatchStart({ kind: "sync", catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId, batchId, operationId, sourceEntryId: sourceEntry.id, targetEntryIds: frozenTargets.map(parseEntryId), fields: selectedFields });
      } else {
        if (selection.length === 0) throw new Error("Select at least one Library photo.");
        let operation: DevelopBatchSelectedOperation;
        if (batchAction === "preset") {
          const preset = presets.find((candidate) => candidate.presetId === presetId);
          if (!preset) throw new Error("Choose a preset.");
          operation = { kind: "preset", presetId: preset.presetId, revision: preset.revision, fields: selectedFields, amount: 100 };
        } else if (batchAction === "clipboard") operation = { kind: "clipboard", fields: selectedFields };
        else if (batchAction === "section-reset") operation = { kind: "section-reset", fields: selectedFields };
        else {
          operation = { kind: "selected-control", control };
        }
        await getDarkroomAPI().developBatchStart({ kind: "batch", catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId, batchId, operationId, sourceEntryId: sourceEntry.id, targetEntryIds: selection.map(parseEntryId), operation });
      }
      await refresh();
      await refreshActiveCatalog();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The batch could not start.");
    } finally {
      setPreparingBatchId(null);
      setBusy(false);
    }
  };

  const cancelPreparation = async (): Promise<void> => {
    if (preparingBatchId === null) return;
    try {
      await getDarkroomAPI().developBatchCancel({ catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId, batchId: preparingBatchId });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Batch preparation could not be cancelled.");
    }
  };

  const toggleAutoSync = async (): Promise<void> => {
    if (!available) return;
    setBusy(true);
    setError(null);
    try {
      if (autoSync) {
        await getDarkroomAPI().developBatchAutoDisable({ catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId });
        setAutoSync(false);
      } else {
        if (frozenTargets.length === 0) throw new Error("Select at least one Auto Sync target.");
        await getDarkroomAPI().developBatchAutoEnable({ catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId, sourceEntryId: sourceEntry.id, targetEntryIds: frozenTargets.map(parseEntryId), fields: selectedFields });
        setAutoSync(true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Auto Sync could not change.");
    } finally { setBusy(false); }
  };

  const targetAction = async (receipt: DevelopBatchReceipt, kind: "cancel" | "retry" | "undo") => {
    setBusy(true);
    setError(null);
    const request = { catalogId: sourceEntry.catalogId, sessionId: sourceEntry.sessionId, batchId: receipt.batchId };
    try {
      if (kind === "cancel") await getDarkroomAPI().developBatchCancel(request);
      else if (kind === "retry") await getDarkroomAPI().developBatchRetry(request);
      else await getDarkroomAPI().developBatchUndo(request);
      await refresh();
      await refreshActiveCatalog();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Batch action failed."); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-stretch justify-end bg-black/55" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <aside ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="develop-batch-title" className="flex w-full max-w-[620px] flex-col border-l border-lr-border bg-lr-panel shadow-2xl">
        <header className="flex items-start gap-3 border-b border-lr-border-subtle px-5 py-4">
          <div className="min-w-0 flex-1"><h2 id="develop-batch-title" className="text-sm font-semibold text-lr-text">Batch Develop</h2><p className="mt-1 text-[10px] text-lr-text-muted">1 source · {frozenTargets.length} sync target{frozenTargets.length === 1 ? "" : "s"} · {selection.length} batch target{selection.length === 1 ? "" : "s"}. Targets freeze when the job starts.</p></div>
          <button type="button" onClick={onClose} disabled={busy} className="rounded px-2 py-1 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text">Close</button>
        </header>
        {!available ? <div className="m-5 rounded border border-lr-danger/40 bg-lr-danger/10 p-3 text-xs text-lr-danger">Batch Develop requires the desktop app.</div> : null}
        <div className="grid min-h-0 flex-1 grid-rows-[auto_auto_1fr] overflow-hidden">
          <section className="grid grid-cols-3 gap-1 border-b border-lr-border-subtle p-4" aria-label="Batch mode">
            {(["previous", "sync", "batch"] as const).map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)} className={`rounded px-3 py-2 text-[11px] font-medium capitalize ${mode === item ? "bg-lr-accent text-lr-bg" : "bg-lr-panel-raised text-lr-text-muted hover:text-lr-text"}`}>{item === "batch" ? "Batch Develop" : item}</button>)}
          </section>
          <section className="border-b border-lr-border-subtle px-5 py-4">
            {mode === "batch" ? <label className="mb-3 block text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-muted">Operation<select value={batchAction} onChange={(event) => setBatchAction(batchActionFromValue(event.target.value))} className="mt-1.5 w-full rounded border border-lr-border bg-lr-panel-raised px-2 py-2 text-xs text-lr-text"><option value="section-reset">Reset selected sections</option><option value="clipboard">Paste settings</option><option value="preset">Apply preset</option><option value="selected-control">Copy selected control</option></select></label> : null}
            {mode === "batch" && batchAction === "preset" ? <label className="mb-3 block text-[10px] text-lr-text-muted">Preset<select value={presetId} onChange={(event) => setPresetId(event.target.value)} className="mt-1.5 w-full rounded border border-lr-border bg-lr-panel-raised px-2 py-2 text-xs text-lr-text">{presets.map((preset) => <option key={`${preset.presetId}:${preset.revision}`} value={preset.presetId}>{preset.name} · r{preset.revision}</option>)}</select></label> : null}
            {mode === "batch" && batchAction === "selected-control" ? <label className="mb-3 block text-[10px] text-lr-text-muted">Control<select value={control} onChange={(event) => setControl(parseDevelopBatchControl(event.target.value))} className="mt-1.5 w-full rounded border border-lr-border bg-lr-panel-raised px-2 py-2 text-xs text-lr-text">{DEVELOP_BATCH_CONTROLS.map((item) => <option key={item} value={item}>{CONTROL_LABELS[item]}</option>)}</select></label> : <fieldset><legend className="text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-muted">Fields</legend><div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">{DEVELOP_PRESET_FIELDS.map((field) => <label key={field} className="flex items-center gap-2 text-[11px] text-lr-text"><input type="checkbox" checked={fields.has(field)} onChange={() => setFields((current) => { const next = new Set(current); if (next.has(field)) next.delete(field); else next.add(field); return next; })} className="accent-lr-accent" />{FIELD_LABELS[field]}</label>)}</div></fieldset>}
            <div className="mt-4 flex items-center gap-2"><button type="button" onClick={() => void run()} disabled={!available || busy || (fieldsRequired && selectedFields.length === 0)} className="rounded bg-lr-accent px-3 py-2 text-[11px] font-semibold text-lr-bg disabled:opacity-40">{busy ? "Working…" : mode === "previous" ? "Apply Previous" : mode === "sync" ? `Sync ${frozenTargets.length}` : `Run on ${selection.length}`}</button>{preparingBatchId !== null ? <button type="button" onClick={() => void cancelPreparation()} className="rounded border border-lr-danger/60 px-3 py-2 text-[11px] text-lr-danger">Cancel preparation</button> : <button type="button" onClick={() => void toggleAutoSync()} disabled={!available || busy || selectedFields.length === 0} aria-pressed={autoSync} className="rounded border border-lr-border px-3 py-2 text-[11px] text-lr-text">Auto Sync {autoSync ? "On" : "Off"}</button>}</div>
            {error ? <p role="alert" className="mt-3 text-[11px] leading-4 text-lr-danger">{error}</p> : null}
          </section>
          <section className="min-h-0 overflow-auto px-5 py-4" aria-label="Durable batch jobs">
            <div className="mb-3 flex items-center justify-between"><h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-muted">Durable jobs</h3><button type="button" onClick={() => void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Batch jobs could not refresh."))} className="text-[10px] text-lr-accent">Refresh</button></div>
            {receipts.length === 0 ? <p className="text-xs text-lr-text-faint">No batch receipts yet. Completed and interrupted jobs appear here after restart.</p> : <div className="space-y-2">{receipts.map((receipt) => { const cancelled = receipt.items.some((item) => item.state.kind === "cancelled"); const unresolved = receipt.items.some((item) => item.state.kind === "failed" && item.state.retryable || item.state.kind === "cancelled"); const completed = receipt.items.some((item) => item.state.kind === "completed"); return <article key={receipt.batchId} className="rounded border border-lr-border-subtle bg-lr-panel-raised/55 p-3"><div className="flex items-center gap-2"><strong className="text-[11px] text-lr-text">{actionLabel(receipt)}</strong><span className="text-[10px] capitalize text-lr-text-muted">{stateLabel(receipt)}</span><span className="flex-1" />{!terminal(receipt) ? <button type="button" onClick={() => void targetAction(receipt, "cancel")} className="text-[10px] text-lr-danger">Cancel</button> : null}{unresolved ? <button type="button" onClick={() => void targetAction(receipt, "retry")} className="text-[10px] text-lr-accent">{cancelled ? "Resume" : "Retry"}</button> : null}{terminal(receipt) && completed && receipt.kind !== "undo" ? <button type="button" onClick={() => void targetAction(receipt, "undo")} className="text-[10px] text-lr-text">Undo batch</button> : null}</div><div className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">{receipt.items.map((item) => <div key={item.operationId} className="contents"><span className="truncate text-[10px] text-lr-text-muted">{item.position + 1}. {item.entryId.slice(0, 8)}</span><span className={`text-[10px] capitalize ${item.state.kind === "failed" ? "text-lr-danger" : item.state.kind === "completed" ? "text-lr-accent" : "text-lr-text-faint"}`}>{item.state.kind === "active" ? item.state.phase : item.state.kind}</span>{item.state.kind === "failed" || item.state.kind === "skipped" ? <span className="col-span-2 text-[9px] leading-4 text-lr-text-faint">{item.state.kind === "failed" ? item.state.error : item.state.reason}</span> : null}{item.state.kind === "completed" && item.state.warnings.length > 0 ? <span className="col-span-2 text-[9px] leading-4 text-lr-text-faint">{item.state.warnings.join(" · ")}</span> : null}</div>)}</div></article>; })}</div>}
          </section>
        </div>
      </aside>
    </div>
  );
}
