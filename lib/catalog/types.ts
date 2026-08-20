import {
  migrateLegacyDevelopSettings,
  parseDevelopDocument,
} from "@/lib/develop/document";
import type { DevelopDocument } from "@/lib/develop/types";

export type PickStatus = "none" | "pick" | "reject";
export type StarRating = 0 | 1 | 2 | 3 | 4 | 5;
export type ColorLabel = "red" | "yellow" | "green" | "blue" | "purple" | null;

export interface EntryMetadata {
  pick: PickStatus;
  rating: StarRating;
  colorLabel: ColorLabel;
  develop?: DevelopDocument;
  developUpdatedAt: number;
  updatedAt: number;
}

export interface Album {
  id: string;
  name: string;
  entryIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PhotoCatalogV1 {
  version: 1;
  rootPath: string;
  entries: Record<string, unknown>;
  albums?: unknown;
  archivedEntryIds?: unknown;
}

export interface PhotoCatalog {
  version: 2;
  rootPath: string;
  entries: Record<string, EntryMetadata>;
  albums: Album[];
  archivedEntryIds: string[];
}

export type StoredPhotoCatalog = PhotoCatalogV1 | PhotoCatalog;

export const COLOR_LABELS = [
  "red",
  "yellow",
  "green",
  "blue",
  "purple",
] as const satisfies readonly Exclude<ColorLabel, null>[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function finite(value: unknown, path: string): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(`${path} must be a finite number.`);
}

function parseEntryMetadata(value: unknown, version: 1 | 2, path: string): EntryMetadata {
  if (!isRecord(value)) return fail(`${path} must be an object.`);
  const pick = value.pick === "none" || value.pick === "pick" || value.pick === "reject"
    ? value.pick
    : fail(`${path}.pick is invalid.`);
  const rating = value.rating === 0 || value.rating === 1 || value.rating === 2 || value.rating === 3 || value.rating === 4 || value.rating === 5
    ? value.rating
    : fail(`${path}.rating is invalid.`);
  const colorLabel = value.colorLabel === null || value.colorLabel === "red" || value.colorLabel === "yellow" || value.colorLabel === "green" || value.colorLabel === "blue" || value.colorLabel === "purple"
    ? value.colorLabel
    : fail(`${path}.colorLabel is invalid.`);
  const develop = value.develop === undefined
    ? undefined
    : version === 1
      ? migrateLegacyDevelopSettings(value.develop)
      : parseDevelopDocument(value.develop);
  const updatedAt = finite(value.updatedAt, `${path}.updatedAt`);
  const developUpdatedAt = value.developUpdatedAt === undefined
    ? develop ? updatedAt : 0
    : finite(value.developUpdatedAt, `${path}.developUpdatedAt`);
  return {
    pick,
    rating,
    colorLabel,
    ...(develop ? { develop } : {}),
    developUpdatedAt,
    updatedAt,
  };
}

function parseAlbum(value: unknown, path: string): Album {
  if (!isRecord(value)) return fail(`${path} must be an object.`);
  if (typeof value.id !== "string" || typeof value.name !== "string" || !Array.isArray(value.entryIds)) {
    return fail(`${path} is malformed.`);
  }
  const entryIds = value.entryIds.map((entryId, index) =>
    typeof entryId === "string" ? entryId : fail(`${path}.entryIds[${index}] must be a string.`),
  );
  return {
    id: value.id,
    name: value.name,
    entryIds,
    createdAt: finite(value.createdAt, `${path}.createdAt`),
    updatedAt: finite(value.updatedAt, `${path}.updatedAt`),
  };
}

export function parsePhotoCatalog(value: unknown): PhotoCatalog {
  if (!isRecord(value)) return fail("Catalog must be an object.");
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
    return fail("Catalog version is invalid.");
  }
  if (value.version > 2) {
    return fail(`Catalog version ${value.version} is newer than this version of Darkroom.`);
  }
  if (value.version !== 1 && value.version !== 2) {
    return fail(`Catalog version ${value.version} is not supported.`);
  }
  if (typeof value.rootPath !== "string" || !isRecord(value.entries)) {
    return fail("Catalog root path or entries are invalid.");
  }
  const entries: Record<string, EntryMetadata> = {};
  for (const [entryId, metadata] of Object.entries(value.entries)) {
    entries[entryId] = parseEntryMetadata(metadata, value.version, `entries.${entryId}`);
  }
  const rawAlbums = value.albums ?? [];
  const rawArchived = value.archivedEntryIds ?? [];
  if (!Array.isArray(rawAlbums) || !Array.isArray(rawArchived)) {
    return fail("Catalog albums or archive list are invalid.");
  }
  return {
    version: 2,
    rootPath: value.rootPath,
    entries,
    albums: rawAlbums.map((album, index) => parseAlbum(album, `albums[${index}]`)),
    archivedEntryIds: rawArchived.map((entryId, index) =>
      typeof entryId === "string" ? entryId : fail(`archivedEntryIds[${index}] must be a string.`),
    ),
  };
}
