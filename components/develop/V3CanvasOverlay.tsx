"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  applyCropDrag,
  resolveAspectRatio,
  type CropHandle,
} from "@/lib/develop/crop-geometry";
import {
  MAX_BRUSH_POINTS,
  MAX_BRUSH_STROKES,
  MAX_COMPONENTS_PER_MASK,
  MAX_MASKS,
  MAX_POINTS_PER_STROKE,
} from "@/lib/develop/document";
import type {
  BrushStroke,
  MaskComponent,
  NonEmpty,
  NormalizedPoint,
} from "@/lib/develop/types";
import { createDefaultLocalAdjustments } from "@/lib/develop/v3/local-adjustments";
import {
  appendMaskSource,
  findMaskNode,
  maskSourceNodes,
  replaceMaskNode,
  type LocalMaskV3,
  type MaskSourceNode,
} from "@/lib/develop/v3/masking";
import {
  applyCleanupCommand,
  type CleanupComponent,
  type CleanupEllipse,
} from "@/lib/develop/v3/cleanup";
import {
  mapV3CanonicalToCanvasOutput,
  mapV3CanvasOutputToCanonical,
  sampleV3SourceLinear,
  v3OrientedDimensions,
} from "@/lib/develop/v3/canvas-coordinates";
import type {
  DevelopDocumentV3,
  PersistedCrop,
} from "@/lib/develop/v3/document";
import type { GeometryPoint } from "@/lib/develop/v3/geometry";
import {
  manualMaskCoverage,
  pointInLocalGeometryFrame,
} from "@/lib/develop/v3/manual-edits";
import { rgbToHsl } from "@/lib/develop/v3/point-color";
import type { Rgb } from "@/lib/develop/v3/profiles";
import { loadV3MaskCoverageAssets } from "@/lib/develop/v3/runtime";
import type { SourceRecord } from "@/lib/develop/process";
import { sourceSignaturesEqual } from "@/lib/develop/source-transform";
import { proposeSampledWhiteBalance } from "@/lib/develop/v3/white-balance";
import { useDevelopStore } from "@/stores/develop-store";

export type V3CanvasTool =
  | { readonly kind: "none" }
  | { readonly kind: "white-balance" }
  | { readonly kind: "point-color" }
  | {
      readonly kind: "cleanup";
      readonly componentId: string;
      readonly region: "target" | "source";
    };

interface V3CanvasOverlayProps {
  readonly document: DevelopDocumentV3;
  readonly source: SourceRecord;
  readonly image: DevelopImage;
  readonly width: number;
  readonly height: number;
  readonly cropActive: boolean;
  readonly maskingActive: boolean;
  readonly canvasTool: V3CanvasTool;
  readonly onCanvasToolChange: (tool: V3CanvasTool) => void;
  readonly samplePointColorInput: (output: GeometryPoint) => Rgb | null;
}

type MaskTarget =
  | { readonly kind: "replace"; readonly maskId: string }
  | { readonly kind: "insert"; readonly maskId: string }
  | { readonly kind: "new-mask"; readonly maskId: string; readonly name: string };

type ManualMaskComponent = Exclude<MaskComponent, { readonly kind: "ai" }>;

type MaskGesture =
  | {
      pointerId: number;
      kind: "brush";
      target: MaskTarget;
      component: Extract<ManualMaskComponent, { readonly kind: "brush" }>;
      baseStrokes: readonly BrushStroke[];
      points: NormalizedPoint[];
      lastOutput: GeometryPoint;
      maximumPoints: number;
      rejectedReason: string | null;
    }
  | {
      pointerId: number;
      kind: "linear-gradient";
      target: MaskTarget;
      component: Extract<ManualMaskComponent, { readonly kind: "linear-gradient" }>;
      handle: "start" | "end";
      point: NormalizedPoint;
    }
  | {
      pointerId: number;
      kind: "radial-gradient";
      target: MaskTarget;
      component: Extract<ManualMaskComponent, { readonly kind: "radial-gradient" }>;
      handle: "center" | "radius-x" | "radius-y" | "create";
      point: NormalizedPoint;
    };

interface CleanupGesture {
  pointerId: number;
  component: CleanupComponent;
  region: "target" | "source";
  mode: "move" | "draw";
  start: GeometryPoint;
  point: GeometryPoint;
}

interface CropGesture {
  readonly pointerId: number;
  readonly handle: CropHandle;
  readonly startClient: GeometryPoint;
  readonly startTopRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

const CROP_HANDLES: readonly { readonly handle: CropHandle; readonly className: string }[] = [
  { handle: "nw", className: "-left-1 -top-1 cursor-nwse-resize" },
  { handle: "n", className: "left-1/2 -top-1 -translate-x-1/2 cursor-ns-resize" },
  { handle: "ne", className: "-right-1 -top-1 cursor-nesw-resize" },
  { handle: "e", className: "-right-1 top-1/2 -translate-y-1/2 cursor-ew-resize" },
  { handle: "se", className: "-bottom-1 -right-1 cursor-nwse-resize" },
  { handle: "s", className: "-bottom-1 left-1/2 -translate-x-1/2 cursor-ns-resize" },
  { handle: "sw", className: "-bottom-1 -left-1 cursor-nesw-resize" },
  { handle: "w", className: "-left-1 top-1/2 -translate-y-1/2 cursor-ew-resize" },
];

const MAX_MASK_OVERLAY_PIXELS = 512 * 512;
const MASK_OVERLAY_COLOR = { red: 112, green: 215, blue: 255, alpha: 0.42 };

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function nonEmpty<T>(items: readonly T[]): NonEmpty<T> | null {
  const first = items[0];
  return first === undefined ? null : [first, ...items.slice(1)];
}

function distancePixels(
  left: GeometryPoint,
  right: GeometryPoint,
  width: number,
  height: number,
): number {
  return Math.hypot((left.x - right.x) * width, (left.y - right.y) * height);
}

function nextMaskName(masks: readonly LocalMaskV3[]): string {
  const names = new Set(masks.map((mask) => mask.name));
  let index = 1;
  while (names.has(`Mask ${index}`)) index += 1;
  return `Mask ${index}`;
}

function componentWithOperation(
  kind: "brush" | "linear-gradient" | "radial-gradient",
  id: string,
  point: GeometryPoint,
): ManualMaskComponent {
  switch (kind) {
    case "brush": {
      const settings = { size: 0.08, feather: 0.5, flow: 1, density: 1 };
      return {
        kind,
        id,
        operation: "add",
        strokes: [{ points: [point], ...settings }],
        ...settings,
      };
    }
    case "linear-gradient":
      return { kind, id, operation: "add", start: point, end: point };
    case "radial-gradient":
      return {
        kind,
        id,
        operation: "add",
        center: point,
        radiusX: 0.01,
        radiusY: 0.01,
        rotation: 0,
        feather: 0.5,
      };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function sourceNodeFromComponent(component: ManualMaskComponent): MaskSourceNode {
  switch (component.kind) {
    case "brush": return {
      kind: "source", id: component.id, enabled: true,
      source: { kind: "brush", strokes: component.strokes, autoMask: { kind: "off" } },
    };
    case "linear-gradient": return {
      kind: "source", id: component.id, enabled: true,
      source: { kind: "linear-gradient", start: component.start, end: component.end },
    };
    case "radial-gradient": return {
      kind: "source", id: component.id, enabled: true,
      source: {
        kind: "radial-gradient", center: component.center, radiusX: component.radiusX,
        radiusY: component.radiusY, rotation: component.rotation, feather: component.feather,
      },
    };
    default: { const exhaustive: never = component; return exhaustive; }
  }
}

function manualComponentForNode(node: MaskSourceNode | null): ManualMaskComponent | null {
  if (!node) return null;
  switch (node.source.kind) {
    case "brush": {
      const first = node.source.strokes[0];
      if (!first) return null;
      return { kind: "brush", id: node.id, operation: "add", strokes: [first, ...node.source.strokes.slice(1)], size: first.size, feather: first.feather, flow: first.flow, density: first.density };
    }
    case "linear-gradient": return { kind: "linear-gradient", id: node.id, operation: "add", start: node.source.start, end: node.source.end };
    case "radial-gradient": return { kind: "radial-gradient", id: node.id, operation: "add", center: node.source.center, radiusX: node.source.radiusX, radiusY: node.source.radiusY, rotation: node.source.rotation, feather: node.source.feather };
    case "luminance-range":
    case "color-range":
    case "depth-range":
    case "ai-matte": return null;
    default: { const exhaustive: never = node.source; return exhaustive; }
  }
}

function createMask(id: string, name: string, component: ManualMaskComponent): LocalMaskV3 {
  return {
    id,
    name,
    enabled: true,
    expression: sourceNodeFromComponent(component),
    adjustments: createDefaultLocalAdjustments(),
  };
}

function ellipseForComponent(
  component: CleanupComponent,
  region: "target" | "source",
): CleanupEllipse | null {
  if (component.kind === "red-eye") return region === "target" ? component.bounds : null;
  if (region === "target") return component.target;
  return component.source.kind === "sampled" ? component.source.region : null;
}

function replaceCleanupEllipse(
  component: CleanupComponent,
  region: "target" | "source",
  ellipse: CleanupEllipse,
): CleanupComponent {
  if (component.kind === "red-eye") {
    return region === "target" ? { ...component, bounds: ellipse } : component;
  }
  if (region === "target") return { ...component, target: ellipse };
  return component.source.kind === "sampled"
    ? { ...component, source: { kind: "sampled", region: ellipse } }
    : component;
}

function ellipsePoint(ellipse: CleanupEllipse, parameter: number): GeometryPoint {
  const angle = ellipse.rotationDegrees * Math.PI / 180;
  const localX = Math.cos(parameter) * ellipse.radiusX;
  const localY = Math.sin(parameter) * ellipse.radiusY;
  return {
    x: ellipse.center.x + Math.cos(angle) * localX - Math.sin(angle) * localY,
    y: ellipse.center.y + Math.sin(angle) * localX + Math.cos(angle) * localY,
  };
}

function ellipseContains(ellipse: CleanupEllipse, point: GeometryPoint): boolean {
  const angle = -ellipse.rotationDegrees * Math.PI / 180;
  const deltaX = point.x - ellipse.center.x;
  const deltaY = point.y - ellipse.center.y;
  const localX = Math.cos(angle) * deltaX - Math.sin(angle) * deltaY;
  const localY = Math.sin(angle) * deltaX + Math.cos(angle) * deltaY;
  return (localX / ellipse.radiusX) ** 2 + (localY / ellipse.radiusY) ** 2 <= 1;
}

function ellipseLocalDelta(
  point: GeometryPoint,
  center: GeometryPoint,
  rotationDegrees: number,
): GeometryPoint {
  const angle = rotationDegrees * Math.PI / 180;
  const deltaX = point.x - center.x;
  const deltaY = point.y - center.y;
  return {
    x: Math.cos(angle) * deltaX + Math.sin(angle) * deltaY,
    y: -Math.sin(angle) * deltaX + Math.cos(angle) * deltaY,
  };
}

function toTopCrop(crop: PersistedCrop): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  return { x: crop.x, y: 1 - crop.y - crop.height, width: crop.width, height: crop.height };
}

function fromTopCrop(
  crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  base: PersistedCrop,
): PersistedCrop {
  return {
    ...base,
    enabled: true,
    x: crop.x,
    y: 1 - crop.y - crop.height,
    width: crop.width,
    height: crop.height,
  };
}

function maskOverlayDimensions(width: number, height: number): DisplayDimensions {
  const scale = Math.min(1, Math.sqrt(MAX_MASK_OVERLAY_PIXELS / (width * height)));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

interface DisplayDimensions {
  readonly width: number;
  readonly height: number;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function V3CanvasOverlay({
  document,
  source,
  image,
  width,
  height,
  cropActive,
  maskingActive,
  canvasTool,
  onCanvasToolChange,
  samplePointColorInput,
}: V3CanvasOverlayProps) {
  const dispatch = useDevelopStore((state) => state.dispatchV3);
  const sessionUi = useDevelopStore((state) => {
    const entryId = state.activeEntryId;
    return entryId ? state.sessions[entryId]?.ui ?? null : null;
  });
  const maskGestureRef = useRef<MaskGesture | null>(null);
  const cleanupGestureRef = useRef<CleanupGesture | null>(null);
  const cropGestureRef = useRef<CropGesture | null>(null);
  const maskOverlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskOverlayRequestRef = useRef(0);
  const pointerCaptureRef = useRef<{
    readonly pointerId: number;
    readonly element: HTMLElement;
  } | null>(null);
  const [maskPreview, setMaskPreview] = useState<ManualMaskComponent | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<CleanupComponent | null>(null);
  const [cropPreview, setCropPreview] = useState<PersistedCrop | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const selectedMask = document.local.masks.find((mask) => mask.id === sessionUi?.selectedMaskId) ?? null;
  const selectedNode = selectedMask && sessionUi?.selectedComponentId
    ? findMaskNode(selectedMask.expression, sessionUi.selectedComponentId)
    : null;
  const selectedSourceNode = selectedNode?.kind === "source" ? selectedNode : null;
  const selectedAiSource = selectedSourceNode?.source.kind === "ai-matte"
    ? selectedSourceNode.source
    : null;
  const selectedComponent = manualComponentForNode(selectedSourceNode);
  const maskTool = sessionUi?.tool ?? "none";
  const overlayVisible = sessionUi?.overlayVisible ?? true;

  const cropDraft = cropPreview ?? document.geometry.crop;

  useEffect(() => {
    const canvas = maskOverlayCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const requestId = ++maskOverlayRequestRef.current;
    let cancelled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);

    if (
      !maskingActive ||
      !overlayVisible ||
      !selectedMask ||
      !selectedAiSource ||
      !sourceSignaturesEqual(selectedAiSource.source, source.signature)
    ) {
      return;
    }

    const renderOverlay = async (): Promise<void> => {
      const assets = await loadV3MaskCoverageAssets(document, source);
      if (
        cancelled ||
        requestId !== maskOverlayRequestRef.current ||
        !assets?.maskMatte(selectedAiSource.asset.assetId)
      ) return;

      const dimensions = maskOverlayDimensions(width, height);
      const pixels = new Uint8ClampedArray(dimensions.width * dimensions.height * 4);
      const sourceDimensions = v3OrientedDimensions(source);
      for (let y = 0; y < dimensions.height; y += 1) {
        if (y % 32 === 0) {
          await nextAnimationFrame();
          if (cancelled || requestId !== maskOverlayRequestRef.current) return;
        }
        for (let x = 0; x < dimensions.width; x += 1) {
          const output = {
            x: (x + 0.5) / dimensions.width,
            y: 1 - (y + 0.5) / dimensions.height,
          };
          const mapped = mapV3CanvasOutputToCanonical(output, document, source);
          if (mapped.kind !== "mapped" || !mapped.insideDestination) continue;
          const coverage = manualMaskCoverage(
            selectedMask,
            pointInLocalGeometryFrame(document.local.geometryFrame, mapped.point),
            sourceDimensions,
            assets,
          );
          if (coverage <= 0) continue;
          const offset = (y * dimensions.width + x) * 4;
          pixels[offset] = MASK_OVERLAY_COLOR.red;
          pixels[offset + 1] = MASK_OVERLAY_COLOR.green;
          pixels[offset + 2] = MASK_OVERLAY_COLOR.blue;
          pixels[offset + 3] = Math.round(coverage * MASK_OVERLAY_COLOR.alpha * 255);
        }
      }

      const state = useDevelopStore.getState();
      const session = state.sessions[source.signature.entryId];
      if (
        cancelled ||
        requestId !== maskOverlayRequestRef.current ||
        state.activeCatalogId !== source.signature.catalogId ||
        state.activeEntryId !== source.signature.entryId ||
        (session.previewDocument ?? session.persistedDocument) !== document ||
        maskOverlayCanvasRef.current !== canvas
      ) return;
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      context.putImageData(new ImageData(pixels, dimensions.width, dimensions.height), 0, 0);
    };

    void renderOverlay();
    return () => {
      cancelled = true;
    };
  }, [
    document,
    height,
    maskingActive,
    overlayVisible,
    selectedAiSource,
    selectedMask,
    source,
    width,
  ]);

  useEffect(() => {
    function cancelTool(event: KeyboardEvent): void {
      const hasGesture = maskGestureRef.current !== null ||
        cleanupGestureRef.current !== null || cropGestureRef.current !== null;
      if (
        event.key !== "Escape" ||
        (!hasGesture && canvasTool.kind === "none" && maskTool === "none")
      ) return;
      event.preventDefault();
      const capture = pointerCaptureRef.current;
      if (capture?.element.hasPointerCapture(capture.pointerId)) {
        capture.element.releasePointerCapture(capture.pointerId);
      }
      pointerCaptureRef.current = null;
      maskGestureRef.current = null;
      cleanupGestureRef.current = null;
      cropGestureRef.current = null;
      setMaskPreview(null);
      setCleanupPreview(null);
      setCropPreview(null);
      if (canvasTool.kind !== "none") onCanvasToolChange({ kind: "none" });
      if (maskTool !== "none") useDevelopStore.getState().setMaskTool("none");
      setStatus(hasGesture ? "Canvas gesture cancelled." : "Canvas tool cancelled.");
    }
    window.addEventListener("keydown", cancelTool, true);
    return () => window.removeEventListener("keydown", cancelTool, true);
  }, [canvasTool.kind, maskTool, onCanvasToolChange]);

  function outputFromEvent(event: ReactPointerEvent<HTMLDivElement>): GeometryPoint {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clampUnit((event.clientX - bounds.left) / Math.max(1, bounds.width)),
      y: clampUnit(1 - (event.clientY - bounds.top) / Math.max(1, bounds.height)),
    };
  }

  function canonicalFromOutput(output: GeometryPoint): GeometryPoint | null {
    const mapped = mapV3CanvasOutputToCanonical(output, document, source);
    return mapped.kind === "mapped" && mapped.insideDestination ? mapped.point : null;
  }

  function outputFromCanonical(point: GeometryPoint): GeometryPoint | null {
    const mapped = mapV3CanonicalToCanvasOutput(point, document, source);
    return mapped.kind === "mapped" ? mapped.point : null;
  }

  function maskGestureComponent(gesture: MaskGesture): ManualMaskComponent | null {
    switch (gesture.kind) {
      case "brush": {
        if (gesture.rejectedReason) return null;
        const points = nonEmpty(gesture.points);
        if (!points) return null;
        const strokes = nonEmpty([
          ...gesture.baseStrokes,
          {
            points,
            size: gesture.component.size,
            feather: gesture.component.feather,
            flow: gesture.component.flow,
            density: gesture.component.density,
          },
        ]);
        return strokes ? { ...gesture.component, strokes } : null;
      }
      case "linear-gradient":
        return gesture.handle === "start"
          ? { ...gesture.component, start: gesture.point }
          : { ...gesture.component, end: gesture.point };
      case "radial-gradient": {
        if (gesture.handle === "center") return { ...gesture.component, center: gesture.point };
        const local = ellipseLocalDelta(
          gesture.point,
          gesture.component.center,
          gesture.component.rotation,
        );
        if (gesture.handle === "radius-x") {
          return { ...gesture.component, radiusX: Math.max(0.005, Math.abs(local.x)) };
        }
        if (gesture.handle === "radius-y") {
          return { ...gesture.component, radiusY: Math.max(0.005, Math.abs(local.y)) };
        }
        return {
          ...gesture.component,
          radiusX: Math.max(0.005, Math.abs(local.x)),
          radiusY: Math.max(0.005, Math.abs(local.y)),
        };
      }
      default: {
        const exhaustive: never = gesture;
        return exhaustive;
      }
    }
  }

  function commitMask(target: MaskTarget, component: ManualMaskComponent): void {
    const node = sourceNodeFromComponent(component);
    let masks: readonly LocalMaskV3[];
    switch (target.kind) {
      case "replace":
        masks = document.local.masks.map((mask) => mask.id === target.maskId
          ? { ...mask, expression: replaceMaskNode(mask.expression, component.id, node) }
          : mask);
        break;
      case "insert":
        masks = document.local.masks.map((mask) => mask.id === target.maskId
          ? { ...mask, expression: appendMaskSource(mask.expression, node, "add", crypto.randomUUID()) }
          : mask);
        break;
      case "new-mask":
        masks = [...document.local.masks, createMask(target.maskId, target.name, component)];
        break;
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
    dispatch({
      kind: "replace-v3-semantic-group",
      group: "local",
      value: { ...document.local, masks },
    }, component.kind === "brush" ? "Paint mask" : `Draw ${component.kind}`);
    useDevelopStore.getState().setSelectedMask(target.maskId);
    useDevelopStore.getState().setSelectedComponent(component.id);
    useDevelopStore.getState().setMaskOverlayVisible(true);
  }

  function beginMaskGesture(
    event: ReactPointerEvent<HTMLDivElement>,
    point: GeometryPoint,
    output: GeometryPoint,
  ): boolean {
    if (!maskingActive || maskTool === "none") return false;
    const existing = selectedComponent?.kind === maskTool ? selectedComponent : null;
    const target: MaskTarget | null = existing && selectedMask
      ? { kind: "replace", maskId: selectedMask.id }
      : selectedMask && maskSourceNodes(selectedMask.expression).length < MAX_COMPONENTS_PER_MASK
        ? { kind: "insert", maskId: selectedMask.id }
        : !selectedMask && document.local.masks.length < MAX_MASKS
          ? { kind: "new-mask", maskId: crypto.randomUUID(), name: nextMaskName(document.local.masks) }
          : null;
    if (!target) {
      setStatus("The selected mask cannot accept another component.");
      return true;
    }
    const component = existing ?? componentWithOperation(maskTool, crypto.randomUUID(), point);
    switch (component.kind) {
      case "brush": {
        let strokeCount = 0;
        let pointCount = 0;
        for (const mask of document.local.masks) {
          for (const item of maskSourceNodes(mask.expression)) {
            if (item.source.kind !== "brush") continue;
            strokeCount += item.source.strokes.length;
            for (const stroke of item.source.strokes) pointCount += stroke.points.length;
          }
        }
        if (strokeCount >= MAX_BRUSH_STROKES) {
          setStatus(`Brush masks cannot exceed ${MAX_BRUSH_STROKES} strokes.`);
          return true;
        }
        if (pointCount >= MAX_BRUSH_POINTS) {
          setStatus(`Brush masks cannot exceed ${MAX_BRUSH_POINTS} points.`);
          return true;
        }
        maskGestureRef.current = {
          pointerId: event.pointerId,
          kind: "brush",
          target,
          component,
          baseStrokes: existing?.kind === "brush" ? existing.strokes : [],
          points: [point],
          lastOutput: output,
          maximumPoints: Math.min(MAX_POINTS_PER_STROKE, MAX_BRUSH_POINTS - pointCount),
          rejectedReason: null,
        };
        break;
      }
      case "linear-gradient": {
        const startOutput = outputFromCanonical(component.start);
        const handle = existing?.kind === "linear-gradient" &&
          startOutput && distancePixels(startOutput, output, width, height) <= 18
          ? "start"
          : "end";
        const base = existing?.kind === "linear-gradient"
          ? component
          : { ...component, start: point, end: point };
        maskGestureRef.current = {
          pointerId: event.pointerId,
          kind: "linear-gradient",
          target,
          component: base,
          handle,
          point,
        };
        break;
      }
      case "radial-gradient": {
        const centerOutput = outputFromCanonical(component.center);
        const angle = component.rotation * Math.PI / 180;
        const radiusXOutput = outputFromCanonical({
          x: component.center.x + Math.cos(angle) * component.radiusX,
          y: component.center.y + Math.sin(angle) * component.radiusX,
        });
        const radiusYOutput = outputFromCanonical({
          x: component.center.x - Math.sin(angle) * component.radiusY,
          y: component.center.y + Math.cos(angle) * component.radiusY,
        });
        const handle = existing?.kind !== "radial-gradient"
          ? "create"
          : centerOutput && distancePixels(centerOutput, output, width, height) <= 18
          ? "center"
          : radiusXOutput && distancePixels(radiusXOutput, output, width, height) <= 18
            ? "radius-x"
            : radiusYOutput && distancePixels(radiusYOutput, output, width, height) <= 18
              ? "radius-y"
              : "create";
        maskGestureRef.current = {
          pointerId: event.pointerId,
          kind: "radial-gradient",
          target,
          component: handle === "create" ? { ...component, center: point } : component,
          handle,
          point,
        };
        break;
      }
      default: {
        const exhaustive: never = component;
        return exhaustive;
      }
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerCaptureRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
    };
    const gesture = maskGestureRef.current;
    setMaskPreview(gesture ? maskGestureComponent(gesture) : null);
    return true;
  }

  function cleanupGestureComponent(gesture: CleanupGesture): CleanupComponent {
    const base = ellipseForComponent(gesture.component, gesture.region);
    if (!base) return gesture.component;
    const local = ellipseLocalDelta(
      gesture.point,
      gesture.start,
      base.rotationDegrees,
    );
    const ellipse = gesture.mode === "move"
      ? {
          ...base,
          center: {
            x: clampUnit(base.center.x + gesture.point.x - gesture.start.x),
            y: clampUnit(base.center.y + gesture.point.y - gesture.start.y),
          },
        }
      : {
          ...base,
          center: gesture.start,
          radiusX: Math.max(0.005, Math.abs(local.x)),
          radiusY: Math.max(0.005, Math.abs(local.y)),
        };
    return replaceCleanupEllipse(gesture.component, gesture.region, ellipse);
  }

  function beginCleanupGesture(
    event: ReactPointerEvent<HTMLDivElement>,
    point: GeometryPoint,
  ): boolean {
    if (canvasTool.kind !== "cleanup") return false;
    const component = document.cleanup.components.find((item) => item.id === canvasTool.componentId);
    if (!component) {
      setStatus("The cleanup component is no longer available.");
      onCanvasToolChange({ kind: "none" });
      return true;
    }
    const ellipse = ellipseForComponent(component, canvasTool.region);
    if (!ellipse) {
      setStatus("This cleanup component has no sampled source region.");
      onCanvasToolChange({ kind: "none" });
      return true;
    }
    cleanupGestureRef.current = {
      pointerId: event.pointerId,
      component,
      region: canvasTool.region,
      mode: ellipseContains(ellipse, point) ? "move" : "draw",
      start: point,
      point,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerCaptureRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
    };
    setCleanupPreview(cleanupGestureComponent(cleanupGestureRef.current));
    return true;
  }

  function sampleCanvas(output: GeometryPoint, canonical: GeometryPoint): boolean {
    if (canvasTool.kind === "white-balance") {
      const sampled = sampleV3SourceLinear(image, source, canonical);
      if (sampled.kind === "unavailable") {
        setStatus(sampled.reason);
        return true;
      }
      const proposal = proposeSampledWhiteBalance({ kind: "source-linear", samples: sampled.samples });
      if (proposal.kind !== "proposal") {
        setStatus(`White-balance sample rejected: ${proposal.reason}.`);
        return true;
      }
      dispatch({
        kind: "replace-v3-semantic-group",
        group: "color",
        value: {
          ...document.color,
          whiteBalance: {
            mode: "sampled",
            adjustment: {
              temperature: Math.max(
                -3_000,
                Math.min(3_000, proposal.values.temperatureKelvin - 5_500),
              ),
              tint: proposal.values.tint,
            },
            resolved: proposal.values,
          },
        },
      }, "Sample white balance");
      setStatus(`White balance sampled from ${proposal.sampleCount} source pixels.`);
      onCanvasToolChange({ kind: "none" });
      return true;
    }
    if (canvasTool.kind === "point-color") {
      if (document.color.pointColor.adjustments.length >= 8) {
        setStatus("Point Color already has eight samples.");
        return true;
      }
      const pointColorInput = samplePointColorInput(output);
      if (!pointColorInput) {
        setStatus("The Point Color input pixel could not be sampled.");
        return true;
      }
      const color = rgbToHsl(pointColorInput);
      dispatch({
        kind: "replace-v3-semantic-group",
        group: "color",
        value: {
          ...document.color,
          pointColor: {
            adjustments: [...document.color.pointColor.adjustments, {
              id: crypto.randomUUID(),
              enabled: true,
              sourceHueDegrees: color.hueDegrees,
              sourceSaturation: color.saturation,
              sourceLuminance: color.luminance,
              hueRangeDegrees: 30,
              saturationRange: 0.25,
              luminanceRange: 0.25,
              falloff: 0.5,
              hueShiftDegrees: 0,
              saturationShift: 0,
              luminanceShift: 0,
            }],
          },
        },
      }, "Sample Point Color");
      setStatus("Point Color sample added from its linear input stage.");
      onCanvasToolChange({ kind: "none" });
      return true;
    }
    return false;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (cropActive) return;
    const output = outputFromEvent(event);
    const canonical = canonicalFromOutput(output);
    if (!canonical) {
      setStatus("That point is outside the transformed source.");
      return;
    }
    if (sampleCanvas(output, canonical)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (beginCleanupGesture(event, canonical) || beginMaskGesture(event, canonical, output)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const output = outputFromEvent(event);
    const point = canonicalFromOutput(output);
    if (!point) return;
    const maskGesture = maskGestureRef.current;
    if (maskGesture?.pointerId === event.pointerId) {
      if (maskGesture.kind === "brush") {
        if (distancePixels(maskGesture.lastOutput, output, width, height) >= 2) {
          if (maskGesture.points.length >= maskGesture.maximumPoints) {
            maskGesture.rejectedReason = maskGesture.maximumPoints === MAX_POINTS_PER_STROKE
              ? `A brush stroke cannot exceed ${MAX_POINTS_PER_STROKE} points.`
              : `Brush masks cannot exceed ${MAX_BRUSH_POINTS} points.`;
            setMaskPreview(null);
            setStatus(maskGesture.rejectedReason);
            return;
          }
          maskGesture.points.push(point);
          maskGesture.lastOutput = output;
        }
      } else {
        maskGesture.point = point;
      }
      setMaskPreview(maskGestureComponent(maskGesture));
      return;
    }
    const cleanupGesture = cleanupGestureRef.current;
    if (cleanupGesture?.pointerId === event.pointerId) {
      cleanupGesture.point = point;
      setCleanupPreview(cleanupGestureComponent(cleanupGesture));
    }
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>, commit: boolean): void {
    const maskGesture = maskGestureRef.current;
    if (maskGesture?.pointerId === event.pointerId) {
      const component = maskGestureComponent(maskGesture);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      maskGestureRef.current = null;
      pointerCaptureRef.current = null;
      setMaskPreview(null);
      if (commit && component) {
        commitMask(maskGesture.target, component);
      } else if (commit && maskGesture.kind === "brush" && maskGesture.rejectedReason) {
        setStatus(maskGesture.rejectedReason);
      }
      return;
    }
    const cleanupGesture = cleanupGestureRef.current;
    if (cleanupGesture?.pointerId === event.pointerId) {
      const component = cleanupGestureComponent(cleanupGesture);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      cleanupGestureRef.current = null;
      pointerCaptureRef.current = null;
      setCleanupPreview(null);
      if (commit) {
        const result = applyCleanupCommand(document.cleanup, {
          kind: "replace",
          componentId: component.id,
          component,
        });
        if (result.kind === "changed") {
          dispatch({ kind: "replace-v3-semantic-group", group: "cleanup", value: result.layer }, "Place cleanup region");
          setStatus("Cleanup region placed.");
        } else if (result.kind === "invalid") {
          setStatus(result.reason);
        }
      }
    }
  }

  function beginCrop(handle: CropHandle, event: ReactPointerEvent<HTMLElement>): void {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerCaptureRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
    };
    cropGestureRef.current = {
      pointerId: event.pointerId,
      handle,
      startClient: { x: event.clientX, y: event.clientY },
      startTopRect: toTopCrop(cropDraft),
    };
  }

  function moveCrop(event: ReactPointerEvent<HTMLElement>): void {
    const gesture = cropGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const aspect = resolveAspectRatio(
      cropDraft.aspectPreset,
      width,
      height,
      cropDraft.customAspectWidth,
      cropDraft.customAspectHeight,
    );
    const next = applyCropDrag(
      gesture.startTopRect,
      gesture.handle,
      (event.clientX - gesture.startClient.x) / Math.max(1, width),
      (event.clientY - gesture.startClient.y) / Math.max(1, height),
      aspect,
    );
    setCropPreview(fromTopCrop(next, cropDraft));
  }

  function finishCrop(event: ReactPointerEvent<HTMLElement>, commit: boolean): void {
    const gesture = cropGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    cropGestureRef.current = null;
    pointerCaptureRef.current = null;
    if (commit) {
      dispatch({ kind: "commit-v3-crop-draft", crop: cropDraft }, "Adjust crop");
      setCropPreview(null);
      setStatus("Crop committed.");
    } else {
      setCropPreview(null);
    }
  }

  function svgPoint(point: GeometryPoint): string | null {
    const output = outputFromCanonical(point);
    return output ? `${output.x * width},${(1 - output.y) * height}` : null;
  }

  function svgPath(points: readonly GeometryPoint[]): string | null {
    const mapped = points.map(svgPoint).filter((point) => point !== null);
    return mapped.length > 0 ? mapped.join(" ") : null;
  }

  function ellipsePath(ellipse: CleanupEllipse): string | null {
    return svgPath(Array.from({ length: 49 }, (_, index) => ellipsePoint(ellipse, index / 48 * Math.PI * 2)));
  }

  function closedSvgPath(points: readonly GeometryPoint[]): string | null {
    const mapped: string[] = [];
    for (const point of points) {
      const output = outputFromCanonical(point);
      if (!output) return null;
      mapped.push(`${output.x * width},${(1 - output.y) * height}`);
    }
    return mapped.length >= 3 ? `M ${mapped.join(" L ")} Z` : null;
  }

  function brushGuidePath(stroke: BrushStroke): string | null {
    const dimensions = v3OrientedDimensions(source);
    const pixelWidth = Math.max(1, dimensions.width - 1);
    const pixelHeight = Math.max(1, dimensions.height - 1);
    const radius = Math.max(
      0.5,
      stroke.size * Math.max(dimensions.width, dimensions.height) * 0.5,
    );
    const paths: string[] = [];
    const circle = (point: GeometryPoint): string | null => closedSvgPath(
      Array.from({ length: 32 }, (_, index) => {
        const angle = index / 32 * Math.PI * 2;
        return {
          x: point.x + Math.cos(angle) * radius / pixelWidth,
          y: point.y + Math.sin(angle) * radius / pixelHeight,
        };
      }),
    );
    for (let index = 0; index < stroke.points.length; index += 1) {
      const current = stroke.points[index];
      if (!current) continue;
      const cap = circle(current);
      if (cap) paths.push(cap);
      const next = stroke.points[index + 1];
      if (!next) continue;
      const startX = current.x * pixelWidth;
      const startY = current.y * pixelHeight;
      const endX = next.x * pixelWidth;
      const endY = next.y * pixelHeight;
      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const length = Math.hypot(deltaX, deltaY);
      if (length <= Number.EPSILON) continue;
      const normalX = -deltaY / length * radius;
      const normalY = deltaX / length * radius;
      const steps = Math.min(32, Math.max(1, Math.ceil(length / 16)));
      const left: GeometryPoint[] = [];
      const right: GeometryPoint[] = [];
      for (let step = 0; step <= steps; step += 1) {
        const amount = step / steps;
        const x = startX + deltaX * amount;
        const y = startY + deltaY * amount;
        left.push({ x: (x + normalX) / pixelWidth, y: (y + normalY) / pixelHeight });
        right.push({ x: (x - normalX) / pixelWidth, y: (y - normalY) / pixelHeight });
      }
      const segment = closedSvgPath([...left, ...right.reverse()]);
      if (segment) paths.push(segment);
    }
    return paths.length > 0 ? paths.join(" ") : null;
  }

  const guideComponent = maskPreview ?? selectedComponent;
  const cleanupGuide = cleanupPreview ?? (canvasTool.kind === "cleanup"
    ? document.cleanup.components.find((component) => component.id === canvasTool.componentId) ?? null
    : null);
  const active = cropActive || maskingActive || canvasTool.kind !== "none";
  const topCrop = toTopCrop(cropDraft);

  return (
    <div
      className={`absolute inset-0 touch-none select-none ${active ? "pointer-events-auto" : "pointer-events-none"} ${canvasTool.kind !== "none" || (maskingActive && maskTool !== "none") ? "cursor-crosshair" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishPointer(event, true)}
      onPointerCancel={(event) => finishPointer(event, false)}
    >
      {cropActive ? (
        <div className="absolute inset-0 bg-black/35">
          <div
            className="absolute cursor-grab border border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.48)] active:cursor-grabbing"
            style={{
              left: `${topCrop.x * 100}%`,
              top: `${topCrop.y * 100}%`,
              width: `${topCrop.width * 100}%`,
              height: `${topCrop.height * 100}%`,
            }}
            onPointerDown={(event) => beginCrop("move", event)}
            onPointerMove={moveCrop}
            onPointerUp={(event) => finishCrop(event, true)}
            onPointerCancel={(event) => finishCrop(event, false)}
          >
            <div className="pointer-events-none grid h-full grid-cols-3 grid-rows-3">
              {Array.from({ length: 9 }, (_, index) => <span key={index} className="border border-white/20" />)}
            </div>
            {CROP_HANDLES.map(({ handle, className }) => (
              <button
                key={handle}
                type="button"
                aria-label={`Drag crop ${handle}`}
                className={`absolute z-10 size-3 rounded-full border border-black/70 bg-white shadow ${className}`}
                onPointerDown={(event) => beginCrop(handle, event)}
                onPointerMove={moveCrop}
                onPointerUp={(event) => finishCrop(event, true)}
                onPointerCancel={(event) => finishCrop(event, false)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <canvas
        ref={maskOverlayCanvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {maskingActive && overlayVisible && guideComponent ? (
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height} aria-hidden="true">
          {guideComponent.kind === "brush" ? guideComponent.strokes.map((stroke, index) => {
            const path = brushGuidePath(stroke);
            return path ? (
              <path
                key={index}
                d={path}
                fill={guideComponent.operation === "add" ? "#70d7ff" : "#ff857d"}
                opacity={0.35 + stroke.flow * 0.45}
              />
            ) : null;
          }) : null}
          {guideComponent.kind === "linear-gradient" ? (() => {
            const start = svgPoint(guideComponent.start);
            const end = svgPoint(guideComponent.end);
            return start && end ? (
              <>
                <polyline points={`${start} ${end}`} fill="none" stroke="#70d7ff" strokeWidth="2" />
                {[start, end].map((point) => <circle key={point} cx={Number(point.split(",")[0])} cy={Number(point.split(",")[1])} r="5" fill="#70d7ff" stroke="#10202b" />)}
              </>
            ) : null;
          })() : null}
          {guideComponent.kind === "radial-gradient" ? (() => {
            const path = svgPath(Array.from({ length: 49 }, (_, index) => {
              const angle = guideComponent.rotation * Math.PI / 180;
              const parameter = index / 48 * Math.PI * 2;
              const x = Math.cos(parameter) * guideComponent.radiusX;
              const y = Math.sin(parameter) * guideComponent.radiusY;
              return {
                x: guideComponent.center.x + Math.cos(angle) * x - Math.sin(angle) * y,
                y: guideComponent.center.y + Math.sin(angle) * x + Math.cos(angle) * y,
              };
            }));
            return path ? <polygon points={path} fill="#70d7ff" fillOpacity="0.12" stroke="#70d7ff" strokeWidth="2" /> : null;
          })() : null}
        </svg>
      ) : null}

      {cleanupGuide ? (
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height} aria-hidden="true">
          {cleanupGuide.kind === "repair" ? (
            <>
              {ellipsePath(cleanupGuide.target) ? <polygon points={ellipsePath(cleanupGuide.target) ?? ""} fill="#ffbf69" fillOpacity="0.1" stroke="#ffbf69" strokeWidth="2" /> : null}
              {cleanupGuide.source.kind === "sampled" && ellipsePath(cleanupGuide.source.region) ? <polygon points={ellipsePath(cleanupGuide.source.region) ?? ""} fill="#70d7ff" fillOpacity="0.08" stroke="#70d7ff" strokeWidth="2" strokeDasharray="5 4" /> : null}
            </>
          ) : ellipsePath(cleanupGuide.bounds) ? (
            <polygon points={ellipsePath(cleanupGuide.bounds) ?? ""} fill="#ff796c" fillOpacity="0.12" stroke="#ff796c" strokeWidth="2" />
          ) : null}
        </svg>
      ) : null}

      {canvasTool.kind !== "none" || status ? (
        <div
          className="pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border border-white/15 bg-[#11191f]/95 px-3 py-2 text-[11px] text-white shadow-xl"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <span>{status ?? (canvasTool.kind === "white-balance" ? "Click a neutral source area" : canvasTool.kind === "point-color" ? "Click a color to sample" : "Drag to place; drag the center to move")}</span>
          {canvasTool.kind !== "none" ? (
            <button type="button" onClick={() => onCanvasToolChange({ kind: "none" })} className="text-white/65 hover:text-white">Cancel</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
