"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconAlbum } from "@/components/shell/icons";
import type { Album } from "@/lib/catalog/types";
import { useLibraryStore } from "@/stores/library-store";

interface AlbumPickerPopupProps {
  entryIds: string[];
  onClose: () => void;
}

type PickerRow =
  | { kind: "album"; album: Album }
  | { kind: "create"; name: string };

export function AlbumPickerPopup({ entryIds, onClose }: AlbumPickerPopupProps) {
  const albums = useLibraryStore((state) => state.albums);
  const createAlbum = useLibraryStore((state) => state.createAlbum);
  const addEntriesToAlbum = useLibraryStore((state) => state.addEntriesToAlbum);

  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = useMemo(() => {
    const trimmed = query.trim();
    const lowerQuery = trimmed.toLowerCase();
    const matched = lowerQuery
      ? albums.filter((album) => album.name.toLowerCase().includes(lowerQuery))
      : albums;
    const result: PickerRow[] = matched.map((album) => ({
      kind: "album",
      album,
    }));

    const exactMatch = albums.some(
      (album) => album.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (trimmed && !exactMatch) {
      result.push({ kind: "create", name: trimmed });
    }

    if (result.length === 0 && !trimmed) {
      result.push({ kind: "create", name: "New album" });
    }

    return result;
  }, [albums, query]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, rows.length]);

  const confirmRow = useCallback(
    (row: PickerRow) => {
      if (row.kind === "album") {
        addEntriesToAlbum(row.album.id, entryIds);
        onClose();
        return;
      }

      const albumId = createAlbum(row.name);
      if (albumId) {
        addEntriesToAlbum(albumId, entryIds);
      }
      onClose();
    },
    [addEntriesToAlbum, createAlbum, entryIds, onClose],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const highlighted = listRef.current?.children[highlightIndex] as
      | HTMLElement
      | undefined;
    highlighted?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setHighlightIndex((index) =>
          rows.length === 0 ? 0 : Math.min(index + 1, rows.length - 1),
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setHighlightIndex((index) => Math.max(index - 1, 0));
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const row = rows[highlightIndex];
        if (row) {
          confirmRow(row);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirmRow, highlightIndex, onClose, rows]);

  const photoLabel =
    entryIds.length === 1 ? "1 photo" : `${entryIds.length} photos`;

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
        className="w-80 overflow-hidden rounded-lg border border-lr-border bg-lr-panel shadow-xl"
        role="dialog"
        aria-label="Add to album"
      >
        <div className="border-b border-lr-border-subtle px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-dim">
            Add to album
          </p>
          <p className="text-[11px] text-lr-text-dim">{photoLabel}</p>
        </div>

        <div className="border-b border-lr-border-subtle p-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search albums…"
            className="w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2.5 py-1.5 text-sm text-lr-text outline-none focus:border-lr-accent"
          />
        </div>

        <ul
          ref={listRef}
          className="max-h-56 overflow-auto py-1"
          role="listbox"
        >
          {rows.length === 0 ? (
            <li className="px-3 py-2 text-xs text-lr-text-dim">
              No matching albums
            </li>
          ) : (
            rows.map((row, index) => {
              const isActive = index === highlightIndex;
              const label =
                row.kind === "album"
                  ? row.album.name
                  : `Create "${row.name}"`;
              const count =
                row.kind === "album" ? row.album.entryIds.length : null;

              return (
                <li key={row.kind === "album" ? row.album.id : `create-${row.name}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setHighlightIndex(index)}
                    onClick={() => confirmRow(row)}
                    className={[
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition",
                      isActive
                        ? "bg-lr-selection text-lr-text"
                        : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text",
                    ].join(" ")}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <IconAlbum
                        className={[
                          "h-3.5 w-3.5 shrink-0",
                          isActive ? "text-lr-text-muted" : "text-lr-text-dim",
                        ].join(" ")}
                      />
                      <span className="truncate">{label}</span>
                    </span>
                    {count !== null ? (
                      <span
                        className={[
                          "shrink-0",
                          isActive ? "text-lr-text-muted" : "text-lr-text-dim",
                        ].join(" ")}
                      >
                        {count}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="border-t border-lr-border-subtle px-3 py-1.5 text-[10px] text-lr-text-dim">
          ↑↓ navigate · Enter confirm · Esc cancel
        </div>
      </div>
    </div>,
    document.body,
  );
}
