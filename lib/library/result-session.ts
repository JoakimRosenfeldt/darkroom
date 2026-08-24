let visibleEntryIds: readonly string[] = [];
let revision = "";

export function recordVisibleLibraryResult(
  nextEntryIds: readonly string[],
  nextRevision: string,
): void {
  visibleEntryIds = nextEntryIds;
  revision = nextRevision;
}

export function getVisibleLibraryResult(): {
  readonly entryIds: readonly string[];
  readonly revision: string;
} {
  return { entryIds: visibleEntryIds, revision };
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
