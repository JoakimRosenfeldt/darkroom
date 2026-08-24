import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogLiveRepository } from "../electron/catalog-live-repository.ts";
import { installCatalogV3Schema } from "../electron/catalog-v3-schema.ts";
import { createAssetId, createCatalogId, createOperationId, createPresetId, createRootId } from "../lib/catalog/ids.ts";
import { createCatalogWorkerTestClient, type CatalogWorkerClient } from "../electron/catalog-worker-client.ts";
import type { CatalogLiveCreateInput } from "../lib/catalog/live.ts";

function createInput(databaseRoot: string): CatalogLiveCreateInput {
  return {
    catalogId: createCatalogId(),
    displayName: "Live catalog",
    appVersion: "test",
    root: {
      rootId: createRootId(),
      label: "Main",
      configuredPath: databaseRoot,
      canonicalPath: databaseRoot,
      health: "online",
      scanState: "unknown",
      watchState: "disabled",
    },
    now: 10,
  };
}

function observation(observedAt: number, byteLength = 10) {
  return {
    byteLength,
    modifiedAt: observedAt + 1,
    observedAt,
    localFileId: null,
  } as const;
}

function itemPayload(
  stage: "planned" | "destination-prepared" | "destination-published" | "catalog-applied" | "source-cleaned",
  xmpStatus: "absent" | "preserved" | "mismatch" | null = null,
) {
  return {
    version: 1 as const,
    stage,
    action: "copy" as const,
    sourceRootId: null,
    sourceRelativePath: null,
    destinationRootId: null,
    destinationRelativePath: null,
    xmpStatus,
  };
}

test("live create recovers from a committed schema-only database", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "darkroom-live-schema-only-"));
  const databasePath = path.join(temporaryRoot, "catalog.db");
  const schemaDatabase = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  installCatalogV3Schema(schemaDatabase);
  schemaDatabase.close();
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    const repository = new CatalogLiveRepository(database);
    const created = createInput(temporaryRoot);
    assert.equal(repository.create(created).revision, 1);
    const state = repository.query({ catalogId: created.catalogId, expectedRevision: 1 });
    assert.equal(state.catalog.displayName, created.displayName);
    assert.equal(state.roots.length, 1);
    assert.deepEqual(state.assets, []);
    assert.deepEqual(state.fingerprintCoverage, { total: 0, missing: 0, hashing: 0, valid: 0, stale: 0, failed: 0 });
  } finally {
    database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("live repository persists roots, assets, albums, fingerprints, presets, rules and operations", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "darkroom-live-repository-"));
  const databasePath = path.join(temporaryRoot, "catalog.db");
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON;");
  try {
    const repository = new CatalogLiveRepository(database);
    const created = createInput(temporaryRoot);
    const createResult = repository.create(created);
    assert.equal(createResult.revision, 1);
    const emptyState = repository.query({ catalogId: created.catalogId, expectedRevision: 1 });
    assert.deepEqual(emptyState.fingerprintCoverage, { total: 0, missing: 0, hashing: 0, valid: 0, stale: 0, failed: 0 });
    assert.deepEqual(emptyState.albums, []);
    const secondRoot = createRootId();
    const assetId = createAssetId();
    const firstApply = repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 1,
      now: 20,
      mutations: [
        {
          kind: "root-upsert",
          root: {
            rootId: secondRoot,
            label: "Secondary",
            configuredPath: `${temporaryRoot}/secondary`,
            canonicalPath: `${temporaryRoot}/secondary`,
            health: "online",
            scanState: "unknown",
            watchState: "disabled",
          },
        },
        {
          kind: "reconcile-complete",
          rootId: created.root.rootId,
          observations: [{
            assetId,
            relativePath: "photos/one.jpg",
            observation: observation(30),
            health: "present",
            formatId: "jpeg",
            cameraMake: null,
            cameraModel: null,
            lensModel: null,
          }],
        },
      ],
    });
    assert.equal(firstApply.revision, 2);
    assert.throws(() => repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 1,
      mutations: [],
    }), /stale/);
    const partialApply = repository.apply({ catalogId: created.catalogId, expectedRevision: 2, now: 25, mutations: [{ kind: "reconcile", rootId: created.root.rootId, complete: false, observations: [] }] });
    assert.equal(partialApply.revision, 3);
    assert.equal(repository.query({ catalogId: created.catalogId, expectedRevision: 3 }).assets[0]?.health, "present");

    const presetId = createPresetId();
    const ruleId = createCatalogId();
    const operationId = createOperationId();
    const presetPayload = {
      version: 1 as const,
      template: { pattern: "{{filename}}" },
      payload: { destination: "photos" },
      isDefault: true,
    };
    const operationPayload = {
      version: 1 as const,
      kind: "copy",
      planHash: "a".repeat(64),
      plan: { version: 1, action: "copy" },
    } as const;
    const secondApply = repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 3,
      now: 40,
      mutations: [
        { kind: "metadata-patch", assetId, patch: { version: 1, archive: true, title: "Saved" } },
        { kind: "album-create", albumId: "saved", name: "Saved", position: 0, createdAt: 40, updatedAt: 40 },
        { kind: "album-membership-replace", albumId: "saved", assetIds: [assetId] },
        { kind: "preset-upsert", presetId, name: "Default", payload: presetPayload, createdAt: 40, updatedAt: 40 },
        { kind: "rule-upsert", ruleId, name: "Copy", enabled: true, destinationRootId: secondRoot, presetId, config: { version: 1, action: "copy", ingressRootId: created.root.rootId, ingressRelativePath: "in", stabilityMs: 100, maxAttempts: 2, retryBackoffMs: 10 }, createdAt: 40, updatedAt: 40 },
        { kind: "operation-upsert", operation: { operationId, kind: "file-copy", state: "planned", payload: operationPayload, createdAt: 40, updatedAt: 40 } },
        { kind: "operation-item-upsert", item: { operationId, itemId: "one", assetId, state: "planned", payload: itemPayload("planned") } },
      ],
    });
    assert.equal(secondApply.revision, 4);
    const state = repository.query({ catalogId: created.catalogId, expectedRevision: 4, fingerprintSha256: undefined });
    assert.equal(state.roots.length, 2);
    assert.equal(state.assets[0]?.metadata.archive, true);
    assert.deepEqual(state.albums[0]?.assetIds, [assetId]);
    assert.equal(state.presets[0]?.payload.isDefault, true);
    assert.equal(state.rules.length, 1);
    assert.equal(state.operations[0]?.items[0]?.payload.stage, "planned");

    const currentAsset = state.assets[0]!;
    const fingerprint = {
      assetId,
      status: "valid" as const,
      sha256: "b".repeat(64),
      observedAt: currentAsset.observation!.observedAt,
      observedByteLength: currentAsset.observation!.byteLength,
      observedModifiedAt: currentAsset.observation!.modifiedAt,
      localFileId: currentAsset.observation!.localFileId,
    };
    const fingerprintApply = repository.apply({ catalogId: created.catalogId, expectedRevision: 4, now: 50, mutations: [{ kind: "fingerprint-set", fingerprint }] });
    assert.equal(fingerprintApply.revision, 5);
    assert.equal(repository.query({ catalogId: created.catalogId, expectedRevision: 5, fingerprintSha256: fingerprint.sha256 }).fingerprintMatches.length, 1);

    const timestampOnlyApply = repository.apply({ catalogId: created.catalogId, expectedRevision: 5, now: 55, mutations: [{ kind: "reconcile-complete", rootId: created.root.rootId, observations: [{ assetId, relativePath: "photos/one.jpg", observation: { ...observation(30), observedAt: 31 }, health: "present", formatId: "jpeg", cameraMake: null, cameraModel: null, lensModel: null }] }] });
    assert.equal(timestampOnlyApply.revision, 6);
    assert.equal(repository.query({ catalogId: created.catalogId, expectedRevision: 6 }).assets[0]?.fingerprintStatus, "valid");
    const missingApply = repository.apply({ catalogId: created.catalogId, expectedRevision: 6, now: 60, mutations: [{ kind: "reconcile-complete", rootId: created.root.rootId, observations: [] }] });
    assert.equal(missingApply.revision, 7);
    const missingState = repository.query({ catalogId: created.catalogId, expectedRevision: 7 });
    assert.equal(missingState.assets[0]?.health, "missing");
    assert.equal(missingState.assets[0]?.fingerprintStatus, "valid");
    assert.equal(missingState.assets[0]?.observation?.observedAt, 31);
    assert.equal(missingState.assets[0]?.metadata.archive, true);
    assert.deepEqual(missingState.albums[0]?.assetIds, [assetId]);
    const statChange = repository.apply({ catalogId: created.catalogId, expectedRevision: 7, now: 65, mutations: [{ kind: "reconcile-complete", rootId: created.root.rootId, observations: [{ assetId, relativePath: "photos/one.jpg", observation: observation(32, 11), health: "present", formatId: "jpeg", cameraMake: null, cameraModel: null, lensModel: null }] }] });
    assert.equal(statChange.revision, 8);
    const statState = repository.query({ catalogId: created.catalogId, expectedRevision: 8 });
    assert.equal(statState.assets[0]?.fingerprintStatus, "stale");
    const relocated = repository.apply({ catalogId: created.catalogId, expectedRevision: 8, mutations: [{ kind: "asset-relocate", assetId, rootId: secondRoot, relativePath: "moved/one.jpg", observation: statState.assets[0]!.observation, health: "present" }] });
    assert.equal(relocated.revision, 9);
    const copiedAssetId = createAssetId();
    repository.apply({ catalogId: created.catalogId, expectedRevision: 9, mutations: [{ kind: "asset-copy", sourceAssetId: assetId, newAssetId: copiedAssetId, rootId: secondRoot, relativePath: "copy/one.jpg", observation: null, health: "missing" }] });
    const finalState = repository.query({ catalogId: created.catalogId, expectedRevision: 10 });
    assert.equal(finalState.assets.some((asset) => asset.assetId === assetId), true);
    assert.equal(finalState.assets.some((asset) => asset.assetId === copiedAssetId), true);
    assert.equal(finalState.assets.find((asset) => asset.assetId === assetId)?.rootId, secondRoot);
    const v2Config = {
      version: 2 as const,
      action: "copy" as const,
      ingressRootId: secondRoot,
      ingressRelativePath: "incoming",
      destinationRelativePath: "output",
      presetVersion: 1,
      presetSha256: "c".repeat(64),
      duplicatePolicy: "skip-incoming" as const,
      destinationConflictPolicy: "rename" as const,
      stabilityMs: 100,
      maxAttempts: 2,
      retryBackoffMs: 10,
    };
    const ruleUpdate = repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 10,
      mutations: [{ kind: "rule-upsert", ruleId, name: "Copy", enabled: true, destinationRootId: secondRoot, presetId, config: v2Config, createdAt: 40, updatedAt: 70 }],
    });
    assert.equal(ruleUpdate.revision, 11);
    assert.deepEqual(repository.query({ catalogId: created.catalogId, expectedRevision: 11 }).rules[0]?.config, v2Config);
    assert.throws(() => repository.apply({ catalogId: created.catalogId, expectedRevision: 11, mutations: [{ kind: "rule-upsert", ruleId: createCatalogId(), name: "Second", enabled: true, destinationRootId: secondRoot, presetId, config: { version: 1, action: "copy", ingressRootId: created.root.rootId, ingressRelativePath: "in2", stabilityMs: 100, maxAttempts: 1, retryBackoffMs: 0 }, createdAt: 70, updatedAt: 70 }] }), /UNIQUE|enabled/);
    const integrity = database.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(integrity, []);
  } finally {
    database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("live operation items apply safe XMP and destination AssetId transitions", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "darkroom-live-operation-item-"));
  const databasePath = path.join(temporaryRoot, "catalog.db");
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON;");
  try {
    const repository = new CatalogLiveRepository(database);
    const created = createInput(temporaryRoot);
    repository.create(created);
    const sourceAssetId = createAssetId();
    repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 1,
      mutations: [{
        kind: "reconcile-complete",
        rootId: created.root.rootId,
        observations: [{
          assetId: sourceAssetId,
          relativePath: "source.jpg",
          observation: observation(10),
          health: "present",
          formatId: "jpeg",
          cameraMake: null,
          cameraModel: null,
          lensModel: null,
        }],
      }],
    });
    const operationId = createOperationId();
    const operationPayload = {
      version: 1 as const,
      kind: "copy",
      planHash: "c".repeat(64),
      plan: { version: 1, action: "copy" },
    };
    const plannedOperation = {
      kind: "operation-upsert" as const,
      operation: {
        operationId,
        kind: "file-copy",
        state: "planned" as const,
        payload: operationPayload,
        createdAt: 20,
        updatedAt: 20,
      },
    };
    const plannedCopyItem = {
      kind: "operation-item-upsert" as const,
      item: { operationId, itemId: "copy-item", assetId: null, state: "planned" as const, payload: itemPayload("planned") },
    };
    const earlyAssignmentItem = {
      kind: "operation-item-upsert" as const,
      item: { operationId, itemId: "early-item", assetId: null, state: "planned" as const, payload: itemPayload("planned") },
    };
    repository.apply({ catalogId: created.catalogId, expectedRevision: 2, mutations: [plannedOperation, plannedCopyItem, earlyAssignmentItem] });

    assert.throws(() => repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 3,
      mutations: [{ kind: "operation-item-upsert", item: { operationId, itemId: "copy-item", assetId: null, state: "running", payload: itemPayload("planned", "preserved") } }],
    }), /XMP result|stage transition/);
    assert.throws(() => repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 3,
      mutations: [{ kind: "operation-item-upsert", item: { operationId, itemId: "early-item", assetId: sourceAssetId, state: "running", payload: itemPayload("destination-published") } }],
    }), /assigned at catalog-applied/);

    repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 3,
      mutations: [{ kind: "operation-item-upsert", item: { operationId, itemId: "copy-item", assetId: null, state: "running", payload: itemPayload("destination-prepared", "preserved") } }],
    });
    assert.throws(() => repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 4,
      mutations: [{ kind: "operation-item-upsert", item: { operationId, itemId: "copy-item", assetId: null, state: "running", payload: itemPayload("destination-published") } }],
    }), /XMP result|stage transition/);
    repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 4,
      mutations: [{ kind: "operation-item-upsert", item: { operationId, itemId: "copy-item", assetId: null, state: "running", payload: itemPayload("destination-published", "preserved") } }],
    });

    const copiedAssetId = createAssetId();
    repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 5,
      mutations: [
        {
          kind: "asset-copy",
          sourceAssetId,
          newAssetId: copiedAssetId,
          rootId: created.root.rootId,
          relativePath: "copy.jpg",
          observation: observation(11),
          health: "present",
        },
        { kind: "operation-item-upsert", item: { operationId, itemId: "copy-item", assetId: copiedAssetId, state: "running", payload: itemPayload("catalog-applied", "preserved") } },
      ],
    });
    const copiedState = repository.query({ catalogId: created.catalogId, expectedRevision: 6 });
    assert.equal(copiedState.operations[0]?.items.find((item) => item.itemId === "copy-item")?.assetId, copiedAssetId);
    assert.equal(copiedState.operations[0]?.items.find((item) => item.itemId === "copy-item")?.payload.xmpStatus, "preserved");

    assert.throws(() => repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 6,
      mutations: [{ kind: "operation-item-upsert", item: { operationId, itemId: "copy-item", assetId: null, state: "running", payload: itemPayload("catalog-applied", "preserved") } }],
    }), /asset is immutable/);
    assert.throws(() => repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 6,
      mutations: [{ kind: "operation-item-upsert", item: { operationId, itemId: "copy-item", assetId: sourceAssetId, state: "running", payload: itemPayload("catalog-applied", "preserved") } }],
    }), /asset is immutable/);
    assert.throws(() => repository.apply({
      catalogId: created.catalogId,
      expectedRevision: 6,
      mutations: [{ kind: "operation-item-upsert", item: { operationId, itemId: "copy-item", assetId: copiedAssetId, state: "completed", payload: itemPayload("source-cleaned", "mismatch") } }],
    }), /XMP result|stage transition/);
  } finally {
    database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("worker create, apply, query, close and reopen preserve live state", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "darkroom-live-worker-"));
  let client: CatalogWorkerClient | undefined;
  try {
    const databasePath = path.join(temporaryRoot, "catalog.db");
    const created = createInput(temporaryRoot);
    client = createCatalogWorkerTestClient({ workerPath: path.resolve("electron/catalog-worker.ts"), execArgv: ["--no-warnings", "--experimental-strip-types"] });
    await client.open(databasePath);
    await client.liveCreate(created);
    const assetId = createAssetId();
    const result = await client.liveApply({ catalogId: created.catalogId, expectedRevision: 1, mutations: [{ kind: "reconcile-complete", rootId: created.root.rootId, observations: [{ assetId, relativePath: "one.webp", observation: observation(2), health: "present", formatId: "webp", cameraMake: null, cameraModel: null, lensModel: null }] }] });
    assert.equal(result.revision, 2);
    await client.close();
    await client.open(databasePath);
    assert.equal((await client.liveQuery({ catalogId: created.catalogId, expectedRevision: 2 })).assets[0]?.assetId, assetId);
  } finally {
    await client?.shutdown().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
