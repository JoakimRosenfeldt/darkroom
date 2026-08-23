"use client";

import { useState } from "react";
import type { AssetId } from "@/lib/catalog/ids";
import type {
  RelinkAcceptedPairInput,
  RelinkServiceDraft,
  RelinkSuggestion,
} from "@/lib/catalog/relink";
import {
  applyCatalogRelink,
  cancelCatalogRelink,
  prepareCatalogRelink,
} from "@/lib/fs/session-catalog";
import { useLibraryStore } from "@/stores/library-store";

const BUTTON_CLASS = "rounded border border-lr-border-subtle px-2.5 py-1.5 text-xs text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40";

function relinkError(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "Relink files failed.";
  }
  if (error.message.length > 240 || error.message.includes("/") || error.message.includes("\\")) {
    return "Relink files failed.";
  }
  return error.message;
}

function rankLabel(rank: RelinkSuggestion["rank"]): string {
  switch (rank) {
    case "exact-sha256": return "Exact hash";
    case "local-file-identity": return "Local identity";
    case "relative-observation": return "Path and observation";
    case "filename-size": return "Filename and size";
    case null: return "No ranked match";
  }
}

function candidatePath(draft: RelinkServiceDraft, candidateId: string): string | null {
  return draft.candidates.find((candidate) => candidate.candidateId === candidateId)?.relativePath ?? null;
}

function selectedPair(
  pairs: readonly RelinkAcceptedPairInput[],
  assetId: AssetId,
): RelinkAcceptedPairInput | undefined {
  return pairs.find((pair) => pair.assetId === assetId);
}

export function CatalogAssetRelink({ disabled }: { disabled: boolean }) {
  const catalogId = useLibraryStore((state) => state.catalogId);
  const sessionId = useLibraryStore((state) => state.sessionId);
  const unresolvedCount = useLibraryStore((state) => state.unresolvedEntries.length);
  const [draft, setDraft] = useState<RelinkServiceDraft | null>(null);
  const [acceptedPairs, setAcceptedPairs] = useState<readonly RelinkAcceptedPairInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (catalogId === null || sessionId === null || unresolvedCount === 0) return null;

  const operationDisabled = disabled || busy;

  async function handlePrepare(): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await prepareCatalogRelink();
      if (next === null) {
        setStatus("Relink cancelled.");
        return;
      }
      setDraft(next);
      setAcceptedPairs([]);
      setStatus(null);
    } catch (reason) {
      setError(relinkError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(): Promise<void> {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await applyCatalogRelink(draft.operationId, acceptedPairs);
      setDraft(null);
      setAcceptedPairs([]);
      setStatus(result.appliedMutations === 0
        ? "No relinks were applied."
        : `${result.appliedMutations} relink${result.appliedMutations === 1 ? "" : "s"} applied.`);
    } catch (reason) {
      setError(relinkError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      await cancelCatalogRelink(draft.operationId);
      setDraft(null);
      setAcceptedPairs([]);
      setStatus("Relink cancelled.");
    } catch (reason) {
      setError(relinkError(reason));
    } finally {
      setBusy(false);
    }
  }

  function chooseCandidate(assetId: AssetId, candidateId: string): void {
    setAcceptedPairs((current) => [
      ...current.filter((pair) => pair.assetId !== assetId),
      { assetId, candidateId },
    ]);
  }

  return (
    <section aria-labelledby="catalog-asset-relink-title" className="rounded-lg border border-lr-border-subtle bg-lr-panel px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="catalog-asset-relink-title" className="text-xs font-medium text-lr-text">Relink files</h3>
          <p className="mt-1 text-[11px] leading-4 text-lr-text-faint">
            Choose missing files from the active catalog roots. Exact SHA-256 matches are selected automatically.
          </p>
        </div>
        {draft === null ? (
          <button type="button" onClick={() => void handlePrepare()} disabled={operationDisabled} className={BUTTON_CLASS}>
            {busy ? "Opening…" : "Choose files"}
          </button>
        ) : null}
      </div>

      {draft !== null ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-lr-text-faint">
            <span>{draft.preselectedPairs.length} exact match{draft.preselectedPairs.length === 1 ? "" : "es"} selected</span>
            <span>{draft.unresolvedAssetCount} need review</span>
            {draft.ambiguousAssetCount > 0 ? <span>{draft.ambiguousAssetCount} ambiguous</span> : null}
            <span>Expires {new Date(draft.expiresAt).toLocaleTimeString()}</span>
          </div>

          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {draft.missingAssets.map((asset) => {
              const suggestion = draft.suggestions.find((item) => item.assetId === asset.assetId);
              if (suggestion === undefined) return null;
              const automatic = suggestion.preselectedCandidateId !== null;
              const selected = selectedPair(acceptedPairs, asset.assetId)?.candidateId ?? "";
              return (
                <li key={asset.assetId} className="rounded border border-lr-border-subtle bg-lr-panel-raised px-2.5 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate text-xs text-lr-text" title={asset.relativePath}>{asset.relativePath}</p>
                    <span className="shrink-0 text-[10px] text-lr-text-faint">{rankLabel(suggestion.rank)}</span>
                  </div>
                  {automatic ? (
                    <p className="mt-1 truncate text-[11px] text-emerald-300" title={candidatePath(draft, suggestion.preselectedCandidateId) ?? undefined}>
                      Exact match · {candidatePath(draft, suggestion.preselectedCandidateId) ?? "candidate unavailable"}
                    </p>
                  ) : suggestion.candidateIds.length > 0 ? (
                    <fieldset className="mt-1 space-y-1">
                      <legend className="sr-only">Choose a candidate for {asset.relativePath}</legend>
                      {suggestion.candidateIds.map((candidateId) => {
                        const pathValue = candidatePath(draft, candidateId);
                        if (pathValue === null) return null;
                        return (
                          <label key={candidateId} className="flex min-w-0 items-start gap-2 text-[11px] text-lr-text-muted">
                            <input
                              type="radio"
                              name={`relink-${asset.assetId}`}
                              value={candidateId}
                              checked={selected === candidateId}
                              onChange={() => chooseCandidate(asset.assetId, candidateId)}
                              disabled={operationDisabled}
                              className="mt-0.5 accent-lr-accent"
                            />
                            <span className="min-w-0 truncate" title={pathValue}>{pathValue}</span>
                          </label>
                        );
                      })}
                    </fieldset>
                  ) : (
                    <p className="mt-1 text-[11px] text-lr-text-faint">No candidate matched this asset.</p>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => void handleCancel()} disabled={operationDisabled} className={BUTTON_CLASS}>Cancel</button>
            <button type="button" onClick={() => void handleApply()} disabled={operationDisabled} className="rounded bg-lr-accent px-2.5 py-1.5 text-xs text-white transition hover:bg-lr-accent/90 disabled:opacity-40">
              {busy ? "Applying…" : "Apply relinks"}
            </button>
          </div>
        </div>
      ) : null}

      {status ? <p className="mt-2 text-[11px] text-lr-text-muted" role="status">{status}</p> : null}
      {error ? <p className="mt-2 text-[11px] text-red-300" role="alert">{error}</p> : null}
    </section>
  );
}
