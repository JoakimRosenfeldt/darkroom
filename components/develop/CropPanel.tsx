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
  crop: CropSettings | null;
  imageWidth: number;
  imageHeight: number;
  onChange: (crop: CropSettings, preserveFrame?: boolean) => void;
  onReset: () => void;
  onActivate?: () => void;
}

export function CropPanel({
  crop,
  imageWidth,
  imageHeight,
  onChange,
  onReset,
  onActivate,
}: CropPanelProps) {
  function updateCrop(patch: Partial<CropSettings>) {
    if (!crop) {
      return;
    }
    const next = { ...crop, ...patch };
    onChange(
      {
        ...next,
        x: "x" in patch ? Math.min(next.x, 1 - crop.width) : next.x,
        y: "y" in patch ? Math.min(next.y, 1 - crop.height) : next.y,
        width:
          "width" in patch ? Math.min(next.width, 1 - crop.x) : next.width,
        height:
          "height" in patch ? Math.min(next.height, 1 - crop.y) : next.height,
      },
      "x" in patch || "y" in patch,
    );
  }

  function selectAspectPreset(presetId: AspectRatioPresetId) {
    if (!crop) {
      return;
    }
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
    if (!crop) {
      return;
    }
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
    <section
      id="develop-crop-section"
      tabIndex={-1}
      aria-label="Crop and geometry"
      className="outline-none"
    >
      <div className="flex items-center justify-between border-b border-lr-border-subtle px-4 py-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
          Crop &amp; geometry
        </h2>
        {crop ? (
          <button
            type="button"
            onClick={onReset}
            className="rounded-md border border-lr-border-subtle px-2.5 py-1.5 text-[11px] text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
          >
            Reset
          </button>
        ) : null}
      </div>

      {crop ? (
        <>
          <section className="border-b border-lr-border-subtle px-4 pb-[18px] pt-3.5">
            <div className="mb-2.5 flex items-center gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
                Aspect ratio
              </h3>
              <div className="flex-1" />
              <span className="text-[10px] text-lr-text-faint">
                {crop.aspectPreset === "free" ? "Unlocked" : "Locked"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {ASPECT_RATIO_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={crop.aspectPreset === preset.id}
                  onClick={() => selectAspectPreset(preset.id)}
                  className={`flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2 text-[10px] ${
                    crop.aspectPreset === preset.id
                      ? "border-lr-accent bg-lr-selection text-lr-text"
                      : "border-lr-border-subtle text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text"
                  }`}
                >
                  <AspectGlyph
                    presetId={preset.id}
                    imageWidth={imageWidth}
                    imageHeight={imageHeight}
                    customWidth={crop.customAspectWidth}
                    customHeight={crop.customAspectHeight}
                  />
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

          </section>

          <section className="border-b border-lr-border-subtle px-4 pb-[18px] pt-3.5">
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lr-text-muted">
                Frame &amp; geometry
              </h3>
              <div className="flex-1" />
              <span className="text-[10px] text-lr-text-faint">Drag on canvas</span>
            </div>
            <SliderRow label="Left" value={crop.x} min={0} max={1 - crop.width} step={0.01} onChange={(x) => updateCrop({ x })} />
            <SliderRow label="Top" value={crop.y} min={0} max={1 - crop.height} step={0.01} onChange={(y) => updateCrop({ y })} />
            <SliderRow label="Width" value={crop.width} min={0.05} max={1} step={0.01} resetValue={1} onChange={(width) => updateCrop({ width })} />
            <SliderRow label="Height" value={crop.height} min={0.05} max={1} step={0.01} resetValue={1} onChange={(height) => updateCrop({ height })} />
            <SliderRow label="Perspective X" value={crop.perspectiveX} min={-100} max={100} onChange={(perspectiveX) => onChange({ ...crop, perspectiveX })} />
            <SliderRow label="Perspective Y" value={crop.perspectiveY} min={-100} max={100} onChange={(perspectiveY) => onChange({ ...crop, perspectiveY })} />
            <SliderRow label="Distortion" value={crop.distortion} min={-100} max={100} onChange={(distortion) => onChange({ ...crop, distortion })} />
            <p className="mt-2 text-[10px] leading-relaxed text-lr-text-faint">
              Drag the image to reposition it. Pull an edge or corner to resize.
            </p>
          </section>
        </>
      ) : (
        <div className="space-y-3 px-4 py-4">
          <p className="text-[11px] leading-relaxed text-lr-text-muted">
            Activate crop to adjust framing, aspect ratio, and geometry.
          </p>
          <button
            type="button"
            onClick={onActivate}
            className="rounded-md border border-lr-border-subtle px-3 py-2 text-xs text-lr-text-muted transition hover:bg-lr-panel-raised hover:text-lr-text"
          >
            Activate crop
          </button>
        </div>
      )}
    </section>
  );
}

function AspectGlyph({
  presetId,
  imageWidth,
  imageHeight,
  customWidth,
  customHeight,
}: {
  presetId: AspectRatioPresetId;
  imageWidth: number;
  imageHeight: number;
  customWidth: number;
  customHeight: number;
}) {
  const ratio = resolveAspectRatio(
    presetId,
    imageWidth,
    imageHeight,
    customWidth,
    customHeight,
  ) ?? imageWidth / imageHeight;
  const width = ratio >= 1 ? 22 : Math.max(9, Math.round(18 * ratio));
  const height = ratio >= 1 ? Math.max(9, Math.round(22 / ratio)) : 18;

  return (
    <span
      aria-hidden="true"
      className="block rounded-[2px] border border-current opacity-80"
      style={{ width, height }}
    />
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
      <span className="text-lr-text-muted">{label}</span>
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
