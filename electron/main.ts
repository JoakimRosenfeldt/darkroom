import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getFolderName,
  trashFiles,
} from "./fs-service";
import { createCatalogRegistryStore } from "./catalog-registry";
import { migrateLegacyCatalogAtStartup } from "./catalog-startup-migration";
import {
  createNefDecoderService,
  type NefDecoderCommand,
} from "./nef-decoder-service";
import {
  createExportService,
  resolveApprovedExportSources,
  type ExportEncodeOptions,
  type ExportDestinationRequest,
  type ExportPixelPayload,
} from "./export-service";
import { parseExportDestinationRequest } from "../lib/export/types.ts";
import { createSettingsStore } from "./settings";
import { getAppRoot, getOutDir, startStaticServer } from "./static-server";
import {
  parseAiModelId,
  type AiModelDisclosureLink,
  type AiModelProgress,
} from "../lib/ai/types";
import { createAiModelService } from "./ai-model-service";
import { getAiModelDisclosureUrl } from "./ai-model-manifest";
import {
  registerAiModelProtocol,
  registerAiModelScheme,
} from "./ai-model-protocol";
import {
  createCatalogWorkerClient,
  type CatalogWorkerClient,
} from "./catalog-worker-client";
import {
  CatalogCoordinator,
  createCatalogCoordinatorRuntime,
  type CatalogNativeAdminLease,
  type CatalogFilesystemPort,
  type CatalogPathAllocatorPort,
  type CatalogPickerPort,
  type CatalogRegistryPort,
} from "./catalog-coordinator.ts";
import {
  CatalogAdminService,
  FileCatalogBackupPolicyStore,
  type CatalogAdminMaintenancePort,
} from "./catalog-admin-service.ts";
import {
  parseCatalogAdminImportRequest,
  parseCatalogAdminPolicyRequest,
  parseCatalogAdminSessionRequest,
} from "../lib/catalog/admin.ts";
import { NativeAssetAccess } from "./native-asset-access.ts";
import { DevelopAssetStore } from "./develop-asset-store.ts";
import { DevelopJobRuntime } from "./develop-job-runtime.ts";
import {
  parseDevelopAssetGcRequest,
  parseDevelopAssetPutRequest,
  parseDevelopAssetReadRequest,
  parseDevelopAssetTransitionRequest,
} from "../lib/develop/v3/asset-store.ts";
import {
  parseDevelopJobAcceptRequest,
  parseDevelopJobRetryRequest,
  parseDevelopJobStartRequest,
  parseDevelopJobTargetRequest,
  parseGenerativeRemoveConsentGrantRequest,
  parseGenerativeRemoveConsentRevokeRequest,
} from "../lib/develop/v3/job-api.ts";
import { CatalogWatcherReconcileAdapter } from "./catalog-watcher-adapter.ts";
import { WatcherReconciliationService } from "./watcher-reconciliation.ts";
import {
  createCatalogManualImportController,
  type CatalogManualImportController,
} from "./catalog-manual-import-controller.ts";
import { createFileTransactionJournal } from "./file-transaction-journal.ts";
import {
  createCatalogAutoImportRuntime,
  type CatalogAutoImportRuntime,
} from "./catalog-auto-import-runtime.ts";
import { createAutoImportStore } from "./auto-import-store.ts";
import { CatalogWorkLifecycle, type CatalogWorkToken } from "./catalog-work-lifecycle.ts";
import { CatalogFingerprintBackfillAdapter } from "./catalog-fingerprint-backfill-adapter.ts";
import {
  CatalogFingerprintBackfillService,
  parseFingerprintBackfillSnapshot,
  type FingerprintBackfillExecution,
  type FingerprintBackfillProgressEvent,
  type FingerprintBackfillSnapshot,
} from "./catalog-fingerprint-backfill-service.ts";
import { CatalogFingerprintBackfillStore } from "./catalog-fingerprint-backfill-store.ts";
import {
  CatalogAssetRelinkService,
  type CatalogRelinkSelectedCandidate,
} from "./catalog-asset-relink-service.ts";
import { createRuntimeFormatCapabilityReport } from "./format-capability-service.ts";
import type { FormatCapabilityReport, NikonRuntimePackageState } from "../lib/formats/types.ts";
import { isRuntimeNativeRoot, type AssetScopedOperations, type RuntimeRootProjection } from "./library-runtime.ts";
import { createOperationId, type AssetId, type CatalogId, type OperationId } from "../lib/catalog/ids.ts";
import { parseCatalogLiveQueryResult } from "../lib/catalog/live.ts";
import {
  parseCatalogDecodeRequest,
  parseCatalogSessionRequest,
  type CatalogBootstrapRecovery,
} from "../lib/catalog/api.ts";
import {
  parseRelinkApplyRequest,
  parseRelinkCancelRequest,
  parseRelinkPrepareRequest,
} from "../lib/catalog/relink.ts";
import { parseRelativePath, type SessionId } from "../lib/catalog/runtime.ts";
import {
  parseCatalogFingerprintBackfillOperationRequest,
  parseCatalogFingerprintBackfillRequest,
  parseCatalogFingerprintBackfillResumeRequest,
  type CatalogFingerprintBackfillProgress,
  type CatalogFingerprintBackfillRequest,
} from "../lib/catalog/fingerprint-backfill.ts";
import {
  parseCatalogImportOperationRequest,
  parseCatalogImportPrepareRequest,
} from "../lib/import/api.ts";
import {
  parseAutoImportCancelRequest,
  parseAutoImportConfigureRequest,
  parseAutoImportControlRequest,
} from "../lib/import/auto-import-api.ts";
import {
  parseMetadataAnalysisOperationRequest,
  parseMetadataAnalysisRequest,
  type MetadataAnalysisItem,
  type MetadataAnalysisProgress,
  type MetadataAnalysisRequest,
  type MetadataAnalysisResult,
} from "../lib/library/metadata-analysis.ts";
import { entryAnalysisCacheSignature } from "../lib/library/model.ts";
import {
  analyzeMetadataTargets,
  type MetadataAnalysisTarget,
} from "./metadata-analysis-service.ts";
import { CameraProfileService } from "./camera-profile-service.ts";
import {
  parseCameraProfileConflictRequest,
  parseCameraProfileRemoveRequest,
} from "../lib/camera-profiles/registry.ts";
import { MetadataCache } from "./metadata-cache.ts";
import { fingerprintNoFollowFile } from "./catalog-fingerprint-service.ts";
import {
  parseExactDuplicateTrashRequest,
  type ExactDuplicateTrashItemResult,
} from "../lib/library/duplicate-actions.ts";
import { DevelopPresetStore } from "./develop-preset-store.ts";
import { BUILT_IN_DEVELOP_PRESETS } from "../lib/develop/presets/built-ins.ts";
import {
  parseDevelopPresetConflictRequest,
  parseDevelopPresetDeleteRequest,
  parseDevelopPresetFavoriteRequest,
  parseDevelopPresetSearchRequest,
} from "../lib/develop/presets/api.ts";
import { parseDevelopPresetRecord } from "../lib/develop/presets/schema.ts";
import {
  parseDevelopClipboardGroups,
  parseDevelopClipboardPayload,
  parseDevelopClipboardText,
  serializeDevelopClipboardPayload,
} from "../lib/develop/clipboard/schema.ts";

registerAiModelScheme();

const isDev = process.env.ELECTRON_DEV === "1" || !app.isPackaged;
const DEV_SERVER_URL = process.env.DARKROOM_DEV_URL ?? "http://localhost:3000";

let mainWindow: BrowserWindow | null = null;
let staticServerPort: number | null = null;
let catalogWorkerClient: CatalogWorkerClient | null = null;
let catalogCoordinator: CatalogCoordinator | null = null;
let startupRecovery: CatalogBootstrapRecovery | null = null;
let isQuitting = false;
let shutdownCatalogBindings: (() => Promise<void>) | null = null;
let formatCapabilityReport: Promise<FormatCapabilityReport> | null = null;
let catalogBackupTimer: ReturnType<typeof setInterval> | null = null;

const settingsStore = createSettingsStore(app.getPath("userData"));
const catalogRegistryStore = createCatalogRegistryStore(app.getPath("userData"));
const CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS = 2_000;
const CATALOG_WORKER_SMOKE_ENV = "DARKROOM_CATALOG_WORKER_SMOKE";
const CATALOG_WORKER_SMOKE_REPORT_ENV = "DARKROOM_CATALOG_WORKER_SMOKE_REPORT";

async function runStartupMigration(): Promise<void> {
  const result = await migrateLegacyCatalogAtStartup({
    userDataPath: app.getPath("userData"),
    workerPath: catalogWorkerPath(),
    appVersion: app.getVersion(),
    registry: catalogRegistryStore,
    settings: settingsStore,
  });
  if (result.state === "recovery-required") {
    startupRecovery = {
      kind: "corrupt",
      catalogId: result.catalogId,
      message: result.message,
    };
  }
}

async function deleteManagedCatalogFile(databasePath: string): Promise<void> {
  const directory = path.join(app.getPath("userData"), "catalog-databases");
  const normalized = path.normalize(databasePath);
  if (
    !path.isAbsolute(normalized) ||
    path.dirname(normalized) !== directory ||
    path.extname(normalized) !== ".db"
  ) {
    throw new Error("Only a managed Darkroom catalog can be deleted.");
  }
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Catalog storage directory is unavailable.");
  }
  const databaseStat = await fs.lstat(normalized);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    throw new Error("Catalog database is not a regular file.");
  }
  const sidecars: string[] = [];
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = `${normalized}${suffix}`;
    try {
      const stat = await fs.lstat(sidecar);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Catalog database sidecar is not a regular file.");
      }
      sidecars.push(sidecar);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  for (const filePath of [...sidecars, normalized]) {
    await fs.unlink(filePath);
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireRegularFile(filePath: string, label: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  return stat;
}

async function swapOptimizedCatalogDatabase(
  lease: CatalogNativeAdminLease,
  input: { readonly catalogId: string; readonly temporaryPath: string; readonly sourcePath: string },
): Promise<void> {
  const sourcePath = path.normalize(path.resolve(input.sourcePath));
  const temporaryPath = path.normalize(path.resolve(input.temporaryPath));
  if (
    input.catalogId !== lease.catalogId ||
    sourcePath !== path.normalize(path.resolve(lease.databasePath)) ||
    sourcePath === temporaryPath
  ) {
    throw new Error("Catalog optimization ownership is invalid.");
  }
  const temporaryBefore = await requireRegularFile(temporaryPath, "Compacted catalog");
  await requireRegularFile(sourcePath, "Catalog database");
  const backupPath = `${sourcePath}.optimize-backup-${randomUUID()}`;
  const movedSidecars: { readonly source: string; readonly backup: string }[] = [];
  let sourceMoved = false;
  let compactMoved = false;
  await lease.quiesce();
  try {
    const temporaryAfter = await requireRegularFile(temporaryPath, "Compacted catalog");
    if (temporaryBefore.dev !== temporaryAfter.dev || temporaryBefore.ino !== temporaryAfter.ino) {
      throw new Error("Compacted catalog changed before publication.");
    }
    await requireRegularFile(sourcePath, "Catalog database");
    await fs.rename(sourcePath, backupPath);
    sourceMoved = true;
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${sourcePath}${suffix}`;
      try {
        await requireRegularFile(sidecar, "Catalog database sidecar");
        const backup = `${backupPath}${suffix}`;
        await fs.rename(sidecar, backup);
        movedSidecars.push({ source: sidecar, backup });
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    await fs.rename(temporaryPath, sourcePath);
    compactMoved = true;
    await syncDirectory(path.dirname(sourcePath));
    await lease.resume();
  } catch (error) {
    try {
      const removeReplacementSidecars = compactMoved;
      if (compactMoved) {
        await fs.rename(sourcePath, temporaryPath);
        compactMoved = false;
      }
      if (removeReplacementSidecars) {
        for (const suffix of ["-wal", "-shm"] as const) {
          const sidecar = `${sourcePath}${suffix}`;
          try {
            await requireRegularFile(sidecar, "Replacement catalog sidecar");
            await fs.unlink(sidecar);
          } catch (sidecarError) {
            if (
              typeof sidecarError !== "object" ||
              sidecarError === null ||
              !("code" in sidecarError) ||
              sidecarError.code !== "ENOENT"
            ) {
              throw sidecarError;
            }
          }
        }
      }
      if (sourceMoved) {
        await fs.rename(backupPath, sourcePath);
        sourceMoved = false;
      }
      for (const sidecar of movedSidecars) {
        await fs.rename(sidecar.backup, sidecar.source);
      }
      await syncDirectory(path.dirname(sourcePath));
      await lease.resume();
    } catch {
      throw new Error("Catalog optimization failed and needs recovery.");
    }
    throw error;
  }
  if (sourceMoved) {
    await fs.unlink(backupPath).catch(() => undefined);
    for (const sidecar of movedSidecars) {
      await fs.unlink(sidecar.backup).catch(() => undefined);
    }
    await syncDirectory(path.dirname(sourcePath)).catch(() => undefined);
  }
}

function catalogWorkerPath(): string {
  return path.join(__dirname, "catalog-worker.js");
}

async function startCatalogWorker(): Promise<void> {
  const client = createCatalogWorkerClient({
    workerPath: catalogWorkerPath(),
  });
  try {
    const runtime = await client.runtimeInfo();
    const majorVersion = Number.parseInt(runtime.nodeVersion.split(".")[0] ?? "", 10);
    if (majorVersion !== 24) {
      throw new Error(`Catalog worker requires Node 24, got ${runtime.nodeVersion}.`);
    }
    catalogWorkerClient = client;
  } catch (error) {
    await client.forceTerminate().catch(() => undefined);
    throw error;
  }
}

async function stopCatalogWorker(): Promise<void> {
  const client = catalogWorkerClient;
  catalogWorkerClient = null;
  if (!client) {
    return;
  }
  await client.shutdown(CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS);
}

interface CatalogWorkerAppSmokeReport {
  readonly ok: boolean;
  readonly packaged: boolean;
  readonly workerPath: string;
  readonly appPath: string;
  readonly nodeVersion?: string;
  readonly sqliteVersion?: string;
  readonly reopenedWithoutLock?: boolean;
  readonly error?: string;
}

async function runCatalogWorkerAppSmoke(): Promise<void> {
  const reportPathValue = process.env[CATALOG_WORKER_SMOKE_REPORT_ENV];
  const reportPath = reportPathValue && path.isAbsolute(reportPathValue)
    ? path.normalize(reportPathValue)
    : path.join(app.getPath("temp"), `darkroom-catalog-worker-app-smoke-${randomUUID()}.json`);
  const root = await fs.mkdtemp(path.join(app.getPath("temp"), "darkroom-catalog-worker-app-smoke-"));
  const databasePath = path.join(root, "catalog.db");
  const backupPath = path.join(root, "backup", "catalog.db");
  let reopened: CatalogWorkerClient | null = null;
  let report: CatalogWorkerAppSmokeReport | null = null;

  try {
    const client = catalogWorkerClient;
    if (!client) {
      throw new Error("Catalog worker smoke started without a worker client.");
    }
    const runtime = await client.runtimeInfo();
    if (!/^24\./.test(runtime.nodeVersion)) {
      throw new Error(`Catalog worker smoke requires Node 24, got ${runtime.nodeVersion}.`);
    }
    if (runtime.sqliteVersion === "unknown") {
      throw new Error("Catalog worker smoke could not read the SQLite runtime version.");
    }
    await client.open(databasePath);
    await client.transactionProbe();
    await client.backup(backupPath);
    const integrity = await client.integrityCheck();
    if (integrity.integrityCheck.length !== 1 || integrity.integrityCheck[0] !== "ok") {
      throw new Error("Catalog worker smoke integrity check failed.");
    }
    await stopCatalogWorker();

    reopened = createCatalogWorkerClient({
      workerPath: catalogWorkerPath(),
      requestTimeoutMs: CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS,
    });
    await reopened.open(databasePath);
    const reopenedIntegrity = await reopened.integrityCheck();
    if (
      reopenedIntegrity.integrityCheck.length !== 1 ||
      reopenedIntegrity.integrityCheck[0] !== "ok"
    ) {
      throw new Error("Catalog worker smoke reopen integrity check failed.");
    }
    await reopened.shutdown(CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS);
    reopened = null;
    report = {
      ok: true,
      packaged: app.isPackaged,
      workerPath: catalogWorkerPath(),
      appPath: app.getAppPath(),
      nodeVersion: runtime.nodeVersion,
      sqliteVersion: runtime.sqliteVersion,
      reopenedWithoutLock: true,
    };
  } catch (error) {
    report = {
      ok: false,
      packaged: app.isPackaged,
      workerPath: catalogWorkerPath(),
      appPath: app.getAppPath(),
      error: error instanceof Error ? error.message : "Catalog worker smoke failed.",
    };
  } finally {
    await reopened?.forceTerminate().catch(() => undefined);
    try {
      await stopCatalogWorker();
    } catch (error) {
      report = {
        ok: false,
        packaged: app.isPackaged,
        workerPath: catalogWorkerPath(),
        appPath: app.getAppPath(),
        error: error instanceof Error ? error.message : "Catalog worker smoke shutdown failed.",
      };
    }
    await fs.rm(root, { recursive: true, force: true });
  }

  if (!report) {
    throw new Error("Catalog worker smoke produced no report.");
  }
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report)}\n`, "utf8");
  app.exit(report.ok ? 0 : 1);
}

function sendAiModelProgress(progress: AiModelProgress): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("darkroom:ai-model-progress", progress);
}

function parseAiModelDisclosureLink(value: unknown): AiModelDisclosureLink {
  if (value !== "source" && value !== "license") {
    throw new Error("Unknown AI model disclosure link.");
  }
  return value;
}

const aiModelService = createAiModelService({
  userDataPath: app.getPath("userData"),
  onProgress: sendAiModelProgress,
});

function getNefDecoderCommand(): NefDecoderCommand | null {
  const privateHelper = process.env.DARKROOM_NEF_HELPER_PATH;
  if (!app.isPackaged && privateHelper && path.isAbsolute(privateHelper)) {
    return { executable: privateHelper, kind: "native" };
  }
  if (!app.isPackaged && process.env.DARKROOM_ENABLE_NEF_MOCK === "1") {
    return {
      executable: process.execPath,
      fixedArgs: [path.join(app.getAppPath(), "native/nikon-nef-decoder/mock-decoder.mjs")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      kind: "test-only",
    };
  }
  if (process.platform !== "darwin") return null;
  return {
    executable: path.join(process.resourcesPath, "nikon-nef-decoder", "MacOS", "nikon-nef-decoder"),
    kind: "native",
  };
}

function getNikonPackageState(command: NefDecoderCommand | null): NikonRuntimePackageState {
  if (command === null) return "unavailable";
  if (command.kind === "test-only") return "test-only";
  return app.isPackaged ? "packaged" : "development";
}

function getFormatCapabilityReport(): Promise<FormatCapabilityReport> {
  const helper = getNefDecoderCommand();
  formatCapabilityReport ??= createRuntimeFormatCapabilityReport({
    appVersion: app.getVersion(),
    helper,
    packageState: getNikonPackageState(helper),
  });
  return formatCapabilityReport;
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (event.sender !== mainWindow?.webContents) {
    throw new Error("Desktop API is only available to the main Darkroom window.");
  }
  if (!event.senderFrame) {
    throw new Error("Desktop API request has no renderer frame.");
  }

  const expectedOrigin = isDev
    ? new URL(DEV_SERVER_URL).origin
    : `http://127.0.0.1:${staticServerPort}`;
  if (new URL(event.senderFrame.url).origin !== expectedOrigin) {
    throw new Error("Desktop API request came from an untrusted origin.");
  }
}

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function safeRelinkSelectionError(error: unknown): Error {
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 240) {
    if (!error.message.includes("/") && !error.message.includes("\\")) {
      return new Error(error.message);
    }
  }
  return new Error("Selected relink files could not be prepared.");
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

async function canonicalizeRelinkCandidates(
  filePaths: readonly string[],
  roots: readonly RuntimeRootProjection[],
): Promise<readonly CatalogRelinkSelectedCandidate[]> {
  if (filePaths.length === 0) throw new Error("No relink files were selected.");
  if (roots.length === 0) throw new Error("No active catalog roots are available.");

  const canonicalRoots = roots.filter(isRuntimeNativeRoot).map((root) => ({
    rootId: root.rootId,
    canonicalPath: path.resolve(root.nativePath),
  }));
  if (canonicalRoots.length === 0) throw new Error("No active catalog roots are available.");
  const selectedPaths = new Set<string>();
  const candidates: CatalogRelinkSelectedCandidate[] = [];

  for (const filePath of filePaths) {
    let canonicalPath: string;
    try {
      const selectedStat = await fs.lstat(filePath);
      if (selectedStat.isSymbolicLink() || !selectedStat.isFile()) {
        throw new Error("Selected relink item is not a regular file.");
      }
      canonicalPath = await fs.realpath(filePath);
      const canonicalStat = await fs.lstat(canonicalPath);
      if (canonicalStat.isSymbolicLink() || !canonicalStat.isFile()) {
        throw new Error("Selected relink item is not a regular file.");
      }
    } catch (error) {
      throw safeRelinkSelectionError(error);
    }

    if (selectedPaths.has(canonicalPath)) {
      throw new Error("A relink file was selected more than once.");
    }
    selectedPaths.add(canonicalPath);

    const matches = canonicalRoots.filter((root) => isPathInside(root.canonicalPath, canonicalPath));
    if (matches.length === 0) throw new Error("Selected relink file is outside active catalog roots.");
    if (matches.length !== 1) throw new Error("Selected relink file belongs to multiple active roots.");
    const root = matches[0]!;
    const relativePath = path.relative(root.canonicalPath, canonicalPath).split(path.sep).join("/");
    try {
      candidates.push({
        rootId: root.rootId,
        relativePath: parseRelativePath(relativePath),
        absolutePath: canonicalPath,
      });
    } catch {
      throw new Error("Selected relink file has an invalid relative path.");
    }
  }
  return candidates;
}

async function loadWindow(window: BrowserWindow): Promise<void> {
  if (isDev) {
    await window.loadURL(DEV_SERVER_URL);
    window.webContents.openDevTools({ mode: "detach" });
    return;
  }

  const outDir = getOutDir(getAppRoot());
  staticServerPort ??= await startStaticServer(outDir);
  await window.loadURL(`http://127.0.0.1:${staticServerPort}`);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Darkroom",
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const expectedOrigin = isDev
      ? new URL(DEV_SERVER_URL).origin
      : `http://127.0.0.1:${staticServerPort}`;
    if (new URL(url).origin !== expectedOrigin) {
      event.preventDefault();
    }
  });

  await loadWindow(mainWindow);
}

function registerIpcHandlers(): void {
  const worker = catalogWorkerClient;
  if (!worker) {
    throw new Error("Catalog coordinator started without a worker client.");
  }
  const nefDecoder = createNefDecoderService({
    helper: getNefDecoderCommand(),
    tempRoot: app.getPath("temp"),
  });
  const exportService = createExportService(dialog, (exportedPath) => {
    shell.showItemInFolder(exportedPath);
  }, {
    provenancePath: path.join(app.getPath("userData"), "export-provenance.json"),
  });
  const coordinatorPicker: CatalogPickerPort = {
    async chooseFolder() {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Select catalog root",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const selectedPath = result.filePaths[0]!;
      return { path: selectedPath, label: getFolderName(selectedPath) };
    },
  };
  const coordinatorFilesystem: CatalogFilesystemPort = {
    async canonicalizeDirectory(inputPath) {
      const canonicalPath = await fs.realpath(inputPath);
      const stat = await fs.lstat(canonicalPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Catalog root must be a directory.");
      return { canonicalPath, label: getFolderName(canonicalPath) };
    },
    deleteCatalogFile: deleteManagedCatalogFile,
  };
  const coordinatorPaths: CatalogPathAllocatorPort = {
    async allocateDatabasePath(catalogId) {
      const databaseDirectory = path.join(app.getPath("userData"), "catalog-databases");
      await fs.mkdir(databaseDirectory, { recursive: true });
      return path.join(databaseDirectory, `${catalogId}.db`);
    },
  };
  const coordinatorRegistry: CatalogRegistryPort = {
    read: async () => (await catalogRegistryStore.read()).catalogs,
    upsert: (value) => catalogRegistryStore.upsert(value),
    remove: (catalogId) => catalogRegistryStore.remove(catalogId),
  };
  const nativeAssetAccess = new NativeAssetAccess(path.join(app.getPath("userData"), "xmp-backups"));
  const developAssetStore = new DevelopAssetStore(
    path.join(app.getPath("userData"), "develop-assets-v3"),
  );
  const cameraProfiles = new CameraProfileService(app.getPath("userData"));
  const cameraProfilesReady = cameraProfiles.initialize();
  const developPresets = new DevelopPresetStore(
    path.join(app.getPath("userData"), "develop-presets"),
    BUILT_IN_DEVELOP_PRESETS,
  );
  const developPresetsReady = developPresets.initialize();
  const developJobRuntime = new DevelopJobRuntime({
    journalPath: path.join(
      app.getPath("userData"),
      "develop-jobs-v3",
      "journal.json",
    ),
    assetStore: developAssetStore,
    onUpdate: (jobs) => {
      mainWindow?.webContents.send("darkroom:develop-jobs-updated", jobs);
    },
  });
  const developJobRuntimeReady = developJobRuntime.initialize().then(
    () => true,
    () => false,
  );
  const requireDevelopJobRuntime = async (): Promise<void> => {
    if (!(await developJobRuntimeReady)) {
      throw new Error("Prototype job storage is unavailable.");
    }
  };
  const metadataCache = new MetadataCache(path.join(app.getPath("userData"), "metadata-cache"));
  const assetOperations: AssetScopedOperations = {
    readSidecar: (location) => nativeAssetAccess.readSidecar(location),
    writeSidecar: (location, contents, expectedLastModified) => nativeAssetAccess.writeSidecar(location, contents, expectedLastModified),
    trash: async (location) => {
      const absolutePath = await nativeAssetAccess.resolvePath(location);
      await trashFiles([absolutePath]);
    },
    decode: async (location, requestValue) => {
      const request = parseCatalogDecodeRequest(requestValue);
      return nefDecoder.decode(location.canonicalRootPath, {
        relativePath: location.relativePath,
        mode: request.mode,
        maxEdge: request.maxEdge,
      });
    },
  };
  const coordinatorRuntime = createCatalogCoordinatorRuntime({
    worker,
    picker: coordinatorPicker,
    assetOperations,
  });
  const watcherService = new WatcherReconciliationService({
    reconcileAdapter: new CatalogWatcherReconcileAdapter({
      worker,
      runtime: coordinatorRuntime,
    }),
  });
  catalogCoordinator = new CatalogCoordinator({
    picker: coordinatorPicker,
    registry: coordinatorRegistry,
    worker,
    runtime: coordinatorRuntime,
    watchers: watcherService,
    settings: settingsStore,
    filesystem: coordinatorFilesystem,
    paths: coordinatorPaths,
    startupRecovery,
  });
  const coordinator = catalogCoordinator;
  interface MetadataAnalysisJob {
    readonly request: MetadataAnalysisRequest;
    readonly controller: AbortController;
  }
  const metadataAnalysisJobs = new Map<OperationId, MetadataAnalysisJob>();
  const sendMetadataProgress = (progress: MetadataAnalysisProgress): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send("darkroom:catalog-metadata-analysis-progress", progress);
  };
  const metadataFailure = (
    entryId: AssetId,
    size: number,
    modifiedAt: number,
  ): MetadataAnalysisItem => ({
    entryId,
    analysis: {
      cacheSignature: entryAnalysisCacheSignature(size, modifiedAt),
      size,
      modifiedAt,
      sourceSha256: null,
      parserVersion: null,
      adapterVersion: null,
      cacheHit: false,
      source: null,
      captureTimeKey: null,
      captureTimeDisplay: null,
      captureTimeProvenance: null,
      cameraMake: null,
      cameraModel: null,
      lens: null,
      iso: null,
      focalLength: null,
      location: { city: null, state: null, country: null },
      hasGps: null,
      error: "The source file is unavailable for metadata analysis.",
      analyzedAt: Date.now(),
    },
  });
  const runMetadataAnalysis = async (
    request: MetadataAnalysisRequest,
    signal: AbortSignal,
  ): Promise<MetadataAnalysisResult> => {
    const state = await coordinator.queryLive({
      catalogId: request.catalogId,
      sessionId: request.sessionId,
      expectedRevision: null,
    });
    const assets = new Map<AssetId, (typeof state.assets)[number]>(
      state.assets.map((asset) => [asset.assetId, asset]),
    );
    const roots = new Map(
      coordinatorRuntime.getNativeSessionRoots()
        .filter(isRuntimeNativeRoot)
        .filter((root) => root.catalogId === request.catalogId)
        .map((root) => [root.rootId, root]),
    );
    const targets: MetadataAnalysisTarget[] = [];
    const resolutionFailures: MetadataAnalysisItem[] = [];
    for (const entryId of request.entryIds) {
      if (signal.aborted) break;
      const asset = assets.get(entryId);
      const size = asset?.observation?.byteLength ?? 0;
      const modifiedAt = asset?.observation?.modifiedAt ?? 0;
      const root = asset ? roots.get(asset.rootId) : undefined;
      if (!asset || !root || asset.health !== "present") {
        resolutionFailures.push(metadataFailure(entryId, size, modifiedAt));
        continue;
      }
      try {
        const filePath = await nativeAssetAccess.resolvePath({
          catalogId: request.catalogId,
          assetId: entryId,
          rootId: asset.rootId,
          canonicalRootPath: root.nativePath,
          relativePath: asset.relativePath,
        });
        targets.push({
          entryId,
          filePath,
          size,
          modifiedAt,
          fallback: {
            cameraMake: asset.cameraMake,
            cameraModel: asset.cameraModel,
            lens: asset.lensModel,
          },
        });
      } catch {
        resolutionFailures.push(metadataFailure(entryId, size, modifiedAt));
      }
    }
    const baseCompleted = resolutionFailures.length;
    const total = request.entryIds.length;
    const progress = (current: MetadataAnalysisProgress): MetadataAnalysisProgress => ({
      ...current,
      total,
      completed: baseCompleted + current.completed,
      failed: baseCompleted + current.failed,
      cancelled: signal.aborted || current.cancelled,
    });
    const analyzed = await analyzeMetadataTargets(
      request,
      targets,
      signal,
      (current) => sendMetadataProgress(progress(current)),
      { cache: metadataCache },
    );
    const finalProgress = progress(analyzed);
    return {
      ...finalProgress,
      items: [...resolutionFailures, ...analyzed.items],
    };
  };
  let manualImportBinding: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
    readonly controller: CatalogManualImportController;
  } | null = null;
  let autoImportBinding: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
    readonly runtime: CatalogAutoImportRuntime;
  } | null = null;
  let pendingManualImportShutdown: Promise<void> | null = null;
  let pendingAutoImportShutdown: Promise<void> | null = null;
  const queueManualImportShutdown = (controller: CatalogManualImportController): void => {
    const previous = pendingManualImportShutdown ?? Promise.resolve();
    const next = previous.then(
      () => controller.shutdown(),
      () => controller.shutdown(),
    );
    pendingManualImportShutdown = next;
    void next.then(
      () => {
        if (pendingManualImportShutdown === next) pendingManualImportShutdown = null;
      },
      () => {
        if (pendingManualImportShutdown === next) pendingManualImportShutdown = null;
      },
    );
  };
  const discardManualImportController = (): void => {
    const controller = manualImportBinding?.controller;
    manualImportBinding = null;
    if (controller !== undefined) queueManualImportShutdown(controller);
  };
  const shutdownManualImportController = async (): Promise<void> => {
    const controller = manualImportBinding?.controller;
    manualImportBinding = null;
    if (controller !== undefined) queueManualImportShutdown(controller);
    const pending = pendingManualImportShutdown;
    if (pending !== null) await pending;
  };
  const queueAutoImportShutdown = (runtime: CatalogAutoImportRuntime): void => {
    const previous = pendingAutoImportShutdown ?? Promise.resolve();
    const next = previous.then(
      () => runtime.shutdown(),
      () => runtime.shutdown(),
    );
    pendingAutoImportShutdown = next;
    void next.then(
      () => {
        if (pendingAutoImportShutdown === next) pendingAutoImportShutdown = null;
      },
      () => {
        if (pendingAutoImportShutdown === next) pendingAutoImportShutdown = null;
      },
    );
  };
  const discardAutoImportRuntime = (): void => {
    const runtime = autoImportBinding?.runtime;
    autoImportBinding = null;
    if (runtime !== undefined) queueAutoImportShutdown(runtime);
  };
  const shutdownAutoImportRuntime = async (): Promise<void> => {
    const runtime = autoImportBinding?.runtime;
    autoImportBinding = null;
    if (runtime !== undefined) queueAutoImportShutdown(runtime);
    const pending = pendingAutoImportShutdown;
    if (pending !== null) await pending;
  };
  const shutdownImportBindings = async (): Promise<void> => {
    await Promise.all([
      shutdownManualImportController(),
      shutdownAutoImportRuntime(),
    ]);
  };
  const workLifecycle = new CatalogWorkLifecycle({
    drainBindings: shutdownImportBindings,
  });
  const discardImportBindings = (binding: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
  }): void => {
    if (
      manualImportBinding?.catalogId === binding.catalogId &&
      manualImportBinding.sessionId === binding.sessionId
    ) discardManualImportController();
    if (
      autoImportBinding?.catalogId === binding.catalogId &&
      autoImportBinding.sessionId === binding.sessionId
    ) discardAutoImportRuntime();
  };
  const assertManualImportSession = async (binding: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
  }): Promise<void> => {
    const before = coordinatorRuntime.getSession();
    if (
      before === null ||
      before.catalogId !== binding.catalogId ||
      before.sessionId !== binding.sessionId
    ) {
      discardImportBindings(binding);
      throw new Error("Catalog import session is no longer active.");
    }
    await coordinator.queryLive({
      catalogId: binding.catalogId,
      sessionId: binding.sessionId,
      expectedRevision: null,
    });
    const after = coordinatorRuntime.getSession();
    if (
      after === null ||
      after.catalogId !== binding.catalogId ||
      after.sessionId !== binding.sessionId
    ) {
      discardImportBindings(binding);
      throw new Error("Catalog import session changed.");
    }
  };
  const getManualImportController = async (
    catalogId: CatalogId,
    sessionId: SessionId,
    allowClosed = false,
  ): Promise<CatalogManualImportController> => {
    if (!allowClosed) workLifecycle.assertOpen();
    const current = coordinatorRuntime.getSession();
    if (
      current === null ||
      current.catalogId !== catalogId ||
      current.sessionId !== sessionId
    ) {
      discardManualImportController();
      throw new Error("Catalog import session is no longer active.");
    }
    if (
      manualImportBinding?.catalogId === catalogId &&
      manualImportBinding.sessionId === sessionId
    ) {
      return manualImportBinding.controller;
    }
    await shutdownManualImportController();
    if (!allowClosed) workLifecycle.assertOpen();
    const controller = createCatalogManualImportController({
      catalogId,
      sessionId,
      worker,
      assertCurrentSession: assertManualImportSession,
      getNativeSessionRoots: () => coordinatorRuntime.getNativeSessionRoots()
        .filter((root) => root.catalogId === catalogId)
        .filter(isRuntimeNativeRoot)
        .map((root) => ({
          catalogId: root.catalogId,
          rootId: root.rootId,
          nativePath: root.nativePath,
        })),
      chooseFiles: async () => {
        await assertManualImportSession({ catalogId, sessionId });
        const result = await dialog.showOpenDialog({
          title: "Select photos to import",
          properties: ["openFile", "multiSelections"],
        });
        await assertManualImportSession({ catalogId, sessionId });
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
      },
      journal: createFileTransactionJournal(
        path.join(app.getPath("userData"), "catalog-import-state", catalogId),
      ),
    });
    manualImportBinding = {
      catalogId,
      sessionId,
      controller,
    };
    return controller;
  };
  const recoverManualImportForSession = async (session: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
  } | null): Promise<void> => {
    if (session === null) {
      await shutdownManualImportController();
      return;
    }
    try {
      const controller = await getManualImportController(session.catalogId, session.sessionId, true);
      await controller.recoverPending();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Manual import recovery failed.";
      const diagnostic = message.length > 0 && message.length <= 500 && !message.includes("/") && !message.includes("\\")
        ? message
        : "Manual import recovery failed.";
      process.stderr.write(`${diagnostic}\n`);
    }
  };
  const getAutoImportRuntime = async (
    catalogId: CatalogId,
    sessionId: SessionId,
    allowClosed = false,
  ): Promise<CatalogAutoImportRuntime> => {
    if (!allowClosed) workLifecycle.assertOpen();
    const current = coordinatorRuntime.getSession();
    if (
      current === null ||
      current.catalogId !== catalogId ||
      current.sessionId !== sessionId
    ) {
      discardAutoImportRuntime();
      throw new Error("Catalog Auto Import session is no longer active.");
    }
    if (
      autoImportBinding?.catalogId === catalogId &&
      autoImportBinding.sessionId === sessionId
    ) {
      return autoImportBinding.runtime;
    }
    await shutdownAutoImportRuntime();
    if (!allowClosed) workLifecycle.assertOpen();
    const runtime = createCatalogAutoImportRuntime({
      catalogId,
      sessionId,
      worker,
      assertCurrentSession: async () => assertManualImportSession({ catalogId, sessionId }),
      applyLive: (input) => coordinator.applyAutoImportRule(input),
      resolveNativeRoot: async (input) => {
        await assertManualImportSession({ catalogId, sessionId });
        const root = coordinatorRuntime.getNativeSessionRoots()
          .filter(isRuntimeNativeRoot)
          .find((candidate) => candidate.rootId === input.rootId && candidate.catalogId === input.catalogId);
        if (root === undefined) throw new Error("Catalog root is unavailable.");
        return { catalogId: root.catalogId, rootId: root.rootId, canonicalPath: root.nativePath };
      },
      store: createAutoImportStore(path.join(app.getPath("userData"), "catalog-auto-import-state", catalogId)),
      journal: createFileTransactionJournal(
        path.join(app.getPath("userData"), "catalog-import-state", catalogId),
      ),
      openPath: (nativePath) => shell.openPath(nativePath),
    });
    autoImportBinding = { catalogId, sessionId, runtime };
    return runtime;
  };
  const recoverAutoImportForSession = async (session: {
    readonly catalogId: CatalogId;
    readonly sessionId: SessionId;
  } | null): Promise<void> => {
    if (session === null) {
      await shutdownAutoImportRuntime();
      return;
    }
    try {
      const runtime = await getAutoImportRuntime(session.catalogId, session.sessionId, true);
      await runtime.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Auto Import startup failed.";
      const diagnostic = message.length > 0 && message.length <= 500 && !message.includes("/") && !message.includes("\\")
        ? message
        : "Auto Import startup failed.";
      process.stderr.write(`${diagnostic}\n`);
    }
  };
  const recoverCurrentCatalogBindings = async (): Promise<void> => {
    const session = coordinatorRuntime.getSession();
    await recoverManualImportForSession(session);
    await recoverAutoImportForSession(session);
  };
  const runCatalogTransition = <T>(task: () => Promise<T>): Promise<T> => {
    return workLifecycle.transition(task, recoverCurrentCatalogBindings);
  };
  shutdownCatalogBindings = async () => {
    await workLifecycle.shutdown();
  };
  const relinkService = new CatalogAssetRelinkService({
    worker,
    session: {
      assertActive: async (input) => {
        await coordinator.queryLive({ ...input, expectedRevision: null });
      },
      getActiveRoots: ({ catalogId }) => coordinatorRuntime.getNativeSessionRoots()
        .filter((root) => root.catalogId === catalogId)
        .filter(isRuntimeNativeRoot)
        .map((root) => ({
          rootId: root.rootId,
          canonicalPath: path.resolve(root.nativePath),
        })),
    },
  });
  coordinator.subscribe((event) => {
    if (
      manualImportBinding !== null &&
      (manualImportBinding.catalogId !== event.catalogId || manualImportBinding.sessionId !== event.sessionId)
    ) {
      discardManualImportController();
    }
    if (
      autoImportBinding !== null &&
      (autoImportBinding.catalogId !== event.catalogId || autoImportBinding.sessionId !== event.sessionId)
    ) {
      discardAutoImportRuntime();
    }
    if (
      event.kind === "reconcile-completed" &&
      autoImportBinding?.catalogId === event.catalogId &&
      autoImportBinding.sessionId === event.sessionId
    ) {
      try {
        workLifecycle.assertOpen();
        void workLifecycle.track("auto", () =>
          autoImportBinding!.runtime.reconcile(event.rootId, event.payload.scopes),
        ).catch(() => undefined);
      } catch {
        // A transition or shutdown has already closed the work gate.
      }
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send("darkroom:catalog-event", event);
  });
  interface FingerprintJob {
    readonly catalogId: CatalogId;
    readonly sessionId: CatalogFingerprintBackfillRequest["sessionId"];
    readonly operationId: OperationId;
    readonly workToken: CatalogWorkToken | null;
    cancelled: boolean;
  }
  const fingerprintJobs = new Map<OperationId, FingerprintJob>();
  const fingerprintProgress = (
    request: CatalogFingerprintBackfillRequest,
    value: FingerprintBackfillExecution | FingerprintBackfillProgressEvent | FingerprintBackfillSnapshot,
  ): CatalogFingerprintBackfillProgress => {
    const counts = "progress" in value ? value.progress : value;
    return {
      catalogId: request.catalogId,
      sessionId: request.sessionId,
      operationId: value.operationId,
      state: value.state,
      total: counts.total,
      indexed: counts.indexed,
      stale: counts.stale,
      remaining: counts.remaining,
      processed: counts.processed,
      failed: counts.failed,
      unchecked: counts.unchecked,
    };
  };
  const sendFingerprintProgress = (progress: CatalogFingerprintBackfillProgress): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send("darkroom:catalog-fingerprint-progress", progress);
  };
  const assertFingerprintSession = async (request: CatalogFingerprintBackfillRequest): Promise<void> => {
    await coordinator.queryLive({ ...request, expectedRevision: null });
  };
  const fingerprintStore = (catalogId: CatalogId): CatalogFingerprintBackfillStore =>
    new CatalogFingerprintBackfillStore(app.getPath("userData"), catalogId);
  const latestFingerprintSnapshot = async (
    request: CatalogFingerprintBackfillRequest,
  ): Promise<FingerprintBackfillSnapshot | null> => {
    workLifecycle.assertOpen();
    await assertFingerprintSession(request);
    const snapshots = await fingerprintStore(request.catalogId).list();
    return [...snapshots].sort((left, right) =>
      right.updatedAt - left.updatedAt || right.operationId.localeCompare(left.operationId)
    )[0] ?? null;
  };
  const runFingerprintBackfill = async (
    request: CatalogFingerprintBackfillRequest,
    operationId: OperationId,
    sourceOperationId: OperationId | null,
    startCancelled = false,
    workToken: CatalogWorkToken | null = null,
  ): Promise<CatalogFingerprintBackfillProgress> => {
    const conflict = [...fingerprintJobs.values()].find(
      (job) => job.catalogId === request.catalogId,
    );
    if (conflict !== undefined) {
      throw new Error("A fingerprint backfill is already active for this catalog.");
    }
    const job: FingerprintJob = {
      ...request,
      operationId,
      workToken,
      cancelled: startCancelled || workToken?.isCancelled() === true,
    };
    fingerprintJobs.set(operationId, job);
    try {
      await assertFingerprintSession(request);
      const state = parseCatalogLiveQueryResult(await worker.liveQuery({
        catalogId: request.catalogId,
        expectedRevision: null,
      }));
      const store = fingerprintStore(request.catalogId);
      const adapter = new CatalogFingerprintBackfillAdapter(
        request.catalogId,
        worker,
        {
          resolve: async (asset) => {
            await assertFingerprintSession(request);
            const root = coordinatorRuntime.getNativeSessionRoots()
              .filter(isRuntimeNativeRoot)
              .find(
                (candidate) =>
                  candidate.catalogId === request.catalogId &&
                  candidate.rootId === asset.rootId,
              );
            if (root === undefined) throw new Error("Fingerprint asset root is unavailable.");
            return {
              catalogId: request.catalogId,
              assetId: asset.assetId,
              rootId: asset.rootId,
              canonicalRootPath: root.nativePath,
              relativePath: asset.relativePath,
            };
          },
        },
        { pathAccess: nativeAssetAccess },
      );
      const service = new CatalogFingerprintBackfillService(store, adapter, adapter);
      const onProgress = (value: FingerprintBackfillProgressEvent): void => {
        sendFingerprintProgress(fingerprintProgress(request, value));
      };
      const common = {
        catalogId: request.catalogId,
        operationId,
        assets: state.assets,
        isCancelled: () => job.cancelled || job.workToken?.isCancelled() === true,
        onProgress,
      };
      const execution = sourceOperationId === null
        ? await service.run(common)
        : await service.resume({ ...common, sourceOperationId });
      return fingerprintProgress(request, execution);
    } finally {
      if (fingerprintJobs.get(operationId) === job) fingerprintJobs.delete(operationId);
    }
  };
  let currentAdminLease: CatalogNativeAdminLease | null = null;
  const maintenance: CatalogAdminMaintenancePort = {
    async quiesce() {
      throw new Error("Merge and Replace restore are unavailable in this build.");
    },
    async resume() {
      if (currentAdminLease === null) throw new Error("Catalog maintenance is inactive.");
      await currentAdminLease.resume();
    },
    async swapOptimized(input) {
      if (currentAdminLease === null) throw new Error("Catalog maintenance is inactive.");
      await swapOptimizedCatalogDatabase(currentAdminLease, input);
    },
  };
  const adminService = new CatalogAdminService({
    worker,
    appVersion: app.getVersion(),
    paths: {
      async databasePath(catalogId) {
        const existing = (await coordinatorRegistry.read()).find((entry) => entry.catalogId === catalogId);
        return existing?.databasePath ?? coordinatorPaths.allocateDatabasePath(catalogId);
      },
      async backupDirectory(catalogId) {
        return path.join(app.getPath("userData"), "catalog-backups", catalogId);
      },
      async temporaryDirectory(catalogId) {
        return path.join(app.getPath("userData"), "catalog-admin-temporary", catalogId);
      },
    },
    policyStore: new FileCatalogBackupPolicyStore(
      path.join(app.getPath("userData"), "catalog-backup-policies.json"),
    ),
    maintenance,
    publishClone: async (input) => {
      await coordinatorRegistry.upsert({
        catalogId: input.catalogId,
        displayName: input.displayName,
        databasePath: input.databasePath,
        health: "healthy",
        lastOpenedAt: 0,
      });
    },
  });
  const withActiveAdmin = <T>(
    value: unknown,
    task: (lease: CatalogNativeAdminLease) => Promise<T>,
  ): Promise<T> => {
    const request = parseCatalogAdminSessionRequest(value);
    return coordinator.runCatalogAdmin(request, async (lease) => {
      if (currentAdminLease !== null) throw new Error("Catalog administration is already active.");
      currentAdminLease = lease;
      try {
        return await task(lease);
      } finally {
        currentAdminLease = null;
      }
    });
  };

  catalogBackupTimer = setInterval(() => {
    void coordinator.runScheduledCatalogAdmin(async (lease) => {
      if (currentAdminLease !== null) return null;
      currentAdminLease = lease;
      try {
        return await adminService.runScheduledBackup(lease.catalogId);
      } finally {
        currentAdminLease = null;
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Scheduled catalog backup failed.";
      process.stderr.write(`${message}\n`);
    });
  }, 60_000);
  catalogBackupTimer.unref();

  ipcMain.handle("darkroom:catalog-bootstrap", async (event) => {
    assertTrustedRenderer(event);
    return runCatalogTransition(() => coordinator.bootstrap());
  });
  ipcMain.handle("darkroom:catalog-create", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return runCatalogTransition(() => coordinator.createCatalog(value));
  });
  ipcMain.handle("darkroom:catalog-open", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return runCatalogTransition(() => coordinator.openCatalog(value));
  });
  ipcMain.handle("darkroom:catalog-switch", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return runCatalogTransition(() => coordinator.switchCatalog(value));
  });
  ipcMain.handle("darkroom:catalog-close", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await runCatalogTransition(() => coordinator.closeCatalog(value));
  });
  ipcMain.handle("darkroom:catalog-add-root", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.addRoot(value);
  });
  ipcMain.handle("darkroom:catalog-relink-root", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return runCatalogTransition(() => coordinator.relinkRoot(value));
  });
  ipcMain.handle("darkroom:catalog-relink-files-prepare", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseRelinkPrepareRequest(value);
    workLifecycle.assertOpen();
    await coordinator.queryLive({ ...request, expectedRevision: null });
    workLifecycle.assertOpen();
    const result = await dialog.showOpenDialog({
      title: "Select files to relink",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    workLifecycle.assertOpen();
    const roots = coordinatorRuntime.getNativeSessionRoots()
      .filter((root) => root.catalogId === request.catalogId)
      .filter(isRuntimeNativeRoot);
    const selectedCandidates = await canonicalizeRelinkCandidates(result.filePaths, roots);
    workLifecycle.assertOpen();
    return relinkService.prepare({ ...request, selectedCandidates });
  });
  ipcMain.handle("darkroom:catalog-relink-files-apply", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseRelinkApplyRequest(value);
    return workLifecycle.track("manual", (token) => relinkService.apply(request, token.isCancelled));
  });
  ipcMain.handle("darkroom:catalog-relink-files-cancel", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseRelinkCancelRequest(value);
    await workLifecycle.track("manual", (token) => relinkService.cancel(request, token.isCancelled));
  });
  ipcMain.handle("darkroom:catalog-remove", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await coordinator.removeCatalog(value);
  });
  ipcMain.handle("darkroom:catalog-start-scan", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.startScan(value);
  });
  ipcMain.handle("darkroom:catalog-cancel-scan", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    coordinator.cancelScan(value);
  });
  ipcMain.handle("darkroom:catalog-get-operation", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.getOperation(value);
  });
  ipcMain.handle("darkroom:catalog-wait-operation", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.waitForOperation(value);
  });
  ipcMain.handle("darkroom:catalog-query", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.queryLive(value);
  });
  ipcMain.handle("darkroom:catalog-apply", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.applyLive(value);
  });
  ipcMain.handle("darkroom:catalog-import-prepare", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogImportPrepareRequest(value);
    const controller = await getManualImportController(request.catalogId, request.sessionId);
    return runManualWork(() => controller.prepare(request));
  });
  ipcMain.handle("darkroom:catalog-import-review", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogImportOperationRequest(value);
    const controller = await getManualImportController(request.catalogId, request.sessionId);
    return runManualWork(() => controller.review(request));
  });
  ipcMain.handle("darkroom:catalog-import-run", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogImportOperationRequest(value);
    const controller = await getManualImportController(request.catalogId, request.sessionId);
    return runManualWork(() => controller.run(request));
  });
  ipcMain.handle("darkroom:catalog-import-cancel", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogImportOperationRequest(value);
    const controller = await getManualImportController(request.catalogId, request.sessionId);
    workLifecycle.assertOpen();
    controller.cancel(request);
    await assertManualImportSession({
      catalogId: request.catalogId,
      sessionId: request.sessionId,
    });
  });
  const requireAutoImportAction = <T extends ReturnType<typeof parseAutoImportControlRequest>["action"]>(
    request: ReturnType<typeof parseAutoImportControlRequest>,
    action: T,
  ): void => {
    if (request.action !== action) throw new Error("Auto Import control action does not match the channel.");
  };
  const runManualWork = <T>(task: () => Promise<T>): Promise<T> =>
    workLifecycle.track("manual", task);
  const runAutoWork = <T>(task: () => Promise<T>): Promise<T> =>
    workLifecycle.track("auto", task);
  ipcMain.handle("darkroom:catalog-auto-import-configure", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportConfigureRequest(value);
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.configure({
      ingressRootId: request.ingressRootId,
      ingressRelativePath: request.ingressRelativePath,
      destinationRootId: request.destinationRootId,
      destinationRelativePath: request.destinationRelativePath,
      presetId: request.presetId,
      duplicatePolicy: request.duplicatePolicy,
      destinationConflictPolicy: request.destinationConflictPolicy,
      stabilityMs: request.stabilityMs,
      maxAttempts: request.maxAttempts,
      retryBackoffMs: request.retryBackoffMs,
      enabled: request.enabled,
    }));
  });
  ipcMain.handle("darkroom:catalog-auto-import-status", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportControlRequest(value);
    requireAutoImportAction(request, "status");
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.status());
  });
  ipcMain.handle("darkroom:catalog-auto-import-enable", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportControlRequest(value);
    requireAutoImportAction(request, "enable");
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.enable());
  });
  ipcMain.handle("darkroom:catalog-auto-import-disable", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportControlRequest(value);
    requireAutoImportAction(request, "disable");
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.disable());
  });
  ipcMain.handle("darkroom:catalog-auto-import-pause", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportControlRequest(value);
    requireAutoImportAction(request, "pause");
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.pause());
  });
  ipcMain.handle("darkroom:catalog-auto-import-resume", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportControlRequest(value);
    requireAutoImportAction(request, "resume");
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.resume());
  });
  ipcMain.handle("darkroom:catalog-auto-import-retry-failed", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportControlRequest(value);
    requireAutoImportAction(request, "retry-failed");
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.retryFailed());
  });
  ipcMain.handle("darkroom:catalog-auto-import-clear-failed", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportControlRequest(value);
    requireAutoImportAction(request, "clear-failed");
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.clearFailed());
  });
  ipcMain.handle("darkroom:catalog-auto-import-cancel", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseAutoImportCancelRequest(value);
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    return runAutoWork(() => runtime.cancel(request.queueId));
  });
  ipcMain.handle("darkroom:catalog-auto-import-open-ingress", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogSessionRequest(value);
    const runtime = await getAutoImportRuntime(request.catalogId, request.sessionId);
    await runAutoWork(() => runtime.openIngress());
  });
  ipcMain.handle("darkroom:catalog-read-asset", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.readAsset(value);
  });
  ipcMain.handle("darkroom:develop-asset-put", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return developAssetStore.put(parseDevelopAssetPutRequest(value));
  });
  ipcMain.handle(
    "darkroom:develop-asset-transition",
    async (event, value: unknown) => {
      assertTrustedRenderer(event);
      return developAssetStore.transition(
        parseDevelopAssetTransitionRequest(value),
      );
    },
  );
  ipcMain.handle("darkroom:develop-asset-read", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return developAssetStore.read(parseDevelopAssetReadRequest(value));
  });
  ipcMain.handle("darkroom:camera-profiles-list", async (event) => {
    assertTrustedRenderer(event);
    await cameraProfilesReady;
    return cameraProfiles.list();
  });
  ipcMain.handle("darkroom:camera-profiles-import", async (event) => {
    assertTrustedRenderer(event);
    await cameraProfilesReady;
    const result = await dialog.showOpenDialog({
      title: "Import camera profile",
      properties: ["openFile"],
      filters: [{ name: "Matrix camera profiles", extensions: ["dcp", "xmp"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { kind: "cancelled" };
    return cameraProfiles.importFile(result.filePaths[0]!);
  });
  ipcMain.handle("darkroom:camera-profiles-resolve-conflict", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await cameraProfilesReady;
    return cameraProfiles.resolveConflict(parseCameraProfileConflictRequest(value));
  });
  ipcMain.handle("darkroom:camera-profiles-rescan", async (event) => {
    assertTrustedRenderer(event);
    await cameraProfilesReady;
    return cameraProfiles.rescan();
  });
  ipcMain.handle("darkroom:camera-profiles-remove", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await cameraProfilesReady;
    return cameraProfiles.remove(parseCameraProfileRemoveRequest(value));
  });
  ipcMain.handle("darkroom:develop-presets-list", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await developPresetsReady;
    return developPresets.list(parseDevelopPresetSearchRequest(value));
  });
  ipcMain.handle("darkroom:develop-presets-create", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await developPresetsReady;
    return developPresets.create(parseDevelopPresetRecord(value));
  });
  ipcMain.handle("darkroom:develop-presets-update", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await developPresetsReady;
    return developPresets.update(parseDevelopPresetRecord(value));
  });
  ipcMain.handle("darkroom:develop-presets-favorite", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await developPresetsReady;
    const request = parseDevelopPresetFavoriteRequest(value);
    return developPresets.setFavorite(request.presetId, request.favorite);
  });
  ipcMain.handle("darkroom:develop-presets-delete", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await developPresetsReady;
    const request = parseDevelopPresetDeleteRequest(value);
    await developPresets.delete(request.presetId);
  });
  ipcMain.handle("darkroom:develop-presets-import", async (event) => {
    assertTrustedRenderer(event);
    await developPresetsReady;
    const result = await dialog.showOpenDialog({
      title: "Import Develop preset",
      properties: ["openFile"],
      filters: [{ name: "Darkroom Develop preset", extensions: ["json", "drpreset"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { kind: "cancelled" };
    return developPresets.importFile(result.filePaths[0]!);
  });
  ipcMain.handle("darkroom:develop-presets-resolve-conflict", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await developPresetsReady;
    const request = parseDevelopPresetConflictRequest(value);
    if (request.action === "cancel") {
      await developPresets.cancelImport(request.token);
      return { kind: "cancelled" };
    }
    return {
      kind: "imported",
      preset: await developPresets.resolveImport(request.token, request.action),
    };
  });
  ipcMain.handle("darkroom:develop-clipboard-write", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const payload = parseDevelopClipboardPayload(value);
    clipboard.writeText(serializeDevelopClipboardPayload(payload));
    await settingsStore.setDevelopClipboardGroups(payload.selectedGroups);
  });
  ipcMain.handle("darkroom:develop-clipboard-read", async (event) => {
    assertTrustedRenderer(event);
    const text = clipboard.readText();
    if (text.length === 0) return { kind: "empty" };
    try {
      return { kind: "ready", payload: parseDevelopClipboardText(text) };
    } catch (error) {
      return {
        kind: "invalid",
        reason: error instanceof Error
          ? error.message.slice(0, 512)
          : "Clipboard does not contain valid Darkroom Develop settings.",
      };
    }
  });
  ipcMain.handle("darkroom:develop-clipboard-groups-get", async (event) => {
    assertTrustedRenderer(event);
    return settingsStore.getDevelopClipboardGroups();
  });
  ipcMain.handle("darkroom:develop-clipboard-groups-set", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await settingsStore.setDevelopClipboardGroups(parseDevelopClipboardGroups(value));
  });
  ipcMain.handle("darkroom:develop-asset-gc", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return developAssetStore.collectGarbage(parseDevelopAssetGcRequest(value));
  });
  ipcMain.handle("darkroom:develop-jobs-list", async (event) => {
    assertTrustedRenderer(event);
    await requireDevelopJobRuntime();
    return developJobRuntime.list();
  });
  ipcMain.handle("darkroom:develop-jobs-start", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await requireDevelopJobRuntime();
    return developJobRuntime.start(parseDevelopJobStartRequest(value));
  });
  ipcMain.handle("darkroom:develop-jobs-cancel", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await requireDevelopJobRuntime();
    return developJobRuntime.cancel(parseDevelopJobTargetRequest(value));
  });
  ipcMain.handle("darkroom:develop-jobs-retry", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await requireDevelopJobRuntime();
    return developJobRuntime.retry(parseDevelopJobRetryRequest(value));
  });
  ipcMain.handle("darkroom:develop-jobs-discard", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await requireDevelopJobRuntime();
    await developJobRuntime.discard(parseDevelopJobTargetRequest(value));
  });
  ipcMain.handle("darkroom:develop-jobs-accept", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await requireDevelopJobRuntime();
    return developJobRuntime.accept(parseDevelopJobAcceptRequest(value));
  });
  ipcMain.handle("darkroom:develop-jobs-consent-grant", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await requireDevelopJobRuntime();
    return developJobRuntime.grantGenerativeRemoveConsent(
      parseGenerativeRemoveConsentGrantRequest(value),
    );
  });
  ipcMain.handle("darkroom:develop-jobs-consent-revoke", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await requireDevelopJobRuntime();
    return developJobRuntime.revokeGenerativeRemoveConsent(
      parseGenerativeRemoveConsentRevokeRequest(value),
    );
  });
  ipcMain.handle("darkroom:catalog-read-asset-head", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.readAssetHead(value);
  });
  ipcMain.handle("darkroom:catalog-stat-asset", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.statAsset(value);
  });
  ipcMain.handle("darkroom:catalog-read-sidecar", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.readSidecar(value);
  });
  ipcMain.handle("darkroom:catalog-write-sidecar", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await coordinator.writeSidecar(value);
  });
  ipcMain.handle("darkroom:catalog-decode-asset", async (event, value: unknown, request: unknown) => {
    assertTrustedRenderer(event);
    return coordinator.decodeAsset(value, request);
  });
  ipcMain.handle("darkroom:catalog-trash-asset", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await coordinator.trashAsset(value);
  });
  ipcMain.handle("darkroom:catalog-trash-exact-duplicates", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseExactDuplicateTrashRequest(value);
    const state = await coordinator.queryLive({
      catalogId: request.catalogId,
      sessionId: request.sessionId,
      expectedRevision: null,
    });
    const roots = new Map(
      coordinatorRuntime.getNativeSessionRoots()
        .filter(isRuntimeNativeRoot)
        .filter((root) => root.catalogId === request.catalogId)
        .map((root) => [root.rootId, root.nativePath] as const),
    );
    const assets = new Map(state.assets.map((asset) => [asset.assetId, asset]));
    const resolveAssetPath = async (entryId: AssetId): Promise<string> => {
      const asset = assets.get(entryId);
      if (!asset || asset.health !== "present") throw new Error("Duplicate member is no longer present.");
      const canonicalRootPath = roots.get(asset.rootId);
      if (!canonicalRootPath) throw new Error("Duplicate member root is unavailable.");
      return nativeAssetAccess.resolvePath({
        catalogId: request.catalogId,
        assetId: asset.assetId,
        rootId: asset.rootId,
        canonicalRootPath,
        relativePath: asset.relativePath,
      });
    };
    const keeperPath = await resolveAssetPath(request.keeperId);
    const keeper = await fingerprintNoFollowFile(keeperPath);
    if (keeper.status !== "valid" || keeper.sha256 === null || keeper.observation === null) {
      throw new Error("The keeper could not be verified before trashing duplicates.");
    }
    const items: ExactDuplicateTrashItemResult[] = [];
    for (const entryId of request.targetIds) {
      try {
        const targetPath = await resolveAssetPath(entryId);
        const target = await fingerprintNoFollowFile(targetPath);
        if (
          target.status !== "valid" ||
          target.sha256 !== keeper.sha256 ||
          target.observation?.size !== keeper.observation.size
        ) {
          throw new Error("File changed or is no longer byte-identical to the keeper.");
        }
        await trashFiles([targetPath]);
        items.push({ entryId, trashed: true, error: null });
      } catch (reason) {
        items.push({
          entryId,
          trashed: false,
          error: reason instanceof Error ? reason.message : "Could not move file to the OS trash.",
        });
      }
    }
    return { items };
  });
  ipcMain.handle("darkroom:catalog-analyze-metadata", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseMetadataAnalysisRequest(value);
    if (metadataAnalysisJobs.has(request.operationId)) {
      throw new Error("Metadata analysis operation is already active.");
    }
    const conflict = [...metadataAnalysisJobs.values()].find(
      (job) => job.request.catalogId === request.catalogId,
    );
    if (conflict) throw new Error("Metadata analysis is already active for this catalog.");
    const job: MetadataAnalysisJob = { request, controller: new AbortController() };
    metadataAnalysisJobs.set(request.operationId, job);
    try {
      return await runMetadataAnalysis(request, job.controller.signal);
    } finally {
      if (metadataAnalysisJobs.get(request.operationId) === job) {
        metadataAnalysisJobs.delete(request.operationId);
      }
    }
  });
  ipcMain.handle("darkroom:catalog-cancel-metadata-analysis", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseMetadataAnalysisOperationRequest(value);
    const job = metadataAnalysisJobs.get(request.operationId);
    if (
      job &&
      job.request.catalogId === request.catalogId &&
      job.request.sessionId === request.sessionId
    ) {
      job.controller.abort();
    }
  });
  ipcMain.handle("darkroom:get-format-capability-report", async (event) => {
    assertTrustedRenderer(event);
    return getFormatCapabilityReport();
  });
  ipcMain.handle("darkroom:catalog-fingerprint-status", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogFingerprintBackfillRequest(value);
    const snapshot = await latestFingerprintSnapshot(request);
    return snapshot === null ? null : fingerprintProgress(request, snapshot);
  });
  ipcMain.handle("darkroom:catalog-fingerprint-start", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogFingerprintBackfillRequest(value);
    workLifecycle.assertOpen();
    return workLifecycle.track("fingerprint", (token) =>
      runFingerprintBackfill(request, createOperationId(), null, false, token),
    );
  });
  ipcMain.handle("darkroom:catalog-fingerprint-resume", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogFingerprintBackfillResumeRequest(value);
    workLifecycle.assertOpen();
    return workLifecycle.track("fingerprint", (token) =>
      runFingerprintBackfill(request, createOperationId(), request.sourceOperationId, false, token),
    );
  });
  ipcMain.handle("darkroom:catalog-fingerprint-recover", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    workLifecycle.assertOpen();
    const request = parseCatalogFingerprintBackfillRequest(value);
    const snapshot = await latestFingerprintSnapshot(request);
    if (snapshot === null) return null;
    if (snapshot.state !== "planned" && snapshot.state !== "running") {
      return fingerprintProgress(request, snapshot);
    }
    const active = fingerprintJobs.get(snapshot.operationId);
    if (
      active?.catalogId === request.catalogId &&
      active.sessionId === request.sessionId
    ) {
      return fingerprintProgress(request, snapshot);
    }
    workLifecycle.assertOpen();
    return workLifecycle.track("fingerprint", (token) =>
      runFingerprintBackfill(request, snapshot.operationId, null, false, token),
    );
  });
  ipcMain.handle("darkroom:catalog-fingerprint-cancel", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    workLifecycle.assertOpen();
    const request = parseCatalogFingerprintBackfillOperationRequest(value);
    await assertFingerprintSession(request);
    const job = fingerprintJobs.get(request.operationId);
    if (job !== undefined) {
      if (job.catalogId !== request.catalogId || job.sessionId !== request.sessionId) {
        throw new Error("Fingerprint operation belongs to another catalog session.");
      }
      job.cancelled = true;
      return;
    }
    const stored = await fingerprintStore(request.catalogId).load(request.operationId);
    if (stored === null) return;
    const snapshot = parseFingerprintBackfillSnapshot(stored);
    if (snapshot.state === "planned" || snapshot.state === "running") {
      await workLifecycle.track("fingerprint", (token) =>
        runFingerprintBackfill(request, request.operationId, null, true, token),
      );
    }
  });

  ipcMain.handle("darkroom:catalog-admin-inspect", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return withActiveAdmin(value, (lease) => adminService.inspectCatalog(lease.databasePath));
  });
  ipcMain.handle("darkroom:catalog-admin-backup", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return withActiveAdmin(value, (lease) => adminService.backupCatalog(lease.catalogId));
  });
  ipcMain.handle("darkroom:catalog-admin-export", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return withActiveAdmin(value, async (lease) => {
      const result = await dialog.showSaveDialog({
        title: "Export catalog package",
        defaultPath: `${lease.displayName}.darkroomcatalog`,
        filters: [{ name: "Darkroom catalog", extensions: ["darkroomcatalog"] }],
      });
      if (result.canceled || result.filePath.length === 0) return null;
      const packagePath = result.filePath.endsWith(".darkroomcatalog")
        ? result.filePath
        : `${result.filePath}.darkroomcatalog`;
      return adminService.exportCatalogPackage(lease.catalogId, packagePath);
    });
  });
  ipcMain.handle("darkroom:catalog-admin-validate-package", async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog({
      title: "Validate catalog package",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return coordinator.runCatalogManagement(() => adminService.inspectCatalogPackage(result.filePaths[0]!));
  });
  ipcMain.handle("darkroom:catalog-admin-import-as-new", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogAdminImportRequest(value);
    const result = await dialog.showOpenDialog({
      title: "Import catalog as new",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return coordinator.runCatalogManagement(
      () => adminService.cloneAsNew(result.filePaths[0]!, request.displayName),
    );
  });
  ipcMain.handle("darkroom:catalog-admin-optimize-preview", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return withActiveAdmin(value, (lease) => adminService.optimizePreview(lease.catalogId));
  });
  ipcMain.handle("darkroom:catalog-admin-optimize", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return runCatalogTransition(() => withActiveAdmin(value, (lease) => adminService.optimize(lease.catalogId)));
  });
  ipcMain.handle("darkroom:catalog-admin-get-backup-policy", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return withActiveAdmin(value, (lease) => adminService.getBackupPolicy(lease.catalogId));
  });
  ipcMain.handle("darkroom:catalog-admin-set-backup-policy", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const request = parseCatalogAdminPolicyRequest(value);
    return withActiveAdmin(request, (lease) => adminService.setBackupPolicy(lease.catalogId, request.policy));
  });
  ipcMain.handle("darkroom:catalog-admin-run-scheduled-backup", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return withActiveAdmin(value, (lease) => adminService.runScheduledBackup(lease.catalogId));
  });

  ipcMain.handle("darkroom:get-export-formats", async (event) => {
    assertTrustedRenderer(event);
    return exportService.getExportFormats();
  });

  ipcMain.handle(
    "darkroom:choose-export-destination",
    async (event, request: ExportDestinationRequest) => {
      assertTrustedRenderer(event);
      const parsed = parseExportDestinationRequest(request);
      const locations = await coordinator.exportAssetLocations(parsed);
      const resolved = await Promise.all(locations.map(async (location) => ({
        assetId: location.assetId,
        path: await nativeAssetAccess.resolvePath(location),
      })));
      const sources = await resolveApprovedExportSources(resolved);
      return exportService.chooseExportDestination(parsed, sources);
    },
  );

  ipcMain.handle(
    "darkroom:encode-and-save-export",
    async (
      event,
      token: string,
      basename: string,
      pixels: ArrayBuffer | Uint8Array | ExportPixelPayload,
      options: ExportEncodeOptions,
    ) => {
      assertTrustedRenderer(event);
      return exportService.encodeAndSaveExport(token, basename, pixels, options);
    },
  );

  ipcMain.handle("darkroom:get-export-options", async (event) => {
    assertTrustedRenderer(event);
    return settingsStore.getExportOptions();
  });

  ipcMain.handle(
    "darkroom:set-export-options",
    async (event, options) => {
      assertTrustedRenderer(event);
      await settingsStore.setExportOptions(options);
    },
  );

  ipcMain.handle(
    "darkroom:finalize-export",
    async (event, token: string) => {
      assertTrustedRenderer(event);
      return exportService.finalizeExport(token);
    },
  );

  ipcMain.handle(
    "darkroom:show-in-folder",
    async (event, revealToken: string) => {
      assertTrustedRenderer(event);
      exportService.showInFolder(revealToken);
    },
  );

  ipcMain.handle("darkroom:get-ai-model-state", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    return aiModelService.getAiModelState(parseAiModelId(value));
  });

  ipcMain.handle("darkroom:download-ai-model", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await aiModelService.downloadAiModel(parseAiModelId(value));
  });

  ipcMain.handle("darkroom:cancel-ai-model-download", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await aiModelService.cancelAiModelDownload(parseAiModelId(value));
  });

  ipcMain.handle("darkroom:remove-ai-model", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    await aiModelService.removeAiModel(parseAiModelId(value));
  });

  ipcMain.handle(
    "darkroom:open-ai-model-link",
    async (event, modelValue: unknown, linkValue: unknown) => {
      assertTrustedRenderer(event);
      const modelId = parseAiModelId(modelValue);
      const link = parseAiModelDisclosureLink(linkValue);
      await shell.openExternal(getAiModelDisclosureUrl(modelId, link));
    },
  );
}

app.whenReady().then(async () => {
  await startCatalogWorker();
  if (process.env[CATALOG_WORKER_SMOKE_ENV] === "1") {
    await runCatalogWorkerAppSmoke();
    return;
  }
  await runStartupMigration();
  registerAiModelProtocol(aiModelService);
  registerIpcHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Catalog worker startup failed.";
  process.stderr.write(`${message}\n`);
  app.quit();
});

app.on("before-quit", (event) => {
  if (isQuitting) {
    return;
  }
  isQuitting = true;
  if (catalogBackupTimer !== null) {
    clearInterval(catalogBackupTimer);
    catalogBackupTimer = null;
  }
  event.preventDefault();
  const coordinatorShutdown = Promise.resolve()
    .then(() => shutdownCatalogBindings?.())
    .then(() => catalogCoordinator?.close());
  void coordinatorShutdown
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Catalog coordinator shutdown failed.";
      process.stderr.write(`${message}\n`);
    })
    .finally(() => stopCatalogWorker())
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Catalog worker shutdown failed.";
      process.stderr.write(`${message}\n`);
    })
    .finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
