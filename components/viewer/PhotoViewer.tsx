"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  DevelopCanvas,
  type CropPreviewTransform,
} from "@/components/develop/DevelopCanvas";
import type { BrushSettings } from "@/components/develop/MaskingOverlay";
import { sourceSignatureForEntry } from "@/lib/develop/source-transform";
import { DevelopSidePanels } from "@/components/develop/DevelopSidePanels";
import { AiMaskActions } from "@/components/develop/AiMaskActions";
import type {
  MaskOverlayMode,
  RenderDiagnostic,
} from "@/lib/develop/renderer";
import type { DevelopPanelId } from "@/components/develop/DevelopPanelRail";
import type { MaskTool } from "@/components/develop/MaskingPanel";
import { useDevelopSettingsSync } from "@/components/develop/useDevelopSettingsSync";
import { DEFAULT_CROP_SETTINGS } from "@/lib/develop/plugins/crop";
import { DEFAULT_DEVELOP_SETTINGS } from "@/lib/develop/registry";
import { captureBrushStrokeSettings, createDefaultDevelopDocument } from "@/lib/develop/document";
import type { CropSettings } from "@/lib/develop/types";
import { fitCropWithinRotation } from "@/lib/develop/crop-geometry";
import { estimateStraightenAngle } from "@/lib/develop/auto-straighten";
import { useDevelopStore } from "@/stores/develop-store";
import { ExportDialog } from "@/components/export/ExportDialog";
import { Filmstrip } from "./Filmstrip";
import { useEntryMetadataShortcuts } from "@/hooks/useEntryMetadataShortcuts";
import { isEditableTarget } from "@/hooks/is-editable-target";
import { updateViewerSessionActive, viewerPhotoHref } from "@/lib/viewer/session";
import { readReferenceEntryId, writeReferenceEntryId } from "@/lib/viewer/reference";
import { ViewerSurface, type ViewerSurfaceMode } from "./ViewerSurface";

interface PhotoViewerProps {
  entry: LibraryEntry;
  entries: LibraryEntry[];
  resultId: string;
  resultEntryIds: readonly string[];
  missingEntryIds: readonly string[];
  sessionMessage: string | null;
  onRefreshResult: () => void;
}

const MASK_CANVAS_TOOLS: Array<{
  id: MaskTool;
  label: string;
  shortcut: string;
}> = [
  { id: "none", label: "Select", shortcut: "Esc" },
  { id: "brush", label: "Brush", shortcut: "K" },
  { id: "linear-gradient", label: "Linear", shortcut: "M" },
  { id: "radial-gradient", label: "Radial", shortcut: "⇧M" },
];

const MASK_BRUSH_SETTINGS: Array<{
  key: keyof BrushSettings;
  label: string;
}> = [
  { key: "size", label: "Size" },
  { key: "feather", label: "Feather" },
  { key: "flow", label: "Flow" },
  { key: "density", label: "Density" },
];

const RANGE_ADJUSTMENT_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);
const DEFAULT_DEVELOP_DOCUMENT = createDefaultDevelopDocument();

function MaskBrushSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const beginEditGroup = useDevelopStore((state) => state.beginEditGroup);
  const endEditGroup = useDevelopStore((state) => state.endEditGroup);

  return (
    <label className="flex shrink-0 items-center gap-1.5 text-[10px] text-lr-text-muted">
      <span>{label}</span>
      <input
        type="range"
        aria-label={`Brush ${label}`}
        min={0}
        max={1}
        step={0.01}
        value={value}
        onPointerDown={() => beginEditGroup(`Adjust brush ${label.toLowerCase()}`)}
        onPointerUp={endEditGroup}
        onPointerCancel={endEditGroup}
        onBlur={endEditGroup}
        onKeyDown={(event) => {
          if (RANGE_ADJUSTMENT_KEYS.has(event.key)) {
            beginEditGroup(`Adjust brush ${label.toLowerCase()}`);
          }
        }}
        onKeyUp={(event) => {
          if (RANGE_ADJUSTMENT_KEYS.has(event.key)) endEditGroup();
        }}
        onChange={(event) => onChange(Number(event.target.value))}
        className="develop-slider w-16"
      />
      <span className="w-6 text-right font-mono text-[9px] text-lr-text-faint">
        {Math.round(value * 100)}
      </span>
    </label>
  );
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
  const [cropDraft, setCropDraft] = useState<CropSettings | null>(null);
  const cropDraftRef = useRef<CropSettings | null>(null);
  const [cropImageOffset, setCropImageOffset] = useState({ x: 0, y: 0 });
  const [cropPreviewTransform, setCropPreviewTransform] =
    useState<CropPreviewTransform>({ scale: 1, x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoStraightening, setAutoStraightening] = useState(false);
  const [maskOverlayMode, setMaskOverlayMode] = useState<MaskOverlayMode>("color");
  const [maskBrushSettings, setMaskBrushSettings] = useState<BrushSettings>({
    size: 0.08,
    feather: 0.5,
    flow: 1,
    density: 1,
  });
  const [renderDiagnostics, setRenderDiagnostics] = useState<readonly RenderDiagnostic[]>([]);
  const [surfaceMode, setSurfaceMode] = useState<"single" | ViewerSurfaceMode>("single");
  const [linkedViewports, setLinkedViewports] = useState(true);
  const [referenceEntryId, setReferenceEntryId] = useState<string | null>(() => readReferenceEntryId(entry.catalogId));
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
  const developSettings = useDevelopStore(
    (state) => state.sessions[entry.id]?.document.settings ?? DEFAULT_DEVELOP_SETTINGS,
  );
  const developDocument = useDevelopStore(
    (state) => state.sessions[entry.id]?.document ?? DEFAULT_DEVELOP_DOCUMENT,
  );
  const developProcessKind = useDevelopStore(
    (state) => state.sessions[entry.id]?.processKind ?? "v2",
  );
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const resetAll = useDevelopStore((state) => state.resetAll);
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
  const dispatchDevelop = useDevelopStore((state) => state.dispatch);
  const [exportOpen, setExportOpen] = useState(false);
  const sourceSignature = useMemo(
    () => sourceSignatureForEntry(entry),
    [entry],
  );
  const onRenderDiagnostics = useCallback((next: readonly RenderDiagnostic[]) => {
    setRenderDiagnostics(next);
  }, []);
  const selectedMask = developSettings.masking.masks.find(
    (mask) => mask.id === maskUi?.selectedMaskId,
  );
  const selectedMaskComponent = selectedMask?.components.find(
    (component) => component.id === maskUi?.selectedComponentId,
  );
  const selectedBrush = selectedMaskComponent?.kind === "brush"
    ? selectedMaskComponent
    : null;
  const footerBrushSettings = selectedBrush ?? maskBrushSettings;
  const showBrushSettings = maskUi?.tool === "brush" || selectedBrush !== null;
  const cropWidth = decoded && cropDraft
    ? Math.max(1, Math.round(decoded.width * cropDraft.width))
    : null;
  const cropHeight = decoded && cropDraft
    ? Math.max(1, Math.round(decoded.height * cropDraft.height))
    : null;
  const captureDetails = decoded ? captureSummary(decoded.metadata) : [];
  const currentStack = stacks.find((stack) => stack.entryIds.includes(entry.id));
  const referenceEntry = entries.find((item) => item.id === referenceEntryId) ?? null;

  function setReference(id: string | null) {
    setReferenceEntryId(id);
    writeReferenceEntryId(entry.catalogId, id);
  }

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
      setRenderDiagnostics([]);

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

  const discardCrop = useCallback((nextPanel: DevelopPanelId | null = "edit") => {
    cropDraftRef.current = null;
    setCropDraft(null);
    setCropImageOffset({ x: 0, y: 0 });
    setCropPreviewTransform({ scale: 1, x: 0, y: 0 });
    setActivePanel(nextPanel);
  }, []);

  const selectSurfaceMode = useCallback((mode: "single" | ViewerSurfaceMode) => {
    setSurfaceMode(mode);
    if (mode !== "single") {
      discardCrop("edit");
      setMaskTool("none");
    }
  }, [discardCrop, setMaskTool]);

  const applyCrop = useCallback(() => {
    const draft = cropDraftRef.current;
    if (draft) {
      updatePlugin("crop", draft);
    }
    discardCrop("edit");
  }, [discardCrop, updatePlugin]);

  function changeCrop(next: CropSettings, preserveFrame = false) {
    const current = cropDraftRef.current;
    const boundedRect = decoded
      ? fitCropWithinRotation(next, next.angle, decoded.width, decoded.height)
      : next;
    const bounded = { ...next, ...boundedRect };
    if (preserveFrame && current) {
      setCropImageOffset((offset) => ({
        x: offset.x + current.x - bounded.x,
        y: offset.y + current.y - bounded.y,
      }));
    }
    cropDraftRef.current = bounded;
    setCropDraft(bounded);
  }

  function autoStraighten() {
    if (!decoded || autoStraightening) return;
    setAutoStraightening(true);
    window.requestAnimationFrame(() => {
      const draft = cropDraftRef.current;
      if (draft) {
        changeCrop({ ...draft, angle: estimateStraightenAngle(decoded) });
      }
      setAutoStraightening(false);
    });
  }

  function updateBrushSetting(
    key: keyof BrushSettings,
    value: number,
  ) {
    const nextSettings = { ...footerBrushSettings, [key]: value };
    setMaskBrushSettings(nextSettings);
    if (!selectedMask || !selectedBrush) return;
    dispatchDevelop({
      kind: "replace-mask-component",
      maskId: selectedMask.id,
      component: {
        ...captureBrushStrokeSettings(selectedBrush),
        ...nextSettings,
      },
    }, `Adjust brush ${key}`);
  }

  function resetCrop() {
    const next = { ...DEFAULT_CROP_SETTINGS, enabled: true };
    cropDraftRef.current = next;
    setCropDraft(next);
    setCropImageOffset({ x: 0, y: 0 });
    setCropPreviewTransform({ scale: 1, x: 0, y: 0 });
  }

  function selectDevelopPanel(panel: DevelopPanelId) {
    if (developProcessKind !== "v2") {
      cropDraftRef.current = null;
      setCropDraft(null);
      setMaskTool("none");
      setActivePanel((current) => current === panel ? "edit" : panel);
      return;
    }
    if (activePanel === "crop") {
      discardCrop(panel === "crop" ? "edit" : panel);
      return;
    }
    if (panel === "crop") {
      setMaskTool("none");
      const draft = { ...developSettings.crop, enabled: true };
      cropDraftRef.current = draft;
      setCropDraft(draft);
      setCropImageOffset({ x: 0, y: 0 });
      setCropPreviewTransform({ scale: 1, x: 0, y: 0 });
      setActivePanel("crop");
      return;
    }
    if (panel === "info") {
      setMaskTool("none");
      setActivePanel((current) => (current === "info" ? "edit" : "info"));
      return;
    }
    if (panel === "masking") {
      if (activePanel === "masking") {
        setMaskTool("none");
        setActivePanel("edit");
      } else {
        setActivePanel("masking");
      }
      return;
    }
    setMaskTool("none");
    setActivePanel("edit");
  }

  function resetAllDevelopSettings() {
    resetAll();
    discardCrop("edit");
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
      discardCrop("edit");

      const nextActiveId =
        removing && id === entry.id ? remaining.at(-1) : removing ? entry.id : id;
      if (nextActiveId && nextActiveId !== entry.id) {
        router.push(viewerPhotoHref(nextActiveId, resultId));
      }
    },
    [
      discardCrop,
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
      if (developProcessKind === "v2" && activePanel === "crop" && cropDraftRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          discardCrop("edit");
          return;
        }
        if (event.key === "Enter" && !interactiveTarget) {
          event.preventDefault();
          applyCrop();
          return;
        }
      }
      if (isEditableTarget(event.target) || interactiveTarget) {
        return;
      }
      const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (plainKey && event.key.toLowerCase() === "y") {
        event.preventDefault();
        selectSurfaceMode(surfaceMode === "before-side" ? "single" : "before-side");
        return;
      }
      if (plainKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        selectSurfaceMode(surfaceMode === "reference" ? "single" : "reference");
        return;
      }
      if (plainKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setMaskOverlayVisible(!(maskUi?.overlayVisible ?? false));
        return;
      }
      if (developProcessKind === "v2" && activePanel === "masking" && plainKey) {
        if (event.key === "Enter") {
          event.preventDefault();
          setMaskTool("none");
          setActivePanel("edit");
          return;
        }
        const key = event.key.toLowerCase();
        if (key === "k" || key === "m") {
          event.preventDefault();
          setMaskOverlayVisible(true);
          setMaskTool(key === "k" ? "brush" : event.shiftKey ? "radial-gradient" : "linear-gradient");
          return;
        }
        if ((event.key === "Delete" || event.key === "Backspace") && !event.repeat) {
          const state = useDevelopStore.getState();
          const session = state.sessions[entry.id];
          const masks = session?.document.settings.masking.masks ?? [];
          const index = masks.findIndex((mask) => mask.id === session?.ui.selectedMaskId);
          const selectedMask = masks[index];
          if (!selectedMask) return;
          event.preventDefault();
          const next = masks[index + 1] ?? masks[index - 1] ?? null;
          state.dispatch({ kind: "remove-mask", maskId: selectedMask.id }, "Delete mask");
          state.setSelectedMask(next?.id ?? null);
          state.setSelectedComponent(next?.components[0]?.id ?? null);
          state.setMaskTool("none");
          return;
        }
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
        if (maskUi?.tool !== "none") {
          event.preventDefault();
          setMaskTool("none");
          return;
        }
        router.push("/");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    adjacentEntry,
    entry.id,
    activeIndex,
    router,
    activePanel,
    applyCrop,
    discardCrop,
    exportOpen,
    selectPhoto,
    redo,
    undo,
    maskUi?.overlayVisible,
    setMaskOverlayVisible,
    maskUi?.tool,
    setMaskTool,
    selectSurfaceMode,
    surfaceMode,
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
              activePanel === "crop" || activePanel === "masking"
                ? "bg-lr-selection"
                : "border border-lr-border-subtle",
            ].join(" ")}>
              {activePanel === "crop"
                ? "CROP"
                : activePanel === "masking"
                  ? "MASKING"
                  : fileType(entry.name)}
            </span>
            <span className="truncate font-mono text-[11px] text-lr-text-muted">
              {activePanel === "crop" && cropWidth && cropHeight && decoded
                ? `${cropWidth} × ${cropHeight} · from ${decoded.width} × ${decoded.height}`
                : activePanel === "masking"
                  ? `${developSettings.masking.masks.length} ${developSettings.masking.masks.length === 1 ? "mask" : "masks"}${selectedMask ? ` · ${selectedMask.name}` : ""}`
                  : decoded
                    ? [`${decoded.width} × ${decoded.height}`, ...captureDetails].join(" · ")
                : loading
                  ? "Preparing preview…"
                  : "Preview unavailable"}
            </span>
            <div className="flex-1" />
            {activePanel !== "crop" && activePanel !== "masking" ? (
              <div className="flex items-center gap-0.5 rounded-lg border border-lr-border-subtle bg-lr-panel-raised p-0.5">
                <button type="button" onClick={() => selectSurfaceMode(surfaceMode === "before-side" ? "single" : "before-side")} aria-pressed={surfaceMode === "before-side"} className={`rounded-md px-2 py-1.5 text-[10px] ${surfaceMode === "before-side" ? "bg-lr-selection text-lr-accent" : "text-lr-text-muted hover:text-lr-text"}`}>B/A · Y</button>
                <button type="button" onClick={() => selectSurfaceMode(surfaceMode === "before-split" ? "single" : "before-split")} aria-pressed={surfaceMode === "before-split"} className={`rounded-md px-2 py-1.5 text-[10px] ${surfaceMode === "before-split" ? "bg-lr-selection text-lr-accent" : "text-lr-text-muted hover:text-lr-text"}`}>Split</button>
                <button type="button" onClick={() => selectSurfaceMode(surfaceMode === "reference" ? "single" : "reference")} aria-pressed={surfaceMode === "reference"} className={`rounded-md px-2 py-1.5 text-[10px] ${surfaceMode === "reference" ? "bg-lr-selection text-lr-accent" : "text-lr-text-muted hover:text-lr-text"}`}>Reference · R</button>
              </div>
            ) : null}
            {surfaceMode !== "single" ? (
              <button type="button" onClick={() => setLinkedViewports((value) => !value)} aria-pressed={linkedViewports} className={`h-8 rounded-md border px-2 text-[10px] ${linkedViewports ? "border-lr-accent/40 text-lr-accent" : "border-lr-border-subtle text-lr-text-muted"}`}>{linkedViewports ? "Linked" : "Independent"}</button>
            ) : null}
            {surfaceMode === "reference" ? (
              <>
                <button type="button" onClick={() => setReference(entry.id)} className="h-8 rounded-md border border-lr-border-subtle px-2 text-[10px] text-lr-text-muted">Set active as reference</button>
                {referenceEntry ? <button type="button" onClick={() => { const previous = entry.id; selectPhoto(referenceEntry.id); setReference(previous); }} className="h-8 rounded-md border border-lr-border-subtle px-2 text-[10px] text-lr-text-muted">Make reference active</button> : null}
                {referenceEntryId ? <button type="button" onClick={() => setReference(null)} className="h-8 rounded-md border border-lr-border-subtle px-2 text-[10px] text-lr-text-muted">Clear</button> : null}
              </>
            ) : null}
            {activePanel === "masking" ? (
              <>
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-faint">
                  Overlay
                </span>
                <div className="flex gap-0.5 rounded-lg border border-lr-border-subtle bg-lr-panel-raised p-0.5">
                  {(["color", "white", "image"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setMaskOverlayMode(mode);
                        setMaskOverlayVisible(true);
                      }}
                      aria-pressed={maskOverlayMode === mode}
                      className={[
                        "rounded-md px-2.5 py-1.5 text-[11px] capitalize",
                        maskOverlayMode === mode
                          ? "bg-lr-selection text-lr-accent"
                          : "text-lr-text-muted hover:text-lr-text",
                      ].join(" ")}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
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
            ) : activePanel !== "crop" ? (
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

          <div className={[
            "relative min-h-0 flex-1",
            developProcessKind === "v2" && activePanel === "crop"
              ? "p-[34px]"
              : developProcessKind === "v2" && activePanel === "masking"
                ? "p-7"
                : surfaceMode === "single" ? "p-8" : "p-0",
          ].join(" ")}>
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

            {decoded ? (
              surfaceMode === "single" ? <DevelopCanvas
                image={decoded}
                alt={entry.name}
                sourceSignature={sourceSignature}
                cropActive={developProcessKind === "v2" && activePanel === "crop"}
                cropDraft={developProcessKind === "v2" ? cropDraft : null}
                cropImageOffset={cropImageOffset}
                previewTransform={cropPreviewTransform}
                onCropChange={changeCrop}
                onPreviewTransformChange={setCropPreviewTransform}
                overlayMaskId={developProcessKind === "v2" && activePanel === "masking" && maskUi?.overlayVisible ? maskUi.selectedMaskId : null}
                overlayMode={maskOverlayMode}
                onRenderDiagnostics={onRenderDiagnostics}
                maskingActive={developProcessKind === "v2" && activePanel === "masking"}
                brushSettings={maskBrushSettings}
                onBrushSettingsChange={setMaskBrushSettings}
              /> : <ViewerSurface mode={surfaceMode} entry={entry} image={decoded} document={developDocument} referenceEntry={referenceEntry} linked={linkedViewports} />
            ) : null}
          </div>

          {developProcessKind === "v2" && activePanel === "crop" && cropDraft ? (
            <div className="flex h-[76px] shrink-0 items-center gap-4 border-t border-lr-border-subtle bg-lr-toolbar px-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-faint">
                    Straighten
                  </span>
                  <span className="font-mono text-xs text-lr-accent">
                    {cropDraft.angle > 0 ? "+" : ""}{cropDraft.angle.toFixed(1)}°
                  </span>
                  <button
                    type="button"
                    onClick={() => changeCrop({ ...cropDraft, angle: 0 })}
                    className="text-[10px] text-lr-text-faint hover:text-lr-text"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    disabled={!decoded || autoStraightening}
                    onClick={autoStraighten}
                    className="rounded border border-lr-border-subtle px-2 py-1 text-[10px] text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text disabled:opacity-40"
                  >
                    {autoStraightening ? "Analyzing…" : "Auto"}
                  </button>
                </div>
                <input
                  type="range"
                  aria-label="Straighten"
                  min={-45}
                  max={45}
                  step={0.1}
                  value={cropDraft.angle}
                  onChange={(event) => changeCrop({ ...cropDraft, angle: Number(event.target.value) })}
                  className="develop-slider"
                />
              </div>
              <button type="button" onClick={resetCrop} className="h-9 rounded-lg border border-lr-border-subtle px-3.5 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text">
                Reset crop
              </button>
              <button type="button" onClick={() => discardCrop("edit")} className="h-9 rounded-lg border border-lr-border-subtle px-3.5 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text">
                Cancel
              </button>
              <button type="button" onClick={applyCrop} className="h-9 rounded-lg bg-lr-accent px-4 text-xs font-medium text-[#14202a] hover:bg-lr-accent-hover">
                Done · ↵
              </button>
            </div>
          ) : developProcessKind === "v2" && activePanel === "masking" ? (
            <div className={[
              "shrink-0 border-t border-lr-border-subtle bg-lr-toolbar px-4",
              showBrushSettings
                ? "flex h-[78px] flex-wrap items-center gap-x-2.5 gap-y-1 overflow-hidden py-1.5"
                : "flex h-[52px] items-center gap-2.5",
            ].join(" ")}>
              <div className="flex gap-0.5 rounded-lg border border-lr-border-subtle bg-lr-panel-raised p-0.5">
                {(["add", "subtract"] as const).map((operation) => {
                  const first = selectedMask?.components[0]?.id === selectedMaskComponent?.id;
                  return (
                    <button
                      key={operation}
                      type="button"
                      disabled={!selectedMask || !selectedMaskComponent || (first && operation === "subtract")}
                      onClick={() => {
                        if (!selectedMask || !selectedMaskComponent) return;
                        dispatchDevelop({
                          kind: "set-mask-component-operation",
                          maskId: selectedMask.id,
                          componentId: selectedMaskComponent.id,
                          operation,
                        }, operation === "add" ? "Add component" : "Subtract component");
                      }}
                      aria-pressed={selectedMaskComponent?.operation === operation}
                      className={[
                        "rounded-md px-3 py-1.5 text-[11px] capitalize disabled:opacity-35",
                        selectedMaskComponent?.operation === operation
                          ? "bg-lr-selection text-lr-accent"
                          : "text-lr-text-muted hover:text-lr-text",
                      ].join(" ")}
                    >
                      {operation}
                    </button>
                  );
                })}
              </div>
              <span className="h-5 w-px bg-lr-border-subtle" />
              <div className="flex gap-0.5 rounded-lg border border-lr-border-subtle bg-lr-panel-raised p-0.5">
                {MASK_CANVAS_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => {
                      setMaskTool(tool.id);
                      if (tool.id !== "none") setMaskOverlayVisible(true);
                    }}
                    aria-pressed={(maskUi?.tool ?? "none") === tool.id}
                    className={[
                      "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px]",
                      (maskUi?.tool ?? "none") === tool.id
                        ? "bg-lr-selection text-lr-accent"
                        : "text-lr-text-muted hover:text-lr-text",
                    ].join(" ")}
                  >
                    {tool.label}
                    <span className="font-mono text-[9px] text-lr-text-faint">{tool.shortcut}</span>
                  </button>
                ))}
              </div>
              {showBrushSettings ? (
                <div className="order-last flex h-7 w-full min-w-0 items-center gap-4 overflow-x-auto border-t border-lr-border-subtle pt-1">
                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.1em] text-lr-text-faint">
                    Brush
                  </span>
                  {MASK_BRUSH_SETTINGS.map((setting) => (
                    <MaskBrushSlider
                      key={setting.key}
                      label={setting.label}
                      value={footerBrushSettings[setting.key]}
                      onChange={(value) => updateBrushSetting(setting.key, value)}
                    />
                  ))}
                </div>
              ) : (
                <>
                  <div className="flex-1" />
                  <span className="font-mono text-[10px] text-lr-text-faint">
                    O overlay · Delete mask
                  </span>
                </>
              )}
            </div>
          ) : (
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
          )}
          </div>

          {decoded ? (
            <DevelopSidePanels
              decoded={decoded}
              entry={entry}
              activePanel={activePanel}
              cropDraft={cropDraft}
              onSelect={selectDevelopPanel}
              onResetAll={resetAllDevelopSettings}
              onCropChange={changeCrop}
              onCropReset={resetCrop}
              maskingAiActions={
                <AiMaskActions
                  entry={entry}
                  sourceSignature={sourceSignature}
                  diagnostics={renderDiagnostics}
                />
              }
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
          referenceId={referenceEntryId}
          onSetReference={setReference}
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
