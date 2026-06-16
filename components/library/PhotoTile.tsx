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
}

export function PhotoTile({ entry }: PhotoTileProps) {
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
            maxEdge: 320,
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
  }, [entry]);

  return (
    <Link
      href={`/photo?id=${encodeURIComponent(entry.id)}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 transition hover:border-zinc-600 hover:bg-zinc-900"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-zinc-900">
        {thumbnailUrl ? (
          <Image
            src={thumbnailUrl}
            alt={entry.name}
            fill
            unoptimized
            className="object-cover transition duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs uppercase tracking-[0.2em] text-zinc-600">
            {status === "error" ? "Decode error" : "Loading"}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="truncate text-sm text-zinc-200">{entry.name}</p>
        <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
          {entry.profileId ?? "unknown"}
        </span>
      </div>
    </Link>
  );
}
