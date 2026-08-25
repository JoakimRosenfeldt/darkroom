"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cameraProfileIsCompatible } from "@/lib/camera-profiles/matrix";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  appliedPresetAmountAvailable,
  calculateDevelopPresetApplication,
  captureDevelopPresetPayload,
  incrementPresetAmount,
  reapplyDevelopPreset,
  resetPresetAmount,
  setAppliedPresetAmount,
  type DevelopPresetApplyContext,
  type DevelopPresetApplyReport,
} from "@/lib/develop/presets/apply";
import type { DevelopPresetImportResult } from "@/lib/develop/presets/api";
import {
  DEVELOP_PRESET_FIELDS,
  createDevelopPresetId,
  parseDevelopPresetRecord,
  type DevelopPresetField,
  type DevelopPresetRecord,
} from "@/lib/develop/presets/schema";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { LibraryEntry } from "@/lib/fs/types";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import { useDevelopStore } from "@/stores/develop-store";
import { ActionButton, StatusCard } from "./V3PanelControls";

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

interface PreviewBinding {
  readonly catalogId: string;
  readonly entryId: string;
  readonly presetId: string;
}

interface AmountBinding {
  readonly catalogId: string;
  readonly entryId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Preset operation failed.";
}

function resultMessage(result: DevelopPresetImportResult): string {
  switch (result.kind) {
    case "cancelled": return "Import cancelled.";
    case "imported": return `${result.preset.name} imported.`;
    case "exact-duplicate": return `${result.preset.name} is already installed.`;
    case "conflict": return `${result.incoming.name} has the same ID as ${result.existing.name}.`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function reportRows(report: DevelopPresetApplyReport): readonly string[] {
  return [
    ...report.unsupported.map((item) => `${FIELD_LABELS[item.field]}: ${item.reason}`),
    ...report.skipped.map((item) => `${FIELD_LABELS[item.field]}: ${item.reason}`),
    ...report.regenerationRequests.map((item) => `${FIELD_LABELS[item.field]}: ${item.reason}`),
  ];
}

function currentDocument(entryId: string): DevelopDocumentV3 | null {
  const session = useDevelopStore.getState().sessions[entryId];
  const document = session?.previewDocument ?? session?.persistedDocument;
  return session?.processKind === "v3" && document?.version === 3 ? document : null;
}

function committedDocument(entryId: string): DevelopDocumentV3 | null {
  const session = useDevelopStore.getState().sessions[entryId];
  const document = session?.persistedDocument;
  return session?.processKind === "v3" && document?.version === 3 ? document : null;
}

export function DevelopPresetPanel({
  document,
  image,
  entry,
}: {
  readonly document: DevelopDocumentV3;
  readonly image: DevelopImage;
  readonly entry: LibraryEntry;
}) {
  const [presets, setPresets] = useState<readonly DevelopPresetRecord[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<DevelopPresetApplyReport | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("Darkroom user");
  const [managerCategory, setManagerCategory] = useState("Custom");
  const [fields, setFields] = useState<readonly DevelopPresetField[]>(["basic"]);
  const [conflict, setConflict] = useState<Extract<DevelopPresetImportResult, { kind: "conflict" }> | null>(null);
  const [compatibleProfileIds, setCompatibleProfileIds] = useState<readonly string[]>([]);
  const previewRef = useRef<PreviewBinding | null>(null);
  const amountRef = useRef<AmountBinding | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [amountText, setAmountText] = useState(String(document.appliedPreset?.amount ?? 100));

  const selected = presets.find((preset) => preset.presetId === selectedId) ?? null;
  const categories = useMemo(
    () => [...new Set(presets.map((preset) => preset.category))].sort(),
    [presets],
  );
  const context: DevelopPresetApplyContext = useMemo(() => ({
    sourceId: entry.sourceId,
    compatibleInputProfileIds: compatibleProfileIds,
    regenerateAiMasks: false,
  }), [compatibleProfileIds, entry.sourceId]);

  const cancelPreview = () => {
    const binding = previewRef.current;
    if (!binding) return;
    useDevelopStore.getState().cancelEditGroupForEntry(binding.catalogId, binding.entryId);
    previewRef.current = null;
    setPreviewingId(null);
    setMessage("Preview cancelled.");
  };

  const cancelAmount = () => {
    const binding = amountRef.current;
    if (!binding) return;
    useDevelopStore.getState().cancelEditGroupForEntry(binding.catalogId, binding.entryId);
    amountRef.current = null;
  };

  useEffect(() => {
    if (!isElectronApp()) return;
    let active = true;
    void getDarkroomAPI().developPresetsList({ query, category, favoriteOnly }).then((next) => {
      if (!active) return;
      const currentSelectedId = selectedIdRef.current;
      const nextSelectedId = currentSelectedId && next.some((preset) => preset.presetId === currentSelectedId)
        ? currentSelectedId
        : next[0]?.presetId ?? null;
      const binding = previewRef.current;
      if (binding && binding.presetId !== nextSelectedId) {
        useDevelopStore.getState().cancelEditGroupForEntry(binding.catalogId, binding.entryId);
        previewRef.current = null;
        setPreviewingId(null);
      }
      setPresets(next);
      selectedIdRef.current = nextSelectedId;
      setSelectedId(nextSelectedId);
    }).catch((error: unknown) => {
      if (active) setMessage(errorMessage(error));
    });
    return () => {
      active = false;
    };
  }, [category, favoriteOnly, query]);

  useEffect(() => {
    if (!isElectronApp()) return;
    let active = true;
    void getDarkroomAPI().cameraProfilesList().then((registry) => {
      if (!active) return;
      const stage = image.pixelProvenance.cameraProfileStage;
      setCompatibleProfileIds(stage.kind === "available"
        ? registry.profiles.flatMap((record) =>
            record.kind === "ready" && cameraProfileIsCompatible(record.profile, stage.camera)
              ? [record.profile.id]
              : [],
          )
        : []);
    }).catch(() => {
      if (active) setCompatibleProfileIds([]);
    });
    return () => {
      active = false;
    };
  }, [image]);

  useEffect(() => () => {
    const preview = previewRef.current;
    if (preview) {
      useDevelopStore.getState().cancelEditGroupForEntry(preview.catalogId, preview.entryId);
      previewRef.current = null;
    }
    const amount = amountRef.current;
    if (amount) {
      useDevelopStore.getState().cancelEditGroupForEntry(amount.catalogId, amount.entryId);
      amountRef.current = null;
    }
  }, [entry.catalogId, entry.id]);

  useEffect(() => {
    if (!amountRef.current) setAmountText(String(document.appliedPreset?.amount ?? 100));
  }, [document.appliedPreset?.amount]);

  const refresh = async (preferredId?: string) => {
    const next = await getDarkroomAPI().developPresetsList({ query, category, favoriteOnly });
    const nextSelectedId = preferredId && next.some((preset) => preset.presetId === preferredId)
      ? preferredId
      : selectedId && next.some((preset) => preset.presetId === selectedId)
        ? selectedId
        : next[0]?.presetId ?? null;
    const binding = previewRef.current;
    if (binding && binding.presetId !== nextSelectedId) {
      useDevelopStore.getState().cancelEditGroupForEntry(binding.catalogId, binding.entryId);
      previewRef.current = null;
      setPreviewingId(null);
    }
    setPresets(next);
    selectedIdRef.current = nextSelectedId;
    setSelectedId(nextSelectedId);
  };

  const preview = () => {
    if (!selected) return;
    cancelAmount();
    cancelPreview();
    const base = committedDocument(entry.id);
    if (!base) return;
    try {
      const result = calculateDevelopPresetApplication({
        document: base,
        preset: selected,
        amount: 100,
        context,
      });
      setReport(result.report);
      if (result.report.included.length === 0) {
        setMessage("No compatible preset fields can be previewed.");
        return;
      }
      const store = useDevelopStore.getState();
      store.beginEditGroupForEntry(entry.catalogId, entry.id, `Preview ${selected.name}`);
      store.dispatchV3ToEntry(entry.catalogId, entry.id, result.command, `Apply ${selected.name}`);
      previewRef.current = { catalogId: entry.catalogId, entryId: entry.id, presetId: selected.presetId };
      setPreviewingId(selected.presetId);
      setMessage(`Previewing ${selected.name}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const apply = () => {
    if (!selected) return;
    const previewBinding = previewRef.current;
    if (previewBinding?.presetId === selected.presetId) {
      useDevelopStore.getState().endEditGroupForEntry(previewBinding.catalogId, previewBinding.entryId);
      previewRef.current = null;
      setPreviewingId(null);
      setMessage(`${selected.name} applied.`);
      return;
    }
    cancelPreview();
    const base = committedDocument(entry.id);
    if (!base) return;
    try {
      const result = calculateDevelopPresetApplication({ document: base, preset: selected, amount: 100, context });
      setReport(result.report);
      if (result.report.included.length === 0) {
        setMessage("No compatible preset fields were applied.");
        return;
      }
      useDevelopStore.getState().commitV3CompleteState(entry.catalogId, entry.id, result.document, `Apply ${selected.name}`);
      setMessage(`${selected.name} applied.`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const toggleFavorite = async () => {
    if (!selected || !isElectronApp()) return;
    setBusy(true);
    try {
      const updated = await getDarkroomAPI().developPresetsFavorite({
        presetId: selected.presetId,
        favorite: !selected.favorite,
      });
      await refresh(updated.presetId);
      setMessage(updated.favorite ? "Added to favorites." : "Removed from favorites.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const recordFromCurrent = (
    existing?: DevelopPresetRecord,
  ): DevelopPresetRecord => {
    const base = committedDocument(entry.id);
    if (!base) throw new Error("Current Develop document is unavailable.");
    if (fields.length === 0) throw new Error("Choose at least one field.");
    return parseDevelopPresetRecord({
      schemaVersion: 1,
      presetId: existing?.presetId ?? createDevelopPresetId(),
      revision: existing ? existing.revision + 1 : 1,
      name: name.trim() || existing?.name,
      author: author.trim() || existing?.author,
      category: managerCategory.trim() || existing?.category,
      source: existing?.source ?? "user",
      favorite: existing?.favorite ?? false,
      fields,
      payload: captureDevelopPresetPayload(base, fields, entry.sourceId),
      compatibility: { process: "darkroom-v3", documentSchemaRevision: "darkroom-v3-document-2" },
    });
  };

  const createPreset = async () => {
    if (!isElectronApp()) return;
    setBusy(true);
    try {
      const created = await getDarkroomAPI().developPresetsCreate(recordFromCurrent());
      await refresh(created.presetId);
      setName("");
      setMessage(`${created.name} created.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const updatePreset = async () => {
    if (!selected || selected.source === "built-in" || !isElectronApp()) return;
    cancelPreview();
    setBusy(true);
    try {
      const updated = await getDarkroomAPI().developPresetsUpdate(recordFromCurrent(selected));
      await refresh(updated.presetId);
      setMessage(`${updated.name} updated as revision ${updated.revision}.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const duplicatePreset = async () => {
    if (!selected || !isElectronApp()) return;
    setBusy(true);
    try {
      const duplicate = parseDevelopPresetRecord({
        ...selected,
        presetId: createDevelopPresetId(),
        revision: 1,
        name: `${selected.name} copy`,
        source: "user",
        favorite: false,
      });
      const created = await getDarkroomAPI().developPresetsCreate(duplicate);
      await refresh(created.presetId);
      setMessage(`${created.name} created.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const deletePreset = async () => {
    if (!selected || selected.source === "built-in" || !isElectronApp()) return;
    if (document.appliedPreset?.presetId === selected.presetId) return;
    if (!window.confirm(`Delete ${selected.name}? Existing applied documents keep their recorded state.`)) return;
    setBusy(true);
    try {
      await getDarkroomAPI().developPresetsDelete({ presetId: selected.presetId });
      await refresh();
      setMessage(`${selected.name} deleted.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const importPreset = async () => {
    if (!isElectronApp()) {
      setMessage("Import is available in the desktop app.");
      return;
    }
    setBusy(true);
    try {
      const result = await getDarkroomAPI().developPresetsImport();
      setConflict(result.kind === "conflict" ? result : null);
      setMessage(resultMessage(result));
      if (result.kind === "imported" || result.kind === "exact-duplicate") {
        await refresh(result.preset.presetId);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const resolveConflict = async (action: "replace" | "import-copy" | "cancel") => {
    if (!conflict || !isElectronApp()) return;
    setBusy(true);
    try {
      const result = await getDarkroomAPI().developPresetsResolveConflict({ token: conflict.token, action });
      setConflict(null);
      setMessage(resultMessage(result));
      if (result.kind === "imported") await refresh(result.preset.presetId);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const beginAmount = () => {
    if (amountRef.current || previewRef.current) return;
    const store = useDevelopStore.getState();
    store.beginEditGroupForEntry(entry.catalogId, entry.id, "Adjust preset Amount");
    amountRef.current = { catalogId: entry.catalogId, entryId: entry.id };
  };

  const changeAmount = (value: number) => {
    const nextAmount = Math.max(0, Math.min(100, value));
    beginAmount();
    const current = currentDocument(entry.id);
    if (!current || !amountRef.current) return;
    try {
      const result = setAppliedPresetAmount(current, nextAmount, context);
      useDevelopStore.getState().dispatchV3ToEntry(entry.catalogId, entry.id, result.command, "Adjust preset Amount");
      setAmountText(String(nextAmount));
      setReport(result.report);
    } catch (error) {
      cancelAmount();
      setMessage(errorMessage(error));
    }
  };

  const finishAmount = () => {
    const binding = amountRef.current;
    if (!binding) return;
    useDevelopStore.getState().endEditGroupForEntry(binding.catalogId, binding.entryId);
    amountRef.current = null;
  };

  const amountKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelAmount();
      setAmountText(String(committedDocument(entry.id)?.appliedPreset?.amount ?? 100));
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowDown" && event.key !== "ArrowRight" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = currentDocument(entry.id)?.appliedPreset?.amount;
    if (current === undefined) return;
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
    changeAmount(incrementPresetAmount(current, direction, event.shiftKey ? 10 : 1));
  };

  const amount = document.appliedPreset;
  const amountEnabled = appliedPresetAmountAvailable(document) && previewingId === null;
  const fullStrengthFields = amount?.includedFields.filter((field) =>
    field === "camera-profile" || field === "crop" || field === "manual-masks" || field === "ai-masks",
  ) ?? [];
  const deleteReason = selected?.source === "built-in"
    ? "Built-in presets are immutable."
    : document.appliedPreset?.presetId === selected?.presetId
      ? "Reapply another preset before deleting this live reference."
      : null;

  return (
    <div className="space-y-0">
      {amount ? (
        <section className="border-b border-lr-border-subtle px-4 py-3.5">
          <div className="flex items-center gap-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Amount</h3>
            <span className={`ml-auto rounded px-1.5 py-0.5 text-[9px] ${amount.linkState === "linked" ? "bg-lr-panel-raised text-lr-accent" : "bg-lr-danger/10 text-lr-danger"}`}>
              {amount.linkState === "linked" ? "Linked" : "Modified"}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-[1fr_54px] items-center gap-2">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={amount.amount}
              disabled={!amountEnabled}
              aria-label="Preset Amount"
              onPointerDown={beginAmount}
              onPointerUp={finishAmount}
              onPointerCancel={cancelAmount}
              onChange={(event) => changeAmount(Number(event.target.value))}
              onKeyDown={amountKeyDown}
              onKeyUp={(event) => {
                if (event.key.startsWith("Arrow")) finishAmount();
              }}
              className="w-full accent-lr-accent disabled:opacity-40"
            />
            <input
              type="number"
              min={0}
              max={100}
              value={amountText}
              disabled={!amountEnabled}
              aria-label="Preset Amount value"
              onFocus={beginAmount}
              onChange={(event) => {
                setAmountText(event.target.value);
                if (event.target.value.trim() === "") return;
                const value = Number(event.target.value);
                if (Number.isFinite(value)) changeAmount(value);
              }}
              onBlur={finishAmount}
              onKeyDown={(event) => {
                if (event.key === "Enter") finishAmount();
                else amountKeyDown(event);
              }}
              className="w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1 text-right text-[11px] text-lr-text outline-none focus:border-lr-text-dim disabled:opacity-40"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <ActionButton
              onClick={() => {
                const current = committedDocument(entry.id);
                if (!current) return;
                try {
                  const result = setAppliedPresetAmount(current, resetPresetAmount(), context);
                  useDevelopStore.getState().commitV3CompleteState(entry.catalogId, entry.id, result.document, "Reset preset Amount");
                } catch (error) {
                  setMessage(errorMessage(error));
                }
              }}
              disabled={!amountEnabled || amount.amount === 100}
            >
              Reset 100
            </ActionButton>
            <ActionButton
              onClick={() => {
                const current = committedDocument(entry.id);
                if (!current) return;
                try {
                  const result = reapplyDevelopPreset(current, context);
                  useDevelopStore.getState().commitV3CompleteState(entry.catalogId, entry.id, result.document, "Reapply preset");
                  setReport(result.report);
                  setMessage("Preset reapplied. Amount is linked again.");
                } catch (error) {
                  setMessage(errorMessage(error));
                }
              }}
              disabled={amount.linkState !== "modified"}
            >
              Reapply
            </ActionButton>
          </div>
          {amount.linkState === "modified" ? (
            <p className="mt-2 text-[10px] leading-4 text-lr-danger">A covered field changed. Reapply to restore Amount.</p>
          ) : null}
          {fullStrengthFields.length > 0 && amount.amount < 100 ? (
            <p className="mt-2 text-[10px] leading-4 text-lr-text-faint">
              At 100 only: {fullStrengthFields.map((field) => FIELD_LABELS[field]).join(", ")}.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="border-b border-lr-border-subtle px-4 py-3.5">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search presets"
            aria-label="Search presets"
            className="min-w-0 rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none placeholder:text-lr-text-faint focus:border-lr-text-dim"
          />
          <ActionButton onClick={() => setFavoriteOnly((value) => !value)} pressed={favoriteOnly}>Favorites</ActionButton>
        </div>
        <select
          value={category ?? ""}
          onChange={(event) => setCategory(event.target.value || null)}
          aria-label="Preset category"
          className="mt-2 w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none focus:border-lr-text-dim"
        >
          <option value="">All categories</option>
          {categories.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </section>

      <div className="max-h-[220px] overflow-auto border-b border-lr-border-subtle p-2" role="listbox" aria-label="Develop presets">
        {presets.length === 0 ? <p className="px-2 py-3 text-[10px] text-lr-text-faint">No presets match.</p> : null}
        {presets.map((preset) => (
          <button
            key={preset.presetId}
            type="button"
            role="option"
            aria-selected={selected?.presetId === preset.presetId}
            onClick={() => {
              if (previewRef.current?.presetId !== preset.presetId) cancelPreview();
              selectedIdRef.current = preset.presetId;
              setSelectedId(preset.presetId);
              setReport(null);
            }}
            className={`mb-1 flex w-full items-start gap-2 rounded-[7px] border px-2.5 py-2 text-left last:mb-0 ${selected?.presetId === preset.presetId ? "border-lr-text-dim bg-lr-panel-raised" : "border-transparent hover:bg-lr-panel-raised/60"}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-medium text-lr-text">{preset.name}</span>
              <span className="mt-0.5 block truncate text-[9px] text-lr-text-faint">{preset.category} · {preset.source} · r{preset.revision}</span>
            </span>
            <span className="text-[11px] text-lr-accent" aria-label={preset.favorite ? "Favorite" : undefined}>{preset.favorite ? "★" : ""}</span>
          </button>
        ))}
      </div>

      {selected ? (
        <section className="border-b border-lr-border-subtle px-4 py-3.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-xs font-medium text-lr-text">{selected.name}</h3>
              <p className="mt-0.5 text-[9px] text-lr-text-faint">by {selected.author}</p>
            </div>
            <ActionButton onClick={() => void toggleFavorite()} disabled={busy}>{selected.favorite ? "Unfavorite" : "Favorite"}</ActionButton>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {selected.fields.map((field) => <span key={field} className="rounded bg-lr-panel-raised px-1.5 py-0.5 text-[9px] text-lr-text-muted">{FIELD_LABELS[field]}</span>)}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {previewingId === selected.presetId
              ? <ActionButton onClick={cancelPreview}>Cancel preview</ActionButton>
              : <ActionButton onClick={preview}>Preview</ActionButton>}
            <ActionButton onClick={apply}>Apply</ActionButton>
          </div>
          {report ? (
            <div className="mt-2 text-[9px] leading-4 text-lr-text-faint">
              <p>Included: {report.included.length ? report.included.map((field) => FIELD_LABELS[field]).join(", ") : "none"}</p>
              {reportRows(report).map((row) => <p key={row} className="text-lr-accent">{row}</p>)}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="px-4 py-3.5">
        <div className="flex flex-wrap gap-1.5">
          <ActionButton onClick={() => setManagerOpen((value) => !value)} pressed={managerOpen}>Manage</ActionButton>
          <ActionButton onClick={() => void importPreset()} disabled={busy || !isElectronApp()}>Import</ActionButton>
        </div>
        {managerOpen ? (
          <div className="mt-3 space-y-2">
            <StatusCard title="Create from current">
              Choose exactly which Develop fields the preset owns. Rating, pick, and label are never included.
            </StatusCard>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Preset name" aria-label="Preset name" className="w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none" />
            <div className="grid grid-cols-2 gap-2">
              <input value={author} onChange={(event) => setAuthor(event.target.value)} aria-label="Preset author" className="min-w-0 rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none" />
              <input value={managerCategory} onChange={(event) => setManagerCategory(event.target.value)} aria-label="Preset category name" className="min-w-0 rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1" aria-label="Preset fields">
              {DEVELOP_PRESET_FIELDS.map((field) => (
                <label key={field} className="flex items-center gap-1.5 text-[10px] text-lr-text-muted">
                  <input
                    type="checkbox"
                    checked={fields.includes(field)}
                    onChange={(event) => setFields(event.target.checked
                      ? [...fields, field]
                      : fields.filter((value) => value !== field))}
                    className="size-3 accent-lr-accent"
                  />
                  {FIELD_LABELS[field]}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <ActionButton onClick={() => void createPreset()} disabled={busy || !name.trim() || fields.length === 0}>Create</ActionButton>
              <ActionButton onClick={() => void updatePreset()} disabled={busy || !selected || selected.source === "built-in" || fields.length === 0} title={selected?.source === "built-in" ? "Built-in presets are immutable." : undefined}>Update selected</ActionButton>
              <ActionButton onClick={() => void duplicatePreset()} disabled={busy || !selected}>Duplicate selected</ActionButton>
              <ActionButton onClick={() => void deletePreset()} disabled={busy || !selected || deleteReason !== null} title={deleteReason ?? undefined}>Delete selected</ActionButton>
            </div>
            {deleteReason ? <p className="text-[9px] leading-3 text-lr-text-faint">Delete unavailable: {deleteReason}</p> : null}
          </div>
        ) : null}
        {conflict ? (
          <div className="mt-3 rounded-[7px] border border-lr-accent/50 bg-lr-panel-raised p-2.5">
            <p className="text-[10px] leading-4 text-lr-text">{conflict.incoming.name} conflicts with {conflict.existing.name}.</p>
            {conflict.existing.source === "built-in" ? <p className="mt-1 text-[9px] text-lr-text-faint">Built-in presets cannot be replaced.</p> : null}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {conflict.decisions.includes("replace") ? <ActionButton onClick={() => void resolveConflict("replace")} disabled={busy}>Replace</ActionButton> : null}
              <ActionButton onClick={() => void resolveConflict("import-copy")} disabled={busy}>Import copy</ActionButton>
              <ActionButton onClick={() => void resolveConflict("cancel")} disabled={busy}>Cancel</ActionButton>
            </div>
          </div>
        ) : null}
        {message ? <p role="status" className="mt-3 text-[10px] leading-4 text-lr-accent">{message}</p> : null}
      </section>
    </div>
  );
}
