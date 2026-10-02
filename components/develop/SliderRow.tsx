"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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

type SliderHandler = (value: number) => void;

// Returns stable handlers by id that call the latest render's closure, so memoized rows never act on stale edits.
export function useSliderHandlers(
  handlers: Readonly<Record<string, SliderHandler>>,
): (id: string) => SliderHandler {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const ids = Object.keys(handlers).join("\n");
  const stable = useMemo(() => new Map(ids.split("\n").map((id) => [
    id,
    (value: number) => latest.current[id]?.(value),
  ])), [ids]);
  return (id) => {
    const handler = stable.get(id);
    if (!handler) throw new Error(`Slider handler ${id} is not registered.`);
    return handler;
  };
}

export const SliderRow = memo(function SliderRow({
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
  // Inputs beyond the first in a frame wait for the next frame; the draft keeps the thumb under the pointer.
  const [draft, setDraft] = useState<number | null>(null);
  const shownValue = draft ?? value;
  const decimalPlaces = step.toString().split(".")[1]?.length ?? 0;
  const displayValue = shownValue.toFixed(decimalPlaces);
  const beginEditGroup = useDevelopStore((state) => state.beginEditGroup);
  const endEditGroup = useDevelopStore((state) => state.endEditGroup);
  const cancelEditGroup = useDevelopStore((state) => state.cancelEditGroup);
  const activeEntryId = useDevelopStore((state) => state.activeEntryId);
  const interactionActive = useRef(false);
  const onChangeRef = useRef(onChange);
  const pendingValue = useRef<number | null>(null);
  const frame = useRef(0);

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });

  function dropPending(): void {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    pendingValue.current = null;
    setDraft(null);
  }

  function flushPending(): void {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const pending = pendingValue.current;
    pendingValue.current = null;
    if (pending === null) return;
    onChangeRef.current(pending);
    setDraft(null);
  }

  function nextFrame(): void {
    const pending = pendingValue.current;
    pendingValue.current = null;
    if (pending === null) {
      frame.current = 0;
      return;
    }
    frame.current = requestAnimationFrame(nextFrame);
    onChangeRef.current(pending);
    setDraft(null);
  }

  function change(next: number): void {
    if (frame.current) {
      pendingValue.current = next;
      setDraft(next);
      return;
    }
    frame.current = requestAnimationFrame(nextFrame);
    onChangeRef.current(next);
  }

  function reset(): void {
    flushPending();
    onChangeRef.current(resetValue);
  }

  useEffect(() => {
    interactionActive.current = false;
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      pendingValue.current = null;
    };
  }, [activeEntryId]);

  function beginInteraction(): void {
    if (interactionActive.current) return;
    interactionActive.current = true;
    beginEditGroup(`Adjust ${label}`);
    onInteractionStart?.();
  }

  function endInteraction(): void {
    if (!interactionActive.current) return;
    interactionActive.current = false;
    flushPending();
    endEditGroup();
    onInteractionEnd?.();
  }

  function cancelInteraction(): void {
    if (!interactionActive.current) return;
    interactionActive.current = false;
    dropPending();
    cancelEditGroup();
    onInteractionEnd?.();
  }

  return (
    <div className={`grid grid-cols-[92px_1fr_64px] items-center gap-2.5 py-1 text-xs ${disabled ? "opacity-40" : ""}`}>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Reset ${label}`}
        onClick={reset}
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
        value={shownValue}
        disabled={disabled}
        onPointerDown={beginInteraction}
        onPointerUp={endInteraction}
        onPointerCancel={cancelInteraction}
        onBlur={endInteraction}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancelInteraction();
            return;
          }
          if (RANGE_ADJUSTMENT_KEYS.has(event.key)) beginInteraction();
        }}
        onKeyUp={(event) => {
          if (RANGE_ADJUSTMENT_KEYS.has(event.key)) endInteraction();
        }}
        onChange={(event) => change(Number(event.target.value))}
        onDoubleClick={reset}
        style={track ? ({ "--develop-slider-track": track } as CSSProperties) : undefined}
        className="develop-slider"
      />
      <span className="text-right font-mono text-xs text-lr-text-muted">
        {shownValue > 0 ? "+" : ""}
        {displayValue}
        {suffix}
      </span>
    </div>
  );
});
