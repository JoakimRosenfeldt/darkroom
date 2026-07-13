"use client";

import type { CSSProperties } from "react";

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
}

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
}: SliderRowProps) {
  return (
    <div className={`grid grid-cols-[86px_1fr_42px] items-center gap-2 py-1 text-xs ${disabled ? "opacity-40" : ""}`}>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Reset ${label}`}
        onClick={() => onChange(resetValue)}
        className="group cursor-pointer select-none rounded-sm text-left text-lr-text-dim hover:text-lr-text-muted focus-visible:outline focus-visible:outline-lr-text-dim disabled:pointer-events-none"
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
        onChange={(event) => onChange(Number(event.target.value))}
        style={track ? ({ "--develop-slider-track": track } as CSSProperties) : undefined}
        className="develop-slider"
      />
      <span className="text-right font-mono text-[10px] text-lr-text-muted">
        {value > 0 ? "+" : ""}
        {value}
        {suffix}
      </span>
    </div>
  );
}
