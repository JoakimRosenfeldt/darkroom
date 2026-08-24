import type { GeometryPoint, Homography } from "./geometry";

export type UprightMode = "manual" | "guided" | "automatic";

export interface UprightValues {
  readonly rotationDegrees: number;
  readonly horizontalPerspective: number;
  readonly verticalPerspective: number;
}

export interface UprightProposal {
  readonly mode: UprightMode;
  readonly values: UprightValues;
  readonly matrix: Homography;
  readonly confidence: number;
}

export type UprightProposalOutcome =
  | { readonly kind: "proposal"; readonly proposal: UprightProposal }
  | {
      readonly kind: "no-result";
      readonly mode: UprightMode;
      readonly reason: "insufficient-guides" | "low-confidence" | "invalid-input";
    }
  | { readonly kind: "cancelled"; readonly mode: UprightMode };

export interface UprightGuide {
  readonly role: "horizontal" | "vertical";
  readonly start: GeometryPoint;
  readonly end: GeometryPoint;
}

export interface AutomaticUprightObservation {
  readonly rotationDegrees: number;
  readonly horizontalPerspective: number;
  readonly verticalPerspective: number;
  readonly confidence: number;
  readonly featureCount: number;
}

const MAX_GUIDES = 8;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, 0)));
}

function normalizeLineAngle(angleDegrees: number): number {
  let angle = finiteOr(angleDegrees, 0);
  while (angle > 90) angle -= 180;
  while (angle <= -90) angle += 180;
  return angle;
}

function createMatrix(values: UprightValues): Homography {
  const rotation = clamp(values.rotationDegrees, -45, 45) * Math.PI / 180;
  const horizontal = clamp(values.horizontalPerspective, -1, 1) * 0.5;
  const vertical = clamp(values.verticalPerspective, -1, 1) * 0.5;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return [
    cosine,
    -sine,
    0.5 - 0.5 * cosine + 0.5 * sine,
    sine,
    cosine,
    0.5 - 0.5 * sine - 0.5 * cosine,
    horizontal,
    vertical,
    1 - 0.5 * horizontal - 0.5 * vertical,
  ];
}

function proposal(
  mode: UprightMode,
  values: UprightValues,
  confidence: number,
): UprightProposalOutcome {
  const boundedValues = {
    rotationDegrees: clamp(values.rotationDegrees, -45, 45),
    horizontalPerspective: clamp(values.horizontalPerspective, -1, 1),
    verticalPerspective: clamp(values.verticalPerspective, -1, 1),
  };
  return {
    kind: "proposal",
    proposal: {
      mode,
      values: boundedValues,
      matrix: createMatrix(boundedValues),
      confidence: clamp(confidence, 0, 1),
    },
  };
}

export function proposeManualUpright(values: UprightValues): UprightProposalOutcome {
  if (!Object.values(values).every(Number.isFinite)) {
    return { kind: "no-result", mode: "manual", reason: "invalid-input" };
  }
  return proposal("manual", values, 1);
}

export function proposeGuidedUpright(
  guides: readonly UprightGuide[],
): UprightProposalOutcome {
  if (guides.length === 0) {
    return { kind: "no-result", mode: "guided", reason: "insufficient-guides" };
  }
  const deviations: number[] = [];
  let horizontalSum = 0;
  let verticalSum = 0;
  let horizontalCount = 0;
  let verticalCount = 0;
  for (const guide of guides.slice(0, MAX_GUIDES)) {
    const deltaX = guide.end.x - guide.start.x;
    const deltaY = guide.end.y - guide.start.y;
    const length = Math.hypot(deltaX, deltaY);
    if (!Number.isFinite(length) || length < 1e-4) continue;
    const angle = normalizeLineAngle(Math.atan2(deltaY, deltaX) * 180 / Math.PI);
    const deviation = guide.role === "horizontal"
      ? angle
      : normalizeLineAngle(angle - 90);
    deviations.push(deviation);
    if (guide.role === "horizontal") {
      horizontalSum += deviation;
      horizontalCount += 1;
    } else {
      verticalSum += deviation;
      verticalCount += 1;
    }
  }
  if (deviations.length === 0) {
    return { kind: "no-result", mode: "guided", reason: "invalid-input" };
  }
  const mean = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
  const spread = Math.sqrt(
    deviations.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      deviations.length,
  );
  const horizontalMean = horizontalCount > 0 ? horizontalSum / horizontalCount : mean;
  const verticalMean = verticalCount > 0 ? verticalSum / verticalCount : mean;
  return proposal("guided", {
    rotationDegrees: -mean,
    horizontalPerspective: clamp((verticalMean - mean) / 45, -1, 1),
    verticalPerspective: clamp((horizontalMean - mean) / 45, -1, 1),
  }, 1 - clamp(spread / 20, 0, 0.8));
}

export function proposeAutomaticUpright(
  observation: AutomaticUprightObservation,
): UprightProposalOutcome {
  if (
    !Object.values(observation).every(Number.isFinite) ||
    observation.featureCount < 2
  ) {
    return { kind: "no-result", mode: "automatic", reason: "invalid-input" };
  }
  if (observation.confidence < 0.2) {
    return { kind: "no-result", mode: "automatic", reason: "low-confidence" };
  }
  return proposal("automatic", observation, observation.confidence);
}

export function cancelledUpright(mode: UprightMode): UprightProposalOutcome {
  return { kind: "cancelled", mode };
}
