"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AiInferenceError,
  runAiMaskInference,
  type AiInferenceProgress,
} from "@/lib/ai/inference-client";
import type {
  AiModelId,
  AiModelProgress,
  AiModelState,
} from "@/lib/ai/types";
import type { AiInferenceResult } from "@/lib/ai/worker-types";
import {
  MAX_COMPONENTS_PER_MASK,
  MAX_MASKS,
} from "@/lib/develop/document";
import { COORDINATE_FRAME_REVISION, type V3SourceSignature } from "@/lib/develop/process";
import { parseSha256Digest } from "@/lib/develop/render-contract";
import {
  sourceSignatureKey,
  sourceSignaturesEqual,
} from "@/lib/develop/source-transform";
import type {
  DevelopAssetCandidate,
  DevelopAssetRef,
} from "@/lib/develop/v3/assets";
import type {
  DevelopDocumentV3,
  PersistedLocalEdits,
} from "@/lib/develop/v3/document";
import { createDefaultLocalAdjustments } from "@/lib/develop/v3/local-adjustments";
import {
  appendMaskSource,
  findMaskNode,
  maskSourceNodes,
  referencedMaskArtifacts,
  replaceMaskNode,
  type LocalMaskV3,
  type MaskSourceNode,
} from "@/lib/develop/v3/masking";
import type { LibraryEntry } from "@/lib/fs/types";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import { ActionButton, StatusCard } from "@/components/develop/V3PanelControls";
import { useDevelopStore } from "@/stores/develop-store";
import { useLibraryStore } from "@/stores/library-store";

interface AiMaskActionsProps {
  readonly entry: LibraryEntry;
  readonly document: DevelopDocumentV3;
}

type AiTarget = {
  readonly maskId: string;
  readonly componentId: string;
};

type AiRequest = {
  readonly modelId: AiModelId;
  readonly maskId: string | null;
  readonly target: AiTarget | null;
  readonly forceWasm: boolean;
};

type AiJob =
  | {
      readonly kind: "downloading";
      readonly modelId: AiModelId;
      readonly receivedBytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly kind: "inferring";
      readonly modelId: AiModelId;
      readonly stage: AiInferenceProgress["stage"];
      readonly progress: number;
      readonly forceWasm: boolean;
    };

type ActiveJob = {
  readonly token: string;
  readonly controller: AbortController;
  readonly modelId: AiModelId;
  readonly downloading: boolean;
};

interface StagedMaskAsset {
  readonly candidate: DevelopAssetCandidate;
  readonly reference: DevelopAssetRef;
  readonly nowMs: number;
  readonly recoveryUntilMs: number;
}

interface PreparedMaskUpdate {
  readonly local: PersistedLocalEdits;
  readonly maskId: string;
  readonly componentId: string;
}

interface CurrentDocument {
  readonly document: DevelopDocumentV3;
  readonly revision: number;
}

const MODEL_IDS: readonly AiModelId[] = ["subject", "sky"];
const MODEL_LABELS: Record<AiModelId, string> = {
  subject: "Subject",
  sky: "Sky",
};
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;

function sourceSignatureForEntry(entry: LibraryEntry): V3SourceSignature {
  return {
    entryId: entry.id,
    catalogId: entry.catalogId,
    assetRevision: entry.assetRevision,
    relativePath: entry.relativePath,
    size: entry.size,
    lastModified: entry.lastModified,
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MiB`;
  }
  return `${Math.round(bytes / 1024)} KiB`;
}

function modelStateLabel(state: AiModelState | undefined): string {
  if (!state) return "Checking cache…";
  switch (state.status) {
    case "ready":
      return "Ready offline";
    case "downloading":
      return `Downloading ${formatBytes(state.receivedBytes)} / ${formatBytes(state.totalBytes)}`;
    case "error":
      return "Cache unavailable";
    case "missing":
      return "Not downloaded";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function stageLabel(stage: AiInferenceProgress["stage"]): string {
  switch (stage) {
    case "preparing":
      return "Preparing source";
    case "loading-model":
      return "Loading model";
    case "inference":
      return "Creating mask";
    case "encoding":
      return "Saving mask";
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

function isCancelled(error: unknown): boolean {
  return error instanceof AiInferenceError && error.code === "cancelled";
}

function currentDocument(entry: LibraryEntry): CurrentDocument | null {
  const state = useDevelopStore.getState();
  const session = state.sessions[entry.id];
  const document = session?.persistedDocument;
  return state.activeCatalogId === entry.catalogId &&
      state.activeEntryId === entry.id &&
      session?.processKind === "v3" &&
      document?.version === 3
    ? { document, revision: session.documentRevision }
    : null;
}

function liveSourceMatches(
  entry: LibraryEntry,
  sourceSignature: V3SourceSignature,
): boolean {
  const library = useLibraryStore.getState();
  const liveEntry = library.catalogId === entry.catalogId
    ? library.entries.find((item) => item.id === entry.id)
    : undefined;
  return Boolean(
    liveEntry &&
    sourceSignaturesEqual(sourceSignatureForEntry(liveEntry), sourceSignature),
  );
}

function requestApplies(
  document: DevelopDocumentV3,
  request: AiRequest,
): boolean {
  if (request.target) {
    const mask = document.local.masks.find(
      (item) => item.id === request.target?.maskId,
    );
    const node = mask ? findMaskNode(mask.expression, request.target.componentId) : null;
    return node?.kind === "source" && node.source.kind === "ai-matte";
  }
  if (request.maskId) {
    const mask = document.local.masks.find((item) => item.id === request.maskId);
    return Boolean(mask && maskSourceNodes(mask.expression).length < MAX_COMPONENTS_PER_MASK);
  }
  return document.local.masks.length < MAX_MASKS;
}

function nextMaskName(masks: readonly LocalMaskV3[]): string {
  const names = new Set(masks.map((mask) => mask.name));
  let index = 1;
  while (names.has(`Mask ${index}`)) index += 1;
  return `Mask ${index}`;
}

function newMask(maskId: string, node: MaskSourceNode, masks: readonly LocalMaskV3[]): LocalMaskV3 {
  return {
    id: maskId,
    name: nextMaskName(masks),
    enabled: true,
    expression: node,
    adjustments: createDefaultLocalAdjustments(),
  };
}

function referencedMaskAssets(
  masks: readonly LocalMaskV3[],
  current: readonly DevelopAssetRef[],
  accepted: DevelopAssetRef,
): readonly DevelopAssetRef[] {
  const used = new Set(
    masks.flatMap((mask) => referencedMaskArtifacts(mask.expression).map((asset) => asset.assetId)),
  );
  const references = current
    .filter((reference) => used.has(reference.assetId))
    .map((reference) => reference.assetId === accepted.assetId ? accepted : reference);
  return used.has(accepted.assetId) &&
      !references.some((reference) => reference.assetId === accepted.assetId)
    ? [...references, accepted]
    : references;
}

function prepareMaskUpdate(
  document: DevelopDocumentV3,
  request: AiRequest,
  result: AiInferenceResult,
  reference: DevelopAssetRef,
  sourceSignature: V3SourceSignature,
): PreparedMaskUpdate | null {
  if (!requestApplies(document, request)) return null;
  const targetMask = request.target
    ? document.local.masks.find((mask) => mask.id === request.target?.maskId)
    : null;
  const targetNode = request.target && targetMask
    ? findMaskNode(targetMask.expression, request.target.componentId)
    : null;
  const nodeId = request.target?.componentId ?? crypto.randomUUID();
  const node: MaskSourceNode = {
    kind: "source",
    id: nodeId,
    enabled: true,
    source: {
    kind: "ai-matte",
    selector: result.component.selector,
    asset: reference,
    model: result.component.model,
    source: sourceSignature,
    threshold: result.component.inference.threshold,
    },
  };

  let masks: readonly LocalMaskV3[];
  let maskId: string;
  if (request.target) {
    maskId = request.target.maskId;
    masks = document.local.masks.map((mask) => mask.id === request.target?.maskId
      ? {
          ...mask,
          expression: targetNode?.kind === "source"
            ? replaceMaskNode(mask.expression, request.target.componentId, node)
            : mask.expression,
        }
      : mask);
  } else if (request.maskId) {
    maskId = request.maskId;
    masks = document.local.masks.map((mask) => mask.id === request.maskId
      ? { ...mask, expression: appendMaskSource(mask.expression, node, "add", crypto.randomUUID()) }
      : mask);
  } else {
    maskId = crypto.randomUUID();
    masks = [...document.local.masks, newMask(maskId, node, document.local.masks)];
  }

  return {
    local: {
      ...document.local,
      masks,
      maskAssetRefs: referencedMaskAssets(
        masks,
        document.local.maskAssetRefs,
        reference,
      ),
    },
    maskId,
    componentId: node.id,
  };
}

async function stageMaskAsset(
  result: AiInferenceResult,
  sourceSignature: V3SourceSignature,
): Promise<StagedMaskAsset> {
  if (
    result.asset.id !== result.asset.sha256 ||
    result.asset.width !== result.component.inference.width ||
    result.asset.height !== result.component.inference.height
  ) {
    throw new Error("The generated mask metadata does not match its pixels.");
  }
  const digest = parseSha256Digest(result.asset.sha256);
  const reference: DevelopAssetRef = {
    assetId: digest,
    kind: "mask-matte",
    sha256: digest,
    producerRevision: result.component.model.revision,
    coordinateFrameRevision: COORDINATE_FRAME_REVISION,
    colorStageId: "local-adjustments",
  };
  const candidate: DevelopAssetCandidate = {
    kind: "candidate",
    candidateId: `ai-mask-${crypto.randomUUID()}`,
    descriptor: {
      kind: "mask-matte",
      sha256: digest,
      sourceSignature,
      coordinateFrameRevision: COORDINATE_FRAME_REVISION,
      colorStageId: "local-adjustments",
      dimensions: {
        width: result.asset.width,
        height: result.asset.height,
      },
      byteLength: result.asset.byteLength,
      mimeType: "image/png",
      producerId: `darkroom-ai-${result.component.model.id}`,
      producerRevision: result.component.model.revision,
    },
  };
  const bytes = decodeBase64(result.asset.pngBase64);
  const nowMs = Date.now();
  const recoveryUntilMs = nowMs + RECOVERY_WINDOW_MS;
  const stored = await getDarkroomAPI().developAssetPut({
    candidate,
    bytes,
    nowMs,
    recoveryUntilMs,
  });
  if (stored.kind === "rejected") throw new Error(stored.message);
  return {
    candidate: stored.candidate,
    reference,
    nowMs,
    recoveryUntilMs,
  };
}

async function transitionMaskAsset(
  staged: StagedMaskAsset,
  lifecycle: "accepted" | "stale",
): Promise<void> {
  const transitioned = await getDarkroomAPI().developAssetTransition({
    candidate: staged.candidate,
    lifecycle,
    reference: lifecycle === "accepted" ? staged.reference : null,
    nowMs: staged.nowMs,
    recoveryUntilMs: staged.recoveryUntilMs,
  });
  if (transitioned.kind === "missing" || transitioned.kind === "conflict") {
    throw new Error(transitioned.message);
  }
}

export function AiMaskActions({ entry, document }: AiMaskActionsProps) {
  const sourceSignature = useMemo(
    () => sourceSignatureForEntry(entry),
    [entry],
  );
  const sourceKey = sourceSignatureKey(sourceSignature);
  const [modelStates, setModelStates] = useState<Partial<Record<AiModelId, AiModelState>>>({});
  const [job, setJob] = useState<AiJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [canForceCpu, setCanForceCpu] = useState(false);
  const [consentRequest, setConsentRequest] = useState<AiRequest | null>(null);
  const [lastRequest, setLastRequest] = useState<AiRequest | null>(null);
  const activeJobRef = useRef<ActiveJob | null>(null);
  const mountedRef = useRef(true);
  const sessionUi = useDevelopStore((state) => {
    const session = state.activeEntryId === entry.id ? state.sessions[entry.id] : undefined;
    return session?.ui ?? null;
  });
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const setSelectedMask = useDevelopStore((state) => state.setSelectedMask);
  const setSelectedComponent = useDevelopStore((state) => state.setSelectedComponent);
  const setOverlayVisible = useDevelopStore((state) => state.setMaskOverlayVisible);
  const selectedMask = document.local.masks.find(
    (mask) => mask.id === sessionUi?.selectedMaskId,
  ) ?? null;
  const selectedComponent = selectedMask && sessionUi?.selectedComponentId
    ? findMaskNode(selectedMask.expression, sessionUi.selectedComponentId)
    : null;

  const refreshModels = useCallback(async (): Promise<void> => {
    if (!isElectronApp()) return;
    try {
      const api = getDarkroomAPI();
      const states = await Promise.all(MODEL_IDS.map(async (modelId) => (
        [modelId, await api.getAiModelState(modelId)] as const
      )));
      if (mountedRef.current) setModelStates(Object.fromEntries(states));
    } catch (refreshError) {
      if (mountedRef.current) {
        setError(refreshError instanceof Error
          ? refreshError.message
          : "AI model status is unavailable.");
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const refreshTimer = window.setTimeout(() => void refreshModels(), 0);
    return () => {
      window.clearTimeout(refreshTimer);
      mountedRef.current = false;
      const active = activeJobRef.current;
      activeJobRef.current = null;
      active?.controller.abort();
      if (active?.downloading && isElectronApp()) {
        void getDarkroomAPI().cancelAiModelDownload(active.modelId).catch(() => undefined);
      }
    };
  }, [entry.id, refreshModels, sourceKey]);

  const cancelJob = useCallback(async (): Promise<void> => {
    const active = activeJobRef.current;
    if (!active) return;
    activeJobRef.current = null;
    active.controller.abort();
    if (active.downloading && isElectronApp()) {
      await getDarkroomAPI().cancelAiModelDownload(active.modelId).catch(() => undefined);
    }
    if (mountedRef.current) {
      setJob(null);
      setSuccess(null);
    }
  }, []);

  const beginJob = useCallback((modelId: AiModelId, downloading: boolean): ActiveJob => {
    const active: ActiveJob = {
      token: crypto.randomUUID(),
      controller: new AbortController(),
      modelId,
      downloading,
    };
    activeJobRef.current = active;
    return active;
  }, []);

  const currentJob = useCallback((active: ActiveJob): boolean => (
    mountedRef.current &&
    activeJobRef.current?.token === active.token &&
    activeJobRef.current.modelId === active.modelId &&
    useDevelopStore.getState().activeEntryId === entry.id &&
    liveSourceMatches(entry, sourceSignature)
  ), [entry, sourceSignature]);

  const completeResult = useCallback(async (
    request: AiRequest,
    result: AiInferenceResult,
    active: ActiveJob,
  ): Promise<string | null> => {
    if (
      result.component.selector !== request.modelId ||
      result.component.model.id !== request.modelId ||
      !sourceSignaturesEqual(result.sourceSignature, sourceSignature) ||
      !sourceSignaturesEqual(result.component.source, sourceSignature)
    ) {
      return "The source photo changed before the AI result was ready.";
    }
    if (!liveSourceMatches(entry, sourceSignature)) {
      return "The source photo changed before the AI result was ready.";
    }
    const beforeStore = currentDocument(entry);
    if (!beforeStore || !requestApplies(beforeStore.document, request)) {
      return request.target
        ? "The mask component changed before the AI result was ready."
        : "The mask limit was reached before the AI result was ready.";
    }

    const staged = await stageMaskAsset(result, sourceSignature);
    if (!liveSourceMatches(entry, sourceSignature)) {
      await transitionMaskAsset(staged, "stale").catch(() => undefined);
      return "The source photo changed before the AI result was saved.";
    }
    if (!currentJob(active)) {
      await transitionMaskAsset(staged, "stale").catch(() => undefined);
      return null;
    }
    const latest = currentDocument(entry);
    if (!latest || !requestApplies(latest.document, request)) {
      await transitionMaskAsset(staged, "stale").catch(() => undefined);
      return request.target
        ? "The mask component changed before the AI result was ready."
        : "The mask limit was reached before the AI result was ready.";
    }
    const update = prepareMaskUpdate(
      latest.document,
      request,
      result,
      staged.reference,
      sourceSignature,
    );
    if (!update) {
      await transitionMaskAsset(staged, "stale").catch(() => undefined);
      return "The mask changed before the AI result was ready.";
    }
    await transitionMaskAsset(staged, "accepted");
    if (!liveSourceMatches(entry, sourceSignature)) {
      return "The source photo changed while the AI mask was being saved. Run it again.";
    }
    if (!currentJob(active)) return null;
    const afterAccept = currentDocument(entry);
    if (
      !afterAccept ||
      afterAccept.revision !== latest.revision ||
      afterAccept.document !== latest.document
    ) {
      return "The mask changed while the AI result was being saved. Run it again.";
    }
    dispatch({
      kind: "replace-v3-semantic-group",
      group: "local",
      value: update.local,
    }, request.target ? "Regenerate AI mask" : "Create AI mask");
    setSelectedMask(update.maskId);
    setSelectedComponent(update.componentId);
    setOverlayVisible(true);
    return null;
  }, [currentJob, dispatch, entry, setOverlayVisible, setSelectedComponent, setSelectedMask, sourceSignature]);

  const infer = useCallback(async (request: AiRequest, active: ActiveJob): Promise<void> => {
    if (!currentJob(active)) return;
    activeJobRef.current = { ...active, downloading: false };
    setJob({
      kind: "inferring",
      modelId: request.modelId,
      stage: "preparing",
      progress: 0,
      forceWasm: request.forceWasm,
    });
    try {
      const result = await runAiMaskInference({
        modelId: request.modelId,
        entry,
        sourceSignature,
        signal: active.controller.signal,
        forceWasm: request.forceWasm,
        onProgress: (progress) => {
          if (!currentJob(active)) return;
          setJob({
            kind: "inferring",
            modelId: request.modelId,
            stage: progress.stage,
            progress: progress.progress,
            forceWasm: request.forceWasm,
          });
        },
      });
      if (!currentJob(active)) return;
      const completionError = await completeResult(request, result, active);
      if (!currentJob(active)) return;
      if (completionError) {
        setError(completionError);
        return;
      }
      setFallbackReason(result.fallbackReason ?? null);
      setCanForceCpu(false);
      setLastRequest(null);
      setError(null);
      setSuccess(request.target
        ? `${MODEL_LABELS[request.modelId]} mask regenerated.`
        : `${MODEL_LABELS[request.modelId]} mask added.`);
    } catch (inferenceError) {
      if (!currentJob(active) || active.controller.signal.aborted || isCancelled(inferenceError)) return;
      setLastRequest(request);
      setError(inferenceError instanceof Error ? inferenceError.message : "AI inference failed.");
      setCanForceCpu(
        !request.forceWasm &&
        inferenceError instanceof AiInferenceError &&
        (inferenceError.code === "runtime" ||
          inferenceError.code === "inference" ||
          Boolean(inferenceError.fallbackReason)),
      );
      setSuccess(null);
    } finally {
      if (activeJobRef.current?.token === active.token) {
        activeJobRef.current = null;
        setJob(null);
      }
    }
  }, [completeResult, currentJob, entry, sourceSignature]);

  const downloadAndInfer = useCallback(async (request: AiRequest): Promise<void> => {
    if (!isElectronApp()) {
      setError("AI masking is available in the Darkroom desktop app.");
      return;
    }
    const api = getDarkroomAPI();
    const active = beginJob(request.modelId, true);
    setError(null);
    setSuccess(null);
    setJob({
      kind: "downloading",
      modelId: request.modelId,
      receivedBytes: 0,
      totalBytes: modelStates[request.modelId]?.model.bytes ?? 1,
    });
    const unsubscribe = api.onAiModelProgress((progress: AiModelProgress) => {
      if (!currentJob(active) || progress.modelId !== request.modelId) return;
      setJob({
        kind: "downloading",
        modelId: request.modelId,
        receivedBytes: progress.receivedBytes,
        totalBytes: progress.totalBytes,
      });
      setModelStates((states) => {
        const current = states[request.modelId];
        return current
          ? {
              ...states,
              [request.modelId]: {
                status: "downloading",
                model: current.model,
                receivedBytes: progress.receivedBytes,
                totalBytes: progress.totalBytes,
              },
            }
          : states;
      });
    });
    try {
      await api.downloadAiModel(request.modelId);
      if (!currentJob(active)) return;
      const state = await api.getAiModelState(request.modelId);
      if (state.status !== "ready") {
        throw new Error(state.status === "error"
          ? state.message
          : "The AI model was not ready after download.");
      }
      setModelStates((states) => ({ ...states, [request.modelId]: state }));
      await infer(request, active);
    } catch (downloadError) {
      if (!currentJob(active) || active.controller.signal.aborted) return;
      setLastRequest(request);
      setError(downloadError instanceof Error
        ? downloadError.message
        : "AI model download failed.");
      setSuccess(null);
      activeJobRef.current = null;
      setJob(null);
    } finally {
      unsubscribe();
      void refreshModels();
    }
  }, [beginJob, currentJob, infer, modelStates, refreshModels]);

  const startRequest = useCallback(async (request: AiRequest): Promise<void> => {
    if (job || consentRequest) return;
    if (!isElectronApp()) {
      setError("AI masking is available in the Darkroom desktop app.");
      return;
    }
    setError(null);
    setSuccess(null);
    setCanForceCpu(false);
    setLastRequest(request);
    try {
      const state = await getDarkroomAPI().getAiModelState(request.modelId);
      if (!mountedRef.current || useDevelopStore.getState().activeEntryId !== entry.id) return;
      setModelStates((states) => ({ ...states, [request.modelId]: state }));
      if (state.status === "ready") {
        await infer(request, beginJob(request.modelId, false));
        return;
      }
      setConsentRequest(request);
      if (state.status === "error") setError(state.message);
    } catch (stateError) {
      setError(stateError instanceof Error
        ? stateError.message
        : "AI model status is unavailable.");
    }
  }, [beginJob, consentRequest, entry.id, infer, job]);

  const confirmDownload = useCallback(() => {
    const request = consentRequest;
    setConsentRequest(null);
    if (request) void downloadAndInfer(request);
  }, [consentRequest, downloadAndInfer]);

  const retryLastRequest = useCallback((forceWasm: boolean) => {
    if (lastRequest) void startRequest({ ...lastRequest, forceWasm });
  }, [lastRequest, startRequest]);

  const removeModel = useCallback(async (modelId: AiModelId): Promise<void> => {
    if (job?.modelId === modelId || !isElectronApp()) return;
    try {
      await getDarkroomAPI().removeAiModel(modelId);
      setSuccess(`${MODEL_LABELS[modelId]} model removed from this device.`);
      await refreshModels();
    } catch (removeError) {
      setError(removeError instanceof Error
        ? removeError.message
        : "Could not remove the cached model.");
    }
  }, [job?.modelId, refreshModels]);

  if (!isElectronApp()) {
    return (
      <div className="space-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">AI selection</h3>
        <p className="text-[10px] leading-relaxed text-lr-text-faint">
          Subject and Sky masking run locally in the Darkroom desktop app.
        </p>
      </div>
    );
  }

  const busy = job !== null;
  const canAdd = selectedMask
    ? maskSourceNodes(selectedMask.expression).length < MAX_COMPONENTS_PER_MASK
    : document.local.masks.length < MAX_MASKS;
  const selectedAiNode = selectedComponent?.kind === "source" ? selectedComponent : null;
  const selectedAi = selectedAiNode?.source.kind === "ai-matte" ? selectedAiNode.source : null;
  const staleSelectedAi = selectedAi
    ? !sourceSignaturesEqual(selectedAi.source, sourceSignature)
    : false;

  return (
    <div className="mb-3 space-y-3 border-b border-lr-border-subtle pb-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">AI selection</h3>
          <p className="mt-1 text-[10px] leading-relaxed text-lr-text-faint">
            Runs locally. Downloaded models stay available offline.
          </p>
        </div>
        {busy ? <span className="rounded bg-lr-selection px-1.5 py-1 text-[9px] text-lr-accent">Working</span> : null}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {MODEL_IDS.map((modelId) => (
          <button
            key={modelId}
            type="button"
            disabled={busy || !canAdd}
            onClick={() => void startRequest({
              modelId,
              maskId: selectedMask?.id ?? null,
              target: null,
              forceWasm: false,
            })}
            className="flex min-h-[52px] items-center gap-2 rounded-lg border border-lr-border-subtle px-2.5 py-2 text-left text-[10px] text-lr-text-muted hover:border-lr-accent/60 hover:bg-lr-panel-raised hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="font-mono text-[9px] font-semibold tracking-[0.08em] text-lr-accent">
              {modelId === "subject" ? "SUB" : "SKY"}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{MODEL_LABELS[modelId]}</span>
              <span className="mt-0.5 block truncate text-[9px] text-lr-text-faint">
                {modelStateLabel(modelStates[modelId])}
              </span>
            </span>
          </button>
        ))}
      </div>

      {selectedAi ? (
        <div className="flex items-center justify-between gap-2">
          <p className={`text-[10px] ${staleSelectedAi ? "text-lr-danger" : "text-lr-text-faint"}`}>
            {staleSelectedAi
              ? `${MODEL_LABELS[selectedAi.selector]} mask is stale.`
              : `${MODEL_LABELS[selectedAi.selector]} mask selected.`}
          </p>
          <ActionButton
            disabled={busy}
            onClick={() => void startRequest({
              modelId: selectedAi.selector,
              maskId: selectedMask?.id ?? null,
              target: selectedMask
                ? { maskId: selectedMask.id, componentId: selectedAiNode?.id ?? "" }
                : null,
              forceWasm: false,
            })}
          >
            Regenerate
          </ActionButton>
        </div>
      ) : null}

      {job?.kind === "downloading" ? (
        <div className="rounded-md border border-lr-border-subtle bg-lr-panel-raised/60 p-2">
          <div className="flex items-center justify-between text-[10px] text-lr-text-muted">
            <span>Downloading {MODEL_LABELS[job.modelId]}</span>
            <span>{formatBytes(job.receivedBytes)} / {formatBytes(job.totalBytes)}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-lr-border-subtle">
            <div className="h-full bg-lr-accent transition-[width]" style={{ width: `${Math.round((job.receivedBytes / Math.max(1, job.totalBytes)) * 100)}%` }} />
          </div>
          <button type="button" onClick={() => void cancelJob()} className="mt-2 text-[10px] text-lr-text-muted underline decoration-lr-border-subtle underline-offset-2 hover:text-lr-text">Cancel download</button>
        </div>
      ) : null}

      {job?.kind === "inferring" ? (
        <div className="rounded-md border border-lr-border-subtle bg-lr-panel-raised/60 p-2">
          <div className="flex items-center justify-between text-[10px] text-lr-text-muted">
            <span>{stageLabel(job.stage)}</span>
            <span>{Math.round(job.progress * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-lr-border-subtle">
            <div className="h-full bg-lr-accent transition-[width]" style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <button type="button" onClick={() => void cancelJob()} className="mt-2 text-[10px] text-lr-text-muted underline decoration-lr-border-subtle underline-offset-2 hover:text-lr-text">Cancel inference</button>
        </div>
      ) : null}

      {lastRequest && error ? (
        <StatusCard title="AI masking did not complete" tone="danger">
          <p>Your existing mask is unchanged.</p>
          <div className="mt-2 flex gap-2">
            <ActionButton disabled={busy} onClick={() => retryLastRequest(false)}>Retry</ActionButton>
            {canForceCpu && !lastRequest.forceWasm ? (
              <ActionButton disabled={busy} onClick={() => retryLastRequest(true)}>Use CPU</ActionButton>
            ) : null}
          </div>
        </StatusCard>
      ) : null}

      {fallbackReason ? <p className="text-[10px] text-lr-text-faint">{fallbackReason}</p> : null}
      {success ? <p className="text-[10px] text-lr-accent">{success}</p> : null}
      {error ? <p role="alert" className="text-[10px] leading-relaxed text-lr-danger">{error}</p> : null}

      <details className="border-t border-lr-border-subtle pt-2">
        <summary className="cursor-pointer text-[10px] text-lr-text-faint hover:text-lr-text-muted">Model cache</summary>
        <div className="mt-2 space-y-1.5">
          {MODEL_IDS.map((modelId) => {
            const state = modelStates[modelId];
            return (
              <div key={modelId} className="flex items-center justify-between gap-2 text-[10px]">
                <span className="min-w-0 truncate text-lr-text-faint">
                  {MODEL_LABELS[modelId]} · {state ? formatBytes(state.model.bytes) : "…"}
                </span>
                <button
                  type="button"
                  disabled={state?.status !== "ready" || job?.modelId === modelId}
                  onClick={() => void removeModel(modelId)}
                  className="shrink-0 text-lr-text-muted underline decoration-lr-border-subtle underline-offset-2 hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-35"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      </details>

      {consentRequest ? (
        <div role="dialog" aria-modal="true" aria-labelledby="ai-consent-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg border border-lr-border-subtle bg-lr-panel p-4 shadow-2xl">
            {(() => {
              const disclosure = modelStates[consentRequest.modelId]?.model;
              if (!disclosure) {
                return <p className="text-[11px] text-lr-text-muted">Checking model details…</p>;
              }
              return (
                <>
                  <h2 id="ai-consent-title" className="text-sm font-medium text-lr-text">Download {MODEL_LABELS[consentRequest.modelId]} model?</h2>
                  <p className="mt-2 text-[11px] leading-relaxed text-lr-text-muted">
                    {disclosure.purpose} Darkroom will download {disclosure.bytes.toLocaleString()} bytes ({formatBytes(disclosure.bytes)}) once and keep the verified file in its private cache for offline use.
                  </p>
                  <dl className="mt-3 space-y-1 text-[10px] text-lr-text-faint">
                    <div className="flex justify-between gap-3"><dt>Revision</dt><dd className="font-mono text-right">{disclosure.revision}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Source</dt><dd><a href={disclosure.sourceUrl} onClick={(event) => { event.preventDefault(); void getDarkroomAPI().openAiModelLink(disclosure.id, "source").catch((openError: unknown) => setError(openError instanceof Error ? openError.message : "Could not open the model source page.")); }} className="text-lr-accent underline">Project release</a></dd></div>
                    <div className="flex justify-between gap-3"><dt>License</dt><dd><a href={disclosure.license.url} onClick={(event) => { event.preventDefault(); void getDarkroomAPI().openAiModelLink(disclosure.id, "license").catch((openError: unknown) => setError(openError instanceof Error ? openError.message : "Could not open the model license page.")); }} className="text-lr-accent underline">{disclosure.license.name}</a></dd></div>
                  </dl>
                  <p className="mt-3 text-[10px] leading-relaxed text-lr-text-faint">{disclosure.offlineCacheBehavior}</p>
                  <div className="mt-4 flex justify-end gap-2">
                    <button type="button" onClick={() => setConsentRequest(null)} className="rounded border border-lr-border-subtle px-3 py-1.5 text-[10px] text-lr-text-muted hover:bg-lr-panel-raised">Cancel</button>
                    <button type="button" onClick={confirmDownload} className="rounded bg-lr-accent px-3 py-1.5 text-[10px] font-medium text-[#14202a] hover:bg-lr-accent-hover">Download and continue</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
