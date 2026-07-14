"use client";

import { useState } from "react";
import {
  ASPECT_RATIO_PRESETS,
  fitCropToAspectRatio,
  parseAspectRatioInput,
  resolveAspectRatio,
  type AspectRatioPresetId,
} from "@/lib/develop/crop-geometry";
import type { CropSettings } from "@/lib/develop/types";
import { SliderRow } from "@/components/develop/SliderRow";

interface CropPanelProps {
  crop: CropSettings;
  imageWidth: number;
  imageHeight: number;
  onChange: (crop: CropSettings, preserveFrame?: boolean) => void;
  onReset: () => void;
  onApply: () => void;
  onCancel: () => void;
}

export function CropPanel({
  crop,
  imageWidth,
  imageHeight,
  onChange,
  onReset,
  onApply,
  onCancel,
}: CropPanelProps) {
  function updateCrop(patch: Partial<typeof crop>) {
    const next = { ...crop, ...patch };
    onChange({
      ...next,
      x: "x" in patch ? Math.min(next.x, 1 - crop.width) : next.x,
      y: "y" in patch ? Math.min(next.y, 1 - crop.height) : next.y,
      width: "width" in patch ? Math.min(next.width, 1 - crop.x) : next.width,
      height: "height" in patch ? Math.min(next.height, 1 - crop.y) : next.height,
    }, "x" in patch || "y" in patch);
  }

  function selectAspectPreset(presetId: AspectRatioPresetId) {
    const ratio = resolveAspectRatio(
      presetId,
      imageWidth,
      imageHeight,
      crop.customAspectWidth,
      crop.customAspectHeight,
    );
    onChange({
      ...crop,
      aspectPreset: presetId,
      ...(ratio ? fitCropToAspectRatio(crop, ratio) : {}),
    });
  }

  function commitCustomAspect(width: number, height: number) {
    const ratio = resolveAspectRatio(
      "custom",
      imageWidth,
      imageHeight,
      width,
      height,
    );
    if (!ratio) {
      return;
    }
    onChange({
      ...crop,
      aspectPreset: "custom" as const,
      customAspectWidth: width,
      customAspectHeight: height,
      ...fitCropToAspectRatio(crop, ratio),
    });
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex items-center justify-between border-b border-lr-border-subtle px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-muted">
          Crop
        </h2>
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-lr-border-subtle px-2 py-1 text-[11px] text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
        >
          Reset
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3 py-3">
        <p className="mb-1 text-[11px] uppercase tracking-wider text-lr-text-dim">
          Aspect ratio
        </p>
        <div className="mb-3 grid grid-cols-2 gap-1">
          {ASPECT_RATIO_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={crop.aspectPreset === preset.id}
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
          <CustomAspectInputs
            key={`${crop.customAspectWidth}:${crop.customAspectHeight}`}
            width={crop.customAspectWidth}
            height={crop.customAspectHeight}
            onCommit={commitCustomAspect}
          />
        ) : null}

        <p className="mb-1 mt-2 text-[11px] text-lr-text-dim">
          Drag the image to position it. Pull an edge or corner to resize.
          Scroll over the image to inspect it more closely.
        </p>

        <SliderRow
          label="Straighten"
          value={crop.angle}
          min={-45}
          max={45}
          step={0.1}
          suffix="°"
          onChange={(angle) => onChange({ ...crop, angle })}
        />
        <SliderRow label="Left" value={crop.x} min={0} max={1 - crop.width} step={0.01} onChange={(x) => updateCrop({ x })} />
        <SliderRow label="Top" value={crop.y} min={0} max={1 - crop.height} step={0.01} onChange={(y) => updateCrop({ y })} />
        <SliderRow label="Width" value={crop.width} min={0.05} max={1} step={0.01} resetValue={1} onChange={(width) => updateCrop({ width })} />
        <SliderRow label="Height" value={crop.height} min={0.05} max={1} step={0.01} resetValue={1} onChange={(height) => updateCrop({ height })} />
        <SliderRow label="Perspective X" value={crop.perspectiveX} min={-100} max={100} onChange={(perspectiveX) => onChange({ ...crop, perspectiveX })} />
        <SliderRow label="Perspective Y" value={crop.perspectiveY} min={-100} max={100} onChange={(perspectiveY) => onChange({ ...crop, perspectiveY })} />
        <SliderRow label="Distortion" value={crop.distortion} min={-100} max={100} onChange={(distortion) => onChange({ ...crop, distortion })} />
      </div>

      <div className="border-t border-lr-border-subtle px-3 py-3">
        <p className="mb-2 text-[10px] uppercase tracking-wider text-lr-text-dim">
          Enter apply · Esc cancel
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-lr-border-subtle px-3 py-1.5 text-xs text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApply}
            className="rounded bg-lr-accent px-3 py-1.5 text-xs font-medium text-[#0d0d0d] hover:bg-lr-accent-hover"
          >
            Apply
          </button>
        </div>
      </div>
    </aside>
  );
}

function CustomAspectInputs({
  width,
  height,
  onCommit,
}: {
  width: number;
  height: number;
  onCommit: (width: number, height: number) => void;
}) {
  const [customWidth, setCustomWidth] = useState(String(width));
  const [customHeight, setCustomHeight] = useState(String(height));

  function commit() {
    const nextWidth = Number(customWidth);
    const nextHeight = Number(customHeight);
    if (!parseAspectRatioInput(customWidth, customHeight)) {
      setCustomWidth(String(width));
      setCustomHeight(String(height));
      return;
    }
    onCommit(nextWidth, nextHeight);
  }

  return (
    <div className="mb-3 flex items-center gap-2">
      <AspectInput label="W" value={customWidth} onChange={setCustomWidth} onCommit={commit} />
      <span className="text-xs text-lr-text-dim">:</span>
      <AspectInput label="H" value={customHeight} onChange={setCustomHeight} onCommit={commit} />
    </div>
  );
}

function AspectInput({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <label className="flex flex-1 items-center gap-1 text-xs text-lr-text-muted">
      <span className="text-lr-text-dim">{label}</span>
      <input
        type="number"
        min={1}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onCommit();
          }
        }}
        className="w-full rounded border border-lr-border-subtle bg-lr-panel-raised px-2 py-1 font-mono text-[11px] text-lr-text"
      />
    </label>
  );
}
