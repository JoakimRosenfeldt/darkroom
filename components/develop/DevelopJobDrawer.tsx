"use client";

import { useExperimentalTools } from "@/hooks/useExperimentalTools";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { getDarkroomAPI, isElectronApp } from "@/lib/fs/platform";
import type { DevelopJobSnapshot } from "@/lib/develop/v3/jobs";
import { useDevelopJobStore } from "@/stores/develop-job-store";
import { useLibraryStore } from "@/stores/library-store";
import { getVisibleLibraryResult } from "@/lib/library/result-session";
import { createViewerSession, viewerPhotoHref } from "@/lib/viewer/session";

function label(job: DevelopJobSnapshot): string {
  const name = job.request.kind === "generative-remove" ? "Remove, Mock prototype" : `${job.request.kind.replaceAll("-", " ")}, Prototype`;
  if (job.status === "running" || job.status === "postprocess") return `${name}: ${Math.round(job.progress.completed / Math.max(1, job.progress.total) * 100)}%`;
  if (job.status === "failed") return `${name}: ${job.failure.message}`;
  if (job.status === "stale" || job.status === "interrupted") return `${name}: ${job.status}, ${job.reason.replaceAll("-", " ")}`;
  return `${name}: ${job.status.replaceAll("-", " ")}`;
}

function subscribeRuntime(): () => void {
  return () => undefined;
}

export function DevelopJobDrawer() {
  const [experimental] = useExperimentalTools();
  const router = useRouter();
  const jobs = useDevelopJobStore((state) => state.jobs);
  const initialize = useDevelopJobStore((state) => state.initialize);
  const refresh = useDevelopJobStore((state) => state.refresh);
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const available = useSyncExternalStore(subscribeRuntime, isElectronApp, () => false);
  useEffect(() => {
    return available ? initialize() : undefined;
  }, [available, initialize]);
  if (!available) return null;
  const visible = jobs.filter((job) => job.status !== "discarded");
  if (!experimental && !visible.some((job) => job.status === "running" || job.status === "queued" || job.status === "preparing" || job.status === "postprocess" || job.status === "accepting" || job.status === "awaiting-review" || job.status === "interrupted")) return null;
  const openDevelop = (entryId: string): void => {
    const result = getVisibleLibraryResult();
    if (!result.query || !result.entryIds.includes(entryId)) return;
    const session = createViewerSession({ query: result.query, orderedEntryIds: result.viewerEntryIds, activeEntryId: entryId, selectedEntryIds });
    router.push(viewerPhotoHref(entryId, session.id));
  };
  return <details className="fixed bottom-3 right-3 z-[65] w-[min(360px,calc(100vw-24px))] rounded-lg border border-lr-border bg-lr-panel-raised shadow-xl">
    <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold text-lr-text">Prototype jobs ({visible.length})</summary>
    <div className="max-h-72 space-y-2 overflow-auto border-t border-lr-border-subtle p-2">{visible.length === 0 ? <p className="text-[9px] text-lr-text-faint">No prototype jobs.</p> : visible.map((job) => <article key={job.id.value} className="rounded border border-lr-border-subtle p-2">
      <p className="text-[9px] leading-4 text-lr-text-muted">{label(job)}</p>
      {job.status === "awaiting-review" || job.status === "failed" || job.status === "stale" || job.status === "interrupted" ? <p className="text-[9px] text-lr-text-faint">Return to Develop to retry or accept.</p> : null}
      <div className="mt-1 flex gap-1">
        <button type="button" className="text-[9px] text-lr-accent" onClick={() => openDevelop(job.request.source.entryId)}>Open Develop</button>
        {job.status === "queued" || job.status === "preparing" || job.status === "running" || job.status === "postprocess" ? <button type="button" className="text-[9px] text-lr-accent" onClick={() => void getDarkroomAPI().developJobsCancel({ jobId: job.id }).then(refresh)}>Cancel</button> : null}
        {job.status === "awaiting-review" || job.status === "cancelled" || job.status === "failed" || job.status === "interrupted" || job.status === "stale" ? <button type="button" className="text-[9px] text-lr-danger" onClick={() => void getDarkroomAPI().developJobsDiscard({ jobId: job.id }).then(refresh)}>Discard</button> : null}
      </div>
    </article>)}</div>
  </details>;
}
