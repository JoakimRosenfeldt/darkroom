import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createCatalogRegistryStore } from "../electron/catalog-registry.ts";
import {
  installCatalogV3Migration,
  type CatalogV3MigrationInstallerInput,
} from "../electron/catalog-v3-migration.ts";
import { createCatalogWorkerTestClient, type CatalogWorkerClient } from "../electron/catalog-worker-client.ts";
import {
  createCatalogId,
  createOperationId,
  createRootId,
} from "../lib/catalog/ids.ts";
import type { CatalogV3AlbumAssetSnapshot } from "../lib/catalog/v3.ts";
import type {
  Album,
  ColorLabel,
  EntryMetadata,
  PhotoCatalog,
  PickStatus,
  StarRating,
} from "../lib/catalog/types.ts";

interface Fixture {
  readonly root: string;
  readonly userDataPath: string;
  readonly catalogPath: string;
  readonly settingsPath: string;
  readonly workerPath: string;
  readonly catalogId: ReturnType<typeof createCatalogId>;
  readonly rootId: ReturnType<typeof createRootId>;
  readonly migrationId: ReturnType<typeof createOperationId>;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function legacyId(relativePath: string): string {
  return encodeURIComponent(relativePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function testParser(value: unknown): PhotoCatalog {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || typeof value.rootPath !== "string" || !isRecord(value.entries)) {
    throw new Error("Test legacy catalog is malformed.");
  }
  const entries: Record<string, EntryMetadata> = {};
  for (const [id, rawMetadata] of Object.entries(value.entries)) {
    if (!isRecord(rawMetadata)) throw new Error("Test legacy metadata is malformed.");
    const pick = rawMetadata.pick;
    const rating = rawMetadata.rating;
    const colorLabel = rawMetadata.colorLabel;
    if (
      (pick !== "none" && pick !== "pick" && pick !== "reject") ||
      (rating !== 0 && rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4 && rating !== 5) ||
      (colorLabel !== null && colorLabel !== "red" && colorLabel !== "yellow" && colorLabel !== "green" && colorLabel !== "blue" && colorLabel !== "purple") ||
      typeof rawMetadata.updatedAt !== "number" ||
      !Number.isFinite(rawMetadata.updatedAt)
    ) {
      throw new Error("Test legacy metadata is malformed.");
    }
    const develop = rawMetadata.develop === undefined
      ? undefined
      : JSON.parse(JSON.stringify(rawMetadata.develop));
    entries[id] = {
      pick: pick as PickStatus,
      rating: rating as StarRating,
      colorLabel: colorLabel as ColorLabel,
      ...(develop === undefined ? {} : { develop }),
      developUpdatedAt: typeof rawMetadata.developUpdatedAt === "number" && Number.isFinite(rawMetadata.developUpdatedAt)
        ? rawMetadata.developUpdatedAt
        : develop === undefined ? 0 : rawMetadata.updatedAt,
      updatedAt: rawMetadata.updatedAt,
    };
  }
  const rawAlbums = value.albums === undefined ? [] : value.albums;
  const rawArchived = value.archivedEntryIds === undefined ? [] : value.archivedEntryIds;
  if (!Array.isArray(rawAlbums) || !Array.isArray(rawArchived)) throw new Error("Test legacy relations are malformed.");
  const albums: Album[] = rawAlbums.map((rawAlbum) => {
    if (!isRecord(rawAlbum) || typeof rawAlbum.id !== "string" || typeof rawAlbum.name !== "string" || !Array.isArray(rawAlbum.entryIds) || typeof rawAlbum.createdAt !== "number" || typeof rawAlbum.updatedAt !== "number") {
      throw new Error("Test legacy album is malformed.");
    }
    if (!rawAlbum.entryIds.every((entryId) => typeof entryId === "string")) throw new Error("Test legacy album is malformed.");
    return {
      id: rawAlbum.id,
      name: rawAlbum.name,
      entryIds: rawAlbum.entryIds,
      createdAt: rawAlbum.createdAt,
      updatedAt: rawAlbum.updatedAt,
    };
  });
  if (!rawArchived.every((entryId) => typeof entryId === "string")) throw new Error("Test legacy archive is malformed.");
  return { version: 2, rootPath: value.rootPath, entries, albums, archivedEntryIds: rawArchived };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-v3-installer-test-"));
  return {
    root,
    userDataPath: path.join(root, "user-data"),
    catalogPath: path.join(root, "legacy-catalog.json"),
    settingsPath: path.join(root, "legacy-settings.json"),
    workerPath: path.resolve("electron/catalog-worker.ts"),
    catalogId: createCatalogId(),
    rootId: createRootId(),
    migrationId: createOperationId(),
  };
}

function inputFor(
  value: Fixture,
  extra: Partial<CatalogV3MigrationInstallerInput> = {},
): CatalogV3MigrationInstallerInput {
  return {
    userDataPath: value.userDataPath,
    workerPath: value.workerPath,
    catalogPath: value.catalogPath,
    settingsPath: value.settingsPath,
    catalogId: value.catalogId,
    rootId: value.rootId,
    migrationId: value.migrationId,
    displayName: "Migration test catalog",
    appVersion: "test",
    parseCatalog: testParser,
    ...extra,
  };
}

async function writeLegacy(
  value: Fixture,
  catalog: unknown,
  settings: unknown = { lastFolderPath: "/photos" },
): Promise<{ readonly catalog: Buffer; readonly settings: Buffer }> {
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog)}\n`, "utf8");
  const settingsBytes = Buffer.from(`${JSON.stringify(settings)}\n`, "utf8");
  await writeFile(value.catalogPath, catalogBytes);
  await writeFile(value.settingsPath, settingsBytes);
  return { catalog: catalogBytes, settings: settingsBytes };
}

function workerClient(): CatalogWorkerClient {
  return createCatalogWorkerTestClient({
    workerPath: path.resolve("electron/catalog-worker.ts"),
    execArgv: ["--no-warnings", "--experimental-strip-types"],
  });
}

async function productionCatalogParser(outputDirectory: string): Promise<(value: unknown) => PhotoCatalog> {
  const outfile = path.join(outputDirectory, "production-catalog-parser.mjs");
  await build({
    entryPoints: [path.resolve("lib/catalog/types.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
  });
  const parserModule: unknown = await import(`${pathToFileURL(outfile).href}?migration-test`);
  if (!isRecord(parserModule) || typeof parserModule.parsePhotoCatalog !== "function") {
    throw new Error("Production catalog parser bundle is invalid.");
  }
  return parserModule.parsePhotoCatalog as (value: unknown) => PhotoCatalog;
}

async function readAssets(databasePath: string, catalogId: ReturnType<typeof createCatalogId>) {
  let client: CatalogWorkerClient | undefined;
  try {
    client = workerClient();
    await client.open(databasePath);
    const first = await client.v3AssetsPage({ catalogId, expectedRevision: null, cursor: null, limit: 250 });
    return first.assets;
  } finally {
    await client?.shutdown().catch(() => client?.forceTerminate());
  }
}

test("v1 online installation preserves metadata, relations, XMP, and legacy bytes", async () => {
  const value = await fixture();
  try {
    const photoRoot = path.join(value.root, "photos");
    await mkdir(photoRoot);
    const edited = legacyId("edited/photo.JPG");
    const missing = legacyId("album/missing.jpeg");
    const archived = legacyId("archive/old.png");
    const catalog = {
      version: 1,
      rootPath: photoRoot,
      entries: {
        [edited]: {
          pick: "pick",
          rating: 4,
          colorLabel: "red",
          develop: { basic: { exposure: 1.25 } },
          developUpdatedAt: 22,
          updatedAt: 23,
        },
      },
      albums: [{ id: "album-1", name: "Album", entryIds: [edited, missing], createdAt: 4, updatedAt: 5 }],
      archivedEntryIds: [archived],
    };
    const parseCatalog = await productionCatalogParser(value.root);
    const expectedDevelop = parseCatalog(catalog).entries[edited]?.develop;
    assert.notEqual(expectedDevelop, undefined);
    const source = await writeLegacy(value, catalog);
    const xmp = "<x:xmpmeta>preserved</x:xmpmeta>\n";
    const result = await installCatalogV3Migration(inputFor(value, {
      parseCatalog,
      onlineScan: {
        complete: true,
        xmpComplete: true,
        observations: [
          { relativePath: "edited/photo.JPG", byteLength: 100, modifiedAt: 10, observedAt: 11, localFileId: null, formatId: "jpeg" },
          { relativePath: "scan-only.NEF", byteLength: 200, modifiedAt: 12, observedAt: 13, localFileId: "file-1", formatId: "nef" },
          { relativePath: "archive/old.png", byteLength: 300, modifiedAt: 14, observedAt: 15, localFileId: null, formatId: "png" },
        ],
      },
      xmpByRelativePath: {
        "edited/photo.JPG": { state: "preserved", contents: xmp, modifiedAt: 30, sha256: digest(xmp) },
      },
    }));

    assert.equal(result.phase, "registry-activated");
    assert.deepEqual(result.before, {
      metadataEntries: 1,
      albums: 1,
      albumMemberships: 2,
      archiveReferences: 1,
      distinctReferencedIds: 3,
      scannedAssetCount: 3,
      expectedTotalAssets: 4,
      expectedPresentAssets: 3,
      expectedMissingAssets: 1,
      expectedAliases: 4,
      offlineInventoryLimited: false,
    });
    assert.equal(result.after.assets, 4);
    assert.equal(result.after.present, 3);
    assert.equal(result.after.missing, 1);
    assert.equal(result.after.archived, 1);
    assert.equal(result.fingerprintCoverage.missing, 4);
    assert.equal(result.fingerprintCoverage.valid, 0);
    assert.deepEqual(await readFile(value.catalogPath), source.catalog);
    assert.deepEqual(await readFile(value.settingsPath), source.settings);
    assert.deepEqual(
      await readFile(path.join(result.recoveryEvidence.directory, "catalog.json")),
      source.catalog,
    );
    const assets = await readAssets(result.databasePath, value.catalogId);
    const editedAsset = assets.find((asset) => asset.relativePath === "edited/photo.JPG");
    assert.equal(editedAsset?.formatId, "jpeg");
    assert.equal(editedAsset?.metadata.pick, "pick");
    assert.equal(editedAsset?.metadata.rating, 4);
    assert.equal(editedAsset?.metadata.developUpdatedAt, 22);
    assert.equal(editedAsset?.metadata.updatedAt, 23);
    assert.deepEqual(JSON.parse(editedAsset?.metadata.developJson ?? "null"), expectedDevelop);
    assert.equal(editedAsset?.metadata.archive, false);
    assert.equal(editedAsset?.metadata.rawXmp, xmp);
    assert.equal(editedAsset?.metadata.xmpMtime, 30);
    assert.equal(editedAsset?.metadata.xmpSha256, digest(xmp));
    assert.equal(editedAsset?.fingerprintStatus, "missing");
    const archivedAsset = assets.find((asset) => asset.relativePath === "archive/old.png");
    assert.equal(archivedAsset?.metadata.archive, true);

    let client: CatalogWorkerClient | undefined;
    try {
      client = workerClient();
      await client.open(result.databasePath);
      const albums = await client.v3Albums({
        catalogId: value.catalogId,
        expectedRevision: null,
        cursor: null,
        limit: 250,
      });
      const members = await client.v3AlbumAssetsPage({
        catalogId: value.catalogId,
        albumId: albums.albums[0]!.id,
        expectedRevision: albums.revision,
        cursor: null,
        limit: 250,
      });
      assert.deepEqual(members.assets.map((item) => item.relativePath), [
        "edited/photo.JPG",
        "album/missing.jpeg",
      ]);
      assert.equal(albums.albums[0]?.createdAt, 4);
      assert.equal(albums.albums[0]?.updatedAt, 5);
    } finally {
      await client?.shutdown().catch(() => client?.forceTerminate());
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("v2 offline installation creates recoverable placeholders and declares limits", async () => {
  const value = await fixture();
  try {
    const metadata = legacyId("metadata.jpg");
    const albumOnly = legacyId("album-only.jpg");
    const archived = legacyId("archive-only.jpg");
    await writeLegacy(value, {
      version: 2,
      rootPath: "/photos",
      entries: {
        [metadata]: { pick: "none", rating: 0, colorLabel: null, developUpdatedAt: 0, updatedAt: 1 },
      },
      albums: [{ id: "album", name: "Offline", entryIds: [albumOnly], createdAt: 1, updatedAt: 2 }],
      archivedEntryIds: [archived],
    });
    const result = await installCatalogV3Migration(inputFor(value));
    assert.equal(result.after.assets, 3);
    assert.equal(result.after.present, 0);
    assert.equal(result.after.missing, 3);
    assert.equal(result.after.archived, 1);
    assert.deepEqual(result.limitations, [
      "No asset has a proven digest; duplicate readiness is unavailable.",
      "offline-v2-incomplete-inventory",
      "offline-xmp-state-unknown",
    ]);
    const assets = await readAssets(result.databasePath, value.catalogId);
    assert.equal(assets.every((asset) => asset.health === "missing"), true);
    assert.equal(assets.every((asset) => asset.metadata.xmpState === "unknown"), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("one album preserves membership order across the 249-entry batch boundary", async () => {
  const value = await fixture();
  try {
    const relativePaths = Array.from(
      { length: 251 },
      (_, index) => `batch/photo-${index.toString().padStart(3, "0")}.jpg`,
    );
    const entryIds = relativePaths.map(legacyId);
    await writeLegacy(value, {
      version: 2,
      rootPath: "/photos",
      entries: {},
      albums: [{
        id: "large-album",
        name: "Large album",
        entryIds,
        createdAt: 10,
        updatedAt: 20,
      }],
      archivedEntryIds: [],
    });
    const result = await installCatalogV3Migration(inputFor(value));

    let client: CatalogWorkerClient | undefined;
    try {
      client = workerClient();
      await client.open(result.databasePath);
      const albums = await client.v3Albums({
        catalogId: value.catalogId,
        expectedRevision: null,
        cursor: null,
        limit: 250,
      });
      const members: CatalogV3AlbumAssetSnapshot[] = [];
      let cursor: number | null = null;
      do {
        const page = await client.v3AlbumAssetsPage({
          catalogId: value.catalogId,
          albumId: albums.albums[0]!.id,
          expectedRevision: albums.revision,
          cursor,
          limit: 100,
        });
        members.push(...page.assets);
        cursor = page.nextCursor;
      } while (cursor !== null);
      assert.equal(members.length, 251);
      assert.deepEqual(members.map((member) => member.position), Array.from({ length: 251 }, (_, index) => index));
      assert.deepEqual(members.map((member) => member.relativePath), relativePaths);
    } finally {
      await client?.shutdown().catch(() => client?.forceTerminate());
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("malformed catalog saves exact recovery evidence without a database or registry", async () => {
  const value = await fixture();
  try {
    const malformed = Buffer.concat([
      Buffer.from('{"version":2,"rootPath":"/photos","entries":{},"albums":[{"id":"a","name":"'),
      Buffer.from([0xff]),
      Buffer.from('","entryIds":[],"createdAt":0,"updatedAt":0}],"archivedEntryIds":[]}'),
    ]);
    await writeFile(value.catalogPath, malformed);
    await writeFile(value.settingsPath, "{\"lastFolderPath\":\"/photos\"}\n");
    await assert.rejects(installCatalogV3Migration(inputFor(value)), /not valid JSON/);
    const recoveryPath = path.join(value.userDataPath, "catalog-migration-recovery", value.migrationId, "catalog.json");
    assert.deepEqual(await readFile(recoveryPath), malformed);
    await assert.rejects(access(path.join(value.userDataPath, "catalogs-v3", `${value.catalogId}.sqlite`)));
    assert.deepEqual((await createCatalogRegistryStore(value.userDataPath).read()).catalogs, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("malformed settings save exact recovery evidence without activation", async () => {
  const value = await fixture();
  try {
    const catalog = Buffer.from(
      '{"version":2,"rootPath":"/photos","entries":{},"albums":[],"archivedEntryIds":[]}\n',
      "utf8",
    );
    const malformedSettings = Buffer.concat([
      Buffer.from('{"lastFolderPath":"/pho', "utf8"),
      Buffer.from([0xff]),
      Buffer.from('tos"}\n', "utf8"),
    ]);
    await writeFile(value.catalogPath, catalog);
    await writeFile(value.settingsPath, malformedSettings);

    await assert.rejects(installCatalogV3Migration(inputFor(value)), /settings source is not valid JSON/i);
    const recoveryDirectory = path.join(
      value.userDataPath,
      "catalog-migration-recovery",
      value.migrationId,
    );
    assert.deepEqual(await readFile(path.join(recoveryDirectory, "catalog.json")), catalog);
    assert.deepEqual(await readFile(path.join(recoveryDirectory, "settings.json")), malformedSettings);
    await assert.rejects(access(path.join(value.userDataPath, "catalogs-v3", `${value.catalogId}.sqlite`)));
    assert.deepEqual((await createCatalogRegistryStore(value.userDataPath).read()).catalogs, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a source mutation before recheck refuses activation", async () => {
  const value = await fixture();
  try {
    const photoRoot = path.join(value.root, "photos");
    await mkdir(photoRoot);
    const entry = legacyId("photo.jpg");
    await writeLegacy(value, {
      version: 2,
      rootPath: photoRoot,
      entries: { [entry]: { pick: "none", rating: 0, colorLabel: null, developUpdatedAt: 0, updatedAt: 1 } },
      albums: [],
      archivedEntryIds: [],
    });
    await assert.rejects(installCatalogV3Migration(inputFor(value, {
      onlineScan: {
        complete: true,
        xmpComplete: false,
        observations: [{ relativePath: "photo.jpg", byteLength: 1, modifiedAt: 1, observedAt: 1, localFileId: null, formatId: "jpg" }],
      },
      beforeSourceRecheck: async () => {
        await writeFile(value.catalogPath, "{\"version\":2,\"rootPath\":\"/changed\",\"entries\":{},\"albums\":[],\"archivedEntryIds\":[]}\n");
      },
    })), /sources changed/);
    await assert.rejects(access(path.join(value.userDataPath, "catalogs-v3", `${value.catalogId}.sqlite`)));
    assert.deepEqual((await createCatalogRegistryStore(value.userDataPath).read()).catalogs, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an interrupted asset copy retries with stable IDs and one registry entry", async () => {
  const value = await fixture();
  try {
    const photoRoot = path.join(value.root, "photos");
    await mkdir(photoRoot);
    const entryIds = Array.from({ length: 251 }, (_, index) => legacyId(`photo-${index.toString().padStart(3, "0")}.jpg`));
    await writeLegacy(value, {
      version: 2,
      rootPath: photoRoot,
      entries: Object.fromEntries(entryIds.map((entryId, index) => [
        entryId,
        { pick: "none", rating: 0, colorLabel: null, developUpdatedAt: 0, updatedAt: index + 1 },
      ])),
      albums: [{ id: "album", name: "Retry", entryIds: [entryIds[0], entryIds.at(-1)], createdAt: 1, updatedAt: 1 }],
      archivedEntryIds: [],
    });
    const scan = {
      complete: true as const,
      xmpComplete: false,
      observations: entryIds.map((_, index) => ({
        relativePath: `photo-${index.toString().padStart(3, "0")}.jpg`,
        byteLength: index + 1,
        modifiedAt: index + 1,
        observedAt: index + 1,
        localFileId: null,
        formatId: "jpeg",
      })),
    };
    await assert.rejects(installCatalogV3Migration(inputFor(value, {
      onlineScan: scan,
      afterFirstAssetBatch: () => {
        throw new Error("intentional interrupt");
      },
    })), /intentional interrupt/);
    const stagePath = path.join(value.userDataPath, "catalogs-v3", `.${value.catalogId}.${value.migrationId}.sqlite.tmp`);
    const stagedAssets = await readAssets(stagePath, value.catalogId);
    assert.equal(stagedAssets.length, 250);
    const stagedIds = new Map(stagedAssets.map((asset) => [asset.relativePath, asset.assetId]));
    const changedScan = {
      ...scan,
      observations: scan.observations.map((observation, index) => index === 0
        ? { ...observation, modifiedAt: observation.modifiedAt + 1 }
        : observation),
    };
    await assert.rejects(
      installCatalogV3Migration(inputFor(value, { onlineScan: changedScan })),
      /envelope conflicts/,
    );
    const result = await installCatalogV3Migration(inputFor(value, { onlineScan: scan }));
    const retry = await installCatalogV3Migration(inputFor(value, { onlineScan: scan }));
    assert.equal(retry.databasePath, result.databasePath);
    assert.equal(result.after.assets, 251);
    const registry = await createCatalogRegistryStore(value.userDataPath).read();
    assert.equal(registry.catalogs.length, 1);
    const assets = await readAssets(result.databasePath, value.catalogId);
    assert.equal(assets.length, 250);
    assert.equal(assets.every((asset) => stagedIds.get(asset.relativePath) === asset.assetId), true);
    await assert.rejects(access(stagePath));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an interrupted final publish removes the linked staging name and resumes", async () => {
  const value = await fixture();
  try {
    const entry = legacyId("photo.jpg");
    await writeLegacy(value, {
      version: 2,
      rootPath: "/photos",
      entries: { [entry]: { pick: "none", rating: 0, colorLabel: null, developUpdatedAt: 0, updatedAt: 1 } },
      albums: [],
      archivedEntryIds: [],
    });
    await assert.rejects(installCatalogV3Migration(inputFor(value, {
      afterFinalDatabaseLink: () => {
        throw new Error("intentional publish interrupt");
      },
    })), /intentional publish interrupt/);

    const stagePath = path.join(value.userDataPath, "catalogs-v3", `.${value.catalogId}.${value.migrationId}.sqlite.tmp`);
    const finalPath = path.join(value.userDataPath, "catalogs-v3", `${value.catalogId}.sqlite`);
    await access(stagePath);
    await access(finalPath);
    assert.deepEqual((await createCatalogRegistryStore(value.userDataPath).read()).catalogs, []);

    const result = await installCatalogV3Migration(inputFor(value));
    assert.equal(result.phase, "registry-activated");
    await assert.rejects(access(stagePath));
    assert.equal((await createCatalogRegistryStore(value.userDataPath).read()).catalogs.length, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a source change after database sealing still blocks registry activation", async () => {
  const value = await fixture();
  try {
    const entry = legacyId("photo.jpg");
    await writeLegacy(value, {
      version: 2,
      rootPath: "/photos",
      entries: { [entry]: { pick: "none", rating: 0, colorLabel: null, developUpdatedAt: 0, updatedAt: 1 } },
      albums: [],
      archivedEntryIds: [],
    });
    await assert.rejects(installCatalogV3Migration(inputFor(value, {
      afterFinalDatabaseLink: async () => {
        await writeFile(value.catalogPath, '{"version":2,"rootPath":"/changed","entries":{},"albums":[],"archivedEntryIds":[]}\n');
      },
    })), /sources changed/);

    await access(path.join(value.userDataPath, "catalogs-v3", `${value.catalogId}.sqlite`));
    assert.deepEqual((await createCatalogRegistryStore(value.userDataPath).read()).catalogs, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a final database retry recomputes exact migrated state before activation", async () => {
  const value = await fixture();
  try {
    const entry = legacyId("photo.jpg");
    await writeLegacy(value, {
      version: 2,
      rootPath: "/photos",
      entries: { [entry]: { pick: "none", rating: 0, colorLabel: null, developUpdatedAt: 0, updatedAt: 1 } },
      albums: [],
      archivedEntryIds: [],
    });
    await assert.rejects(installCatalogV3Migration(inputFor(value, {
      beforeRegistryActivation: () => {
        throw new Error("pause before registry");
      },
    })), /pause before registry/);

    const finalPath = path.join(value.userDataPath, "catalogs-v3", `${value.catalogId}.sqlite`);
    const database = new DatabaseSync(finalPath);
    try {
      database.prepare("UPDATE asset_metadata SET rating = 5 WHERE catalog_id = ?").run(value.catalogId);
    } finally {
      database.close();
    }

    await assert.rejects(
      installCatalogV3Migration(inputFor(value)),
      /final database no longer matches the frozen migration state/,
    );
    assert.deepEqual((await createCatalogRegistryStore(value.userDataPath).read()).catalogs, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a post-commit registry interruption retries without duplicate activation", async () => {
  const value = await fixture();
  try {
    const entry = legacyId("photo.jpg");
    await writeLegacy(value, {
      version: 2,
      rootPath: "/photos",
      entries: { [entry]: { pick: "pick", rating: 3, colorLabel: null, developUpdatedAt: 0, updatedAt: 1 } },
      albums: [],
      archivedEntryIds: [],
    });
    await assert.rejects(installCatalogV3Migration(inputFor(value, {
      afterRegistryActivation: () => {
        throw new Error("intentional registry interrupt");
      },
    })), /intentional registry interrupt/);

    const finalPath = path.join(value.userDataPath, "catalogs-v3", `${value.catalogId}.sqlite`);
    await access(finalPath);
    assert.equal((await createCatalogRegistryStore(value.userDataPath).read()).catalogs.length, 1);

    const result = await installCatalogV3Migration(inputFor(value));
    assert.equal(result.databasePath, finalPath);
    assert.equal((await createCatalogRegistryStore(value.userDataPath).read()).catalogs.length, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("preserved XMP with a mismatched digest never activates", async () => {
  const value = await fixture();
  try {
    const entry = legacyId("photo.jpg");
    await writeLegacy(value, {
      version: 2,
      rootPath: "/photos",
      entries: { [entry]: { pick: "none", rating: 0, colorLabel: null, developUpdatedAt: 0, updatedAt: 1 } },
      albums: [],
      archivedEntryIds: [],
    });
    await assert.rejects(installCatalogV3Migration(inputFor(value, {
      xmpByRelativePath: {
        "photo.jpg": {
          state: "preserved",
          contents: "<x:xmpmeta/>",
          modifiedAt: 1,
          sha256: "0".repeat(64),
        },
      },
    })), /XMP evidence hash does not match/);
    await assert.rejects(access(path.join(value.userDataPath, "catalogs-v3", `${value.catalogId}.sqlite`)));
    assert.deepEqual((await createCatalogRegistryStore(value.userDataPath).read()).catalogs, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an existing final path is never overwritten", async () => {
  const value = await fixture();
  try {
    const entry = legacyId("photo.jpg");
    await writeLegacy(value, {
      version: 2,
      rootPath: "/photos",
      entries: { [entry]: { pick: "none", rating: 0, colorLabel: null, developUpdatedAt: 0, updatedAt: 1 } },
      albums: [],
      archivedEntryIds: [],
    });
    const finalDirectory = path.join(value.userDataPath, "catalogs-v3");
    const finalPath = path.join(finalDirectory, `${value.catalogId}.sqlite`);
    const original = Buffer.from("do not replace");
    await mkdir(finalDirectory, { recursive: true });
    await writeFile(finalPath, original, { flag: "wx" });
    await assert.rejects(installCatalogV3Migration(inputFor(value)), /final database exists/);
    assert.deepEqual(await readFile(finalPath), original);
    assert.deepEqual((await createCatalogRegistryStore(value.userDataPath).read()).catalogs, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
