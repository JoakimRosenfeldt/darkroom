"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  loadDevelopImage,
  preloadDevelopImages,
} from "@/lib/cache/develop-image-cache";
import { ModuleSpine } from "@/components/shell/ModuleSpine";
import {
  EntryMetadataBar,
  useEntryMetadataForId,
} from "@/components/library/EntryMetadataBar";
import { useLibraryStore } from "@/stores/library-store";
import type { SelectEntryModifiers } from "@/stores/library-store";
import { DevelopSidePanels } from "@/components/develop/DevelopSidePanels";
import {
  DevelopCanvas,
  type V3CanvasTool,
  type V3CanvasDiagnostic,
} from "@/components/develop/DevelopCanvas";
import type { CpuAnalysisTapResult } from "@/lib/develop/v3/cpu-backend";
import type { DevelopPanelId } from "@/components/develop/DevelopPanelRail";
import { useDevelopSettingsSync } from "@/components/develop/useDevelopSettingsSync";
import { useDevelopStore } from "@/stores/develop-store";
import { ExportDialog } from "@/components/export/ExportDialog";
import { Filmstrip } from "./Filmstrip";
import { useEntryMetadataShortcuts } from "@/hooks/useEntryMetadataShortcuts";
import { isEditableTarget } from "@/hooks/is-editable-target";
import { updateViewerSessionActive, viewerPhotoHref } from "@/lib/viewer/session";

interface PhotoViewerProps {
  entry: LibraryEntry;
  entries: LibraryEntry[];
  resultId: string;
  resultCatalogRevision: number;
  resultEntryIds: readonly string[];
  missingEntryIds: readonly string[];
  sessionMessage: string | null;
  onRefreshResult: () => void;
}

function fileType(name: string): string {
  return name.split(".").at(-1)?.toUpperCase() ?? "PHOTO";
}

function captureSummary(metadata: Record<string, unknown>): string[] {
  const summary: string[] = [];
  const iso = metadata.iso_speed;
  const aperture = metadata.aperture;
  const shutter = metadata.shutter;
  if (typeof iso === "number" || typeof iso === "string") {
    summary.push(`ISO ${iso}`);
  }
  if (typeof aperture === "number") {
    summary.push(`f/${aperture.toFixed(1)}`);
  } else if (typeof aperture === "string") {
    summary.push(aperture);
  }
  if (typeof shutter === "number" && shutter > 0) {
    summary.push(shutter >= 1 ? `${shutter}s` : `1/${Math.round(1 / shutter)}`);
  } else if (typeof shutter === "string") {
    summary.push(shutter);
  }
  return summary;
}

export function PhotoViewer({
  entry,
  entries,
  resultId,
  resultCatalogRevision,
  resultEntryIds,
  missingEntryIds,
  sessionMessage,
  onRefreshResult,
}: PhotoViewerProps) {
  const router = useRouter();
  const activeSelectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const stacks = useLibraryStore((state) => state.libraryWorkspace.stacks);
  const setStackCover = useLibraryStore((state) => state.setStackCover);
  const reorderStackEntry = useLibraryStore((state) => state.reorderStackEntry);
  const removeEntriesFromStack = useLibraryStore((state) => state.removeEntriesFromStack);
  const selectEntry = useLibraryStore((state) => state.selectEntry);
  const applyMetadataToEntries = useLibraryStore(
    (state) => state.applyMetadataToEntries,
  );
  const metadata = useEntryMetadataForId(entry.id);
  const [decoded, setDecoded] = useState<DevelopImage | null>(null);
  const [activePanel, setActivePanel] = useState<DevelopPanelId | null>("edit");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [v3RenderDiagnostics, setV3RenderDiagnostics] = useState<readonly V3CanvasDiagnostic[]>([]);
  const [v3Analysis, setV3Analysis] = useState<readonly CpuAnalysisTapResult[]>([]);
  const [v3CanvasState, setV3CanvasState] = useState<{
    readonly entryId: string;
    readonly tool: V3CanvasTool;
  }>({ entryId: entry.id, tool: { kind: "none" } });
  const v3CanvasTool = v3CanvasState.entryId === entry.id
    ? v3CanvasState.tool
    : { kind: "none" } satisfies V3CanvasTool;
  const setV3CanvasTool = useCallback((tool: V3CanvasTool) => {
    setV3CanvasState({ entryId: entry.id, tool });
  }, [entry.id]);
  const activeIndex = useMemo(
    () => resultEntryIds.indexOf(entry.id),
    [entry.id, resultEntryIds],
  );
  const availableActiveIndex = useMemo(
    () => entries.findIndex((item) => item.id === entry.id),
    [entries, entry.id],
  );
  const visibleOrder = useMemo(() => entries.map((item) => item.id), [entries]);
  const availableEntryById = useMemo(
    () => new Map<string, LibraryEntry>(entries.map((item) => [item.id, item])),
    [entries],
  );
  const adjacentEntry = useCallback((direction: -1 | 1) => {
    for (
      let index = activeIndex + direction;
      index >= 0 && index < resultEntryIds.length;
      index += direction
    ) {
      const candidate = availableEntryById.get(resultEntryIds[index]!);
      if (candidate) return candidate;
    }
    return null;
  }, [activeIndex, availableEntryById, resultEntryIds]);
  const selectionTargets = useMemo(
    () =>
      selectedEntryIds.length > 0 && selectedEntryIds.includes(entry.id)
        ? selectedEntryIds
        : [entry.id],
    [entry.id, selectedEntryIds],
  );
  const persistDevelopState = useLibraryStore((state) => state.persistDevelopState);
  const hydrateEntryKeywords = useLibraryStore((state) => state.hydrateEntryKeywords);
  const persistCatalog = useCallback(
    (input: Parameters<typeof persistDevelopState>[2]) =>
      persistDevelopState(entry.catalogId, entry.id, input),
    [entry.catalogId, entry.id, persistDevelopState],
  );
  const hydrateKeywords = useCallback(
    (flat: readonly string[], hierarchical: readonly string[]) => {
      hydrateEntryKeywords(entry.id, flat, hierarchical);
    },
    [entry.id, hydrateEntryKeywords],
  );

  useDevelopSettingsSync({
    entry,
    metadata,
    persistCatalog,
    hydrateKeywords,
  });
  const persistedV3Document = useDevelopStore((state) => {
    const session = state.sessions[entry.id];
    return session?.processKind === "v3" && session.persistedDocument?.version === 3
      ? session.persistedDocument
      : null;
  });
  const developProcessKind = useDevelopStore(
    (state) => state.sessions[entry.id]?.processKind ?? "v2",
  );
  const undo = useDevelopStore((state) => state.undo);
  const redo = useDevelopStore((state) => state.redo);
  const canUndo = useDevelopStore((state) => (state.sessions[entry.id]?.undo.length ?? 0) > 0);
  const canRedo = useDevelopStore((state) => (state.sessions[entry.id]?.redo.length ?? 0) > 0);
  const maskUi = useDevelopStore((state) => {
    const session = state.sessions[entry.id];
    return session?.ui ?? null;
  });
  const setMaskOverlayVisible = useDevelopStore((state) => state.setMaskOverlayVisible);
  const setMaskTool = useDevelopStore((state) => state.setMaskTool);
  const [exportOpen, setExportOpen] = useState(false);
  const headerMasks = persistedV3Document?.local.masks ?? [];
  const headerSelectedMask = headerMasks.find((mask) => mask.id === maskUi?.selectedMaskId);
  const captureDetails = decoded ? captureSummary(decoded.metadata) : [];
  const currentStack = stacks.find((stack) => stack.entryIds.includes(entry.id));

  useEffect(() => {
    updateViewerSessionActive(resultId, entry.id);
  }, [entry.id, resultId]);

  useEffect(() => {
    if (
      activeSelectedEntryId &&
      activeSelectedEntryId !== entry.id &&
      selectedEntryIds.includes(entry.id) &&
      entries.some((item) => item.id === activeSelectedEntryId)
    ) {
      router.replace(viewerPhotoHref(activeSelectedEntryId, resultId));
    }
  }, [activeSelectedEntryId, entries, entry.id, resultId, router, selectedEntryIds]);

  useEffect(() => {
    let active = true;

    async function loadImage() {
      setLoading(true);
      setError(null);
      setDecoded(null);

      if (entry.formatAvailability.status !== "supported") {
        setError(
          entry.formatAvailability.reason ??
            `Preview is unavailable for ${entry.name}.`,
        );
        setLoading(false);
        return;
      }

      try {
        const result = await loadDevelopImage(entry);
        if (!active) {
          return;
        }
        setDecoded(result);
        preloadDevelopImages(entries, availableActiveIndex);
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to decode image.",
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadImage();

    return () => {
      active = false;
    };
  }, [entry, entries, availableActiveIndex]);

  useEntryMetadataShortcuts(selectionTargets, exportOpen);

  const closeEditingTools = useCallback(() => {
    setMaskTool("none");
    setV3CanvasTool({ kind: "none" });
    setActivePanel("edit");
  }, [setMaskTool, setV3CanvasTool]);

  function selectDevelopPanel(panel: DevelopPanelId) {
    setMaskTool("none");
    setV3CanvasTool({ kind: "none" });
    setActivePanel((current) => current === panel ? "edit" : panel);
  }

  const selectPhoto = useCallback(
    (id: string, modifiers: SelectEntryModifiers = {}) => {
      const removing = Boolean(
        modifiers.toggle && selectedEntryIds.includes(id),
      );
      if (removing && selectedEntryIds.length === 1) {
        return;
      }

      const remaining = removing
        ? selectedEntryIds.filter((selectedId) => selectedId !== id)
        : selectedEntryIds;
      selectEntry(id, modifiers, visibleOrder);
      closeEditingTools();

      const nextActiveId =
        removing && id === entry.id ? remaining.at(-1) : removing ? entry.id : id;
      if (nextActiveId && nextActiveId !== entry.id) {
        router.push(viewerPhotoHref(nextActiveId, resultId));
      }
    },
    [
      closeEditingTools,
      entry.id,
      router,
      selectEntry,
      selectedEntryIds,
      resultId,
      visibleOrder,
    ],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // The export dialog owns keyboard handling while it is mounted. In
      // particular, do not navigate away and unmount an in-flight export.
      if (exportOpen) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      const interactiveTarget =
        event.target instanceof HTMLElement &&
        Boolean(event.target.closest("button, a[href], [role='button']"));
      if (isEditableTarget(event.target) || interactiveTarget) {
        return;
      }
      const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (
        developProcessKind === "v3" &&
        activePanel === "masking" &&
        plainKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        setMaskOverlayVisible(!(maskUi?.overlayVisible ?? false));
        return;
      }
      const key = event.key.toLowerCase();
      if (developProcessKind === "v3" && plainKey && (key === "k" || key === "m")) {
        event.preventDefault();
        setActivePanel("masking");
        setMaskOverlayVisible(true);
        setMaskTool(key === "k" ? "brush" : event.shiftKey ? "radial-gradient" : "linear-gradient");
        return;
      }
      if (activePanel === "masking" && event.key === "Enter") {
        event.preventDefault();
        closeEditingTools();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.key === "ArrowLeft") {
        const previous = adjacentEntry(-1);
        if (!previous) return;
        event.preventDefault();
        selectPhoto(previous.id, {
          shift: event.shiftKey,
        });
      }
      if (event.key === "ArrowRight") {
        const next = adjacentEntry(1);
        if (!next) return;
        event.preventDefault();
        selectPhoto(next.id, {
          shift: event.shiftKey,
        });
      }
      if (event.key === "Escape") {
        if (v3CanvasTool.kind !== "none") {
          event.preventDefault();
          setV3CanvasTool({ kind: "none" });
          return;
        }
        if (maskUi?.tool !== "none") {
          event.preventDefault();
          setMaskTool("none");
          return;
        }
        if (activePanel === "crop" || activePanel === "masking" || activePanel === "cleanup") {
          event.preventDefault();
          closeEditingTools();
          return;
        }
        router.push("/");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    adjacentEntry,
    router,
    activePanel,
    closeEditingTools,
    exportOpen,
    selectPhoto,
    redo,
    undo,
    maskUi?.overlayVisible,
    setMaskOverlayVisible,
    maskUi?.tool,
    setMaskTool,
    setV3CanvasTool,
    v3CanvasTool.kind,
    developProcessKind,
  ]);

  return (
    <div className="flex h-screen overflow-hidden bg-lr-toolbar">
      <ModuleSpine activeModule="develop" developPhotoId={entry.id} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col bg-[#131110]">
          {sessionMessage ? (
            <div role="status" className="border-b border-amber-300/20 bg-amber-950/25 px-4 py-1.5 text-[11px] text-amber-100/80">{sessionMessage}</div>
          ) : null}
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-lr-border-subtle bg-lr-toolbar px-4">
            <span className="font-mono text-xs text-lr-text">{entry.name}</span>
            <span className={[
              "rounded-md px-1.5 py-0.5 font-mono text-[10px] text-lr-accent",
              activePanel === "crop" || activePanel === "masking" || activePanel === "cleanup"
                ? "bg-lr-selection"
                : "border border-lr-border-subtle",
            ].join(" ")}>
              {activePanel === "crop"
                ? "CROP"
                : activePanel === "masking"
                  ? "MASKING"
                  : activePanel === "cleanup"
                    ? "CLEANUP"
                  : fileType(entry.name)}
            </span>
            <span className="truncate font-mono text-[11px] text-lr-text-muted">
              {activePanel === "crop"
                ? "Adjust framing on the photo"
                : activePanel === "masking"
                  ? `${headerMasks.length} ${headerMasks.length === 1 ? "mask" : "masks"}${headerSelectedMask ? ` · ${headerSelectedMask.name}` : ""}`
                  : activePanel === "cleanup"
                    ? "Remove spots and distractions"
                  : decoded
                    ? [`${decoded.width} × ${decoded.height}`, ...captureDetails].join(" · ")
                : loading
                  ? "Preparing preview…"
                  : "Preview unavailable"}
            </span>
            <div className="flex-1" />
            {developProcessKind === "v3" && activePanel === "masking" ? (
              <>
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-faint">
                  Overlay
                </span>
                <button
                  type="button"
                  onClick={() => setMaskOverlayVisible(!(maskUi?.overlayVisible ?? false))}
                  aria-pressed={maskUi?.overlayVisible ?? false}
                  className={[
                    "h-8 rounded-lg border px-3 text-xs transition",
                    maskUi?.overlayVisible
                      ? "border-lr-accent/60 bg-lr-selection text-lr-accent"
                      : "border-lr-border-subtle bg-lr-panel-raised text-lr-text-muted hover:text-lr-text",
                  ].join(" ")}
                >
                  {maskUi?.overlayVisible ? "Hide" : "Show"} · O
                </button>
              </>
            ) : developProcessKind === "v3" && activePanel !== "crop" ? (
              <>
                <button type="button" disabled={!canUndo} onClick={undo} className="h-8 rounded-md border border-lr-border-subtle px-2.5 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-40">
                  Undo
                </button>
                <button type="button" disabled={!canRedo} onClick={redo} className="h-8 rounded-md border border-lr-border-subtle px-2.5 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-40">
                  Redo
                </button>
                <button
                  type="button"
                  disabled={adjacentEntry(1) === null}
                  onClick={() => {
                    const candidate = adjacentEntry(1);
                    if (candidate) router.push(`/compare?select=${encodeURIComponent(entry.id)}&candidate=${encodeURIComponent(candidate.id)}`);
                  }}
                  className="h-8 rounded-md border border-lr-border-subtle px-2.5 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-40"
                >
                  Compare
                </button>
                <button
                  type="button"
                  onClick={onRefreshResult}
                  className="h-8 rounded-md border border-lr-border-subtle px-2.5 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
                >
                  Refresh result
                </button>
                <button
                  type="button"
                  onClick={() => setExportOpen(true)}
                  className="h-8 rounded-lg bg-lr-accent px-3.5 text-xs font-medium text-[#14202a] transition hover:bg-lr-accent-hover"
                >
                  Export{selectionTargets.length > 1 ? ` ${selectionTargets.length}` : ""}…
                </button>
              </>
            ) : null}
          </div>

          <div className="relative min-h-0 flex-1 p-8">
            {loading ? (
              <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-lr-text-faint">
                Decoding...
              </div>
            ) : null}

            {error ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-lr-danger">
                {error}
              </div>
            ) : null}

            {decoded && developProcessKind === "v3" ? (
                <DevelopCanvas
                  entry={entry}
                  image={decoded}
                  alt={entry.name}
                  onRenderDiagnostics={setV3RenderDiagnostics}
                  onAnalysis={setV3Analysis}
                  cropActive={activePanel === "crop"}
                  maskingActive={
                    activePanel === "masking" || (maskUi?.tool ?? "none") !== "none"
                  }
                  canvasTool={v3CanvasTool}
                  onCanvasToolChange={setV3CanvasTool}
                />
            ) : decoded && !error ? (
              <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-lr-text-faint" role="status">
                Preparing editor…
              </div>
            ) : null}
          </div>

          <EntryMetadataBar
            entryId={entry.id}
            metadata={metadata}
            onPick={() => applyMetadataToEntries(selectionTargets, { pick: "pick" })}
            onReject={() => applyMetadataToEntries(selectionTargets, { pick: "reject" })}
            onClearPick={() => applyMetadataToEntries(selectionTargets, { pick: "none" })}
            onRating={(rating) => applyMetadataToEntries(selectionTargets, { rating })}
            onColorLabel={(label) => {
              const current = metadata.colorLabel;
              applyMetadataToEntries(selectionTargets, {
                colorLabel:
                  selectionTargets.length === 1 && current === label
                    ? null
                    : label,
              });
            }}
          />
          </div>

          {decoded ? (
            <DevelopSidePanels
              decoded={decoded}
              entry={entry}
              resultId={resultId}
              resultCatalogRevision={resultCatalogRevision}
              resultEntryIds={resultEntryIds}
              missingEntryIds={missingEntryIds}
              resultEntries={entries}
              v3Analysis={v3Analysis}
              v3RenderDiagnostics={v3RenderDiagnostics}
              v3CanvasTool={v3CanvasTool}
              onV3CanvasToolChange={setV3CanvasTool}
              activePanel={activePanel}
              onSelect={selectDevelopPanel}
            />
          ) : null}
        </div>

        {currentStack ? (
          <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-t border-lr-border-subtle bg-lr-panel px-3" aria-label="Stack members">
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-lr-text-faint">Stack {currentStack.entryIds.length}</span>
            {currentStack.entryIds.map((entryId, index) => {
              const member = entries.find((item) => item.id === entryId);
              if (!member) return null;
              return (
                <div key={entryId} className={`flex shrink-0 items-center rounded border ${entryId === entry.id ? "border-lr-accent bg-lr-selection" : "border-lr-border-subtle"}`}>
                  <button type="button" onClick={() => selectPhoto(entryId)} className="max-w-32 truncate px-2 py-1 text-[10px] text-lr-text-muted">{member.name}</button>
                  <button type="button" disabled={index === 0} onClick={() => reorderStackEntry(currentStack.id, entryId, -1)} aria-label={`Move ${member.name} earlier`} className="px-1 text-[10px] text-lr-text-faint disabled:opacity-30">←</button>
                  <button type="button" disabled={index === currentStack.entryIds.length - 1} onClick={() => reorderStackEntry(currentStack.id, entryId, 1)} aria-label={`Move ${member.name} later`} className="px-1 text-[10px] text-lr-text-faint disabled:opacity-30">→</button>
                  <button type="button" onClick={() => setStackCover(currentStack.id, entryId)} aria-label={`Use ${member.name} as stack cover`} className={`px-1 text-[10px] ${currentStack.coverEntryId === entryId ? "text-lr-accent" : "text-lr-text-faint"}`}>◆</button>
                  <button type="button" onClick={() => removeEntriesFromStack(currentStack.id, [entryId])} aria-label={`Remove ${member.name} from stack`} className="px-1.5 text-[10px] text-lr-text-faint hover:text-lr-danger">×</button>
                </div>
              );
            })}
          </div>
        ) : null}

        <Filmstrip
          entries={entries}
          orderedEntryIds={resultEntryIds}
          missingEntryIds={missingEntryIds}
          activeId={entry.id}
          selectedIds={selectedEntryIds}
          onSelect={selectPhoto}
        />
      </div>
      {exportOpen ? (
        <ExportDialog
          entries={entries.filter((item) => selectionTargets.includes(item.id))}
          onClose={() => setExportOpen(false)}
        />
      ) : null}
    </div>
  );
}
