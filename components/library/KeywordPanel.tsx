"use client";

import { useMemo } from "react";
import type { Keyword } from "@/lib/library/model";
import { useLibraryStore } from "@/stores/library-store";
import { IconPlus, IconTrash } from "@/components/shell/icons";
import {
  useLibraryDialog,
  type RequestConfirmationOptions,
  type RequestTextOptions,
} from "./useLibraryDialog";

export function KeywordPanel({ disabled }: { disabled: boolean }) {
  const workspace = useLibraryStore((state) => state.libraryWorkspace);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const createKeyword = useLibraryStore((state) => state.createKeyword);
  const assignKeywordToEntries = useLibraryStore((state) => state.assignKeywordToEntries);
  const removeKeywordFromEntries = useLibraryStore((state) => state.removeKeywordFromEntries);
  const renameKeyword = useLibraryStore((state) => state.renameKeyword);
  const moveKeyword = useLibraryStore((state) => state.moveKeyword);
  const mergeKeyword = useLibraryStore((state) => state.mergeKeyword);
  const deleteKeyword = useLibraryStore((state) => state.deleteKeyword);
  const dialog = useLibraryDialog();
  const children = useMemo(() => {
    const grouped = new Map<string | null, Keyword[]>();
    for (const keyword of workspace.keywords) {
      const siblings = grouped.get(keyword.parentId) ?? [];
      siblings.push(keyword);
      grouped.set(keyword.parentId, siblings);
    }
    for (const siblings of grouped.values()) siblings.sort((a, b) => a.name.localeCompare(b.name));
    return grouped;
  }, [workspace.keywords]);

  async function create(parentId: string | null = null) {
    const name = (await dialog.requestText({ title: "New keyword", label: "Keyword name", confirmLabel: "Create" }))?.trim();
    if (name) createKeyword(name, parentId);
  }

  return (
    <section className="mt-4 px-2">
      {dialog.element}
      <div className="flex items-center justify-between px-2 pb-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">
          Keywords
        </h3>
        <button
          type="button"
          onClick={() => create()}
          disabled={disabled}
          title="New keyword"
          aria-label="New keyword"
          className="flex h-6 w-6 items-center justify-center rounded-md text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
        >
          <IconPlus className="h-3 w-3" />
        </button>
      </div>
      {(children.get(null)?.length ?? 0) > 0 ? (
        <ul aria-label="Keywords" className="space-y-px">
          {children.get(null)?.map((keyword) => (
            <KeywordItem
              key={keyword.id}
              keyword={keyword}
              depth={0}
              childrenByParent={children}
              selectedEntryIds={selectedEntryIds}
              assignedByEntry={workspace.entryKeywordIds}
              create={create}
              assign={assignKeywordToEntries}
              remove={removeKeywordFromEntries}
              rename={renameKeyword}
              move={moveKeyword}
              merge={mergeKeyword}
              deleteKeyword={deleteKeyword}
              requestText={dialog.requestText}
              requestConfirmation={dialog.requestConfirmation}
            />
          ))}
        </ul>
      ) : (
        <p className="px-2 py-2 text-xs text-lr-text-muted">Add keywords to describe selected photos.</p>
      )}
    </section>
  );
}

function KeywordItem({
  keyword,
  depth,
  childrenByParent,
  selectedEntryIds,
  assignedByEntry,
  create,
  assign,
  remove,
  rename,
  move,
  merge,
  deleteKeyword,
  requestText,
  requestConfirmation,
}: {
  keyword: Keyword;
  depth: number;
  childrenByParent: ReadonlyMap<string | null, readonly Keyword[]>;
  selectedEntryIds: readonly string[];
  assignedByEntry: Readonly<Record<string, readonly string[]>>;
  create: (parentId: string | null) => void;
  assign: (keywordId: string, entryIds: string[]) => void;
  remove: (keywordId: string, entryIds: string[]) => void;
  rename: (keywordId: string, name: string) => void;
  move: (keywordId: string, parentId: string | null) => void;
  merge: (sourceId: string, targetId: string) => void;
  deleteKeyword: (keywordId: string, deleteSubtree?: boolean) => void;
  requestText: (options: RequestTextOptions) => Promise<string | null>;
  requestConfirmation: (options: RequestConfirmationOptions) => Promise<boolean>;
}) {
  const children = childrenByParent.get(keyword.id) ?? [];
  const selected = [...selectedEntryIds];
  const assignedCount = Object.values(assignedByEntry).filter((ids) => ids.includes(keyword.id)).length;
  const assignedToAll = selected.length > 0 && selected.every((entryId) =>
    assignedByEntry[entryId]?.includes(keyword.id) ?? false
  );

  return (
    <li>
      <div className="group flex items-center gap-1" style={{ paddingLeft: depth * 12 }}>
        <button
          type="button"
          disabled={selected.length === 0}
          aria-pressed={assignedToAll}
          onClick={() => assignedToAll
            ? remove(keyword.id, selected)
            : assign(keyword.id, selected)}
          className={`min-w-0 flex-1 rounded-[7px] px-2.5 py-1.5 text-left text-xs transition-colors ${
            assignedToAll ? "bg-lr-selection text-lr-accent" : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
          } disabled:opacity-50`}
          title={selected.length === 0 ? "Select photos to assign keywords" : "Toggle keyword on selected photos"}
        >
          <span className="truncate">{keyword.name}</span>
          <span className="float-right font-mono text-[10px] text-lr-text-faint">{assignedCount}</span>
        </button>
        <details className="relative opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <summary className="flex h-6 w-5 cursor-pointer list-none items-center justify-center text-lr-text-faint">···</summary>
          <div className="absolute right-0 top-6 z-40 w-32 rounded border border-lr-border bg-lr-panel-raised p-1 shadow-xl">
            <button type="button" onClick={() => void create(keyword.id)} className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-lr-text-muted hover:bg-lr-panel-hover">Add child</button>
            <button type="button" onClick={() => void (async () => {
              const name = (await requestText({ title: "Rename keyword", label: "Keyword name", initialValue: keyword.name }))?.trim();
              if (name) rename(keyword.id, name);
            })()} className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-lr-text-muted hover:bg-lr-panel-hover">Rename</button>
            {keyword.parentId !== null ? (
              <button type="button" onClick={() => move(keyword.id, null)} className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-lr-text-muted hover:bg-lr-panel-hover">Move to root</button>
            ) : null}
            {[...childrenByParent.values()].flat().some((item) => item.id !== keyword.id) ? (
              <button type="button" onClick={() => void (async () => {
                const descendants = new Set<string>();
                const pending = [keyword.id];
                while (pending.length > 0) {
                  const current = pending.pop();
                  for (const child of childrenByParent.get(current ?? "") ?? []) {
                    if (descendants.has(child.id)) continue;
                    descendants.add(child.id);
                    pending.push(child.id);
                  }
                }
                const targets = [...childrenByParent.values()].flat().filter((item) => item.id !== keyword.id && !descendants.has(item.id));
                if (targets.length === 0) return;
                const targetId = await requestText({
                  title: "Move keyword",
                  label: "New parent",
                  confirmLabel: "Move",
                  options: targets.map((item) => ({ value: item.id, label: item.name })),
                });
                if (targetId) move(keyword.id, targetId);
              })()} className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-lr-text-muted hover:bg-lr-panel-hover">Move under…</button>
            ) : null}
            <button type="button" onClick={() => void (async () => {
              const targets = [...childrenByParent.values()].flat().filter((item) => item.id !== keyword.id);
              if (targets.length === 0) return;
              const targetId = await requestText({
                title: "Merge keyword",
                label: "Destination keyword",
                confirmLabel: "Merge",
                options: targets.map((item) => ({ value: item.id, label: item.name })),
              });
              if (!targetId) return;
              const target = targets.find((item) => item.id === targetId);
              const confirmed = await requestConfirmation({
                title: "Merge keyword?",
                message: `Move ${assignedCount} direct assignment${assignedCount === 1 ? "" : "s"} and ${children.length} child keyword${children.length === 1 ? "" : "s"} into ${target?.name ?? "the selected keyword"}.`,
                confirmLabel: "Merge",
                danger: true,
              });
              if (confirmed) merge(keyword.id, targetId);
            })()} className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-lr-text-muted hover:bg-lr-panel-hover">Merge into…</button>
            <button type="button" onClick={() => void (async () => {
              let deleteSubtree = false;
              if (children.length > 0) {
                const choice = await requestText({
                  title: "Delete keyword",
                  label: "Child keyword handling",
                  confirmLabel: "Next",
                  options: [
                    { value: "promote", label: `Promote ${children.length} children` },
                    { value: "subtree", label: "Delete the full subtree" },
                  ],
                });
                if (choice === null) return;
                deleteSubtree = choice === "subtree";
              }
              const confirmed = await requestConfirmation({
                title: `Delete ${keyword.name}?`,
                message: deleteSubtree
                  ? `Delete this keyword subtree and remove its assignments from photos. Source files are not deleted.`
                  : `Remove ${assignedCount} direct assignment${assignedCount === 1 ? "" : "s"}${children.length > 0 ? ` and promote ${children.length} child keyword${children.length === 1 ? "" : "s"}` : ""}. Source files are not deleted.`,
                confirmLabel: "Delete keyword",
                danger: true,
              });
              if (confirmed) deleteKeyword(keyword.id, deleteSubtree);
            })()} className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-[11px] text-lr-danger hover:bg-lr-panel-hover"><IconTrash className="h-3 w-3" />Delete</button>
          </div>
        </details>
      </div>
      {children.length > 0 ? (
        <ul>
          {children.map((child) => (
            <KeywordItem
              key={child.id}
              keyword={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              selectedEntryIds={selectedEntryIds}
              assignedByEntry={assignedByEntry}
              create={create}
              assign={assign}
              remove={remove}
              rename={rename}
              move={move}
              merge={merge}
              deleteKeyword={deleteKeyword}
              requestText={requestText}
              requestConfirmation={requestConfirmation}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
