"use client";

import { useCallback, useSyncExternalStore } from "react";
import type {
  CurationFilter,
  FilterOption,
  GridViewMode,
  SortOption,
} from "@/lib/library/curation";

interface LibraryViewSettings {
  sort: SortOption;
  filter: FilterOption;
  curationFilter: CurationFilter;
  thumbSize: number;
  viewMode: GridViewMode;
}

const STORAGE_KEY = "darkroom:library-view-settings";
const CHANGE_EVENT = "darkroom:library-view-settings-change";
const DEFAULT_SETTINGS: LibraryViewSettings = {
  sort: "name",
  filter: "all",
  curationFilter: "all",
  thumbSize: 180,
  viewMode: "dynamic",
};

let cachedRaw: string | null | undefined;
let cachedSettings = DEFAULT_SETTINGS;

function parseSettings(raw: string | null): LibraryViewSettings {
  if (!raw) {
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LibraryViewSettings>;
    const sort = ["name", "date", "rating", "pick"].includes(parsed.sort ?? "")
      ? parsed.sort!
      : DEFAULT_SETTINGS.sort;
    const filter = ["all", "raw", "standard"].includes(parsed.filter ?? "")
      ? parsed.filter!
      : DEFAULT_SETTINGS.filter;
    const curationFilter = [
      "all",
      "picked",
      "rejected",
      "unpicked",
      "rated",
      "rating-1",
      "rating-2",
      "rating-3",
      "rating-4",
      "rating-5",
      "label-red",
      "label-yellow",
      "label-green",
      "label-blue",
      "label-purple",
    ].includes(parsed.curationFilter ?? "")
      ? parsed.curationFilter!
      : DEFAULT_SETTINGS.curationFilter;
    const thumbSize =
      typeof parsed.thumbSize === "number" &&
      parsed.thumbSize >= 120 &&
      parsed.thumbSize <= 320
        ? parsed.thumbSize
        : DEFAULT_SETTINGS.thumbSize;
    const viewMode = ["grid", "dynamic"].includes(parsed.viewMode ?? "")
      ? parsed.viewMode!
      : DEFAULT_SETTINGS.viewMode;

    return { sort, filter, curationFilter, thumbSize, viewMode };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function getSnapshot(): LibraryViewSettings {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSettings = parseSettings(raw);
  }
  return cachedSettings;
}

function subscribe(onStoreChange: () => void): () => void {
  function onStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) {
      cachedRaw = undefined;
      onStoreChange();
    }
  }

  function onLocalChange() {
    cachedRaw = undefined;
    onStoreChange();
  }

  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onLocalChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onLocalChange);
  };
}

export function useLibraryViewSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_SETTINGS,
  );
  const updateSettings = useCallback(
    (patch: Partial<LibraryViewSettings>) => {
      const next = { ...getSnapshot(), ...patch };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [],
  );

  return [settings, updateSettings] as const;
}
