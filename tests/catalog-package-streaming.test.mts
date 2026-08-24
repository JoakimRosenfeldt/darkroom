import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCatalogId, createOperationId, createRootId } from "../lib/catalog/ids.ts";
import {
  FileRestoreEnvelopeStore,
  validateCatalogPackage,
  writeCatalogPackage,
  type RestoreEnvelope,
} from "../electron/catalog-package-service.ts";

test("catalog packages stream file payloads and reject a symlink source", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "darkroom-package-stream-"));
  try {
    const sourcePath = path.join(directory, "catalog-source.sqlite");
    const sourceBytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    await writeFile(sourcePath, sourceBytes);
    const packageDirectory = path.join(directory, "package");
    const summary = await writeCatalogPackage({
      targetDirectory: packageDirectory,
      catalogId: createCatalogId(),
      appVersion: "test",
      roots: [{ rootId: createRootId(), label: "Photos", configuredPath: "/photos" }],
      payloads: [{ name: "catalog.sqlite", sourcePath }],
      backupAndValidate: async () => undefined,
      now: 1,
    });

    assert.equal(summary.fileCount, 1);
    assert.deepEqual(await readFile(path.join(packageDirectory, "catalog.sqlite")), sourceBytes);
    assert.equal((await validateCatalogPackage(packageDirectory)).manifestSha256, summary.manifestSha256);
    const packageLink = path.join(directory, "package-link");
    await symlink(packageDirectory, packageLink);
    await assert.rejects(validateCatalogPackage(packageLink), /non-symlink directory/);

    const sourceLink = path.join(directory, "catalog-link.sqlite");
    await symlink(sourcePath, sourceLink);
    await assert.rejects(
      writeCatalogPackage({
        targetDirectory: path.join(directory, "linked-package"),
        catalogId: createCatalogId(),
        appVersion: "test",
        roots: [{ rootId: createRootId(), label: "Photos", configuredPath: "/photos" }],
        payloads: [{ name: "catalog.sqlite", sourcePath: sourceLink }],
        backupAndValidate: async () => undefined,
      }),
      /regular non-symlink/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore envelopes serialize atomic writes and refuse symlinks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "darkroom-restore-envelope-"));
  try {
    const envelopeDirectory = path.join(directory, "envelopes");
    const store = new FileRestoreEnvelopeStore(envelopeDirectory);
    const restoreId = createOperationId();
    const envelope: RestoreEnvelope = {
      kind: "darkroom-restore-recovery",
      version: 1,
      restoreId,
      sourceCatalogId: createCatalogId(),
      targetCatalogId: createCatalogId(),
      sourcePackageSha256: "a".repeat(64),
      mode: "replace",
      dryRunId: crypto.randomUUID(),
      targetSha256: "b".repeat(64),
      safetyBackupSha256: "c".repeat(64),
      forwardFacts: [],
      stage: "created",
      updatedAt: 1,
    };
    const first = store.write(envelope);
    const second = store.write({ ...envelope, stage: "safety-backup-created", updatedAt: 2 });
    await Promise.all([first, second]);
    assert.equal((await store.read(restoreId))?.stage, "safety-backup-created");
    assert.deepEqual((await readdir(envelopeDirectory)).sort(), [`${restoreId}.json`]);

    await store.remove(restoreId);
    const outside = path.join(directory, "outside.json");
    await writeFile(outside, "{}", "utf8");
    await symlink(outside, path.join(envelopeDirectory, `${restoreId}.json`));
    await assert.rejects(store.read(restoreId), /regular file/);

    const linkedDirectory = path.join(directory, "linked-envelopes");
    await mkdir(path.join(directory, "real-envelopes"));
    await symlink(path.join(directory, "real-envelopes"), linkedDirectory);
    await assert.rejects(
      new FileRestoreEnvelopeStore(linkedDirectory).write(envelope),
      /regular directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
