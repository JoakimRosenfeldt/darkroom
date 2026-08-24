import {
  parseAssetId,
  parseCatalogId,
  type CatalogId,
} from "../lib/catalog/ids.ts";
import {
  parseCatalogLiveApplyResult,
  parseCatalogLiveQueryResult,
  type CatalogLiveApplyInput,
  type CatalogLiveFingerprintTransition,
  type CatalogLiveQueryInput,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import type { FileObservation } from "../lib/import/domain.ts";
import {
  fingerprintNoFollowFile,
  type FingerprintResult,
} from "./catalog-fingerprint-service.ts";
import {
  NativeAssetAccess,
  type NativeAssetLocation,
} from "./native-asset-access.ts";
import type {
  FingerprintBackfillAsset,
  FingerprintBackfillCatalogPort,
  FingerprintBackfillCatalogUpdate,
  FingerprintBackfillHasher,
} from "./catalog-fingerprint-backfill-service.ts";

export interface FingerprintBackfillWorkerPort {
  readonly liveQuery: (input: CatalogLiveQueryInput) => Promise<unknown>;
  readonly liveApply: (input: CatalogLiveApplyInput) => Promise<unknown>;
}

export interface FingerprintBackfillNativeResolver {
  readonly resolve: (asset: FingerprintBackfillAsset) => Promise<NativeAssetLocation>;
}

export interface FingerprintBackfillPathAccess {
  readonly resolvePath: (location: NativeAssetLocation) => Promise<string>;
}

export interface CatalogFingerprintBackfillAdapterOptions {
  readonly pathAccess?: FingerprintBackfillPathAccess;
  readonly maxRevisionRetries?: number;
}

const DEFAULT_REVISION_RETRIES = 3;
const MAX_REVISION_RETRIES = 8;

function digest(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function statEqual(left: FileObservation, right: NonNullable<FingerprintBackfillAsset["observation"]>): boolean {
  return left.size === right.byteLength &&
    left.modifiedAt === right.modifiedAt &&
    (left.localFileId === null || right.localFileId === null || left.localFileId === right.localFileId);
}

function assertAssetBelongsToCatalog(asset: FingerprintBackfillAsset, catalogId: CatalogId): void {
  if (asset.catalogId !== catalogId) throw new Error("Fingerprint asset belongs to another catalog.");
  if (asset.health !== "present" || asset.observation === null) {
    throw new Error("Only present assets with observations can be fingerprinted.");
  }
}

function assertLocationMatches(asset: FingerprintBackfillAsset, location: NativeAssetLocation): void {
  if (
    location.catalogId !== asset.catalogId ||
    location.assetId !== asset.assetId ||
    location.rootId !== asset.rootId ||
    location.relativePath !== asset.relativePath
  ) {
    throw new Error("Native fingerprint location does not match the catalog asset.");
  }
}

function fileObservationFromCatalog(
  observation: NonNullable<FingerprintBackfillAsset["observation"]> | null,
): FileObservation | null {
  if (observation === null || observation.byteLength === null || observation.modifiedAt === null) return null;
  return {
    size: observation.byteLength,
    modifiedAt: observation.modifiedAt,
    localFileId: observation.localFileId,
    observedAt: observation.observedAt,
  };
}

function transitionFor(
  update: FingerprintBackfillCatalogUpdate,
  asset: CatalogLiveState["assets"][number],
): CatalogLiveFingerprintTransition {
  const current = fileObservationFromCatalog(asset.observation);
  const resultObservation = update.observation;
  if (update.status === "valid") {
    if (update.sha256 === null || resultObservation === null || current === null ||
      !statEqual(resultObservation, asset.observation!)) {
      throw new Error("Fingerprint source changed before catalog publication.");
    }
    return {
      assetId: update.assetId,
      status: "valid",
      sha256: update.sha256,
      observedAt: current.observedAt,
      observedByteLength: current.size,
      observedModifiedAt: current.modifiedAt,
      localFileId: current.localFileId,
    };
  }
  const proof = current ?? resultObservation;
  return {
    assetId: update.assetId,
    status: update.status,
    sha256: null,
    observedAt: proof?.observedAt ?? null,
    observedByteLength: proof?.size ?? null,
    observedModifiedAt: proof?.modifiedAt ?? null,
    localFileId: proof?.localFileId ?? null,
  };
}

function sameTransition(
  asset: CatalogLiveState["assets"][number],
  transition: CatalogLiveFingerprintTransition,
): boolean {
  return asset.fingerprintStatus === transition.status &&
    asset.fingerprintSha256 === transition.sha256 &&
    asset.fingerprintObservedAt === transition.observedAt &&
    asset.fingerprintObservedByteLength === transition.observedByteLength &&
    asset.fingerprintObservedModifiedAt === transition.observedModifiedAt &&
    asset.fingerprintLocalFileId === transition.localFileId;
}

function isRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /revision(?: [^.]*)? stale|stale[^.]*revision|revision conflict/i.test(error.message);
}

function sanitizeFingerprintResult(result: FingerprintResult): FingerprintResult {
  if (result.reason === null) return result;
  switch (result.status) {
    case "stale":
      return { ...result, reason: "File changed while it was being fingerprinted." };
    case "not-fully-checked":
      return { ...result, reason: "File could not be fully checked." };
    case "failed":
      return { ...result, reason: "Fingerprint failed." };
    case "valid":
    case "cancelled":
      return { ...result, reason: null };
  }
}

function validateRetries(value: number | undefined): number {
  const retries = value ?? DEFAULT_REVISION_RETRIES;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > MAX_REVISION_RETRIES) {
    throw new Error("Fingerprint catalog revision retry count is invalid.");
  }
  return retries;
}

export class CatalogFingerprintBackfillAdapter implements FingerprintBackfillCatalogPort, FingerprintBackfillHasher {
  private readonly catalogId: CatalogId;
  private readonly worker: FingerprintBackfillWorkerPort;
  private readonly resolver: FingerprintBackfillNativeResolver;
  private readonly pathAccess: FingerprintBackfillPathAccess;
  private readonly maxRevisionRetries: number;

  public constructor(
    catalogId: CatalogId,
    worker: FingerprintBackfillWorkerPort,
    resolver: FingerprintBackfillNativeResolver,
    options: CatalogFingerprintBackfillAdapterOptions = {},
  ) {
    this.catalogId = parseCatalogId(catalogId);
    this.worker = worker;
    this.resolver = resolver;
    this.pathAccess = options.pathAccess ?? new NativeAssetAccess();
    this.maxRevisionRetries = validateRetries(options.maxRevisionRetries);
  }

  public async fingerprint(
    asset: FingerprintBackfillAsset,
    isCancelled: () => boolean,
  ): Promise<FingerprintResult> {
    assertAssetBelongsToCatalog(asset, this.catalogId);
    const location = await this.resolver.resolve(asset);
    assertLocationMatches(asset, location);
    const filePath = await this.pathAccess.resolvePath(location);
    const result = await fingerprintNoFollowFile(filePath, isCancelled);
    return sanitizeFingerprintResult(result);
  }

  public async applyFingerprint(update: FingerprintBackfillCatalogUpdate): Promise<void> {
    const assetId = parseAssetId(update.assetId);
    const sha256 = digest(update.sha256, "Fingerprint catalog digest");
    if (update.status === "valid" && sha256 === null) throw new Error("Valid fingerprint needs a digest.");
    if (update.status !== "valid" && sha256 !== null) throw new Error("Non-valid fingerprint cannot have a digest.");
    for (let attempt = 0; attempt <= this.maxRevisionRetries; attempt += 1) {
      try {
        const state = parseCatalogLiveQueryResult(await this.worker.liveQuery({
          catalogId: this.catalogId,
          expectedRevision: null,
        }));
        const asset = state.assets.find((candidate) => candidate.assetId === assetId);
        if (asset === undefined) throw new Error("Fingerprint catalog asset does not exist.");
        if (asset.health !== "present" || asset.observation === null) {
          throw new Error("Fingerprint catalog asset is no longer present.");
        }
        const transition = transitionFor({ ...update, assetId, sha256 }, asset);
        if (sameTransition(asset, transition)) return;
        const result = parseCatalogLiveApplyResult(await this.worker.liveApply({
          catalogId: this.catalogId,
          expectedRevision: state.catalog.revision,
          mutations: [{ kind: "fingerprint-set", fingerprint: transition }],
        }));
        if (result.catalogId !== this.catalogId) throw new Error("Fingerprint catalog apply identity mismatched.");
        return;
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === this.maxRevisionRetries) throw error;
      }
    }
    throw new Error("Fingerprint catalog revision retry loop failed.");
  }
}

export function createCatalogFingerprintBackfillAdapter(
  catalogId: CatalogId,
  worker: FingerprintBackfillWorkerPort,
  resolver: FingerprintBackfillNativeResolver,
  options?: CatalogFingerprintBackfillAdapterOptions,
): CatalogFingerprintBackfillAdapter {
  return new CatalogFingerprintBackfillAdapter(catalogId, worker, resolver, options);
}
