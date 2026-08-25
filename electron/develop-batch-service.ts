import type { CatalogWorkerClient } from "./catalog-worker-client.ts";
import type { CameraProfileService } from "./camera-profile-service.ts";
import type { DevelopPresetStore } from "./develop-preset-store.ts";
import type { CatalogLiveEntrySnapshot } from "../lib/catalog/live.ts";
import { parseDevelopBatchAutoSyncState, parseDevelopBatchJson, parseDevelopBatchReceipt, createDevelopBatchId, createDevelopBatchOperationId, parseDevelopBatchId, parseDevelopBatchOperationId, type DevelopBatchAutoSyncState, type DevelopBatchOperation, type DevelopBatchReceipt } from "../lib/develop/batch/domain.ts";
import { parseDevelopBatchReceiptList, type DevelopBatchAutoSyncRequest, type DevelopBatchListRequest, type DevelopBatchStartRequest, type DevelopBatchTargetRequest } from "../lib/develop/batch/api.ts";
import type { DevelopHistoryCommitInput, DevelopHistoryCommitResult } from "../lib/develop/history.ts";
import { parseV3DevelopDocument } from "../lib/develop/v3/codec.ts";
import { captureDevelopPresetPayload, type DevelopPresetCameraProfileContext } from "../lib/develop/presets/apply.ts";
import { cameraProfileIsCompatible } from "../lib/camera-profiles/matrix.ts";
import { persistedInputProfileFromMatrix } from "../lib/develop/v3/profiles.ts";
import type { DevelopClipboardReadResult } from "../lib/develop/clipboard/schema.ts";
import type { EntryId } from "../lib/catalog/ids.ts";

interface DevelopBatchServiceOptions {
  readonly worker: CatalogWorkerClient;
  readonly cameraProfiles: CameraProfileService;
  readonly presets: DevelopPresetStore;
  readonly verifyBinding: (catalogId: DevelopBatchListRequest["catalogId"], sessionId: DevelopBatchListRequest["sessionId"]) => void;
  readonly verifySession: (catalogId: DevelopBatchListRequest["catalogId"], sessionId: DevelopBatchListRequest["sessionId"]) => Promise<{ readonly assets: readonly CatalogLiveEntrySnapshot[] }>;
  readonly readClipboard: () => DevelopClipboardReadResult;
  readonly onUpdate: (catalogId: DevelopBatchListRequest["catalogId"], receipts: readonly DevelopBatchReceipt[]) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Develop batch failed.";
}

function usesCameraProfile(action: Exclude<DevelopBatchOperation, { readonly kind: "undo" | "frozen" }>): boolean {
  if (action.kind === "selected-control") return action.field === "camera-profile";
  if (action.kind === "preset") return action.fields === null || action.fields.includes("camera-profile");
  return action.fields.includes("camera-profile");
}

export class DevelopBatchService {
  readonly #options: DevelopBatchServiceOptions;

  constructor(options: DevelopBatchServiceOptions) {
    this.#options = options;
  }

  async list(request: DevelopBatchListRequest): Promise<readonly DevelopBatchReceipt[]> {
    this.#options.verifyBinding(request.catalogId, request.sessionId);
    const result = await this.#options.worker.developBatch({ kind: "list", catalogId: request.catalogId, limit: request.limit });
    return parseDevelopBatchReceiptList(result);
  }

  async start(request: DevelopBatchStartRequest): Promise<DevelopBatchReceipt> {
    const state = await this.#options.verifySession(request.catalogId, request.sessionId);
    const active = new Map(state.assets.flatMap((entry) => entry.entryId && entry.sourceId ? [[entry.entryId, entry] as const] : []));
    const requireEntries = (entryIds: readonly EntryId[]): void => {
      if (new Set(entryIds).size !== entryIds.length) throw new Error("Develop batch entries contain duplicates.");
      if (entryIds.some((entryId) => !active.has(entryId))) throw new Error("Develop batch contains an inactive or tombstoned entry.");
    };
    const batchId = createDevelopBatchId();
    const operationId = createDevelopBatchOperationId();
    const createdAt = Date.now();
    let receipt: DevelopBatchReceipt;
    if (request.kind === "previous") {
      requireEntries([request.currentEntryId]);
      const operation = await this.#freezeOperation(active, [request.currentEntryId], { kind: "copy-fields", fields: request.fields });
      await this.#verifyStillActive(request, active, [request.currentEntryId]);
      receipt = this.#receipt(await this.#options.worker.developBatch({ kind: "previous-frozen", catalogId: request.catalogId, batchId, operationId, currentEntryId: request.currentEntryId, operation, createdAt }));
    } else if (request.kind === "sync") {
      requireEntries([request.sourceEntryId, ...request.targetEntryIds]);
      if (request.targetEntryIds.includes(request.sourceEntryId)) throw new Error("Sync source cannot also be a target.");
      const operation = await this.#freezeOperation(active, request.targetEntryIds, { kind: "copy-fields", fields: request.fields });
      await this.#verifyStillActive(request, active, [request.sourceEntryId, ...request.targetEntryIds]);
      receipt = this.#receipt(await this.#options.worker.developBatch({ kind: "freeze", catalogId: request.catalogId, batchId, operationId, batchKind: "sync", sourceEntryId: request.sourceEntryId, targetEntryIds: request.targetEntryIds, operation, createdAt }));
    } else {
      requireEntries([request.sourceEntryId]);
      requireEntries(request.targetEntryIds);
      const sourceId = active.get(request.sourceEntryId)?.sourceId;
      if (!sourceId) throw new Error("Batch Develop source is inactive.");
      const action = await this.#selectedAction(request, sourceId);
      const operation = await this.#freezeOperation(active, request.targetEntryIds, action);
      await this.#verifyStillActive(request, active, [request.sourceEntryId, ...request.targetEntryIds]);
      receipt = this.#receipt(await this.#options.worker.developBatch({ kind: "freeze", catalogId: request.catalogId, batchId, operationId, batchKind: "batch", sourceEntryId: null, targetEntryIds: request.targetEntryIds, operation, createdAt }));
    }
    this.#run(receipt);
    return receipt;
  }

  async cancel(request: DevelopBatchTargetRequest): Promise<DevelopBatchReceipt> {
    this.#options.verifyBinding(request.catalogId, request.sessionId);
    return this.#receipt(await this.#options.worker.developBatch({ kind: "cancel", catalogId: request.catalogId, batchId: request.batchId }));
  }

  async retry(request: DevelopBatchTargetRequest): Promise<DevelopBatchReceipt> {
    await this.#options.verifySession(request.catalogId, request.sessionId);
    const receipt = this.#receipt(await this.#options.worker.developBatch({ kind: "retry", catalogId: request.catalogId, batchId: request.batchId }));
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
    const operation = await this.#freezeOperation(active, request.targetEntryIds, { kind: "copy-fields", fields: request.fields });
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
    } catch (error) {
      if (!message(error).includes("Auto Sync is not enabled") && !message(error).includes("already emitted")) throw error;
    }
  }

  async #selectedAction(request: Extract<DevelopBatchStartRequest, { readonly kind: "batch" }>, sourceId: NonNullable<CatalogLiveEntrySnapshot["sourceId"]>): Promise<Exclude<DevelopBatchOperation, { readonly kind: "undo" | "frozen" }>> {
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
    const payloadEntry = captureDevelopPresetPayload(document, [selected.field], sourceId)[0];
    if (!payloadEntry) throw new Error("The selected control is unavailable.");
    return { kind: "selected-control", field: selected.field, payloadEntry: parseDevelopBatchJson(payloadEntry) };
  }

  async #freezeOperation(
    active: ReadonlyMap<EntryId, CatalogLiveEntrySnapshot>,
    targetEntryIds: readonly EntryId[],
    action: Exclude<DevelopBatchOperation, { readonly kind: "undo" | "frozen" }>,
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
    const registry = this.#options.cameraProfiles.list();
    const profileContexts = await Promise.all(targetEntryIds.map(async (entryId) => {
      const entry = active.get(entryId);
      if (!entry?.sourceId) throw new Error("Develop batch target is inactive.");
      const loaded = await this.#options.worker.loadDevelopHistory({ catalogId: entry.catalogId, entryId, revisionId: null });
      if (loaded.kind !== "loaded") throw new Error("Develop batch target needs history recovery.");
      const document = parseV3DevelopDocument(loaded.value.document);
      let context: DevelopPresetCameraProfileContext;
      if (entry.formatId !== "nef" || !entry.cameraMake || !entry.cameraModel || document.color.inputProfile.registryRevision !== registry.revision) {
        context = { kind: "unavailable", reason: "The target has no verified before-tone camera-profile stage." };
      } else {
        const camera = { make: entry.cameraMake, model: entry.cameraModel };
        const current = document.color.inputProfile;
        context = {
          kind: "available-before-tone",
          decoderDefault: current.selection.kind === "decoder-default"
            ? current
            : { ...current, selection: { kind: "unavailable", reason: "Decoder-default calibration is not frozen for this target." } },
          compatibleProfiles: registry.profiles.flatMap((record) => record.kind === "ready" && cameraProfileIsCompatible(record.profile, camera)
            ? [persistedInputProfileFromMatrix(record.profile, registry.revision)]
            : []),
        };
      }
      return { entryId, context };
    }));
    return { kind: "frozen", action, profileContexts };
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
