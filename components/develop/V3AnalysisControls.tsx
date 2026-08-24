"use client";

import { ActionButton, StatusCard } from "@/components/develop/V3PanelControls";
import { currentV3AnalysisBinding } from "@/components/develop/DevelopCanvas";
import { getDevelopSession } from "@/lib/develop/session";
import type { DevelopDocumentV3 } from "@/lib/develop/v3/document";
import type { CpuAnalysisTapResult } from "@/lib/develop/v3/cpu-backend";
import { useDevelopStore } from "@/stores/develop-store";

const HISTOGRAM_WIDTH = 256;
const HISTOGRAM_HEIGHT = 72;
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
  const beginEditGroup = useDevelopStore((state) => state.beginEditGroup);
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const endEditGroup = useDevelopStore((state) => state.endEditGroup);
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
    beginEditGroup("Auto Tone");
    try {
      dispatch({
        kind: "replace-v3-semantic-group",
        group: "tone",
        value: {
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
      }, "Auto Tone");
      dispatch({
        kind: "replace-v3-semantic-group",
        group: "color",
        value: {
          ...document.color,
          global: {
            vibrance: values.vibrance,
            saturation: values.saturation,
          },
        },
      }, "Auto Tone");
    } finally {
      endEditGroup();
    }
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
  return bins.map((count, index) => {
    const x = bins.length === 1 ? 0 : index / (bins.length - 1) * HISTOGRAM_WIDTH;
    const normalized = Math.sqrt(Math.max(0, count) / maximum);
    const y = HISTOGRAM_HEIGHT - normalized * (HISTOGRAM_HEIGHT - 2);
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function HistogramGraphic({ tap }: { readonly tap: DisplayOutputTap }) {
  if (tap.state.kind === "loading") {
    return <StatusCard title="Histogram loading">Analyzing the full-frame display output…</StatusCard>;
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
        className="block h-[72px] w-full rounded-[6px] bg-lr-panel-raised/55"
      >
        <title>Full-frame red, green, and blue channel histogram</title>
        {channels.map((channel) => (
          <path
            key={channel.id}
            d={channel.path}
            fill="none"
            stroke={channel.color}
            strokeWidth="1.25"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="mt-1 flex gap-3 text-[9px] font-medium" aria-hidden="true">
        {channels.map((channel) => (
          <span key={channel.id} style={{ color: channel.color }}>{channel.id}</span>
        ))}
        <span className="ml-auto text-lr-text-faint">
          {tap.state.value.pixelCount.toLocaleString()} pixels
        </span>
      </div>
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

export function V3HistogramPanel({ analysis }: V3HistogramPanelProps) {
  const display = displayOutputTap(analysis);
  const headroom = sceneHeadroomTap(analysis);
  return (
    <div className="space-y-2.5" aria-live="polite">
      {display ? (
        <>
          <HistogramGraphic tap={display} />
          <ClippingSummary tap={display} />
        </>
      ) : (
        <StatusCard title="Histogram unavailable">
          Display-output analysis has not been requested.
        </StatusCard>
      )}
      <HeadroomSummary tap={headroom} />
    </div>
  );
}
