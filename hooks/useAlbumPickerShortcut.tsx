"use client";

import { useEffect, useMemo, useState } from "react";
import { AlbumPickerPopup } from "@/components/library/AlbumPickerPopup";
import { RemovePhotosPopup } from "@/components/library/RemovePhotosPopup";
import { useLibraryStore } from "@/stores/library-store";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function isRemoveKey(key: string): boolean {
  return key === "Backspace" || key === "Delete";
}

interface UseAlbumPickerShortcutOptions {
  selectedEntryId: string | null;
  selectedEntryIds: string[];
  disabled?: boolean;
}

export function useAlbumPickerShortcut({
  selectedEntryId,
  selectedEntryIds,
  disabled = false,
}: UseAlbumPickerShortcutOptions) {
  const [albumPickerOpen, setAlbumPickerOpen] = useState(false);
  const [removePopupOpen, setRemovePopupOpen] = useState(false);
  const catalogView = useLibraryStore((state) => state.catalogView);
  const isArchiveView = catalogView.type === "archive";

  const entryIds = useMemo(
    () =>
      selectedEntryIds.length > 0
        ? selectedEntryIds
        : selectedEntryId
          ? [selectedEntryId]
          : [],
    [selectedEntryIds, selectedEntryId],
  );

  const overlayOpen = albumPickerOpen || removePopupOpen;

  useEffect(() => {
    if (disabled || overlayOpen || entryIds.length === 0) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }

      if (
        event.key === "b" &&
        !isArchiveView &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        setAlbumPickerOpen(true);
        return;
      }

      if (
        isRemoveKey(event.key) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setRemovePopupOpen(true);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, entryIds.length, isArchiveView, overlayOpen]);

  const albumPicker =
    albumPickerOpen && !isArchiveView ? (
      <AlbumPickerPopup
        entryIds={entryIds}
        onClose={() => setAlbumPickerOpen(false)}
      />
    ) : null;

  const removePopup = removePopupOpen ? (
    <RemovePhotosPopup
      entryIds={entryIds}
      onClose={() => setRemovePopupOpen(false)}
    />
  ) : null;

  return { albumPicker, removePopup, overlayOpen };
}
