"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { DynamicPhotoGrid } from "@/components/library/DynamicPhotoGrid";
import { DuplicateWorkspace } from "@/components/library/DuplicateWorkspace";
import { PhotoGrid } from "@/components/library/PhotoGrid";
import { LibraryToolbar } from "@/components/shell/LibraryToolbar";
import { SidePanel } from "@/components/shell/SidePanel";
import { ModuleSpine } from "@/components/shell/ModuleSpine";
import { FolderPickerButton } from "@/components/shell/FolderPickerButton";
import { useLibraryGridShortcuts } from "@/hooks/useEntryMetadataShortcuts";
import { useLibraryResult } from "@/hooks/useLibraryResult";
import { useAlbumPickerShortcut } from "@/hooks/useAlbumPickerShortcut";
import { useLibraryContextMenu } from "@/hooks/useLibraryContextMenu";
import { useLibraryStore } from "@/stores/library-store";
import { ExportDialog } from "@/components/export/ExportDialog";
import { StarRatingControl } from "@/components/library/StarRatingControl";
import { COLOR_LABEL_HEX, getEntryMetadata } from "@/lib/catalog/defaults";
import type { EntryMetadata } from "@/lib/catalog/types";
import { COLOR_LABELS } from "@/lib/catalog/types";
import { useLibraryViewSettings } from "@/hooks/useLibraryViewSettings";

export default function HomePage() {
  const router = useRouter();
  const entries = useLibraryStore((state) => state.entries);
  const archivedEntryIds = useLibraryStore((state) => state.archivedEntryIds);
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const selectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const folderName = useLibraryStore((state) => state.folderName);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const importState = useLibraryStore((state) => state.importState);
  const importStatus = useLibraryStore((state) => state.importStatus);
  const importError = useLibraryStore((state) => state.importError);
  const metadataAnalysis = useLibraryStore((state) => state.metadataAnalysis);
  const cancelFolderOperation = useLibraryStore(
    (state) => state.cancelFolderOperation,
  );
  const applyMetadataToEntries = useLibraryStore(
    (state) => state.applyMetadataToEntries,
  );
  const setCatalogView = useLibraryStore((state) => state.setCatalogView);
  const reconcileSelection = useLibraryStore((state) => state.reconcileSelection);
  const cancelMetadataAnalysis = useLibraryStore((state) => state.cancelMetadataAnalysis);

  useEffect(() => {
    if (catalogView.type === "archive" && archivedEntryIds.length === 0) {
      setCatalogView({ type: "all" });
    }
  }, [archivedEntryIds.length, catalogView.type, setCatalogView]);

  const [viewSettings, updateViewSettings] = useLibraryViewSettings();
  const {
    sort,
    sortDirection,
    filter,
    curationFilter,
    textQuery,
    facets,
    thumbSize,
    viewMode,
    autoAdvance,
  } = viewSettings;
  const [gridRows, setGridRows] = useState<string[][]>([]);
  const [exportEntryIds, setExportEntryIds] = useState<string[] | null>(null);

  const libraryResult = useLibraryResult();
  const visibleEntries = useMemo(() => {
    const byId = new Map<string, (typeof entries)[number]>(
      entries.map((entry) => [entry.id, entry]),
    );
    return libraryResult.visibleEntryIds
      .map((id) => byId.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  }, [entries, libraryResult.visibleEntryIds]);
  const visibleOrder = [...libraryResult.visibleEntryIds];

  useEffect(() => {
    reconcileSelection(libraryResult.visibleEntryIds);
  }, [libraryResult.revision, libraryResult.visibleEntryIds, reconcileSelection]);

  const { openContextMenu, contextMenu, actionOverlayOpen } =
    useLibraryContextMenu(visibleOrder, setExportEntryIds);

  const {
    albumPicker,
    removePopup,
    overlayOpen,
    openAlbumPicker,
    openRemovePopup,
  } = useAlbumPickerShortcut({
    selectedEntryId,
    selectedEntryIds,
    disabled: actionOverlayOpen || exportEntryIds !== null,
  });

  useLibraryGridShortcuts({
    gridRows,
    visibleEntries,
    visibleOrder,
    selectedEntryId,
    selectedEntryIds,
    onOpen: (id) => router.push(`/photo?id=${encodeURIComponent(id)}`),
    disabled: overlayOpen || actionOverlayOpen || exportEntryIds !== null,
    metadataShortcutsDisabled: catalogView.type === "archive",
  });

  return (
    <div className="flex h-screen overflow-hidden bg-lr-toolbar">
      {contextMenu}
      {albumPicker}
      {removePopup}
      <ModuleSpine activeModule="library" />

      <div className="flex min-h-0 flex-1">
        <SidePanel />

        <div className="flex min-w-0 flex-1 flex-col">
          <LibraryToolbar
            photoCount={libraryResult.photoCount}
            sort={sort}
            sortDirection={sortDirection}
            filter={filter}
            curationFilter={curationFilter}
            textQuery={textQuery}
            facets={facets}
            facetCounts={libraryResult.facetCounts}
            thumbSize={thumbSize}
            viewMode={viewMode}
            onSortChange={(next) => updateViewSettings({ sort: next })}
            onSortDirectionChange={(next) => updateViewSettings({ sortDirection: next })}
            onFilterChange={(next) => updateViewSettings({ filter: next })}
            onCurationFilterChange={(next) =>
              updateViewSettings({ curationFilter: next })
            }
            onTextQueryChange={(next) => updateViewSettings({ textQuery: next })}
            onFacetsChange={(next) => updateViewSettings({ facets: next })}
            onThumbSizeChange={(next) =>
              updateViewSettings({ thumbSize: next })
            }
            onViewModeChange={(next) =>
              updateViewSettings({ viewMode: next })
            }
            autoAdvance={autoAdvance}
            onAutoAdvanceChange={(next) => updateViewSettings({ autoAdvance: next })}
            onCompare={() => {
              const [candidateId, selectId] = selectedEntryIds;
              if (candidateId && selectId) {
                router.push(`/compare?select=${encodeURIComponent(selectId)}&candidate=${encodeURIComponent(candidateId)}`);
              }
            }}
            onExport={() => setExportEntryIds(selectedEntryIds)}
          />

          <main className="min-h-0 flex-1 bg-lr-bg">
            {needsFolderAccess ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <div className="space-y-2">
                  <p className="text-sm text-lr-text-muted">
                    Open or re-link a catalog to continue
                  </p>
                  <p className="max-w-sm text-xs text-lr-text-muted">
                    {folderName
                      ? `Select a root for "${folderName}" again to restore access.`
                      : "Open a catalog or link a photo root to restore access."}{" "}
                    The root may have been moved or deleted.
                  </p>
                </div>
                <div className="flex flex-col items-center gap-2 sm:flex-row">
                  <FolderPickerButton
                    mode="restore"
                    className="rounded bg-lr-accent px-4 py-2 text-sm text-white transition hover:bg-lr-accent/90"
                  >
                    {importState === "restoring" ? "Re-linking…" : "Re-link root"}
                  </FolderPickerButton>
                  <FolderPickerButton
                    mode="import"
                    className="rounded border border-lr-border-subtle px-4 py-2 text-sm text-lr-text-muted transition hover:bg-lr-panel-raised hover:text-lr-text"
                  >
                    {importState === "importing"
                      ? "Opening…"
                      : "Open catalog"}
                  </FolderPickerButton>
                </div>
                {importStatus ? (
                  <p className="max-w-sm text-xs text-lr-text-muted">{importStatus}</p>
                ) : null}
                {importError ? (
                  <p className="max-w-sm text-xs text-red-400">{importError}</p>
                ) : null}
              </div>
            ) : entries.length > 0 ? (
              <>
                {importStatus ? (
                  <div className="border-b border-lr-border-subtle bg-lr-panel px-3 py-1.5 text-xs text-lr-text-muted">
                    {importStatus}
                  </div>
                ) : null}
                {metadataAnalysis ? (
                  <div className="flex items-center gap-3 border-b border-lr-border-subtle bg-lr-panel px-3 py-1.5 text-xs text-lr-text-muted" role="status">
                    <span>
                      {metadataAnalysis.cancelled ? "Stopping metadata analysis" : "Analyzing metadata"}
                      {` · ${metadataAnalysis.completed}/${metadataAnalysis.total}`}
                      {metadataAnalysis.failed > 0 ? ` · ${metadataAnalysis.failed} unavailable` : ""}
                    </span>
                    {!metadataAnalysis.cancelled ? (
                      <button
                        type="button"
                        onClick={cancelMetadataAnalysis}
                        className="text-lr-text transition hover:text-lr-accent"
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {importError ? (
                  <div className="border-b border-lr-border-subtle bg-lr-panel px-3 py-1.5 text-xs text-red-400">
                    {importError}
                  </div>
                ) : null}
                {catalogView.type === "duplicates" ? (
                  <DuplicateWorkspace />
                ) : visibleEntries.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <p className="text-sm text-lr-text-muted">No photos match this view.</p>
                    <p className="max-w-sm text-xs text-lr-text-faint">
                      {textQuery ? `Nothing matched “${textQuery}”. Clear search or adjust filters.` : "Adjust the active filters or choose another collection."}
                    </p>
                  </div>
                ) : viewMode === "dynamic" ? (
                  <DynamicPhotoGrid
                    entries={visibleEntries}
                    rowHeight={thumbSize}
                    onGridRowsChange={setGridRows}
                    onPhotoContextMenu={openContextMenu}
                  />
                ) : (
                  <PhotoGrid
                    entries={visibleEntries}
                    thumbSize={thumbSize}
                    onGridRowsChange={setGridRows}
                    onPhotoContextMenu={openContextMenu}
                  />
                )}
              </>
            ) : importState === "importing" || importState === "restoring" ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-lr-text-muted">Reading catalog…</p>
                {importStatus ? (
                  <p className="max-w-sm text-xs text-lr-text-muted">{importStatus}</p>
                ) : null}
                {folderName ? (
                  <p className="text-xs text-lr-text-muted">{folderName}</p>
                ) : null}
                {importError ? (
                  <p className="max-w-sm text-xs text-red-400">{importError}</p>
                ) : null}
                <button
                  type="button"
                  onClick={() => cancelFolderOperation()}
                  className="rounded border border-lr-border-subtle px-4 py-2 text-sm text-lr-text-muted transition hover:bg-lr-panel-raised hover:text-lr-text"
                >
                  Cancel
                </button>
              </div>
            ) : importError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-red-400">{importError}</p>
                <FolderPickerButton
                  mode="import"
                  className="rounded bg-lr-accent px-4 py-2 text-sm text-white transition hover:bg-lr-accent/90"
                >
                  Try again
                </FolderPickerButton>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-lr-text-muted">
                  Open a catalog to begin
                </p>
                <p className="max-w-sm text-xs text-lr-text-muted">
                  Open a catalog to link local photo roots. Files stay on your machine.
                </p>
                <FolderPickerButton
                  mode="import"
                  className="rounded bg-lr-accent px-4 py-2 text-sm text-white transition hover:bg-lr-accent/90"
                >
                  Open catalog
                </FolderPickerButton>
              </div>
            )}
          </main>
          {catalogView.type === "archive" ? null : (
            <LibraryCurationBar
              selectedEntryIds={selectedEntryIds}
              entryMetadata={entryMetadata}
              onApply={applyMetadataToEntries}
              onAddToAlbum={openAlbumPicker}
              onRemove={openRemovePopup}
            />
          )}
        </div>
      </div>
      {exportEntryIds ? (
        <ExportDialog
          entries={entries.filter((entry) => exportEntryIds.includes(entry.id))}
          onClose={() => setExportEntryIds(null)}
        />
      ) : null}
    </div>
  );
}

function LibraryCurationBar({
  selectedEntryIds,
  entryMetadata,
  onApply,
  onAddToAlbum,
  onRemove,
}: {
  selectedEntryIds: string[];
  entryMetadata: Record<string, EntryMetadata>;
  onApply: (
    entryIds: string[],
    patch: Partial<EntryMetadata>,
  ) => void;
  onAddToAlbum: () => void;
  onRemove: () => void;
}) {
  const selectedMetadata = getEntryMetadata(
    entryMetadata,
    selectedEntryIds.at(-1) ?? "",
  );

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 overflow-x-auto border-t border-lr-border-subtle bg-lr-toolbar px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="shrink-0 text-xs text-lr-text-muted">
        {selectedEntryIds.length > 0
          ? `${selectedEntryIds.length} selected`
          : "No selection"}
      </span>
      {selectedEntryIds.length > 0 ? (
        <>
          <div className="h-5 w-px bg-lr-border-subtle" />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onApply(selectedEntryIds, { pick: "pick" })}
              aria-pressed={selectedMetadata.pick === "pick"}
              className={[
                "rounded-md px-2.5 py-1.5 text-[11px] transition-colors",
                selectedMetadata.pick === "pick"
                  ? "bg-[#2f3a2f] text-[#8fd0a0]"
                  : "text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text",
              ].join(" ")}
            >
              Pick <span className="text-[#6a7a6a]">P</span>
            </button>
            <button
              type="button"
              onClick={() => onApply(selectedEntryIds, { pick: "reject" })}
              aria-pressed={selectedMetadata.pick === "reject"}
              className={[
                "rounded-md px-2.5 py-1.5 text-[11px] transition-colors",
                selectedMetadata.pick === "reject"
                  ? "bg-[#3c2925] text-lr-danger"
                  : "text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text",
              ].join(" ")}
            >
              Reject <span className="text-lr-text-muted">X</span>
            </button>
            <button
              type="button"
              onClick={() => onApply(selectedEntryIds, { pick: "none" })}
              aria-pressed={selectedMetadata.pick === "none"}
              className={[
                "rounded-md px-2.5 py-1.5 text-[11px] transition-colors",
                selectedMetadata.pick === "none"
                  ? "bg-lr-selection text-lr-accent"
                  : "text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text",
              ].join(" ")}
            >
              Unflag <span className="text-lr-text-muted">U</span>
            </button>
          </div>
          <div className="h-5 w-px bg-lr-border-subtle" />
          <StarRatingControl
            value={selectedMetadata.rating}
            onChange={(rating) => onApply(selectedEntryIds, { rating })}
            starClassName="text-sm"
          />
          <div className="h-5 w-px bg-lr-border-subtle" />
          <div className="flex items-center gap-2">
            {COLOR_LABELS.map((label) => (
              <button
                key={label}
                type="button"
                title={`${label} label`}
                aria-label={`${label} color label`}
                onClick={() =>
                  onApply(selectedEntryIds, {
                    colorLabel:
                      selectedMetadata.colorLabel === label ? null : label,
                  })
                }
                className="h-3.5 w-3.5 rounded-[4px] border transition hover:scale-110"
                style={{
                  backgroundColor: COLOR_LABEL_HEX[label],
                  borderColor:
                    selectedMetadata.colorLabel === label
                      ? "#ece7e3"
                      : "transparent",
                }}
              />
            ))}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            disabled={selectedEntryIds.length === 0}
            onClick={onAddToAlbum}
            className="h-8 shrink-0 rounded-lg border border-lr-border-subtle px-3 text-xs text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add to album <span className="text-lr-text-muted">B</span>
          </button>
          <button
            type="button"
            disabled={selectedEntryIds.length === 0}
            onClick={onRemove}
            className="h-8 shrink-0 rounded-lg border border-lr-border-subtle px-3 text-xs text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Remove…
          </button>
        </>
      ) : null}
    </div>
  );
}
