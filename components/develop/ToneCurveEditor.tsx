"use client";

import { useRef, useState } from "react";
import type {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  DEFAULT_CURVE_SETTINGS,
  sampleCurve,
} from "@/lib/develop/plugins/curve";
import type {
  CurveChannel,
  CurvePoint,
  CurveSettings,
} from "@/lib/develop/types";

const SIZE = 256;
const INSET = 8;
const PLOT_SIZE = SIZE - INSET * 2;
const MIN_GAP = 1 / 255;

const CHANNELS: { id: CurveChannel; label: string; color: string }[] = [
  { id: "rgb", label: "RGB", color: "#d4d4d4" },
  { id: "red", label: "R", color: "#ef6767" },
  { id: "green", label: "G", color: "#62c979" },
  { id: "blue", label: "B", color: "#69a7f5" },
];

function svgPoint(point: CurvePoint): { x: number; y: number } {
  return {
    x: INSET + point.x * PLOT_SIZE,
    y: INSET + (1 - point.y) * PLOT_SIZE,
  };
}

function pathFor(points: CurvePoint[]): string {
  return Array.from({ length: 64 }, (_, index) => {
    const x = index / 63;
    const point = svgPoint({ x, y: sampleCurve(points, x) });
    return `${index === 0 ? "M" : "L"}${point.x} ${point.y}`;
  }).join(" ");
}

export function ToneCurveEditor({
  settings,
  onChange,
}: {
  settings: CurveSettings;
  onChange: (settings: CurveSettings) => void;
}) {
  const [channel, setChannel] = useState<CurveChannel>("rgb");
  const [selected, setSelected] = useState<number | null>(null);
  const dragIndex = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const points = settings[channel];
  const channelInfo = CHANNELS.find((item) => item.id === channel)!;

  const eventPoint = (clientX: number, clientY: number): CurvePoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * SIZE;
    const y = ((clientY - rect.top) / rect.height) * SIZE;
    return {
      x: Math.min(1, Math.max(0, (x - INSET) / PLOT_SIZE)),
      y: Math.min(1, Math.max(0, 1 - (y - INSET) / PLOT_SIZE)),
    };
  };

  const commitPoint = (index: number, point: CurvePoint) => {
    const next = points.map((current, currentIndex) => {
      if (currentIndex !== index) {
        return current;
      }
      const isFirst = index === 0;
      const isLast = index === points.length - 1;
      const minX = isFirst ? 0 : points[index - 1].x + MIN_GAP;
      const maxX = isLast ? 1 : points[index + 1].x - MIN_GAP;
      return {
        x: isFirst ? 0 : isLast ? 1 : Math.min(maxX, Math.max(minX, point.x)),
        y: point.y,
      };
    });
    onChange({ ...settings, [channel]: next });
  };

  const addPoint = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const point = eventPoint(event.clientX, event.clientY);
    const next = [...points, point].sort((a, b) => a.x - b.x);
    const index = next.indexOf(point);
    onChange({ ...settings, [channel]: next });
    setSelected(index);
    dragIndex.current = index;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const removePoint = (index: number) => {
    if (index === 0 || index === points.length - 1) {
      return;
    }
    onChange({
      ...settings,
      [channel]: points.filter((_, pointIndex) => pointIndex !== index),
    });
    setSelected(null);
  };

  const handlePointKey = (event: KeyboardEvent<SVGCircleElement>, index: number) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removePoint(index);
      return;
    }
    const step = (event.shiftKey ? 5 : 1) / 255;
    const point = points[index];
    const deltaX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const deltaY = event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0;
    if (deltaX || deltaY) {
      event.preventDefault();
      commitPoint(index, {
        x: point.x + deltaX,
        y: Math.min(1, Math.max(0, point.y + deltaY)),
      });
    }
  };

  const selectedPoint = selected === null ? null : points[selected];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex gap-1" role="tablist" aria-label="Tone curve channel">
          {CHANNELS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={channel === item.id}
              onClick={() => {
                setChannel(item.id);
                setSelected(null);
              }}
              className={`min-w-8 rounded-sm border px-2 py-1 text-[10px] font-semibold ${
                channel === item.id
                  ? "border-lr-text-dim bg-lr-panel-raised text-lr-text"
                  : "border-transparent text-lr-text-dim hover:text-lr-text-muted"
              }`}
              style={{ color: channel === item.id ? item.color : undefined }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            onChange({
              ...settings,
              [channel]: structuredClone(DEFAULT_CURVE_SETTINGS[channel]),
            });
            setSelected(null);
          }}
          className="text-[10px] text-lr-text-dim hover:text-lr-text-muted"
        >
          Reset channel
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="group"
        aria-label={`${channelInfo.label} point curve. Click to add a point and drag points to adjust.`}
        onPointerDown={addPoint}
        onPointerMove={(event) => {
          if (dragIndex.current === null) {
            return;
          }
          commitPoint(dragIndex.current, eventPoint(event.clientX, event.clientY));
        }}
        onPointerUp={() => {
          dragIndex.current = null;
        }}
        onPointerCancel={() => {
          dragIndex.current = null;
        }}
        className="block w-full touch-none cursor-crosshair rounded-sm border border-lr-border bg-[#181818]"
      >
        <rect x={INSET} y={INSET} width={PLOT_SIZE} height={PLOT_SIZE} fill="transparent" pointerEvents="none" />
        {[0.25, 0.5, 0.75].map((position) => (
          <g key={position} pointerEvents="none" stroke="#353535" strokeWidth="1">
            <line x1={INSET + position * PLOT_SIZE} y1={INSET} x2={INSET + position * PLOT_SIZE} y2={SIZE - INSET} />
            <line x1={INSET} y1={INSET + position * PLOT_SIZE} x2={SIZE - INSET} y2={INSET + position * PLOT_SIZE} />
          </g>
        ))}
        <line x1={INSET} y1={SIZE - INSET} x2={SIZE - INSET} y2={INSET} stroke="#464646" strokeWidth="1" pointerEvents="none" />
        <path d={pathFor(points)} fill="none" stroke={channelInfo.color} strokeWidth="2" pointerEvents="none" />
        {points.map((point, index) => {
          const position = svgPoint(point);
          return (
            <circle
              key={index}
              cx={position.x}
              cy={position.y}
              r={selected === index ? 5 : 4}
              fill="#1a1a1a"
              stroke={channelInfo.color}
              strokeWidth="2"
              tabIndex={0}
              role="button"
              aria-label={`Point ${index + 1}: input ${Math.round(point.x * 255)}, output ${Math.round(point.y * 255)}`}
              onFocus={() => setSelected(index)}
              onKeyDown={(event) => handlePointKey(event, index)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                removePoint(index);
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
                setSelected(index);
                dragIndex.current = index;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              className="cursor-grab outline-none focus-visible:stroke-[3px] active:cursor-grabbing"
            />
          );
        })}
      </svg>

      <div className="mt-1 flex justify-between text-[10px] text-lr-text-dim">
        <span>Double-click a point to remove</span>
        <span className="font-mono">
          {selectedPoint
            ? `${Math.round(selectedPoint.x * 255)} / ${Math.round(selectedPoint.y * 255)}`
            : "Input / Output"}
        </span>
      </div>
    </div>
  );
}
