"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
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
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import {
  MAX_COMPONENTS_PER_MASK,
  MAX_MASKS,
} from "@/lib/develop/document";
import {
  sourceSignatureKey,
  sourceSignaturesEqual,
} from "@/lib/develop/source-transform";
import type {
  AiMaskComponent,
  LocalMask,
  SourceSignature,
} from "@/lib/develop/types";
import type { RenderDiagnostic } from "@/lib/develop/renderer";
import { DEFAULT_DEVELOP_SETTINGS } from "@/lib/develop/registry";
import { useDevelopStore } from "@/stores/develop-store";

interface AiMaskActionsProps {
  entry: LibraryEntry;
  sourceSignature: SourceSignature;
  diagnostics: readonly RenderDiagnostic[];
}

type AiTarget = {
  maskId: string;
  componentId: string;
};

type AiRequest = {
  modelId: AiModelId;
  maskId: string | null;
  target: AiTarget | null;
  forceWasm: boolean;
};

type AiJob =
  | {
      kind: "downloading";
      modelId: AiModelId;
      receivedBytes: number;
      totalBytes: number;
    }
  | {
      kind: "inferring";
      modelId: AiModelId;
      stage: AiInferenceProgress["stage"];
      progress: number;
      forceWasm: boolean;
    };

type ActiveJob = {
  token: string;
  controller: AbortController;
  modelId: AiModelId;
  downloading: boolean;
};

const MODEL_IDS: readonly AiModelId[] = ["subject", "sky"];
const MODEL_LABELS: Record<AiModelId, string> = {
  subject: "Subject",
  sky: "Sky",
};

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

function selectedAiTarget(
  entryId: string,
  diagnostics: readonly RenderDiagnostic[],
): AiTarget | null {
  const state = useDevelopStore.getState();
  const session = state.sessions[entryId];
  const maskId = session?.ui.selectedMaskId;
  const componentId = session?.ui.selectedComponentId;
  if (!maskId || !componentId) return null;
  const component = session.document.settings.masking.masks
    .find((mask) => mask.id === maskId)
    ?.components.find((item) => item.id === componentId);
  if (component?.kind !== "ai") return null;
  if (!diagnostics.some((diagnostic) => diagnostic.maskId === maskId && diagnostic.componentId === componentId)) {
    return null;
  }
  return { maskId, componentId };
}

function newMaskForAi(
  maskId: string,
  component: AiMaskComponent,
  masks: readonly LocalMask[],
): LocalMask {
  const names = new Set(masks.map((mask) => mask.name));
  let index = 1;
  while (names.has(`Mask ${index}`)) index += 1;
  return {
    id: maskId,
    name: `Mask ${index}`,
    enabled: true,
    inverted: false,
    components: [component],
    adjustments: structuredClone(DEFAULT_DEVELOP_SETTINGS.basic),
  };
}

export function AiMaskActions({
  entry,
  sourceSignature,
  diagnostics,
}: AiMaskActionsProps) {
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
  const sourceKey = sourceSignatureKey(sourceSignature);
  const activeSession = useDevelopStore((state) => (
    state.activeEntryId === entry.id ? state.sessions[entry.id] ?? null : null
  ));
  const dispatch = useDevelopStore((state) => state.dispatch);
  const setSelectedMask = useDevelopStore((state) => state.setSelectedMask);
  const setSelectedComponent = useDevelopStore((state) => state.setSelectedComponent);
  const setOverlayVisible = useDevelopStore((state) => state.setMaskOverlayVisible);

  const refreshModels = useCallback(async (): Promise<void> => {
    if (!isElectronApp()) return;
    const api = getDarkroomAPI();
    try {
      const states = await Promise.all(MODEL_IDS.map(async (modelId) => (
        [modelId, await api.getAiModelState(modelId)] as const
      )));
      if (!mountedRef.current) return;
      setModelStates(Object.fromEntries(states) as Partial<Record<AiModelId, AiModelState>>);
    } catch (refreshError) {
      if (mountedRef.current) {
        setError(refreshError instanceof Error ? refreshError.message : "AI model status is unavailable.");
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const refreshTimer = window.setTimeout(() => {
      void refreshModels();
    }, 0);
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
  }, [entry.id, sourceKey, refreshModels]);

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
    sourceSignatureKey(sourceSignature) === sourceKey
  ), [entry.id, sourceKey, sourceSignature]);

  const completeResult = useCallback((request: AiRequest, result: Awaited<ReturnType<typeof runAiMaskInference>>): boolean => {
    const state = useDevelopStore.getState();
    const session = state.sessions[entry.id];
    if (!session || state.activeEntryId !== entry.id) return false;
    if (
      !sourceSignaturesEqual(result.sourceSignature, sourceSignature) ||
      !sourceSignaturesEqual(result.component.source, sourceSignature)
    ) {
      return false;
    }

    const component: AiMaskComponent = {
      ...result.component,
      id: request.target?.componentId ?? crypto.randomUUID(),
      operation: "add",
      assetId: result.asset.id,
    };
    const selectedMask = request.maskId
      ? session.document.settings.masking.masks.find((mask) => mask.id === request.maskId)
      : undefined;
    if (request.target) {
      if (!selectedMask?.components.some((item) => item.id === request.target?.componentId)) return false;
      const before = session.document;
      dispatch({
        kind: "update-ai-mask",
        maskId: request.target.maskId,
        componentId: request.target.componentId,
        component,
        asset: result.asset,
      }, "Update AI mask");
      return useDevelopStore.getState().sessions[entry.id]?.document !== before;
    }

    if (request.maskId && !selectedMask) return false;
    if (!request.maskId && session.document.settings.masking.masks.length >= MAX_MASKS) return false;
    const newMask = request.maskId
      ? null
      : newMaskForAi(crypto.randomUUID(), component, session.document.settings.masking.masks);
    const before = session.document;
    dispatch({
      kind: "complete-ai-mask",
      maskId: request.maskId,
      newMask,
      component,
      asset: result.asset,
    }, "Create AI mask");
    const changed = useDevelopStore.getState().sessions[entry.id]?.document !== before;
    if (changed) {
      const maskId = request.maskId ?? newMask?.id ?? null;
      setSelectedMask(maskId);
      setSelectedComponent(component.id);
      setOverlayVisible(true);
    }
    return changed;
  }, [dispatch, entry.id, setOverlayVisible, setSelectedComponent, setSelectedMask, sourceSignature]);

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
      if (!completeResult(request, result)) {
        setError(request.target ? "The selected mask changed before the AI result was ready." : "The mask limit was reached before the AI result was ready.");
        return;
      }
      setFallbackReason(result.fallbackReason ?? null);
      setCanForceCpu(false);
      setLastRequest(null);
      setError(null);
      setSuccess(request.target
        ? `${MODEL_LABELS[request.modelId]} mask updated.`
        : `${MODEL_LABELS[request.modelId]} mask added.`);
    } catch (inferenceError) {
      if (!currentJob(active) || active.controller.signal.aborted || isCancelled(inferenceError)) return;
      setLastRequest(request);
      setError(inferenceError instanceof Error ? inferenceError.message : "AI inference failed.");
      setCanForceCpu(!request.forceWasm && inferenceError instanceof AiInferenceError && (inferenceError.code === "runtime" || inferenceError.code === "inference" || Boolean(inferenceError.fallbackReason)));
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
        if (!current) return states;
        return {
          ...states,
          [request.modelId]: {
            status: "downloading",
            model: current.model,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
          },
        };
      });
    });
    try {
      await api.downloadAiModel(request.modelId);
      if (!currentJob(active)) return;
      const state = await api.getAiModelState(request.modelId);
      if (state.status !== "ready") {
        throw new Error(state.status === "error" ? state.message : "The AI model was not ready after download.");
      }
      setModelStates((states) => ({ ...states, [request.modelId]: state }));
      await infer(request, active);
    } catch (downloadError) {
      if (!currentJob(active) || active.controller.signal.aborted) return;
      setLastRequest(request);
      setError(downloadError instanceof Error ? downloadError.message : "AI model download failed.");
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
    const api = getDarkroomAPI();
    try {
      const state = await api.getAiModelState(request.modelId);
      if (!mountedRef.current || useDevelopStore.getState().activeEntryId !== entry.id) return;
      setModelStates((states) => ({ ...states, [request.modelId]: state }));
      if (state.status === "ready") {
        const active = beginJob(request.modelId, false);
        await infer(request, active);
        return;
      }
      setConsentRequest(request);
      if (state.status === "error") setError(state.message);
    } catch (stateError) {
      setError(stateError instanceof Error ? stateError.message : "AI model status is unavailable.");
    }
  }, [beginJob, consentRequest, entry.id, infer, job]);

  const confirmDownload = useCallback(() => {
    const request = consentRequest;
    setConsentRequest(null);
    if (request) void downloadAndInfer(request);
  }, [consentRequest, downloadAndInfer]);

  const retrySelected = useCallback((forceWasm: boolean) => {
    const target = selectedAiTarget(entry.id, diagnostics);
    if (!target) {
      setError("Select the stale AI component to update it.");
      return;
    }
    const session = useDevelopStore.getState().sessions[entry.id];
    const mask = session?.document.settings.masking.masks.find((item) => item.id === target.maskId);
    const component = mask?.components.find((item) => item.id === target.componentId);
    if (!component || component.kind !== "ai") return;
    void startRequest({
      modelId: component.selector,
      maskId: target.maskId,
      target,
      forceWasm,
    });
  }, [diagnostics, entry.id, startRequest]);

  const retryLastRequest = useCallback((forceWasm: boolean) => {
    if (!lastRequest) return;
    void startRequest({ ...lastRequest, forceWasm });
  }, [lastRequest, startRequest]);

  const removeModel = useCallback(async (modelId: AiModelId): Promise<void> => {
    if (job?.modelId === modelId) return;
    if (!isElectronApp()) return;
    try {
      await getDarkroomAPI().removeAiModel(modelId);
      setSuccess(`${MODEL_LABELS[modelId]} model removed from this device.`);
      await refreshModels();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove the cached model.");
    }
  }, [job?.modelId, refreshModels]);

  const selectedDiagnostic = useMemo(() => {
    const maskId = activeSession?.ui.selectedMaskId;
    const componentId = activeSession?.ui.selectedComponentId;
    return diagnostics.find((diagnostic) => diagnostic.maskId === maskId && diagnostic.componentId === componentId) ?? null;
  }, [activeSession, diagnostics]);

  if (!isElectronApp()) {
    return (
      <div className="space-y-2">
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">AI selection</h3>
          <p className="mt-1 text-[10px] leading-relaxed text-lr-text-faint">Subject and Sky masking run locally in the Darkroom desktop app.</p>
        </div>
      </div>
    );
  }

  const busy = job !== null;
  const selectedMaskId = activeSession?.ui.selectedMaskId ?? null;
  const selectedMaskForAi = selectedMaskId
    ? activeSession?.document.settings.masking.masks.find((mask) => mask.id === selectedMaskId) ?? null
    : null;
  const canCreateNewMask = selectedMaskForAi
    ? selectedMaskForAi.components.length < MAX_COMPONENTS_PER_MASK
    : (activeSession?.document.settings.masking.masks.length ?? 0) < MAX_MASKS;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">AI selection</h3>
          <p className="mt-1 text-[10px] leading-relaxed text-lr-text-faint">Local inference. Models stay in Darkroom&apos;s offline cache.</p>
        </div>
        {busy ? <span className="rounded bg-lr-selection px-1.5 py-1 text-[9px] text-lr-accent">Working</span> : null}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {MODEL_IDS.map((modelId) => {
          const state = modelStates[modelId];
          const disabled = busy || !canCreateNewMask;
          return (
            <button
              key={modelId}
              type="button"
              disabled={disabled}
              onClick={() => void startRequest({ modelId, maskId: selectedMaskId, target: null, forceWasm: false })}
              className="flex min-h-[52px] items-center gap-2 rounded-lg border border-lr-border-subtle px-2.5 py-2 text-left text-[10px] text-lr-text-muted hover:border-lr-accent/60 hover:bg-lr-panel-raised hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="font-mono text-[9px] font-semibold tracking-[0.08em] text-lr-accent">
                {modelId === "subject" ? "SUB" : "SKY"}
              </span>
              <span className="min-w-0">
                <span className="block font-medium">{MODEL_LABELS[modelId]}</span>
                <span className="mt-0.5 block truncate text-[9px] text-lr-text-faint">{modelStateLabel(state)}</span>
              </span>
            </button>
          );
        })}
      </div>

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

      {selectedDiagnostic ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-950/20 p-2 text-[10px] text-amber-100">
          <p>{selectedDiagnostic.message}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => retrySelected(false)} className="rounded border border-amber-400/40 px-2 py-1 text-[10px] hover:bg-amber-900/30 disabled:opacity-40">
              {selectedDiagnostic.kind === "stale-ai" ? "Update" : "Regenerate"}
            </button>
            {canForceCpu ? (
              <button type="button" disabled={busy} onClick={() => retrySelected(true)} className="rounded border border-amber-400/40 px-2 py-1 text-[10px] hover:bg-amber-900/30 disabled:opacity-40">Switch to CPU</button>
            ) : null}
          </div>
        </div>
      ) : null}

      {lastRequest && error && !selectedDiagnostic ? (
        <div className="rounded-md border border-red-500/30 bg-red-950/20 p-2 text-[10px] text-red-100">
          <p>AI masking did not complete. Your existing edits are unchanged.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => retryLastRequest(false)} className="rounded border border-red-400/40 px-2 py-1 text-[10px] hover:bg-red-900/30 disabled:opacity-40">
              Retry
            </button>
            {canForceCpu && !lastRequest.forceWasm ? (
              <button type="button" disabled={busy} onClick={() => retryLastRequest(true)} className="rounded border border-red-400/40 px-2 py-1 text-[10px] hover:bg-red-900/30 disabled:opacity-40">
                Switch to CPU
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {fallbackReason ? <p className="text-[10px] text-lr-text-faint">{fallbackReason}</p> : null}
      {success ? <p className="text-[10px] text-lr-accent">{success}</p> : null}
      {error ? <p role="alert" className="text-[10px] leading-relaxed text-lr-danger">{error}</p> : null}

      <details className="border-t border-lr-border-subtle pt-2">
        <summary className="cursor-pointer text-[10px] text-lr-text-faint hover:text-lr-text-muted">Model cache</summary>
        <div className="mt-2 space-y-1.5">
        {MODEL_IDS.map((modelId) => {
          const state = modelStates[modelId];
          const ready = state?.status === "ready";
          const active = job?.modelId === modelId;
          return (
            <div key={modelId} className="flex items-center justify-between gap-2 text-[10px]">
              <span className="min-w-0 truncate text-lr-text-faint">{MODEL_LABELS[modelId]} · {state ? formatBytes(state.model.bytes) : "…"}</span>
              <button type="button" disabled={!ready || active} onClick={() => void removeModel(modelId)} className="shrink-0 text-lr-text-muted underline decoration-lr-border-subtle underline-offset-2 hover:text-lr-text disabled:cursor-not-allowed disabled:opacity-35">Remove</button>
            </div>
          );
        })}
        </div>
      </details>

      {consentRequest ? (
        <div role="dialog" aria-modal="true" aria-labelledby="ai-consent-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg border border-lr-border-subtle bg-lr-panel p-4 shadow-2xl">
            {(() => {
              const state = modelStates[consentRequest.modelId];
              const disclosure = state?.model;
              if (!disclosure) return <p className="text-[11px] text-lr-text-muted">Checking model details…</p>;
              return (
                <>
                  <h2 id="ai-consent-title" className="text-sm font-medium text-lr-text">Download {MODEL_LABELS[consentRequest.modelId]} model?</h2>
                  <p className="mt-2 text-[11px] leading-relaxed text-lr-text-muted">{disclosure.purpose} Darkroom will download {disclosure.bytes.toLocaleString()} bytes ({formatBytes(disclosure.bytes)}) once and keep the verified file in its private cache for offline use.</p>
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
