import {
  parseAssetId,
  parseCatalogId,
  parseOperationId,
  type AssetId,
  type CatalogId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import type {
  CatalogV3AssetHealth,
  CatalogV3AssetSnapshot,
  CatalogV3FingerprintStatus,
} from "../lib/catalog/v3.ts";
import {
  parseFileObservation,
  sameFileObservation,
  type FileObservation,
} from "../lib/import/domain.ts";
import type {
  FingerprintResult,
  FingerprintStatus,
} from "./catalog-fingerprint-service.ts";

export const FINGERPRINT_BACKFILL_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_FINGERPRINT_BACKFILL_CONCURRENCY = 2;
const MAX_FINGERPRINT_BACKFILL_CONCURRENCY = 16;
const MAX_FINGERPRINT_BACKFILL_ITEMS = 100_000;

export type FingerprintBackfillRunState =
  | "planned"
  | "running"
  | "completed"
  | "cancelled";

export type FingerprintBackfillItemState =
  | "pending"
  | "indexed"
  | "stale"
  | "failed"
  | "unchecked";

/**
 * This is a renderer-safe subset of a live asset snapshot. Native paths stay
 * inside the hasher adapter that resolves the asset ID and relative path.
 */
export type FingerprintBackfillAsset = Pick<
  CatalogV3AssetSnapshot,
  | "catalogId"
  | "assetId"
  | "rootId"
  | "relativePath"
  | "observation"
  | "health"
  | "fingerprintStatus"
  | "fingerprintSha256"
  | "fingerprintObservedAt"
  | "fingerprintObservedByteLength"
  | "fingerprintObservedModifiedAt"
  | "fingerprintLocalFileId"
>;

export interface FingerprintBackfillItemSnapshot {
  readonly assetId: AssetId;
  readonly state: FingerprintBackfillItemState;
  readonly sha256: string | null;
  readonly observation: FileObservation | null;
  readonly reason: string | null;
}

export interface FingerprintBackfillProgress {
  readonly total: number;
  readonly indexed: number;
  readonly stale: number;
  readonly remaining: number;
  readonly processed: number;
  readonly failed: number;
  readonly unchecked: number;
}

export interface FingerprintBackfillSnapshot {
  readonly version: typeof FINGERPRINT_BACKFILL_SNAPSHOT_VERSION;
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly state: FingerprintBackfillRunState;
  readonly items: readonly FingerprintBackfillItemSnapshot[];
  readonly progress: FingerprintBackfillProgress;
  readonly updatedAt: number;
}

export interface FingerprintBackfillCatalogUpdate {
  readonly assetId: AssetId;
  readonly status: "valid" | "stale" | "failed";
  readonly sha256: string | null;
  readonly observation: FileObservation | null;
}

/**
 * The persistence adapter owns atomic durable storage. Its load boundary is
 * unknown on purpose so malformed or tampered snapshots cannot enter the
 * service unchecked.
 */
export interface FingerprintBackfillPersistence {
  readonly load: (operationId: OperationId) => Promise<unknown | null>;
  readonly save: (snapshot: FingerprintBackfillSnapshot) => Promise<void>;
}

export interface FingerprintBackfillCatalogPort {
  readonly applyFingerprint: (update: FingerprintBackfillCatalogUpdate) => Promise<void>;
}

/**
 * The adapter resolves the asset through main-owned native access and must
 * use a no-follow opened handle with pre/post stat validation. No native path
 * crosses this interface.
 */
export interface FingerprintBackfillHasher {
  readonly fingerprint: (
    asset: FingerprintBackfillAsset,
    isCancelled: () => boolean,
  ) => Promise<unknown>;
}

export interface FingerprintBackfillProgressEvent extends FingerprintBackfillProgress {
  readonly operationId: OperationId;
  readonly state: FingerprintBackfillRunState;
}

export interface FingerprintBackfillItemResult {
  readonly assetId: AssetId;
  readonly status: Exclude<FingerprintBackfillItemState, "pending">;
  readonly sha256: string | null;
  readonly observation: FileObservation | null;
  readonly reason: string | null;
}

export interface FingerprintBackfillExecution extends FingerprintBackfillProgress {
  readonly operationId: OperationId;
  readonly state: FingerprintBackfillRunState;
  readonly cancelled: boolean;
  readonly results: readonly FingerprintBackfillItemResult[];
}

export interface FingerprintBackfillRunInput {
  readonly operationId: OperationId;
  readonly catalogId: CatalogId;
  readonly assets: readonly FingerprintBackfillAsset[];
  readonly concurrency?: number;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (progress: FingerprintBackfillProgressEvent) => void;
  readonly onResult?: (result: FingerprintBackfillItemResult) => void;
  readonly now?: () => number;
}

export interface FingerprintBackfillResumeInput extends Omit<FingerprintBackfillRunInput, "operationId"> {
  readonly sourceOperationId: OperationId;
  readonly operationId: OperationId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return stringValue(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid.`);
  }
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`${label} is invalid.`);
  return match;
}

function parseSnapshotProgress(value: unknown): FingerprintBackfillProgress {
  if (!isRecord(value)) throw new Error("Fingerprint backfill progress is invalid.");
  const result = {
    total: nonNegativeInteger(value.total, "Fingerprint backfill total"),
    indexed: nonNegativeInteger(value.indexed, "Fingerprint backfill indexed"),
    stale: nonNegativeInteger(value.stale, "Fingerprint backfill stale"),
    remaining: nonNegativeInteger(value.remaining, "Fingerprint backfill remaining"),
    processed: nonNegativeInteger(value.processed, "Fingerprint backfill processed"),
    failed: nonNegativeInteger(value.failed, "Fingerprint backfill failed"),
    unchecked: nonNegativeInteger(value.unchecked, "Fingerprint backfill unchecked"),
  } satisfies FingerprintBackfillProgress;
  if (result.processed + result.remaining !== result.total) {
    throw new Error("Fingerprint backfill progress coverage is inconsistent.");
  }
  if (result.indexed + result.stale + result.failed + result.unchecked !== result.processed) {
    throw new Error("Fingerprint backfill progress status counts are inconsistent.");
  }
  return result;
}

function parseSnapshotItem(value: unknown): FingerprintBackfillItemSnapshot {
  if (!isRecord(value)) throw new Error("Fingerprint backfill item is invalid.");
  const state = enumValue(value.state, "Fingerprint backfill item state", [
    "pending",
    "indexed",
    "stale",
    "failed",
    "unchecked",
  ] as const);
  const sha256 = value.sha256 === null ? null : digest(value.sha256, "Fingerprint backfill item digest");
  const observation = value.observation === null ? null : parseFileObservation(value.observation);
  if (state === "indexed" && (sha256 === null || observation === null)) {
    throw new Error("Indexed fingerprint backfill item needs a digest and observation.");
  }
  if (state !== "indexed" && sha256 !== null) {
    throw new Error("Non-indexed fingerprint backfill item cannot have a digest.");
  }
  return {
    assetId: parseAssetId(value.assetId),
    state,
    sha256,
    observation,
    reason: nullableString(value.reason, "Fingerprint backfill item reason"),
  };
}

function countItems(items: readonly FingerprintBackfillItemSnapshot[]): FingerprintBackfillProgress {
  let indexed = 0;
  let stale = 0;
  let failed = 0;
  let unchecked = 0;
  let remaining = 0;
  for (const item of items) {
    switch (item.state) {
      case "pending": remaining += 1; break;
      case "indexed": indexed += 1; break;
      case "stale": stale += 1; break;
      case "failed": failed += 1; break;
      case "unchecked": unchecked += 1; break;
    }
  }
  const total = items.length;
  return {
    total,
    indexed,
    stale,
    remaining,
    processed: total - remaining,
    failed,
    unchecked,
  };
}

function assertProgressMatchesItems(
  progress: FingerprintBackfillProgress,
  items: readonly FingerprintBackfillItemSnapshot[],
): void {
  const expected = countItems(items);
  if (JSON.stringify(progress) !== JSON.stringify(expected)) {
    throw new Error("Fingerprint backfill progress does not match its items.");
  }
}

export function parseFingerprintBackfillSnapshot(value: unknown): FingerprintBackfillSnapshot {
  if (!isRecord(value)) throw new Error("Fingerprint backfill snapshot is invalid.");
  if (value.version !== FINGERPRINT_BACKFILL_SNAPSHOT_VERSION) {
    throw new Error("Fingerprint backfill snapshot version is invalid.");
  }
  if (!Array.isArray(value.items) || value.items.length > MAX_FINGERPRINT_BACKFILL_ITEMS) {
    throw new Error("Fingerprint backfill snapshot items are invalid.");
  }
  const items = value.items.map(parseSnapshotItem);
  const itemIds = new Set<AssetId>();
  for (const item of items) {
    if (itemIds.has(item.assetId)) throw new Error("Fingerprint backfill snapshot has duplicate assets.");
    itemIds.add(item.assetId);
  }
  const progress = parseSnapshotProgress(value.progress);
  assertProgressMatchesItems(progress, items);
  return {
    version: FINGERPRINT_BACKFILL_SNAPSHOT_VERSION,
    operationId: parseOperationId(value.operationId),
    catalogId: parseCatalogId(value.catalogId),
    state: enumValue(value.state, "Fingerprint backfill snapshot state", [
      "planned",
      "running",
      "completed",
      "cancelled",
    ] as const),
    items,
    progress,
    updatedAt: finiteNumber(value.updatedAt, "Fingerprint backfill snapshot updatedAt"),
  };
}

function observationFromAsset(asset: FingerprintBackfillAsset): FileObservation | null {
  if (asset.observation === null || asset.observation.byteLength === null || asset.observation.modifiedAt === null) {
    return null;
  }
  return {
    size: asset.observation.byteLength,
    modifiedAt: asset.observation.modifiedAt,
    localFileId: asset.observation.localFileId,
    observedAt: asset.observation.observedAt,
  };
}

function cachedProofMatches(asset: FingerprintBackfillAsset): boolean {
  const observation = observationFromAsset(asset);
  return asset.health === "present" &&
    asset.fingerprintStatus === "valid" &&
    asset.fingerprintSha256 !== null && /^[0-9a-f]{64}$/.test(asset.fingerprintSha256) &&
    observation !== null &&
    asset.fingerprintObservedAt === observation.observedAt &&
    asset.fingerprintObservedByteLength === observation.size &&
    asset.fingerprintObservedModifiedAt === observation.modifiedAt &&
    asset.fingerprintLocalFileId === observation.localFileId;
}

function initialItem(asset: FingerprintBackfillAsset): FingerprintBackfillItemSnapshot {
  if (cachedProofMatches(asset)) {
    const observation = observationFromAsset(asset);
    if (observation === null || asset.fingerprintSha256 === null) {
      throw new Error("Cached fingerprint proof unexpectedly disappeared.");
    }
    return {
      assetId: asset.assetId,
      state: "indexed",
      sha256: asset.fingerprintSha256,
      observation,
      reason: null,
    };
  }
  return {
    assetId: asset.assetId,
    state: "pending",
    sha256: null,
    observation: null,
    reason: null,
  };
}

function eligibleAssets(
  catalogId: CatalogId,
  assets: readonly FingerprintBackfillAsset[],
): readonly FingerprintBackfillAsset[] {
  if (assets.length > MAX_FINGERPRINT_BACKFILL_ITEMS) {
    throw new Error("Too many fingerprint backfill assets.");
  }
  const seen = new Set<AssetId>();
  const eligible: FingerprintBackfillAsset[] = [];
  for (const asset of assets) {
    if (asset.catalogId !== catalogId) throw new Error("Fingerprint asset belongs to another catalog.");
    if (seen.has(asset.assetId)) throw new Error("Fingerprint backfill has duplicate assets.");
    seen.add(asset.assetId);
    if (asset.health === "present" && asset.observation !== null) eligible.push(asset);
  }
  return [...eligible].sort((left, right) => left.assetId.localeCompare(right.assetId));
}

function initialSnapshot(input: FingerprintBackfillRunInput): FingerprintBackfillSnapshot {
  const items = eligibleAssets(input.catalogId, input.assets).map(initialItem);
  const progress = countItems(items);
  return {
    version: FINGERPRINT_BACKFILL_SNAPSHOT_VERSION,
    operationId: input.operationId,
    catalogId: input.catalogId,
    state: "planned",
    items,
    progress,
    updatedAt: (input.now ?? Date.now)(),
  };
}

function sameAssetStat(left: FileObservation | null, right: FileObservation | null): boolean {
  return left !== null && right !== null && sameFileObservation(left, right);
}

function preparedSnapshot(
  snapshot: FingerprintBackfillSnapshot,
  input: FingerprintBackfillRunInput,
): FingerprintBackfillSnapshot {
  const assets = eligibleAssets(input.catalogId, input.assets);
  const previous = new Map(snapshot.items.map((item) => [item.assetId, item]));
  const items = assets.map((asset) => {
    const prior = previous.get(asset.assetId);
    if (prior?.state === "indexed" && sameAssetStat(prior.observation, observationFromAsset(asset))) {
      return prior;
    }
    return initialItem(asset);
  });
  const progress = countItems(items);
  return {
    ...snapshot,
    catalogId: input.catalogId,
    items,
    progress,
    updatedAt: (input.now ?? Date.now)(),
  };
}

function retrySnapshot(
  source: FingerprintBackfillSnapshot,
  input: FingerprintBackfillRunInput,
): FingerprintBackfillSnapshot {
  const prepared = preparedSnapshot({ ...source, operationId: input.operationId }, input);
  const items = prepared.items.map((item): FingerprintBackfillItemSnapshot => {
    if (item.state === "indexed") return item;
    return { ...item, state: "pending", sha256: null, observation: null, reason: null };
  });
  return {
    ...prepared,
    operationId: input.operationId,
    state: "planned",
    items,
    progress: countItems(items),
    updatedAt: (input.now ?? Date.now)(),
  };
}

function parseFingerprintResult(value: unknown): FingerprintResult {
  if (!isRecord(value)) throw new Error("Fingerprint result is invalid.");
  const status = enumValue(value.status, "Fingerprint result status", [
    "valid",
    "stale",
    "not-fully-checked",
    "failed",
    "cancelled",
  ] as const) satisfies FingerprintStatus;
  const sha256 = value.sha256 === null ? null : digest(value.sha256, "Fingerprint result digest");
  const observation = value.observation === null ? null : parseFileObservation(value.observation);
  const reason = nullableString(value.reason, "Fingerprint result reason");
  if (status === "valid" && (sha256 === null || observation === null)) {
    throw new Error("Valid fingerprint result needs a digest and observation.");
  }
  if (status !== "valid" && sha256 !== null) {
    throw new Error("Non-valid fingerprint result cannot have a digest.");
  }
  if (status === "cancelled" && observation !== null) {
    throw new Error("Cancelled fingerprint result cannot have an observation.");
  }
  return { status, sha256, observation, reason };
}

function resultState(result: FingerprintResult): Exclude<FingerprintBackfillItemState, "pending" | "indexed"> {
  switch (result.status) {
    case "stale": return "stale";
    case "failed": return "failed";
    case "not-fully-checked": return "unchecked";
    case "cancelled": return "unchecked";
    case "valid": throw new Error("Valid fingerprints need the indexed result state.");
  }
}

function itemResult(
  assetId: AssetId,
  state: Exclude<FingerprintBackfillItemState, "pending">,
  sha256: string | null,
  observation: FileObservation | null,
  reason: string | null,
): FingerprintBackfillItemResult {
  return { assetId, status: state, sha256, observation, reason };
}

function isTerminalItemState(
  state: FingerprintBackfillItemState,
): state is Exclude<FingerprintBackfillItemState, "pending"> {
  return state !== "pending";
}

function executionFromSnapshot(
  snapshot: FingerprintBackfillSnapshot,
  cancelled: boolean,
): FingerprintBackfillExecution {
  return {
    operationId: snapshot.operationId,
    state: snapshot.state,
    cancelled,
    ...snapshot.progress,
    results: snapshot.items
      .filter((item): item is FingerprintBackfillItemSnapshot & { readonly state: Exclude<FingerprintBackfillItemState, "pending" | "indexed"> } =>
        item.state !== "pending" && item.state !== "indexed")
      .map((item) => itemResult(item.assetId, item.state, item.sha256, item.observation, item.reason)),
  };
}

function validateConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_FINGERPRINT_BACKFILL_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_FINGERPRINT_BACKFILL_CONCURRENCY) {
    throw new Error("Fingerprint backfill concurrency is invalid.");
  }
  return concurrency;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class CatalogFingerprintBackfillService {
  private readonly persistence: FingerprintBackfillPersistence;
  private readonly catalog: FingerprintBackfillCatalogPort;
  private readonly hasher: FingerprintBackfillHasher;

  public constructor(
    persistence: FingerprintBackfillPersistence,
    catalog: FingerprintBackfillCatalogPort,
    hasher: FingerprintBackfillHasher,
  ) {
    this.persistence = persistence;
    this.catalog = catalog;
    this.hasher = hasher;
  }

  public async run(input: FingerprintBackfillRunInput): Promise<FingerprintBackfillExecution> {
    const concurrency = validateConcurrency(input.concurrency);
    let snapshot = await this.loadOrCreate(input);
    if (snapshot.state === "completed" || snapshot.state === "cancelled") {
      return executionFromSnapshot(snapshot, snapshot.state === "cancelled");
    }
    snapshot = preparedSnapshot(snapshot, input);
    await this.persistence.save(snapshot);
    return this.execute(input, concurrency, snapshot);
  }

  public async resume(input: FingerprintBackfillResumeInput): Promise<FingerprintBackfillExecution> {
    if (input.operationId === input.sourceOperationId) {
      throw new Error("Fingerprint backfill resume needs a new operation ID.");
    }
    const source = await this.persistence.load(parseOperationId(input.sourceOperationId));
    if (source === null) throw new Error("Fingerprint backfill source snapshot does not exist.");
    const parsed = parseFingerprintBackfillSnapshot(source);
    if (parsed.catalogId !== input.catalogId) throw new Error("Fingerprint backfill catalog does not match.");
    const snapshot = retrySnapshot(parsed, input);
    await this.persistence.save(snapshot);
    return this.execute(input, validateConcurrency(input.concurrency), snapshot);
  }

  private async loadOrCreate(input: FingerprintBackfillRunInput): Promise<FingerprintBackfillSnapshot> {
    const operationId = parseOperationId(input.operationId);
    const loaded = await this.persistence.load(operationId);
    if (loaded === null) return initialSnapshot(input);
    const snapshot = parseFingerprintBackfillSnapshot(loaded);
    if (snapshot.operationId !== operationId || snapshot.catalogId !== input.catalogId) {
      throw new Error("Fingerprint backfill snapshot identity does not match.");
    }
    return snapshot;
  }

  private async execute(
    input: FingerprintBackfillRunInput,
    concurrency: number,
    initial: FingerprintBackfillSnapshot,
  ): Promise<FingerprintBackfillExecution> {
    const now = input.now ?? Date.now;
    let snapshot: FingerprintBackfillSnapshot = {
      ...initial,
      state: "running",
      updatedAt: now(),
    };
    await this.persistence.save(snapshot);
    this.emitProgress(input, snapshot);
    if (snapshot.progress.remaining === 0) {
      snapshot = { ...snapshot, state: "completed", updatedAt: now() };
      await this.persistence.save(snapshot);
      this.emitProgress(input, snapshot);
      return executionFromSnapshot(snapshot, false);
    }

    const assets = new Map(eligibleAssets(input.catalogId, input.assets).map((asset) => [asset.assetId, asset]));
    const pending = snapshot.items.filter((item) => item.state === "pending");
    let next = 0;
    let cancelled = false;
    let fatalError: unknown = null;
    let mutationTail: Promise<void> = Promise.resolve();
    const results: FingerprintBackfillItemResult[] = [];

    const commit = async (
      item: FingerprintBackfillItemSnapshot,
      asset: FingerprintBackfillAsset,
      result: FingerprintResult,
    ): Promise<void> => {
      const nextMutation = mutationTail.then(async () => {
        if (fatalError !== null) throw fatalError;
        if (cancelled || input.isCancelled?.() === true) {
          cancelled = true;
          return;
        }
        let nextItem: FingerprintBackfillItemSnapshot;
        let update: FingerprintBackfillCatalogUpdate | null = null;
        if (result.status === "valid" && result.sha256 !== null && result.observation !== null) {
          const expected = observationFromAsset(asset);
          if (expected !== null && !sameFileObservation(expected, result.observation)) {
            nextItem = {
              ...item,
              state: "stale",
              sha256: null,
              observation: result.observation,
              reason: "Asset observation changed before fingerprint publication.",
            };
            update = {
              assetId: item.assetId,
              status: "stale",
              sha256: null,
              observation: result.observation,
            };
          } else {
            nextItem = {
              ...item,
              state: "indexed",
              sha256: result.sha256,
              observation: result.observation,
              reason: result.reason,
            };
            update = {
              assetId: item.assetId,
              status: "valid",
              sha256: result.sha256,
              observation: result.observation,
            };
          }
        } else if (result.status === "cancelled") {
          cancelled = true;
          return;
        } else {
          const state = resultState(result);
          nextItem = {
            ...item,
            state,
            sha256: null,
            observation: result.observation,
            reason: result.reason,
          };
          update = {
            assetId: item.assetId,
            status: state === "stale" ? "stale" : "failed",
            sha256: null,
            observation: result.observation,
          };
        }
        if (update === null) throw new Error("Fingerprint backfill update is missing.");
        await this.catalog.applyFingerprint(update);
        snapshot = {
          ...snapshot,
          state: "running",
          items: snapshot.items.map((candidate) => candidate.assetId === item.assetId ? nextItem : candidate),
          progress: countItems(snapshot.items.map((candidate) => candidate.assetId === item.assetId ? nextItem : candidate)),
          updatedAt: now(),
        };
        await this.persistence.save(snapshot);
        if (!isTerminalItemState(nextItem.state)) throw new Error("Fingerprint backfill item did not reach a terminal state.");
        const publicResult = itemResult(nextItem.assetId, nextItem.state, nextItem.sha256, nextItem.observation, nextItem.reason);
        results.push(publicResult);
        input.onResult?.(publicResult);
        this.emitProgress(input, snapshot);
      });
      mutationTail = nextMutation.catch((error: unknown) => {
        fatalError ??= error;
      });
      await nextMutation;
    };

    const worker = async (): Promise<void> => {
      while (true) {
        if (cancelled || input.isCancelled?.() === true || fatalError !== null) {
          if (input.isCancelled?.() === true) cancelled = true;
          return;
        }
        const index = next;
        next += 1;
        const item = pending[index];
        if (item === undefined) return;
        const asset = assets.get(item.assetId);
        if (asset === undefined) throw new Error("Fingerprint backfill asset disappeared.");
        let result: FingerprintResult;
        try {
          result = parseFingerprintResult(await this.hasher.fingerprint(
            asset,
            () => cancelled || input.isCancelled?.() === true,
          ));
        } catch (error) {
          result = {
            status: "failed",
            sha256: null,
            observation: null,
            reason: error instanceof Error ? error.message : "Fingerprint adapter failed.",
          };
        }
        if (result.status === "cancelled" || input.isCancelled?.() === true || cancelled) {
          cancelled = true;
          return;
        }
        await commit(item, asset, result);
        await yieldToEventLoop();
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await mutationTail;
    if (fatalError !== null) throw fatalError;
    if (cancelled || input.isCancelled?.() === true) {
      cancelled = true;
      snapshot = { ...snapshot, state: "cancelled", updatedAt: now() };
      await this.persistence.save(snapshot);
      this.emitProgress(input, snapshot);
      return {
        ...executionFromSnapshot(snapshot, true),
        results,
      };
    }
    snapshot = { ...snapshot, state: "completed", updatedAt: now() };
    await this.persistence.save(snapshot);
    this.emitProgress(input, snapshot);
    return {
      ...executionFromSnapshot(snapshot, false),
      results,
    };
  }

  private emitProgress(input: FingerprintBackfillRunInput, snapshot: FingerprintBackfillSnapshot): void {
    input.onProgress?.({
      operationId: snapshot.operationId,
      state: snapshot.state,
      ...snapshot.progress,
    });
  }
}

export type FingerprintBackfillCatalogStatus = CatalogV3FingerprintStatus;
export type FingerprintBackfillHealth = CatalogV3AssetHealth;
