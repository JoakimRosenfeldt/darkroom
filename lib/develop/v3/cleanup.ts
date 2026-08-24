import type { GeometryPoint } from "./geometry";
import {
  MAX_DEVELOP_ASSET_REFS,
  parseDevelopAssetRef,
  type DevelopAssetRef,
} from "./assets";

export const MAX_CLEANUP_COMPONENTS = Math.min(MAX_DEVELOP_ASSET_REFS, 256);

export interface CleanupEllipse {
  readonly center: GeometryPoint;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotationDegrees: number;
}

export type SampledRepairSource = {
  readonly kind: "sampled";
  readonly region: CleanupEllipse;
};

export type RepairPatchAssetRef = DevelopAssetRef & {
  readonly kind: "repair-patch";
};

export type AcceptedPatchRepairSource = {
  readonly kind: "accepted-patch";
  readonly region: CleanupEllipse;
  readonly asset: RepairPatchAssetRef;
};

interface RepairComponentBase {
  readonly kind: "repair";
  readonly id: string;
  readonly enabled: boolean;
  readonly target: CleanupEllipse;
  readonly feather: number;
  readonly opacity: number;
}

export interface SampledRepairComponent extends RepairComponentBase {
  readonly mode: "heal" | "clone";
  readonly source: SampledRepairSource;
}

export interface RemoveRepairComponent extends RepairComponentBase {
  readonly mode: "remove";
  readonly source: SampledRepairSource | AcceptedPatchRepairSource;
}

export interface RedEyeComponent {
  readonly kind: "red-eye";
  readonly id: string;
  readonly enabled: boolean;
  readonly origin: "manual" | "accepted-proposal";
  readonly bounds: CleanupEllipse;
  readonly pupilRadius: number;
  readonly amount: number;
  readonly catchlightProtection: number;
}

export type CleanupComponent =
  | SampledRepairComponent
  | RemoveRepairComponent
  | RedEyeComponent;

export interface CleanupLayer {
  readonly components: readonly CleanupComponent[];
}

export interface RedEyeProposal {
  readonly proposalId: string;
  readonly bounds: CleanupEllipse;
  readonly pupilRadius: number;
  readonly amount: number;
  readonly catchlightProtection: number;
  readonly confidence: number;
}

export type CleanupCommand =
  | { readonly kind: "add"; readonly component: CleanupComponent }
  | {
      readonly kind: "replace";
      readonly componentId: string;
      readonly component: CleanupComponent;
    }
  | {
      readonly kind: "set-enabled";
      readonly componentId: string;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "move";
      readonly componentId: string;
      readonly targetIndex: number;
    }
  | { readonly kind: "delete"; readonly componentId: string }
  | { readonly kind: "reset" };

export type CleanupCommandResult =
  | { readonly kind: "changed"; readonly layer: CleanupLayer }
  | {
      readonly kind: "skipped";
      readonly reason: "duplicate" | "missing" | "unchanged" | "empty";
    }
  | { readonly kind: "invalid"; readonly reason: string };

export type RedEyeAcceptanceResult =
  | { readonly kind: "accepted"; readonly component: RedEyeComponent }
  | { readonly kind: "invalid"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  minimumInclusive = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (minimumInclusive ? value < minimum : value <= minimum) ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parsePoint(value: unknown): GeometryPoint {
  if (!isRecord(value)) throw new Error("Cleanup point is invalid.");
  return {
    x: boundedNumber(value.x, "Cleanup x coordinate", 0, 1),
    y: boundedNumber(value.y, "Cleanup y coordinate", 0, 1),
  };
}

function parseEllipse(value: unknown): CleanupEllipse {
  if (!isRecord(value)) throw new Error("Cleanup region is invalid.");
  return {
    center: parsePoint(value.center),
    radiusX: boundedNumber(value.radiusX, "Cleanup x radius", 0, 1, false),
    radiusY: boundedNumber(value.radiusY, "Cleanup y radius", 0, 1, false),
    rotationDegrees: boundedNumber(
      value.rotationDegrees,
      "Cleanup rotation",
      -180,
      180,
    ),
  };
}

function parseRepairPatchAsset(value: unknown): RepairPatchAssetRef {
  const reference = parseDevelopAssetRef(value);
  if (reference.kind !== "repair-patch") {
    throw new Error("Cleanup patch reference is not a repair asset.");
  }
  return { ...reference, kind: "repair-patch" };
}

function parseRepairSource(
  value: unknown,
): SampledRepairSource | AcceptedPatchRepairSource {
  if (!isRecord(value)) throw new Error("Cleanup repair source is invalid.");
  if (value.kind === "sampled") {
    return { kind: "sampled", region: parseEllipse(value.region) };
  }
  if (value.kind === "accepted-patch") {
    return {
      kind: "accepted-patch",
      region: parseEllipse(value.region),
      asset: parseRepairPatchAsset(value.asset),
    };
  }
  throw new Error("Cleanup repair source kind is invalid.");
}

function parseRepairComponent(
  value: Record<string, unknown>,
): SampledRepairComponent | RemoveRepairComponent {
  if (typeof value.enabled !== "boolean") {
    throw new Error("Cleanup enabled state is invalid.");
  }
  const common = {
    kind: "repair" as const,
    id: boundedText(value.id, "Cleanup component ID"),
    enabled: value.enabled,
    target: parseEllipse(value.target),
    feather: boundedNumber(value.feather, "Cleanup feather", 0, 1),
    opacity: boundedNumber(value.opacity, "Cleanup opacity", 0, 1),
  };
  const source = parseRepairSource(value.source);
  if (value.mode === "heal" || value.mode === "clone") {
    if (source.kind !== "sampled") {
      throw new Error("Heal and Clone require a sampled source.");
    }
    return { ...common, mode: value.mode, source };
  }
  if (value.mode === "remove") {
    return { ...common, mode: "remove", source };
  }
  throw new Error("Cleanup repair mode is invalid.");
}

function parseRedEyeComponent(value: Record<string, unknown>): RedEyeComponent {
  if (value.origin !== "manual" && value.origin !== "accepted-proposal") {
    throw new Error("Red-eye origin is invalid.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("Red-eye enabled state is invalid.");
  }
  return {
    kind: "red-eye",
    id: boundedText(value.id, "Red-eye component ID"),
    enabled: value.enabled,
    origin: value.origin,
    bounds: parseEllipse(value.bounds),
    pupilRadius: boundedNumber(value.pupilRadius, "Red-eye pupil radius", 0, 1, false),
    amount: boundedNumber(value.amount, "Red-eye amount", 0, 1),
    catchlightProtection: boundedNumber(
      value.catchlightProtection,
      "Red-eye catchlight protection",
      0,
      1,
    ),
  };
}

export function parseCleanupComponent(value: unknown): CleanupComponent {
  if (!isRecord(value)) throw new Error("Cleanup component is invalid.");
  switch (value.kind) {
    case "repair":
      return parseRepairComponent(value);
    case "red-eye":
      return parseRedEyeComponent(value);
    default:
      throw new Error("Cleanup component kind is invalid.");
  }
}

export function parseCleanupLayer(value: unknown): CleanupLayer {
  if (!isRecord(value) || !Array.isArray(value.components)) {
    throw new Error("Cleanup layer is invalid.");
  }
  if (value.components.length > MAX_CLEANUP_COMPONENTS) {
    throw new Error("Cleanup layer has too many components.");
  }
  const components = value.components.map(parseCleanupComponent);
  if (new Set(components.map((component) => component.id)).size !== components.length) {
    throw new Error("Cleanup component IDs must be unique.");
  }
  return { components };
}

function validLayer(layer: CleanupLayer): string | null {
  try {
    parseCleanupLayer(layer);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Cleanup layer is invalid.";
  }
}

function validComponent(component: CleanupComponent): string | null {
  try {
    parseCleanupComponent(component);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Cleanup component is invalid.";
  }
}

export function applyCleanupCommand(
  layer: CleanupLayer,
  command: CleanupCommand,
): CleanupCommandResult {
  const layerError = validLayer(layer);
  if (layerError) return { kind: "invalid", reason: layerError };
  switch (command.kind) {
    case "add": {
      const componentError = validComponent(command.component);
      if (componentError) return { kind: "invalid", reason: componentError };
      if (layer.components.length >= MAX_CLEANUP_COMPONENTS) {
        return { kind: "invalid", reason: "Cleanup layer is full." };
      }
      if (layer.components.some((component) => component.id === command.component.id)) {
        return { kind: "skipped", reason: "duplicate" };
      }
      return {
        kind: "changed",
        layer: { components: [...layer.components, command.component] },
      };
    }
    case "replace": {
      const componentError = validComponent(command.component);
      if (componentError) return { kind: "invalid", reason: componentError };
      if (command.component.id !== command.componentId) {
        return { kind: "invalid", reason: "Replacement component ID changed." };
      }
      const index = layer.components.findIndex(
        (component) => component.id === command.componentId,
      );
      if (index < 0) return { kind: "skipped", reason: "missing" };
      if (layer.components[index] === command.component) {
        return { kind: "skipped", reason: "unchanged" };
      }
      const components = [...layer.components];
      components[index] = command.component;
      return { kind: "changed", layer: { components } };
    }
    case "set-enabled": {
      const component = layer.components.find(
        (candidate) => candidate.id === command.componentId,
      );
      if (!component) return { kind: "skipped", reason: "missing" };
      if (component.enabled === command.enabled) {
        return { kind: "skipped", reason: "unchanged" };
      }
      return {
        kind: "changed",
        layer: {
          components: layer.components.map((candidate) =>
            candidate.id === command.componentId
              ? { ...candidate, enabled: command.enabled }
              : candidate
          ),
        },
      };
    }
    case "move": {
      if (
        !Number.isSafeInteger(command.targetIndex) ||
        command.targetIndex < 0 ||
        command.targetIndex >= layer.components.length
      ) {
        return { kind: "invalid", reason: "Cleanup target order is invalid." };
      }
      const index = layer.components.findIndex(
        (component) => component.id === command.componentId,
      );
      if (index < 0) return { kind: "skipped", reason: "missing" };
      if (index === command.targetIndex) {
        return { kind: "skipped", reason: "unchanged" };
      }
      const component = layer.components[index];
      if (!component) return { kind: "skipped", reason: "missing" };
      const components = [...layer.components];
      components.splice(index, 1);
      components.splice(command.targetIndex, 0, component);
      return { kind: "changed", layer: { components } };
    }
    case "delete": {
      if (!layer.components.some((component) => component.id === command.componentId)) {
        return { kind: "skipped", reason: "missing" };
      }
      return {
        kind: "changed",
        layer: {
          components: layer.components.filter(
            (component) => component.id !== command.componentId,
          ),
        },
      };
    }
    case "reset":
      return layer.components.length === 0
        ? { kind: "skipped", reason: "empty" }
        : { kind: "changed", layer: { components: [] } };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function acceptRedEyeProposal(input: {
  readonly proposal: RedEyeProposal;
  readonly componentId: string;
}): RedEyeAcceptanceResult {
  try {
    const component = parseRedEyeComponent({
      kind: "red-eye",
      id: input.componentId,
      enabled: true,
      origin: "accepted-proposal",
      bounds: input.proposal.bounds,
      pupilRadius: input.proposal.pupilRadius,
      amount: input.proposal.amount,
      catchlightProtection: input.proposal.catchlightProtection,
    });
    boundedText(input.proposal.proposalId, "Red-eye proposal ID");
    boundedNumber(input.proposal.confidence, "Red-eye proposal confidence", 0, 1);
    return { kind: "accepted", component };
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : "Red-eye proposal is invalid.",
    };
  }
}
