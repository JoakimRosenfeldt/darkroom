"use client";

import { useEffect } from "react";
import {
  COLOR_LABEL_SHORTCUTS,
  isStarRating,
} from "@/lib/catalog/defaults";
import type { ColorLabel } from "@/lib/catalog/types";
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

export function useEntryMetadataShortcuts(activeEntryId: string | null): void {
  const setPick = useLibraryStore((state) => state.setPick);
  const setRating = useLibraryStore((state) => state.setRating);
  const setColorLabel = useLibraryStore((state) => state.setColorLabel);

  useEffect(() => {
    if (!activeEntryId) {
      return;
    }

    const entryId = activeEntryId;

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }

      const key = event.key;
      let handled = false;

      if (key === "p" || key === "P") {
        setPick(entryId, "pick");
        handled = true;
      } else if (key === "x" || key === "X") {
        setPick(entryId, "reject");
        handled = true;
      } else if (key === "u" || key === "U") {
        setPick(entryId, "none");
        handled = true;
      } else if (isStarRating(Number(key))) {
        setRating(entryId, Number(key) as 0 | 1 | 2 | 3 | 4 | 5);
        handled = true;
      } else if (key in COLOR_LABEL_SHORTCUTS) {
        const label = COLOR_LABEL_SHORTCUTS[key] as Exclude<ColorLabel, null>;
        setColorLabel(entryId, label);
        handled = true;
      }

      if (handled) {
        event.preventDefault();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeEntryId, setColorLabel, setPick, setRating]);
}

interface LibraryGridShortcutsOptions {
  visibleEntries: Array<{ id: string }>;
  selectedEntryId: string | null;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
}

export function useLibraryGridShortcuts({
  visibleEntries,
  selectedEntryId,
  onSelect,
  onOpen,
}: LibraryGridShortcutsOptions): void {
  useEntryMetadataShortcuts(selectedEntryId);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }

      if (visibleEntries.length === 0) {
        return;
      }

      const currentIndex = selectedEntryId
        ? visibleEntries.findIndex((entry) => entry.id === selectedEntryId)
        : -1;

      if (event.key === "Enter" && selectedEntryId && onOpen) {
        event.preventDefault();
        onOpen(selectedEntryId);
        return;
      }

      let nextIndex = currentIndex;

      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex =
          currentIndex < 0
            ? 0
            : Math.min(currentIndex + 1, visibleEntries.length - 1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex =
          currentIndex < 0
            ? visibleEntries.length - 1
            : Math.max(currentIndex - 1, 0);
      } else {
        return;
      }

      if (nextIndex !== currentIndex && visibleEntries[nextIndex]) {
        event.preventDefault();
        onSelect(visibleEntries[nextIndex].id);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visibleEntries, selectedEntryId, onSelect, onOpen]);
}
