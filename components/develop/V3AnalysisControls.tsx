"use client";

import { useState } from "react";
import { ActionButton, StatusCard } from "@/components/develop/V3PanelControls";
import { currentV3AnalysisBinding } from "@/components/develop/DevelopCanvas";
import { getDevelopSession } from "@/lib/develop/session";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { CpuAnalysisTapResult } from "@/lib/develop/v3/cpu-backend";
import { metadataValue } from "@/lib/metadata/types";
import { useDevelopStore } from "@/stores/develop-store";
import { useLibraryStore } from "@/stores/library-store";

const HISTOGRAM_WIDTH = 256;
const HISTOGRAM_HEIGHT = 112;
const MAX_DRAWN_BINS = 128;

type ToneInputTap = Extract<CpuAnalysisTapResult, { readonly tap: "tone-input" }>;
type DisplayOutputTap = Extract<CpuAnalysisTapResult, { readonly tap: "display-output" }>;
type SceneHeadroomTap = Extract<CpuAnalysisTapResult, { readonly tap: "scene-headroom" }>;

export interface V3AutoToneControlProps {
  readonly analysis: readonly CpuAnalysisTapResult[];
  readonly document: DevelopDocumentV3;
  readonly disabled?: boolean;
}

export interface V3HistogramPanelProps {
  readonly analysis: readonly CpuAnalysisTapResult[];
  readonly sourceIdentity: V3HistogramSourceIdentity;
  readonly decodedMetadata: Record<string, unknown>;
}

export interface V3HistogramSourceIdentity {
  readonly catalogId: string;
  readonly entryId: string;
  readonly assetRevision: number;
}

function toneInputTap(analysis: readonly CpuAnalysisTapResult[]): ToneInputTap | null {
  return analysis.find((tap): tap is ToneInputTap => tap.tap === "tone-input") ?? null;
}

function displayOutputTap(
  analysis: readonly CpuAnalysisTapResult[],
): DisplayOutputTap | null {
  return analysis.find((tap): tap is DisplayOutputTap => tap.tap === "display-output") ?? null;
}

function sceneHeadroomTap(
  analysis: readonly CpuAnalysisTapResult[],
): SceneHeadroomTap | null {
  return analysis.find((tap): tap is SceneHeadroomTap => tap.tap === "scene-headroom") ?? null;
}

function noResultMessage(reason: "empty" | "invalid-statistics" | "invalid-histogram"): string {
  switch (reason) {
    case "empty": return "The image has no usable tonal range.";
    case "invalid-statistics": return "Tone statistics are invalid.";
    case "invalid-histogram": return "The tone-input histogram is invalid.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function V3AutoToneControl({
  analysis,
  document,
  disabled = false,
}: V3AutoToneControlProps) {
  const commitCompleteState = useDevelopStore(
    (state) => state.commitV3CompleteState,
  );
  const activeCatalogId = useDevelopStore((state) => state.activeCatalogId);
  const activeEntryId = useDevelopStore((state) => state.activeEntryId);
  const activeSession = useDevelopStore((state) => {
    const entryId = state.activeEntryId;
    return entryId ? state.sessions[entryId] : undefined;
  });
  const tap = toneInputTap(analysis);
  const binding = currentV3AnalysisBinding(analysis);
  const analysisIsCurrent = Boolean(
    binding &&
    binding.catalogId === activeCatalogId &&
    binding.entryId === activeEntryId &&
    binding.documentRevision === activeSession?.documentRevision &&
    activeSession.persistedDocument === document,
  );
  const currentTap = analysisIsCurrent ? tap : null;
  const proposal = currentTap?.state.kind === "ready" &&
    currentTap.state.value.autoTone.kind === "proposal"
    ? currentTap.state.value.autoTone
    : null;

  const apply = () => {
    if (!proposal || disabled) return;
    const currentBinding = currentV3AnalysisBinding(analysis);
    const state = useDevelopStore.getState();
    const currentEntryId = state.activeEntryId;
    const storeSession = currentEntryId ? state.sessions[currentEntryId] : undefined;
    const coreSession = state.activeCatalogId && currentEntryId
      ? getDevelopSession(state.activeCatalogId, currentEntryId)
      : null;
    const coreSnapshot = coreSession?.snapshot() ?? null;
    if (
      !currentBinding ||
      currentBinding.catalogId !== state.activeCatalogId ||
      currentBinding.entryId !== currentEntryId ||
      currentBinding.documentRevision !== storeSession?.documentRevision ||
      currentBinding.documentRevision !== coreSnapshot?.documentRevision ||
      coreSnapshot.processKind !== "v3" ||
      storeSession?.persistedDocument !== document
    ) {
      return;
    }
    const values = proposal.values;
    commitCompleteState(
      currentBinding.catalogId,
      currentBinding.entryId,
      {
        ...document,
        tone: {
          ...document.tone,
          basic: {
            exposure: values.exposure,
            contrast: values.contrast,
            highlights: values.highlights,
            shadows: values.shadows,
            whites: values.whites,
            blacks: values.blacks,
          },
        },
        color: {
          ...document.color,
          global: {
            vibrance: values.vibrance,
            saturation: values.saturation,
          },
        },
      },
      "Auto Tone",
    );
  };

  let status = "Tone analysis has not been requested.";
  if (currentTap?.state.kind === "loading") status = "Analyzing the full-frame tone input…";
  if (currentTap?.state.kind === "unavailable") {
    status = currentTap.state.reason;
  }
  if (currentTap?.state.kind === "error") {
    status = currentTap.state.message;
  }
  if (currentTap?.state.kind === "ready") {
    status = currentTap.state.value.autoTone.kind === "proposal"
      ? "A deterministic full-frame proposal is ready. It runs only when applied."
      : noResultMessage(currentTap.state.value.autoTone.reason);
  }

  return (
    <ActionButton
      onClick={apply}
      disabled={disabled || !proposal}
      title={status}
    >
      Auto
    </ActionButton>
  );
}

function downsampleBins(input: ReadonlyArray<number>): readonly number[] {
  if (input.length <= MAX_DRAWN_BINS) return [...input];
  return Array.from({ length: MAX_DRAWN_BINS }, (_, outputIndex) => {
    const start = Math.floor(outputIndex * input.length / MAX_DRAWN_BINS);
    const end = Math.max(start + 1, Math.floor((outputIndex + 1) * input.length / MAX_DRAWN_BINS));
    let total = 0;
    for (let index = start; index < end; index += 1) total += input[index] ?? 0;
    return total;
  });
}

function histogramPath(bins: readonly number[], maximum: number): string {
  if (bins.length === 0 || maximum <= 0) return "";
  const line = bins.map((count, index) => {
    const x = bins.length === 1 ? 0 : index / (bins.length - 1) * HISTOGRAM_WIDTH;
    const normalized = Math.sqrt(Math.max(0, count) / maximum);
    const y = HISTOGRAM_HEIGHT - normalized * (HISTOGRAM_HEIGHT - 2);
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
  return `${line} L${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT} L0 ${HISTOGRAM_HEIGHT} Z`;
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value :
    typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function CameraSettings({ entryId, decodedMetadata }: {
  readonly entryId: string;
  readonly decodedMetadata: Record<string, unknown>;
}) {
  const capture = useLibraryStore((state) => state.libraryWorkspace.analysisByEntryId[entryId]?.source?.capture);
  const iso = positiveNumber(metadataValue(capture?.iso ?? { kind: "absent" })) ??
    positiveNumber(decodedMetadata.iso_speed ?? decodedMetadata.iso);
  const focalLength = positiveNumber(metadataValue(capture?.focalLength ?? { kind: "absent" })) ??
    positiveNumber(decodedMetadata.focal_len ?? decodedMetadata.focalLength);
  const aperture = positiveNumber(metadataValue(capture?.aperture ?? { kind: "absent" })) ??
    positiveNumber(decodedMetadata.aperture);
  const shutter = positiveNumber(metadataValue(capture?.shutter ?? { kind: "absent" })) ??
    positiveNumber(decodedMetadata.shutter);
  const settings = [
    iso === null ? "—" : `ISO ${iso}`,
    focalLength === null ? "—" : `${focalLength} mm`,
    aperture === null ? "—" : `f/${aperture.toFixed(1)}`,
    shutter === null ? "—" : shutter >= 1 ? `${shutter} sec` : `1/${Math.round(1 / shutter)} sec`,
  ];
  return (
    <div className="mt-1 grid grid-cols-4 gap-1 text-[10px] tabular-nums text-lr-text-muted" role="group" aria-label="Camera settings">
      {settings.map((setting, index) => (
        <span key={index} className={index === 3 ? "text-right" : undefined}>{setting}</span>
      ))}
    </div>
  );
}

function HistogramSkeleton() {
  return (
    <svg
      viewBox={`0 0 ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT}`}
      role="status"
      aria-label="Loading histogram"
      className="block h-full w-full animate-pulse rounded-[6px] border border-lr-border-subtle bg-lr-panel-raised/55 text-lr-text-faint"
    >
      <path
        d="M0 112 L0 101 L12 91 L24 65 L40 48 L55 57 L72 36 L90 61 L108 40 L130 26 L150 48 L166 31 L182 54 L205 66 L225 91 L256 105 L256 112 Z"
        fill="currentColor"
        opacity="0.2"
        aria-hidden="true"
      />
    </svg>
  );
}

function HistogramGraphic({ tap }: { readonly tap: DisplayOutputTap }) {
  if (tap.state.kind === "loading") {
    return <HistogramSkeleton />;
  }
  if (tap.state.kind === "unavailable") {
    return <StatusCard title="Histogram unavailable" tone="warning">{tap.state.reason}</StatusCard>;
  }
  if (tap.state.kind === "error") {
    return <StatusCard title="Histogram error" tone="danger">{tap.state.message}</StatusCard>;
  }
  const red = downsampleBins(tap.state.value.histogram.red);
  const green = downsampleBins(tap.state.value.histogram.green);
  const blue = downsampleBins(tap.state.value.histogram.blue);
  const maximum = Math.max(1, ...red, ...green, ...blue);
  const channels = [
    { id: "R", color: "#d9564a", path: histogramPath(red, maximum) },
    { id: "G", color: "#5cb073", path: histogramPath(green, maximum) },
    { id: "B", color: "#4f8fc0", path: histogramPath(blue, maximum) },
  ] as const;

  return (
    <div>
      <svg
        viewBox={`0 0 ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT}`}
        role="img"
        aria-label={`Full-frame RGB histogram with ${tap.state.value.binCount} bins`}
        className="isolate block h-[112px] w-full rounded-[6px] border border-lr-border-subtle bg-lr-panel-raised/55"
      >
        <title>Full-frame red, green, and blue channel histogram</title>
        {channels.map((channel) => (
          <path
            key={channel.id}
            d={channel.path}
            fill={channel.color}
            fillOpacity="0.85"
            stroke={channel.color}
            strokeWidth="0.75"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ mixBlendMode: "screen" }}
          />
        ))}
      </svg>
    </div>
  );
}

function percentage(count: number, total: number): string {
  return `${(count / Math.max(1, total) * 100).toFixed(2)}%`;
}

function ClippingSummary({ tap }: { readonly tap: DisplayOutputTap }) {
  if (tap.state.kind !== "ready") return null;
  const analysis = tap.state.value;
  const rows = [
    { label: "Red", value: analysis.clipping.red },
    { label: "Green", value: analysis.clipping.green },
    { label: "Blue", value: analysis.clipping.blue },
  ] as const;
  return (
    <table className="mt-2 w-full table-fixed text-[10px] text-lr-text-muted">
      <caption className="sr-only">Per-channel SDR clipping counts and percentages</caption>
      <thead className="text-lr-text-faint">
        <tr>
          <th scope="col" className="pb-1 text-left font-medium">Channel</th>
          <th scope="col" className="pb-1 text-right font-medium">Shadows</th>
          <th scope="col" className="pb-1 text-right font-medium">Highlights</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row" className="py-0.5 text-left font-medium">{row.label}</th>
            <td className="py-0.5 text-right tabular-nums">
              {row.value.shadows.toLocaleString()} ({percentage(row.value.shadows, analysis.pixelCount)})
            </td>
            <td className="py-0.5 text-right tabular-nums">
              {row.value.highlights.toLocaleString()} ({percentage(row.value.highlights, analysis.pixelCount)})
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HeadroomSummary({ tap }: { readonly tap: SceneHeadroomTap | null }) {
  if (!tap) {
    return <StatusCard title="Scene headroom unavailable">Scene-headroom analysis has not been requested.</StatusCard>;
  }
  if (tap.state.kind === "loading") {
    return <StatusCard title="Scene headroom loading">Analyzing scene-linear luminance…</StatusCard>;
  }
  if (tap.state.kind === "unavailable") {
    return <StatusCard title="Scene headroom unavailable" tone="warning">{tap.state.reason}</StatusCard>;
  }
  if (tap.state.kind === "error") {
    return <StatusCard title="Scene headroom error" tone="danger">{tap.state.message}</StatusCard>;
  }
  if (tap.state.value.kind === "unavailable") {
    return <StatusCard title="Scene headroom unavailable" tone="warning">{tap.state.value.reason}</StatusCard>;
  }
  const headroom = tap.state.value;
  return (
    <StatusCard title="Scene headroom ready">
      99th percentile: {headroom.percentile99StopsAboveSdr.toFixed(2)} stops above SDR.
      Maximum: {headroom.maximumStopsAboveSdr.toFixed(2)} stops across {headroom.sampleCount.toLocaleString()} samples.
    </StatusCard>
  );
}

export function V3HistogramPanel({ analysis, sourceIdentity, decodedMetadata }: V3HistogramPanelProps) {
  const binding = currentV3AnalysisBinding(analysis);
  const analysisMatchesSource = binding?.catalogId === sourceIdentity.catalogId &&
    binding.entryId === sourceIdentity.entryId &&
    binding.assetRevision === sourceIdentity.assetRevision;
  const incomingDisplay = analysisMatchesSource ? displayOutputTap(analysis) : null;
  const readyDisplay = incomingDisplay?.state.kind === "ready" ? incomingDisplay : null;
  const sourceKey = JSON.stringify([
    sourceIdentity.catalogId,
    sourceIdentity.entryId,
    sourceIdentity.assetRevision,
  ]);
  const [lastReadyDisplay, setLastReadyDisplay] = useState<{
    readonly sourceKey: string;
    readonly tap: DisplayOutputTap;
  } | null>(null);
  if (readyDisplay && (
    lastReadyDisplay?.sourceKey !== sourceKey ||
    lastReadyDisplay.tap !== readyDisplay
  )) {
    setLastReadyDisplay({ sourceKey, tap: readyDisplay });
  }

  const cachedDisplay = lastReadyDisplay?.sourceKey === sourceKey
    ? lastReadyDisplay.tap
    : null;
  const display = readyDisplay ?? (
    incomingDisplay === null || incomingDisplay.state.kind === "loading"
      ? cachedDisplay ?? incomingDisplay
      : incomingDisplay
  );
  const headroom = analysisMatchesSource ? sceneHeadroomTap(analysis) : null;
  return (
    <div className="space-y-2.5" aria-live="polite">
      <div className="h-[112px]">
        {display ? (
          <HistogramGraphic tap={display} />
        ) : (
          <HistogramSkeleton />
        )}
      </div>
      <CameraSettings entryId={sourceIdentity.entryId} decodedMetadata={decodedMetadata} />
      <details className="text-xs text-lr-text-muted"><summary className="cursor-pointer">Clipping details</summary><div className="mt-2 space-y-2">{display ? <ClippingSummary tap={display} /> : null}<HeadroomSummary tap={headroom} /></div></details>
    </div>
  );
}
