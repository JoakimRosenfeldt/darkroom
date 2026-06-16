"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import {
  createThumbnailObjectUrl,
  getCachedThumbnail,
  setCachedThumbnail,
} from "@/lib/cache/thumbnail-cache";
import { decodeEntry } from "@/lib/raw/decode";

interface PhotoTileProps {
  entry: LibraryEntry;
  size: number;
  selected?: boolean;
  compact?: boolean;
}

export function PhotoTile({
  entry,
  size,
  selected = false,
  compact = false,
}: PhotoTileProps) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    async function loadThumbnail() {
      try {
        const cacheKey = {
          relativePath: entry.relativePath,
          lastModified: entry.lastModified,
          thumbnail: true,
        };

        let blob = await getCachedThumbnail(cacheKey);
        if (!blob) {
          const decoded = await decodeEntry(entry, {
            thumbnail: true,
            maxEdge: Math.max(size, 120),
          });
          blob = decoded.blob;
          URL.revokeObjectURL(decoded.objectUrl);
          await setCachedThumbnail(cacheKey, blob);
        }

        if (!active) {
          return;
        }

        objectUrl = createThumbnailObjectUrl(blob);
        setThumbnailUrl(objectUrl);
        setStatus("ready");
      } catch {
        if (active) {
          setStatus("error");
        }
      }
    }

    void loadThumbnail();

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [entry, size]);

  const content = (
    <div
      className={[
        "group relative shrink-0 overflow-hidden bg-[#141414]",
        selected
          ? "ring-2 ring-lr-accent ring-offset-1 ring-offset-lr-bg"
          : "hover:ring-1 hover:ring-lr-border",
        compact ? "" : "transition-shadow",
      ].join(" ")}
      style={{ width: size, height: size }}
    >
      {thumbnailUrl ? (
        <Image
          src={thumbnailUrl}
          alt={entry.name}
          fill
          unoptimized
          className="object-cover"
          sizes={`${size}px`}
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

      {selected ? (
        <div className="absolute left-0 top-0 h-0 w-0 border-r-[10px] border-t-[10px] border-r-transparent border-t-lr-accent" />
      ) : null}
    </div>
  );

  if (compact) {
    return content;
  }

  return (
    <Link href={`/photo?id=${encodeURIComponent(entry.id)}`}>{content}</Link>
  );
}
