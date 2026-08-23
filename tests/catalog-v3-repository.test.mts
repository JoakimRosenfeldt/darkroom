import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CatalogWorkerRequestError,
  createCatalogWorkerTestClient,
  type CatalogWorkerClient,
} from "../electron/catalog-worker-client.ts";
import {
  parseCatalogWorkerRequest,
  parseCatalogWorkerResponse,
} from "../electron/catalog-worker-protocol.ts";
import {
  CATALOG_V3_TABLES,
  verifyCatalogV3Schema,
} from "../electron/catalog-v3-schema.ts";
import { catalogV3ExpectedStateSha256 } from "../electron/catalog-v3-state.ts";
import {
  createCatalogId,
  createOperationId,
  createRootId,
} from "../lib/catalog/ids.ts";

function workerClient(): CatalogWorkerClient {
  return createCatalogWorkerTestClient({
    workerPath: path.resolve("electron/catalog-worker.ts"),
    execArgv: ["--no-warnings", "--experimental-strip-types"],
  });
}

function metadata(archive = false) {
  return {
    archive,
    pick: "none" as const,
    rating: 0 as const,
    colorLabel: null,
    developJson: null,
    developUpdatedAt: 0,
    updatedAt: 0,
    title: null,
    caption: null,
    copyright: null,
    keywordsJson: "[]",
    rawXmp: null,
    xmpState: "unknown" as const,
    xmpMtime: null,
    xmpSha256: null,
  };
}

test("catalog v3 stages assets and ordered relations through the worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-v3-test-"));
  let client: CatalogWorkerClient | undefined;
  let direct: DatabaseSync | undefined;
  try {
    const databasePath = path.join(root, "catalog.db");
    const catalogId = createCatalogId();
    const rootId = createRootId();
    const migrationId = createOperationId();
    const missingPath = "😀-missing.jpg";
    const presentPath = "\uE000-present.jpg";
    const expectedCounts = {
      assets: 2,
      metadata: 2,
      albums: 2,
      albumAssets: 2,
      archived: 1,
      aliases: 4,
      fingerprints: 2,
      present: 1,
      missing: 1,
    };
    const candidates = [
      {
        rootId,
        relativePath: missingPath,
        observation: null,
        health: "missing" as const,
        formatId: "jpg",
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
        legacyIds: ["missing.jpg", "😀-alias", "\uE000-alias"],
        metadata: metadata(),
      },
      {
        rootId,
        relativePath: presentPath,
        observation: {
          byteLength: 10,
          modifiedAt: 20,
          observedAt: 30,
          localFileId: null,
        },
        health: "present" as const,
        formatId: "jpg",
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
        legacyIds: ["present.jpg"],
        metadata: metadata(),
      },
    ];
    const expectedStateSha256 = catalogV3ExpectedStateSha256({
      assets: candidates,
      albums: [
        {
          id: "z-first",
          name: "First",
          createdAt: -20,
          updatedAt: -15,
          position: 0,
          entryIds: [],
        },
        {
          id: "a-second",
          name: "Ordered",
          createdAt: -10,
          updatedAt: -5,
          position: 1,
          entryIds: ["present.jpg", "missing.jpg"],
        },
      ],
      archiveLegacyIds: ["missing.jpg"],
    });
    const reorderedStateSha256 = catalogV3ExpectedStateSha256({
      assets: candidates,
      albums: [
        {
          id: "a-second",
          name: "Ordered",
          createdAt: -10,
          updatedAt: -5,
          position: 0,
          entryIds: ["present.jpg", "missing.jpg"],
        },
        {
          id: "z-first",
          name: "First",
          createdAt: -20,
          updatedAt: -15,
          position: 1,
          entryIds: [],
        },
      ],
      archiveLegacyIds: ["missing.jpg"],
    });
    assert.notEqual(reorderedStateSha256, expectedStateSha256);
    client = workerClient();
    await client.open(databasePath);
    const install = await client.installV3({
      catalogId,
      displayName: "Test catalog",
      appVersion: "test",
      root: {
        rootId,
        label: "Test root",
        configuredPath: root,
        canonicalPath: root,
        health: "online",
        scanState: "complete",
        watchState: "disabled",
      },
      migration: {
        migrationId,
        sourceVersion: 2,
        catalogPath: path.join(root, "legacy.json"),
        settingsPath: null,
        catalogSha256: "a".repeat(64),
        settingsSha256: null,
        rootAvailable: true,
        expectedCounts,
        expectedStateSha256,
      },
    });
    assert.equal(install.created, true);
    assert.equal(install.installState, "staging");

    direct = new DatabaseSync(databasePath);
    const installedDatabase = direct;
    installedDatabase.exec("PRAGMA foreign_keys = ON;");
    assert.deepEqual(verifyCatalogV3Schema(installedDatabase).tables, CATALOG_V3_TABLES);
    const indexNames = installedDatabase.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => Reflect.get(row, "name"));
    assert.equal(indexNames.includes("fingerprints_by_catalog_digest"), true);
    assert.equal(indexNames.includes("migration_aliases_by_asset"), true);
    assert.equal(indexNames.includes("auto_import_one_enabled_per_catalog"), true);
    assert.throws(() => installedDatabase.prepare(`
      INSERT INTO roots (
        catalog_id, root_id, label, configured_path, canonical_path,
        health, scan_state, watch_state
      ) VALUES (?, ?, ?, ?, ?, 'missing', 'unknown', 'disabled')
    `).run(createCatalogId(), createRootId(), "Other root", root, null));
    installedDatabase.close();
    direct = undefined;

    const firstAssets = await client.writeV3AssetBatch({ catalogId, migrationId, assets: candidates });
    const retryAssets = await client.writeV3AssetBatch({ catalogId, migrationId, assets: candidates });
    assert.equal(retryAssets.revision, firstAssets.revision);
    assert.deepEqual(
      retryAssets.assets.map((asset) => [asset.relativePath, asset.assetId, asset.fingerprintId]),
      firstAssets.assets.map((asset) => [asset.relativePath, asset.assetId, asset.fingerprintId]),
    );

    const firstRelations = await client.writeV3RelationsBatch({
      catalogId,
      migrationId,
      albums: [
        {
          id: "z-first",
          name: "First",
          createdAt: -20,
          updatedAt: -15,
          position: 0,
          positionOffset: 0,
          entryIds: [],
        },
        {
          id: "a-second",
          name: "Ordered",
          createdAt: -10,
          updatedAt: -5,
          position: 1,
          positionOffset: 0,
          entryIds: ["present.jpg"],
        },
      ],
      archiveLegacyIds: ["missing.jpg"],
    });
    assert.equal(firstRelations.albums, 2);
    assert.equal(firstRelations.albumAssets, 1);
    assert.equal(firstRelations.archived, 1);
    const secondRelations = await client.writeV3RelationsBatch({
      catalogId,
      migrationId,
      albums: [{
        id: "a-second",
        name: "Ordered",
        createdAt: -10,
        updatedAt: -5,
        position: 1,
        positionOffset: 1,
        entryIds: ["missing.jpg"],
      }],
      archiveLegacyIds: [],
    });
    assert.equal(secondRelations.albums, 1);
    assert.equal(secondRelations.albumAssets, 1);
    assert.equal(secondRelations.archived, 0);
    await client.finishV3Copy(catalogId, migrationId);
    const validation = await client.validateV3(catalogId, migrationId);
    assert.equal(validation.phase, "validated");
    assert.equal(validation.report.clean, true);
    assert.deepEqual(validation.report.integrity.foreignKeyCheck, []);
    assert.deepEqual(validation.report.fingerprintCoverage, {
      total: 2,
      missing: 2,
      hashing: 0,
      valid: 0,
      stale: 0,
      failed: 0,
    });
    const activation = await client.prepareV3Activation(catalogId, migrationId);
    assert.equal(activation.installState, "ready");
    const seal = await client.sealV3ForInstall(catalogId, migrationId);
    assert.equal(seal.busy, 0);
    assert.equal(seal.journalMode, "delete");

    const summary = await client.v3Summary(catalogId);
    assert.equal(summary.installState, "ready");
    assert.deepEqual(
      {
        assets: summary.counts.assets,
        present: summary.counts.present,
        missing: summary.counts.missing,
        archived: summary.counts.archived,
      },
      { assets: 2, present: 1, missing: 1, archived: 1 },
    );
    const firstAlbumPage = await client.v3Albums({
      catalogId,
      expectedRevision: summary.revision,
      cursor: null,
      limit: 1,
    });
    assert.deepEqual(firstAlbumPage.albums.map((album) => album.id), ["z-first"]);
    assert.equal(firstAlbumPage.nextCursor, 0);
    const secondAlbumPage = await client.v3Albums({
      catalogId,
      expectedRevision: firstAlbumPage.revision,
      cursor: firstAlbumPage.nextCursor,
      limit: 1,
    });
    assert.deepEqual(secondAlbumPage.albums.map((album) => album.id), ["a-second"]);
    assert.deepEqual(secondAlbumPage.albums.map((album) => album.position), [1]);
    assert.equal(secondAlbumPage.nextCursor, null);
    const firstMemberPage = await client.v3AlbumAssetsPage({
      catalogId,
      albumId: "a-second",
      expectedRevision: secondAlbumPage.revision,
      cursor: null,
      limit: 1,
    });
    assert.deepEqual(firstMemberPage.assets.map((item) => item.relativePath), [presentPath]);
    assert.equal(firstMemberPage.nextCursor, 0);
    const secondMemberPage = await client.v3AlbumAssetsPage({
      catalogId,
      albumId: "a-second",
      expectedRevision: firstMemberPage.revision,
      cursor: firstMemberPage.nextCursor,
      limit: 1,
    });
    assert.deepEqual(secondMemberPage.assets.map((item) => item.relativePath), [missingPath]);
    assert.deepEqual(secondMemberPage.assets.map((item) => item.position), [1]);
    assert.equal(secondMemberPage.nextCursor, null);
    await client.shutdown();
    client = undefined;
    await assert.rejects(access(`${databasePath}-wal`));
    await assert.rejects(access(`${databasePath}-shm`));
  } finally {
    direct?.close();
    await client?.forceTerminate().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog v3 validation rejects wrong same-count metadata, album, and archive state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-v3-state-test-"));
  let client: CatalogWorkerClient | undefined;
  try {
    const catalogId = createCatalogId();
    const rootId = createRootId();
    const migrationId = createOperationId();
    const candidate = (relativePath: string, rating: 1 | 2, developJson: string) => ({
      rootId,
      relativePath,
      observation: null,
      health: "missing" as const,
      formatId: "jpg",
      cameraMake: null,
      cameraModel: null,
      lensModel: null,
      legacyIds: [relativePath],
      metadata: { ...metadata(), rating, developJson },
    });
    const expectedAssets = [candidate("a.jpg", 1, '{"exposure":1}'), candidate("b.jpg", 2, '{"exposure":2}')];
    const expectedStateSha256 = catalogV3ExpectedStateSha256({
      assets: expectedAssets,
      albums: [{
        id: "album",
        name: "Album",
        createdAt: 1,
        updatedAt: 2,
        position: 0,
        entryIds: ["a.jpg"],
      }],
      archiveLegacyIds: ["a.jpg"],
    });

    client = workerClient();
    await client.open(path.join(root, "catalog.db"));
    await client.installV3({
      catalogId,
      displayName: "State mismatch",
      appVersion: "test",
      root: {
        rootId,
        label: "Missing root",
        configuredPath: root,
        canonicalPath: null,
        health: "missing",
        scanState: "unknown",
        watchState: "disabled",
      },
      migration: {
        migrationId,
        sourceVersion: 2,
        catalogPath: path.join(root, "legacy.json"),
        settingsPath: null,
        catalogSha256: "c".repeat(64),
        settingsSha256: null,
        rootAvailable: false,
        expectedCounts: {
          assets: 2,
          metadata: 2,
          albums: 1,
          albumAssets: 1,
          archived: 1,
          aliases: 2,
          fingerprints: 2,
          present: 0,
          missing: 2,
        },
        expectedStateSha256,
      },
    });
    await client.writeV3AssetBatch({
      catalogId,
      migrationId,
      assets: [candidate("a.jpg", 2, '{"exposure":2}'), candidate("b.jpg", 1, '{"exposure":1}')],
    });
    await client.writeV3RelationsBatch({
      catalogId,
      migrationId,
      albums: [{
        id: "album",
        name: "Album",
        createdAt: 1,
        updatedAt: 2,
        position: 0,
        positionOffset: 0,
        entryIds: ["b.jpg"],
      }],
      archiveLegacyIds: ["b.jpg"],
    });
    await client.finishV3Copy(catalogId, migrationId);
    const validation = await client.validateV3(catalogId, migrationId);
    assert.equal(validation.phase, "failed");
    assert.equal(validation.report.clean, false);
    assert.notEqual(validation.report.actualStateSha256, expectedStateSha256);
    assert.equal(
      validation.report.blockingErrors.includes("Catalog v3 migrated state does not match the frozen migration plan."),
      true,
    );
  } finally {
    await client?.forceTerminate().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog v3 validation rejects every non-missing fingerprint state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-v3-fingerprint-test-"));
  let client: CatalogWorkerClient | undefined;
  try {
    const catalogId = createCatalogId();
    const rootId = createRootId();
    const migrationId = createOperationId();
    const asset = {
      rootId,
      relativePath: "asset.jpg",
      observation: null,
      health: "missing" as const,
      formatId: "jpg",
      cameraMake: null,
      cameraModel: null,
      lensModel: null,
      legacyIds: ["asset.jpg"],
      metadata: metadata(),
      fingerprint: {
        status: "hashing" as const,
        sha256: null,
        observedAt: null,
        observedByteLength: null,
        observedModifiedAt: null,
        localFileId: null,
      },
    };
    const expectedStateSha256 = catalogV3ExpectedStateSha256({
      assets: [asset],
      albums: [],
      archiveLegacyIds: [],
    });

    client = workerClient();
    await client.open(path.join(root, "catalog.db"));
    await client.installV3({
      catalogId,
      displayName: "Fingerprint gate",
      appVersion: "test",
      root: {
        rootId,
        label: "Missing root",
        configuredPath: root,
        canonicalPath: null,
        health: "missing",
        scanState: "unknown",
        watchState: "disabled",
      },
      migration: {
        migrationId,
        sourceVersion: 2,
        catalogPath: path.join(root, "legacy.json"),
        settingsPath: null,
        catalogSha256: "d".repeat(64),
        settingsSha256: null,
        rootAvailable: false,
        expectedCounts: {
          assets: 1,
          metadata: 1,
          albums: 0,
          albumAssets: 0,
          archived: 0,
          aliases: 1,
          fingerprints: 1,
          present: 0,
          missing: 1,
        },
        expectedStateSha256,
      },
    });
    await client.writeV3AssetBatch({ catalogId, migrationId, assets: [asset] });
    await client.finishV3Copy(catalogId, migrationId);
    const validation = await client.validateV3(catalogId, migrationId);
    assert.equal(validation.phase, "failed");
    assert.equal(validation.report.actualStateSha256, expectedStateSha256);
    assert.equal(
      validation.report.blockingErrors.includes(
        "Every legacy migration fingerprint must remain missing until post-migration hashing.",
      ),
      true,
    );
  } finally {
    await client?.forceTerminate().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog v3 snapshots bind revision and reject stale pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-catalog-v3-page-test-"));
  let client: CatalogWorkerClient | undefined;
  try {
    const catalogId = createCatalogId();
    const rootId = createRootId();
    const migrationId = createOperationId();
    const asset = (relativePath: string) => ({
      rootId,
      relativePath,
      observation: {
        byteLength: 1,
        modifiedAt: 1,
        observedAt: 1,
        localFileId: null,
      },
      health: "present" as const,
      formatId: "jpg",
      cameraMake: null,
      cameraModel: null,
      lensModel: null,
      legacyIds: [relativePath],
      metadata: metadata(),
    });
    const candidates = [asset("a.jpg"), asset("b.jpg")];
    client = workerClient();
    await client.open(path.join(root, "catalog.db"));
    await client.installV3({
      catalogId,
      displayName: "Page test",
      appVersion: "test",
      root: {
        rootId,
        label: "Page root",
        configuredPath: root,
        canonicalPath: root,
        health: "online",
        scanState: "complete",
        watchState: "disabled",
      },
      migration: {
        migrationId,
        sourceVersion: 1,
        catalogPath: path.join(root, "legacy.json"),
        settingsPath: null,
        catalogSha256: "b".repeat(64),
        settingsSha256: null,
        rootAvailable: true,
        expectedCounts: {
          assets: 2,
          metadata: 2,
          albums: 0,
          albumAssets: 0,
          archived: 0,
          aliases: 2,
          fingerprints: 2,
          present: 2,
          missing: 0,
        },
        expectedStateSha256: catalogV3ExpectedStateSha256({
          assets: candidates,
          albums: [],
          archiveLegacyIds: [],
        }),
      },
    });
    await client.writeV3AssetBatch({ catalogId, migrationId, assets: candidates });
    const first = await client.v3AssetsPage({ catalogId, expectedRevision: null, cursor: null, limit: 1 });
    assert.equal(first.assets.length, 1);
    assert.notEqual(first.nextCursor, null);
    await client.writeV3AssetBatch({
      catalogId,
      migrationId,
      assets: [{ ...asset("a.jpg"), formatId: "jpeg" }],
    });
    const updated = await client.v3AssetsPage({ catalogId, expectedRevision: null, cursor: null, limit: 1 });
    assert.equal(updated.assets[0]?.revision, 2);
    await client.writeV3AssetBatch({
      catalogId,
      migrationId,
      assets: [{
        ...asset("a.jpg"),
        formatId: "jpeg",
        fingerprint: {
          status: "hashing" as const,
          sha256: null,
          observedAt: 1,
          observedByteLength: 1,
          observedModifiedAt: 1,
          localFileId: null,
        },
      }],
    });
    const fingerprintUpdated = await client.v3AssetsPage({ catalogId, expectedRevision: null, cursor: null, limit: 1 });
    assert.equal(fingerprintUpdated.assets[0]?.revision, 3);
    await assert.rejects(
      client.v3AssetsPage({ catalogId, expectedRevision: first.revision, cursor: first.nextCursor, limit: 1 }),
      (error: unknown) => error instanceof CatalogWorkerRequestError && error.code === "runtime",
    );
    await client.shutdown();
    client = undefined;
  } finally {
    await client?.forceTerminate().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog v3 protocol rejects malformed requests and responses", () => {
  const catalogId = createCatalogId();
  const migrationId = createOperationId();
  assert.throws(() => parseCatalogWorkerRequest({
    kind: "v3-assets",
    requestId: "request",
    input: {
      catalogId,
      migrationId,
      assets: Array.from({ length: 251 }, (_, index) => ({
        rootId: createRootId(),
        relativePath: `asset-${index}.jpg`,
        observation: null,
        health: "missing",
        formatId: "jpg",
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
        legacyIds: [],
        metadata: null,
      })),
    },
  }));
  assert.throws(() => parseCatalogWorkerRequest({
    kind: "v3-assets-page",
    requestId: "request",
    input: { catalogId, expectedRevision: null, cursor: "not-a-cursor", limit: 1 },
  }));
  assert.throws(() => parseCatalogWorkerRequest({
    kind: "v3-relations",
    requestId: "request",
    input: {
      catalogId,
      migrationId,
      albums: Array.from({ length: 251 }, (_, index) => ({
        id: `album-${index}`,
        name: "",
        createdAt: 0,
        updatedAt: 0,
        position: index,
        positionOffset: 0,
        entryIds: [],
      })),
      archiveLegacyIds: [],
    },
  }));
  assert.throws(() => parseCatalogWorkerResponse({
    kind: "v3-summary",
    requestId: "request",
    result: { catalogId },
  }));
  assert.throws(() => parseCatalogWorkerResponse({
    kind: "v3-assets-page",
    requestId: "request",
    result: {
      catalogId,
      revision: 0,
      assets: [],
      nextCursor: "not-a-cursor",
    },
  }));
  assert.throws(() => parseCatalogWorkerResponse({
    kind: "v3-seal-for-install",
    requestId: "request",
    result: {
      catalogId,
      migrationId,
      busy: 1,
      logFrames: 0,
      checkpointedFrames: 0,
      journalMode: "delete",
    },
  }));
});
