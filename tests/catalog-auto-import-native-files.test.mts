import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAssetId,
  createCatalogId,
  createOperationId,
  createPresetId,
  createRootId,
  type CatalogId,
  type RootId,
} from "../lib/catalog/ids.ts";
import { createSessionId, type SessionId } from "../lib/catalog/runtime.ts";
import { canonicalJson, type ImportPreset } from "../lib/import/domain.ts";
import { parseAutoImportRuleId, type AutoImportRule } from "../lib/import/auto-import.ts";
import { CatalogFaultInjectedError, type CatalogFaultInjector } from "../electron/catalog-fault-injection.ts";
import { CatalogLiveRepository } from "../electron/catalog-live-repository.ts";
import { CatalogAutoImportExecutor } from "../electron/catalog-auto-import-executor.ts";
import { CatalogAutoImportNativeFiles } from "../electron/catalog-auto-import-native-files.ts";
import {
  MemoryFileTransactionJournal,
  type FileTransactionJournal,
  type FileTransactionJournalRecord,
} from "../electron/file-transaction-service.ts";

interface NativeFixture {
  readonly directory: string;
  readonly ingressPath: string;
  readonly destinationPath: string;
  readonly catalogId: CatalogId;
  readonly sessionId: SessionId;
  readonly ingressRootId: RootId;
  readonly destinationRootId: RootId;
  readonly native: CatalogAutoImportNativeFiles;
}

async function fixture(maxEnumerationCandidates?: number): Promise<NativeFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "darkroom-auto-native-"));
  const ingressPath = path.join(directory, "ingress");
  const destinationPath = path.join(directory, "destination");
  await mkdir(path.join(ingressPath, "watch"), { recursive: true });
  await mkdir(destinationPath, { recursive: true });
  const catalogId = createCatalogId();
  const sessionId = createSessionId();
  const ingressRootId = createRootId();
  const destinationRootId = createRootId();
  const roots = new Map<RootId, string>([
    [ingressRootId, await realpath(ingressPath)],
    [destinationRootId, await realpath(destinationPath)],
  ]);
  const native = new CatalogAutoImportNativeFiles({
    catalogId,
    sessionId,
    roots: {
      resolveRoot: async ({ rootId }) => {
        const canonicalPath = roots.get(rootId);
        return canonicalPath === undefined ? null : { catalogId, rootId, canonicalPath };
      },
    },
    assertCurrentSession: () => undefined,
    ...(maxEnumerationCandidates === undefined ? {} : { maxEnumerationCandidates }),
  });
  return { directory, ingressPath, destinationPath, catalogId, sessionId, ingressRootId, destinationRootId, native };
}

function rule(value: NativeFixture): AutoImportRule {
  return {
    catalogId: value.catalogId,
    ruleId: parseAutoImportRuleId(createOperationId()),
    ingressRootId: value.ingressRootId,
    ingressRelativePath: "watch",
    destinationRootId: value.destinationRootId,
    destinationRelativePath: "library",
    placement: "copy",
    presetId: createPresetId(),
    presetVersion: 1,
    presetSha256: "a".repeat(64),
    duplicatePolicy: "continue-unchecked",
    destinationConflictPolicy: "rename",
    enabled: true,
    stabilityMs: 1,
    maxAttempts: 2,
    retryBackoffMs: 1,
  };
}

class FailAfterCatalogApplyJournal implements FileTransactionJournal {
  private failed = false;
  private readonly delegate: FileTransactionJournal;

  public constructor(delegate: FileTransactionJournal) {
    this.delegate = delegate;
  }

  public read(operationId: FileTransactionJournalRecord["operationId"], itemId: FileTransactionJournalRecord["itemId"]): Promise<FileTransactionJournalRecord | null> {
    return this.delegate.read(operationId, itemId);
  }

  public async write(record: FileTransactionJournalRecord): Promise<void> {
    if (!this.failed && record.stage === "catalog-applied") {
      this.failed = true;
      throw new Error("Injected journal write failure after catalog apply.");
    }
    await this.delegate.write(record);
  }

  public list(operationId: FileTransactionJournalRecord["operationId"]): Promise<readonly FileTransactionJournalRecord[]> {
    return this.delegate.list(operationId);
  }
}

test("native Auto Import enumeration is bounded to supported no-follow files", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.ingressPath, "watch", "photo.jpg"), "photo");
    await writeFile(path.join(value.ingressPath, "watch", "photo.dng"), "dng");
    await writeFile(path.join(value.ingressPath, "watch", "notes.txt"), "text");
    const candidates = await value.native.listCandidates(rule(value), [{ kind: "root" }], new AbortController().signal);
    assert.deepEqual(candidates.candidates.map((candidate) => candidate.relativePath), ["watch/photo.jpg"]);
    assert.equal(candidates.overflowed, false);
    const observed = await value.native.observe(value.ingressRootId, "watch/photo.jpg", new AbortController().signal);
    assert.equal(observed.readable, true);
    assert.equal(observed.observation.size, 5);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("native Auto Import reports an explicit enumeration overflow", async () => {
  const value = await fixture(3);
  try {
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(value.ingressPath, "watch", `photo-${index}.jpg`), "photo");
    }
    const candidates = await value.native.listCandidates(rule(value), [{ kind: "root" }], new AbortController().signal, 3);
    assert.equal(candidates.candidates.length, 3);
    assert.equal(candidates.overflowed, true);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("native Auto Import terminates a truncated page with a degraded result", async () => {
  const value = await fixture(3);
  try {
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(value.ingressPath, "watch", `photo-${index}.jpg`), "photo");
    }
    const signal = new AbortController().signal;
    const first = await value.native.listCandidates(rule(value), [{ kind: "root" }], signal, 2);
    const second = await value.native.listCandidates(rule(value), [{ kind: "root" }], signal, 2);
    const exhausted = await value.native.listCandidates(rule(value), [{ kind: "root" }], signal, 2);
    assert.equal(first.overflowed, true);
    assert.equal(second.overflowed, true);
    assert.deepEqual(exhausted.candidates, []);
    assert.equal(exhausted.overflowed, false);
    assert.equal(exhausted.degraded, true);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("native Auto Import rejects symlink traversal and reports path-free fingerprint failures", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.ingressPath, "outside.jpg"), "outside");
    await symlink(path.join(value.ingressPath, "outside.jpg"), path.join(value.ingressPath, "watch", "link.jpg"));
    await assert.rejects(
      value.native.listCandidates(rule(value), [{ kind: "root" }], new AbortController().signal),
      /symbolic link/,
    );
    const result = await value.native.fingerprint(value.ingressRootId, "watch/missing.jpg");
    assert.notEqual(result.reason?.includes(value.directory), true);
    assert.notEqual(result.reason?.includes("/"), true);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("native source observation uses the stem XMP sidecar and rejects DNG", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.ingressPath, "watch", "photo.jpg"), "photo");
    await writeFile(path.join(value.ingressPath, "watch", "photo.xmp"), "<xmp/>");
    const source = await value.native.observeSource({
      catalogId: value.catalogId,
      sessionId: value.sessionId,
      rootId: value.ingressRootId,
      relativePath: "watch/photo.jpg",
    });
    assert.equal(source.xmpState, "present");
    await writeFile(path.join(value.ingressPath, "watch", "photo.dng"), "dng");
    await assert.rejects(
      value.native.observeSource({
        catalogId: value.catalogId,
        sessionId: value.sessionId,
        rootId: value.ingressRootId,
        relativePath: "watch/photo.dng",
      }),
      /format is unavailable/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Auto Import executor freezes the full preset and executes Copy through the shared adapter", async () => {
  const value = await fixture();
  const database = new DatabaseSync(path.join(value.directory, "catalog.db"));
  const repository = new CatalogLiveRepository(database);
  try {
    const sourcePath = path.join(value.ingressPath, "watch", "photo.jpg");
    await writeFile(sourcePath, "photo");
    await writeFile(path.join(value.ingressPath, "watch", "photo.xmp"), "<source/>");
    await mkdir(path.join(value.destinationPath, "library"), { recursive: true });
    await writeFile(path.join(value.destinationPath, "library", "photo.jpg"), "old");
    await writeFile(path.join(value.destinationPath, "library", "photo.xmp"), "<old/>");
    await value.native.listCandidates({
      ...rule(value),
      ingressRelativePath: "watch",
    }, [{ kind: "root" }], new AbortController().signal);
    const sourceObservation = await value.native.observe(value.ingressRootId, "watch/photo.jpg", new AbortController().signal);
    const destinationRoot = await realpath(value.destinationPath);
    repository.create({
      catalogId: value.catalogId,
      displayName: "Fixture",
      appVersion: "test",
      root: {
        rootId: value.ingressRootId,
        label: "Ingress",
        configuredPath: value.ingressPath,
        canonicalPath: value.ingressPath,
        health: "online",
        scanState: "complete",
        watchState: "disabled",
      },
    });
    repository.apply({
      catalogId: value.catalogId,
      expectedRevision: repository.query({ catalogId: value.catalogId, expectedRevision: null }).catalog.revision,
      mutations: [{
        kind: "root-upsert",
        root: {
          rootId: value.destinationRootId,
          label: "Destination",
          configuredPath: value.destinationPath,
          canonicalPath: destinationRoot,
          health: "online",
          scanState: "complete",
          watchState: "disabled",
        },
      }],
    });
    const sourceAssetId = createAssetId();
    repository.apply({
      catalogId: value.catalogId,
      expectedRevision: repository.query({ catalogId: value.catalogId, expectedRevision: null }).catalog.revision,
      mutations: [{
        kind: "reconcile-complete",
        rootId: value.ingressRootId,
        observations: [{
          assetId: sourceAssetId,
          relativePath: "watch/photo.jpg",
          observation: {
            byteLength: sourceObservation.observation.size,
            modifiedAt: sourceObservation.observation.modifiedAt,
            observedAt: sourceObservation.observation.observedAt,
            localFileId: sourceObservation.observation.localFileId,
          },
          health: "present",
          formatId: "jpeg",
          cameraMake: null,
          cameraModel: null,
          lensModel: null,
        }],
      }],
    });
    const preset: ImportPreset = {
      catalogId: value.catalogId,
      presetId: createPresetId(),
      name: "Import defaults",
      version: 2,
      template: { pattern: "{{filename}}" },
      payload: { metadata: { title: "Imported", keywords: ["auto"] } },
      updatedAt: 2,
    };
    const hash = createHash("sha256").update(canonicalJson({
      catalogId: preset.catalogId,
      presetId: preset.presetId,
      name: preset.name,
      version: preset.version,
      template: { pattern: preset.template.pattern },
      payload: preset.payload,
      updatedAt: preset.updatedAt,
    }), "utf8").digest("hex");
    const currentRule: AutoImportRule = {
      ...rule(value),
      presetId: preset.presetId,
      presetVersion: preset.version,
      presetSha256: hash,
    };
    const native = value.native;
    const executor = new CatalogAutoImportExecutor({
      catalogId: value.catalogId,
      sessionId: value.sessionId,
      worker: {
        liveQuery: async (input) => repository.query(input),
        liveApply: async (input) => repository.apply(input),
      },
      assertCurrentSession: () => undefined,
      nativeFiles: native,
      presetResolver: { resolvePreset: async () => preset },
      externalSourceRegistrar: { register: async () => sourceAssetId },
      journal: new FailAfterCatalogApplyJournal(new MemoryFileTransactionJournal()),
    });
    const item = {
      queueId: createOperationId(),
      catalogId: value.catalogId,
      ruleId: currentRule.ruleId,
      relativePath: "watch/photo.jpg",
      placement: "copy" as const,
      observation: sourceObservation.observation,
      dedupeKey: "photo",
      state: "queued" as const,
      attempts: 1,
      maxAttempts: 1,
      retryBackoffMs: 1,
      nextAttemptAt: 0,
      leaseUntil: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const firstExecution = await executor.executeAutoImport(item, currentRule);
    assert.equal(firstExecution.state, "failed");
    assert.equal(firstExecution.retryable, true);
    assert.equal(repository.query({ catalogId: value.catalogId, expectedRevision: null }).operations[0]?.state, "running");
    const execution = await executor.executeAutoImport({ ...item, attempts: 2 }, currentRule);
    assert.equal(execution.state, "completed", execution.error ?? "");
    assert.equal(execution.items[0]?.xmpStatus, "preserved");
    assert.equal(await readFile(path.join(value.destinationPath, "library", "photo (1).jpg"), "utf8"), "photo");
    assert.equal(await readFile(path.join(value.destinationPath, "library", "photo (1).xmp"), "utf8"), "<source/>");
    assert.equal(await readFile(path.join(value.destinationPath, "library", "photo.jpg"), "utf8"), "old");
    const destinationStat = await stat(path.join(value.destinationPath, "library", "photo (1).jpg"));
    const copied = repository.query({ catalogId: value.catalogId, expectedRevision: null }).assets.find((asset) => asset.relativePath === "library/photo (1).jpg");
    assert.ok(copied);
    assert.equal(copied.observation?.byteLength, destinationStat.size);
    assert.equal(copied.observation?.modifiedAt, destinationStat.mtimeMs);
    await assert.rejects(
      executor.executeAutoImport(
        { ...item, queueId: createOperationId() },
        { ...currentRule, presetSha256: "b".repeat(64) },
      ),
      /preset/,
    );
    await writeFile(sourcePath, "changed");
    await assert.rejects(
      executor.executeAutoImport({ ...item, queueId: createOperationId() }, currentRule),
      /stale|changed/i,
    );
  } finally {
    database.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("Auto Import executor resumes the same live operation after a file-stage fault", async () => {
  const value = await fixture();
  const database = new DatabaseSync(path.join(value.directory, "catalog.db"));
  const repository = new CatalogLiveRepository(database);
  try {
    const sourcePath = path.join(value.ingressPath, "watch", "retry.jpg");
    const destinationDirectory = path.join(value.destinationPath, "library");
    await writeFile(sourcePath, "retry");
    await mkdir(destinationDirectory, { recursive: true });
    await value.native.listCandidates({ ...rule(value), ingressRelativePath: "watch" }, [{ kind: "root" }], new AbortController().signal);
    const sourceObservation = await value.native.observe(value.ingressRootId, "watch/retry.jpg", new AbortController().signal);
    repository.create({
      catalogId: value.catalogId,
      displayName: "Fixture",
      appVersion: "test",
      root: {
        rootId: value.ingressRootId,
        label: "Ingress",
        configuredPath: value.ingressPath,
        canonicalPath: value.ingressPath,
        health: "online",
        scanState: "complete",
        watchState: "disabled",
      },
    });
    repository.apply({
      catalogId: value.catalogId,
      expectedRevision: repository.query({ catalogId: value.catalogId, expectedRevision: null }).catalog.revision,
      mutations: [{
        kind: "root-upsert",
        root: {
          rootId: value.destinationRootId,
          label: "Destination",
          configuredPath: value.destinationPath,
          canonicalPath: value.destinationPath,
          health: "online",
          scanState: "complete",
          watchState: "disabled",
        },
      }],
    });
    const sourceAssetId = createAssetId();
    repository.apply({
      catalogId: value.catalogId,
      expectedRevision: repository.query({ catalogId: value.catalogId, expectedRevision: null }).catalog.revision,
      mutations: [{
        kind: "reconcile-complete",
        rootId: value.ingressRootId,
        observations: [{
          assetId: sourceAssetId,
          relativePath: "watch/retry.jpg",
          observation: {
            byteLength: sourceObservation.observation.size,
            modifiedAt: sourceObservation.observation.modifiedAt,
            observedAt: sourceObservation.observation.observedAt,
            localFileId: sourceObservation.observation.localFileId,
          },
          health: "present",
          formatId: "jpeg",
          cameraMake: null,
          cameraModel: null,
          lensModel: null,
        }],
      }],
    });
    const preset: ImportPreset = {
      catalogId: value.catalogId,
      presetId: createPresetId(),
      name: "Retry defaults",
      version: 1,
      template: { pattern: "{{filename}}" },
      payload: {},
      updatedAt: 1,
    };
    const presetSha256 = createHash("sha256").update(canonicalJson({
      catalogId: preset.catalogId,
      presetId: preset.presetId,
      name: preset.name,
      version: preset.version,
      template: { pattern: preset.template.pattern },
      payload: preset.payload,
      updatedAt: preset.updatedAt,
    }), "utf8").digest("hex");
    const currentRule: AutoImportRule = {
      ...rule(value),
      presetId: preset.presetId,
      presetVersion: preset.version,
      presetSha256,
    };
    const item = {
      queueId: createOperationId(),
      catalogId: value.catalogId,
      ruleId: currentRule.ruleId,
      relativePath: "watch/retry.jpg",
      placement: "copy" as const,
      observation: sourceObservation.observation,
      dedupeKey: "retry",
      state: "queued" as const,
      attempts: 1,
      maxAttempts: 2,
      retryBackoffMs: 0,
      nextAttemptAt: 0,
      leaseUntil: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    };
    let injected = false;
    const faultInjector: CatalogFaultInjector = {
      afterStage: (point) => {
        if (!injected && point.stage === "destination-prepared") {
          injected = true;
          throw new CatalogFaultInjectedError(point);
        }
      },
    };
    const executor = new CatalogAutoImportExecutor({
      catalogId: value.catalogId,
      sessionId: value.sessionId,
      worker: {
        liveQuery: async (input) => repository.query(input),
        liveApply: async (input) => repository.apply(input),
      },
      assertCurrentSession: () => undefined,
      nativeFiles: value.native,
      presetResolver: { resolvePreset: async () => preset },
      externalSourceRegistrar: { register: async () => sourceAssetId },
      journal: new MemoryFileTransactionJournal(),
      faultInjector,
    });
    await assert.rejects(executor.executeAutoImport(item, currentRule), CatalogFaultInjectedError);
    const afterFault = repository.query({ catalogId: value.catalogId, expectedRevision: null });
    assert.equal(afterFault.operations[0]?.state, "running");
    assert.equal(afterFault.operations[0]?.items[0]?.state, "running");
    const recovered = await executor.executeAutoImport({ ...item, attempts: 2 }, currentRule);
    assert.equal(recovered.state, "completed", recovered.error ?? "");
    const completed = repository.query({ catalogId: value.catalogId, expectedRevision: null });
    assert.equal(completed.operations[0]?.state, "completed");
    assert.equal(completed.operations[0]?.items[0]?.payload.status, "completed");
    assert.equal(await readFile(path.join(destinationDirectory, "retry.jpg"), "utf8"), "retry");
  } finally {
    database.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
