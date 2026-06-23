import type { EntryMetadata } from "@/lib/catalog/types";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import type { LibraryEntry } from "@/lib/fs/types";
import type { CurationFilter, FilterOption, SortOption } from "./filter-types";

export type { CurationFilter } from "./filter-types";

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

export interface CurationCounts {
  picked: number;
  rejected: number;
  unpicked: number;
  rated: number;
  rating1: number;
  rating2: number;
  rating3: number;
  rating4: number;
  rating5: number;
  labelRed: number;
  labelYellow: number;
  labelGreen: number;
  labelBlue: number;
  labelPurple: number;
}

export function countCuration(
  entries: LibraryEntry[],
  metadata: Record<string, EntryMetadata>,
): CurationCounts {
  const counts: CurationCounts = {
    picked: 0,
    rejected: 0,
    unpicked: 0,
    rated: 0,
    rating1: 0,
    rating2: 0,
    rating3: 0,
    rating4: 0,
    rating5: 0,
    labelRed: 0,
    labelYellow: 0,
    labelGreen: 0,
    labelBlue: 0,
    labelPurple: 0,
  };

  for (const entry of entries) {
    const meta = getEntryMetadata(metadata, entry.id);

    if (meta.pick === "pick") {
      counts.picked += 1;
    } else if (meta.pick === "reject") {
      counts.rejected += 1;
    } else {
      counts.unpicked += 1;
    }

    if (meta.rating >= 1) {
      counts.rated += 1;
    }

    switch (meta.rating) {
      case 1:
        counts.rating1 += 1;
        break;
      case 2:
        counts.rating2 += 1;
        break;
      case 3:
        counts.rating3 += 1;
        break;
      case 4:
        counts.rating4 += 1;
        break;
      case 5:
        counts.rating5 += 1;
        break;
    }

    switch (meta.colorLabel) {
      case "red":
        counts.labelRed += 1;
        break;
      case "yellow":
        counts.labelYellow += 1;
        break;
      case "green":
        counts.labelGreen += 1;
        break;
      case "blue":
        counts.labelBlue += 1;
        break;
      case "purple":
        counts.labelPurple += 1;
        break;
    }
  }

  return counts;
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
