"use client";

import { useMemo, useState } from "react";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import { useLibraryViewSettings } from "@/hooks/useLibraryViewSettings";
import type { CollectionNode, SmartRuleGroup } from "@/lib/library/model";
import { buildQueryIndex, evaluateSmartRule } from "@/lib/library/query";
import { useLibraryStore } from "@/stores/library-store";
import {
  IconAlbum,
  IconChevronRight,
  IconFolder,
  IconPlus,
} from "@/components/shell/icons";
import {
  useLibraryDialog,
  type RequestConfirmationOptions,
  type RequestTextOptions,
} from "./useLibraryDialog";
import { SmartAlbumEditor } from "./SmartAlbumEditor";

type SmartEditorState =
  | { readonly mode: "create"; readonly name: string; readonly parentId: string | null }
  | { readonly mode: "edit"; readonly nodeId: string; readonly name: string; readonly rule: SmartRuleGroup };

export function CollectionTree({ disabled }: { disabled: boolean }) {
  const workspace = useLibraryStore((state) => state.libraryWorkspace);
  const entries = useLibraryStore((state) => state.entries);
  const metadata = useLibraryStore((state) => state.entryMetadata);
  const albums = useLibraryStore((state) => state.albums);
  const archivedEntryIds = useLibraryStore((state) => state.archivedEntryIds);
  const [settings, updateSettings] = useLibraryViewSettings();
  const dialog = useLibraryDialog();
  const [smartEditor, setSmartEditor] = useState<SmartEditorState | null>(null);
  const children = useMemo(() => {
    const grouped = new Map<string | null, CollectionNode[]>();
    for (const node of workspace.collections) {
      const siblings = grouped.get(node.parentId) ?? [];
      siblings.push(node);
      grouped.set(node.parentId, siblings);
    }
    for (const siblings of grouped.values()) {
      siblings.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
    }
    return grouped;
  }, [workspace.collections]);
  const smartCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const archived = new Set(archivedEntryIds);
    const index = buildQueryIndex(entries, metadata, albums, workspace);
    for (const node of workspace.collections) {
      if (node.kind !== "smart") continue;
      counts.set(node.id, entries.filter((entry) => {
        const record = index.get(entry.id);
        return !archived.has(entry.id) && record !== undefined && evaluateSmartRule(
          node.rule,
          entry,
          record,
          getEntryMetadata(metadata, entry.id),
          workspace.analysisByEntryId[entry.id],
        );
      }).length);
    }
    return counts;
  }, [albums, archivedEntryIds, entries, metadata, workspace]);

  async function create(kind: "album" | "set" | "smart", parentId: string | null = null) {
    const label = kind === "album" ? "album" : kind === "set" ? "collection set" : "Smart Album";
    const name = (await dialog.requestText({
      title: `New ${label}`,
      label: "Name",
      confirmLabel: "Create",
    }))?.trim();
    if (!name) return;
    const store = useLibraryStore.getState();
    if (kind === "album") {
      store.createAlbum(name, parentId);
      return;
    }
    if (kind === "set") {
      const id = store.createCollectionSet(name, parentId);
      if (id) updateSettings({
        expandedCollectionIds: [...new Set([...settings.expandedCollectionIds, id])],
      });
      return;
    }
    setSmartEditor({ mode: "create", name, parentId });
  }

  return (
    <section className="mt-4 px-2">
      {dialog.element}
      {smartEditor ? (
        <SmartAlbumEditor
          key={smartEditor.mode === "edit" ? smartEditor.nodeId : `${smartEditor.parentId ?? "root"}:${smartEditor.name}`}
          name={smartEditor.name}
          initialRule={smartEditor.mode === "edit" ? smartEditor.rule : undefined}
          onCancel={() => setSmartEditor(null)}
          onSave={(rule) => {
            const store = useLibraryStore.getState();
            if (smartEditor.mode === "edit") store.updateSmartAlbumRule(smartEditor.nodeId, rule);
            else store.createSmartAlbum(smartEditor.name, rule, smartEditor.parentId);
            setSmartEditor(null);
          }}
        />
      ) : null}
      <div className="flex items-center justify-between px-2 pb-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">
          Collections
        </h3>
        <div className="flex items-center gap-0.5">
          <CreateButton label="New album" disabled={disabled} onClick={() => void create("album")} />
          <CreateButton label="New set" disabled={disabled} onClick={() => void create("set")} />
          <CreateButton label="New Smart Album" disabled={disabled} onClick={() => void create("smart")} />
        </div>
      </div>
      {(children.get(null)?.length ?? 0) > 0 ? (
        <ul role="tree" aria-label="Collections" className="space-y-px">
          {children.get(null)?.map((node) => (
            <CollectionNodeItem
              key={node.id}
              node={node}
              depth={0}
              childrenByParent={children}
              smartCounts={smartCounts}
              create={create}
              requestText={dialog.requestText}
              requestConfirmation={dialog.requestConfirmation}
              onEditSmart={(node) => setSmartEditor({ mode: "edit", nodeId: node.id, name: node.name, rule: node.rule })}
            />
          ))}
        </ul>
      ) : (
        <p className="px-2 py-2 text-xs text-lr-text-muted">
          Create albums, sets, or saved searches.
        </p>
      )}
    </section>
  );
}

function CreateButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded-md text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
      title={label}
    >
      <IconPlus className="h-3 w-3" />
      <span className="sr-only">{label}</span>
    </button>
  );
}

function CollectionNodeItem({
  node,
  depth,
  childrenByParent,
  smartCounts,
  create,
  requestText,
  requestConfirmation,
  onEditSmart,
}: {
  node: CollectionNode;
  depth: number;
  childrenByParent: ReadonlyMap<string | null, readonly CollectionNode[]>;
  smartCounts: ReadonlyMap<string, number>;
  create: (kind: "album" | "set" | "smart", parentId?: string | null) => Promise<void>;
  requestText: (options: RequestTextOptions) => Promise<string | null>;
  requestConfirmation: (options: RequestConfirmationOptions) => Promise<boolean>;
  onEditSmart: (node: Extract<CollectionNode, { readonly kind: "smart" }>) => void;
}) {
  const albums = useLibraryStore((state) => state.albums);
  const workspace = useLibraryStore((state) => state.libraryWorkspace);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const setCatalogView = useLibraryStore((state) => state.setCatalogView);
  const renameCollection = useLibraryStore((state) => state.renameCollection);
  const moveCollection = useLibraryStore((state) => state.moveCollection);
  const reorderCollection = useLibraryStore((state) => state.reorderCollection);
  const deleteCollection = useLibraryStore((state) => state.deleteCollection);
  const duplicateSmartAlbum = useLibraryStore((state) => state.duplicateSmartAlbum);
  const setTargetAlbum = useLibraryStore((state) => state.setTargetAlbum);
  const [settings, updateSettings] = useLibraryViewSettings();
  const children = childrenByParent.get(node.id) ?? [];
  const expanded = settings.expandedCollectionIds.includes(node.id);
  const active = node.kind === "album"
    ? catalogView.type === "album" && catalogView.albumId === node.id
    : node.kind === "smart"
      ? catalogView.type === "smart" && catalogView.collectionId === node.id
      : false;
  const count = node.kind === "album"
    ? albums.find((album) => album.id === node.id)?.entryIds.length ?? 0
    : node.kind === "smart"
      ? smartCounts.get(node.id) ?? 0
      : children.length;
  const target = node.kind === "album" && workspace.targetAlbumId === node.id;

  function toggle() {
    updateSettings({
      expandedCollectionIds: expanded
        ? settings.expandedCollectionIds.filter((id) => id !== node.id)
        : [...settings.expandedCollectionIds, node.id],
    });
  }

  async function rename() {
    const name = (await requestText({
      title: "Rename collection",
      label: "Name",
      initialValue: node.name,
    }))?.trim();
    if (name) renameCollection(node.id, name);
  }

  return (
    <li
      role="treeitem"
      aria-expanded={node.kind === "set" ? expanded : undefined}
      aria-selected={active}
    >
      <div className="group flex items-center" style={{ paddingLeft: depth * 12 }}>
        {node.kind === "set" ? (
          <button
            type="button"
            onClick={toggle}
            aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className="flex h-7 w-5 shrink-0 items-center justify-center text-lr-text-faint hover:text-lr-text"
          >
            <IconChevronRight className={`h-2.5 w-2.5 transition ${expanded ? "rotate-90" : ""}`} />
          </button>
        ) : <span className="w-5 shrink-0" />}
        <button
          type="button"
          onClick={() => {
            if (node.kind === "set") toggle();
            else if (node.kind === "album") setCatalogView({ type: "album", albumId: node.id });
            else setCatalogView({ type: "smart", collectionId: node.id });
          }}
          onDoubleClick={() => void rename()}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2 py-2 text-left text-[13px] transition-colors ${
            active ? "bg-lr-selection text-lr-text" : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
          }`}
        >
          {node.kind === "set" ? (
            <IconFolder className="h-3 w-3 shrink-0 text-lr-text-dim" />
          ) : (
            <IconAlbum className={`h-3 w-3 shrink-0 ${node.kind === "smart" ? "text-lr-accent" : "text-lr-text-dim"}`} />
          )}
          <span className="truncate">{node.name}</span>
          {target ? <span className="ml-auto text-[9px] font-semibold text-lr-accent">TARGET</span> : null}
          <span className="ml-auto font-mono text-[10px] text-lr-text-faint">{count}</span>
        </button>
        <details className="relative shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <summary className="flex h-7 w-5 cursor-pointer list-none items-center justify-center rounded text-lr-text-faint hover:bg-lr-panel-hover hover:text-lr-text" aria-label={`Actions for ${node.name}`}>
            ···
          </summary>
          <div className="absolute right-0 top-7 z-40 w-36 rounded-md border border-lr-border bg-lr-panel-raised p-1 shadow-xl">
            <NodeAction onClick={() => void rename()}>Rename</NodeAction>
            <NodeAction onClick={() => reorderCollection(node.id, -1)}>Move up</NodeAction>
            <NodeAction onClick={() => reorderCollection(node.id, 1)}>Move down</NodeAction>
            {node.parentId !== null ? (
              <NodeAction onClick={() => moveCollection(node.id, null)}>Move to root</NodeAction>
            ) : null}
            {workspace.collections.some((item) => item.kind === "set" && item.id !== node.id) ? (
              <NodeAction onClick={() => void (async () => {
                const sets = workspace.collections.filter((item) => item.kind === "set" && item.id !== node.id);
                const destinationId = await requestText({
                  title: "Move collection",
                  label: "Destination set",
                  confirmLabel: "Move",
                  options: sets.map((item) => ({ value: item.id, label: item.name })),
                });
                if (destinationId) moveCollection(node.id, destinationId);
              })()}>Move to set…</NodeAction>
            ) : null}
            {node.kind === "album" ? (
              <NodeAction onClick={() => setTargetAlbum(target ? null : node.id)}>
                {target ? "Clear target" : "Set as target"}
              </NodeAction>
            ) : null}
            {node.kind === "smart" ? (
              <>
                <NodeAction onClick={() => onEditSmart(node)}>Edit rule</NodeAction>
                <NodeAction onClick={() => duplicateSmartAlbum(node.id)}>Duplicate</NodeAction>
              </>
            ) : null}
            {node.kind === "set" ? (
              <>
                <NodeAction onClick={() => void create("album", node.id)}>New album inside</NodeAction>
                <NodeAction onClick={() => void create("set", node.id)}>New set inside</NodeAction>
                <NodeAction onClick={() => void create("smart", node.id)}>New Smart Album</NodeAction>
                <NodeAction onClick={() => void (async () => {
                  const confirmed = await requestConfirmation({
                    title: `Delete ${node.name}?`,
                    message: `Delete this collection set and promote its ${children.length} direct child collection${children.length === 1 ? "" : "s"}. Photo files and album membership are preserved.`,
                    confirmLabel: "Delete and promote",
                  });
                  if (confirmed) deleteCollection(node.id, false);
                })()}>Delete; promote children</NodeAction>
                <NodeAction danger onClick={() => void (async () => {
                  const confirmed = await requestConfirmation({
                    title: `Delete ${node.name} subtree?`,
                    message: "Delete this set and every descendant collection definition. Photo files are not deleted.",
                    confirmLabel: "Delete subtree",
                    danger: true,
                  });
                  if (confirmed) deleteCollection(node.id, true);
                })()}>Delete subtree</NodeAction>
              </>
            ) : (
              <NodeAction danger onClick={() => void (async () => {
                const confirmed = await requestConfirmation({
                  title: `Delete ${node.name}?`,
                  message: node.kind === "album"
                    ? `Delete this album and its ${count} membership record${count === 1 ? "" : "s"}. Photo files and photo metadata are preserved.`
                    : "Delete this saved rule. Photo files and manual album membership are preserved.",
                  confirmLabel: "Delete collection",
                  danger: true,
                });
                if (confirmed) deleteCollection(node.id);
              })()}>Delete</NodeAction>
            )}
          </div>
        </details>
      </div>
      {node.kind === "set" && expanded && children.length > 0 ? (
        <ul role="group">
          {children.map((child) => (
            <CollectionNodeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              smartCounts={smartCounts}
              create={create}
              requestText={requestText}
              requestConfirmation={requestConfirmation}
              onEditSmart={onEditSmart}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function NodeAction({
  children,
  danger = false,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-lr-panel-hover ${
        danger ? "text-lr-danger" : "text-lr-text-muted"
      }`}
    >
      {children}
    </button>
  );
}
