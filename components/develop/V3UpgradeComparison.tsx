"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  getDevelopSession,
  type V3UpgradeComparisonFrame,
  type V3UpgradeComparisonResult,
} from "@/lib/develop/session";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { V3EditCommand } from "@/lib/develop/v3/commands";
import { createV3MigrationCandidate } from "@/lib/develop/v3/migration";
import type { LibraryEntry } from "@/lib/fs/types";
import { useDevelopStore } from "@/stores/develop-store";

const COMPARISON_DIMENSIONS = { width: 560, height: 420 };

type FirstEditId = "texture" | "clarity" | "dehaze";

const FIRST_EDITS: readonly {
  readonly id: FirstEditId;
  readonly label: string;
}[] = [
  { id: "texture", label: "Texture" },
  { id: "clarity", label: "Clarity" },
  { id: "dehaze", label: "Dehaze" },
];

function isFirstEditId(value: string): value is FirstEditId {
  return FIRST_EDITS.some((edit) => edit.id === value);
}

type ComparisonState =
  | { readonly kind: "idle" }
  | { readonly kind: "rendering"; readonly identity: string }
  | {
      readonly kind: "compared";
      readonly identity: string;
      readonly result: Extract<V3UpgradeComparisonResult, { readonly kind: "compared" }>;
    }
  | {
      readonly kind: "blocked" | "invalid" | "cancelled";
      readonly identity: string;
      readonly message: string;
    };

type ApplyState =
  | { readonly kind: "idle" }
  | { readonly kind: "applying" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "success" };

interface CancellationState {
  cancelled: boolean;
}

function firstEditCommand(
  document: DevelopDocumentV3,
  edit: FirstEditId,
  value: number,
): V3EditCommand {
  switch (edit) {
    case "texture":
      return {
        kind: "replace-v3-semantic-group",
        group: "presence",
        value: { ...document.presence, texture: value },
      };
    case "clarity":
      return {
        kind: "replace-v3-semantic-group",
        group: "presence",
        value: { ...document.presence, clarity: value },
      };
    case "dehaze":
      return {
        kind: "replace-v3-semantic-group",
        group: "presence",
        value: { ...document.presence, dehaze: value },
      };
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

function failureMessage(
  result: Exclude<V3UpgradeComparisonResult, { readonly kind: "compared" }>,
): string {
  if (result.kind === "cancelled") return "Comparison was cancelled.";
  if (result.kind === "blocked") {
    const diagnostic = result.diagnostics[0];
    return "reason" in diagnostic
      ? diagnostic.reason
      : `Comparison is blocked by ${diagnostic.kind}.`;
  }
  const issue = result.issues[0];
  return "reason" in issue
    ? issue.reason
    : `Comparison request is invalid: ${issue.kind}.`;
}

function diagnosticText(diagnostic: { readonly kind: string }): string {
  return "reason" in diagnostic && typeof diagnostic.reason === "string"
    ? diagnostic.reason
    : diagnostic.kind.replaceAll("-", " ");
}

function ComparisonCanvas({
  frame,
  label,
}: {
  readonly frame: V3UpgradeComparisonFrame;
  readonly label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = frame.dimensions.width;
    canvas.height = frame.dimensions.height;
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray(frame.pixels),
        frame.dimensions.width,
        frame.dimensions.height,
      ),
      0,
      0,
    );
  }, [frame]);

  return (
    <figure className="min-w-0 rounded-md border border-lr-border-subtle bg-black p-1.5">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        className="block h-auto w-full"
      />
      <figcaption className="pt-1.5 text-center text-[10px] font-medium text-lr-text-muted">
        {label}
      </figcaption>
    </figure>
  );
}

export function V3UpgradeComparison({
  entry,
  image,
}: {
  readonly entry: LibraryEntry;
  readonly image: DevelopImage;
}) {
  const editId = useId();
  const valueId = useId();
  const identity = JSON.stringify([entry.catalogId, entry.id]);
  const storeSession = useDevelopStore((state) =>
    state.activeCatalogId === entry.catalogId
      ? state.sessions[entry.id]
      : undefined,
  );
  const session = getDevelopSession(entry.catalogId, entry.id);
  const snapshot = session?.snapshot() ?? null;
  const [firstEdit, setFirstEdit] = useState<FirstEditId>("texture");
  const [value, setValue] = useState(10);
  const [comparison, setComparison] = useState<ComparisonState>({ kind: "idle" });
  const [applyState, setApplyState] = useState<ApplyState>({ kind: "idle" });
  const cancellationRef = useRef<CancellationState | null>(null);
  const applyingRef = useRef(false);

  useEffect(() => () => {
    if (cancellationRef.current) cancellationRef.current.cancelled = true;
  }, [identity]);

  const visibleComparison: ComparisonState = comparison.kind === "idle" || comparison.identity === identity
    ? comparison
    : { kind: "idle" };
  const compared = visibleComparison.kind === "compared"
    ? visibleComparison.result
    : null;
  const comparedRevision = compared?.acceptance.sourceDocumentRevision ?? null;
  const currentRevision = storeSession?.documentRevision ?? snapshot?.documentRevision ?? null;
  const comparisonIsCurrent = Boolean(
    compared &&
    snapshot?.processKind === "v2" &&
    currentRevision === comparedRevision &&
    snapshot.documentRevision === comparedRevision,
  );
  const editIsValid = Number.isFinite(value) && value >= -100 && value <= 100 && value !== 0;
  const editLabel = FIRST_EDITS.find((option) => option.id === firstEdit)?.label ?? "Edit";

  async function compare(): Promise<void> {
    if (applyingRef.current) return;
    if (cancellationRef.current) cancellationRef.current.cancelled = true;
    const cancellation = { cancelled: false };
    cancellationRef.current = cancellation;
    setApplyState({ kind: "idle" });
    setComparison({ kind: "rendering", identity });
    const activeSession = getDevelopSession(entry.catalogId, entry.id);
    if (!activeSession || activeSession.snapshot().processKind !== "v2") {
      cancellationRef.current = null;
      setComparison({
        kind: "invalid",
        identity,
        message: "An editable v2 Develop session is required.",
      });
      return;
    }
    try {
      const result = await activeSession.render({
        kind: "v3-upgrade-comparison",
        entry,
        image,
        outputDimensions: COMPARISON_DIMENSIONS,
        cancellation: {
          isCancelled: () => cancellation.cancelled,
          reason: () => cancellation.cancelled
            ? "A newer comparison replaced this request."
            : null,
        },
      });
      if (cancellation.cancelled) return;
      if (result.kind === "compared") {
        setComparison({ kind: "compared", identity, result });
      } else {
        setComparison({
          kind: result.kind,
          identity,
          message: failureMessage(result),
        });
      }
    } catch (error) {
      if (cancellation.cancelled) return;
      setComparison({
        kind: "invalid",
        identity,
        message: error instanceof Error ? error.message : "Could not render the comparison.",
      });
    } finally {
      if (cancellationRef.current === cancellation) cancellationRef.current = null;
    }
  }

  async function accept(): Promise<void> {
    if (!compared || !comparisonIsCurrent || !editIsValid || applyingRef.current) return;
    const activeSession = getDevelopSession(entry.catalogId, entry.id);
    const current = activeSession?.snapshot() ?? null;
    if (
      !activeSession ||
      current?.processKind !== "v2" ||
      current.documentRevision !== compared.acceptance.sourceDocumentRevision
    ) {
      setApplyState({
        kind: "error",
        message: "The v2 edit changed. Render and accept a new comparison.",
      });
      return;
    }
    applyingRef.current = true;
    setApplyState({ kind: "applying" });
    try {
      const candidate = createV3MigrationCandidate(current.document);
      const nextSnapshot = await activeSession.dispatch(
        {
          kind: "upgrade-and-first-v3-edit",
          acceptance: compared.acceptance,
          edit: firstEditCommand(candidate.document, firstEdit, value),
        },
        `Upgrade to v3 and set ${editLabel}`,
      );
      useDevelopStore.getState().synchronizeSession(entry.id, nextSnapshot);
      setApplyState({ kind: "success" });
    } catch (error) {
      setApplyState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not upgrade this edit.",
      });
    } finally {
      applyingRef.current = false;
    }
  }

  if (!session) {
    return (
      <section className="rounded-md border border-lr-border-subtle bg-lr-panel-raised/35 p-3" role="status">
        <p className="text-xs text-lr-text-muted">Develop session is not ready.</p>
      </section>
    );
  }

  if (snapshot?.processKind !== "v2") {
    return (
      <section className="rounded-md border border-lr-border-subtle bg-lr-panel-raised/35 p-3" role="status">
        <p className="text-xs text-lr-text-muted">
          {applyState.kind === "success"
            ? "V3 upgrade applied."
            : "V3 comparison is available only for editable v2 photos."}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-md border border-lr-border-subtle bg-lr-panel-raised/35 p-3">
      <div>
        <h3 className="text-xs font-semibold text-lr-text">Compare v2 with v3</h3>
        <p className="mt-1 text-[11px] leading-4 text-lr-text-faint">
          Choose the first v3 edit, compare the real fit renders, then accept this exact revision.
        </p>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <label htmlFor={editId} className="min-w-0 text-[11px] text-lr-text-muted">
          First v3 edit
          <select
            id={editId}
            value={firstEdit}
            onChange={(event) => {
              if (isFirstEditId(event.target.value)) setFirstEdit(event.target.value);
            }}
            disabled={applyState.kind === "applying"}
            className="mt-1 block w-full rounded border border-lr-border-subtle bg-lr-panel px-2 py-1.5 text-xs text-lr-text"
          >
            {FIRST_EDITS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <output htmlFor={valueId} className="pb-1.5 font-mono text-xs text-lr-text">
          {value > 0 ? "+" : ""}{value}
        </output>
      </div>

      <label htmlFor={valueId} className="block text-[11px] text-lr-text-muted">
        {editLabel} value
        <input
          id={valueId}
          type="range"
          min={-100}
          max={100}
          step={1}
          value={value}
          onChange={(event) => setValue(event.currentTarget.valueAsNumber)}
          disabled={applyState.kind === "applying"}
          className="mt-1 block w-full accent-lr-accent"
        />
      </label>
      {!editIsValid ? (
        <p className="text-[11px] text-lr-danger" role="alert">
          Choose a non-zero value from −100 to +100.
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void compare()}
        disabled={applyState.kind === "applying"}
        className="w-full rounded bg-lr-panel px-3 py-2 text-xs font-medium text-lr-text hover:bg-lr-panel-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {visibleComparison.kind === "rendering" ? "Restart comparison" : "Render comparison"}
      </button>

      {visibleComparison.kind === "rendering" ? (
        <p className="text-center text-[11px] text-lr-text-muted" role="status">
          Rendering v2 and v3 fit frames…
        </p>
      ) : null}
      {visibleComparison.kind === "blocked" ||
      visibleComparison.kind === "invalid" ||
      visibleComparison.kind === "cancelled" ? (
        <p className="text-[11px] leading-4 text-lr-danger" role="alert">
          {visibleComparison.message}
        </p>
      ) : null}

      {compared ? (
        <>
          <div className="grid grid-cols-2 gap-2" aria-label="V2 and v3 comparison frames">
            <ComparisonCanvas frame={compared.baseline} label="Frozen v2 · fit" />
            <ComparisonCanvas frame={compared.candidate} label="Candidate v3 · fit" />
          </div>
          {compared.candidateDiagnostics.length > 0 ? (
            <div className="rounded border border-lr-border-subtle bg-lr-panel/60 p-2">
              <p className="text-[10px] font-semibold text-lr-text-muted">Candidate notes</p>
              <ul className="mt-1 space-y-1 text-[10px] leading-4 text-lr-text-faint">
                {compared.candidateDiagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.kind}-${index}`}>{diagnosticText(diagnostic)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!comparisonIsCurrent ? (
            <p className="text-[11px] leading-4 text-lr-danger" role="alert">
              This comparison is stale. Render the current v2 revision again.
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void accept()}
            disabled={!comparisonIsCurrent || !editIsValid || applyState.kind === "applying"}
            className="w-full rounded bg-lr-accent px-3 py-2 text-xs font-semibold text-[#14202a] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {applyState.kind === "applying"
              ? "Applying v3 upgrade…"
              : `Accept and apply ${editLabel} ${value > 0 ? "+" : ""}${value}`}
          </button>
        </>
      ) : null}

      {applyState.kind === "error" ? (
        <p className="text-[11px] leading-4 text-lr-danger" role="alert">
          {applyState.message}
        </p>
      ) : null}
      {applyState.kind === "success" ? (
        <p className="text-[11px] text-lr-text" role="status">V3 upgrade applied.</p>
      ) : null}
    </section>
  );
}
