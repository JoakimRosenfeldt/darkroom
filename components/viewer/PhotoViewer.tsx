"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import { getDarkroomAPI } from "@/lib/fs/platform";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  loadDevelopExportImage,
  loadDevelopImage,
  preloadDevelopImages,
} from "@/lib/cache/develop-image-cache";
import { TopBar } from "@/components/shell/TopBar";
import {
  EntryMetadataBar,
  useEntryMetadataForId,
} from "@/components/library/EntryMetadataBar";
import { useLibraryStore } from "@/stores/library-store";
import {
  DevelopCanvas,
  type DevelopCanvasHandle,
} from "@/components/develop/DevelopCanvas";
import { DevelopSidePanels } from "@/components/develop/DevelopSidePanels";
import { useDevelopSettingsSync } from "@/components/develop/useDevelopSettingsSync";
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
  const rootPath = useLibraryStore((state) => state.rootPath);
  const applyMetadataToEntries = useLibraryStore(
    (state) => state.applyMetadataToEntries,
  );
  const metadata = useEntryMetadataForId(entry.id);
  const [decoded, setDecoded] = useState<DevelopImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const activeIndex = useMemo(
    () => entries.findIndex((item) => item.id === entry.id),
    [entries, entry.id],
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
  const canvasRef = useRef<DevelopCanvasHandle>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  useEffect(() => {
    setSelectedEntryId(entry.id);
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

  useEntryMetadataShortcuts([entry.id]);

  async function exportEditedJpeg() {
    let exportImage: DevelopImage | null = null;
    try {
      setExportStatus("Exporting...");
      exportImage = await loadDevelopExportImage(entry);
      const blob = await canvasRef.current?.exportJpeg(exportImage);
      if (!blob) {
        throw new Error("Editor preview is not ready.");
      }
      const targetPath = await getDarkroomAPI().saveExport(
        entry.name.replace(/\.[^.]+$/, "-darkroom.jpg"),
        await blob.arrayBuffer(),
      );
      setExportStatus(targetPath ? `Exported ${targetPath}` : "Export canceled");
    } catch (exportError) {
      setExportStatus(
        exportError instanceof Error ? exportError.message : "Export failed.",
      );
    } finally {
      if (exportImage) {
        URL.revokeObjectURL(exportImage.objectUrl);
      }
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (event.key === "ArrowLeft" && activeIndex > 0) {
        router.push(`/photo?id=${encodeURIComponent(entries[activeIndex - 1].id)}`);
      }
      if (
        event.key === "ArrowRight" &&
        activeIndex >= 0 &&
        activeIndex < entries.length - 1
      ) {
        router.push(`/photo?id=${encodeURIComponent(entries[activeIndex + 1].id)}`);
      }
      if (event.key === "Escape") {
        router.push("/");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [entries, activeIndex, router]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar
        activeModule="develop"
        showBack
        title={entry.name}
        developPhotoId={entry.id}
      />

      <EntryMetadataBar
        entryId={entry.id}
        metadata={metadata}
        onPick={() => applyMetadataToEntries([entry.id], { pick: "pick" })}
        onReject={() => applyMetadataToEntries([entry.id], { pick: "reject" })}
        onClearPick={() => applyMetadataToEntries([entry.id], { pick: "none" })}
        onRating={(rating) => applyMetadataToEntries([entry.id], { rating })}
        onColorLabel={(label) => {
          const current = metadata.colorLabel;
          applyMetadataToEntries([entry.id], {
            colorLabel: current === label ? null : label,
          });
        }}
      />

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col bg-[#0d0d0d]">
          <div className="absolute right-3 top-3 z-10">
            <div className="flex items-center gap-2">
              {exportStatus ? (
                <span className="max-w-64 truncate rounded bg-lr-panel/90 px-2 py-1 text-[11px] text-lr-text-dim">
                  {exportStatus}
                </span>
              ) : null}
              <button
                type="button"
                onClick={exportEditedJpeg}
                className="rounded border border-lr-border-subtle bg-lr-panel/90 px-2.5 py-1 text-[11px] text-lr-text-muted backdrop-blur hover:text-lr-text"
              >
                Export JPEG
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex flex-1 items-center justify-center text-xs uppercase tracking-wider text-lr-text-dim">
              Decoding...
            </div>
          ) : null}

          {error ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-red-400">
              {error}
            </div>
          ) : null}

          {decoded ? (
            <div className="relative flex-1">
              <DevelopCanvas ref={canvasRef} image={decoded} alt={entry.name} />
            </div>
          ) : null}
        </div>

        {decoded ? <DevelopSidePanels decoded={decoded} entry={entry} /> : null}
      </div>

      <Filmstrip
        entries={entries}
        activeId={entry.id}
        onSelect={(id) => router.push(`/photo?id=${encodeURIComponent(id)}`)}
      />
    </div>
  );
}
