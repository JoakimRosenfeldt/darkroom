import type { Album } from "@/lib/catalog/types";
import type { LibraryEntry } from "@/lib/fs/types";

export interface FolderNode {
  name: string;
  path: string;
  photoCount: number;
  children: FolderNode[];
}

export interface FolderTree {
  rootPhotoCount: number;
  folders: FolderNode[];
}

export function getParentFolderPath(relativePath: string): string | null {
  const slash = relativePath.lastIndexOf("/");
  if (slash === -1) {
    return null;
  }
  return relativePath.slice(0, slash);
}

export function buildFolderTree(entries: LibraryEntry[]): FolderTree {
  const nodes = new Map<string, FolderNode>();
  let rootPhotoCount = 0;

  function ensureNode(path: string): FolderNode {
    const existing = nodes.get(path);
    if (existing) {
      return existing;
    }

    const name = path.split("/").pop()!;
    const node: FolderNode = { name, path, photoCount: 0, children: [] };
    nodes.set(path, node);

    const slash = path.lastIndexOf("/");
    if (slash !== -1) {
      ensureNode(path.slice(0, slash)).children.push(node);
    }

    return node;
  }

  for (const entry of entries) {
    const parent = getParentFolderPath(entry.relativePath);
    if (!parent) {
      rootPhotoCount += 1;
    } else {
      ensureNode(parent).photoCount += 1;
    }
  }

  for (const node of nodes.values()) {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
  }

  const folders = [...nodes.values()]
    .filter((node) => !node.path.includes("/"))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { rootPhotoCount, folders };
}

/** `null` = all photos; `""` = root-level files only. */
export function filterByFolderPath(
  entries: LibraryEntry[],
  folderPath: string | null,
): LibraryEntry[] {
  if (folderPath === null) {
    return entries;
  }

  if (folderPath === "") {
    return entries.filter((entry) => !entry.relativePath.includes("/"));
  }

  return entries.filter(
    (entry) => getParentFolderPath(entry.relativePath) === folderPath,
  );
}

export function filterByAlbum(
  entries: LibraryEntry[],
  album: Album | undefined,
): LibraryEntry[] {
  if (!album) {
    return entries;
  }

  const entryIds = new Set(album.entryIds);
  return entries.filter((entry) => entryIds.has(entry.id));
}

export function pruneAlbumsForEntries(
  albums: Album[],
  entryIds: Set<string>,
): Album[] {
  return albums.map((album) => ({
    ...album,
    entryIds: album.entryIds.filter((id) => entryIds.has(id)),
  }));
}
