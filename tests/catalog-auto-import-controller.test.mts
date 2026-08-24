import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCatalogId,
  createPresetId,
  createRootId,
  type CatalogId,
  type PresetId,
  type RootId,
} from "../lib/catalog/ids.ts";
import { canonicalJson } from "../lib/import/domain.ts";
import type { AutoImportQueueItem, AutoImportRule } from "../lib/import/auto-import.ts";
import {
  CatalogAutoImportController,
  type CatalogAutoImportExecutor,
  type CatalogAutoImportPresetSnapshot,
  type CatalogAutoImportResolver,
  type CatalogAutoImportRootSnapshot,
} from "../electron/catalog-auto-import-controller.ts";
import { createAutoImportStore } from "../electron/auto-import-store.ts";

interface Fixture {
  readonly catalogId: CatalogId;
  readonly ingressRootId: RootId;
  readonly destinationRootId: RootId;
  readonly presetId: PresetId;
  readonly directory: string;
  readonly roots: Map<RootId, CatalogAutoImportRootSnapshot>;
  readonly presets: Map<PresetId, CatalogAutoImportPresetSnapshot>;
}

interface ExecutorHarness extends CatalogAutoImportExecutor {
  readonly calls: Array<{
    readonly item: AutoImportQueueItem;
    readonly rule: AutoImportRule;
    readonly isCancelled: () => boolean;
  }>;
  behavior: "complete" | "fail" | "wait" | "retryable";
  release: (() => void) | null;
}

async function fixture(): Promise<Fixture> {
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-auto-controller-")));
  const catalogId = createCatalogId();
  const ingressRootId = createRootId();
  const destinationRootId = createRootId();
  const presetId = createPresetId();
  const roots = new Map<RootId, CatalogAutoImportRootSnapshot>([
    [ingressRootId, { catalogId, rootId: ingressRootId, canonicalPath: path.join(directory, "ingress") }],
    [destinationRootId, { catalogId, rootId: destinationRootId, canonicalPath: path.join(directory, "destination") }],
  ]);
  const presets = new Map<PresetId, CatalogAutoImportPresetSnapshot>([
    [presetId, {
      catalogId,
      presetId,
      name: "Import defaults",
      version: 4,
      template: { pattern: "{{filename}}" },
      payload: { title: "first", keywords: ["one"] },
      updatedAt: 4,
    }],
  ]);
  return { catalogId, ingressRootId, destinationRootId, presetId, directory, roots, presets };
}

function resolverFor(fixtureValue: Fixture): CatalogAutoImportResolver {
  return {
    resolveRoot: async ({ rootId }) => fixtureValue.roots.get(rootId) ?? null,
    resolvePreset: async ({ presetId }) => fixtureValue.presets.get(presetId) ?? null,
  };
}

function executorFor(): ExecutorHarness {
  const harness: ExecutorHarness = {
    calls: [],
    behavior: "complete",
    release: null,
    executeAutoImport: async (item, rule, options) => {
      harness.calls.push({ item, rule, isCancelled: options.isCancelled ?? (() => false) });
      if (harness.behavior === "fail") throw new Error("/private/native/source/photo.jpg");
      if (harness.behavior === "wait") {
        await new Promise<void>((resolve) => { harness.release = resolve; });
      }
      if (harness.behavior === "retryable") {
        return {
          operationId: item.queueId,
          state: "failed",
          items: [],
          error: "journal acknowledgement was lost",
          retryable: true,
        };
      }
      return {
        operationId: item.queueId,
        state: options.isCancelled?.() === true ? "cancelled" : "completed",
        items: [],
        error: null,
      };
    },
  };
  return harness;
}

function observation(
  relativePath: string,
  observedAt: number,
  size = 4,
  modifiedAt = 10,
): { readonly relativePath: string; readonly observation: { readonly size: number; readonly modifiedAt: number; readonly localFileId: string; readonly observedAt: number }; readonly readable: boolean } {
  return {
    relativePath,
    observation: { size, modifiedAt, localFileId: "device:1", observedAt },
    readable: true,
  };
}

function configureInput(fixtureValue: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ingressRootId: fixtureValue.ingressRootId,
    ingressRelativePath: "watch",
    destinationRootId: fixtureValue.destinationRootId,
    destinationRelativePath: "library",
    presetId: fixtureValue.presetId,
    duplicatePolicy: "continue-unchecked",
    destinationConflictPolicy: "rename",
    stabilityMs: 100,
    maxAttempts: 2,
    retryBackoffMs: 0,
    enabled: true,
    ...overrides,
  };
}

function controllerFor(
  fixtureValue: Fixture,
  stateDirectory: string,
  executor: ExecutorHarness,
  now = 1_000,
  leaseMs = 30,
): CatalogAutoImportController {
  return new CatalogAutoImportController({
    catalogId: fixtureValue.catalogId,
    store: createAutoImportStore(stateDirectory),
    resolver: resolverFor(fixtureValue),
    executor,
    now: () => now,
    leaseMs,
  });
}

test("Auto Import controller enforces Copy-only overlap rules and freezes preset hash", async () => {
  const fixtureValue = await fixture();
  try {
    const store = createAutoImportStore(fixtureValue.directory);
    const executor = executorFor();
    const controller = new CatalogAutoImportController({
      catalogId: fixtureValue.catalogId,
      store,
      resolver: resolverFor(fixtureValue),
      executor,
    });
    const overlapRootId = createRootId();
    fixtureValue.roots.set(overlapRootId, {
      catalogId: fixtureValue.catalogId,
      rootId: overlapRootId,
      canonicalPath: fixtureValue.roots.get(fixtureValue.ingressRootId)!.canonicalPath,
    });
    await assert.rejects(
      controller.configure({
        ...configureInput(fixtureValue),
        ingressRootId: overlapRootId,
        destinationRootId: overlapRootId,
        destinationRelativePath: "watch/library",
      }),
      /overlap/,
    );
    await assert.rejects(
      controller.configure({ ...configureInput(fixtureValue), destinationConflictPolicy: "replace" }),
      /unavailable/,
    );
    const rule = await controller.configure(configureInput(fixtureValue));
    assert.equal(rule.placement, "copy");
    const expectedHash = createHash("sha256").update(canonicalJson({
      catalogId: fixtureValue.catalogId,
      presetId: fixtureValue.presetId,
      name: "Import defaults",
      version: 4,
      template: { pattern: "{{filename}}" },
      payload: { title: "first", keywords: ["one"] },
      updatedAt: 4,
    }), "utf8").digest("hex");
    assert.equal(rule.presetSha256, expectedHash);
    fixtureValue.presets.set(fixtureValue.presetId, {
      ...fixtureValue.presets.get(fixtureValue.presetId)!,
      version: 5,
      payload: { title: "changed" },
    });
    const status = await controller.status();
    assert.equal(status.rule?.presetVersion, 4);
    assert.equal(status.rule?.presetSha256, expectedHash);
    assert.equal(status.rule?.ingressRelativePath.includes(fixtureValue.directory), false);
  } finally {
    await fsp.rm(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("Auto Import controller gates stability, deduplicates observations, and persists pause/disable", async () => {
  const fixtureValue = await fixture();
  try {
    const executor = executorFor();
    const controller = controllerFor(fixtureValue, fixtureValue.directory, executor);
    await controller.configure(configureInput(fixtureValue));
    assert.equal(await controller.observe(observation("watch/photo.jpg", 1), observation("watch/photo.jpg", 50)), null);
    assert.equal(await controller.observe({ ...observation("watch/photo.jpg", 1), readable: false }, observation("watch/photo.jpg", 150)), null);
    await controller.pause();
    assert.equal(await controller.observe(observation("watch/photo.jpg", 1), observation("watch/photo.jpg", 150)), null);
    await controller.resume();
    const item = await controller.observe(observation("watch/photo.jpg", 1), observation("watch/photo.jpg", 150));
    assert.ok(item);
    const duplicate = await controller.observe(observation("watch/photo.jpg", 1), observation("watch/photo.jpg", 150));
    assert.equal(duplicate?.queueId, item.queueId);
    await controller.disable();
    const status = await controller.status();
    assert.equal(status.state, "disabled");
    assert.equal(status.counts.cancelled, 1);
    assert.equal(status.counts.queued, 0);
    await controller.enable();
    const replacement = await controller.observe(observation("watch/photo.jpg", 1), observation("watch/photo.jpg", 150));
    assert.ok(replacement);
    assert.notEqual(replacement?.queueId, item.queueId);
  } finally {
    await fsp.rm(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("Auto Import controller drains through the shared executor and keeps sanitized failures retryable", async () => {
  const fixtureValue = await fixture();
  try {
    const executor = executorFor();
    const controller = controllerFor(fixtureValue, fixtureValue.directory, executor);
    await controller.configure(configureInput(fixtureValue, { maxAttempts: 1 }));
    const item = await controller.observe(observation("watch/photo.jpg", 1), observation("watch/photo.jpg", 150));
    assert.ok(item);
    const result = await controller.drain();
    assert.equal(result[0]?.state, "completed");
    assert.equal(executor.calls[0]?.rule.presetVersion, 4);
    assert.equal(executor.calls[0]?.rule.destinationConflictPolicy, "rename");

    executor.behavior = "fail";
    const failedItem = await controller.observe(observation("watch/failed.jpg", 2), observation("watch/failed.jpg", 151));
    assert.ok(failedItem);
    const failed = await controller.drain();
    assert.equal(failed[0]?.state, "failed");
    const failedStatus = await controller.status();
    const failedRow = failedStatus.items.find((candidate) => candidate.queueId === failedItem.queueId);
    assert.equal(failedRow?.error?.code, "execution-failed");
    assert.equal(failedRow?.error?.message.includes("/private"), false);
    const persisted = await createAutoImportStore(fixtureValue.directory).load();
    const persistedItem = persisted.queue.list().find((candidate) => candidate.queueId === failedItem.queueId);
    assert.equal(persistedItem?.error, "execution-failed");
    assert.equal(persistedItem?.error?.includes("/private"), false);

    executor.behavior = "complete";
    await controller.retryFailed();
    const replacement = (await controller.status()).items.find((candidate) => candidate.state === "queued");
    assert.ok(replacement);
    assert.notEqual(replacement?.queueId, failedItem.queueId);
    const retried = await controller.drain();
    assert.equal(retried[0]?.state, "completed");
    await controller.clearFailed();
    assert.equal((await controller.status()).counts.failed, 0);
  } finally {
    await fsp.rm(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("Auto Import controller cancellation is cooperative and restart reclaims expired leases", async () => {
  const fixtureValue = await fixture();
  try {
    const executor = executorFor();
    const controller = controllerFor(fixtureValue, fixtureValue.directory, executor, 1_000, 10);
    await controller.configure(configureInput(fixtureValue));
    const item = await controller.observe(observation("watch/cancel.jpg", 1), observation("watch/cancel.jpg", 150));
    assert.ok(item);
    executor.behavior = "wait";
    const draining = controller.drain();
    while (executor.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await controller.cancel(item.queueId);
    executor.release?.();
    const cancelled = await draining;
    assert.equal(cancelled[0]?.state, "cancelled");
    assert.equal((await controller.status()).counts.cancelled, 1);

    const restartExecutor = executorFor();
    let restartNow = 2_000;
    const restartController = new CatalogAutoImportController({
      catalogId: fixtureValue.catalogId,
      store: createAutoImportStore(fixtureValue.directory),
      resolver: resolverFor(fixtureValue),
      executor: restartExecutor,
      now: () => restartNow,
      leaseMs: 10,
    });
    const restartItem = await restartController.observe(observation("watch/restart.jpg", 2), observation("watch/restart.jpg", 151));
    assert.ok(restartItem);
    const claimed = await createAutoImportStore(fixtureValue.directory).claimNext(2_000, 10);
    assert.equal(claimed?.queueId, restartItem.queueId);
    restartNow = 2_020;
    const recovered = await restartController.drain();
    assert.equal(recovered[0]?.queueId, restartItem.queueId);
    assert.equal(recovered[0]?.state, "completed");
  } finally {
    await fsp.rm(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("Auto Import controller dispose cancels an in-flight executor", async () => {
  const fixtureValue = await fixture();
  try {
    const executor = executorFor();
    const controller = controllerFor(fixtureValue, fixtureValue.directory, executor);
    await controller.configure(configureInput(fixtureValue));
    const item = await controller.observe(observation("watch/dispose.jpg", 1), observation("watch/dispose.jpg", 150));
    assert.ok(item);
    executor.behavior = "wait";
    const draining = controller.drain();
    while (executor.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.dispose();
    executor.release?.();
    const result = await draining;
    assert.equal(result[0]?.state, "cancelled");
  } finally {
    await fsp.rm(fixtureValue.directory, { recursive: true, force: true });
  }
});

test("Auto Import keeps an ambiguous final attempt queued for same-operation recovery", async () => {
  const fixtureValue = await fixture();
  try {
    const firstExecutor = executorFor();
    const firstController = controllerFor(fixtureValue, fixtureValue.directory, firstExecutor);
    await firstController.configure(configureInput(fixtureValue, { maxAttempts: 1 }));
    const queued = await firstController.observe(
      observation("watch/ambiguous.jpg", 1),
      observation("watch/ambiguous.jpg", 150),
    );
    assert.ok(queued);
    firstExecutor.behavior = "retryable";
    const first = await firstController.drain();
    assert.equal(first[0]?.queueId, queued.queueId);
    assert.equal(first[0]?.state, "queued");
    const afterAmbiguous = await createAutoImportStore(fixtureValue.directory).load();
    const persisted = afterAmbiguous.queue.list()[0];
    assert.equal(persisted?.queueId, queued.queueId);
    assert.equal(persisted?.state, "queued");
    assert.equal(persisted?.attempts, 1);
    assert.equal(persisted?.recoveryRequired, true);

    const restartedExecutor = executorFor();
    const restarted = controllerFor(fixtureValue, fixtureValue.directory, restartedExecutor, 2_000);
    const recovered = await restarted.drain();
    assert.equal(recovered[0]?.queueId, queued.queueId);
    assert.equal(recovered[0]?.state, "completed");
    await restarted.retryFailed();
    const finalStatus = await restarted.status();
    assert.equal(finalStatus.counts.failed, 0);
    assert.equal(finalStatus.counts.completed, 1);
    assert.deepEqual(finalStatus.items.map((item) => item.queueId), [queued.queueId]);
  } finally {
    await fsp.rm(fixtureValue.directory, { recursive: true, force: true });
  }
});
