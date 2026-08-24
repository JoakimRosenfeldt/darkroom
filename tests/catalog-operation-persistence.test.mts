import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  type OperationId,
} from "../lib/catalog/ids.ts";
import type { FileObservation } from "../lib/import/domain.ts";
import {
  AutoImportQueue,
  type AutoImportRule,
  type StableFileGateInput,
} from "../lib/import/auto-import.ts";
import {
  AUTO_IMPORT_STORE_FILENAME,
  AUTO_IMPORT_STORE_VERSION,
  createAutoImportStore,
  parseAutoImportStoreSnapshot,
} from "../electron/auto-import-store.ts";
import {
  FILE_TRANSACTION_JOURNAL_DIRECTORY,
  FILE_TRANSACTION_JOURNAL_VERSION,
  createFileTransactionJournal,
} from "../electron/file-transaction-journal.ts";
import type { FileTransactionJournalRecord } from "../electron/file-transaction-service.ts";

async function temporaryDirectory(): Promise<string> {
  const created = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-operation-persistence-"));
  return fsp.realpath(created);
}

function operationId(): OperationId {
  return createOperationId();
}

function observation(size: number, modifiedAt: number, observedAt: number): FileObservation {
  return { size, modifiedAt, localFileId: "device:1", observedAt };
}

function transactionRecord(
  stateDirectory: string,
  operation: OperationId,
  item: AssetId,
): FileTransactionJournalRecord {
  return {
    operationId: operation,
    itemId: item,
    action: "copy",
    destinationAssetId: createAssetId(),
    stage: "planned",
    sourcePath: path.join(stateDirectory, "source", `${item}.jpg`),
    destinationPath: path.join(stateDirectory, "destination", `${item}.jpg`),
    xmpSourcePath: null,
    xmpDestinationPath: null,
    imageStagePath: path.join(stateDirectory, "stages", `${item}.jpg`),
    xmpStagePath: null,
    imageBackupPath: null,
    xmpBackupPath: null,
    imageBackupProof: null,
    xmpBackupProof: null,
    xmpStatus: "absent",
    updatedAt: 1,
  };
}

function autoImportRule(catalogId = createCatalogId()): AutoImportRule {
  return {
    catalogId,
    ruleId: `${randomUUID()}` as AutoImportRule["ruleId"],
    ingressRootId: createRootId(),
    ingressRelativePath: "watch",
    destinationRootId: createRootId(),
    destinationRelativePath: "library",
    placement: "copy",
    presetId: createPresetId(),
    presetVersion: 3,
    presetSha256: "a".repeat(64),
    duplicatePolicy: "continue-unchecked",
    destinationConflictPolicy: "rename",
    enabled: true,
    stabilityMs: 10,
    maxAttempts: 3,
    retryBackoffMs: 5,
  };
}

function stableGate(
  relativePath: string,
  size: number,
  modifiedAt: number,
  observedAt: number,
): StableFileGateInput {
  const first = { relativePath, observation: observation(size, modifiedAt, observedAt), readable: true };
  const second = {
    relativePath,
    observation: observation(size, modifiedAt, observedAt + 10),
    readable: true,
  };
  return { first, second };
}

test("file transaction journal round-trips, namespaces, and serializes concurrent writes", async () => {
  const stateDirectory = await temporaryDirectory();
  try {
    const operation = operationId();
    const first = createAssetId();
    const second = createAssetId();
    const journal = createFileTransactionJournal(stateDirectory);
    const firstRecord = transactionRecord(stateDirectory, operation, first);
    const secondRecord = transactionRecord(stateDirectory, operation, second);
    await Promise.all([journal.write(secondRecord), journal.write(firstRecord)]);
    assert.deepEqual(await journal.read(operation, first), firstRecord);
    assert.deepEqual(await journal.list(operation), [firstRecord, secondRecord].sort((a, b) => a.itemId.localeCompare(b.itemId)));
    const entries = await fsp.readdir(path.join(stateDirectory, FILE_TRANSACTION_JOURNAL_DIRECTORY, operation));
    assert.deepEqual(entries.sort(), [`${first}.json`, `${second}.json`].sort());
    const raw = JSON.parse(await fsp.readFile(path.join(stateDirectory, FILE_TRANSACTION_JOURNAL_DIRECTORY, operation, `${first}.json`), "utf8")) as { version: number };
    assert.equal(raw.version, FILE_TRANSACTION_JOURNAL_VERSION);
  } finally {
    await fsp.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("file transaction journal rejects malformed, oversized, mismatched, duplicate, and symlink records", async () => {
  const stateDirectory = await temporaryDirectory();
  try {
    const operation = operationId();
    const item = createAssetId();
    const otherItem = createAssetId();
    const journal = createFileTransactionJournal(stateDirectory);
    await journal.write(transactionRecord(stateDirectory, operation, item));
    const operationDirectory = path.join(stateDirectory, FILE_TRANSACTION_JOURNAL_DIRECTORY, operation);
    const filePath = path.join(operationDirectory, `${item}.json`);
    const valid = JSON.parse(await fsp.readFile(filePath, "utf8")) as Record<string, unknown> & { record: Record<string, unknown> };

    await fsp.writeFile(filePath, "{", "utf8");
    await assert.rejects(journal.read(operation, item));
    await fsp.writeFile(filePath, "x".repeat(1024 * 1024 + 1), "utf8");
    await assert.rejects(journal.read(operation, item), /too large/);

    valid.record.itemId = otherItem;
    await fsp.writeFile(filePath, JSON.stringify(valid), "utf8");
    await assert.rejects(journal.list(operation), /namespace/);
    valid.record.itemId = item;
    (valid.record as Record<string, unknown>).unexpected = true;
    await fsp.writeFile(filePath, JSON.stringify(valid), "utf8");
    await assert.rejects(journal.read(operation, item), /unexpected fields/);

    await fsp.writeFile(filePath, JSON.stringify({ ...valid, record: transactionRecord(stateDirectory, operation, item) }), "utf8");
    await fsp.writeFile(path.join(operationDirectory, `${otherItem}.json`), JSON.stringify({
      version: FILE_TRANSACTION_JOURNAL_VERSION,
      kind: "darkroom-file-transaction-journal",
      record: transactionRecord(stateDirectory, operation, item),
    }), "utf8");
    await assert.rejects(journal.list(operation), /namespace/);
    await fsp.unlink(path.join(operationDirectory, `${otherItem}.json`));

    await fsp.unlink(filePath);
    await fsp.symlink(path.join(stateDirectory, "outside.json"), filePath);
    await assert.rejects(journal.read(operation, item), /symlink/);
    await fsp.unlink(filePath);
    await journal.write(transactionRecord(stateDirectory, operation, item));
    await fsp.rm(operationDirectory, { recursive: true, force: true });
    await fsp.symlink(path.join(stateDirectory, "elsewhere"), operationDirectory);
    await assert.rejects(journal.list(operation), /namespace|symlink/);
  } finally {
    await fsp.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("Auto Import store persists rules, policies, pause state, concurrent enqueue, and claimed leases", async () => {
  const stateDirectory = await temporaryDirectory();
  try {
    const rule = autoImportRule();
    const store = createAutoImportStore(stateDirectory);
    await store.setRules([rule]);
    const item = await store.enqueue(rule.ruleId, stableGate("watch/photo.jpg", 4, 1, 100), 110);
    assert.ok(item);
    await store.pause();
    const restarted = createAutoImportStore(stateDirectory);
    const paused = await restarted.load();
    assert.equal(paused.paused, true);
    assert.deepEqual(paused.rules, [rule]);
    assert.deepEqual(paused.queue.list(), [item]);
    await restarted.resume();
    const claimed = await restarted.claimNext(200, 20);
    assert.equal(claimed?.state, "claimed");
    assert.equal(claimed?.attempts, 1);
    const afterRestart = await createAutoImportStore(stateDirectory).load();
    assert.equal(afterRestart.queue.list()[0]?.state, "claimed");
    const reclaimed = await createAutoImportStore(stateDirectory).claimNext(221, 20);
    assert.equal(reclaimed?.attempts, 2);

    const concurrentDirectory = await temporaryDirectory();
    try {
      const concurrentStore = createAutoImportStore(concurrentDirectory);
      await concurrentStore.setRules([rule]);
      await Promise.all(
        Array.from({ length: 8 }, (_, index) => concurrentStore.enqueue(
          rule.ruleId,
          stableGate(`watch/photo-${index}.jpg`, index + 1, index + 1, 300 + index * 20),
          400 + index,
        )),
      );
      assert.equal((await concurrentStore.load()).queue.list().length, 8);
      const temporaryEntries = (await fsp.readdir(concurrentDirectory)).filter((entry) => entry.endsWith(".tmp"));
      assert.deepEqual(temporaryEntries, []);
    } finally {
      await fsp.rm(concurrentDirectory, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("Auto Import store rejects invalid ownership, duplicate rules, policies, corruption, oversize, and symlinks", async () => {
  const stateDirectory = await temporaryDirectory();
  try {
    const rule = autoImportRule();
    const store = createAutoImportStore(stateDirectory);
    await store.setRules([rule]);
    const item = await store.enqueue(rule.ruleId, stableGate("watch/owned.jpg", 4, 1, 500), 510);
    assert.ok(item);
    const foreign = {
      ...item,
      catalogId: createCatalogId(),
    };
    const foreignQueue = new AutoImportQueue([foreign]);
    await assert.rejects(store.save([rule], foreignQueue, false), /owner/);
    await assert.rejects(store.save([rule, rule], new AutoImportQueue(), false), /duplicate rule/);

    const filePath = path.join(stateDirectory, AUTO_IMPORT_STORE_FILENAME);
    const raw = JSON.parse(await fsp.readFile(filePath, "utf8")) as Record<string, unknown> & { rules: Array<Record<string, unknown>> };
    raw.rules[0]!.duplicatePolicy = "invalid-policy";
    await fsp.writeFile(filePath, JSON.stringify(raw), "utf8");
    await assert.rejects(store.load(), /duplicate policy/);
    await fsp.writeFile(filePath, "{", "utf8");
    await assert.rejects(store.load());
    await fsp.writeFile(filePath, "x".repeat(4 * 1024 * 1024 + 1), "utf8");
    await assert.rejects(store.load(), /too large/);
    await store.save([rule], new AutoImportQueue([item]), false);
    await fsp.unlink(filePath);
    await fsp.symlink(path.join(stateDirectory, "outside.json"), filePath);
    await assert.rejects(store.load(), /regular file|symlink/);
    await fsp.unlink(filePath);
    await store.save([rule], new AutoImportQueue([item]), false);
    assert.deepEqual((await fsp.readdir(stateDirectory)).filter((entry) => entry.endsWith(".tmp")), []);

    const persisted = JSON.parse(await fsp.readFile(filePath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.version, AUTO_IMPORT_STORE_VERSION);
    assert.deepEqual(parseAutoImportStoreSnapshot(persisted).rules, [rule]);
  } finally {
    await fsp.rm(stateDirectory, { recursive: true, force: true });
  }
});
