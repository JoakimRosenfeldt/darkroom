"use client";

import type { CSSProperties } from "react";
import { useDevelopStore } from "@/stores/develop-store";

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  resetValue?: number;
  track?: string;
  onChange: (value: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

export const COLOR_SLIDER_TRACKS = {
  temperature: "linear-gradient(90deg,#4f8fc0,#d9d3cb,#8fb8e0)",
  tint: "linear-gradient(90deg,#5cb073,#d9d3cb,#8e6ec4)",
  vibrance: "linear-gradient(90deg,#6e6863,#93887f,#b5806f,#a89a6e,#7fa085,#7290ab,#9082ab)",
  saturation: "linear-gradient(90deg,#6e6863,#8f8880,#d9564a,#d9b64a,#5cb073,#4f8fc0,#8e6ec4)",
} as const;

const RANGE_ADJUSTMENT_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  disabled = false,
  resetValue = 0,
  track,
  onChange,
  onInteractionStart,
  onInteractionEnd,
}: SliderRowProps) {
  const decimalPlaces = step.toString().split(".")[1]?.length ?? 0;
  const displayValue = value.toFixed(decimalPlaces);
  const beginEditGroup = useDevelopStore((state) => state.beginEditGroup);
  const endEditGroup = useDevelopStore((state) => state.endEditGroup);

  function beginInteraction(): void {
    beginEditGroup(`Adjust ${label}`);
    onInteractionStart?.();
  }

  function endInteraction(): void {
    endEditGroup();
    onInteractionEnd?.();
  }

  return (
    <div className={`grid grid-cols-[92px_1fr_64px] items-center gap-2.5 py-1 text-xs ${disabled ? "opacity-40" : ""}`}>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Reset ${label}`}
        onClick={() => onChange(resetValue)}
        className="group cursor-pointer select-none rounded-sm text-left text-lr-text-muted hover:text-lr-text focus-visible:outline focus-visible:outline-lr-text-dim disabled:pointer-events-none"
      >
        <span aria-hidden="true" className="group-hover:hidden group-focus-visible:hidden">
          {label}
        </span>
        <span aria-hidden="true" className="hidden group-hover:inline group-focus-visible:inline">
          Reset
        </span>
      </button>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={beginInteraction}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
        onBlur={endInteraction}
        onKeyDown={(event) => {
          if (RANGE_ADJUSTMENT_KEYS.has(event.key)) beginInteraction();
        }}
        onKeyUp={(event) => {
          if (RANGE_ADJUSTMENT_KEYS.has(event.key)) endInteraction();
        }}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={() => onChange(resetValue)}
        style={track ? ({ "--develop-slider-track": track } as CSSProperties) : undefined}
        className="develop-slider"
      />
      <span className="text-right font-mono text-[11px] text-lr-text-muted">
        {value > 0 ? "+" : ""}
        {displayValue}
        {suffix}
      </span>
    </div>
  );
}
