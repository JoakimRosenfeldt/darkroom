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
import { DevelopSidePanels } from "@/components/develop/DevelopSidePanels";
import type { DevelopPanelId } from "@/components/develop/DevelopPanelRail";
import { useDevelopSettingsSync } from "@/components/develop/useDevelopSettingsSync";
import { DEFAULT_CROP_SETTINGS } from "@/lib/develop/plugins/crop";
import type { CropSettings } from "@/lib/develop/types";
import { useDevelopStore } from "@/stores/develop-store";
import { ExportDialog } from "@/components/export/ExportDialog";
import { Filmstrip } from "./Filmstrip";
import { useEntryMetadataShortcuts } from "@/hooks/useEntryMetadataShortcuts";
import { isEditableTarget } from "@/hooks/is-editable-target";

interface PhotoViewerProps {
  entry: LibraryEntry;
  entries: LibraryEntry[];
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
  const applyDevelopMetadata = useCallback(
    (patch: Parameters<typeof applyMetadataToEntries>[1]) => {
      applyMetadataToEntries([entry.id], patch);
    },
    [applyMetadataToEntries, entry.id],
  );

  useDevelopSettingsSync({
    entry,
    rootPath,
    metadata,
    applyMetadata: applyDevelopMetadata,
  });
  const developSettings = useDevelopStore((state) => state.settings);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const resetAll = useDevelopStore((state) => state.resetAll);
  const [exportOpen, setExportOpen] = useState(false);

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
    if (preserveFrame && current) {
      setCropImageOffset((offset) => ({
        x: offset.x + current.x - next.x,
        y: offset.y + current.y - next.y,
      }));
    }
    cropDraftRef.current = next;
    setCropDraft(next);
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
      const draft = { ...developSettings.crop, enabled: true };
      cropDraftRef.current = draft;
      setCropDraft(draft);
      setCropImageOffset({ x: 0, y: 0 });
      setCropPreviewTransform({ scale: 1, x: 0, y: 0 });
      setActivePanel("crop");
      return;
    }
    if (panel === "info") {
      setActivePanel((current) => (current === "info" ? "edit" : "info"));
      return;
    }
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
      if (activePanel === "crop" && cropDraftRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          discardCrop("edit");
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          applyCrop();
          return;
        }
      }
      if (isEditableTarget(event.target)) {
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
        router.push("/");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    entries,
    activeIndex,
    router,
    activePanel,
    applyCrop,
    discardCrop,
    exportOpen,
    selectPhoto,
  ]);

  return (
    <div className="flex h-screen overflow-hidden bg-lr-toolbar">
      <ModuleSpine activeModule="develop" developPhotoId={entry.id} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col bg-lr-canvas">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-lr-border-subtle bg-lr-toolbar px-4">
            <span className="font-mono text-xs text-lr-text">{entry.name}</span>
            <span className="rounded-md border border-lr-border-subtle px-1.5 py-0.5 font-mono text-[10px] text-lr-accent">
              {entry.profileId?.toUpperCase() ?? "PHOTO"}
            </span>
            <span className="truncate font-mono text-[11px] text-lr-text-muted">
              {decoded
                ? `${decoded.width} × ${decoded.height}`
                : loading
                  ? "Preparing preview…"
                  : "Preview unavailable"}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              className="h-8 rounded-lg bg-lr-accent px-3.5 text-xs font-medium text-[#14202a] transition hover:bg-lr-accent-hover"
            >
              Export{selectionTargets.length > 1 ? ` ${selectionTargets.length}` : ""}…
            </button>
          </div>

          <div className="relative min-h-0 flex-1">
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
                cropActive={activePanel === "crop"}
                cropDraft={cropDraft}
                cropImageOffset={cropImageOffset}
                previewTransform={cropPreviewTransform}
                onCropChange={changeCrop}
                onPreviewTransformChange={setCropPreviewTransform}
              />
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
              activePanel={activePanel}
              cropDraft={cropDraft}
              onSelect={selectDevelopPanel}
              onResetAll={resetAllDevelopSettings}
              onCropChange={changeCrop}
              onCropReset={resetCrop}
              onCropApply={applyCrop}
              onCropCancel={() => discardCrop("edit")}
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
