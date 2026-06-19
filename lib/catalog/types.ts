export type PickStatus = "none" | "pick" | "reject";
export type StarRating = 0 | 1 | 2 | 3 | 4 | 5;
export type ColorLabel = "red" | "yellow" | "green" | "blue" | "purple" | null;

export interface EntryMetadata {
  pick: PickStatus;
  rating: StarRating;
  colorLabel: ColorLabel;
  updatedAt: number;
}

export interface PhotoCatalog {
  version: 1;
  rootPath: string;
  entries: Record<string, EntryMetadata>;
}

export const COLOR_LABELS = [
  "red",
  "yellow",
  "green",
  "blue",
  "purple",
] as const satisfies readonly Exclude<ColorLabel, null>[];
