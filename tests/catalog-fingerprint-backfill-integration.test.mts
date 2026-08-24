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
  type CatalogId,
} from "../lib/catalog/ids.ts";
import {
  defaultCatalogLiveMetadata,
  type CatalogLiveApplyInput,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import type { CatalogV3Observation } from "../lib/catalog/v3.ts";
import {
  CatalogFingerprintBackfillAdapter,
  type FingerprintBackfillWorkerPort,
} from "../electron/catalog-fingerprint-backfill-adapter.ts";
import type {
  FingerprintBackfillAsset,
  FingerprintBackfillSnapshot,
} from "../electron/catalog-fingerprint-backfill-service.ts";
import { observeNoFollowFile } from "../electron/catalog-fingerprint-service.ts";
import {
  CatalogFingerprintBackfillStore,
  CATALOG_FINGERPRINT_BACKFILL_DIRECTORY,
} from "../electron/catalog-fingerprint-backfill-store.ts";

function observation(size = 4, observedAt = 1): CatalogV3Observation {
  return { byteLength: size, modifiedAt: 10, observedAt, localFileId: "device:file" };
}

function asset(catalogId: CatalogId, assetId = createAssetId()): FingerprintBackfillAsset {
  return {
    catalogId,
    assetId,
    rootId: createRootId(),
    relativePath: `${assetId}.jpg`,
    observation: observation(),
    health: "present",
    fingerprintStatus: "missing",
    fingerprintSha256: null,
    fingerprintObservedAt: null,
    fingerprintObservedByteLength: null,
    fingerprintObservedModifiedAt: null,
    fingerprintLocalFileId: null,
  };
}

function snapshot(catalogId: CatalogId, operationId = createOperationId()): FingerprintBackfillSnapshot {
  const item = { assetId: createAssetId(), state: "pending" as const, sha256: null, observation: null, reason: null };
  return {
    version: 1,
    operationId,
    catalogId,
    state: "planned",
    items: [item],
    progress: { total: 1, indexed: 0, stale: 0, remaining: 1, processed: 0, failed: 0, unchecked: 0 },
    updatedAt: 1,
  };
}

function liveState(catalogId: CatalogId, item: FingerprintBackfillAsset): CatalogLiveState {
  if (item.observation === null) throw new Error("Fixture observation is missing.");
  return {
    catalog: { catalogId, displayName: "Fixture", appVersion: "test", installState: "ready", revision: 1 },
    roots: [{
      rootId: item.rootId,
      label: "Photos",
      configuredPath: "/private/photos",
      canonicalPath: "/private/photos",
      health: "online",
      scanState: "complete",
      watchState: "disabled",
      revision: 1,
    }],
    assets: [{
      catalogId,
      assetId: item.assetId,
      rootId: item.rootId,
      relativePath: item.relativePath,
      observation: item.observation,
      revision: 1,
      health: "present",
      formatId: "jpeg",
      cameraMake: null,
      cameraModel: null,
      lensModel: null,
      fingerprintId: createAssetId(),
      fingerprintStatus: item.fingerprintStatus,
      fingerprintSha256: item.fingerprintSha256,
      fingerprintObservedAt: item.fingerprintObservedAt,
      fingerprintObservedByteLength: item.fingerprintObservedByteLength,
      fingerprintObservedModifiedAt: item.fingerprintObservedModifiedAt,
      fingerprintLocalFileId: item.fingerprintLocalFileId,
      metadata: defaultCatalogLiveMetadata(1),
    }],
    albums: [],
    operations: [],
    presets: [],
    rules: [],
    fingerprintCoverage: { total: 1, missing: 1, hashing: 0, valid: 0, stale: 0, failed: 0 },
    fingerprintMatches: [],
  };
}

class FakeWorker implements FingerprintBackfillWorkerPort {
  public state: CatalogLiveState;
  public readonly applies: CatalogLiveApplyInput[] = [];
  public queryCount = 0;
  public staleResponses = 0;
  public alwaysStale = false;

  public constructor(state: CatalogLiveState) {
    this.state = structuredClone(state);
  }

  public async liveQuery(): Promise<unknown> {
    this.queryCount += 1;
    return structuredClone(this.state);
  }

  public async liveApply(input: CatalogLiveApplyInput): Promise<unknown> {
    this.applies.push(structuredClone(input));
    if (this.alwaysStale || this.staleResponses > 0) {
      if (this.staleResponses > 0) this.staleResponses -= 1;
      this.state = { ...this.state, catalog: { ...this.state.catalog, revision: this.state.catalog.revision + 1 } };
      throw new Error("Catalog live revision 1 is stale; current revision is 2.");
    }
    const mutation = input.mutations[0];
    if (mutation === undefined || mutation.kind !== "fingerprint-set") throw new Error("Unexpected mutation.");
    this.state = {
      ...this.state,
      catalog: { ...this.state.catalog, revision: this.state.catalog.revision + 1 },
      assets: this.state.assets.map((candidate) => candidate.assetId === mutation.fingerprint.assetId
        ? {
          ...candidate,
          fingerprintStatus: mutation.fingerprint.status,
          fingerprintSha256: mutation.fingerprint.sha256,
          fingerprintObservedAt: mutation.fingerprint.observedAt,
          fingerprintObservedByteLength: mutation.fingerprint.observedByteLength,
          fingerprintObservedModifiedAt: mutation.fingerprint.observedModifiedAt,
          fingerprintLocalFileId: mutation.fingerprint.localFileId,
        }
        : candidate),
    };
    return {
      catalogId: input.catalogId,
      revision: this.state.catalog.revision,
      changed: true,
      appliedMutations: input.mutations.length,
      auditId: 1,
    };
  }
}

test("backfill store atomically round-trips, namespaces, and cleans temporary files", async () => {
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-fingerprint-store-")));
  try {
    const catalogId = createCatalogId();
    const operationId = createOperationId();
    const stored = snapshot(catalogId, operationId);
    const first = new CatalogFingerprintBackfillStore(directory, catalogId);
    const second = snapshot(catalogId, createOperationId());
    await Promise.all([first.save(stored), first.save(second)]);
    assert.deepEqual(await first.load(operationId), stored);
    const namespacePath = path.join(directory, CATALOG_FINGERPRINT_BACKFILL_DIRECTORY, catalogId);
    const entries = await fsp.readdir(namespacePath);
    assert.deepEqual(entries, [`${operationId}.json`, `${second.operationId}.json`].sort());
    assert.deepEqual(
      (await first.list()).map((candidate) => candidate.operationId),
      [operationId, second.operationId].sort(),
    );
    const otherCatalog = new CatalogFingerprintBackfillStore(directory, createCatalogId());
    assert.equal(await otherCatalog.load(operationId), null);
    assert.deepEqual(await otherCatalog.list(), []);
    await assert.rejects(otherCatalog.save(stored), /another catalog/);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("backfill store rejects corrupt, tampered, oversized, and symlink snapshots", async () => {
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-fingerprint-store-")));
  try {
    const catalogId = createCatalogId();
    const operationId = createOperationId();
    const store = new CatalogFingerprintBackfillStore(directory, catalogId);
    await store.save(snapshot(catalogId, operationId));
    const filePath = path.join(directory, CATALOG_FINGERPRINT_BACKFILL_DIRECTORY, catalogId, `${operationId}.json`);
    const original = await fsp.readFile(filePath, "utf8");
    await fsp.writeFile(filePath, "{");
    await assert.rejects(store.load(operationId), /JSON|envelope|invalid/);
    await fsp.writeFile(filePath, original, "utf8");
    const parsed: unknown = JSON.parse(original);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Envelope fixture is invalid.");
    const envelope = parsed as Record<string, unknown>;
    const rawSnapshot = envelope.snapshot;
    if (typeof rawSnapshot !== "object" || rawSnapshot === null || Array.isArray(rawSnapshot)) throw new Error("Snapshot fixture is invalid.");
    const invalidSnapshot = { ...rawSnapshot, progress: { total: 1, indexed: 1, stale: 0, remaining: 0, processed: 1, failed: 0, unchecked: 0 } };
    await fsp.writeFile(filePath, JSON.stringify({ ...envelope, snapshot: invalidSnapshot }), "utf8");
    await assert.rejects(store.load(operationId), /progress/);
    await fsp.writeFile(filePath, "x".repeat(4 * 1024 * 1024 + 1), "utf8");
    await assert.rejects(store.load(operationId), /too large/);
    await fsp.rm(filePath);
    await fsp.symlink("missing-target", filePath);
    await assert.rejects(store.load(operationId), /regular file|symlink/);
    await fsp.rm(filePath);
    await fsp.mkdir(filePath);
    await assert.rejects(store.list(), /unsafe|regular/);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("adapter maps valid, stale, and failed results to live fingerprint-set mutations", async () => {
  const catalogId = createCatalogId();
  const item = asset(catalogId);
  const worker = new FakeWorker(liveState(catalogId, item));
  const adapter = new CatalogFingerprintBackfillAdapter(catalogId, worker, {
    resolve: async () => {
      throw new Error("Hasher is not used in this test.");
    },
  });
  const resultObservation = { size: 4, modifiedAt: 10, localFileId: "device:file", observedAt: 99 };
  await adapter.applyFingerprint({ assetId: item.assetId, status: "valid", sha256: "a".repeat(64), observation: resultObservation });
  assert.equal(worker.applies[0]?.expectedRevision, 1);
  const validMutation = worker.applies[0]?.mutations[0];
  assert.equal(validMutation?.kind, "fingerprint-set");
  if (validMutation?.kind !== "fingerprint-set") throw new Error("Valid mutation is missing.");
  assert.equal(validMutation.fingerprint.status, "valid");
  assert.equal(validMutation.fingerprint.observedAt, 1);
  assert.equal(validMutation.fingerprint.sha256, "a".repeat(64));
  await adapter.applyFingerprint({ assetId: item.assetId, status: "stale", sha256: null, observation: resultObservation });
  await adapter.applyFingerprint({ assetId: item.assetId, status: "failed", sha256: null, observation: null });
  assert.deepEqual(worker.applies.slice(1).map((input) => input.mutations[0]?.kind), ["fingerprint-set", "fingerprint-set"]);
});

test("adapter accepts a legacy catalog observation without a local file identity", async () => {
  const catalogId = createCatalogId();
  const item = {
    ...asset(catalogId),
    observation: {
      byteLength: 4,
      modifiedAt: 10,
      localFileId: null,
      observedAt: 1,
    },
  } satisfies FingerprintBackfillAsset;
  const worker = new FakeWorker(liveState(catalogId, item));
  const adapter = new CatalogFingerprintBackfillAdapter(catalogId, worker, {
    resolve: async () => { throw new Error("Hasher is not used in this test."); },
  });
  await adapter.applyFingerprint({
    assetId: item.assetId,
    status: "valid",
    sha256: "a".repeat(64),
    observation: { size: 4, modifiedAt: 10, localFileId: "device:file", observedAt: 99 },
  });
  assert.equal(worker.applies.length, 1);
  const mutation = worker.applies[0]?.mutations[0];
  assert.equal(mutation?.kind, "fingerprint-set");
  if (mutation?.kind !== "fingerprint-set") throw new Error("Valid mutation is missing.");
  assert.equal(mutation.fingerprint.localFileId, null);
});

test("adapter retries a live revision conflict and fails after the bounded retry limit", async () => {
  const catalogId = createCatalogId();
  const item = asset(catalogId);
  const worker = new FakeWorker(liveState(catalogId, item));
  worker.staleResponses = 1;
  const adapter = new CatalogFingerprintBackfillAdapter(catalogId, worker, {
    resolve: async () => { throw new Error("Hasher is not used in this test."); },
  });
  await adapter.applyFingerprint({ assetId: item.assetId, status: "failed", sha256: null, observation: null });
  assert.equal(worker.queryCount, 2);
  const failedWorker = new FakeWorker(liveState(catalogId, item));
  failedWorker.alwaysStale = true;
  const failingAdapter = new CatalogFingerprintBackfillAdapter(catalogId, failedWorker, {
    resolve: async () => { throw new Error("Hasher is not used in this test."); },
  }, { maxRevisionRetries: 1 });
  await assert.rejects(
    failingAdapter.applyFingerprint({ assetId: item.assetId, status: "failed", sha256: null, observation: null }),
    /stale|revision/,
  );
  assert.equal(failedWorker.queryCount, 2);
  assert.equal(failedWorker.applies.length, 2);
});

test("adapter hashes through a private NativeAssetLocation without exposing paths", async () => {
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-fingerprint-adapter-")));
  try {
    const filePath = path.join(directory, "photo.jpg");
    await fsp.writeFile(filePath, "photo bytes");
    const stat = await observeNoFollowFile(filePath);
    const catalogId = createCatalogId();
    const item = {
      ...asset(catalogId),
      relativePath: "photo.jpg",
      observation: {
        byteLength: stat.size,
        modifiedAt: stat.modifiedAt,
        observedAt: stat.observedAt,
        localFileId: stat.localFileId,
      },
    } satisfies FingerprintBackfillAsset;
    const worker = new FakeWorker(liveState(catalogId, item));
    const resolvedAssets: FingerprintBackfillAsset[] = [];
    const adapter = new CatalogFingerprintBackfillAdapter(catalogId, worker, {
      resolve: async (resolved) => {
        resolvedAssets.push(resolved);
        return {
          catalogId,
          assetId: item.assetId,
          rootId: item.rootId,
          canonicalRootPath: directory,
          relativePath: item.relativePath,
        };
      },
    }, { pathAccess: { resolvePath: async () => filePath } });
    const result = await adapter.fingerprint(item, () => false);
    assert.equal(result.status, "valid");
    assert.ok(result.sha256);
    assert.equal("filePath" in result, false);
    assert.equal(resolvedAssets[0]?.assetId, item.assetId);
    assert.equal("canonicalRootPath" in (resolvedAssets[0] ?? {}), false);
    await assert.rejects(
      adapter.fingerprint({ ...item, relativePath: "other.jpg" }, () => false),
      /location|asset/,
    );
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("adapter sanitizes native fingerprint failure reasons", async () => {
  const catalogId = createCatalogId();
  const item = asset(catalogId);
  const worker = new FakeWorker(liveState(catalogId, item));
  const adapter = new CatalogFingerprintBackfillAdapter(catalogId, worker, {
    resolve: async () => ({
      catalogId,
      assetId: item.assetId,
      rootId: item.rootId,
      canonicalRootPath: "/private/hidden",
      relativePath: item.relativePath,
    }),
  }, { pathAccess: { resolvePath: async () => "/private/hidden/photo.jpg" } });
  const result = await adapter.fingerprint(item, () => false);
  assert.equal(result.status, "not-fully-checked");
  assert.equal(result.reason, "File could not be fully checked.");
  assert.equal(result.reason.includes("/private"), false);
});
