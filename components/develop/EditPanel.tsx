"use client";

import { DEVELOP_PLUGINS } from "@/lib/develop/registry";
import { MIXER_COLORS } from "@/lib/develop/plugins/mixer";
import type { DevelopPluginId, MixerColor } from "@/lib/develop/types";
import { useDevelopStore } from "@/stores/develop-store";
import { SliderRow } from "@/components/develop/SliderRow";
import { ToneCurveEditor } from "@/components/develop/ToneCurveEditor";
import { useState } from "react";

const EDIT_PLUGINS = DEVELOP_PLUGINS.filter((plugin) => plugin.id !== "crop");

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

const MIXER_MODES: { id: MixerMode; label: string }[] = [
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

export function EditPanel() {
  const resetAll = useDevelopStore((state) => state.resetAll);
  const sidecarStatus = useDevelopStore((state) => state.sidecarStatus);
  const sidecarError = useDevelopStore((state) => state.sidecarError);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex items-center justify-between border-b border-lr-border-subtle px-3 py-2">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-muted">
            Edit
          </h2>
          <p className="text-[10px] text-lr-text-dim">
            XMP {sidecarStatus}
            {sidecarError ? `: ${sidecarError}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={resetAll}
          className="rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
        >
          Reset All
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {EDIT_PLUGINS.map((plugin) => (
          <PluginSection key={plugin.id} id={plugin.id} label={plugin.label} />
        ))}
      </div>
    </aside>
  );
}

function PluginSection({
  id,
  label,
}: {
  id: DevelopPluginId;
  label: string;
}) {
  const resetPlugin = useDevelopStore((state) => state.resetPlugin);

  return (
    <details open className="border-b border-lr-border-subtle">
      <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim hover:text-lr-text-muted">
        {label}
      </summary>
      <div className="px-3 pb-3">
        {id === "basic" ? <BasicControls /> : null}
        {id === "curve" ? <CurveControls /> : null}
        {id === "mixer" ? <MixerControls /> : null}
        {id === "effects" ? <EffectsControls /> : null}
        <button
          type="button"
          onClick={() => resetPlugin(id)}
          className="mt-2 rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-dim hover:bg-lr-panel-raised hover:text-lr-text-muted"
        >
          Reset {label}
        </button>
      </div>
    </details>
  );
}

function BasicControls() {
  const basic = useDevelopStore((state) => state.settings.basic);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);

  return (
    <div>
      <SliderRow label="Exposure" value={basic.exposure} min={-5} max={5} step={0.05} onChange={(exposure) => updatePlugin("basic", { exposure })} />
      <SliderRow label="Contrast" value={basic.contrast} min={-100} max={100} onChange={(contrast) => updatePlugin("basic", { contrast })} />
      <SliderRow label="Highlights" value={basic.highlights} min={-100} max={100} onChange={(highlights) => updatePlugin("basic", { highlights })} />
      <SliderRow label="Shadows" value={basic.shadows} min={-100} max={100} onChange={(shadows) => updatePlugin("basic", { shadows })} />
      <SliderRow label="Whites" value={basic.whites} min={-100} max={100} onChange={(whites) => updatePlugin("basic", { whites })} />
      <SliderRow label="Blacks" value={basic.blacks} min={-100} max={100} onChange={(blacks) => updatePlugin("basic", { blacks })} />
      <SliderRow label="Temp" value={basic.temperature} min={-3000} max={3000} step={50} suffix="K" onChange={(temperature) => updatePlugin("basic", { temperature })} />
      <SliderRow label="Tint" value={basic.tint} min={-150} max={150} onChange={(tint) => updatePlugin("basic", { tint })} />
      <SliderRow label="Vibrance" value={basic.vibrance} min={-100} max={100} onChange={(vibrance) => updatePlugin("basic", { vibrance })} />
      <SliderRow label="Saturation" value={basic.saturation} min={-100} max={100} onChange={(saturation) => updatePlugin("basic", { saturation })} />
    </div>
  );
}

function CurveControls() {
  const curve = useDevelopStore((state) => state.settings.curve);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);

  return <ToneCurveEditor settings={curve} onChange={(settings) => updatePlugin("curve", settings)} />;
}

function MixerControls() {
  const [mode, setMode] = useState<MixerMode>("hue");
  const mixer = useDevelopStore((state) => state.settings.mixer);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);

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
    <div>
      <div className="mb-2 grid grid-cols-4 border-b border-lr-border-subtle" role="tablist" aria-label="HSL adjustment">
        {MIXER_MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            onClick={() => setMode(item.id)}
            className={`border-b px-1 py-1.5 text-[10px] ${
              mode === item.id
                ? "border-lr-text-muted text-lr-text"
                : "border-transparent text-lr-text-dim hover:text-lr-text-muted"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {mode === "all" ? (
        <div className="space-y-3">
          {(["hue", "saturation", "luminance"] as const).map((property) => (
            <section key={property}>
              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
                {property}
              </h3>
              {rows(property)}
            </section>
          ))}
        </div>
      ) : (
        rows(mode)
      )}
    </div>
  );
}

function EffectsControls() {
  const effects = useDevelopStore((state) => state.settings.effects);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);

  return (
    <div>
      <SliderRow label="Vignette" value={effects.vignette} min={-100} max={100} onChange={(vignette) => updatePlugin("effects", { vignette })} />
      <SliderRow label="Grain" value={effects.grain} min={0} max={100} onChange={(grain) => updatePlugin("effects", { grain })} />
      <SliderRow label="Sharpen" value={effects.sharpening} min={0} max={100} onChange={(sharpening) => updatePlugin("effects", { sharpening })} />
      <SliderRow label="Noise NR" value={effects.noiseReduction} min={0} max={100} onChange={(noiseReduction) => updatePlugin("effects", { noiseReduction })} />
    </div>
  );
}
