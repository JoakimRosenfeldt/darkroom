import assert from "node:assert/strict";
import { realpathSync, renameSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCurrentLibraryEvent,
  type CatalogId,
  type AssetId,
  type LibraryEvent,
  type LibraryOperationHandle,
  type RootId,
} from "../lib/catalog/runtime.ts";
import { createAssetId, createCatalogId, createRootId } from "../lib/catalog/ids.ts";
import {
  LibraryRuntime,
  type AdoptRootInput,
  type LibraryRuntimeSource,
  type RuntimeAssetProjection,
  type RuntimeCatalogProjection,
  type RuntimeRootProjection,
  type ScanCommitInput,
} from "../electron/library-runtime.ts";
import { scanNativeFolder, type NativeScanResult } from "../electron/library-scan.ts";

interface CatalogFixture {
  readonly catalogId: CatalogId;
  readonly root: RuntimeRootProjection;
  readonly projection: RuntimeCatalogProjection;
  readonly assets: Map<string, RuntimeAssetProjection>;
}

class MemorySource implements LibraryRuntimeSource {
  readonly catalogs = new Map<string, CatalogFixture>();
  readonly commits: ScanCommitInput[] = [];
  readonly adoptedRoots: AdoptRootInput[] = [];

  addCatalog(fixture: CatalogFixture): void {
    this.catalogs.set(fixture.catalogId, fixture);
  }

  async loadCatalogProjection(catalogId: CatalogId): Promise<RuntimeCatalogProjection | null> {
    return this.catalogs.get(catalogId)?.projection ?? null;
  }

  async loadRootProjection(catalogId: CatalogId, rootId: RootId): Promise<RuntimeRootProjection | null> {
    const fixture = this.catalogs.get(catalogId);
    return fixture?.root.rootId === rootId ? fixture.root : null;
  }

  async loadAssetProjection(catalogId: CatalogId, assetId: AssetId): Promise<RuntimeAssetProjection | null> {
    return this.catalogs.get(catalogId)?.assets.get(assetId) ?? null;
  }

  async commitScan(input: ScanCommitInput): Promise<void> {
    this.commits.push({ ...input, observations: [...input.observations] });
  }

  async adoptRoot(input: AdoptRootInput): Promise<RootId> {
    this.adoptedRoots.push(input);
    const fixture = this.catalogs.get(input.catalogId);
    if (fixture === undefined) return createRootId();
    const root = { ...fixture.root, nativePath: input.canonicalPath };
    this.catalogs.set(input.catalogId, {
      ...fixture,
      root,
      projection: { ...fixture.projection, roots: [root] },
    });
    return root.rootId;
  }
}

async function temporaryFolder(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "darkroom-runtime-"));
}

function fixture(
  folderPath: string,
  catalogId = createCatalogId(),
  relativePath = "photo.jpg",
): CatalogFixture {
  const rootId = createRootId();
  const assetId = createAssetId();
  const root: RuntimeRootProjection = {
    catalogId,
    rootId,
    label: "Fixture",
    nativePath: realpathSync(folderPath),
  };
  const asset: RuntimeAssetProjection = {
    catalogId,
    assetId,
    rootId,
    relativePath,
  };
  return {
    catalogId,
    root,
    projection: { catalogId, roots: [root] },
    assets: new Map([[assetId, asset]]),
  };
}

function assetId(fixtureValue: CatalogFixture): ReturnType<typeof createAssetId> {
  const first = fixtureValue.assets.keys().next().value;
  if (typeof first !== "string") throw new Error("Fixture has no asset.");
  return createAssetId(first);
}

function operationRequest(handle: LibraryOperationHandle): {
  readonly catalogId: CatalogId;
  readonly sessionId: LibraryOperationHandle["sessionId"];
  readonly operationId: LibraryOperationHandle["operationId"];
} {
  return {
    catalogId: handle.catalogId,
    sessionId: handle.sessionId,
    operationId: handle.operationId,
  };
}

async function cleanup(folderPath: string): Promise<void> {
  await rm(folderPath, { recursive: true, force: true });
}

test("asset access rejects cross-catalog and traversal requests", async () => {
  const folderPath = await temporaryFolder();
  try {
    await writeFile(path.join(folderPath, "photo.jpg"), "photo");
    const source = new MemorySource();
    const first = fixture(folderPath);
    const second = fixture(folderPath);
    source.addCatalog(first);
    source.addCatalog(second);
    const runtime = new LibraryRuntime({ source });
    const session = await runtime.selectSession({ catalogId: first.catalogId });

    await assert.rejects(
      runtime.readAsset({
        catalogId: first.catalogId,
        sessionId: session.sessionId,
        assetId: assetId(second),
      }),
      /Asset was not found in this catalog/,
    );

    const traversal = fixture(folderPath, first.catalogId, "../photo.jpg");
    source.catalogs.set(first.catalogId, traversal);
    await assert.rejects(
      runtime.readAsset({
        catalogId: first.catalogId,
        sessionId: session.sessionId,
        assetId: assetId(traversal),
      }),
      /unsafe path segment/,
    );
  } finally {
    await cleanup(folderPath);
  }
});

test("asset access rejects a symlink escape at the native boundary", async () => {
  const folderPath = await temporaryFolder();
  const outsidePath = await temporaryFolder();
  try {
    await writeFile(path.join(outsidePath, "outside.jpg"), "outside");
    await symlink(path.join(outsidePath, "outside.jpg"), path.join(folderPath, "escape.jpg"));
    const source = new MemorySource();
    const fixtureValue = fixture(folderPath);
    const baseAsset = fixtureValue.assets.values().next().value;
    if (baseAsset === undefined) throw new Error("Fixture has no asset.");
    const symlinkAsset: RuntimeAssetProjection = {
      ...baseAsset,
      relativePath: "escape.jpg",
    };
    fixtureValue.assets.clear();
    fixtureValue.assets.set(symlinkAsset.assetId, symlinkAsset);
    source.addCatalog(fixtureValue);
    const runtime = new LibraryRuntime({ source });
    const session = await runtime.selectSession({ catalogId: fixtureValue.catalogId });

    await assert.rejects(
      runtime.readAsset({
        catalogId: fixtureValue.catalogId,
        sessionId: session.sessionId,
        assetId: symlinkAsset.assetId,
      }),
      /Symlinked asset paths are not allowed|Asset is unavailable/,
    );
  } finally {
    await cleanup(folderPath);
    await cleanup(outsidePath);
  }
});

test("asset access rejects replacement of a canonical root", async () => {
  const folderPath = await temporaryFolder();
  const outsidePath = await temporaryFolder();
  const backupPath = `${folderPath}-backup`;
  try {
    await writeFile(path.join(folderPath, "photo.jpg"), "inside");
    await writeFile(path.join(outsidePath, "photo.jpg"), "outside");
    const source = new MemorySource();
    const fixtureValue = fixture(folderPath);
    source.addCatalog(fixtureValue);
    const runtime = new LibraryRuntime({ source });
    const session = await runtime.selectSession({ catalogId: fixtureValue.catalogId });
    renameSync(folderPath, backupPath);
    symlinkSync(outsidePath, folderPath);
    await assert.rejects(
      runtime.readAsset({
        catalogId: fixtureValue.catalogId,
        sessionId: session.sessionId,
        assetId: assetId(fixtureValue),
      }),
      /Asset root is unavailable|Asset root changed/,
    );
  } finally {
    await cleanup(folderPath);
    await cleanup(backupPath);
    await cleanup(outsidePath);
  }
});

test("native scan rejects a queued directory replaced by a symlink", async () => {
  const folderPath = await temporaryFolder();
  const outsidePath = await temporaryFolder();
  const childPath = path.join(folderPath, "child");
  const backupPath = path.join(folderPath, "child-real");
  try {
    await mkdir(childPath);
    await writeFile(path.join(folderPath, "root.jpg"), "root");
    await writeFile(path.join(outsidePath, "escape.jpg"), "outside");
    let swapped = false;
    await assert.rejects(
      scanNativeFolder({
        rootPath: folderPath,
        signal: new AbortController().signal,
        onProgress: (progress) => {
          if (!swapped && progress.phase === "statting" && progress.currentPath === "") {
            swapped = true;
            renameSync(childPath, backupPath);
            symlinkSync(outsidePath, childPath);
          }
        },
      }),
      /symlink|non-directory/,
    );
  } finally {
    await cleanup(folderPath);
    await cleanup(outsidePath);
  }
});

test("native scan records a stable local file identity", async () => {
  const folderPath = await temporaryFolder();
  try {
    const filePath = path.join(folderPath, "photo.jpg");
    await writeFile(filePath, "photo");
    const fileStat = await stat(filePath);
    const result = await scanNativeFolder({
      rootPath: folderPath,
      signal: new AbortController().signal,
    });
    assert.equal(result.observations[0]?.localFileId, `${fileStat.dev}:${fileStat.ino}`);
  } finally {
    await cleanup(folderPath);
  }
});

test("picker grants are scoped, expiring, single-use, and path-free", async () => {
  const folderPath = await temporaryFolder();
  try {
    const source = new MemorySource();
    const first = fixture(folderPath);
    const second = fixture(folderPath);
    source.addCatalog(first);
    source.addCatalog(second);
    let now = 100;
    const runtime = new LibraryRuntime({
      source,
      now: () => now,
      pickerGrantTtlMs: 10,
      picker: { chooseFolder: async () => ({ path: folderPath, label: "Picked" }) },
    });
    const firstSession = await runtime.selectSession({ catalogId: first.catalogId });
    const consumedGrant = await runtime.issuePathGrant();
    assert.equal("canonicalPath" in consumedGrant, false);
    assert.equal("path" in consumedGrant, false);
    const consumed = await runtime.consumePathGrant({
      catalogId: first.catalogId,
      sessionId: firstSession.sessionId,
      grantId: consumedGrant.grantId,
    });
    assert.equal(consumed.rootId, first.root.rootId);
    await assert.rejects(
      runtime.consumePathGrant({
        catalogId: first.catalogId,
        sessionId: firstSession.sessionId,
        grantId: consumedGrant.grantId,
      }),
      /invalid, expired, or already consumed/,
    );

    const expiredGrant = await runtime.issuePathGrant();
    now = 111;
    await assert.rejects(
      runtime.consumePathGrant({
        catalogId: first.catalogId,
        sessionId: firstSession.sessionId,
        grantId: expiredGrant.grantId,
      }),
      /invalid, expired, or already consumed/,
    );

    now = 200;
    const wrongSessionGrant = await runtime.issuePathGrant();
    const secondSession = await runtime.selectSession({ catalogId: second.catalogId });
    await assert.rejects(
      runtime.consumePathGrant({
        catalogId: first.catalogId,
        sessionId: firstSession.sessionId,
        grantId: wrongSessionGrant.grantId,
      }),
      /Library session is inactive/,
    );
    assert.equal(secondSession.catalogId, second.catalogId);
  } finally {
    await cleanup(folderPath);
  }
});

test("offline roots remain visible but gain native authority only after picker relink", async () => {
  const folderPath = await temporaryFolder();
  try {
    const source = new MemorySource();
    const baseFixture = fixture(folderPath);
    const offlineRoot = { ...baseFixture.root, nativePath: null };
    const fixtureValue: CatalogFixture = {
      ...baseFixture,
      root: offlineRoot,
      projection: { catalogId: baseFixture.catalogId, roots: [offlineRoot] },
    };
    source.addCatalog(fixtureValue);
    const runtime = new LibraryRuntime({
      source,
      picker: { chooseFolder: async () => ({ path: folderPath, label: "Relinked" }) },
    });
    const session = await runtime.selectSession({ catalogId: fixtureValue.catalogId });
    assert.equal(session.roots.length, 1);
    assert.equal(session.roots[0]?.rootId, offlineRoot.rootId);
    assert.deepEqual(runtime.getNativeSessionRoots(), []);

    const grant = await runtime.issuePathGrant();
    await runtime.consumePathGrant({
      catalogId: fixtureValue.catalogId,
      sessionId: session.sessionId,
      grantId: grant.grantId,
    });
    const nativeRoots = runtime.getNativeSessionRoots();
    assert.equal(nativeRoots.length, 1);
    assert.equal(nativeRoots[0]?.nativePath, realpathSync(folderPath));
  } finally {
    await cleanup(folderPath);
  }
});

test("native scan emits relative progress before completion with monotonic events", async () => {
  const folderPath = await temporaryFolder();
  try {
    await mkdir(path.join(folderPath, "nested"));
    await writeFile(path.join(folderPath, "a.jpg"), "a");
    await writeFile(path.join(folderPath, "nested", "b.nef"), "b");
    const source = new MemorySource();
    const fixtureValue = fixture(folderPath);
    source.addCatalog(fixtureValue);
    const runtime = new LibraryRuntime({ source });
    const session = await runtime.selectSession({ catalogId: fixtureValue.catalogId });
    const events: LibraryEvent[] = [];
    let firstProgress: LibraryEvent | undefined;
    let resolveFirstProgress: (() => void) | undefined;
    const firstProgressPromise = new Promise<void>((resolve) => {
      resolveFirstProgress = resolve;
    });
    runtime.subscribe((event) => {
      events.push(event);
      if (event.kind === "scan-progress" && firstProgress === undefined) {
        firstProgress = event;
        resolveFirstProgress?.();
      }
    });
    const handle = runtime.startScan({
      catalogId: fixtureValue.catalogId,
      sessionId: session.sessionId,
      rootId: fixtureValue.root.rootId,
    });
    await firstProgressPromise;
    assert.equal(runtime.getOperation(operationRequest(handle)).status, "running");
    const terminal = await runtime.waitForOperation(operationRequest(handle));
    assert.equal(terminal.status, "completed");
    assert.ok(firstProgress);
    assert.ok(events.some((event) => event.kind === "scan-terminal"));
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    for (const event of events) {
      if (event.kind === "scan-progress") assert.equal(path.isAbsolute(event.payload.currentPath ?? ""), false);
    }
    assert.equal(source.commits.length, 1);
    assert.deepEqual(
      source.commits[0]?.observations.map((observation) => observation.relativePath),
      ["a.jpg", "nested/b.nef"],
    );
  } finally {
    await cleanup(folderPath);
  }
});

test("cancellation stops native traversal and publishes no staged observations", async () => {
  const folderPath = await temporaryFolder();
  try {
    await mkdir(path.join(folderPath, "nested"), { recursive: true });
    for (let index = 0; index < 120; index += 1) {
      await writeFile(path.join(folderPath, "nested", `photo-${index}.jpg`), "photo");
    }
    const source = new MemorySource();
    const fixtureValue = fixture(folderPath);
    source.addCatalog(fixtureValue);
    const runtime = new LibraryRuntime({ source });
    const session = await runtime.selectSession({ catalogId: fixtureValue.catalogId });
    const operationHolder: { handle?: LibraryOperationHandle } = {};
    runtime.subscribe((event) => {
      if (event.kind === "scan-progress" && operationHolder.handle !== undefined) {
        runtime.cancelScan(operationRequest(operationHolder.handle));
      }
    });
    const handle = runtime.startScan({
      catalogId: fixtureValue.catalogId,
      sessionId: session.sessionId,
      rootId: fixtureValue.root.rootId,
    });
    operationHolder.handle = handle;
    const terminal = await runtime.waitForOperation(operationRequest(handle));
    assert.equal(terminal.status, "cancelled");
    assert.equal(source.commits.length, 0);
    assert.ok(terminal.directoriesVisited <= 1);
  } finally {
    await cleanup(folderPath);
  }
});

test("timeout and failure finish and clean up without committing", async () => {
  const folderPath = await temporaryFolder();
  try {
    const source = new MemorySource();
    const fixtureValue = fixture(folderPath);
    source.addCatalog(fixtureValue);
    const runtime = new LibraryRuntime({
      source,
      scanRunner: ({ signal }) => new Promise<NativeScanResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const session = await runtime.selectSession({ catalogId: fixtureValue.catalogId });
    const handle = runtime.startScan({
      catalogId: fixtureValue.catalogId,
      sessionId: session.sessionId,
      rootId: fixtureValue.root.rootId,
      timeoutMs: 5,
    });
    const timedOut = await runtime.waitForOperation(operationRequest(handle));
    assert.equal(timedOut.status, "timed-out");
    assert.equal(source.commits.length, 0);

    const failedRuntime = new LibraryRuntime({
      source,
      scanRunner: async () => {
        throw new Error("failed at /private/native/path");
      },
    });
    const failedSession = await failedRuntime.selectSession({ catalogId: fixtureValue.catalogId });
    const failedHandle = failedRuntime.startScan({
      catalogId: fixtureValue.catalogId,
      sessionId: failedSession.sessionId,
      rootId: fixtureValue.root.rootId,
    });
    const failed = await failedRuntime.waitForOperation(operationRequest(failedHandle));
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorMessage, "Scan failed.");
  } finally {
    await cleanup(folderPath);
  }
});

test("session swap supersedes late scan results and rejects old events", async () => {
  const folderPath = await temporaryFolder();
  try {
    const source = new MemorySource();
    const first = fixture(folderPath);
    const second = fixture(folderPath);
    source.addCatalog(first);
    source.addCatalog(second);
    let resolveScan: ((result: NativeScanResult) => void) | undefined;
    const scanResult = new Promise<NativeScanResult>((resolve) => {
      resolveScan = resolve;
    });
    const runtime = new LibraryRuntime({
      source,
      scanRunner: async ({ onProgress }) => {
        onProgress({
          phase: "scanning",
          directoriesVisited: 1,
          filesConsidered: 0,
          acceptedCount: 0,
          currentPath: "",
        });
        return scanResult;
      },
    });
    const firstSession = await runtime.selectSession({ catalogId: first.catalogId });
    const events: LibraryEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const handle = runtime.startScan({
      catalogId: first.catalogId,
      sessionId: firstSession.sessionId,
      rootId: first.root.rootId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondSession = await runtime.selectSession({ catalogId: second.catalogId });
    resolveScan?.({
      observations: [{ name: "late.jpg", relativePath: "late.jpg", size: 1, lastModified: 1 }],
      directoriesVisited: 1,
      filesConsidered: 1,
      acceptedCount: 1,
      currentPath: "",
    });
    await assert.rejects(
      runtime.waitForOperation(operationRequest(handle)),
      /Library session is inactive/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(source.commits.length, 0);
    assert.equal(events.filter((event) => event.kind === "scan-terminal").length, 0);
    const oldEvent = events[0];
    if (oldEvent !== undefined) {
      assert.throws(
        () => assertCurrentLibraryEvent(oldEvent, {
          catalogId: secondSession.catalogId,
          sessionId: secondSession.sessionId,
          lastSequence: 0,
        }),
        /inactive session/,
      );
    }
  } finally {
    await cleanup(folderPath);
  }
});

test("asset bytes resolve through catalog and asset IDs", async () => {
  const folderPath = await temporaryFolder();
  try {
    await writeFile(path.join(folderPath, "photo.jpg"), "photo");
    const source = new MemorySource();
    const fixtureValue = fixture(folderPath);
    source.addCatalog(fixtureValue);
    const runtime = new LibraryRuntime({ source });
    const session = await runtime.selectSession({ catalogId: fixtureValue.catalogId });
    const bytes = await runtime.readAsset({
      catalogId: fixtureValue.catalogId,
      sessionId: session.sessionId,
      assetId: assetId(fixtureValue),
    });
    assert.equal(new TextDecoder().decode(bytes), "photo");
    assert.equal((await runtime.readAssetHead({
      catalogId: fixtureValue.catalogId,
      sessionId: session.sessionId,
      assetId: assetId(fixtureValue),
      maxBytes: 3,
    })).byteLength, 3);
    assert.equal((await runtime.statAsset({
      catalogId: fixtureValue.catalogId,
      sessionId: session.sessionId,
      assetId: assetId(fixtureValue),
    })).size, 5);
    assert.deepEqual(await readFile(path.join(folderPath, "photo.jpg")), Buffer.from(bytes));
  } finally {
    await cleanup(folderPath);
  }
});
