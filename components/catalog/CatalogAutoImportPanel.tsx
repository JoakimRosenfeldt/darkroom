"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogRootState } from "@/lib/fs/session-catalog";
import { parsePresetId, parseRootId, type PresetId, type RootId } from "@/lib/catalog/ids";
import { parseSessionId } from "@/lib/catalog/runtime";
import type { AutoImportStatus, AutoImportStatusItem } from "@/lib/import/auto-import-api";
import {
  cancelCatalogAutoImport,
  clearCatalogAutoImportFailures,
  configureCatalogAutoImport,
  disableCatalogAutoImport,
  enableCatalogAutoImport,
  getCatalogAutoImportStatus,
  openCatalogAutoImportIngress,
  pauseCatalogAutoImport,
  retryCatalogAutoImport,
  resumeCatalogAutoImport,
} from "@/lib/fs/session-catalog";
import { useLibraryStore } from "@/stores/library-store";

const BUTTON_CLASS = "rounded border border-lr-border-subtle px-2.5 py-1.5 text-[11px] text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40";
const PRIMARY_BUTTON_CLASS = "rounded bg-lr-accent px-2.5 py-1.5 text-[11px] text-white transition hover:bg-lr-accent/90 disabled:opacity-40";
const POLL_MS = 5_000;

function safeMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : "";
  return message.length > 0 && message.length <= 500 && !message.includes("/") && !message.includes("\\")
    ? message
    : fallback;
}

function rootLabel(root: CatalogRootState): string {
  return `${root.label} · ${root.health}`;
}

function itemLabel(item: AutoImportStatusItem): string {
  return `${item.state} · ${item.relativePath} · attempt ${item.attempts}/${item.maxAttempts}`;
}

function parseCount(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function CatalogAutoImportPanel({ disabled }: { readonly disabled: boolean }) {
  const catalogId = useLibraryStore((state) => state.catalogId);
  const sessionId = useLibraryStore((state) => state.sessionId);
  const roots = useLibraryStore((state) => state.catalogRoots);
  const presets = useLibraryStore((state) => state.importPresets);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AutoImportStatus | null>(null);
  const [ingressRootId, setIngressRootId] = useState<RootId | null>(null);
  const [ingressRelativePath, setIngressRelativePath] = useState("inbox");
  const [destinationRootId, setDestinationRootId] = useState<RootId | null>(null);
  const [destinationRelativePath, setDestinationRelativePath] = useState("photos");
  const [presetId, setPresetId] = useState<PresetId | null>(null);
  const [duplicatePolicy, setDuplicatePolicy] = useState<"skip-incoming" | "keep-both" | "continue-unchecked">("skip-incoming");
  const [destinationConflictPolicy, setDestinationConflictPolicy] = useState<"skip" | "rename">("rename");
  const [stabilityMs, setStabilityMs] = useState("1000");
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [retryBackoffMs, setRetryBackoffMs] = useState("5000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const hydratedRuleId = useRef<string | null>(null);

  const onlineRoots = roots.filter((root) => root.health === "online");
  const defaultPreset = presets.find((preset) => preset.isDefault) ?? presets[0];
  const effectivePresetId = presetId ?? (defaultPreset === undefined ? null : parsePresetId(defaultPreset.presetId));
  const effectiveIngressRootId = ingressRootId ?? onlineRoots[0]?.rootId ?? null;
  const effectiveDestinationRootId = destinationRootId ?? onlineRoots[0]?.rootId ?? null;
  const operationBusy = disabled || busy;

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (catalogId === null || sessionId === null) return;
    try {
      const next = await getCatalogAutoImportStatus();
      setStatus(next);
      const nextRuleId = next.rule?.ruleId ?? null;
      if (nextRuleId !== hydratedRuleId.current && next.rule !== null) {
        hydratedRuleId.current = nextRuleId;
        setIngressRootId(next.rule.ingressRootId);
        setIngressRelativePath(next.rule.ingressRelativePath);
        setDestinationRootId(next.rule.destinationRootId);
        setDestinationRelativePath(next.rule.destinationRelativePath);
        setPresetId(next.rule.presetId);
        if (next.rule.duplicatePolicy !== "use-existing-location") setDuplicatePolicy(next.rule.duplicatePolicy);
        if (next.rule.destinationConflictPolicy !== "replace") setDestinationConflictPolicy(next.rule.destinationConflictPolicy);
        setStabilityMs(String(next.rule.stabilityMs));
        setMaxAttempts(String(next.rule.maxAttempts));
        setRetryBackoffMs(String(next.rule.retryBackoffMs));
      } else if (next.rule === null) {
        hydratedRuleId.current = null;
      }
    } catch (reason) {
      setError(safeMessage(reason, "Auto Import status is unavailable."));
    }
  }, [catalogId, sessionId]);

  useEffect(() => {
    hydratedRuleId.current = null;
  }, [catalogId, sessionId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await refreshStatus();
    };
    void load();
    if (!open) return () => { cancelled = true; };
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, refreshStatus]);

  async function act(operation: () => Promise<AutoImportStatus>, success: string): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await operation();
      setStatus(next);
      if (next.rule !== null) hydratedRuleId.current = next.rule.ruleId;
      setMessage(success);
    } catch (reason) {
      setError(safeMessage(reason, "Auto Import action failed."));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfigure(): Promise<void> {
    if (catalogId === null || sessionId === null || effectiveIngressRootId === null || effectiveDestinationRootId === null || effectivePresetId === null) {
      setError("Choose online roots and a persisted preset before configuring Auto Import.");
      return;
    }
    const parsedStability = parseCount(stabilityMs, -1);
    const parsedAttempts = parseCount(maxAttempts, 0);
    const parsedBackoff = parseCount(retryBackoffMs, -1);
    if (parsedStability < 0 || parsedAttempts < 1 || parsedBackoff < 0) {
      setError("Timing values are invalid.");
      return;
    }
    await act(() => configureCatalogAutoImport({
      catalogId,
      sessionId: parseSessionId(sessionId),
      action: "copy",
      ingressRootId: effectiveIngressRootId,
      ingressRelativePath,
      destinationRootId: effectiveDestinationRootId,
      destinationRelativePath,
      presetId: effectivePresetId,
      duplicatePolicy,
      destinationConflictPolicy,
      stabilityMs: parsedStability,
      maxAttempts: parsedAttempts,
      retryBackoffMs: parsedBackoff,
      enabled: status?.rule?.enabled ?? false,
    }), "Auto Import rule saved.");
  }

  if (catalogId === null || sessionId === null) return null;

  const configured = status?.rule !== null && status?.rule !== undefined;
  const enabled = status?.state === "ready" || status?.state === "paused";
  const canConfigure = onlineRoots.length > 0 && effectivePresetId !== null && effectiveIngressRootId !== null && effectiveDestinationRootId !== null;

  return (
    <details
      className="rounded-lg border border-lr-border-subtle bg-lr-panel px-3 py-2.5"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs font-medium text-lr-text">Auto Import · Copy</summary>
      <div className="mt-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] leading-4 text-lr-text-faint">Watch a linked root and copy stable photos into the active catalog.</p>
            <p className="mt-1 text-[10px] text-lr-text-faint">Move unavailable · Replace unavailable · DNG conversion unavailable.</p>
          </div>
          <span className={enabled ? "shrink-0 text-[10px] text-emerald-300" : "shrink-0 text-[10px] text-lr-text-faint"}>{status?.state ?? "loading"}</span>
        </div>

        <section aria-labelledby="auto-import-placement-title" className="space-y-2">
          <h3 id="auto-import-placement-title" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Placement</h3>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-lr-text-muted">
              Ingress root
              <select value={effectiveIngressRootId ?? ""} onChange={(event) => setIngressRootId(event.target.value.length === 0 ? null : parseRootId(event.target.value))} disabled={operationBusy || onlineRoots.length === 0} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                {onlineRoots.map((root) => <option key={root.rootId} value={root.rootId}>{rootLabel(root)}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-lr-text-muted">
              Ingress subfolder
              <input value={ingressRelativePath} onChange={(event) => setIngressRelativePath(event.target.value)} disabled={operationBusy} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" />
            </label>
            <label className="text-[11px] text-lr-text-muted">
              Destination root
              <select value={effectiveDestinationRootId ?? ""} onChange={(event) => setDestinationRootId(event.target.value.length === 0 ? null : parseRootId(event.target.value))} disabled={operationBusy || onlineRoots.length === 0} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                {onlineRoots.map((root) => <option key={root.rootId} value={root.rootId}>{rootLabel(root)}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-lr-text-muted">
              Destination subfolder
              <input value={destinationRelativePath} onChange={(event) => setDestinationRelativePath(event.target.value)} disabled={operationBusy} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" />
            </label>
          </div>
          <label className="block text-[11px] text-lr-text-muted">
            Persisted preset
            <select value={effectivePresetId ?? ""} onChange={(event) => setPresetId(event.target.value.length === 0 ? null : parsePresetId(event.target.value))} disabled={operationBusy || presets.length === 0} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
              <option value="">Choose a saved preset</option>
              {presets.map((preset) => <option key={preset.presetId} value={preset.presetId}>{preset.name}{preset.isDefault ? " · default" : ""}</option>)}
            </select>
          </label>
          {onlineRoots.length === 0 ? <p className="text-[11px] text-amber-300">Link an online root before configuring Auto Import.</p> : null}
          {presets.length === 0 ? <p className="text-[11px] text-amber-300">Create a persisted preset in Manual import first.</p> : null}
        </section>

        <section aria-labelledby="auto-import-policy-title" className="space-y-2">
          <h3 id="auto-import-policy-title" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Policy</h3>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-lr-text-muted">
              Duplicates
              <select value={duplicatePolicy} onChange={(event) => setDuplicatePolicy(event.target.value as typeof duplicatePolicy)} disabled={operationBusy} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                <option value="skip-incoming">Skip incoming</option>
                <option value="keep-both">Keep both</option>
                <option value="continue-unchecked">Continue unchecked</option>
              </select>
            </label>
            <label className="text-[11px] text-lr-text-muted">
              Destination conflicts
              <select value={destinationConflictPolicy} onChange={(event) => setDestinationConflictPolicy(event.target.value as typeof destinationConflictPolicy)} disabled={operationBusy} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text">
                <option value="skip">Skip</option>
                <option value="rename">Rename</option>
                <option value="replace" disabled>Replace · unavailable</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[11px] text-lr-text-muted">Stability ms<input value={stabilityMs} onChange={(event) => setStabilityMs(event.target.value)} disabled={operationBusy} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" /></label>
            <label className="text-[11px] text-lr-text-muted">Max attempts<input value={maxAttempts} onChange={(event) => setMaxAttempts(event.target.value)} disabled={operationBusy} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" /></label>
            <label className="text-[11px] text-lr-text-muted">Retry backoff ms<input value={retryBackoffMs} onChange={(event) => setRetryBackoffMs(event.target.value)} disabled={operationBusy} className="mt-1 w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1.5 text-[11px] text-lr-text" /></label>
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={() => void openCatalogAutoImportIngress().catch((reason) => setError(safeMessage(reason, "Ingress could not be opened.")))} disabled={operationBusy || !configured} className={BUTTON_CLASS}>Open ingress</button>
          <button type="button" onClick={() => void handleConfigure()} disabled={operationBusy || !canConfigure} className={PRIMARY_BUTTON_CLASS}>Configure</button>
          {enabled ? <button type="button" onClick={() => void act(disableCatalogAutoImport, "Auto Import disabled.")} disabled={operationBusy} className={BUTTON_CLASS}>Disable</button> : <button type="button" onClick={() => void act(enableCatalogAutoImport, "Auto Import enabled.")} disabled={operationBusy || !configured} className={BUTTON_CLASS}>Enable</button>}
        </div>

        {status ? (
          <section aria-labelledby="auto-import-status-title" className="rounded border border-lr-border-subtle bg-lr-panel-raised p-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 id="auto-import-status-title" className="text-xs font-medium text-lr-text">Status</h3>
              <span className="text-[10px] text-lr-text-faint">{status.counts.total} queued records</span>
            </div>
            <p className="mt-1 text-[10px] text-lr-text-muted">Queued {status.counts.queued} · Claimed {status.counts.claimed} · Failed {status.counts.failed} · Completed {status.counts.completed} · Cancelled {status.counts.cancelled}</p>
            {status.degraded ? <p className="mt-1 text-[10px] text-amber-300" role="status">Watcher health is degraded; some candidates remain for the next reconciliation.</p> : null}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              {status.paused ? <button type="button" onClick={() => void act(resumeCatalogAutoImport, "Auto Import resumed.")} disabled={operationBusy} className={BUTTON_CLASS}>Resume</button> : <button type="button" onClick={() => void act(pauseCatalogAutoImport, "Auto Import paused.")} disabled={operationBusy} className={BUTTON_CLASS}>Pause</button>}
              <button type="button" onClick={() => void act(retryCatalogAutoImport, "Failed items retried.")} disabled={operationBusy || status.counts.failed === 0} className={BUTTON_CLASS}>Retry failed</button>
              <button type="button" onClick={() => void act(clearCatalogAutoImportFailures, "Failed items cleared.")} disabled={operationBusy || status.counts.failed === 0} className={BUTTON_CLASS}>Clear failed</button>
            </div>
            {status.items.length > 0 ? <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto">{status.items.map((item) => <QueueRow key={item.queueId} item={item} disabled={operationBusy} onCancel={(queueId) => void act(() => cancelCatalogAutoImport(queueId), "Queue item cancelled.")} />)}</ul> : <p className="mt-2 text-[10px] text-lr-text-faint">No queue items.</p>}
          </section>
        ) : null}

        {message ? <p className="text-[11px] text-lr-text-muted" role="status">{message}</p> : null}
        {error ? <p className="text-[11px] text-red-300" role="alert">{error}</p> : null}
      </div>
    </details>
  );
}

function QueueRow({
  item,
  disabled,
  onCancel,
}: {
  readonly item: AutoImportStatusItem;
  readonly disabled: boolean;
  readonly onCancel: (queueId: AutoImportStatusItem["queueId"]) => void;
}) {
  const cancellable = item.state === "queued" || item.state === "claimed";
  return (
    <li className="flex items-center justify-between gap-2 rounded border border-lr-border-subtle px-2 py-1.5 text-[10px]">
      <span className="min-w-0 truncate text-lr-text-muted" title={item.relativePath}>{itemLabel(item)}{item.error ? ` · ${item.error.message}` : ""}</span>
      {cancellable ? <button type="button" onClick={() => onCancel(item.queueId)} disabled={disabled} className={BUTTON_CLASS}>Cancel</button> : null}
    </li>
  );
}
