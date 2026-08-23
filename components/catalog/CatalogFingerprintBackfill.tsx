"use client";

import { useEffect, useState } from "react";
import {
  cancelFingerprintBackfill,
  getFingerprintBackfillStatus,
  recoverFingerprintBackfill,
  refreshActiveCatalog,
  resumeFingerprintBackfill,
  startFingerprintBackfill,
  subscribeFingerprintBackfillProgress,
} from "@/lib/fs/session-catalog";
import type { CatalogFingerprintBackfillProgress } from "@/lib/catalog/fingerprint-backfill";
import { useLibraryStore } from "@/stores/library-store";

function isRunning(progress: CatalogFingerprintBackfillProgress | null): boolean {
  return progress?.state === "planned" || progress?.state === "running";
}

function progressLabel(progress: CatalogFingerprintBackfillProgress): string {
  if (progress.state === "cancelled") return `Cancelled · ${progress.processed}/${progress.total} checked`;
  if (progress.state === "completed") return `Complete · ${progress.indexed}/${progress.total} indexed`;
  return `${progress.processed}/${progress.total} checked`;
}

export function CatalogFingerprintBackfill({ disabled }: { disabled: boolean }) {
  const catalogId = useLibraryStore((state) => state.catalogId);
  const sessionId = useLibraryStore((state) => state.sessionId);
  const coverage = useLibraryStore((state) => state.fingerprintCoverage);
  const [progress, setProgress] = useState<CatalogFingerprintBackfillProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (catalogId === null || sessionId === null) return;
    let cancelled = false;
    const unsubscribe = subscribeFingerprintBackfillProgress((next) => {
      if (next.catalogId !== catalogId || next.sessionId !== sessionId) return;
      setProgress(next);
      setBusy(isRunning(next));
      if (!isRunning(next)) void refreshActiveCatalog().catch(() => undefined);
    });
    void getFingerprintBackfillStatus().then(async (status) => {
      if (cancelled) return;
      setProgress(status);
      if (!isRunning(status)) return;
      setBusy(true);
      const recovered = await recoverFingerprintBackfill();
      if (cancelled) return;
      setProgress(recovered);
      setBusy(isRunning(recovered));
      if (!isRunning(recovered)) await refreshActiveCatalog();
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setBusy(false);
        setError(reason instanceof Error ? reason.message : "Fingerprint status is unavailable.");
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [catalogId, sessionId]);

  if (catalogId === null || sessionId === null) return null;

  const retryable = progress !== null && (
    progress.state === "cancelled" ||
    progress.failed > 0 ||
    progress.stale > 0 ||
    progress.unchecked > 0 ||
    progress.remaining > 0
  );
  const actionDisabled = disabled || busy || coverage.total === 0;

  async function run(action: () => Promise<CatalogFingerprintBackfillProgress>) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setProgress(next);
      await refreshActiveCatalog();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Fingerprint backfill failed.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (progress === null) return;
    setError(null);
    try {
      await cancelFingerprintBackfill(progress.operationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Fingerprint cancellation failed.");
    }
  }

  return (
    <section className="rounded-lg border border-lr-border-subtle bg-lr-panel px-3 py-2.5" aria-labelledby="catalog-fingerprints-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="catalog-fingerprints-title" className="text-xs font-medium text-lr-text">File fingerprints</h3>
          <p className="mt-0.5 text-[11px] text-lr-text-faint">
            {coverage.valid}/{coverage.total} indexed · {coverage.missing} missing · {coverage.stale} stale · {coverage.failed} failed
          </p>
        </div>
        {busy && progress ? (
          <button
            type="button"
            onClick={() => void cancel()}
            className="rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text"
          >
            Cancel
          </button>
        ) : retryable && progress ? (
          <button
            type="button"
            onClick={() => void run(() => resumeFingerprintBackfill(progress.operationId))}
            disabled={actionDisabled}
            className="rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
          >
            Retry unresolved
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void run(startFingerprintBackfill)}
            disabled={actionDisabled || coverage.valid === coverage.total}
            className="rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40"
          >
            Build fingerprints
          </button>
        )}
      </div>
      {progress ? <p className="mt-2 text-[11px] text-lr-text-muted" role="status">{progressLabel(progress)}</p> : null}
      {error ? <p className="mt-2 text-[11px] text-red-400" role="alert">{error}</p> : null}
      <p className="mt-2 text-[10px] leading-4 text-lr-text-faint">
        Fingerprints resume safely and improve duplicate detection and exact file relinking.
      </p>
    </section>
  );
}
