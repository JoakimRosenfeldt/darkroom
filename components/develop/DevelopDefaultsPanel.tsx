"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionButton, StatusCard } from "@/components/develop/V3PanelControls";
import type { DevelopDefaultFacts } from "@/lib/develop/defaults/matcher";
import {
  createDevelopDefaultRuleId,
  parseDevelopDefaultRule,
  type DevelopDefaultRule,
} from "@/lib/develop/defaults/schema";
import type { InstalledDevelopDefault } from "@/lib/develop/defaults/installed";
import { DEVELOP_PRESET_FIELDS, type DevelopPresetField, type DevelopPresetRecord } from "@/lib/develop/presets/schema";
import { getDevelopRepository } from "@/lib/develop/repository";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import type { LibraryEntry } from "@/lib/fs/types";
import { useDevelopStore } from "@/stores/develop-store";

const FIELD_LABELS: Readonly<Record<DevelopPresetField, string>> = {
  basic: "Basic",
  mixer: "Color mixer",
  effects: "Effects",
  "tone-curves": "Tone curves",
  "camera-profile": "Camera profile",
  crop: "Crop",
  "manual-masks": "Manual masks",
  "ai-masks": "AI masks",
};

type SelectorKind = "exact" | "wildcard" | "unknown";

function selectorKind(value: string): SelectorKind {
  if (value === "exact" || value === "wildcard" || value === "unknown") return value;
  throw new Error("Default profile selector is invalid.");
}

interface RuleDraft {
  readonly name: string;
  readonly priority: string;
  readonly enabled: boolean;
  readonly camera: "exact" | "unknown";
  readonly rawProfile: SelectorKind;
  readonly iso: "range" | "unknown";
  readonly isoMinimum: string;
  readonly isoMaximum: string;
  readonly presetKey: string;
  readonly fields: readonly DevelopPresetField[];
}

function presetKey(preset: Pick<DevelopPresetRecord, "presetId" | "revision">): string {
  return `${preset.presetId}:${preset.revision}`;
}

function defaultDraft(facts: DevelopDefaultFacts, presets: readonly DevelopPresetRecord[]): RuleDraft {
  const preset = presets[0] ?? null;
  const iso = facts.iso.kind === "known" ? String(facts.iso.value) : "100";
  return {
    name: "New camera default",
    priority: "0",
    enabled: true,
    camera: facts.camera.kind === "known" ? "exact" : "unknown",
    rawProfile: facts.decoder.kind === "known" && facts.inputProfile.kind === "known" ? "exact" : "unknown",
    iso: facts.iso.kind === "known" ? "range" : "unknown",
    isoMinimum: iso,
    isoMaximum: iso,
    presetKey: preset ? presetKey(preset) : "",
    fields: preset?.fields.filter((field) => field !== "ai-masks") ?? ["basic"],
  };
}

function draftFromRule(rule: DevelopDefaultRule): RuleDraft {
  return {
    name: rule.name,
    priority: String(rule.priority),
    enabled: rule.enabled,
    camera: rule.camera.kind,
    rawProfile: rule.rawProfile.kind,
    iso: rule.iso.kind,
    isoMinimum: rule.iso.kind === "range" ? String(rule.iso.minimum) : "100",
    isoMaximum: rule.iso.kind === "range" ? String(rule.iso.maximum) : "100",
    presetKey: `${rule.preset.presetId}:${rule.preset.presetRevision}`,
    fields: rule.preset.selectedFields,
  };
}

function number(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a whole number.`);
  return parsed;
}

function buildRule(
  draft: RuleDraft,
  facts: DevelopDefaultFacts,
  presets: readonly DevelopPresetRecord[],
  existing: DevelopDefaultRule | null,
): DevelopDefaultRule {
  const preset = presets.find((candidate) => presetKey(candidate) === draft.presetKey);
  if (!preset) throw new Error("Choose an available preset revision.");
  if (draft.fields.length === 0) throw new Error("Choose at least one preset field.");
  const now = Date.now();
  return parseDevelopDefaultRule({
    schemaVersion: 1,
    ruleId: existing?.ruleId ?? createDevelopDefaultRuleId(),
    revision: existing ? existing.revision + 1 : 1,
    name: draft.name,
    enabled: draft.enabled,
    priority: number(draft.priority, "Priority"),
    camera: draft.camera === "unknown"
      ? { kind: "unknown" }
      : facts.camera.kind === "known"
        ? { kind: "exact", make: facts.camera.make, model: facts.camera.model }
        : (() => { throw new Error("This photo has no verified camera identity."); })(),
    rawProfile: draft.rawProfile === "wildcard"
      ? { kind: "wildcard" }
      : draft.rawProfile === "unknown"
        ? { kind: "unknown" }
        : facts.decoder.kind === "known" && facts.inputProfile.kind === "known"
          ? {
              kind: "exact",
              decoderId: facts.decoder.value,
              profileId: facts.inputProfile.profileId,
              profileRevision: facts.inputProfile.profileRevision,
            }
          : (() => { throw new Error("This photo has no verified before-tone input profile."); })(),
    iso: draft.iso === "unknown"
      ? { kind: "unknown" }
      : { kind: "range", minimum: number(draft.isoMinimum, "Minimum ISO"), maximum: number(draft.isoMaximum, "Maximum ISO") },
    preset: { presetId: preset.presetId, presetRevision: preset.revision, selectedFields: draft.fields },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

export function DevelopDefaultsPanel({ entry, facts }: { readonly entry: LibraryEntry; readonly facts: DevelopDefaultFacts }) {
  const session = useDevelopStore((state) => state.sessions[entry.id]);
  const commitCompleteState = useDevelopStore((state) => state.commitV3CompleteState);
  const [rules, setRules] = useState<readonly DevelopDefaultRule[]>([]);
  const [presets, setPresets] = useState<readonly DevelopPresetRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(() => defaultDraft(facts, []));
  const [installed, setInstalled] = useState<InstalledDevelopDefault | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<NonNullable<Window["darkroom"]>["developDefaultsPreview"]>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const selected = useMemo(() => rules.find((rule) => rule.ruleId === selectedId) ?? null, [rules, selectedId]);
  const durable = session?.processKind === "v3" && session.ui.sidecarStatus === "saved";
  const controlsMessage = session?.processKind !== "v3"
    ? "This photo is read-only or uses a newer Develop process. Rules remain viewable, but editing and reset are unavailable."
    : "Rule controls unlock after the initial Develop Head is durable.";

  const refresh = useCallback(async (): Promise<void> => {
    if (!isElectronApp()) return;
    const current = ++generation.current;
    const api = getDarkroomAPI();
    const [nextRules, nextPresets, nextInstalled, nextPreview] = await Promise.all([
      api.developDefaultsList(),
      api.developPresetsList({ query: "", category: null, favoriteOnly: false }),
      api.developDefaultsInstalled({ catalogId: entry.catalogId, sessionId: entry.sessionId, entryId: entry.id }),
      api.developDefaultsPreview({ facts }),
    ]);
    if (current !== generation.current) return;
    setRules(nextRules);
    setPresets(nextPresets);
    setInstalled(nextInstalled);
    setPreview(nextPreview);
    setDraft((currentDraft) => currentDraft.presetKey || nextPresets.length === 0
      ? currentDraft
      : defaultDraft(facts, nextPresets));
  }, [entry.catalogId, entry.id, entry.sessionId, facts]);

  useEffect(() => {
    let active = true;
    void refresh().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Develop defaults could not be loaded.");
    });
    return () => { active = false; generation.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (session?.persistedDocumentRevision === undefined) return;
    void refresh().catch(() => undefined);
  }, [refresh, session?.persistedDocumentRevision]);

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Develop default action failed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const selectRule = (rule: DevelopDefaultRule): void => {
    setSelectedId(rule.ruleId);
    setDraft(draftFromRule(rule));
  };

  const newRule = (): void => {
    setSelectedId(null);
    setDraft(defaultDraft(facts, presets));
    setError(null);
  };

  const save = (): Promise<void> => run(async () => {
    const rule = buildRule(draft, facts, presets, selected);
    const saved = selected
      ? await getDarkroomAPI().developDefaultsUpdate(rule)
      : await getDarkroomAPI().developDefaultsCreate(rule);
    setSelectedId(saved.ruleId);
    setDraft(draftFromRule(saved));
  });

  const reset = (): Promise<void> => run(async () => {
    const baseline = getDevelopRepository(entry).installedDefault() ?? installed;
    if (!baseline) throw new Error("This photo has no recorded matched default.");
    const state = useDevelopStore.getState();
    if (state.activeCatalogId !== entry.catalogId || state.activeEntryId !== entry.id) {
      throw new Error("The active photo changed before reset.");
    }
    commitCompleteState(entry.catalogId, entry.id, baseline.baselineDocument, "Reset to matched default");
    await getDevelopRepository(entry).flush();
  });

  if (!isElectronApp()) {
    return <aside className="w-[352px] shrink-0 border-l border-lr-border-subtle bg-lr-panel p-4"><StatusCard title="Defaults unavailable">Camera defaults require the Darkroom desktop app.</StatusCard></aside>;
  }

  return (
    <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel" aria-label="Develop defaults">
      <header className="border-b border-lr-border-subtle px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-xs font-semibold text-lr-text">Develop defaults</h2><p className="mt-0.5 text-[10px] text-lr-text-faint">Applied once when a new photo gets its first durable edit.</p></div>
          <ActionButton disabled={busy} onClick={newRule}>New</ActionButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? <StatusCard title="Could not update defaults" tone="danger">{error}</StatusCard> : null}
        {!durable ? <div className="mb-3"><StatusCard title={session?.processKind === "v3" ? "Preparing photo" : "Editing unavailable"}>{controlsMessage}</StatusCard></div> : null}
        <section aria-labelledby="default-rules-heading">
          <h3 id="default-rules-heading" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Rules</h3>
          {rules.length === 0 ? <p className="mt-2 text-[11px] leading-4 text-lr-text-faint">No rules yet. Create one from this photo’s verified camera facts.</p> : (
            <ul className="mt-2 space-y-1">{rules.map((rule) => (
              <li key={rule.ruleId}><button type="button" onClick={() => selectRule(rule)} className={`w-full rounded-md border px-2.5 py-2 text-left ${selectedId === rule.ruleId ? "border-lr-text-dim bg-lr-panel-raised" : "border-transparent hover:bg-lr-panel-raised/60"}`}>
                <span className="flex items-center gap-2 text-[11px] text-lr-text"><span className={`size-1.5 rounded-full ${rule.enabled ? "bg-lr-accent" : "bg-lr-text-faint"}`} /> <span className="truncate">{rule.name}</span><span className="ml-auto text-[9px] text-lr-text-faint">P{rule.priority}</span></span>
                <span className="mt-1 block truncate text-[9px] text-lr-text-faint">{rule.camera.kind === "exact" ? `${rule.camera.make} ${rule.camera.model}` : "Unknown camera fallback"}</span>
              </button></li>
            ))}</ul>
          )}
        </section>

        <section className="mt-5 border-t border-lr-border-subtle pt-4" aria-labelledby="default-editor-heading">
          <h3 id="default-editor-heading" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">{selected ? "Edit rule" : "New rule"}</h3>
          <label className="mt-2 block text-[10px] text-lr-text-muted">Name<input value={draft.name} maxLength={256} disabled={busy || !durable} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none focus:border-lr-text-dim disabled:opacity-40" /></label>
          <label className="mt-2 block text-[10px] text-lr-text-muted">Priority<input type="number" value={draft.priority} disabled={busy || !durable} onChange={(event) => setDraft({ ...draft, priority: event.target.value })} className="mt-1 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none disabled:opacity-40" /></label>
          <label className="mt-2 flex items-center gap-2 text-[11px] text-lr-text-muted"><input type="checkbox" checked={draft.enabled} disabled={busy || !durable} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="size-3.5 accent-lr-accent" /> Enabled</label>
          <label className="mt-2 block text-[10px] text-lr-text-muted">Camera<select value={draft.camera} disabled={busy || !durable} onChange={(event) => setDraft({ ...draft, camera: event.target.value === "unknown" ? "unknown" : "exact" })} className="mt-1 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text"><option value="exact" disabled={facts.camera.kind !== "known"}>{facts.camera.kind === "known" ? `Exact: ${facts.camera.make} ${facts.camera.model}` : "Exact unavailable"}</option><option value="unknown">Explicit unknown only</option></select></label>
          <label className="mt-2 block text-[10px] text-lr-text-muted">Decoder and profile<select value={draft.rawProfile} disabled={busy || !durable} onChange={(event) => setDraft({ ...draft, rawProfile: selectorKind(event.target.value) })} className="mt-1 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text"><option value="exact" disabled={facts.decoder.kind !== "known" || facts.inputProfile.kind !== "known"}>Exact verified before-tone profile</option><option value="wildcard">Any known profile</option><option value="unknown">Explicit unavailable profile</option></select></label>
          {facts.inputProfile.kind === "unknown" ? <p className="mt-1 text-[9px] leading-4 text-lr-text-faint">{facts.inputProfile.reason}</p> : null}
          <label className="mt-2 block text-[10px] text-lr-text-muted">ISO<select value={draft.iso} disabled={busy || !durable} onChange={(event) => setDraft({ ...draft, iso: event.target.value === "unknown" ? "unknown" : "range" })} className="mt-1 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text"><option value="range" disabled={facts.iso.kind !== "known"}>Inclusive range</option><option value="unknown">Explicit unknown only</option></select></label>
          {draft.iso === "range" ? <div className="mt-1 grid grid-cols-2 gap-2"><input aria-label="Minimum ISO" type="number" min="1" value={draft.isoMinimum} disabled={busy || !durable} onChange={(event) => setDraft({ ...draft, isoMinimum: event.target.value })} className="rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" /><input aria-label="Maximum ISO" type="number" min="1" value={draft.isoMaximum} disabled={busy || !durable} onChange={(event) => setDraft({ ...draft, isoMaximum: event.target.value })} className="rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" /></div> : null}
          <label className="mt-2 block text-[10px] text-lr-text-muted">Preset revision<select value={draft.presetKey} disabled={busy || !durable || presets.length === 0} onChange={(event) => { const preset = presets.find((candidate) => presetKey(candidate) === event.target.value); setDraft({ ...draft, presetKey: event.target.value, fields: preset?.fields.filter((field) => field !== "ai-masks") ?? draft.fields }); }} className="mt-1 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text"><option value="">Choose preset</option>{presets.map((preset) => <option key={presetKey(preset)} value={presetKey(preset)}>{preset.name} · r{preset.revision}</option>)}</select></label>
          <fieldset className="mt-3"><legend className="text-[10px] text-lr-text-muted">Included fields</legend><div className="mt-1 grid grid-cols-2 gap-x-2">{DEVELOP_PRESET_FIELDS.map((field) => {
            const available = field !== "ai-masks" && presets.find((preset) => presetKey(preset) === draft.presetKey)?.fields.includes(field) === true;
            return <label key={field} className={`flex items-center gap-1.5 py-1 text-[9px] ${available ? "text-lr-text-muted" : "text-lr-text-faint opacity-50"}`}><input type="checkbox" checked={draft.fields.includes(field)} disabled={!available || busy || !durable} onChange={(event) => setDraft({ ...draft, fields: event.target.checked ? [...draft.fields, field] : draft.fields.filter((candidate) => candidate !== field) })} className="size-3 accent-lr-accent" />{FIELD_LABELS[field]}</label>;
          })}</div><p className="mt-1 text-[9px] leading-4 text-lr-text-faint">Source-specific AI masks never apply as defaults.</p></fieldset>
          <div className="mt-3 flex flex-wrap gap-1.5"><ActionButton disabled={busy || !durable || presets.length === 0} onClick={() => void save()}>{selected ? "Update" : "Create"}</ActionButton>{selected ? <><ActionButton disabled={busy || !durable} onClick={() => void run(async () => { await getDarkroomAPI().developDefaultsSetEnabled({ ruleId: selected.ruleId, expectedRevision: selected.revision, enabled: !selected.enabled, updatedAt: Date.now() }); })}>{selected.enabled ? "Disable" : "Enable"}</ActionButton><ActionButton disabled={busy || !durable} onClick={() => void run(async () => { await getDarkroomAPI().developDefaultsDelete({ ruleId: selected.ruleId, expectedRevision: selected.revision }); newRule(); })}>Delete</ActionButton></> : null}</div>
        </section>

        <section className="mt-5 border-t border-lr-border-subtle pt-4" aria-labelledby="default-preview-heading">
          <h3 id="default-preview-heading" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Current photo match</h3>
          <p className="mt-2 text-[11px] text-lr-text">{preview?.kind === "matched" ? `Winner: ${preview.winner.ruleName} · r${preview.winner.ruleRevision}` : "No enabled rule matches all verified facts."}</p>
          <ul className="mt-2 space-y-1.5">{preview?.traces.map((trace) => <li key={`${trace.ruleId}:${trace.ruleRevision}`} className="rounded-md bg-lr-panel-raised/45 p-2"><p className="text-[10px] text-lr-text-muted">{trace.ruleName}: {trace.summary}</p>{trace.facts.filter((fact) => !fact.matched).map((fact) => <p key={fact.fact} className="mt-1 text-[9px] leading-4 text-lr-text-faint">{fact.fact}: {fact.reason}</p>)}</li>)}</ul>
        </section>

        <section className="mt-5 border-t border-lr-border-subtle pt-4" aria-labelledby="default-baseline-heading">
          <h3 id="default-baseline-heading" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Matched baseline</h3>
          {installed ? <><p className="mt-2 text-[11px] text-lr-text-muted">Rule r{installed.ruleRevision} · preset r{installed.presetRevision}</p><p className="mt-1 text-[9px] leading-4 text-lr-text-faint">Applied {installed.appliedFields.length}; skipped {installed.skipped.length}; unsupported {installed.unsupported.length}.</p><div className="mt-2"><ActionButton disabled={busy || !durable} onClick={() => void reset()}>Reset to default</ActionButton></div></> : <p className="mt-2 text-[11px] leading-4 text-lr-text-faint">No matched default was recorded for this photo. Reset is unavailable.</p>}
        </section>
      </div>
    </aside>
  );
}
