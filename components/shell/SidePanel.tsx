"use client";

import { useMemo, useState, type ReactNode } from "react";
import { FolderPickerButton } from "@/components/shell/FolderPickerButton";
import {
  IconAlbum,
  IconChevronRight,
  IconFolder,
  IconPlus,
  IconTrash,
} from "@/components/shell/icons";
import {
  buildFolderTree,
  type FolderNode,
} from "@/lib/library/folders";
import { useLibraryStore } from "@/stores/library-store";

export function SidePanel() {
  const entries = useLibraryStore((state) => state.entries);
  const folderName = useLibraryStore((state) => state.folderName);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const isDesktopApp = useLibraryStore((state) => state.isDesktopApp);
  const albums = useLibraryStore((state) => state.albums);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const setCatalogView = useLibraryStore((state) => state.setCatalogView);
  const createAlbum = useLibraryStore((state) => state.createAlbum);
  const renameAlbum = useLibraryStore((state) => state.renameAlbum);
  const deleteAlbum = useLibraryStore((state) => state.deleteAlbum);

  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [renamingAlbumId, setRenamingAlbumId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const folderTree = useMemo(() => buildFolderTree(entries), [entries]);
  const hasLibrary = entries.length > 0 && !needsFolderAccess;

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

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-lr-border-subtle bg-lr-panel">
      <div className="border-b border-lr-border-subtle px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-dim">
          Catalog
        </h2>
      </div>

      <div className="flex-1 overflow-auto py-1">
        <section className="px-2 py-1">
          <div className="flex items-center justify-between px-2 py-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
              Folders
            </h3>
            <div className="flex items-center gap-0.5">
              {needsFolderAccess ? (
                <FolderPickerButton
                  mode="restore"
                  disabled={!isDesktopApp}
                  className="flex h-5 w-5 items-center justify-center rounded text-lr-accent transition hover:bg-lr-panel-raised disabled:opacity-50"
                >
                  <IconFolder className="h-3 w-3" />
                </FolderPickerButton>
              ) : null}
              <FolderPickerButton
                mode="import"
                disabled={!isDesktopApp}
                className="flex h-5 w-5 items-center justify-center rounded text-lr-text-muted transition hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-50"
              >
                <IconPlus className="h-3 w-3" />
              </FolderPickerButton>
            </div>
          </div>

          {folderName ? (
            <div className="mb-1 truncate px-2 text-[11px] text-lr-text-dim">
              {folderName}
            </div>
          ) : (
            <div className="mb-1 px-2 text-[11px] text-lr-text-dim">
              No folder linked
            </div>
          )}

          {hasLibrary ? (
            <ul className="space-y-0.5">
              <CatalogItem
                label="All Photos"
                count={entries.length}
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
            </ul>
          ) : (
            <p className="px-2 py-1.5 text-xs text-lr-text-dim">
              Import a folder to browse subfolders.
            </p>
          )}
        </section>

        <section className="mt-2 px-2 py-1">
          <div className="flex items-center justify-between px-2 py-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
              Albums
            </h3>
            <button
              type="button"
              onClick={() => {
                setCreatingAlbum(true);
                setNewAlbumName("");
              }}
              disabled={!hasLibrary}
              className="flex h-5 w-5 items-center justify-center rounded text-lr-text-muted transition hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-40"
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
                className="w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1 text-xs text-lr-text outline-none focus:border-lr-accent"
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
                      className="mx-2 flex-1 rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1 text-xs text-lr-text outline-none focus:border-lr-accent"
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
                        onClick={() => deleteAlbum(album.id)}
                        className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-lr-text-dim opacity-0 transition hover:bg-lr-panel-raised hover:text-red-400 group-hover:opacity-100"
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
            <p className="px-2 py-1.5 text-xs text-lr-text-dim">
              Create albums to group photos.
            </p>
          )}
        </section>
      </div>
    </aside>
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
        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition",
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
      <span className="ml-2 shrink-0 text-lr-text-dim">{count}</span>
    </button>
  );
}
