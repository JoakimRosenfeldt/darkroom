"use client";

import { useState, type ReactNode } from "react";
import { MIXER_COLORS } from "@/lib/develop/plugins/mixer";
import type { MixerColor } from "@/lib/develop/types";
import { DEFAULT_DEVELOP_SETTINGS } from "@/lib/develop/registry";
import { useDevelopStore } from "@/stores/develop-store";
import {
  COLOR_SLIDER_TRACKS,
  SliderRow,
} from "@/components/develop/SliderRow";
import { ToneCurveEditor } from "@/components/develop/ToneCurveEditor";

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

type MixerMode = "hue" | "saturation" | "luminance" | "all";
type EditTab = "light" | "color" | "detail";

const EDIT_TABS: Array<{ id: EditTab; label: string }> = [
  { id: "light", label: "Light" },
  { id: "color", label: "Color" },
  { id: "detail", label: "Detail" },
];

const MIXER_MODES: Array<{ id: MixerMode; label: string }> = [
  { id: "hue", label: "Hue" },
  { id: "saturation", label: "Saturation" },
  { id: "luminance", label: "Luminance" },
  { id: "all", label: "All" },
];

const COLOR_HEX: Record<MixerColor, string> = {
  red: "#d64d52",
  orange: "#df8438",
  yellow: "#d9c83f",
  green: "#55a85c",
  aqua: "#4cb8b5",
  blue: "#4d78c9",
  purple: "#8b63c5",
  magenta: "#c35b9e",
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

interface EditPanelProps {
  onResetAll: () => void;
}

export function EditPanel({ onResetAll }: EditPanelProps) {
  const [activeTab, setActiveTab] = useState<EditTab>("light");
  const sidecarError = useDevelopStore((state) => {
    const session = state.activeEntryId
      ? state.sessions[state.activeEntryId]
      : undefined;
    return session?.ui.sidecarError ?? null;
  });

  return (
    <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex min-h-[49px] items-center gap-2 border-b border-lr-border-subtle px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
            Develop
          </h2>
          {sidecarError ? (
            <p
              className="mt-0.5 break-words text-[10px] leading-4 text-lr-danger"
              title={sidecarError}
            >
              XMP: {sidecarError}
            </p>
          ) : null}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onResetAll}
          className="rounded-[7px] border border-lr-border-subtle px-2.5 py-1.5 text-[11px] text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
        >
          Reset all
        </button>
      </div>

      <div
        className="flex gap-0.5 border-b border-lr-border-subtle px-3 py-2.5"
        role="tablist"
        aria-label="Develop sections"
      >
        {EDIT_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              "flex-1 rounded-[7px] px-1 py-2 text-[11px] transition",
              activeTab === tab.id
                ? "bg-lr-panel-raised text-lr-text"
                : "text-lr-text-muted hover:bg-lr-panel-raised/60 hover:text-lr-text",
            ].join(" ")}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {activeTab === "light" ? (
          <>
            <BasicLightSection />
            <CurveSection />
          </>
        ) : null}
        {activeTab === "color" ? (
          <>
            <BasicColorSection />
            <MixerSection />
          </>
        ) : null}
        {activeTab === "detail" ? <EffectsSection /> : null}
      </div>
    </aside>
  );
}

function PanelSection({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-lr-border-subtle px-4 pb-[18px] pt-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
          {title}
        </h3>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onReset}
          className="text-[10px] text-lr-text-faint hover:text-lr-text"
        >
          Reset
        </button>
      </div>
      {children}
    </section>
  );
}

function BasicLightSection() {
  const basic = useDevelopStore((state) => {
    const session = state.activeEntryId
      ? state.sessions[state.activeEntryId]
      : undefined;
    return session?.document.settings.basic ?? DEFAULT_DEVELOP_SETTINGS.basic;
  });
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);

  function resetLight() {
    const defaults = DEFAULT_DEVELOP_SETTINGS.basic;
    updatePlugin("basic", {
      exposure: defaults.exposure,
      contrast: defaults.contrast,
      highlights: defaults.highlights,
      shadows: defaults.shadows,
      whites: defaults.whites,
      blacks: defaults.blacks,
    });
  }

  return (
    <PanelSection title="Light" onReset={resetLight}>
      <SliderRow label="Exposure" value={basic.exposure} min={-5} max={5} step={0.05} onChange={(exposure) => updatePlugin("basic", { exposure })} />
      <SliderRow label="Contrast" value={basic.contrast} min={-100} max={100} onChange={(contrast) => updatePlugin("basic", { contrast })} />
      <SliderRow label="Highlights" value={basic.highlights} min={-100} max={100} onChange={(highlights) => updatePlugin("basic", { highlights })} />
      <SliderRow label="Shadows" value={basic.shadows} min={-100} max={100} onChange={(shadows) => updatePlugin("basic", { shadows })} />
      <SliderRow label="Whites" value={basic.whites} min={-100} max={100} onChange={(whites) => updatePlugin("basic", { whites })} />
      <SliderRow label="Blacks" value={basic.blacks} min={-100} max={100} onChange={(blacks) => updatePlugin("basic", { blacks })} />
    </PanelSection>
  );
}

function BasicColorSection() {
  const basic = useDevelopStore((state) => {
    const session = state.activeEntryId
      ? state.sessions[state.activeEntryId]
      : undefined;
    return session?.document.settings.basic ?? DEFAULT_DEVELOP_SETTINGS.basic;
  });
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);

  function resetColor() {
    const defaults = DEFAULT_DEVELOP_SETTINGS.basic;
    updatePlugin("basic", {
      temperature: defaults.temperature,
      tint: defaults.tint,
      vibrance: defaults.vibrance,
      saturation: defaults.saturation,
    });
  }

  return (
    <PanelSection title="White balance & color" onReset={resetColor}>
      <SliderRow label="Temp" value={basic.temperature} min={-3000} max={3000} step={50} suffix="K" track={COLOR_SLIDER_TRACKS.temperature} onChange={(temperature) => updatePlugin("basic", { temperature })} />
      <SliderRow label="Tint" value={basic.tint} min={-150} max={150} track={COLOR_SLIDER_TRACKS.tint} onChange={(tint) => updatePlugin("basic", { tint })} />
      <SliderRow label="Vibrance" value={basic.vibrance} min={-100} max={100} track={COLOR_SLIDER_TRACKS.vibrance} onChange={(vibrance) => updatePlugin("basic", { vibrance })} />
      <SliderRow label="Saturation" value={basic.saturation} min={-100} max={100} track={COLOR_SLIDER_TRACKS.saturation} onChange={(saturation) => updatePlugin("basic", { saturation })} />
    </PanelSection>
  );
}

function CurveSection() {
  const curve = useDevelopStore((state) => {
    const session = state.activeEntryId
      ? state.sessions[state.activeEntryId]
      : undefined;
    return session?.document.settings.curve ?? DEFAULT_DEVELOP_SETTINGS.curve;
  });
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const resetPlugin = useDevelopStore((state) => state.resetPlugin);

  return (
    <PanelSection title="Tone curve" onReset={() => resetPlugin("curve")}>
      <ToneCurveEditor
        settings={curve}
        onChange={(settings) => updatePlugin("curve", settings)}
      />
    </PanelSection>
  );
}

function MixerSection() {
  const [mode, setMode] = useState<MixerMode>("hue");
  const mixer = useDevelopStore((state) => {
    const session = state.activeEntryId
      ? state.sessions[state.activeEntryId]
      : undefined;
    return session?.document.settings.mixer ?? DEFAULT_DEVELOP_SETTINGS.mixer;
  });
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const resetPlugin = useDevelopStore((state) => state.resetPlugin);

  const rows = (property: Exclude<MixerMode, "all">) => (
    <div>
      {MIXER_COLORS.map((color) => (
        <SliderRow
          key={color}
          label={MIXER_LABELS[color]}
          value={mixer[color][property]}
          min={-100}
          max={100}
          track={
            property === "hue"
              ? HUE_TRACKS[color]
              : property === "saturation"
                ? `linear-gradient(90deg, #555, ${COLOR_HEX[color]})`
                : `linear-gradient(90deg, #151515, ${COLOR_HEX[color]}, #e8e8e8)`
          }
          onChange={(value) =>
            updatePlugin("mixer", {
              [color]: { ...mixer[color], [property]: value },
            })
          }
        />
      ))}
    </div>
  );

  return (
    <PanelSection title="Color mixer" onReset={() => resetPlugin("mixer")}>
      <div
        className="mb-2.5 flex gap-0.5 rounded-lg border border-lr-border-subtle bg-lr-canvas p-0.5"
        role="tablist"
        aria-label="HSL adjustment"
      >
        {MIXER_MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            onClick={() => setMode(item.id)}
            className={[
              "flex-1 rounded-md px-1 py-1.5 text-[10px]",
              mode === item.id
                ? "bg-lr-panel-raised text-lr-text"
                : "text-lr-text-muted hover:text-lr-text",
            ].join(" ")}
          >
            {item.label}
          </button>
        ))}
      </div>

      {mode === "all" ? (
        <div className="space-y-4">
          {(["hue", "saturation", "luminance"] as const).map((property) => (
            <section key={property}>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-lr-text-faint">
                {property}
              </h4>
              {rows(property)}
            </section>
          ))}
        </div>
      ) : (
        rows(mode)
      )}
    </PanelSection>
  );
}

function EffectsSection() {
  const effects = useDevelopStore((state) => {
    const session = state.activeEntryId
      ? state.sessions[state.activeEntryId]
      : undefined;
    return session?.document.settings.effects ?? DEFAULT_DEVELOP_SETTINGS.effects;
  });
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const defaults = DEFAULT_DEVELOP_SETTINGS.effects;

  return (
    <>
      <PanelSection title="Sharpening" onReset={() => updatePlugin("effects", {
        sharpening: defaults.sharpening,
        sharpenRadius: defaults.sharpenRadius,
        sharpenDetail: defaults.sharpenDetail,
        sharpenMasking: defaults.sharpenMasking,
      })}>
        <SliderRow label="Amount" value={effects.sharpening} min={0} max={100} resetValue={defaults.sharpening} onChange={(sharpening) => updatePlugin("effects", { sharpening })} />
        <SliderRow label="Radius" value={effects.sharpenRadius} min={0.5} max={3} step={0.1} resetValue={defaults.sharpenRadius} onChange={(sharpenRadius) => updatePlugin("effects", { sharpenRadius })} />
        <SliderRow label="Detail" value={effects.sharpenDetail} min={0} max={100} resetValue={defaults.sharpenDetail} onChange={(sharpenDetail) => updatePlugin("effects", { sharpenDetail })} />
        <SliderRow label="Masking" value={effects.sharpenMasking} min={0} max={100} resetValue={defaults.sharpenMasking} onChange={(sharpenMasking) => updatePlugin("effects", { sharpenMasking })} />
      </PanelSection>
      <PanelSection title="Noise reduction" onReset={() => updatePlugin("effects", {
        noiseReduction: defaults.noiseReduction,
        noiseDetail: defaults.noiseDetail,
        noiseContrast: defaults.noiseContrast,
        colorNoiseReduction: defaults.colorNoiseReduction,
        colorNoiseDetail: defaults.colorNoiseDetail,
        colorNoiseSmoothness: defaults.colorNoiseSmoothness,
      })}>
        <SliderRow label="Luminance" value={effects.noiseReduction} min={0} max={100} resetValue={defaults.noiseReduction} onChange={(noiseReduction) => updatePlugin("effects", { noiseReduction })} />
        <SliderRow label="Detail" value={effects.noiseDetail} min={0} max={100} resetValue={defaults.noiseDetail} onChange={(noiseDetail) => updatePlugin("effects", { noiseDetail })} />
        <SliderRow label="Contrast" value={effects.noiseContrast} min={0} max={100} resetValue={defaults.noiseContrast} onChange={(noiseContrast) => updatePlugin("effects", { noiseContrast })} />
        <SliderRow label="Color" value={effects.colorNoiseReduction} min={0} max={100} resetValue={defaults.colorNoiseReduction} onChange={(colorNoiseReduction) => updatePlugin("effects", { colorNoiseReduction })} />
        <SliderRow label="Color detail" value={effects.colorNoiseDetail} min={0} max={100} resetValue={defaults.colorNoiseDetail} onChange={(colorNoiseDetail) => updatePlugin("effects", { colorNoiseDetail })} />
        <SliderRow label="Smoothness" value={effects.colorNoiseSmoothness} min={0} max={100} resetValue={defaults.colorNoiseSmoothness} onChange={(colorNoiseSmoothness) => updatePlugin("effects", { colorNoiseSmoothness })} />
      </PanelSection>
      <PanelSection title="Post-crop vignette" onReset={() => updatePlugin("effects", {
        vignette: defaults.vignette,
        vignetteMidpoint: defaults.vignetteMidpoint,
        vignetteRoundness: defaults.vignetteRoundness,
        vignetteFeather: defaults.vignetteFeather,
        vignetteHighlights: defaults.vignetteHighlights,
      })}>
        <SliderRow label="Amount" value={effects.vignette} min={-100} max={100} resetValue={defaults.vignette} onChange={(vignette) => updatePlugin("effects", { vignette })} />
        <SliderRow label="Midpoint" value={effects.vignetteMidpoint} min={0} max={100} resetValue={defaults.vignetteMidpoint} onChange={(vignetteMidpoint) => updatePlugin("effects", { vignetteMidpoint })} />
        <SliderRow label="Roundness" value={effects.vignetteRoundness} min={-100} max={100} resetValue={defaults.vignetteRoundness} onChange={(vignetteRoundness) => updatePlugin("effects", { vignetteRoundness })} />
        <SliderRow label="Feather" value={effects.vignetteFeather} min={0} max={100} resetValue={defaults.vignetteFeather} onChange={(vignetteFeather) => updatePlugin("effects", { vignetteFeather })} />
        <SliderRow label="Highlights" value={effects.vignetteHighlights} min={0} max={100} resetValue={defaults.vignetteHighlights} onChange={(vignetteHighlights) => updatePlugin("effects", { vignetteHighlights })} />
      </PanelSection>
      <PanelSection title="Grain" onReset={() => updatePlugin("effects", {
        grain: defaults.grain,
        grainSize: defaults.grainSize,
        grainRoughness: defaults.grainRoughness,
      })}>
        <SliderRow label="Amount" value={effects.grain} min={0} max={100} resetValue={defaults.grain} onChange={(grain) => updatePlugin("effects", { grain })} />
        <SliderRow label="Size" value={effects.grainSize} min={0} max={100} resetValue={defaults.grainSize} onChange={(grainSize) => updatePlugin("effects", { grainSize })} />
        <SliderRow label="Roughness" value={effects.grainRoughness} min={0} max={100} resetValue={defaults.grainRoughness} onChange={(grainRoughness) => updatePlugin("effects", { grainRoughness })} />
      </PanelSection>
    </>
  );
}
