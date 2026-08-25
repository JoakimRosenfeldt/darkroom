"use client";

import { useState } from "react";
import { ASPECT_RATIO_PRESETS } from "@/lib/develop/crop-geometry";
import { MIXER_COLORS } from "@/lib/develop/plugins/mixer";
import type { MixerColor } from "@/lib/develop/types";
import {
  applyCleanupCommand,
  type CleanupCommand,
  type CleanupComponent,
} from "@/lib/develop/v3/cleanup";
import { MAX_POINT_COLOR_SAMPLES } from "@/lib/develop/v3/point-color";
import { currentGeneratedJobCapability } from "@/lib/develop/v3/generated-jobs";
import type {
  DevelopDocumentV3,
  PersistedWhiteBalanceMode,
} from "@/lib/develop/v3/document";
import {
  manualPerspectiveHomographyForFrame,
  type QuarterTurns,
} from "@/lib/develop/v3/geometry";
import { resolveAdjustedWhiteBalance } from "@/lib/develop/v3/white-balance";
import type { ColorGradingWheel } from "@/lib/develop/v3/color-grading";
import type { DevelopPanelId } from "@/components/develop/DevelopPanelRail";
import { V3BatchDialog } from "@/components/develop/V3BatchDialog";
import type { LibraryEntry } from "@/lib/fs/types";
import type { BatchSemanticGroup } from "@/lib/develop/v3/batch";
import type { CpuAnalysisTapResult } from "@/lib/develop/v3/cpu-backend";
import type {
  V3CanvasDiagnostic,
  V3CanvasTool,
} from "@/components/develop/DevelopCanvas";
import {
  V3AutoToneControl,
  V3HistogramPanel,
} from "@/components/develop/V3AnalysisControls";
import { MaskExpressionEditor } from "@/components/develop/MaskExpressionEditor";
import { PrototypeOperations } from "@/components/develop/PrototypeOperations";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { V3CleanupComponentEditor } from "@/components/develop/V3CleanupComponentEditor";
import { SliderRow, COLOR_SLIDER_TRACKS } from "@/components/develop/SliderRow";
import { ToneCurveEditor } from "@/components/develop/ToneCurveEditor";
import {
  ActionButton,
  PanelSection,
  SectionLabel,
  SelectRow,
  StatusCard,
  ToggleRow,
} from "@/components/develop/V3PanelControls";
import { useDevelopStore } from "@/stores/develop-store";

type V3Tab = "light" | "color" | "detail" | "geometry" | "masking" | "cleanup" | "output";
type MixerMode = "hue" | "saturation" | "luminance";
type GradingRange = "shadows" | "midtones" | "highlights";

const TABS: readonly { readonly id: V3Tab; readonly label: string }[] = [
  { id: "light", label: "Light" },
  { id: "color", label: "Color" },
  { id: "detail", label: "Detail" },
  { id: "output", label: "Output" },
];

const MIXER_LABELS: Record<MixerColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  aqua: "Aqua",
  blue: "Blue",
  purple: "Purple",
  magenta: "Magenta",
};

const HUE_TRACKS: Record<MixerColor, string> = {
  red: "linear-gradient(90deg, #bd4f83, #d64d52, #df7438)",
  orange: "linear-gradient(90deg, #d64d52, #df8438, #d9b83f)",
  yellow: "linear-gradient(90deg, #df8438, #d9c83f, #75a94d)",
  green: "linear-gradient(90deg, #d9c83f, #55a85c, #45aaa0)",
  aqua: "linear-gradient(90deg, #55a85c, #4cb8b5, #4d8bc9)",
  blue: "linear-gradient(90deg, #4cb8b5, #4d78c9, #7767c6)",
  purple: "linear-gradient(90deg, #4d78c9, #8b63c5, #bd5aa7)",
  magenta: "linear-gradient(90deg, #8b63c5, #c35b9e, #d64d52)",
};

function tabForPanel(panel: DevelopPanelId | null): V3Tab | null {
  if (panel === "crop") return "geometry";
  if (panel === "masking") return "masking";
  if (panel === "cleanup") return "cleanup";
  return null;
}

function batchGroupForTab(tab: V3Tab): BatchSemanticGroup {
  switch (tab) {
    case "light": return "tone";
    case "color": return "curve-and-color";
    case "detail": return "detail";
    case "geometry": return "geometry-and-crop";
    case "masking": return "local-adjustments";
    case "cleanup": return "cleanup";
    case "output": return "output-intent";
    default: {
      const exhaustive: never = tab;
      return exhaustive;
    }
  }
}

export interface V3BatchContext {
  readonly sourceEntry: LibraryEntry;
  readonly entries: readonly LibraryEntry[];
  readonly resultId: string;
  readonly catalogRevision: number;
  readonly resultEntryIds: readonly string[];
  readonly missingEntryIds: readonly string[];
}

function saveLabel(input: {
  readonly sidecarStatus: string;
  readonly documentRevision: number;
  readonly persistedDocumentRevision: number;
  readonly metadataRevision: number;
  readonly persistedMetadataRevision: number;
}): string {
  if (input.sidecarStatus === "saving") return "Saving…";
  if (input.sidecarStatus === "error") return "Save failed";
  return input.documentRevision === input.persistedDocumentRevision &&
      input.metadataRevision === input.persistedMetadataRevision
    ? "Saved"
    : "Unsaved changes";
}

export function EditPanel({
  decoded,
  entry,
  activePanel,
  batch,
  analysis,
  diagnostics,
  canvasTool,
  onCanvasToolChange,
}: {
  readonly decoded: DevelopImage;
  readonly entry: LibraryEntry;
  readonly activePanel: DevelopPanelId | null;
  readonly batch: V3BatchContext;
  readonly analysis: readonly CpuAnalysisTapResult[];
  readonly diagnostics: readonly V3CanvasDiagnostic[];
  readonly canvasTool: V3CanvasTool;
  readonly onCanvasToolChange: (tool: V3CanvasTool) => void;
}) {
  const session = useDevelopStore((state) => {
    const entryId = state.activeEntryId;
    return entryId ? state.sessions[entryId] : undefined;
  });
  const resetAll = useDevelopStore((state) => state.resetV3All);
  const [activeTab, setActiveTab] = useState<V3Tab>(
    tabForPanel(activePanel) ?? "light",
  );
  const [batchOpen, setBatchOpen] = useState(false);

  const document = session?.persistedDocument;
  if (!session || session.processKind !== "v3" || document?.version !== 3) {
    return null;
  }

  const status = saveLabel({
    sidecarStatus: session.ui.sidecarStatus,
    documentRevision: session.documentRevision,
    persistedDocumentRevision: session.persistedDocumentRevision,
    metadataRevision: session.metadataRevision,
    persistedMetadataRevision: session.persistedMetadataRevision,
  });
  const panelTitle = activePanel === "cleanup" ? "Cleanup" : "Develop";

  return (
    <>
      <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex min-h-[58px] items-center gap-2 border-b border-lr-border-subtle px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
            {panelTitle}
          </h2>
          <p className="mt-0.5 text-[10px] text-lr-text-faint">
            {status} · SDR · 8-bit output
          </p>
          {session.ui.sidecarError ? (
            <p className="mt-0.5 break-words text-[10px] leading-4 text-lr-danger">
              XMP: {session.ui.sidecarError}
            </p>
          ) : null}
        </div>
        <div className="flex-1" />
        <ActionButton onClick={() => setBatchOpen(true)}>Batch</ActionButton>
        <ActionButton onClick={resetAll}>Reset all</ActionButton>
      </div>

      <PrototypeOperations decoded={decoded} document={document} entry={entry} />

      {activePanel !== "crop" && activePanel !== "masking" && activePanel !== "cleanup" ? (
        <div
          className="grid grid-cols-4 gap-0.5 border-b border-lr-border-subtle px-3 py-2.5"
          role="tablist"
          aria-label="Develop sections"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-[7px] px-1 py-1.5 text-[10px] transition ${
                activeTab === tab.id
                  ? "bg-lr-panel-raised text-lr-text"
                  : "text-lr-text-muted hover:bg-lr-panel-raised/60 hover:text-lr-text"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {activeTab === "light" ? <LightTab document={document} analysis={analysis} /> : null}
        {activeTab === "color" ? <ColorTab document={document} canvasTool={canvasTool} onCanvasToolChange={onCanvasToolChange} /> : null}
        {activeTab === "detail" ? <DetailTab document={document} /> : null}
        {activeTab === "geometry" ? <GeometryTab document={document} /> : null}
        {activeTab === "masking" ? (
          <MaskingTab document={document} entry={batch.sourceEntry} />
        ) : null}
        {activeTab === "cleanup" ? <CleanupTab document={document} canvasTool={canvasTool} onCanvasToolChange={onCanvasToolChange} /> : null}
        {activeTab === "output" ? <OutputTab document={document} analysis={analysis} diagnostics={diagnostics} /> : null}
      </div>
      </aside>
      {batchOpen ? (
        <V3BatchDialog
          sourceEntry={batch.sourceEntry}
          entries={batch.entries}
          resultId={batch.resultId}
          catalogId={batch.sourceEntry.catalogId}
          catalogRevision={batch.catalogRevision}
          resultEntryIds={batch.resultEntryIds}
          missingEntryIds={batch.missingEntryIds}
          currentGroup={batchGroupForTab(activeTab)}
          onClose={() => setBatchOpen(false)}
        />
      ) : null}
    </>
  );
}

function LightTab({
  document,
  analysis,
}: {
  readonly document: DevelopDocumentV3;
  readonly analysis: readonly CpuAnalysisTapResult[];
}) {
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const reset = useDevelopStore((state) => state.resetV3Group);
  const basic = document.tone.basic;

  const updateBasic = (
    field: keyof DevelopDocumentV3["tone"]["basic"],
    value: number,
  ) => dispatch({
    kind: "replace-v3-semantic-group",
    group: "tone",
    value: { ...document.tone, basic: { ...basic, [field]: value } },
  }, "Adjust tone");

  return (
    <>
      <PanelSection
        title="Tone"
        headerActions={<V3AutoToneControl analysis={analysis} document={document} />}
        onReset={() => reset("tone")}
      >
        <SliderRow label="Exposure" value={basic.exposure} min={-5} max={5} step={0.05} suffix=" EV" onChange={(value) => updateBasic("exposure", value)} />
        <SliderRow label="Contrast" value={basic.contrast} min={-100} max={100} onChange={(value) => updateBasic("contrast", value)} />
        <SliderRow label="Highlights" value={basic.highlights} min={-100} max={100} onChange={(value) => updateBasic("highlights", value)} />
        <SliderRow label="Shadows" value={basic.shadows} min={-100} max={100} onChange={(value) => updateBasic("shadows", value)} />
        <SliderRow label="Whites" value={basic.whites} min={-100} max={100} onChange={(value) => updateBasic("whites", value)} />
        <SliderRow label="Blacks" value={basic.blacks} min={-100} max={100} onChange={(value) => updateBasic("blacks", value)} />
      </PanelSection>

      <PanelSection title="Presence" onReset={() => reset("presence")}>
        <SliderRow label="Texture" value={document.presence.texture} min={-100} max={100} onChange={(texture) => dispatch({ kind: "replace-v3-semantic-group", group: "presence", value: { ...document.presence, texture } }, "Adjust texture")} />
        <SliderRow label="Clarity" value={document.presence.clarity} min={-100} max={100} onChange={(clarity) => dispatch({ kind: "replace-v3-semantic-group", group: "presence", value: { ...document.presence, clarity } }, "Adjust clarity")} />
        <SliderRow label="Dehaze" value={document.presence.dehaze} min={-100} max={100} onChange={(dehaze) => dispatch({ kind: "replace-v3-semantic-group", group: "presence", value: { ...document.presence, dehaze } }, "Adjust dehaze")} />
      </PanelSection>

      <PanelSection title="Tone curve">
        <ToneCurveEditor
          settings={document.tone.curves}
          onChange={(curves) => dispatch({
            kind: "replace-v3-semantic-group",
            group: "tone",
            value: { ...document.tone, curves },
          }, "Adjust tone curve")}
        />
      </PanelSection>
    </>
  );
}

function whiteBalanceMode(value: string): PersistedWhiteBalanceMode | null {
  switch (value) {
    case "current":
    case "camera":
    case "custom":
    case "sampled":
    case "auto":
    case "legacy-custom":
      return value;
    default:
      return null;
  }
}

function profileDescription(document: DevelopDocumentV3): string {
  const selection = document.color.inputProfile.selection;
  if (selection.kind === "decoder-default") {
    return "Decoder-provided color. No licensed camera profile registry is installed.";
  }
  if (selection.kind === "unavailable") return selection.reason;
  return `${selection.profileId} · revision ${selection.profileRevision}. Stored calibration only; no registry lookup is available.`;
}

function ColorTab({
  document,
  canvasTool,
  onCanvasToolChange,
}: {
  readonly document: DevelopDocumentV3;
  readonly canvasTool: V3CanvasTool;
  readonly onCanvasToolChange: (tool: V3CanvasTool) => void;
}) {
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const reset = useDevelopStore((state) => state.resetV3Group);
  const [mixerMode, setMixerMode] = useState<MixerMode>("hue");
  const [autoStatus, setAutoStatus] = useState<string | null>(null);
  const color = document.color;

  const replaceColor = (value: DevelopDocumentV3["color"], label: string) =>
    dispatch({ kind: "replace-v3-semantic-group", group: "color", value }, label);

  const setWhiteBalanceMode = (raw: string) => {
    const mode = whiteBalanceMode(raw);
    if (!mode) return;
    if (mode === "auto") {
      setAutoStatus("Auto WB is unavailable until renderer analysis is connected. The document was not changed.");
      return;
    }
    if (mode === "sampled") {
      setAutoStatus("Click a neutral source area in the canvas. Press Escape to cancel.");
      onCanvasToolChange(canvasTool.kind === "white-balance"
        ? { kind: "none" }
        : { kind: "white-balance" });
      return;
    }
    setAutoStatus(null);
    replaceColor({
      ...color,
      whiteBalance: { ...color.whiteBalance, mode },
    }, "Change white balance mode");
  };

  const requestAutoWhiteBalance = () => {
    setAutoStatus("Auto WB is unavailable until renderer analysis is connected. The document was not changed.");
  };

  const updateWhiteBalance = (field: "temperature" | "tint", value: number) => {
    const adjustment = { ...color.whiteBalance.adjustment, [field]: value };
    replaceColor({
      ...color,
      whiteBalance: {
        ...color.whiteBalance,
        mode: "custom",
        adjustment,
        resolved: resolveAdjustedWhiteBalance({
          previousAdjustment: color.whiteBalance.adjustment,
          previousValues: color.whiteBalance.resolved,
          adjustment,
        }),
      },
    }, "Adjust white balance");
  };

  return (
    <PanelSection title="Color" onReset={() => reset("color")}>
      <SectionLabel>White balance</SectionLabel>
      <SelectRow label="Mode" value={color.whiteBalance.mode} onChange={setWhiteBalanceMode}>
        <option value="current">Current</option>
        <option value="camera">As shot</option>
        <option value="custom">Custom</option>
        <option value="sampled">Sample from canvas</option>
        <option value="auto" disabled>Auto requested · unavailable</option>
        <option value="legacy-custom">Imported custom</option>
      </SelectRow>
      <SliderRow label="Temperature" value={color.whiteBalance.adjustment.temperature} min={-3000} max={3000} suffix=" K" track={COLOR_SLIDER_TRACKS.temperature} onChange={(value) => updateWhiteBalance("temperature", value)} />
      <SliderRow label="Tint" value={color.whiteBalance.adjustment.tint} min={-150} max={150} track={COLOR_SLIDER_TRACKS.tint} onChange={(value) => updateWhiteBalance("tint", value)} />
      <div className="mt-2 flex items-center gap-2">
        <ActionButton onClick={() => onCanvasToolChange(canvasTool.kind === "white-balance" ? { kind: "none" } : { kind: "white-balance" })}>
          {canvasTool.kind === "white-balance" ? "Cancel sampler" : "Sample neutral"}
        </ActionButton>
        <ActionButton onClick={requestAutoWhiteBalance}>Request Auto</ActionButton>
        <p className="text-[9px] leading-3 text-lr-text-faint">
          Resolved: {color.whiteBalance.resolved.temperatureKelvin} K
        </p>
      </div>
      {autoStatus ? <p role="status" className="mt-2 text-[10px] leading-4 text-lr-accent">{autoStatus}</p> : null}

      <SectionLabel>Global color</SectionLabel>
      <SliderRow label="Vibrance" value={color.global.vibrance} min={-100} max={100} track={COLOR_SLIDER_TRACKS.vibrance} onChange={(vibrance) => replaceColor({ ...color, global: { ...color.global, vibrance } }, "Adjust vibrance")} />
      <SliderRow label="Saturation" value={color.global.saturation} min={-100} max={100} track={COLOR_SLIDER_TRACKS.saturation} onChange={(saturation) => replaceColor({ ...color, global: { ...color.global, saturation } }, "Adjust saturation")} />

      <SectionLabel>Input profile</SectionLabel>
      <StatusCard title="Profile status">{profileDescription(document)}</StatusCard>

      <PointColorControls
        document={document}
        replaceColor={replaceColor}
        canvasTool={canvasTool}
        onCanvasToolChange={onCanvasToolChange}
      />
      <MixerControls document={document} mode={mixerMode} setMode={setMixerMode} replaceColor={replaceColor} />
      <MonochromeControls document={document} replaceColor={replaceColor} />
      <ColorGradingControls document={document} replaceColor={replaceColor} />
    </PanelSection>
  );
}

function PointColorControls({
  document,
  replaceColor,
  canvasTool,
  onCanvasToolChange,
}: {
  document: DevelopDocumentV3;
  replaceColor: (value: DevelopDocumentV3["color"], label: string) => void;
  canvasTool: V3CanvasTool;
  onCanvasToolChange: (tool: V3CanvasTool) => void;
}) {
  const settings = document.color.pointColor;
  const update = (id: string, patch: Partial<(typeof settings.adjustments)[number]>) =>
    replaceColor({
      ...document.color,
      pointColor: {
        adjustments: settings.adjustments.map((adjustment) =>
          adjustment.id === id ? { ...adjustment, ...patch } : adjustment
        ),
      },
    }, "Adjust Point Color");

  return (
    <>
      <div className="mb-1.5 mt-3 flex items-center gap-2">
        <SectionLabel>Point Color</SectionLabel>
        <div className="flex-1" />
        <ActionButton
          disabled={settings.adjustments.length >= MAX_POINT_COLOR_SAMPLES}
          onClick={() => onCanvasToolChange(canvasTool.kind === "point-color"
            ? { kind: "none" }
            : { kind: "point-color" })}
        >
          {canvasTool.kind === "point-color" ? "Cancel sample" : "Sample canvas"}
        </ActionButton>
        <ActionButton
          disabled={settings.adjustments.length >= MAX_POINT_COLOR_SAMPLES}
          onClick={() => replaceColor({
            ...document.color,
            pointColor: {
              adjustments: [...settings.adjustments, {
                id: crypto.randomUUID(),
                enabled: true,
                sourceHueDegrees: 0,
                sourceSaturation: 0.5,
                sourceLuminance: 0.5,
                hueRangeDegrees: 30,
                saturationRange: 0.25,
                luminanceRange: 0.25,
                falloff: 0.5,
                hueShiftDegrees: 0,
                saturationShift: 0,
                luminanceShift: 0,
              }],
            },
          }, "Add Point Color")}
        >
          Add numeric point
        </ActionButton>
      </div>
      <p className="mb-1.5 text-[10px] leading-4 text-lr-text-faint">
        Canvas sampling records the clicked SDR color. Numeric points start from neutral mid-color values.
      </p>
      {settings.adjustments.length === 0 ? (
        <p className="text-[10px] leading-4 text-lr-text-faint">No Point Color samples.</p>
      ) : settings.adjustments.map((adjustment, index) => (
        <div key={adjustment.id} className="mb-2 rounded-[7px] border border-lr-border-subtle p-2">
          <div className="mb-1 flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[10px] text-lr-text-muted">
              <input type="checkbox" checked={adjustment.enabled} onChange={(event) => update(adjustment.id, { enabled: event.target.checked })} className="size-3 accent-lr-accent" />
              Sample {index + 1}
            </label>
            <div className="flex-1" />
            <button type="button" onClick={() => replaceColor({ ...document.color, pointColor: { adjustments: settings.adjustments.filter((item) => item.id !== adjustment.id) } }, "Remove Point Color")} className="text-[10px] text-lr-text-faint hover:text-lr-danger">Remove</button>
          </div>
          <SliderRow label="Source hue" value={adjustment.sourceHueDegrees} min={0} max={360} onChange={(sourceHueDegrees) => update(adjustment.id, { sourceHueDegrees })} />
          <SliderRow label="Source sat." value={adjustment.sourceSaturation} min={0} max={1} step={0.01} onChange={(sourceSaturation) => update(adjustment.id, { sourceSaturation })} />
          <SliderRow label="Source lum." value={adjustment.sourceLuminance} min={0} max={1} step={0.01} onChange={(sourceLuminance) => update(adjustment.id, { sourceLuminance })} />
          <SliderRow label="Hue range" value={adjustment.hueRangeDegrees} min={1} max={180} onChange={(hueRangeDegrees) => update(adjustment.id, { hueRangeDegrees })} />
          <SliderRow label="Sat. range" value={adjustment.saturationRange} min={0.01} max={1} step={0.01} onChange={(saturationRange) => update(adjustment.id, { saturationRange })} />
          <SliderRow label="Lum. range" value={adjustment.luminanceRange} min={0.01} max={1} step={0.01} onChange={(luminanceRange) => update(adjustment.id, { luminanceRange })} />
          <SliderRow label="Falloff" value={adjustment.falloff} min={0} max={1} step={0.01} onChange={(falloff) => update(adjustment.id, { falloff })} />
          <SliderRow label="Hue shift" value={adjustment.hueShiftDegrees} min={-180} max={180} onChange={(hueShiftDegrees) => update(adjustment.id, { hueShiftDegrees })} />
          <SliderRow label="Sat. shift" value={adjustment.saturationShift} min={-1} max={1} step={0.01} onChange={(saturationShift) => update(adjustment.id, { saturationShift })} />
          <SliderRow label="Lum. shift" value={adjustment.luminanceShift} min={-1} max={1} step={0.01} onChange={(luminanceShift) => update(adjustment.id, { luminanceShift })} />
        </div>
      ))}
    </>
  );
}

function MixerControls({
  document,
  mode,
  setMode,
  replaceColor,
}: {
  document: DevelopDocumentV3;
  mode: MixerMode;
  setMode: (mode: MixerMode) => void;
  replaceColor: (value: DevelopDocumentV3["color"], label: string) => void;
}) {
  const mixer = document.color.mixer;
  return (
    <>
      <SectionLabel>Color mixer</SectionLabel>
      <div className="mb-1.5 flex gap-1" role="group" aria-label="Color mixer property">
        {(["hue", "saturation", "luminance"] as const).map((item) => (
          <ActionButton key={item} pressed={mode === item} onClick={() => setMode(item)}>
            {item === "hue" ? "Hue" : item === "saturation" ? "Saturation" : "Luminance"}
          </ActionButton>
        ))}
      </div>
      {MIXER_COLORS.map((color) => (
        <SliderRow
          key={color}
          label={MIXER_LABELS[color]}
          value={mixer[color][mode]}
          min={-100}
          max={100}
          track={mode === "hue" ? HUE_TRACKS[color] : undefined}
          onChange={(value) => replaceColor({
            ...document.color,
            mixer: { ...mixer, [color]: { ...mixer[color], [mode]: value } },
          }, `Adjust ${MIXER_LABELS[color]} ${mode}`)}
        />
      ))}
    </>
  );
}

function MonochromeControls({
  document,
  replaceColor,
}: {
  document: DevelopDocumentV3;
  replaceColor: (value: DevelopDocumentV3["color"], label: string) => void;
}) {
  const monochrome = document.color.monochrome;
  return (
    <>
      <SectionLabel>Monochrome</SectionLabel>
      <ToggleRow label="Black & white" checked={monochrome.enabled} detail="Neutral built-in profile" onChange={(enabled) => replaceColor({ ...document.color, monochrome: { ...monochrome, enabled } }, "Toggle monochrome")} />
      {monochrome.enabled ? MIXER_COLORS.map((channel) => (
        <SliderRow key={channel} label={MIXER_LABELS[channel]} value={monochrome.mixer[channel]} min={-100} max={100} onChange={(value) => replaceColor({ ...document.color, monochrome: { ...monochrome, mixer: { ...monochrome.mixer, [channel]: value } } }, `Adjust monochrome ${channel}`)} />
      )) : null}
    </>
  );
}

function ColorGradingControls({
  document,
  replaceColor,
}: {
  document: DevelopDocumentV3;
  replaceColor: (value: DevelopDocumentV3["color"], label: string) => void;
}) {
  const grading = document.color.grading;
  const updateWheel = (range: GradingRange, patch: Partial<ColorGradingWheel>) =>
    replaceColor({
      ...document.color,
      grading: { ...grading, [range]: { ...grading[range], ...patch } },
    }, `Adjust ${range} grading`);
  return (
    <>
      <SectionLabel>Color grading</SectionLabel>
      {(["shadows", "midtones", "highlights"] as const).map((range) => (
        <div key={range} className="mb-1.5">
          <p className="text-[9px] font-medium capitalize text-lr-text-faint">{range}</p>
          <SliderRow label="Hue" value={grading[range].hueDegrees} min={0} max={360} onChange={(hueDegrees) => updateWheel(range, { hueDegrees })} />
          <SliderRow label="Saturation" value={grading[range].saturation} min={0} max={100} onChange={(saturation) => updateWheel(range, { saturation })} />
          <SliderRow label="Luminance" value={grading[range].luminance} min={-100} max={100} onChange={(luminance) => updateWheel(range, { luminance })} />
        </div>
      ))}
      <SliderRow label="Blending" value={grading.blending} min={0} max={100} onChange={(blending) => replaceColor({ ...document.color, grading: { ...grading, blending } }, "Adjust grading blending")} />
      <SliderRow label="Balance" value={grading.balance} min={-100} max={100} onChange={(balance) => replaceColor({ ...document.color, grading: { ...grading, balance } }, "Adjust grading balance")} />
    </>
  );
}

function opticsProfileStatus(document: DevelopDocumentV3): string {
  const profile = document.optics.profile;
  if (profile.kind === "off") return "Off. No licensed lens profile registry is installed.";
  if (profile.kind === "automatic") return "Automatic profile requested, but no lens profile registry is installed.";
  return `${profile.profileId} is stored, but this build cannot verify it against a lens profile registry.`;
}

function DetailTab({ document }: { document: DevelopDocumentV3 }) {
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const reset = useDevelopStore((state) => state.resetV3Group);
  const optics = document.optics;
  const noise = document.detail.noiseReduction;
  const sharpening = document.detail.sharpening;
  const postCrop = document.effects.postCrop;

  return (
    <>
      <PanelSection title="Optics" onReset={() => reset("optics")}>
        <StatusCard title="Lens profile" tone={optics.profile.kind === "off" ? "neutral" : "warning"}>
          {opticsProfileStatus(document)}
        </StatusCard>
        <SectionLabel>Manual correction</SectionLabel>
        <SliderRow label="Distortion" value={optics.manualDistortion} min={-100} max={100} onChange={(manualDistortion) => dispatch({ kind: "replace-v3-semantic-group", group: "optics", value: { ...optics, manualDistortion } }, "Adjust distortion")} />
        <SliderRow label="Defringe" value={optics.defringe.amount} min={0} max={100} onChange={(amount) => dispatch({ kind: "replace-v3-semantic-group", group: "optics", value: { ...optics, defringe: { ...optics.defringe, amount } } }, "Adjust defringe")} />
        <SliderRow label="Purple hue" value={optics.defringe.purpleHueDegrees} min={0} max={360} onChange={(purpleHueDegrees) => dispatch({ kind: "replace-v3-semantic-group", group: "optics", value: { ...optics, defringe: { ...optics.defringe, purpleHueDegrees } } }, "Adjust purple defringe hue")} />
        <SliderRow label="Green hue" value={optics.defringe.greenHueDegrees} min={0} max={360} onChange={(greenHueDegrees) => dispatch({ kind: "replace-v3-semantic-group", group: "optics", value: { ...optics, defringe: { ...optics.defringe, greenHueDegrees } } }, "Adjust green defringe hue")} />
        <SliderRow label="Hue range" value={optics.defringe.hueRangeDegrees} min={1} max={60} onChange={(hueRangeDegrees) => dispatch({ kind: "replace-v3-semantic-group", group: "optics", value: { ...optics, defringe: { ...optics.defringe, hueRangeDegrees } } }, "Adjust defringe range")} />
      </PanelSection>

      <PanelSection title="Detail" onReset={() => reset("detail")}>
        <SectionLabel>Noise reduction</SectionLabel>
        {([
          ["noiseReduction", "Luminance"],
          ["noiseDetail", "Detail"],
          ["noiseContrast", "Contrast"],
          ["colorNoiseReduction", "Color"],
          ["colorNoiseDetail", "Color detail"],
          ["colorNoiseSmoothness", "Smoothness"],
        ] as const).map(([field, label]) => (
          <SliderRow key={field} label={label} value={noise[field]} min={0} max={100} onChange={(value) => dispatch({ kind: "replace-v3-semantic-group", group: "detail", value: { ...document.detail, noiseReduction: { ...noise, [field]: value } } }, `Adjust ${label.toLowerCase()} noise reduction`)} />
        ))}
        <SectionLabel>Sharpening</SectionLabel>
        <SliderRow label="Amount" value={sharpening.sharpening} min={0} max={100} onChange={(value) => dispatch({ kind: "replace-v3-semantic-group", group: "detail", value: { ...document.detail, sharpening: { ...sharpening, sharpening: value } } }, "Adjust sharpening")} />
        <SliderRow label="Radius" value={sharpening.sharpenRadius} min={0.5} max={3} step={0.1} onChange={(sharpenRadius) => dispatch({ kind: "replace-v3-semantic-group", group: "detail", value: { ...document.detail, sharpening: { ...sharpening, sharpenRadius } } }, "Adjust sharpen radius")} />
        <SliderRow label="Detail" value={sharpening.sharpenDetail} min={0} max={100} onChange={(sharpenDetail) => dispatch({ kind: "replace-v3-semantic-group", group: "detail", value: { ...document.detail, sharpening: { ...sharpening, sharpenDetail } } }, "Adjust sharpen detail")} />
        <SliderRow label="Masking" value={sharpening.sharpenMasking} min={0} max={100} onChange={(sharpenMasking) => dispatch({ kind: "replace-v3-semantic-group", group: "detail", value: { ...document.detail, sharpening: { ...sharpening, sharpenMasking } } }, "Adjust sharpen masking")} />
      </PanelSection>

      <PanelSection title="Post-crop effects" onReset={() => reset("effects")}>
        {([
          ["vignette", "Vignette", -100, 100],
          ["vignetteMidpoint", "Midpoint", 0, 100],
          ["vignetteRoundness", "Roundness", -100, 100],
          ["vignetteFeather", "Feather", 0, 100],
          ["vignetteHighlights", "Highlights", 0, 100],
          ["grain", "Grain", 0, 100],
          ["grainSize", "Size", 0, 100],
          ["grainRoughness", "Roughness", 0, 100],
        ] as const).map(([field, label, minimum, maximum]) => (
          <SliderRow key={field} label={label} value={postCrop[field]} min={minimum} max={maximum} onChange={(value) => dispatch({ kind: "replace-v3-semantic-group", group: "effects", value: { postCrop: { ...postCrop, [field]: value } } }, `Adjust ${label.toLowerCase()}`)} />
        ))}
      </PanelSection>
    </>
  );
}

function rotateQuarterTurns(value: QuarterTurns, direction: "left" | "right"): QuarterTurns {
  switch (value) {
    case 0: return direction === "left" ? 3 : 1;
    case 1: return direction === "left" ? 0 : 2;
    case 2: return direction === "left" ? 1 : 3;
    case 3: return direction === "left" ? 2 : 0;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function MaskingTab({
  document,
  entry,
}: {
  readonly document: DevelopDocumentV3;
  readonly entry: LibraryEntry;
}) {
  return (
    <PanelSection title="Masks">
      <MaskExpressionEditor document={document} entry={entry} />
    </PanelSection>
  );
}

function GeometryTab({ document }: { document: DevelopDocumentV3 }) {
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const reset = useDevelopStore((state) => state.resetV3Group);
  const geometry = document.geometry;
  const crop = geometry.crop;
  const geometryFrame = document.local.geometryFrame;
  const legacyPerspective = geometryFrame === "legacy-oriented-v2";
  const horizontalPerspective = legacyPerspective
    ? -geometry.manualPerspective.horizontal
    : geometry.manualPerspective.horizontal;
  const verticalPerspective = legacyPerspective
    ? -geometry.manualPerspective.vertical
    : geometry.manualPerspective.vertical;
  const replace = (value: DevelopDocumentV3["geometry"], label: string) =>
    dispatch({ kind: "replace-v3-semantic-group", group: "geometry", value }, label);
  const replacePerspective = (
    horizontal: number,
    vertical: number,
    label: string,
  ) => replace({
    ...geometry,
    manualPerspective: {
      horizontal: legacyPerspective ? -horizontal : horizontal,
      vertical: legacyPerspective ? -vertical : vertical,
      matrix: manualPerspectiveHomographyForFrame(
        horizontal,
        vertical,
        geometryFrame,
      ),
    },
  }, label);

  return (
    <PanelSection title="Geometry" onReset={() => reset("geometry")}>
      <SectionLabel>Orientation</SectionLabel>
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        <ActionButton onClick={() => replace({ ...geometry, orientation: { ...geometry.orientation, quarterTurns: rotateQuarterTurns(geometry.orientation.quarterTurns, "left") } }, "Turn left")}>Turn left</ActionButton>
        <ActionButton onClick={() => replace({ ...geometry, orientation: { ...geometry.orientation, quarterTurns: rotateQuarterTurns(geometry.orientation.quarterTurns, "right") } }, "Turn right")}>Turn right</ActionButton>
      </div>
      <ToggleRow label="Flip horizontal" checked={geometry.orientation.flipHorizontal} onChange={(flipHorizontal) => replace({ ...geometry, orientation: { ...geometry.orientation, flipHorizontal } }, "Flip horizontal")} />
      <ToggleRow label="Flip vertical" checked={geometry.orientation.flipVertical} onChange={(flipVertical) => replace({ ...geometry, orientation: { ...geometry.orientation, flipVertical } }, "Flip vertical")} />
      <SliderRow label="Fine angle" value={geometry.orientation.fineAngleDegrees} min={-180} max={180} step={0.1} suffix="°" onChange={(fineAngleDegrees) => replace({ ...geometry, orientation: { ...geometry.orientation, fineAngleDegrees } }, "Adjust fine angle")} />

      <SectionLabel>Perspective</SectionLabel>
      <SliderRow label="Horizontal" value={horizontalPerspective} min={-100} max={100} onChange={(horizontal) => replacePerspective(horizontal, verticalPerspective, "Adjust horizontal perspective")} />
      <SliderRow label="Vertical" value={verticalPerspective} min={-100} max={100} onChange={(vertical) => replacePerspective(horizontalPerspective, vertical, "Adjust vertical perspective")} />
      <StatusCard title="Upright unavailable">
        Automatic and guided Upright require a transform provider. Use manual perspective controls.
      </StatusCard>
      <ToggleRow label="Constrain crop" checked={geometry.constrainCrop} onChange={(constrainCrop) => replace({ ...geometry, constrainCrop }, "Toggle constrained crop")} />

      <SectionLabel>Crop state</SectionLabel>
      <ToggleRow label="Enable crop" checked={crop.enabled} onChange={(enabled) => replace({ ...geometry, crop: { ...crop, enabled } }, "Toggle crop")} />
      <SelectRow
        label="Aspect"
        value={crop.aspectPreset}
        disabled={!crop.enabled}
        onChange={(value) => {
          const preset = ASPECT_RATIO_PRESETS.find((candidate) => candidate.id === value);
          if (preset) replace({ ...geometry, crop: { ...crop, aspectPreset: preset.id } }, "Change crop aspect");
        }}
      >
        {ASPECT_RATIO_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
      </SelectRow>
      <SliderRow label="Left" value={crop.x} min={0} max={1 - crop.width} step={0.01} disabled={!crop.enabled} onChange={(x) => replace({ ...geometry, crop: { ...crop, x } }, "Adjust crop left")} />
      <SliderRow label="Top" value={crop.y} min={0} max={1 - crop.height} step={0.01} disabled={!crop.enabled} onChange={(y) => replace({ ...geometry, crop: { ...crop, y } }, "Adjust crop top")} />
      <SliderRow label="Width" value={crop.width} min={0.05} max={1 - crop.x} step={0.01} resetValue={1} disabled={!crop.enabled} onChange={(width) => replace({ ...geometry, crop: { ...crop, width } }, "Adjust crop width")} />
      <SliderRow label="Height" value={crop.height} min={0.05} max={1 - crop.y} step={0.01} resetValue={1} disabled={!crop.enabled} onChange={(height) => replace({ ...geometry, crop: { ...crop, height } }, "Adjust crop height")} />
      {crop.aspectPreset === "custom" ? (
        <>
          <SliderRow label="Custom width" value={crop.customAspectWidth} min={0.01} max={10000} step={0.01} resetValue={1} disabled={!crop.enabled} onChange={(customAspectWidth) => replace({ ...geometry, crop: { ...crop, customAspectWidth } }, "Adjust custom crop width")} />
          <SliderRow label="Custom height" value={crop.customAspectHeight} min={0.01} max={10000} step={0.01} resetValue={1} disabled={!crop.enabled} onChange={(customAspectHeight) => replace({ ...geometry, crop: { ...crop, customAspectHeight } }, "Adjust custom crop height")} />
        </>
      ) : null}
      <p className="mt-2 text-[10px] leading-4 text-lr-text-faint">
        Open Crop from the Develop rail to drag the frame and handles on the photo. Each completed drag commits one crop command.
      </p>
    </PanelSection>
  );
}

function defaultCleanupComponent(kind: "heal" | "clone" | "remove" | "red-eye"): CleanupComponent {
  const id = crypto.randomUUID();
  if (kind === "red-eye") {
    return {
      kind: "red-eye",
      id,
      enabled: true,
      origin: "manual",
      bounds: {
        center: { x: 0.5, y: 0.5 },
        radiusX: 0.06,
        radiusY: 0.04,
        rotationDegrees: 0,
      },
      pupilRadius: 0.5,
      amount: 0.5,
      catchlightProtection: 0.5,
    };
  }
  return {
    kind: "repair",
    id,
    enabled: true,
    mode: kind,
    target: {
      center: { x: 0.5, y: 0.5 },
      radiusX: 0.08,
      radiusY: 0.08,
      rotationDegrees: 0,
    },
    feather: 0.5,
    opacity: 1,
    source: {
      kind: "sampled",
      region: {
        center: { x: 0.35, y: 0.35 },
        radiusX: 0.08,
        radiusY: 0.08,
        rotationDegrees: 0,
      },
    },
  };
}


function cleanupLabel(component: CleanupComponent): string {
  if (component.kind === "red-eye") return "Red eye";
  if (component.mode === "heal") return "Heal";
  if (component.mode === "clone") return "Clone";
  return component.source.kind === "sampled" ? "Remove" : "Accepted removal patch";
}

function CleanupTab({
  document,
  canvasTool,
  onCanvasToolChange,
}: {
  readonly document: DevelopDocumentV3;
  readonly canvasTool: V3CanvasTool;
  readonly onCanvasToolChange: (tool: V3CanvasTool) => void;
}) {
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const reset = useDevelopStore((state) => state.resetV3Group);
  const [message, setMessage] = useState<string | null>(null);

  const commit = (command: CleanupCommand, label: string) => {
    const result = applyCleanupCommand(document.cleanup, command);
    if (result.kind === "changed") {
      dispatch({ kind: "replace-v3-semantic-group", group: "cleanup", value: result.layer }, label);
      setMessage(null);
      return;
    }
    if (result.kind === "invalid") setMessage(result.reason);
  };

  const unavailable = (["people", "reflection", "dust"] as const).map((kind) =>
    currentGeneratedJobCapability(kind)
  );

  return (
    <PanelSection title="Manual cleanup" onReset={() => reset("cleanup")}>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <ActionButton onClick={() => commit({ kind: "add", component: defaultCleanupComponent("heal") }, "Add heal repair")}>Add heal</ActionButton>
        <ActionButton onClick={() => commit({ kind: "add", component: defaultCleanupComponent("clone") }, "Add clone repair")}>Add clone</ActionButton>
        <ActionButton onClick={() => commit({ kind: "add", component: defaultCleanupComponent("remove") }, "Add sampled removal")}>Add remove</ActionButton>
        <ActionButton onClick={() => commit({ kind: "add", component: defaultCleanupComponent("red-eye") }, "Add red eye")}>Add red eye</ActionButton>
      </div>
      <p className="mb-2 text-[10px] leading-4 text-lr-text-faint">
        Add a component, then place its target and sampled source on the canvas. Numeric controls remain available below.
      </p>
      {message ? <p role="alert" className="mb-2 text-[10px] text-lr-danger">{message}</p> : null}
      {document.cleanup.components.length === 0 ? (
        <StatusCard title="No cleanup components">Add a manual heal, clone, or red-eye component.</StatusCard>
      ) : (
        <ol className="space-y-1.5">
          {document.cleanup.components.map((component, index) => (
            <li key={component.id} className="rounded-[7px] border border-lr-border-subtle bg-lr-panel-raised/40 p-2">
              <div className="flex items-center gap-1.5">
                <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-lr-text-muted">
                  <input type="checkbox" checked={component.enabled} onChange={(event) => commit({ kind: "set-enabled", componentId: component.id, enabled: event.target.checked }, `Toggle ${cleanupLabel(component)}`)} className="size-3 accent-lr-accent" />
                  <span className="truncate">{index + 1}. {cleanupLabel(component)}</span>
                </label>
                <button type="button" disabled={index === 0} aria-label={`Move ${cleanupLabel(component)} up`} onClick={() => commit({ kind: "move", componentId: component.id, targetIndex: index - 1 }, `Move ${cleanupLabel(component)}`)} className="px-1 text-xs text-lr-text-faint hover:text-lr-text disabled:opacity-25">↑</button>
                <button type="button" disabled={index === document.cleanup.components.length - 1} aria-label={`Move ${cleanupLabel(component)} down`} onClick={() => commit({ kind: "move", componentId: component.id, targetIndex: index + 1 }, `Move ${cleanupLabel(component)}`)} className="px-1 text-xs text-lr-text-faint hover:text-lr-text disabled:opacity-25">↓</button>
                <button type="button" aria-label={`Remove ${cleanupLabel(component)}`} onClick={() => commit({ kind: "delete", componentId: component.id }, `Remove ${cleanupLabel(component)}`)} className="px-1 text-[10px] text-lr-text-faint hover:text-lr-danger">Remove</button>
              </div>
              <V3CleanupComponentEditor
                component={component}
                onReplace={(replacement) => commit({
                  kind: "replace",
                  componentId: component.id,
                  component: replacement,
                }, `Adjust ${cleanupLabel(component)}`)}
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                <ActionButton onClick={() => onCanvasToolChange(
                  canvasTool.kind === "cleanup" && canvasTool.componentId === component.id && canvasTool.region === "target"
                    ? { kind: "none" }
                    : { kind: "cleanup", componentId: component.id, region: "target" },
                )}>
                  {component.kind === "red-eye" ? "Place eye" : "Place target"}
                </ActionButton>
                {component.kind === "repair" && component.source.kind === "sampled" ? (
                  <ActionButton onClick={() => onCanvasToolChange(
                    canvasTool.kind === "cleanup" && canvasTool.componentId === component.id && canvasTool.region === "source"
                      ? { kind: "none" }
                      : { kind: "cleanup", componentId: component.id, region: "source" },
                  )}>
                    Place source
                  </ActionButton>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      <SectionLabel>Generated cleanup</SectionLabel>
      <div className="space-y-1.5">
        {unavailable.map((capability) => (
          <StatusCard key={capability.jobKind} title={`${capability.jobKind[0].toUpperCase()}${capability.jobKind.slice(1)} unavailable`}>
            {capability.kind === "available"
              ? "A local model is available, but generated cleanup is not connected to this panel."
              : capability.reason} Use manual cleanup above.
          </StatusCard>
        ))}
      </div>
    </PanelSection>
  );
}

function diagnosticMessage(diagnostic: V3CanvasDiagnostic): string {
  return "reason" in diagnostic
    ? diagnostic.reason
    : diagnostic.kind.replaceAll("-", " ");
}

function OutputTab({
  document,
  analysis,
  diagnostics,
}: {
  readonly document: DevelopDocumentV3;
  readonly analysis: readonly CpuAnalysisTapResult[];
  readonly diagnostics: readonly V3CanvasDiagnostic[];
}) {
  const depth = currentGeneratedJobCapability("depth");
  const lensState = document.lensBlur.kind === "enabled"
    ? `A depth reference is stored (${document.lensBlur.depthAsset.assetId}), but this build cannot generate or validate a live depth result.`
    : depth.kind === "available"
      ? "A depth model exists, but the depth workflow is not connected to this panel."
      : depth.reason;

  return (
    <>
      <PanelSection title="Histogram & headroom">
        <V3HistogramPanel analysis={analysis} />
        {diagnostics.length > 0 ? (
          <StatusCard title="Preview notes" tone="warning">
            <ul className="space-y-1">
              {diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.kind}-${index}`}>{diagnosticMessage(diagnostic)}</li>
              ))}
            </ul>
          </StatusCard>
        ) : null}
      </PanelSection>
      <PanelSection title="Lens Blur">
        <ToggleRow label="Enable Lens Blur" checked={document.lensBlur.kind === "enabled"} disabled detail="Unavailable" onChange={() => undefined} />
        <StatusCard title="Missing depth/model" tone="warning">
          {lensState} Lens Blur requires an accepted current depth map.
        </StatusCard>
      </PanelSection>
      <PanelSection title="HDR & proof">
        <ToggleRow label="HDR preview" checked={false} disabled detail="SDR fallback active" onChange={() => undefined} />
        <ToggleRow label="Soft proof" checked={false} disabled detail="Proof unavailable" onChange={() => undefined} />
        <ToggleRow label="Gamut warning" checked={false} disabled detail="Proof unavailable" onChange={() => undefined} />
        <StatusCard title="SDR · 8-bit output">
          HDR display, high-bit output, ICC proof transforms, and gamut analysis are not verified in this build. Stored HDR edits are not changed here; preview and output remain explicit SDR fallback.
        </StatusCard>
        {document.hdr.enabled ? (
          <p className="mt-2 text-[10px] leading-4 text-lr-danger">
            This document requests HDR edits, but the current capability tier cannot render or export them as HDR.
          </p>
        ) : null}
      </PanelSection>
    </>
  );
}

export function NewerDevelopReadOnlyPanel({
  version,
  reason,
}: {
  version: number;
  reason: string;
}) {
  return (
    <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="border-b border-lr-border-subtle px-4 py-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">Develop</h2>
          <span className="rounded bg-[#3c2925] px-1.5 py-0.5 font-mono text-[9px] text-lr-danger">v{version} · read-only</span>
        </div>
        <p className="mt-1 text-[10px] text-lr-text-faint">Not editable or saved by this app</p>
      </div>
      <div className="p-4">
        <StatusCard title="Newer process" tone="danger">{reason}</StatusCard>
      </div>
    </aside>
  );
}

export function PreparingDevelopPanel({ error }: { readonly error: string | null }) {
  return (
    <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="border-b border-lr-border-subtle px-4 py-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
          Develop
        </h2>
        <p
          className={`mt-1 text-[10px] ${error ? "text-lr-danger" : "text-lr-text-faint"}`}
          role={error ? "alert" : "status"}
        >
          {error ?? "Preparing editor…"}
        </p>
      </div>
    </aside>
  );
}
