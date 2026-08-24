import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CatalogAssetRelinkService,
  type CatalogRelinkSessionPort,
  type CatalogRelinkWorkerPort,
} from "../electron/catalog-asset-relink-service.ts";
import { CatalogWorkLifecycle } from "../electron/catalog-work-lifecycle.ts";
import { observeNoFollowFile } from "../electron/catalog-fingerprint-service.ts";
import {
  createAssetId,
  createCatalogId,
  createOperationId,
  createRootId,
  type AssetId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  defaultCatalogLiveMetadata,
  type CatalogLiveApplyInput,
  type CatalogLiveState,
} from "../lib/catalog/live.ts";
import { createSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import type { CatalogV3AssetSnapshot, CatalogV3Observation } from "../lib/catalog/v3.ts";
import type { FileObservation } from "../lib/import/domain.ts";

interface Fixture {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly rootId: RootId;
  readonly rootPath: string;
  readonly worker: FakeWorker;
  readonly session: FakeSession;
  readonly missing: AssetId[];
}

function digest(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function fileObservation(size: number, modifiedAt = 1, localFileId: string | null = null): CatalogV3Observation {
  return { byteLength: size, modifiedAt, observedAt: 1, localFileId };
}

function asset(
  catalogId: CatalogId,
  assetId: AssetId,
  rootId: RootId,
  relativePath: string,
  health: CatalogV3AssetSnapshot["health"],
  observation: CatalogV3Observation | null,
  sha256: string | null = null,
): CatalogV3AssetSnapshot {
  const fingerprintStatus = sha256 === null ? "missing" : "valid";
  return {
    catalogId,
    assetId,
    rootId,
    relativePath,
    observation,
    revision: 1,
    health,
    formatId: "jpeg",
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    fingerprintId: createOperationId(),
    fingerprintStatus,
    fingerprintSha256: sha256,
    fingerprintObservedAt: sha256 === null ? null : 1,
    fingerprintObservedByteLength: sha256 === null ? null : observation?.byteLength ?? null,
    fingerprintObservedModifiedAt: sha256 === null ? null : observation?.modifiedAt ?? null,
    fingerprintLocalFileId: sha256 === null ? null : observation?.localFileId ?? null,
    metadata: defaultCatalogLiveMetadata(1),
  };
}

class FakeSession implements CatalogRelinkSessionPort {
  readonly roots: readonly { readonly rootId: RootId; readonly canonicalPath: string }[];
  current: { readonly catalogId: CatalogId; readonly sessionId: SessionId };

  constructor(catalogId: CatalogId, sessionId: SessionId, rootId: RootId, rootPath: string) {
    this.current = { catalogId, sessionId };
    this.roots = [{ rootId, canonicalPath: rootPath }];
  }

  assertActive(input: { readonly catalogId: CatalogId; readonly sessionId: SessionId }): void {
    if (input.catalogId !== this.current.catalogId || input.sessionId !== this.current.sessionId) {
      throw new Error("Catalog session is inactive.");
    }
  }

  getActiveRoots(input: { readonly catalogId: CatalogId; readonly sessionId: SessionId }): readonly { readonly rootId: RootId; readonly canonicalPath: string }[] {
    this.assertActive(input);
    return this.roots;
  }
}

class FakeWorker implements CatalogRelinkWorkerPort {
  state: CatalogLiveState;
  readonly applies: CatalogLiveApplyInput[] = [];

  constructor(state: CatalogLiveState) {
    this.state = state;
  }

  async liveQuery(): Promise<unknown> {
    return this.state;
  }

  async liveApply(input: CatalogLiveApplyInput): Promise<unknown> {
    assert.equal(input.expectedRevision, this.state.catalog.revision);
    this.applies.push(input);
    const nextRevision = this.state.catalog.revision + 1;
    const assets = this.state.assets.map((current) => {
      const mutation = input.mutations.find(
        (candidate) => candidate.kind === "asset-relocate" && candidate.assetId === current.assetId,
      );
      if (mutation?.kind !== "asset-relocate") return current;
      return {
        ...current,
        rootId: mutation.rootId,
        relativePath: mutation.relativePath,
        observation: mutation.observation,
        health: mutation.health,
        revision: current.revision + 1,
      };
    });
    this.state = {
      ...this.state,
      catalog: { ...this.state.catalog, revision: nextRevision },
      assets,
    };
    return {
      catalogId: input.catalogId,
      revision: nextRevision,
      changed: input.mutations.length > 0,
      appliedMutations: input.mutations.length,
      auditId: 1,
    };
  }
}

async function fixture(
  files: readonly { readonly relativePath: string; readonly contents: string }[],
  assets: readonly CatalogV3AssetSnapshot[],
): Promise<Fixture> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "darkroom-relink-"));
  for (const file of files) {
    const absolutePath = path.join(rootPath, ...file.relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.contents, "utf8");
  }
  const catalogId = createCatalogId();
  const sessionId = createSessionId();
  const rootId = createRootId();
  const state: CatalogLiveState = {
    catalog: { catalogId, displayName: "Fixture", appVersion: "test", installState: "ready", revision: 1 },
    roots: [{
      rootId,
      label: "Fixture",
      configuredPath: rootPath,
      canonicalPath: rootPath,
      health: "online",
      scanState: "complete",
      watchState: "active",
      revision: 1,
    }],
    assets: assets.map((item) => ({ ...item, catalogId, rootId })),
    albums: [],
    operations: [],
    presets: [],
    rules: [],
    fingerprintCoverage: { total: assets.length, missing: assets.length, hashing: 0, valid: 0, stale: 0, failed: 0 },
    fingerprintMatches: [],
  };
  const worker = new FakeWorker(state);
  const session = new FakeSession(catalogId, sessionId, rootId, rootPath);
  const missing = assets.filter((item) => item.health === "missing").map((item) => item.assetId);
  return { catalogId, sessionId, rootId, rootPath, worker, session, missing };
}

async function cleanup(fixtureValue: Fixture): Promise<void> {
  await rm(fixtureValue.rootPath, { recursive: true, force: true });
}

function service(
  fixtureValue: Fixture,
  now: () => number = () => Date.now(),
  draftTtlMs?: number,
  reobserveFile?: (absolutePath: string) => Promise<FileObservation>,
): CatalogAssetRelinkService {
  return new CatalogAssetRelinkService({
    session: fixtureValue.session,
    worker: fixtureValue.worker,
    now,
    ...(draftTtlMs === undefined ? {} : { draftTtlMs }),
    ...(reobserveFile === undefined ? {} : { reobserveFile }),
  });
}

function prepareInput(fixtureValue: Fixture, candidates: readonly { readonly candidateId: string; readonly relativePath: string }[]): {
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly selectedCandidates: readonly { readonly candidateId: string; readonly rootId: RootId; readonly relativePath: string; readonly absolutePath: string }[];
} {
  return {
    catalogId: fixtureValue.catalogId,
    sessionId: fixtureValue.sessionId,
    selectedCandidates: candidates.map((candidate) => ({
      ...candidate,
      rootId: fixtureValue.rootId,
      absolutePath: path.join(fixtureValue.rootPath, ...candidate.relativePath.split("/")),
    })),
  };
}

test("prepares a path-free draft, preselects exact hashes only, and atomically retains AssetIds", async () => {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const exactId = createAssetId();
  const lowerId = createAssetId();
  const exactHash = digest("exact");
  const fixtureValue = await fixture(
    [
      { relativePath: "selected/exact.jpg", contents: "exact" },
      { relativePath: "selected/lower.jpg", contents: "lower" },
    ],
    [
      asset(catalogId, exactId, rootId, "old/exact.jpg", "missing", fileObservation(5, 1), exactHash),
      asset(catalogId, lowerId, rootId, "old/lower.jpg", "missing", fileObservation(5, 1)),
    ],
  );
  try {
    const relink = service(fixtureValue);
    const draft = await relink.prepare(prepareInput(fixtureValue, [
      { candidateId: "exact", relativePath: "selected/exact.jpg" },
      { candidateId: "lower", relativePath: "selected/lower.jpg" },
    ]));
    assert.deepEqual(draft.preselectedPairs.map((pair) => pair.candidateId), ["exact"]);
    assert.equal(draft.suggestions.find((item) => item.assetId === lowerId)?.rank, "filename-size");
    assert.equal(JSON.stringify(draft).includes(fixtureValue.rootPath), false);
    assert.equal(draft.candidates.some((candidate) => "absolutePath" in candidate), false);

    const applied = await relink.apply({
      catalogId: fixtureValue.catalogId,
      sessionId: fixtureValue.sessionId,
      operationId: draft.operationId,
      acceptedPairs: [{ assetId: lowerId, candidateId: "lower" }],
    });
    assert.equal(applied.acceptedPairs.length, 2);
    assert.equal(fixtureValue.worker.applies.length, 1);
    assert.equal(fixtureValue.worker.applies[0]?.mutations.length, 2);
    assert.deepEqual(
      fixtureValue.worker.state.assets.map((item) => ({ assetId: item.assetId, health: item.health })).sort((left, right) => left.assetId.localeCompare(right.assetId)),
      [exactId, lowerId].map((assetId) => ({ assetId, health: "present" as const })).sort((left, right) => left.assetId.localeCompare(right.assetId)),
    );
  } finally {
    await cleanup(fixtureValue);
  }
});

test("enforces one-to-one pairs, source-missing state, and live destination collisions", async () => {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const firstId = createAssetId();
  const secondId = createAssetId();
  const firstFixture = await fixture(
    [{ relativePath: "selected/one.jpg", contents: "one" }],
    [
      asset(catalogId, firstId, rootId, "old-a/one.jpg", "missing", fileObservation(3)),
      asset(catalogId, secondId, rootId, "old-b/one.jpg", "missing", fileObservation(3)),
    ],
  );
  try {
    const relink = service(firstFixture);
    const draft = await relink.prepare(prepareInput(firstFixture, [{ candidateId: "one", relativePath: "selected/one.jpg" }]));
    await assert.rejects(
      relink.apply({
        catalogId: firstFixture.catalogId,
        sessionId: firstFixture.sessionId,
        operationId: draft.operationId,
        acceptedPairs: [
          { assetId: firstId, candidateId: "one" },
          { assetId: secondId, candidateId: "one" },
        ],
      }),
      /one-to-one/,
    );
    assert.equal(firstFixture.worker.applies.length, 0);
  } finally {
    await cleanup(firstFixture);
  }

  const sourceId = createAssetId();
  const occupantId = createAssetId();
  const collisionFixture = await fixture(
    [{ relativePath: "selected/photo.jpg", contents: "abc" }],
    [
      asset(catalogId, sourceId, rootId, "old/photo.jpg", "missing", fileObservation(3)),
      asset(catalogId, occupantId, rootId, "selected/photo.jpg", "present", fileObservation(3)),
    ],
  );
  try {
    const relink = service(collisionFixture);
    const draft = await relink.prepare(prepareInput(collisionFixture, [{ candidateId: "photo", relativePath: "selected/photo.jpg" }]));
    await assert.rejects(
      relink.apply({
        catalogId: collisionFixture.catalogId,
        sessionId: collisionFixture.sessionId,
        operationId: draft.operationId,
        acceptedPairs: [{ assetId: sourceId, candidateId: "photo" }],
      }),
      /occupied/,
    );
    assert.equal(collisionFixture.worker.applies.length, 0);
    const missingAgain = await relink.prepare(prepareInput(collisionFixture, [{ candidateId: "again", relativePath: "selected/photo.jpg" }]));
    const source = collisionFixture.worker.state.assets.find((item) => item.assetId === sourceId);
    if (source === undefined) throw new Error("Fixture source is missing.");
    collisionFixture.worker.state = {
      ...collisionFixture.worker.state,
      assets: collisionFixture.worker.state.assets.map((item) => item.assetId === sourceId ? { ...item, health: "present" } : item),
    };
    await assert.rejects(
      relink.apply({
        catalogId: collisionFixture.catalogId,
        sessionId: collisionFixture.sessionId,
        operationId: missingAgain.operationId,
        acceptedPairs: [{ assetId: sourceId, candidateId: "again" }],
      }),
      /no longer missing/,
    );
  } finally {
    await cleanup(collisionFixture);
  }
});

test("rejects changed candidates and keeps native paths out of public errors", async () => {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const sourceId = createAssetId();
  const fixtureValue = await fixture(
    [{ relativePath: "selected/photo.jpg", contents: "abc" }],
    [asset(catalogId, sourceId, rootId, "old/photo.jpg", "missing", fileObservation(3))],
  );
  try {
    const relink = service(fixtureValue);
    const draft = await relink.prepare(prepareInput(fixtureValue, [{ candidateId: "photo", relativePath: "selected/photo.jpg" }]));
    await writeFile(path.join(fixtureValue.rootPath, "selected/photo.jpg"), "changed", "utf8");
    const error = await assert.rejects(
      relink.apply({
        catalogId: fixtureValue.catalogId,
        sessionId: fixtureValue.sessionId,
        operationId: draft.operationId,
        acceptedPairs: [{ assetId: sourceId, candidateId: "photo" }],
      }),
      /changed|unavailable/,
    );
    assert.equal(String(error).includes(fixtureValue.rootPath), false);
  } finally {
    await cleanup(fixtureValue);
  }
});

test("binds drafts to the active session, supports cancellation, and expires them", async () => {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const sourceId = createAssetId();
  const fixtureValue = await fixture(
    [{ relativePath: "selected/photo.jpg", contents: "abc" }],
    [asset(catalogId, sourceId, rootId, "old/photo.jpg", "missing", fileObservation(3))],
  );
  try {
    let clock = 100;
    const relink = service(fixtureValue, () => clock, 10);
    const draft = await relink.prepare(prepareInput(fixtureValue, [{ candidateId: "photo", relativePath: "selected/photo.jpg" }]));
    const wrongSession = createSessionId();
    await assert.rejects(
      relink.apply({
        catalogId: fixtureValue.catalogId,
        sessionId: wrongSession,
        operationId: draft.operationId,
        acceptedPairs: [{ assetId: sourceId, candidateId: "photo" }],
      }),
      /inactive/,
    );
    await assert.rejects(
      relink.apply({
        catalogId: createCatalogId(),
        sessionId: fixtureValue.sessionId,
        operationId: draft.operationId,
        acceptedPairs: [{ assetId: sourceId, candidateId: "photo" }],
      }),
      /inactive/,
    );
    await relink.cancel({ catalogId: fixtureValue.catalogId, sessionId: fixtureValue.sessionId, operationId: draft.operationId });
    await assert.rejects(
      relink.apply({
        catalogId: fixtureValue.catalogId,
        sessionId: fixtureValue.sessionId,
        operationId: draft.operationId,
        acceptedPairs: [],
      }),
      /missing or expired/,
    );

    const expired = await relink.prepare(prepareInput(fixtureValue, [{ candidateId: "expired", relativePath: "selected/photo.jpg" }]));
    clock = 111;
    await assert.rejects(
      relink.apply({
        catalogId: fixtureValue.catalogId,
        sessionId: fixtureValue.sessionId,
        operationId: expired.operationId,
        acceptedPairs: [{ assetId: sourceId, candidateId: "expired" }],
      }),
      /missing or expired/,
    );
    assert.equal(fixtureValue.worker.applies.length, 0);
  } finally {
    await cleanup(fixtureValue);
  }
});

test("does not apply or consume a draft when lifecycle cancellation arrives during reobservation", async () => {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const sourceId = createAssetId();
  const fixtureValue = await fixture(
    [{ relativePath: "selected/photo.jpg", contents: "abc" }],
    [asset(catalogId, sourceId, rootId, "old/photo.jpg", "missing", fileObservation(3))],
  );
  try {
    let releaseReobserve: (() => void) | undefined;
    let markReobserveStarted: (() => void) | undefined;
    const reobserveStarted = new Promise<void>((resolve) => {
      markReobserveStarted = resolve;
    });
    const relink = service(fixtureValue, () => Date.now(), undefined, async (absolutePath) => {
      markReobserveStarted?.();
      await new Promise<void>((resolve) => {
        releaseReobserve = resolve;
      });
      return observeNoFollowFile(absolutePath);
    });
    const draft = await relink.prepare(prepareInput(fixtureValue, [{ candidateId: "photo", relativePath: "selected/photo.jpg" }]));
    const lifecycle = new CatalogWorkLifecycle();
    const apply = lifecycle.track("manual", (token) => relink.apply({
      catalogId: fixtureValue.catalogId,
      sessionId: fixtureValue.sessionId,
      operationId: draft.operationId,
      acceptedPairs: [{ assetId: sourceId, candidateId: "photo" }],
    }, token.isCancelled));
    await reobserveStarted;
    const nextSessionId = createSessionId();
    const transition = lifecycle.transition(async () => {
      fixtureValue.session.current = {
        catalogId: fixtureValue.catalogId,
        sessionId: nextSessionId,
      };
    }, async () => undefined);
    releaseReobserve?.();
    await assert.rejects(apply, /cancelled/);
    await transition;
    assert.equal(fixtureValue.worker.applies.length, 0);

    await assert.rejects(
      relink.cancel({
        catalogId: fixtureValue.catalogId,
        sessionId: nextSessionId,
        operationId: draft.operationId,
      }),
      /different catalog session/,
    );
    await assert.rejects(
      relink.prepare({
        ...prepareInput(fixtureValue, [{ candidateId: "retry", relativePath: "selected/photo.jpg" }]),
        sessionId: nextSessionId,
        operationId: draft.operationId,
      }),
      /already active/,
    );
  } finally {
    await cleanup(fixtureValue);
  }
});
