"use client";

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useEffectEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { PreferencesDialog } from "@/components/shell/PreferencesDialog";
import { useLibraryViewSettings } from "@/hooks/useLibraryViewSettings";
import { useWorkspacePreferences } from "@/hooks/useWorkspacePreferences";
import {
  APP_MENU_ACTIONS,
  appMenuOverlayOpen,
  useAppMenuOverlayOpen,
  useRouteMenuActions,
  type AppMenuAction,
  type AppMenuActions,
} from "@/lib/app-menu";
import { useLibraryStore } from "@/stores/library-store";

const CHECKED_ACTIONS = [
  "grid-dynamic", "grid-square", "sort-name", "sort-date", "sort-rating", "sort-pick",
  "sort-ascending", "sort-descending", "auto-advance", "show-filmstrip", "linked-compare",
] as const satisfies readonly AppMenuAction[];

let menuStateUpdate = Promise.resolve();

export function AppMenu() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [menuVersion, setMenuVersion] = useState(0);
  const [view, updateView] = useLibraryViewSettings();
  const [workspace, updateWorkspace] = useWorkspacePreferences();
  const routeActions = useRouteMenuActions();
  const overlayOpen = useAppMenuOverlayOpen();
  const importState = useLibraryStore((state) => state.importState);
  const catalogId = useLibraryStore((state) => state.catalogId);
  const openCatalogManager = useLibraryStore((state) => state.openCatalogManager);
  const addCatalogRoot = useLibraryStore((state) => state.addCatalogRoot);
  const libraryOpen = pathname === "/";
  const desktopReady = isTauri() && importState === "idle";

  function manageCatalogs() {
    navigate("/");
    openCatalogManager();
  }

  const actions: AppMenuActions = {
    ...routeActions,
    preferences: () => setPreferencesOpen(true),
    "manage-catalogs": desktopReady ? manageCatalogs : undefined,
    "import-folder": desktopReady ? () => {
      if (!catalogId) {
        manageCatalogs();
        return;
      }
      navigate("/");
      void addCatalogRoot();
    } : undefined,
    library: !libraryOpen ? () => navigate("/") : undefined,
    "grid-dynamic": libraryOpen ? () => updateView({ viewMode: "dynamic" }) : undefined,
    "grid-square": libraryOpen ? () => updateView({ viewMode: "grid" }) : undefined,
    "thumbnails-smaller": libraryOpen && view.thumbSize > 120
      ? () => updateView({ thumbSize: Math.max(120, view.thumbSize - 20) }) : undefined,
    "thumbnails-larger": libraryOpen && view.thumbSize < 320
      ? () => updateView({ thumbSize: Math.min(320, view.thumbSize + 20) }) : undefined,
    "sort-name": libraryOpen ? () => updateView({ sort: "name" }) : undefined,
    "sort-date": libraryOpen ? () => updateView({ sort: "date" }) : undefined,
    "sort-rating": libraryOpen ? () => updateView({ sort: "rating" }) : undefined,
    "sort-pick": libraryOpen ? () => updateView({ sort: "pick" }) : undefined,
    "sort-ascending": libraryOpen ? () => updateView({ sortDirection: "ascending" }) : undefined,
    "sort-descending": libraryOpen ? () => updateView({ sortDirection: "descending" }) : undefined,
    "auto-advance": () => updateView({ autoAdvance: !view.autoAdvance }),
    "show-filmstrip": pathname === "/photo"
      ? () => updateWorkspace({ showFilmstrip: !workspace.showFilmstrip }) : undefined,
    "linked-compare": pathname === "/compare"
      ? () => updateWorkspace({ linkedCompare: !workspace.linkedCompare }) : undefined,
  };
  const checked: Partial<Record<AppMenuAction, boolean>> = {
    "grid-dynamic": view.viewMode === "dynamic",
    "grid-square": view.viewMode === "grid",
    "sort-name": view.sort === "name",
    "sort-date": view.sort === "date",
    "sort-rating": view.sort === "rating",
    "sort-pick": view.sort === "pick",
    "sort-ascending": view.sortDirection === "ascending",
    "sort-descending": view.sortDirection === "descending",
    "auto-advance": view.autoAdvance,
    "show-filmstrip": workspace.showFilmstrip,
    "linked-compare": workspace.linkedCompare,
  };
  const enabledKey = APP_MENU_ACTIONS.filter((id) => !overlayOpen && actions[id]).join(",");
  const checkedKey = CHECKED_ACTIONS.filter((id) => checked[id]).join(",");

  const handleAction = useEffectEvent((id: string) => {
    // Native check items toggle before emitting, including the selected sort option.
    setMenuVersion((version) => version + 1);
    if (appMenuOverlayOpen() || !APP_MENU_ACTIONS.some((action) => action === id)) return;
    actions[id as AppMenuAction]?.();
  });

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("darkroom:menu-action", ({ payload }) => handleAction(payload)).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error: unknown) => console.error("Could not listen to the app menu.", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    function openPreferences() {
      if (!appMenuOverlayOpen()) setPreferencesOpen(true);
    }
    window.addEventListener("darkroom:open-preferences", openPreferences);
    return () => window.removeEventListener("darkroom:open-preferences", openPreferences);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const enabled = new Set(enabledKey.split(","));
    const selected = new Set(checkedKey.split(","));
    menuStateUpdate = menuStateUpdate.then(() => invoke<void>("darkroom_menu_state", {
      enabled: Object.fromEntries(APP_MENU_ACTIONS.map((id) => [id, enabled.has(id)])),
      checked: Object.fromEntries(CHECKED_ACTIONS.map((id) => [id, selected.has(id)])),
    })).catch((error: unknown) => console.error("Could not update the app menu.", error));
  }, [enabledKey, checkedKey, menuVersion]);

  return preferencesOpen ? <PreferencesDialog onClose={() => setPreferencesOpen(false)} /> : null;
}
