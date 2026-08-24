import type {
  AnalysisTapId,
  PixelPrecision,
  V3SourceSignature,
} from "../process";
import type { RenderPlanIdentityInputs } from "../render-contract";
import type { PixelRegion } from "./source";

export const MAX_CACHE_KEY_BYTES = 1024 * 1024;
export const MAX_CACHE_ENTRIES = 100_000;
export const MAX_CACHE_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;

export interface DecodedSourceCacheKey {
  readonly kind: "decoded-source";
  readonly source: V3SourceSignature;
  readonly decoderId: string;
  readonly decoderRevision: string;
  readonly precision: PixelPrecision;
  readonly region: PixelRegion;
}

export interface PlanCacheKey {
  readonly kind: "render-plan";
  readonly identity: RenderPlanIdentityInputs;
}

export type FrameCacheClass = "grid" | "fit" | "active-loupe" | "export";

export interface FrameCacheKey {
  readonly kind: "rendered-frame";
  readonly frameClass: FrameCacheClass;
  readonly plan: PlanCacheKey;
  readonly outputRegion: PixelRegion;
}

export interface AnalysisCacheKey {
  readonly kind: "analysis";
  readonly plan: PlanCacheKey;
  readonly tap: AnalysisTapId;
}

export type DevelopCacheKey =
  | DecodedSourceCacheKey
  | PlanCacheKey
  | FrameCacheKey
  | AnalysisCacheKey;

export interface CacheBudget {
  readonly maximumEntries: number;
  readonly maximumBytes: number;
}

export interface DevelopCacheBudgets {
  readonly decodedSource: CacheBudget;
  readonly plans: CacheBudget;
  readonly frames: {
    readonly grid: CacheBudget;
    readonly fit: CacheBudget;
    readonly activeLoupe: CacheBudget;
    readonly export: CacheBudget;
  };
  readonly analysis: CacheBudget;
}

export const DEFAULT_DEVELOP_CACHE_BUDGETS = {
  decodedSource: { maximumEntries: 64, maximumBytes: 512 * 1024 * 1024 },
  plans: { maximumEntries: 256, maximumBytes: 16 * 1024 * 1024 },
  frames: {
    grid: { maximumEntries: 512, maximumBytes: 256 * 1024 * 1024 },
    fit: { maximumEntries: 32, maximumBytes: 256 * 1024 * 1024 },
    activeLoupe: { maximumEntries: 8, maximumBytes: 512 * 1024 * 1024 },
    export: { maximumEntries: 8, maximumBytes: 512 * 1024 * 1024 },
  },
  analysis: { maximumEntries: 64, maximumBytes: 64 * 1024 * 1024 },
} as const satisfies DevelopCacheBudgets;

export type CacheKeyMaterialResult =
  | { readonly kind: "key"; readonly material: string; readonly byteLength: number }
  | { readonly kind: "too-large"; readonly byteLength: number }
  | { readonly kind: "invalid"; readonly reason: string };

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cache keys require finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  throw new Error("Cache key contains an unsupported value.");
}

function validBudget(budget: CacheBudget): boolean {
  return Number.isSafeInteger(budget.maximumEntries) &&
    budget.maximumEntries >= 1 &&
    budget.maximumEntries <= MAX_CACHE_ENTRIES &&
    Number.isSafeInteger(budget.maximumBytes) &&
    budget.maximumBytes >= 1 &&
    budget.maximumBytes <= MAX_CACHE_BUDGET_BYTES;
}

export function validateDevelopCacheBudgets(budgets: DevelopCacheBudgets): string | null {
  const entries = [
    budgets.decodedSource,
    budgets.plans,
    budgets.frames.grid,
    budgets.frames.fit,
    budgets.frames.activeLoupe,
    budgets.frames.export,
    budgets.analysis,
  ];
  return entries.every(validBudget)
    ? null
    : "Develop cache budgets are outside their entry or byte limits.";
}

export function cacheKeyMaterial(key: DevelopCacheKey): CacheKeyMaterialResult {
  try {
    const material = stableJson(key);
    const byteLength = new TextEncoder().encode(material).byteLength;
    return byteLength <= MAX_CACHE_KEY_BYTES
      ? { kind: "key", material, byteLength }
      : { kind: "too-large", byteLength };
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : "Cache key is invalid.",
    };
  }
}

export function planCacheKey(identity: RenderPlanIdentityInputs): PlanCacheKey {
  return { kind: "render-plan", identity };
}

export function frameClassForPlan(plan: RenderPlanIdentityInputs): FrameCacheClass {
  switch (plan.qualityAndDimensions.kind) {
    case "grid": return "grid";
    case "fit": return "fit";
    case "loupe": return "active-loupe";
    case "export": return "export";
    default: {
      const exhaustive: never = plan.qualityAndDimensions;
      return exhaustive;
    }
  }
}
