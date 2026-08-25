import type {
  CatalogActivationResult,
  CatalogApplyRequest,
  CatalogApplyResult,
  CatalogAssetHeadRequest,
  CatalogAssetRequest,
  CatalogBootstrapResult,
  CatalogCreateRequest,
  CatalogDecodeRequest,
  CatalogDecodeResult,
  CatalogEvent,
  CatalogOperationRequest,
  CatalogOperationResult,
  CatalogQueryRequest,
  CatalogRemoveRequest,
  CatalogRootRequest,
  CatalogRootResult,
  CatalogScanRequest,
  CatalogSelectionRequest,
  CatalogSessionRequest,
  CatalogSidecarWriteRequest,
  CatalogLiveStateView,
} from "../lib/catalog/api";
import type { LibraryOperationSnapshot } from "../lib/catalog/runtime";
import type {
  CatalogFingerprintBackfillOperationRequest,
  CatalogFingerprintBackfillProgress,
  CatalogFingerprintBackfillRequest,
  CatalogFingerprintBackfillResumeRequest,
} from "../lib/catalog/fingerprint-backfill";
import type {
  AiModelId,
  AiModelDisclosureLink,
  AiModelProgress,
  AiModelState,
  Unsubscribe,
} from "../lib/ai/types";
import type {
  ExportDestinationRequest,
  ExportEncodeOptions,
  ExportFinalizeResult,
  ExportFormatDescriptor,
  ExportPixelPayload,
  ExportResult,
} from "../electron/export-service";
import type {
  ExportOptionsSettings,
  ExportOptionsSettingsInput,
} from "../electron/settings";
import type { FormatCapabilityReport } from "../lib/formats/types";
import type {
  CatalogAdminBackupResult,
  CatalogAdminCloneResult,
  CatalogAdminImportRequest,
  CatalogAdminInspectReport,
  CatalogAdminOptimizePreview,
  CatalogAdminOptimizeResult,
  CatalogAdminPolicyRequest,
  CatalogAdminSessionRequest,
  CatalogBackupPolicyState,
} from "../lib/catalog/admin";
import type {
  RelinkApplyRequest,
  RelinkCancelRequest,
  RelinkPrepareRequest,
  RelinkServiceApplyResult,
  RelinkServiceDraft,
} from "../lib/catalog/relink";
import type {
  CatalogImportDraftView,
  CatalogImportExecutionView,
  CatalogImportOperationRequest,
  CatalogImportPrepareRequest,
} from "../lib/import/api";
import type {
  AutoImportCancelRequest,
  AutoImportConfigureRequest,
  AutoImportControlRequest,
  AutoImportStatus,
} from "../lib/import/auto-import-api";
import type {
  MetadataAnalysisOperationRequest,
  MetadataAnalysisProgress,
  MetadataAnalysisRequest,
  MetadataAnalysisResult,
} from "../lib/library/metadata-analysis";
import type {
  ExactDuplicateTrashRequest,
  ExactDuplicateTrashResult,
} from "../lib/library/duplicate-actions";
import type {
  DevelopAssetGcRequest,
  DevelopAssetGcResult,
  DevelopAssetPutRequest,
  DevelopAssetPutResult,
  DevelopAssetReadRequest,
  DevelopAssetReadResult,
  DevelopAssetTransitionRequest,
  DevelopAssetTransitionResult,
} from "../lib/develop/v3/asset-store";
import type {
  DevelopJobAcceptanceResult,
  DevelopJobAcceptRequest,
  DevelopJobListener,
  DevelopJobRetryRequest,
  DevelopJobStartRequest,
  DevelopJobTargetRequest,
  GenerativeRemoveConsentGrantRequest,
  GenerativeRemoveConsentRevokeRequest,
} from "../lib/develop/v3/job-api";
import type {
  DevelopJobSnapshot,
  GenerativeRemoveConsentReceipt,
} from "../lib/develop/v3/jobs";
import type {
  CameraProfileConflictRequest,
  CameraProfileImportResult,
  CameraProfileRegistrySnapshot,
  CameraProfileRemoveRequest,
} from "../lib/camera-profiles/registry";
import type {
  DevelopPresetConflictRequest,
  DevelopPresetDeleteRequest,
  DevelopPresetFavoriteRequest,
  DevelopPresetImportResult,
  DevelopPresetSearchRequest,
} from "../lib/develop/presets/api";
import type { DevelopPresetRecord } from "../lib/develop/presets/schema";

export interface DarkroomAPI {
  isElectron: true;
  catalogBootstrap(): Promise<CatalogBootstrapResult>;
  catalogCreate(request: CatalogCreateRequest): Promise<CatalogActivationResult>;
  catalogOpen(request: CatalogSelectionRequest): Promise<CatalogActivationResult>;
  catalogSwitch(request: CatalogSelectionRequest): Promise<CatalogActivationResult>;
  catalogClose(request: CatalogSessionRequest): Promise<void>;
  catalogAddRoot(request: CatalogSessionRequest): Promise<CatalogRootResult>;
  catalogRelinkRoot(request: CatalogRootRequest): Promise<CatalogActivationResult>;
  catalogRelinkFilesPrepare(request: RelinkPrepareRequest): Promise<RelinkServiceDraft | null>;
  catalogRelinkFilesApply(request: RelinkApplyRequest): Promise<RelinkServiceApplyResult>;
  catalogRelinkFilesCancel(request: RelinkCancelRequest): Promise<void>;
  catalogRemove(request: CatalogRemoveRequest): Promise<void>;
  catalogStartScan(request: CatalogScanRequest): Promise<CatalogOperationResult>;
  catalogCancelScan(request: CatalogOperationRequest): Promise<void>;
  catalogGetOperation(request: CatalogOperationRequest): Promise<LibraryOperationSnapshot>;
  catalogWaitOperation(request: CatalogOperationRequest): Promise<LibraryOperationSnapshot>;
  catalogQuery(request: CatalogQueryRequest): Promise<CatalogLiveStateView>;
  catalogApply(request: CatalogApplyRequest): Promise<CatalogApplyResult>;
  catalogImportPrepare(request: CatalogImportPrepareRequest): Promise<CatalogImportDraftView>;
  catalogImportReview(request: CatalogImportOperationRequest): Promise<CatalogImportDraftView>;
  catalogImportRun(request: CatalogImportOperationRequest): Promise<CatalogImportExecutionView>;
  catalogImportCancel(request: CatalogImportOperationRequest): Promise<void>;
  catalogAutoImportConfigure(request: AutoImportConfigureRequest): Promise<AutoImportStatus>;
  catalogAutoImportStatus(request: AutoImportControlRequest): Promise<AutoImportStatus>;
  catalogAutoImportEnable(request: AutoImportControlRequest): Promise<AutoImportStatus>;
  catalogAutoImportDisable(request: AutoImportControlRequest): Promise<AutoImportStatus>;
  catalogAutoImportPause(request: AutoImportControlRequest): Promise<AutoImportStatus>;
  catalogAutoImportResume(request: AutoImportControlRequest): Promise<AutoImportStatus>;
  catalogAutoImportRetryFailed(request: AutoImportControlRequest): Promise<AutoImportStatus>;
  catalogAutoImportClearFailed(request: AutoImportControlRequest): Promise<AutoImportStatus>;
  catalogAutoImportCancel(request: AutoImportCancelRequest): Promise<AutoImportStatus>;
  catalogAutoImportOpenIngress(request: CatalogSessionRequest): Promise<void>;
  catalogReadAsset(request: CatalogAssetRequest): Promise<ArrayBuffer>;
  developAssetPut(request: DevelopAssetPutRequest): Promise<DevelopAssetPutResult>;
  developAssetTransition(
    request: DevelopAssetTransitionRequest,
  ): Promise<DevelopAssetTransitionResult>;
  developAssetRead(request: DevelopAssetReadRequest): Promise<DevelopAssetReadResult>;
  cameraProfilesList(): Promise<CameraProfileRegistrySnapshot>;
  cameraProfilesImport(): Promise<CameraProfileImportResult>;
  cameraProfilesResolveConflict(
    request: CameraProfileConflictRequest,
  ): Promise<CameraProfileImportResult>;
  cameraProfilesRescan(): Promise<CameraProfileRegistrySnapshot>;
  cameraProfilesRemove(
    request: CameraProfileRemoveRequest,
  ): Promise<CameraProfileRegistrySnapshot>;
  developPresetsList(
    request: DevelopPresetSearchRequest,
  ): Promise<readonly DevelopPresetRecord[]>;
  developPresetsCreate(preset: DevelopPresetRecord): Promise<DevelopPresetRecord>;
  developPresetsUpdate(preset: DevelopPresetRecord): Promise<DevelopPresetRecord>;
  developPresetsFavorite(
    request: DevelopPresetFavoriteRequest,
  ): Promise<DevelopPresetRecord>;
  developPresetsDelete(request: DevelopPresetDeleteRequest): Promise<void>;
  developPresetsImport(): Promise<DevelopPresetImportResult>;
  developPresetsResolveConflict(
    request: DevelopPresetConflictRequest,
  ): Promise<DevelopPresetImportResult>;
  developAssetCollectGarbage(
    request: DevelopAssetGcRequest,
  ): Promise<DevelopAssetGcResult>;
  developJobsList(): Promise<readonly DevelopJobSnapshot[]>;
  developJobsStart(request: DevelopJobStartRequest): Promise<DevelopJobSnapshot>;
  developJobsCancel(request: DevelopJobTargetRequest): Promise<DevelopJobSnapshot>;
  developJobsRetry(request: DevelopJobRetryRequest): Promise<DevelopJobSnapshot>;
  developJobsDiscard(request: DevelopJobTargetRequest): Promise<void>;
  developJobsAccept(request: DevelopJobAcceptRequest): Promise<DevelopJobAcceptanceResult>;
  developJobsGrantGenerativeRemoveConsent(
    request: GenerativeRemoveConsentGrantRequest,
  ): Promise<GenerativeRemoveConsentReceipt>;
  developJobsRevokeGenerativeRemoveConsent(
    request: GenerativeRemoveConsentRevokeRequest,
  ): Promise<GenerativeRemoveConsentReceipt>;
  onDevelopJobsUpdated(listener: DevelopJobListener): () => void;
  catalogReadAssetHead(request: CatalogAssetHeadRequest): Promise<ArrayBuffer>;
  catalogStatAsset(request: CatalogAssetRequest): Promise<{ readonly size: number; readonly lastModified: number }>;
  catalogReadSidecar(request: CatalogAssetRequest): Promise<{ readonly contents: string; readonly lastModified: number } | null>;
  catalogWriteSidecar(request: CatalogSidecarWriteRequest): Promise<void>;
  catalogDecodeAsset(request: CatalogAssetRequest, decode: CatalogDecodeRequest): Promise<CatalogDecodeResult>;
  catalogTrashAsset(request: CatalogAssetRequest): Promise<void>;
  catalogTrashExactDuplicates(request: ExactDuplicateTrashRequest): Promise<ExactDuplicateTrashResult>;
  catalogAnalyzeMetadata(request: MetadataAnalysisRequest): Promise<MetadataAnalysisResult>;
  catalogCancelMetadataAnalysis(request: MetadataAnalysisOperationRequest): Promise<void>;
  onCatalogMetadataAnalysisProgress(listener: (progress: MetadataAnalysisProgress) => void): Unsubscribe;
  onCatalogEvent(listener: (event: CatalogEvent) => void): Unsubscribe;
  getFormatCapabilityReport(): Promise<FormatCapabilityReport>;
  catalogFingerprintStatus(request: CatalogFingerprintBackfillRequest): Promise<CatalogFingerprintBackfillProgress | null>;
  catalogFingerprintStart(request: CatalogFingerprintBackfillRequest): Promise<CatalogFingerprintBackfillProgress>;
  catalogFingerprintResume(request: CatalogFingerprintBackfillResumeRequest): Promise<CatalogFingerprintBackfillProgress>;
  catalogFingerprintRecover(request: CatalogFingerprintBackfillRequest): Promise<CatalogFingerprintBackfillProgress | null>;
  catalogFingerprintCancel(request: CatalogFingerprintBackfillOperationRequest): Promise<void>;
  onCatalogFingerprintProgress(listener: (progress: CatalogFingerprintBackfillProgress) => void): Unsubscribe;
  catalogAdminInspect(request: CatalogAdminSessionRequest): Promise<CatalogAdminInspectReport>;
  catalogAdminBackup(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult>;
  catalogAdminExport(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult | null>;
  catalogAdminValidatePackage(): Promise<CatalogAdminInspectReport | null>;
  catalogAdminImportAsNew(request: CatalogAdminImportRequest): Promise<CatalogAdminCloneResult | null>;
  catalogAdminOptimizePreview(request: CatalogAdminSessionRequest): Promise<CatalogAdminOptimizePreview>;
  catalogAdminOptimize(request: CatalogAdminSessionRequest): Promise<CatalogAdminOptimizeResult>;
  catalogAdminGetBackupPolicy(request: CatalogAdminSessionRequest): Promise<CatalogBackupPolicyState>;
  catalogAdminSetBackupPolicy(request: CatalogAdminPolicyRequest): Promise<CatalogBackupPolicyState>;
  catalogAdminRunScheduledBackup(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult | null>;
  getExportFormats(): Promise<ExportFormatDescriptor[]>;
  chooseExportDestination(
    request: ExportDestinationRequest,
  ): Promise<{ token: string } | null>;
  encodeAndSaveExport(
    token: string,
    basename: string,
    pixels: ArrayBuffer | Uint8Array | ExportPixelPayload,
    options: ExportEncodeOptions,
  ): Promise<ExportResult>;
  finalizeExport(token: string): Promise<ExportFinalizeResult>;
  getExportOptions(): Promise<ExportOptionsSettings>;
  setExportOptions(options: ExportOptionsSettingsInput): Promise<void>;
  showInFolder(revealToken: string): Promise<void>;
  getAiModelState(modelId: AiModelId): Promise<AiModelState>;
  downloadAiModel(modelId: AiModelId): Promise<void>;
  cancelAiModelDownload(modelId: AiModelId): Promise<void>;
  removeAiModel(modelId: AiModelId): Promise<void>;
  openAiModelLink(modelId: AiModelId, link: AiModelDisclosureLink): Promise<void>;
  onAiModelProgress(listener: (progress: AiModelProgress) => void): Unsubscribe;
}

declare global {
  interface Window {
    darkroom?: DarkroomAPI;
  }
}

export {};
