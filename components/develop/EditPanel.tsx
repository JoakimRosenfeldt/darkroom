"use client";

import { useState, type ReactNode } from "react";
import { MIXER_COLORS } from "@/lib/develop/plugins/mixer";
import type { MixerColor } from "@/lib/develop/types";
import { DEFAULT_DEVELOP_SETTINGS } from "@/lib/develop/registry";
import { useDevelopStore } from "@/stores/develop-store";
import { SliderRow } from "@/components/develop/SliderRow";
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
      <SliderRow label="Temp" value={basic.temperature} min={-3000} max={3000} step={50} suffix="K" onChange={(temperature) => updatePlugin("basic", { temperature })} />
      <SliderRow label="Tint" value={basic.tint} min={-150} max={150} onChange={(tint) => updatePlugin("basic", { tint })} />
      <SliderRow label="Vibrance" value={basic.vibrance} min={-100} max={100} onChange={(vibrance) => updatePlugin("basic", { vibrance })} />
      <SliderRow label="Saturation" value={basic.saturation} min={-100} max={100} onChange={(saturation) => updatePlugin("basic", { saturation })} />
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
  const resetPlugin = useDevelopStore((state) => state.resetPlugin);

  return (
    <PanelSection title="Detail & effects" onReset={() => resetPlugin("effects")}>
      <SliderRow label="Vignette" value={effects.vignette} min={-100} max={100} onChange={(vignette) => updatePlugin("effects", { vignette })} />
      <SliderRow label="Grain" value={effects.grain} min={0} max={100} onChange={(grain) => updatePlugin("effects", { grain })} />
      <SliderRow label="Sharpen" value={effects.sharpening} min={0} max={100} onChange={(sharpening) => updatePlugin("effects", { sharpening })} />
      <SliderRow label="Noise NR" value={effects.noiseReduction} min={0} max={100} onChange={(noiseReduction) => updatePlugin("effects", { noiseReduction })} />
    </PanelSection>
  );
}
