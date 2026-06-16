"use client";

import { useEffect, useMemo, useState } from "react";
import { DynamicPhotoGrid } from "@/components/library/DynamicPhotoGrid";
import { PhotoGrid } from "@/components/library/PhotoGrid";
import {
  LibraryToolbar,
  type FilterOption,
  type GridViewMode,
  type SortOption,
} from "@/components/shell/LibraryToolbar";
import { SidePanel } from "@/components/shell/SidePanel";
import { TopBar } from "@/components/shell/TopBar";
import { useLibraryStore } from "@/stores/library-store";

function filterEntries(
  entries: ReturnType<typeof useLibraryStore.getState>["entries"],
  filter: FilterOption,
) {
  if (filter === "raw") {
    return entries.filter((entry) => entry.profileId !== "standard");
  }
  if (filter === "standard") {
    return entries.filter((entry) => entry.profileId === "standard");
  }
  return entries;
}

function sortEntries(
  entries: ReturnType<typeof useLibraryStore.getState>["entries"],
  sort: SortOption,
) {
  const sorted = [...entries];
  if (sort === "date") {
    sorted.sort((a, b) => b.lastModified - a.lastModified);
    return sorted;
  }
  sorted.sort((a, b) => a.name.localeCompare(b.name));
  return sorted;
}

export default function HomePage() {
  const entries = useLibraryStore((state) => state.entries);
  const folderName = useLibraryStore((state) => state.folderName);
  const restoreLastFolder = useLibraryStore((state) => state.restoreLastFolder);
  const setSupportedBrowser = useLibraryStore((state) => state.setSupportedBrowser);

  const [sort, setSort] = useState<SortOption>("name");
  const [filter, setFilter] = useState<FilterOption>("all");
  const [thumbSize, setThumbSize] = useState(180);
  const [viewMode, setViewMode] = useState<GridViewMode>("grid");

  useEffect(() => {
    setSupportedBrowser("showDirectoryPicker" in window);
    void restoreLastFolder();
  }, [restoreLastFolder, setSupportedBrowser]);

  const rawCount = entries.filter((entry) => entry.profileId !== "standard").length;
  const standardCount = entries.filter(
    (entry) => entry.profileId === "standard",
  ).length;

  const visibleEntries = useMemo(
    () => sortEntries(filterEntries(entries, filter), sort),
    [entries, filter, sort],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar activeModule="library" />

      <div className="flex min-h-0 flex-1">
        <SidePanel
          folderName={folderName}
          photoCount={entries.length}
          rawCount={rawCount}
          standardCount={standardCount}
          filter={filter}
          onFilterChange={setFilter}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <LibraryToolbar
            photoCount={visibleEntries.length}
            sort={sort}
            filter={filter}
            thumbSize={thumbSize}
            viewMode={viewMode}
            onSortChange={setSort}
            onFilterChange={setFilter}
            onThumbSizeChange={setThumbSize}
            onViewModeChange={setViewMode}
          />

          <main className="min-h-0 flex-1 bg-lr-bg">
            {entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-lr-text-muted">
                  Import a folder to begin
                </p>
                <p className="max-w-sm text-xs text-lr-text-dim">
                  Click Import in the toolbar to link a local photo folder.
                  Files stay on your machine.
                </p>
              </div>
            ) : viewMode === "dynamic" ? (
              <DynamicPhotoGrid
                entries={visibleEntries}
                rowHeight={thumbSize}
              />
            ) : (
              <PhotoGrid entries={visibleEntries} thumbSize={thumbSize} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
