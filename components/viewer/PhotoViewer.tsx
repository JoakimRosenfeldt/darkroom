"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  loadDevelopImage,
  preloadDevelopImages,
} from "@/lib/cache/develop-image-cache";
import { TopBar } from "@/components/shell/TopBar";
import { useLibraryStore } from "@/stores/library-store";
import { Filmstrip } from "./Filmstrip";
import { MetadataPanel } from "./MetadataPanel";

interface PhotoViewerProps {
  entry: LibraryEntry;
  entries: LibraryEntry[];
}

export function PhotoViewer({ entry, entries }: PhotoViewerProps) {
  const router = useRouter();
  const setSelectedEntryId = useLibraryStore((state) => state.setSelectedEntryId);
  const [decoded, setDecoded] = useState<DevelopImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showMetadata, setShowMetadata] = useState(true);
  const activeIndex = useMemo(
    () => entries.findIndex((item) => item.id === entry.id),
    [entries, entry.id],
  );

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
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

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col bg-[#0d0d0d]">
          <div className="absolute right-3 top-3 z-10">
            <button
              type="button"
              onClick={() => setShowMetadata((value) => !value)}
              className="rounded border border-lr-border-subtle bg-lr-panel/90 px-2.5 py-1 text-[11px] text-lr-text-muted backdrop-blur hover:text-lr-text"
            >
              {showMetadata ? "Hide Info" : "Show Info"}
            </button>
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
              <Image
                src={decoded.objectUrl}
                alt={entry.name}
                fill
                unoptimized
                className="object-contain"
                priority
              />
            </div>
          ) : null}
        </div>

        {showMetadata && decoded ? (
          <MetadataPanel
            metadata={decoded.metadata}
            fileName={entry.name}
            profileId={entry.profileId}
          />
        ) : null}
      </div>

      <Filmstrip
        entries={entries}
        activeId={entry.id}
        onSelect={(id) => router.push(`/photo?id=${encodeURIComponent(id)}`)}
      />
    </div>
  );
}
