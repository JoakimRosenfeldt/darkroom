"use client";

import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  CatalogAdminBackupResult,
  CatalogAdminCloneResult,
  CatalogAdminInspectReport,
  CatalogAdminOptimizePreview,
  CatalogAdminOptimizeResult,
  CatalogBackupPolicy,
  CatalogBackupPolicyState,
} from "@/lib/catalog/admin";
import type { CatalogId } from "@/lib/catalog/ids";
import {
  backupCatalogAdmin,
  exportCatalogAdmin,
  getCatalogAdminBackupPolicy,
  importCatalogAdminAsNew,
  inspectCatalogAdmin,
  optimizeCatalogAdmin,
  previewCatalogAdminOptimize,
  runCatalogAdminScheduledBackup,
  setCatalogAdminBackupPolicy,
  validateCatalogAdminPackage,
} from "@/lib/fs/session-catalog";
import { useLibraryStore } from "@/stores/library-store";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;
const ADMIN_BUTTON_CLASS = "rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted transition hover:bg-lr-panel-hover hover:text-lr-text disabled:opacity-40";
const ADMIN_DANGER_BUTTON_CLASS = "rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-300 transition hover:bg-red-500/10 disabled:opacity-40";
const ADMIN_NOTE_CLASS = "mt-1 text-[11px] leading-4 text-lr-text-faint";
const ADMIN_RESULT_CLASS = "mt-2 rounded border border-lr-border-subtle bg-lr-panel px-2.5 py-2 text-[11px]";

type ScheduleChoice = "off" | "daily" | "weekly";

function adminError(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "Catalog administration failed.";
  }
  if (error.message.length > 240 || error.message.includes("/") || error.message.includes("\\")) {
    return "Catalog administration failed.";
  }
  return error.message;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

function checksumPrefix(value: string): string {
  return value.slice(0, 12);
}

function scheduleChoice(policy: CatalogBackupPolicyState): ScheduleChoice {
  if (policy.policy.schedule.kind === "off") return "off";
  return policy.policy.schedule.intervalMs >= WEEK_MS ? "weekly" : "daily";
}

function orphanTotal(preview: CatalogAdminOptimizePreview): number {
  return Object.values(preview.provenOrphanCounts).reduce((sum, count) => sum + count, 0);
}

export function CatalogAdministration({ disabled }: { disabled: boolean }) {
  const catalogId = useLibraryStore((state) => state.catalogId);
  const sessionId = useLibraryStore((state) => state.sessionId);
  const refreshCatalogs = useLibraryStore((state) => state.refreshCatalogs);
  const bootstrapLibrary = useLibraryStore((state) => state.bootstrapLibrary);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<CatalogAdminInspectReport | null>(null);
  const [packageInspection, setPackageInspection] = useState<CatalogAdminInspectReport | null>(null);
  const [backup, setBackup] = useState<CatalogAdminBackupResult | null>(null);
  const [scheduledBackup, setScheduledBackup] = useState<CatalogAdminBackupResult | null>(null);
  const [exported, setExported] = useState<CatalogAdminBackupResult | null>(null);
  const [clone, setClone] = useState<CatalogAdminCloneResult | null>(null);
  const [preview, setPreview] = useState<CatalogAdminOptimizePreview | null>(null);
  const [previewCatalogId, setPreviewCatalogId] = useState<CatalogId | null>(null);
  const [optimized, setOptimized] = useState<CatalogAdminOptimizeResult | null>(null);
  const [importName, setImportName] = useState("");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policy, setPolicy] = useState<CatalogBackupPolicyState | null>(null);
  const [policyCatalogId, setPolicyCatalogId] = useState<CatalogId | null>(null);
  const [schedule, setSchedule] = useState<ScheduleChoice>("off");
  const [retention, setRetention] = useState("3");

  const activeDisabled = disabled || busy || policyLoading || catalogId === null || sessionId === null;
  const anyDisabled = disabled || busy || policyLoading;

  useEffect(() => {
    if (!policyOpen || catalogId === null || sessionId === null) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setPolicyLoading(true);
      return getCatalogAdminBackupPolicy();
    }).then((next) => {
      if (cancelled) return;
      setPolicy(next);
      setPolicyCatalogId(catalogId);
      setSchedule(scheduleChoice(next));
      setRetention(String(next.policy.retentionCount));
      setPolicyLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setPolicyLoading(false);
      setError(adminError(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [catalogId, policyOpen, sessionId]);

  async function execute<T>(
    task: () => Promise<T>,
    onSuccess: (value: T) => Promise<void> | void,
  ): Promise<void> {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const value = await task();
      await onSuccess(value);
    } catch (reason) {
      setError(adminError(reason));
    } finally {
      setBusy(false);
    }
  }

  function handleAdminToggle(event: SyntheticEvent<HTMLDetailsElement>): void {
    setPolicyOpen(event.currentTarget.open);
  }

  async function handleInspect(): Promise<void> {
    await execute(inspectCatalogAdmin, (next) => {
      setInspection(next);
      setStatus("Catalog inspection complete.");
    });
  }

  async function handleBackup(): Promise<void> {
    await execute(backupCatalogAdmin, (next) => {
      setBackup(next);
      setStatus("Backup created.");
    });
  }

  async function handleExport(): Promise<void> {
    await execute(exportCatalogAdmin, (next) => {
      if (next === null) {
        setStatus("Export cancelled.");
        return;
      }
      setExported(next);
      setStatus("Catalog package exported.");
    });
  }

  async function handleValidate(): Promise<void> {
    await execute(validateCatalogAdminPackage, (next) => {
      if (next === null) {
        setStatus("Package validation cancelled.");
        return;
      }
      setPackageInspection(next);
      setStatus("Package validation complete.");
    });
  }

  async function handleImport(): Promise<void> {
    const name = importName.trim();
    if (!name) return;
    await execute(
      () => importCatalogAdminAsNew(name),
      async (next) => {
        if (next === null) {
          setStatus("Import cancelled.");
          return;
        }
        setClone(next);
        setImportName("");
        await refreshCatalogs();
        setStatus("Catalog imported as a new recent catalog.");
      },
    );
  }

  async function handlePreviewOptimize(): Promise<void> {
    await execute(previewCatalogAdminOptimize, (next) => {
      setPreview(next);
      setPreviewCatalogId(catalogId);
      setOptimized(null);
      setStatus("Optimization preview ready. Confirm to continue.");
    });
  }

  async function handleOptimize(): Promise<void> {
    if (preview === null || previewCatalogId !== catalogId) return;
    await execute(optimizeCatalogAdmin, async (next) => {
      setOptimized(next);
      setPreview(null);
      setPreviewCatalogId(null);
      await bootstrapLibrary();
      setStatus("Catalog optimized and reloaded.");
    });
  }

  async function handleSavePolicy(): Promise<void> {
    const count = Number.parseInt(retention, 10);
    if (!/^\d+$/.test(retention) || !Number.isSafeInteger(count) || count < 1 || count > 100) {
      setError("Retention must be between 1 and 100 backups.");
      return;
    }
    const nextPolicy: CatalogBackupPolicy = {
      schedule: schedule === "off"
        ? { kind: "off" }
        : { kind: "interval", intervalMs: schedule === "weekly" ? WEEK_MS : DAY_MS },
      retentionCount: count,
    };
    await execute(
      () => setCatalogAdminBackupPolicy(nextPolicy),
      (next) => {
        setPolicy(next);
        setPolicyCatalogId(catalogId);
        setStatus("Backup schedule saved.");
      },
    );
  }

  async function handleRunScheduled(): Promise<void> {
    await execute(runCatalogAdminScheduledBackup, (next) => {
      if (next === null) {
        setStatus("No scheduled backup is due.");
        return;
      }
      setScheduledBackup(next);
      setStatus("Scheduled backup created.");
    });
  }

  return (
    <details className="rounded-lg border border-lr-border-subtle bg-lr-panel px-3 py-2.5">
      <summary className="cursor-pointer text-xs font-medium text-lr-text">Catalog Administration</summary>
      <div className="mt-3 space-y-4">
        <p className="text-[11px] leading-4 text-lr-text-faint">
          Merge and Replace restore are not available; import opens as a new catalog.
        </p>

        <section aria-labelledby="catalog-admin-inspection">
          <h3 id="catalog-admin-inspection" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Inspect and backup</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void handleInspect()} disabled={activeDisabled} className={ADMIN_BUTTON_CLASS}>Inspect</button>
            <button type="button" onClick={() => void handleBackup()} disabled={activeDisabled} className={ADMIN_BUTTON_CLASS}>Backup</button>
            <button type="button" onClick={() => void handleExport()} disabled={activeDisabled} className={ADMIN_BUTTON_CLASS}>Export package</button>
            <button type="button" onClick={() => void handleValidate()} disabled={anyDisabled} className={ADMIN_BUTTON_CLASS}>Validate package</button>
          </div>
          {inspection ? <InspectionSummary label="Catalog" report={inspection} /> : null}
          {packageInspection ? <InspectionSummary label="Package" report={packageInspection} /> : null}
          {backup ? <BackupSummary label="Backup" result={backup} /> : null}
          {exported ? <BackupSummary label="Export" result={exported} /> : null}
          {scheduledBackup ? <BackupSummary label="Scheduled backup" result={scheduledBackup} /> : null}
        </section>

        <section aria-labelledby="catalog-admin-import">
          <h3 id="catalog-admin-import" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Import as new</h3>
          <div className="mt-2 flex gap-2">
            <input
              value={importName}
              maxLength={512}
              onChange={(event) => setImportName(event.target.value)}
              aria-label="Imported catalog name"
              placeholder="New catalog name"
              className="min-w-0 flex-1 rounded-md border border-lr-border-subtle bg-lr-panel px-2.5 py-1.5 text-xs text-lr-text outline-none focus:border-lr-accent disabled:opacity-40"
              disabled={anyDisabled}
            />
            <button type="button" onClick={() => void handleImport()} disabled={anyDisabled || !importName.trim()} className={ADMIN_BUTTON_CLASS}>Import</button>
          </div>
          {clone ? <p className={ADMIN_NOTE_CLASS}>Imported “{clone.displayName}” · {clone.rootCount} roots · {clone.assetCount} assets.</p> : null}
        </section>

        <section aria-labelledby="catalog-admin-optimize">
          <h3 id="catalog-admin-optimize" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-faint">Optimize</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void handlePreviewOptimize()} disabled={activeDisabled} className={ADMIN_BUTTON_CLASS}>Preview optimize</button>
            {preview && previewCatalogId === catalogId ? <button type="button" onClick={() => void handleOptimize()} disabled={activeDisabled} className={ADMIN_DANGER_BUTTON_CLASS}>Confirm optimize</button> : null}
          </div>
          {preview && previewCatalogId === catalogId ? <OptimizePreview preview={preview} /> : null}
          {optimized ? <p className={ADMIN_NOTE_CLASS}>Optimized database: {formatBytes(optimized.compactByteLength)} · checksum {checksumPrefix(optimized.compactSha256)}.</p> : null}
        </section>

        <details className="border-t border-lr-border-subtle pt-3" onToggle={handleAdminToggle}>
          <summary className="cursor-pointer text-xs text-lr-text">Scheduled backup</summary>
          <div className="mt-2 space-y-2">
            {catalogId === null || sessionId === null ? (
              <p className={ADMIN_NOTE_CLASS}>Open a catalog to configure scheduled backups.</p>
            ) : policyLoading ? (
              <p className={ADMIN_NOTE_CLASS}>Loading backup policy…</p>
            ) : policy === null || policyCatalogId !== catalogId ? (
              <p className={ADMIN_NOTE_CLASS}>Backup policy is unavailable.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-[11px] text-lr-text-muted">
                    Schedule
                    <select value={schedule} onChange={(event) => setSchedule(event.target.value as ScheduleChoice)} disabled={activeDisabled} className="rounded border border-lr-border-subtle bg-lr-panel px-2 py-1 text-[11px] text-lr-text">
                      <option value="off">Off</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-[11px] text-lr-text-muted">
                    Retain
                    <input type="number" min={1} max={100} value={retention} onChange={(event) => setRetention(event.target.value)} disabled={activeDisabled} aria-label="Backup retention count" className="w-16 rounded border border-lr-border-subtle bg-lr-panel px-2 py-1 text-[11px] text-lr-text" />
                  </label>
                  <button type="button" onClick={() => void handleSavePolicy()} disabled={activeDisabled} className={ADMIN_BUTTON_CLASS}>Save</button>
                  <button type="button" onClick={() => void handleRunScheduled()} disabled={activeDisabled} className={ADMIN_BUTTON_CLASS}>Run due backup</button>
                </div>
                {policy.lastSuccessAt !== null ? <p className={ADMIN_NOTE_CLASS}>Last successful backup: {formatDate(policy.lastSuccessAt)}.</p> : null}
                {policy.lastFailureMessage ? <p className={`${ADMIN_NOTE_CLASS} text-red-300`}>The last scheduled backup failed.</p> : null}
              </>
            )}
          </div>
        </details>

        {status ? <p className="text-xs text-lr-text-muted" role="status">{status}</p> : null}
        {error ? <p className="text-xs text-red-400" role="alert">{error}</p> : null}
        {busy ? <p className="text-xs text-lr-text-faint" role="status">Working…</p> : null}
      </div>
    </details>
  );
}

function InspectionSummary({
  label,
  report,
}: {
  label: string;
  report: CatalogAdminInspectReport;
}) {
  const counts = report.counts;
  return (
    <div className={ADMIN_RESULT_CLASS} aria-label={`${label} inspection result`}>
      <p className={report.clean ? "text-emerald-300" : "text-red-300"}>{report.clean ? `${label} clean` : `${label} has errors`}</p>
      <p className={ADMIN_NOTE_CLASS}>Schema {report.schemaVersion ?? "unknown"} · {formatBytes(report.sourceByteLength)} · checksum {checksumPrefix(report.sourceSha256)}</p>
      <p className={ADMIN_NOTE_CLASS}>{counts.assets} assets · {counts.present} present · {counts.missing} missing · {counts.albums} albums · {counts.fingerprints} fingerprints</p>
      <p className={ADMIN_NOTE_CLASS}>Roots: {report.roots.length > 0 ? report.roots.map((root) => root.label).join(", ") : "none"}</p>
      {!report.clean ? <p className={`${ADMIN_NOTE_CLASS} text-red-300`}>{report.blockingErrors.length} blocking issue(s); details stay in the native report.</p> : null}
    </div>
  );
}

function BackupSummary({
  label,
  result,
}: {
  label: string;
  result: CatalogAdminBackupResult;
}) {
  return <p className={ADMIN_NOTE_CLASS}>{label} created {formatDate(result.createdAt)} · {formatBytes(result.byteLength)} · checksum {checksumPrefix(result.packageSha256)}.</p>;
}

function OptimizePreview({ preview }: { preview: CatalogAdminOptimizePreview }) {
  return (
    <div className={ADMIN_RESULT_CLASS}>
      <p className="text-xs text-lr-text">Preview: {formatBytes(preview.sourceByteLength)} · {orphanTotal(preview)} orphan record(s).</p>
      <p className={ADMIN_NOTE_CLASS}>Metadata {preview.provenOrphanCounts.assetMetadata} · fingerprints {preview.provenOrphanCounts.fingerprints} · albums {preview.provenOrphanCounts.albums} · album assets {preview.provenOrphanCounts.albumAssets} · operations {preview.provenOrphanCounts.operations}.</p>
    </div>
  );
}
