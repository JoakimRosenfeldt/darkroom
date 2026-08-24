import type { Album, EntryMetadata } from "../catalog/types";
import type { LibraryEntry } from "../fs/types";
import type { LibraryWorkspaceState } from "./model";

export interface ExactDuplicateMember {
  readonly entry: LibraryEntry;
  readonly archived: boolean;
  readonly albumNames: readonly string[];
  readonly keywordCount: number;
  readonly stackId: string | null;
  readonly metadata: EntryMetadata | undefined;
}

export interface ExactDuplicateGroup {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly members: readonly ExactDuplicateMember[];
  readonly defaultKeeperId: string;
  readonly reclaimableBytes: number;
}

export function buildExactDuplicateGroups(
  entries: readonly LibraryEntry[],
  metadata: Readonly<Record<string, EntryMetadata>>,
  albums: readonly Album[],
  archivedEntryIds: readonly string[],
  workspace: LibraryWorkspaceState,
): ExactDuplicateGroup[] {
  const archived = new Set(archivedEntryIds);
  const byHash = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    if (entry.fingerprintStatus !== "valid" || !entry.fingerprintSha256) continue;
    const key = `${entry.size}:${entry.fingerprintSha256}`;
    const group = byHash.get(key) ?? [];
    group.push(entry);
    byHash.set(key, group);
  }
  return [...byHash.entries()].flatMap(([id, group]) => {
    if (group.length < 2) return [];
    const ordered = [...group].sort((left, right) => {
      const archiveDifference = Number(archived.has(left.id)) - Number(archived.has(right.id));
      return archiveDifference || left.relativePath.localeCompare(right.relativePath) || left.id.localeCompare(right.id);
    });
    const first = ordered[0];
    if (!first?.fingerprintSha256) return [];
    return [{
      id,
      sha256: first.fingerprintSha256,
      size: first.size,
      members: ordered.map((entry) => ({
        entry,
        archived: archived.has(entry.id),
        albumNames: albums.filter((album) => album.entryIds.includes(entry.id)).map((album) => album.name),
        keywordCount: workspace.entryKeywordIds[entry.id]?.length ?? 0,
        stackId: workspace.stacks.find((stack) => stack.entryIds.includes(entry.id))?.id ?? null,
        metadata: metadata[entry.id],
      })),
      defaultKeeperId: first.id,
      reclaimableBytes: first.size * (ordered.length - 1),
    }];
  }).sort((left, right) => right.reclaimableBytes - left.reclaimableBytes || left.id.localeCompare(right.id));
}
