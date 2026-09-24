import { useEffect, useSyncExternalStore } from "react";
import type { EntryMetadata } from "@/lib/catalog/types";

export const APP_MENU_ACTIONS = [
  "import-folder", "manage-catalogs", "export", "open-develop", "compare-selected",
  "pick", "reject", "clear-flag", "rating-0", "rating-1", "rating-2", "rating-3", "rating-4", "rating-5",
  "library", "grid-dynamic", "grid-square", "thumbnails-smaller", "thumbnails-larger",
  "sort-name", "sort-date", "sort-rating", "sort-pick", "sort-ascending", "sort-descending",
  "auto-advance", "show-filmstrip", "linked-compare", "preferences",
] as const;

export type AppMenuAction = (typeof APP_MENU_ACTIONS)[number];
export type AppMenuActions = Partial<Record<AppMenuAction, (() => void) | undefined>>;

const EMPTY_ACTIONS: AppMenuActions = {};
let routeActions = EMPTY_ACTIONS;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAppMenuActions(actions: AppMenuActions) {
  useEffect(() => {
    routeActions = actions;
    listeners.forEach((listener) => listener());
    return () => {
      if (routeActions === actions) {
        routeActions = EMPTY_ACTIONS;
        listeners.forEach((listener) => listener());
      }
    };
  }, [actions]);
}

export function useRouteMenuActions() {
  return useSyncExternalStore(subscribe, () => routeActions, () => EMPTY_ACTIONS);
}

export function metadataMenuActions(apply: (patch: Partial<EntryMetadata>) => void): AppMenuActions {
  return {
    pick: () => apply({ pick: "pick" }),
    reject: () => apply({ pick: "reject" }),
    "clear-flag": () => apply({ pick: "none" }),
    "rating-0": () => apply({ rating: 0 }),
    "rating-1": () => apply({ rating: 1 }),
    "rating-2": () => apply({ rating: 2 }),
    "rating-3": () => apply({ rating: 3 }),
    "rating-4": () => apply({ rating: 4 }),
    "rating-5": () => apply({ rating: 5 }),
  };
}

export function appMenuOverlayOpen() {
  return document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

function subscribeToOverlays(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["role", "open"],
  });
  return () => observer.disconnect();
}

export function useAppMenuOverlayOpen() {
  return useSyncExternalStore(subscribeToOverlays, appMenuOverlayOpen, () => false);
}
