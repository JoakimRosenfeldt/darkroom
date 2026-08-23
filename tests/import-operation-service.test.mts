import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
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
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";
import type {
  FileObservation,
  FrozenImportPlan,
  ImportAction,
  ImportPlanItem,
  ImportPreset,
  ImportSource,
} from "../lib/import/domain.ts";
import {
  AutoImportQueue,
  parseAutoImportRuleId,
  type AutoImportQueueItem,
  type AutoImportRule,
} from "../lib/import/auto-import.ts";
import {
  fingerprintCandidate,
} from "../electron/catalog-fingerprint-service.ts";
import {
  CatalogFaultInjectedError,
  createCatalogFaultInjectorForTests,
  createNoopCatalogFaultInjector,
} from "../electron/catalog-fault-injection.ts";
import {
  createUnavailableDngAdapter,
} from "../electron/import-plan-service.ts";
import {
  createFileTransactionJournal,
  type FileTransactionJournal,
} from "../electron/file-transaction-journal.ts";
import {
  ImportOperationService,
  type FrozenImportOperation,
  type ImportMetadataDefaults,
  type ImportOperationCatalogPort,
  type ImportOperationExecution,
  type ImportOperationFilePort,
  type ImportOperationItemUpdate,
  type ImportOperationMetadataPort,
  type ImportOperationServiceDependencies,
  type ImportOperationSourcePort,
} from "../electron/import-operation-service.ts";
import type {
  FileTransactionPathResolver,
  ResolvedTransactionPaths,
} from "../electron/file-transaction-service.ts";

async function temporaryDirectory(): Promise<string> {
  const created = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-import-operation-"));
  return fsp.realpath(created);
}

function observation(size = 4, modifiedAt = 1, observedAt = 2): FileObservation {
  return { size, modifiedAt, localFileId: "device:1", observedAt };
}

function source(rootId: RootId, relativePath = "photo.jpg", value = observation()): ImportSource {
  return { rootId, relativePath, observation: value, xmpState: "absent", formatId: "jpeg" };
}

function preset(catalogId: CatalogId, payload: ImportPreset["payload"] = { kind: "copy" }): ImportPreset {
  return {
    catalogId,
    presetId: createPresetId(),
    name: "Import defaults",
    version: 4,
    template: { pattern: "{{filename}}" },
    payload,
    updatedAt: 5,
  };
}

function autoRule(catalogId: CatalogId): AutoImportRule {
  return {
    catalogId,
    ruleId: parseAutoImportRuleId(createOperationId()),
    ingressRootId: createRootId(),
    ingressRelativePath: "watch",
    destinationRootId: createRootId(),
    destinationRelativePath: "library",
    placement: "copy",
    presetId: createPresetId(),
    presetVersion: 4,
    presetSha256: "a".repeat(64),
    duplicatePolicy: "continue-unchecked",
    destinationConflictPolicy: "rename",
    enabled: true,
    stabilityMs: 1,
    maxAttempts: 2,
    retryBackoffMs: 1,
  };
}

class MemoryCatalog implements ImportOperationCatalogPort {
  public operation: FrozenImportOperation | null = null;
  public readonly applied: AssetId[] = [];
  public readonly registered: AssetId[] = [];
  public readonly metadata: Array<{ readonly assetId: AssetId; readonly defaults: ImportMetadataDefaults }> = [];
  public updateCalls = 0;

  public async persistFrozenPlan(operation: FrozenImportOperation): Promise<void> {
    if (this.operation !== null) throw new Error("plan already persisted");
    this.operation = structuredClone(operation);
  }

  public async loadFrozenOperation(operationId: OperationId): Promise<FrozenImportOperation | null> {
    if (this.operation?.plan.operationId !== operationId) return null;
    return structuredClone(this.operation);
  }

  public async updateOperation(operation: FrozenImportOperation["operation"]): Promise<void> {
    if (this.operation === null) throw new Error("operation is missing");
    this.updateCalls += 1;
    this.operation = { ...this.operation, operation: structuredClone(operation) };
  }

  public async updateItem(item: ImportOperationItemUpdate): Promise<void> {
    if (this.operation === null) throw new Error("operation is missing");
    this.updateCalls += 1;
    const found = this.operation.items.some((candidate) => candidate.itemId === item.itemId);
    if (!found) throw new Error("item is missing");
    this.operation = {
      ...this.operation,
      items: this.operation.items.map((candidate) => candidate.itemId === item.itemId ? structuredClone(item) : candidate),
    };
  }

  public async applyFileTransaction(item: ImportPlanItem): Promise<void> {
    this.applied.push(item.destinationAssetId);
  }

  public async registerSource(item: ImportPlanItem): Promise<void> {
    this.registered.push(item.destinationAssetId);
  }
}

function operationService(
  catalog: MemoryCatalog,
  sourcePort: ImportOperationSourcePort,
  files: ImportOperationFilePort,
  metadataPort: ImportOperationMetadataPort = { apply: async () => undefined },
  autoImport?: ImportOperationServiceDependencies["autoImport"],
): ImportOperationService {
  return new ImportOperationService({
    catalog,
    source: sourcePort,
    files,
    metadata: metadataPort,
    autoImport,
    now: () => 100,
  });
}

function basicFiles(
  journal: FileTransactionJournal,
  resolver: FileTransactionPathResolver = { resolve: async () => ({ sourcePath: "/tmp/source.jpg", destinationPath: "/tmp/destination.jpg", xmp: null }) },
  faultInjector = createNoopCatalogFaultInjector(),
): ImportOperationFilePort {
  return { journal, paths: resolver, faultInjector };
}

test("Prepare and Review are pure, while Freeze rejects stale source observations", async () => {
  const catalog = new MemoryCatalog();
  let observed = 0;
  const sourcePort: ImportOperationSourcePort = {
    observe: async (item) => {
      observed += 1;
      return { ...item.source, observation: { ...item.source.observation, size: item.source.observation.size + 1 } };
    },
  };
  const service = operationService(catalog, sourcePort, basicFiles(new MapJournal()));
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const sourceInput = { source: source(rootId), action: "copy" as const };
  const draft = service.prepare({ operationId: createOperationId(), catalogId, destinationRootId: rootId, preset: preset(catalogId), sources: [sourceInput], now: 10 });
  const review = service.review(draft);
  assert.equal(observed, 0);
  assert.equal(catalog.updateCalls, 0);
  await assert.rejects(service.freeze({ draft, review }), /stale/);
  assert.equal(observed, 1);
  assert.equal(catalog.operation, null);
});

test("renamed duplicate decisions freeze and on-demand duplicate proof ignores unrelated sizes", async () => {
  const directory = await temporaryDirectory();
  try {
    const incomingPath = path.join(directory, "incoming.jpg");
    const samePath = path.join(directory, "same.jpg");
    const unrelatedPath = path.join(directory, "unrelated.jpg");
    await fsp.writeFile(incomingPath, "same");
    await fsp.writeFile(samePath, "same");
    await fsp.writeFile(unrelatedPath, "different-size");
    const catalog = new MemoryCatalog();
    const service = operationService(catalog, { observe: async (item) => item.source }, basicFiles(new MapJournal()));
    const incomingId = createAssetId();
    const sameId = createAssetId();
    const unrelatedId = createAssetId();
    const unreadableId = createAssetId();
    const hashed: AssetId[] = [];
    const duplicateInput = {
      incoming: { assetId: incomingId, filePath: incomingPath, storedStatus: "missing" as const, storedSha256: null, storedObservation: null },
      existing: [
        { assetId: sameId, filePath: samePath, storedStatus: "stale" as const, storedSha256: "b".repeat(64), storedObservation: observation() },
        { assetId: unrelatedId, filePath: unrelatedPath, storedStatus: "missing" as const, storedSha256: null, storedObservation: observation(20) },
        { assetId: unreadableId, filePath: path.join(directory, "missing.jpg"), storedStatus: "stale" as const, storedSha256: "c".repeat(64), storedObservation: observation() },
      ],
    } satisfies Parameters<ImportOperationService["reviewDuplicatesOnDemand"]>[0];
    const duplicates = await service.reviewDuplicatesOnDemand(duplicateInput, async (candidate) => {
      hashed.push(candidate.assetId);
      return fingerprintCandidate(candidate);
    });
    assert.deepEqual(new Set(hashed), new Set([incomingId, sameId]));
    assert.equal(duplicates.groups.length, 1);
    assert.ok(duplicates.notFullyChecked.includes(unreadableId));
    assert.equal(duplicates.notFullyChecked.includes(unrelatedId), false);

    const catalogId = createCatalogId();
    const rootId = createRootId();
    const draft = service.prepare({
      operationId: createOperationId(),
      catalogId,
      destinationRootId: rootId,
      preset: preset(catalogId),
      sources: [{ source: source(rootId), action: "copy" }],
      now: 10,
    });
    const itemId = draft.items[0]!.itemId;
    const review = service.review(draft, {
      duplicateItems: new Set([itemId]),
      destinationExists: new Set([draft.items[0]!.destinationRelativePath]),
      duplicateDecisions: new Map([[itemId, { kind: "keep-both" }]]),
      destinationDecisions: new Map([[itemId, { kind: "rename", destinationRelativePath: "renamed.jpg" }]]),
    });
    assert.equal(review.canFreeze, true);
    const plan = await service.freeze({ draft, review });
    assert.equal(plan.items[0]!.destinationRelativePath, "renamed.jpg");
    assert.equal(plan.items[0]!.conflictDecisions.duplicate?.kind, "keep-both");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("plan identity rules cover Add, Copy, Move, Rename, frozen preset immutability, and DNG unavailability", async () => {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const existing = createAssetId();
  const plans = new Map<ImportAction, FrozenImportPlan>();
  for (const action of ["add", "copy", "move", "rename"] as const) {
    const catalog = new MemoryCatalog();
    const service = operationService(catalog, { observe: async (item) => item.source }, basicFiles(new MapJournal()));
    const sourceAssetId = action === "move" || action === "rename" ? existing : undefined;
    const draft = service.prepare({
      operationId: createOperationId(),
      catalogId,
      destinationRootId: rootId,
      preset: preset(catalogId),
      sources: [{ source: source(rootId), action, ...(sourceAssetId === undefined ? {} : { sourceAssetId }) }],
      now: 10,
    });
    const plan = await service.freeze({ draft, review: service.review(draft) });
    plans.set(action, plan);
  }
  const addPlan = plans.get("add");
  const copyPlan = plans.get("copy");
  const movePlan = plans.get("move");
  const renamePlan = plans.get("rename");
  assert.ok(addPlan);
  assert.ok(copyPlan);
  assert.ok(movePlan);
  assert.ok(renamePlan);
  assert.notEqual(addPlan.items[0]!.destinationAssetId, existing);
  assert.notEqual(copyPlan.items[0]!.destinationAssetId, existing);
  assert.equal(movePlan.items[0]!.destinationAssetId, existing);
  assert.equal(renamePlan.items[0]!.destinationAssetId, existing);
  const service = operationService(new MemoryCatalog(), { observe: async (item) => item.source }, basicFiles(new MapJournal()));
  const externalMove = service.prepare({ operationId: createOperationId(), catalogId, destinationRootId: rootId, preset: preset(catalogId), sources: [{ source: source(rootId), action: "move" }], now: 10 });
  assert.equal(externalMove.items[0]!.sourceAssetId, null);
  assert.throws(() => service.prepare({ operationId: createOperationId(), catalogId, destinationRootId: rootId, preset: preset(catalogId), sources: [{ source: source(rootId), action: "rename" }], now: 10 }), /Rename requires/);

  const tampered: FrozenImportPlan = { ...copyPlan, preset: { ...copyPlan.preset, name: "changed" } };
  await assert.rejects(service.executeFrozenPlan(tampered), /hash/);
  const unavailable = createUnavailableDngAdapter();
  assert.equal((await unavailable.convert({})).status, "unavailable");
  assert.throws(() => service.prepare({ operationId: createOperationId(), catalogId, destinationRootId: rootId, preset: preset(catalogId), sources: [{ source: { ...source(rootId), formatId: "dng" }, action: "copy" }], now: 10 }), /DNG/);
});

test("Execute applies frozen metadata defaults, supports Add, and cancels before file publication", async () => {
  const catalog = new MemoryCatalog();
  const metadata: ImportOperationMetadataPort = {
    apply: async (assetId, defaults) => { catalog.metadata.push({ assetId, defaults }); },
  };
  const service = operationService(catalog, { observe: async (item) => item.source }, basicFiles(new MapJournal()), metadata);
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const payload = { metadata: { title: "Title", caption: "Caption", copyright: "Copyright", keywords: ["one", "two"] }, develop: { exposure: 1 } };
  const draft = service.prepare({ operationId: createOperationId(), catalogId, destinationRootId: rootId, preset: preset(catalogId, payload), sources: [{ source: source(rootId), action: "add" }], now: 10 });
  const plan = await service.freeze({ draft, review: service.review(draft) });
  const execution = await service.executeFrozenPlan(plan);
  assert.equal(execution.state, "completed");
  assert.deepEqual(catalog.registered, [plan.items[0]!.destinationAssetId]);
  assert.deepEqual(catalog.metadata[0]!.defaults, { title: "Title", caption: "Caption", copyright: "Copyright", keywords: ["one", "two"], develop: { exposure: 1 } });

  const copyCatalog = new MemoryCatalog();
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "destination", "photo.jpg");
    await fsp.writeFile(sourcePath, "same");
    const stat = await fsp.stat(sourcePath);
    const copyService = operationService(copyCatalog, { observe: async (item) => item.source }, basicFiles(new MapJournal(), { resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }) }));
    const copyDraft = copyService.prepare({ operationId: createOperationId(), catalogId, destinationRootId: rootId, preset: preset(catalogId), sources: [{ source: source(rootId, "source.jpg", { size: stat.size, modifiedAt: stat.mtimeMs, localFileId: `${stat.dev}:${stat.ino}`, observedAt: 10 }), action: "copy" }], now: 10 });
    const copyPlan = await copyService.freeze({ draft: copyDraft, review: copyService.review(copyDraft) });
    const cancelled = await copyService.executeFrozenPlan(copyPlan, { isCancelled: () => true });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(await fsp.stat(destinationPath).then(() => true).catch(() => false), false);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("persisted plan and durable journal recover after a publication-stage restart", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "destination", "photo.jpg");
    await fsp.writeFile(sourcePath, "same");
    const stat = await fsp.stat(sourcePath);
    const catalog = new MemoryCatalog();
    const catalogId = createCatalogId();
    const rootId = createRootId();
    const planSource = source(rootId, "source.jpg", { size: stat.size, modifiedAt: stat.mtimeMs, localFileId: `${stat.dev}:${stat.ino}`, observedAt: 10 });
    const resolver: FileTransactionPathResolver = { resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }) };
    const journal = createFileTransactionJournal(directory);
    const planner = operationService(catalog, { observe: async (item) => item.source }, basicFiles(journal, resolver));
    const draft = planner.prepare({ operationId: createOperationId(), catalogId, destinationRootId: rootId, preset: preset(catalogId), sources: [{ source: planSource, action: "copy" }], now: 10 });
    const plan = await planner.freeze({ draft, review: planner.review(draft) });
    const faultService = operationService(catalog, { observe: async (item) => item.source }, basicFiles(journal, resolver, createCatalogFaultInjectorForTests([{ operationId: plan.operationId, itemId: plan.items[0]!.itemId, stage: "destination-published" }])));
    await assert.rejects(faultService.executeFrozenPlan(plan), CatalogFaultInjectedError);
    assert.equal(catalog.operation?.operation.state, "running");
    assert.equal(catalog.operation?.items[0]?.stage, "destination-published");
    const restarted = operationService(catalog, { observe: async (item) => item.source }, basicFiles(journal, resolver));
    const recovered = await restarted.executeFrozenPlan(plan.operationId);
    assert.equal(recovered.state, "completed", recovered.error ?? "");
    assert.equal(await fsp.readFile(destinationPath, "utf8"), "same");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("Auto Import dispatch uses executeFrozenPlan as its only executor path", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "destination", "photo.jpg");
    await fsp.writeFile(sourcePath, "same");
    const stat = await fsp.stat(sourcePath);
    const catalog = new MemoryCatalog();
    const catalogId = createCatalogId();
    const rule = autoRule(catalogId);
    const queue = new AutoImportQueue();
    const firstObservation = { size: stat.size, modifiedAt: stat.mtimeMs, localFileId: `${stat.dev}:${stat.ino}`, observedAt: 1 };
    const secondObservation = { ...firstObservation, observedAt: 2 };
    const item = queue.enqueue(rule, {
      first: { relativePath: "watch/photo.jpg", observation: firstObservation, readable: true },
      second: { relativePath: "watch/photo.jpg", observation: secondObservation, readable: true },
    }, 10);
    assert.ok(item);
    const base = new ImportOperationService({
      catalog,
      source: { observe: async (planItem) => planItem.source },
      metadata: { apply: async () => undefined },
      files: basicFiles(new MapJournal(), { resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }) }),
      autoImport: { createPlan: async () => { throw new Error("not yet"); } },
    });
    const rootId = rule.ingressRootId;
    const draft = base.prepare({
      operationId: item.queueId,
      catalogId,
      destinationRootId: rule.destinationRootId,
      preset: preset(catalogId),
      sources: [{ source: source(rootId, item.relativePath, secondObservation), action: "copy" as const }],
      now: 10,
    });
    const autoDraft = {
      ...draft,
      items: draft.items.map((planItem) => ({
        ...planItem,
        destinationRelativePath: `library/${planItem.destinationRelativePath}`,
      })),
    };
    const frozen = await base.freeze({ draft: autoDraft, review: base.review(autoDraft) });
    const executionRule: AutoImportRule = {
      ...rule,
      presetId: frozen.preset.presetId,
      presetVersion: frozen.preset.version,
      presetSha256: frozen.preset.sha256,
    };
    let calls = 0;
    class SpiedService extends ImportOperationService {
      public override async executeFrozenPlan(input: FrozenImportPlan | OperationId, options = {}): Promise<ImportOperationExecution> {
        calls += 1;
        return super.executeFrozenPlan(input, options);
      }
    }
    const service = new SpiedService({
      catalog,
      source: { observe: async (planItem) => planItem.source },
      metadata: { apply: async () => undefined },
      files: basicFiles(new MapJournal(), { resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }) }),
      autoImport: { createPlan: async () => frozen },
    });
    const result = await service.executeAutoImport(item, executionRule);
    assert.equal(result.state, "completed");
    assert.equal(calls, 1);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("Auto Import retries the same frozen operation after a file-stage fault and terminals only on the final attempt", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "destination", "photo.jpg");
    await fsp.writeFile(sourcePath, "same");
    const stat = await fsp.stat(sourcePath);
    const catalogId = createCatalogId();
    const ruleBase = autoRule(catalogId);
    const rootId = ruleBase.ingressRootId;
    const item: AutoImportQueueItem = {
      queueId: createOperationId(),
      catalogId,
      ruleId: ruleBase.ruleId,
      relativePath: "watch/photo.jpg",
      placement: "copy",
      observation: { size: stat.size, modifiedAt: stat.mtimeMs, localFileId: `${stat.dev}:${stat.ino}`, observedAt: 2 },
      dedupeKey: "watch/photo.jpg",
      state: "queued",
      attempts: 1,
      maxAttempts: 2,
      retryBackoffMs: 0,
      nextAttemptAt: 0,
      leaseUntil: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const planCatalog = new MemoryCatalog();
    const journal = new MapJournal();
    const resolver: FileTransactionPathResolver = {
      resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }),
    };
    const planService = operationService(
      planCatalog,
      { observe: async (planItem) => planItem.source },
      basicFiles(journal, resolver),
    );
    const draft = planService.prepare({
      operationId: item.queueId,
      catalogId,
      destinationRootId: ruleBase.destinationRootId,
      preset: preset(catalogId),
      sources: [{ source: source(rootId, item.relativePath, item.observation), action: "copy" }],
      now: 10,
    });
    const autoDraft = {
      ...draft,
      items: draft.items.map((planItem) => ({
        ...planItem,
        destinationRelativePath: `library/${planItem.destinationRelativePath}`,
      })),
    };
    const frozen = await planService.freeze({ draft: autoDraft, review: planService.review(autoDraft) });
    const rule: AutoImportRule = {
      ...ruleBase,
      presetId: frozen.preset.presetId,
      presetVersion: frozen.preset.version,
      presetSha256: frozen.preset.sha256,
    };
    const fault = createCatalogFaultInjectorForTests([{
      operationId: item.queueId,
      itemId: frozen.items[0]!.itemId,
      stage: "destination-prepared",
    }]);
    let createPlanCalls = 0;
    const service = operationService(
      planCatalog,
      { observe: async (planItem) => planItem.source },
      basicFiles(journal, resolver, fault),
      { apply: async () => undefined },
      {
        createPlan: async () => {
          createPlanCalls += 1;
          throw new Error("A resumed Auto Import must not create a new plan.");
        },
      },
    );
    await assert.rejects(service.executeAutoImport(item, rule), CatalogFaultInjectedError);
    assert.equal(createPlanCalls, 0);
    assert.equal(planCatalog.operation?.operation.state, "running");
    assert.equal(planCatalog.operation?.items[0]?.status, "running");
    const recovered = await service.executeAutoImport({ ...item, attempts: 2 }, rule);
    assert.equal(recovered.state, "completed", recovered.error ?? "");
    assert.equal(createPlanCalls, 0);
    assert.equal(await fsp.readFile(destinationPath, "utf8"), "same");

    const finalDirectory = await temporaryDirectory();
    try {
      const finalSourcePath = path.join(finalDirectory, "source.jpg");
      const blockedParent = path.join(finalDirectory, "blocked");
      await fsp.writeFile(finalSourcePath, "same");
      await fsp.writeFile(blockedParent, "not-a-directory");
      const finalStat = await fsp.stat(finalSourcePath);
      const finalCatalog = new MemoryCatalog();
      const finalItem: AutoImportQueueItem = {
        ...item,
        queueId: createOperationId(),
        observation: { size: finalStat.size, modifiedAt: finalStat.mtimeMs, localFileId: `${finalStat.dev}:${finalStat.ino}`, observedAt: 2 },
        attempts: 1,
        maxAttempts: 1,
      };
      const finalPlanService = operationService(
        finalCatalog,
        { observe: async (planItem) => planItem.source },
        basicFiles(new MapJournal(), { resolve: async (): Promise<ResolvedTransactionPaths> => ({
          sourcePath: finalSourcePath,
          destinationPath: path.join(blockedParent, "photo.jpg"),
          xmp: null,
        }) }),
      );
      const finalDraft = finalPlanService.prepare({
        operationId: finalItem.queueId,
        catalogId,
        destinationRootId: rule.destinationRootId,
        preset: preset(catalogId),
        sources: [{ source: source(rootId, finalItem.relativePath, finalItem.observation), action: "copy" }],
        now: 10,
      });
      const finalAutoDraft = {
        ...finalDraft,
        items: finalDraft.items.map((planItem) => ({
          ...planItem,
          destinationRelativePath: `library/${planItem.destinationRelativePath}`,
        })),
      };
      const finalFrozen = await finalPlanService.freeze({ draft: finalAutoDraft, review: finalPlanService.review(finalAutoDraft) });
      const finalRule: AutoImportRule = {
        ...rule,
        presetId: finalFrozen.preset.presetId,
        presetVersion: finalFrozen.preset.version,
        presetSha256: finalFrozen.preset.sha256,
      };
      const finalService = operationService(
        finalCatalog,
        { observe: async (planItem) => planItem.source },
        basicFiles(new MapJournal(), { resolve: async (): Promise<ResolvedTransactionPaths> => ({
          sourcePath: finalSourcePath,
          destinationPath: path.join(blockedParent, "photo.jpg"),
          xmp: null,
        }) }),
        { apply: async () => undefined },
        { createPlan: async () => finalFrozen },
      );
      const failed = await finalService.executeAutoImport(finalItem, finalRule);
      assert.equal(failed.state, "failed");
      assert.equal(finalCatalog.operation?.operation.state, "failed");
      assert.equal(finalCatalog.operation?.items[0]?.status, "failed");
    } finally {
      await fsp.rm(finalDirectory, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

class MapJournal implements FileTransactionJournal {
  private readonly records = new Map<string, never>();

  public async read(): Promise<null> {
    return null;
  }

  public async write(): Promise<void> {
    return undefined;
  }

  public async list(): Promise<readonly never[]> {
    return [...this.records.values()];
  }
}
