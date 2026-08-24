"use client";

import { useEffect, useState } from "react";
import type { CatalogSummary } from "@/lib/catalog/api";
import type { CatalogRootState } from "@/lib/fs/session-catalog";
import { getFormatCapabilityReport } from "@/lib/fs/session-catalog";
import type { FormatCapabilityReport } from "@/lib/formats/types";
import type { CatalogId, RootId } from "@/lib/catalog/ids";
import { useLibraryStore } from "@/stores/library-store";
import { CatalogAdministration } from "@/components/catalog/CatalogAdministration";
import { CatalogFingerprintBackfill } from "@/components/catalog/CatalogFingerprintBackfill";
import { CatalogAssetRelink } from "@/components/catalog/CatalogAssetRelink";
import { CatalogManualImportPanel } from "@/components/catalog/CatalogManualImportPanel";
import { CatalogAutoImportPanel } from "@/components/catalog/CatalogAutoImportPanel";

function catalogHealthLabel(health: CatalogSummary["health"]): string {
  switch (health) {
    case "healthy": return "Healthy";
    case "degraded": return "Degraded";
    case "missing": return "Missing";
    case "corrupt": return "Corrupt";
  }
}

function rootHealthLabel(root: CatalogRootState): string {
  return `${root.health} · scan ${root.scanState} · watch ${root.watchState}`;
}

function operationLabel(status: string): string {
  if (status === "supported") return "Available";
  if (status === "unverified") return "Unverified";
  return "Unavailable";
}

function reportNikonLabel(report: FormatCapabilityReport): string {
  const runtime = report.nikon;
  const backend = runtime.backend ?? "none";
  return `${runtime.status} · ${backend} · ${runtime.packageState}`;
}

export function CatalogManager() {
  const open = useLibraryStore((state) => state.catalogManagerOpen);
  const catalogs = useLibraryStore((state) => state.catalogs);
  const catalogId = useLibraryStore((state) => state.catalogId);
  const sessionId = useLibraryStore((state) => state.sessionId);
  const folderName = useLibraryStore((state) => state.folderName);
  const catalogRoots = useLibraryStore((state) => state.catalogRoots);
  const unresolvedEntries = useLibraryStore((state) => state.unresolvedEntries);
  const importState = useLibraryStore((state) => state.importState);
  const importError = useLibraryStore((state) => state.importError);
  const close = useLibraryStore((state) => state.closeCatalogManager);
  const createCatalog = useLibraryStore((state) => state.createCatalog);
  const addCatalogRoot = useLibraryStore((state) => state.addCatalogRoot);
  const relinkCatalogRoot = useLibraryStore((state) => state.relinkCatalogRoot);
  const renameCatalog = useLibraryStore((state) => state.renameCatalog);
  const switchCatalog = useLibraryStore((state) => state.switchCatalog);
  const removeCatalogRecent = useLibraryStore((state) => state.removeCatalogRecent);
  const deleteCatalog = useLibraryStore((state) => state.deleteCatalog);
  const clearLibrary = useLibraryStore((state) => state.clearLibrary);

  const [newName, setNewName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [renameCatalogId, setRenameCatalogId] = useState<CatalogId | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CatalogSummary | null>(null);
  const [deleteValue, setDeleteValue] = useState("");
  const [report, setReport] = useState<FormatCapabilityReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(() => getFormatCapabilityReport()).then((next) => {
      if (!cancelled) setReport(next);
    }).catch((error: unknown) => {
      if (!cancelled) {
        setReportError(error instanceof Error ? error.message : "Support information is unavailable.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [catalogId, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  if (!open) return null;

  const isBusy = importState !== "idle";
  const activeCatalog = catalogs.find((catalog) => catalog.catalogId === catalogId) ?? null;
  const displayedRenameValue = renameCatalogId === catalogId ? renameValue : folderName ?? "";

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    await createCatalog(name);
    setNewName("");
  }

  async function handleRename() {
    const name = displayedRenameValue.trim();
    if (!name || !catalogId) return;
    await renameCatalog(name);
  }

  async function handleDelete() {
    if (!deleteTarget || deleteValue !== deleteTarget.displayName) return;
    await deleteCatalog(deleteTarget.catalogId, deleteValue);
    setDeleteTarget(null);
    setDeleteValue("");
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-[#0a0908]/65 px-4 py-[8vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="max-h-[84vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-lr-border bg-lr-panel-raised shadow-[0_32px_64px_rgba(0,0,0,.6)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-manager-title"
      >
        <div className="flex items-center justify-between border-b border-lr-border-subtle px-4 py-3">
          <div>
            <h2 id="catalog-manager-title" className="text-sm font-medium text-lr-text">Catalogs</h2>
            <p className="mt-0.5 text-xs text-lr-text-faint">Open a catalog or manage its linked roots.</p>
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded px-2 py-1 text-xs text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text"
          >
            Close
          </button>
        </div>

        <div className="space-y-5 px-4 py-4">
          <section aria-labelledby="catalog-create-title">
            <h3 id="catalog-create-title" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Create catalog</h3>
            <div className="mt-2 flex gap-2">
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void handleCreate(); }}
                placeholder="Catalog name"
                aria-label="New catalog name"
                className="min-w-0 flex-1 rounded-md border border-lr-border-subtle bg-lr-panel px-2.5 py-2 text-xs text-lr-text outline-none focus:border-lr-accent"
              />
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={!newName.trim() || isBusy}
                className="rounded-md bg-lr-accent px-3 py-2 text-xs text-white transition hover:bg-lr-accent/90 disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </section>

          {activeCatalog ? (
            <section aria-labelledby="catalog-active-title" className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 id="catalog-active-title" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Active catalog</h3>
                  <p className="mt-1 truncate text-sm text-lr-text">{activeCatalog.displayName}</p>
                  <p className="mt-0.5 text-xs text-lr-text-faint">{catalogHealthLabel(activeCatalog.health)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void clearLibrary()}
                  disabled={isBusy}
                  className="rounded border border-lr-border-subtle px-2.5 py-1.5 text-xs text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
                >
                  Close catalog
                </button>
              </div>

              <div className="flex gap-2">
                <input
                  value={displayedRenameValue}
                  onChange={(event) => {
                    setRenameCatalogId(catalogId);
                    setRenameValue(event.target.value);
                  }}
                  aria-label="Catalog display name"
                  className="min-w-0 flex-1 rounded-md border border-lr-border-subtle bg-lr-panel px-2.5 py-1.5 text-xs text-lr-text outline-none focus:border-lr-accent"
                />
                <button
                  type="button"
                  onClick={() => void handleRename()}
                  disabled={!displayedRenameValue.trim() || isBusy}
                  className="rounded border border-lr-border-subtle px-2.5 py-1.5 text-xs text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
                >
                  Rename
                </button>
              </div>

              <div className="rounded-lg border border-lr-border-subtle bg-lr-panel px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-lr-text">Linked roots</p>
                  <button
                    type="button"
                    onClick={() => void addCatalogRoot()}
                    disabled={isBusy}
                    className="rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
                  >
                    Add root
                  </button>
                </div>
                {catalogRoots.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {catalogRoots.map((root) => (
                      <RootRow
                        key={root.rootId}
                        root={root}
                        unresolvedCount={unresolvedEntries.filter((entry) => entry.rootId === root.rootId).length}
                        disabled={isBusy}
                        onRelink={(rootId) => void relinkCatalogRoot(rootId)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-lr-text-faint">No roots linked.</p>
                )}
                <p className="mt-2 text-[11px] text-lr-text-faint">
                  {unresolvedEntries.length === 0
                    ? "No unresolved assets."
                    : `${unresolvedEntries.length} unresolved assets remain available for relink.`}
                </p>
              </div>

              <CatalogManualImportPanel disabled={isBusy} key={`${catalogId}-${sessionId}`} />
              <CatalogAutoImportPanel disabled={isBusy} key={`auto-${catalogId}-${sessionId}`} />
              <CatalogFingerprintBackfill key={catalogId} disabled={isBusy} />
              <CatalogAssetRelink key={`${catalogId}-${sessionId}`} disabled={isBusy} />
            </section>
          ) : null}

          <section aria-labelledby="catalog-list-title">
            <h3 id="catalog-list-title" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Recent catalogs</h3>
            {catalogs.length > 0 ? (
              <ul className="mt-2 divide-y divide-lr-border-subtle rounded-lg border border-lr-border-subtle bg-lr-panel">
                {catalogs.map((catalog) => (
                  <CatalogRow
                    key={catalog.catalogId}
                    catalog={catalog}
                    active={catalog.catalogId === catalogId}
                    disabled={isBusy}
                    onSwitch={(id) => void switchCatalog(id)}
                    onRemove={(id) => void removeCatalogRecent(id)}
                    onDelete={(item) => {
                      setDeleteTarget(item);
                      setDeleteValue("");
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-lr-text-faint">No saved catalogs yet.</p>
            )}
          </section>

          <details className="rounded-lg border border-lr-border-subtle bg-lr-panel px-3 py-2.5">
            <summary className="cursor-pointer text-xs font-medium text-lr-text">Support / Formats</summary>
            {report ? <SupportReport report={report} /> : (
              <p className="mt-2 text-xs text-lr-text-faint">{reportError ?? "Loading capability report…"}</p>
            )}
          </details>

          <CatalogAdministration disabled={isBusy} />

          {importError ? <p className="text-xs text-red-400" role="status">{importError}</p> : null}
          {importState !== "idle" ? <p className="text-xs text-lr-text-muted" role="status">{importState === "restoring" ? "Relinking catalog root…" : "Opening catalog…"}</p> : null}
        </div>
      </section>

      {deleteTarget ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#0a0908]/45 px-4">
          <div className="w-full max-w-sm rounded-xl border border-lr-border bg-lr-panel-raised p-4 shadow-[0_24px_48px_rgba(0,0,0,.55)]" role="alertdialog" aria-modal="true" aria-labelledby="catalog-delete-title">
            <h2 id="catalog-delete-title" className="text-sm text-lr-text">Delete catalog?</h2>
            <p className="mt-2 text-xs leading-5 text-lr-text-muted">
              This removes the managed catalog file and its saved organization. Type <code className="rounded bg-lr-panel px-1 py-0.5 text-lr-text">{deleteTarget.displayName}</code> to confirm.
            </p>
            <input
              value={deleteValue}
              onChange={(event) => setDeleteValue(event.target.value)}
              aria-label="Type catalog name to confirm deletion"
              className="mt-3 w-full rounded-md border border-lr-border-subtle bg-lr-panel px-2.5 py-2 text-xs text-lr-text outline-none focus:border-red-400"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => { setDeleteTarget(null); setDeleteValue(""); }} className="rounded px-2.5 py-1.5 text-xs text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text">Cancel</button>
              <button type="button" onClick={() => void handleDelete()} disabled={deleteValue !== deleteTarget.displayName || isBusy} className="rounded bg-red-500/20 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/30 disabled:opacity-40">Delete catalog</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RootRow({
  root,
  unresolvedCount,
  disabled,
  onRelink,
}: {
  root: CatalogRootState;
  unresolvedCount: number;
  disabled: boolean;
  onRelink: (rootId: RootId) => void;
}) {
  const needsRelink = root.health !== "online";
  return (
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-xs text-lr-text">{root.label}</p>
        <p className="truncate text-[10px] text-lr-text-faint">{rootHealthLabel(root)}{unresolvedCount > 0 ? ` · ${unresolvedCount} unresolved` : ""}</p>
      </div>
      <button
        type="button"
        onClick={() => onRelink(root.rootId)}
        disabled={disabled}
        className="shrink-0 rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
      >
        {needsRelink ? "Relink" : "Relink root"}
      </button>
    </li>
  );
}

function CatalogRow({
  catalog,
  active,
  disabled,
  onSwitch,
  onRemove,
  onDelete,
}: {
  catalog: CatalogSummary;
  active: boolean;
  disabled: boolean;
  onSwitch: (catalogId: CatalogId) => void;
  onRemove: (catalogId: CatalogId) => void;
  onDelete: (catalog: CatalogSummary) => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-lr-text">{catalog.displayName}</p>
        <p className="text-[10px] text-lr-text-faint">{active ? "Active" : catalogHealthLabel(catalog.health)}</p>
      </div>
      {!active ? <button type="button" onClick={() => onSwitch(catalog.catalogId)} disabled={disabled} className="rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40">Open</button> : null}
      {!active ? <button type="button" onClick={() => onRemove(catalog.catalogId)} disabled={disabled} className="rounded px-2 py-1 text-[11px] text-lr-text-faint hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40">Remove</button> : null}
      <button type="button" onClick={() => onDelete(catalog)} disabled={disabled || active} title={active ? "Close this catalog before deleting it." : "Delete catalog"} className="rounded px-2 py-1 text-[11px] text-lr-text-faint hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40">Delete</button>
    </li>
  );
}

function SupportReport({ report }: { report: FormatCapabilityReport }) {
  return (
    <div className="mt-3 space-y-3">
      <div>
        <p className="text-xs text-lr-text">Nikon runtime</p>
        <p className="mt-0.5 text-[11px] text-lr-text-muted">{reportNikonLabel(report)}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-lr-text-faint">{report.nikon.reason}</p>
        {report.nikon.version ? <p className="mt-0.5 text-[10px] text-lr-text-faint">v{report.nikon.version}{report.nikon.architecture ? ` · ${report.nikon.architecture}` : ""}</p> : null}
      </div>
      <div>
        <p className="text-xs text-lr-text">Operations</p>
        <ul className="mt-1 space-y-1">
          {report.operations.map((operation) => (
            <li key={operation.id} className="flex items-start justify-between gap-3 text-[11px]">
              <span className="text-lr-text-muted">{operation.label}</span>
              <span className={operation.status === "supported" ? "text-emerald-300" : "text-lr-text-faint"} title={operation.reason}>{operationLabel(operation.status)}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[10px] leading-4 text-lr-text-faint">
        {report.cameraRows.length === 0 ? "No camera-specific evidence is recorded." : `${report.cameraRows.length} camera evidence rows recorded.`}
      </p>
    </div>
  );
}
