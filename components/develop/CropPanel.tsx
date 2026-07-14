"use client";

import { useState } from "react";
import {
  ASPECT_RATIO_PRESETS,
  fitCropToAspectRatio,
  parseAspectRatioInput,
  resolveAspectRatio,
  type AspectRatioPresetId,
} from "@/lib/develop/crop-geometry";
import { useDevelopStore } from "@/stores/develop-store";
import { SliderRow } from "@/components/develop/SliderRow";
import { DEFAULT_CROP_SETTINGS } from "@/lib/develop/plugins/crop";

interface CropPanelProps {
  imageWidth: number;
  imageHeight: number;
}

export function CropPanel({ imageWidth, imageHeight }: CropPanelProps) {
  const crop = useDevelopStore((state) => state.settings.crop);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const resetPlugin = useDevelopStore((state) => state.resetPlugin);

  function updateCrop(patch: Partial<typeof crop>) {
    const next = { ...crop, ...patch };
    updatePlugin("crop", {
      ...patch,
      width: Math.min(next.width, 1 - next.x),
      height: Math.min(next.height, 1 - next.y),
    });
  }

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
            onChange={(event) => event.target.checked
              ? updatePlugin("crop", { enabled: true })
              : updatePlugin("crop", DEFAULT_CROP_SETTINGS)}
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
          <CustomAspectInputs
            key={`${crop.customAspectWidth}:${crop.customAspectHeight}`}
            width={crop.customAspectWidth}
            height={crop.customAspectHeight}
            onCommit={commitCustomAspect}
          />
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
          disabled={!crop.enabled}
          onChange={(angle) => updatePlugin("crop", { angle })}
        />
        <SliderRow label="Left" value={crop.x} min={0} max={0.95} step={0.01} disabled={!crop.enabled} onChange={(x) => updateCrop({ x })} />
        <SliderRow label="Top" value={crop.y} min={0} max={0.95} step={0.01} disabled={!crop.enabled} onChange={(y) => updateCrop({ y })} />
        <SliderRow label="Width" value={crop.width} min={0.05} max={1} step={0.01} disabled={!crop.enabled} resetValue={1} onChange={(width) => updateCrop({ width })} />
        <SliderRow label="Height" value={crop.height} min={0.05} max={1} step={0.01} disabled={!crop.enabled} resetValue={1} onChange={(height) => updateCrop({ height })} />
        <SliderRow label="Perspective X" value={crop.perspectiveX} min={-100} max={100} disabled={!crop.enabled} onChange={(perspectiveX) => updatePlugin("crop", { perspectiveX })} />
        <SliderRow label="Perspective Y" value={crop.perspectiveY} min={-100} max={100} disabled={!crop.enabled} onChange={(perspectiveY) => updatePlugin("crop", { perspectiveY })} />
        <SliderRow label="Distortion" value={crop.distortion} min={-100} max={100} disabled={!crop.enabled} onChange={(distortion) => updatePlugin("crop", { distortion })} />
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
