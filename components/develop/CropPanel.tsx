"use client";

import { useDevelopStore } from "@/stores/develop-store";
import { SliderRow } from "@/components/develop/SliderRow";

export function CropPanel() {
  const crop = useDevelopStore((state) => state.settings.crop);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const resetPlugin = useDevelopStore((state) => state.resetPlugin);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex items-center justify-between border-b border-lr-border-subtle px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-muted">
          Crop
        </h2>
        <button
          type="button"
          onClick={() => resetPlugin("crop")}
          className="rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
        >
          Reset
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3 py-3">
        <label className="mb-3 flex items-center gap-2 text-xs text-lr-text-muted">
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
    </aside>
  );
}
