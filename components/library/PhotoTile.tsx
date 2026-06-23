"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { memo, useEffect, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { EntryMetadata } from "@/lib/catalog/types";
import type { SelectEntryModifiers } from "@/stores/library-store";
import {
  createThumbnailObjectUrl,
  loadThumbnailBlob,
} from "@/lib/cache/thumbnail-cache";
import { EntryMetadataBadges } from "./EntryMetadataBar";

interface PhotoTileProps {
  entry: LibraryEntry;
  width: number;
  height: number;
  selected?: boolean;
  compact?: boolean;
  fit?: "contain" | "cover";
  metadata?: EntryMetadata;
  onSelect?: (entryId: string, modifiers: SelectEntryModifiers) => void;
  onContextMenu?: (entryId: string, event: React.MouseEvent) => void;
  getScrollRoot?: () => HTMLElement | null;
}

const MIN_THUMBNAIL_EDGE = 360;

export const PhotoTile = memo(function PhotoTile({
  entry,
  width,
  height,
  selected = false,
  compact = false,
  fit = "contain",
  metadata,
  onSelect,
  onContextMenu,
  getScrollRoot,
}: PhotoTileProps) {
  const router = useRouter();
  const tileRef = useRef<HTMLDivElement>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [intersectionRatio, setIntersectionRatio] = useState(0);
  const decodeEdge = Math.max(width, height, MIN_THUMBNAIL_EDGE);

  useEffect(() => {
    const element = tileRef.current;
    if (!element) {
      return;
    }

    if (!("IntersectionObserver" in window)) {
      setIsNearViewport(true);
      setIntersectionRatio(1);
      return;
    }

    const root = getScrollRoot?.() ?? null;
    const observer = new IntersectionObserver(
      ([observed]) => {
        if (!observed) {
          return;
        }
        setIsNearViewport(observed.isIntersecting);
        setIntersectionRatio(observed.intersectionRatio);
      },
      {
        root,
        rootMargin: compact ? "160px 320px" : "320px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, [compact, getScrollRoot]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setThumbnailUrl(null);
    setStatus("loading");

    if (!isNearViewport) {
      return () => {
        active = false;
        controller.abort();
      };
    }

    const loadPriority = selected
      ? 30
      : intersectionRatio >= 0.5
        ? 20 + Math.round(intersectionRatio * 5)
        : 12;

    async function loadThumbnail() {
      try {
        const blob = await loadThumbnailBlob(entry, decodeEdge, {
          priority: loadPriority,
          signal: controller.signal,
        });
        if (!active) {
          return;
        }

        objectUrl = createThumbnailObjectUrl(blob);
        setThumbnailUrl(objectUrl);
        setStatus("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        if (active) {
          setStatus("error");
        }
      }
    }

    void loadThumbnail();

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [entry, decodeEdge, isNearViewport, intersectionRatio, selected]);

  const imageFit = compact ? "object-cover" : `object-${fit}`;
  const isRejected = metadata?.pick === "reject";

  const content = (
    <div
      ref={tileRef}
      className={[
        "group relative shrink-0 overflow-hidden bg-[#141414]",
        selected
          ? "ring-2 ring-lr-accent ring-offset-1 ring-offset-lr-bg"
          : "hover:ring-1 hover:ring-lr-border",
        compact ? "" : "transition-shadow",
      ].join(" ")}
      style={{ width, height }}
    >
      {thumbnailUrl ? (
        <Image
          src={thumbnailUrl}
          alt={entry.name}
          fill
          unoptimized
          className={imageFit}
          sizes={`${width}px`}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-wider text-lr-text-dim">
          {status === "error" ? "Error" : "···"}
        </div>
      )}

      {!compact ? (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-6 opacity-0 transition-opacity group-hover:opacity-100">
          <p className="truncate text-[10px] text-white/90">{entry.name}</p>
          {entry.profileId && entry.profileId !== "standard" ? (
            <p className="text-[9px] uppercase tracking-wide text-lr-accent">
              {entry.profileId}
            </p>
          ) : null}
        </div>
      ) : null}

      {isRejected ? (
        <div className="pointer-events-none absolute inset-0 bg-black/50" />
      ) : null}

      {metadata ? <EntryMetadataBadges metadata={metadata} /> : null}

      {selected ? (
        <div className="absolute left-0 top-0 h-0 w-0 border-r-[10px] border-t-[10px] border-r-transparent border-t-lr-accent" />
      ) : null}
    </div>
  );

  if (compact) {
    return content;
  }

  if (onSelect) {
    return (
      <button
        type="button"
        className="block shrink-0 cursor-pointer border-0 bg-transparent p-0 text-left"
        onClick={(event) =>
          onSelect(entry.id, {
            shift: event.shiftKey,
            toggle: event.metaKey || event.ctrlKey,
          })
        }
        onDoubleClick={() =>
          router.push(`/photo?id=${encodeURIComponent(entry.id)}`)
        }
        onContextMenu={(event) => onContextMenu?.(entry.id, event)}
      >
        {content}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="block shrink-0 cursor-pointer border-0 bg-transparent p-0 text-left"
      onClick={() =>
        router.push(`/photo?id=${encodeURIComponent(entry.id)}`)
      }
    >
      {content}
    </button>
  );
});
