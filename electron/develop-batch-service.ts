import type { CatalogWorkerClient } from "./catalog-worker-client.ts";
import type { CameraProfileService } from "./camera-profile-service.ts";
import type { DevelopPresetStore } from "./develop-preset-store.ts";
import type { CatalogLiveEntrySnapshot } from "../lib/catalog/live.ts";
import { developBatchPreparationIsPending, parseDevelopBatchAutoSyncState, parseDevelopBatchJson, parseDevelopBatchReceipt, createDevelopBatchId, createDevelopBatchOperationId, parseDevelopBatchId, parseDevelopBatchOperationId, type DevelopBatchAutoSyncState, type DevelopBatchOperation, type DevelopBatchReceipt } from "../lib/develop/batch/domain.ts";
import { parseDevelopBatchReceiptList, type DevelopBatchAutoSyncRequest, type DevelopBatchListRequest, type DevelopBatchStartRequest, type DevelopBatchTargetRequest } from "../lib/develop/batch/api.ts";
import type { DevelopHistoryCommitInput, DevelopHistoryCommitResult } from "../lib/develop/history.ts";
import { parseV3DevelopDocument } from "../lib/develop/v3/codec.ts";
import type { DevelopPresetCameraProfileContext } from "../lib/develop/presets/apply.ts";
import { cameraProfileIsCompatible } from "../lib/camera-profiles/matrix.ts";
import { persistedInputProfileFromMatrix } from "../lib/develop/v3/profiles.ts";
import type { PersistedInputProfile } from "../lib/develop/v3/document.ts";
import { parseDevelopPresetPayload, parseDevelopPresetRecord } from "../lib/develop/presets/schema.ts";
import type { DevelopClipboardReadResult } from "../lib/develop/clipboard/schema.ts";
import type { EntryId } from "../lib/catalog/ids.ts";
import { captureDevelopBatchControl } from "./develop-batch-executor.ts";

interface DevelopBatchServiceOptions {
  readonly worker: CatalogWorkerClient;
  readonly cameraProfiles: CameraProfileService;
  readonly presets: DevelopPresetStore;
  readonly verifyBinding: (catalogId: DevelopBatchListRequest["catalogId"], sessionId: DevelopBatchListRequest["sessionId"]) => void;
  readonly verifySession: (catalogId: DevelopBatchListRequest["catalogId"], sessionId: DevelopBatchListRequest["sessionId"]) => Promise<{ readonly assets: readonly CatalogLiveEntrySnapshot[] }>;
  readonly readClipboard: () => DevelopClipboardReadResult;
  readonly resolveDecoderDefault: (entry: CatalogLiveEntrySnapshot) => Promise<PersistedInputProfile | null>;
  readonly onUpdate: (catalogId: DevelopBatchListRequest["catalogId"], receipts: readonly DevelopBatchReceipt[]) => void;
}

interface DevelopBatchPreparationLifecycle {
  cancelRequested: boolean;
  persisted: boolean;
  readonly waitForPersistence: Promise<void>;
  readonly releasePersistence: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Develop batch failed.";
}

function usesCameraProfile(action: Exclude<DevelopBatchOperation, { readonly kind: "undo" | "frozen" }>): boolean {
  if (action.kind === "selected-control") return false;
  if (action.kind === "preset") return action.fields === null || action.fields.includes("camera-profile");
  return action.fields.includes("camera-profile");
}

export class DevelopBatchService {
  readonly #options: DevelopBatchServiceOptions;
  readonly #preparations = new Map<DevelopBatchReceipt["batchId"], DevelopBatchPreparationLifecycle>();

  constructor(options: DevelopBatchServiceOptions) {
    this.#options = options;
  }

  async list(request: DevelopBatchListRequest): Promise<readonly DevelopBatchReceipt[]> {
    this.#options.verifyBinding(request.catalogId, request.sessionId);
    const result = await this.#options.worker.developBatch({ kind: "list", catalogId: request.catalogId, limit: request.limit });
    return parseDevelopBatchReceiptList(result);
  }

  async start(request: DevelopBatchStartRequest): Promise<DevelopBatchReceipt> {
    let releasePersistence = (): void => undefined;
    const waitForPersistence = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const lifecycle = { cancelRequested: false, persisted: false, waitForPersistence, releasePersistence };
    if (this.#preparations.has(request.batchId)) throw new Error("Develop batch preparation is already active.");
    this.#preparations.set(request.batchId, lifecycle);
    try {
      return await this.#start(request);
    } finally {
      if (!lifecycle.persisted) lifecycle.releasePersistence();
      this.#preparations.delete(request.batchId);
    }
  }

  async #start(request: DevelopBatchStartRequest): Promise<DevelopBatchReceipt> {
    const state = await this.#options.verifySession(request.catalogId, request.sessionId);
    const active = new Map(state.assets.flatMap((entry) => entry.entryId && entry.sourceId ? [[entry.entryId, entry] as const] : []));
    const requireEntries = (entryIds: readonly EntryId[]): void => {
      if (new Set(entryIds).size !== entryIds.length) throw new Error("Develop batch entries contain duplicates.");
      if (entryIds.some((entryId) => !active.has(entryId))) throw new Error("Develop batch contains an inactive or tombstoned entry.");
    };
    const batchId = request.batchId;
    const operationId = request.operationId;
    const createdAt = Date.now();
    let receipt: DevelopBatchReceipt;
    if (request.kind === "previous") {
      requireEntries([request.currentEntryId]);
      if (request.fields.includes("camera-profile")) {
        receipt = await this.#persistedReceipt(this.#options.worker.developBatch({ kind: "previous-prepare", catalogId: request.catalogId, batchId, operationId, currentEntryId: request.currentEntryId, fields: request.fields, createdAt }), batchId);
        return this.#resumePreparation(request, active, receipt);
      }
      const operation = await this.#freezeOperation(active, [request.currentEntryId], { kind: "copy-fields", fields: request.fields });
      await this.#verifyStillActive(request, active, [request.currentEntryId]);
      receipt = await this.#persistedReceipt(this.#options.worker.developBatch({ kind: "previous-frozen", catalogId: request.catalogId, batchId, operationId, currentEntryId: request.currentEntryId, operation, createdAt }), batchId);
    } else if (request.kind === "sync") {
      requireEntries([request.sourceEntryId, ...request.targetEntryIds]);
      if (request.targetEntryIds.includes(request.sourceEntryId)) throw new Error("Sync source cannot also be a target.");
      if (request.fields.includes("camera-profile")) {
        receipt = await this.#persistedReceipt(this.#options.worker.developBatch({ kind: "prepare", catalogId: request.catalogId, batchId, operationId, batchKind: "sync", sourceEntryId: request.sourceEntryId, targetEntryIds: request.targetEntryIds, action: { kind: "copy-fields", fields: request.fields }, createdAt }), batchId);
        return this.#resumePreparation(request, active, receipt);
      }
      const sourceProfile = request.fields.includes("camera-profile") ? await this.#entryProfile(request.catalogId, request.sourceEntryId) : null;
      const operation = await this.#freezeOperation(active, request.targetEntryIds, { kind: "copy-fields", fields: request.fields }, sourceProfile);
      await this.#verifyStillActive(request, active, [request.sourceEntryId, ...request.targetEntryIds]);
      receipt = await this.#persistedReceipt(this.#options.worker.developBatch({ kind: "freeze", catalogId: request.catalogId, batchId, operationId, batchKind: "sync", sourceEntryId: request.sourceEntryId, targetEntryIds: request.targetEntryIds, operation, createdAt }), batchId);
    } else {
      requireEntries([request.sourceEntryId]);
      requireEntries(request.targetEntryIds);
      const action = await this.#selectedAction(request);
      if (usesCameraProfile(action)) {
        receipt = await this.#persistedReceipt(this.#options.worker.developBatch({ kind: "prepare", catalogId: request.catalogId, batchId, operationId, batchKind: "batch", sourceEntryId: null, targetEntryIds: request.targetEntryIds, action, createdAt }), batchId);
        return this.#resumePreparation(request, active, receipt);
      }
      const operation = await this.#freezeOperation(active, request.targetEntryIds, action, this.#operationProfile(action));
      await this.#verifyStillActive(request, active, [request.sourceEntryId, ...request.targetEntryIds]);
      receipt = await this.#persistedReceipt(this.#options.worker.developBatch({ kind: "freeze", catalogId: request.catalogId, batchId, operationId, batchKind: "batch", sourceEntryId: null, targetEntryIds: request.targetEntryIds, operation, createdAt }), batchId);
    }
    if (!receipt.cancellationRequested) this.#run(receipt);
    return receipt;
  }

  async cancel(request: DevelopBatchTargetRequest): Promise<DevelopBatchReceipt> {
    this.#options.verifyBinding(request.catalogId, request.sessionId);
    const preparation = this.#preparations.get(request.batchId);
    if (preparation) {
      preparation.cancelRequested = true;
      await preparation.waitForPersistence;
    }
    return this.#receipt(await this.#options.worker.developBatch({ kind: "cancel", catalogId: request.catalogId, batchId: request.batchId }));
  }

  async retry(request: DevelopBatchTargetRequest): Promise<DevelopBatchReceipt> {
    const state = await this.#options.verifySession(request.catalogId, request.sessionId);
    const receipt = this.#receipt(await this.#options.worker.developBatch({ kind: "retry", catalogId: request.catalogId, batchId: request.batchId }));
    if (developBatchPreparationIsPending(receipt.operation)) {
      const active = new Map(state.assets.flatMap((entry) => entry.entryId && entry.sourceId ? [[entry.entryId, entry] as const] : []));
      return this.#resumePreparation(request, active, receipt);
    }
    this.#run(receipt);
    return receipt;
  }

  async undo(request: DevelopBatchTargetRequest): Promise<DevelopBatchReceipt> {
    await this.#options.verifySession(request.catalogId, request.sessionId);
    const receipt = this.#receipt(await this.#options.worker.developBatch({
      kind: "undo", catalogId: request.catalogId, sourceBatchId: request.batchId,
      batchId: createDevelopBatchId(), operationId: createDevelopBatchOperationId(), createdAt: Date.now(),
    }));
    this.#run(receipt);
    return receipt;
  }

  async enableAutoSync(request: DevelopBatchAutoSyncRequest): Promise<void> {
    const state = await this.#options.verifySession(request.catalogId, request.sessionId);
    const active = new Map(state.assets.flatMap((entry) => entry.entryId && entry.sourceId ? [[entry.entryId, entry] as const] : []));
    if (request.targetEntryIds.includes(request.sourceEntryId)) throw new Error("Auto Sync source cannot also be a target.");
    if (!active.has(request.sourceEntryId) || request.targetEntryIds.some((entryId) => !active.has(entryId))) throw new Error("Auto Sync contains an inactive entry.");
    const sourceProfile = request.fields.includes("camera-profile") ? await this.#entryProfile(request.catalogId, request.sourceEntryId) : null;
    const operation = await this.#freezeOperation(active, request.targetEntryIds, { kind: "copy-fields", fields: request.fields }, sourceProfile);
    await this.#verifyStillActive(request, active, [request.sourceEntryId, ...request.targetEntryIds]);
    await this.#options.worker.developBatch({ kind: "auto-enable-frozen", catalogId: request.catalogId, sourceEntryId: request.sourceEntryId, targetEntryIds: request.targetEntryIds, operation, updatedAt: Date.now() });
  }

  async disableAutoSync(request: Omit<DevelopBatchAutoSyncRequest, "sourceEntryId" | "targetEntryIds" | "fields">): Promise<void> {
    await this.#options.verifySession(request.catalogId, request.sessionId);
    await this.#options.worker.developBatch({ kind: "auto-disable", catalogId: request.catalogId, updatedAt: Date.now() });
  }

  async autoSyncState(request: Omit<DevelopBatchAutoSyncRequest, "sourceEntryId" | "targetEntryIds" | "fields">): Promise<DevelopBatchAutoSyncState> {
    this.#options.verifyBinding(request.catalogId, request.sessionId);
    return parseDevelopBatchAutoSyncState(await this.#options.worker.developBatch({ kind: "auto-get", catalogId: request.catalogId }));
  }

  async historyCommitted(input: DevelopHistoryCommitInput, result: DevelopHistoryCommitResult): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const state = parseDevelopBatchAutoSyncState(await this.#options.worker.developBatch({
          kind: "auto-get",
          catalogId: input.catalogId,
        }));
        if (!state.enabled || state.sourceEntryId !== input.entryId) return;
        const receipt = this.#receipt(await this.#options.worker.developBatch({
          kind: "auto-emit",
          catalogId: input.catalogId,
          batchId: parseDevelopBatchId(result.revision.revisionId),
          operationId: parseDevelopBatchOperationId(input.operationId),
          sourceRevisionId: result.revision.revisionId,
          createdAt: result.revision.createdAt,
        }));
        this.#run(receipt);
        return;
      } catch (error) {
        if (message(error).includes("Auto Sync is not enabled") || message(error).includes("already emitted")) return;
        if (attempt === 2) throw error;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  async #selectedAction(request: Extract<DevelopBatchStartRequest, { readonly kind: "batch" }>): Promise<Exclude<DevelopBatchOperation, { readonly kind: "undo" | "frozen" }>> {
    const selected = request.operation;
    if (selected.kind === "preset") {
      const preset = await this.#options.presets.getRevision(selected.presetId, selected.revision);
      if (!preset) throw new Error("The selected preset revision is unavailable.");
      const fields = selected.fields?.filter((field) => preset.fields.includes(field)) ?? null;
      if (fields?.length === 0) throw new Error("The preset does not contain any selected fields.");
      return { kind: "preset", preset: parseDevelopBatchJson(preset), fields, amount: selected.amount };
    }
    if (selected.kind === "clipboard") {
      const clipboard = this.#options.readClipboard();
      if (clipboard.kind !== "ready") throw new Error(clipboard.kind === "invalid" ? clipboard.reason : "The clipboard has no Develop settings.");
      const available = new Set(clipboard.payload.payload.map((entry) => entry.field));
      if (selected.fields.some((field) => !available.has(field))) throw new Error("The clipboard does not contain every selected field.");
      return { kind: "paste-settings", payload: parseDevelopBatchJson(clipboard.payload.payload), fields: selected.fields };
    }
    if (selected.kind === "section-reset") return selected;
    const loaded = await this.#options.worker.loadDevelopHistory({ catalogId: request.catalogId, entryId: request.sourceEntryId, revisionId: null });
    if (loaded.kind !== "loaded") throw new Error("The selected-control source needs Develop history recovery.");
    const document = parseV3DevelopDocument(loaded.value.document);
    return { kind: "selected-control", control: selected.control, value: captureDevelopBatchControl(document, selected.control) };
  }

  async #freezeOperation(
    active: ReadonlyMap<EntryId, CatalogLiveEntrySnapshot>,
    targetEntryIds: readonly EntryId[],
    action: Exclude<DevelopBatchOperation, { readonly kind: "undo" | "frozen" }>,
    referencedProfile: PersistedInputProfile | null = null,
    preparationBatchId: DevelopBatchReceipt["batchId"] | null = null,
  ): Promise<Extract<DevelopBatchOperation, { readonly kind: "frozen" }>> {
    if (!usesCameraProfile(action)) {
      return {
        kind: "frozen",
        action,
        profileContexts: targetEntryIds.map((entryId) => ({
          entryId,
          context: { kind: "unavailable", reason: "Camera profile was not selected." },
        })),
      };
    }
    if (targetEntryIds.length > 32) throw new Error("Camera-profile batches are limited to 32 targets.");
    const registry = this.#options.cameraProfiles.list();
    const referencedSelection = referencedProfile?.selection;
    const selectedRecord = referencedSelection?.kind === "selected"
      ? registry.profiles.find((record) => record.kind === "ready" && record.profile.id === referencedSelection.profileId && record.profile.revision === referencedSelection.profileRevision)
      : undefined;
    const profileContexts: Extract<DevelopBatchOperation, { readonly kind: "frozen" }>["profileContexts"][number][] = [];
    for (const entryId of targetEntryIds) {
      if (preparationBatchId !== null && await this.#preparationCancelled(active.get(entryId)?.catalogId, preparationBatchId)) break;
      const entry = active.get(entryId);
      if (!entry?.sourceId) throw new Error("Develop batch target is inactive.");
      const loaded = await this.#options.worker.loadDevelopHistory({ catalogId: entry.catalogId, entryId, revisionId: null });
      if (loaded.kind !== "loaded") throw new Error("Develop batch target needs history recovery.");
      const document = parseV3DevelopDocument(loaded.value.document);
      let context: DevelopPresetCameraProfileContext;
      if (entry.formatId !== "nef" || !entry.cameraMake || !entry.cameraModel) {
        context = { kind: "unavailable", reason: "The target has no verified before-tone camera-profile stage." };
      } else {
        const camera = { make: entry.cameraMake, model: entry.cameraModel };
        const current = document.color.inputProfile;
        const decoderDefault = current.selection.kind === "decoder-default" ? current : await this.#options.resolveDecoderDefault(entry);
        context = decoderDefault === null ? { kind: "unavailable", reason: "Decoder-default calibration could not be verified for this target." } : {
          kind: "available-before-tone", decoderDefault,
          compatibleProfiles: selectedRecord?.kind === "ready" && cameraProfileIsCompatible(selectedRecord.profile, camera) ? [persistedInputProfileFromMatrix(selectedRecord.profile, registry.revision)] : [],
        };
      }
      profileContexts.push({ entryId, context });
    }
    if (profileContexts.length !== targetEntryIds.length) throw new Error("Develop batch preparation was cancelled.");
    return { kind: "frozen", action, profileContexts };
  }

  async #entryProfile(catalogId: DevelopBatchListRequest["catalogId"], entryId: EntryId, revisionId: DevelopBatchReceipt["sourceRevisionId"] = null): Promise<PersistedInputProfile> {
    const loaded = await this.#options.worker.loadDevelopHistory({ catalogId, entryId, revisionId });
    if (loaded.kind !== "loaded") throw new Error("Develop batch source needs history recovery.");
    return parseV3DevelopDocument(loaded.value.document).color.inputProfile;
  }

  #operationProfile(action: Exclude<DevelopBatchOperation, { readonly kind: "undo" | "frozen" }>): PersistedInputProfile | null {
    if (action.kind === "preset") return parseDevelopPresetRecord(action.preset).payload.find((entry) => entry.field === "camera-profile")?.value ?? null;
    if (action.kind === "paste-settings") return parseDevelopPresetPayload(action.payload, action.fields).find((entry) => entry.field === "camera-profile")?.value ?? null;
    return null;
  }

  async #preparationCancelled(catalogId: DevelopBatchListRequest["catalogId"] | undefined, batchId: DevelopBatchReceipt["batchId"]): Promise<boolean> {
    if (catalogId === undefined) return true;
    const receipt = this.#receipt(await this.#options.worker.developBatch({ kind: "get", catalogId, batchId }));
    return receipt.cancellationRequested;
  }

  async #resumePreparation(
    request: Pick<DevelopBatchStartRequest | DevelopBatchTargetRequest, "catalogId" | "sessionId">,
    active: ReadonlyMap<EntryId, CatalogLiveEntrySnapshot>,
    receipt: DevelopBatchReceipt,
  ): Promise<DevelopBatchReceipt> {
    if (receipt.cancellationRequested) return receipt;
    if (!developBatchPreparationIsPending(receipt.operation)) {
      if (!receipt.cancellationRequested) this.#run(receipt);
      return receipt;
    }
    if (receipt.operation.kind !== "frozen") throw new Error("Develop batch preparation is invalid.");
    try {
      const action = receipt.operation.action;
      const referencedProfile = action.kind === "copy-fields" && action.fields.includes("camera-profile") && receipt.sourceEntryId !== null && receipt.sourceRevisionId !== null
        ? await this.#entryProfile(receipt.catalogId, receipt.sourceEntryId, receipt.sourceRevisionId)
        : this.#operationProfile(action);
      const operation = await this.#freezeOperation(active, receipt.targetEntryIds, action, referencedProfile, receipt.batchId);
      await this.#verifyStillActive(request, active, receipt.targetEntryIds);
      const completed = this.#receipt(await this.#options.worker.developBatch({ kind: "complete-preparation", catalogId: receipt.catalogId, batchId: receipt.batchId, operation }));
      if (!completed.cancellationRequested) this.#run(completed);
      return completed;
    } catch (error) {
      return this.#receipt(await this.#options.worker.developBatch({
        kind: "fail-preparation",
        catalogId: receipt.catalogId,
        batchId: receipt.batchId,
        error: message(error),
      }));
    }
  }

  async #verifyStillActive(
    request: Pick<DevelopBatchStartRequest, "catalogId" | "sessionId">,
    expected: ReadonlyMap<EntryId, CatalogLiveEntrySnapshot>,
    entryIds: readonly EntryId[],
  ): Promise<void> {
    const state = await this.#options.verifySession(request.catalogId, request.sessionId);
    const active = new Map(state.assets.flatMap((entry) => entry.entryId && entry.sourceId ? [[entry.entryId, entry] as const] : []));
    const changed = entryIds.some((entryId) => {
      const before = expected.get(entryId);
      const after = active.get(entryId);
      return !before || !after || before.sourceId !== after.sourceId || before.assetId !== after.assetId ||
        before.revision !== after.revision || before.formatId !== after.formatId ||
        before.cameraMake !== after.cameraMake || before.cameraModel !== after.cameraModel ||
        before.fingerprintSha256 !== after.fingerprintSha256;
    });
    if (changed) {
      throw new Error("Develop batch entries changed while the operation was prepared.");
    }
  }

  #receipt(result: Awaited<ReturnType<CatalogWorkerClient["developBatch"]>>): DevelopBatchReceipt {
    return parseDevelopBatchReceipt(result);
  }

  async #persistedReceipt(
    result: ReturnType<CatalogWorkerClient["developBatch"]>,
    batchId: DevelopBatchReceipt["batchId"],
  ): Promise<DevelopBatchReceipt> {
    let receipt = this.#receipt(await result);
    const preparation = this.#preparations.get(batchId);
    if (!preparation) return receipt;
    preparation.persisted = true;
    preparation.releasePersistence();
    if (preparation.cancelRequested && !receipt.cancellationRequested) {
      receipt = this.#receipt(await this.#options.worker.developBatch({ kind: "cancel", catalogId: receipt.catalogId, batchId }));
    }
    return receipt;
  }

  #run(receipt: DevelopBatchReceipt): void {
    void this.#options.worker.developBatch({ kind: "run", catalogId: receipt.catalogId, batchId: receipt.batchId }).then(async () => {
      const receipts = await this.listWithoutSession(receipt.catalogId);
      this.#options.onUpdate(receipt.catalogId, receipts);
    }).catch(() => undefined);
  }

  async listWithoutSession(catalogId: DevelopBatchListRequest["catalogId"]): Promise<readonly DevelopBatchReceipt[]> {
    const result = await this.#options.worker.developBatch({ kind: "list", catalogId, limit: 100 });
    return parseDevelopBatchReceiptList(result);
  }
}
