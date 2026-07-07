"use client";

import { useEffect, useState } from "react";
import {
  ASPECT_RATIO_PRESETS,
  fitCropToAspectRatio,
  parseAspectRatioInput,
  resolveAspectRatio,
  type AspectRatioPresetId,
} from "@/lib/develop/crop-geometry";
import { useDevelopStore } from "@/stores/develop-store";
import { SliderRow } from "@/components/develop/SliderRow";

interface CropPanelProps {
  imageWidth: number;
  imageHeight: number;
}

export function CropPanel({ imageWidth, imageHeight }: CropPanelProps) {
  const crop = useDevelopStore((state) => state.settings.crop);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const resetPlugin = useDevelopStore((state) => state.resetPlugin);
  const [customWidth, setCustomWidth] = useState(String(crop.customAspectWidth));
  const [customHeight, setCustomHeight] = useState(
    String(crop.customAspectHeight),
  );

  useEffect(() => {
    setCustomWidth(String(crop.customAspectWidth));
    setCustomHeight(String(crop.customAspectHeight));
  }, [crop.customAspectWidth, crop.customAspectHeight]);

  function selectAspectPreset(presetId: AspectRatioPresetId) {
    const ratio = resolveAspectRatio(
      presetId,
      imageWidth,
      imageHeight,
      crop.customAspectWidth,
      crop.customAspectHeight,
    );
    const patch = {
      aspectPreset: presetId,
      ...(ratio && crop.enabled ? fitCropToAspectRatio(crop, ratio) : {}),
    };
    updatePlugin("crop", patch);
  }

  function commitCustomAspect() {
    const width = Number(customWidth);
    const height = Number(customHeight);
    const ratio = parseAspectRatioInput(customWidth, customHeight);
    if (!ratio) {
      setCustomWidth(String(crop.customAspectWidth));
      setCustomHeight(String(crop.customAspectHeight));
      return;
    }
    const patch = {
      aspectPreset: "custom" as const,
      customAspectWidth: width,
      customAspectHeight: height,
      ...(crop.enabled ? fitCropToAspectRatio(crop, ratio) : {}),
    };
    updatePlugin("crop", patch);
  }

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

        <p className="mb-1 text-[11px] uppercase tracking-wider text-lr-text-dim">
          Aspect ratio
        </p>
        <div className="mb-3 grid grid-cols-2 gap-1">
          {ASPECT_RATIO_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => selectAspectPreset(preset.id)}
              className={`rounded border px-2 py-1.5 text-left text-[11px] ${
                crop.aspectPreset === preset.id
                  ? "border-lr-accent bg-lr-panel-raised text-lr-text"
                  : "border-lr-border-subtle text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {crop.aspectPreset === "custom" ? (
          <div className="mb-3 flex items-center gap-2">
            <label className="flex flex-1 items-center gap-1 text-xs text-lr-text-muted">
              <span className="text-lr-text-dim">W</span>
              <input
                type="number"
                min={1}
                step={1}
                value={customWidth}
                onChange={(event) => setCustomWidth(event.target.value)}
                onBlur={commitCustomAspect}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitCustomAspect();
                  }
                }}
                className="w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1 font-mono text-[11px] text-lr-text"
              />
            </label>
            <span className="text-xs text-lr-text-dim">:</span>
            <label className="flex flex-1 items-center gap-1 text-xs text-lr-text-muted">
              <span className="text-lr-text-dim">H</span>
              <input
                type="number"
                min={1}
                step={1}
                value={customHeight}
                onChange={(event) => setCustomHeight(event.target.value)}
                onBlur={commitCustomAspect}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitCustomAspect();
                  }
                }}
                className="w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1 font-mono text-[11px] text-lr-text"
              />
            </label>
          </div>
        ) : null}

        <p className="mb-1 mt-2 text-[11px] text-lr-text-dim">
          Drag inside the image to move or resize the crop.
        </p>

        <SliderRow
          label="Straighten"
          value={crop.angle}
          min={-45}
          max={45}
          step={0.1}
          suffix="°"
          onChange={(angle) => updatePlugin("crop", { angle })}
        />
      </div>
    </aside>
  );
}
