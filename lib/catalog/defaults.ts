import type { ColorLabel, EntryMetadata, StarRating } from "./types";

export const DEFAULT_ENTRY_METADATA: EntryMetadata = {
  pick: "none",
  rating: 0,
  colorLabel: null,
  updatedAt: 0,
};

export function createEntryMetadata(
  patch: Partial<EntryMetadata> = {},
): EntryMetadata {
  return {
    ...DEFAULT_ENTRY_METADATA,
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
  };
}

export function getEntryMetadata(
  map: Record<string, EntryMetadata>,
  entryId: string,
): EntryMetadata {
  return map[entryId] ?? DEFAULT_ENTRY_METADATA;
}

export function isStarRating(value: number): value is StarRating {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}

export const COLOR_LABEL_HEX: Record<Exclude<ColorLabel, null>, string> = {
  red: "#e74c3c",
  yellow: "#f1c40f",
  green: "#2ecc71",
  blue: "#3498db",
  purple: "#9b59b6",
};

export const COLOR_LABEL_SHORTCUTS: Record<string, Exclude<ColorLabel, null>> = {
  "6": "red",
  "7": "yellow",
  "8": "green",
  "9": "blue",
  "]": "purple",
};

export const COLOR_LABEL_SHORTCUT_HINTS = Object.fromEntries(
  Object.entries(COLOR_LABEL_SHORTCUTS).map(([key, label]) => [label, key]),
) as Record<Exclude<ColorLabel, null>, string>;
