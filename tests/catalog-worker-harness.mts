import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CatalogFaultStage,
  type CatalogWorkerTestHarnessData,
  CATALOG_FAULT_STAGES,
} from "../electron/catalog-fault-injection.ts";
import {
  CatalogWorkerRequestError,
  createCatalogWorkerTestClient,
  type CatalogWorkerClient,
} from "../electron/catalog-worker-client.ts";
import {
  createAssetId,
  createOperationId,
  type AssetId,
  type OperationId,
} from "../lib/catalog/ids.ts";

export interface TracerRecoveryReport {
  readonly injectedStage: CatalogFaultStage;
  readonly operationId: OperationId;
  readonly itemId: AssetId;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly catalogRowCount: number;
  readonly terminalStage: CatalogFaultStage;
}

export interface TemporaryRootHarness {
  readonly root: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly databasePath: string;
  readonly original: Buffer;
  readonly operationId: OperationId;
  readonly itemId: AssetId;
}

function workerOptions(): { workerPath: string; execArgv: readonly string[] } {
  return {
    workerPath: path.resolve("electron/catalog-worker.ts"),
    execArgv: ["--no-warnings", "--experimental-strip-types"],
  };
}

function workerData(
  harness: TemporaryRootHarness,
  stage: CatalogFaultStage | null,
): CatalogWorkerTestHarnessData {
  return {
    kind: "catalog-worker-test-harness",
    rootPath: harness.root,
    faultPoint: stage
      ? {
          operationId: harness.operationId,
          itemId: harness.itemId,
          stage,
        }
      : null,
  };
}

async function startWorker(
  harness: TemporaryRootHarness,
  stage: CatalogFaultStage | null,
): Promise<CatalogWorkerClient> {
  const client = createCatalogWorkerTestClient({
    ...workerOptions(),
    workerData: workerData(harness, stage),
  });
  try {
    await client.open(harness.databasePath);
    await client.transactionProbe();
    return client;
  } catch (error) {
    await client.forceTerminate().catch(() => undefined);
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function stagedPath(harness: TemporaryRootHarness): string {
  const parsed = path.parse(harness.destinationPath);
  return path.join(parsed.dir, `.${parsed.base}.${harness.itemId}.stage`);
}

function expectedTracerState(stage: CatalogFaultStage): {
  readonly source: boolean;
  readonly staged: boolean;
  readonly destination: boolean;
  readonly catalogRowCount: number;
} {
  switch (stage) {
    case "planned":
      return { source: true, staged: false, destination: false, catalogRowCount: 0 };
    case "destination-prepared":
      return { source: true, staged: true, destination: false, catalogRowCount: 0 };
    case "destination-published":
      return { source: true, staged: false, destination: true, catalogRowCount: 0 };
    case "catalog-applied":
      return { source: true, staged: false, destination: true, catalogRowCount: 1 };
    case "source-cleaned":
      return { source: false, staged: false, destination: true, catalogRowCount: 1 };
    default: {
      const _exhaustive: never = stage;
      throw new Error(`Unknown catalog fault stage: ${_exhaustive}.`);
    }
  }
}

async function assertTracerState(
  client: CatalogWorkerClient,
  harness: TemporaryRootHarness,
  stage: CatalogFaultStage,
): Promise<void> {
  const expected = expectedTracerState(stage);
  const inspected = await client.inspectTestTracer({
    operationId: harness.operationId,
    itemId: harness.itemId,
  });
  assert.equal(inspected.stage, stage);
  assert.equal(inspected.catalogRowCount, expected.catalogRowCount);
  assert.equal(await exists(harness.sourcePath), expected.source);
  assert.equal(await exists(stagedPath(harness)), expected.staged);
  assert.equal(await exists(harness.destinationPath), expected.destination);
}

export async function createTemporaryRootHarness(): Promise<TemporaryRootHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-harness-"));
  const sourcePath = path.join(root, "source", "original.bin");
  const original = Buffer.from("catalog-worker-tracer-payload\0\x01\x02");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, original, { flag: "wx" });
  return {
    root,
    sourcePath,
    destinationPath: path.join(root, "destination", "published.bin"),
    databasePath: path.join(root, "tracer.db"),
    original,
    operationId: createOperationId(),
    itemId: createAssetId(),
  };
}

export async function disposeTemporaryRootHarness(
  harness: TemporaryRootHarness,
): Promise<void> {
  await rm(harness.root, { recursive: true, force: true });
}

export async function runTracerRecovery(
  injectedStage: CatalogFaultStage,
): Promise<TracerRecoveryReport> {
  const harness = await createTemporaryRootHarness();
  let client: CatalogWorkerClient | null = null;
  try {
    client = await startWorker(harness, injectedStage);
    let injectedError: unknown = null;
    try {
      await client.runTestTracer({
        operationId: harness.operationId,
        itemId: harness.itemId,
        sourcePath: harness.sourcePath,
        destinationPath: harness.destinationPath,
      });
    } catch (error) {
      injectedError = error;
    }
    if (!(injectedError instanceof CatalogWorkerRequestError)) {
      throw new Error("Catalog tracer did not report the injected fault.");
    }
    assert.equal(injectedError.code, "injected-fault");
    assert.deepEqual(injectedError.faultPoint, {
      operationId: harness.operationId,
      itemId: harness.itemId,
      stage: injectedStage,
    });
    await assertTracerState(client, harness, injectedStage);
    await client.forceTerminate();
    client = null;

    client = await startWorker(harness, null);
    const first = await client.recoverTestTracer({
      operationId: harness.operationId,
      itemId: harness.itemId,
    });
    const second = await client.recoverTestTracer({
      operationId: harness.operationId,
      itemId: harness.itemId,
    });
    assert.equal(first.stage, "source-cleaned");
    assert.equal(second.stage, "source-cleaned");
    assert.equal(second.catalogRowCount, 1);
    await client.shutdown();
    client = null;

    assert.deepEqual(await readFile(harness.destinationPath), harness.original);
    assert.equal(await exists(harness.sourcePath), false);
    assert.equal(await exists(stagedPath(harness)), false);
    return {
      injectedStage,
      operationId: harness.operationId,
      itemId: harness.itemId,
      sourcePath: harness.sourcePath,
      destinationPath: harness.destinationPath,
      catalogRowCount: second.catalogRowCount,
      terminalStage: second.stage,
    };
  } finally {
    await client?.forceTerminate().catch(() => undefined);
    await disposeTemporaryRootHarness(harness);
  }
}

export async function runAllTracerRecoveries(): Promise<readonly TracerRecoveryReport[]> {
  const reports: TracerRecoveryReport[] = [];
  for (const stage of CATALOG_FAULT_STAGES) {
    reports.push(await runTracerRecovery(stage));
  }
  return reports;
}
