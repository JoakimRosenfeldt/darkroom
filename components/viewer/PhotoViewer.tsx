"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { DecodedImage } from "@/lib/raw/decode";
import { decodeEntry } from "@/lib/raw/decode";
import { TopBar } from "@/components/shell/TopBar";
import { Filmstrip } from "./Filmstrip";
import { MetadataPanel } from "./MetadataPanel";

interface PhotoViewerProps {
  entry: LibraryEntry;
  entries: LibraryEntry[];
}

export function PhotoViewer({ entry, entries }: PhotoViewerProps) {
  const router = useRouter();
  const [decoded, setDecoded] = useState<DecodedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showMetadata, setShowMetadata] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadImage() {
      setLoading(true);
      setError(null);
      setDecoded(null);

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const index = entries.findIndex((item) => item.id === entry.id);
      if (event.key === "ArrowLeft" && index > 0) {
        router.push(`/photo?id=${encodeURIComponent(entries[index - 1].id)}`);
      }
      if (event.key === "ArrowRight" && index >= 0 && index < entries.length - 1) {
        router.push(`/photo?id=${encodeURIComponent(entries[index + 1].id)}`);
      }
      if (event.key === "Escape") {
        router.push("/");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [entries, entry.id, router]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar activeModule="library" showBack title={entry.name} />

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
