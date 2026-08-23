import assert from "node:assert/strict";
import test from "node:test";
import {
  createCatalogId,
  createOperationId,
  createPresetId,
  createRootId,
  type CatalogId,
  type PresetId,
  type RootId,
} from "../lib/catalog/ids.ts";
import { parseAutoImportRuleId, type AutoImportFileObservation } from "../lib/import/auto-import.ts";
import type {
  CatalogAutoImportController,
  CatalogAutoImportStatus,
} from "../electron/catalog-auto-import-controller.ts";
import {
  CatalogAutoImportMonitor,
  type CatalogAutoImportMonitorCandidate,
  type CatalogAutoImportMonitorPorts,
  type CatalogAutoImportMonitorTimer,
} from "../electron/catalog-auto-import-monitor.ts";
import {
  AUTO_IMPORT_CAPABILITY,
  parseAutoImportAction,
  parseAutoImportCancelRequest,
  parseAutoImportCapability,
  parseAutoImportConfigureRequest,
  parseAutoImportControlRequest,
  parseAutoImportStatus,
} from "../lib/import/auto-import-api.ts";
import { createSessionId, type SessionId } from "../lib/catalog/runtime.ts";

interface Fixture {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly ingressRootId: RootId;
  readonly destinationRootId: RootId;
  readonly presetId: PresetId;
  readonly ruleId: ReturnType<typeof parseAutoImportRuleId>;
  status: CatalogAutoImportStatus;
  readonly observations: Map<string, readonly AutoImportFileObservation[]>;
  readonly observed: string[];
  readonly enqueued: string[];
  drainCalls: number;
}

class ManualScheduler {
  readonly entries: Array<{ readonly callback: () => void; cancelled: boolean; readonly delayMs: number }> = [];

  schedule(delayMs: number, callback: () => void): CatalogAutoImportMonitorTimer {
    const entry = { callback, cancelled: false, delayMs };
    this.entries.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  }

  fireNext(): void {
    const entry = this.entries.find((candidate) => !candidate.cancelled);
    if (entry === undefined) throw new Error("No scheduled callback.");
    entry.cancelled = true;
    entry.callback();
  }
}

function observation(relativePath: string, observedAt: number, size = 5): AutoImportFileObservation {
  return {
    relativePath,
    readable: true,
    observation: { size, modifiedAt: 10, localFileId: "device:1", observedAt },
  };
}

function fixture(): Fixture {
  const catalogId = createCatalogId();
  const sessionId = createSessionId();
  const ingressRootId = createRootId();
  const destinationRootId = createRootId();
  const presetId = createPresetId();
  const ruleId = parseAutoImportRuleId(createOperationId());
  return {
    catalogId,
    sessionId,
    ingressRootId,
    destinationRootId,
    presetId,
    ruleId,
    status: {
      catalogId,
      state: "ready",
      paused: false,
      degraded: false,
      rule: {
        ruleId,
        enabled: true,
        ingressRootId,
        ingressRelativePath: "watch",
        destinationRootId,
        destinationRelativePath: "library",
        presetId,
        presetVersion: 3,
        presetSha256: "a".repeat(64),
        duplicatePolicy: "continue-unchecked",
        destinationConflictPolicy: "rename",
        stabilityMs: 100,
        maxAttempts: 2,
        retryBackoffMs: 0,
      },
      counts: { total: 0, queued: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 },
      items: [],
    },
    observations: new Map(),
    observed: [],
    enqueued: [],
    drainCalls: 0,
  };
}

function controllerFor(fixtureValue: Fixture): CatalogAutoImportController {
  const controller = {
    status: async () => structuredClone(fixtureValue.status),
    observe: async (first: unknown, second: unknown) => {
      const firstValue = first as AutoImportFileObservation;
      const secondValue = second as AutoImportFileObservation;
      fixtureValue.enqueued.push(`${firstValue.relativePath}:${secondValue.relativePath}`);
      return null;
    },
    drain: async () => {
      fixtureValue.drainCalls += 1;
      return [];
    },
  } as unknown as CatalogAutoImportController;
  return controller;
}

function portsFor(fixtureValue: Fixture, scheduler: ManualScheduler): CatalogAutoImportMonitorPorts {
  return {
    schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
    listCandidates: async (rule) => [{ rootId: rule.ingressRootId, relativePath: "watch/photo.jpg" } satisfies CatalogAutoImportMonitorCandidate],
    observe: async (rootId, relativePath) => {
      fixtureValue.observed.push(`${rootId}:${relativePath}`);
      const values = fixtureValue.observations.get(relativePath) ?? [observation(relativePath, 100), observation(relativePath, 200)];
      return values[Math.min(fixtureValue.observed.filter((value) => value.endsWith(relativePath)).length - 1, values.length - 1)];
    },
  };
}

function monitorFor(fixtureValue: Fixture, scheduler = new ManualScheduler(), now = () => 1_000): CatalogAutoImportMonitor {
  return new CatalogAutoImportMonitor({
    catalogId: fixtureValue.catalogId,
    controller: controllerFor(fixtureValue),
    ports: portsFor(fixtureValue, scheduler),
    maxPending: 10,
    maxCandidates: 10,
    now,
  });
}

test("Auto Import monitor waits for two matching observations and collapses repeated hints", async () => {
  const value = fixture();
  value.observations.set("watch/photo.jpg", [observation("watch/photo.jpg", 100), observation("watch/photo.jpg", 100), observation("watch/photo.jpg", 200)]);
  const scheduler = new ManualScheduler();
  let now = 1_000;
  const monitor = monitorFor(value, scheduler, () => now);
  await monitor.start();
  assert.equal(value.observed.length, 1);
  assert.equal(scheduler.entries[0]?.delayMs, 100);
  now = 1_100;
  await monitor.reconcile([{ kind: "path", relativePath: "watch/photo.jpg" }, { kind: "path", relativePath: "watch/photo.jpg" }]);
  assert.equal(value.observed.length, 2);
  assert.equal(scheduler.entries.filter((entry) => !entry.cancelled).length, 1);
  now = 1_200;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(value.enqueued, ["watch/photo.jpg:watch/photo.jpg"]);
  monitor.close();
});

test("Auto Import monitor does not enqueue a growing file or expose native errors", async () => {
  const value = fixture();
  value.observations.set("watch/photo.jpg", [observation("watch/photo.jpg", 100), observation("watch/photo.jpg", 200, 6)]);
  const scheduler = new ManualScheduler();
  const bounded = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      ...portsFor(value, scheduler),
      observe: async () => { throw new Error("/private/ingress/photo.jpg"); },
    },
    now: () => 1_000,
  });
  await bounded.start();
  assert.equal(value.enqueued.length, 0);
  bounded.close();
});

test("Auto Import monitor rolls a changed observation forward until the file is stable", async () => {
  const value = fixture();
  value.observations.set("watch/photo.jpg", [
    observation("watch/photo.jpg", 100, 5),
    observation("watch/photo.jpg", 200, 6),
    observation("watch/photo.jpg", 300, 6),
  ]);
  const scheduler = new ManualScheduler();
  let now = 1_000;
  const monitor = monitorFor(value, scheduler, () => now);
  await monitor.start();
  now = 1_100;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(value.enqueued.length, 0);
  now = 1_200;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(value.enqueued, ["watch/photo.jpg:watch/photo.jpg"]);
  monitor.close();
});

test("Auto Import monitor retries after an unreadable second observation", async () => {
  const value = fixture();
  value.observations.set("watch/photo.jpg", [
    observation("watch/photo.jpg", 100),
    { ...observation("watch/photo.jpg", 200), readable: false },
    observation("watch/photo.jpg", 300),
  ]);
  const scheduler = new ManualScheduler();
  let now = 1_000;
  const monitor = monitorFor(value, scheduler, () => now);
  await monitor.start();
  now = 1_100;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(value.enqueued.length, 0);
  now = 1_200;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(value.enqueued, ["watch/photo.jpg:watch/photo.jpg"]);
  monitor.close();
});

test("Auto Import monitor drops a deleted candidate after bounded gate retries", async () => {
  const value = fixture();
  const scheduler = new ManualScheduler();
  let now = 1_000;
  let reads = 0;
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
      listCandidates: async (rule) => [{ rootId: rule.ingressRootId, relativePath: "watch/deleted.jpg" }],
      observe: async (_rootId, relativePath) => {
        reads += 1;
        return reads === 1 ? observation(relativePath, 100) : null;
      },
    },
    now: () => now,
  });
  await monitor.start();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    now += 100;
    scheduler.fireNext();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(value.enqueued.length, 0);
  assert.equal(reads, 4);
  assert.equal(scheduler.entries.filter((entry) => !entry.cancelled).length, 0);
  monitor.close();
});

test("Auto Import monitor retries a transiently unreadable first observation", async () => {
  const value = fixture();
  const scheduler = new ManualScheduler();
  let reads = 0;
  let now = 1_000;
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
      listCandidates: async (rule) => [{ rootId: rule.ingressRootId, relativePath: "watch/photo.jpg" }],
      observe: async (_rootId, relativePath) => {
        reads += 1;
        if (reads === 1) return null;
        return observation(relativePath, reads === 2 ? 100 : 200);
      },
    },
    now: () => now,
  });
  await monitor.start();
  assert.equal(reads, 1);
  now = 1_100;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(value.enqueued.length, 0);
  assert.equal(reads, 2);
  now = 1_300;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(value.enqueued, ["watch/photo.jpg:watch/photo.jpg"]);
  monitor.close();
});

test("Auto Import monitor enumerates path hints as directories before direct-file fallback", async () => {
  const value = fixture();
  const scheduler = new ManualScheduler();
  const scopes: string[] = [];
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
      listCandidates: async (rule, dirtyScopes) => {
        const scope = dirtyScopes[0];
        scopes.push(scope?.kind === "path" ? `${scope.kind}:${scope.relativePath}` : scope?.kind ?? "none");
        return scope?.kind === "path" && scope.relativePath === "watch/folder"
          ? [{ rootId: rule.ingressRootId, relativePath: "watch/folder/photo.jpg" }]
          : [];
      },
      observe: async (_rootId, relativePath) => {
        value.observed.push(relativePath);
        return observation(relativePath, 100);
      },
    },
  });
  await monitor.reconcile([{ kind: "path", relativePath: "watch/folder" }]);
  assert.deepEqual(scopes, ["path:watch/folder"]);
  assert.deepEqual(value.observed, ["watch/folder/photo.jpg"]);
  monitor.close();
});

test("Auto Import monitor close cancels late timers and caps enumeration", async () => {
  const value = fixture();
  const scheduler = new ManualScheduler();
  let listCalls = 0;
  let observed = 0;
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    rootId: value.ingressRootId,
    relativePath: `watch/photo-${index}.jpg`,
  }));
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
      listCandidates: async () => { listCalls += 1; return { candidates, overflowed: true }; },
      observe: async (_rootId, relativePath) => {
        observed += 1;
        return observation(relativePath, 100);
      },
    },
    maxCandidates: 3,
    maxPending: 3,
    now: () => 1_000,
  });
  await monitor.start();
  assert.ok(listCalls >= 1);
  assert.equal(monitor.hasEnumerationOverflow, true);
  assert.equal(observed, 3);
  monitor.close();
  for (const entry of scheduler.entries) entry.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observed, 3);
});

test("Auto Import monitor advances past copied overflow candidates on refresh", async () => {
  const value = fixture();
  const scheduler = new ManualScheduler();
  let now = 1_000;
  const reads = new Map<string, number>();
  const candidates = ["watch/photo-0.jpg", "watch/photo-1.jpg", "watch/photo-2.jpg"];
  let page = 0;
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
      listCandidates: async (rule) => {
        page += 1;
        const values = page === 1 ? candidates.slice(0, 2) : candidates.slice(2);
        return {
          candidates: values.map((relativePath) => ({ rootId: rule.ingressRootId, relativePath })),
          overflowed: page === 1,
        };
      },
      observe: async (_rootId, relativePath) => {
        value.observed.push(relativePath);
        const count = (reads.get(relativePath) ?? 0) + 1;
        reads.set(relativePath, count);
        return observation(relativePath, count === 1 ? 100 : 200);
      },
    },
    maxCandidates: 2,
    maxPending: 2,
    now: () => now,
  });
  await monitor.start();
  assert.equal(value.observed.length, 2);
  now = 1_100;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(value.enqueued.length, 2);
  const overflowTimer = scheduler.entries.find((entry) => !entry.cancelled && entry.delayMs === 1_000);
  assert.ok(overflowTimer);
  now = 2_100;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(value.observed.includes("watch/photo-2.jpg"));
  monitor.close();
});

test("Auto Import monitor consumes bounded native pages before applying its pending cap", async () => {
  const value = fixture();
  const scheduler = new ManualScheduler();
  let page = 0;
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
      listCandidates: async (rule) => {
        page += 1;
        const candidates = page === 1
          ? ["watch/page-0.jpg", "watch/page-1.jpg"]
          : ["watch/page-2.jpg"];
        return {
          candidates: candidates.map((relativePath) => ({ rootId: rule.ingressRootId, relativePath })),
          overflowed: page === 1,
        };
      },
      observe: async (_rootId, relativePath) => {
        value.observed.push(relativePath);
        return observation(relativePath, 100);
      },
    },
    maxCandidates: 3,
    maxPending: 3,
  });
  await monitor.start();
  assert.equal(page, 2);
  assert.deepEqual(value.observed.sort(), ["watch/page-0.jpg", "watch/page-1.jpg", "watch/page-2.jpg"]);
  monitor.close();
});

test("Auto Import monitor does not enumerate while disabled or paused and startup drains once", async () => {
  const value = fixture();
  value.status = { ...value.status, state: "paused", paused: true };
  let enumerations = 0;
  const scheduler = new ManualScheduler();
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      ...portsFor(value, scheduler),
      listCandidates: async () => { enumerations += 1; return []; },
    },
  });
  await monitor.start();
  await monitor.reconcile([{ kind: "root" }]);
  assert.equal(enumerations, 0);
  assert.equal(value.drainCalls, 1);
  monitor.close();
});

test("Auto Import API rejects unknown fields and Move while keeping status path-free", () => {
  const value = fixture();
  const config = {
    catalogId: value.catalogId,
    sessionId: value.sessionId,
    ingressRootId: value.ingressRootId,
    ingressRelativePath: "watch",
    destinationRootId: value.destinationRootId,
    destinationRelativePath: "library",
    presetId: value.presetId,
    duplicatePolicy: "continue-unchecked",
    destinationConflictPolicy: "rename",
    stabilityMs: 100,
    maxAttempts: 2,
    retryBackoffMs: 0,
    enabled: true,
  };
  assert.equal(parseAutoImportConfigureRequest(config).action, "copy");
  assert.throws(() => parseAutoImportConfigureRequest({ ...config, destinationConflictPolicy: "replace" }), /unavailable/);
  assert.throws(() => parseAutoImportConfigureRequest({ ...config, duplicatePolicy: "use-existing-location" }), /unavailable/);
  assert.throws(() => parseAutoImportConfigureRequest({ ...config, extra: true }), /unexpected fields/);
  assert.throws(() => parseAutoImportConfigureRequest({ ...config, action: "move" }), /unavailable/);
  assert.throws(() => parseAutoImportAction("move"), /unavailable/);
  assert.deepEqual(parseAutoImportCapability(AUTO_IMPORT_CAPABILITY), AUTO_IMPORT_CAPABILITY);
  assert.equal(parseAutoImportControlRequest({ catalogId: value.catalogId, sessionId: value.sessionId, action: "pause" }).action, "pause");
  assert.equal(parseAutoImportCancelRequest({ catalogId: value.catalogId, sessionId: value.sessionId, queueId: createOperationId() }).catalogId, value.catalogId);
  assert.throws(() => parseAutoImportCapability({ ...AUTO_IMPORT_CAPABILITY, extra: true }), /unexpected fields/);
  assert.throws(() => parseAutoImportStatus({
    ...value.status,
    items: [],
    counts: value.status.counts,
    rule: { ...value.status.rule!, ingressRelativePath: "/private/native" },
  }), /relative/);
});

test("Auto Import monitor restarts by draining durable work without duplicating completed work", async () => {
  const value = fixture();
  value.status = { ...value.status, items: [{
    queueId: createOperationId(),
    ruleId: value.ruleId,
    relativePath: "watch/done.jpg",
    state: "completed",
    attempts: 1,
    maxAttempts: 2,
    nextAttemptAt: 0,
    leaseUntil: null,
    createdAt: 1,
    updatedAt: 2,
    error: null,
  }], counts: { total: 1, queued: 0, claimed: 0, completed: 1, failed: 0, cancelled: 0 }};
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller: controllerFor(value),
    ports: {
      listCandidates: async () => [],
      observe: async () => observation("watch/done.jpg", 1),
    },
  });
  await monitor.start();
  assert.equal(value.drainCalls, 1);
  assert.equal(value.enqueued.length, 0);
  monitor.close();
});

test("Auto Import monitor retries queued failures at nextAttemptAt", async () => {
  const value = fixture();
  const queueId = createOperationId();
  value.status = {
    ...value.status,
    items: [{
      queueId,
      ruleId: value.ruleId,
      relativePath: "watch/retry.jpg",
      state: "queued",
      attempts: 1,
      maxAttempts: 2,
      nextAttemptAt: 1_500,
      leaseUntil: null,
      createdAt: 1,
      updatedAt: 2,
      error: { code: "execution-failed", message: "Auto Import execution failed." },
    }],
    counts: { total: 1, queued: 1, claimed: 0, completed: 0, failed: 0, cancelled: 0 },
  };
  const scheduler = new ManualScheduler();
  let now = 1_000;
  let drains = 0;
  const controller = {
    status: async () => structuredClone(value.status),
    drain: async () => {
      drains += 1;
      if (drains > 1) {
        value.status = {
          ...value.status,
          items: value.status.items.map((item) => ({ ...item, state: "completed", error: null })),
          counts: { total: 1, queued: 0, claimed: 0, completed: 1, failed: 0, cancelled: 0 },
        };
      }
      return [];
    },
  } as unknown as CatalogAutoImportController;
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller,
    ports: {
      schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
      listCandidates: async () => [],
      observe: async () => null,
    },
    now: () => now,
  });
  await monitor.start();
  assert.equal(drains, 1);
  const retry = scheduler.entries.find((entry) => !entry.cancelled);
  assert.equal(retry?.delayMs, 500);
  now = 1_500;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drains, 2);
  assert.equal(scheduler.entries.filter((entry) => !entry.cancelled).length, 0);
  monitor.close();
});

test("Auto Import monitor schedules a claimed lease recovery after restart", async () => {
  const value = fixture();
  const queueId = createOperationId();
  value.status = {
    ...value.status,
    items: [{
      queueId,
      ruleId: value.ruleId,
      relativePath: "watch/claimed.jpg",
      state: "claimed",
      attempts: 1,
      maxAttempts: 2,
      nextAttemptAt: 0,
      leaseUntil: 1_500,
      createdAt: 1,
      updatedAt: 2,
      error: null,
    }],
    counts: { total: 1, queued: 0, claimed: 1, completed: 0, failed: 0, cancelled: 0 },
  };
  const scheduler = new ManualScheduler();
  let now = 1_000;
  let drains = 0;
  const controller = {
    status: async () => structuredClone(value.status),
    drain: async () => {
      drains += 1;
      if (drains > 1) {
        value.status = {
          ...value.status,
          items: value.status.items.map((item) => ({ ...item, state: "completed", leaseUntil: null })),
          counts: { total: 1, queued: 0, claimed: 0, completed: 1, failed: 0, cancelled: 0 },
        };
      }
      return [];
    },
  } as unknown as CatalogAutoImportController;
  const monitor = new CatalogAutoImportMonitor({
    catalogId: value.catalogId,
    controller,
    ports: {
      schedule: (delayMs, callback) => scheduler.schedule(delayMs, callback),
      listCandidates: async () => [],
      observe: async () => null,
    },
    now: () => now,
  });
  await monitor.start();
  assert.equal(scheduler.entries.find((entry) => !entry.cancelled)?.delayMs, 500);
  now = 1_500;
  scheduler.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drains, 2);
  monitor.close();
});
