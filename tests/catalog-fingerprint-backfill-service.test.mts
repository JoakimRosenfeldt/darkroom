import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAssetId,
  createCatalogId,
  createOperationId,
  createRootId,
  type AssetId,
  type CatalogId,
  type OperationId,
} from "../lib/catalog/ids.ts";
import type { CatalogV3FingerprintStatus, CatalogV3Observation } from "../lib/catalog/v3.ts";
import {
  fingerprintNoFollowFile,
  observeNoFollowFile,
  type FingerprintResult,
} from "../electron/catalog-fingerprint-service.ts";
import {
  CatalogFingerprintBackfillService,
  type FingerprintBackfillAsset,
  type FingerprintBackfillCatalogPort,
  type FingerprintBackfillCatalogUpdate,
  type FingerprintBackfillHasher,
  type FingerprintBackfillPersistence,
  type FingerprintBackfillProgressEvent,
  type FingerprintBackfillSnapshot,
} from "../electron/catalog-fingerprint-backfill-service.ts";

function observation(size: number, observedAt = 1): CatalogV3Observation {
  return { byteLength: size, modifiedAt: 10, observedAt, localFileId: "device:file" };
}

function asset(
  catalogId: CatalogId,
  assetId: AssetId,
  status: CatalogV3FingerprintStatus = "missing",
  size = 4,
): FingerprintBackfillAsset {
  return {
    catalogId,
    assetId,
    rootId: createRootId(),
    relativePath: `${assetId}.jpg`,
    observation: observation(size),
    health: "present",
    fingerprintStatus: status,
    fingerprintSha256: null,
    fingerprintObservedAt: null,
    fingerprintObservedByteLength: null,
    fingerprintObservedModifiedAt: null,
    fingerprintLocalFileId: null,
  };
}

function validResult(item: FingerprintBackfillAsset, sha256 = "a".repeat(64)): FingerprintResult {
  const sourceObservation = item.observation;
  if (sourceObservation === null || sourceObservation.byteLength === null || sourceObservation.modifiedAt === null) {
    throw new Error("Test asset observation is incomplete.");
  }
  return {
    status: "valid",
    sha256,
    observation: {
      size: sourceObservation.byteLength,
      modifiedAt: sourceObservation.modifiedAt,
      localFileId: sourceObservation.localFileId,
      observedAt: sourceObservation.observedAt + 1,
    },
    reason: null,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class MemoryPersistence implements FingerprintBackfillPersistence {
  public readonly snapshots = new Map<OperationId, FingerprintBackfillSnapshot>();

  public async load(operationId: OperationId): Promise<unknown | null> {
    const snapshot = this.snapshots.get(operationId);
    return snapshot === undefined ? null : structuredClone(snapshot);
  }

  public async save(snapshot: FingerprintBackfillSnapshot): Promise<void> {
    this.snapshots.set(snapshot.operationId, structuredClone(snapshot));
  }
}

class MemoryCatalog implements FingerprintBackfillCatalogPort {
  public readonly updates: FingerprintBackfillCatalogUpdate[] = [];

  public async applyFingerprint(update: FingerprintBackfillCatalogUpdate): Promise<void> {
    this.updates.push(structuredClone(update));
  }
}

function fakeHasher(
  handler: (asset: FingerprintBackfillAsset, isCancelled: () => boolean) => Promise<unknown>,
): FingerprintBackfillHasher {
  return { fingerprint: handler };
}

test("fresh backfill hashes present assets and exposes exact path-free counts", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-fingerprint-backfill-"));
  try {
    const catalogId = createCatalogId();
    const firstId = createAssetId();
    const secondId = createAssetId();
    const firstPath = path.join(directory, "first.jpg");
    const secondPath = path.join(directory, "second.jpg");
    await fsp.writeFile(firstPath, "first");
    await fsp.writeFile(secondPath, "second");
    const firstObservation = await observeNoFollowFile(firstPath);
    const secondObservation = await observeNoFollowFile(secondPath);
    const assets = [
      { ...asset(catalogId, firstId, "missing", firstObservation.size), observation: { byteLength: firstObservation.size, modifiedAt: firstObservation.modifiedAt, localFileId: firstObservation.localFileId, observedAt: firstObservation.observedAt } },
      { ...asset(catalogId, secondId, "stale", secondObservation.size), observation: { byteLength: secondObservation.size, modifiedAt: secondObservation.modifiedAt, localFileId: secondObservation.localFileId, observedAt: secondObservation.observedAt } },
      { ...asset(catalogId, createAssetId(), "missing"), health: "missing" as const },
    ] satisfies readonly FingerprintBackfillAsset[];
    const paths = new Map([[firstId, firstPath], [secondId, secondPath]]);
    const persistence = new MemoryPersistence();
    const catalog = new MemoryCatalog();
    const service = new CatalogFingerprintBackfillService(
      persistence,
      catalog,
      fakeHasher(async (item, isCancelled) => fingerprintNoFollowFile(paths.get(item.assetId)!, isCancelled)),
    );
    const progress: FingerprintBackfillProgressEvent[] = [];
    const execution = await service.run({
      operationId: createOperationId(),
      catalogId,
      assets,
      concurrency: 1,
      onProgress: (event) => progress.push(event),
    });
    assert.equal(execution.state, "completed");
    assert.equal(execution.total, 2);
    assert.equal(execution.indexed, 2);
    assert.equal(execution.remaining, 0);
    assert.equal(execution.failed, 0);
    assert.equal(execution.unchecked, 0);
    assert.equal(catalog.updates.length, 2);
    assert.ok(catalog.updates.every((update) => update.status === "valid" && update.sha256 !== null));
    assert.equal("filePath" in execution, false);
    assert.equal(progress.at(-1)?.state, "completed");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("valid cached proof is reused only when size, mtime, and local identity still match", async () => {
  const catalogId = createCatalogId();
  const cachedId = createAssetId();
  const changedId = createAssetId();
  const cachedObservation = observation(8, 4);
  const cached: FingerprintBackfillAsset = {
    ...asset(catalogId, cachedId, "valid", 8),
    observation: cachedObservation,
    fingerprintStatus: "valid",
    fingerprintSha256: "f".repeat(64),
    fingerprintObservedAt: cachedObservation.observedAt,
    fingerprintObservedByteLength: cachedObservation.byteLength,
    fingerprintObservedModifiedAt: cachedObservation.modifiedAt,
    fingerprintLocalFileId: cachedObservation.localFileId,
  };
  const changed: FingerprintBackfillAsset = {
    ...asset(catalogId, changedId, "valid", 9),
    fingerprintStatus: "valid",
    fingerprintSha256: "e".repeat(64),
    fingerprintObservedAt: 1,
    fingerprintObservedByteLength: 8,
    fingerprintObservedModifiedAt: 10,
    fingerprintLocalFileId: "device:file",
  };
  const calls: AssetId[] = [];
  const service = new CatalogFingerprintBackfillService(
    new MemoryPersistence(),
    new MemoryCatalog(),
    fakeHasher(async (item) => {
      calls.push(item.assetId);
      return validResult(item, "1".repeat(64));
    }),
  );
  const execution = await service.run({
    operationId: createOperationId(),
    catalogId,
    assets: [cached, changed],
    concurrency: 1,
  });
  assert.equal(execution.indexed, 2);
  assert.deepEqual(calls, [changedId]);
});

test("backfill concurrency is bounded by its configured worker count", async () => {
  const catalogId = createCatalogId();
  const assets = Array.from({ length: 7 }, () => asset(catalogId, createAssetId()));
  const persistence = new MemoryPersistence();
  const catalog = new MemoryCatalog();
  let active = 0;
  let maximum = 0;
  const service = new CatalogFingerprintBackfillService(
    persistence,
    catalog,
    fakeHasher(async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(3);
      active -= 1;
      return validResult(item);
    }),
  );
  const execution = await service.run({ operationId: createOperationId(), catalogId, assets, concurrency: 3 });
  assert.equal(execution.indexed, assets.length);
  assert.ok(maximum <= 3);
  assert.ok(maximum > 1);
});

test("cancelled run is terminal and a new operation resumes pending assets", async () => {
  const catalogId = createCatalogId();
  const assets = Array.from({ length: 3 }, () => asset(catalogId, createAssetId()));
  const persistence = new MemoryPersistence();
  const catalog = new MemoryCatalog();
  let cancel = false;
  const calls: AssetId[] = [];
  const hasher = fakeHasher(async (item) => {
    calls.push(item.assetId);
    return validResult(item);
  });
  const firstService = new CatalogFingerprintBackfillService(persistence, catalog, hasher);
  const firstOperationId = createOperationId();
  const first = await firstService.run({
    operationId: firstOperationId,
    catalogId,
    assets,
    concurrency: 1,
    isCancelled: () => cancel,
    onResult: () => { cancel = true; },
  });
  assert.equal(first.state, "cancelled");
  assert.equal(first.indexed, 1);
  assert.equal(first.remaining, 2);
  assert.equal(persistence.snapshots.get(firstOperationId)?.state, "cancelled");

  const resumed = await firstService.resume({
    sourceOperationId: firstOperationId,
    operationId: createOperationId(),
    catalogId,
    assets,
    concurrency: 1,
    isCancelled: () => false,
  });
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.indexed, 3);
  assert.equal(resumed.remaining, 0);
  const orderedIds = [...assets].map((item) => item.assetId).sort();
  assert.deepEqual(calls.slice(0, 1), [orderedIds[0]]);
  assert.equal(calls.length, 3);
});

test("source change during hashing becomes stale and never publishes a digest", async () => {
  const catalogId = createCatalogId();
  const item = asset(catalogId, createAssetId());
  const changed = validResult(item);
  if (changed.observation === null) throw new Error("Test result observation is missing.");
  const result: FingerprintResult = {
    ...changed,
    observation: { ...changed.observation, size: changed.observation.size + 1 },
  };
  const persistence = new MemoryPersistence();
  const catalog = new MemoryCatalog();
  const service = new CatalogFingerprintBackfillService(
    persistence,
    catalog,
    fakeHasher(async () => result),
  );
  const execution = await service.run({ operationId: createOperationId(), catalogId, assets: [item] });
  assert.equal(execution.state, "completed");
  assert.equal(execution.indexed, 0);
  assert.equal(execution.stale, 1);
  assert.equal(execution.results[0]?.sha256, null);
  assert.deepEqual(catalog.updates[0], {
    assetId: item.assetId,
    status: "stale",
    sha256: null,
    observation: result.observation,
  });
});

test("failed and unreadable assets remain retryable with honest counts", async () => {
  const catalogId = createCatalogId();
  const unreadable = asset(catalogId, createAssetId());
  const failed = asset(catalogId, createAssetId());
  const assets = [unreadable, failed];
  const persistence = new MemoryPersistence();
  const catalog = new MemoryCatalog();
  let retry = false;
  const service = new CatalogFingerprintBackfillService(
    persistence,
    catalog,
    fakeHasher(async (item) => {
      if (!retry && item.assetId === unreadable.assetId) {
        return { status: "not-fully-checked", sha256: null, observation: null, reason: "unreadable" };
      }
      if (!retry && item.assetId === failed.assetId) throw new Error("decoder failed");
      return validResult(item, item.assetId === unreadable.assetId ? "b".repeat(64) : "c".repeat(64));
    }),
  );
  const first = await service.run({ operationId: createOperationId(), catalogId, assets, concurrency: 1 });
  assert.equal(first.failed, 1);
  assert.equal(first.unchecked, 1);
  assert.equal(first.remaining, 0);
  retry = true;
  const second = await service.resume({
    sourceOperationId: first.operationId,
    operationId: createOperationId(),
    catalogId,
    assets,
    concurrency: 1,
  });
  assert.equal(second.indexed, 2);
  assert.equal(second.failed, 0);
  assert.equal(second.unchecked, 0);
  assert.equal(second.remaining, 0);
});

test("restart from a running snapshot skips proven assets and continues remaining work", async () => {
  const catalogId = createCatalogId();
  const first = asset(catalogId, createAssetId());
  const second = asset(catalogId, createAssetId());
  const firstResult = validResult(first, "d".repeat(64));
  if (firstResult.observation === null) throw new Error("Test result observation is missing.");
  const operationId = createOperationId();
  const preseed: FingerprintBackfillSnapshot = {
    version: 1,
    operationId,
    catalogId,
    state: "running",
    items: [
      { assetId: first.assetId, state: "indexed", sha256: firstResult.sha256, observation: firstResult.observation, reason: null },
      { assetId: second.assetId, state: "pending", sha256: null, observation: null, reason: null },
    ],
    progress: { total: 2, indexed: 1, stale: 0, remaining: 1, processed: 1, failed: 0, unchecked: 0 },
    updatedAt: 1,
  };
  const persistence = new MemoryPersistence();
  await persistence.save(preseed);
  const catalog = new MemoryCatalog();
  const calls: AssetId[] = [];
  const service = new CatalogFingerprintBackfillService(
    persistence,
    catalog,
    fakeHasher(async (item) => {
      calls.push(item.assetId);
      return validResult(item, "e".repeat(64));
    }),
  );
  const execution = await service.run({ operationId, catalogId, assets: [first, second], concurrency: 1 });
  assert.equal(execution.indexed, 2);
  assert.deepEqual(calls, [second.assetId]);
  assert.equal(catalog.updates.length, 1);
});

test("tampered persisted progress is rejected before hashing", async () => {
  const catalogId = createCatalogId();
  const item = asset(catalogId, createAssetId());
  const operationId = createOperationId();
  const persistence = new MemoryPersistence();
  await persistence.save({
    version: 1,
    operationId,
    catalogId,
    state: "running",
    items: [{ assetId: item.assetId, state: "pending", sha256: null, observation: null, reason: null }],
    progress: { total: 1, indexed: 1, stale: 0, remaining: 0, processed: 1, failed: 0, unchecked: 0 },
    updatedAt: 1,
  });
  let calls = 0;
  const service = new CatalogFingerprintBackfillService(
    persistence,
    new MemoryCatalog(),
    fakeHasher(async () => {
      calls += 1;
      return validResult(item);
    }),
  );
  await assert.rejects(service.run({ operationId, catalogId, assets: [item] }), /progress/);
  assert.equal(calls, 0);
});
