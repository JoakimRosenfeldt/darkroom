"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DeleteFromDiskConfirm } from "@/components/library/DeleteFromDiskConfirm";
import {
  IconAlbum,
  IconArchive,
  IconFolder,
  IconTrash,
} from "@/components/shell/icons";
import { useLibraryStore } from "@/stores/library-store";

interface RemovePhotosPopupProps {
  entryIds: string[];
  onClose: () => void;
}

type ActionOption = {
  id: "album" | "imported" | "restore" | "disk";
  label: string;
  description: string;
};

export function RemovePhotosPopup({ entryIds, onClose }: RemovePhotosPopupProps) {
  const albums = useLibraryStore((state) => state.albums);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const removeEntriesFromAlbum = useLibraryStore(
    (state) => state.removeEntriesFromAlbum,
  );
  const removeEntriesFromAllAlbums = useLibraryStore(
    (state) => state.removeEntriesFromAllAlbums,
  );
  const archiveEntries = useLibraryStore((state) => state.archiveEntries);
  const restoreEntries = useLibraryStore((state) => state.restoreEntries);
  const deleteEntriesFromDisk = useLibraryStore(
    (state) => state.deleteEntriesFromDisk,
  );

  const isArchiveView = catalogView.type === "archive";
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [confirmDiskDelete, setConfirmDiskDelete] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const options = useMemo(() => {
    if (isArchiveView) {
      return [
        {
          id: "restore" as const,
          label: "Restore to imported",
          description: "Move back into your library.",
        },
        {
          id: "disk" as const,
          label: "Remove from disk",
          description: "Remove files from your library.",
        },
      ];
    }

    const result: ActionOption[] = [];
    const targetSet = new Set(entryIds);
    const inAlbum =
      catalogView.type === "album" ||
      albums.some((album) => album.entryIds.some((id) => targetSet.has(id)));

    if (inAlbum) {
      if (catalogView.type === "album") {
        const album = albums.find((item) => item.id === catalogView.albumId);
        result.push({
          id: "album",
          label: `Remove from "${album?.name ?? "album"}"`,
          description: "Photos stay in your imported library.",
        });
      } else {
        result.push({
          id: "album",
          label: "Remove from all albums",
          description: "Photos stay in your imported library.",
        });
      }
    }

    result.push({
      id: "imported",
      label: "Remove from imported",
      description: "Move to archive. Files stay on disk.",
    });
    result.push({
      id: "disk",
      label: "Remove from disk",
      description: "Remove files from your library.",
    });

    return result;
  }, [albums, catalogView, entryIds, isArchiveView]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [options.length, isArchiveView]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const highlighted = listRef.current?.children[highlightIndex] as
      | HTMLElement
      | undefined;
    highlighted?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const runAction = useCallback(
    async (option: ActionOption) => {
      if (option.id === "album") {
        if (catalogView.type === "album") {
          removeEntriesFromAlbum(catalogView.albumId, entryIds);
        } else {
          removeEntriesFromAllAlbums(entryIds);
        }
        onClose();
        return;
      }

      if (option.id === "imported") {
        archiveEntries(entryIds);
        onClose();
        return;
      }

      if (option.id === "restore") {
        restoreEntries(entryIds);
        onClose();
        return;
      }

      setConfirmDiskDelete(true);
    },
    [
      archiveEntries,
      catalogView,
      entryIds,
      onClose,
      removeEntriesFromAlbum,
      removeEntriesFromAllAlbums,
      restoreEntries,
    ],
  );

  useEffect(() => {
    if (confirmDiskDelete) {
      return;
    }

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
          options.length === 0 ? 0 : Math.min(index + 1, options.length - 1),
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
        const option = options[highlightIndex];
        if (option) {
          void runAction(option);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirmDiskDelete, highlightIndex, onClose, options, runAction]);

  const photoLabel =
    entryIds.length === 1 ? "1 photo" : `${entryIds.length} photos`;

  function iconForOption(id: ActionOption["id"]) {
    switch (id) {
      case "album":
        return IconAlbum;
      case "imported":
        return IconArchive;
      case "restore":
        return IconFolder;
      case "disk":
        return IconTrash;
    }
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[18vh]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !confirmDiskDelete) {
            onClose();
          }
        }}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="w-80 overflow-hidden rounded-lg border border-lr-border bg-lr-panel shadow-xl outline-none"
          role="dialog"
          aria-label={isArchiveView ? "Archive actions" : "Remove photos"}
        >
          <div className="border-b border-lr-border-subtle px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-dim">
              {isArchiveView ? "Archive actions" : "Remove photos"}
            </p>
            <p className="text-[11px] text-lr-text-dim">{photoLabel}</p>
          </div>

          <ul ref={listRef} className="py-1" role="listbox">
            {options.map((option, index) => {
              const isActive = index === highlightIndex;
              const Icon = iconForOption(option.id);
              const isTrash = option.id === "disk";

              return (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setHighlightIndex(index)}
                    onClick={() => void runAction(option)}
                    className={[
                      "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition",
                      isActive
                        ? "bg-lr-selection text-lr-text"
                        : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text",
                    ].join(" ")}
                  >
                    <span className="flex items-center gap-2 text-xs">
                      <Icon
                        className={[
                          "h-3.5 w-3.5 shrink-0",
                          isTrash
                            ? "text-red-400"
                            : isActive
                              ? "text-lr-text-muted"
                              : "text-lr-text-dim",
                        ].join(" ")}
                      />
                      <span className={isTrash ? "text-red-400" : ""}>
                        {option.label}
                      </span>
                    </span>
                    <span
                      className={[
                        "pl-5 text-[11px]",
                        isActive
                          ? isTrash
                            ? "text-red-300"
                            : "text-lr-text-muted"
                          : isTrash
                            ? "text-red-400/70"
                            : "text-lr-text-dim",
                      ].join(" ")}
                    >
                      {option.description}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-lr-border-subtle px-3 py-1.5 text-[10px] text-lr-text-dim">
            ↑↓ navigate · Enter confirm · Esc cancel
          </div>
        </div>
      </div>

      {confirmDiskDelete ? (
        <DeleteFromDiskConfirm
          entryIds={entryIds}
          onClose={() => {
            setConfirmDiskDelete(false);
            onClose();
          }}
          onConfirm={() => {
            void deleteEntriesFromDisk(entryIds)
              .then(() => {
                setConfirmDiskDelete(false);
                onClose();
              })
              .catch(() => {});
          }}
        />
      ) : null}
    </>,
    document.body,
  );
}
