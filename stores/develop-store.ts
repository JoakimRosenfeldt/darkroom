import { create } from "zustand";
import {
  applyDevelopCommand,
  replayDevelopPatches,
  type DevelopCommand,
  type DevelopPatch,
} from "@/lib/develop/commands";
import { createDefaultDevelopDocument } from "@/lib/develop/document";
import type { EntryMetadata } from "@/lib/catalog/types";
import type {
  DevelopDocument,
  DevelopSettings,
  GlobalDevelopPluginId,
} from "@/lib/develop/types";

export type SidecarStatus = "idle" | "loading" | "saving" | "saved" | "error";
type MetadataValues = Pick<EntryMetadata, "pick" | "rating" | "colorLabel">;

export type HistoryEntry =
  | { kind: "document"; label: string; patches: readonly DevelopPatch[]; editGroup: string | null }
  | { kind: "metadata"; label: string; before: MetadataValues; after: MetadataValues };

export interface DevelopSession {
  document: DevelopDocument;
  documentRevision: number;
  persistedDocumentRevision: number;
  metadataRevision: number;
  persistedMetadataRevision: number;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  ui: {
    selectedMaskId: string | null;
    selectedComponentId: string | null;
    overlayVisible: boolean;
    tool: "none" | "brush" | "linear-gradient" | "radial-gradient";
    sidecarStatus: SidecarStatus;
    sidecarError: string | null;
  };
  transientEdit: { id: string; label: string } | null;
}

type MetadataWriter = (entryId: string, values: MetadataValues) => void;
let metadataWriter: MetadataWriter | null = null;

function metadataValues(metadata: MetadataValues): MetadataValues {
  return {
    pick: metadata.pick,
    rating: metadata.rating,
    colorLabel: metadata.colorLabel,
  };
}

export function setDevelopMetadataWriter(writer: MetadataWriter): void {
  metadataWriter = writer;
}

function createSession(document: DevelopDocument): DevelopSession {
  return {
    document,
    documentRevision: 0,
    persistedDocumentRevision: 0,
    metadataRevision: 0,
    persistedMetadataRevision: 0,
    undo: [],
    redo: [],
    ui: {
      selectedMaskId: null,
      selectedComponentId: null,
      overlayVisible: false,
      tool: "none",
      sidecarStatus: "idle",
      sidecarError: null,
    },
    transientEdit: null,
  };
}

function boundedHistory(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.length > 100 ? entries.slice(entries.length - 100) : entries;
}

function cloneSession(session: DevelopSession): DevelopSession {
  return { ...session, undo: [...session.undo], redo: [...session.redo], ui: { ...session.ui } };
}

function patchTarget(patch: DevelopPatch): string {
  switch (patch.kind) {
    case "global":
      return `global:${patch.pluginId}`;
    case "masking":
      return "masking";
    case "asset":
      return `asset:${patch.assetId}`;
    default: {
      const exhaustive: never = patch;
      return exhaustive;
    }
  }
}

function mergePatch(current: DevelopPatch, next: DevelopPatch): DevelopPatch {
  switch (current.kind) {
    case "masking":
      return next.kind === "masking" ? { ...current, after: next.after } : current;
    case "asset":
      return next.kind === "asset" && next.assetId === current.assetId
        ? { ...current, after: next.after }
        : current;
    case "global": {
      if (next.kind !== "global" || next.pluginId !== current.pluginId) return current;
      switch (current.pluginId) {
        case "basic":
          return next.pluginId === "basic" ? { ...current, after: next.after } : current;
        case "crop":
          return next.pluginId === "crop" ? { ...current, after: next.after } : current;
        case "curve":
          return next.pluginId === "curve" ? { ...current, after: next.after } : current;
        case "mixer":
          return next.pluginId === "mixer" ? { ...current, after: next.after } : current;
        case "effects":
          return next.pluginId === "effects" ? { ...current, after: next.after } : current;
        default: {
          const exhaustive: never = current;
          return exhaustive;
        }
      }
    }
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

function mergeGroupedPatches(
  current: readonly DevelopPatch[],
  next: readonly DevelopPatch[],
): DevelopPatch[] {
  const merged = [...current];
  const targetIndexes = new Map(
    merged.map((patch, index) => [patchTarget(patch), index]),
  );
  for (const patch of next) {
    const target = patchTarget(patch);
    const index = targetIndexes.get(target);
    if (index === undefined) {
      targetIndexes.set(target, merged.length);
      merged.push(patch);
      continue;
    }
    const existing = merged[index];
    if (existing) merged[index] = mergePatch(existing, patch);
  }
  return merged;
}

interface DevelopStore {
  activeEntryId: string | null;
  sessions: Record<string, DevelopSession>;
  showOriginal: boolean;
  activateEntry: (entryId: string, document: DevelopDocument) => void;
  hydrateEntry: (entryId: string, document: DevelopDocument) => void;
  dispatch: (command: DevelopCommand, label?: string) => void;
  updatePlugin: <T extends GlobalDevelopPluginId>(pluginId: T, patch: Partial<DevelopSettings[T]>) => void;
  resetPlugin: (pluginId: GlobalDevelopPluginId) => void;
  resetAll: () => void;
  beginEditGroup: (label: string) => void;
  endEditGroup: () => void;
  undo: () => void;
  redo: () => void;
  recordMetadataEdit: (entryId: string, before: MetadataValues, after: MetadataValues, document?: DevelopDocument) => void;
  markMetadataHydrated: (entryId: string) => void;
  markPersisted: (
    entryId: string,
    documentRevision: number,
    metadataRevision: number,
  ) => void;
  clearLibrarySessions: () => void;
  setShowOriginal: (showOriginal: boolean) => void;
  setSidecarStatus: (status: SidecarStatus, error?: string | null) => void;
  setSelectedMask: (maskId: string | null) => void;
  setSelectedComponent: (componentId: string | null) => void;
  setMaskOverlayVisible: (visible: boolean) => void;
  setMaskTool: (tool: DevelopSession["ui"]["tool"]) => void;
}

function patchCommand(session: DevelopSession, pluginId: GlobalDevelopPluginId, patch: unknown): DevelopCommand {
  const values = typeof patch === "object" && patch !== null ? patch : {};
  switch (pluginId) {
    case "basic":
      return { kind: "replace-global", pluginId, value: Object.assign({}, session.document.settings.basic, values) };
    case "crop":
      return { kind: "replace-global", pluginId, value: Object.assign({}, session.document.settings.crop, values) };
    case "curve":
      return { kind: "replace-global", pluginId, value: Object.assign({}, session.document.settings.curve, values) };
    case "mixer":
      return { kind: "replace-global", pluginId, value: Object.assign({}, session.document.settings.mixer, values) };
    case "effects":
      return { kind: "replace-global", pluginId, value: Object.assign({}, session.document.settings.effects, values) };
    default: {
      const exhaustive: never = pluginId;
      return exhaustive;
    }
  }
}

export const useDevelopStore = create<DevelopStore>((set, get) => ({
  activeEntryId: null,
  sessions: {},
  showOriginal: false,

  activateEntry: (entryId, document) => set((state) => ({
    activeEntryId: entryId,
    sessions: state.sessions[entryId] ? state.sessions : { ...state.sessions, [entryId]: createSession(document) },
    showOriginal: false,
  })),

  hydrateEntry: (entryId, document) => set((state) => {
    const current = state.sessions[entryId];
    if (!current) {
      return { sessions: { ...state.sessions, [entryId]: createSession(document) } };
    }
    if (current.documentRevision !== current.persistedDocumentRevision) return state;
    return {
      sessions: {
        ...state.sessions,
        [entryId]: {
          ...createSession(document),
          documentRevision: current.documentRevision + 1,
          persistedDocumentRevision: current.persistedDocumentRevision + 1,
          metadataRevision: current.metadataRevision,
          persistedMetadataRevision: current.persistedMetadataRevision,
          undo: current.undo.filter((entry) => entry.kind === "metadata"),
          redo: current.redo.filter((entry) => entry.kind === "metadata"),
        },
      },
    };
  }),

  dispatch: (command, label = "Edit") => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    const result = applyDevelopCommand(current.document, command);
    if (!result.changed) return state;
    const session = cloneSession(current);
    const editGroup = session.transientEdit?.id ?? null;
    const previous = session.undo.at(-1);
    if (editGroup && previous?.kind === "document" && previous.editGroup === editGroup) {
      session.undo[session.undo.length - 1] = {
        ...previous,
        patches: mergeGroupedPatches(previous.patches, result.patches),
      };
    } else {
      session.undo = boundedHistory([...session.undo, {
        kind: "document",
        label: session.transientEdit?.label ?? label,
        patches: result.patches,
        editGroup,
      }]);
    }
    session.document = result.document;
    session.documentRevision += 1;
    session.redo = [];
    return { sessions: { ...state.sessions, [entryId]: session } };
  }),

  updatePlugin: (pluginId, patch) => {
    const state = get();
    const session = state.activeEntryId ? state.sessions[state.activeEntryId] : undefined;
    if (session) state.dispatch(patchCommand(session, pluginId, patch), `Adjust ${pluginId}`);
  },
  resetPlugin: (pluginId) => get().dispatch({ kind: "reset-plugin", pluginId }, `Reset ${pluginId}`),
  resetAll: () => get().dispatch({ kind: "reset-all" }, "Reset all"),

  beginEditGroup: (label) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current || current.transientEdit) return state;
    return { sessions: { ...state.sessions, [entryId]: { ...current, transientEdit: { id: crypto.randomUUID(), label } } } };
  }),
  endEditGroup: () => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current?.transientEdit) return state;
    return { sessions: { ...state.sessions, [entryId]: { ...current, transientEdit: null } } };
  }),

  undo: () => {
    const state = get();
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    const history = current?.undo.at(-1);
    if (!entryId || !current || !history) return;
    const session = cloneSession(current);
    session.undo.pop();
    session.redo.push(history);
    session.transientEdit = null;
    if (history.kind === "document") {
      session.documentRevision += 1;
      session.document = replayDevelopPatches(session.document, history.patches, "backward");
    } else {
      session.metadataRevision += 1;
    }
    set({ sessions: { ...state.sessions, [entryId]: session } });
    if (history.kind === "metadata") metadataWriter?.(entryId, history.before);
  },
  redo: () => {
    const state = get();
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    const history = current?.redo.at(-1);
    if (!entryId || !current || !history) return;
    const session = cloneSession(current);
    session.redo.pop();
    session.undo = boundedHistory([...session.undo, history]);
    session.transientEdit = null;
    if (history.kind === "document") {
      session.documentRevision += 1;
      session.document = replayDevelopPatches(session.document, history.patches, "forward");
    } else {
      session.metadataRevision += 1;
    }
    set({ sessions: { ...state.sessions, [entryId]: session } });
    if (history.kind === "metadata") metadataWriter?.(entryId, history.after);
  },

  recordMetadataEdit: (entryId, before, after, document = createDefaultDevelopDocument()) => set((state) => {
    const beforeMetadata = metadataValues(before);
    const afterMetadata = metadataValues(after);
    if (JSON.stringify(beforeMetadata) === JSON.stringify(afterMetadata)) return state;
    const session = cloneSession(state.sessions[entryId] ?? createSession(document));
    session.undo = boundedHistory([...session.undo, {
      kind: "metadata",
      label: "Edit metadata",
      before: beforeMetadata,
      after: afterMetadata,
    }]);
    session.redo = [];
    session.metadataRevision += 1;
    return { sessions: { ...state.sessions, [entryId]: session } };
  }),

  markMetadataHydrated: (entryId) => set((state) => {
    const current = state.sessions[entryId];
    if (!current || current.metadataRevision === current.persistedMetadataRevision) return state;
    return {
      sessions: {
        ...state.sessions,
        [entryId]: {
          ...current,
          persistedMetadataRevision: current.metadataRevision,
        },
      },
    };
  }),

  markPersisted: (entryId, documentRevision, metadataRevision) => set((state) => {
    const current = state.sessions[entryId];
    if (
      !current ||
      documentRevision < current.persistedDocumentRevision ||
      documentRevision > current.documentRevision ||
      metadataRevision < current.persistedMetadataRevision ||
      metadataRevision > current.metadataRevision
    ) return state;
    return {
      sessions: {
        ...state.sessions,
        [entryId]: {
          ...current,
          persistedDocumentRevision: documentRevision,
          persistedMetadataRevision: metadataRevision,
        },
      },
    };
  }),
  clearLibrarySessions: () => set({ activeEntryId: null, sessions: {}, showOriginal: false }),
  setShowOriginal: (showOriginal) => set({ showOriginal }),
  setSidecarStatus: (sidecarStatus, sidecarError = null) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return { sessions: { ...state.sessions, [entryId]: { ...current, ui: { ...current.ui, sidecarStatus, sidecarError } } } };
  }),
  setSelectedMask: (selectedMaskId) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return { sessions: { ...state.sessions, [entryId]: { ...current, ui: { ...current.ui, selectedMaskId } } } };
  }),
  setSelectedComponent: (selectedComponentId) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return { sessions: { ...state.sessions, [entryId]: { ...current, ui: { ...current.ui, selectedComponentId } } } };
  }),
  setMaskOverlayVisible: (overlayVisible) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return { sessions: { ...state.sessions, [entryId]: { ...current, ui: { ...current.ui, overlayVisible } } } };
  }),
  setMaskTool: (tool) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return { sessions: { ...state.sessions, [entryId]: { ...current, ui: { ...current.ui, tool } } } };
  }),
}));

export function activeDevelopSession(state: DevelopStore): DevelopSession | null {
  return state.activeEntryId ? state.sessions[state.activeEntryId] ?? null : null;
}

export function activeDevelopDocument(state: DevelopStore): DevelopDocument {
  return activeDevelopSession(state)?.document ?? createDefaultDevelopDocument();
}
