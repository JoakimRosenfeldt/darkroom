"use client";

import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import type { MaskTool } from "@/components/develop/MaskingPanel";
import { isEditableTarget } from "@/hooks/is-editable-target";
import type { ImageRect } from "@/lib/develop/crop-geometry";
import { captureBrushStrokeSettings, MAX_COMPONENTS_PER_MASK, MAX_MASKS } from "@/lib/develop/document";
import { DEFAULT_DEVELOP_SETTINGS } from "@/lib/develop/registry";
import { orientedToOutputUv, transformOutputUv } from "@/lib/develop/source-transform";
import type { SourceTransformInput } from "@/lib/develop/source-transform";
import type {
  BrushMaskComponent,
  BrushStroke,
  CropSettings,
  LinearGradientMaskComponent,
  LocalMask,
  MaskComponent,
  NonEmpty,
  NormalizedPoint,
  RadialGradientMaskComponent,
} from "@/lib/develop/types";
import { useDevelopStore } from "@/stores/develop-store";

interface MaskingOverlayProps {
  imageRect: ImageRect;
  displayWidth: number;
  displayHeight: number;
  orientation: number;
  crop: CropSettings;
  mask: LocalMask | null;
  component: MaskComponent | null;
  tool: MaskTool;
  brushSettings: BrushSettings;
  onBrushSettingsChange: (settings: BrushSettings) => void;
}

type ManualMaskTool = Exclude<MaskTool, "none">;
type LinearHandle = "linear-start" | "linear-end";
type RadialHandle = "radial-center" | "radial-radius-x" | "radial-radius-y" | "radial-rotation" | "radial-feather";
type HandleKind = LinearHandle | RadialHandle;
type GestureTarget =
  | { kind: "replace"; maskId: string }
  | { kind: "insert-component"; maskId: string; index: number }
  | { kind: "insert-mask"; maskId: string; index: number; name: string };

interface GestureBase {
  pointerId: number;
  target: GestureTarget;
  startOutput: NormalizedPoint;
  output: NormalizedPoint;
  point: NormalizedPoint;
  moved: boolean;
  label: string;
}

type BrushGesture = GestureBase & {
  kind: "brush";
  component: BrushMaskComponent;
  baseStrokes: readonly BrushStroke[];
  points: NormalizedPoint[];
  lastStoredOutput: NormalizedPoint;
};

type LinearGesture = GestureBase & {
  kind: "linear-gradient";
  component: LinearGradientMaskComponent;
  handle: "create" | LinearHandle;
};

type RadialGesture = GestureBase & {
  kind: "radial-gradient";
  component: RadialGradientMaskComponent;
  handle: "create" | RadialHandle;
};

type Gesture = BrushGesture | LinearGesture | RadialGesture;
type CursorPoint = { output: NormalizedPoint; source: NormalizedPoint };
export type BrushSettings = Pick<BrushMaskComponent, "size" | "feather" | "flow" | "density">;
type AdjustableBrushSetting = "size" | "feather";

const EMPTY_MASKS: readonly LocalMask[] = [];
const BRUSH_SIZE_STEP = 0.02;
const BRUSH_FEATHER_STEP = 0.05;
const WHEEL_STEP = 40;
const HANDLE_HIT_RADIUS = 18;
const FEATHER_HANDLE_SPAN = 0.75;
const DRAG_THRESHOLD = 2;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function nonEmpty<T>(items: T[]): NonEmpty<T> {
  const first = items[0];
  if (first === undefined) throw new Error("Expected a non-empty list.");
  return [first, ...items.slice(1)];
}

function pointString(point: NormalizedPoint): string {
  return `${point.x * 100},${point.y * 100}`;
}

function isHandleKind(value: string | null): value is HandleKind {
  return value === "linear-start" || value === "linear-end" || value === "radial-center" || value === "radial-radius-x" || value === "radial-radius-y" || value === "radial-rotation" || value === "radial-feather";
}

function isLinearHandle(value: HandleKind): value is LinearHandle {
  return value === "linear-start" || value === "linear-end";
}

function isRadialHandle(value: HandleKind): value is RadialHandle {
  return value === "radial-center" || value === "radial-radius-x" || value === "radial-radius-y" || value === "radial-rotation" || value === "radial-feather";
}

function handleFromTarget(target: EventTarget | null): HandleKind | null {
  if (!(target instanceof Element)) return null;
  const value = target.closest<HTMLElement>("[data-mask-handle]")?.dataset.maskHandle ?? null;
  return isHandleKind(value) ? value : null;
}

function angleRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function normalizeDegrees(degrees: number): number {
  const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

function addPoint(left: NormalizedPoint, right: NormalizedPoint): NormalizedPoint {
  return { x: left.x + right.x, y: left.y + right.y };
}

function radialAxisOffset(
  component: RadialGradientMaskComponent,
  axis: "x" | "y",
  scale: number,
  sourceWidth: number,
  sourceHeight: number,
): NormalizedPoint {
  const rotation = angleRadians(component.rotation);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  return axis === "x"
    ? { x: cos * component.radiusX * scale, y: sin * component.radiusX * width / height * scale }
    : { x: -sin * component.radiusY * height / width * scale, y: cos * component.radiusY * scale };
}

function radialEllipsePoint(
  component: RadialGradientMaskComponent,
  parameter: number,
  sourceWidth: number,
  sourceHeight: number,
  scale = 1,
): NormalizedPoint {
  const rotation = angleRadians(component.rotation);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localX = component.radiusX * Math.cos(parameter) * scale;
  const localY = component.radiusY * Math.sin(parameter) * scale;
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  return addPoint(component.center, {
    x: cos * localX - sin * localY * height / width,
    y: sin * localX * width / height + cos * localY,
  });
}

function radialHandleSourcePoint(
  component: RadialGradientMaskComponent,
  handle: RadialHandle,
  sourceWidth: number,
  sourceHeight: number,
): NormalizedPoint {
  switch (handle) {
    case "radial-center":
      return component.center;
    case "radial-radius-x":
      return addPoint(component.center, radialAxisOffset(component, "x", 1, sourceWidth, sourceHeight));
    case "radial-radius-y":
      return addPoint(component.center, radialAxisOffset(component, "y", 1, sourceWidth, sourceHeight));
    case "radial-rotation":
      return addPoint(component.center, radialAxisOffset(component, "x", 1.25, sourceWidth, sourceHeight));
    case "radial-feather":
      return addPoint(component.center, radialAxisOffset(component, "x", 1 - FEATHER_HANDLE_SPAN * component.feather, sourceWidth, sourceHeight));
    default: {
      const exhaustive: never = handle;
      return exhaustive;
    }
  }
}

function handleSources(component: MaskComponent, sourceInput: SourceTransformInput): Array<{ kind: HandleKind; point: NormalizedPoint }> {
  switch (component.kind) {
    case "linear-gradient":
      return [
        { kind: "linear-start", point: component.start },
        { kind: "linear-end", point: component.end },
      ];
    case "radial-gradient":
      return (["radial-center", "radial-radius-x", "radial-radius-y", "radial-rotation", "radial-feather"] as const).map((kind) => ({
        kind,
        point: radialHandleSourcePoint(component, kind, sourceInput.displayWidth, sourceInput.displayHeight),
      }));
    default:
      return [];
  }
}

function handleLabel(handle: HandleKind): string {
  switch (handle) {
    case "linear-start": return "Move linear gradient start";
    case "linear-end": return "Move linear gradient end";
    case "radial-center": return "Move radial gradient center";
    case "radial-radius-x": return "Adjust radial gradient width";
    case "radial-radius-y": return "Adjust radial gradient height";
    case "radial-rotation": return "Rotate radial gradient";
    case "radial-feather": return "Adjust radial gradient feather";
    default: {
      const exhaustive: never = handle;
      return exhaustive;
    }
  }
}

function toOutputPoint(point: NormalizedPoint, sourceInput: SourceTransformInput): NormalizedPoint {
  return orientedToOutputUv(point, sourceInput);
}

function outputDistanceInPixels(left: NormalizedPoint, right: NormalizedPoint, width: number, height: number): number {
  return Math.hypot((left.x - right.x) * width, (left.y - right.y) * height);
}

function movePointByOutputDelta(point: NormalizedPoint, delta: NormalizedPoint, sourceInput: SourceTransformInput): NormalizedPoint {
  const output = toOutputPoint(point, sourceInput);
  return transformOutputUv({ x: clampUnit(output.x + delta.x), y: clampUnit(output.y + delta.y) }, sourceInput).oriented;
}

function updateRadialComponent(
  component: RadialGradientMaskComponent,
  handle: "create" | RadialHandle,
  point: NormalizedPoint,
  sourceInput: SourceTransformInput,
): RadialGradientMaskComponent {
  if (handle === "create") {
    return {
      ...component,
      radiusX: Math.max(0.01, Math.abs(point.x - component.center.x)),
      radiusY: Math.max(0.01, Math.abs(point.y - component.center.y)),
    };
  }
  switch (handle) {
    case "radial-center":
      return { ...component, center: point };
    case "radial-radius-x": {
      const dx = (point.x - component.center.x) * sourceInput.displayWidth;
      const dy = (point.y - component.center.y) * sourceInput.displayHeight;
      const rotation = angleRadians(component.rotation);
      const localX = Math.cos(rotation) * dx + Math.sin(rotation) * dy;
      return { ...component, radiusX: clampUnit(Math.max(0.01, Math.abs(localX) / Math.max(1, sourceInput.displayWidth))) };
    }
    case "radial-radius-y": {
      const dx = (point.x - component.center.x) * sourceInput.displayWidth;
      const dy = (point.y - component.center.y) * sourceInput.displayHeight;
      const rotation = angleRadians(component.rotation);
      const localY = -Math.sin(rotation) * dx + Math.cos(rotation) * dy;
      return { ...component, radiusY: clampUnit(Math.max(0.01, Math.abs(localY) / Math.max(1, sourceInput.displayHeight))) };
    }
    case "radial-rotation": {
      const dx = (point.x - component.center.x) * sourceInput.displayWidth;
      const dy = (point.y - component.center.y) * sourceInput.displayHeight;
      return Math.hypot(dx, dy) < 1
        ? component
        : { ...component, rotation: normalizeDegrees(Math.atan2(dy, dx) * 180 / Math.PI) };
    }
    case "radial-feather": {
      const dx = (point.x - component.center.x) * sourceInput.displayWidth;
      const dy = (point.y - component.center.y) * sourceInput.displayHeight;
      const rotation = angleRadians(component.rotation);
      const localX = Math.abs(Math.cos(rotation) * dx + Math.sin(rotation) * dy);
      const radius = Math.max(1, component.radiusX * sourceInput.displayWidth);
      return { ...component, feather: clampUnit((1 - localX / radius) / FEATHER_HANDLE_SPAN) };
    }
    default: {
      const exhaustive: never = handle;
      return exhaustive;
    }
  }
}

function nextMaskName(masks: readonly LocalMask[]): string {
  const names = new Set(masks.map((mask) => mask.name));
  let index = 1;
  while (names.has(`Mask ${index}`)) index += 1;
  return `Mask ${index}`;
}

function createComponent(tool: ManualMaskTool, id: string, point: NormalizedPoint, brushSettings: BrushSettings): MaskComponent {
  switch (tool) {
    case "brush": {
      return { kind: tool, id, operation: "add", strokes: [{ points: [point], ...brushSettings }], ...brushSettings };
    }
    case "linear-gradient":
      return { kind: tool, id, operation: "add", start: point, end: point };
    case "radial-gradient":
      return { kind: tool, id, operation: "add", center: point, radiusX: 0.01, radiusY: 0.01, rotation: 0, feather: 0.5 };
    default: {
      const exhaustive: never = tool;
      return exhaustive;
    }
  }
}

function createMask(id: string, name: string, component: MaskComponent): LocalMask {
  return { id, name, enabled: true, inverted: false, components: [component], adjustments: structuredClone(DEFAULT_DEVELOP_SETTINGS.basic) };
}

function componentForGesture(gesture: Gesture, sourceInput: SourceTransformInput): MaskComponent {
  switch (gesture.kind) {
    case "brush":
      return {
        ...gesture.component,
        strokes: nonEmpty([
          ...gesture.baseStrokes,
          {
            points: nonEmpty([...gesture.points]),
            size: gesture.component.size,
            feather: gesture.component.feather,
            flow: gesture.component.flow,
            density: gesture.component.density,
          },
        ]),
      };
    case "linear-gradient":
      return gesture.handle === "linear-start"
        ? { ...gesture.component, start: gesture.point }
        : { ...gesture.component, end: gesture.point };
    case "radial-gradient":
      return updateRadialComponent(gesture.component, gesture.handle, gesture.point, sourceInput);
    default: {
      const exhaustive: never = gesture;
      return exhaustive;
    }
  }
}

function brushCursorDiameter(size: number, imageRect: ImageRect, sourceInput: SourceTransformInput): number {
  const cropWidth = sourceInput.crop.enabled ? sourceInput.crop.width : 1;
  const cropHeight = sourceInput.crop.enabled ? sourceInput.crop.height : 1;
  const scaleX = imageRect.width / Math.max(1, sourceInput.displayWidth * cropWidth);
  const scaleY = imageRect.height / Math.max(1, sourceInput.displayHeight * cropHeight);
  const sourceDiameter = size * Math.max(sourceInput.displayWidth, sourceInput.displayHeight);
  return Math.max(4, sourceDiameter * (scaleX + scaleY) * 0.5);
}

export function MaskingOverlay({
  imageRect,
  displayWidth,
  displayHeight,
  orientation,
  crop,
  mask,
  component,
  tool,
  brushSettings,
  onBrushSettingsChange,
}: MaskingOverlayProps) {
  const dispatch = useDevelopStore((state) => state.dispatch);
  const beginEditGroup = useDevelopStore((state) => state.beginEditGroup);
  const endEditGroup = useDevelopStore((state) => state.endEditGroup);
  const setSelectedMask = useDevelopStore((state) => state.setSelectedMask);
  const setSelectedComponent = useDevelopStore((state) => state.setSelectedComponent);
  const masks = useDevelopStore((state) => {
    const entryId = state.activeEntryId;
    return entryId ? state.sessions[entryId]?.document.settings.masking.masks ?? EMPTY_MASKS : EMPTY_MASKS;
  });
  const overlayVisible = useDevelopStore((state) => {
    const entryId = state.activeEntryId;
    return entryId ? state.sessions[entryId]?.ui.overlayVisible ?? false : false;
  });
  const gestureRef = useRef<Gesture | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const cursorFrameRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<CursorPoint | null>(null);
  const overlayElementRef = useRef<HTMLDivElement | null>(null);
  const cursorElementRef = useRef<HTMLDivElement | null>(null);
  const brushAdjustmentRef = useRef<BrushMaskComponent | null>(null);
  const brushAdjustmentTimerRef = useRef<number | null>(null);
  const wheelAccumulatorRef = useRef<{ setting: AdjustableBrushSetting; delta: number }>({ setting: "size", delta: 0 });
  const brushSettingsRef = useRef(brushSettings);
  const [preview, setPreview] = useState<MaskComponent | null>(null);
  const sourceInput: SourceTransformInput = {
    displayWidth,
    displayHeight,
    textureWidth: displayWidth,
    textureHeight: displayHeight,
    orientation,
    crop,
    mode: crop.enabled ? "crop-preview" : "source",
  };

  const finishBrushAdjustment = useCallback(() => {
    if (brushAdjustmentTimerRef.current === null) return;
    window.clearTimeout(brushAdjustmentTimerRef.current);
    brushAdjustmentTimerRef.current = null;
    brushAdjustmentRef.current = null;
    endEditGroup();
  }, [endEditGroup]);

  useEffect(() => {
    brushSettingsRef.current = brushSettings;
  }, [brushSettings]);

  const adjustBrush = useCallback((setting: AdjustableBrushSetting, steps: number) => {
    if (steps === 0 || gestureRef.current) return;
    const step = setting === "size" ? BRUSH_SIZE_STEP : BRUSH_FEATHER_STEP;
    if (component?.kind === "brush" && mask) {
      const current = brushAdjustmentTimerRef.current !== null && brushAdjustmentRef.current?.id === component.id
        ? brushAdjustmentRef.current
        : component;
      const next = {
        ...captureBrushStrokeSettings(current),
        [setting]: clampUnit(Math.max(setting === "size" ? 0.01 : 0, current[setting] + steps * step)),
      };
      if (next[setting] === current[setting]) return;
      brushAdjustmentRef.current = next;
      const nextSettings = {
        size: next.size,
        feather: next.feather,
        flow: next.flow,
        density: next.density,
      };
      brushSettingsRef.current = nextSettings;
      onBrushSettingsChange(nextSettings);
      if (brushAdjustmentTimerRef.current === null) beginEditGroup(setting === "size" ? "Resize brush" : "Adjust brush feather");
      else window.clearTimeout(brushAdjustmentTimerRef.current);
      dispatch({ kind: "replace-mask-component", maskId: mask.id, component: next }, setting === "size" ? "Resize brush" : "Adjust brush feather");
      brushAdjustmentTimerRef.current = window.setTimeout(finishBrushAdjustment, 240);
      return;
    }

    const current = brushSettingsRef.current;
    const next = {
      ...current,
      [setting]: clampUnit(Math.max(setting === "size" ? 0.01 : 0, current[setting] + steps * step)),
    };
    if (next[setting] === current[setting]) return;
    brushSettingsRef.current = next;
    onBrushSettingsChange(next);
  }, [beginEditGroup, component, dispatch, finishBrushAdjustment, mask, onBrushSettingsChange]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (tool !== "brush" || gestureRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const setting = event.shiftKey ? "feather" : "size";
    const accumulator = wheelAccumulatorRef.current;
    if (accumulator.setting !== setting) {
      accumulator.setting = setting;
      accumulator.delta = 0;
    }
    const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? event.deltaY * Math.max(1, imageRect.height)
        : event.deltaY;
    accumulator.delta += pixels;
    const steps = Math.trunc(accumulator.delta / WHEEL_STEP);
    if (steps === 0) return;
    accumulator.delta -= steps * WHEEL_STEP;
    adjustBrush(setting, -steps);
  }, [adjustBrush, imageRect.height, tool]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (tool !== "brush" || isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code !== "BracketLeft" && event.code !== "BracketRight") return;
      event.preventDefault();
      adjustBrush(event.shiftKey ? "feather" : "size", event.code === "BracketRight" ? 1 : -1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [adjustBrush, tool]);

  useEffect(() => {
    const element = overlayElementRef.current;
    if (!element) return;
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  useEffect(() => () => {
    gestureRef.current = null;
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    if (cursorFrameRef.current !== null) cancelAnimationFrame(cursorFrameRef.current);
    finishBrushAdjustment();
  }, [finishBrushAdjustment]);

  if (tool === "none" && (!mask || !component)) return null;

  function eventCoordinates(event: React.PointerEvent<HTMLDivElement>): CursorPoint {
    const bounds = event.currentTarget.getBoundingClientRect();
    const output = {
      x: clampUnit((event.clientX - bounds.left) / Math.max(1, bounds.width)),
      y: clampUnit((event.clientY - bounds.top) / Math.max(1, bounds.height)),
    };
    return { output, source: transformOutputUv(output, sourceInput).oriented };
  }

  function queueCursor(point: CursorPoint | null): void {
    pendingCursorRef.current = point;
    if (cursorFrameRef.current !== null) return;
    cursorFrameRef.current = requestAnimationFrame(() => {
      cursorFrameRef.current = null;
      const element = cursorElementRef.current;
      if (!element) return;
      const next = pendingCursorRef.current;
      element.style.display = next ? "flex" : "none";
      if (next) {
        element.style.left = `${next.output.x * 100}%`;
        element.style.top = `${next.output.y * 100}%`;
      }
    });
  }

  function queuePreview(): void {
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      const gesture = gestureRef.current;
      setPreview(gesture ? componentForGesture(gesture, sourceInput) : null);
    });
  }

  function targetForNewComponent(): GestureTarget | null {
    if (mask) {
      return mask.components.length < MAX_COMPONENTS_PER_MASK
        ? { kind: "insert-component", maskId: mask.id, index: mask.components.length }
        : null;
    }
    return masks.length < MAX_MASKS
      ? { kind: "insert-mask", maskId: crypto.randomUUID(), index: masks.length, name: nextMaskName(masks) }
      : null;
  }

  function commitGesture(gesture: Gesture, next: MaskComponent): void {
    const target = gesture.target;
    switch (target.kind) {
      case "replace":
        dispatch({ kind: "replace-mask-component", maskId: target.maskId, component: next }, gesture.label);
        break;
      case "insert-component": {
        const label = next.kind === "linear-gradient" ? "linear" : next.kind === "radial-gradient" ? "radial" : "brush";
        dispatch({ kind: "insert-mask-component", maskId: target.maskId, index: target.index, component: next }, `Add ${label} component`);
        break;
      }
      case "insert-mask":
        dispatch({ kind: "insert-mask", index: target.index, mask: createMask(target.maskId, target.name, next) }, "Add mask");
        break;
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
    setSelectedMask(target.maskId);
    setSelectedComponent(next.id);
  }

  function findHandle(event: React.PointerEvent<HTMLDivElement>): HandleKind | null {
    const targetHandle = handleFromTarget(event.target);
    if (targetHandle) return targetHandle;
    if (!component || (component.kind !== "linear-gradient" && component.kind !== "radial-gradient")) return null;
    const { output } = eventCoordinates(event);
    const bounds = event.currentTarget.getBoundingClientRect();
    return handleSources(component, sourceInput).find(({ point }) => (
      outputDistanceInPixels(toOutputPoint(point, sourceInput), output, bounds.width, bounds.height) <= HANDLE_HIT_RADIUS
    ))?.kind ?? null;
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    finishBrushAdjustment();
    const coordinates = eventCoordinates(event);
    if (tool === "brush") queueCursor(coordinates);
    const handle = findHandle(event);
    const handleAllowed = component && mask && (tool === "none" || tool === component.kind);
    if (handle && handleAllowed && component && mask) {
      const base = {
        pointerId: event.pointerId,
        target: { kind: "replace", maskId: mask.id } as const,
        startOutput: coordinates.output,
        output: coordinates.output,
        point: coordinates.source,
        moved: false,
        label: handleLabel(handle),
      };
      if (component.kind === "linear-gradient" && isLinearHandle(handle)) {
        gestureRef.current = { ...base, kind: "linear-gradient", component, handle };
      } else if (component.kind === "radial-gradient" && isRadialHandle(handle)) {
        gestureRef.current = { ...base, kind: "radial-gradient", component, handle };
      }
      if (gestureRef.current) event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === "none") return;
    const editable = component?.kind === tool && mask ? component : null;
    const target = editable ? { kind: "replace", maskId: mask!.id } as const : targetForNewComponent();
    if (!target) return;
    const next = editable ?? createComponent(tool, crypto.randomUUID(), coordinates.source, brushSettingsRef.current);
    const base = {
      pointerId: event.pointerId,
      target,
      startOutput: coordinates.output,
      output: coordinates.output,
      point: coordinates.source,
      moved: false,
      label: tool === "brush" ? "Paint mask" : `Draw ${tool}`,
    };
    switch (tool) {
      case "brush":
        if (next.kind !== "brush") return;
        gestureRef.current = {
          ...base,
          kind: tool,
          component: next,
          baseStrokes: editable?.kind === "brush" ? editable.strokes : [],
          points: [coordinates.source],
          lastStoredOutput: coordinates.output,
        };
        break;
      case "linear-gradient":
        if (next.kind !== "linear-gradient") return;
        gestureRef.current = { ...base, kind: tool, component: { ...next, start: coordinates.source, end: coordinates.source }, handle: "create" };
        break;
      case "radial-gradient":
        if (next.kind !== "radial-gradient") return;
        gestureRef.current = { ...base, kind: tool, component: { ...next, center: coordinates.source, radiusX: 0.01, radiusY: 0.01 }, handle: "create" };
        break;
      default: {
        const exhaustive: never = tool;
        return exhaustive;
      }
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview(componentForGesture(gestureRef.current, sourceInput));
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const coordinates = eventCoordinates(event);
    if (tool === "brush") queueCursor(coordinates);
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.point = coordinates.source;
    gesture.output = coordinates.output;
    gesture.moved ||= outputDistanceInPixels(gesture.startOutput, coordinates.output, event.currentTarget.clientWidth, event.currentTarget.clientHeight) >= DRAG_THRESHOLD;
    if (gesture.kind === "brush") {
      const spacing = Math.max(1, brushCursorDiameter(gesture.component.size, imageRect, sourceInput) * 0.1);
      if (outputDistanceInPixels(gesture.lastStoredOutput, coordinates.output, event.currentTarget.clientWidth, event.currentTarget.clientHeight) < spacing) return;
      gesture.points.push(coordinates.source);
      gesture.lastStoredOutput = coordinates.output;
    }
    queuePreview();
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>, commit: boolean): void {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    if (gesture.kind === "brush" && outputDistanceInPixels(
      gesture.lastStoredOutput,
      gesture.output,
      event.currentTarget.clientWidth,
      event.currentTarget.clientHeight,
    ) >= 0.5) {
      gesture.points.push(gesture.point);
    }
    const next = componentForGesture(gesture, sourceInput);
    gestureRef.current = null;
    setPreview(null);
    if (commit && (gesture.kind === "brush" || gesture.handle !== "create" || gesture.moved)) commitGesture(gesture, next);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!component || !mask || (tool !== "none" && tool !== component.kind)) return;
    const handle = handleFromTarget(event.target);
    if (!handle || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    let next: MaskComponent = component;
    if (handle === "linear-start" || handle === "linear-end" || handle === "radial-center") {
      const delta = {
        x: event.key === "ArrowLeft" || event.key === "ArrowRight" ? direction * step : 0,
        y: event.key === "ArrowUp" || event.key === "ArrowDown" ? direction * step : 0,
      };
      if (component.kind === "linear-gradient" && (handle === "linear-start" || handle === "linear-end")) {
        next = { ...component, [handle === "linear-start" ? "start" : "end"]: movePointByOutputDelta(handle === "linear-start" ? component.start : component.end, delta, sourceInput) };
      } else if (component.kind === "radial-gradient" && handle === "radial-center") {
        next = { ...component, center: movePointByOutputDelta(component.center, delta, sourceInput) };
      }
    } else if (component.kind === "radial-gradient") {
      switch (handle) {
        case "radial-radius-x":
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") next = { ...component, radiusX: clampUnit(Math.max(0.01, component.radiusX + direction * step)) };
          break;
        case "radial-radius-y":
          if (event.key === "ArrowUp" || event.key === "ArrowDown") next = { ...component, radiusY: clampUnit(Math.max(0.01, component.radiusY + direction * step)) };
          break;
        case "radial-rotation":
          next = { ...component, rotation: normalizeDegrees(component.rotation + direction * (event.shiftKey ? 10 : 1)) };
          break;
        case "radial-feather":
          next = { ...component, feather: clampUnit(component.feather + direction * step) };
          break;
      }
    }
    if (next === component) return;
    event.preventDefault();
    event.stopPropagation();
    dispatch({ kind: "replace-mask-component", maskId: mask.id, component: next }, handleLabel(handle));
  }

  const guide = preview ?? (component && (tool === "none" || component.kind === tool) ? component : null);
  const brush = guide?.kind === "brush" ? guide : component?.kind === "brush" && tool === "brush" ? component : null;
  const cursorBrush = brush ?? {
    kind: "brush", id: "cursor", operation: "add", strokes: [{ points: [{ x: 0.5, y: 0.5 }], ...brushSettings }], ...brushSettings,
  } satisfies BrushMaskComponent;
  const cursorDiameter = brushCursorDiameter(cursorBrush.size, imageRect, sourceInput);

  return (
    <div
      ref={overlayElementRef}
      className={`absolute touch-none select-none ${tool === "brush" ? "cursor-none" : tool !== "none" ? "cursor-crosshair" : ""}`}
      style={{ left: imageRect.x, top: imageRect.y, width: imageRect.width, height: imageRect.height }}
      onPointerEnter={(event) => { if (tool === "brush") queueCursor(eventCoordinates(event)); }}
      onPointerLeave={() => { if (!gestureRef.current) queueCursor(null); }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishGesture(event, true)}
      onPointerCancel={(event) => finishGesture(event, false)}
      onKeyDown={onKeyDown}
    >
      {preview && overlayVisible ? (
        <PreviewCoverage
          component={preview}
          previousComponent={component}
          sourceInput={sourceInput}
          width={imageRect.width}
          height={imageRect.height}
          brushDiameter={cursorDiameter}
        />
      ) : null}
      {guide ? <Guide component={guide} sourceInput={sourceInput} /> : null}
      {tool === "brush" ? <BrushCursor elementRef={cursorElementRef} diameter={cursorDiameter} feather={cursorBrush.feather} /> : null}
    </div>
  );
}

function PreviewCoverage({
  component,
  previousComponent,
  sourceInput,
  width,
  height,
  brushDiameter,
}: {
  component: MaskComponent;
  previousComponent: MaskComponent | null;
  sourceInput: SourceTransformInput;
  width: number;
  height: number;
  brushDiameter: number;
}) {
  const gradientId = `mask-preview-${useId().replaceAll(":", "")}`;
  const toPixel = (point: NormalizedPoint) => {
    const output = toOutputPoint(point, sourceInput);
    return { x: output.x * width, y: output.y * height };
  };
  const viewBox = `0 0 ${width} ${height}`;

  switch (component.kind) {
    case "brush": {
      const strokes = previousComponent?.kind === "brush" && previousComponent.id === component.id
        ? component.strokes.slice(previousComponent.strokes.length)
        : component.strokes;
      return (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-hidden" viewBox={viewBox} preserveAspectRatio="none" aria-hidden>
          {strokes.map((stroke, index) => {
            const opacity = (stroke.flow ?? component.flow) * (stroke.density ?? component.density) * 0.35;
            const layers = brushPreviewLayers(brushDiameter, stroke.feather ?? component.feather, opacity);
            const points = stroke.points.map(toPixel);
            const pointList = points.map((point) => `${point.x},${point.y}`).join(" ");
            const first = points[0]!;
            return points.length === 1 ? (
              layers.map((layer, layerIndex) => (
                <circle key={`${index}-${layerIndex}`} cx={first.x} cy={first.y} r={layer.diameter / 2} fill="#8fb8e0" fillOpacity={layer.opacity} />
              ))
            ) : (
              layers.map((layer, layerIndex) => (
                <polyline key={`${index}-${layerIndex}`} points={pointList} fill="none" stroke="#8fb8e0" strokeOpacity={layer.opacity} strokeWidth={layer.diameter} strokeLinecap="round" strokeLinejoin="round" />
              ))
            );
          })}
        </svg>
      );
    }
    case "linear-gradient": {
      const start = toPixel(component.start);
      const end = toPixel(component.end);
      if (Math.hypot(end.x - start.x, end.y - start.y) < 0.5) return null;
      return (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-hidden" viewBox={viewBox} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={start.x} y1={start.y} x2={end.x} y2={end.y}>
              <stop offset="0" stopColor="#8fb8e0" stopOpacity="0.42" />
              <stop offset="0.25" stopColor="#8fb8e0" stopOpacity="0.35" />
              <stop offset="0.5" stopColor="#8fb8e0" stopOpacity="0.21" />
              <stop offset="0.75" stopColor="#8fb8e0" stopOpacity="0.07" />
              <stop offset="1" stopColor="#8fb8e0" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect width={width} height={height} fill={`url(#${gradientId})`} />
        </svg>
      );
    }
    case "radial-gradient": {
      const center = toPixel(component.center);
      const xHandle = toPixel(radialHandleSourcePoint(component, "radial-radius-x", sourceInput.displayWidth, sourceInput.displayHeight));
      const yHandle = toPixel(radialHandleSourcePoint(component, "radial-radius-y", sourceInput.displayWidth, sourceInput.displayHeight));
      const radiusX = Math.max(1, Math.hypot(xHandle.x - center.x, xHandle.y - center.y));
      const radiusY = Math.max(1, Math.hypot(yHandle.x - center.x, yHandle.y - center.y));
      const rotation = Math.atan2(xHandle.y - center.y, xHandle.x - center.x) * 180 / Math.PI;
      const inner = Math.max(0, 1 - component.feather);
      return (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-hidden" viewBox={viewBox} preserveAspectRatio="none" aria-hidden>
          <defs>
            <radialGradient id={gradientId}>
              <stop offset="0" stopColor="#8fb8e0" stopOpacity="0.42" />
              <stop offset={inner} stopColor="#8fb8e0" stopOpacity="0.42" />
              <stop offset="1" stopColor="#8fb8e0" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse
            cx={center.x}
            cy={center.y}
            rx={radiusX}
            ry={radiusY}
            transform={`rotate(${rotation} ${center.x} ${center.y})`}
            fill={`url(#${gradientId})`}
          />
        </svg>
      );
    }
    case "ai":
      return null;
    default: {
      const exhaustive: never = component;
      return exhaustive;
    }
  }
}

function brushPreviewLayers(diameter: number, feather: number, opacity: number): Array<{ diameter: number; opacity: number }> {
  if (opacity <= 0) return [];
  if (feather <= 0.001) return [{ diameter, opacity }];
  const steps = 12;
  const innerDiameter = Math.max(1, diameter * (1 - feather));
  const range = diameter - innerDiameter;
  const layers: Array<{ diameter: number; opacity: number }> = [];
  let previousOpacity = 0;
  for (let index = 0; index <= steps; index += 1) {
    const progress = (index + 1) / (steps + 2);
    const smooth = progress * progress * (3 - 2 * progress);
    const targetOpacity = opacity * smooth;
    layers.push({
      diameter: diameter - range * index / steps,
      opacity: (targetOpacity - previousOpacity) / Math.max(0.001, 1 - previousOpacity),
    });
    previousOpacity = targetOpacity;
  }
  layers.push({
    diameter: innerDiameter,
    opacity: (opacity - previousOpacity) / Math.max(0.001, 1 - previousOpacity),
  });
  return layers;
}

function BrushCursor({
  elementRef,
  diameter,
  feather,
}: {
  elementRef: React.RefObject<HTMLDivElement | null>;
  diameter: number;
  feather: number;
}) {
  const innerDiameter = Math.max(2, diameter * (1 - feather));
  return (
    <div
      ref={elementRef}
      aria-hidden
      className="pointer-events-none absolute z-20 flex items-center justify-center rounded-full border border-white/95 shadow-[0_0_0_1px_rgba(0,0,0,.8)]"
      style={{ display: "none", width: diameter, height: diameter, transform: "translate(-50%, -50%)" }}
    >
      <span className="rounded-full border border-dashed border-black/80 outline outline-1 outline-white/65" style={{ width: innerDiameter, height: innerDiameter }} />
      <span className="absolute h-0.5 w-0.5 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,.8)]" />
    </div>
  );
}

function handleCursor(kind: HandleKind): string {
  switch (kind) {
    case "linear-start":
    case "linear-end":
    case "radial-center": return "cursor-move";
    case "radial-radius-x":
    case "radial-feather": return "cursor-ew-resize";
    case "radial-radius-y": return "cursor-ns-resize";
    case "radial-rotation": return "cursor-grab active:cursor-grabbing";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function HandleGlyph({ kind }: { kind: HandleKind }) {
  switch (kind) {
    case "linear-start":
    case "linear-end":
      return <span className="h-1.5 w-1.5 rounded-full bg-current" />;
    case "radial-center":
      return <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M1 6h10M6 1v10M1 6l2-2M1 6l2 2M11 6 9 4M11 6 9 8M6 1 4 3M6 1l2 2M6 11l-2-2M6 11l2-2" /></svg>;
    case "radial-radius-x":
      return <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden><path d="M1 6h10M1 6l2-2M1 6l2 2M11 6 9 4M11 6 9 8" /></svg>;
    case "radial-radius-y":
      return <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden><path d="M6 1v10M6 1 4 3M6 1l2 2M6 11l-2-2M6 11l2-2" /></svg>;
    case "radial-rotation":
      return <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden><path d="M2.2 5.2A4.2 4.2 0 1 1 3.4 9M2.2 2.4v2.8H5" /></svg>;
    case "radial-feather":
      return <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden><circle cx="6" cy="6" r="4" /><circle cx="6" cy="6" r="1.7" strokeDasharray="1.2 1" /></svg>;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function HandleButton({ kind, point, label, value }: { kind: HandleKind; point: NormalizedPoint; label: string; value?: number }) {
  const emphasized = kind === "radial-rotation" || kind === "radial-feather";
  return (
    <button
      type="button"
      data-mask-handle={kind}
      title={label}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={value}
      className={`pointer-events-auto absolute z-10 flex h-5 w-5 items-center justify-center rounded-full border shadow-[0_1px_4px_rgba(0,0,0,.45)] ${handleCursor(kind)} ${emphasized ? "border-lr-accent bg-[#20201d] text-lr-accent" : "border-[#24231e] bg-lr-accent text-[#24231e]"}`}
      style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%`, transform: "translate(-50%, -50%)" }}
    >
      <HandleGlyph kind={kind} />
    </button>
  );
}

function Guide({ component, sourceInput }: { component: MaskComponent; sourceInput: SourceTransformInput }) {
  const toOutput = (point: NormalizedPoint) => toOutputPoint(point, sourceInput);
  switch (component.kind) {
    case "brush":
      return null;
    case "linear-gradient": {
      const start = toOutput(component.start);
      const end = toOutput(component.end);
      return (
        <Fragment>
          <svg className="pointer-events-none h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <line x1={start.x * 100} y1={start.y * 100} x2={end.x * 100} y2={end.y * 100} stroke="rgba(236,231,227,.9)" strokeWidth=".7" vectorEffect="non-scaling-stroke" />
          </svg>
          <HandleButton kind="linear-start" point={start} label="Move linear gradient start" value={component.start.x} />
          <HandleButton kind="linear-end" point={end} label="Move linear gradient end" value={component.end.x} />
        </Fragment>
      );
    }
    case "radial-gradient":
      return <RadialGuide component={component} sourceInput={sourceInput} />;
    case "ai":
      return null;
    default: {
      const exhaustive: never = component;
      return exhaustive;
    }
  }
}

function RadialGuide({ component, sourceInput }: { component: RadialGradientMaskComponent; sourceInput: SourceTransformInput }) {
  const center = toOutputPoint(component.center, sourceInput);
  const ellipsePoints = (scale: number) => Array.from({ length: 64 }, (_, index) => pointString(toOutputPoint(
    radialEllipsePoint(component, index / 64 * Math.PI * 2, sourceInput.displayWidth, sourceInput.displayHeight, scale),
    sourceInput,
  ))).join(" ");
  const handles = new Map(handleSources(component, sourceInput).map(({ kind, point }) => [kind, toOutputPoint(point, sourceInput)]));
  const xHandle = handles.get("radial-radius-x");
  const yHandle = handles.get("radial-radius-y");
  const rotationHandle = handles.get("radial-rotation");
  const featherHandle = handles.get("radial-feather");
  const centerHandle = handles.get("radial-center");
  if (!xHandle || !yHandle || !rotationHandle || !featherHandle || !centerHandle) return null;
  return (
    <Fragment>
      <svg className="pointer-events-none h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <polygon points={ellipsePoints(1)} fill="rgba(143,184,224,.08)" stroke="rgba(236,231,227,.9)" strokeWidth=".7" vectorEffect="non-scaling-stroke" />
        <polygon points={ellipsePoints(1 - FEATHER_HANDLE_SPAN * component.feather)} fill="none" stroke="rgba(255,255,255,.8)" strokeDasharray="3 3" strokeWidth=".55" vectorEffect="non-scaling-stroke" />
        <line x1={center.x * 100} y1={center.y * 100} x2={xHandle.x * 100} y2={xHandle.y * 100} stroke="rgba(236,231,227,.45)" strokeWidth=".45" vectorEffect="non-scaling-stroke" />
        <line x1={center.x * 100} y1={center.y * 100} x2={yHandle.x * 100} y2={yHandle.y * 100} stroke="rgba(236,231,227,.45)" strokeWidth=".45" vectorEffect="non-scaling-stroke" />
        <line x1={xHandle.x * 100} y1={xHandle.y * 100} x2={rotationHandle.x * 100} y2={rotationHandle.y * 100} stroke="rgba(236,231,227,.45)" strokeDasharray="2 2" strokeWidth=".45" vectorEffect="non-scaling-stroke" />
      </svg>
      <HandleButton kind="radial-center" point={centerHandle} label="Move radial gradient center" value={component.center.x} />
      <HandleButton kind="radial-radius-x" point={xHandle} label="Adjust radial gradient width" value={component.radiusX} />
      <HandleButton kind="radial-radius-y" point={yHandle} label="Adjust radial gradient height" value={component.radiusY} />
      <HandleButton kind="radial-rotation" point={rotationHandle} label="Rotate radial gradient" value={(normalizeDegrees(component.rotation) + 180) / 360} />
      <HandleButton kind="radial-feather" point={featherHandle} label="Adjust radial gradient feather" value={component.feather} />
    </Fragment>
  );
}
