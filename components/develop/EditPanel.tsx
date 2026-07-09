"use client";

import { DEFAULT_DEVELOP_SETTINGS } from "@/lib/develop/registry";
import { MIXER_COLORS } from "@/lib/develop/plugins/mixer";
import type { DevelopPluginId, MixerColor } from "@/lib/develop/types";
import { useDevelopStore } from "@/stores/develop-store";
import { SliderRow } from "@/components/develop/SliderRow";

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

const EDIT_SECTIONS: ReadonlyArray<{ id: DevelopPluginId; label: string }> = [
  { id: "crop", label: "Crop & Transform" },
  { id: "basic", label: "Basic" },
  { id: "curve", label: "Tone Curve" },
  { id: "mixer", label: "Color Mixer" },
  { id: "effects", label: "Effects & Details" },
];

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
        {EDIT_SECTIONS.map((section) => (
          <PluginSection key={section.id} id={section.id} label={section.label} />
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
        {id === "crop" ? <CropControls /> : null}
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

function CropControls() {
  const crop = useDevelopStore((state) => state.settings.crop);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);

  return (
    <div>
      <label className="mb-2 flex items-center gap-2 text-xs text-lr-text-muted">
        <input
          type="checkbox"
          checked={crop.enabled}
          onChange={(event) =>
            updatePlugin("crop", { enabled: event.target.checked })
          }
        />
        Enable crop
      </label>
      <SliderRow label="Left" value={crop.x} min={0} max={0.95} step={0.01} onChange={(x) => updatePlugin("crop", { x })} />
      <SliderRow label="Top" value={crop.y} min={0} max={0.95} step={0.01} onChange={(y) => updatePlugin("crop", { y })} />
      <SliderRow label="Width" value={crop.width} min={0.05} max={1} step={0.01} onChange={(width) => updatePlugin("crop", { width })} />
      <SliderRow label="Height" value={crop.height} min={0.05} max={1} step={0.01} onChange={(height) => updatePlugin("crop", { height })} />
      <SliderRow label="Straighten" value={crop.angle} min={-45} max={45} step={0.1} suffix="deg" onChange={(angle) => updatePlugin("crop", { angle })} />
      <SliderRow label="Perspective X" value={crop.perspectiveX} min={-100} max={100} onChange={(perspectiveX) => updatePlugin("crop", { perspectiveX })} />
      <SliderRow label="Perspective Y" value={crop.perspectiveY} min={-100} max={100} onChange={(perspectiveY) => updatePlugin("crop", { perspectiveY })} />
      <SliderRow label="Distortion" value={crop.distortion} min={-100} max={100} onChange={(distortion) => updatePlugin("crop", { distortion })} />
    </div>
  );
}

function BasicControls() {
  const basic = useDevelopStore((state) => state.settings.basic);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const defaults = DEFAULT_DEVELOP_SETTINGS.basic;

  return (
    <div>
      <SliderRow label="Exposure" value={basic.exposure} min={-5} max={5} step={0.05} onChange={(exposure) => updatePlugin("basic", { exposure })} onReset={() => updatePlugin("basic", { exposure: defaults.exposure })} />
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

  return (
    <div>
      <SliderRow label="Shadows" value={curve.shadows} min={-100} max={100} onChange={(shadows) => updatePlugin("curve", { shadows })} />
      <SliderRow label="Midtones" value={curve.midtones} min={-100} max={100} onChange={(midtones) => updatePlugin("curve", { midtones })} />
      <SliderRow label="Highlights" value={curve.highlights} min={-100} max={100} onChange={(highlights) => updatePlugin("curve", { highlights })} />
    </div>
  );
}

function MixerControls() {
  const mixer = useDevelopStore((state) => state.settings.mixer);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);

  return (
    <div className="space-y-3">
      {MIXER_COLORS.map((color) => (
        <div key={color}>
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
            {MIXER_LABELS[color]}
          </h3>
          <SliderRow label="Hue" value={mixer[color].hue} min={-100} max={100} onChange={(hue) => updatePlugin("mixer", { [color]: { ...mixer[color], hue } })} />
          <SliderRow label="Sat" value={mixer[color].saturation} min={-100} max={100} onChange={(saturation) => updatePlugin("mixer", { [color]: { ...mixer[color], saturation } })} />
          <SliderRow label="Lum" value={mixer[color].luminance} min={-100} max={100} onChange={(luminance) => updatePlugin("mixer", { [color]: { ...mixer[color], luminance } })} />
        </div>
      ))}
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
