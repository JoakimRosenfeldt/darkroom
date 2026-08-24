import { getEntryMetadata } from "../catalog/defaults";
import type { Album, EntryMetadata } from "../catalog/types";
import { getFormatFamilyForEntry } from "../formats/registry";
import type { LibraryEntry } from "../fs/types";
import type { CurationFilter, FilterOption, SortOption } from "./curation";
import type { LibraryWorkspaceState, StackRecord } from "./model";
import {
  buildQueryIndex,
  computeFacetCounts,
  evaluateSmartRule,
  matchesFacets,
  matchesTextQuery,
  tokenizeSearchQuery,
  type LibraryFacetCounts,
  type LibraryFacets,
  type QueryIndex,
} from "./query";

export type LibraryPrimaryScope =
  | { readonly type: "all" }
  | { readonly type: "folder"; readonly path: string | null }
  | { readonly type: "album"; readonly albumId: string }
  | { readonly type: "smart"; readonly collectionId: string }
  | { readonly type: "quick" }
  | { readonly type: "archive" }
  | { readonly type: "duplicates" };

export type LibraryVisibleItem =
  | { readonly kind: "photo"; readonly entryId: string; readonly stackId: string | null }
  | {
      readonly kind: "stack";
      readonly stackId: string;
      readonly entryId: string;
      readonly matchingEntryIds: readonly string[];
      readonly savedCoverEntryId: string;
    };

export interface LibraryResult {
  readonly matchingEntryIds: readonly string[];
  readonly visibleItems: readonly LibraryVisibleItem[];
  readonly visibleEntryIds: readonly string[];
  readonly viewerEntryIds: readonly string[];
  readonly photoCount: number;
  readonly tileCount: number;
  readonly facetCounts: LibraryFacetCounts;
  readonly revision: string;
}

export interface ResolveLibraryResultInput {
  readonly catalogRevision: number;
  readonly entries: readonly LibraryEntry[];
  readonly metadata: Readonly<Record<string, EntryMetadata>>;
  readonly albums: readonly Album[];
  readonly archivedEntryIds: readonly string[];
  readonly workspace: LibraryWorkspaceState;
  readonly primaryScope: LibraryPrimaryScope;
  readonly textQuery: string;
  readonly facets: LibraryFacets;
  readonly curationFilter: CurationFilter;
  readonly formatFilter: FilterOption;
  readonly sort: SortOption;
  readonly sortDirection: "ascending" | "descending";
  readonly expandedStackIds: ReadonlySet<string>;
  readonly duplicateEntryIds?: ReadonlySet<string>;
  readonly queryIndex?: QueryIndex;
}

export function normalizeFolderPath(path: string | null): string {
  if (path === null) return "";
  return path.replaceAll("\\", "/").split("/").filter(Boolean).join("/");
}

export function isEntryInFolderSubtree(entry: LibraryEntry, folderPath: string | null): boolean {
  const folder = normalizeFolderPath(folderPath);
  if (folder === "") return true;
  const relativePath = normalizeFolderPath(entry.relativePath);
  return relativePath.startsWith(`${folder}/`);
}

function scopeEntries(
  entries: readonly LibraryEntry[],
  input: ResolveLibraryResultInput,
  index: QueryIndex,
): LibraryEntry[] {
  const excluded = new Set(input.workspace.excludedEntryIds);
  const archived = new Set(input.archivedEntryIds);
  const scope = input.primaryScope;
  const source = entries.filter((entry) =>
    !excluded.has(entry.id) &&
    (scope.type === "archive"
      ? archived.has(entry.id)
      : !archived.has(entry.id)),
  );
  if (scope.type === "folder") {
    return source.filter((entry) => isEntryInFolderSubtree(entry, scope.path));
  }
  if (scope.type === "album") {
    const album = input.albums.find((item) => item.id === scope.albumId);
    if (!album) return [];
    const entryIds = new Set(album.entryIds);
    return source.filter((entry) => entryIds.has(entry.id));
  }
  if (scope.type === "smart") {
    const smart = input.workspace.collections.find(
      (node) => node.kind === "smart" && node.id === scope.collectionId,
    );
    if (!smart || smart.kind !== "smart") return [];
    return source.filter((entry) => {
      const record = index.get(entry.id);
      if (!record) return false;
      return evaluateSmartRule(
        smart.rule,
        entry,
        record,
        getEntryMetadata(input.metadata, entry.id),
        input.workspace.analysisByEntryId[entry.id],
      );
    });
  }
  if (scope.type === "quick") {
    const entryIds = new Set(input.workspace.quickEntryIds);
    return source.filter((entry) => entryIds.has(entry.id));
  }
  if (scope.type === "duplicates") {
    return source.filter((entry) => input.duplicateEntryIds?.has(entry.id) ?? false);
  }
  return source;
}

function matchesCuration(
  metadata: EntryMetadata,
  filter: CurationFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "picked") return metadata.pick === "pick";
  if (filter === "rejected") return metadata.pick === "reject";
  if (filter === "unpicked") return metadata.pick === "none";
  if (filter === "rated") return metadata.rating > 0;
  if (filter.startsWith("rating-")) return metadata.rating === Number(filter.slice(7));
  if (filter.startsWith("label-")) return metadata.colorLabel === filter.slice(6);
  return true;
}

function matchesFormat(entry: LibraryEntry, filter: FilterOption): boolean {
  if (filter === "all") return true;
  return getFormatFamilyForEntry(entry.name, entry.profileId) === filter;
}

function stablePathCompare(left: LibraryEntry, right: LibraryEntry): number {
  const path = normalizeFolderPath(left.relativePath).localeCompare(
    normalizeFolderPath(right.relativePath),
  );
  return path !== 0 ? path : left.id.localeCompare(right.id);
}

function compareEntries(
  left: LibraryEntry,
  right: LibraryEntry,
  input: ResolveLibraryResultInput,
): number {
  if (input.sort === "date") {
    const leftTime = input.workspace.analysisByEntryId[left.id]?.captureTimeKey ?? null;
    const rightTime = input.workspace.analysisByEntryId[right.id]?.captureTimeKey ?? null;
    if (leftTime === null && rightTime !== null) return 1;
    if (leftTime !== null && rightTime === null) return -1;
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return stablePathCompare(left, right);
  }
  if (input.sort === "rating") {
    const difference = getEntryMetadata(input.metadata, left.id).rating -
      getEntryMetadata(input.metadata, right.id).rating;
    return difference !== 0 ? difference : stablePathCompare(left, right);
  }
  if (input.sort === "pick") {
    const order = { pick: 0, none: 1, reject: 2 } as const;
    const difference = order[getEntryMetadata(input.metadata, left.id).pick] -
      order[getEntryMetadata(input.metadata, right.id).pick];
    return difference !== 0 ? difference : stablePathCompare(left, right);
  }
  return left.name.localeCompare(right.name) || stablePathCompare(left, right);
}

function sortedEntries(
  entries: readonly LibraryEntry[],
  input: ResolveLibraryResultInput,
): LibraryEntry[] {
  return [...entries].sort((left, right) => {
    const compared = compareEntries(left, right, input);
    if (input.sort === "date") {
      const leftMissing = input.workspace.analysisByEntryId[left.id]?.captureTimeKey == null;
      const rightMissing = input.workspace.analysisByEntryId[right.id]?.captureTimeKey == null;
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    }
    return input.sortDirection === "ascending" ? compared : -compared;
  });
}

function projectStacks(
  entries: readonly LibraryEntry[],
  stacks: readonly StackRecord[],
  expandedStackIds: ReadonlySet<string>,
): LibraryVisibleItem[] {
  const byEntryId = new Map<string, LibraryEntry>(
    entries.map((entry) => [entry.id, entry]),
  );
  const stackByEntryId = new Map<string, StackRecord>();
  for (const stack of stacks) {
    for (const entryId of stack.entryIds) stackByEntryId.set(entryId, stack);
  }
  const emittedStacks = new Set<string>();
  const items: LibraryVisibleItem[] = [];
  for (const entry of entries) {
    const stack = stackByEntryId.get(entry.id);
    if (!stack) {
      items.push({ kind: "photo", entryId: entry.id, stackId: null });
      continue;
    }
    if (emittedStacks.has(stack.id)) continue;
    emittedStacks.add(stack.id);
    const matchingEntryIds = stack.entryIds.filter((id) => byEntryId.has(id));
    if (expandedStackIds.has(stack.id)) {
      for (const entryId of matchingEntryIds) {
        items.push({ kind: "photo", entryId, stackId: stack.id });
      }
      continue;
    }
    const representative = matchingEntryIds.includes(stack.coverEntryId)
      ? stack.coverEntryId
      : matchingEntryIds[0];
    if (representative) {
      items.push({
        kind: "stack",
        stackId: stack.id,
        entryId: representative,
        matchingEntryIds,
        savedCoverEntryId: stack.coverEntryId,
      });
    }
  }
  return items;
}

export function resolveLibraryResult(input: ResolveLibraryResultInput): LibraryResult {
  const queryIndex = input.queryIndex ?? buildQueryIndex(
    input.entries,
    input.metadata,
    input.albums,
    input.workspace,
  );
  const scoped = scopeEntries(input.entries, input, queryIndex);
  const tokens = tokenizeSearchQuery(input.textQuery);
  const queryMatched = scoped.filter((entry) => {
    const record = queryIndex.get(entry.id);
    return record !== undefined && matchesTextQuery(record, tokens);
  });
  const baseForFacets = queryMatched.filter((entry) =>
    matchesCuration(getEntryMetadata(input.metadata, entry.id), input.curationFilter) &&
    matchesFormat(entry, input.formatFilter),
  );
  const facetCounts = computeFacetCounts(
    baseForFacets
      .map((entry) => queryIndex.get(entry.id))
      .filter((record): record is NonNullable<typeof record> => record !== undefined),
    input.facets,
  );
  const matched = baseForFacets.filter((entry) => {
    const record = queryIndex.get(entry.id);
    return record !== undefined && matchesFacets(record, input.facets);
  });
  const ordered = sortedEntries(matched, input);
  const visibleItems = projectStacks(
    ordered,
    input.workspace.stacks,
    input.expandedStackIds,
  );
  const matchingEntryIds = ordered.map((entry) => entry.id);
  const visibleEntryIds = visibleItems.map((item) => item.entryId);
  return {
    matchingEntryIds,
    visibleItems,
    visibleEntryIds,
    viewerEntryIds: matchingEntryIds,
    photoCount: matchingEntryIds.length,
    tileCount: visibleItems.length,
    facetCounts,
    revision: [
      input.catalogRevision,
      JSON.stringify(input.primaryScope),
      input.textQuery,
      JSON.stringify(input.facets),
      input.curationFilter,
      input.formatFilter,
      input.sort,
      input.sortDirection,
      input.workspace.stacks.map((stack) => `${stack.id}:${stack.updatedAt}`).join(","),
    ].join("|"),
  };
}

export function reconcileSelectionToResult(
  selectedEntryIds: readonly string[],
  selectedEntryId: string | null,
  visibleEntryIds: readonly string[],
): { readonly selectedEntryIds: string[]; readonly selectedEntryId: string | null } {
  const visible = new Set(visibleEntryIds);
  const nextIds = selectedEntryIds.filter((id) => visible.has(id));
  if (selectedEntryId !== null && visible.has(selectedEntryId)) {
    if (!nextIds.includes(selectedEntryId)) nextIds.push(selectedEntryId);
    return { selectedEntryIds: nextIds, selectedEntryId };
  }
  if (nextIds.length > 0) {
    return { selectedEntryIds: nextIds, selectedEntryId: nextIds.at(-1) ?? null };
  }
  return { selectedEntryIds: [], selectedEntryId: null };
}
