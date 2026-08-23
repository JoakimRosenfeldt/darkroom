import path from "node:path";
import {
  parseAssetId,
  parseOperationId,
  type AssetId,
  type OperationId,
} from "../lib/catalog/ids.ts";

export const CATALOG_FAULT_STAGES = [
  "planned",
  "destination-prepared",
  "destination-published",
  "catalog-applied",
  "source-cleaned",
] as const;

export type CatalogFaultStage = (typeof CATALOG_FAULT_STAGES)[number];

export interface CatalogFaultPoint {
  readonly operationId: OperationId;
  readonly itemId: AssetId;
  readonly stage: CatalogFaultStage;
}

export interface CatalogFaultInjector {
  afterStage(point: CatalogFaultPoint): void;
}

export interface CatalogWorkerTestHarnessData {
  readonly kind: "catalog-worker-test-harness";
  readonly rootPath: string;
  readonly faultPoint: CatalogFaultPoint | null;
}

export class CatalogFaultInjectedError extends Error {
  readonly point: CatalogFaultPoint;

  constructor(point: CatalogFaultPoint) {
    super(`Catalog fault injected after ${point.stage}.`);
    this.name = "CatalogFaultInjectedError";
    this.point = point;
  }
}

const noopCatalogFaultInjector: CatalogFaultInjector = {
  afterStage: () => undefined,
};

export function createNoopCatalogFaultInjector(): CatalogFaultInjector {
  return noopCatalogFaultInjector;
}

export function parseCatalogFaultStage(value: unknown): CatalogFaultStage {
  if (
    value !== "planned" &&
    value !== "destination-prepared" &&
    value !== "destination-published" &&
    value !== "catalog-applied" &&
    value !== "source-cleaned"
  ) {
    throw new Error("Catalog fault stage is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCatalogFaultPoint(value: unknown): CatalogFaultPoint {
  if (!isRecord(value)) {
    throw new Error("Catalog fault point is invalid.");
  }
  return {
    operationId: parseOperationId(value.operationId),
    itemId: parseAssetId(value.itemId),
    stage: parseCatalogFaultStage(value.stage),
  };
}

export function parseCatalogWorkerTestHarnessData(
  value: unknown,
): CatalogWorkerTestHarnessData | null {
  if (value === undefined) {
    return null;
  }
  if (
    !isRecord(value) ||
    value.kind !== "catalog-worker-test-harness" ||
    typeof value.rootPath !== "string" ||
    !path.isAbsolute(value.rootPath) ||
    value.rootPath !== path.normalize(value.rootPath)
  ) {
    throw new Error("Catalog worker test harness data is invalid.");
  }
  return {
    kind: "catalog-worker-test-harness",
    rootPath: value.rootPath,
    faultPoint: value.faultPoint === null ? null : parseCatalogFaultPoint(value.faultPoint),
  };
}

export function createCatalogFaultInjectorForTests(
  targets: readonly CatalogFaultPoint[],
): CatalogFaultInjector {
  const pending = new Set(
    targets.map((target) => `${target.operationId}\u0000${target.itemId}\u0000${target.stage}`),
  );
  return {
    afterStage(point): void {
      const key = `${point.operationId}\u0000${point.itemId}\u0000${point.stage}`;
      if (!pending.delete(key)) {
        return;
      }
      throw new CatalogFaultInjectedError(point);
    },
  };
}
