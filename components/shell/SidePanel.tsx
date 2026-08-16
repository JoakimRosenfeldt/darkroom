"use client";

import { useMemo, useState, type ReactNode } from "react";
import { FolderPickerButton } from "@/components/shell/FolderPickerButton";
import { DeleteAlbumConfirm } from "@/components/library/DeleteAlbumConfirm";
import {
  IconAlbum,
  IconArchive,
  IconChevronRight,
  IconFolder,
  IconPlus,
  IconTrash,
} from "@/components/shell/icons";
import {
  buildFolderTree,
  type FolderNode,
} from "@/lib/library/folders";
import {
  filterArchivedEntries,
  filterOnlyArchivedEntries,
} from "@/lib/library/archive";
import type { Album } from "@/lib/catalog/types";
import { useLibraryStore } from "@/stores/library-store";

export function SidePanel() {
  const entries = useLibraryStore((state) => state.entries);
  const archivedEntryIds = useLibraryStore((state) => state.archivedEntryIds);
  const folderName = useLibraryStore((state) => state.folderName);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const albums = useLibraryStore((state) => state.albums);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const setCatalogView = useLibraryStore((state) => state.setCatalogView);
  const createAlbum = useLibraryStore((state) => state.createAlbum);
  const renameAlbum = useLibraryStore((state) => state.renameAlbum);
  const deleteAlbum = useLibraryStore((state) => state.deleteAlbum);
  const clearLibrary = useLibraryStore((state) => state.clearLibrary);

  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [renamingAlbumId, setRenamingAlbumId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [albumPendingDelete, setAlbumPendingDelete] = useState<Album | null>(
    null,
  );

  const libraryEntries = useMemo(
    () => filterArchivedEntries(entries, archivedEntryIds),
    [entries, archivedEntryIds],
  );

  const archivedEntries = useMemo(
    () => filterOnlyArchivedEntries(entries, archivedEntryIds),
    [entries, archivedEntryIds],
  );

  const folderTree = useMemo(
    () => buildFolderTree(libraryEntries),
    [libraryEntries],
  );
  const hasImportedFolder = entries.length > 0 && !needsFolderAccess;

  function handleCreateAlbum() {
    const id = createAlbum(newAlbumName);
    if (id) {
      setNewAlbumName("");
      setCreatingAlbum(false);
    }
  }

  function handleRenameAlbum(albumId: string) {
    if (renameValue.trim()) {
      renameAlbum(albumId, renameValue);
    }
    setRenamingAlbumId(null);
    setRenameValue("");
  }

  function handleDeleteAlbum(album: Album) {
    if (album.entryIds.length > 0) {
      setAlbumPendingDelete(album);
      return;
    }
    deleteAlbum(album.id);
  }

  return (
    <>
      <aside className="flex w-[248px] shrink-0 flex-col border-r border-lr-border-subtle bg-lr-panel">
        <div className="flex items-center justify-between border-b border-lr-border-subtle px-4 py-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
            Catalog
          </h2>
          <FolderPickerButton
            mode="import"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-lr-border-subtle text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text"
          >
            <IconPlus className="h-3 w-3" />
            <span className="sr-only">Import folder</span>
          </FolderPickerButton>
        </div>

      <div className="flex-1 overflow-auto py-2">
        <section className="px-2">
          <div className="flex items-center justify-between px-2 py-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
              Folders
            </h3>
            <div className="flex items-center gap-0.5">
              {needsFolderAccess ? (
                <FolderPickerButton
                  mode="restore"
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-lr-border-subtle text-lr-accent transition hover:bg-lr-panel-hover"
                >
                  <IconFolder className="h-3 w-3" />
                </FolderPickerButton>
              ) : null}
            </div>
          </div>

          {folderName ? (
            <div className="mb-2 truncate px-2 text-[11px] text-lr-text-muted">
              {folderName}
            </div>
          ) : (
            <div className="mb-2 px-2 text-[11px] text-lr-text-muted">
              No folder linked
            </div>
          )}

          {hasImportedFolder ? (
            <ul className="space-y-0.5">
              <CatalogItem
                label="All Photos"
                count={libraryEntries.length}
                icon={<IconFolder className="h-3 w-3 text-lr-accent" />}
                isActive={catalogView.type === "all"}
                onClick={() => setCatalogView({ type: "all" })}
              />
              {folderTree.rootPhotoCount > 0 ? (
                <CatalogItem
                  label="Root"
                  count={folderTree.rootPhotoCount}
                  icon={<IconFolder className="h-3 w-3 text-lr-text-dim" />}
                  isActive={
                    catalogView.type === "folder" && catalogView.path === ""
                  }
                  onClick={() =>
                    setCatalogView({ type: "folder", path: "" })
                  }
                />
              ) : null}
              {folderTree.folders.map((node) => (
                <FolderTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  catalogView={catalogView}
                  onSelect={(path) =>
                    setCatalogView({ type: "folder", path })
                  }
                />
              ))}
              {archivedEntries.length > 0 ? (
                <CatalogItem
                  label="Archive"
                  count={archivedEntries.length}
                  icon={<IconArchive className="h-3 w-3 text-lr-text-dim" />}
                  isActive={catalogView.type === "archive"}
                  onClick={() => setCatalogView({ type: "archive" })}
                />
              ) : null}
            </ul>
          ) : (
            <p className="px-2 py-2 text-xs text-lr-text-muted">
              Import a folder to browse subfolders.
            </p>
          )}
        </section>

        <section className="mt-4 px-2">
          <div className="flex items-center justify-between px-2 py-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
              Albums
            </h3>
            <button
              type="button"
              onClick={() => {
                setCreatingAlbum(true);
                setNewAlbumName("");
              }}
              disabled={!hasImportedFolder}
              className="flex h-6 w-6 items-center justify-center rounded-md text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
              title="New album"
            >
              <IconPlus className="h-3 w-3" />
            </button>
          </div>

          {creatingAlbum ? (
            <div className="px-2 py-1">
              <input
                type="text"
                value={newAlbumName}
                onChange={(event) => setNewAlbumName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleCreateAlbum();
                  }
                  if (event.key === "Escape") {
                    setCreatingAlbum(false);
                    setNewAlbumName("");
                  }
                }}
                onBlur={() => {
                  if (newAlbumName.trim()) {
                    handleCreateAlbum();
                  } else {
                    setCreatingAlbum(false);
                  }
                }}
                placeholder="Album name"
                autoFocus
                className="w-full rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-2 text-xs text-lr-text outline-none focus:border-lr-accent"
              />
            </div>
          ) : null}

          {albums.length > 0 ? (
            <ul className="space-y-0.5">
              {albums.map((album) => (
                <li key={album.id} className="group flex items-center gap-0.5">
                  {renamingAlbumId === album.id ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          handleRenameAlbum(album.id);
                        }
                        if (event.key === "Escape") {
                          setRenamingAlbumId(null);
                          setRenameValue("");
                        }
                      }}
                      onBlur={() => handleRenameAlbum(album.id)}
                      autoFocus
                      className="mx-2 flex-1 rounded-md border border-lr-border-subtle bg-lr-panel-raised px-2 py-2 text-xs text-lr-text outline-none focus:border-lr-accent"
                    />
                  ) : (
                    <>
                      <CatalogItem
                        label={album.name}
                        count={album.entryIds.length}
                        icon={
                          <IconAlbum className="h-3 w-3 text-lr-text-dim" />
                        }
                        isActive={
                          catalogView.type === "album" &&
                          catalogView.albumId === album.id
                        }
                        onClick={() =>
                          setCatalogView({ type: "album", albumId: album.id })
                        }
                        onDoubleClick={() => {
                          setRenamingAlbumId(album.id);
                          setRenameValue(album.name);
                        }}
                        className="flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => handleDeleteAlbum(album)}
                        className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-lr-text-faint opacity-0 transition hover:bg-lr-panel-hover hover:text-lr-danger group-hover:opacity-100"
                        title="Delete album"
                      >
                        <IconTrash className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-2 text-xs text-lr-text-muted">
              Create albums to group photos.
            </p>
          )}
        </section>
      </div>

      <div className="flex items-center gap-2 border-t border-lr-border-subtle px-4 py-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-lr-text-muted">
          {folderName ?? "No folder linked"}
        </span>
        {folderName ? (
          <FolderPickerButton
            mode="restore"
            className="shrink-0 text-[11px] text-lr-text-muted transition hover:text-lr-text"
          >
            Re-link
          </FolderPickerButton>
        ) : null}
        <button
          type="button"
          onClick={() => void clearLibrary()}
            className="shrink-0 text-[11px] text-lr-text-dim transition hover:text-lr-danger"
          title="Clear saved library and reset folder access"
        >
          Reset
        </button>
      </div>
      </aside>

      {albumPendingDelete ? (
        <DeleteAlbumConfirm
          album={albumPendingDelete}
          onConfirm={() => {
            deleteAlbum(albumPendingDelete.id);
            setAlbumPendingDelete(null);
          }}
          onClose={() => setAlbumPendingDelete(null)}
        />
      ) : null}
    </>
  );
}

function FolderTreeNode({
  node,
  depth,
  catalogView,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  catalogView: ReturnType<typeof useLibraryStore.getState>["catalogView"];
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const isActive =
    catalogView.type === "folder" && catalogView.path === node.path;

  return (
    <li>
      <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex h-5 w-4 shrink-0 items-center justify-center text-lr-text-dim transition hover:text-lr-text"
            aria-label={expanded ? "Collapse folder" : "Expand folder"}
          >
            <IconChevronRight
              className={[
                "h-2.5 w-2.5 transition",
                expanded ? "rotate-90" : "",
              ].join(" ")}
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <CatalogItem
          label={node.name}
          count={node.photoCount}
          icon={<IconFolder className="h-3 w-3 text-lr-text-dim" />}
          isActive={isActive}
          onClick={() => onSelect(node.path)}
          className="flex-1"
        />
      </div>
      {hasChildren && expanded ? (
        <ul>
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              catalogView={catalogView}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CatalogItem({
  label,
  count,
  icon,
  isActive,
  onClick,
  onDoubleClick,
  className = "",
}: {
  label: string;
  count: number;
  icon: ReactNode;
  isActive: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={[
        "flex w-full items-center justify-between rounded-[7px] px-2.5 py-2 text-left text-[13px] transition",
        isActive
          ? "bg-lr-selection text-lr-text"
          : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text",
        className,
      ].join(" ")}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="ml-2 shrink-0 text-lr-text-muted">{count}</span>
    </button>
  );
}
