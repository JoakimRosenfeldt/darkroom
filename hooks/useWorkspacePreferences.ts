"use client";

import { useSyncExternalStore } from "react";

interface WorkspacePreferences {
  readonly showFilmstrip: boolean;
  readonly linkedCompare: boolean;
}

const KEY = "darkroom:workspace-preferences";
const EVENT = "darkroom:workspace-preferences-changed";
const DEFAULTS: WorkspacePreferences = { showFilmstrip: true, linkedCompare: true };
let cachedRaw: string | null | undefined;
let cachedPreferences = DEFAULTS;
let sessionOnly = false;

function snapshot(): WorkspacePreferences {
  if (sessionOnly) return cachedPreferences;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      cachedPreferences = parsed && typeof parsed === "object" ? {
        showFilmstrip: "showFilmstrip" in parsed && typeof parsed.showFilmstrip === "boolean"
          ? parsed.showFilmstrip : DEFAULTS.showFilmstrip,
        linkedCompare: "linkedCompare" in parsed && typeof parsed.linkedCompare === "boolean"
          ? parsed.linkedCompare : DEFAULTS.linkedCompare,
      } : DEFAULTS;
    }
  } catch {
    // Keep preferences available when storage is blocked or malformed.
  }
  return cachedPreferences;
}

function subscribe(notify: () => void): () => void {
  function onStorage(event: StorageEvent) {
    if (event.key !== KEY && event.key !== null) return;
    sessionOnly = false;
    cachedRaw = undefined;
    notify();
  }
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, notify);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, notify);
  };
}

function updatePreferences(patch: Partial<WorkspacePreferences>): void {
  const current = snapshot();
  const next = { ...current, ...patch };
  if (next.showFilmstrip === current.showFilmstrip && next.linkedCompare === current.linkedCompare) return;
  cachedPreferences = next;
  cachedRaw = JSON.stringify(next);
  try {
    window.localStorage.setItem(KEY, cachedRaw);
    sessionOnly = false;
  } catch {
    sessionOnly = true;
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useWorkspacePreferences() {
  const preferences = useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
  return [preferences, updatePreferences] as const;
}
