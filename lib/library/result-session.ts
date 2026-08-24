import type { LibraryResultQuery } from "./result-contract";

let visibleEntryIds: readonly string[] = [];
let viewerEntryIds: readonly string[] = [];
let revision = "";
let query: LibraryResultQuery | null = null;

export function recordVisibleLibraryResult(
  nextEntryIds: readonly string[],
  nextViewerEntryIds: readonly string[],
  nextRevision: string,
  nextQuery: LibraryResultQuery | null,
): void {
  visibleEntryIds = nextEntryIds;
  viewerEntryIds = nextViewerEntryIds;
  revision = nextRevision;
  query = nextQuery;
}

export function getVisibleLibraryResult(): {
  readonly entryIds: readonly string[];
  readonly viewerEntryIds: readonly string[];
  readonly revision: string;
  readonly query: LibraryResultQuery | null;
} {
  return { entryIds: visibleEntryIds, viewerEntryIds, revision, query };
}

export function readAutoAdvancePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem("darkroom:library-view-settings") ?? "{}",
    );
    return typeof value === "object" && value !== null && "autoAdvance" in value && value.autoAdvance === true;
  } catch {
    return false;
  }
}
