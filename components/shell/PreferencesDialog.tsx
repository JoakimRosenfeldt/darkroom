"use client";

import { useEffect, useRef, useState } from "react";
import { useExperimentalTools } from "@/hooks/useExperimentalTools";
import { useLibraryViewSettings } from "@/hooks/useLibraryViewSettings";
import { useWorkspacePreferences } from "@/hooks/useWorkspacePreferences";
import { ExportPreferences } from "./ExportPreferences";

const sections = ["Library", "Workspace", "Export"] as const;
const selectClass = "h-9 w-44 rounded-md border border-lr-border bg-lr-panel px-2 text-xs text-lr-text focus-visible:outline-2 focus-visible:outline-lr-accent";
const rowClass = "flex items-center justify-between gap-6 py-3 text-xs text-lr-text";

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<(typeof sections)[number]>("Library");
  const [library, updateLibrary] = useLibraryViewSettings();
  const [workspace, updateWorkspace] = useWorkspacePreferences();
  const [experimental, setExperimental] = useExperimentalTools();

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="preferences-title"
      className="m-auto max-h-[85vh] w-[560px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-lr-border bg-lr-panel-raised p-0 text-lr-text shadow-2xl backdrop:bg-black/60"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex max-h-[calc(85vh-2px)] flex-col">
        <header className="shrink-0 border-b border-lr-border-subtle px-6 pb-4 pt-5">
          <h2 id="preferences-title" className="text-base font-semibold">Preferences</h2>
          <p className="mt-1 text-xs text-lr-text-dim">Changes are saved automatically.</p>
          <nav aria-label="Preference sections" className="mt-5 flex gap-1">
            {sections.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={section === name}
                aria-controls={`preferences-${name.toLowerCase()}`}
                onClick={() => setSection(name)}
                className={`rounded-md px-3 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-lr-accent ${section === name ? "bg-lr-selection text-lr-accent" : "text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text"}`}
              >
                {name}
              </button>
            ))}
          </nav>
        </header>

        <div className="min-h-0 overflow-y-auto px-6 py-3">
          <section id="preferences-library" aria-label="Library preferences" hidden={section !== "Library"}>
            <label className={rowClass}>
              <span>Grid layout</span>
              <select className={selectClass} value={library.viewMode} onChange={(event) => updateLibrary({ viewMode: event.target.value === "grid" ? "grid" : "dynamic" })}>
                <option value="dynamic">Dynamic grid</option>
                <option value="grid">Square grid</option>
              </select>
            </label>
            <label className={rowClass}>
              <span>Thumbnail size</span>
              <span className="flex w-44 items-center gap-3">
                <input aria-label="Thumbnail size" type="range" min={120} max={320} step={20} value={library.thumbSize} onChange={(event) => updateLibrary({ thumbSize: Number(event.target.value) })} className="thin-slider min-w-0 flex-1" />
                <span className="w-12 text-right font-mono text-[11px] text-lr-text-muted">{library.thumbSize}px</span>
              </span>
            </label>
            <label className={rowClass}>
              <span>Sort photos by</span>
              <select className={selectClass} value={library.sort} onChange={(event) => {
                const sort = event.target.value;
                if (sort === "name" || sort === "date" || sort === "rating" || sort === "pick") updateLibrary({ sort });
              }}>
                <option value="name">File name</option>
                <option value="date">Capture date</option>
                <option value="rating">Rating</option>
                <option value="pick">Pick status</option>
              </select>
            </label>
            <label className={rowClass}>
              <span>Sort order</span>
              <select className={selectClass} value={library.sortDirection} onChange={(event) => updateLibrary({ sortDirection: event.target.value === "descending" ? "descending" : "ascending" })}>
                <option value="ascending">Ascending</option>
                <option value="descending">Descending</option>
              </select>
            </label>
            <label className={`${rowClass} mt-2 border-t border-lr-border-subtle`}>
              <span>
                <span className="block">Auto-advance</span>
                <span className="mt-1 block leading-5 text-lr-text-dim">Move to the next photo after rating or flagging.</span>
              </span>
              <input type="checkbox" checked={library.autoAdvance} onChange={(event) => updateLibrary({ autoAdvance: event.target.checked })} className="h-4 w-4 shrink-0 accent-lr-accent" />
            </label>
          </section>

          <section id="preferences-workspace" aria-label="Workspace preferences" hidden={section !== "Workspace"}>
            <label className={rowClass}>
              <span>
                <span className="block">Show filmstrip</span>
                <span className="mt-1 block leading-5 text-lr-text-dim">Display photo thumbnails below the Develop canvas.</span>
              </span>
              <input type="checkbox" checked={workspace.showFilmstrip} onChange={(event) => updateWorkspace({ showFilmstrip: event.target.checked })} className="h-4 w-4 shrink-0 accent-lr-accent" />
            </label>
            <label className={`${rowClass} border-t border-lr-border-subtle`}>
              <span>
                <span className="block">Link Compare views</span>
                <span className="mt-1 block leading-5 text-lr-text-dim">Move and zoom both photos together.</span>
              </span>
              <input type="checkbox" checked={workspace.linkedCompare} onChange={(event) => updateWorkspace({ linkedCompare: event.target.checked })} className="h-4 w-4 shrink-0 accent-lr-accent" />
            </label>
            <label className={`${rowClass} border-t border-lr-border-subtle`}>
              <span>
                <span className="block">Experimental tools</span>
                <span className="mt-1 block leading-5 text-lr-text-dim">Show experimental controls in Develop.</span>
              </span>
              <input type="checkbox" checked={experimental} onChange={(event) => setExperimental(event.target.checked)} className="h-4 w-4 shrink-0 accent-lr-accent" />
            </label>
          </section>

          <section id="preferences-export" aria-label="Export preferences" hidden={section !== "Export"}>
            <ExportPreferences />
          </section>
        </div>

        <footer className="flex shrink-0 justify-end border-t border-lr-border-subtle px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-md bg-lr-accent px-4 py-2 text-xs font-medium text-[#14202a] hover:bg-lr-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lr-accent">Done</button>
        </footer>
      </div>
    </dialog>
  );
}
