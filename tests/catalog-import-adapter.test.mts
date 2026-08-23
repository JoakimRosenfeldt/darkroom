import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAssetId,
  createCatalogId,
  createOperationId,
  createPresetId,
  createRootId,
  type AssetId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  createSessionId,
  type SessionId,
} from "../lib/catalog/runtime.ts";
import type {
  FileObservation,
  FrozenImportPlan,
  ImportPreset,
  ImportSource,
} from "../lib/import/domain.ts";
import {
  CatalogLiveRepository,
} from "../electron/catalog-live-repository.ts";
import {
  CatalogImportAdapter,
  type CatalogImportAdapterOptions,
} from "../electron/catalog-import-adapter.ts";
import {
  MemoryFileTransactionJournal,
} from "../electron/file-transaction-service.ts";
import {
  ImportOperationService,
} from "../electron/import-operation-service.ts";
import {
  createNoopCatalogFaultInjector,
} from "../electron/catalog-fault-injection.ts";

function observation(size = 4, modifiedAt = 1, observedAt = 2): FileObservation {
  return { size, modifiedAt, localFileId: "device:1", observedAt };
}

function source(rootId: RootId, relativePath = "source.jpg", value = observation()): ImportSource {
  return { rootId, relativePath, observation: value, xmpState: "absent", formatId: "jpeg" };
}

function preset(catalogId: CatalogId): ImportPreset {
  return {
    catalogId,
    presetId: createPresetId(),
    name: "Import defaults",
    version: 1,
    template: { pattern: "{{filename}}" },
    payload: { metadata: { title: "Imported", keywords: ["one"] }, develop: { exposure: 1 } },
    updatedAt: 1,
  };
}

function createInput(rootPath: string): {
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly rootPath: string;
} {
  return { catalogId: createCatalogId(), rootId: createRootId(), rootPath };
}

async function createFixture(): Promise<{
  readonly temporaryRoot: string;
  readonly database: DatabaseSync;
  readonly repository: CatalogLiveRepository;
  readonly catalogId: CatalogId;
  readonly rootId: RootId;
  readonly sessionId: SessionId;
}> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "darkroom-catalog-import-adapter-"));
  const database = new DatabaseSync(path.join(temporaryRoot, "catalog.db"), { enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON;");
  const repository = new CatalogLiveRepository(database);
  const input = createInput(temporaryRoot);
  repository.create({
    catalogId: input.catalogId,
    displayName: "Test",
    appVersion: "test",
    root: {
      rootId: input.rootId,
      label: "Photos",
      configuredPath: temporaryRoot,
      canonicalPath: temporaryRoot,
      health: "online",
      scanState: "complete",
      watchState: "disabled",
    },
  });
  return {
    temporaryRoot,
    database,
    repository,
    catalogId: input.catalogId,
    rootId: input.rootId,
    sessionId: createSessionId(),
  };
}

async function cleanup(value: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  value.database.close();
  await rm(value.temporaryRoot, { recursive: true, force: true });
}

function adapterOptions(
  value: Awaited<ReturnType<typeof createFixture>>,
  sourceObservation: FileObservation,
  destinationObservation: FileObservation = sourceObservation,
  overrides: Partial<CatalogImportAdapterOptions> = {},
): CatalogImportAdapterOptions {
  return {
    catalogId: value.catalogId,
    sessionId: value.sessionId,
    worker: {
      liveQuery: async (input) => value.repository.query(input),
      liveApply: async (input) => value.repository.apply(input),
    },
    assertCurrentSession: () => undefined,
    source: {
      observe: async (input) => ({
        rootId: input.rootId,
        relativePath: input.relativePath,
        observation: sourceObservation,
        xmpState: "absent",
        formatId: "jpeg",
      }),
    },
    destinationObservation: {
      observe: async () => destinationObservation,
    },
    paths: {
      resolve: async () => ({
        sourcePath: "/tmp/source.jpg",
        destinationPath: "/tmp/destination.jpg",
        xmp: null,
      }),
    },
    journal: new MemoryFileTransactionJournal(),
    faultInjector: createNoopCatalogFaultInjector(),
    now: () => 100,
    ...overrides,
  };
}

async function frozenPlan(
  adapter: CatalogImportAdapter,
  catalogId: CatalogId,
  rootId: RootId,
  action: "add" | "copy" | "move" | "rename",
  sourceAssetId?: AssetId,
  pattern = "{{filename}}",
): Promise<FrozenImportPlan> {
  const service = new ImportOperationService({
    ...adapter.dependencies(),
    now: () => 100,
  });
  const draft = service.prepare({
    operationId: createOperationId(),
    catalogId,
    destinationRootId: rootId,
    preset: { ...preset(catalogId), template: { pattern } },
    sources: [{ source: source(rootId), action, ...(sourceAssetId === undefined ? {} : { sourceAssetId }) }],
    now: 100,
  });
  return service.freeze({ draft, review: service.review(draft) });
}

async function seedAsset(
  value: Awaited<ReturnType<typeof createFixture>>,
  assetId: AssetId,
  relativePath: string,
  fileObservation: FileObservation = observation(),
): Promise<void> {
  value.repository.apply({
    catalogId: value.catalogId,
    expectedRevision: value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).catalog.revision,
    mutations: [{
      kind: "reconcile-complete",
      rootId: value.rootId,
      observations: [{
        assetId,
        relativePath,
        observation: {
          byteLength: fileObservation.size,
          modifiedAt: fileObservation.modifiedAt,
          observedAt: fileObservation.observedAt,
          localFileId: fileObservation.localFileId,
        },
        health: "present",
        formatId: "jpeg",
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
      }],
    }],
  });
}

test("persists and reloads a frozen plan atomically", async () => {
  const value = await createFixture();
  try {
    let applies = 0;
    const adapter = new CatalogImportAdapter({
      ...adapterOptions(value, observation()),
      worker: {
        liveQuery: async (input) => value.repository.query(input),
        liveApply: async (input) => {
          applies += 1;
          return value.repository.apply(input);
        },
      },
    });
    const plan = await frozenPlan(adapter, value.catalogId, value.rootId, "add");
    assert.equal(applies, 1);
    const loaded = await adapter.loadFrozenOperation(plan.operationId);
    assert.deepEqual(loaded?.plan, plan);
    assert.equal(loaded?.items[0]?.assetId, plan.items[0]?.destinationAssetId);
    assert.equal(loaded?.items[0]?.status, "planned");
  } finally {
    await cleanup(value);
  }
});

test("rejects a stale session before and after worker calls", async () => {
  const value = await createFixture();
  try {
    let current = true;
    const adapter = new CatalogImportAdapter({
      ...adapterOptions(value, observation()),
      assertCurrentSession: () => {
        if (!current) throw new Error("Import session is stale.");
      },
    });
    const plan = await frozenPlan(adapter, value.catalogId, value.rootId, "add");
    current = false;
    await assert.rejects(adapter.loadFrozenOperation(plan.operationId), /stale/);
  } finally {
    await cleanup(value);
  }
});

test("Add registration requires ownership of the active source root", async () => {
  const value = await createFixture();
  try {
    const foreignRoot = createRootId();
    const adapter = new CatalogImportAdapter(adapterOptions(value, observation()));
    const plan = await frozenPlan(adapter, value.catalogId, value.rootId, "add");
    const item = { ...plan.items[0]!, source: { ...plan.items[0]!.source, rootId: foreignRoot } };
    await assert.rejects(adapter.registerSource(item), /active catalog/);
  } finally {
    await cleanup(value);
  }
});

test("Move and Rename relocate the planned AssetId, while Copy mints its planned AssetId", async () => {
  const value = await createFixture();
  try {
    const sourceAssetId = createAssetId();
    await seedAsset(value, sourceAssetId, "source.jpg");
    const adapter = new CatalogImportAdapter(adapterOptions(value, observation()));
    const move = await frozenPlan(adapter, value.catalogId, value.rootId, "move", sourceAssetId, "moved-{{filename}}");
    await adapter.applyFileTransaction(move.items[0]!, "absent");
    const moved = value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.find((asset) => asset.assetId === sourceAssetId);
    assert.equal(moved?.assetId, sourceAssetId);
    assert.equal(moved?.relativePath, "moved-source.jpg");

    const rename = await frozenPlan(adapter, value.catalogId, value.rootId, "rename", sourceAssetId, "renamed-{{filename}}");
    await adapter.applyFileTransaction(rename.items[0]!, "absent");
    const renamed = value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.find((asset) => asset.assetId === sourceAssetId);
    assert.equal(renamed?.assetId, sourceAssetId);
    assert.equal(renamed?.relativePath, "renamed-source.jpg");

    const copy = await frozenPlan(adapter, value.catalogId, value.rootId, "copy", sourceAssetId, "copy-{{filename}}");
    await adapter.applyFileTransaction(copy.items[0]!, "absent");
    const copied = value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.find((asset) => asset.assetId === copy.items[0]!.destinationAssetId);
    assert.equal(copied?.assetId, copy.items[0]!.destinationAssetId);
    assert.notEqual(copied?.assetId, sourceAssetId);
  } finally {
    await cleanup(value);
  }
});

test("external Copy source registration keeps the frozen source observation", async () => {
  const value = await createFixture();
  try {
    const sourceObservation = observation();
    const copiedObservation = observation(4, 20, 21);
    const sourceAssetId = createAssetId();
    let registeredObservation: FileObservation | null = null;
    const adapter = new CatalogImportAdapter(adapterOptions(
      value,
      sourceObservation,
      copiedObservation,
      {
        externalSourceRegistrar: {
          register: async (input) => {
            registeredObservation = input.observation;
            await seedAsset(value, sourceAssetId, input.item.source.relativePath, input.observation);
            return sourceAssetId;
          },
        },
      },
    ));
    const plan = await frozenPlan(adapter, value.catalogId, value.rootId, "copy", undefined, "copy-{{filename}}");
    await adapter.applyFileTransaction(plan.items[0]!, "absent");

    assert.deepEqual(registeredObservation, sourceObservation);
    const copied = value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.find(
      (asset) => asset.assetId === plan.items[0]!.destinationAssetId,
    );
    assert.equal(copied?.observation?.modifiedAt, copiedObservation.modifiedAt);
  } finally {
    await cleanup(value);
  }
});

test("metadata applies canonical keywords, Develop defaults, and timestamps in one patch", async () => {
  const value = await createFixture();
  try {
    const assetId = createAssetId();
    await seedAsset(value, assetId, "photo.jpg");
    const adapter = new CatalogImportAdapter(adapterOptions(value, observation()));
    await adapter.apply(assetId, {
      title: "Title",
      caption: "Caption",
      copyright: "Copyright",
      keywords: ["z", "a"],
      develop: { z: 1, a: true },
    });
    const asset = value.repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.find((candidate) => candidate.assetId === assetId);
    assert.equal(asset?.metadata.keywordsJson, '["z","a"]');
    assert.equal(asset?.metadata.developJson, '{"a":true,"z":1}');
    assert.equal(asset?.metadata.developUpdatedAt, 100);
    assert.equal(asset?.metadata.updatedAt, 100);
  } finally {
    await cleanup(value);
  }
});

test("destination-published recovery applies catalog state monotonically", async () => {
  const value = await createFixture();
  try {
    const sourceAssetId = createAssetId();
    await seedAsset(value, sourceAssetId, "source.jpg");
    const adapter = new CatalogImportAdapter(adapterOptions(value, observation()));
    const plan = await frozenPlan(adapter, value.catalogId, value.rootId, "copy", sourceAssetId, "copy-{{filename}}");
    const item = plan.items[0]!;
    await adapter.updateOperation({ operationId: plan.operationId, state: "running", error: null, updatedAt: 101 });
    await adapter.updateItem({ operationId: plan.operationId, itemId: item.itemId, assetId: item.destinationAssetId, state: "running", status: "running", stage: "destination-published", xmpStatus: "absent", error: null, updatedAt: 101 });
    await adapter.applyFileTransaction(item, "absent");
    await adapter.updateItem({ operationId: plan.operationId, itemId: item.itemId, assetId: item.destinationAssetId, state: "running", status: "running", stage: "catalog-applied", xmpStatus: "absent", error: null, updatedAt: 101 });
    await adapter.updateItem({ operationId: plan.operationId, itemId: item.itemId, assetId: item.destinationAssetId, state: "completed", status: "completed", stage: "source-cleaned", xmpStatus: "absent", error: null, updatedAt: 102 });
    const loaded = await adapter.loadFrozenOperation(plan.operationId);
    assert.equal(loaded?.items[0]?.stage, "source-cleaned");
    assert.equal(loaded?.items[0]?.assetId, item.destinationAssetId);
  } finally {
    await cleanup(value);
  }
});

test("tampered persisted plans fail hash verification", async () => {
  const value = await createFixture();
  try {
    const adapter = new CatalogImportAdapter(adapterOptions(value, observation()));
    const plan = await frozenPlan(adapter, value.catalogId, value.rootId, "add");
    value.database.prepare("UPDATE operations SET payload_json = ? WHERE catalog_id = ? AND operation_id = ?").run(
      JSON.stringify({ version: 1, kind: "import", planHash: plan.planSha256, plan: { ...plan, createdAt: plan.createdAt + 1 }, error: null }),
      value.catalogId,
      plan.operationId,
    );
    await assert.rejects(adapter.loadFrozenOperation(plan.operationId), /hash/);
  } finally {
    await cleanup(value);
  }
});
