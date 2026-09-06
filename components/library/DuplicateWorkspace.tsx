"use client";

import { useEffect, useMemo, useState } from "react";
import { CatalogFingerprintBackfill } from "@/components/catalog/CatalogFingerprintBackfill";
import { loadThumbnailBlob } from "@/lib/cache/thumbnail-cache";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import type { LibraryEntry } from "@/lib/fs/types";
import { getExactDuplicateGroups } from "@/lib/library/duplicates";
import { useLibraryStore } from "@/stores/library-store";
import { useLibraryDialog } from "./useLibraryDialog";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function DuplicateWorkspace() {
  const entries = useLibraryStore((state) => state.entries);
  const metadata = useLibraryStore((state) => state.entryMetadata);
  const albums = useLibraryStore((state) => state.albums);
  const archivedEntryIds = useLibraryStore((state) => state.archivedEntryIds);
  const workspace = useLibraryStore((state) => state.libraryWorkspace);
  const coverage = useLibraryStore((state) => state.fingerprintCoverage);
  const stackEntries = useLibraryStore((state) => state.stackEntries);
  const archiveEntries = useLibraryStore((state) => state.archiveEntries);
  const excludeEntries = useLibraryStore((state) => state.excludeEntries);
  const trashExactDuplicates = useLibraryStore((state) => state.trashExactDuplicates);
  const groups = useMemo(
    () => getExactDuplicateGroups(entries, metadata, albums, archivedEntryIds, workspace),
    [albums, archivedEntryIds, entries, metadata, workspace],
  );
  const [chosenKeepers, setChosenKeepers] = useState<Record<string, string>>({});
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [ledger, setLedger] = useState<string[]>([]);
  const dialog = useLibraryDialog();
  const reclaimable = groups.reduce((total, group) => total + group.reclaimableBytes, 0);

  function keeperFor(groupId: string, fallback: string): string {
    return chosenKeepers[groupId] ?? fallback;
  }

  function catalogAction(groupId: string, action: "stack" | "archive" | "hide") {
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;
    const keeperId = keeperFor(group.id, group.defaultKeeperId);
    const targetIds = group.members.map((member) => member.entry.id).filter((id) => id !== keeperId);
    if (action === "stack") stackEntries(group.members.map((member) => member.entry.id));
    if (action === "archive") archiveEntries(targetIds);
    if (action === "hide") excludeEntries(targetIds);
    setLedger((current) => [...current, `${action === "stack" ? "Stacked" : action === "archive" ? "Archived" : "Hidden"} ${targetIds.length} member${targetIds.length === 1 ? "" : "s"}; kept ${group.members.find((member) => member.entry.id === keeperId)?.entry.name ?? keeperId}.`]);
  }

  async function trash(groupId: string) {
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;
    const keeperId = keeperFor(group.id, group.defaultKeeperId);
    const targets = group.members.filter((member) => member.entry.id !== keeperId);
    const confirmed = await dialog.requestConfirmation({
      title: "Move exact duplicates to Trash?",
      message: `A catalog backup will be created first. Then move ${targets.length} verified exact duplicate${targets.length === 1 ? "" : "s"} to the OS Trash:\n${targets.map((member) => member.entry.relativePath).join("\n")}\nThe keeper will not be touched.`,
      confirmLabel: "Verify and move",
      danger: true,
    });
    if (!confirmed) return;
    setBusyGroupId(group.id);
    try {
      const result = await trashExactDuplicates(keeperId, targets.map((member) => member.entry.id));
      const succeeded = result.items.filter((item) => item.trashed).length;
      const failed = result.items.length - succeeded;
      setLedger((current) => [...current, `Catalog backup created. OS Trash: ${succeeded} moved, ${failed} failed. Keeper reverified before every move.`]);
    } catch (error) {
      setLedger((current) => [...current, `Trash action stopped: ${error instanceof Error ? error.message : "Unknown error"}`]);
    } finally {
      setBusyGroupId(null);
    }
  }

  return (
    <div className="h-full overflow-auto p-5">
      {dialog.element}
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-lr-text">Exact duplicate review</h2>
            <p className="mt-1 text-xs text-lr-text-muted">
              {groups.length} group{groups.length === 1 ? "" : "s"} · {bytes(reclaimable)} potentially reclaimable. Equality means matching byte length and SHA-256.
            </p>
          </div>
        </header>
        <CatalogFingerprintBackfill disabled={false} />
        {coverage.valid < coverage.total ? (
          <p className="rounded border border-lr-border-subtle bg-lr-panel px-3 py-2 text-xs text-lr-text-muted">
            Results are partial while fingerprints remain missing, stale, or failed.
          </p>
        ) : null}
        {groups.length === 0 ? (
          <div className="rounded-lg border border-lr-border-subtle bg-lr-panel p-8 text-center">
            <p className="text-sm text-lr-text-muted">No byte-identical groups found.</p>
            <p className="mt-1 text-xs text-lr-text-faint">Build or resume fingerprints above to complete the review.</p>
          </div>
        ) : groups.map((group, index) => {
          const keeperId = keeperFor(group.id, group.defaultKeeperId);
          return (
            <section key={group.id} className="rounded-lg border border-lr-border-subtle bg-lr-panel p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-lr-text">Group {index + 1} · {group.members.length} files</h3>
                <span className="font-mono text-[10px] text-lr-text-faint">{bytes(group.size)} each · {bytes(group.reclaimableBytes)} reclaimable</span>
              </div>
              <div className="mt-3 space-y-1.5">
                {group.members.map((member) => {
                  const analysis = workspace.analysisByEntryId[member.entry.id];
                  const entryMetadata = getEntryMetadata(metadata, member.entry.id);
                  return (
                    <label key={member.entry.id} className={`grid cursor-pointer grid-cols-[48px_auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2 ${keeperId === member.entry.id ? "border-lr-accent bg-lr-selection" : "border-lr-border-subtle bg-lr-panel-raised"}`}>
                      <DuplicatePreview entry={member.entry} />
                      <input
                        type="radio"
                        name={`keeper-${group.id}`}
                        checked={keeperId === member.entry.id}
                        onChange={() => setChosenKeepers((current) => ({ ...current, [group.id]: member.entry.id }))}
                        aria-label={`Keep ${member.entry.name}`}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-xs text-lr-text">{member.entry.relativePath}</span>
                        <span className="block truncate text-[10px] text-lr-text-faint">
                          {analysis?.captureTimeDisplay ?? "Capture time unavailable"}
                          {` · ${member.entry.name.split(".").at(-1)?.toUpperCase() ?? "Unknown format"}`}
                          {` · ${entryMetadata.pick}`}
                          {entryMetadata.rating > 0 ? ` · ${entryMetadata.rating}★` : " · unrated"}
                          {entryMetadata.colorLabel ? ` · ${entryMetadata.colorLabel} label` : ""}
                          {member.albumNames.length > 0 ? ` · ${member.albumNames.join(", ")}` : " · no albums"}
                          {` · ${member.keywordCount} keywords`}
                          {member.stackId ? " · stacked" : ""}
                          {member.archived ? " · archived" : ""}
                        </span>
                      </span>
                      <span className="text-[10px] font-semibold text-lr-accent">{keeperId === member.entry.id ? "KEEP" : "DUPLICATE"}</span>
                    </label>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-lr-border-subtle pt-3">
                <button type="button" onClick={() => catalogAction(group.id, "stack")} className="rounded border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:text-lr-text">Stack group</button>
                <button type="button" onClick={() => catalogAction(group.id, "archive")} className="rounded border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:text-lr-text">Archive duplicates</button>
                <button type="button" onClick={() => catalogAction(group.id, "hide")} className="rounded border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:text-lr-text">Hide from catalog</button>
                <button type="button" disabled={busyGroupId === group.id} onClick={() => void trash(group.id)} className="ml-auto rounded border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/50 disabled:opacity-40">{busyGroupId === group.id ? "Verifying…" : "Verify and move duplicates to trash"}</button>
              </div>
            </section>
          );
        })}
        {ledger.length > 0 ? (
          <section className="rounded-lg border border-lr-border-subtle bg-lr-panel p-4" aria-live="polite">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-lr-text-faint">Action ledger</h3>
            <ul className="mt-2 space-y-1 text-xs text-lr-text-muted">{ledger.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
            <p className="mt-2 text-[10px] text-lr-text-faint">OS-trash items can be recovered from the system Trash. Hidden catalog items can be restored from the Library sidebar.</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function DuplicatePreview({ entry }: { entry: LibraryEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    void loadThumbnailBlob(entry, 160, { priority: 3 }).then((blob) => {
      if (!live) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry]);
  return (
    <span className="relative h-12 w-12 overflow-hidden rounded bg-lr-bg">
      {url ? <img src={url} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" /> : null}
    </span>
  );
}
