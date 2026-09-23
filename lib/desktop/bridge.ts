import { isTauri } from "@tauri-apps/api/core";
import { desktopTransport } from "./transport";
import type { DarkroomAPI } from "../../types/desktop";
import {
  isAiModelProgress,
  parseAiModelId,
  type AiModelDisclosureLink,
  type AiModelId,
  type AiModelProgress,
  type AiModelState,
  type Unsubscribe,
} from "../ai/types";
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
} from "../catalog/api.ts";
import type { LibraryOperationSnapshot } from "../catalog/runtime.ts";
import {
  parseCatalogFingerprintBackfillOperationRequest,
  parseCatalogFingerprintBackfillProgress,
  parseCatalogFingerprintBackfillRequest,
  parseCatalogFingerprintBackfillResumeRequest,
  type CatalogFingerprintBackfillOperationRequest,
  type CatalogFingerprintBackfillProgress,
  type CatalogFingerprintBackfillRequest,
  type CatalogFingerprintBackfillResumeRequest,
} from "../catalog/fingerprint-backfill.ts";
import {
  parseRelinkApplyRequest,
  parseRelinkCancelRequest,
  parseRelinkPrepareRequest,
  type RelinkApplyRequest,
  type RelinkCancelRequest,
  type RelinkPrepareRequest,
  type RelinkServiceApplyResult,
  type RelinkServiceDraft,
} from "../catalog/relink.ts";
import type {
  ExportDestinationRequest,
  ExportEncodeOptions,
  ExportFinalizeResult,
  ExportFormatDescriptor,
  ExportPixelPayload,
  ExportResult,
} from "../export/desktop-types";
import { parseExportDestinationRequest } from "../export/types";
import type { FormatCapabilityReport } from "../formats/types";
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
} from "../catalog/admin.ts";
import type {
  ExportOptionsSettings,
  ExportOptionsSettingsInput,
} from "../export/desktop-types";
import {
  parseCatalogImportDraftView,
  parseCatalogImportExecutionView,
  parseCatalogImportOperationRequest,
  parseCatalogImportPrepareRequest,
  type CatalogImportDraftView,
  type CatalogImportExecutionView,
  type CatalogImportOperationRequest,
  type CatalogImportPrepareRequest,
} from "../import/api.ts";
import {
  parseAutoImportCancelRequest,
  parseAutoImportConfigureRequest,
  parseAutoImportControlRequest,
  parseAutoImportStatus,
  type AutoImportCancelRequest,
  type AutoImportConfigureRequest,
  type AutoImportControlRequest,
  type AutoImportStatus,
} from "../import/auto-import-api.ts";
import {
  parseMetadataAnalysisOperationRequest,
  parseMetadataAnalysisProgress,
  parseMetadataAnalysisRequest,
  parseMetadataAnalysisResult,
  type MetadataAnalysisOperationRequest,
  type MetadataAnalysisProgress,
  type MetadataAnalysisRequest,
  type MetadataAnalysisResult,
} from "../library/metadata-analysis.ts";
import {
  parseExactDuplicateTrashRequest,
  parseExactDuplicateTrashResult,
  type ExactDuplicateTrashRequest,
  type ExactDuplicateTrashResult,
} from "../library/duplicate-actions.ts";
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
} from "../develop/v3/asset-store.ts";
import {
  parseDevelopHistoryCommitInput,
  parseDevelopHistoryCommitResult,
  parseDevelopHistoryListInput,
  parseDevelopHistoryLoadInput,
  parseDevelopHistoryLoadResult,
  parseDevelopHistoryProjection,
  parseDevelopHistoryProjectionWriteInput,
  parseDevelopHistoryRef,
  parseDevelopHistoryRefMutationInput,
  parseDevelopHistoryRevision,
  parseDevelopHistoryTargetInput,
  type DevelopHistoryCommitInput,
  type DevelopHistoryCommitResult,
  type DevelopHistoryListInput,
  type DevelopHistoryLoadInput,
  type DevelopHistoryLoadResult,
  type DevelopHistoryProjection,
  type DevelopHistoryProjectionWriteInput,
  type DevelopHistoryRef,
  type DevelopHistoryRefMutationInput,
  type DevelopHistoryRevision,
  type DevelopHistoryTargetInput,
} from "../develop/history.ts";
import {
  parseDevelopDefaultRuleDeleteRequest,
  parseDevelopDefaultRuleEnabledRequest,
  parseDevelopDefaultsCancelRequest,
  parseDevelopDefaultsEntryRequest,
  parseDevelopDefaultsInstallRequest,
  parseDevelopDefaultsPreviewRequest,
  parseDevelopDefaultsPreviewResult,
  parseDevelopDefaultsProductionResult,
  type DevelopDefaultRuleDeleteRequest,
  type DevelopDefaultRuleEnabledRequest,
  type DevelopDefaultsCancelRequest,
  type DevelopDefaultsEntryRequest,
  type DevelopDefaultsInstallRequest,
  type DevelopDefaultsPreviewRequest,
  type DevelopDefaultsPreviewResult,
  type DevelopDefaultsProductionResult,
} from "../develop/defaults/api.ts";
import { parseInstalledDevelopDefault, type InstalledDevelopDefault } from "../develop/defaults/installed.ts";
import { parseDevelopDefaultRule, type DevelopDefaultRule } from "../develop/defaults/schema.ts";
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
} from "../develop/v3/job-api.ts";
import {
  parseDevelopJobSnapshot,
  type DevelopJobSnapshot,
  type GenerativeRemoveConsentReceipt,
} from "../develop/v3/jobs.ts";
import {
  parseCameraProfileConflictRequest,
  parseCameraProfileImportResult,
  parseCameraProfileRegistrySnapshot,
  parseCameraProfileRemoveRequest,
  type CameraProfileConflictRequest,
  type CameraProfileImportResult,
  type CameraProfileRegistrySnapshot,
  type CameraProfileRemoveRequest,
} from "../camera-profiles/registry.ts";
import {
  parseDevelopPresetConflictRequest,
  parseDevelopPresetDeleteRequest,
  parseDevelopPresetFavoriteRequest,
  parseDevelopPresetImportResult,
  parseDevelopPresetList,
  parseDevelopPresetSearchRequest,
  type DevelopPresetConflictRequest,
  type DevelopPresetDeleteRequest,
  type DevelopPresetFavoriteRequest,
  type DevelopPresetImportResult,
  type DevelopPresetSearchRequest,
} from "../develop/presets/api.ts";
import {
  parseDevelopPresetRecord,
  type DevelopPresetRecord,
} from "../develop/presets/schema.ts";
import {
  parseDevelopClipboardGroups,
  parseDevelopClipboardPayload,
  parseDevelopClipboardReadResult,
  type DevelopClipboardGroup,
  type DevelopClipboardPayload,
  type DevelopClipboardReadResult,
} from "../develop/clipboard/schema.ts";
import {
  parseDevelopBatchAutoSyncRequest,
  parseDevelopBatchListRequest,
  parseDevelopBatchReceiptList,
  parseDevelopBatchStartRequest,
  parseDevelopBatchTargetRequest,
  parseDevelopBatchUpdate,
  type DevelopBatchAutoSyncRequest,
  type DevelopBatchListRequest,
  type DevelopBatchStartRequest,
  type DevelopBatchTargetRequest,
  type DevelopBatchUpdate,
} from "../develop/batch/api.ts";
import { parseDevelopBatchAutoSyncState, parseDevelopBatchReceipt, type DevelopBatchAutoSyncState, type DevelopBatchReceipt } from "../develop/batch/domain.ts";

const darkroom: DarkroomAPI = {
  isDesktop: true as const,

  catalogBootstrap(): Promise<CatalogBootstrapResult> {
    return desktopTransport.invoke("darkroom:catalog-bootstrap");
  },

  catalogCreate(request: CatalogCreateRequest): Promise<CatalogActivationResult> {
    return desktopTransport.invoke("darkroom:catalog-create", parseCatalogCreateRequest(request));
  },

  catalogOpen(request: CatalogSelectionRequest): Promise<CatalogActivationResult> {
    return desktopTransport.invoke("darkroom:catalog-open", parseCatalogSelectionRequest(request));
  },

  catalogSwitch(request: CatalogSelectionRequest): Promise<CatalogActivationResult> {
    return desktopTransport.invoke("darkroom:catalog-switch", parseCatalogSelectionRequest(request));
  },

  catalogClose(request: CatalogSessionRequest): Promise<void> {
    return desktopTransport.invoke("darkroom:catalog-close", parseCatalogSessionRequest(request));
  },

  catalogAddRoot(request: CatalogSessionRequest): Promise<CatalogRootResult> {
    return desktopTransport.invoke("darkroom:catalog-add-root", parseCatalogSessionRequest(request));
  },

  catalogRelinkRoot(request: CatalogRootRequest): Promise<CatalogActivationResult> {
    return desktopTransport.invoke("darkroom:catalog-relink-root", parseCatalogRootRequest(request));
  },

  catalogRelinkFilesPrepare(request: RelinkPrepareRequest): Promise<RelinkServiceDraft | null> {
    return desktopTransport.invoke(
      "darkroom:catalog-relink-files-prepare",
      parseRelinkPrepareRequest(request),
    );
  },

  catalogRelinkFilesApply(request: RelinkApplyRequest): Promise<RelinkServiceApplyResult> {
    return desktopTransport.invoke(
      "darkroom:catalog-relink-files-apply",
      parseRelinkApplyRequest(request),
    );
  },

  catalogRelinkFilesCancel(request: RelinkCancelRequest): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:catalog-relink-files-cancel",
      parseRelinkCancelRequest(request),
    );
  },

  catalogRemove(request: CatalogRemoveRequest): Promise<void> {
    return desktopTransport.invoke("darkroom:catalog-remove", parseCatalogRemoveRequest(request));
  },

  catalogStartScan(request: CatalogScanRequest): Promise<CatalogOperationResult> {
    return desktopTransport.invoke("darkroom:catalog-start-scan", parseCatalogScanRequest(request));
  },

  catalogCancelScan(request: CatalogOperationRequest): Promise<void> {
    return desktopTransport.invoke("darkroom:catalog-cancel-scan", parseCatalogOperationRequest(request));
  },

  catalogGetOperation(request: CatalogOperationRequest): Promise<LibraryOperationSnapshot> {
    return desktopTransport.invoke("darkroom:catalog-get-operation", parseCatalogOperationRequest(request));
  },

  catalogWaitOperation(request: CatalogOperationRequest): Promise<LibraryOperationSnapshot> {
    return desktopTransport.invoke("darkroom:catalog-wait-operation", parseCatalogOperationRequest(request));
  },

  catalogQuery(request: CatalogQueryRequest): Promise<CatalogLiveStateView> {
    return desktopTransport.invoke("darkroom:catalog-query", parseCatalogQueryRequest(request));
  },

  catalogApply(request: CatalogApplyRequest): Promise<CatalogApplyResult> {
    return desktopTransport.invoke("darkroom:catalog-apply", parseCatalogApplyRequest(request));
  },

  async catalogImportPrepare(request: CatalogImportPrepareRequest): Promise<CatalogImportDraftView> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-import-prepare",
      parseCatalogImportPrepareRequest(request),
    );
    return parseCatalogImportDraftView(result);
  },

  async catalogImportReview(request: CatalogImportOperationRequest): Promise<CatalogImportDraftView> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-import-review",
      parseCatalogImportOperationRequest(request),
    );
    return parseCatalogImportDraftView(result);
  },

  async catalogImportRun(request: CatalogImportOperationRequest): Promise<CatalogImportExecutionView> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-import-run",
      parseCatalogImportOperationRequest(request),
    );
    return parseCatalogImportExecutionView(result);
  },

  catalogImportCancel(request: CatalogImportOperationRequest): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:catalog-import-cancel",
      parseCatalogImportOperationRequest(request),
    );
  },

  async catalogAutoImportConfigure(request: AutoImportConfigureRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-configure",
      parseAutoImportConfigureRequest(request),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportStatus(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-status",
      parseAutoImportControlRequest(request),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportEnable(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-enable",
      parseAutoImportControlRequest({ ...request, action: "enable" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportDisable(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-disable",
      parseAutoImportControlRequest({ ...request, action: "disable" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportPause(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-pause",
      parseAutoImportControlRequest({ ...request, action: "pause" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportResume(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-resume",
      parseAutoImportControlRequest({ ...request, action: "resume" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportRetryFailed(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-retry-failed",
      parseAutoImportControlRequest({ ...request, action: "retry-failed" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportClearFailed(request: AutoImportControlRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-clear-failed",
      parseAutoImportControlRequest({ ...request, action: "clear-failed" }),
    );
    return parseAutoImportStatus(result);
  },

  async catalogAutoImportCancel(request: AutoImportCancelRequest): Promise<AutoImportStatus> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-auto-import-cancel",
      parseAutoImportCancelRequest(request),
    );
    return parseAutoImportStatus(result);
  },

  catalogAutoImportOpenIngress(request: CatalogSessionRequest): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:catalog-auto-import-open-ingress",
      parseCatalogSessionRequest(request),
    );
  },

  catalogReadAsset(request: CatalogAssetRequest): Promise<ArrayBuffer> {
    return desktopTransport.invoke("darkroom:catalog-read-asset", parseCatalogAssetRequest(request));
  },

  async developAssetPut(
    request: DevelopAssetPutRequest,
  ): Promise<DevelopAssetPutResult> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-asset-put",
      parseDevelopAssetPutRequest(request),
    );
    return parseDevelopAssetPutResult(result);
  },

  async developAssetTransition(
    request: DevelopAssetTransitionRequest,
  ): Promise<DevelopAssetTransitionResult> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-asset-transition",
      parseDevelopAssetTransitionRequest(request),
    );
    return parseDevelopAssetTransitionResult(result);
  },

  async developAssetRead(
    request: DevelopAssetReadRequest,
  ): Promise<DevelopAssetReadResult> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-asset-read",
      parseDevelopAssetReadRequest(request),
    );
    return parseDevelopAssetReadResult(result);
  },

  async developHistoryLoad(input: DevelopHistoryLoadInput): Promise<DevelopHistoryLoadResult> {
    return parseDevelopHistoryLoadResult(await desktopTransport.invoke(
      "darkroom:develop-history-load",
      parseDevelopHistoryLoadInput(input),
    ));
  },

  async developHistoryList(input: DevelopHistoryListInput): Promise<readonly DevelopHistoryRevision[]> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-history-list", parseDevelopHistoryListInput(input));
    if (!Array.isArray(result)) throw new Error("Develop history list response is invalid.");
    return result.map(parseDevelopHistoryRevision);
  },

  async developHistoryCommit(input: DevelopHistoryCommitInput): Promise<DevelopHistoryCommitResult> {
    return parseDevelopHistoryCommitResult(await desktopTransport.invoke(
      "darkroom:develop-history-commit",
      parseDevelopHistoryCommitInput(input),
    ));
  },

  async developHistoryRefs(input: DevelopHistoryTargetInput): Promise<readonly DevelopHistoryRef[]> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-history-refs", parseDevelopHistoryTargetInput(input));
    if (!Array.isArray(result)) throw new Error("Develop history refs response is invalid.");
    return result.map(parseDevelopHistoryRef);
  },

  async developHistoryRefMutate(input: DevelopHistoryRefMutationInput): Promise<readonly DevelopHistoryRef[]> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-history-ref-mutate", parseDevelopHistoryRefMutationInput(input));
    if (!Array.isArray(result)) throw new Error("Develop history refs response is invalid.");
    return result.map(parseDevelopHistoryRef);
  },

  async developHistoryProjection(input: DevelopHistoryTargetInput): Promise<DevelopHistoryProjection | null> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-history-projection-get", parseDevelopHistoryTargetInput(input));
    return result === null ? null : parseDevelopHistoryProjection(result);
  },

  async developHistoryRecordProjection(input: DevelopHistoryProjectionWriteInput): Promise<DevelopHistoryProjection> {
    return parseDevelopHistoryProjection(await desktopTransport.invoke(
      "darkroom:develop-history-projection-set",
      parseDevelopHistoryProjectionWriteInput(input),
    ));
  },

  async developDefaultsList(): Promise<readonly DevelopDefaultRule[]> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-defaults-list");
    if (!Array.isArray(result)) throw new Error("Develop defaults list response is invalid.");
    return result.map(parseDevelopDefaultRule);
  },

  async developDefaultsReferencedPresets(): Promise<readonly DevelopPresetRecord[]> {
    return parseDevelopPresetList(await desktopTransport.invoke("darkroom:develop-defaults-referenced-presets"));
  },

  async developDefaultsCreate(rule: DevelopDefaultRule): Promise<DevelopDefaultRule> {
    return parseDevelopDefaultRule(await desktopTransport.invoke("darkroom:develop-defaults-create", parseDevelopDefaultRule(rule)));
  },

  async developDefaultsUpdate(rule: DevelopDefaultRule): Promise<DevelopDefaultRule> {
    return parseDevelopDefaultRule(await desktopTransport.invoke("darkroom:develop-defaults-update", parseDevelopDefaultRule(rule)));
  },

  async developDefaultsSetEnabled(request: DevelopDefaultRuleEnabledRequest): Promise<DevelopDefaultRule> {
    return parseDevelopDefaultRule(await desktopTransport.invoke("darkroom:develop-defaults-enabled", parseDevelopDefaultRuleEnabledRequest(request)));
  },

  async developDefaultsDelete(request: DevelopDefaultRuleDeleteRequest): Promise<void> {
    await desktopTransport.invoke("darkroom:develop-defaults-delete", parseDevelopDefaultRuleDeleteRequest(request));
  },

  async developDefaultsPreview(request: DevelopDefaultsPreviewRequest): Promise<DevelopDefaultsPreviewResult> {
    return parseDevelopDefaultsPreviewResult(await desktopTransport.invoke("darkroom:develop-defaults-preview", parseDevelopDefaultsPreviewRequest(request)));
  },

  async developDefaultsInstalled(request: DevelopDefaultsEntryRequest): Promise<InstalledDevelopDefault | null> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-defaults-installed", parseDevelopDefaultsEntryRequest(request));
    return result === null ? null : parseInstalledDevelopDefault(result);
  },

  async developDefaultsInstall(request: DevelopDefaultsInstallRequest): Promise<DevelopDefaultsProductionResult> {
    return parseDevelopDefaultsProductionResult(await desktopTransport.invoke("darkroom:develop-defaults-install", parseDevelopDefaultsInstallRequest(request)));
  },

  async developDefaultsCancel(request: DevelopDefaultsCancelRequest): Promise<void> {
    await desktopTransport.invoke("darkroom:develop-defaults-cancel", parseDevelopDefaultsCancelRequest(request));
  },

  async cameraProfilesList(): Promise<CameraProfileRegistrySnapshot> {
    const result: unknown = await desktopTransport.invoke("darkroom:camera-profiles-list");
    return parseCameraProfileRegistrySnapshot(result);
  },

  async cameraProfilesImport(): Promise<CameraProfileImportResult> {
    const result: unknown = await desktopTransport.invoke("darkroom:camera-profiles-import");
    return parseCameraProfileImportResult(result);
  },

  async cameraProfilesResolveConflict(
    request: CameraProfileConflictRequest,
  ): Promise<CameraProfileImportResult> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:camera-profiles-resolve-conflict",
      parseCameraProfileConflictRequest(request),
    );
    return parseCameraProfileImportResult(result);
  },

  async cameraProfilesRescan(): Promise<CameraProfileRegistrySnapshot> {
    const result: unknown = await desktopTransport.invoke("darkroom:camera-profiles-rescan");
    return parseCameraProfileRegistrySnapshot(result);
  },

  async cameraProfilesRemove(
    request: CameraProfileRemoveRequest,
  ): Promise<CameraProfileRegistrySnapshot> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:camera-profiles-remove",
      parseCameraProfileRemoveRequest(request),
    );
    return parseCameraProfileRegistrySnapshot(result);
  },

  async developPresetsList(
    request: DevelopPresetSearchRequest,
  ): Promise<readonly DevelopPresetRecord[]> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-presets-list",
      parseDevelopPresetSearchRequest(request),
    );
    return parseDevelopPresetList(result);
  },

  async developPresetsCreate(
    preset: DevelopPresetRecord,
  ): Promise<DevelopPresetRecord> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-presets-create",
      parseDevelopPresetRecord(preset),
    );
    return parseDevelopPresetRecord(result);
  },

  async developPresetsUpdate(
    preset: DevelopPresetRecord,
  ): Promise<DevelopPresetRecord> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-presets-update",
      parseDevelopPresetRecord(preset),
    );
    return parseDevelopPresetRecord(result);
  },

  async developPresetsFavorite(
    request: DevelopPresetFavoriteRequest,
  ): Promise<DevelopPresetRecord> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-presets-favorite",
      parseDevelopPresetFavoriteRequest(request),
    );
    return parseDevelopPresetRecord(result);
  },

  developPresetsDelete(request: DevelopPresetDeleteRequest): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:develop-presets-delete",
      parseDevelopPresetDeleteRequest(request),
    );
  },

  async developPresetsImport(): Promise<DevelopPresetImportResult> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-presets-import");
    return parseDevelopPresetImportResult(result);
  },

  async developPresetsResolveConflict(
    request: DevelopPresetConflictRequest,
  ): Promise<DevelopPresetImportResult> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-presets-resolve-conflict",
      parseDevelopPresetConflictRequest(request),
    );
    return parseDevelopPresetImportResult(result);
  },

  developClipboardWrite(payload: DevelopClipboardPayload): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:develop-clipboard-write",
      parseDevelopClipboardPayload(payload),
    );
  },

  async developClipboardRead(): Promise<DevelopClipboardReadResult> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-clipboard-read");
    return parseDevelopClipboardReadResult(result);
  },

  async developClipboardGroupsGet(): Promise<readonly DevelopClipboardGroup[]> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-clipboard-groups-get");
    return parseDevelopClipboardGroups(result);
  },

  developClipboardGroupsSet(groups: readonly DevelopClipboardGroup[]): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:develop-clipboard-groups-set",
      parseDevelopClipboardGroups(groups),
    );
  },

  async developBatchList(request: DevelopBatchListRequest): Promise<readonly DevelopBatchReceipt[]> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-batch-list", parseDevelopBatchListRequest(request));
    return parseDevelopBatchReceiptList(result);
  },

  async developBatchStart(request: DevelopBatchStartRequest): Promise<DevelopBatchReceipt> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-batch-start", parseDevelopBatchStartRequest(request));
    return parseDevelopBatchReceipt(result);
  },

  async developBatchCancel(request: DevelopBatchTargetRequest): Promise<DevelopBatchReceipt> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-batch-cancel", parseDevelopBatchTargetRequest(request));
    return parseDevelopBatchReceipt(result);
  },

  async developBatchRetry(request: DevelopBatchTargetRequest): Promise<DevelopBatchReceipt> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-batch-retry", parseDevelopBatchTargetRequest(request));
    return parseDevelopBatchReceipt(result);
  },

  async developBatchUndo(request: DevelopBatchTargetRequest): Promise<DevelopBatchReceipt> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-batch-undo", parseDevelopBatchTargetRequest(request));
    return parseDevelopBatchReceipt(result);
  },

  developBatchAutoEnable(request: DevelopBatchAutoSyncRequest): Promise<void> {
    return desktopTransport.invoke("darkroom:develop-batch-auto-enable", parseDevelopBatchAutoSyncRequest(request));
  },

  developBatchAutoDisable(request: CatalogSessionRequest): Promise<void> {
    return desktopTransport.invoke("darkroom:develop-batch-auto-disable", parseCatalogSessionRequest(request));
  },

  async developBatchAutoState(request: CatalogSessionRequest): Promise<DevelopBatchAutoSyncState> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-batch-auto-state", parseCatalogSessionRequest(request));
    return parseDevelopBatchAutoSyncState(result);
  },

  onDevelopBatchUpdated(listener: (update: DevelopBatchUpdate) => void): () => void {
    if (typeof listener !== "function") throw new Error("Develop batch listener must be a function.");
    const wrapped = (_event: undefined, value: unknown) => {
      try { listener(parseDevelopBatchUpdate(value)); } catch { /* ignore malformed main events */ }
    };
    desktopTransport.on("darkroom:develop-batch-updated", wrapped);
    return () => desktopTransport.removeListener("darkroom:develop-batch-updated", wrapped);
  },

  async developAssetCollectGarbage(
    request: DevelopAssetGcRequest,
  ): Promise<DevelopAssetGcResult> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-asset-gc",
      parseDevelopAssetGcRequest(request),
    );
    return parseDevelopAssetGcResult(result);
  },

  async developJobsList(): Promise<readonly DevelopJobSnapshot[]> {
    const result: unknown = await desktopTransport.invoke("darkroom:develop-jobs-list");
    return parseDevelopJobSnapshotList(result);
  },

  async developJobsStart(request: DevelopJobStartRequest): Promise<DevelopJobSnapshot> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-jobs-start",
      parseDevelopJobStartRequest(request),
    );
    return parseDevelopJobSnapshot(result);
  },

  async developJobsCancel(request: DevelopJobTargetRequest): Promise<DevelopJobSnapshot> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-jobs-cancel",
      parseDevelopJobTargetRequest(request),
    );
    return parseDevelopJobSnapshot(result);
  },

  async developJobsRetry(request: DevelopJobRetryRequest): Promise<DevelopJobSnapshot> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-jobs-retry",
      parseDevelopJobRetryRequest(request),
    );
    return parseDevelopJobSnapshot(result);
  },

  async developJobsDiscard(request: DevelopJobTargetRequest): Promise<void> {
    await desktopTransport.invoke(
      "darkroom:develop-jobs-discard",
      parseDevelopJobTargetRequest(request),
    );
  },

  async developJobsAccept(
    request: DevelopJobAcceptRequest,
  ): Promise<DevelopJobAcceptanceResult> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-jobs-accept",
      parseDevelopJobAcceptRequest(request),
    );
    return parseDevelopJobAcceptanceResult(result);
  },

  async developJobsGrantGenerativeRemoveConsent(
    request: GenerativeRemoveConsentGrantRequest,
  ): Promise<GenerativeRemoveConsentReceipt> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-jobs-consent-grant",
      parseGenerativeRemoveConsentGrantRequest(request),
    );
    return parseGenerativeRemoveConsentResult(result);
  },

  async developJobsRevokeGenerativeRemoveConsent(
    request: GenerativeRemoveConsentRevokeRequest,
  ): Promise<GenerativeRemoveConsentReceipt> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:develop-jobs-consent-revoke",
      parseGenerativeRemoveConsentRevokeRequest(request),
    );
    return parseGenerativeRemoveConsentResult(result);
  },

  onDevelopJobsUpdated(listener: DevelopJobListener): () => void {
    if (typeof listener !== "function") {
      throw new Error("Develop job listener must be a function.");
    }
    const wrapped = (_event: undefined, value: unknown) => {
      try {
        listener(parseDevelopJobSnapshotList(value));
      } catch {
        // Malformed or stale main-process events are ignored at the renderer boundary.
      }
    };
    desktopTransport.on("darkroom:develop-jobs-updated", wrapped);
    return () => desktopTransport.removeListener("darkroom:develop-jobs-updated", wrapped);
  },

  catalogReadAssetHead(request: CatalogAssetHeadRequest): Promise<ArrayBuffer> {
    return desktopTransport.invoke("darkroom:catalog-read-asset-head", parseCatalogAssetHeadRequest(request));
  },

  catalogStatAsset(request: CatalogAssetRequest): Promise<{ readonly size: number; readonly lastModified: number }> {
    return desktopTransport.invoke("darkroom:catalog-stat-asset", parseCatalogAssetRequest(request));
  },

  catalogReadSidecar(request: CatalogAssetRequest): Promise<{ readonly contents: string; readonly lastModified: number } | null> {
    return desktopTransport.invoke("darkroom:catalog-read-sidecar", parseCatalogAssetRequest(request));
  },

  catalogWriteSidecar(request: CatalogSidecarWriteRequest): Promise<void> {
    return desktopTransport.invoke("darkroom:catalog-write-sidecar", parseCatalogSidecarWriteRequest(request));
  },

  catalogDecodeAsset(request: CatalogAssetRequest, decode: CatalogDecodeRequest): Promise<CatalogDecodeResult> {
    return desktopTransport.invoke(
      "darkroom:catalog-decode-asset",
      parseCatalogAssetRequest(request),
      parseCatalogDecodeRequest(decode),
    );
  },

  catalogTrashAsset(request: CatalogAssetRequest): Promise<void> {
    return desktopTransport.invoke("darkroom:catalog-trash-asset", parseCatalogAssetRequest(request));
  },

  async catalogTrashExactDuplicates(request: ExactDuplicateTrashRequest): Promise<ExactDuplicateTrashResult> {
    return parseExactDuplicateTrashResult(await desktopTransport.invoke(
      "darkroom:catalog-trash-exact-duplicates",
      parseExactDuplicateTrashRequest(request),
    ));
  },

  async catalogAnalyzeMetadata(request: MetadataAnalysisRequest): Promise<MetadataAnalysisResult> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-analyze-metadata",
      parseMetadataAnalysisRequest(request),
    );
    return parseMetadataAnalysisResult(result);
  },

  catalogCancelMetadataAnalysis(request: MetadataAnalysisOperationRequest): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:catalog-cancel-metadata-analysis",
      parseMetadataAnalysisOperationRequest(request),
    );
  },

  onCatalogMetadataAnalysisProgress(
    listener: (progress: MetadataAnalysisProgress) => void,
  ): Unsubscribe {
    if (typeof listener !== "function") throw new Error("Metadata progress listener must be a function.");
    const wrapped = (_event: undefined, value: unknown) => {
      try {
        listener(parseMetadataAnalysisProgress(value));
      } catch {
        // Malformed or stale progress is ignored at the renderer boundary.
      }
    };
    desktopTransport.on("darkroom:catalog-metadata-analysis-progress", wrapped);
    return () => desktopTransport.removeListener("darkroom:catalog-metadata-analysis-progress", wrapped);
  },

  onCatalogEvent(listener: (event: CatalogEvent) => void): Unsubscribe {
    if (typeof listener !== "function") throw new Error("Catalog event listener must be a function.");
    const wrapped = (_event: undefined, value: unknown) => {
      try {
        listener(parseCatalogEvent(value));
      } catch {
        // Malformed or stale main-process events are ignored at the renderer boundary.
      }
    };
    desktopTransport.on("darkroom:catalog-event", wrapped);
    return () => desktopTransport.removeListener("darkroom:catalog-event", wrapped);
  },

  getFormatCapabilityReport(): Promise<FormatCapabilityReport> {
    return desktopTransport.invoke("darkroom:get-format-capability-report");
  },

  async catalogFingerprintStatus(
    request: CatalogFingerprintBackfillRequest,
  ): Promise<CatalogFingerprintBackfillProgress | null> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-fingerprint-status",
      parseCatalogFingerprintBackfillRequest(request),
    );
    return result === null ? null : parseCatalogFingerprintBackfillProgress(result);
  },

  async catalogFingerprintStart(
    request: CatalogFingerprintBackfillRequest,
  ): Promise<CatalogFingerprintBackfillProgress> {
    return parseCatalogFingerprintBackfillProgress(await desktopTransport.invoke(
      "darkroom:catalog-fingerprint-start",
      parseCatalogFingerprintBackfillRequest(request),
    ));
  },

  async catalogFingerprintResume(
    request: CatalogFingerprintBackfillResumeRequest,
  ): Promise<CatalogFingerprintBackfillProgress> {
    return parseCatalogFingerprintBackfillProgress(await desktopTransport.invoke(
      "darkroom:catalog-fingerprint-resume",
      parseCatalogFingerprintBackfillResumeRequest(request),
    ));
  },

  async catalogFingerprintRecover(
    request: CatalogFingerprintBackfillRequest,
  ): Promise<CatalogFingerprintBackfillProgress | null> {
    const result: unknown = await desktopTransport.invoke(
      "darkroom:catalog-fingerprint-recover",
      parseCatalogFingerprintBackfillRequest(request),
    );
    return result === null ? null : parseCatalogFingerprintBackfillProgress(result);
  },

  catalogFingerprintCancel(request: CatalogFingerprintBackfillOperationRequest): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:catalog-fingerprint-cancel",
      parseCatalogFingerprintBackfillOperationRequest(request),
    );
  },

  onCatalogFingerprintProgress(
    listener: (progress: CatalogFingerprintBackfillProgress) => void,
  ): Unsubscribe {
    if (typeof listener !== "function") throw new Error("Fingerprint progress listener must be a function.");
    const wrapped = (_event: undefined, value: unknown) => {
      try {
        listener(parseCatalogFingerprintBackfillProgress(value));
      } catch {
        // Malformed or stale main-process events are ignored at the renderer boundary.
      }
    };
    desktopTransport.on("darkroom:catalog-fingerprint-progress", wrapped);
    return () => desktopTransport.removeListener("darkroom:catalog-fingerprint-progress", wrapped);
  },

  catalogAdminInspect(request: CatalogAdminSessionRequest): Promise<CatalogAdminInspectReport> {
    return desktopTransport.invoke("darkroom:catalog-admin-inspect", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminBackup(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult> {
    return desktopTransport.invoke("darkroom:catalog-admin-backup", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminExport(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult | null> {
    return desktopTransport.invoke("darkroom:catalog-admin-export", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminValidatePackage(): Promise<CatalogAdminInspectReport | null> {
    return desktopTransport.invoke("darkroom:catalog-admin-validate-package");
  },

  catalogAdminImportAsNew(request: CatalogAdminImportRequest): Promise<CatalogAdminCloneResult | null> {
    return desktopTransport.invoke("darkroom:catalog-admin-import-as-new", parseCatalogAdminImportRequest(request));
  },

  catalogAdminOptimizePreview(request: CatalogAdminSessionRequest): Promise<CatalogAdminOptimizePreview> {
    return desktopTransport.invoke("darkroom:catalog-admin-optimize-preview", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminOptimize(request: CatalogAdminSessionRequest): Promise<CatalogAdminOptimizeResult> {
    return desktopTransport.invoke("darkroom:catalog-admin-optimize", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminGetBackupPolicy(request: CatalogAdminSessionRequest): Promise<CatalogBackupPolicyState> {
    return desktopTransport.invoke("darkroom:catalog-admin-get-backup-policy", parseCatalogAdminSessionRequest(request));
  },

  catalogAdminSetBackupPolicy(request: CatalogAdminPolicyRequest): Promise<CatalogBackupPolicyState> {
    return desktopTransport.invoke("darkroom:catalog-admin-set-backup-policy", parseCatalogAdminPolicyRequest(request));
  },

  catalogAdminRunScheduledBackup(request: CatalogAdminSessionRequest): Promise<CatalogAdminBackupResult | null> {
    return desktopTransport.invoke("darkroom:catalog-admin-run-scheduled-backup", parseCatalogAdminSessionRequest(request));
  },

  getExportFormats(): Promise<ExportFormatDescriptor[]> {
    return desktopTransport.invoke("darkroom:get-export-formats");
  },

  chooseExportDestination(
    request: ExportDestinationRequest,
  ): Promise<{ token: string } | null> {
    return desktopTransport.invoke(
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
    return desktopTransport.invoke(
      "darkroom:encode-and-save-export",
      token,
      basename,
      pixels,
      options,
    );
  },

  finalizeExport(token: string): Promise<ExportFinalizeResult> {
    return desktopTransport.invoke("darkroom:finalize-export", token);
  },

  getExportOptions(): Promise<ExportOptionsSettings> {
    return desktopTransport.invoke("darkroom:get-export-options");
  },

  setExportOptions(options: ExportOptionsSettingsInput): Promise<void> {
    return desktopTransport.invoke("darkroom:set-export-options", options);
  },

  showInFolder(revealToken: string): Promise<void> {
    return desktopTransport.invoke("darkroom:show-in-folder", revealToken);
  },

  getAiModelState(modelId: AiModelId): Promise<AiModelState> {
    return desktopTransport.invoke("darkroom:get-ai-model-state", parseAiModelId(modelId));
  },

  downloadAiModel(modelId: AiModelId): Promise<void> {
    return desktopTransport.invoke("darkroom:download-ai-model", parseAiModelId(modelId));
  },

  cancelAiModelDownload(modelId: AiModelId): Promise<void> {
    return desktopTransport.invoke(
      "darkroom:cancel-ai-model-download",
      parseAiModelId(modelId),
    );
  },

  removeAiModel(modelId: AiModelId): Promise<void> {
    return desktopTransport.invoke("darkroom:remove-ai-model", parseAiModelId(modelId));
  },

  openAiModelLink(modelId: AiModelId, link: AiModelDisclosureLink): Promise<void> {
    return desktopTransport.invoke(
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
    const wrapped = (_event: undefined, value: unknown) => {
      if (isAiModelProgress(value)) {
        listener(value);
      }
    };
    desktopTransport.on("darkroom:ai-model-progress", wrapped);
    return () => {
      desktopTransport.removeListener("darkroom:ai-model-progress", wrapped);
    };
  },
};

export async function initializeDesktopBridge(): Promise<void> {
  if (!isTauri()) return;
  await desktopTransport.initialize();
  window.darkroom = Object.freeze(darkroom);
}
