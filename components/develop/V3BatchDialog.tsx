"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseAssetId, type CatalogId } from "@/lib/catalog/ids";
import type { LibraryEntry } from "@/lib/fs/types";
import {
  BATCH_SEMANTIC_GROUPS,
  MAX_BATCH_PHOTOS,
  fullDocumentScope,
  parseExactBatchSelection,
  selectedGroupsScope,
  type BatchCopyScope,
  type BatchPhotoResult,
  type BatchProgress,
  type BatchResultSummary,
  type BatchSemanticGroup,
} from "@/lib/develop/v3/batch";
import { runV3Batch } from "@/lib/develop/v3/batch-runner";
import { createAppV3BatchAdapter } from "@/lib/develop/v3/app-batch-adapter";
import { useLibraryStore } from "@/stores/library-store";

const GROUP_LABELS = {
  "input-profile": "Input profile",
  "white-balance": "White balance",
  optics: "Optics",
  "geometry-and-crop": "Geometry and crop",
  tone: "Basic tone",
  "curve-and-color": "Curves and color",
  "local-adjustments": "Local adjustments",
  presence: "Presence",
  detail: "Detail",
  cleanup: "Cleanup",
  "lens-blur": "Lens Blur",
  "post-crop-effects": "Post-crop effects",
  "hdr-edit": "HDR edit",
  "output-intent": "Output intent",
} as const satisfies Record<BatchSemanticGroup, string>;

type ScopeMode = "current" | "selected" | "full";
type RunState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly progress: BatchProgress | null; readonly cancelling: boolean }
  | { readonly kind: "complete"; readonly summary: BatchResultSummary }
  | { readonly kind: "invalid"; readonly message: string };

export interface V3BatchDialogProps {
  readonly sourceEntry: LibraryEntry;
  readonly entries: readonly LibraryEntry[];
  readonly resultId: string;
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly resultEntryIds: readonly string[];
  readonly missingEntryIds: readonly string[];
  readonly currentGroup: BatchSemanticGroup;
  readonly onClose: () => void;
}

function resultDetail(result: BatchPhotoResult): string {
  switch (result.kind) {
    case "changed":
      return `Saved ${result.changedGroups.map((group) => GROUP_LABELS[group]).join(", ")}.`;
    case "skipped":
      return result.message;
    case "failed":
      return `${result.phase}: ${result.message}`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function resultTone(result: BatchPhotoResult): string {
  return result.kind === "changed"
    ? "text-lr-accent"
    : result.kind === "failed"
      ? "text-lr-danger"
      : "text-lr-text-faint";
}

export function V3BatchDialog({
  sourceEntry,
  entries,
  resultId,
  catalogId,
  catalogRevision,
  resultEntryIds,
  missingEntryIds,
  currentGroup,
  onClose,
}: V3BatchDialogProps) {
  const librarySelection = useLibraryStore((state) => state.selectedEntryIds);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => {
      const initial = librarySelection.includes(sourceEntry.id)
        ? resultEntryIds.filter((entryId) => librarySelection.includes(entryId))
        : [sourceEntry.id];
      return new Set(initial);
    },
  );
  const [scopeMode, setScopeMode] = useState<ScopeMode>("current");
  const [selectedGroups, setSelectedGroups] = useState<ReadonlySet<BatchSemanticGroup>>(
    () => new Set([currentGroup]),
  );
  const [fullConfirmed, setFullConfirmed] = useState(false);
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const cancelledRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const entryById = useMemo(
    () => new Map<string, LibraryEntry>(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const missing = useMemo(() => new Set(missingEntryIds), [missingEntryIds]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const firstControl = dialogRef.current?.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    firstControl?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && runState.kind !== "running") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? [])].filter((element) => element.offsetParent !== null);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, runState.kind]);

  const selectedInOrder = resultEntryIds.filter((entryId) => selectedIds.has(entryId));
  const canRun = selectedInOrder.length > 0 &&
    selectedInOrder.length <= MAX_BATCH_PHOTOS &&
    (scopeMode !== "selected" || selectedGroups.size > 0) &&
    (scopeMode !== "full" || fullConfirmed) &&
    runState.kind !== "running";

  const toggleEntry = (entryId: string) => {
    if (entryId === sourceEntry.id || runState.kind === "running") return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
    setRunState({ kind: "idle" });
  };

  const toggleGroup = (group: BatchSemanticGroup) => {
    if (group === "output-intent" || runState.kind === "running") return;
    setSelectedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
    setRunState({ kind: "idle" });
  };

  const run = async () => {
    try {
      const entryIds = selectedInOrder.map(parseAssetId);
      const firstEntryId = entryIds[0];
      if (!firstEntryId) throw new Error("Select at least one photo.");
      const selection = parseExactBatchSelection({
        source: "stored-library-result",
        resultId,
        catalogId,
        catalogRevision,
        entryIds: [firstEntryId, ...entryIds.slice(1)],
      });
      let scope: BatchCopyScope;
      switch (scopeMode) {
        case "current":
          scope = { kind: "current-group", group: currentGroup };
          break;
        case "selected":
          scope = selectedGroupsScope([...selectedGroups]);
          break;
        case "full":
          scope = fullDocumentScope(fullConfirmed ? "explicit" : null);
          break;
        default: {
          const exhaustive: never = scopeMode;
          throw new Error(`Unknown scope ${exhaustive}.`);
        }
      }
      cancelledRef.current = false;
      setRunState({ kind: "running", progress: null, cancelling: false });
      const app = createAppV3BatchAdapter({
        exactResult: {
          resultId,
          catalogId,
          catalogRevision,
          orderedEntryIds: resultEntryIds.map(parseAssetId),
        },
        isCancelled: () => cancelledRef.current,
        onProgress: (progress) => {
          setRunState((current) => current.kind === "running"
            ? { ...current, progress }
            : current);
        },
      });
      const source = await app.prepareSource(sourceEntry.id);
      const result = await runV3Batch({
        source,
        adapter: app.adapter,
        plan: {
          selection,
          sourceEntryId: sourceEntry.id,
          scope,
          output: { kind: "save" },
        },
      });
      setRunState(result.kind === "complete"
        ? { kind: "complete", summary: result.summary }
        : { kind: "invalid", message: result.reason });
    } catch (error) {
      setRunState({
        kind: "invalid",
        message: error instanceof Error ? error.message : "The batch could not start.",
      });
    }
  };

  const progress = runState.kind === "running" ? runState.progress : null;
  const progressCompleted = progress?.kind === "running"
    ? progress.completed
    : progress?.kind === "complete"
      ? progress.completed
      : 0;
  const progressTotal = progress?.total ?? selectedInOrder.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-5">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="v3-batch-title"
        className="flex max-h-[86vh] w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-lr-border bg-lr-panel shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-lr-border-subtle px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="v3-batch-title" className="text-sm font-semibold text-lr-text">
              Batch Develop settings
            </h2>
            <p className="mt-1 text-[11px] leading-4 text-lr-text-faint">
              Source: {sourceEntry.name}. Saves v3 Develop settings only. Export and output intent are unavailable here.
            </p>
          </div>
          <button
            type="button"
            disabled={runState.kind === "running"}
            onClick={onClose}
            aria-label="Close batch dialog"
            className="rounded px-2 py-1 text-lr-text-muted hover:bg-lr-panel-raised disabled:opacity-40"
          >
            ×
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="border-b border-lr-border-subtle p-4 md:border-b-0 md:border-r">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
                Photos · {selectedInOrder.length}
              </h3>
              <div className="flex-1" />
              <button
                type="button"
                disabled={resultEntryIds.length > MAX_BATCH_PHOTOS || runState.kind === "running"}
                onClick={() => setSelectedIds(new Set(resultEntryIds))}
                className="text-[10px] text-lr-accent disabled:text-lr-text-faint"
              >
                Include exact result
              </button>
              <button
                type="button"
                disabled={runState.kind === "running"}
                onClick={() => setSelectedIds(new Set([sourceEntry.id]))}
                className="text-[10px] text-lr-text-muted disabled:opacity-40"
              >
                Source only
              </button>
            </div>
            {resultEntryIds.length > MAX_BATCH_PHOTOS ? (
              <p className="mb-2 text-[10px] leading-4 text-lr-danger">
                The stored result exceeds the {MAX_BATCH_PHOTOS.toLocaleString()} photo batch limit. Choose a smaller subset.
              </p>
            ) : null}
            <div className="max-h-64 overflow-auto rounded border border-lr-border-subtle bg-lr-toolbar/40">
              {resultEntryIds.map((entryId, index) => {
                const entry = entryById.get(entryId);
                const isMissing = missing.has(entryId) || !entry;
                return (
                  <label key={entryId} className="flex min-h-8 items-center gap-2 border-b border-lr-border-subtle px-2.5 py-1.5 last:border-b-0">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(entryId)}
                      disabled={entryId === sourceEntry.id || runState.kind === "running"}
                      onChange={() => toggleEntry(entryId)}
                      className="size-3.5 accent-lr-accent"
                    />
                    <span className="w-6 font-mono text-[9px] text-lr-text-faint">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-lr-text-muted">
                      {entry?.name ?? `Missing photo ${entryId.slice(0, 8)}`}
                    </span>
                    {entryId === sourceEntry.id ? <span className="text-[9px] text-lr-accent">Source</span> : null}
                    {isMissing ? <span className="text-[9px] text-lr-danger">Missing</span> : null}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="p-4">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
              Settings
            </h3>
            <div className="space-y-2 text-[11px] text-lr-text-muted">
              <label className="flex items-start gap-2">
                <input type="radio" name="batch-scope" checked={scopeMode === "current"} disabled={runState.kind === "running"} onChange={() => setScopeMode("current")} className="mt-0.5 accent-lr-accent" />
                <span>Current group: <strong className="font-medium text-lr-text">{GROUP_LABELS[currentGroup]}</strong></span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="batch-scope" checked={scopeMode === "selected"} disabled={runState.kind === "running"} onChange={() => setScopeMode("selected")} className="mt-0.5 accent-lr-accent" />
                <span>Selected groups</span>
              </label>
              {scopeMode === "selected" ? (
                <div className="grid grid-cols-2 gap-x-3 pl-5">
                  {BATCH_SEMANTIC_GROUPS.map((group) => (
                    <label key={group} className={`flex min-h-7 items-center gap-1.5 ${group === "output-intent" ? "opacity-45" : ""}`} title={group === "output-intent" ? "Batch export is not connected." : undefined}>
                      <input type="checkbox" checked={selectedGroups.has(group)} disabled={group === "output-intent" || runState.kind === "running"} onChange={() => toggleGroup(group)} className="size-3 accent-lr-accent" />
                      <span>{GROUP_LABELS[group]}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              <label className="flex items-start gap-2">
                <input type="radio" name="batch-scope" checked={scopeMode === "full"} disabled={runState.kind === "running"} onChange={() => setScopeMode("full")} className="mt-0.5 accent-lr-accent" />
                <span>Full v3 document</span>
              </label>
              {scopeMode === "full" ? (
                <label className="ml-5 flex items-start gap-2 rounded border border-lr-border-subtle bg-lr-panel-raised/50 p-2">
                  <input type="checkbox" checked={fullConfirmed} disabled={runState.kind === "running"} onChange={(event) => setFullConfirmed(event.target.checked)} className="mt-0.5 size-3.5 accent-lr-accent" />
                  <span className="text-[10px] leading-4 text-lr-text-faint">
                    I understand this replaces every supported v3 Develop group. Source-specific and unavailable groups will be reported as skipped.
                  </span>
                </label>
              ) : null}
            </div>

            {runState.kind === "running" ? (
              <div className="mt-4 rounded border border-lr-border-subtle bg-lr-panel-raised/55 p-3">
                <div className="flex items-center gap-2 text-[10px] text-lr-text-muted">
                  <span>{runState.cancelling ? "Cancelling remaining photos…" : `Processing ${progressCompleted} of ${progressTotal}`}</span>
                  <div className="flex-1" />
                  <button type="button" disabled={runState.cancelling} onClick={() => {
                    cancelledRef.current = true;
                    setRunState((current) => current.kind === "running" ? { ...current, cancelling: true } : current);
                  }} className="text-lr-danger disabled:opacity-40">Cancel remaining</button>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-lr-toolbar">
                  <div className="h-full bg-lr-accent" style={{ width: `${progressTotal > 0 ? (progressCompleted / progressTotal) * 100 : 0}%` }} />
                </div>
              </div>
            ) : null}

            {runState.kind === "invalid" ? (
              <p className="mt-4 rounded border border-lr-danger/30 bg-lr-danger/5 p-2 text-[10px] leading-4 text-lr-danger">{runState.message}</p>
            ) : null}

            {runState.kind === "complete" ? (
              <div className="mt-4">
                <p className="text-[10px] text-lr-text-muted">
                  {runState.summary.changed} changed · {runState.summary.skipped} skipped · {runState.summary.failed} failed
                </p>
                <ol className="mt-2 max-h-48 overflow-auto rounded border border-lr-border-subtle">
                  {runState.summary.results.map((result, index) => (
                    <li key={result.entryId} className="border-b border-lr-border-subtle p-2 last:border-b-0">
                      <div className="flex items-center gap-2 text-[10px]">
                        <span className="font-mono text-lr-text-faint">{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-lr-text-muted">{entryById.get(result.entryId)?.name ?? `Missing photo ${result.entryId.slice(0, 8)}`}</span>
                        <span className={`font-medium capitalize ${resultTone(result)}`}>{result.kind}</span>
                      </div>
                      <p className="mt-1 text-[9px] leading-4 text-lr-text-faint">{resultDetail(result)}</p>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-lr-border-subtle px-5 py-3">
          <button type="button" disabled={runState.kind === "running"} onClick={onClose} className="rounded-[7px] border border-lr-border-subtle px-3 py-2 text-[11px] text-lr-text-muted disabled:opacity-40">
            {runState.kind === "complete" ? "Close" : "Cancel"}
          </button>
          {runState.kind !== "complete" ? (
            <button type="button" disabled={!canRun} onClick={() => void run()} className="rounded-[7px] bg-lr-accent px-3 py-2 text-[11px] font-medium text-[#14202a] disabled:opacity-40">
              Apply and save
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
