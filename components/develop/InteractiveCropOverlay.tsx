"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyCropDrag,
  clampCropRect,
  computeContainedImageRect,
  type CropHandle,
  resolveAspectRatio,
} from "@/lib/develop/crop-geometry";
import { useDevelopStore } from "@/stores/develop-store";

interface InteractiveCropOverlayProps {
  imageWidth: number;
  imageHeight: number;
}

const HANDLE_CURSORS: Record<CropHandle, string> = {
  move: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  sw: "nesw-resize",
};

const HANDLE_POSITIONS: Array<{
  handle: CropHandle;
  className: string;
}> = [
  { handle: "nw", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2" },
  { handle: "n", className: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2" },
  { handle: "ne", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2" },
  { handle: "e", className: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2" },
  { handle: "se", className: "right-0 bottom-0 translate-x-1/2 translate-y-1/2" },
  { handle: "s", className: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2" },
  { handle: "sw", className: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2" },
  { handle: "w", className: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2" },
];

const EDGE_HIT_AREAS: Array<{
  handle: CropHandle;
  className: string;
}> = [
  { handle: "n", className: "left-3 right-3 top-0 h-3" },
  { handle: "e", className: "bottom-3 right-0 top-3 w-3" },
  { handle: "s", className: "bottom-0 left-3 right-3 h-3" },
  { handle: "w", className: "bottom-3 left-0 top-3 w-3" },
];

export function InteractiveCropOverlay({
  imageWidth,
  imageHeight,
}: InteractiveCropOverlayProps) {
  const crop = useDevelopStore((state) => state.settings.crop);
  const updatePlugin = useDevelopStore((state) => state.updatePlugin);
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageRect, setImageRect] = useState({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  const dragRef = useRef<{
    handle: CropHandle;
    startX: number;
    startY: number;
    startCrop: { x: number; y: number; width: number; height: number };
  } | null>(null);

  const measureImageRect = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    setImageRect(
      computeContainedImageRect(
        container.clientWidth,
        container.clientHeight,
        imageWidth,
        imageHeight,
      ),
    );
  }, [imageWidth, imageHeight]);

  useEffect(() => {
    measureImageRect();
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const observer = new ResizeObserver(measureImageRect);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measureImageRect, crop.enabled]);

  const aspectRatio = resolveAspectRatio(
    crop.aspectPreset,
    imageWidth,
    imageHeight,
    crop.customAspectWidth,
    crop.customAspectHeight,
  );
  const cropRect = clampCropRect(crop);

  function onPointerDown(handle: CropHandle, event: React.PointerEvent) {
    if (!crop.enabled) {
      updatePlugin("crop", { enabled: true });
    }
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = {
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: {
        x: cropRect.x,
        y: cropRect.y,
        width: cropRect.width,
        height: cropRect.height,
      },
    };
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || imageRect.width <= 0 || imageRect.height <= 0) {
      return;
    }

    const deltaX = (event.clientX - drag.startX) / imageRect.width;
    const deltaY = (event.clientY - drag.startY) / imageRect.height;
    const next = applyCropDrag(
      drag.startCrop,
      drag.handle,
      deltaX,
      deltaY,
      aspectRatio,
    );
    updatePlugin("crop", next);
  }

  function onPointerUp(event: React.PointerEvent) {
    if (dragRef.current) {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      dragRef.current = null;
    }
  }

  function enableCropOnImageClick(event: React.PointerEvent) {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const bounds = container.getBoundingClientRect();
    const rect = computeContainedImageRect(
      container.clientWidth,
      container.clientHeight,
      imageWidth,
      imageHeight,
    );
    const localX = event.clientX - bounds.left - rect.x;
    const localY = event.clientY - bounds.top - rect.y;
    if (
      localX < 0 ||
      localY < 0 ||
      localX > rect.width ||
      localY > rect.height
    ) {
      return;
    }
    updatePlugin("crop", { enabled: true });
  }

  if (!crop.enabled) {
    return (
      <div
        ref={containerRef}
        className="absolute inset-0 cursor-crosshair"
        onPointerDown={enableCropOnImageClick}
      />
    );
  }

  return (
    <div ref={containerRef} className="absolute inset-0">
      <div
        className="absolute overflow-hidden"
        style={{
          left: imageRect.x,
          top: imageRect.y,
          width: imageRect.width,
          height: imageRect.height,
        }}
      >
        <div
          className="absolute cursor-move border border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.32)]"
          style={{
            left: `${cropRect.x * 100}%`,
            top: `${cropRect.y * 100}%`,
            width: `${cropRect.width * 100}%`,
            height: `${cropRect.height * 100}%`,
          }}
          onPointerDown={(event) => onPointerDown("move", event)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="pointer-events-none grid h-full w-full grid-cols-3 grid-rows-3">
            {Array.from({ length: 9 }, (_, index) => (
              <div key={index} className="border border-white/20" />
            ))}
          </div>

          {EDGE_HIT_AREAS.map(({ handle, className }) => (
            <div
              key={handle}
              className={`absolute z-10 ${className}`}
              style={{ cursor: HANDLE_CURSORS[handle] }}
              onPointerDown={(event) => onPointerDown(handle, event)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          ))}

          {HANDLE_POSITIONS.map(({ handle, className }) => (
            <div
              key={handle}
              className={`absolute z-10 h-3 w-3 rounded-full border border-white/90 bg-lr-accent ${className}`}
              style={{ cursor: HANDLE_CURSORS[handle] }}
              onPointerDown={(event) => onPointerDown(handle, event)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
