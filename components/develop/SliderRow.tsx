"use client";

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
  onReset?: () => void;
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
  onReset,
}: SliderRowProps) {
  return (
    <label
      className="grid grid-cols-[86px_1fr_42px] items-center gap-2 py-1 text-xs"
      onDoubleClick={onReset}
    >
      <span className="text-lr-text-dim">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-lr-accent"
      />
      <span className="text-right font-mono text-[10px] text-lr-text-muted">
        {value > 0 ? "+" : ""}
        {value}
        {suffix}
      </span>
    </label>
  );
}
