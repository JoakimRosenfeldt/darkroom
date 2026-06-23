"use client";

import { useEffect, useMemo, useState } from "react";
import { AlbumPickerPopup } from "@/components/library/AlbumPickerPopup";

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
  const [open, setOpen] = useState(false);

  const entryIds = useMemo(
    () =>
      selectedEntryIds.length > 0
        ? selectedEntryIds
        : selectedEntryId
          ? [selectedEntryId]
          : [],
    [selectedEntryIds, selectedEntryId],
  );

  useEffect(() => {
    if (disabled || open || entryIds.length === 0) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }

      if (
        event.key === "b" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        setOpen(true);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, entryIds.length, open]);

  const albumPicker = open ? (
    <AlbumPickerPopup
      entryIds={entryIds}
      onClose={() => setOpen(false)}
    />
  ) : null;

  return { albumPicker, albumPickerOpen: open };
}
