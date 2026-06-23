"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DynamicPhotoGrid } from "@/components/library/DynamicPhotoGrid";
import { PhotoGrid } from "@/components/library/PhotoGrid";
import {
  LibraryToolbar,
  type CurationFilter,
  type FilterOption,
  type GridViewMode,
  type SortOption,
} from "@/components/shell/LibraryToolbar";
import { SidePanel } from "@/components/shell/SidePanel";
import { TopBar } from "@/components/shell/TopBar";
import { FolderPickerButton } from "@/components/shell/FolderPickerButton";
import {
  filterByCuration,
  filterByFormat,
  sortLibraryEntries,
} from "@/lib/library/curation";
import {
  filterByAlbum,
  filterByFolderPath,
} from "@/lib/library/folders";
import { useLibraryGridShortcuts } from "@/hooks/useEntryMetadataShortcuts";
import { useAlbumPickerShortcut } from "@/hooks/useAlbumPickerShortcut";
import { useLibraryContextMenu } from "@/hooks/useLibraryContextMenu";
import { useLibraryStore } from "@/stores/library-store";

export default function HomePage() {
  const router = useRouter();
  const entries = useLibraryStore((state) => state.entries);
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const selectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const setSelectedEntryId = useLibraryStore((state) => state.setSelectedEntryId);
  const folderName = useLibraryStore((state) => state.folderName);
  const albums = useLibraryStore((state) => state.albums);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const importState = useLibraryStore((state) => state.importState);
  const importStatus = useLibraryStore((state) => state.importStatus);
  const importError = useLibraryStore((state) => state.importError);
  const cancelFolderOperation = useLibraryStore(
    (state) => state.cancelFolderOperation,
  );

  const [sort, setSort] = useState<SortOption>("name");
  const [filter, setFilter] = useState<FilterOption>("all");
  const [curationFilter, setCurationFilter] = useState<CurationFilter>("all");
  const [thumbSize, setThumbSize] = useState(180);
  const [viewMode, setViewMode] = useState<GridViewMode>("grid");
  const [gridRows, setGridRows] = useState<string[][]>([]);

  const visibleEntries = useMemo(() => {
    let scoped = entries;

    if (catalogView.type === "folder") {
      scoped = filterByFolderPath(scoped, catalogView.path);
    } else if (catalogView.type === "album") {
      const album = albums.find((item) => item.id === catalogView.albumId);
      scoped = filterByAlbum(scoped, album);
    }

    return sortLibraryEntries(
      filterByFormat(
        filterByCuration(scoped, entryMetadata, curationFilter),
        filter,
      ),
      entryMetadata,
      sort,
    );
  }, [
    entries,
    entryMetadata,
    albums,
    catalogView,
    curationFilter,
    filter,
    sort,
  ]);

  const visibleOrder = useMemo(
    () => visibleEntries.map((entry) => entry.id),
    [visibleEntries],
  );

  const { openContextMenu, contextMenu } = useLibraryContextMenu(visibleOrder);

  const { albumPicker, albumPickerOpen } = useAlbumPickerShortcut({
    selectedEntryId,
    selectedEntryIds,
  });

  useLibraryGridShortcuts({
    gridRows,
    visibleEntries,
    selectedEntryId,
    selectedEntryIds,
    onSelect: setSelectedEntryId,
    onOpen: (id) => router.push(`/photo?id=${encodeURIComponent(id)}`),
    disabled: albumPickerOpen,
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {contextMenu}
      {albumPicker}
      <TopBar activeModule="library" />

      <div className="flex min-h-0 flex-1">
        <SidePanel />

        <div className="flex min-w-0 flex-1 flex-col">
          <LibraryToolbar
            photoCount={visibleEntries.length}
            sort={sort}
            filter={filter}
            curationFilter={curationFilter}
            thumbSize={thumbSize}
            viewMode={viewMode}
            onSortChange={setSort}
            onFilterChange={setFilter}
            onCurationFilterChange={setCurationFilter}
            onThumbSizeChange={setThumbSize}
            onViewModeChange={setViewMode}
          />

          <main className="min-h-0 flex-1 bg-lr-bg">
            {needsFolderAccess ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <div className="space-y-2">
                  <p className="text-sm text-lr-text-muted">
                    Re-link your folder to continue
                  </p>
                  <p className="max-w-sm text-xs text-lr-text-dim">
                    {folderName
                      ? `Select "${folderName}" again to restore access.`
                      : "Select your photo folder again to restore access."}{" "}
                    The folder may have been moved or deleted.
                  </p>
                </div>
                <div className="flex flex-col items-center gap-2 sm:flex-row">
                  <FolderPickerButton
                    mode="restore"
                    className="rounded bg-lr-accent px-4 py-2 text-sm text-white transition hover:bg-lr-accent/90"
                  >
                    {importState === "restoring" ? "Re-linking…" : "Re-link folder"}
                  </FolderPickerButton>
                  <FolderPickerButton
                    mode="import"
                    className="rounded border border-lr-border-subtle px-4 py-2 text-sm text-lr-text-muted transition hover:bg-lr-panel-raised hover:text-lr-text"
                  >
                    {importState === "importing"
                      ? "Importing…"
                      : "Import different folder"}
                  </FolderPickerButton>
                </div>
                {importStatus ? (
                  <p className="max-w-sm text-xs text-lr-text-dim">{importStatus}</p>
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
                {viewMode === "dynamic" ? (
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
                <p className="text-sm text-lr-text-muted">Reading folder…</p>
                {importStatus ? (
                  <p className="max-w-sm text-xs text-lr-text-dim">{importStatus}</p>
                ) : null}
                {folderName ? (
                  <p className="text-xs text-lr-text-dim">{folderName}</p>
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
                  Import a folder to begin
                </p>
                <p className="max-w-sm text-xs text-lr-text-dim">
                  Click Import in the toolbar to link a local photo folder.
                  Files stay on your machine.
                </p>
                <FolderPickerButton
                  mode="import"
                  className="rounded bg-lr-accent px-4 py-2 text-sm text-white transition hover:bg-lr-accent/90"
                >
                  Import folder
                </FolderPickerButton>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
