import { create } from "zustand";
import { formatPickerError } from "@/lib/fs/access";
import {
  activateCatalog,
  addCatalogRoot as addCatalogRootSession,
  bootstrapCatalog,
  backupCatalogAdmin,
  cancelCatalogScan,
  clearSessionCatalog,
  closeActiveCatalog,
  createCatalog as createCatalogSession,
  getActiveCatalogView,
  queryActiveCatalog,
  relinkCatalogRoot as relinkCatalogRootSession,
  removeCatalog as removeCatalogSession,
  renameActiveCatalog,
  scanCatalogRoot,
  scheduleCatalogStateSync,
  subscribeCatalogState,
  switchCatalog as switchCatalogSession,
  type CatalogRootState,
  type HydratedCatalogState,
  type ScanProgress,
} from "@/lib/fs/session-catalog";
import type {
  CatalogActivationResult,
  CatalogPresetView,
  CatalogSummary,
} from "@/lib/catalog/api";
import {
  createOperationId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "@/lib/catalog/ids";
import type { CatalogV3FingerprintCoverage } from "@/lib/catalog/v3";
import type { SessionId } from "@/lib/catalog/runtime";
import {
  getEntryMetadata,
  createEntryMetadata,
} from "@/lib/catalog/defaults";
import type {
  Album,
  EntryMetadata,
} from "@/lib/catalog/types";
import { filterArchivedEntries, filterOnlyArchivedEntries } from "@/lib/library/archive";
import { pruneMetadataForEntries } from "@/lib/library/curation";
import { pruneAlbumsForEntries } from "@/lib/library/folders";
import {
  createLibraryWorkspaceState,
  entryAnalysisCacheSignature,
  type CollectionNode,
  type SmartRuleGroup,
  type LibraryWorkspaceState,
} from "@/lib/library/model";
import type { MetadataAnalysisProgress } from "@/lib/library/metadata-analysis";
import {
  effectiveMetadataValue,
  parseMetadataOverrides,
  parseMetadataPreset,
  type MetadataEditableField,
  type MetadataOverrides,
  type MetadataPreset,
  type MetadataValue,
} from "@/lib/metadata/types";
import type { ExactDuplicateTrashResult } from "@/lib/library/duplicate-actions";
import { reconcileSelectionToResult } from "@/lib/library/result";
import {
  getVisibleLibraryResult,
  readAutoAdvancePreference,
} from "@/lib/library/result-session";
import { getDarkroomAPI } from "@/lib/fs/platform";
import { getAssetRequest } from "@/lib/fs/session-catalog";
import type { LibraryEntry } from "@/lib/fs/types";
import { createDefaultV3DevelopDocument } from "@/lib/develop/v3/document";
import { writeKeywordSidecar } from "@/lib/develop/keyword-sidecar";
import {
  parseMetadataXmp,
  reconcileMetadataXmp,
  serializeMetadataXmp,
} from "@/lib/develop/xmp";
import { setDevelopMetadataWriter, useDevelopStore } from "@/stores/develop-store";

const fsDebug = (...args: unknown[]) => console.log("[darkroom:fs]", ...args);
const fsDebugError = (step: string, error: unknown) =>
  console.error("[darkroom:fs]", step, error);

export type ImportState = "idle" | "importing" | "restoring" | "error";

export interface SelectEntryModifiers {
  shift?: boolean;
  toggle?: boolean;
}

export interface MetadataAnalysisState {
  operationId: OperationId;
  total: number;
  completed: number;
  failed: number;
  cancelled: boolean;
}

type SidecarMetadataPatch = Partial<Pick<EntryMetadata, "rating" | "colorLabel">>;

interface DevelopCatalogPersistence {
  readonly document?: EntryMetadata["develop"];
  readonly sourceUpdatedAt: number;
  readonly metadataPatch: SidecarMetadataPatch;
}

export type CatalogView =
  | { type: "all" }
  | { type: "folder"; path: string | null }
  | { type: "album"; albumId: string }
  | { type: "smart"; collectionId: string }
  | { type: "quick" }
  | { type: "archive" }
  | { type: "duplicates" };

interface LibraryStore {
  catalogId: CatalogId | null;
  sessionId: SessionId | null;
  catalogRevision: number;
  folderName: string | null;
  entries: LibraryEntry[];
  unresolvedEntries: LibraryEntry[];
  fingerprintCoverage: CatalogV3FingerprintCoverage;
  importPresets: readonly CatalogPresetView[];
  albums: Album[];
  archivedEntryIds: string[];
  libraryWorkspace: LibraryWorkspaceState;
  catalogs: readonly CatalogSummary[];
  catalogRoots: readonly CatalogRootState[];
  catalogManagerOpen: boolean;
  catalogView: CatalogView;
  importState: ImportState;
  hasBootstrapped: boolean;
  importStatus: string | null;
  importError: string | null;
  metadataAnalysis: MetadataAnalysisState | null;
  catalogRecovery: string | null;
  needsFolderAccess: boolean;
  selectedEntryId: string | null;
  selectedEntryIds: string[];
  selectionAnchorId: string | null;
  entryMetadata: Record<string, EntryMetadata>;
  setSelectedEntryId: (id: string | null) => void;
  restoreViewerSelection: (
    selectedEntryIds: readonly string[],
    activeEntryId: string,
    focusedEntryId: string | null,
  ) => void;
  clearSelection: () => void;
  selectEntry: (
    id: string,
    modifiers: SelectEntryModifiers,
    visibleOrder: string[],
  ) => void;
  reconcileSelection: (visibleEntryIds: readonly string[]) => void;
  setEntryMetadata: (entryId: string, patch: Partial<EntryMetadata>) => void;
  applyMetadataToEntries: (
    entryIds: string[],
    patch: Partial<EntryMetadata>,
  ) => void;
  applyMetadataOverrides: (
    entryIds: readonly string[],
    overrides: MetadataOverrides,
    options?: {
      readonly captionMode?: "replace" | "append";
      readonly keywordMode?: "replace" | "append";
    },
  ) => void;
  resetMetadataFields: (
    entryIds: readonly string[],
    fields: readonly MetadataEditableField[],
  ) => void;
  saveMetadataPreset: (preset: MetadataPreset) => void;
  deleteMetadataPreset: (presetId: string) => void;
  publishMetadataXmp: (
    entryId: string,
    resolution?: "merge" | "catalog-wins" | "sidecar-wins",
  ) => Promise<"published" | "conflict" | "reloaded">;
  mirrorDevelopDocument: (
    entryId: string,
    develop: EntryMetadata["develop"],
    sourceUpdatedAt?: number,
    metadataPatch?: SidecarMetadataPatch,
  ) => void;
  persistDevelopState: (
    catalogId: string,
    entryId: string,
    input: DevelopCatalogPersistence,
  ) => Promise<void>;
  hydrateEntryMetadata: (
    entryId: string,
    patch: SidecarMetadataPatch,
    sourceUpdatedAt: number,
  ) => void;
  restoreEntryMetadata: (
    entryId: string,
    patch: Pick<EntryMetadata, "pick" | "rating" | "colorLabel">,
  ) => void;
  setCatalogView: (view: CatalogView) => void;
  createAlbum: (name: string, parentId?: string | null) => string;
  createCollectionSet: (name: string, parentId?: string | null) => string;
  createSmartAlbum: (
    name: string,
    rule: SmartRuleGroup,
    parentId?: string | null,
  ) => string;
  updateSmartAlbumRule: (collectionId: string, rule: SmartRuleGroup) => void;
  duplicateSmartAlbum: (collectionId: string) => string;
  renameCollection: (collectionId: string, name: string) => void;
  moveCollection: (collectionId: string, parentId: string | null) => void;
  reorderCollection: (collectionId: string, direction: -1 | 1) => void;
  deleteCollection: (collectionId: string, deleteDescendants?: boolean) => void;
  renameAlbum: (albumId: string, name: string) => void;
  deleteAlbum: (albumId: string) => void;
  addEntriesToAlbum: (albumId: string, entryIds: string[]) => void;
  removeEntriesFromAlbum: (albumId: string, entryIds: string[]) => void;
  removeEntriesFromAllAlbums: (entryIds: string[]) => void;
  archiveEntries: (entryIds: string[]) => void;
  restoreEntries: (entryIds: string[]) => void;
  toggleQuickEntries: (entryIds: string[]) => void;
  clearQuickCollection: () => void;
  setTargetAlbum: (albumId: string | null) => void;
  addEntriesToTarget: (entryIds: string[]) => void;
  createKeyword: (name: string, parentId?: string | null) => string;
  renameKeyword: (keywordId: string, name: string) => void;
  moveKeyword: (keywordId: string, parentId: string | null) => void;
  mergeKeyword: (sourceId: string, targetId: string) => void;
  deleteKeyword: (keywordId: string, deleteSubtree?: boolean) => void;
  assignKeywordToEntries: (keywordId: string, entryIds: string[]) => void;
  removeKeywordFromEntries: (keywordId: string, entryIds: string[]) => void;
  hydrateEntryKeywords: (
    entryId: string,
    flat: readonly string[],
    hierarchical: readonly string[],
  ) => void;
  stackEntries: (entryIds: string[]) => string;
  addEntriesToStack: (stackId: string, entryIds: string[]) => void;
  removeEntriesFromStack: (stackId: string, entryIds: string[]) => void;
  reorderStackEntry: (stackId: string, entryId: string, direction: -1 | 1) => void;
  unstackEntries: (entryIds: string[]) => void;
  setStackCover: (stackId: string, entryId: string) => void;
  excludeEntries: (entryIds: string[]) => void;
  restoreExcludedEntries: (entryIds: string[]) => void;
  trashExactDuplicates: (keeperId: string, targetIds: string[]) => Promise<ExactDuplicateTrashResult>;
  deleteEntriesFromDisk: (entryIds: string[]) => Promise<void>;
  createCatalog: (displayName: string) => Promise<void>;
  addCatalogRoot: () => Promise<void>;
  relinkCatalogRoot: (rootId?: RootId) => Promise<void>;
  renameCatalog: (displayName: string) => Promise<void>;
  removeCatalogRecent: (catalogId: CatalogId) => Promise<void>;
  deleteCatalog: (catalogId: CatalogId, confirmation: string) => Promise<void>;
  switchCatalog: (catalogId: CatalogId) => Promise<void>;
  openCatalogManager: () => void;
  closeCatalogManager: () => void;
  refreshCatalogs: () => Promise<void>;
  cancelFolderOperation: () => void;
  refreshMetadataAnalysis: () => void;
  refreshEntryMetadataAnalysis: (entryId: string) => void;
  cancelMetadataAnalysis: () => void;
  clearLibrary: () => Promise<void>;
  bootstrapLibrary: () => Promise<void>;
}

let folderOperationGeneration = 0;
let metadataProgressUnsubscribe: (() => void) | null = null;
let autoAdvanceGeneration = 0;

const METADATA_EDITABLE_FIELDS: readonly MetadataEditableField[] = [
  "title", "caption", "copyright", "keywords", "captureTime", "latitude", "longitude",
];

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const EMPTY_FINGERPRINT_COVERAGE: CatalogV3FingerprintCoverage = {
  total: 0,
  missing: 0,
  hashing: 0,
  valid: 0,
  stale: 0,
  failed: 0,
};

function beginFolderOperation(): number {
  folderOperationGeneration += 1;
  return folderOperationGeneration;
}

function isActiveFolderOperation(generation: number): boolean {
  return generation === folderOperationGeneration;
}

function restoreSelection(
  entries: LibraryEntry[],
  previousIds: string[],
  previousAnchor: string | null,
): {
  selectedEntryIds: string[];
  selectedEntryId: string | null;
  selectionAnchorId: string | null;
} {
  const validIds = previousIds.filter((id) => entries.some((entry) => entry.id === id));
  const selectedEntryIds = validIds.length > 0
    ? validIds
    : entries[0] ? [entries[0].id] : [];
  const anchorValid = previousAnchor !== null && entries.some((entry) => entry.id === previousAnchor);
  return {
    selectedEntryIds,
    selectedEntryId: selectedEntryIds.at(-1) ?? null,
    selectionAnchorId: anchorValid ? previousAnchor : selectedEntryIds[0] ?? null,
  };
}

function nextCollectionOrder(
  collections: readonly CollectionNode[],
  parentId: string | null,
): number {
  return collections.reduce(
    (highest, node) => node.parentId === parentId ? Math.max(highest, node.order + 1) : highest,
    0,
  );
}

function descendantCollectionIds(
  collections: readonly CollectionNode[],
  collectionId: string,
): Set<string> {
  const descendants = new Set<string>();
  const pending = [collectionId];
  while (pending.length > 0) {
    const parentId = pending.pop();
    if (parentId === undefined) continue;
    for (const node of collections) {
      if (node.parentId === parentId && !descendants.has(node.id)) {
        descendants.add(node.id);
        pending.push(node.id);
      }
    }
  }
  return descendants;
}

function pruneWorkspaceForEntries(
  workspace: LibraryWorkspaceState,
  validEntryIds: ReadonlySet<string>,
): LibraryWorkspaceState {
  const entryKeywordIds = Object.fromEntries(
    Object.entries(workspace.entryKeywordIds).filter(([entryId]) => validEntryIds.has(entryId)),
  );
  const analysisByEntryId = Object.fromEntries(
    Object.entries(workspace.analysisByEntryId).filter(([entryId]) => validEntryIds.has(entryId)),
  );
  const metadataOverridesByEntryId = Object.fromEntries(
    Object.entries(workspace.metadataOverridesByEntryId)
      .filter(([entryId]) => validEntryIds.has(entryId)),
  );
  const metadataSyncByEntryId = Object.fromEntries(
    Object.entries(workspace.metadataSyncByEntryId)
      .filter(([entryId]) => validEntryIds.has(entryId)),
  );
  return {
    ...workspace,
    quickEntryIds: workspace.quickEntryIds.filter((id) => validEntryIds.has(id)),
    entryKeywordIds,
    archiveMemberships: workspace.archiveMemberships.filter((item) => validEntryIds.has(item.entryId)),
    excludedEntryIds: workspace.excludedEntryIds.filter((id) => validEntryIds.has(id)),
    analysisByEntryId,
    metadataOverridesByEntryId,
    metadataSyncByEntryId,
    stacks: workspace.stacks.flatMap((stack) => {
      const entryIds = stack.entryIds.filter((id) => validEntryIds.has(id));
      if (entryIds.length < 2) return [];
      return [{
        ...stack,
        entryIds,
        coverEntryId: entryIds.includes(stack.coverEntryId) ? stack.coverEntryId : entryIds[0],
        updatedAt: Date.now(),
      }];
    }),
  };
}

interface CatalogSessionBinding {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
}

function catalogSessionIsCurrent(
  binding: CatalogSessionBinding,
  get: () => LibraryStore,
): boolean {
  const current = get();
  return current.catalogId === binding.catalogId && current.sessionId === binding.sessionId;
}

function requireCatalogSession(
  binding: CatalogSessionBinding,
  get: () => LibraryStore,
  message: string,
): void {
  if (!catalogSessionIsCurrent(binding, get)) throw new Error(message);
}

function removeEntriesForAssets(
  assetIds: ReadonlySet<AssetId>,
  binding: CatalogSessionBinding,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  if (assetIds.size === 0) return;
  requireCatalogSession(
    binding,
    get,
    "Catalog changed before removed photos could be reconciled. Reopen the original catalog.",
  );
  const current = get();
  const entries = current.entries.filter((entry) => !assetIds.has(entry.assetId));
  const remainingIds = new Set<string>(entries.map((entry) => entry.id));
  const entryMetadata = pruneMetadataForEntries(current.entryMetadata, remainingIds);
  const albums = pruneAlbumsForEntries(current.albums, remainingIds);
  const archivedEntryIds = current.archivedEntryIds.filter((id) => remainingIds.has(id));
  const libraryWorkspace = pruneWorkspaceForEntries(current.libraryWorkspace, remainingIds);
  const visible = current.catalogView.type === "archive"
    ? filterOnlyArchivedEntries(entries, archivedEntryIds)
    : filterArchivedEntries(entries, archivedEntryIds);
  set({
    entries,
    entryMetadata,
    albums,
    archivedEntryIds,
    libraryWorkspace,
    importError: null,
    ...restoreSelection(
      visible,
      current.selectedEntryIds.filter((id) => remainingIds.has(id)),
      current.selectionAnchorId,
    ),
  });
  scheduleStateSync(set, get);
}

function keywordPath(
  keywordId: string,
  workspace: LibraryWorkspaceState,
): string {
  const byId = new Map(workspace.keywords.map((keyword) => [keyword.id, keyword]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(keywordId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.join("|");
}

function persistKeywordSidecars(
  entryIds: readonly string[],
  workspace: LibraryWorkspaceState,
  entries: readonly LibraryEntry[],
  set: (partial: Partial<LibraryStore>) => void,
): void {
  const keywordById = new Map(workspace.keywords.map((keyword) => [keyword.id, keyword]));
  for (const entryId of [...new Set(entryIds)]) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry) continue;
    const assigned = workspace.entryKeywordIds[entryId] ?? [];
    const flat = assigned.flatMap((id) => {
      const keyword = keywordById.get(id);
      return keyword ? [keyword.name, ...keyword.synonyms] : [];
    });
    const hierarchical = assigned.map((id) => keywordPath(id, workspace)).filter(Boolean);
    void writeKeywordSidecar(entry, flat, hierarchical).catch((error: unknown) => {
      set({ importError: `Keyword sidecar conflict: ${formatPickerError(error)}` });
    });
  }
}

function applyHydratedState(
  state: HydratedCatalogState,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  const catalogChanged = get().catalogId !== state.catalogId;
  const sessionChanged = catalogChanged || get().sessionId !== state.sessionId;
  if (catalogChanged) {
    useDevelopStore.getState().clearLibrarySessions();
  }
  const activeEntries = filterArchivedEntries(state.entries, state.archivedEntryIds);
  set({
    catalogId: state.catalogId,
    sessionId: state.sessionId,
    catalogRevision: state.revision,
    folderName: state.displayName,
    entries: state.entries,
    unresolvedEntries: state.unresolvedEntries,
    fingerprintCoverage: state.fingerprintCoverage,
    importPresets: state.importPresets,
    catalogRoots: state.roots,
    entryMetadata: state.entryMetadata,
    albums: state.albums,
    archivedEntryIds: state.archivedEntryIds,
    libraryWorkspace: state.libraryWorkspace,
    ...restoreSelection(activeEntries, get().selectedEntryIds, get().selectionAnchorId),
    needsFolderAccess: false,
    importError: null,
    catalogRecovery: null,
    metadataAnalysis: sessionChanged ? null : get().metadataAnalysis,
  });
}

async function persistStateSync(
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): Promise<void> {
  const catalogId = get().catalogId;
  const sessionId = get().sessionId;
  if (catalogId === null || sessionId === null) {
    throw new Error("Open the original catalog before saving Develop settings.");
  }
  const { entryMetadata, albums, archivedEntryIds, libraryWorkspace } = get();
  try {
    const revision = await scheduleCatalogStateSync(
      entryMetadata,
      albums,
      archivedEntryIds,
      libraryWorkspace,
    );
    if (get().catalogId === catalogId && get().sessionId === sessionId) {
      set({ catalogRevision: revision });
    }
  } catch (error) {
    if (get().catalogId === catalogId && get().sessionId === sessionId) {
      try {
        const state = await queryActiveCatalog();
        if (get().catalogId === catalogId && get().sessionId === sessionId) {
          applyHydratedState(state, set, get);
        }
      } catch {
        // The original sync error remains the actionable failure.
      }
      set({ importError: formatPickerError(error) });
    }
    throw error;
  }
}

function scheduleStateSync(
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  void persistStateSync(set, get).catch(() => undefined);
}

function applyLocalMetadata(
  entryIds: string[],
  patch: Partial<EntryMetadata>,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  if (entryIds.length === 0) return;
  const resultBefore = getVisibleLibraryResult();
  const visibleBefore = resultBefore.entryIds;
  const activeEntryId = entryIds.length === 1 ? entryIds[0] ?? null : null;
  const activeIndex = activeEntryId === null ? -1 : visibleBefore.indexOf(activeEntryId);
  const shouldAutoAdvance = activeEntryId !== null &&
    activeIndex >= 0 &&
    readAutoAdvancePreference() &&
    (patch.pick !== undefined || patch.rating !== undefined || patch.colorLabel !== undefined);
  const { entryMetadata } = get();
  const updated = { ...entryMetadata };
  const updatedAt = Date.now();
  const history: Array<{ entryId: string; before: EntryMetadata; after: EntryMetadata }> = [];
  for (const entryId of entryIds) {
    const before = getEntryMetadata(updated, entryId);
    const after = createEntryMetadata({ ...before, ...patch, updatedAt });
    updated[entryId] = after;
    history.push({ entryId, before, after });
  }
  set({ entryMetadata: updated });
  const catalogId = get().catalogId;
  if (catalogId) {
    for (const item of history) {
      useDevelopStore.getState().recordMetadataEdit(
        catalogId,
        item.entryId,
        item.before,
        item.after,
        item.before.develop ?? createDefaultV3DevelopDocument(),
      );
    }
  }
  scheduleStateSync(set, get);
  if (shouldAutoAdvance) {
    const generation = ++autoAdvanceGeneration;
    const reconcile = (attempt: number) => {
      if (generation !== autoAdvanceGeneration || get().selectedEntryId !== activeEntryId) return;
      const resultAfter = getVisibleLibraryResult();
      if (resultAfter.revision === resultBefore.revision && attempt < 2) {
        globalThis.setTimeout(() => reconcile(attempt + 1), 0);
        return;
      }
      const currentIds = new Set(resultAfter.entryIds);
      const nextId = visibleBefore.slice(activeIndex + 1).find((id) => currentIds.has(id)) ??
        (currentIds.has(activeEntryId) ? activeEntryId : undefined) ??
        [...visibleBefore.slice(0, activeIndex)].reverse().find((id) => currentIds.has(id));
      if (nextId === undefined) {
        set({ selectedEntryId: null, selectedEntryIds: [], selectionAnchorId: null });
        return;
      }
      set({
        selectedEntryId: nextId,
        selectedEntryIds: [nextId],
        selectionAnchorId: nextId,
      });
    };
    globalThis.setTimeout(() => reconcile(0), 0);
  }
}

const ABSENT_METADATA_VALUE: MetadataValue<never> = { kind: "absent" };

function mergeMetadataOverrides(
  current: MetadataOverrides,
  patch: MetadataOverrides,
  analysis: LibraryWorkspaceState["analysisByEntryId"][string] | undefined,
  options: {
    readonly captionMode?: "replace" | "append";
    readonly keywordMode?: "replace" | "append";
  },
): MetadataOverrides {
  let caption = patch.caption;
  if (caption?.kind === "set" && options.captionMode === "append") {
    const existing = effectiveMetadataValue(
      analysis?.source?.description.caption ?? ABSENT_METADATA_VALUE,
      current.caption,
    );
    caption = {
      kind: "set",
      value: existing && existing.trim().length > 0
        ? `${existing}\n${caption.value}`
        : caption.value,
    };
  }
  let keywords = patch.keywords;
  if (keywords?.kind === "set" && options.keywordMode === "append") {
    const existing = effectiveMetadataValue(
      analysis?.source?.description.keywords ?? ABSENT_METADATA_VALUE,
      current.keywords,
    ) ?? [];
    keywords = {
      kind: "set",
      value: [...new Map(
        [...existing, ...keywords.value].map((keyword) => [keyword.toLocaleLowerCase(), keyword]),
      ).values()],
    };
  }
  return parseMetadataOverrides({
    ...current,
    ...patch,
    ...(caption === undefined ? {} : { caption }),
    ...(keywords === undefined ? {} : { keywords }),
  });
}

function metadataPatchFromOverrides(
  patch: MetadataOverrides,
  merged: MetadataOverrides,
): Partial<EntryMetadata> {
  return {
    ...(patch.title === undefined
      ? {}
      : { title: merged.title?.kind === "set" ? merged.title.value : null }),
    ...(patch.caption === undefined
      ? {}
      : { caption: merged.caption?.kind === "set" ? merged.caption.value : null }),
    ...(patch.copyright === undefined
      ? {}
      : { copyright: merged.copyright?.kind === "set" ? merged.copyright.value : null }),
    ...(patch.keywords === undefined
      ? {}
      : { keywords: merged.keywords?.kind === "set" ? merged.keywords.value : [] }),
  };
}

function applyMetadataOverridesLocal(
  entryIds: readonly string[],
  overrides: MetadataOverrides,
  options: {
    readonly captionMode?: "replace" | "append";
    readonly keywordMode?: "replace" | "append";
  },
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  if (entryIds.length === 0) return;
  const current = get();
  const nextOverrides = { ...current.libraryWorkspace.metadataOverridesByEntryId };
  const nextSync = { ...current.libraryWorkspace.metadataSyncByEntryId };
  const nextMetadata = { ...current.entryMetadata };
  const updatedAt = Date.now();
  for (const entryId of entryIds) {
    const merged = mergeMetadataOverrides(
      nextOverrides[entryId] ?? {},
      overrides,
      current.libraryWorkspace.analysisByEntryId[entryId],
      options,
    );
    nextOverrides[entryId] = merged;
    const entryMetadata = getEntryMetadata(nextMetadata, entryId);
    nextMetadata[entryId] = createEntryMetadata({
      ...entryMetadata,
      ...metadataPatchFromOverrides(overrides, merged),
      updatedAt,
    });
    nextSync[entryId] = {
      status: "catalog-only",
      sidecarSha256: nextSync[entryId]?.sidecarSha256 ?? null,
      sidecarModifiedAt: nextSync[entryId]?.sidecarModifiedAt ?? null,
      catalogRevision: current.catalogRevision,
      baseline: nextSync[entryId]?.baseline ?? {},
      ownedFields: nextSync[entryId]?.ownedFields ?? [],
      conflicts: nextSync[entryId]?.conflicts ?? [],
      message: "Catalog saved. XMP publication requires an explicit sync.",
      updatedAt,
    };
  }
  set({
    entryMetadata: nextMetadata,
    libraryWorkspace: {
      ...current.libraryWorkspace,
      metadataOverridesByEntryId: nextOverrides,
      metadataSyncByEntryId: nextSync,
    },
  });
  scheduleStateSync(set, get);
}

function receiveMetadataProgress(
  progress: MetadataAnalysisProgress,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): void {
  const current = get();
  if (
    current.catalogId !== progress.catalogId ||
    current.sessionId !== progress.sessionId ||
    current.metadataAnalysis?.operationId !== progress.operationId
  ) {
    return;
  }
  set({
    metadataAnalysis: {
      operationId: progress.operationId,
      total: progress.total,
      completed: progress.completed,
      failed: progress.failed,
      cancelled: progress.cancelled,
    },
  });
}

function startMetadataAnalysis(
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
  options: {
    readonly entryIds?: readonly string[];
    readonly force?: boolean;
  } = {},
): void {
  const current = get();
  if (
    current.catalogId === null ||
    current.sessionId === null ||
    current.metadataAnalysis !== null
  ) {
    return;
  }
  const requestedIds = options.entryIds === undefined ? null : new Set(options.entryIds);
  const analysisEntries = current.entries
    .filter((entry) => requestedIds === null || requestedIds.has(entry.id))
    .filter((entry) => (
      options.force ||
      current.libraryWorkspace.analysisByEntryId[entry.id]?.cacheSignature !==
      entryAnalysisCacheSignature(entry.size, entry.lastModified)
    ));
  if (analysisEntries.length === 0) return;
  const entryIdsByAssetId = new Map(analysisEntries.map((entry) => [entry.assetId, [] as string[]]));
  for (const entry of analysisEntries) entryIdsByAssetId.get(entry.assetId)?.push(entry.id);

  let api: ReturnType<typeof getDarkroomAPI>;
  try {
    api = getDarkroomAPI();
  } catch {
    return;
  }

  if (metadataProgressUnsubscribe === null) {
    metadataProgressUnsubscribe = api.onCatalogMetadataAnalysisProgress((progress) => {
      receiveMetadataProgress(progress, set, get);
    });
  }

  const operationId = createOperationId();
  const catalogId = current.catalogId;
  const sessionId = current.sessionId;
  set({
    metadataAnalysis: {
      operationId,
      total: entryIdsByAssetId.size,
      completed: 0,
      failed: 0,
      cancelled: false,
    },
  });

  void api.catalogAnalyzeMetadata({
    catalogId,
    sessionId,
    operationId,
    entryIds: [...entryIdsByAssetId.keys()],
    force: options.force === true,
  }).then(
    (result) => {
      const latest = get();
      if (
        latest.catalogId !== catalogId ||
        latest.sessionId !== sessionId ||
        latest.metadataAnalysis?.operationId !== operationId
      ) {
        return;
      }
      const analysisByEntryId = { ...latest.libraryWorkspace.analysisByEntryId };
      for (const item of result.items) {
        for (const entryId of entryIdsByAssetId.get(item.entryId) ?? []) {
          analysisByEntryId[entryId] = item.analysis;
        }
      }
      set({
        libraryWorkspace: { ...latest.libraryWorkspace, analysisByEntryId },
        metadataAnalysis: null,
      });
    },
    (error: unknown) => {
      const latest = get();
      if (
        latest.catalogId !== catalogId ||
        latest.sessionId !== sessionId ||
        latest.metadataAnalysis?.operationId !== operationId
      ) {
        return;
      }
      set({ metadataAnalysis: null, importError: formatPickerError(error) });
    },
  );
}

async function scanRoots(
  generation: number,
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): Promise<void> {
  const roots = getActiveCatalogView()?.roots ?? [];
  for (const root of roots) {
    if (!isActiveFolderOperation(generation)) return;
    if (root.scanState === "complete") continue;
    const scanned = await scanCatalogRoot(root.rootId, (progress: ScanProgress) => {
      if (!isActiveFolderOperation(generation)) return;
      const phase = progress.phase === "statting" ? "Indexing" : "Scanning";
      const counts = `${progress.count} accepted · ${progress.filesConsidered ?? 0} files · ${progress.directoriesVisited ?? 0} folders`;
      const terminal = progress.status && progress.status !== "completed"
        ? `Scan ${progress.status}${progress.errorMessage ? `: ${progress.errorMessage}` : ""}`
        : `${phase} · ${counts}`;
      set({ importStatus: progress.done ? terminal : `${phase} · ${counts}` });
    });
    if (!isActiveFolderOperation(generation)) return;
    applyHydratedState(scanned, set, get);
  }
}

async function finishImport(
  generation: number,
  load: () => Promise<HydratedCatalogState>,
  mode: "import" | "restore",
  set: (partial: Partial<LibraryStore>) => void,
  get: () => LibraryStore,
): Promise<void> {
  try {
    set({
      importState: mode === "restore" ? "restoring" : "importing",
      importStatus: "Opening catalog…",
      importError: null,
    });
    const state = await load();
    if (!isActiveFolderOperation(generation)) return;
    applyHydratedState(state, set, get);
    set({ importStatus: "Scanning catalog…" });
    await scanRoots(generation, set, get);
    if (!isActiveFolderOperation(generation)) return;
    set({ importState: "idle", importStatus: null, needsFolderAccess: false });
    startMetadataAnalysis(set, get);
  } catch (error) {
    if (!isActiveFolderOperation(generation)) return;
    fsDebugError("catalog import failed", error);
    set({
      importState: "idle",
      importStatus: get().importStatus?.startsWith("Scan ")
        ? get().importStatus
        : null,
      importError: formatPickerError(error),
      needsFolderAccess: get().entries.length === 0,
    });
  }
}

async function refreshCatalogSummaries(
  set: (partial: Partial<LibraryStore>) => void,
): Promise<readonly CatalogSummary[]> {
  const result = await bootstrapCatalog();
  set({ catalogs: result.catalogs });
  return result.catalogs;
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  catalogId: null,
  sessionId: null,
  catalogRevision: 0,
  folderName: null,
  entries: [],
  unresolvedEntries: [],
  fingerprintCoverage: EMPTY_FINGERPRINT_COVERAGE,
  importPresets: [],
  albums: [],
  archivedEntryIds: [],
  libraryWorkspace: createLibraryWorkspaceState([]),
  catalogs: [],
  catalogRoots: [],
  catalogManagerOpen: false,
  catalogView: { type: "all" },
  importState: "idle",
  hasBootstrapped: false,
  importStatus: null,
  importError: null,
  metadataAnalysis: null,
  catalogRecovery: null,
  needsFolderAccess: false,
  selectedEntryId: null,
  selectedEntryIds: [],
  selectionAnchorId: null,
  entryMetadata: {},

  setSelectedEntryId: (id) => set({
    selectedEntryId: id,
    selectedEntryIds: id ? [id] : [],
    selectionAnchorId: id,
  }),

  restoreViewerSelection: (selectedEntryIds, activeEntryId, focusedEntryId) => set((state) => {
    const restoredEntryIds = [...new Set(selectedEntryIds)];
    if (
      state.selectedEntryId === activeEntryId &&
      state.selectionAnchorId === focusedEntryId &&
      state.selectedEntryIds.length === restoredEntryIds.length &&
      state.selectedEntryIds.every((entryId, index) => entryId === restoredEntryIds[index])
    ) return state;
    return {
      selectedEntryId: activeEntryId,
      selectedEntryIds: restoredEntryIds,
      selectionAnchorId: focusedEntryId,
    };
  }),

  clearSelection: () => set({ selectedEntryIds: [], selectedEntryId: null, selectionAnchorId: null }),

  selectEntry: (id, modifiers, visibleOrder) => {
    const { selectedEntryIds, selectionAnchorId } = get();
    if (modifiers.toggle) {
      const next = selectedEntryIds.includes(id)
        ? selectedEntryIds.filter((entryId) => entryId !== id)
        : [...selectedEntryIds, id];
      set({
        selectedEntryIds: next,
        selectedEntryId: next.includes(id) ? id : next.at(-1) ?? null,
        selectionAnchorId: selectionAnchorId ?? id,
      });
      return;
    }
    if (modifiers.shift) {
      const anchor = selectionAnchorId ?? get().selectedEntryId;
      if (anchor) {
        const anchorIndex = visibleOrder.indexOf(anchor);
        const targetIndex = visibleOrder.indexOf(id);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const start = Math.min(anchorIndex, targetIndex);
          const end = Math.max(anchorIndex, targetIndex);
          set({ selectedEntryIds: visibleOrder.slice(start, end + 1), selectedEntryId: id });
          return;
        }
      }
    }
    set({ selectedEntryIds: [id], selectedEntryId: id, selectionAnchorId: id });
  },

  reconcileSelection: (visibleEntryIds) => {
    const current = get();
    const next = reconcileSelectionToResult(
      current.selectedEntryIds,
      current.selectedEntryId,
      visibleEntryIds,
    );
    if (
      next.selectedEntryId === current.selectedEntryId &&
      next.selectedEntryIds.join("\u001f") === current.selectedEntryIds.join("\u001f")
    ) return;
    set({
      ...next,
      selectionAnchorId: next.selectedEntryIds.includes(current.selectionAnchorId ?? "")
        ? current.selectionAnchorId
        : next.selectedEntryIds[0] ?? null,
    });
  },

  setEntryMetadata: (entryId, patch) => applyLocalMetadata([entryId], patch, set, get),
  applyMetadataToEntries: (entryIds, patch) => applyLocalMetadata(entryIds, patch, set, get),

  applyMetadataOverrides: (entryIds, overrides, options = {}) => {
    applyMetadataOverridesLocal(entryIds, parseMetadataOverrides(overrides), options, set, get);
  },

  resetMetadataFields: (entryIds, fields) => {
    if (entryIds.length === 0 || fields.length === 0) return;
    const current = get();
    const nextOverrides = { ...current.libraryWorkspace.metadataOverridesByEntryId };
    const nextMetadata = { ...current.entryMetadata };
    const nextSync = { ...current.libraryWorkspace.metadataSyncByEntryId };
    const updatedAt = Date.now();
    for (const entryId of entryIds) {
      const entries = Object.entries(nextOverrides[entryId] ?? {})
        .filter(([field]) => !fields.some((candidate) => candidate === field));
      nextOverrides[entryId] = parseMetadataOverrides(Object.fromEntries(entries));
      const metadata = getEntryMetadata(nextMetadata, entryId);
      nextMetadata[entryId] = createEntryMetadata({
        ...metadata,
        ...(fields.includes("title") ? { title: null } : {}),
        ...(fields.includes("caption") ? { caption: null } : {}),
        ...(fields.includes("copyright") ? { copyright: null } : {}),
        ...(fields.includes("keywords") ? { keywords: [] } : {}),
        updatedAt,
      });
      nextSync[entryId] = {
        status: "catalog-only",
        sidecarSha256: nextSync[entryId]?.sidecarSha256 ?? null,
        sidecarModifiedAt: nextSync[entryId]?.sidecarModifiedAt ?? null,
        catalogRevision: current.catalogRevision,
        baseline: nextSync[entryId]?.baseline ?? {},
        ownedFields: nextSync[entryId]?.ownedFields ?? [],
        conflicts: nextSync[entryId]?.conflicts ?? [],
        message: "Overrides reset to source. XMP was not changed.",
        updatedAt,
      };
    }
    set({
      entryMetadata: nextMetadata,
      libraryWorkspace: {
        ...current.libraryWorkspace,
        metadataOverridesByEntryId: nextOverrides,
        metadataSyncByEntryId: nextSync,
      },
    });
    scheduleStateSync(set, get);
  },

  saveMetadataPreset: (preset) => {
    const parsed = parseMetadataPreset(preset);
    const current = get();
    const existing = current.libraryWorkspace.metadataPresets.findIndex(
      (item) => item.id === parsed.id,
    );
    const metadataPresets = [...current.libraryWorkspace.metadataPresets];
    if (existing === -1) metadataPresets.push(parsed);
    else metadataPresets[existing] = parsed;
    set({
      libraryWorkspace: { ...current.libraryWorkspace, metadataPresets },
    });
    scheduleStateSync(set, get);
  },

  deleteMetadataPreset: (presetId) => {
    const current = get();
    const metadataPresets = current.libraryWorkspace.metadataPresets.filter(
      (preset) => preset.id !== presetId,
    );
    if (metadataPresets.length === current.libraryWorkspace.metadataPresets.length) return;
    set({
      libraryWorkspace: { ...current.libraryWorkspace, metadataPresets },
    });
    scheduleStateSync(set, get);
  },

  publishMetadataXmp: async (entryId, resolution = "merge") => {
    const started = get();
    const entry = started.entries.find((item) => item.id === entryId);
    if (!entry || started.catalogId === null || started.sessionId === null) {
      throw new Error("Photo is unavailable.");
    }
    if (entry.entryKind === "virtual") {
      throw new Error("Virtual copies keep metadata in the catalog and cannot publish source XMP.");
    }
    const api = getDarkroomAPI();
    const request = getAssetRequest(entry);
    const sidecar = await api.catalogReadSidecar(request);
    const sidecarProjection = sidecar ? parseMetadataXmp(sidecar.contents) : {};
    const currentSync = started.libraryWorkspace.metadataSyncByEntryId[entryId];
    const baseline = currentSync?.baseline ?? sidecarProjection;
    const catalogProjection = started.libraryWorkspace.metadataOverridesByEntryId[entryId] ?? {};
    const reconciled = reconcileMetadataXmp(baseline, catalogProjection, sidecarProjection);
    if (resolution === "merge" && reconciled.conflicts.length > 0) {
      const latest = get();
      set({
        libraryWorkspace: {
          ...latest.libraryWorkspace,
          metadataSyncByEntryId: {
            ...latest.libraryWorkspace.metadataSyncByEntryId,
            [entryId]: {
              status: "conflict",
              sidecarSha256: sidecar ? await sha256Text(sidecar.contents) : null,
              sidecarModifiedAt: sidecar?.lastModified ?? null,
              catalogRevision: latest.catalogRevision,
              baseline,
              ownedFields: currentSync?.ownedFields ?? [],
              conflicts: reconciled.conflicts,
              message: `${reconciled.conflicts.length} metadata field${reconciled.conflicts.length === 1 ? "" : "s"} changed in both the catalog and XMP.`,
              updatedAt: Date.now(),
            },
          },
        },
      });
      scheduleStateSync(set, get);
      return "conflict";
    }
    if (resolution === "sidecar-wins") {
      get().resetMetadataFields([entryId], METADATA_EDITABLE_FIELDS);
      get().applyMetadataOverrides([entryId], sidecarProjection);
      const latest = get();
      set({
        libraryWorkspace: {
          ...latest.libraryWorkspace,
          metadataSyncByEntryId: {
            ...latest.libraryWorkspace.metadataSyncByEntryId,
            [entryId]: {
              status: "clean",
              sidecarSha256: sidecar ? await sha256Text(sidecar.contents) : null,
              sidecarModifiedAt: sidecar?.lastModified ?? null,
              catalogRevision: latest.catalogRevision,
              baseline: sidecarProjection,
              ownedFields: METADATA_EDITABLE_FIELDS.filter((field) => sidecarProjection[field] !== undefined),
              conflicts: [],
              message: "Catalog metadata reloaded from XMP.",
              updatedAt: Date.now(),
            },
          },
        },
      });
      scheduleStateSync(set, get);
      return "reloaded";
    }
    const desired = resolution === "catalog-wins" ? catalogProjection : reconciled.merged;
    const contents = serializeMetadataXmp(sidecar?.contents ?? null, desired);
    await api.catalogWriteSidecar({
      ...request,
      contents,
      expectedLastModified: sidecar?.lastModified ?? null,
    });
    const confirmed = await api.catalogReadSidecar(request);
    if (!confirmed) throw new Error("XMP sidecar disappeared after publication.");
    const latest = get();
    if (latest.catalogId !== started.catalogId || latest.sessionId !== started.sessionId) {
      throw new Error("Catalog changed before XMP publication completed.");
    }
    set({
      libraryWorkspace: {
        ...latest.libraryWorkspace,
        metadataSyncByEntryId: {
          ...latest.libraryWorkspace.metadataSyncByEntryId,
          [entryId]: {
            status: "clean",
            sidecarSha256: await sha256Text(confirmed.contents),
            sidecarModifiedAt: confirmed.lastModified,
            catalogRevision: latest.catalogRevision,
            baseline: desired,
            ownedFields: METADATA_EDITABLE_FIELDS.filter((field) => desired[field] !== undefined),
            conflicts: [],
            message: "Catalog metadata published to XMP with a recovery backup.",
            updatedAt: Date.now(),
          },
        },
      },
    });
    scheduleStateSync(set, get);
    return "published";
  },

  mirrorDevelopDocument: (entryId, develop, sourceUpdatedAt = Date.now(), metadataPatch = {}) => {
    const { entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    const developUpdatedAt = Math.max(sourceUpdatedAt, current.developUpdatedAt + 1);
    const metadataChanged = Object.keys(metadataPatch).length > 0;
    const updatedAt = metadataChanged ? Math.max(sourceUpdatedAt, current.updatedAt + 1) : current.updatedAt;
    set({
      entryMetadata: {
        ...entryMetadata,
        [entryId]: createEntryMetadata({
          ...current,
          ...metadataPatch,
          develop,
          developUpdatedAt,
          updatedAt,
        }),
      },
    });
    scheduleStateSync(set, get);
  },

  persistDevelopState: async (catalogId, entryId, input) => {
    if (get().catalogId !== catalogId) {
      throw new Error("Reopen the original catalog before saving Develop settings.");
    }
    const { entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    const metadataChanged =
      (input.metadataPatch.rating !== undefined &&
        input.metadataPatch.rating !== current.rating) ||
      (input.metadataPatch.colorLabel !== undefined &&
        input.metadataPatch.colorLabel !== current.colorLabel);
    if (input.document || metadataChanged) {
      const developUpdatedAt = input.document
        ? Math.max(input.sourceUpdatedAt, current.developUpdatedAt + 1)
        : current.developUpdatedAt;
      const updatedAt = metadataChanged
        ? Math.max(input.sourceUpdatedAt, current.updatedAt + 1)
        : current.updatedAt;
      set({
        entryMetadata: {
          ...entryMetadata,
          [entryId]: createEntryMetadata({
            ...current,
            ...input.metadataPatch,
            ...(input.document ? { develop: input.document } : {}),
            developUpdatedAt,
            updatedAt,
          }),
        },
      });
    }
    await persistStateSync(set, get);
  },

  hydrateEntryMetadata: (entryId, patch, sourceUpdatedAt) => {
    const { entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    set({
      entryMetadata: {
        ...entryMetadata,
        [entryId]: createEntryMetadata({
          ...current,
          ...patch,
          updatedAt: Math.max(sourceUpdatedAt, current.updatedAt + 1),
        }),
      },
    });
    scheduleStateSync(set, get);
  },

  restoreEntryMetadata: (entryId, patch) => {
    const { entryMetadata } = get();
    const current = getEntryMetadata(entryMetadata, entryId);
    set({
      entryMetadata: {
        ...entryMetadata,
        [entryId]: createEntryMetadata({ ...current, ...patch, updatedAt: Date.now() }),
      },
    });
    scheduleStateSync(set, get);
  },

  setCatalogView: (view) => set({ catalogView: view }),

  createAlbum: (name, parentId = null) => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    const workspace = get().libraryWorkspace;
    if (
      parentId !== null &&
      !workspace.collections.some((node) => node.kind === "set" && node.id === parentId)
    ) return "";
    const now = Date.now();
    const album: Album = {
      id: crypto.randomUUID(),
      name: trimmed,
      entryIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const collection: CollectionNode = {
      kind: "album",
      id: album.id,
      name: album.name,
      parentId,
      order: nextCollectionOrder(workspace.collections, parentId),
      createdAt: now,
      updatedAt: now,
    };
    set({
      albums: [...get().albums, album],
      libraryWorkspace: {
        ...workspace,
        collections: [...workspace.collections, collection],
      },
      catalogView: { type: "album", albumId: album.id },
    });
    scheduleStateSync(set, get);
    return album.id;
  },

  createCollectionSet: (name, parentId = null) => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    const workspace = get().libraryWorkspace;
    if (
      parentId !== null &&
      !workspace.collections.some((node) => node.kind === "set" && node.id === parentId)
    ) return "";
    const now = Date.now();
    const id = crypto.randomUUID();
    set({
      libraryWorkspace: {
        ...workspace,
        collections: [...workspace.collections, {
          kind: "set",
          id,
          name: trimmed,
          parentId,
          order: nextCollectionOrder(workspace.collections, parentId),
          createdAt: now,
          updatedAt: now,
        }],
      },
    });
    scheduleStateSync(set, get);
    return id;
  },

  createSmartAlbum: (name, rule, parentId = null) => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    const workspace = get().libraryWorkspace;
    if (
      parentId !== null &&
      !workspace.collections.some((node) => node.kind === "set" && node.id === parentId)
    ) return "";
    const now = Date.now();
    const id = crypto.randomUUID();
    set({
      libraryWorkspace: {
        ...workspace,
        collections: [...workspace.collections, {
          kind: "smart",
          id,
          name: trimmed,
          parentId,
          order: nextCollectionOrder(workspace.collections, parentId),
          rule,
          createdAt: now,
          updatedAt: now,
        }],
      },
      catalogView: { type: "smart", collectionId: id },
    });
    scheduleStateSync(set, get);
    return id;
  },

  updateSmartAlbumRule: (collectionId, rule) => {
    const workspace = get().libraryWorkspace;
    let changed = false;
    const collections = workspace.collections.map((node) => {
      if (node.kind !== "smart" || node.id !== collectionId) return node;
      changed = true;
      return { ...node, rule, updatedAt: Date.now() };
    });
    if (!changed) return;
    set({ libraryWorkspace: { ...workspace, collections } });
    scheduleStateSync(set, get);
  },

  duplicateSmartAlbum: (collectionId) => {
    const workspace = get().libraryWorkspace;
    const source = workspace.collections.find(
      (node) => node.kind === "smart" && node.id === collectionId,
    );
    if (!source || source.kind !== "smart") return "";
    return get().createSmartAlbum(
      `${source.name} copy`,
      structuredClone(source.rule),
      source.parentId,
    );
  },

  renameCollection: (collectionId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const workspace = get().libraryWorkspace;
    const now = Date.now();
    set({
      albums: get().albums.map((album) => album.id === collectionId
        ? { ...album, name: trimmed, updatedAt: now }
        : album),
      libraryWorkspace: {
        ...workspace,
        collections: workspace.collections.map((node) => node.id === collectionId
          ? { ...node, name: trimmed, updatedAt: now }
          : node),
      },
    });
    scheduleStateSync(set, get);
  },

  moveCollection: (collectionId, parentId) => {
    const workspace = get().libraryWorkspace;
    const node = workspace.collections.find((item) => item.id === collectionId);
    if (!node || node.parentId === parentId) return;
    if (
      parentId !== null &&
      !workspace.collections.some((item) => item.kind === "set" && item.id === parentId)
    ) return;
    if (parentId === collectionId || descendantCollectionIds(workspace.collections, collectionId).has(parentId ?? "")) {
      return;
    }
    set({
      libraryWorkspace: {
        ...workspace,
        collections: workspace.collections.map((item) => item.id === collectionId
          ? {
              ...item,
              parentId,
              order: nextCollectionOrder(workspace.collections, parentId),
              updatedAt: Date.now(),
            }
          : item),
      },
    });
    scheduleStateSync(set, get);
  },

  reorderCollection: (collectionId, direction) => {
    const workspace = get().libraryWorkspace;
    const node = workspace.collections.find((item) => item.id === collectionId);
    if (!node) return;
    const siblings = workspace.collections
      .filter((item) => item.parentId === node.parentId)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    const index = siblings.findIndex((item) => item.id === collectionId);
    const neighbor = siblings[index + direction];
    if (!neighbor) return;
    const collections = workspace.collections.map((item) => {
      if (item.id === node.id) return { ...item, order: neighbor.order, updatedAt: Date.now() };
      if (item.id === neighbor.id) return { ...item, order: node.order, updatedAt: Date.now() };
      return item;
    });
    set({ libraryWorkspace: { ...workspace, collections } });
    scheduleStateSync(set, get);
  },

  deleteCollection: (collectionId, deleteDescendants = false) => {
    const workspace = get().libraryWorkspace;
    const node = workspace.collections.find((item) => item.id === collectionId);
    if (!node) return;
    if (node.kind === "album") {
      get().deleteAlbum(collectionId);
      return;
    }
    const descendants = descendantCollectionIds(workspace.collections, collectionId);
    const removedIds = deleteDescendants
      ? new Set([collectionId, ...descendants])
      : new Set([collectionId]);
    const removedAlbumIds = new Set(
      workspace.collections
        .filter((item) => removedIds.has(item.id) && item.kind === "album")
        .map((item) => item.id),
    );
    const collections = workspace.collections
      .filter((item) => !removedIds.has(item.id))
      .map((item) => !deleteDescendants && item.parentId === collectionId
        ? { ...item, parentId: node.parentId, updatedAt: Date.now() }
        : item);
    const currentView = get().catalogView;
    const catalogView = (
      (currentView.type === "smart" && removedIds.has(currentView.collectionId)) ||
      (currentView.type === "album" && removedIds.has(currentView.albumId))
    ) ? { type: "all" as const } : currentView;
    set({
      albums: get().albums.filter((album) => !removedAlbumIds.has(album.id)),
      libraryWorkspace: {
        ...workspace,
        collections,
        targetAlbumId: workspace.targetAlbumId !== null && removedAlbumIds.has(workspace.targetAlbumId)
          ? null
          : workspace.targetAlbumId,
        archiveMemberships: workspace.archiveMemberships.map((snapshot) => ({
          ...snapshot,
          albums: snapshot.albums.filter((membership) => !removedAlbumIds.has(membership.albumId)),
        })),
      },
      catalogView,
    });
    scheduleStateSync(set, get);
  },

  renameAlbum: (albumId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const now = Date.now();
    const workspace = get().libraryWorkspace;
    set({
      albums: get().albums.map((album) => album.id === albumId
        ? { ...album, name: trimmed, updatedAt: now }
        : album),
      libraryWorkspace: {
        ...workspace,
        collections: workspace.collections.map((node) => node.id === albumId
          ? { ...node, name: trimmed, updatedAt: now }
          : node),
      },
    });
    scheduleStateSync(set, get);
  },

  deleteAlbum: (albumId) => {
    const currentView = get().catalogView;
    const workspace = get().libraryWorkspace;
    const catalogView = currentView.type === "album" && currentView.albumId === albumId
      ? { type: "all" as const }
      : currentView;
    set({
      albums: get().albums.filter((album) => album.id !== albumId),
      libraryWorkspace: {
        ...workspace,
        collections: workspace.collections.filter((node) => node.id !== albumId),
        targetAlbumId: workspace.targetAlbumId === albumId ? null : workspace.targetAlbumId,
        archiveMemberships: workspace.archiveMemberships.map((snapshot) => ({
          ...snapshot,
          albums: snapshot.albums.filter((membership) => membership.albumId !== albumId),
        })),
      },
      catalogView,
    });
    scheduleStateSync(set, get);
  },

  addEntriesToAlbum: (albumId, entryIds) => {
    if (entryIds.length === 0) return;
    const validIds = new Set<string>(get().entries.map((entry) => entry.id));
    let changed = false;
    const albums = get().albums.map((album) => {
      if (album.id !== albumId) return album;
      const existing = new Set(album.entryIds);
      const added = entryIds.filter((id) => validIds.has(id) && !existing.has(id));
      if (added.length === 0) return album;
      changed = true;
      return { ...album, entryIds: [...album.entryIds, ...added], updatedAt: Date.now() };
    });
    if (!changed) return;
    set({ albums });
    scheduleStateSync(set, get);
  },

  removeEntriesFromAlbum: (albumId, entryIds) => {
    if (entryIds.length === 0) return;
    const removeSet = new Set(entryIds);
    let changed = false;
    const albums = get().albums.map((album) => {
      if (album.id !== albumId || !album.entryIds.some((id) => removeSet.has(id))) return album;
      changed = true;
      return {
        ...album,
        entryIds: album.entryIds.filter((id) => !removeSet.has(id)),
        updatedAt: Date.now(),
      };
    });
    if (!changed) return;
    set({ albums });
    scheduleStateSync(set, get);
  },

  removeEntriesFromAllAlbums: (entryIds) => {
    if (entryIds.length === 0) return;
    const removeSet = new Set(entryIds);
    let changed = false;
    const albums = get().albums.map((album) => {
      if (!album.entryIds.some((id) => removeSet.has(id))) return album;
      changed = true;
      return {
        ...album,
        entryIds: album.entryIds.filter((id) => !removeSet.has(id)),
        updatedAt: Date.now(),
      };
    });
    if (!changed) return;
    set({ albums });
    scheduleStateSync(set, get);
  },

  archiveEntries: (entryIds) => {
    if (entryIds.length === 0) return;
    const current = get();
    const validIds = new Set<string>(current.entries.map((entry) => entry.id));
    const newlyArchived = entryIds.filter(
      (id) => validIds.has(id) && !current.archivedEntryIds.includes(id),
    );
    if (newlyArchived.length === 0) return;
    const removeSet = new Set(newlyArchived);
    const archivedEntryIds = [...current.archivedEntryIds, ...newlyArchived];
    const snapshots = newlyArchived.map((entryId) => ({
      entryId,
      albums: current.albums.flatMap((album) => {
        const index = album.entryIds.indexOf(entryId);
        return index >= 0 ? [{ albumId: album.id, index }] : [];
      }),
    }));
    const albums = current.albums.map((album) => ({
      ...album,
      entryIds: album.entryIds.filter((id) => !removeSet.has(id)),
      updatedAt: album.entryIds.some((id) => removeSet.has(id)) ? Date.now() : album.updatedAt,
    }));
    const activeEntries = filterArchivedEntries(current.entries, archivedEntryIds);
    set({
      archivedEntryIds,
      albums,
      libraryWorkspace: {
        ...current.libraryWorkspace,
        archiveMemberships: [
          ...current.libraryWorkspace.archiveMemberships.filter((item) => !removeSet.has(item.entryId)),
          ...snapshots,
        ],
      },
      ...restoreSelection(activeEntries, current.selectedEntryIds, current.selectionAnchorId),
    });
    scheduleStateSync(set, get);
  },

  restoreEntries: (entryIds) => {
    if (entryIds.length === 0) return;
    const removeSet = new Set(entryIds);
    const current = get();
    const restoredIds = current.archivedEntryIds.filter((id) => removeSet.has(id));
    if (restoredIds.length === 0) return;
    const archivedEntryIds = current.archivedEntryIds.filter((id) => !removeSet.has(id));
    const snapshots = current.libraryWorkspace.archiveMemberships
      .filter((item) => removeSet.has(item.entryId));
    const albums = current.albums.map((album) => {
      const insertions = snapshots
        .flatMap((snapshot) => snapshot.albums
          .filter((membership) => membership.albumId === album.id)
          .map((membership) => ({ entryId: snapshot.entryId, index: membership.index })))
        .filter((item) => !album.entryIds.includes(item.entryId))
        .sort((left, right) => left.index - right.index);
      if (insertions.length === 0) return album;
      const nextIds = [...album.entryIds];
      for (const item of insertions) {
        nextIds.splice(Math.min(item.index, nextIds.length), 0, item.entryId);
      }
      return { ...album, entryIds: nextIds, updatedAt: Date.now() };
    });
    const { entries, catalogView } = current;
    const activeEntries = catalogView.type === "archive"
      ? filterOnlyArchivedEntries(entries, archivedEntryIds)
      : filterArchivedEntries(entries, archivedEntryIds);
    set({
      archivedEntryIds,
      albums,
      libraryWorkspace: {
        ...current.libraryWorkspace,
        archiveMemberships: current.libraryWorkspace.archiveMemberships
          .filter((item) => !removeSet.has(item.entryId)),
      },
      ...restoreSelection(
        activeEntries,
        current.selectedEntryIds.filter((id) => !removeSet.has(id)),
        current.selectionAnchorId,
      ),
    });
    scheduleStateSync(set, get);
  },

  toggleQuickEntries: (entryIds) => {
    if (entryIds.length === 0) return;
    const current = get();
    const valid = new Set<string>(current.entries.map((entry) => entry.id));
    const uniqueIds = [...new Set(entryIds)].filter((id) => valid.has(id));
    if (uniqueIds.length === 0) return;
    const quick = new Set(current.libraryWorkspace.quickEntryIds);
    const remove = uniqueIds.every((id) => quick.has(id));
    const quickEntryIds = remove
      ? current.libraryWorkspace.quickEntryIds.filter((id) => !uniqueIds.includes(id))
      : [...current.libraryWorkspace.quickEntryIds, ...uniqueIds.filter((id) => !quick.has(id))];
    set({
      libraryWorkspace: { ...current.libraryWorkspace, quickEntryIds },
    });
    scheduleStateSync(set, get);
  },

  clearQuickCollection: () => {
    const workspace = get().libraryWorkspace;
    if (workspace.quickEntryIds.length === 0) return;
    set({ libraryWorkspace: { ...workspace, quickEntryIds: [] } });
    scheduleStateSync(set, get);
  },

  setTargetAlbum: (albumId) => {
    const current = get();
    const targetAlbumId = albumId !== null && current.albums.some((album) => album.id === albumId)
      ? albumId
      : null;
    if (current.libraryWorkspace.targetAlbumId === targetAlbumId) return;
    set({ libraryWorkspace: { ...current.libraryWorkspace, targetAlbumId } });
    scheduleStateSync(set, get);
  },

  addEntriesToTarget: (entryIds) => {
    const targetAlbumId = get().libraryWorkspace.targetAlbumId;
    if (targetAlbumId !== null) get().addEntriesToAlbum(targetAlbumId, entryIds);
  },

  createKeyword: (name, parentId = null) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes("|")) return "";
    const workspace = get().libraryWorkspace;
    if (parentId !== null && !workspace.keywords.some((keyword) => keyword.id === parentId)) {
      return "";
    }
    const siblingExists = workspace.keywords.some((keyword) =>
      keyword.parentId === parentId && keyword.name.localeCompare(trimmed, undefined, { sensitivity: "base" }) === 0
    );
    if (siblingExists) return "";
    const now = Date.now();
    const id = crypto.randomUUID();
    set({
      libraryWorkspace: {
        ...workspace,
        keywords: [...workspace.keywords, {
          id,
          parentId,
          name: trimmed,
          synonyms: [],
          export: true,
          createdAt: now,
          updatedAt: now,
        }],
      },
    });
    scheduleStateSync(set, get);
    return id;
  },

  renameKeyword: (keywordId, name) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes("|")) return;
    const workspace = get().libraryWorkspace;
    const keyword = workspace.keywords.find((item) => item.id === keywordId);
    if (!keyword || workspace.keywords.some((item) =>
      item.id !== keywordId &&
      item.parentId === keyword.parentId &&
      item.name.localeCompare(trimmed, undefined, { sensitivity: "base" }) === 0
    )) return;
    const nextWorkspace = {
      ...workspace,
      keywords: workspace.keywords.map((item) => item.id === keywordId
        ? { ...item, name: trimmed, updatedAt: Date.now() }
        : item),
    };
    set({ libraryWorkspace: nextWorkspace });
    persistKeywordSidecars(Object.keys(workspace.entryKeywordIds), nextWorkspace, get().entries, set);
    scheduleStateSync(set, get);
  },

  moveKeyword: (keywordId, parentId) => {
    const workspace = get().libraryWorkspace;
    const keyword = workspace.keywords.find((item) => item.id === keywordId);
    if (!keyword || keyword.parentId === parentId) return;
    if (parentId !== null && !workspace.keywords.some((item) => item.id === parentId)) return;
    const descendants = new Set<string>();
    const pending = [keywordId];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const child of workspace.keywords.filter((item) => item.parentId === current)) {
        if (!descendants.has(child.id)) {
          descendants.add(child.id);
          pending.push(child.id);
        }
      }
    }
    if (parentId === keywordId || (parentId !== null && descendants.has(parentId))) return;
    if (workspace.keywords.some((item) =>
      item.id !== keywordId &&
      item.parentId === parentId &&
      item.name.localeCompare(keyword.name, undefined, { sensitivity: "base" }) === 0
    )) return;
    const nextWorkspace = {
      ...workspace,
      keywords: workspace.keywords.map((item) => item.id === keywordId
        ? { ...item, parentId, updatedAt: Date.now() }
        : item),
    };
    set({ libraryWorkspace: nextWorkspace });
    persistKeywordSidecars(Object.keys(workspace.entryKeywordIds), nextWorkspace, get().entries, set);
    scheduleStateSync(set, get);
  },

  mergeKeyword: (sourceId, targetId) => {
    const workspace = get().libraryWorkspace;
    if (sourceId === targetId || !workspace.keywords.some((item) => item.id === sourceId) || !workspace.keywords.some((item) => item.id === targetId)) return;
    const entryKeywordIds = Object.fromEntries(
      Object.entries(workspace.entryKeywordIds).map(([entryId, ids]) => [
        entryId,
        [...new Set(ids.map((id) => id === sourceId ? targetId : id))],
      ]),
    );
    const nextWorkspace = {
      ...workspace,
      keywords: workspace.keywords
        .filter((item) => item.id !== sourceId)
        .map((item) => item.parentId === sourceId
          ? { ...item, parentId: targetId, updatedAt: Date.now() }
          : item),
      entryKeywordIds,
    };
    set({ libraryWorkspace: nextWorkspace });
    persistKeywordSidecars(Object.keys(entryKeywordIds), nextWorkspace, get().entries, set);
    scheduleStateSync(set, get);
  },

  deleteKeyword: (keywordId, deleteSubtree = false) => {
    const workspace = get().libraryWorkspace;
    const keyword = workspace.keywords.find((item) => item.id === keywordId);
    if (!keyword) return;
    const removedIds = new Set([keywordId]);
    if (deleteSubtree) {
      const pending = [keywordId];
      while (pending.length > 0) {
        const current = pending.pop();
        for (const child of workspace.keywords.filter((item) => item.parentId === current)) {
          if (removedIds.has(child.id)) continue;
          removedIds.add(child.id);
          pending.push(child.id);
        }
      }
    }
    const entryKeywordIds = Object.fromEntries(
      Object.entries(workspace.entryKeywordIds).map(([entryId, ids]) => [
        entryId,
        ids.filter((id) => !removedIds.has(id)),
      ]),
    );
    const nextWorkspace = {
      ...workspace,
      keywords: workspace.keywords
        .filter((item) => !removedIds.has(item.id))
        .map((item) => item.parentId === keywordId
          ? { ...item, parentId: keyword.parentId, updatedAt: Date.now() }
          : item),
      entryKeywordIds,
    };
    set({ libraryWorkspace: nextWorkspace });
    persistKeywordSidecars(Object.keys(entryKeywordIds), nextWorkspace, get().entries, set);
    scheduleStateSync(set, get);
  },

  assignKeywordToEntries: (keywordId, entryIds) => {
    const workspace = get().libraryWorkspace;
    if (!workspace.keywords.some((keyword) => keyword.id === keywordId)) return;
    const valid = new Set<string>(get().entries.map((entry) => entry.id));
    const entryKeywordIds = { ...workspace.entryKeywordIds };
    let changed = false;
    for (const entryId of entryIds) {
      if (!valid.has(entryId)) continue;
      const ids = entryKeywordIds[entryId] ?? [];
      if (ids.includes(keywordId)) continue;
      entryKeywordIds[entryId] = [...ids, keywordId];
      changed = true;
    }
    if (!changed) return;
    const nextWorkspace = { ...workspace, entryKeywordIds };
    set({ libraryWorkspace: nextWorkspace });
    persistKeywordSidecars(entryIds, nextWorkspace, get().entries, set);
    scheduleStateSync(set, get);
  },

  removeKeywordFromEntries: (keywordId, entryIds) => {
    const workspace = get().libraryWorkspace;
    const entryKeywordIds = { ...workspace.entryKeywordIds };
    let changed = false;
    for (const entryId of entryIds) {
      const ids = entryKeywordIds[entryId] ?? [];
      if (!ids.includes(keywordId)) continue;
      entryKeywordIds[entryId] = ids.filter((id) => id !== keywordId);
      changed = true;
    }
    if (!changed) return;
    const nextWorkspace = { ...workspace, entryKeywordIds };
    set({ libraryWorkspace: nextWorkspace });
    persistKeywordSidecars(entryIds, nextWorkspace, get().entries, set);
    scheduleStateSync(set, get);
  },

  hydrateEntryKeywords: (entryId, flat, hierarchical) => {
    const workspace = get().libraryWorkspace;
    const keywords = [...workspace.keywords];
    const assigned = new Set(workspace.entryKeywordIds[entryId] ?? []);
    const ensurePath = (parts: readonly string[]): string | null => {
      let parentId: string | null = null;
      let leafId: string | null = null;
      for (const rawPart of parts) {
        const name = rawPart.trim();
        if (!name) continue;
        let keyword = keywords.find((item) =>
          item.parentId === parentId && item.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0
        );
        if (!keyword) {
          const now = Date.now();
          keyword = {
            id: crypto.randomUUID(),
            parentId,
            name,
            synonyms: [],
            export: true,
            createdAt: now,
            updatedAt: now,
          };
          keywords.push(keyword);
        }
        parentId = keyword.id;
        leafId = keyword.id;
      }
      return leafId;
    };
    for (const path of hierarchical) {
      const id = ensurePath(path.split("|").filter(Boolean));
      if (id) assigned.add(id);
    }
    for (const name of flat) {
      const alreadyRepresented = keywords.some((keyword) =>
        assigned.has(keyword.id) && keyword.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0
      );
      if (!alreadyRepresented) {
        const id = ensurePath([name]);
        if (id) assigned.add(id);
      }
    }
    const nextIds = [...assigned];
    if (
      keywords.length === workspace.keywords.length &&
      nextIds.length === (workspace.entryKeywordIds[entryId]?.length ?? 0)
    ) return;
    set({
      libraryWorkspace: {
        ...workspace,
        keywords,
        entryKeywordIds: { ...workspace.entryKeywordIds, [entryId]: nextIds },
      },
    });
    scheduleStateSync(set, get);
  },

  stackEntries: (entryIds) => {
    const current = get();
    const valid = new Set<string>(current.entries.map((entry) => entry.id));
    const uniqueIds = [...new Set(entryIds)].filter((id) => valid.has(id));
    if (uniqueIds.length < 2) return "";
    const occupied = new Set(current.libraryWorkspace.stacks.flatMap((stack) => stack.entryIds));
    if (uniqueIds.some((id) => occupied.has(id))) return "";
    const now = Date.now();
    const id = crypto.randomUUID();
    set({
      libraryWorkspace: {
        ...current.libraryWorkspace,
        stacks: [...current.libraryWorkspace.stacks, {
          id,
          entryIds: uniqueIds,
          coverEntryId: uniqueIds[0],
          reason: null,
          createdAt: now,
          updatedAt: now,
        }],
      },
    });
    scheduleStateSync(set, get);
    return id;
  },

  addEntriesToStack: (stackId, entryIds) => {
    const workspace = get().libraryWorkspace;
    const valid = new Set<string>(get().entries.map((entry) => entry.id));
    const occupiedElsewhere = new Set(
      workspace.stacks.filter((stack) => stack.id !== stackId).flatMap((stack) => stack.entryIds),
    );
    let changed = false;
    const stacks = workspace.stacks.map((stack) => {
      if (stack.id !== stackId) return stack;
      const existing = new Set(stack.entryIds);
      const added = entryIds.filter((id) => valid.has(id) && !existing.has(id) && !occupiedElsewhere.has(id));
      if (added.length === 0) return stack;
      changed = true;
      return { ...stack, entryIds: [...stack.entryIds, ...added], updatedAt: Date.now() };
    });
    if (!changed) return;
    set({ libraryWorkspace: { ...workspace, stacks } });
    scheduleStateSync(set, get);
  },

  removeEntriesFromStack: (stackId, entryIds) => {
    const workspace = get().libraryWorkspace;
    const removed = new Set(entryIds);
    let changed = false;
    const stacks = workspace.stacks.flatMap((stack) => {
      if (stack.id !== stackId || !stack.entryIds.some((id) => removed.has(id))) return [stack];
      changed = true;
      const nextIds = stack.entryIds.filter((id) => !removed.has(id));
      if (nextIds.length < 2) return [];
      return [{
        ...stack,
        entryIds: nextIds,
        coverEntryId: nextIds.includes(stack.coverEntryId) ? stack.coverEntryId : nextIds[0],
        updatedAt: Date.now(),
      }];
    });
    if (!changed) return;
    set({ libraryWorkspace: { ...workspace, stacks } });
    scheduleStateSync(set, get);
  },

  reorderStackEntry: (stackId, entryId, direction) => {
    const workspace = get().libraryWorkspace;
    let changed = false;
    const stacks = workspace.stacks.map((stack) => {
      if (stack.id !== stackId) return stack;
      const index = stack.entryIds.indexOf(entryId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= stack.entryIds.length) return stack;
      const entryIds = [...stack.entryIds];
      [entryIds[index], entryIds[nextIndex]] = [entryIds[nextIndex]!, entryIds[index]!];
      changed = true;
      return { ...stack, entryIds, updatedAt: Date.now() };
    });
    if (!changed) return;
    set({ libraryWorkspace: { ...workspace, stacks } });
    scheduleStateSync(set, get);
  },

  unstackEntries: (entryIds) => {
    const workspace = get().libraryWorkspace;
    const targets = new Set(entryIds);
    const stacks = workspace.stacks.filter((stack) =>
      !stack.entryIds.some((entryId) => targets.has(entryId))
    );
    if (stacks.length === workspace.stacks.length) return;
    set({ libraryWorkspace: { ...workspace, stacks } });
    scheduleStateSync(set, get);
  },

  setStackCover: (stackId, entryId) => {
    const workspace = get().libraryWorkspace;
    let changed = false;
    const stacks = workspace.stacks.map((stack) => {
      if (stack.id !== stackId || !stack.entryIds.includes(entryId) || stack.coverEntryId === entryId) {
        return stack;
      }
      changed = true;
      return { ...stack, coverEntryId: entryId, updatedAt: Date.now() };
    });
    if (!changed) return;
    set({ libraryWorkspace: { ...workspace, stacks } });
    scheduleStateSync(set, get);
  },

  excludeEntries: (entryIds) => {
    const workspace = get().libraryWorkspace;
    const valid = new Set<string>(get().entries.map((entry) => entry.id));
    const excluded = new Set(workspace.excludedEntryIds);
    const added = entryIds.filter((id) => valid.has(id) && !excluded.has(id));
    if (added.length === 0) return;
    set({
      libraryWorkspace: {
        ...workspace,
        excludedEntryIds: [...workspace.excludedEntryIds, ...added],
      },
    });
    scheduleStateSync(set, get);
  },

  restoreExcludedEntries: (entryIds) => {
    const workspace = get().libraryWorkspace;
    const restored = new Set(entryIds);
    const excludedEntryIds = workspace.excludedEntryIds.filter((id) => !restored.has(id));
    if (excludedEntryIds.length === workspace.excludedEntryIds.length) return;
    set({ libraryWorkspace: { ...workspace, excludedEntryIds } });
    scheduleStateSync(set, get);
  },

  trashExactDuplicates: async (keeperId, targetIds) => {
    const current = get();
    const keeper = current.entries.find((entry) => entry.id === keeperId);
    if (!keeper || current.catalogId === null || current.sessionId === null) {
      throw new Error("The duplicate keeper is no longer available.");
    }
    const binding = {
      catalogId: current.catalogId,
      sessionId: current.sessionId,
    };
    const targets = [...new Set(current.entries
      .filter((entry) => entry.assetId !== keeper.assetId && targetIds.includes(entry.id))
      .map((entry) => entry.assetId))];
    if (targets.length === 0) throw new Error("Choose at least one duplicate to trash.");
    await backupCatalogAdmin();
    requireCatalogSession(
      binding,
      get,
      "Catalog changed before duplicate files were trashed. No files were moved.",
    );
    const result = await getDarkroomAPI().catalogTrashExactDuplicates({
      catalogId: binding.catalogId,
      sessionId: binding.sessionId,
      keeperId: keeper.assetId,
      targetIds: targets,
    });
    if (!catalogSessionIsCurrent(binding, get)) {
      const succeeded = result.items.filter((item) => item.trashed).length;
      const failed = result.items.length - succeeded;
      throw new Error(
        `Catalog changed after duplicate trash completed: ${succeeded} moved, ${failed} failed. Reopen the original catalog to reconcile the results.`,
      );
    }
    const trashed = new Set(result.items
      .filter((item) => item.trashed)
      .map((item) => item.entryId));
    removeEntriesForAssets(trashed, binding, set, get);
    const failures = result.items.filter((item) => !item.trashed);
    if (failures.length > 0) {
      set({
        importError: `${failures.length} duplicate${failures.length === 1 ? "" : "s"} could not be trashed: ${failures[0]?.error ?? "Unknown error"}`,
      });
    }
    return result;
  },

  deleteEntriesFromDisk: async (entryIds) => {
    if (entryIds.length === 0) return;
    const current = get();
    if (current.catalogId === null || current.sessionId === null) {
      throw new Error("Open the original catalog before removing photos from disk.");
    }
    const binding = {
      catalogId: current.catalogId,
      sessionId: current.sessionId,
    };
    const selected = current.entries.filter((entry) => entryIds.includes(entry.id));
    const targets = [...new Map(selected.map((entry) => [entry.assetId, entry])).values()];
    try {
      await Promise.all(targets.map((entry) => getDarkroomAPI().catalogTrashAsset(getAssetRequest(entry))));
    } catch (error) {
      requireCatalogSession(
        binding,
        get,
        "Catalog changed while photos were being removed. Reopen the original catalog to reconcile the results.",
      );
      const message = formatPickerError(error);
      set({ importError: message });
      throw new Error(message);
    }
    requireCatalogSession(
      binding,
      get,
      "Catalog changed after photos were removed. Reopen the original catalog to reconcile the results.",
    );
    removeEntriesForAssets(
      new Set(targets.map((entry) => entry.assetId)),
      binding,
      set,
      get,
    );
  },

  createCatalog: async (displayName) => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      set({ importError: "Catalog name is required." });
      return;
    }
    const generation = beginFolderOperation();
    await finishImport(generation, () => createCatalogSession(trimmed), "import", set, get);
    await refreshCatalogSummaries(set).catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
  },

  addCatalogRoot: async () => {
    const generation = beginFolderOperation();
    await finishImport(generation, async () => (await addCatalogRootSession()).state, "restore", set, get);
    await refreshCatalogSummaries(set).catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
  },

  relinkCatalogRoot: async (rootId) => {
    const target = rootId ?? get().catalogRoots.find((root) => root.health !== "online")?.rootId;
    if (!target) {
      set({ importError: "No catalog root is available to relink." });
      return;
    }
    const generation = beginFolderOperation();
    await finishImport(generation, () => relinkCatalogRootSession(target), "restore", set, get);
    await refreshCatalogSummaries(set).catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
  },

  renameCatalog: async (displayName) => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      set({ importError: "Catalog name is required." });
      return;
    }
    try {
      const state = await renameActiveCatalog(trimmed);
      applyHydratedState(state, set, get);
      await refreshCatalogSummaries(set);
    } catch (error) {
      set({ importError: formatPickerError(error) });
    }
  },

  removeCatalogRecent: async (catalogId) => {
    const catalog = get().catalogs.find((item) => item.catalogId === catalogId);
    if (!catalog) return;
    if (get().catalogId === catalogId) {
      set({ importError: "Close the active catalog before removing it from recents." });
      return;
    }
    try {
      await removeCatalogSession(catalogId, catalog.displayName, false);
      await refreshCatalogSummaries(set);
    } catch (error) {
      set({ importError: formatPickerError(error) });
    }
  },

  deleteCatalog: async (catalogId, confirmation) => {
    const catalog = get().catalogs.find((item) => item.catalogId === catalogId);
    if (!catalog) return;
    if (confirmation !== catalog.displayName) {
      set({ importError: "Type the exact catalog name to delete it." });
      return;
    }
    try {
      await removeCatalogSession(catalogId, confirmation, true);
      if (get().catalogId === catalogId) {
        useDevelopStore.getState().clearLibrarySessions();
        set({
          catalogId: null,
          sessionId: null,
          catalogRevision: 0,
          folderName: null,
          entries: [],
          unresolvedEntries: [],
          fingerprintCoverage: EMPTY_FINGERPRINT_COVERAGE,
          importPresets: [],
          catalogRoots: [],
          entryMetadata: {},
          albums: [],
          archivedEntryIds: [],
          libraryWorkspace: createLibraryWorkspaceState([]),
          catalogView: { type: "all" },
          selectedEntryId: null,
          selectedEntryIds: [],
          selectionAnchorId: null,
          needsFolderAccess: true,
          metadataAnalysis: null,
        });
      }
      await refreshCatalogSummaries(set);
    } catch (error) {
      set({ importError: formatPickerError(error) });
    }
  },

  switchCatalog: async (catalogId) => {
    const generation = beginFolderOperation();
    await finishImport(generation, () => switchCatalogSession(catalogId), "restore", set, get);
    await refreshCatalogSummaries(set).catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
  },

  openCatalogManager: () => set({ catalogManagerOpen: true }),
  closeCatalogManager: () => set({ catalogManagerOpen: false }),
  refreshCatalogs: async () => {
    await refreshCatalogSummaries(set);
  },

  cancelFolderOperation: () => {
    beginFolderOperation();
    void cancelCatalogScan().catch((error: unknown) => {
      set({ importError: formatPickerError(error) });
    });
    set({ importState: "idle", importStatus: null, needsFolderAccess: get().entries.length === 0 });
  },

  refreshMetadataAnalysis: () => startMetadataAnalysis(set, get),

  refreshEntryMetadataAnalysis: (entryId) => {
    startMetadataAnalysis(set, get, { entryIds: [entryId], force: true });
  },

  cancelMetadataAnalysis: () => {
    const current = get();
    if (
      current.catalogId === null ||
      current.sessionId === null ||
      current.metadataAnalysis === null ||
      current.metadataAnalysis.cancelled
    ) {
      return;
    }
    const operationId = current.metadataAnalysis.operationId;
    set({ metadataAnalysis: { ...current.metadataAnalysis, cancelled: true } });
    void getDarkroomAPI().catalogCancelMetadataAnalysis({
      catalogId: current.catalogId,
      sessionId: current.sessionId,
      operationId,
    }).catch((error: unknown) => {
      if (get().metadataAnalysis?.operationId === operationId) {
        set({ importError: formatPickerError(error) });
      }
    });
  },

  clearLibrary: async () => {
    beginFolderOperation();
    try {
      await closeActiveCatalog();
    } catch (error) {
      set({ importError: formatPickerError(error) });
      return;
    }
    useDevelopStore.getState().clearLibrarySessions();
    set({
      catalogId: null,
      sessionId: null,
      catalogRevision: 0,
      folderName: null,
      entries: [],
      unresolvedEntries: [],
      fingerprintCoverage: EMPTY_FINGERPRINT_COVERAGE,
      importPresets: [],
      catalogRoots: [],
      entryMetadata: {},
      albums: [],
      archivedEntryIds: [],
      libraryWorkspace: createLibraryWorkspaceState([]),
      catalogView: { type: "all" },
      selectedEntryId: null,
      selectedEntryIds: [],
      selectionAnchorId: null,
      importState: "idle",
      importStatus: null,
      importError: null,
      metadataAnalysis: null,
      catalogRecovery: null,
      needsFolderAccess: false,
    });
  },

  bootstrapLibrary: async () => {
    fsDebug("bootstrapLibrary: start");
    set({ hasBootstrapped: false });
    try {
      const result = await bootstrapCatalog();
      if (!result.session) {
        clearSessionCatalog();
        useDevelopStore.getState().clearLibrarySessions();
        set({
          catalogId: null,
          sessionId: null,
          catalogRevision: 0,
          folderName: null,
          entries: [],
          unresolvedEntries: [],
          fingerprintCoverage: EMPTY_FINGERPRINT_COVERAGE,
          importPresets: [],
          catalogRoots: [],
          entryMetadata: {},
          albums: [],
          archivedEntryIds: [],
          libraryWorkspace: createLibraryWorkspaceState([]),
          selectedEntryId: null,
          selectedEntryIds: [],
          selectionAnchorId: null,
          needsFolderAccess: true,
          catalogs: result.catalogs,
          catalogRecovery: result.recovery?.message ?? null,
          importError: null,
          metadataAnalysis: null,
        });
        return;
      }
      const catalog = result.catalogs.find((item) => item.catalogId === result.session?.catalogId);
      if (!catalog) throw new Error("The active catalog is not registered.");
      const activation: CatalogActivationResult = { catalog, session: result.session };
      const generation = beginFolderOperation();
      set({ catalogs: result.catalogs });
      await finishImport(generation, () => activateCatalog(activation), "restore", set, get);
    } catch (error) {
      set({ importError: formatPickerError(error), needsFolderAccess: true });
    } finally {
      set({ hasBootstrapped: true });
    }
  },
}));

subscribeCatalogState((state) => {
  const current = useLibraryStore.getState();
  if (
    current.catalogId !== state.catalogId ||
    current.sessionId !== state.sessionId
  ) {
    return;
  }
  applyHydratedState(state, useLibraryStore.setState, useLibraryStore.getState);
});

setDevelopMetadataWriter((entryId, values) => {
  useLibraryStore.getState().restoreEntryMetadata(entryId, values);
});

export function getEntryById(
  entries: LibraryEntry[],
  id: string,
): LibraryEntry | undefined {
  return entries.find((entry) => entry.id === id);
}
