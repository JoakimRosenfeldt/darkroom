"use client";

import { useMemo, useState } from "react";
import { getEntryMetadata } from "@/lib/catalog/defaults";
import type {
  SmartChoiceField,
  SmartNumberField,
  SmartPredicate,
  SmartRuleGroup,
  SmartTextField,
} from "@/lib/library/model";
import { buildQueryIndex, evaluateSmartRule } from "@/lib/library/query";
import { useLibraryStore } from "@/stores/library-store";

const TEXT_FIELDS: readonly SmartTextField[] = [
  "filename", "path", "format", "camera", "lens", "location", "album", "keyword",
];
const NUMBER_FIELDS: readonly SmartNumberField[] = ["rating", "captureTime", "iso", "focalLength"];
const CHOICE_FIELDS: readonly SmartChoiceField[] = ["pick", "label", "edited"];
const ALL_FIELDS = [...TEXT_FIELDS, ...NUMBER_FIELDS, ...CHOICE_FIELDS] as const;

function defaultPredicate(): SmartPredicate {
  return { kind: "text", field: "filename", operator: "contains", value: "" };
}

function defaultGroup(): SmartRuleGroup {
  return { version: 1, match: "all", children: [] };
}

function predicateForField(field: (typeof ALL_FIELDS)[number]): SmartPredicate {
  if (TEXT_FIELDS.includes(field as SmartTextField)) {
    return { kind: "text", field: field as SmartTextField, operator: "contains", value: "" };
  }
  if (NUMBER_FIELDS.includes(field as SmartNumberField)) {
    return { kind: "number", field: field as SmartNumberField, operator: "equals", value: 0 };
  }
  const choiceField = field as SmartChoiceField;
  return {
    kind: "choice",
    field: choiceField,
    operator: "equals",
    value: choiceField === "edited" ? true : choiceField === "pick" ? "none" : "red",
  };
}

function nodeCount(group: SmartRuleGroup): number {
  return 1 + group.children.reduce(
    (total, child) => total + ("version" in child ? nodeCount(child) : 1),
    0,
  );
}

function invalidReason(group: SmartRuleGroup): string | null {
  if (group.children.length === 0) return "An empty rule includes every photo in its scope.";
  for (const child of group.children) {
    if ("version" in child) {
      const nested = invalidReason(child);
      if (nested && !nested.startsWith("An empty rule")) return nested;
      continue;
    }
    if (child.operator !== "missing" && child.value === null) return `Choose a value for ${child.field}.`;
    if (child.kind === "text" && child.operator !== "missing" && child.value?.trim() === "") {
      return `Enter a value for ${child.field}.`;
    }
  }
  return null;
}

export function SmartAlbumEditor({
  name,
  initialRule,
  onSave,
  onCancel,
}: {
  name: string;
  initialRule?: SmartRuleGroup;
  onSave: (rule: SmartRuleGroup) => void;
  onCancel: () => void;
}) {
  const entries = useLibraryStore((state) => state.entries);
  const metadata = useLibraryStore((state) => state.entryMetadata);
  const albums = useLibraryStore((state) => state.albums);
  const archivedEntryIds = useLibraryStore((state) => state.archivedEntryIds);
  const workspace = useLibraryStore((state) => state.libraryWorkspace);
  const [draft, setDraft] = useState<SmartRuleGroup>(() => initialRule ?? defaultGroup());
  const reason = invalidReason(draft);
  const previewCount = useMemo(() => {
    const archived = new Set(archivedEntryIds);
    const excluded = new Set(workspace.excludedEntryIds);
    const index = buildQueryIndex(entries, metadata, albums, workspace);
    return entries.filter((entry) => {
      const record = index.get(entry.id);
      return !archived.has(entry.id) &&
        !excluded.has(entry.id) &&
        record !== undefined &&
        evaluateSmartRule(
          draft,
          entry,
          record,
          getEntryMetadata(metadata, entry.id),
          workspace.analysisByEntryId[entry.id],
        );
    }).length;
  }, [albums, archivedEntryIds, draft, entries, metadata, workspace]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="smart-editor-title" className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-lr-border bg-lr-panel-raised shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-lr-border-subtle px-5 py-4">
          <div>
            <h2 id="smart-editor-title" className="text-sm font-semibold text-lr-text">Smart Album · {name}</h2>
            <p className="mt-1 text-xs text-lr-text-muted">Build typed rules. Changes remain private until Save.</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm text-lr-accent">{previewCount} photos</p>
            <p className="text-[10px] text-lr-text-faint">Live preview</p>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <RuleGroupEditor group={draft} onChange={setDraft} depth={0} totalNodes={nodeCount(draft)} />
          {reason ? (
            <p className={`mt-3 rounded-md border px-3 py-2 text-xs ${reason.startsWith("An empty rule") ? "border-lr-border-subtle text-lr-text-muted" : "border-red-500/30 text-red-300"}`}>
              {reason}
            </p>
          ) : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-lr-border-subtle px-5 py-4">
          <button type="button" onClick={onCancel} className="rounded-md border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text">Cancel</button>
          <button type="button" disabled={Boolean(reason && !reason.startsWith("An empty rule"))} onClick={() => onSave(draft)} className="rounded-md bg-lr-accent px-3 py-1.5 text-xs text-white hover:brightness-110 disabled:opacity-40">Save Smart Album</button>
        </footer>
      </div>
    </div>
  );
}

function RuleGroupEditor({
  group,
  onChange,
  depth,
  totalNodes,
}: {
  group: SmartRuleGroup;
  onChange: (group: SmartRuleGroup) => void;
  depth: number;
  totalNodes: number;
}) {
  function replace(index: number, child: SmartPredicate | SmartRuleGroup) {
    onChange({ ...group, children: group.children.map((current, childIndex) => childIndex === index ? child : current) });
  }

  return (
    <section className={`rounded-lg border p-3 ${depth === 0 ? "border-lr-border bg-lr-panel" : "border-lr-border-subtle bg-lr-panel-raised"}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-lr-text-muted">Match</span>
        <select value={group.match} onChange={(event) => onChange({ ...group, match: event.target.value as "all" | "any" })} className="h-8 rounded border border-lr-border bg-lr-panel-raised px-2 text-xs text-lr-text">
          <option value="all">all rules</option>
          <option value="any">any rule</option>
        </select>
        <span className="text-[10px] text-lr-text-faint">Group {depth + 1}</span>
      </div>
      <div className="mt-3 space-y-2">
        {group.children.map((child, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {"version" in child ? (
                <RuleGroupEditor group={child} onChange={(next) => replace(index, next)} depth={depth + 1} totalNodes={totalNodes} />
              ) : (
                <PredicateEditor predicate={child} onChange={(next) => replace(index, next)} />
              )}
            </div>
            <button type="button" aria-label="Remove rule" onClick={() => onChange({ ...group, children: group.children.filter((_, childIndex) => childIndex !== index) })} className="mt-1 rounded px-2 py-1 text-xs text-lr-text-faint hover:bg-lr-panel-hover hover:text-lr-danger">×</button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={totalNodes >= 100} onClick={() => onChange({ ...group, children: [...group.children, defaultPredicate()] })} className="rounded border border-lr-border-subtle px-2.5 py-1.5 text-[11px] text-lr-text-muted hover:text-lr-text disabled:opacity-40">Add rule</button>
        <button type="button" disabled={depth >= 4 || totalNodes >= 100} onClick={() => onChange({ ...group, children: [...group.children, defaultGroup()] })} className="rounded border border-lr-border-subtle px-2.5 py-1.5 text-[11px] text-lr-text-muted hover:text-lr-text disabled:opacity-40">Add group</button>
      </div>
    </section>
  );
}

function PredicateEditor({
  predicate,
  onChange,
}: {
  predicate: SmartPredicate;
  onChange: (predicate: SmartPredicate) => void;
}) {
  const operators = predicate.kind === "text"
    ? ["contains", "equals", "missing"] as const
    : predicate.kind === "number"
      ? ["equals", "atLeast", "atMost", "missing"] as const
      : ["equals", "missing"] as const;

  return (
    <div className="grid grid-cols-[minmax(120px,1fr)_110px_minmax(120px,1fr)] gap-2 rounded-md border border-lr-border-subtle bg-lr-panel-raised p-2">
      <select value={predicate.field} onChange={(event) => onChange(predicateForField(event.target.value as (typeof ALL_FIELDS)[number]))} aria-label="Rule field" className="h-8 min-w-0 rounded border border-lr-border bg-lr-panel px-2 text-xs text-lr-text">
        {ALL_FIELDS.map((field) => <option key={field} value={field}>{field}</option>)}
      </select>
      <select value={predicate.operator} onChange={(event) => {
        const operator = event.target.value;
        if (predicate.kind === "text") onChange({ ...predicate, operator: operator as "contains" | "equals" | "missing", value: operator === "missing" ? null : predicate.value ?? "" });
        else if (predicate.kind === "number") onChange({ ...predicate, operator: operator as "equals" | "atLeast" | "atMost" | "missing", value: operator === "missing" ? null : predicate.value ?? 0 });
        else onChange({
          ...predicate,
          operator: operator as "equals" | "missing",
          value: operator === "missing"
            ? null
            : predicate.value ?? (predicate.field === "edited" ? true : predicate.field === "pick" ? "none" : "red"),
        });
      }} aria-label="Rule operator" className="h-8 rounded border border-lr-border bg-lr-panel px-2 text-xs text-lr-text">
        {operators.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
      </select>
      <PredicateValue predicate={predicate} onChange={onChange} />
    </div>
  );
}

function PredicateValue({ predicate, onChange }: { predicate: SmartPredicate; onChange: (predicate: SmartPredicate) => void }) {
  if (predicate.operator === "missing") return <span className="self-center text-[10px] text-lr-text-faint">No value</span>;
  if (predicate.kind === "text") {
    return <input value={predicate.value ?? ""} onChange={(event) => onChange({ ...predicate, value: event.target.value })} aria-label="Rule value" className="h-8 min-w-0 rounded border border-lr-border bg-lr-panel px-2 text-xs text-lr-text" />;
  }
  if (predicate.kind === "number") {
    if (predicate.field === "captureTime") {
      const value = predicate.value === null ? "" : new Date(predicate.value).toISOString().slice(0, 16);
      return <input type="datetime-local" value={value} onChange={(event) => onChange({ ...predicate, value: event.target.value ? new Date(event.target.value).getTime() : null })} aria-label="Rule date" className="h-8 min-w-0 rounded border border-lr-border bg-lr-panel px-2 text-xs text-lr-text" />;
    }
    return <input type="number" min={predicate.field === "rating" ? 0 : undefined} max={predicate.field === "rating" ? 5 : undefined} value={predicate.value ?? ""} onChange={(event) => onChange({ ...predicate, value: event.target.value === "" ? null : Number(event.target.value) })} aria-label="Rule number" className="h-8 min-w-0 rounded border border-lr-border bg-lr-panel px-2 text-xs text-lr-text" />;
  }
  if (predicate.field === "edited") {
    return <select value={String(predicate.value)} onChange={(event) => onChange({ ...predicate, value: event.target.value === "true" })} aria-label="Rule value" className="h-8 rounded border border-lr-border bg-lr-panel px-2 text-xs text-lr-text"><option value="true">edited</option><option value="false">unedited</option></select>;
  }
  const values = predicate.field === "pick" ? ["none", "pick", "reject"] : ["red", "yellow", "green", "blue", "purple"];
  return <select value={String(predicate.value)} onChange={(event) => onChange({ ...predicate, value: event.target.value })} aria-label="Rule value" className="h-8 rounded border border-lr-border bg-lr-panel px-2 text-xs text-lr-text">{values.map((value) => <option key={value} value={value}>{value}</option>)}</select>;
}
