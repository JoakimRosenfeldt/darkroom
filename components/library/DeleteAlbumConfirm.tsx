"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Album } from "@/lib/catalog/types";

interface DeleteAlbumConfirmProps {
  album: Album;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeleteAlbumConfirm({
  album,
  onConfirm,
  onClose,
}: DeleteAlbumConfirmProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onConfirm();
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onConfirm, onClose]);

  const photoLabel =
    album.entryIds.length === 1
      ? "1 photo"
      : `${album.entryIds.length} photos`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[18vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-80 overflow-hidden rounded-lg border border-lr-border bg-lr-panel shadow-xl outline-none"
        role="alertdialog"
        aria-label={`Delete album ${album.name}`}
      >
        <div className="px-3 py-3">
          <p className="text-sm text-lr-text">
            Delete &ldquo;{album.name}&rdquo;?
          </p>
          <p className="mt-1.5 text-xs text-lr-text-dim">
            {photoLabel} will stay in your library. Only the album is removed.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-lr-border-subtle px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2.5 py-1 text-xs text-lr-text-muted transition hover:bg-lr-panel-raised hover:text-lr-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-red-500/20 px-2.5 py-1 text-xs text-red-400 transition hover:bg-red-500/30"
          >
            Delete album
          </button>
        </div>

        <div className="border-t border-lr-border-subtle px-3 py-1.5 text-[10px] text-lr-text-dim">
          Enter confirm · Esc cancel
        </div>
      </div>
    </div>,
    document.body,
  );
}
