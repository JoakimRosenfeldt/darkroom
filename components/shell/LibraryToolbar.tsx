"use client";

import { useLibraryStore } from "@/stores/library-store";
import { FolderPickerButton } from "@/components/shell/FolderPickerButton";
import { IconDynamicGrid, IconFolder, IconGrid } from "./icons";

export type SortOption = "name" | "date";
export type FilterOption = "all" | "raw" | "standard";
export type GridViewMode = "grid" | "dynamic";

interface LibraryToolbarProps {
  photoCount: number;
  sort: SortOption;
  filter: FilterOption;
  thumbSize: number;
  viewMode: GridViewMode;
  onSortChange: (sort: SortOption) => void;
  onFilterChange: (filter: FilterOption) => void;
  onThumbSizeChange: (size: number) => void;
  onViewModeChange: (mode: GridViewMode) => void;
}

export function LibraryToolbar({
  photoCount,
  sort,
  filter,
  thumbSize,
  viewMode,
  onSortChange,
  onFilterChange,
  onThumbSizeChange,
  onViewModeChange,
}: LibraryToolbarProps) {
  const {
    folderName,
    importState,
    importStatus,
    importError,
    needsFolderAccess,
    isSupportedBrowser,
    clearLibrary,
  } = useLibraryStore();

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-lr-border-subtle bg-lr-panel px-2">
      {needsFolderAccess ? (
        <FolderPickerButton
          mode="restore"
          disabled={!isSupportedBrowser}
          className="flex h-7 items-center gap-1.5 rounded bg-lr-accent/20 px-2.5 text-xs text-lr-accent transition hover:bg-lr-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconFolder className="h-3.5 w-3.5" />
          {importState === "restoring" ? "Re-linking..." : "Re-link folder"}
        </FolderPickerButton>
      ) : null}

      <FolderPickerButton
        mode="import"
        disabled={!isSupportedBrowser}
        className="flex h-7 items-center gap-1.5 rounded bg-lr-panel-raised px-2.5 text-xs text-lr-text transition hover:bg-[#383838] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <IconFolder className="h-3.5 w-3.5 text-lr-accent" />
        {importState === "importing"
          ? "Importing..."
          : needsFolderAccess
            ? "Import different folder"
            : "Import"}
      </FolderPickerButton>

      {folderName && !needsFolderAccess ? (
        <FolderPickerButton
          mode="restore"
          className="h-7 rounded px-2 text-xs text-lr-text-muted transition hover:bg-lr-panel-raised hover:text-lr-text"
        >
          {importState === "restoring" ? "Restoring..." : "Re-link"}
        </FolderPickerButton>
      ) : null}

      <button
        type="button"
        onClick={() => void clearLibrary()}
        className="h-7 rounded px-2 text-xs text-lr-text-dim transition hover:bg-lr-panel-raised hover:text-red-400"
        title="Clear saved library and reset folder access"
      >
        Reset
      </button>

      <div className="mx-1 h-4 w-px bg-lr-border-subtle" />

      <span className="truncate text-xs text-lr-text-muted">
        {folderName ?? "No folder selected"}
      </span>

      {folderName && !needsFolderAccess ? (
        <span className="text-xs text-lr-text-dim">
          · {photoCount} photo{photoCount === 1 ? "" : "s"}
        </span>
      ) : null}

      <div className="flex-1" />

      <div className="flex items-center rounded border border-lr-border-subtle bg-lr-panel-raised p-0.5">
        <button
          type="button"
          onClick={() => onViewModeChange("grid")}
          className={[
            "flex h-6 items-center gap-1 rounded px-2 text-[11px] transition",
            viewMode === "grid"
              ? "bg-lr-selection text-lr-text"
              : "text-lr-text-muted hover:text-lr-text",
          ].join(" ")}
          title="Square grid"
        >
          <IconGrid className="h-3 w-3" />
          Grid
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("dynamic")}
          className={[
            "flex h-6 items-center gap-1 rounded px-2 text-[11px] transition",
            viewMode === "dynamic"
              ? "bg-lr-selection text-lr-text"
              : "text-lr-text-muted hover:text-lr-text",
          ].join(" ")}
          title="Dynamic grid (fixed height, variable width)"
        >
          <IconDynamicGrid className="h-3 w-3" />
          Dynamic
        </button>
      </div>

      <label className="flex items-center gap-1.5 text-xs text-lr-text-muted">
        <span className="text-[11px] text-lr-text-dim">
          {viewMode === "grid" ? "Size" : "Row height"}
        </span>
        <input
          type="range"
          min={120}
          max={320}
          step={20}
          value={thumbSize}
          onChange={(event) => onThumbSizeChange(Number(event.target.value))}
          className="h-1 w-20 cursor-pointer accent-lr-accent"
          title="Thumbnail size"
        />
      </label>

      <select
        value={filter}
        onChange={(event) =>
          onFilterChange(event.target.value as FilterOption)
        }
        className="h-7 rounded border border-lr-border-subtle bg-lr-panel-raised px-2 text-xs text-lr-text outline-none"
      >
        <option value="all">All Photos</option>
        <option value="raw">RAW</option>
        <option value="standard">JPEG / PNG</option>
      </select>

      <select
        value={sort}
        onChange={(event) => onSortChange(event.target.value as SortOption)}
        className="h-7 rounded border border-lr-border-subtle bg-lr-panel-raised px-2 text-xs text-lr-text outline-none"
      >
        <option value="name">Sort: File Name</option>
        <option value="date">Sort: Capture Date</option>
      </select>

      {importStatus ? (
        <span className="max-w-[220px] truncate text-xs text-lr-text-muted" title={importStatus}>
          {importStatus}
        </span>
      ) : null}

      {importError ? (
        <span className="max-w-[200px] truncate text-xs text-red-400" title={importError}>
          {importError}
        </span>
      ) : null}

      {!isSupportedBrowser ? (
        <span className="text-xs text-amber-400">Chrome / Edge required</span>
      ) : null}
    </div>
  );
}
