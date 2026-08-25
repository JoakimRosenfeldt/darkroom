"use client";

import { useMemo, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import type { LibraryEntry } from "@/lib/fs/types";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import { COORDINATE_FRAME_REVISION, type V3SourceSignature } from "@/lib/develop/process";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { DevelopJobIntent } from "@/lib/develop/v3/job-api";
import type { DevelopDocumentRevision, DevelopJobSnapshot } from "@/lib/develop/v3/jobs";
import { createDefaultLocalAdjustments } from "@/lib/develop/v3/local-adjustments";
import { findMaskNode, maskSourceNodes, MAX_LOCAL_MASKS, type LocalMaskV3 } from "@/lib/develop/v3/masking";
import { preparePrototypeImage, developDocumentRevision } from "@/lib/develop/v3/prototype-image";
import { sourceSignaturesEqual } from "@/lib/develop/source-transform";
import { useDevelopJobStore } from "@/stores/develop-job-store";
import { useDevelopStore } from "@/stores/develop-store";
import { useLibraryStore } from "@/stores/library-store";
import { ActionButton } from "./V3PanelControls";

interface Props {
  readonly decoded: DevelopImage;
  readonly document: DevelopDocumentV3;
  readonly entry: LibraryEntry;
}

type Operation = "depth" | "denoise" | "raw-details" | "super-resolution" | "generative-remove";
type ReviewableJob = Extract<DevelopJobSnapshot,
  | { readonly status: "awaiting-review" }
  | { readonly status: "interrupted"; readonly reason: "acceptance-recovery" }
>;

function source(entry: LibraryEntry): V3SourceSignature {
  return { entryId: entry.id, catalogId: entry.catalogId, assetRevision: entry.assetRevision, relativePath: entry.relativePath, size: entry.size, lastModified: entry.lastModified };
}

function currentDocument(entry: LibraryEntry): DevelopDocumentV3 | null {
  const state = useDevelopStore.getState();
  const session = state.sessions[entry.id];
  const document = session?.persistedDocument;
  return state.activeCatalogId === entry.catalogId &&
      state.activeEntryId === entry.id &&
      session?.processKind === "v3" &&
      document?.version === 3
    ? document
    : null;
}

function currentSource(entry: LibraryEntry): V3SourceSignature | null {
  const library = useLibraryStore.getState();
  const liveEntry = library.catalogId === entry.catalogId
    ? library.entries.find((candidate) => candidate.id === entry.id)
    : null;
  return liveEntry ? source(liveEntry) : null;
}

function hasDepthAsset(document: DevelopDocumentV3, assetId: string): boolean {
  return document.local.masks.some((mask) => maskSourceNodes(mask.expression).some((node) =>
    node.source.kind === "depth-range" && node.source.asset.assetId === assetId
  ));
}

async function stableCurrentContext(entry: LibraryEntry): Promise<{
  readonly document: DevelopDocumentV3;
  readonly documentRevision: DevelopDocumentRevision;
  readonly source: V3SourceSignature;
} | null> {
  const document = currentDocument(entry);
  const liveSource = currentSource(entry);
  if (!document || !liveSource) return null;
  const documentRevision = await developDocumentRevision(document);
  const checkedDocument = currentDocument(entry);
  const checkedSource = currentSource(entry);
  return checkedDocument === document && checkedSource && sourceSignaturesEqual(checkedSource, liveSource)
    ? { document, documentRevision, source: liveSource }
    : null;
}

function operationLabel(kind: Operation): string {
  switch (kind) {
    case "depth": return "Depth, Prototype";
    case "denoise": return "Denoise, Prototype";
    case "raw-details": return "Raw Details, Prototype";
    case "super-resolution": return "Super Resolution, Prototype";
    case "generative-remove": return "Remove, Mock prototype";
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}

function processing(status: DevelopJobSnapshot["status"]): boolean {
  return status === "queued" || status === "preparing" || status === "running" ||
    status === "postprocess" || status === "accepting";
}

function cancellable(status: DevelopJobSnapshot["status"]): boolean {
  return status === "queued" || status === "preparing" || status === "running" || status === "postprocess";
}

function discardable(status: DevelopJobSnapshot["status"]): boolean {
  return status === "awaiting-review" || status === "cancelled" ||
    status === "failed" || status === "stale" || status === "interrupted";
}

function statusText(job: DevelopJobSnapshot): string {
  switch (job.status) {
    case "running": case "postprocess": return `${job.status}, ${Math.round(job.progress.completed / Math.max(1, job.progress.total) * 100)}%`;
    case "failed": return `${job.failure.message} Recovery: ${job.failure.recovery}.`;
    case "stale": return `Stale: ${job.reason.replaceAll("-", " ")}.`;
    case "interrupted": return `Interrupted: ${job.reason.replaceAll("-", " ")}.`;
    default: return job.status.replaceAll("-", " ");
  }
}

export function PrototypeOperations({ decoded, document, entry }: Props) {
  const jobs = useDevelopJobStore((state) => state.jobs);
  const refresh = useDevelopJobStore((state) => state.refresh);
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const selectedNodeId = useDevelopStore((state) => {
    const id = state.activeEntryId;
    return id ? state.sessions[id]?.ui.selectedComponentId ?? null : null;
  });
  const selectedMaskId = useDevelopStore((state) => {
    const id = state.activeEntryId;
    return id ? state.sessions[id]?.ui.selectedMaskId ?? null : null;
  });
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, string>>({});
  const [removeConsent, setRemoveConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const entryJobs = useMemo(() => jobs.filter((job) => job.request.source.entryId === entry.id && job.request.source.catalogId === entry.catalogId), [entry.catalogId, entry.id, jobs]);
  const selectedMask = document.local.masks.find((mask) => mask.id === selectedMaskId) ?? null;
  const selectedNode = selectedMask && selectedNodeId ? findMaskNode(selectedMask.expression, selectedNodeId) : null;
  const selection = selectedNode?.kind === "source" && selectedNode.source.kind === "ai-matte" ? selectedNode.source.asset : null;

  const connectDepthAsset = async (asset: Extract<DevelopJobSnapshot, { readonly status: "accepted" }>["assets"][number], jobSource: V3SourceSignature, jobDocumentRevision: DevelopDocumentRevision): Promise<void> => {
    if (asset.kind !== "depth-map") return;
    const current = await stableCurrentContext(entry);
    if (!current || !sourceSignaturesEqual(current.source, jobSource) || current.documentRevision.value !== jobDocumentRevision.value) {
      setMessage("Depth artifact accepted. Return to its unchanged source photo and document revision to connect the mask.");
      return;
    }
    const latest = current.document;
    if (hasDepthAsset(latest, asset.assetId)) {
      setMessage("Depth artifact is already connected to this document.");
      return;
    }
    if (latest.local.masks.length >= MAX_LOCAL_MASKS) {
      setMessage(`Depth cannot be connected until the document is below the ${MAX_LOCAL_MASKS}-mask limit.`);
      return;
    }
    const mask: LocalMaskV3 = { id: crypto.randomUUID(), name: "Depth Range, Prototype", enabled: true, expression: { kind: "source", id: crypto.randomUUID(), enabled: true, source: { kind: "depth-range", asset, source: jobSource, minimum: 0.25, maximum: 0.75, feather: 0.1, algorithm: "prototype-depth-map-v1" } }, adjustments: createDefaultLocalAdjustments() };
    dispatch({ kind: "replace-v3-semantic-group", group: "local", value: { ...latest.local, masks: [...latest.local.masks, mask], maskAssetRefs: [...latest.local.maskAssetRefs.filter((reference) => reference.assetId !== asset.assetId), asset] } }, "Connect Prototype Depth");
    setMessage(hasDepthAsset(currentDocument(entry) ?? latest, asset.assetId)
      ? "Depth artifact connected as a new Depth Range mask."
      : "Depth artifact accepted, but document integration is still pending.");
  };

  const intent = async (operation: Operation, current: NonNullable<Awaited<ReturnType<typeof stableCurrentContext>>>, previous?: DevelopJobSnapshot): Promise<DevelopJobIntent> => {
    const { document: latest, documentRevision, source: liveSource } = current;
    const base = { source: liveSource, documentRevision };
    switch (operation) {
      case "depth": return { ...base, kind: "depth" };
      case "denoise": return { ...base, kind: "denoise", strength: previous?.request.kind === "denoise" ? previous.request.strength : 45 };
      case "raw-details": return { ...base, kind: "raw-details", amount: previous?.request.kind === "raw-details" ? previous.request.amount : 40 };
      case "super-resolution": return { ...base, kind: "super-resolution", scale: 2 };
      case "generative-remove": {
        const latestMask = latest.local.masks.find((mask) => mask.id === selectedMaskId) ?? null;
        const latestNode = latestMask && selectedNodeId ? findMaskNode(latestMask.expression, selectedNodeId) : null;
        const latestSelection = latestNode?.kind === "source" && latestNode.source.kind === "ai-matte"
          ? latestNode.source.asset
          : null;
        if (!latestSelection || !removeConsent) throw new Error("Select an accepted Subject or Sky mask and confirm local mock consent.");
        const seed = previous?.request.kind === "generative-remove" ? previous.request.seed : 1;
        const searchRadius = previous?.request.kind === "generative-remove" ? previous.request.searchRadius : 24;
        const receipt = await getDarkroomAPI().developJobsGrantGenerativeRemoveConsent({ source: base.source, selection: latestSelection, seed, searchRadius });
        return { ...base, kind: "generative-remove", selection: latestSelection, consentReceiptId: receipt.id, seed, searchRadius };
      }
      default: { const exhaustive: never = operation; return exhaustive; }
    }
  };

  const run = async (operation: Operation, retry?: DevelopJobSnapshot): Promise<void> => {
    if (!isElectronApp()) return;
    setBusy(retry ? retry.id.value : operation);
    setMessage(null);
    try {
      const current = await stableCurrentContext(entry);
      if (!current || !sourceSignaturesEqual(current.source, source(entry))) {
        throw new Error("The source photo or active document changed. Return to Develop and try again.");
      }
      const requestIntent = await intent(operation, current, retry);
      const image = await preparePrototypeImage(decoded, operation);
      if (retry) await getDarkroomAPI().developJobsRetry({ jobId: retry.id, intent: requestIntent, image });
      else await getDarkroomAPI().developJobsStart({ intent: requestIntent, image });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Prototype operation failed.");
    } finally {
      setBusy(null);
    }
  };

  const accept = async (job: ReviewableJob): Promise<void> => {
    const current = await stableCurrentContext(entry);
    if (!current || !sourceSignaturesEqual(current.source, job.request.source)) {
      setMessage("Acceptance is pending because the source photo or active document changed.");
      return;
    }
    const latest = current.document;
    if (job.request.kind === "depth" && latest.local.masks.length >= MAX_LOCAL_MASKS) {
      setMessage(`Depth cannot be accepted until the document is below the ${MAX_LOCAL_MASKS}-mask limit.`);
      return;
    }
    const candidateId = selectedCandidates[job.id.value] ?? job.candidates[0].candidateId;
    setBusy(job.id.value);
    try {
      const result = await getDarkroomAPI().developJobsAccept({ jobId: job.id, currentSource: current.source, currentDocumentRevision: current.documentRevision, currentFrameRevision: { kind: "coordinate-frame-revision", value: COORDINATE_FRAME_REVISION }, candidateIds: [candidateId] });
      const accepted = result.job.assets[0];
      if (job.request.kind === "depth" && accepted?.kind === "depth-map") {
        await connectDepthAsset(accepted, job.request.source, job.request.documentRevision);
      } else {
        setMessage("Artifact accepted. Source-variant and repair rendering remain placeholders, so exported pixels do not include it yet.");
      }
      await refresh();
    } catch (error) {
      setMessage(`Artifact acceptance remains pending. ${error instanceof Error ? error.message : "Document update failed."}`);
    } finally { setBusy(null); }
  };

  return <section className="border-b border-lr-border-subtle px-3 py-3" aria-label="Prototype operations">
    <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Prototype operations</h3>
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      {(["depth", "denoise", "raw-details", "super-resolution"] as const).map((operation) => <ActionButton key={operation} disabled={busy !== null || entryJobs.some((job) => job.request.kind === operation && processing(job.status))} onClick={() => void run(operation)}>{operationLabel(operation)}</ActionButton>)}
    </div>
    <label className="mt-2 flex items-start gap-2 text-[9px] leading-4 text-lr-text-faint"><input type="checkbox" checked={removeConsent} onChange={(event) => setRemoveConsent(event.target.checked)} className="mt-0.5 accent-lr-accent" />I consent to this local Mock prototype. No image leaves this computer. Consent binds this selected mask and intent for 15 minutes.</label>
    <ActionButton disabled={busy !== null || !selection || !removeConsent} onClick={() => void run("generative-remove")}>Remove, Mock prototype</ActionButton>
    {!selection ? <p className="mt-1 text-[9px] text-lr-text-faint">Select an accepted Subject or Sky mask source to enable Remove.</p> : null}
    <div className="mt-3 space-y-2">{entryJobs.map((job) => <article key={job.id.value} className="rounded border border-lr-border-subtle p-2 text-[9px] text-lr-text-muted">
      <div className="flex justify-between gap-2"><strong>{operationLabel(job.request.kind)}</strong><span>{statusText(job)}</span></div>
      {job.status === "awaiting-review" || (job.status === "interrupted" && job.reason === "acceptance-recovery") ? <><label className="mt-1 block">Candidate<select value={selectedCandidates[job.id.value] ?? job.candidates[0].candidateId} onChange={(event) => setSelectedCandidates((current) => ({ ...current, [job.id.value]: event.target.value }))} className="ml-2 rounded border border-lr-border-subtle bg-lr-panel px-1 py-0.5">{job.candidates.map((candidate) => <option key={candidate.candidateId} value={candidate.candidateId}>{candidate.candidateId}</option>)}</select></label><p className="mt-1 text-lr-text-faint">Staged candidates are not readable, so no visual preview is shown.</p><ActionButton disabled={busy !== null} onClick={() => void accept(job)}>{job.status === "awaiting-review" ? "Accept selected" : "Complete acceptance"}</ActionButton></> : null}
      {(job.status === "failed" || job.status === "stale" || job.status === "cancelled" || (job.status === "interrupted" && job.reason !== "acceptance-recovery")) ? <ActionButton disabled={busy !== null} onClick={() => void run(job.request.kind, job)}>Retry with current pixels</ActionButton> : null}
      {job.status === "accepted" && job.request.kind === "depth" && job.assets[0]?.kind === "depth-map" && !hasDepthAsset(document, job.assets[0].assetId) ? <ActionButton disabled={busy !== null} onClick={() => void connectDepthAsset(job.assets[0], job.request.source, job.request.documentRevision)}>Connect depth mask</ActionButton> : null}
      {cancellable(job.status) ? <ActionButton onClick={() => void getDarkroomAPI().developJobsCancel({ jobId: job.id }).then(refresh)}>Cancel</ActionButton> : null}
      {discardable(job.status) ? <ActionButton onClick={() => void getDarkroomAPI().developJobsDiscard({ jobId: job.id }).then(refresh)}>Discard</ActionButton> : null}
    </article>)}</div>
    {message ? <p role="status" className="mt-2 text-[9px] text-lr-text-faint">{message}</p> : null}
  </section>;
}
