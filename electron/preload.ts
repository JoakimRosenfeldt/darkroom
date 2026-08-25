import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  isAiModelProgress,
  parseAiModelId,
  type AiModelDisclosureLink,
  type AiModelId,
  type AiModelProgress,
  type AiModelState,
  type Unsubscribe,
} from "../lib/ai/types";
import {
  parseCatalogApplyRequest,
  parseCatalogAssetHeadRequest,
  parseCatalogAssetRequest,
  parseCatalogCreateRequest,
  parseCatalogDecodeRequest,
  parseCatalogEvent,
  parseCatalogOperationRequest,
  parseCatalogQueryRequest,
  parseCatalogRemoveRequest,
  parseCatalogRootRequest,
  parseCatalogScanRequest,
  parseCatalogSelectionRequest,
  parseCatalogSessionRequest,
  parseCatalogSidecarWriteRequest,
  type CatalogActivationResult,
  type CatalogApplyRequest,
  type CatalogApplyResult,
  type CatalogAssetHeadRequest,
  type CatalogAssetRequest,
  type CatalogBootstrapResult,
  type CatalogCreateRequest,
  type CatalogDecodeRequest,
  type CatalogDecodeResult,
  type CatalogEvent,
  type CatalogOperationRequest,
  type CatalogOperationResult,
  type CatalogQueryRequest,
  type CatalogRemoveRequest,
  type CatalogRootRequest,
  type CatalogScanRequest,
  type CatalogSelectionRequest,
  type CatalogSessionRequest,
  type CatalogSidecarWriteRequest,
  type CatalogRootResult,
  type CatalogLiveStateView,
} from "../lib/catalog/api.ts";
import type { LibraryOperationSnapshot } from "../lib/catalog/runtime.ts";
import {
  parseCatalogFingerprintBackfillOperationRequest,
  parseCatalogFingerprintBackfillProgress,
  parseCatalogFingerprintBackfillRequest,
  parseCatalogFingerprintBackfillResumeRequest,
  type CatalogFingerprintBackfillOperationRequest,
  type CatalogFingerprintBackfillProgress,
  type CatalogFingerprintBackfillRequest,
  type CatalogFingerprintBackfillResumeRequest,
} from "../lib/catalog/fingerprint-backfill.ts";
import {
  parseRelinkApplyRequest,
  parseRelinkCancelRequest,
  parseRelinkPrepareRequest,
  type RelinkApplyRequest,
  type RelinkCancelRequest,
  type RelinkPrepareRequest,
  type RelinkServiceApplyResult,
  type RelinkServiceDraft,
} from "../lib/catalog/relink.ts";
import type {
  ExportDestinationRequest,
  ExportEncodeOptions,
  ExportFinalizeResult,
  ExportFormatDescriptor,
  ExportPixelPayload,
  ExportResult,
} from "./export-service";
import { parseExportDestinationRequest } from "../lib/export/types";
import type { FormatCapabilityReport } from "../lib/formats/types";
import {
  parseCatalogAdminImportRequest,
  parseCatalogAdminPolicyRequest,
  parseCatalogAdminSessionRequest,
  type CatalogAdminBackupResult,
  type CatalogAdminCloneResult,
  type CatalogAdminImportRequest,
  type CatalogAdminInspectReport,
  type CatalogAdminOptimizePreview,
  type CatalogAdminOptimizeResult,
  type CatalogAdminPolicyRequest,
  type CatalogAdminSessionRequest,
  type CatalogBackupPolicyState,
} from "../lib/catalog/admin.ts";
import type {
  ExportOptionsSettings,
  ExportOptionsSettingsInput,
} from "./settings";
import {
  parseCatalogImportDraftView,
  parseCatalogImportExecutionView,
  parseCatalogImportOperationRequest,
  parseCatalogImportPrepareRequest,
  type CatalogImportDraftView,
  type CatalogImportExecutionView,
  type CatalogImportOperationRequest,
  type CatalogImportPrepareRequest,
} from "../lib/import/api.ts";
import {
  parseAutoImportCancelRequest,
  parseAutoImportConfigureRequest,
  parseAutoImportControlRequest,
  parseAutoImportStatus,
  type AutoImportCancelRequest,
  type AutoImportConfigureRequest,
  type AutoImportControlRequest,
  type AutoImportStatus,
} from "../lib/import/auto-import-api.ts";
import {
  parseMetadataAnalysisOperationRequest,
  parseMetadataAnalysisProgress,
  parseMetadataAnalysisRequest,
  parseMetadataAnalysisResult,
  type MetadataAnalysisOperationRequest,
  type MetadataAnalysisProgress,
  type MetadataAnalysisRequest,
  type MetadataAnalysisResult,
} from "../lib/library/metadata-analysis.ts";
import {
  parseExactDuplicateTrashRequest,
  parseExactDuplicateTrashResult,
  type ExactDuplicateTrashRequest,
  type ExactDuplicateTrashResult,
} from "../lib/library/duplicate-actions.ts";
import {
  parseDevelopAssetGcRequest,
  parseDevelopAssetGcResult,
  parseDevelopAssetPutRequest,
  parseDevelopAssetPutResult,
  parseDevelopAssetReadRequest,
  parseDevelopAssetReadResult,
  parseDevelopAssetTransitionRequest,
  parseDevelopAssetTransitionResult,
  type DevelopAssetGcRequest,
  type DevelopAssetGcResult,
  type DevelopAssetPutRequest,
  type DevelopAssetPutResult,
  type DevelopAssetReadRequest,
  type DevelopAssetReadResult,
  type DevelopAssetTransitionRequest,
  type DevelopAssetTransitionResult,
} from "../lib/develop/v3/asset-store.ts";
import {
  parseDevelopJobAcceptanceResult,
  parseDevelopJobAcceptRequest,
  parseDevelopJobRetryRequest,
  parseDevelopJobSnapshotList,
  parseDevelopJobStartRequest,
  parseDevelopJobTargetRequest,
  parseGenerativeRemoveConsentGrantRequest,
  parseGenerativeRemoveConsentResult,
  parseGenerativeRemoveConsentRevokeRequest,
  type DevelopJobAcceptanceResult,
  type DevelopJobAcceptRequest,
  type DevelopJobListener,
  type DevelopJobRetryRequest,
  type DevelopJobStartRequest,
  type DevelopJobTargetRequest,
  type GenerativeRemoveConsentGrantRequest,
  type GenerativeRemoveConsentRevokeRequest,
} from "../lib/develop/v3/job-api.ts";
import {
  parseDevelopJobSnapshot,
  type DevelopJobSnapshot,
  type GenerativeRemoveConsentReceipt,
} from "../lib/develop/v3/jobs.ts";
import {
  parseCameraProfileConflictRequest,
  parseCameraProfileImportResult,
  parseCameraProfileRegistrySnapshot,
  parseCameraProfileRemoveRequest,
  type CameraProfileConflictRequest,
  type CameraProfileImportResult,
  type CameraProfileRegistrySnapshot,
  type CameraProfileRemoveRequest,
} from "../lib/camera-profiles/registry.ts";

const darkroom = {
  isElectron: true as const,

  catalogBootstrap(): Promise<CatalogBootstrapResult> {
    return ipcRenderer.invoke("darkroom:catalog-bootstrap");
  },

  catalogCreate(request: CatalogCreateRequest): Promise<CatalogActivationResult> {
    return ipcRenderer.invoke("darkroom:catalog-create", parseCatalogCreateRequest(request));
  },

  catalogOpen(request: CatalogSelectionRequest): Promise<CatalogActivationResult> {
    return ipcRenderer.invoke("darkroom:catalog-open", parseCatalogSelectionRequest(request));
  },

  catalogSwitch(request: CatalogSelectionRequest): Promise<CatalogActivationResult> {
    return ipcRenderer.invoke("darkroom:catalog-switch", parseCatalogSelectionRequest(request));
  },

  catalogClose(request: CatalogSessionRequest): Promise<void> {
    return ipcRenderer.invoke("darkroom:catalog-close", parseCatalogSessionRequest(request));
  },

  catalogAddRoot(request: CatalogSessionRequest): Promise<CatalogRootResult> {
    return ipcRenderer.invoke("darkroom:catalog-add-root", parseCatalogSessionRequest(request));
  },

  catalogRelinkRoot(request: CatalogRootRequest): Promise<CatalogActivationResult> {
    return ipcRenderer.invoke("darkroom:catalog-relink-root", parseCatalogRootRequest(request));
  },

  catalogRelinkFilesPrepare(request: RelinkPrepareRequest): Promise<RelinkServiceDraft | null> {
    return ipcRenderer.invoke(
      "darkroom:catalog-relink-files-prepare",
      parseRelinkPrepareRequest(request),
    );
  },

  catalogRelinkFilesApply(request: RelinkApplyRequest): Promise<RelinkServiceApplyResult> {
    return ipcRenderer.invoke(
      "darkroom:catalog-relink-files-apply",
      parseRelinkApplyRequest(request),
    );
  },

  catalogRelinkFilesCancel(request: RelinkCancelRequest): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:catalog-relink-files-cancel",
      parseRelinkCancelRequest(request),
    );
  },

  catalogRemove(request: CatalogRemoveRequest): Promise<void> {
    return ipcRenderer.invoke("darkroom:catalog-remove", parseCatalogRemoveRequest(request));
  },

  catalogStartScan(request: CatalogScanRequest): Promise<CatalogOperationResult> {
    return ipcRenderer.invoke("darkroom:catalog-start-scan", parseCatalogScanRequest(request));
  },

  catalogCancelScan(request: CatalogOperationRequest): Promise<void> {
    return ipcRenderer.invoke("darkroom:catalog-cancel-scan", parseCatalogOperationRequest(request));
  },

  catalogGetOperation(request: CatalogOperationRequest): Promise<LibraryOperationSnapshot> {
    return ipcRenderer.invoke("darkroom:catalog-get-operation", parseCatalogOperationRequest(request));
  },

  catalogWaitOperation(request: CatalogOperationRequest): Promise<LibraryOperationSnapshot> {
    return ipcRenderer.invoke("darkroom:catalog-wait-operation", parseCatalogOperationRequest(request));
  },

  catalogQuery(request: CatalogQueryRequest): Promise<CatalogLiveStateView> {
    return ipcRenderer.invoke("darkroom:catalog-query", parseCatalogQueryRequest(request));
  },

  catalogApply(request: CatalogApplyRequest): Promise<CatalogApplyResult> {
    return ipcRenderer.invoke("darkroom:catalog-apply", parseCatalogApplyRequest(request));
  },

  async catalogImportPrepare(request: CatalogImportPrepareRequest): Promise<CatalogImportDraftView> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-import-prepare",
      parseCatalogImportPrepareRequest(request),
    );
    return parseCatalogImportDraftView(result);
  },

  async catalogImportReview(request: CatalogImportOperationRequest): Promise<CatalogImportDraftView> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-import-review",
      parseCatalogImportOperationRequest(request),
    );
    return parseCatalogImportDraftView(result);
  },

  async catalogImportRun(request: CatalogImportOperationRequest): Promise<CatalogImportExecutionView> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-import-run",
      parseCatalogImportOperationRequest(request),
    );
    return parseCatalogImportExecutionView(result);
  },

  catalogImportCancel(request: CatalogImportOperationRequest): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:catalog-import-cancel",
      parseCatalogImportOperationRequest(request),
    );
  },

  async catalogAutoImportConfigure(request: AutoImportConfigureRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-configure",
      parseAutoImportConfigureRequest(request),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportStatus(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-status",
      parseAutoImportControlRequest(request),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportEnable(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-enable",
      parseAutoImportControlRequest({ ...request, action: "enable" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportDisable(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-disable",
      parseAutoImportControlRequest({ ...request, action: "disable" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportPause(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-pause",
      parseAutoImportControlRequest({ ...request, action: "pause" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportResume(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-resume",
      parseAutoImportControlRequest({ ...request, action: "resume" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportRetryFailed(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-retry-failed",
      parseAutoImportControlRequest({ ...request, action: "retry-failed" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportClearFailed(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-clear-failed",
      parseAutoImportControlRequest({ ...request, action: "clear-failed" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportCancel(request: AutoImportCancelRequest): Promise<AutoImportStatus> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-auto-import-cancel",
      parseAutoImportCancelRequest(request),
    );
    return parseAutoImportStatus(result);
  },

  catalogAutoImportOpenIngress(request: CatalogSessionRequest): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:catalog-auto-import-open-ingress",
      parseCatalogSessionRequest(request),
    );
  },

  catalogReadAsset(request: CatalogAssetRequest): Promise<ArrayBuffer> {
    return ipcRenderer.invoke("darkroom:catalog-read-asset", parseCatalogAssetRequest(request));
  },

  async developAssetPut(
    request: DevelopAssetPutRequest,
  ): Promise<DevelopAssetPutResult> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-asset-put",
      parseDevelopAssetPutRequest(request),
    );
    return parseDevelopAssetPutResult(result);
  },

  async developAssetTransition(
    request: DevelopAssetTransitionRequest,
  ): Promise<DevelopAssetTransitionResult> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-asset-transition",
      parseDevelopAssetTransitionRequest(request),
    );
    return parseDevelopAssetTransitionResult(result);
  },

  async developAssetRead(
    request: DevelopAssetReadRequest,
  ): Promise<DevelopAssetReadResult> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-asset-read",
      parseDevelopAssetReadRequest(request),
    );
    return parseDevelopAssetReadResult(result);
  },

  async cameraProfilesList(): Promise<CameraProfileRegistrySnapshot> {
    const result: unknown = await ipcRenderer.invoke("darkroom:camera-profiles-list");
    return parseCameraProfileRegistrySnapshot(result);
  },

  async cameraProfilesImport(): Promise<CameraProfileImportResult> {
    const result: unknown = await ipcRenderer.invoke("darkroom:camera-profiles-import");
    return parseCameraProfileImportResult(result);
  },

  async cameraProfilesResolveConflict(
    request: CameraProfileConflictRequest,
  ): Promise<CameraProfileImportResult> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:camera-profiles-resolve-conflict",
      parseCameraProfileConflictRequest(request),
    );
    return parseCameraProfileImportResult(result);
  },

  async cameraProfilesRescan(): Promise<CameraProfileRegistrySnapshot> {
    const result: unknown = await ipcRenderer.invoke("darkroom:camera-profiles-rescan");
    return parseCameraProfileRegistrySnapshot(result);
  },

  async cameraProfilesRemove(
    request: CameraProfileRemoveRequest,
  ): Promise<CameraProfileRegistrySnapshot> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:camera-profiles-remove",
      parseCameraProfileRemoveRequest(request),
    );
    return parseCameraProfileRegistrySnapshot(result);
  },

  async developAssetCollectGarbage(
    request: DevelopAssetGcRequest,
  ): Promise<DevelopAssetGcResult> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-asset-gc",
      parseDevelopAssetGcRequest(request),
    );
    return parseDevelopAssetGcResult(result);
  },

  async developJobsList(): Promise<readonly DevelopJobSnapshot[]> {
    const result: unknown = await ipcRenderer.invoke("darkroom:develop-jobs-list");
    return parseDevelopJobSnapshotList(result);
  },

  async developJobsStart(request: DevelopJobStartRequest): Promise<DevelopJobSnapshot> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-jobs-start",
      parseDevelopJobStartRequest(request),
    );
    return parseDevelopJobSnapshot(result);
  },

  async developJobsCancel(request: DevelopJobTargetRequest): Promise<DevelopJobSnapshot> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-jobs-cancel",
      parseDevelopJobTargetRequest(request),
    );
    return parseDevelopJobSnapshot(result);
  },

  async developJobsRetry(request: DevelopJobRetryRequest): Promise<DevelopJobSnapshot> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-jobs-retry",
      parseDevelopJobRetryRequest(request),
    );
    return parseDevelopJobSnapshot(result);
  },

  async developJobsDiscard(request: DevelopJobTargetRequest): Promise<void> {
    await ipcRenderer.invoke(
      "darkroom:develop-jobs-discard",
      parseDevelopJobTargetRequest(request),
    );
  },

  async developJobsAccept(
    request: DevelopJobAcceptRequest,
  ): Promise<DevelopJobAcceptanceResult> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-jobs-accept",
      parseDevelopJobAcceptRequest(request),
    );
    return parseDevelopJobAcceptanceResult(result);
  },

  async developJobsGrantGenerativeRemoveConsent(
    request: GenerativeRemoveConsentGrantRequest,
  ): Promise<GenerativeRemoveConsentReceipt> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-jobs-consent-grant",
      parseGenerativeRemoveConsentGrantRequest(request),
    );
    return parseGenerativeRemoveConsentResult(result);
  },

  async developJobsRevokeGenerativeRemoveConsent(
    request: GenerativeRemoveConsentRevokeRequest,
  ): Promise<GenerativeRemoveConsentReceipt> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:develop-jobs-consent-revoke",
      parseGenerativeRemoveConsentRevokeRequest(request),
    );
    return parseGenerativeRemoveConsentResult(result);
  },

  onDevelopJobsUpdated(listener: DevelopJobListener): () => void {
    if (typeof listener !== "function") {
      throw new Error("Develop job listener must be a function.");
    }
    const wrapped = (_event: IpcRendererEvent, value: unknown) => {
      try {
        listener(parseDevelopJobSnapshotList(value));
      } catch {
        // Malformed or stale main-process events are ignored at the renderer boundary.
      }
    };
    ipcRenderer.on("darkroom:develop-jobs-updated", wrapped);
    return () => ipcRenderer.removeListener("darkroom:develop-jobs-updated", wrapped);
  },

  catalogReadAssetHead(request: CatalogAssetHeadRequest): Promise<ArrayBuffer> {
    return ipcRenderer.invoke("darkroom:catalog-read-asset-head", parseCatalogAssetHeadRequest(request));
  },

  catalogStatAsset(request: CatalogAssetRequest): Promise<{ readonly size: number; readonly lastModified: number }> {
    return ipcRenderer.invoke("darkroom:catalog-stat-asset", parseCatalogAssetRequest(request));
  },

  catalogReadSidecar(request: CatalogAssetRequest): Promise<{ readonly contents: string; readonly lastModified: number } | null> {
    return ipcRenderer.invoke("darkroom:catalog-read-sidecar", parseCatalogAssetRequest(request));
  },

  catalogWriteSidecar(request: CatalogSidecarWriteRequest): Promise<void> {
    return ipcRenderer.invoke("darkroom:catalog-write-sidecar", parseCatalogSidecarWriteRequest(request));
  },

  catalogDecodeAsset(request: CatalogAssetRequest, decode: CatalogDecodeRequest): Promise<CatalogDecodeResult> {
    return ipcRenderer.invoke(
      "darkroom:catalog-decode-asset",
      parseCatalogAssetRequest(request),
      parseCatalogDecodeRequest(decode),
    );
  },

  catalogTrashAsset(request: CatalogAssetRequest): Promise<void> {
    return ipcRenderer.invoke("darkroom:catalog-trash-asset", parseCatalogAssetRequest(request));
  },

  async catalogTrashExactDuplicates(request: ExactDuplicateTrashRequest): Promise<ExactDuplicateTrashResult> {
    return parseExactDuplicateTrashResult(await ipcRenderer.invoke(
      "darkroom:catalog-trash-exact-duplicates",
      parseExactDuplicateTrashRequest(request),
    ));
  },

  async catalogAnalyzeMetadata(request: MetadataAnalysisRequest): Promise<MetadataAnalysisResult> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-analyze-metadata",
      parseMetadataAnalysisRequest(request),
    );
    return parseMetadataAnalysisResult(result);
  },

  catalogCancelMetadataAnalysis(request: MetadataAnalysisOperationRequest): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:catalog-cancel-metadata-analysis",
      parseMetadataAnalysisOperationRequest(request),
    );
  },

  onCatalogMetadataAnalysisProgress(
    listener: (progress: MetadataAnalysisProgress) => void,
  ): Unsubscribe {
    if (typeof listener !== "function") throw new Error("Metadata progress listener must be a function.");
    const wrapped = (_event: IpcRendererEvent, value: unknown) => {
      try {
        listener(parseMetadataAnalysisProgress(value));
      } catch {
        // Malformed or stale progress is ignored at the renderer boundary.
      }
    };
    ipcRenderer.on("darkroom:catalog-metadata-analysis-progress", wrapped);
    return () => ipcRenderer.removeListener("darkroom:catalog-metadata-analysis-progress", wrapped);
  },

  onCatalogEvent(listener: (event: CatalogEvent) => void): Unsubscribe {
    if (typeof listener !== "function") throw new Error("Catalog event listener must be a function.");
    const wrapped = (_event: IpcRendererEvent, value: unknown) => {
      try {
        listener(parseCatalogEvent(value));
      } catch {
        // Malformed or stale main-process events are ignored at the renderer boundary.
      }
    };
    ipcRenderer.on("darkroom:catalog-event", wrapped);
    return () => ipcRenderer.removeListener("darkroom:catalog-event", wrapped);
  },

  getFormatCapabilityReport(): Promise<FormatCapabilityReport> {
    return ipcRenderer.invoke("darkroom:get-format-capability-report");
  },

  async catalogFingerprintStatus(
    request: CatalogFingerprintBackfillRequest,
  ): Promise<CatalogFingerprintBackfillProgress | null> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-fingerprint-status",
      parseCatalogFingerprintBackfillRequest(request),
    );
    return result === null ? null : parseCatalogFingerprintBackfillProgress(result);
  },

  async catalogFingerprintStart(
    request: CatalogFingerprintBackfillRequest,
  ): Promise<CatalogFingerprintBackfillProgress> {
    return parseCatalogFingerprintBackfillProgress(await ipcRenderer.invoke(
      "darkroom:catalog-fingerprint-start",
      parseCatalogFingerprintBackfillRequest(request),
    ));
  },

  async catalogFingerprintResume(
    request: CatalogFingerprintBackfillResumeRequest,
  ): Promise<CatalogFingerprintBackfillProgress> {
    return parseCatalogFingerprintBackfillProgress(await ipcRenderer.invoke(
      "darkroom:catalog-fingerprint-resume",
      parseCatalogFingerprintBackfillResumeRequest(request),
    ));
  },

  async catalogFingerprintRecover(
    request: CatalogFingerprintBackfillRequest,
  ): Promise<CatalogFingerprintBackfillProgress | null> {
    const result: unknown = await ipcRenderer.invoke(
      "darkroom:catalog-fingerprint-recover",
      parseCatalogFingerprintBackfillRequest(request),
    );
    return result === null ? null : parseCatalogFingerprintBackfillProgress(result);
  },

  catalogFingerprintCancel(request: CatalogFingerprintBackfillOperationRequest): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:catalog-fingerprint-cancel",
      parseCatalogFingerprintBackfillOperationRequest(request),
    );
  },

  onCatalogFingerprintProgress(
    listener: (progress: CatalogFingerprintBackfillProgress) => void,
  ): Unsubscribe {
    if (typeof listener !== "function") throw new Error("Fingerprint progress listener must be a function.");
    const wrapped = (_event: IpcRendererEvent, value: unknown) => {
      try {
        listener(parseCatalogFingerprintBackfillProgress(value));
      } catch {
        // Malformed or stale main-process events are ignored at the renderer boundary.
      }
    };
    ipcRenderer.on("darkroom:catalog-fingerprint-progress", wrapped);
    return () => ipcRenderer.removeListener("darkroom:catalog-fingerprint-progress", wrapped);
  },

  catalogAdminInspect(request: CatalogAdminSessionRequest): Promise<CatalogAdminInspectReport> {
    return ipcRenderer.invoke("darkroom:catalog-admin-inspect", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminBackup(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult> {
    return ipcRenderer.invoke("darkroom:catalog-admin-backup", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminExport(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult | null> {
    return ipcRenderer.invoke("darkroom:catalog-admin-export", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminValidatePackage(): Promise<CatalogAdminInspectReport | null> {
    return ipcRenderer.invoke("darkroom:catalog-admin-validate-package");
  },

  catalogAdminImportAsNew(request: CatalogAdminImportRequest): Promise<CatalogAdminCloneResult | null> {
    return ipcRenderer.invoke("darkroom:catalog-admin-import-as-new", parseCatalogAdminImportRequest(request));
  },

  catalogAdminOptimizePreview(request: CatalogAdminSessionRequest): Promise<CatalogAdminOptimizePreview> {
    return ipcRenderer.invoke("darkroom:catalog-admin-optimize-preview", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminOptimize(request: CatalogAdminSessionRequest): Promise<CatalogAdminOptimizeResult> {
    return ipcRenderer.invoke("darkroom:catalog-admin-optimize", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminGetBackupPolicy(request: CatalogAdminSessionRequest): Promise<CatalogBackupPolicyState> {
    return ipcRenderer.invoke("darkroom:catalog-admin-get-backup-policy", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminSetBackupPolicy(request: CatalogAdminPolicyRequest): Promise<CatalogBackupPolicyState> {
    return ipcRenderer.invoke("darkroom:catalog-admin-set-backup-policy", parseCatalogAdminPolicyRequest(request));
  },

  catalogAdminRunScheduledBackup(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult | null> {
    return ipcRenderer.invoke("darkroom:catalog-admin-run-scheduled-backup", parseCatalogAdminSessionRequest(request));
  },

  getExportFormats(): Promise<ExportFormatDescriptor[]> {
    return ipcRenderer.invoke("darkroom:get-export-formats");
  },

  chooseExportDestination(
    request: ExportDestinationRequest,
  ): Promise<{ token: string } | null> {
    return ipcRenderer.invoke(
      "darkroom:choose-export-destination",
      parseExportDestinationRequest(request),
    );
  },

  encodeAndSaveExport(
    token: string,
    basename: string,
    pixels: ArrayBuffer | Uint8Array | ExportPixelPayload,
    options: ExportEncodeOptions,
  ): Promise<ExportResult> {
    return ipcRenderer.invoke(
      "darkroom:encode-and-save-export",
      token,
      basename,
      pixels,
      options,
    );
  },

  finalizeExport(token: string): Promise<ExportFinalizeResult> {
    return ipcRenderer.invoke("darkroom:finalize-export", token);
  },

  getExportOptions(): Promise<ExportOptionsSettings> {
    return ipcRenderer.invoke("darkroom:get-export-options");
  },

  setExportOptions(options: ExportOptionsSettingsInput): Promise<void> {
    return ipcRenderer.invoke("darkroom:set-export-options", options);
  },

  showInFolder(revealToken: string): Promise<void> {
    return ipcRenderer.invoke("darkroom:show-in-folder", revealToken);
  },

  getAiModelState(modelId: AiModelId): Promise<AiModelState> {
    return ipcRenderer.invoke("darkroom:get-ai-model-state", parseAiModelId(modelId));
  },

  downloadAiModel(modelId: AiModelId): Promise<void> {
    return ipcRenderer.invoke("darkroom:download-ai-model", parseAiModelId(modelId));
  },

  cancelAiModelDownload(modelId: AiModelId): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:cancel-ai-model-download",
      parseAiModelId(modelId),
    );
  },

  removeAiModel(modelId: AiModelId): Promise<void> {
    return ipcRenderer.invoke("darkroom:remove-ai-model", parseAiModelId(modelId));
  },

  openAiModelLink(modelId: AiModelId, link: AiModelDisclosureLink): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:open-ai-model-link",
      parseAiModelId(modelId),
      link,
    );
  },

  onAiModelProgress(
    listener: (progress: AiModelProgress) => void,
  ): Unsubscribe {
    if (typeof listener !== "function") {
      throw new Error("AI model progress listener must be a function.");
    }
    const wrapped = (_event: IpcRendererEvent, value: unknown) => {
      if (isAiModelProgress(value)) {
        listener(value);
      }
    };
    ipcRenderer.on("darkroom:ai-model-progress", wrapped);
    return () => {
      ipcRenderer.removeListener("darkroom:ai-model-progress", wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("darkroom", darkroom);
