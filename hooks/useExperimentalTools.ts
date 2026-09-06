"use client";

import { useSyncExternalStore } from "react";

const KEY = "darkroom:experimental-tools";
const EVENT = "darkroom:preferences-changed";
let enabled = false;

function snapshot(): boolean {
  try { return window.localStorage.getItem(KEY) === "true"; }
  catch { return enabled; }
}

function subscribe(notify: () => void): () => void {
  window.addEventListener("storage", notify);
  window.addEventListener(EVENT, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(EVENT, notify);
  };
}

export function useExperimentalTools() {
  const experimental = useSyncExternalStore(subscribe, snapshot, () => false);
  return [experimental, (value: boolean) => {
    enabled = value;
    try { window.localStorage.setItem(KEY, String(value)); } catch { /* Session-only preference. */ }
    window.dispatchEvent(new Event(EVENT));
  }] as const;
}
