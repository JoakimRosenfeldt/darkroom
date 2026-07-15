"use client";

import { useRef } from "react";
import {
  applyCropDrag,
  clampCropRect,
  type CropHandle,
  type ImageRect,
  resolveAspectRatio,
} from "@/lib/develop/crop-geometry";
import type { CropSettings } from "@/lib/develop/types";

interface InteractiveCropOverlayProps {
  crop: CropSettings;
  imageOffset: { x: number; y: number };
  imageRect: ImageRect;
  imageWidth: number;
  imageHeight: number;
  previewScale: number;
  onChange: (crop: CropSettings, preserveFrame?: boolean) => void;
}

const HANDLE_CURSORS: Record<CropHandle, string> = {
  move: "grab",
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
  { handle: "nw", className: "-left-px -top-px h-5 w-5 border-l-2 border-t-2" },
  { handle: "n", className: "-top-px left-1/2 h-3 w-6 -translate-x-1/2 border-t-2" },
  { handle: "ne", className: "-right-px -top-px h-5 w-5 border-r-2 border-t-2" },
  { handle: "e", className: "-right-px top-1/2 h-6 w-3 -translate-y-1/2 border-r-2" },
  { handle: "se", className: "-bottom-px -right-px h-5 w-5 border-b-2 border-r-2" },
  { handle: "s", className: "-bottom-px left-1/2 h-3 w-6 -translate-x-1/2 border-b-2" },
  { handle: "sw", className: "-bottom-px -left-px h-5 w-5 border-b-2 border-l-2" },
  { handle: "w", className: "-left-px top-1/2 h-6 w-3 -translate-y-1/2 border-l-2" },
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
  crop,
  imageOffset,
  imageRect,
  imageWidth,
  imageHeight,
  previewScale,
  onChange,
}: InteractiveCropOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    handle: CropHandle;
    startX: number;
    startY: number;
    startCrop: { x: number; y: number; width: number; height: number };
  } | null>(null);

  const aspectRatio = resolveAspectRatio(
    crop.aspectPreset,
    imageWidth,
    imageHeight,
    crop.customAspectWidth,
    crop.customAspectHeight,
  );
  const cropRect = clampCropRect(crop);

  function onPointerDown(handle: CropHandle, event: React.PointerEvent) {
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

    const deltaX = (event.clientX - drag.startX) / (imageRect.width * previewScale);
    const deltaY = (event.clientY - drag.startY) / (imageRect.height * previewScale);
    const movingImage = drag.handle === "move";
    const next = applyCropDrag(
      drag.startCrop,
      drag.handle,
      movingImage ? -deltaX : deltaX,
      movingImage ? -deltaY : deltaY,
      aspectRatio,
    );
    onChange({ ...crop, ...next }, movingImage);
  }

  function onPointerUp(event: React.PointerEvent) {
    if (dragRef.current) {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      dragRef.current = null;
    }
  }

  return (
    <div
      ref={containerRef}
      className="absolute touch-none select-none overflow-hidden"
      style={{
        left: imageRect.x + imageOffset.x * imageRect.width,
        top: imageRect.y + imageOffset.y * imageRect.height,
        width: imageRect.width,
        height: imageRect.height,
      }}
    >
      <div
        className="absolute cursor-grab border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.4)] active:cursor-grabbing"
        style={{
          left: cropRect.x * imageRect.width,
          top: cropRect.y * imageRect.height,
          width: cropRect.width * imageRect.width,
          height: cropRect.height * imageRect.height,
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
            className={`absolute z-20 border-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.85)] ${className}`}
            style={{ cursor: HANDLE_CURSORS[handle] }}
            onPointerDown={(event) => onPointerDown(handle, event)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        ))}
      </div>
    </div>
  );
}
