import {
  isSupportedInputFileName,
  SUPPORTED_INPUT_EXTENSIONS,
} from "../formats/registry";
import type { CapabilityStatus } from "../formats/types";
import type { AssetId, CatalogId, EntryId, RootId, SourceId } from "../catalog/ids";
import type { SessionId } from "../catalog/runtime";

export interface EntryFormatAvailability {
  readonly status: CapabilityStatus;
  readonly reason: string | null;
}

export interface LibraryEntry {
  id: EntryId;
  sourceId: SourceId;
  assetId: AssetId;
  catalogId: CatalogId;
  sessionId: SessionId;
  rootId: RootId;
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
  profileId: string | null;
  assetRevision: number;
  health: "present" | "missing" | "ambiguous" | "unreadable";
  formatId: string | null;
  formatAvailability: EntryFormatAvailability;
  fingerprintStatus?: "missing" | "hashing" | "valid" | "stale" | "failed";
  fingerprintSha256?: string | null;
}

export const SUPPORTED_EXTENSIONS = SUPPORTED_INPUT_EXTENSIONS;

export function isSupportedFileName(name: string): boolean {
  return isSupportedInputFileName(name);
}
