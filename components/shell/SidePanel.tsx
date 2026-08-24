"use client";

import { useMemo, useState, type ReactNode } from "react";
import { FolderPickerButton } from "@/components/shell/FolderPickerButton";
import { CollectionTree } from "@/components/library/CollectionTree";
import { KeywordPanel } from "@/components/library/KeywordPanel";
import {
  IconAlbum,
  IconArchive,
  IconChevronRight,
  IconFolder,
  IconPlus,
} from "@/components/shell/icons";
import {
  buildFolderTree,
  type FolderNode,
} from "@/lib/library/folders";
import {
  filterArchivedEntries,
  filterOnlyArchivedEntries,
} from "@/lib/library/archive";
import { buildExactDuplicateGroups } from "@/lib/library/duplicates";
import { isEntryInFolderSubtree, type LibraryPrimaryScope } from "@/lib/library/result";
import { useLibraryResult } from "@/hooks/useLibraryResult";
import { useLibraryStore } from "@/stores/library-store";
import { CatalogManager } from "@/components/catalog/CatalogManager";

const ALL_LIBRARY_SCOPE: LibraryPrimaryScope = { type: "all" };

export function SidePanel() {
  const entries = useLibraryStore((state) => state.entries);
  const catalogId = useLibraryStore((state) => state.catalogId);
  const archivedEntryIds = useLibraryStore((state) => state.archivedEntryIds);
  const folderName = useLibraryStore((state) => state.folderName);
  const catalogRecovery = useLibraryStore((state) => state.catalogRecovery);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const workspace = useLibraryStore((state) => state.libraryWorkspace);
  const albums = useLibraryStore((state) => state.albums);
  const entryMetadata = useLibraryStore((state) => state.entryMetadata);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const setCatalogView = useLibraryStore((state) => state.setCatalogView);
  const clearQuickCollection = useLibraryStore((state) => state.clearQuickCollection);
  const restoreExcludedEntries = useLibraryStore((state) => state.restoreExcludedEntries);
  const clearLibrary = useLibraryStore((state) => state.clearLibrary);
  const openCatalogManager = useLibraryStore((state) => state.openCatalogManager);
  const filteredLibrary = useLibraryResult(ALL_LIBRARY_SCOPE, false);

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
  const duplicateGroups = useMemo(
    () => buildExactDuplicateGroups(entries, entryMetadata, albums, archivedEntryIds, workspace),
    [albums, archivedEntryIds, entries, entryMetadata, workspace],
  );
  const filteredFolderCounts = useMemo(() => {
    const matchingIds = new Set(filteredLibrary.matchingEntryIds);
    const matchingEntries = libraryEntries.filter((entry) => matchingIds.has(entry.id));
    const counts = new Map<string, number>();
    function count(nodes: readonly FolderNode[]) {
      for (const node of nodes) {
        counts.set(node.path, matchingEntries.filter((entry) =>
          isEntryInFolderSubtree(entry, node.path)
        ).length);
        count(node.children);
      }
    }
    count(folderTree.folders);
    return counts;
  }, [filteredLibrary.matchingEntryIds, folderTree.folders, libraryEntries]);
  const hasImportedFolder = catalogId !== null && !needsFolderAccess;

  return (
    <>
      <aside className="flex w-[248px] shrink-0 flex-col border-r border-lr-border-subtle bg-lr-panel">
        <div className="flex items-center justify-between px-4 pb-2.5 pt-4">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">
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

        <div className="flex-1 overflow-auto px-2 pb-3">
          <section>
          {hasImportedFolder ? (
            <ul className="space-y-px">
              <CatalogItem
                label="All photos"
                count={libraryEntries.length}
                icon={<IconFolder className="h-3 w-3 text-lr-accent" />}
                isActive={catalogView.type === "all"}
                onClick={() => setCatalogView({ type: "all" })}
              />
              <CatalogItem
                label="Quick Collection"
                count={workspace.quickEntryIds.length}
                icon={<IconAlbum className="h-3 w-3 text-lr-accent" />}
                isActive={catalogView.type === "quick"}
                onClick={() => setCatalogView({ type: "quick" })}
              />
              <CatalogItem
                label="Exact Duplicates"
                count={duplicateGroups.length}
                icon={<IconArchive className="h-3 w-3 text-lr-text-dim" />}
                isActive={catalogView.type === "duplicates"}
                onClick={() => setCatalogView({ type: "duplicates" })}
              />
              {libraryEntries.length > 0 ? (
                <CatalogItem
                  label="Root"
                  count={filteredLibrary.photoCount}
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
                  filteredCounts={filteredFolderCounts}
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
            <p className="px-2 py-2 text-xs leading-5 text-lr-text-muted">
              {catalogRecovery ?? (needsFolderAccess
                ? "Re-link the catalog root to browse your catalog."
                : "Create a catalog to browse your photos.")}
            </p>
          )}
        </section>

        <CollectionTree disabled={!hasImportedFolder} />
        <KeywordPanel disabled={!hasImportedFolder} />
      </div>

        <div className="group border-t border-lr-border-subtle px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-[11px] text-lr-text-muted">
              {folderName ?? "No catalog open"}
            </span>
            <span className="truncate font-mono text-[10px] text-lr-text-faint">
              {entries.length > 0 ? `${entries.length} assets` : "No assets indexed"}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              onClick={openCatalogManager}
              className="text-[11px] text-lr-text-muted transition-colors hover:text-lr-text"
            >
              Manage
            </button>
            {folderName ? (
              <FolderPickerButton
                mode="restore"
                className="text-[11px] text-lr-text-muted transition-colors hover:text-lr-text"
              >
                Re-link
              </FolderPickerButton>
            ) : null}
            <button
              type="button"
              onClick={() => void clearLibrary()}
              className="text-[11px] text-lr-text-faint transition-colors hover:text-lr-danger"
              title="Clear saved library and reset folder access"
            >
              Reset
            </button>
            {workspace.quickEntryIds.length > 0 ? (
              <button type="button" onClick={clearQuickCollection} className="text-[11px] text-lr-text-faint hover:text-lr-text">
                Clear Quick
              </button>
            ) : null}
            {workspace.excludedEntryIds.length > 0 ? (
              <button
                type="button"
                onClick={() => restoreExcludedEntries([...workspace.excludedEntryIds])}
                className="text-[11px] text-lr-text-faint hover:text-lr-text"
              >
                Restore hidden ({workspace.excludedEntryIds.length})
              </button>
            ) : null}
          </div>
        </div>
      </aside>

      <CatalogManager />
    </>
  );
}

function FolderTreeNode({
  node,
  depth,
  catalogView,
  filteredCounts,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  catalogView: ReturnType<typeof useLibraryStore.getState>["catalogView"];
  filteredCounts: ReadonlyMap<string, number>;
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
            className="flex h-6 w-4 shrink-0 items-center justify-center text-lr-text-faint transition-colors hover:text-lr-text"
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
          count={filteredCounts.get(node.path) ?? 0}
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
              filteredCounts={filteredCounts}
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
        "flex w-full items-center justify-between rounded-[7px] px-2.5 py-2 text-left text-[13px] transition-colors",
        isActive
          ? "bg-lr-selection text-lr-text"
          : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text",
        className,
      ].join(" ")}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="ml-2 shrink-0 font-mono text-[11px] text-lr-text-faint">
        {count}
      </span>
    </button>
  );
}
