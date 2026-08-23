import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyMigrationRecoveryEvidence,
  readMigrationSources,
  recheckMigrationSources,
} from "../electron/catalog-migration-snapshot.ts";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("raw migration snapshots preserve bytes, hash exact content, and recheck changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-migration-snapshot-test-"));
  try {
    const catalogPath = path.join(root, "catalog.json");
    const settingsPath = path.join(root, "settings.json");
    const catalogBytes = Buffer.from('{"version":2,"rootPath":"/photos"}\n', "utf8");
    const settingsBytes = Buffer.from('{"lastFolderPath":"/photos"}\n', "utf8");
    await writeFile(catalogPath, catalogBytes);
    await writeFile(settingsPath, settingsBytes);

    const snapshot = await readMigrationSources({ catalogPath, settingsPath });
    assert.equal(snapshot.catalog.text, catalogBytes.toString("utf8"));
    assert.equal(snapshot.catalog.sha256, digest(catalogBytes));
    assert.equal(snapshot.settings?.sha256, digest(settingsBytes));
    assert.deepEqual([...snapshot.catalog.bytes], [...catalogBytes]);

    const userDataPath = path.join(root, "user-data");
    const first = await copyMigrationRecoveryEvidence(userDataPath, "migration-1", snapshot);
    const second = await copyMigrationRecoveryEvidence(userDataPath, "migration-1", snapshot);
    assert.deepEqual(second, first);
    assert.deepEqual([...await readFile(path.join(first.directory, "catalog.json"))], [...catalogBytes]);
    assert.deepEqual([...await readFile(path.join(first.directory, "settings.json"))], [...settingsBytes]);

    const malformedPath = path.join(root, "malformed-catalog.json");
    const malformedBytes = Uint8Array.from([0xff, 0x00, 0x7b]);
    await writeFile(malformedPath, malformedBytes);
    const malformed = await readMigrationSources({ catalogPath: malformedPath });
    const malformedEvidence = await copyMigrationRecoveryEvidence(userDataPath, "malformed", malformed);
    assert.deepEqual([...malformed.catalog.bytes], [...malformedBytes]);
    assert.equal(malformed.catalog.sha256, digest(malformedBytes));
    assert.deepEqual([...await readFile(path.join(malformedEvidence.directory, "catalog.json"))], [...malformedBytes]);

    const unchanged = await recheckMigrationSources(snapshot);
    assert.equal(unchanged.unchanged, true);

    await writeFile(catalogPath, Buffer.from('{"version":2,"rootPath":"/changed"}\n', "utf8"));
    const changed = await recheckMigrationSources(snapshot);
    assert.equal(changed.unchanged, false);
    await assert.rejects(copyMigrationRecoveryEvidence(userDataPath, "migration-1", changed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("raw migration snapshots reject unsafe source and recovery paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-migration-path-test-"));
  try {
    const catalogPath = path.join(root, "catalog.json");
    await writeFile(catalogPath, "{}");
    await assert.rejects(readMigrationSources({ catalogPath: "relative/catalog.json" }));
    const snapshot = await readMigrationSources({ catalogPath });
    await assert.rejects(copyMigrationRecoveryEvidence(root, "../escape", snapshot));
    await assert.rejects(copyMigrationRecoveryEvidence(root, "migration/escape", snapshot));
    await assert.rejects(copyMigrationRecoveryEvidence(`${root}/../${path.basename(root)}`, "migration", snapshot));
    await assert.rejects(stat(path.join(root, "catalog-migration-recovery", "migration", "catalog.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source recheck detects settings created after an initially missing snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-migration-settings-test-"));
  try {
    const catalogPath = path.join(root, "catalog.json");
    const settingsPath = path.join(root, "settings.json");
    await writeFile(catalogPath, "{}");
    const snapshot = await readMigrationSources({ catalogPath, settingsPath });
    assert.equal(snapshot.settings, undefined);
    assert.equal((await recheckMigrationSources(snapshot, { settingsPath })).unchanged, true);

    await writeFile(settingsPath, "{}\n");
    assert.equal((await recheckMigrationSources(snapshot, { settingsPath })).unchanged, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
