import {
  getFormatCapability,
  getFormatCapabilityForFileName,
} from "../formats/registry";
import type {
  CatalogActivationResult,
  CatalogApplyMutation,
  CatalogBootstrapResult,
  CatalogLiveStateView,
  CatalogLiveRootView,
  CatalogPresetView,
  CatalogRemoveRequest,
  CatalogRootRequest,
} from "../catalog/api";
import type { CatalogLiveMetadataPatch } from "../catalog/live";
import type { CatalogFingerprintBackfillProgress } from "../catalog/fingerprint-backfill";
import type {
  RelinkAcceptedPairInput,
  RelinkServiceApplyResult,
  RelinkServiceDraft,
} from "../catalog/relink";
import type {
  CatalogAdminBackupResult,
  CatalogAdminCloneResult,
  CatalogAdminInspectReport,
  CatalogAdminOptimizePreview,
  CatalogAdminOptimizeResult,
  CatalogBackupPolicy,
  CatalogBackupPolicyState,
} from "../catalog/admin";
import { createPresetId, parseEntryId, parseSourceId, type AssetId, type CatalogId, type OperationId, type PresetId, type RootId } from "../catalog/ids";
import type {
  LibraryOperationStatus,
  ScanProgressPhase,
  SessionId,
} from "../catalog/runtime";
import type { Album, EntryMetadata } from "../catalog/types";
import {
  parseLibraryWorkspaceJson,
  type LibraryWorkspaceState,
} from "../library/model";
import type { FormatCapabilityReport } from "../formats/types";
import type { CatalogV3FingerprintCoverage } from "../catalog/v3";
import { createEntryMetadata } from "../catalog/defaults";
import { decodePersistedDevelopDocument } from "../develop/v3/codec";
import { parseImportTemplate, parseJsonValue, type JsonValue } from "../import/domain";
import type { LibraryEntry } from "./types";
import { getDarkroomAPI } from "./platform";
import type {
  CatalogImportDraftView,
  CatalogImportExecutionView,
  CatalogImportPrepareRequest,
} from "../import/api";
import type {
  AutoImportCancelRequest,
  AutoImportConfigureRequest,
  AutoImportControlRequest,
  AutoImportStatus,
} from "../import/auto-import-api";

export interface ActiveCatalogSession {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  displayName: string;
  readonly roots: readonly {
    readonly catalogId: CatalogId;
    readonly rootId: RootId;
    readonly label: string;
  }[];
  revision: number;
}

export type CatalogRootState = CatalogLiveRootView;

export interface HydratedCatalogState {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly displayName: string;
  readonly revision: number;
  readonly entries: LibraryEntry[];
  readonly unresolvedEntries: LibraryEntry[];
  readonly fingerprintCoverage: CatalogV3FingerprintCoverage;
  readonly importPresets: readonly CatalogPresetView[];
  readonly entryMetadata: Record<string, EntryMetadata>;
  readonly albums: Album[];
  readonly archivedEntryIds: string[];
  readonly libraryWorkspace: LibraryWorkspaceState;
  readonly roots: readonly CatalogRootState[];
}

export interface ScanProgress {
  readonly count: number;
  readonly phase?: ScanProgressPhase;
  readonly directoriesVisited?: number;
  readonly filesConsidered?: number;
  readonly status?: Exclude<LibraryOperationStatus, "running">;
  readonly errorMessage?: string;
  /** Deliberately blank: main-process currentPath is not renderer-safe. */
  readonly latestPath: string;
  readonly latestEntry?: LibraryEntry;
  readonly done?: boolean;
}

const SCAN_TIMEOUT_MS = 90_000;
const SYNC_MUTATIONS_PER_BATCH = 200;

let activeSession: ActiveCatalogSession | null = null;
let activeView: CatalogLiveStateView | null = null;
let activeScan: {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
} | null = null;
let generation = 0;
let mutationQueue: Promise<void> = Promise.resolve();
let activeEventUnsubscribe: (() => void) | null = null;
let activeEventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let activeEventSequence = 0;
let activeScanProgressHandler: ((progress: ScanProgress) => void) | undefined;
let catalogStateListener: ((state: HydratedCatalogState) => void) | null = null;

interface CatalogSyncBinding {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly generation: number;
  readonly revision: number;
}

type CatalogManagementAPI = {
  catalogRelinkRoot(request: CatalogRootRequest): Promise<CatalogActivationResult>;
  catalogRemove(request: CatalogRemoveRequest): Promise<void>;
};

function hasCatalogManagementAPI(
  api: ReturnType<typeof getDarkroomAPI>,
): api is ReturnType<typeof getDarkroomAPI> & CatalogManagementAPI {
  return "catalogRelinkRoot" in api &&
    typeof api.catalogRelinkRoot === "function" &&
    "catalogRemove" in api &&
    typeof api.catalogRemove === "function";
}

function requireCatalogManagementAPI(): ReturnType<typeof getDarkroomAPI> & CatalogManagementAPI {
  const api = getDarkroomAPI();
  if (!hasCatalogManagementAPI(api)) {
    throw new Error("Catalog management is unavailable. Quit and restart Darkroom.");
  }
  return api;
}

function clearCatalogEventListener(): void {
  activeEventUnsubscribe?.();
  activeEventUnsubscribe = null;
  if (activeEventRefreshTimer !== null) {
    clearTimeout(activeEventRefreshTimer);
    activeEventRefreshTimer = null;
  }
  activeScanProgressHandler = undefined;
  activeEventSequence = 0;
}

function emitCatalogState(state: HydratedCatalogState): void {
  catalogStateListener?.(state);
}

function scheduleCatalogEventRefresh(
  eventCatalogId: CatalogId,
  eventSessionId: SessionId,
): void {
  if (activeEventRefreshTimer !== null) {
    clearTimeout(activeEventRefreshTimer);
  }
  activeEventRefreshTimer = setTimeout(() => {
    activeEventRefreshTimer = null;
    void queryActiveCatalog().then((state) => {
      if (
        activeSession?.catalogId === eventCatalogId &&
        activeSession.sessionId === eventSessionId
      ) {
        emitCatalogState(state);
      }
    }).catch(() => undefined);
  }, 100);
}

function installCatalogEventListener(session: ActiveCatalogSession): void {
  clearCatalogEventListener();
  const api = getDarkroomAPI();
  activeEventUnsubscribe = api.onCatalogEvent((event) => {
    if (
      event.catalogId !== session.catalogId ||
      event.sessionId !== session.sessionId ||
      event.sequence <= activeEventSequence
    ) {
      return;
    }
    activeEventSequence = event.sequence;
    if (event.kind === "scan-progress") {
      if (
        activeScan?.operationId === event.operationId &&
        activeScan.catalogId === event.catalogId &&
        activeScan.sessionId === event.sessionId
      ) {
        activeScanProgressHandler?.({
          count: event.payload.acceptedCount,
          phase: event.payload.phase,
          directoriesVisited: event.payload.directoriesVisited,
          filesConsidered: event.payload.filesConsidered,
          latestPath: "",
        });
      }
      return;
    }
    if (
      event.kind === "scan-terminal" &&
      activeScan?.operationId === event.operationId
    ) {
      activeScanProgressHandler?.({
        count: event.payload.acceptedCount,
        directoriesVisited: event.payload.directoriesVisited,
        filesConsidered: event.payload.filesConsidered,
        status: event.payload.status,
        errorMessage: event.payload.errorMessage,
        latestPath: "",
        done: true,
      });
    }
    scheduleCatalogEventRefresh(event.catalogId, event.sessionId);
  });
}

function basename(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

function formatAvailability(
  formatId: string | null,
  name: string,
): LibraryEntry["formatAvailability"] {
  const capability = formatId === null
    ? getFormatCapabilityForFileName(name)
    : getFormatCapability(formatId);
  if (!capability) {
    return {
      status: "unavailable",
      reason: "No format capability is registered for this asset.",
    };
  }
  return {
    status: capability.preview.status,
    reason: capability.recognitionReason ?? capability.preview.reason,
  };
}

function metadataFromAsset(
  asset: CatalogLiveStateView["assets"][number],
): EntryMetadata {
  const source = asset.metadata;
  let keywords: readonly string[] = [];
  try {
    const parsed: unknown = JSON.parse(source.keywordsJson);
    if (Array.isArray(parsed)) {
      keywords = [...new Set(parsed.filter((item): item is string => typeof item === "string"))];
    }
  } catch {
    keywords = [];
  }
  let develop: EntryMetadata["develop"];
  if (source.developJson !== null) {
    try {
      const parsed: unknown = JSON.parse(source.developJson);
      const decoded = decodePersistedDevelopDocument(parsed);
      if (decoded.kind === "invalid") {
        throw new Error(`Catalog Develop document is invalid: ${decoded.message}`);
      }
      develop = decoded.kind === "editable" ? decoded.document : decoded.raw;
    } catch (error) {
      throw new Error("Catalog Develop JSON could not be decoded.", { cause: error });
    }
  }
  return createEntryMetadata({
    pick: source.pick,
    rating: source.rating,
    colorLabel: source.colorLabel,
    title: source.title,
    caption: source.caption,
    copyright: source.copyright,
    keywords,
    ...(develop ? { develop } : {}),
    developUpdatedAt: source.developUpdatedAt,
    updatedAt: source.updatedAt,
  });
}

function entryFromAsset(
  asset: CatalogLiveStateView["assets"][number],
  session: ActiveCatalogSession,
): LibraryEntry {
  const name = basename(asset.relativePath);
  const capability = asset.formatId === null
    ? getFormatCapabilityForFileName(name)
    : getFormatCapability(asset.formatId);
  const entryId = asset.entryId ?? parseEntryId(asset.assetId);
  return {
    id: entryId,
    sourceId: asset.sourceId ?? parseSourceId(asset.assetId),
    assetId: asset.assetId,
    entryKind: asset.entryKind ?? (String(entryId) === String(asset.assetId) ? "original" : "virtual"),
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    rootId: asset.rootId,
    name,
    relativePath: asset.relativePath,
    size: asset.observation?.byteLength ?? 0,
    lastModified: asset.observation?.modifiedAt ?? 0,
    profileId: capability?.profileId ?? null,
    assetRevision: asset.revision,
    health: asset.health,
    formatId: asset.formatId,
    formatAvailability: formatAvailability(asset.formatId, name),
    fingerprintStatus: asset.fingerprintStatus,
    fingerprintSha256: asset.fingerprintSha256,
  };
}

function hydrate(
  view: CatalogLiveStateView,
  session: ActiveCatalogSession,
): HydratedCatalogState {
  const allEntries = view.assets.map((asset) => entryFromAsset(asset, session));
  const entries = allEntries.filter((entry) => entry.health === "present");
  const unresolvedEntries = allEntries.filter((entry) => entry.health !== "present");
  const entryMetadata: Record<string, EntryMetadata> = {};
  const archivedEntryIds: string[] = [];
  for (const asset of view.assets) {
    const entryId = asset.entryId ?? parseEntryId(asset.assetId);
    entryMetadata[entryId] = metadataFromAsset(asset);
    if (asset.metadata.archive) {
      archivedEntryIds.push(entryId);
    }
  }
  const albums = view.albums.map((album) => ({
    id: album.albumId,
    name: album.name,
    entryIds: [...album.entryIds],
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
  }));
  const validEntryIds = new Set(view.assets.map((asset) => asset.entryId ?? parseEntryId(asset.assetId)));
  const libraryWorkspace = parseLibraryWorkspaceJson(
    view.libraryStateJson,
    albums,
    validEntryIds,
  );
  return {
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    displayName: session.displayName,
    revision: view.catalog.revision,
    entries,
    unresolvedEntries,
    fingerprintCoverage: view.fingerprintCoverage,
    importPresets: view.presets,
    entryMetadata,
    albums,
    archivedEntryIds,
    libraryWorkspace,
    roots: view.roots,
  };
}

function requireSession(): ActiveCatalogSession {
  if (!activeSession) {
    throw new Error("No catalog is open.");
  }
  return activeSession;
}

function captureCatalogSyncBinding(): CatalogSyncBinding {
  const session = requireSession();
  return {
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    generation,
    revision: session.revision,
  };
}

function isCurrentCatalogSync(binding: CatalogSyncBinding): boolean {
  return generation === binding.generation &&
    activeSession?.catalogId === binding.catalogId &&
    activeSession.sessionId === binding.sessionId;
}

function activeAdminRequest(): {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
} {
  const session = requireSession();
  return { catalogId: session.catalogId, sessionId: session.sessionId };
}

function updateSessionRevision(revision: number): void {
  if (activeSession) {
    activeSession.revision = revision;
  }
}

function setActivation(activation: CatalogActivationResult): ActiveCatalogSession {
  clearCatalogEventListener();
  generation += 1;
  activeSession = {
    catalogId: activation.session.catalogId,
    sessionId: activation.session.sessionId,
    displayName: activation.catalog.displayName,
    roots: activation.session.roots,
    revision: 0,
  };
  activeView = null;
  activeScan = null;
  return activeSession;
}

export function getSessionGeneration(): number {
  return generation;
}

export function getActiveCatalogSession(): ActiveCatalogSession | null {
  return activeSession;
}

export function getActiveCatalogView(): CatalogLiveStateView | null {
  return activeView;
}

export function getAssetRequest(
  entry: Pick<LibraryEntry, "catalogId" | "sessionId" | "assetId">,
): {
  catalogId: CatalogId;
  sessionId: SessionId;
  assetId: AssetId;
} {
  return {
    catalogId: entry.catalogId,
    sessionId: entry.sessionId,
    assetId: entry.assetId,
  };
}

export function clearSessionCatalog(): void {
  clearCatalogEventListener();
  generation += 1;
  activeSession = null;
  activeView = null;
  activeScan = null;
  mutationQueue = Promise.resolve();
}

export function setSessionCatalog(
  activation: CatalogActivationResult,
  view: CatalogLiveStateView,
): HydratedCatalogState {
  const session = setActivation(activation);
  updateSessionRevision(view.catalog.revision);
  activeView = view;
  try {
    installCatalogEventListener(session);
  } catch {
    // Unit consumers can hydrate a session without an Electron bridge.
  }
  return hydrate(view, session);
}

export function subscribeCatalogState(
  listener: (state: HydratedCatalogState) => void,
): () => void {
  catalogStateListener = listener;
  return () => {
    if (catalogStateListener === listener) {
      catalogStateListener = null;
    }
  };
}

export function getSessionCatalog(): {
  catalogId: CatalogId | null;
  sessionId: SessionId | null;
  displayName: string | null;
  entries: LibraryEntry[];
  revision: number;
} {
  const session = activeSession;
  return {
    catalogId: session?.catalogId ?? null,
    sessionId: session?.sessionId ?? null,
    displayName: session?.displayName ?? null,
    entries: session && activeView
      ? activeView.assets.map((asset) => entryFromAsset(asset, session))
      : [],
    revision: activeSession?.revision ?? 0,
  };
}

export function hasSessionCatalog(): boolean {
  return activeSession !== null;
}

export async function closeActiveCatalog(): Promise<void> {
  const session = activeSession;
  if (session) {
    await getDarkroomAPI().catalogClose({
      catalogId: session.catalogId,
      sessionId: session.sessionId,
    });
  }
  clearSessionCatalog();
}

export async function bootstrapCatalog(): Promise<CatalogBootstrapResult> {
  return getDarkroomAPI().catalogBootstrap();
}

export async function getFormatCapabilityReport(): Promise<FormatCapabilityReport> {
  return getDarkroomAPI().getFormatCapabilityReport();
}

export async function getFingerprintBackfillStatus(): Promise<CatalogFingerprintBackfillProgress | null> {
  return getDarkroomAPI().catalogFingerprintStatus(activeAdminRequest());
}

export async function startFingerprintBackfill(): Promise<CatalogFingerprintBackfillProgress> {
  return getDarkroomAPI().catalogFingerprintStart(activeAdminRequest());
}

export async function resumeFingerprintBackfill(
  sourceOperationId: OperationId,
): Promise<CatalogFingerprintBackfillProgress> {
  return getDarkroomAPI().catalogFingerprintResume({
    ...activeAdminRequest(),
    sourceOperationId,
  });
}

export async function recoverFingerprintBackfill(): Promise<CatalogFingerprintBackfillProgress | null> {
  return getDarkroomAPI().catalogFingerprintRecover(activeAdminRequest());
}

export async function cancelFingerprintBackfill(operationId: OperationId): Promise<void> {
  return getDarkroomAPI().catalogFingerprintCancel({ ...activeAdminRequest(), operationId });
}

export function subscribeFingerprintBackfillProgress(
  listener: (progress: CatalogFingerprintBackfillProgress) => void,
): () => void {
  return getDarkroomAPI().onCatalogFingerprintProgress(listener);
}

export async function inspectCatalogAdmin(): Promise<CatalogAdminInspectReport> {
  return getDarkroomAPI().catalogAdminInspect(activeAdminRequest());
}

export async function backupCatalogAdmin(): Promise<CatalogAdminBackupResult> {
  return getDarkroomAPI().catalogAdminBackup(activeAdminRequest());
}

export async function exportCatalogAdmin(): Promise<CatalogAdminBackupResult | null> {
  return getDarkroomAPI().catalogAdminExport(activeAdminRequest());
}

export async function validateCatalogAdminPackage(): Promise<CatalogAdminInspectReport | null> {
  return getDarkroomAPI().catalogAdminValidatePackage();
}

export async function importCatalogAdminAsNew(
  displayName: string,
): Promise<CatalogAdminCloneResult | null> {
  return getDarkroomAPI().catalogAdminImportAsNew({ displayName });
}

export async function previewCatalogAdminOptimize(): Promise<CatalogAdminOptimizePreview> {
  return getDarkroomAPI().catalogAdminOptimizePreview(activeAdminRequest());
}

export async function optimizeCatalogAdmin(): Promise<CatalogAdminOptimizeResult> {
  return getDarkroomAPI().catalogAdminOptimize(activeAdminRequest());
}

export async function getCatalogAdminBackupPolicy(): Promise<CatalogBackupPolicyState> {
  return getDarkroomAPI().catalogAdminGetBackupPolicy(activeAdminRequest());
}

export async function setCatalogAdminBackupPolicy(
  policy: CatalogBackupPolicy,
): Promise<CatalogBackupPolicyState> {
  return getDarkroomAPI().catalogAdminSetBackupPolicy({
    ...activeAdminRequest(),
    policy,
  });
}

export async function runCatalogAdminScheduledBackup(): Promise<CatalogAdminBackupResult | null> {
  return getDarkroomAPI().catalogAdminRunScheduledBackup(activeAdminRequest());
}

export interface SaveImportPresetInput {
  readonly presetId?: PresetId;
  readonly name: string;
  readonly templatePattern: string;
  readonly payload: JsonValue;
  readonly isDefault: boolean;
}

export async function saveImportPreset(
  input: SaveImportPresetInput,
): Promise<HydratedCatalogState> {
  const session = requireSession();
  const view = await getDarkroomAPI().catalogQuery({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: null,
  });
  const existing = input.presetId === undefined
    ? undefined
    : view.presets.find((preset) => preset.presetId === input.presetId);
  const now = Date.now();
  await getDarkroomAPI().catalogApply({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: view.catalog.revision,
    mutations: [{
      kind: "preset-upsert",
      presetId: input.presetId ?? createPresetId(),
      name: input.name.trim(),
      payload: {
        version: 1,
        template: parseImportTemplate({ pattern: input.templatePattern }),
        payload: parseJsonValue(input.payload, "Import preset payload"),
        isDefault: input.isDefault,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }],
  });
  return queryActiveCatalog();
}

export async function renameImportPreset(
  presetId: PresetId,
  name: string,
): Promise<HydratedCatalogState> {
  const session = requireSession();
  const view = await getDarkroomAPI().catalogQuery({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: null,
  });
  await getDarkroomAPI().catalogApply({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: view.catalog.revision,
    mutations: [{ kind: "preset-rename", presetId, name: name.trim(), updatedAt: Date.now() }],
  });
  return queryActiveCatalog();
}

export async function deleteImportPreset(
  presetId: PresetId,
): Promise<HydratedCatalogState> {
  const session = requireSession();
  const view = await getDarkroomAPI().catalogQuery({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: null,
  });
  await getDarkroomAPI().catalogApply({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: view.catalog.revision,
    mutations: [{ kind: "preset-delete", presetId }],
  });
  return queryActiveCatalog();
}

export async function setDefaultImportPreset(
  presetId: PresetId,
): Promise<HydratedCatalogState> {
  const session = requireSession();
  const view = await getDarkroomAPI().catalogQuery({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: null,
  });
  await getDarkroomAPI().catalogApply({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: view.catalog.revision,
    mutations: [{ kind: "preset-set-default", presetId, updatedAt: Date.now() }],
  });
  return queryActiveCatalog();
}

function assertImportSession(input: Pick<CatalogImportPrepareRequest, "catalogId" | "sessionId">): void {
  const session = requireSession();
  if (session.catalogId !== input.catalogId || session.sessionId !== input.sessionId) {
    throw new Error("Catalog import session is no longer active.");
  }
}

export async function prepareCatalogImport(
  input: CatalogImportPrepareRequest,
): Promise<CatalogImportDraftView> {
  assertImportSession(input);
  return getDarkroomAPI().catalogImportPrepare(input);
}

export async function reviewCatalogImport(
  operationId: OperationId,
): Promise<CatalogImportDraftView> {
  const session = requireSession();
  return getDarkroomAPI().catalogImportReview({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    operationId,
  });
}

export async function runCatalogImport(
  operationId: OperationId,
): Promise<CatalogImportExecutionView> {
  const session = requireSession();
  const result = await getDarkroomAPI().catalogImportRun({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    operationId,
  });
  await refreshActiveCatalog();
  return result;
}

export async function cancelCatalogImport(operationId: OperationId): Promise<void> {
  const session = requireSession();
  await getDarkroomAPI().catalogImportCancel({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    operationId,
  });
}

function assertAutoImportSession(input: Pick<AutoImportConfigureRequest, "catalogId" | "sessionId">): void {
  const session = requireSession();
  if (session.catalogId !== input.catalogId || session.sessionId !== input.sessionId) {
    throw new Error("Auto Import session is no longer active.");
  }
}

export async function configureCatalogAutoImport(
  input: AutoImportConfigureRequest,
): Promise<AutoImportStatus> {
  assertAutoImportSession(input);
  return getDarkroomAPI().catalogAutoImportConfigure(input);
}

async function autoImportControl(action: AutoImportControlRequest["action"]): Promise<AutoImportStatus> {
  const session = requireSession();
  return getDarkroomAPI().catalogAutoImportStatus({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    action,
  });
}

export function getCatalogAutoImportStatus(): Promise<AutoImportStatus> {
  return autoImportControl("status");
}

export function enableCatalogAutoImport(): Promise<AutoImportStatus> {
  return autoImportControl("enable");
}

export function disableCatalogAutoImport(): Promise<AutoImportStatus> {
  return autoImportControl("disable");
}

export function pauseCatalogAutoImport(): Promise<AutoImportStatus> {
  return autoImportControl("pause");
}

export function resumeCatalogAutoImport(): Promise<AutoImportStatus> {
  return autoImportControl("resume");
}

export function retryCatalogAutoImport(): Promise<AutoImportStatus> {
  return autoImportControl("retry-failed");
}

export function clearCatalogAutoImportFailures(): Promise<AutoImportStatus> {
  return autoImportControl("clear-failed");
}

export async function cancelCatalogAutoImport(queueId: OperationId): Promise<AutoImportStatus> {
  const session = requireSession();
  const request: AutoImportCancelRequest = {
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    queueId,
  };
  return getDarkroomAPI().catalogAutoImportCancel(request);
}

export async function openCatalogAutoImportIngress(): Promise<void> {
  const session = requireSession();
  await getDarkroomAPI().catalogAutoImportOpenIngress({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
  });
}

export async function activateCatalog(
  activation: CatalogActivationResult,
): Promise<HydratedCatalogState> {
  const session = setActivation(activation);
  const view = await getDarkroomAPI().catalogQuery({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: null,
  });
  if (activeSession?.sessionId !== session.sessionId) {
    throw new Error("Catalog session changed while loading.");
  }
  activeView = view;
  activeSession.displayName = view.catalog.displayName;
  updateSessionRevision(view.catalog.revision);
  installCatalogEventListener(session);
  return hydrate(view, session);
}

export async function queryActiveCatalog(): Promise<HydratedCatalogState> {
  const session = requireSession();
  const requestedGeneration = generation;
  const view = await getDarkroomAPI().catalogQuery({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: null,
  });
  if (
    requestedGeneration !== generation ||
    activeSession?.sessionId !== session.sessionId
  ) {
    throw new Error("Stale catalog session result.");
  }
  activeView = view;
  activeSession.displayName = view.catalog.displayName;
  updateSessionRevision(view.catalog.revision);
  return hydrate(view, session);
}

export async function refreshActiveCatalog(): Promise<HydratedCatalogState> {
  const state = await queryActiveCatalog();
  emitCatalogState(state);
  return state;
}

export async function createCatalog(
  displayName: string,
): Promise<HydratedCatalogState> {
  const activation = await getDarkroomAPI().catalogCreate({ displayName });
  return activateCatalog(activation);
}

export async function openCatalog(
  catalogId: CatalogId,
): Promise<HydratedCatalogState> {
  const activation = await getDarkroomAPI().catalogOpen({ catalogId });
  return activateCatalog(activation);
}

export async function switchCatalog(
  catalogId: CatalogId,
): Promise<HydratedCatalogState> {
  const activation = await getDarkroomAPI().catalogSwitch({ catalogId });
  return activateCatalog(activation);
}

export async function relinkCatalogRoot(
  rootId: RootId,
): Promise<HydratedCatalogState> {
  const session = requireSession();
  const activation = await requireCatalogManagementAPI().catalogRelinkRoot({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    rootId,
  });
  return activateCatalog(activation);
}

export async function prepareCatalogRelink(): Promise<RelinkServiceDraft | null> {
  const session = requireSession();
  return getDarkroomAPI().catalogRelinkFilesPrepare({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
  });
}

export async function applyCatalogRelink(
  operationId: OperationId,
  acceptedPairs: readonly RelinkAcceptedPairInput[],
): Promise<RelinkServiceApplyResult> {
  const session = requireSession();
  const result = await getDarkroomAPI().catalogRelinkFilesApply({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    operationId,
    acceptedPairs,
  });
  await refreshActiveCatalog();
  return result;
}

export async function cancelCatalogRelink(operationId: OperationId): Promise<void> {
  const session = requireSession();
  await getDarkroomAPI().catalogRelinkFilesCancel({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    operationId,
  });
}

export async function removeCatalog(
  catalogId: CatalogId,
  confirmation: string,
  deleteFile: boolean,
): Promise<void> {
  await requireCatalogManagementAPI().catalogRemove({
    catalogId,
    confirmation,
    deleteFile,
  });
  if (activeSession?.catalogId === catalogId) {
    clearSessionCatalog();
  }
}

export async function renameActiveCatalog(
  displayName: string,
): Promise<HydratedCatalogState> {
  const session = requireSession();
  const view = await getDarkroomAPI().catalogQuery({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: null,
  });
  await getDarkroomAPI().catalogApply({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    expectedRevision: view.catalog.revision,
    mutations: [{ kind: "rename-catalog", displayName }],
  });
  return queryActiveCatalog();
}

export async function addCatalogRoot(): Promise<{
  state: HydratedCatalogState;
  rootId: RootId;
}> {
  const session = requireSession();
  const result = await getDarkroomAPI().catalogAddRoot({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
  });
  return { state: await queryActiveCatalog(), rootId: result.rootId };
}

export async function scanCatalogRoot(
  rootId: RootId,
  onProgress?: (progress: ScanProgress) => void,
): Promise<HydratedCatalogState> {
  const session = requireSession();
  const requestedGeneration = generation;
  const operation = await getDarkroomAPI().catalogStartScan({
    catalogId: session.catalogId,
    sessionId: session.sessionId,
    rootId,
    timeoutMs: SCAN_TIMEOUT_MS,
  });
  activeScan = {
    operationId: operation.operationId,
    catalogId: session.catalogId,
    sessionId: session.sessionId,
  };
  activeScanProgressHandler = requestedGeneration === generation
    ? onProgress
    : undefined;
  try {
    const result = await getDarkroomAPI().catalogWaitOperation({
      catalogId: session.catalogId,
      sessionId: session.sessionId,
      operationId: operation.operationId,
    });
    if (
      requestedGeneration !== generation ||
      activeSession?.sessionId !== session.sessionId
    ) {
      throw new Error("Stale catalog scan result.");
    }
    if (result.status !== "completed") {
      onProgress?.({
        count: result.acceptedCount,
        directoriesVisited: result.directoriesVisited,
        filesConsidered: result.filesConsidered,
        ...(result.status === "running" ? {} : { status: result.status }),
        errorMessage: result.errorMessage,
        latestPath: "",
        done: true,
      });
      throw new Error(result.errorMessage ?? `Catalog scan ${result.status}.`);
    }
    onProgress?.({
      count: result.acceptedCount,
      directoriesVisited: result.directoriesVisited,
      filesConsidered: result.filesConsidered,
      status: result.status,
      latestPath: "",
      done: true,
    });
    return queryActiveCatalog();
  } finally {
    if (activeScan?.operationId === operation.operationId) {
      activeScanProgressHandler = undefined;
    }
    if (activeScan?.operationId === operation.operationId) {
      activeScan = null;
    }
  }
}

export async function cancelCatalogScan(): Promise<void> {
  const scan = activeScan;
  if (!scan) return;
  await getDarkroomAPI().catalogCancelScan(scan);
  activeScan = null;
}

function metadataPatchFor(
  asset: CatalogLiveStateView["assets"][number],
  desired: EntryMetadata,
  desiredArchive: boolean,
): CatalogLiveMetadataPatch | null {
  const current = asset.metadata;
  let patch: CatalogLiveMetadataPatch = {
    version: 1,
    ...(current.pick === desired.pick ? {} : { pick: desired.pick }),
    ...(current.rating === desired.rating ? {} : { rating: desired.rating }),
    ...(current.colorLabel === desired.colorLabel ? {} : { colorLabel: desired.colorLabel }),
    ...(current.archive === desiredArchive ? {} : { archive: desiredArchive }),
    ...(current.developUpdatedAt === desired.developUpdatedAt ? {} : { developUpdatedAt: desired.developUpdatedAt }),
    ...(current.updatedAt === desired.updatedAt ? {} : { updatedAt: desired.updatedAt }),
    ...(current.title === desired.title ? {} : { title: desired.title }),
    ...(current.caption === desired.caption ? {} : { caption: desired.caption }),
    ...(current.copyright === desired.copyright ? {} : { copyright: desired.copyright }),
    ...(current.keywordsJson === JSON.stringify(desired.keywords) ? {} : { keywordsJson: JSON.stringify(desired.keywords) }),
  };
  if (desired.develop !== undefined) {
    const developJson = JSON.stringify(desired.develop);
    if (current.developJson !== developJson) patch = { ...patch, developJson };
  } else if (current.developJson !== null) {
    patch = { ...patch, developJson: null };
  }
  return Object.keys(patch).length === 1 ? null : patch;
}

async function syncCatalogStateForBinding(
  binding: CatalogSyncBinding,
  entryMetadata: Record<string, EntryMetadata>,
  albums: readonly Album[],
  archivedEntryIds: readonly string[],
  libraryWorkspace: LibraryWorkspaceState,
): Promise<number> {
  if (!isCurrentCatalogSync(binding)) return binding.revision;
  const view = await getDarkroomAPI().catalogQuery({
    catalogId: binding.catalogId,
    sessionId: binding.sessionId,
    expectedRevision: null,
  });
  if (!isCurrentCatalogSync(binding)) return binding.revision;
  const mutations: CatalogApplyMutation[] = [];
  const archived = new Set(archivedEntryIds);
  for (const asset of view.assets) {
    const entryId = asset.entryId ?? parseEntryId(asset.assetId);
    const desired = entryMetadata[entryId];
    if (desired) {
      const patch = metadataPatchFor(asset, desired, archived.has(entryId));
      if (patch) {
        mutations.push({ kind: "metadata-patch", entryId, patch });
      }
    } else if (asset.metadata.archive !== archived.has(entryId)) {
      mutations.push({
        kind: "metadata-patch",
        entryId,
        patch: { version: 1, archive: archived.has(entryId) },
      });
    }
  }
  const desiredAlbums = new Map(
    albums.map((album, position) => [album.id, { album, position }]),
  );
  for (const current of view.albums) {
    const desired = desiredAlbums.get(current.albumId);
    if (!desired) {
      mutations.push({ kind: "album-delete", albumId: current.albumId });
      continue;
    }
    if (current.name !== desired.album.name) {
      mutations.push({
        kind: "album-rename",
        albumId: current.albumId,
        name: desired.album.name,
        updatedAt: desired.album.updatedAt,
      });
    }
    if (current.entryIds.join("\u001f") !== desired.album.entryIds.join("\u001f")) {
      mutations.push({
        kind: "album-membership-replace",
        albumId: current.albumId,
        entryIds: desired.album.entryIds.map(parseEntryId),
      });
    }
    desiredAlbums.delete(current.albumId);
  }
  for (const { album, position } of desiredAlbums.values()) {
    mutations.push({
      kind: "album-create",
      albumId: album.id,
      name: album.name,
      position,
      createdAt: album.createdAt,
      updatedAt: album.updatedAt,
    });
    if (album.entryIds.length > 0) {
      mutations.push({
        kind: "album-membership-replace",
        albumId: album.id,
        entryIds: album.entryIds.map(parseEntryId),
      });
    }
  }
  const libraryStateJson = JSON.stringify({
    ...libraryWorkspace,
    analysisByEntryId: {},
  });
  if (view.libraryStateJson !== libraryStateJson) {
    mutations.push({ kind: "library-state-replace", stateJson: libraryStateJson });
  }
  if (mutations.length === 0) {
    updateSessionRevision(view.catalog.revision);
    activeView = view;
    return view.catalog.revision;
  }
  let revision = view.catalog.revision;
  const api = getDarkroomAPI();
  for (let offset = 0; offset < mutations.length; offset += SYNC_MUTATIONS_PER_BATCH) {
    if (!isCurrentCatalogSync(binding)) return revision;
    const result = await api.catalogApply({
      catalogId: binding.catalogId,
      sessionId: binding.sessionId,
      expectedRevision: revision,
      mutations: mutations.slice(offset, offset + SYNC_MUTATIONS_PER_BATCH),
    });
    revision = result.revision;
    updateSessionRevision(revision);
  }
  if (!isCurrentCatalogSync(binding)) return revision;
  const nextView = await getDarkroomAPI().catalogQuery({
    catalogId: binding.catalogId,
    sessionId: binding.sessionId,
    expectedRevision: revision,
  });
  if (!isCurrentCatalogSync(binding)) return revision;
  activeView = nextView;
  updateSessionRevision(nextView.catalog.revision);
  return nextView.catalog.revision;
}

export async function syncCatalogState(
  entryMetadata: Record<string, EntryMetadata>,
  albums: readonly Album[],
  archivedEntryIds: readonly string[],
  libraryWorkspace: LibraryWorkspaceState,
): Promise<number> {
  return syncCatalogStateForBinding(
    captureCatalogSyncBinding(),
    entryMetadata,
    albums,
    archivedEntryIds,
    libraryWorkspace,
  );
}

export function scheduleCatalogStateSync(
  entryMetadata: Record<string, EntryMetadata>,
  albums: readonly Album[],
  archivedEntryIds: readonly string[],
  libraryWorkspace: LibraryWorkspaceState,
): Promise<number> {
  const binding = captureCatalogSyncBinding();
  const task = mutationQueue.then(() =>
    syncCatalogStateForBinding(
      binding,
      entryMetadata,
      albums,
      archivedEntryIds,
      libraryWorkspace,
    ),
  );
  mutationQueue = task.then(() => undefined, () => undefined);
  return task;
}
