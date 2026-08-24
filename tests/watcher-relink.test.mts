import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssetId,
  createCatalogId,
  createOperationId,
  createRootId,
} from "../lib/catalog/ids.ts";
import {
  applyRelinkDraft,
  cancelRelinkDraft,
  planRelink,
  type RelinkCandidate,
  type RelinkMissingAsset,
  type RelinkPlanInput,
} from "../lib/catalog/relink.ts";
import {
  WatcherReconciliationService,
  type WatchAdapter,
  type WatchAdapterCallbacks,
  type WatchHandle,
  type WatchReconcileAdapter,
  type WatchReconcileCommitInput,
  type WatchReconcileInput,
  type WatchReconcileResult,
  type WatchRootInput,
  type WatchSessionInput,
  type WatchTimerAdapter,
  type WatchTimerHandle,
} from "../electron/watcher-reconciliation.ts";
import type { CatalogWatchEvent } from "../lib/catalog/watch.ts";
import { createSessionId, type CatalogId, type RootId, type SessionId } from "../lib/catalog/runtime.ts";

interface OpenWatch {
  readonly nativePath: string;
  readonly callbacks: WatchAdapterCallbacks;
  closed: boolean;
}

class FakeWatchAdapter implements WatchAdapter {
  readonly opened: OpenWatch[] = [];
  failOpenCode: string | null = null;

  open(nativePath: string, callbacks: WatchAdapterCallbacks): WatchHandle {
    if (this.failOpenCode !== null) {
      const code = this.failOpenCode;
      this.failOpenCode = null;
      throw Object.assign(new Error(code), { code });
    }
    const watch: OpenWatch = { nativePath, callbacks, closed: false };
    this.opened.push(watch);
    return {
      close: () => {
        watch.closed = true;
      },
    };
  }

  emit(index: number, filename: string | null, eventType: "rename" | "change" = "change"): void {
    const watch = this.opened[index];
    if (watch === undefined || watch.closed) throw new Error("Watch is not open.");
    watch.callbacks.onEvent({ eventType, filename });
  }

  error(index: number, error: unknown): void {
    const watch = this.opened[index];
    if (watch === undefined || watch.closed) throw new Error("Watch is not open.");
    watch.callbacks.onError(error);
  }
}

interface ScheduledTimer {
  readonly handle: WatchTimerHandle;
  readonly delayMs: number;
  readonly callback: () => void;
}

class FakeTimerAdapter implements WatchTimerAdapter {
  readonly scheduled: ScheduledTimer[] = [];
  private nextId = 0;

  schedule(delayMs: number, callback: () => void): WatchTimerHandle {
    const handle = { id: `timer-${this.nextId++}` };
    this.scheduled.push({ handle, delayMs, callback });
    return handle;
  }

  cancel(handle: WatchTimerHandle): void {
    const item = this.scheduled.find((scheduled) => scheduled.handle.id === handle.id);
    if (item !== undefined) this.scheduled.splice(this.scheduled.indexOf(item), 1);
  }

  runNext(): number {
    const item = this.scheduled.shift();
    if (item === undefined) throw new Error("No timer is scheduled.");
    item.callback();
    return item.delayMs;
  }
}

class FakeReconcileAdapter implements WatchReconcileAdapter {
  readonly calls: WatchReconcileInput[] = [];
  readonly commits: WatchReconcileCommitInput[] = [];
  deferred: Promise<WatchReconcileResult> | null = null;
  failCode: string | null = null;

  async reconcile(input: WatchReconcileInput): Promise<WatchReconcileResult> {
    this.calls.push(input);
    if (this.failCode !== null) {
      const code = this.failCode;
      this.failCode = null;
      throw Object.assign(new Error(code), { code });
    }
    if (this.deferred !== null) return this.deferred;
    return { status: "completed", diff: { scope: input.scope, changedCount: 1 } };
  }

  async commit(input: WatchReconcileCommitInput): Promise<void> {
    this.commits.push(input);
  }
}

function sessionFixture(): {
  readonly input: WatchSessionInput;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly roots: readonly [WatchRootInput, WatchRootInput];
} {
  const catalogId = createCatalogId();
  const sessionId = createSessionId();
  const roots = [
    { catalogId, sessionId, rootId: createRootId(), nativePath: "/catalog/one" },
    { catalogId, sessionId, rootId: createRootId(), nativePath: "/catalog/two" },
  ] as const;
  return { input: { catalogId, sessionId, roots }, catalogId, sessionId, roots };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("watch bursts debounce, collapse, and stay isolated per root", async () => {
  const fixture = sessionFixture();
  const watchAdapter = new FakeWatchAdapter();
  const timers = new FakeTimerAdapter();
  const reconcile = new FakeReconcileAdapter();
  const events: CatalogWatchEvent[] = [];
  const service = new WatcherReconciliationService({
    watchAdapter,
    timerAdapter: timers,
    reconcileAdapter: reconcile,
    debounceMs: 25,
  });
  service.subscribe((event) => events.push(event));
  service.activateSession(fixture.input);
  assert.equal(watchAdapter.opened.length, 2);

  watchAdapter.emit(0, "folder/photo.jpg");
  watchAdapter.emit(0, "folder/other.jpg");
  watchAdapter.emit(0, "folder");
  watchAdapter.emit(1, "other.jpg", "rename");
  assert.equal(reconcile.calls.length, 0);
  assert.equal(timers.scheduled.length, 2);

  const delays = [timers.runNext(), timers.runNext()];
  await flush();
  assert.deepEqual(delays, [25, 25]);
  assert.equal(reconcile.calls.length, 2);
  assert.deepEqual(
    reconcile.calls.map((call) => ({ rootId: call.rootId, scope: call.scope })),
    [
      { rootId: fixture.roots[0].rootId, scope: { kind: "path", relativePath: "folder" } },
      { rootId: fixture.roots[1].rootId, scope: { kind: "path", relativePath: "other.jpg" } },
    ],
  );
  assert.equal(reconcile.commits.length, 2);
  assert.ok(events.some((event) => event.kind === "reconcile-completed"));
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.equal(service.getRootStates().every((state) => state.status === "active"), true);
});

test("watcher errors expose permission state and retry with bounded backoff", () => {
  const fixture = sessionFixture();
  const watchAdapter = new FakeWatchAdapter();
  const timers = new FakeTimerAdapter();
  const reconcile = new FakeReconcileAdapter();
  watchAdapter.failOpenCode = "EACCES";
  const service = new WatcherReconciliationService({
    watchAdapter,
    timerAdapter: timers,
    reconcileAdapter: reconcile,
    debounceMs: 10,
    maxRetryDelayMs: 15,
    maxRetryAttempts: 2,
  });
  const events: CatalogWatchEvent[] = [];
  service.subscribe((event) => events.push(event));
  service.activateSession({ ...fixture.input, roots: [fixture.roots[0]] });
  assert.equal(service.getRootStates()[0]?.status, "permission-denied");
  assert.equal(timers.scheduled[0]?.delayMs, 10);
  timers.runNext();
  assert.equal(service.getRootStates()[0]?.status, "active");
  assert.ok(events.some((event) => event.kind === "watch-state" && "status" in event.payload && event.payload.status === "permission-denied"));
  assert.ok(events.some((event) => event.kind === "watch-state" && "status" in event.payload && event.payload.status === "active"));
});

test("watch hints retain recognized but unavailable formats", async () => {
  const fixture = sessionFixture();
  const watchAdapter = new FakeWatchAdapter();
  const timers = new FakeTimerAdapter();
  const reconcile = new FakeReconcileAdapter();
  const service = new WatcherReconciliationService({
    watchAdapter,
    timerAdapter: timers,
    reconcileAdapter: reconcile,
    debounceMs: 1,
  });
  service.activateSession({ ...fixture.input, roots: [fixture.roots[0]] });
  watchAdapter.emit(0, "camera.dng");
  timers.runNext();
  await flush();
  assert.deepEqual(reconcile.calls[0]?.scope, { kind: "path", relativePath: "camera.dng" });
});

test("session switch closes old watchers, aborts reconcile, and suppresses late commits", async () => {
  const first = sessionFixture();
  const secondCatalog = createCatalogId();
  const secondSession = createSessionId();
  const secondRoot: WatchRootInput = {
    catalogId: secondCatalog,
    sessionId: secondSession,
    rootId: createRootId(),
    nativePath: "/catalog/second",
  };
  const watchAdapter = new FakeWatchAdapter();
  const timers = new FakeTimerAdapter();
  const reconcile = new FakeReconcileAdapter();
  let resolveReconcile: ((result: WatchReconcileResult) => void) | undefined;
  reconcile.deferred = new Promise<WatchReconcileResult>((resolve) => {
    resolveReconcile = resolve;
  });
  const service = new WatcherReconciliationService({
    watchAdapter,
    timerAdapter: timers,
    reconcileAdapter: reconcile,
    debounceMs: 1,
  });
  const events: CatalogWatchEvent[] = [];
  service.subscribe((event) => events.push(event));
  service.activateSession({ ...first.input, roots: [first.roots[0]] });
  watchAdapter.emit(0, "photo.jpg");
  timers.runNext();
  await flush();
  assert.equal(reconcile.calls.length, 1);
  const oldController = reconcile.calls[0]?.signal;
  service.activateSession({ catalogId: secondCatalog, sessionId: secondSession, roots: [secondRoot] });
  assert.equal(watchAdapter.opened[0]?.closed, true);
  assert.equal(oldController?.aborted, true);
  resolveReconcile?.({ status: "completed", diff: { scope: { kind: "path", relativePath: "photo.jpg" }, changedCount: 1 } });
  await flush();
  assert.equal(reconcile.commits.length, 0);
  assert.equal(events.some((event) => event.catalogId === first.catalogId && event.sequence > 3), false);
  assert.equal(service.getRootStates()[0]?.catalogId, secondCatalog);
});

function observation(byteLength: number, modifiedAt: number, localFileId: string | null = null) {
  return { byteLength, modifiedAt, localFileId };
}

function missingAsset(
  assetId: ReturnType<typeof createAssetId>,
  rootId: RootId,
  relativePath: string,
  fingerprint: { readonly status: "missing" | "valid"; readonly sha256: string | null },
  assetObservation: ReturnType<typeof observation> | null,
): RelinkMissingAsset {
  return {
    assetId,
    rootId,
    relativePath,
    filename: relativePath.split("/").at(-1)!,
    observation: assetObservation,
    fingerprint,
  };
}

function candidate(
  candidateId: string,
  rootId: RootId,
  relativePath: string,
  fingerprint: { readonly status: "missing" | "valid"; readonly sha256: string | null },
  candidateObservation: ReturnType<typeof observation>,
): RelinkCandidate {
  return {
    candidateId,
    rootId,
    relativePath,
    filename: relativePath.split("/").at(-1)!,
    observation: candidateObservation,
    fingerprint,
  };
}

function relinkFixture(): RelinkPlanInput {
  const catalogId = createCatalogId();
  const sessionId = createSessionId();
  const operationId = createOperationId();
  const rootId = createRootId();
  const exactHash = "a".repeat(64);
  return {
    catalogId,
    sessionId,
    operationId,
    missingAssets: [
      missingAsset(createAssetId(), rootId, "old/exact.jpg", { status: "valid", sha256: exactHash }, observation(10, 1)),
      missingAsset(createAssetId(), rootId, "old/local.jpg", { status: "missing", sha256: null }, observation(11, 2, "local-2")),
      missingAsset(createAssetId(), rootId, "old/relative.jpg", { status: "missing", sha256: null }, observation(12, 3)),
      missingAsset(createAssetId(), rootId, "old/name.jpg", { status: "missing", sha256: null }, observation(13, 4)),
    ],
    candidates: [
      candidate("hash", rootId, "new/exact.jpg", { status: "valid", sha256: exactHash }, observation(10, 99)),
      candidate("local", rootId, "new/local.jpg", { status: "missing", sha256: null }, observation(11, 8, "local-2")),
      candidate("relative", rootId, "old/relative.jpg", { status: "missing", sha256: null }, observation(12, 3)),
      candidate("name-a", rootId, "a/name.jpg", { status: "missing", sha256: null }, observation(13, 9)),
      candidate("name-b", rootId, "b/name.jpg", { status: "missing", sha256: null }, observation(13, 10)),
    ],
  };
}

test("relink ranking preselects only exact hashes and preserves lower-confidence suggestions", () => {
  const input = relinkFixture();
  const draft = planRelink(input);
  assert.equal(draft.preselectedPairs.length, 1);
  assert.equal(draft.preselectedPairs[0]?.candidateId, "hash");
  assert.deepEqual(
    draft.suggestions.map((suggestion) => ({ rank: suggestion.rank, candidates: suggestion.candidateIds, preselected: suggestion.preselectedCandidateId })),
    [
      { rank: "exact-sha256", candidates: ["hash"], preselected: "hash" },
      { rank: "local-file-identity", candidates: ["local"], preselected: null },
      { rank: "relative-observation", candidates: ["relative"], preselected: null },
      { rank: "filename-size", candidates: ["name-a", "name-b"], preselected: null },
    ],
  );
  assert.equal(draft.ambiguousAssetCount, 1);
  const applied = applyRelinkDraft(draft, [
    { assetId: input.missingAssets[1]!.assetId, candidateId: "local" },
    { assetId: input.missingAssets[2]!.assetId, candidateId: "relative" },
  ]);
  assert.deepEqual(applied.acceptedPairs.map((pair) => pair.candidateId), ["hash", "local", "relative"]);
  assert.equal(applied.unresolvedAssetCount, 1);
  assert.equal(applied.unresolvedCandidateCount, 2);
  assert.equal(applied.operationId, input.operationId);
});

test("duplicate candidates, ties, and reused candidates remain unresolved", () => {
  const input = relinkFixture();
  const target = input.missingAssets[1]!;
  const duplicateInput: RelinkPlanInput = {
    ...input,
    missingAssets: [
      target,
      missingAsset(createAssetId(), target.rootId, "other/local.jpg", { status: "missing", sha256: null }, observation(11, 2, "local-2")),
    ],
    candidates: [input.candidates[1]!],
  };
  const draft = planRelink(duplicateInput);
  assert.equal(draft.preselectedPairs.length, 0);
  assert.equal(draft.suggestions.every((suggestion) => suggestion.candidateIds.length === 1), true);
  assert.throws(
    () => applyRelinkDraft(draft, [
      { assetId: duplicateInput.missingAssets[0]!.assetId, candidateId: "local" },
      { assetId: duplicateInput.missingAssets[1]!.assetId, candidateId: "local" },
    ]),
    /one-to-one/,
  );

  const exactTie: RelinkPlanInput = {
    ...input,
    missingAssets: [input.missingAssets[0]!],
    candidates: [input.candidates[0]!, { ...input.candidates[0]!, candidateId: "hash-2" }],
  };
  const exactDraft = planRelink(exactTie);
  assert.equal(exactDraft.preselectedPairs.length, 0);
  assert.equal(exactDraft.suggestions[0]?.candidateIds.length, 2);
  assert.equal(exactDraft.ambiguousAssetCount, 1);
});

test("cancel preserves the renderer-safe relink draft and rejects native paths", () => {
  const input = relinkFixture();
  const draft = planRelink(input);
  assert.deepEqual(cancelRelinkDraft(draft), draft);
  assert.throws(
    () => planRelink({ ...input, candidates: [{ ...input.candidates[0]!, relativePath: "/outside.jpg" }] }),
    /relativePath must be relative/,
  );
  assert.throws(
    () => planRelink({ ...input, candidates: [{ ...input.candidates[0]!, candidateId: "/native/path" }] }),
    /must not contain a native path/,
  );
});
