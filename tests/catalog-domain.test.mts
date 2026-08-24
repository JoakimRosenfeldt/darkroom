import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCatalogId,
  createAssetId,
  createPresetId,
  createRootId,
  parseOperationId,
  type AssetId,
  type CatalogId,
  type OperationId,
  type RootId,
} from "../lib/catalog/ids.ts";
import {
  createImportPlan,
  createUnavailableDngAdapter,
  freezeImportPlan,
  reviewImportPlan,
} from "../electron/import-plan-service.ts";
import {
  fingerprintCandidate,
  fingerprintChunks,
  observeNoFollowFile,
  reviewDuplicates,
  reviewDuplicatesOnDemand,
  runFingerprintBackfill,
} from "../electron/catalog-fingerprint-service.ts";
import {
  CatalogFaultInjectedError,
  CATALOG_FAULT_STAGES,
  createCatalogFaultInjectorForTests,
  createNoopCatalogFaultInjector,
  type CatalogFaultInjector,
} from "../electron/catalog-fault-injection.ts";
import {
  executeFileTransactions,
  MemoryFileTransactionJournal,
  recoverFileTransactions,
  type FileTransactionCatalogAdapter,
  type FileTransactionBackupProof,
  type FileTransactionFileSystem,
  type FileTransactionJournal,
  type FileTransactionPathResolver,
  type ResolvedTransactionPaths,
} from "../electron/file-transaction-service.ts";
import { createNativeFileTransactionFileSystem } from "../electron/native-file-transaction-helper.ts";
import {
  createRestoreDryRun,
  FileRestoreEnvelopeStore,
  optimizeCatalog,
  restoreConfirmation,
  runRestore,
  validateCatalogPackage,
  writeCatalogPackage,
  type RestoreAdapter,
  type RestoreForwardFact,
  type CatalogAdminAdapter,
} from "../electron/catalog-package-service.ts";
import {
  AutoImportQueue,
  isStableAutoImportFile,
  validateAutoImportRules,
  type AutoImportRule,
} from "../lib/import/auto-import.ts";
import type {
  FileObservation,
  FrozenImportPlan,
  ImportPlanReview,
  ImportPreset,
  ImportSource,
} from "../lib/import/domain.ts";
import { renderImportTemplate } from "../lib/import/domain.ts";

async function temporaryDirectory(): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-domain-")));
}

function operationId(): OperationId {
  return parseOperationId(randomUUID());
}

function observation(size = 4, modifiedAt = 1, localFileId: string | null = "dev:ino"): FileObservation {
  return { size, modifiedAt, localFileId, observedAt: 2 };
}

async function digestForTransaction(filePath: string): Promise<FileTransactionBackupProof> {
  const bytes = await fsp.readFile(filePath);
  const stat = await fsp.stat(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    observation: {
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      localFileId: `${stat.dev}:${stat.ino}`,
      observedAt: Date.now(),
    },
  };
}

function preset(catalogId: CatalogId): ImportPreset {
  return {
    catalogId,
    presetId: createPresetId(),
    name: "By date",
    version: 1,
    template: { pattern: "{{year}}/{{month}}/{{filename}}" },
    payload: { kind: "copy", sidecars: true },
    updatedAt: 3,
  };
}

function source(rootId: RootId, relativePath = "photo.jpg", fileObservation = observation()): ImportSource {
  return {
    rootId,
    relativePath,
    observation: fileObservation,
    xmpState: "absent",
    formatId: "jpeg",
  };
}

function makePlan(
  action: "add" | "copy" | "move" | "rename" = "copy",
  fileObservation = observation(),
): FrozenImportPlan {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const draft = createImportPlan({
    operationId: operationId(),
    catalogId,
    destinationRootId: rootId,
    preset: preset(catalogId),
    sources: [{
      source: source(rootId, "photo.jpg", fileObservation),
      action,
      sourceAssetId: action === "move" || action === "rename" ? createAssetId() : undefined,
    }],
    now: 1_700_000_000_000,
  });
  const review = reviewImportPlan(draft);
  return freezeImportPlan({ draft, review });
}

test("fingerprints stream bytes, invalidate changed stats, and resume cancellation", async () => {
  const directory = await temporaryDirectory();
  try {
    const filePath = path.join(directory, "photo.jpg");
    await fsp.writeFile(filePath, "same");
    const storedObservation = await observeNoFollowFile(filePath);
    const assetId = makePlan().items[0]!.itemId;
    const reused = await fingerprintCandidate({
      assetId,
      filePath,
      storedStatus: "valid",
      storedSha256: "a".repeat(64),
      storedObservation,
    });
    assert.equal(reused.result.status, "valid");
    assert.equal(reused.result.sha256, "a".repeat(64));

    await fsp.writeFile(filePath, "new!");
    await fsp.utimes(filePath, new Date(10_000), new Date(10_000));
    const invalidated = await fingerprintCandidate({
      assetId,
      filePath,
      storedStatus: "valid",
      storedSha256: "a".repeat(64),
      storedObservation,
    });
    assert.equal(invalidated.result.status, "valid");
    assert.notEqual(invalidated.result.sha256, "a".repeat(64));

    const unreadable = await fingerprintCandidate({
      assetId,
      filePath: path.join(directory, "missing.jpg"),
      storedStatus: "valid",
      storedSha256: "b".repeat(64),
      storedObservation: observation(4, storedObservation.modifiedAt, storedObservation.localFileId),
    });
    assert.equal(unreadable.result.status, "not-fully-checked");

    const first = await fingerprintChunks({
      before: observation(4),
      chunks: (async function* (): AsyncIterable<Uint8Array> { yield Buffer.from("same"); })(),
      after: async () => observation(4),
    });
    const second = await fingerprintChunks({
      before: observation(4, 1, "other"),
      chunks: (async function* (): AsyncIterable<Uint8Array> { yield Buffer.from("same"); })(),
      after: async () => observation(4, 1, "other"),
    });
    const cancelledChunks = await fingerprintChunks({
      before: observation(4),
      chunks: (async function* (): AsyncIterable<Uint8Array> { yield Buffer.from("same"); })(),
      after: async () => observation(4),
      isCancelled: () => true,
    });
    assert.equal(cancelledChunks.status, "cancelled");
    const duplicates = reviewDuplicates([
      { assetId, result: first },
      { assetId: makePlan().items[0]!.itemId, result: second },
    ]);
    assert.equal(duplicates.groups.length, 1);
    assert.equal(duplicates.notFullyChecked.length, 0);
    const sameSizeExistingId = makePlan().items[0]!.itemId;
    const unrelatedSizeId = makePlan().items[0]!.itemId;
    const unrelatedPath = path.join(directory, "unrelated.jpg");
    await fsp.writeFile(unrelatedPath, "other");
    const incomingCandidate = {
      assetId,
      filePath,
      storedStatus: "missing" as const,
      storedSha256: null,
      storedObservation: null,
    };
    const sameSizeExisting = {
      assetId: sameSizeExistingId,
      filePath,
      storedStatus: "stale" as const,
      storedSha256: "c".repeat(64),
      storedObservation: observation(4),
    };
    const unrelatedSizeExisting = {
      assetId: unrelatedSizeId,
      filePath: unrelatedPath,
      storedStatus: "missing" as const,
      storedSha256: null,
      storedObservation: observation(5),
    };
    const hashedCandidates: AssetId[] = [];
    const onDemandWithSources = await reviewDuplicatesOnDemand(
      { incoming: incomingCandidate, existing: [sameSizeExisting, unrelatedSizeExisting] },
      async (candidate) => {
        hashedCandidates.push(candidate.assetId);
        return {
          assetId: candidate.assetId,
          result: candidate.assetId === assetId ? first : second,
        };
      },
    );
    assert.equal(onDemandWithSources.groups.length, 1);
    assert.deepEqual(hashedCandidates, [assetId, sameSizeExistingId]);
    const failedOnDemand = await reviewDuplicatesOnDemand(
      { incoming: incomingCandidate, existing: [sameSizeExisting] },
      async (candidate) => ({
        assetId: candidate.assetId,
        result: { status: "cancelled", sha256: null, observation: null, reason: null },
      }),
    );
    assert.deepEqual(failedOnDemand.notFullyChecked, [assetId, sameSizeExistingId]);

    const failedBackfill = await runFingerprintBackfill({
      candidates: [{ assetId, filePath: directory, storedStatus: "missing", storedSha256: null, storedObservation: null }],
    });
    assert.equal(failedBackfill.failed, 1);

    let cancelled = false;
    const backfill = await runFingerprintBackfill({
      candidates: [
        { assetId, filePath, storedStatus: "missing", storedSha256: null, storedObservation: null },
        { assetId: makePlan().items[0]!.itemId, filePath, storedStatus: "missing", storedSha256: null, storedObservation: null },
      ],
      isCancelled: () => cancelled,
      onResult: () => { cancelled = true; },
    });
    assert.equal(backfill.cancelled, true);
    assert.equal(backfill.processed, 1);
    assert.equal(backfill.stale, 0);
    assert.equal(backfill.indexed, 1);
    assert.equal(backfill.remaining, 1);
    const resumed = await runFingerprintBackfill({
      candidates: [
        { assetId, filePath, storedStatus: "stale", storedSha256: null, storedObservation: storedObservation },
        { assetId: makePlan().items[0]!.itemId, filePath: directory, storedStatus: "missing", storedSha256: null, storedObservation: null },
      ],
      startIndex: 1,
    });
    assert.equal(resumed.processed, 2);
    assert.equal(resumed.remaining, 0);
    assert.equal(resumed.stale, 1);
    assert.equal(resumed.failed, 1);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("import plans render deterministic templates and enforce AssetId rules", () => {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const existing = makePlan().items[0]!.itemId;
  const plan = createImportPlan({
    operationId: operationId(),
    catalogId,
    destinationRootId: rootId,
    preset: preset(catalogId),
    sources: [
      { source: source(rootId, "a.jpg", observation(4, Date.UTC(2024, 4, 2))), action: "add", sourceAssetId: existing },
      { source: source(rootId, "b.jpg", observation(4, Date.UTC(2024, 4, 2))), action: "copy" },
      { source: source(rootId, "c.jpg", observation(4, Date.UTC(2024, 4, 2))), action: "move", sourceAssetId: existing },
      { source: source(rootId, "d.jpg", observation(4, Date.UTC(2024, 4, 2))), action: "rename", sourceAssetId: existing },
    ],
    now: Date.UTC(2024, 4, 2),
  });
  assert.equal(plan.items[0]!.destinationAssetId, existing);
  assert.notEqual(plan.items[1]!.destinationAssetId, existing);
  assert.equal(plan.items[2]!.destinationAssetId, existing);
  assert.equal(plan.items[3]!.destinationAssetId, existing);
  const externalMove = createImportPlan({
    operationId: operationId(),
    catalogId,
    destinationRootId: rootId,
    preset: preset(catalogId),
    sources: [{ source: source(rootId, "external.jpg"), action: "move" }],
  });
  assert.equal(externalMove.items[0]!.sourceAssetId, null);
  assert.notEqual(externalMove.items[0]!.destinationAssetId, null);
  assert.throws(() => createImportPlan({
    operationId: operationId(),
    catalogId,
    destinationRootId: rootId,
    preset: preset(catalogId),
    sources: [{ source: source(rootId, "rename.jpg"), action: "rename" }],
  }), /Rename requires/);
  assert.equal(plan.items[0]!.destinationRelativePath, "a.jpg");
  const tokenPlan = createImportPlan({
    operationId: operationId(),
    catalogId,
    destinationRootId: rootId,
    preset: {
      ...preset(catalogId),
      template: { pattern: "{{cameraMake}}/{{cameraModel}}/{{sequence}}-{{original}}" },
    },
    sources: [{
      source: source(rootId, "original.jpg", observation(4, Date.UTC(2024, 4, 2))),
      action: "copy",
      cameraMake: "Nikon",
      cameraModel: "Z8",
      sequence: 7,
    }],
    now: Date.UTC(2024, 4, 2),
  });
  assert.equal(tokenPlan.items[0]!.destinationRelativePath, "Nikon/Z8/0007-original.jpg");

  const review = reviewImportPlan(plan, {
    destinationExists: new Set([plan.items[0]!.destinationRelativePath]),
    notFullyCheckedItems: new Set([plan.items[1]!.itemId]),
  });
  assert.equal(review.canFreeze, false);
  assert.throws(() => freezeImportPlan({ draft: plan, review }));

  const cleanReview = reviewImportPlan(plan);
  const frozen = freezeImportPlan({ draft: plan, review: cleanReview });
  assert.doesNotThrow(() => freezeImportPlan({ draft: plan, review: cleanReview }));
  assert.equal(frozen.planSha256, freezeImportPlan({ draft: plan, review: cleanReview }).planSha256);
  assert.equal(createUnavailableDngAdapter().convert({}).then !== undefined, true);
    const resolvedReview = reviewImportPlan(plan, {
      destinationExists: new Set([plan.items[0]!.destinationRelativePath]),
      destinationDecisions: new Map([[plan.items[0]!.itemId, { kind: "rename", destinationRelativePath: "2024/05/renamed.jpg" }]]),
  });
  assert.equal(resolvedReview.canFreeze, true);
    const resolvedPlan = freezeImportPlan({ draft: plan, review: resolvedReview });
    assert.equal(resolvedPlan.items[0]!.destinationRelativePath, "2024/05/renamed.jpg");
    assert.equal(resolvedPlan.items[0]!.conflictDecisions.destination?.kind, "rename");
    const matchedAssetId = createAssetId();
    const bothReview = reviewImportPlan(plan, {
      destinationDecisions: new Map([[plan.items[0]!.itemId, { kind: "rename", destinationRelativePath: "2024/05/matched.jpg" }]]),
      duplicateDecisions: new Map([[plan.items[0]!.itemId, { kind: "use-existing-location", existingAssetId: matchedAssetId }]]),
    });
    const bothPlan = freezeImportPlan({ draft: plan, review: bothReview });
    assert.equal(bothPlan.items[0]!.destinationAssetId, matchedAssetId);
    assert.equal(bothPlan.items[0]!.conflictDecisions.duplicate?.kind, "use-existing-location");
    assert.equal(bothPlan.items[0]!.conflictDecisions.destination?.kind, "rename");
  const blockedRename = reviewImportPlan(plan, {
      destinationDecisions: new Map([[plan.items[0]!.itemId, { kind: "rename", destinationRelativePath: "2024/05/occupied.jpg" }]]),
      destinationExists: new Set(["2024/05/occupied.jpg"]),
  });
  assert.equal(blockedRename.canFreeze, false);
  const duplicateSkipped = reviewImportPlan(plan, {
    destinationExists: new Set([plan.items[1]!.destinationRelativePath]),
    duplicateItems: new Set([plan.items[1]!.itemId]),
    duplicateDecisions: new Map([[plan.items[1]!.itemId, { kind: "skip-incoming" }]]),
  });
  assert.equal(duplicateSkipped.canFreeze, true);
  const destinationSkipped = reviewImportPlan(plan, {
    destinationExists: new Set([plan.items[1]!.destinationRelativePath]),
    duplicateItems: new Set([plan.items[1]!.itemId]),
    notFullyCheckedItems: new Set([plan.items[1]!.itemId]),
    destinationDecisions: new Map([[plan.items[1]!.itemId, { kind: "skip" }]]),
  });
  assert.equal(destinationSkipped.canFreeze, true);
  const continueUnchecked = reviewImportPlan(plan, {
    notFullyCheckedItems: new Set([plan.items[1]!.itemId]),
    duplicateDecisions: new Map([[plan.items[1]!.itemId, { kind: "continue-unchecked" }]]),
  });
  assert.equal(continueUnchecked.canFreeze, true);
  const uncheckedFrozen = freezeImportPlan({ draft: plan, review: continueUnchecked });
  assert.equal(uncheckedFrozen.items[1]!.conflictDecisions.duplicate?.kind, "continue-unchecked");
  const reviewedRename = reviewImportPlan(plan, {
    destinationDecisions: new Map([[plan.items[1]!.itemId, { kind: "rename", destinationRelativePath: "2024/05/reviewed.jpg" }]]),
  });
  const forgedReview: ImportPlanReview = {
    ...reviewedRename,
    decisions: reviewedRename.decisions.map((entry) => {
      if (entry.decisions.destination?.kind !== "rename") return entry;
      return {
        ...entry,
        decisions: {
          ...entry.decisions,
          destination: {
            ...entry.decisions.destination,
            destinationRelativePath: "2024/05/forged.jpg",
          },
        },
      };
    }),
  };
  assert.throws(() => freezeImportPlan({ draft: plan, review: forgedReview }), /review is stale/);
  assert.equal(renderImportTemplate({ pattern: "{{filename}}" }, {
    filename: "file.jpg",
    stem: "file",
    extension: "jpg",
    original: "file.jpg",
    cameraMake: "Unknown",
    cameraModel: "Unknown",
    sequence: 1,
    date: new Date(0),
  }), "file.jpg");
});

test("file transactions recover all five stages for Copy, Move, and Rename", async () => {
  for (const action of ["copy", "move", "rename"] as const) {
    for (const stage of CATALOG_FAULT_STAGES) {
      const directory = await temporaryDirectory();
      try {
      const sourcePath = path.join(directory, "source.jpg");
        const destinationPath = path.join(directory, "destination", "photo.jpg");
        await fsp.writeFile(sourcePath, "same");
        const sourceStat = await fsp.stat(sourcePath);
        const plan = makePlan(action, {
          size: sourceStat.size,
          modifiedAt: sourceStat.mtimeMs,
          localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
          observedAt: Date.now(),
        });
        const item = plan.items[0]!;
        const resolver: FileTransactionPathResolver = {
          resolve: async (): Promise<ResolvedTransactionPaths> => ({
            sourcePath,
            destinationPath,
            xmp: null,
          }),
        };
        const applied: AssetId[] = [];
        const catalog: FileTransactionCatalogAdapter = {
          apply: async (appliedItem) => { applied.push(appliedItem.destinationAssetId); },
        };
        const journal = new MemoryFileTransactionJournal();
        const fault = createCatalogFaultInjectorForTests([{
          operationId: plan.operationId,
          itemId: item.itemId,
          stage,
        }]);
        await assert.rejects(
          executeFileTransactions({ plan, paths: resolver, journal, catalog, faultInjector: fault }),
          CatalogFaultInjectedError,
        );
        const recovered = await recoverFileTransactions({
          plan,
          paths: resolver,
          journal,
          catalog,
          faultInjector: createNoopCatalogFaultInjector(),
        });
        assert.equal(recovered[0]!.status, "completed", recovered[0]!.error ?? "");
        assert.equal(await fsp.readFile(destinationPath, "utf8"), "same");
        if (action === "copy") assert.equal(await fsp.readFile(sourcePath, "utf8"), "same");
        else await assert.rejects(fsp.stat(sourcePath));
        assert.equal(applied.length >= 1, true);
      } finally {
        await fsp.rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("file transactions reject a destination parent swapped to a symlink before publish", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationParent = path.join(directory, "destination");
    const displacedParent = path.join(directory, "destination-displaced");
    const outsidePath = path.join(directory, "outside");
    const destinationPath = path.join(destinationParent, "photo.jpg");
    await fsp.mkdir(destinationParent);
    await fsp.mkdir(outsidePath);
    await fsp.writeFile(sourcePath, "same");
    const sourceStat = await fsp.stat(sourcePath);
    const plan = makePlan("copy", {
      size: sourceStat.size,
      modifiedAt: sourceStat.mtimeMs,
      localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
      observedAt: Date.now(),
    });
    let swapped = false;
    const fault: CatalogFaultInjector = {
      afterStage(point): void {
        if (point.stage !== "destination-prepared" || swapped) return;
        swapped = true;
        const stageName = `photo.jpg.darkroom-stage-${plan.operationId}-${plan.items[0]!.itemId}`;
        fs.renameSync(destinationParent, displacedParent);
        fs.renameSync(path.join(displacedParent, stageName), path.join(outsidePath, stageName));
        fs.symlinkSync(outsidePath, destinationParent);
      },
    };
    let catalogApplies = 0;
    const result = await executeFileTransactions({
      plan,
      paths: { resolve: async () => ({ sourcePath, destinationPath, xmp: null }) },
      journal: new MemoryFileTransactionJournal(),
      catalog: { apply: async () => { catalogApplies += 1; } },
      faultInjector: fault,
    });
    assert.equal(result[0]?.status, "failed");
    assert.equal(catalogApplies, 0);
    await assert.rejects(fsp.stat(path.join(outsidePath, "photo.jpg")));
    assert.equal((await fsp.lstat(destinationParent)).isSymbolicLink(), true);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("file transactions surface an unavailable native helper without publishing", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "destination", "photo.jpg");
    await fsp.writeFile(sourcePath, "same");
    const sourceStat = await fsp.stat(sourcePath);
    const plan = makePlan("copy", {
      size: sourceStat.size,
      modifiedAt: sourceStat.mtimeMs,
      localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
      observedAt: Date.now(),
    });
    let catalogApplies = 0;
    const result = await executeFileTransactions({
      plan,
      paths: { resolve: async () => ({ sourcePath, destinationPath, xmp: null }) },
      journal: new MemoryFileTransactionJournal(),
      catalog: { apply: async () => { catalogApplies += 1; } },
      faultInjector: createNoopCatalogFaultInjector(),
      fileSystem: createNativeFileTransactionFileSystem({ helperPath: null }),
    });
    assert.equal(result[0]?.status, "failed");
    assert.equal(result[0]?.error, "Native file transactions are unavailable on this build.");
    assert.equal(catalogApplies, 0);
    await assert.rejects(fsp.lstat(destinationPath));
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("file transactions preserve XMP bundles, report mismatch, and cancel before publish", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const xmpPath = path.join(directory, "source.xmp");
    const destinationPath = path.join(directory, "out", "photo.jpg");
    const destinationXmpPath = path.join(directory, "out", "photo.xmp");
    await fsp.writeFile(sourcePath, "phot");
    await fsp.writeFile(xmpPath, "xmp");
    const catalogId = createCatalogId();
    const rootId = createRootId();
    const sourceStat = await fsp.stat(sourcePath);
    const draft = createImportPlan({
      operationId: operationId(),
      catalogId,
      destinationRootId: rootId,
      preset: preset(catalogId),
      sources: [{ source: {
        ...source(rootId, "photo.jpg", {
          size: sourceStat.size,
          modifiedAt: sourceStat.mtimeMs,
          localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
          observedAt: Date.now(),
        }),
        xmpState: "present",
      }, action: "copy" }],
      now: 1_700_000_000_000,
    });
    const plan = freezeImportPlan({ draft, review: reviewImportPlan(draft) });
    const resolver: FileTransactionPathResolver = {
      resolve: async (): Promise<ResolvedTransactionPaths> => ({
        sourcePath,
        destinationPath,
        xmp: {
          sourcePath: xmpPath,
          destinationPath: destinationXmpPath,
          sourceObservation: { size: 3, modifiedAt: 1, localFileId: "wrong" },
        },
      }),
    };
    const journal = new MemoryFileTransactionJournal();
    const catalog: FileTransactionCatalogAdapter = { apply: async () => undefined };
    const mismatch = await executeFileTransactions({
      plan,
      paths: resolver,
      journal,
      catalog,
      faultInjector: createNoopCatalogFaultInjector(),
    });
    assert.equal(mismatch[0]!.status, "failed");
    assert.equal(mismatch[0]!.xmpStatus, "mismatch");
    assert.equal(await fsp.stat(destinationPath).then(() => true).catch(() => false), false);

    let checks = 0;
    const cancelled = await executeFileTransactions({
      plan,
      paths: resolver,
      journal: new MemoryFileTransactionJournal(),
      catalog,
      faultInjector: createNoopCatalogFaultInjector(),
      isCancelled: () => { checks += 1; return checks >= 3; },
    });
    assert.equal(cancelled[0]!.status, "cancelled");
    assert.equal(cancelled[0]!.stage, "planned");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("file transactions fall back from cross-volume rename to copy", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "out", "photo.jpg");
    await fsp.writeFile(sourcePath, "same");
    const stat = await fsp.stat(sourcePath);
    const plan = makePlan("copy", {
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      localFileId: `${stat.dev}:${stat.ino}`,
      observedAt: Date.now(),
    });
    const fileSystem: FileTransactionFileSystem = {
      exists: async (filePath) => fsp.stat(filePath).then(() => true).catch(() => false),
      mkdir: async (directoryPath) => { await fsp.mkdir(directoryPath, { recursive: true }); },
      copyFile: async (source, destination) => { await fsp.copyFile(source, destination); },
      rename: async () => {
        const error = new Error("cross-volume");
        Object.assign(error, { code: "EXDEV" });
        throw error;
      },
      removeFile: async (filePath) => { await fsp.unlink(filePath).catch(() => undefined); },
      observe: async (filePath) => {
        const observed = await fsp.stat(filePath);
        return {
          size: observed.size,
          modifiedAt: observed.mtimeMs,
          localFileId: `${observed.dev}:${observed.ino}`,
          observedAt: Date.now(),
        };
      },
      digest: digestForTransaction,
      verifyCopy: async (source, destination, expected) => {
        assert.deepEqual(await fsp.readFile(source), await fsp.readFile(destination));
        const sourceStat = await fsp.stat(source);
        assert.equal(sourceStat.size, expected.size);
        assert.equal(sourceStat.mtimeMs, expected.modifiedAt);
      },
      verifyObservation: async (filePath, expected) => {
        const current = await fsp.stat(filePath);
        assert.equal(current.size, expected.size);
        assert.equal(current.mtimeMs, expected.modifiedAt);
      },
    };
    const resolver: FileTransactionPathResolver = {
      resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }),
    };
    const result = await executeFileTransactions({
      plan,
      paths: resolver,
      journal: new MemoryFileTransactionJournal(),
      catalog: { apply: async () => undefined },
      faultInjector: createNoopCatalogFaultInjector(),
      fileSystem,
    });
    assert.equal(result[0]!.status, "completed");
    assert.equal(await fsp.readFile(destinationPath, "utf8"), "same");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("Move and Rename cleanup rechecks replacement image and XMP identities", async () => {
  for (const action of ["move", "rename"] as const) {
    for (const changedPart of ["image", "xmp"] as const) {
      const directory = await temporaryDirectory();
      try {
        const sourcePath = path.join(directory, "source.jpg");
        const xmpPath = path.join(directory, "source.xmp");
        const destinationPath = path.join(directory, "out", "photo.jpg");
        const destinationXmpPath = path.join(directory, "out", "photo.xmp");
        await fsp.writeFile(sourcePath, "same");
        await fsp.writeFile(xmpPath, "xmp");
        await fsp.utimes(sourcePath, new Date(1_000), new Date(1_000));
        await fsp.utimes(xmpPath, new Date(1_000), new Date(1_000));
        const imageStat = await fsp.stat(sourcePath);
        const xmpStat = await fsp.stat(xmpPath);
        const rootId = createRootId();
        const catalogId = createCatalogId();
        const draft = createImportPlan({
          operationId: operationId(),
          catalogId,
          destinationRootId: rootId,
          preset: { ...preset(catalogId), template: { pattern: "{{filename}}" } },
          sources: [{
            source: {
              rootId,
              relativePath: "source.jpg",
              observation: {
                size: imageStat.size,
                modifiedAt: imageStat.mtimeMs,
                localFileId: `${imageStat.dev}:${imageStat.ino}`,
                observedAt: Date.now(),
              },
              xmpState: "present",
              formatId: "jpeg",
            },
            action,
            sourceAssetId: createAssetId(),
          }],
        });
        const plan = freezeImportPlan({ draft, review: reviewImportPlan(draft) });
        const journal = new MemoryFileTransactionJournal();
        const resolver: FileTransactionPathResolver = {
          resolve: async (): Promise<ResolvedTransactionPaths> => ({
            sourcePath,
            destinationPath,
            xmp: {
              sourcePath: xmpPath,
              destinationPath: destinationXmpPath,
              sourceObservation: {
                size: xmpStat.size,
                modifiedAt: xmpStat.mtimeMs,
                localFileId: `${xmpStat.dev}:${xmpStat.ino}`,
              },
            },
          }),
        };
        const catalog: FileTransactionCatalogAdapter = {
          apply: async () => {
            await fsp.writeFile(changedPart === "image" ? sourcePath : xmpPath, "replacement");
          },
        };
        const retained = await executeFileTransactions({
          plan,
          paths: resolver,
          journal,
          catalog,
          faultInjector: createNoopCatalogFaultInjector(),
        });
        assert.equal(retained[0]!.status, "completed");
        assert.equal(retained[0]!.stage, "catalog-applied");
        assert.equal(retained[0]!.sourceCleaned, false);
        assert.equal(retained[0]!.error, "Destination is active, but the source was retained.");
        assert.equal(await fsp.readFile(sourcePath, "utf8"), changedPart === "image" ? "replacement" : "same");
        assert.equal(await fsp.readFile(xmpPath, "utf8"), changedPart === "xmp" ? "replacement" : "xmp");

        await fsp.writeFile(sourcePath, "same");
        await fsp.utimes(sourcePath, new Date(imageStat.mtimeMs), new Date(imageStat.mtimeMs));
        await fsp.writeFile(xmpPath, "xmp");
        await fsp.utimes(xmpPath, new Date(xmpStat.mtimeMs), new Date(xmpStat.mtimeMs));
        const recovered = await recoverFileTransactions({
          plan,
          paths: resolver,
          journal,
          catalog: { apply: async () => undefined },
          faultInjector: createNoopCatalogFaultInjector(),
        });
        assert.equal(recovered[0]!.status, "completed", recovered[0]!.error ?? "");
        await assert.rejects(fsp.stat(sourcePath));
        await assert.rejects(fsp.stat(xmpPath));
      } finally {
        await fsp.rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("Move and Rename recovery treats missing source bundle members as already cleaned", async () => {
  for (const action of ["move", "rename"] as const) {
    for (const missing of ["image", "xmp", "both"] as const) {
      const directory = await temporaryDirectory();
      try {
        const sourcePath = path.join(directory, "source.jpg");
        const xmpPath = path.join(directory, "source.xmp");
        const destinationPath = path.join(directory, "out", "photo.jpg");
        const destinationXmpPath = path.join(directory, "out", "photo.xmp");
        await fsp.writeFile(sourcePath, "same");
        await fsp.writeFile(xmpPath, "xmp");
        await fsp.utimes(sourcePath, new Date(1_000), new Date(1_000));
        await fsp.utimes(xmpPath, new Date(1_000), new Date(1_000));
        const imageStat = await fsp.stat(sourcePath);
        const xmpStat = await fsp.stat(xmpPath);
        const rootId = createRootId();
        const catalogId = createCatalogId();
        const draft = createImportPlan({
          operationId: operationId(),
          catalogId,
          destinationRootId: rootId,
          preset: { ...preset(catalogId), template: { pattern: "{{filename}}" } },
          sources: [{
            source: {
              rootId,
              relativePath: "source.jpg",
              observation: {
                size: imageStat.size,
                modifiedAt: imageStat.mtimeMs,
                localFileId: `${imageStat.dev}:${imageStat.ino}`,
                observedAt: Date.now(),
              },
              xmpState: "present",
              formatId: "jpeg",
            },
            action,
            sourceAssetId: createAssetId(),
          }],
        });
        const plan = freezeImportPlan({ draft, review: reviewImportPlan(draft) });
        const baseJournal = new MemoryFileTransactionJournal();
        let crash = true;
        const journal: FileTransactionJournal = {
          read: (operation, itemId) => baseJournal.read(operation, itemId),
          write: async (record) => {
            if (record.stage === "source-cleaned" && crash) {
              crash = false;
              throw new Error("simulated crash before source-cleaned journal write");
            }
            await baseJournal.write(record);
          },
          list: (operation) => baseJournal.list(operation),
        };
        const resolver: FileTransactionPathResolver = {
          resolve: async (): Promise<ResolvedTransactionPaths> => ({
            sourcePath,
            destinationPath,
            xmp: {
              sourcePath: xmpPath,
              destinationPath: destinationXmpPath,
              sourceObservation: {
                size: xmpStat.size,
                modifiedAt: xmpStat.mtimeMs,
                localFileId: `${xmpStat.dev}:${xmpStat.ino}`,
              },
            },
          }),
        };
        const retained = await executeFileTransactions({
          plan,
          paths: resolver,
          journal,
          catalog: {
            apply: async () => {
              if (missing === "image" || missing === "both") await fsp.unlink(sourcePath);
              if (missing === "xmp" || missing === "both") await fsp.unlink(xmpPath);
            },
          },
          faultInjector: createNoopCatalogFaultInjector(),
        });
        assert.equal(retained[0]!.status, "completed");
        assert.equal(retained[0]!.stage, "catalog-applied");
        assert.equal(retained[0]!.sourceCleaned, false);
        assert.equal(retained[0]!.error, "Destination is active, but the source was retained.");
        const recovered = await recoverFileTransactions({
          plan,
          paths: resolver,
          journal,
          catalog: { apply: async () => undefined },
          faultInjector: createNoopCatalogFaultInjector(),
        });
        assert.equal(recovered[0]!.status, "completed", recovered[0]!.error ?? "");
        await assert.rejects(fsp.stat(sourcePath));
        await assert.rejects(fsp.stat(xmpPath));
        assert.equal(await fsp.readFile(destinationPath, "utf8"), "same");
        assert.equal(await fsp.readFile(destinationXmpPath, "utf8"), "xmp");
      } finally {
        await fsp.rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("file transaction recovery rebuilds a partial private XMP bundle stage", async () => {
  for (const partial of ["image", "xmp"] as const) {
    const directory = await temporaryDirectory();
    try {
      const sourcePath = path.join(directory, "source.jpg");
      const xmpPath = path.join(directory, "source.xmp");
      const destinationPath = path.join(directory, "out", "photo.jpg");
      const destinationXmpPath = path.join(directory, "out", "photo.xmp");
      await fsp.writeFile(sourcePath, "same");
      await fsp.writeFile(xmpPath, "xmp");
      const imageStat = await fsp.stat(sourcePath);
      const xmpStat = await fsp.stat(xmpPath);
      const catalogId = createCatalogId();
      const rootId = createRootId();
      const draft = createImportPlan({
        operationId: operationId(),
        catalogId,
        destinationRootId: rootId,
        preset: { ...preset(catalogId), template: { pattern: "{{filename}}" } },
        sources: [{
          source: {
            rootId,
            relativePath: "source.jpg",
            observation: {
              size: imageStat.size,
              modifiedAt: imageStat.mtimeMs,
              localFileId: `${imageStat.dev}:${imageStat.ino}`,
              observedAt: Date.now(),
            },
            xmpState: "present",
            formatId: "jpeg",
          },
          action: "copy",
        }],
      });
      const plan = freezeImportPlan({ draft, review: reviewImportPlan(draft) });
      const resolver: FileTransactionPathResolver = {
        resolve: async (): Promise<ResolvedTransactionPaths> => ({
          sourcePath,
          destinationPath,
          xmp: {
            sourcePath: xmpPath,
            destinationPath: destinationXmpPath,
            sourceObservation: {
              size: xmpStat.size,
              modifiedAt: xmpStat.mtimeMs,
              localFileId: `${xmpStat.dev}:${xmpStat.ino}`,
            },
          },
        }),
      };
      const baseJournal = new MemoryFileTransactionJournal();
      let crashed = false;
      const journal: FileTransactionJournal = {
        read: (operation, itemId) => baseJournal.read(operation, itemId),
        write: async (record) => {
          await baseJournal.write(record);
          if (record.stage === "planned" && !crashed) {
            crashed = true;
            const stage = partial === "image" ? record.imageStagePath : record.xmpStagePath!;
            await fsp.mkdir(path.dirname(stage), { recursive: true });
            await fsp.copyFile(partial === "image" ? sourcePath : xmpPath, stage);
            throw new Error("simulated crash with a partial private stage");
          }
        },
        list: (operation) => baseJournal.list(operation),
      };
      const first = await executeFileTransactions({
        plan,
        paths: resolver,
        journal,
        catalog: { apply: async () => undefined },
        faultInjector: createNoopCatalogFaultInjector(),
      });
      assert.equal(first[0]!.status, "failed");
      const recovered = await recoverFileTransactions({
        plan,
        paths: resolver,
        journal,
        catalog: { apply: async () => undefined },
        faultInjector: createNoopCatalogFaultInjector(),
      });
      assert.equal(recovered[0]!.status, "completed", recovered[0]!.error ?? "");
      assert.equal(await fsp.readFile(destinationPath, "utf8"), "same");
      assert.equal(await fsp.readFile(destinationXmpPath, "utf8"), "xmp");
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }
});

test("catalog apply remains retryable after an ambiguous acknowledgement", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "out", "photo.jpg");
    await fsp.writeFile(sourcePath, "same");
    const stat = await fsp.stat(sourcePath);
    const plan = makePlan("copy", {
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      localFileId: `${stat.dev}:${stat.ino}`,
      observedAt: Date.now(),
    });
    const resolver: FileTransactionPathResolver = {
      resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }),
    };
    let applies = 0;
    const catalog: FileTransactionCatalogAdapter = {
      apply: async () => {
        applies += 1;
        if (applies === 1) throw new Error("catalog acknowledgement was lost");
      },
    };
    const journal = new MemoryFileTransactionJournal();
    const first = await executeFileTransactions({
      plan,
      paths: resolver,
      journal,
      catalog,
      faultInjector: createNoopCatalogFaultInjector(),
    });
    assert.equal(first[0]!.status, "failed");
    assert.equal(first[0]!.stage, "destination-published");
    assert.equal(await fsp.readFile(destinationPath, "utf8"), "same");
    const recovered = await recoverFileTransactions({
      plan,
      paths: resolver,
      journal,
      catalog,
      faultInjector: createNoopCatalogFaultInjector(),
    });
    assert.equal(recovered[0]!.status, "completed", recovered[0]!.error ?? "");
    assert.equal(applies, 2);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("file transaction recovery rejects a journal with mismatched resolved paths", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "out", "photo.jpg");
    await fsp.writeFile(sourcePath, "same");
    const stat = await fsp.stat(sourcePath);
    const plan = makePlan("copy", {
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      localFileId: `${stat.dev}:${stat.ino}`,
      observedAt: Date.now(),
    });
    const resolver: FileTransactionPathResolver = {
      resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }),
    };
    const baseJournal = new MemoryFileTransactionJournal();
    const fault = createCatalogFaultInjectorForTests([{
      operationId: plan.operationId,
      itemId: plan.items[0]!.itemId,
      stage: "planned",
    }]);
    await assert.rejects(executeFileTransactions({
      plan,
      paths: resolver,
      journal: baseJournal,
      catalog: { apply: async () => undefined },
      faultInjector: fault,
    }), CatalogFaultInjectedError);
    const tamperedJournal: FileTransactionJournal = {
      read: async (operation, itemId) => {
        const record = await baseJournal.read(operation, itemId);
        return record === null ? null : { ...record, destinationPath: path.join(directory, "tampered.jpg") };
      },
      write: (record) => baseJournal.write(record),
      list: (operation) => baseJournal.list(operation),
    };
    await assert.rejects(recoverFileTransactions({
      plan,
      paths: resolver,
      journal: tamperedJournal,
      catalog: { apply: async () => undefined },
      faultInjector: createNoopCatalogFaultInjector(),
    }), /journal does not match/);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("file transaction entrypoints reject tampered frozen plans before resolving files", async () => {
  const plan = makePlan("copy");
  let pathResolutions = 0;
  let catalogCalls = 0;
  const resolver: FileTransactionPathResolver = {
    resolve: async (): Promise<ResolvedTransactionPaths> => {
      pathResolutions += 1;
      return { sourcePath: "/tmp/source.jpg", destinationPath: "/tmp/destination.jpg", xmp: null };
    },
  };
  const tamperedObservation: FrozenImportPlan = {
    ...plan,
    items: plan.items.map((item) => ({
      ...item,
      source: { ...item.source, observation: { ...item.source.observation, size: item.source.observation.size + 1 } },
    })),
  };
  const tamperedDecision: FrozenImportPlan = {
    ...plan,
    items: plan.items.map((item) => ({
      ...item,
      conflictDecisions: { duplicate: { kind: "continue-unchecked" }, destination: null },
    })),
  };
  for (const tampered of [tamperedObservation, tamperedDecision]) {
    await assert.rejects(executeFileTransactions({
      plan: tampered,
      paths: resolver,
      journal: new MemoryFileTransactionJournal(),
      catalog: { apply: async () => { catalogCalls += 1; } },
      faultInjector: createNoopCatalogFaultInjector(),
    }), /Frozen import plan hash/);
  }
  assert.equal(pathResolutions, 0);
  assert.equal(catalogCalls, 0);
});

test("replace keeps same-directory backups through every fault stage and restores on publish failure", async () => {
  for (const stage of CATALOG_FAULT_STAGES) {
    const directory = await temporaryDirectory();
    try {
      const sourcePath = path.join(directory, "source.jpg");
      const xmpPath = path.join(directory, "source.xmp");
      const destinationPath = path.join(directory, "out", "photo.jpg");
      const destinationXmpPath = path.join(directory, "out", "photo.xmp");
      await fsp.writeFile(sourcePath, "new-image");
      await fsp.writeFile(xmpPath, "new-xmp");
      await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
      await fsp.writeFile(destinationPath, "old-image");
      await fsp.writeFile(destinationXmpPath, "old-xmp");
      const sourceStat = await fsp.stat(sourcePath);
      const xmpStat = await fsp.stat(xmpPath);
      const catalogId = createCatalogId();
      const rootId = createRootId();
      const draft = createImportPlan({
        operationId: operationId(),
        catalogId,
        destinationRootId: rootId,
        preset: { ...preset(catalogId), template: { pattern: "{{filename}}" } },
        sources: [{
          source: {
            rootId,
            relativePath: "source.jpg",
            observation: {
              size: sourceStat.size,
              modifiedAt: sourceStat.mtimeMs,
              localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
              observedAt: Date.now(),
            },
            xmpState: "present",
            formatId: "jpeg",
          },
          action: "copy",
        }],
      });
      const itemId = draft.items[0]!.itemId;
      const reviewed = reviewImportPlan(draft, {
        destinationExists: new Set([draft.items[0]!.destinationRelativePath]),
        destinationDecisions: new Map([[itemId, { kind: "replace" }]]),
      });
      const plan = freezeImportPlan({ draft, review: reviewed });
      const resolver: FileTransactionPathResolver = {
        resolve: async (): Promise<ResolvedTransactionPaths> => ({
          sourcePath,
          destinationPath,
          xmp: {
            sourcePath: xmpPath,
            destinationPath: destinationXmpPath,
            sourceObservation: {
              size: xmpStat.size,
              modifiedAt: xmpStat.mtimeMs,
              localFileId: `${xmpStat.dev}:${xmpStat.ino}`,
            },
          },
        }),
      };
      const fileSystem: FileTransactionFileSystem = {
        exists: async (filePath) => fsp.lstat(filePath).then(() => true).catch(() => false),
        mkdir: async (directoryPath) => { await fsp.mkdir(directoryPath, { recursive: true }); },
        copyFile: async (source, destination) => { await fsp.copyFile(source, destination); },
        rename: async (source, destination) => { await fsp.rename(source, destination); },
        removeFile: async (filePath) => { await fsp.unlink(filePath).catch(() => undefined); },
        observe: async (filePath) => {
          const observed = await fsp.stat(filePath);
          return {
            size: observed.size,
            modifiedAt: observed.mtimeMs,
            localFileId: `${observed.dev}:${observed.ino}`,
            observedAt: Date.now(),
          };
        },
        digest: digestForTransaction,
        verifyCopy: async (source, destination, expected) => {
          assert.deepEqual(await fsp.readFile(source), await fsp.readFile(destination));
          const observed = await fsp.stat(source);
          assert.equal(observed.size, expected.size);
          assert.equal(observed.mtimeMs, expected.modifiedAt);
        },
        verifyObservation: async (filePath, expected) => {
          const observed = await fsp.stat(filePath);
          assert.equal(observed.size, expected.size);
          assert.equal(observed.mtimeMs, expected.modifiedAt);
        },
      };
      const journal = new MemoryFileTransactionJournal();
      const fault = createCatalogFaultInjectorForTests([{
        operationId: plan.operationId,
        itemId,
        stage,
      }]);
      await assert.rejects(
        executeFileTransactions({
          plan,
          paths: resolver,
          journal,
          catalog: { apply: async () => undefined },
          faultInjector: fault,
          fileSystem,
        }),
        CatalogFaultInjectedError,
      );
      const record = await journal.read(plan.operationId, itemId);
      assert.ok(record?.imageBackupPath);
      assert.ok(record?.xmpBackupPath);
      if (stage !== "planned" && stage !== "destination-prepared") {
        assert.match(record?.imageBackupProof?.sha256 ?? "", /^[0-9a-f]{64}$/);
        assert.match(record?.xmpBackupProof?.sha256 ?? "", /^[0-9a-f]{64}$/);
      }
      const recovered = await recoverFileTransactions({
        plan,
        paths: resolver,
        journal,
        catalog: { apply: async () => undefined },
        faultInjector: createNoopCatalogFaultInjector(),
        fileSystem,
      });
      assert.equal(recovered[0]!.status, "completed", recovered[0]!.error ?? "");
      assert.equal(await fsp.readFile(destinationPath, "utf8"), "new-image");
      assert.equal(await fsp.readFile(destinationXmpPath, "utf8"), "new-xmp");
      assert.equal(await fsp.stat(record!.imageBackupPath).then(() => true).catch(() => false), false);
      assert.equal(await fsp.stat(record!.xmpBackupPath).then(() => true).catch(() => false), false);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }

  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const xmpPath = path.join(directory, "source.xmp");
    const destinationPath = path.join(directory, "out", "photo.jpg");
    const destinationXmpPath = path.join(directory, "out", "photo.xmp");
    await fsp.writeFile(sourcePath, "new-image");
    await fsp.writeFile(xmpPath, "new-xmp");
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsp.writeFile(destinationPath, "old-image");
    await fsp.writeFile(destinationXmpPath, "old-xmp");
    const sourceStat = await fsp.stat(sourcePath);
    const xmpStat = await fsp.stat(xmpPath);
    const catalogId = createCatalogId();
    const rootId = createRootId();
    const draft = createImportPlan({
      operationId: operationId(),
      catalogId,
      destinationRootId: rootId,
      preset: { ...preset(catalogId), template: { pattern: "{{filename}}" } },
      sources: [{
        source: {
          rootId,
          relativePath: "source.jpg",
          observation: {
            size: sourceStat.size,
            modifiedAt: sourceStat.mtimeMs,
            localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
            observedAt: Date.now(),
          },
          xmpState: "present",
          formatId: "jpeg",
        },
        action: "copy",
      }],
    });
    const itemId = draft.items[0]!.itemId;
    const reviewed = reviewImportPlan(draft, {
      destinationExists: new Set([draft.items[0]!.destinationRelativePath]),
      destinationDecisions: new Map([[itemId, { kind: "replace" }]]),
    });
    const plan = freezeImportPlan({ draft, review: reviewed });
    const resolver: FileTransactionPathResolver = {
      resolve: async (): Promise<ResolvedTransactionPaths> => ({
        sourcePath,
        destinationPath,
        xmp: {
          sourcePath: xmpPath,
          destinationPath: destinationXmpPath,
          sourceObservation: {
            size: xmpStat.size,
            modifiedAt: xmpStat.mtimeMs,
            localFileId: `${xmpStat.dev}:${xmpStat.ino}`,
          },
        },
      }),
    };
    let failPublishRename = true;
    const fileSystem: FileTransactionFileSystem = {
      exists: async (filePath) => fsp.lstat(filePath).then(() => true).catch(() => false),
      mkdir: async (directoryPath) => { await fsp.mkdir(directoryPath, { recursive: true }); },
      copyFile: async (source, destination) => { await fsp.copyFile(source, destination); },
      rename: async (source, destination) => {
        if (failPublishRename && destination === destinationPath) {
          failPublishRename = false;
          throw new Error("publish rename failed");
        }
        await fsp.rename(source, destination);
      },
      removeFile: async (filePath) => { await fsp.unlink(filePath).catch(() => undefined); },
      observe: async (filePath) => {
        const observed = await fsp.stat(filePath);
        return {
          size: observed.size,
          modifiedAt: observed.mtimeMs,
          localFileId: `${observed.dev}:${observed.ino}`,
          observedAt: Date.now(),
        };
      },
      digest: digestForTransaction,
      verifyCopy: async (source, destination, expected) => {
        assert.deepEqual(await fsp.readFile(source), await fsp.readFile(destination));
        const observed = await fsp.stat(source);
        assert.equal(observed.size, expected.size);
        assert.equal(observed.mtimeMs, expected.modifiedAt);
      },
      verifyObservation: async (filePath, expected) => {
        const observed = await fsp.stat(filePath);
        assert.equal(observed.size, expected.size);
        assert.equal(observed.mtimeMs, expected.modifiedAt);
      },
    };
    const journal = new MemoryFileTransactionJournal();
    const failed = await executeFileTransactions({
      plan,
      paths: resolver,
      journal,
      catalog: { apply: async () => undefined },
      faultInjector: createNoopCatalogFaultInjector(),
      fileSystem,
    });
    assert.equal(failed[0]!.status, "failed");
    assert.equal(await fsp.readFile(destinationPath, "utf8"), "old-image");
    assert.equal(await fsp.readFile(destinationXmpPath, "utf8"), "old-xmp");
    const recovered = await recoverFileTransactions({
      plan,
      paths: resolver,
      journal,
      catalog: { apply: async () => undefined },
      faultInjector: createNoopCatalogFaultInjector(),
      fileSystem,
    });
    assert.equal(recovered[0]!.status, "completed", recovered[0]!.error ?? "");
    assert.equal(await fsp.readFile(destinationPath, "utf8"), "new-image");
    assert.equal(await fsp.readFile(destinationXmpPath, "utf8"), "new-xmp");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("replace refuses a tampered persisted backup before catalog apply", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "out", "photo.jpg");
    await fsp.writeFile(sourcePath, "new-image");
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsp.writeFile(destinationPath, "old-image");
    const sourceStat = await fsp.stat(sourcePath);
    const catalogId = createCatalogId();
    const rootId = createRootId();
    const draft = createImportPlan({
      operationId: operationId(),
      catalogId,
      destinationRootId: rootId,
      preset: { ...preset(catalogId), template: { pattern: "{{filename}}" } },
      sources: [{
        source: {
          rootId,
          relativePath: "source.jpg",
          observation: {
            size: sourceStat.size,
            modifiedAt: sourceStat.mtimeMs,
            localFileId: `${sourceStat.dev}:${sourceStat.ino}`,
            observedAt: Date.now(),
          },
          xmpState: "absent",
          formatId: "jpeg",
        },
        action: "copy",
      }],
    });
    const itemId = draft.items[0]!.itemId;
    const plan = freezeImportPlan({
      draft,
      review: reviewImportPlan(draft, {
        destinationExists: new Set([draft.items[0]!.destinationRelativePath]),
        destinationDecisions: new Map([[itemId, { kind: "replace" }]]),
      }),
    });
    const resolver: FileTransactionPathResolver = {
      resolve: async (): Promise<ResolvedTransactionPaths> => ({ sourcePath, destinationPath, xmp: null }),
    };
    const journal = new MemoryFileTransactionJournal();
    await assert.rejects(executeFileTransactions({
      plan,
      paths: resolver,
      journal,
      catalog: { apply: async () => undefined },
      faultInjector: createCatalogFaultInjectorForTests([{
        operationId: plan.operationId,
        itemId,
        stage: "destination-published",
      }]),
    }), CatalogFaultInjectedError);
    const record = await journal.read(plan.operationId, itemId);
    assert.ok(record?.imageBackupPath);
    assert.ok(record?.imageBackupProof);
    await fsp.writeFile(record.imageBackupPath, "tampered");
    let applies = 0;
    const recovered = await recoverFileTransactions({
      plan,
      paths: resolver,
      journal,
      catalog: { apply: async () => { applies += 1; } },
      faultInjector: createNoopCatalogFaultInjector(),
    });
    assert.equal(recovered[0]!.status, "failed");
    assert.match(recovered[0]!.error ?? "", /integrity proof/);
    assert.equal(applies, 0);
    assert.equal(await fsp.readFile(destinationPath, "utf8"), "new-image");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("Auto Import requires stable observations, collapses duplicate events, and survives queue controls", () => {
  const catalogId = createCatalogId();
  const rootId = createRootId();
  const rule = {
    catalogId,
    ruleId: randomUUID() as AutoImportRule["ruleId"],
    ingressRootId: rootId,
    ingressRelativePath: "watch",
    destinationRootId: createRootId(),
    destinationRelativePath: "library",
    placement: "copy",
    presetId: createPresetId(),
    presetVersion: 1,
    presetSha256: "0".repeat(64),
    duplicatePolicy: "skip-incoming",
    destinationConflictPolicy: "rename",
    enabled: true,
    stabilityMs: 1_000,
    maxAttempts: 2,
    retryBackoffMs: 10,
  } satisfies AutoImportRule;
  validateAutoImportRules([rule]);
  const first = { relativePath: "watch/photo.jpg", observation: observation(4, 1, "a"), readable: true };
  const growing = { relativePath: "watch/photo.jpg", observation: observation(5, 2, "a"), readable: true };
  const stable = { relativePath: "watch/photo.jpg", observation: { ...first.observation, observedAt: first.observation.observedAt + 1_000 }, readable: true };
  assert.equal(isStableAutoImportFile({ first, second: growing }), false);
  const queue = new AutoImportQueue();
  const item = queue.enqueue(rule, { first, second: stable }, 10);
  assert.ok(item);
  const restored = new AutoImportQueue([
    item,
    { ...item, queueId: operationId() },
  ]);
  assert.equal(restored.list().length, 1);
  assert.throws(() => new AutoImportQueue([{
    ...item,
    leaseUntil: 11,
  }]));
  assert.equal(queue.enqueue(rule, { first, second: stable }, 11)?.queueId, item.queueId);
  const claimed = queue.claimNext(12, 20);
  assert.equal(claimed?.attempts, 1);
  queue.fail(item.queueId, "temporary", rule, 13);
  assert.equal(queue.claimNext(23)?.attempts, 2);
  queue.cancel(item.queueId, 14);
  queue.retryFailed(15);
  queue.clearFailed();
  queue.pause();
  assert.equal(queue.enqueue(rule, { first, second: stable }, 16), null);
  queue.resume();
  const terminalQueue = new AutoImportQueue();
  const terminalItem = terminalQueue.enqueue(rule, { first, second: stable }, 20);
  assert.ok(terminalItem);
  assert.ok(terminalQueue.claimNext(20));
  terminalQueue.complete(terminalItem.queueId, 21);
  assert.throws(() => terminalQueue.cancel(terminalItem.queueId, 22), /Illegal/);
  const persistedLimitQueue = new AutoImportQueue();
  const persistedLimitItem = persistedLimitQueue.enqueue(rule, { first, second: stable }, 30);
  assert.ok(persistedLimitItem);
  assert.ok(persistedLimitQueue.claimNext(30));
  persistedLimitQueue.fail(persistedLimitItem.queueId, "temporary", { ...rule, maxAttempts: 1 }, 31);
  assert.equal(persistedLimitQueue.list()[0]!.state, "queued");
});

test("catalog packages checksum payloads and restore gates/resume unresolved facts", async () => {
  const directory = await temporaryDirectory();
  try {
    const packageDirectory = path.join(directory, "catalog-package");
    const catalogId = createCatalogId();
    let callbackCalled = false;
    const summary = await writeCatalogPackage({
      targetDirectory: packageDirectory,
      catalogId,
      appVersion: "test",
      roots: [{ rootId: createRootId(), label: "Photos", configuredPath: "/photos" }],
      payloads: [{ name: "catalog.sqlite", bytes: Buffer.from("db") }],
      backupAndValidate: async () => { callbackCalled = true; },
      now: 1,
    });
    assert.equal(callbackCalled, true);
    assert.equal(summary.schemaVersion, 3);
    assert.equal(summary.appVersion, "test");
    assert.equal(summary.rootCount, 1);
    assert.equal((await validateCatalogPackage(packageDirectory)).manifestSha256, summary.manifestSha256);
    await fsp.writeFile(path.join(packageDirectory, "unlisted.txt"), "extra");
    await assert.rejects(validateCatalogPackage(packageDirectory));
    await fsp.unlink(path.join(packageDirectory, "unlisted.txt"));
    await fsp.symlink(path.join(packageDirectory, "catalog.sqlite"), path.join(packageDirectory, "link.sqlite"));
    await assert.rejects(validateCatalogPackage(packageDirectory));
    await fsp.unlink(path.join(packageDirectory, "link.sqlite"));
    await fsp.writeFile(path.join(packageDirectory, "catalog.sqlite"), "corrupt");
    await assert.rejects(validateCatalogPackage(packageDirectory));
    await fsp.writeFile(path.join(packageDirectory, "catalog.sqlite"), "db");

    const envelopeDirectory = path.join(directory, "restore-recovery");
    const envelopes = new FileRestoreEnvelopeStore(envelopeDirectory);
    const targetCatalogId = createCatalogId();
    const fact: RestoreForwardFact = { factId: "fact-1", kind: "filesystem-mutation", status: "pending" };
    const calls: string[] = [];
    const adapter: RestoreAdapter = {
      targetSha256: async () => "a".repeat(64),
      makeSafetyBackup: async () => { calls.push("backup"); return { sha256: "b".repeat(64) }; },
      restoreToTemp: async () => { calls.push("restore"); },
      applyForwardFact: async () => { calls.push("fact"); return "queued"; },
      resolveForwardFact: async () => { calls.push("resolve"); return "linked"; },
      validateTemp: async () => { calls.push("validate"); },
      swapIntoPlace: async () => { calls.push("swap"); },
      reopenAndReconcile: async () => { calls.push("reconcile"); return []; },
      rollback: async () => { calls.push("rollback"); },
    };
    const invalidTarget = await runRestore({
      packageDirectory,
      sourcePackageSha256: summary.manifestSha256,
      sourceCatalogId: catalogId,
      targetCatalogId,
      mode: "open-as-new",
      forwardFacts: [],
      adapter: { ...adapter, targetSha256: async () => "invalid" },
      envelopes,
    });
    assert.equal(invalidTarget.status, "failed");
    assert.match(invalidTarget.error ?? "", /Target catalog checksum is invalid/);
    const replaceDryRun = createRestoreDryRun(targetCatalogId, catalogId, "replace", []);
    const invalidSafety = await runRestore({
      packageDirectory,
      sourcePackageSha256: summary.manifestSha256,
      sourceCatalogId: catalogId,
      targetCatalogId,
      mode: "replace",
      dryRunId: replaceDryRun.dryRunId,
      confirmation: restoreConfirmation("replace", replaceDryRun.dryRunId),
      forwardFacts: [],
      adapter: { ...adapter, makeSafetyBackup: async () => ({ sha256: "invalid" }) },
      envelopes,
    });
    assert.equal(invalidSafety.status, "failed");
    assert.match(invalidSafety.error ?? "", /Safety backup checksum is invalid/);
    const openAsNew = await runRestore({
      packageDirectory,
      sourcePackageSha256: summary.manifestSha256,
      sourceCatalogId: catalogId,
      targetCatalogId,
      mode: "open-as-new",
      forwardFacts: [fact],
      adapter,
      envelopes,
    });
    assert.equal(openAsNew.status, "recovery-required");
    assert.deepEqual(openAsNew.unresolvedFactIds, ["fact-1"]);
    assert.ok(await envelopes.read(openAsNew.envelope.restoreId));
    const resumed = await runRestore({
      packageDirectory,
      sourcePackageSha256: summary.manifestSha256,
      sourceCatalogId: catalogId,
      targetCatalogId,
      mode: "open-as-new",
      forwardFacts: [fact],
      adapter,
      envelopes,
      existingEnvelope: openAsNew.envelope,
    });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.unresolvedFactIds.length, 0);
    assert.ok(calls.includes("resolve"));
    assert.equal(await envelopes.read(openAsNew.envelope.restoreId), null);
    await assert.rejects(runRestore({
      packageDirectory,
      sourcePackageSha256: "c".repeat(64),
      sourceCatalogId: catalogId,
      targetCatalogId,
      mode: "open-as-new",
      forwardFacts: [fact],
      adapter,
      envelopes,
      existingEnvelope: openAsNew.envelope,
    }));

    const dryRun = createRestoreDryRun(targetCatalogId, catalogId, "merge", []);
    await assert.rejects(runRestore({
      packageDirectory,
      sourcePackageSha256: summary.manifestSha256,
      sourceCatalogId: catalogId,
      targetCatalogId,
      mode: "merge",
      dryRunId: dryRun.dryRunId,
      confirmation: "wrong",
      forwardFacts: [],
      adapter,
      envelopes,
    }));
    assert.equal(restoreConfirmation("merge", dryRun.dryRunId), `RESTORE MERGE ${dryRun.dryRunId}`);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("catalog optimization validates the compact result before swap", async () => {
  const calls: string[] = [];
  const adapter = {
    validateReadOnly: async () => { calls.push("read-only"); },
    previewOptimize: async () => ({ sourceSha256: "a".repeat(64), sourceByteLength: 10 }),
    optimizeToTemp: async () => ({ tempSha256: "b".repeat(64), tempByteLength: 8 }),
    validateTemp: async () => {
      calls.push("validate-temp");
      throw new Error("compact catalog is invalid");
    },
    swapOptimized: async () => { calls.push("swap"); },
  } satisfies CatalogAdminAdapter;
  await assert.rejects(optimizeCatalog(adapter), /compact catalog is invalid/);
  assert.deepEqual(calls, ["validate-temp"]);
});
