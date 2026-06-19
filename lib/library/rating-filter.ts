import type { StarRating } from "@/lib/catalog/types";
import type { CurationFilter } from "./filter-types";

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
