import type { EntryMetadata, StarRating } from "@/lib/catalog/types";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import type { LibraryEntry } from "@/lib/fs/types";

export type SortOption = "name" | "date" | "rating" | "pick";
export type FilterOption = "all" | "raw" | "standard";
export type GridViewMode = "grid" | "dynamic";

export type CurationFilter =
  | "all"
  | "picked"
  | "rejected"
  | "unpicked"
  | "rated"
  | "rating-1"
  | "rating-2"
  | "rating-3"
  | "rating-4"
  | "rating-5"
  | "label-red"
  | "label-yellow"
  | "label-green"
  | "label-blue"
  | "label-purple";

export function getRatingFromCurationFilter(
  filter: CurationFilter,
): StarRating {
  if (filter === "rating-1") return 1;
  if (filter === "rating-2") return 2;
  if (filter === "rating-3") return 3;
  if (filter === "rating-4") return 4;
  if (filter === "rating-5") return 5;
  return 0;
}

export function isRatingCurationFilter(filter: CurationFilter): boolean {
  return getRatingFromCurationFilter(filter) > 0;
}

export function curationFilterFromRating(
  rating: StarRating,
  currentFilter: CurationFilter,
): CurationFilter {
  if (rating === 0) {
    return isRatingCurationFilter(currentFilter) ? "all" : currentFilter;
  }

  const next = `rating-${rating}` as CurationFilter;
  if (currentFilter === next) {
    return "all";
  }

  return next;
}

export function filterByFormat(
  entries: LibraryEntry[],
  filter: FilterOption,
): LibraryEntry[] {
  if (filter === "raw") {
    return entries.filter((entry) => entry.profileId !== "standard");
  }
  if (filter === "standard") {
    return entries.filter((entry) => entry.profileId === "standard");
  }
  return entries;
}

export function filterByCuration(
  entries: LibraryEntry[],
  metadata: Record<string, EntryMetadata>,
  filter: CurationFilter,
): LibraryEntry[] {
  if (filter === "all") {
    return entries;
  }

  return entries.filter((entry) => {
    const meta = getEntryMetadata(metadata, entry.id);

    switch (filter) {
      case "picked":
        return meta.pick === "pick";
      case "rejected":
        return meta.pick === "reject";
      case "unpicked":
        return meta.pick === "none";
      case "rated":
        return meta.rating >= 1;
      case "rating-1":
        return meta.rating === 1;
      case "rating-2":
        return meta.rating === 2;
      case "rating-3":
        return meta.rating === 3;
      case "rating-4":
        return meta.rating === 4;
      case "rating-5":
        return meta.rating === 5;
      case "label-red":
        return meta.colorLabel === "red";
      case "label-yellow":
        return meta.colorLabel === "yellow";
      case "label-green":
        return meta.colorLabel === "green";
      case "label-blue":
        return meta.colorLabel === "blue";
      case "label-purple":
        return meta.colorLabel === "purple";
      default:
        return true;
    }
  });
}

const PICK_ORDER = { pick: 0, none: 1, reject: 2 } as const;

export function sortLibraryEntries(
  entries: LibraryEntry[],
  metadata: Record<string, EntryMetadata>,
  sort: SortOption,
): LibraryEntry[] {
  const sorted = [...entries];

  if (sort === "date") {
    sorted.sort((a, b) => b.lastModified - a.lastModified);
    return sorted;
  }

  if (sort === "rating") {
    sorted.sort((a, b) => {
      const ratingDiff =
        getEntryMetadata(metadata, b.id).rating -
        getEntryMetadata(metadata, a.id).rating;
      if (ratingDiff !== 0) {
        return ratingDiff;
      }
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }

  if (sort === "pick") {
    sorted.sort((a, b) => {
      const pickDiff =
        PICK_ORDER[getEntryMetadata(metadata, a.id).pick] -
        PICK_ORDER[getEntryMetadata(metadata, b.id).pick];
      if (pickDiff !== 0) {
        return pickDiff;
      }
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }

  sorted.sort((a, b) => a.name.localeCompare(b.name));
  return sorted;
}

export function pruneMetadataForEntries(
  metadata: Record<string, EntryMetadata>,
  entryIds: Set<string>,
): Record<string, EntryMetadata> {
  const pruned: Record<string, EntryMetadata> = {};

  for (const [id, meta] of Object.entries(metadata)) {
    if (entryIds.has(id)) {
      pruned[id] = meta;
    }
  }

  return pruned;
}
