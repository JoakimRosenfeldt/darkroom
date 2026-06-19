"use client";

import { COLOR_LABEL_HEX } from "@/lib/catalog/defaults";
import { StarRatingControl } from "@/components/library/StarRatingControl";
import type { CurationCounts } from "@/lib/library/curation";
import {
  curationFilterFromRating,
  getRatingFromCurationFilter,
} from "@/lib/library/rating-filter";
import type { CurationFilter, FilterOption } from "@/lib/library/filter-types";
import type { StarRating } from "@/lib/catalog/types";

interface SidePanelProps {
  folderName: string | null;
  photoCount: number;
  rawCount: number;
  standardCount: number;
  curationCounts: CurationCounts;
  filter: FilterOption;
  curationFilter: CurationFilter;
  onFilterChange: (filter: FilterOption) => void;
  onCurationFilterChange: (filter: CurationFilter) => void;
}

export function SidePanel({
  folderName,
  photoCount,
  rawCount,
  standardCount,
  curationCounts,
  filter,
  curationFilter,
  onFilterChange,
  onCurationFilterChange,
}: SidePanelProps) {
  const formatFilters: Array<{ id: FilterOption; label: string; count: number }> = [
    { id: "all", label: "All Photographs", count: photoCount },
    { id: "raw", label: "RAW", count: rawCount },
    { id: "standard", label: "JPEG / PNG", count: standardCount },
  ];

  const curationFilters: Array<{
    id: CurationFilter;
    label: string;
    count: number;
    dotColor?: string;
  }> = [
    { id: "picked", label: "Picked", count: curationCounts.picked },
    { id: "rejected", label: "Rejected", count: curationCounts.rejected },
    { id: "unpicked", label: "Unflagged", count: curationCounts.unpicked },
    {
      id: "label-red",
      label: "Red",
      count: curationCounts.labelRed,
      dotColor: COLOR_LABEL_HEX.red,
    },
    {
      id: "label-yellow",
      label: "Yellow",
      count: curationCounts.labelYellow,
      dotColor: COLOR_LABEL_HEX.yellow,
    },
    {
      id: "label-green",
      label: "Green",
      count: curationCounts.labelGreen,
      dotColor: COLOR_LABEL_HEX.green,
    },
    {
      id: "label-blue",
      label: "Blue",
      count: curationCounts.labelBlue,
      dotColor: COLOR_LABEL_HEX.blue,
    },
    {
      id: "label-purple",
      label: "Purple",
      count: curationCounts.labelPurple,
      dotColor: COLOR_LABEL_HEX.purple,
    },
  ];

  const activeRatingFilter = getRatingFromCurationFilter(curationFilter);

  function handleRatingFilterChange(rating: StarRating) {
    onCurationFilterChange(curationFilterFromRating(rating, curationFilter));
  }

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-lr-border-subtle bg-lr-panel">
      <div className="border-b border-lr-border-subtle px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-dim">
          Catalog
        </h2>
      </div>

      <div className="flex-1 overflow-auto py-1">
        <section className="px-2 py-1">
          <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
            Folders
          </h3>
          <div className="rounded px-2 py-1.5 text-xs text-lr-text">
            {folderName ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-lr-accent" />
                <span className="truncate">{folderName}</span>
              </span>
            ) : (
              <span className="text-lr-text-dim">No folder linked</span>
            )}
          </div>
        </section>

        <FilterSection
          title="Format"
          items={formatFilters.map((item) => ({
            id: item.id,
            label: item.label,
            count: item.count,
            isActive: filter === item.id,
            onClick: () => onFilterChange(item.id),
          }))}
        />

        <FilterSection
          title="Curation"
          items={[
            {
              id: "all",
              label: "All",
              count: photoCount,
              isActive: curationFilter === "all",
              onClick: () => onCurationFilterChange("all"),
            },
            ...curationFilters.map((item) => ({
              id: item.id,
              label: item.label,
              count: item.count,
              dotColor: item.dotColor,
              isActive: curationFilter === item.id,
              onClick: () => onCurationFilterChange(item.id),
            })),
          ]}
        />

        <section className="mt-2 px-2 py-1">
          <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
            Rating
          </h3>
          <div className="px-2 py-1.5">
            <StarRatingControl
              value={activeRatingFilter}
              onChange={handleRatingFilterChange}
              starClassName="text-xs"
            />
          </div>
        </section>
      </div>
    </aside>
  );
}

function FilterSection({
  title,
  items,
}: {
  title: string;
  items: Array<{
    id: string;
    label: string;
    count: number;
    dotColor?: string;
    isActive: boolean;
    onClick: () => void;
  }>;
}) {
  return (
    <section className="mt-2 px-2 py-1">
      <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
        {title}
      </h3>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={item.onClick}
              className={[
                "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition",
                item.isActive
                  ? "bg-lr-selection text-lr-text"
                  : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text",
              ].join(" ")}
            >
              <span className="flex items-center gap-1.5">
                {item.dotColor ? (
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: item.dotColor }}
                  />
                ) : null}
                <span>{item.label}</span>
              </span>
              <span className="text-lr-text-dim">{item.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
