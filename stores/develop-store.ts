import { create } from "zustand";
import type { EntryMetadata } from "@/lib/catalog/types";
import type { DevelopCommand } from "@/lib/develop/commands";
import { createDefaultDevelopDocument } from "@/lib/develop/document";
import {
  clearDevelopSessions,
  createDevelopPluginCommand,
  activateDevelopSession,
  getDevelopSession,
  getOrCreateDevelopSession,
  openDevelopSessionDocument,
  type DevelopHistoryEntry,
  type DevelopMetadataValues,
  type DevelopReadOnlyReason,
  type DevelopSessionOpenDocument,
  type DevelopSessionSnapshot,
} from "@/lib/develop/session";
import type {
  DevelopDocument,
  DevelopSettings,
  GlobalDevelopPluginId,
} from "@/lib/develop/types";
import type {
  V3EditCommand,
  V3SemanticGroupId,
} from "@/lib/develop/v3/commands";
import type {
  PersistedDevelopDocument,
  StoredDevelopDocument,
} from "@/lib/develop/v3/document";

export type SidecarStatus = "idle" | "loading" | "saving" | "saved" | "error";
type MetadataValues = Pick<EntryMetadata, "pick" | "rating" | "colorLabel">;
export type HistoryEntry = DevelopHistoryEntry;

interface DevelopSessionUi {
  selectedMaskId: string | null;
  selectedComponentId: string | null;
  overlayVisible: boolean;
  tool: "none" | "brush" | "linear-gradient" | "radial-gradient";
  sidecarStatus: SidecarStatus;
  sidecarError: string | null;
}

export interface DevelopSessionState {
  processKind: DevelopSessionSnapshot["processKind"];
  persistedDocument: PersistedDevelopDocument | null;
  readOnly: DevelopReadOnlyReason | null;
  document: DevelopDocument;
  documentRevision: number;
  persistedDocumentRevision: number;
  metadataRevision: number;
  persistedMetadataRevision: number;
  undo: readonly DevelopHistoryEntry[];
  redo: readonly DevelopHistoryEntry[];
  transientEdit: { readonly id: string; readonly label: string } | null;
  ui: DevelopSessionUi;
}

type MetadataWriter = (entryId: string, values: DevelopMetadataValues) => void;
let metadataWriter: MetadataWriter | null = null;

export function setDevelopMetadataWriter(writer: MetadataWriter): void {
  metadataWriter = writer;
}

function defaultUi(): DevelopSessionUi {
  return {
    selectedMaskId: null,
    selectedComponentId: null,
    overlayVisible: false,
    tool: "none",
    sidecarStatus: "idle",
    sidecarError: null,
  };
}

function adapterState(
  snapshot: DevelopSessionSnapshot,
  ui: DevelopSessionUi = defaultUi(),
): DevelopSessionState {
  const persistedDocument = snapshot.processKind === "read-only-newer"
    ? null
    : snapshot.document;
  const document = snapshot.processKind === "v2"
    ? snapshot.document
    : snapshot.processKind === "v3" && snapshot.document.compatibility.legacyV2
      ? snapshot.document.compatibility.legacyV2
      : createDefaultDevelopDocument();
  return {
    processKind: snapshot.processKind,
    persistedDocument,
    readOnly: snapshot.readOnly,
    document,
    documentRevision: snapshot.documentRevision,
    persistedDocumentRevision: snapshot.persistedDocumentRevision,
    metadataRevision: snapshot.metadataRevision,
    persistedMetadataRevision: snapshot.persistedMetadataRevision,
    undo: snapshot.undo,
    redo: snapshot.redo,
    transientEdit: snapshot.transientEdit,
    ui,
  };
}

interface DevelopStore {
  activeCatalogId: string | null;
  activeEntryId: string | null;
  sessions: Record<string, DevelopSessionState>;
  showOriginal: boolean;
  activateEntry: (
    catalogId: string,
    entryId: string,
    document: DevelopSessionOpenDocument,
  ) => void;
  hydrateEntry: (
    catalogId: string,
    entryId: string,
    document: DevelopSessionOpenDocument,
  ) => void;
  synchronizeSession: (entryId: string, snapshot: DevelopSessionSnapshot) => void;
  dispatch: (command: DevelopCommand, label?: string) => void;
  dispatchV3: (command: V3EditCommand, label?: string) => void;
  resetV3Group: (group: V3SemanticGroupId) => void;
  resetV3All: () => void;
  updatePlugin: <T extends GlobalDevelopPluginId>(
    pluginId: T,
    patch: Partial<DevelopSettings[T]>,
  ) => void;
  resetPlugin: (pluginId: GlobalDevelopPluginId) => void;
  resetAll: () => void;
  beginEditGroup: (label: string) => void;
  endEditGroup: () => void;
  undo: () => void;
  redo: () => void;
  recordMetadataEdit: (
    catalogId: string,
    entryId: string,
    before: MetadataValues,
    after: MetadataValues,
    document?: StoredDevelopDocument,
  ) => void;
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
  setMaskTool: (tool: DevelopSessionUi["tool"]) => void;
}

function replaceCoreState(
  state: DevelopStore,
  entryId: string,
  snapshot: DevelopSessionSnapshot,
): Pick<DevelopStore, "sessions"> {
  return {
    sessions: {
      ...state.sessions,
      [entryId]: adapterState(snapshot, state.sessions[entryId]?.ui),
    },
  };
}

export const useDevelopStore = create<DevelopStore>((set, get) => ({
  activeCatalogId: null,
  activeEntryId: null,
  sessions: {},
  showOriginal: false,

  activateEntry: (catalogId, entryId, document) => set((state) => {
    const session = getOrCreateDevelopSession(catalogId, entryId, document);
    activateDevelopSession(catalogId, entryId);
    return {
      activeCatalogId: catalogId,
      activeEntryId: entryId,
      sessions: {
        ...state.sessions,
        [entryId]: adapterState(session.snapshot(), state.sessions[entryId]?.ui),
      },
      showOriginal: false,
    };
  }),

  hydrateEntry: (catalogId, entryId, document) => set((state) => {
    const session = getOrCreateDevelopSession(catalogId, entryId, document);
    return replaceCoreState(state, entryId, session.hydrate(document));
  }),

  synchronizeSession: (entryId, snapshot) => set((state) =>
    state.activeCatalogId === snapshot.catalogId
      ? replaceCoreState(state, entryId, snapshot)
      : state),

  dispatch: (command, label = "Edit") => set((state) => {
    const entryId = state.activeEntryId;
    const catalogId = state.activeCatalogId;
    if (!catalogId || !entryId) return state;
    const session = getDevelopSession(catalogId, entryId);
    if (!session) return state;
    if (session.snapshot().processKind !== "v2") return state;
    return replaceCoreState(state, entryId, session.dispatch(command, label));
  }),

  dispatchV3: (command, label = "Edit") => set((state) => {
    const entryId = state.activeEntryId;
    const catalogId = state.activeCatalogId;
    if (!catalogId || !entryId) return state;
    const session = getDevelopSession(catalogId, entryId);
    if (!session || session.snapshot().processKind !== "v3") return state;
    return replaceCoreState(state, entryId, session.dispatch(command, label));
  }),
  resetV3Group: (group) =>
    get().dispatchV3(
      { kind: "reset-v3-semantic-group", group },
      `Reset ${group}`,
    ),
  resetV3All: () => get().dispatchV3({ kind: "reset-v3-all" }, "Reset all"),

  updatePlugin: (pluginId, patch) => {
    const state = get();
    const catalogId = state.activeCatalogId;
    const entryId = state.activeEntryId;
    const session = catalogId && entryId
      ? getDevelopSession(catalogId, entryId)
      : null;
    if (!session) return;
    const snapshot = session.snapshot();
    if (snapshot.processKind !== "v2") return;
    state.dispatch(
      createDevelopPluginCommand(snapshot.document, pluginId, patch),
      `Adjust ${pluginId}`,
    );
  },
  resetPlugin: (pluginId) =>
    get().dispatch({ kind: "reset-plugin", pluginId }, `Reset ${pluginId}`),
  resetAll: () => get().dispatch({ kind: "reset-all" }, "Reset all"),

  beginEditGroup: (label) => set((state) => {
    const entryId = state.activeEntryId;
    const catalogId = state.activeCatalogId;
    const session = catalogId && entryId
      ? getDevelopSession(catalogId, entryId)
      : null;
    return entryId && session
      ? replaceCoreState(state, entryId, session.beginEditGroup(label))
      : state;
  }),
  endEditGroup: () => set((state) => {
    const entryId = state.activeEntryId;
    const catalogId = state.activeCatalogId;
    const session = catalogId && entryId
      ? getDevelopSession(catalogId, entryId)
      : null;
    return entryId && session
      ? replaceCoreState(state, entryId, session.endEditGroup())
      : state;
  }),

  undo: () => {
    const state = get();
    const entryId = state.activeEntryId;
    const catalogId = state.activeCatalogId;
    const session = catalogId && entryId
      ? getDevelopSession(catalogId, entryId)
      : null;
    if (!entryId || !session || session.snapshot().undo.length === 0) return;
    const metadataMutation = session.undo();
    set(replaceCoreState(state, entryId, session.snapshot()));
    if (metadataMutation) {
      metadataWriter?.(metadataMutation.entryId, metadataMutation.values);
    }
  },
  redo: () => {
    const state = get();
    const entryId = state.activeEntryId;
    const catalogId = state.activeCatalogId;
    const session = catalogId && entryId
      ? getDevelopSession(catalogId, entryId)
      : null;
    if (!entryId || !session || session.snapshot().redo.length === 0) return;
    const metadataMutation = session.redo();
    set(replaceCoreState(state, entryId, session.snapshot()));
    if (metadataMutation) {
      metadataWriter?.(metadataMutation.entryId, metadataMutation.values);
    }
  },

  recordMetadataEdit: (
    catalogId,
    entryId,
    before,
    after,
    document = createDefaultDevelopDocument(),
  ) => set((state) => {
    const session = getOrCreateDevelopSession(
      catalogId,
      entryId,
      openDevelopSessionDocument(document),
    );
    return replaceCoreState(
      state,
      entryId,
      session.recordMetadataEdit(before, after),
    );
  }),

  markMetadataHydrated: (entryId) => set((state) => {
    const session = state.activeCatalogId
      ? getDevelopSession(state.activeCatalogId, entryId)
      : null;
    return session
      ? replaceCoreState(state, entryId, session.markMetadataHydrated())
      : state;
  }),

  markPersisted: (entryId, documentRevision, metadataRevision) => set((state) => {
    const session = state.activeCatalogId
      ? getDevelopSession(state.activeCatalogId, entryId)
      : null;
    return session
      ? replaceCoreState(
          state,
          entryId,
          session.markPersisted(documentRevision, metadataRevision),
        )
      : state;
  }),

  clearLibrarySessions: () => {
    clearDevelopSessions();
    set({
      activeCatalogId: null,
      activeEntryId: null,
      sessions: {},
      showOriginal: false,
    });
  },
  setShowOriginal: (showOriginal) => set({ showOriginal }),
  setSidecarStatus: (sidecarStatus, sidecarError = null) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return {
      sessions: {
        ...state.sessions,
        [entryId]: {
          ...current,
          ui: { ...current.ui, sidecarStatus, sidecarError },
        },
      },
    };
  }),
  setSelectedMask: (selectedMaskId) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return {
      sessions: {
        ...state.sessions,
        [entryId]: {
          ...current,
          ui: { ...current.ui, selectedMaskId },
        },
      },
    };
  }),
  setSelectedComponent: (selectedComponentId) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return {
      sessions: {
        ...state.sessions,
        [entryId]: {
          ...current,
          ui: { ...current.ui, selectedComponentId },
        },
      },
    };
  }),
  setMaskOverlayVisible: (overlayVisible) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return {
      sessions: {
        ...state.sessions,
        [entryId]: {
          ...current,
          ui: { ...current.ui, overlayVisible },
        },
      },
    };
  }),
  setMaskTool: (tool) => set((state) => {
    const entryId = state.activeEntryId;
    const current = entryId ? state.sessions[entryId] : undefined;
    if (!entryId || !current) return state;
    return {
      sessions: {
        ...state.sessions,
        [entryId]: { ...current, ui: { ...current.ui, tool } },
      },
    };
  }),
}));

export function activeDevelopSession(state: DevelopStore): DevelopSessionState | null {
  return state.activeEntryId ? state.sessions[state.activeEntryId] ?? null : null;
}

export function activeDevelopDocument(state: DevelopStore): DevelopDocument {
  return activeDevelopSession(state)?.document ?? createDefaultDevelopDocument();
}
