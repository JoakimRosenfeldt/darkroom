"use client";

import { useLibraryStore } from "@/stores/library-store";
import { FolderPickerButton } from "@/components/shell/FolderPickerButton";
import { StarRatingControl } from "@/components/library/StarRatingControl";
import type {
  CurationFilter,
  FilterOption,
  GridViewMode,
  SortOption,
} from "@/lib/library/curation";
import {
  curationFilterFromRating,
  getRatingFromCurationFilter,
  isRatingCurationFilter,
} from "@/lib/library/curation";
import type { StarRating } from "@/lib/catalog/types";
import { IconDynamicGrid, IconFolder, IconGrid } from "./icons";

export type { CurationFilter, FilterOption, GridViewMode, SortOption };

interface LibraryToolbarProps {
  photoCount: number;
  sort: SortOption;
  filter: FilterOption;
  curationFilter: CurationFilter;
  thumbSize: number;
  viewMode: GridViewMode;
  onSortChange: (sort: SortOption) => void;
  onFilterChange: (filter: FilterOption) => void;
  onCurationFilterChange: (filter: CurationFilter) => void;
  onThumbSizeChange: (size: number) => void;
  onViewModeChange: (mode: GridViewMode) => void;
  onExport: () => void;
}

export function LibraryToolbar({
  photoCount,
  sort,
  filter,
  curationFilter,
  thumbSize,
  viewMode,
  onSortChange,
  onFilterChange,
  onCurationFilterChange,
  onThumbSizeChange,
  onViewModeChange,
  onExport,
}: LibraryToolbarProps) {
  const {
    folderName,
    importState,
    needsFolderAccess,
    selectedEntryIds,
  } = useLibraryStore();

  const activeRatingFilter = getRatingFromCurationFilter(curationFilter);

  function handleRatingFilterChange(rating: StarRating) {
    onCurationFilterChange(curationFilterFromRating(rating, curationFilter));
  }

  return (
    <div className="flex h-14 shrink-0 min-w-0 items-center gap-2 overflow-x-auto border-b border-lr-border-subtle bg-lr-toolbar px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-w-[145px] shrink-0 flex-col gap-0.5">
        <span className="text-sm font-semibold tracking-tight text-lr-text">
          {folderName ?? "Library"}
        </span>
        <span className="font-mono text-[10px] text-lr-text-muted">
          {photoCount} photo{photoCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mx-1 h-6 w-px shrink-0 bg-lr-border-subtle" />
      {needsFolderAccess ? (
        <FolderPickerButton
          mode="restore"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-lr-selection px-2.5 text-xs text-lr-accent transition hover:bg-lr-panel-hover"
        >
          <IconFolder className="h-3.5 w-3.5" />
          {importState === "restoring" ? "Re-linking..." : "Re-link folder"}
        </FolderPickerButton>
      ) : null}

      <StarRatingControl
        value={activeRatingFilter}
        onChange={handleRatingFilterChange}
        starClassName="text-xs"
      />

      <select
        value={
          isRatingCurationFilter(curationFilter) ? "all" : curationFilter
        }
        onChange={(event) =>
          onCurationFilterChange(event.target.value as CurationFilter)
        }
        className="h-8 shrink-0 rounded-lg border border-lr-border-subtle bg-lr-panel-raised px-2 text-xs text-lr-text outline-none"
      >
        <option value="all">All Curation</option>
        <option value="picked">Picked</option>
        <option value="rejected">Rejected</option>
        <option value="unpicked">Unflagged</option>
        <option value="label-red">Red Label</option>
        <option value="label-yellow">Yellow Label</option>
        <option value="label-green">Green Label</option>
        <option value="label-blue">Blue Label</option>
        <option value="label-purple">Purple Label</option>
      </select>

      <select
        value={filter}
        onChange={(event) =>
          onFilterChange(event.target.value as FilterOption)
        }
        className="h-8 shrink-0 rounded-lg border border-lr-border-subtle bg-lr-panel-raised px-2 text-xs text-lr-text outline-none"
      >
        <option value="all">All Photos</option>
        <option value="raw">RAW</option>
        <option value="standard">JPEG / PNG</option>
      </select>

      <select
        value={sort}
        onChange={(event) => onSortChange(event.target.value as SortOption)}
        className="h-8 shrink-0 rounded-lg border border-lr-border-subtle bg-lr-panel-raised px-2 text-xs text-lr-text outline-none"
      >
        <option value="name">Sort: File Name</option>
        <option value="date">Sort: Capture Date</option>
        <option value="rating">Sort: Rating</option>
        <option value="pick">Sort: Pick Status</option>
      </select>

      <div className="flex-1" />

      <div className="flex shrink-0 items-center rounded-lg border border-lr-border-subtle bg-lr-panel-raised p-[3px]">
        <button
          type="button"
          onClick={() => onViewModeChange("dynamic")}
          className={[
            "flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] transition",
            viewMode === "dynamic"
              ? "bg-lr-selection text-lr-text"
              : "text-lr-text-muted hover:text-lr-text",
          ].join(" ")}
          title="Justified rows"
        >
          <IconDynamicGrid className="h-3 w-3" />
          Rows
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("grid")}
          className={[
            "flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] transition",
            viewMode === "grid"
              ? "bg-lr-selection text-lr-text"
              : "text-lr-text-muted hover:text-lr-text",
          ].join(" ")}
          title="Contact sheet"
        >
          <IconGrid className="h-3 w-3" />
          Sheet
        </button>
      </div>

      <label className="flex shrink-0 items-center gap-1.5 text-xs text-lr-text-muted">
        <span className="text-[11px] text-lr-text-muted">Size</span>
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

      <button
        type="button"
        onClick={onExport}
        disabled={selectedEntryIds.length === 0 || needsFolderAccess}
        className="h-8 shrink-0 rounded-lg bg-lr-accent px-3 text-xs font-medium text-[#14202a] transition hover:bg-lr-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        title={selectedEntryIds.length === 0 ? "Select photos to export" : "Export selected photos"}
      >
        Export{selectedEntryIds.length > 0 ? ` ${selectedEntryIds.length}` : ""}
      </button>
    </div>
  );
}
