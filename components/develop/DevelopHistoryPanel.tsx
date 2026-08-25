"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createDevelopRefId, type DevelopHistoryLoadResult, type DevelopHistoryRef, type DevelopHistoryRevision } from "@/lib/develop/history";
import { getDevelopRepository } from "@/lib/develop/repository";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import type { LibraryEntry } from "@/lib/fs/types";
import { useDevelopStore } from "@/stores/develop-store";
import { openDevelopSessionDocument } from "@/lib/develop/session";
import { useLibraryStore } from "@/stores/library-store";
import { ActionButton, StatusCard } from "@/components/develop/V3PanelControls";

interface HistoryView {
  readonly load: DevelopHistoryLoadResult;
  readonly revisions: readonly DevelopHistoryRevision[];
  readonly refs: readonly DevelopHistoryRef[];
}

function shortDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function refButtonLabel(kind: DevelopHistoryRef["kind"]): string {
  return kind === "version" ? "Activate" : "Recall";
}

export function DevelopHistoryPanel({ entry }: { readonly entry: LibraryEntry }) {
  const projection = useDevelopStore((state) => state.sessions[entry.id]?.ui.projection);
  const processKind = useDevelopStore((state) => state.sessions[entry.id]?.processKind);
  const commitCompleteState = useDevelopStore((state) => state.commitV3CompleteState);
  const createVirtualCopy = useLibraryStore((state) => state.createVirtualCopy);
  const [view, setView] = useState<HistoryView | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [inspect, setInspect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (!isElectronApp()) return;
    const request = ++loadGeneration.current;
    const api = getDarkroomAPI();
    const [load, revisions, refs] = await Promise.all([
      api.developHistoryLoad({ catalogId: entry.catalogId, entryId: entry.id, revisionId: null }),
      api.developHistoryList({ catalogId: entry.catalogId, entryId: entry.id, limit: 500 }),
      api.developHistoryRefs({ catalogId: entry.catalogId, entryId: entry.id }),
    ]);
    if (mounted.current && request === loadGeneration.current) setView({ load, revisions, refs });
  }, [entry.catalogId, entry.id]);

  useEffect(() => {
    let current = true;
    mounted.current = true;
    if (!isElectronApp()) return () => { current = false; mounted.current = false; loadGeneration.current += 1; };
    void refresh().catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "History could not be loaded.");
    });
    return () => { current = false; mounted.current = false; loadGeneration.current += 1; };
  }, [refresh]);

  const act = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      if (mounted.current) await refresh();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "History action failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const headRevisionId = view?.load.kind === "loaded" ? view.load.value.headRevisionId : view?.load.headRevisionId ?? null;
  const createRef = (kind: DevelopHistoryRef["kind"]): Promise<void> => act(async () => {
    const trimmed = name.trim();
    if (!trimmed || !headRevisionId) throw new Error("A name and live Head are required.");
    await getDarkroomAPI().developHistoryRefMutate({
      kind: "create", catalogId: entry.catalogId, entryId: entry.id,
      refId: createDevelopRefId(), refKind: kind, name: trimmed,
      revisionId: headRevisionId, createdAt: Date.now(),
    });
    setName("");
  });

  const restore = (ref: DevelopHistoryRef): Promise<void> => act(async () => {
    const loaded = await getDarkroomAPI().developHistoryLoad({ catalogId: entry.catalogId, entryId: entry.id, revisionId: ref.revisionId });
    if (loaded.kind !== "loaded") {
      throw new Error("This reference is not an editable V3 revision.");
    }
    const process = openDevelopSessionDocument(loaded.value.document);
    if (process.kind !== "editable" || process.document.version !== 3) throw new Error("This reference is not an editable V3 revision.");
    commitCompleteState(entry.catalogId, entry.id, process.document, `${ref.kind === "version" ? "Activate version" : "Recall snapshot"}: ${ref.name}`);
    await getDevelopRepository(entry).flush();
  });

  const refs = (kind: DevelopHistoryRef["kind"]): readonly DevelopHistoryRef[] =>
    view?.refs.filter((item) => item.kind === kind) ?? [];

  if (!isElectronApp()) {
    return <aside className="w-[352px] shrink-0 border-l border-lr-border-subtle bg-lr-panel p-4"><StatusCard title="History unavailable">Persistent Head and XMP recovery require the Darkroom desktop app.</StatusCard></aside>;
  }

  return (
    <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel" aria-label="Develop history">
      <header className="border-b border-lr-border-subtle px-4 py-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">History</h2>
        <p className="mt-0.5 text-[10px] text-lr-text-faint">Persistent Head, versions, snapshots, and XMP recovery</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {processKind === "read-only-newer" ? <div className="border-b border-lr-border-subtle px-4 py-3"><StatusCard title="Read-only document" tone="warning">Timeline and references are available. Restore actions need an editable V3 document.</StatusCard></div> : null}
        {projection?.kind === "divergent" ? (
          <section className="border-b border-lr-border-subtle bg-lr-warning/5 px-4 py-3" aria-live="polite">
            <StatusCard title="Darkroom and XMP both changed" tone="warning">
              Choose which state to keep. Darkroom will not resolve this conflict on its own.
              {inspect ? <ul className="mt-2 list-disc pl-4">{projection.differences.map((item) => <li key={item}>{item}</li>)}</ul> : null}
            </StatusCard>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <ActionButton disabled={busy} onClick={() => void act(() => getDevelopRepository(entry).resolveProjection("keep-darkroom"))}>Keep Darkroom</ActionButton>
              <ActionButton disabled={busy || projection.externalDigest === null} onClick={() => void act(() => getDevelopRepository(entry).resolveProjection("import-xmp"))}>Import XMP</ActionButton>
              <ActionButton disabled={busy} pressed={inspect} onClick={() => setInspect((value) => !value)}>Inspect differences</ActionButton>
              <ActionButton disabled={busy || projection.externalDigest === null} onClick={() => void act(async () => {
                await getDevelopRepository(entry).preserveBoth(
                  () => createVirtualCopy(entry.id, "Darkroom before external XMP"),
                );
              })}>Preserve both</ActionButton>
            </div>
          </section>
        ) : projection?.kind === "pending" || projection?.kind === "recovery" ? (
          <div className="border-b border-lr-border-subtle px-4 py-3"><StatusCard title={projection.kind === "pending" ? "XMP projection pending" : "History recovery needed"} tone="warning">{projection.kind === "pending" ? projection.reason : projection.message}</StatusCard></div>
        ) : null}
        {error ? <p className="border-b border-lr-border-subtle px-4 py-2 text-[10px] leading-4 text-lr-danger" role="alert">{error}</p> : null}

        <section className="border-b border-lr-border-subtle px-4 py-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Timeline</h3>
          {!view ? <p className="mt-2 text-[11px] text-lr-text-faint">Loading history…</p> : view.revisions.length === 0 ? <p className="mt-2 text-[11px] text-lr-text-faint">No retained revisions.</p> : (
            <ol className="mt-2 space-y-1">
              {view.revisions.map((revision) => (
                <li key={revision.revisionId} className="grid grid-cols-[8px_1fr] gap-2 rounded-md px-1 py-1.5 text-[11px] hover:bg-lr-panel-raised/60">
                  <span className={`mt-1 size-2 rounded-full ${revision.revisionId === headRevisionId ? "bg-lr-accent" : "border border-lr-text-faint"}`} aria-label={revision.revisionId === headRevisionId ? "Current Head" : "Retained revision"} />
                  <span className="min-w-0"><span className="block truncate text-lr-text-muted">{revision.label}</span><span className="block text-[9px] text-lr-text-faint">{shortDate(revision.createdAt)}{revision.revisionId === headRevisionId ? " · Current" : ""}</span></span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="border-b border-lr-border-subtle px-4 py-3">
          <label className="text-[10px] text-lr-text-muted" htmlFor="develop-ref-name">Reference name</label>
          <div className="mt-1 flex gap-1.5"><input id="develop-ref-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text outline-none focus:border-lr-text-dim" /><ActionButton disabled={busy || !headRevisionId} onClick={() => void createRef("version")}>Version</ActionButton><ActionButton disabled={busy || !headRevisionId} onClick={() => void createRef("snapshot")}>Snapshot</ActionButton></div>
        </section>

        {(["version", "snapshot"] as const).map((kind) => (
          <section key={kind} className="border-b border-lr-border-subtle px-4 py-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">{kind === "version" ? "Versions" : "Snapshots"}</h3>
            {refs(kind).length === 0 ? <p className="mt-2 text-[11px] text-lr-text-faint">No {kind === "version" ? "versions" : "snapshots"} yet.</p> : (
              <ul className="mt-2 space-y-2">{refs(kind).map((ref) => (
                <li key={ref.refId} className="rounded-md bg-lr-panel-raised/45 p-2">
                  {renaming === ref.refId ? <input autoFocus value={renameValue} maxLength={120} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); if (event.key === "Enter") void act(async () => { await getDarkroomAPI().developHistoryRefMutate({ kind: "rename", catalogId: entry.catalogId, entryId: entry.id, refId: ref.refId, name: renameValue, updatedAt: Date.now() }); setRenaming(null); }); }} className="w-full rounded border border-lr-border-subtle bg-lr-panel px-2 py-1 text-[11px] text-lr-text" /> : <p className="truncate text-[11px] text-lr-text-muted">{ref.name}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-1"><ActionButton disabled={busy || processKind !== "v3"} onClick={() => void restore(ref)}>{refButtonLabel(kind)}</ActionButton>{kind === "version" ? <ActionButton disabled={busy || !headRevisionId || ref.revisionId === headRevisionId} onClick={() => void act(async () => { if (!headRevisionId) return; await getDarkroomAPI().developHistoryRefMutate({ kind: "move", catalogId: entry.catalogId, entryId: entry.id, refId: ref.refId, revisionId: headRevisionId, updatedAt: Date.now() }); })}>Move here</ActionButton> : null}<ActionButton disabled={busy} onClick={() => { setRenaming(ref.refId); setRenameValue(ref.name); }}>Rename</ActionButton><ActionButton disabled={busy} onClick={() => void act(async () => { await getDarkroomAPI().developHistoryRefMutate({ kind: "delete", catalogId: entry.catalogId, entryId: entry.id, refId: ref.refId }); })}>Delete</ActionButton></div>
                </li>
              ))}</ul>
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}
