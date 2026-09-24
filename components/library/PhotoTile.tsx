"use client";

import { useNavigate } from "react-router";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { EntryMetadata } from "@/lib/catalog/types";
import type { SelectEntryModifiers } from "@/stores/library-store";
import { getFormatLabelForEntry } from "@/lib/formats/registry";
import {
  loadThumbnailBlob,
} from "@/lib/cache/thumbnail-cache";
import { getCachedEntryAspectRatio, rememberEntryAspectRatio } from "@/lib/cache/aspect-ratio-cache";
import { EntryMetadataBadges } from "./EntryMetadataBar";
import { useLibraryViewSettings } from "@/hooks/useLibraryViewSettings";
import { useLibraryStore } from "@/stores/library-store";
import { getVisibleLibraryResult } from "@/lib/library/result-session";
import { createViewerSession, viewerPhotoHref } from "@/lib/viewer/session";
import { useDevelopJobStore } from "@/stores/develop-job-store";

interface PhotoTileProps {
  entry: LibraryEntry;
  width: number;
  height: number;
  selected?: boolean;
  compact?: boolean;
  caption?: boolean;
  fit?: "contain" | "cover";
  thumbnailEdge?: number;
  onAspectRatio?: (entryId: string, ratio: number) => void;
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
  caption = false,
  fit = "contain",
  thumbnailEdge,
  onAspectRatio,
  metadata,
  onSelect,
  onContextMenu,
  getScrollRoot,
}: PhotoTileProps) {
  const navigate = useNavigate();
  const stacks = useLibraryStore((state) => state.libraryWorkspace.stacks);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const [viewSettings, updateViewSettings] = useLibraryViewSettings();
  const tileRef = useRef<HTMLDivElement>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const objectUrlRef = useRef<string | null>(null);
  const decodeEdge = thumbnailEdge ?? Math.max(width, height, MIN_THUMBNAIL_EDGE);
  const developDocument = metadata?.develop ?? null;
  const jobs = useDevelopJobStore((state) => state.jobs);
  const prototypeJobs = useMemo(() => jobs.filter((job) =>
    job.request.source.entryId === entry.id && job.request.source.catalogId === entry.catalogId &&
    job.status !== "discarded"
  ), [entry.catalogId, entry.id, jobs]);
  const prototypeBadge = prototypeJobs.some((job) => job.status === "queued" || job.status === "preparing" || job.status === "running" || job.status === "postprocess" || job.status === "accepting")
    ? "Prototype working"
    : prototypeJobs.some((job) => job.status === "awaiting-review")
      ? "Prototype review"
      : prototypeJobs.some((job) => job.status === "accepted")
        ? "Prototype accepted"
        : prototypeJobs.some((job) => job.status === "failed" || job.status === "stale" || job.status === "interrupted")
          ? "Prototype needs attention"
          : null;

  function openRecordedResult(selectedIds: readonly string[]) {
    const result = getVisibleLibraryResult();
    if (result.query === null || !result.entryIds.includes(entry.id)) return;
    try {
      const session = createViewerSession({
        query: result.query,
        orderedEntryIds: result.viewerEntryIds,
        activeEntryId: entry.id,
        selectedEntryIds: selectedIds,
      });
      navigate(viewerPhotoHref(entry.id, session.id));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The Library result could not be saved.");
    }
  }

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setThumbnailUrl(null);
    setLoadError(null);
    setStatus(entry.formatAvailability.status === "supported" ? "loading" : "error");
  }, [entry.assetRevision, entry.catalogId, entry.formatAvailability.status, entry.id, decodeEdge, developDocument]);

  useEffect(() => {
    const element = tileRef.current;
    if (!element) {
      return;
    }

    if (!("IntersectionObserver" in window)) {
      setIsNearViewport(true);
      return;
    }

    const root = getScrollRoot?.() ?? null;
    const observer = new IntersectionObserver(
      ([observed]) => {
        if (!observed) {
          return;
        }
        setIsNearViewport(observed.isIntersecting);
      },
      {
        root,
        rootMargin: compact ? "160px 320px" : "320px",
      },
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, [compact, getScrollRoot]);

  useEffect(() => {
    if (!isNearViewport || thumbnailUrl) {
      return;
    }

    if (entry.formatAvailability.status !== "supported") {
      setStatus("error");
      return;
    }

    let active = true;
    const controller = new AbortController();

    async function loadThumbnail() {
      setLoadError(null);
      setStatus("loading");
      try {
        const blob = await loadThumbnailBlob(entry, decodeEdge, {
          document: developDocument ?? undefined,
          priority: 20,
          signal: controller.signal,
        });
        if (!active) {
          return;
        }

        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = URL.createObjectURL(blob);
        setThumbnailUrl(objectUrlRef.current);
        setLoadError(null);
        setStatus("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        if (active) {
          setLoadError(error instanceof Error && error.message.trim()
            ? error.message
            : typeof error === "string" && error.trim()
              ? error
              : "Could not load the photo preview.");
          setStatus("error");
        }
      }
    }

    void loadThumbnail();

    return () => {
      active = false;
      controller.abort();
    };
  }, [entry, decodeEdge, isNearViewport, thumbnailUrl, developDocument]);

  const imageFit = compact ? "object-cover" : `object-${fit}`;
  const isRejected = metadata?.pick === "reject";
  const formatLabel = getFormatLabelForEntry(entry.name, entry.profileId);
  const previewError = entry.formatAvailability.status !== "supported"
    ? entry.formatAvailability.reason ?? `Preview is unavailable for ${entry.name}.`
    : status === "error" ? loadError ?? "Could not load the photo preview." : null;
  const errorLabel = previewError ? `${entry.name}: ${previewError}` : undefined;
  const showFormatLabel =
    entry.formatAvailability.status !== "supported" ||
    (entry.profileId !== null && entry.profileId !== "standard");
  const stack = stacks.find((item) => item.entryIds.includes(entry.id));
  const stackExpanded = stack ? viewSettings.expandedStackIds.includes(stack.id) : false;

  function toggleStack(event: React.MouseEvent | React.KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!stack) return;
    updateViewSettings({
      expandedStackIds: stackExpanded
        ? viewSettings.expandedStackIds.filter((id) => id !== stack.id)
        : [...viewSettings.expandedStackIds, stack.id],
    });
  }

  const content = (
    <div
      ref={tileRef}
      className={[
        "group relative shrink-0 overflow-hidden rounded-[6px] bg-[#0f0d0c] ring-1 ring-inset ring-transparent",
        selected
          ? "ring-2 ring-inset ring-lr-accent"
          : "hover:ring-1 hover:ring-inset hover:ring-lr-border",
        compact ? "" : "transition-[box-shadow,transform] duration-150 ease-out",
      ].join(" ")}
      style={{ width, height }}
      title={previewError ?? undefined}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={entry.name}
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              const ratio = image.naturalWidth / image.naturalHeight;
              if (!developDocument && Math.abs((getCachedEntryAspectRatio(entry) ?? 0) - ratio) >= 0.01) {
                rememberEntryAspectRatio(entry, ratio);
              }
              onAspectRatio?.(entry.id, ratio);
            }
          }}
          className={`absolute inset-0 h-full w-full ${imageFit}`}
        />
      ) : (
        <div
          className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center text-[10px] text-lr-text-dim"
          role={previewError ? "img" : undefined}
          aria-label={errorLabel}
        >
          <span className="uppercase tracking-wider">
            {entry.formatAvailability.status !== "supported"
              ? `${formatLabel}: unavailable`
              : status === "error"
                ? "Preview unavailable"
                : "···"}
          </span>
          {previewError && !compact ? <span className="line-clamp-2 break-words">{previewError}</span> : null}
        </div>
      )}

      {!compact ? (
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-2 bg-gradient-to-t from-[#0f0d0c]/95 via-[#0f0d0c]/65 to-transparent px-2 pb-2 pt-8 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-lr-text">
            {entry.entryKind === "virtual" ? `${entry.name} · ${entry.displayName}` : entry.name}
          </p>
          {showFormatLabel ? (
            <p className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-lr-accent">
              {formatLabel}
            </p>
          ) : null}
        </div>
      ) : null}

      {isRejected ? (
        <div className="pointer-events-none absolute inset-0 bg-[#0f0d0c]/55" />
      ) : null}

      {metadata ? (
        <EntryMetadataBadges metadata={metadata} compact={caption} />
      ) : null}

      {stack ? (
        <span
          role="button"
          tabIndex={0}
          aria-label={`${stackExpanded ? "Collapse" : "Expand"} stack of ${stack.entryIds.length} photos`}
          aria-pressed={stackExpanded}
          onClick={toggleStack}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") toggleStack(event);
          }}
          className="absolute right-2 top-2 z-30 rounded-md border border-white/15 bg-black/70 px-1.5 py-1 font-mono text-[9px] text-white shadow"
        >
          {stackExpanded ? "▾" : "▸"} {stack.entryIds.length}
        </span>
      ) : null}

      {entry.entryKind === "virtual" ? (
        <span className="pointer-events-none absolute left-2 top-2 z-30 max-w-[70%] truncate rounded border border-white/15 bg-black/75 px-1.5 py-1 font-mono text-[9px] text-white">
          {entry.displayName}
        </span>
      ) : null}

      {prototypeBadge ? <span aria-label={prototypeBadge} className={`pointer-events-none absolute left-2 z-30 rounded border border-white/15 bg-black/75 px-1.5 py-1 font-mono text-[9px] text-white ${entry.entryKind === "virtual" ? "top-9" : "top-2"}`}>{prototypeBadge}</span> : null}

      {selected ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 rounded-[6px] border-2 border-lr-accent"
        />
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
        aria-pressed={selected}
        aria-label={errorLabel}
        className="block shrink-0 cursor-pointer border-0 bg-transparent p-0 text-left"
        style={caption ? { width } : undefined}
        onClick={(event) =>
          onSelect(entry.id, {
            shift: event.shiftKey,
            toggle: event.metaKey || event.ctrlKey,
          })
        }
        onDoubleClick={() => openRecordedResult(selectedEntryIds)}
        onContextMenu={(event) => onContextMenu?.(entry.id, event)}
      >
        {content}
        {caption ? (
          <div className="flex h-[18px] items-end gap-1.5 px-0.5">
            <span
              className={[
                "min-w-0 flex-1 truncate font-mono text-[10px]",
                selected ? "text-lr-text" : "text-lr-text-faint",
              ].join(" ")}
            >
              {entry.entryKind === "virtual" ? `${entry.name} · ${entry.displayName}` : entry.name}
            </span>
            {metadata && metadata.rating > 0 ? (
              <span className="shrink-0 text-[9px] text-lr-accent">
                {"★".repeat(metadata.rating)}
              </span>
            ) : null}
          </div>
        ) : null}
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={errorLabel}
      className="block shrink-0 cursor-pointer border-0 bg-transparent p-0 text-left"
      onClick={() => openRecordedResult([entry.id])}
    >
      {content}
    </button>
  );
});
