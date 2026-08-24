import assert from "node:assert/strict";
import test from "node:test";
import { CatalogWorkLifecycle, type CatalogWorkToken } from "../electron/catalog-work-lifecycle.ts";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("starts reject immediately while a transition is paused", async () => {
  const task = deferred<void>();
  const lifecycle = new CatalogWorkLifecycle();
  const transition = lifecycle.transition(() => task.promise, async () => undefined);
  assert.throws(() => lifecycle.assertOpen(), /transition/);
  let lateStart = false;
  assert.throws(() => lifecycle.track("fingerprint", async () => {
    lateStart = true;
  }), /transition/);
  assert.equal(lateStart, false);
  task.resolve();
  await transition;
  lifecycle.assertOpen();
});

test("queued transitions stay closed and recover only after the final task", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const recoveries: string[] = [];
  const lifecycle = new CatalogWorkLifecycle();
  const firstTransition = lifecycle.transition(async () => {
    assert.throws(() => lifecycle.assertOpen(), /transition/);
    await first.promise;
  }, async () => {
    recoveries.push("first");
  });
  const secondTransition = lifecycle.transition(async () => {
    assert.throws(() => lifecycle.assertOpen(), /transition/);
    await second.promise;
  }, async () => {
    recoveries.push("second");
  });
  first.resolve();
  await firstTransition;
  assert.deepEqual(recoveries, []);
  assert.throws(() => lifecycle.assertOpen(), /transition/);
  second.resolve();
  await secondTransition;
  assert.deepEqual(recoveries, ["second"]);
  lifecycle.assertOpen();
});

test("a blocked fingerprint delays the transition until cancellation settles it", async () => {
  const fingerprint = deferred<void>();
  const fingerprintTokens: CatalogWorkToken[] = [];
  let taskStarted = false;
  const lifecycle = new CatalogWorkLifecycle();
  const run = lifecycle.track("fingerprint", async (token) => {
    fingerprintTokens.push(token);
    await fingerprint.promise;
    assert.equal(token.isCancelled(), true);
  });
  const transition = lifecycle.transition(async () => {
    taskStarted = true;
  }, async () => undefined);
  await Promise.resolve();
  assert.equal(taskStarted, false);
  const token = fingerprintTokens[0];
  if (token === undefined) throw new Error("Fingerprint token was not registered.");
  assert.equal(token.isCancelled(), true);
  fingerprint.resolve();
  await run;
  await transition;
  assert.equal(taskStarted, true);
});

test("shutdown waits for transition and work without recovery", async () => {
  const fingerprint = deferred<void>();
  const transitionTask = deferred<void>();
  let recovered = false;
  let drainedBindings = false;
  const lifecycle = new CatalogWorkLifecycle({
    drainBindings: async () => {
      drainedBindings = true;
    },
  });
  const run = lifecycle.track("fingerprint", async (token) => {
    await fingerprint.promise;
    assert.equal(token.isCancelled(), true);
  });
  const transition = lifecycle.transition(() => transitionTask.promise, async () => {
    recovered = true;
  });
  const shutdown = lifecycle.shutdown();
  let shutdownSettled = false;
  void shutdown.then(() => {
    shutdownSettled = true;
  });
  await Promise.resolve();
  assert.equal(shutdownSettled, false);
  fingerprint.resolve();
  await run;
  assert.equal(shutdownSettled, false);
  transitionTask.resolve();
  await transition;
  await shutdown;
  assert.equal(recovered, false);
  assert.equal(drainedBindings, true);
  assert.throws(() => lifecycle.assertOpen(), /shutdown/);
});
