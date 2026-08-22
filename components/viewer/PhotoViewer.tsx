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
import { captureBrushStrokeSettings } from "@/lib/develop/document";
import type { CropSettings } from "@/lib/develop/types";
import { fitCropWithinRotation } from "@/lib/develop/crop-geometry";
import { estimateStraightenAngle } from "@/lib/develop/auto-straighten";
import { useDevelopStore } from "@/stores/develop-store";
import { ExportDialog } from "@/components/export/ExportDialog";
import { Filmstrip } from "./Filmstrip";
import { useEntryMetadataShortcuts } from "@/hooks/useEntryMetadataShortcuts";
import { isEditableTarget } from "@/hooks/is-editable-target";

interface PhotoViewerProps {
  entry: LibraryEntry;
  entries: LibraryEntry[];
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

export function PhotoViewer({ entry, entries }: PhotoViewerProps) {
  const router = useRouter();
  const setSelectedEntryId = useLibraryStore((state) => state.setSelectedEntryId);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const selectEntry = useLibraryStore((state) => state.selectEntry);
  const rootPath = useLibraryStore((state) => state.rootPath);
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
  const activeIndex = useMemo(
    () => entries.findIndex((item) => item.id === entry.id),
    [entries, entry.id],
  );
  const visibleOrder = useMemo(() => entries.map((item) => item.id), [entries]);
  const selectionTargets = useMemo(
    () =>
      selectedEntryIds.length > 0 && selectedEntryIds.includes(entry.id)
        ? selectedEntryIds
        : [entry.id],
    [entry.id, selectedEntryIds],
  );
  const mirrorDevelopDocument = useLibraryStore((state) => state.mirrorDevelopDocument);
  const hydrateEntryMetadata = useLibraryStore((state) => state.hydrateEntryMetadata);
  const mirrorDocument = useCallback(
    (
      document: Parameters<typeof mirrorDevelopDocument>[1],
      sourceUpdatedAt?: Parameters<typeof mirrorDevelopDocument>[2],
      metadataPatch?: Parameters<typeof mirrorDevelopDocument>[3],
    ) => mirrorDevelopDocument(entry.id, document, sourceUpdatedAt, metadataPatch),
    [entry.id, mirrorDevelopDocument],
  );
  const hydrateMetadata = useCallback(
    (
      patch: Parameters<typeof hydrateEntryMetadata>[1],
      sourceUpdatedAt: Parameters<typeof hydrateEntryMetadata>[2],
    ) => hydrateEntryMetadata(entry.id, patch, sourceUpdatedAt),
    [entry.id, hydrateEntryMetadata],
  );

  useDevelopSettingsSync({
    entry,
    rootPath,
    metadata,
    mirrorDocument,
    hydrateMetadata,
  });
  const developSettings = useDevelopStore(
    (state) => state.sessions[entry.id]?.document.settings ?? DEFAULT_DEVELOP_SETTINGS,
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

  useEffect(() => {
    if (!useLibraryStore.getState().selectedEntryIds.includes(entry.id)) {
      setSelectedEntryId(entry.id);
    }
  }, [entry.id, setSelectedEntryId]);

  useEffect(() => {
    let active = true;

    async function loadImage() {
      setLoading(true);
      setError(null);
      setDecoded(null);
      setRenderDiagnostics([]);

      try {
        const result = await loadDevelopImage(entry);
        if (!active) {
          return;
        }
        setDecoded(result);
        preloadDevelopImages(entries, activeIndex);
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
  }, [entry, entries, activeIndex]);

  useEntryMetadataShortcuts(selectionTargets, exportOpen);

  const discardCrop = useCallback((nextPanel: DevelopPanelId | null = "edit") => {
    cropDraftRef.current = null;
    setCropDraft(null);
    setCropImageOffset({ x: 0, y: 0 });
    setCropPreviewTransform({ scale: 1, x: 0, y: 0 });
    setActivePanel(nextPanel);
  }, []);

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
        router.push(`/photo?id=${encodeURIComponent(nextActiveId)}`);
      }
    },
    [
      discardCrop,
      entry.id,
      router,
      selectEntry,
      selectedEntryIds,
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
      if (activePanel === "crop" && cropDraftRef.current) {
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
      if (plainKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setMaskOverlayVisible(!(maskUi?.overlayVisible ?? false));
        return;
      }
      if (activePanel === "masking" && plainKey) {
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
      if (event.key === "ArrowLeft" && activeIndex > 0) {
        event.preventDefault();
        selectPhoto(entries[activeIndex - 1].id, {
          shift: event.shiftKey,
        });
      }
      if (
        event.key === "ArrowRight" &&
        activeIndex >= 0 &&
        activeIndex < entries.length - 1
      ) {
        event.preventDefault();
        selectPhoto(entries[activeIndex + 1].id, {
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
    entries,
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
  ]);

  return (
    <div className="flex h-screen overflow-hidden bg-lr-toolbar">
      <ModuleSpine activeModule="develop" developPhotoId={entry.id} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col bg-[#131110]">
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
            activePanel === "crop"
              ? "p-[34px]"
              : activePanel === "masking"
                ? "p-7"
                : "p-8",
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
              <DevelopCanvas
                image={decoded}
                alt={entry.name}
                sourceSignature={sourceSignature}
                cropActive={activePanel === "crop"}
                cropDraft={cropDraft}
                cropImageOffset={cropImageOffset}
                previewTransform={cropPreviewTransform}
                onCropChange={changeCrop}
                onPreviewTransformChange={setCropPreviewTransform}
                overlayMaskId={activePanel === "masking" && maskUi?.overlayVisible ? maskUi.selectedMaskId : null}
                overlayMode={maskOverlayMode}
                onRenderDiagnostics={onRenderDiagnostics}
                maskingActive={activePanel === "masking"}
                brushSettings={maskBrushSettings}
                onBrushSettingsChange={setMaskBrushSettings}
              />
            ) : null}
          </div>

          {activePanel === "crop" && cropDraft ? (
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
          ) : activePanel === "masking" ? (
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

        <Filmstrip
          entries={entries}
          activeId={entry.id}
          selectedIds={selectionTargets}
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
