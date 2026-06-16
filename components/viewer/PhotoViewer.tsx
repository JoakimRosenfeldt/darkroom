"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { DecodedImage } from "@/lib/raw/decode";
import { decodeEntry } from "@/lib/raw/decode";
import { MetadataPanel } from "./MetadataPanel";

interface PhotoViewerProps {
  entry: LibraryEntry;
}

export function PhotoViewer({ entry }: PhotoViewerProps) {
  const [decoded, setDecoded] = useState<DecodedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadImage() {
      setLoading(true);
      setError(null);

      try {
        const result = await decodeEntry(entry, { thumbnail: false });
        if (!active) {
          URL.revokeObjectURL(result.objectUrl);
          return;
        }
        setDecoded(result);
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
  }, [entry]);

  useEffect(() => {
    return () => {
      if (decoded?.objectUrl) {
        URL.revokeObjectURL(decoded.objectUrl);
      }
    };
  }, [decoded]);

  return (
    <div className="flex min-h-[calc(100vh-120px)] flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-sm text-zinc-400 transition hover:text-zinc-200"
          >
            Back to library
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-100">
            {entry.name}
          </h1>
          <p className="text-sm text-zinc-500">{entry.relativePath}</p>
        </div>
        <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs uppercase tracking-wide text-zinc-300">
          {entry.profileId ?? "unknown"}
        </span>
      </div>

      <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative min-h-[420px] overflow-hidden rounded-2xl border border-zinc-800 bg-black">
          {loading ? (
            <div className="flex h-full min-h-[420px] items-center justify-center text-sm uppercase tracking-[0.2em] text-zinc-500">
              Decoding image...
            </div>
          ) : null}

          {error ? (
            <div className="flex h-full min-h-[420px] items-center justify-center px-6 text-center text-sm text-red-300">
              {error}
            </div>
          ) : null}

          {decoded ? (
            <div className="relative h-full min-h-[420px]">
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

        {decoded ? <MetadataPanel metadata={decoded.metadata} /> : null}
      </div>
    </div>
  );
}
