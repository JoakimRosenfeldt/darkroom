"use client";

import { useEffect, useRef, useState } from "react";
import { COLOR_LABEL_HEX } from "@/lib/catalog/defaults";
import { COLOR_LABELS } from "@/lib/catalog/types";
import type {
  CurationFilter,
  FilterOption,
  GridViewMode,
  SortOption,
} from "@/lib/library/curation";
import {
  getRatingFromCurationFilter,
  isRatingCurationFilter,
} from "@/lib/library/curation";
import {
  EMPTY_LIBRARY_FACETS,
  UNKNOWN_FACET_VALUE,
  hasActiveFacets,
  type LibraryFacetCounts,
  type LibraryFacets,
  type NumericFacetRange,
  type NumericFacetSummary,
} from "@/lib/library/query";
import { useLibraryStore } from "@/stores/library-store";
import { FolderPickerButton } from "@/components/shell/FolderPickerButton";
import {
  IconChevronDown,
  IconDynamicGrid,
  IconFolder,
  IconGrid,
} from "./icons";

export type { CurationFilter, FilterOption, GridViewMode, SortOption };

interface LibraryToolbarProps {
  photoCount: number;
  sort: SortOption;
  sortDirection: "ascending" | "descending";
  filter: FilterOption;
  curationFilter: CurationFilter;
  textQuery: string;
  facets: LibraryFacets;
  facetCounts: LibraryFacetCounts;
  thumbSize: number;
  viewMode: GridViewMode;
  onSortChange: (sort: SortOption) => void;
  onSortDirectionChange: (direction: "ascending" | "descending") => void;
  onFilterChange: (filter: FilterOption) => void;
  onCurationFilterChange: (filter: CurationFilter) => void;
  onTextQueryChange: (query: string) => void;
  onFacetsChange: (facets: LibraryFacets) => void;
  onThumbSizeChange: (size: number) => void;
  onViewModeChange: (mode: GridViewMode) => void;
  autoAdvance: boolean;
  onAutoAdvanceChange: (enabled: boolean) => void;
  onCompare: () => void;
  onExport: () => void;
}

type ToolbarPopover = "sort" | "filter";

const SORT_OPTIONS: ReadonlyArray<{
  value: SortOption;
  label: string;
}> = [
  { value: "name", label: "File name" },
  { value: "date", label: "Capture date" },
  { value: "rating", label: "Rating" },
  { value: "pick", label: "Pick status" },
];

const RATING_FILTERS = [1, 2, 3, 4, 5] as const;

function getSortLabel(sort: SortOption): string {
  return SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "File name";
}

function getCurationLabel(filter: CurationFilter): string {
  switch (filter) {
    case "all":
      return "All curation";
    case "picked":
      return "Picked";
    case "rejected":
      return "Rejected";
    case "unpicked":
      return "Unflagged";
    case "rated":
      return "Rated";
    case "rating-1":
      return "1 star";
    case "rating-2":
      return "2 stars";
    case "rating-3":
      return "3 stars";
    case "rating-4":
      return "4 stars";
    case "rating-5":
      return "5 stars";
    case "label-red":
      return "Red label";
    case "label-yellow":
      return "Yellow label";
    case "label-green":
      return "Green label";
    case "label-blue":
      return "Blue label";
    case "label-purple":
      return "Purple label";
  }
}

function getFormatLabel(filter: FilterOption): string {
  if (filter === "raw") return "RAW";
  if (filter === "standard") return "JPEG / PNG";
  return "All photos";
}

export function LibraryToolbar({
  photoCount,
  sort,
  sortDirection,
  filter,
  curationFilter,
  textQuery,
  facets,
  facetCounts,
  thumbSize,
  viewMode,
  onSortChange,
  onSortDirectionChange,
  onFilterChange,
  onCurationFilterChange,
  onTextQueryChange,
  onFacetsChange,
  onThumbSizeChange,
  onViewModeChange,
  autoAdvance,
  onAutoAdvanceChange,
  onCompare,
  onExport,
}: LibraryToolbarProps) {
  const folderName = useLibraryStore((state) => state.folderName);
  const albums = useLibraryStore((state) => state.albums);
  const keywords = useLibraryStore((state) => state.libraryWorkspace.keywords);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const importState = useLibraryStore((state) => state.importState);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const [openPopover, setOpenPopover] = useState<ToolbarPopover | null>(null);
  const sortAreaRef = useRef<HTMLDivElement>(null);
  const filterAreaRef = useRef<HTMLDivElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const activeRatingFilter = getRatingFromCurationFilter(curationFilter);
  const activeFilterCount =
    (curationFilter === "all" ? 0 : 1) +
    (filter === "all" ? 0 : 1) +
    (hasActiveFacets(facets) ? 1 : 0);

  let scopeTitle = folderName ?? "Library";
  if (catalogView.type === "folder") {
    scopeTitle = catalogView.path === ""
      ? "Root"
      : catalogView.path?.split(/[\\/]+/).filter(Boolean).at(-1) ??
        folderName ??
        "Root";
  } else if (catalogView.type === "album") {
    scopeTitle =
      albums.find((album) => album.id === catalogView.albumId)?.name ?? "Album";
  } else if (catalogView.type === "archive") {
    scopeTitle = "Archive";
  } else if (catalogView.type === "quick") {
    scopeTitle = "Quick Collection";
  } else if (catalogView.type === "smart") {
    scopeTitle = useLibraryStore.getState().libraryWorkspace.collections.find(
      (node) => node.id === catalogView.collectionId,
    )?.name ?? "Smart Album";
  } else if (catalogView.type === "duplicates") {
    scopeTitle = "Duplicates";
  }

  useEffect(() => {
    if (!openPopover) return;

    const areaRef = openPopover === "sort" ? sortAreaRef : filterAreaRef;
    const triggerRef =
      openPopover === "sort" ? sortButtonRef : filterButtonRef;
    const focusFrame = window.requestAnimationFrame(() => {
      popoverRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    });

    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && areaRef.current?.contains(event.target)) {
        return;
      }
      setOpenPopover(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenPopover(null);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openPopover]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (
        (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f")
      ) {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  function toggleFacet(key: "cameras" | "lenses" | "locations" | "edited" | "albums" | "keywords", value: string) {
    const current: readonly string[] = facets[key];
    onFacetsChange({
      ...facets,
      [key]: current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    });
  }

  function toggleCurationFilter(next: CurationFilter) {
    onCurationFilterChange(curationFilter === next ? "all" : next);
  }

  return (
    <div className="relative z-30 flex h-14 shrink-0 min-w-0 items-center gap-2 border-b border-lr-border-subtle bg-lr-toolbar px-4">
      <div
        className={[
          "w-[150px] min-w-[100px] shrink flex-col gap-0.5",
          needsFolderAccess ? "flex max-[1100px]:hidden" : "flex",
        ].join(" ")}
      >
        <span className="truncate text-sm font-semibold tracking-[-0.01em] text-lr-text">
          {scopeTitle}
        </span>
        <span className="font-mono text-[10px] text-lr-text-faint">
          {photoCount} photo{photoCount === 1 ? "" : "s"}
        </span>
      </div>

      <div
        className={[
          "mx-1 h-6 w-px shrink-0 bg-lr-border-subtle",
          needsFolderAccess ? "max-[1100px]:hidden" : "",
        ].join(" ")}
      />

      <div className="relative min-w-[120px] max-w-[240px] flex-1">
        <input
          ref={searchRef}
          type="search"
          value={textQuery}
          onChange={(event) => onTextQueryChange(event.target.value)}
          placeholder="Search photos"
          aria-label="Search photos"
          className="h-[34px] w-full rounded-lg border border-lr-border-subtle bg-lr-panel-raised px-3 pr-8 text-xs text-lr-text outline-none placeholder:text-lr-text-faint focus:border-lr-accent"
        />
        {textQuery ? (
          <button
            type="button"
            onClick={() => {
              onTextQueryChange("");
              searchRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-lr-text-faint hover:text-lr-text"
          >
            ×
          </button>
        ) : null}
      </div>

      {needsFolderAccess ? (
        <FolderPickerButton
          mode="restore"
          className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg border border-lr-accent/40 bg-lr-selection px-2.5 text-xs text-lr-accent transition-colors hover:border-lr-accent/70"
          title="Re-link folder"
        >
          <IconFolder className="h-3.5 w-3.5" />
          <span className="max-[1100px]:hidden">
            {importState === "restoring" ? "Re-linking..." : "Re-link folder"}
          </span>
        </FolderPickerButton>
      ) : null}

      <div ref={sortAreaRef} className="relative shrink-0">
        <button
          ref={sortButtonRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={openPopover === "sort"}
          onClick={() =>
            setOpenPopover((current) => (current === "sort" ? null : "sort"))
          }
          className={[
            "flex h-[34px] items-center gap-2 rounded-lg border bg-lr-panel-raised px-3 text-xs text-lr-text transition-colors hover:border-lr-border",
            openPopover === "sort"
              ? "border-lr-accent/70"
              : "border-lr-border-subtle",
          ].join(" ")}
        >
          <span>Sort · {getSortLabel(sort)}</span>
          <IconChevronDown className="h-2.5 w-2.5 text-lr-text-faint" />
        </button>

        {openPopover === "sort" ? (
          <div
            ref={popoverRef}
            role="menu"
            aria-label="Sort photos"
            className="absolute left-0 top-[42px] z-50 w-[236px] rounded-[10px] border border-lr-border bg-lr-panel-raised p-1.5 shadow-[0_24px_48px_rgba(0,0,0,.55)]"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-faint">
              Sort by
            </p>
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={sort === option.value}
                onClick={() => {
                  onSortChange(option.value);
                  setOpenPopover(null);
                  sortButtonRef.current?.focus();
                }}
                className={[
                  "flex w-full items-center rounded-[7px] px-2.5 py-2 text-left text-xs transition-colors hover:bg-lr-panel-hover",
                  sort === option.value
                    ? "bg-lr-selection text-lr-text"
                    : "text-lr-text-muted",
                ].join(" ")}
              >
                <span>{option.label}</span>
                <span
                  aria-hidden="true"
                  className="ml-auto font-mono text-xs text-lr-accent"
                >
                  {sort === option.value ? "✓" : ""}
                </span>
              </button>
            ))}
            <div className="mt-1 grid grid-cols-2 gap-1 border-t border-lr-border-subtle pt-1.5">
              {(["ascending", "descending"] as const).map((direction) => (
                <FilterButton
                  key={direction}
                  active={sortDirection === direction}
                  onClick={() => onSortDirectionChange(direction)}
                >
                  {direction === "ascending" ? "Ascending" : "Descending"}
                </FilterButton>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div ref={filterAreaRef} className="relative shrink-0">
        <button
          ref={filterButtonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={openPopover === "filter"}
          onClick={() =>
            setOpenPopover((current) =>
              current === "filter" ? null : "filter",
            )
          }
          className={[
            "flex h-[34px] items-center gap-2 rounded-lg border bg-lr-panel-raised px-3 text-xs text-lr-text transition-colors hover:border-lr-border",
            openPopover === "filter"
              ? "border-lr-accent/70"
              : "border-lr-border-subtle",
          ].join(" ")}
        >
          Filter
          {activeFilterCount > 0 ? (
            <span className="rounded-[5px] bg-lr-selection px-1.5 py-0.5 font-mono text-[10px] text-lr-accent">
              {activeFilterCount}
            </span>
          ) : null}
        </button>

        {openPopover === "filter" ? (
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Filter photos"
            className="absolute left-0 top-[42px] z-50 flex w-72 flex-col gap-3.5 rounded-[10px] border border-lr-border bg-lr-panel-raised p-3 shadow-[0_24px_48px_rgba(0,0,0,.55)]"
          >
            <FilterSection label="Flag">
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    ["picked", "Picked"],
                    ["rejected", "Rejected"],
                    ["unpicked", "Unflagged"],
                  ] satisfies ReadonlyArray<[CurationFilter, string]>
                ).map(([value, label]) => (
                  <FilterButton
                    key={value}
                    active={curationFilter === value}
                    onClick={() => toggleCurationFilter(value)}
                  >
                    {label}
                  </FilterButton>
                ))}
              </div>
            </FilterSection>

            <FilterSection label="Rating">
              <div className="flex items-center gap-1">
                <FilterButton
                  active={curationFilter === "rated"}
                  onClick={() => toggleCurationFilter("rated")}
                  className="px-2"
                >
                  Any
                </FilterButton>
                <div className="flex items-center gap-0.5">
                  {RATING_FILTERS.map((rating) => (
                    <button
                      key={rating}
                      type="button"
                      aria-label={`Show photos rated exactly ${rating} star${rating === 1 ? "" : "s"}`}
                      aria-pressed={activeRatingFilter === rating}
                      onClick={() =>
                        toggleCurationFilter(`rating-${rating}`)
                      }
                      className={[
                        "rounded px-0.5 py-1 text-base transition-colors",
                        rating <= activeRatingFilter
                          ? "text-lr-accent"
                          : "text-lr-border hover:text-lr-text-muted",
                      ].join(" ")}
                    >
                      ★
                    </button>
                  ))}
                </div>
                <span className="ml-auto font-mono text-[10px] text-lr-text-faint">
                  {isRatingCurationFilter(curationFilter)
                    ? `= ${activeRatingFilter}`
                    : "exact"}
                </span>
              </div>
            </FilterSection>

            <FilterSection label="Color label">
              <div className="flex items-center gap-2">
                {COLOR_LABELS.map((label) => {
                  const value = `label-${label}` satisfies CurationFilter;
                  const active = curationFilter === value;
                  return (
                    <button
                      key={label}
                      type="button"
                      title={`${label} label`}
                      aria-pressed={active}
                      onClick={() => toggleCurationFilter(value)}
                      className="h-[18px] w-[18px] rounded-[5px] border-2 transition-transform hover:scale-110"
                      style={{
                        backgroundColor: COLOR_LABEL_HEX[label],
                        borderColor: active ? "#ece7e3" : "transparent",
                      }}
                    />
                  );
                })}
              </div>
            </FilterSection>

            <FilterSection label="File type">
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    ["all", "All"],
                    ["raw", "RAW"],
                    ["standard", "JPEG / PNG"],
                  ] satisfies ReadonlyArray<[FilterOption, string]>
                ).map(([value, label]) => (
                  <FilterButton
                    key={value}
                    active={filter === value}
                    onClick={() => onFilterChange(value)}
                  >
                    {label}
                  </FilterButton>
                ))}
              </div>
            </FilterSection>

            <div className="max-h-64 space-y-3 overflow-y-auto border-t border-lr-border-subtle pt-3">
              <FacetValues
                label="Camera"
                values={facetCounts.cameras}
                selected={facets.cameras}
                onToggle={(value) => toggleFacet("cameras", value)}
              />
              <FacetValues
                label="Lens"
                values={facetCounts.lenses}
                selected={facets.lenses}
                onToggle={(value) => toggleFacet("lenses", value)}
              />
              <FacetValues
                label="Location"
                values={facetCounts.locations}
                selected={facets.locations}
                onToggle={(value) => toggleFacet("locations", value)}
              />
              <FilterSection label="ISO range">
                <NumericFacetInputs
                  min={facets.iso.min}
                  max={facets.iso.max}
                  includeUnknown={facets.iso.includeUnknown}
                  available={facetCounts.iso}
                  onChange={(iso) => onFacetsChange({ ...facets, iso })}
                />
              </FilterSection>
              <FilterSection label="Focal length range">
                <NumericFacetInputs
                  min={facets.focalLength.min}
                  max={facets.focalLength.max}
                  includeUnknown={facets.focalLength.includeUnknown}
                  available={facetCounts.focalLength}
                  onChange={(focalLength) => onFacetsChange({ ...facets, focalLength })}
                />
              </FilterSection>
              <FacetValues
                label="Develop"
                values={facetCounts.edited}
                selected={facets.edited}
                onToggle={(value) => toggleFacet("edited", value)}
              />
              <FacetValues
                label="Album"
                values={Object.fromEntries(Object.entries(facetCounts.albums).map(([id, count]) => [
                  albums.find((album) => album.id === id)?.name ?? id,
                  count,
                ]))}
                selected={facets.albums.map((id) => albums.find((album) => album.id === id)?.name ?? id)}
                onToggle={(name) => {
                  const id = albums.find((album) => album.name === name)?.id ?? name;
                  toggleFacet("albums", id);
                }}
              />
              <FilterSection label="Keyword">
                <div className="flex flex-wrap gap-1">
                  {(["exact", "descendants", "ancestors"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={facets.keywordMode === mode}
                      onClick={() => onFacetsChange({ ...facets, keywordMode: mode })}
                      className={`rounded-md border px-2 py-1 text-[10px] ${facets.keywordMode === mode ? "border-lr-accent bg-lr-selection text-lr-accent" : "border-lr-border-subtle text-lr-text-muted"}`}
                    >
                      {mode === "exact" ? "Exact" : mode === "descendants" ? "Include descendants" : "Include ancestors"}
                    </button>
                  ))}
                </div>
                <FacetValueButtons
                  values={Object.fromEntries(Object.entries(facetCounts.keywords).map(([id, count]) => [
                    keywords.find((keyword) => keyword.id === id)?.name ?? id,
                    count,
                  ]))}
                  selected={facets.keywords.map((id) => keywords.find((keyword) => keyword.id === id)?.name ?? id)}
                  onToggle={(name) => {
                    const id = keywords.find((keyword) => keyword.name === name)?.id ?? name;
                    toggleFacet("keywords", id);
                  }}
                />
              </FilterSection>
            </div>

            <div className="flex items-center gap-2 border-t border-lr-border-subtle pt-2.5">
              <span className="text-[11px] text-lr-text-faint">
                {photoCount} match{photoCount === 1 ? "" : "es"}
              </span>
              <button
                type="button"
                onClick={() => onFacetsChange(EMPTY_LIBRARY_FACETS)}
                disabled={!hasActiveFacets(facets)}
                className="text-[11px] text-lr-text-muted hover:text-lr-text disabled:opacity-40"
              >
                Clear metadata
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenPopover(null);
                  filterButtonRef.current?.focus();
                }}
                className="ml-auto rounded-[7px] bg-lr-accent px-3 py-1.5 text-[11px] font-medium text-[#14202a] transition-colors hover:bg-lr-accent-hover"
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {curationFilter !== "all" ? (
        <FilterChip
          label={getCurationLabel(curationFilter)}
          onClear={() => onCurationFilterChange("all")}
        />
      ) : null}
      {filter !== "all" ? (
        <FilterChip
          label={getFormatLabel(filter)}
          onClear={() => onFilterChange("all")}
        />
      ) : null}
      {hasActiveFacets(facets) ? (
        <FilterChip label="Metadata filters" onClear={() => onFacetsChange(EMPTY_LIBRARY_FACETS)} />
      ) : null}

      <div className="flex-1" />

      <div className="flex shrink-0 items-center rounded-lg border border-lr-border-subtle bg-lr-panel-raised p-[3px]">
        <button
          type="button"
          onClick={() => onViewModeChange("dynamic")}
          aria-pressed={viewMode === "dynamic"}
          className={[
            "flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[11px] transition-colors",
            viewMode === "dynamic"
              ? "bg-lr-selection text-lr-accent"
              : "text-lr-text-muted hover:text-lr-text",
          ].join(" ")}
          title="Justified rows"
        >
          <IconDynamicGrid className="h-3 w-3" />
          <span className="max-[1100px]:hidden">Rows</span>
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("grid")}
          aria-pressed={viewMode === "grid"}
          className={[
            "flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[11px] transition-colors",
            viewMode === "grid"
              ? "bg-lr-selection text-lr-accent"
              : "text-lr-text-muted hover:text-lr-text",
          ].join(" ")}
          title="Contact sheet"
        >
          <IconGrid className="h-3 w-3" />
          <span className="max-[1100px]:hidden">Sheet</span>
        </button>
      </div>

      <label className="flex shrink-0 items-center gap-2 text-[11px] text-lr-text-faint max-[1050px]:hidden">
        <span>Size</span>
        <input
          type="range"
          min={120}
          max={320}
          step={20}
          value={thumbSize}
          onChange={(event) => onThumbSizeChange(Number(event.target.value))}
          className="thin-slider w-[88px]"
          aria-label="Thumbnail size"
        />
      </label>

      <button
        type="button"
        aria-pressed={autoAdvance}
        onClick={() => onAutoAdvanceChange(!autoAdvance)}
        className={`h-[34px] shrink-0 rounded-lg border px-2.5 text-[11px] transition-colors ${
          autoAdvance
            ? "border-lr-accent bg-lr-selection text-lr-accent"
            : "border-lr-border-subtle text-lr-text-muted hover:text-lr-text"
        }`}
        title="Advance after single-photo curation"
      >
        Auto
      </button>

      <button
        type="button"
        onClick={onCompare}
        disabled={selectedEntryIds.length !== 2}
        className="h-[34px] shrink-0 rounded-lg border border-lr-border-subtle px-3 text-xs text-lr-text-muted transition hover:text-lr-text disabled:opacity-35"
        title="Compare exactly two selected photos"
      >
        Compare
      </button>

      <button
        type="button"
        onClick={onExport}
        disabled={selectedEntryIds.length === 0 || needsFolderAccess}
        className="h-[34px] shrink-0 rounded-lg bg-lr-accent px-3.5 text-xs font-medium text-[#14202a] transition-colors hover:bg-lr-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        title={
          selectedEntryIds.length === 0
            ? "Select photos to export"
            : "Export selected photos"
        }
      >
        Export{selectedEntryIds.length > 0 ? ` ${selectedEntryIds.length}` : ""}
      </button>
    </div>
  );
}

function FilterSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-faint">
        {label}
      </h3>
      {children}
    </section>
  );
}

function FacetValues({
  label,
  values,
  selected,
  onToggle,
}: {
  label: string;
  values: Readonly<Record<string, number>>;
  selected: readonly string[];
  onToggle: (value: string) => void;
}) {
  return (
    <FilterSection label={label}>
      <FacetValueButtons values={values} selected={selected} onToggle={onToggle} />
    </FilterSection>
  );
}

function FacetValueButtons({
  values,
  selected,
  onToggle,
}: {
  values: Readonly<Record<string, number>>;
  selected: readonly string[];
  onToggle: (value: string) => void;
}) {
  const items = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 12);
  return items.length > 0 ? (
    <div className="flex flex-wrap gap-1">
      {items.map(([value, count]) => (
        <button
          key={value}
          type="button"
          aria-pressed={selected.includes(value)}
          onClick={() => onToggle(value)}
          className={`rounded-md border px-2 py-1 text-[10px] ${selected.includes(value) ? "border-lr-accent bg-lr-selection text-lr-accent" : "border-lr-border-subtle text-lr-text-muted hover:border-lr-border"}`}
        >
          {value === UNKNOWN_FACET_VALUE ? "Unkeyworded" : value} · {count}
        </button>
      ))}
    </div>
  ) : (
    <p className="text-[10px] text-lr-text-faint">No values under the current filters.</p>
  );
}

function NumericFacetInputs({
  min,
  max,
  includeUnknown,
  available,
  onChange,
}: NumericFacetRange & {
  available: NumericFacetSummary;
  onChange: (range: NumericFacetRange) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <input
        type="number"
        value={min ?? ""}
        placeholder={available.min === null ? "Min" : String(available.min)}
        aria-label="Minimum value"
        onChange={(event) => onChange({ min: event.target.value === "" ? null : Number(event.target.value), max, includeUnknown })}
        className="min-w-0 rounded-md border border-lr-border-subtle bg-lr-panel px-2 py-1.5 text-[11px] text-lr-text outline-none focus:border-lr-accent"
      />
      <input
        type="number"
        value={max ?? ""}
        placeholder={available.max === null ? "Max" : String(available.max)}
        aria-label="Maximum value"
        onChange={(event) => onChange({ min, max: event.target.value === "" ? null : Number(event.target.value), includeUnknown })}
        className="min-w-0 rounded-md border border-lr-border-subtle bg-lr-panel px-2 py-1.5 text-[11px] text-lr-text outline-none focus:border-lr-accent"
      />
      <label className="col-span-2 flex items-center gap-2 text-[10px] text-lr-text-muted">
        <input
          type="checkbox"
          checked={includeUnknown}
          onChange={(event) => onChange({ min, max, includeUnknown: event.target.checked })}
        />
        Include unknown ({available.unknownCount})
      </label>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  className = "",
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        "rounded-[7px] border px-1.5 py-1.5 text-[11px] transition-colors",
        active
          ? "border-lr-accent bg-lr-selection text-lr-accent"
          : "border-lr-border-subtle text-lr-text-muted hover:border-lr-border hover:bg-lr-panel-hover",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-lr-border bg-lr-panel-raised py-1 pl-2.5 pr-1 text-[11px] text-lr-text-muted max-[1100px]:hidden">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label} filter`}
        className="flex h-4 w-4 items-center justify-center rounded-full text-sm leading-none text-lr-text-faint transition-colors hover:bg-lr-panel-hover hover:text-lr-text"
      >
        ×
      </button>
    </span>
  );
}
