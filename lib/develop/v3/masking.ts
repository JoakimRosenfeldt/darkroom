import { parseDevelopAssetRefs, type DevelopAssetRef } from "./assets";
import type {
  BrushStroke,
  LocalMask,
  MaskComponent,
  SourceSignature,
} from "../types";
import { sourceSignaturesEqual } from "../source-transform";
import type { GeometryPoint } from "./geometry";
import { legacyBasicLocalAdjustments, parseLocalAdjustmentValues, type LocalAdjustmentValues } from "./local-adjustments";
import type { Rgb } from "./profiles";

export const MAX_LOCAL_MASKS = 64;
export const MAX_MASK_NODES = 256;
export const MAX_MASK_DEPTH = 32;
export const MAX_COLOR_RANGE_SAMPLES = 16;
const MAX_BRUSH_STROKES = 4_096;
const MAX_BRUSH_POINTS = 65_536;
const MAX_POINTS_PER_STROKE = 8_192;

interface BrushParseBudget {
  strokes: number;
  points: number;
}

export type MaskSource =
  | {
      readonly kind: "brush";
      readonly strokes: readonly BrushStroke[];
      readonly autoMask:
        | { readonly kind: "off" }
        | {
            readonly kind: "auto-mask-prototype-v1";
            readonly samplePolicy: "first-stroke-point" | "explicit-working-rgb";
            readonly samples: readonly Rgb[];
            readonly radius: number;
            readonly algorithm: "analysis-color-edge-v1";
          };
    }
  | { readonly kind: "linear-gradient"; readonly start: GeometryPoint; readonly end: GeometryPoint }
  | {
      readonly kind: "radial-gradient";
      readonly center: GeometryPoint;
      readonly radiusX: number;
      readonly radiusY: number;
      readonly rotation: number;
      readonly feather: number;
    }
  | {
      readonly kind: "luminance-range";
      readonly minimum: number;
      readonly maximum: number;
      readonly feather: number;
      readonly algorithm: "linear-rec709-v1";
    }
  | {
      readonly kind: "color-range";
      readonly samples: readonly Rgb[];
      readonly tolerance: number;
      readonly feather: number;
      readonly algorithm: "working-rgb-distance-v1";
    }
  | {
      readonly kind: "depth-range";
      readonly asset: DevelopAssetRef;
      readonly source: SourceSignature;
      readonly minimum: number;
      readonly maximum: number;
      readonly feather: number;
      readonly algorithm: "prototype-depth-map-v1";
    }
  | {
      readonly kind: "ai-matte";
      readonly selector: "subject" | "sky";
      readonly asset: DevelopAssetRef;
      readonly model: { readonly id: string; readonly revision: string };
      readonly source: SourceSignature;
      readonly threshold: number;
    };

export type MaskExpression =
  | { readonly kind: "source"; readonly id: string; readonly enabled: boolean; readonly source: MaskSource }
  | {
      readonly kind: "combine";
      readonly id: string;
      readonly enabled: boolean;
      readonly operation: "add" | "subtract" | "intersect";
      readonly left: MaskExpression;
      readonly right: MaskExpression;
    }
  | { readonly kind: "invert"; readonly id: string; readonly enabled: boolean; readonly child: MaskExpression };

export interface LocalMaskV3 {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly expression: MaskExpression;
  readonly adjustments: LocalAdjustmentValues;
}

export type MaskSourceNode = Extract<MaskExpression, { readonly kind: "source" }>;

export function maskSourceNodes(expression: MaskExpression): readonly MaskSourceNode[] {
  switch (expression.kind) {
    case "source": return [expression];
    case "combine": return [...maskSourceNodes(expression.left), ...maskSourceNodes(expression.right)];
    case "invert": return maskSourceNodes(expression.child);
    default: { const exhaustive: never = expression; return exhaustive; }
  }
}

export function findMaskNode(expression: MaskExpression, id: string): MaskExpression | null {
  if (expression.id === id) return expression;
  switch (expression.kind) {
    case "source": return null;
    case "combine": return findMaskNode(expression.left, id) ?? findMaskNode(expression.right, id);
    case "invert": return findMaskNode(expression.child, id);
    default: { const exhaustive: never = expression; return exhaustive; }
  }
}

export function replaceMaskNode(
  expression: MaskExpression,
  id: string,
  replacement: MaskExpression,
): MaskExpression {
  if (expression.id === id) return replacement;
  switch (expression.kind) {
    case "source": return expression;
    case "combine": return {
      ...expression,
      left: replaceMaskNode(expression.left, id, replacement),
      right: replaceMaskNode(expression.right, id, replacement),
    };
    case "invert": return { ...expression, child: replaceMaskNode(expression.child, id, replacement) };
    default: { const exhaustive: never = expression; return exhaustive; }
  }
}

export function removeMaskNode(expression: MaskExpression, id: string): MaskExpression | null {
  if (expression.id === id) return null;
  switch (expression.kind) {
    case "source": return expression;
    case "invert": {
      const child = removeMaskNode(expression.child, id);
      return child ? { ...expression, child } : null;
    }
    case "combine": {
      const left = removeMaskNode(expression.left, id);
      const right = removeMaskNode(expression.right, id);
      if (!left) return right;
      if (!right) return left;
      return { ...expression, left, right };
    }
    default: { const exhaustive: never = expression; return exhaustive; }
  }
}

export function appendMaskSource(
  expression: MaskExpression,
  source: MaskSourceNode,
  operation: Extract<MaskExpression, { readonly kind: "combine" }>["operation"],
  combineId: string,
): MaskExpression {
  return { kind: "combine", id: combineId, enabled: true, operation, left: expression, right: source };
}

export function wrapMaskNodeInGroup(
  expression: MaskExpression,
  id: string,
  sibling: MaskExpression,
  operation: Extract<MaskExpression, { readonly kind: "combine" }>["operation"],
  groupId: string,
): MaskExpression {
  const target = findMaskNode(expression, id);
  return target
    ? replaceMaskNode(expression, id, {
        kind: "combine", id: groupId, enabled: true, operation, left: target, right: sibling,
      })
    : expression;
}

export function ungroupMaskNode(expression: MaskExpression, id: string): MaskExpression {
  const target = findMaskNode(expression, id);
  return target?.kind === "combine" ? replaceMaskNode(expression, id, target.left) : expression;
}

export interface MaskRasterDimensions { readonly width: number; readonly height: number }
export interface MaskRasterMatte extends MaskRasterDimensions { readonly pixels: Uint8Array }
export interface MaskEvaluationDiagnostic {
  readonly kind: "analysis-unavailable" | "artifact-unavailable" | "artifact-stale";
  readonly sourceId: string;
  readonly detail: string;
}
export interface MaskEvaluationInput {
  readonly expression: MaskExpression;
  readonly point: GeometryPoint;
  readonly dimensions: MaskRasterDimensions;
  readonly sourceSignature?: SourceSignature;
  readonly analysis?: { readonly color: Rgb; readonly edge: number };
  readonly artifacts?: {
    readonly maskMatte: (assetId: string) => MaskRasterMatte | undefined;
    readonly depthMap?: (assetId: string) => MaskRasterMatte | undefined;
  };
}
export interface MaskEvaluationResult {
  readonly coverage: number;
  readonly diagnostics: readonly MaskEvaluationDiagnostic[];
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error(`${path} must be text.`);
  return value;
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean.`);
  return value;
}
function numberIn(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${path} must be between ${minimum} and ${maximum}.`);
  return Object.is(value, -0) ? 0 : value;
}
function point(value: unknown, path: string): GeometryPoint {
  const input = record(value, path);
  return { x: numberIn(input.x, `${path}.x`, 0, 1), y: numberIn(input.y, `${path}.y`, 0, 1) };
}
function rgb(value: unknown, path: string): Rgb {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${path} must contain three channels.`);
  return [numberIn(value[0], `${path}[0]`, 0, 1), numberIn(value[1], `${path}[1]`, 0, 1), numberIn(value[2], `${path}[2]`, 0, 1)];
}
function asset(value: unknown, path: string): DevelopAssetRef {
  try {
    const parsed = parseDevelopAssetRefs([value]);
    const first = parsed[0];
    if (!first) throw new Error("missing asset");
    return first;
  } catch (error) {
    throw new Error(`${path} is invalid: ${error instanceof Error ? error.message : "invalid asset"}`);
  }
}
function signature(value: unknown, path: string): SourceSignature {
  const input = record(value, path);
  return {
    entryId: text(input.entryId, `${path}.entryId`),
    ...(input.catalogId === undefined ? {} : { catalogId: text(input.catalogId, `${path}.catalogId`) }),
    ...(input.assetRevision === undefined ? {} : { assetRevision: numberIn(input.assetRevision, `${path}.assetRevision`, 0, Number.MAX_SAFE_INTEGER) }),
    relativePath: text(input.relativePath, `${path}.relativePath`),
    size: numberIn(input.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER),
    lastModified: numberIn(input.lastModified, `${path}.lastModified`, 0, Number.MAX_SAFE_INTEGER),
  };
}
function strokes(
  value: unknown,
  path: string,
  budget: BrushParseBudget,
): readonly BrushStroke[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BRUSH_STROKES) throw new Error(`${path} must contain strokes.`);
  budget.strokes += value.length;
  if (budget.strokes > MAX_BRUSH_STROKES) throw new Error(`Mask expression cannot exceed ${MAX_BRUSH_STROKES} brush strokes.`);
  return value.map((item, index) => {
    const input = record(item, `${path}[${index}]`);
    if (!Array.isArray(input.points) || input.points.length === 0 || input.points.length > MAX_POINTS_PER_STROKE) throw new Error(`${path}[${index}].points must contain points.`);
    budget.points += input.points.length;
    if (budget.points > MAX_BRUSH_POINTS) throw new Error(`Mask expression cannot exceed ${MAX_BRUSH_POINTS} brush points.`);
    const parsedPoints = input.points.map((item, pointIndex) => point(item, `${path}[${index}].points[${pointIndex}]`));
    const first = parsedPoints[0];
    if (!first) throw new Error(`${path}[${index}].points must contain points.`);
    const rest = parsedPoints.slice(1);
    return {
      points: [first, ...rest],
      size: numberIn(input.size, `${path}[${index}].size`, 0, 1),
      feather: numberIn(input.feather, `${path}[${index}].feather`, 0, 1),
      flow: numberIn(input.flow, `${path}[${index}].flow`, 0, 1),
      density: numberIn(input.density, `${path}[${index}].density`, 0, 1),
    };
  });
}

function parseSource(value: unknown, path: string, budget: BrushParseBudget): MaskSource {
  const input = record(value, path);
  switch (input.kind) {
    case "brush": {
      const autoMask = record(input.autoMask, `${path}.autoMask`);
      if (autoMask.kind === "off") return { kind: "brush", strokes: strokes(input.strokes, `${path}.strokes`, budget), autoMask: { kind: "off" } };
      if (autoMask.kind !== "auto-mask-prototype-v1") throw new Error(`${path}.autoMask is invalid.`);
      if (!Array.isArray(autoMask.samples) || autoMask.samples.length > MAX_COLOR_RANGE_SAMPLES) throw new Error(`${path}.autoMask.samples cannot exceed ${MAX_COLOR_RANGE_SAMPLES}.`);
      if (autoMask.samplePolicy !== "first-stroke-point" && autoMask.samplePolicy !== "explicit-working-rgb") throw new Error(`${path}.autoMask.samplePolicy is invalid.`);
      if (autoMask.algorithm !== "analysis-color-edge-v1") throw new Error(`${path}.autoMask.algorithm is invalid.`);
      return {
        kind: "brush", strokes: strokes(input.strokes, `${path}.strokes`, budget),
        autoMask: {
          kind: "auto-mask-prototype-v1", samplePolicy: autoMask.samplePolicy,
          samples: autoMask.samples.map((item, index) => rgb(item, `${path}.autoMask.samples[${index}]`)),
          radius: numberIn(autoMask.radius, `${path}.autoMask.radius`, 0.001, 1), algorithm: "analysis-color-edge-v1",
        },
      };
    }
    case "linear-gradient": return { kind: "linear-gradient", start: point(input.start, `${path}.start`), end: point(input.end, `${path}.end`) };
    case "radial-gradient": return { kind: "radial-gradient", center: point(input.center, `${path}.center`), radiusX: numberIn(input.radiusX, `${path}.radiusX`, 0.0001, 2), radiusY: numberIn(input.radiusY, `${path}.radiusY`, 0.0001, 2), rotation: numberIn(input.rotation, `${path}.rotation`, -360, 360), feather: numberIn(input.feather, `${path}.feather`, 0, 1) };
    case "luminance-range": {
      if (input.algorithm !== "linear-rec709-v1") throw new Error(`${path}.algorithm is invalid.`);
      const minimum = numberIn(input.minimum, `${path}.minimum`, 0, 1);
      const maximum = numberIn(input.maximum, `${path}.maximum`, 0, 1);
      if (minimum > maximum) throw new Error(`${path}.minimum cannot exceed maximum.`);
      return { kind: "luminance-range", minimum, maximum, feather: numberIn(input.feather, `${path}.feather`, 0, 1), algorithm: "linear-rec709-v1" };
    }
    case "color-range":
      if (input.algorithm !== "working-rgb-distance-v1" || !Array.isArray(input.samples) || input.samples.length === 0 || input.samples.length > MAX_COLOR_RANGE_SAMPLES) throw new Error(`${path} is invalid.`);
      return { kind: "color-range", samples: input.samples.map((item, index) => rgb(item, `${path}.samples[${index}]`)), tolerance: numberIn(input.tolerance, `${path}.tolerance`, 0.001, 2), feather: numberIn(input.feather, `${path}.feather`, 0, 1), algorithm: "working-rgb-distance-v1" };
    case "depth-range": {
      if (input.algorithm !== "prototype-depth-map-v1") throw new Error(`${path}.algorithm is invalid.`);
      const minimum = numberIn(input.minimum, `${path}.minimum`, 0, 1);
      const maximum = numberIn(input.maximum, `${path}.maximum`, 0, 1);
      if (minimum > maximum) throw new Error(`${path}.minimum cannot exceed maximum.`);
      return { kind: "depth-range", asset: asset(input.asset, `${path}.asset`), source: signature(input.source, `${path}.source`), minimum, maximum, feather: numberIn(input.feather, `${path}.feather`, 0, 1), algorithm: "prototype-depth-map-v1" };
    }
    case "ai-matte": {
      const model = record(input.model, `${path}.model`);
      if (input.selector !== "subject" && input.selector !== "sky") throw new Error(`${path}.selector is invalid.`);
      return { kind: "ai-matte", selector: input.selector, asset: asset(input.asset, `${path}.asset`), model: { id: text(model.id, `${path}.model.id`), revision: text(model.revision, `${path}.model.revision`) }, source: signature(input.source, `${path}.source`), threshold: numberIn(input.threshold, `${path}.threshold`, 0, 1) };
    }
    default: throw new Error(`${path}.kind is not supported.`);
  }
}

export function parseMaskExpression(value: unknown): MaskExpression {
  let nodes = 0;
  const ids = new Set<string>();
  const brushBudget: BrushParseBudget = { strokes: 0, points: 0 };
  const parse = (raw: unknown, path: string, depth: number): MaskExpression => {
    nodes += 1;
    if (nodes > MAX_MASK_NODES) throw new Error(`Mask expression cannot exceed ${MAX_MASK_NODES} nodes.`);
    if (depth > MAX_MASK_DEPTH) throw new Error(`Mask expression cannot exceed depth ${MAX_MASK_DEPTH}.`);
    const input = record(raw, path);
    const id = text(input.id, `${path}.id`);
    if (ids.has(id)) throw new Error(`Duplicate mask node ID ${id}.`);
    ids.add(id);
    const common = { id, enabled: bool(input.enabled, `${path}.enabled`) };
    switch (input.kind) {
      case "source": return { kind: "source", ...common, source: parseSource(input.source, `${path}.source`, brushBudget) };
      case "combine": {
        if (input.operation !== "add" && input.operation !== "subtract" && input.operation !== "intersect") throw new Error(`${path}.operation is invalid.`);
        return { kind: "combine", ...common, operation: input.operation, left: parse(input.left, `${path}.left`, depth + 1), right: parse(input.right, `${path}.right`, depth + 1) };
      }
      case "invert": return { kind: "invert", ...common, child: parse(input.child, `${path}.child`, depth + 1) };
      default: throw new Error(`${path}.kind is not supported.`);
    }
  };
  return parse(value, "mask expression", 1);
}

export function parseLocalMasksV3(value: unknown): readonly LocalMaskV3[] {
  if (!Array.isArray(value) || value.length > MAX_LOCAL_MASKS) throw new Error(`local.masks cannot exceed ${MAX_LOCAL_MASKS} masks.`);
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const input = record(raw, `local.masks[${index}]`);
    const id = text(input.id, `local.masks[${index}].id`);
    if (ids.has(id)) throw new Error(`Duplicate mask ID ${id}.`);
    ids.add(id);
    return { id, name: text(input.name, `local.masks[${index}].name`), enabled: bool(input.enabled, `local.masks[${index}].enabled`), expression: parseMaskExpression(input.expression), adjustments: parseLocalAdjustmentValues(input.adjustments) };
  });
}

function sourceForLegacy(component: MaskComponent, assetIds: ReadonlyMap<string, DevelopAssetRef>): MaskSource {
  switch (component.kind) {
    case "brush": return { kind: "brush", strokes: structuredClone(component.strokes), autoMask: { kind: "off" } };
    case "linear-gradient": return { kind: "linear-gradient", start: structuredClone(component.start), end: structuredClone(component.end) };
    case "radial-gradient": return { kind: "radial-gradient", center: structuredClone(component.center), radiusX: component.radiusX, radiusY: component.radiusY, rotation: component.rotation, feather: component.feather };
    case "ai": {
      const ref = assetIds.get(component.assetId);
      if (!ref) throw new Error(`Legacy AI mask asset ${component.assetId} is missing.`);
      return { kind: "ai-matte", selector: component.selector, asset: ref, model: structuredClone(component.model), source: structuredClone(component.source), threshold: component.inference.threshold };
    }
    default: { const exhaustive: never = component; return exhaustive; }
  }
}

export function migrateLegacyMask(mask: LocalMask, assets: readonly DevelopAssetRef[]): LocalMaskV3 {
  const assetIds = new Map(assets.map((item) => [item.assetId, item]));
  const componentNode = (component: MaskComponent): MaskExpression => ({ kind: "source", id: `${component.id}:source`, enabled: true, source: sourceForLegacy(component, assetIds) });
  const [first, ...rest] = mask.components;
  let expression = {
    ...componentNode(first),
    enabled: first.operation === "add",
  };
  rest.forEach((component, index) => {
    expression = { kind: "combine", id: `${mask.id}:combine:${index + 1}`, enabled: true, operation: component.operation, left: expression, right: componentNode(component) };
  });
  if (mask.inverted) expression = { kind: "invert", id: `${mask.id}:invert`, enabled: true, child: expression };
  return { id: mask.id, name: mask.name, enabled: mask.enabled, expression, adjustments: legacyBasicLocalAdjustments(mask.adjustments) };
}

function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0)); }
function smoothstep(minimum: number, maximum: number, value: number): number { if (minimum === maximum) return value < minimum ? 0 : 1; const position = clamp((value - minimum) / (maximum - minimum), 0, 1); return position * position * (3 - 2 * position); }
function sourceOver(destination: number, source: number): number { return source + destination * (1 - source); }
function pointSegmentDistance(pointX: number, pointY: number, startX: number, startY: number, endX: number, endY: number): number { const dx = endX - startX; const dy = endY - startY; const lengthSquared = dx * dx + dy * dy; const amount = lengthSquared <= Number.EPSILON ? 0 : clamp(((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared, 0, 1); return Math.hypot(pointX - (startX + dx * amount), pointY - (startY + dy * amount)); }
function strokeCoverage(stroke: BrushStroke, point: GeometryPoint, dimensions: MaskRasterDimensions): number { const width = Math.max(1, dimensions.width - 1); const height = Math.max(1, dimensions.height - 1); const x = point.x * width; const y = point.y * height; const radius = Math.max(0.5, stroke.size * Math.max(dimensions.width, dimensions.height) * 0.5); let distance = Number.POSITIVE_INFINITY; stroke.points.forEach((current, index) => { const previous = stroke.points[Math.max(0, index - 1)] ?? current; distance = Math.min(distance, pointSegmentDistance(x, y, previous.x * width, previous.y * height, current.x * width, current.y * height)); }); const inner = radius * (1 - clamp(stroke.feather, 0, 1)); return clamp((distance <= inner ? 1 : 1 - smoothstep(inner, radius, distance)) * stroke.flow * stroke.density, 0, 1); }
function sampleRaster(matte: MaskRasterMatte, point: GeometryPoint): number { const x = clamp(point.x, 0, 1) * (matte.width - 1); const y = (1 - clamp(point.y, 0, 1)) * (matte.height - 1); const lx = Math.floor(x); const ly = Math.floor(y); const hx = Math.min(matte.width - 1, lx + 1); const hy = Math.min(matte.height - 1, ly + 1); const wx = x - lx; const wy = y - ly; const top = (matte.pixels[ly * matte.width + lx] ?? 0) * (1 - wx) + (matte.pixels[ly * matte.width + hx] ?? 0) * wx; const bottom = (matte.pixels[hy * matte.width + lx] ?? 0) * (1 - wx) + (matte.pixels[hy * matte.width + hx] ?? 0) * wx; return (top * (1 - wy) + bottom * wy) / 255; }
function rangeCoverage(value: number, minimum: number, maximum: number, feather: number): number { if (minimum > maximum) return 0; const edge = Math.max(0.0001, feather); return smoothstep(minimum - edge, minimum, value) * (1 - smoothstep(maximum, maximum + edge, value)); }

function evaluateSource(id: string, source: MaskSource, input: MaskEvaluationInput, diagnostics: MaskEvaluationDiagnostic[]): number {
  switch (source.kind) {
    case "brush": {
      let coverage = 0;
      for (const stroke of source.strokes) coverage = sourceOver(coverage, strokeCoverage(stroke, input.point, input.dimensions));
      if (source.autoMask.kind === "off") return coverage;
      if (!input.analysis) { diagnostics.push({ kind: "analysis-unavailable", sourceId: id, detail: "Auto Mask needs mask-analysis-v1 color and edge data." }); return 0; }
      const distance = source.autoMask.samples.length === 0 ? 0 : Math.min(...source.autoMask.samples.map((sample) => Math.hypot(sample[0] - input.analysis!.color[0], sample[1] - input.analysis!.color[1], sample[2] - input.analysis!.color[2])));
      return coverage * clamp(1 - distance / source.autoMask.radius, 0, 1) * clamp(1 - input.analysis.edge, 0, 1);
    }
    case "linear-gradient": { const width = Math.max(1, input.dimensions.width - 1); const height = Math.max(1, input.dimensions.height - 1); const dx = (source.end.x - source.start.x) * width; const dy = (source.end.y - source.start.y) * height; const length = dx * dx + dy * dy; if (length <= Number.EPSILON) return 0; return 1 - smoothstep(0, 1, ((input.point.x * width - source.start.x * width) * dx + (input.point.y * height - source.start.y * height) * dy) / length); }
    case "radial-gradient": { const angle = source.rotation * Math.PI / 180; const dx = input.point.x - source.center.x; const dy = input.point.y - source.center.y; const x = (Math.cos(angle) * dx + Math.sin(angle) * dy) / source.radiusX; const y = (-Math.sin(angle) * dx + Math.cos(angle) * dy) / source.radiusY; return 1 - smoothstep(1 - source.feather, 1, Math.hypot(x, y)); }
    case "luminance-range": if (!input.analysis) { diagnostics.push({ kind: "analysis-unavailable", sourceId: id, detail: "Luminance Range needs linear mask-analysis-v1 pixels." }); return 0; } return rangeCoverage(input.analysis.color[0] * 0.2126 + input.analysis.color[1] * 0.7152 + input.analysis.color[2] * 0.0722, source.minimum, source.maximum, source.feather);
    case "color-range": if (!input.analysis) { diagnostics.push({ kind: "analysis-unavailable", sourceId: id, detail: "Color Range needs mask-analysis-v1 pixels." }); return 0; } return rangeCoverage(Math.min(...source.samples.map((sample) => Math.hypot(sample[0] - input.analysis!.color[0], sample[1] - input.analysis!.color[1], sample[2] - input.analysis!.color[2]))), 0, source.tolerance, source.feather);
    case "depth-range":
    case "ai-matte": {
      if (!input.sourceSignature || !sourceSignaturesEqual(source.source, input.sourceSignature)) { diagnostics.push({ kind: "artifact-stale", sourceId: id, detail: "The raster source belongs to another source revision." }); return 0; }
      const matte = source.kind === "depth-range" ? input.artifacts?.depthMap?.(source.asset.assetId) : input.artifacts?.maskMatte(source.asset.assetId);
      if (!matte) { diagnostics.push({ kind: "artifact-unavailable", sourceId: id, detail: "The raster source is unavailable." }); return 0; }
      const value = sampleRaster(matte, input.point);
      return source.kind === "depth-range" ? rangeCoverage(value, source.minimum, source.maximum, source.feather) : value < source.threshold ? 0 : value;
    }
    default: { const exhaustive: never = source; return exhaustive; }
  }
}

export function evaluateMask(input: MaskEvaluationInput): MaskEvaluationResult {
  const diagnostics: MaskEvaluationDiagnostic[] = [];
  const evaluate = (expression: MaskExpression): number => {
    switch (expression.kind) {
      case "source": return expression.enabled ? evaluateSource(expression.id, expression.source, input, diagnostics) : 0;
      case "combine": if (!expression.enabled) return evaluate(expression.left); { const left = evaluate(expression.left); const right = evaluate(expression.right); switch (expression.operation) { case "add": return sourceOver(left, right); case "subtract": return left * (1 - right); case "intersect": return left * right; default: { const exhaustive: never = expression.operation; return exhaustive; } } }
      case "invert": { const child = evaluate(expression.child); return expression.enabled ? 1 - child : child; }
      default: { const exhaustive: never = expression; return exhaustive; }
    }
  };
  return { coverage: clamp(evaluate(input.expression), 0, 1), diagnostics };
}

export function referencedMaskArtifacts(expression: MaskExpression): readonly DevelopAssetRef[] {
  const refs: DevelopAssetRef[] = [];
  const visit = (node: MaskExpression): void => { switch (node.kind) { case "source": if (node.source.kind === "depth-range" || node.source.kind === "ai-matte") refs.push(node.source.asset); break; case "combine": visit(node.left); visit(node.right); break; case "invert": visit(node.child); break; default: { const exhaustive: never = node; return exhaustive; } } };
  visit(expression);
  return refs;
}
