import { create } from "zustand";
import {
  DEFAULT_DEVELOP_SETTINGS,
  createDevelopSettings,
} from "@/lib/develop/registry";
import type {
  DevelopPluginId,
  DevelopSettings,
} from "@/lib/develop/types";

export type SidecarStatus = "idle" | "loading" | "saving" | "saved" | "error";

interface DevelopStore {
  activeEntryId: string | null;
  settings: DevelopSettings;
  showOriginal: boolean;
  sidecarStatus: SidecarStatus;
  sidecarError: string | null;
  setActiveEntry: (
    entryId: string,
    settings?: Partial<DevelopSettings>,
  ) => void;
  updatePlugin: <T extends DevelopPluginId>(
    pluginId: T,
    patch: Partial<DevelopSettings[T]>,
  ) => void;
  resetPlugin: (pluginId: DevelopPluginId) => void;
  resetAll: () => void;
  setShowOriginal: (showOriginal: boolean) => void;
  setSidecarStatus: (status: SidecarStatus, error?: string | null) => void;
}

export const useDevelopStore = create<DevelopStore>((set) => ({
  activeEntryId: null,
  settings: DEFAULT_DEVELOP_SETTINGS,
  showOriginal: false,
  sidecarStatus: "idle",
  sidecarError: null,

  setActiveEntry: (entryId, settings) =>
    set({
      activeEntryId: entryId,
      settings: createDevelopSettings(settings),
      showOriginal: false,
      sidecarStatus: "idle",
      sidecarError: null,
    }),

  updatePlugin: (pluginId, patch) =>
    set((state) => ({
      settings: {
        ...state.settings,
        [pluginId]: {
          ...state.settings[pluginId],
          ...patch,
        },
      },
    })),

  resetPlugin: (pluginId) =>
    set((state) => ({
      settings: {
        ...state.settings,
        [pluginId]: structuredClone(DEFAULT_DEVELOP_SETTINGS[pluginId]),
      },
    })),

  resetAll: () =>
    set({
      settings: structuredClone(DEFAULT_DEVELOP_SETTINGS),
    }),

  setShowOriginal: (showOriginal) => set({ showOriginal }),

  setSidecarStatus: (sidecarStatus, sidecarError = null) =>
    set({ sidecarStatus, sidecarError }),
}));
