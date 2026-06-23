"use client";

import { useEffect, useMemo } from "react";
import {
  COLOR_LABEL_SHORTCUTS,
  isStarRating,
} from "@/lib/catalog/defaults";
import type { ColorLabel } from "@/lib/catalog/types";
import { navigateGridRows } from "@/lib/library/grid-navigation";
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

export function useEntryMetadataShortcuts(
  activeEntryIds: string[],
  disabled = false,
): void {
  const applyMetadataToEntries = useLibraryStore(
    (state) => state.applyMetadataToEntries,
  );
  const setColorLabel = useLibraryStore((state) => state.setColorLabel);

  useEffect(() => {
    if (disabled || activeEntryIds.length === 0) {
      return;
    }

    const targets = activeEntryIds;

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }

      const key = event.key;
      let handled = false;

      if (key === "p" || key === "P") {
        applyMetadataToEntries(targets, { pick: "pick" });
        handled = true;
      } else if (key === "x" || key === "X") {
        applyMetadataToEntries(targets, { pick: "reject" });
        handled = true;
      } else if (key === "u" || key === "U") {
        applyMetadataToEntries(targets, { pick: "none" });
        handled = true;
      } else if (isStarRating(Number(key))) {
        applyMetadataToEntries(targets, {
          rating: Number(key) as 0 | 1 | 2 | 3 | 4 | 5,
        });
        handled = true;
      } else if (key in COLOR_LABEL_SHORTCUTS) {
        const label = COLOR_LABEL_SHORTCUTS[key] as Exclude<ColorLabel, null>;
        if (targets.length > 1) {
          applyMetadataToEntries(targets, { colorLabel: label });
        } else {
          setColorLabel(targets[0]!, label);
        }
        handled = true;
      }

      if (handled) {
        event.preventDefault();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeEntryIds, applyMetadataToEntries, disabled, setColorLabel]);
}

interface LibraryGridShortcutsOptions {
  gridRows: string[][];
  visibleEntries: Array<{ id: string }>;
  selectedEntryId: string | null;
  selectedEntryIds: string[];
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  disabled?: boolean;
  metadataShortcutsDisabled?: boolean;
}

export function useLibraryGridShortcuts({
  gridRows,
  visibleEntries,
  selectedEntryId,
  selectedEntryIds,
  onSelect,
  onOpen,
  disabled = false,
  metadataShortcutsDisabled = false,
}: LibraryGridShortcutsOptions): void {
  const shortcutTargets = useMemo(
    () =>
      selectedEntryIds.length > 0
        ? selectedEntryIds
        : selectedEntryId
          ? [selectedEntryId]
          : [],
    [selectedEntryIds, selectedEntryId],
  );

  useEntryMetadataShortcuts(
    shortcutTargets,
    disabled || metadataShortcutsDisabled,
  );

  useEffect(() => {
    if (disabled) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }

      if (visibleEntries.length === 0) {
        return;
      }

      if (event.key === "Enter" && selectedEntryId && onOpen) {
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        onOpen(selectedEntryId);
        return;
      }

      let nextId: string | null = null;

      if (event.key === "ArrowRight") {
        nextId = navigateGridRows(gridRows, selectedEntryId, "right");
      } else if (event.key === "ArrowLeft") {
        nextId = navigateGridRows(gridRows, selectedEntryId, "left");
      } else if (event.key === "ArrowDown") {
        nextId = navigateGridRows(gridRows, selectedEntryId, "down");
      } else if (event.key === "ArrowUp") {
        nextId = navigateGridRows(gridRows, selectedEntryId, "up");
      } else {
        return;
      }

      if (nextId && nextId !== selectedEntryId) {
        event.preventDefault();
        onSelect(nextId);
        return;
      }

      // Fall back to flat navigation when grid layout is not ready.
      if (gridRows.length > 0) {
        return;
      }

      const currentIndex = selectedEntryId
        ? visibleEntries.findIndex((entry) => entry.id === selectedEntryId)
        : -1;
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
      }

      if (nextIndex !== currentIndex && visibleEntries[nextIndex]) {
        event.preventDefault();
        onSelect(visibleEntries[nextIndex].id);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gridRows, visibleEntries, selectedEntryId, onSelect, onOpen, disabled]);
}
