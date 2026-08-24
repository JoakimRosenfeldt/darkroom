import type { CatalogId } from "../catalog/ids";
import type { LibraryResultQuery, LibraryResultSnapshot } from "../library/result-contract";
import {
  createLibraryResultSnapshot,
  refreshLibraryResultSnapshot,
  resolveLibraryResultSnapshot,
  updateLibraryResultActive,
  type LibraryResultResolution,
} from "../library/result-repository";

export type ViewerSession = LibraryResultSnapshot;
export type ResolvedViewerSession = LibraryResultResolution;

export function createViewerSession(input: {
  readonly query: LibraryResultQuery;
  readonly orderedEntryIds: readonly string[];
  readonly activeEntryId: string;
  readonly selectedEntryIds: readonly string[];
  readonly focusedEntryId?: string | null;
  readonly scrollAnchorEntryId?: string | null;
}): ViewerSession {
  return createLibraryResultSnapshot(input);
}

export function resolveViewerSession(input: {
  readonly resultId: string;
  readonly requestedEntryId: string;
  readonly catalogId: CatalogId | null;
  readonly catalogRevision: number;
  readonly availableEntryIds: readonly string[];
  readonly reconstructedEntryIds: readonly string[];
  readonly selectedEntryIds: readonly string[];
}): ResolvedViewerSession {
  return resolveLibraryResultSnapshot(input);
}

export function refreshViewerSession(input: {
  readonly resultId: string;
  readonly catalogId: CatalogId;
  readonly catalogRevision: number;
  readonly orderedEntryIds: readonly string[];
  readonly activeEntryId: string;
  readonly availableEntryIds: readonly string[];
  readonly selectedEntryIds: readonly string[];
}): ViewerSession {
  return refreshLibraryResultSnapshot(input);
}

export function updateViewerSessionActive(resultId: string, activeEntryId: string): void {
  updateLibraryResultActive(resultId, activeEntryId);
}

export function viewerPhotoHref(entryId: string, resultId: string): string {
  return `/photo?result=${encodeURIComponent(resultId)}&id=${encodeURIComponent(entryId)}`;
}
