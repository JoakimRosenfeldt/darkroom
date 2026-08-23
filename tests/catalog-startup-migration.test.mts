import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createCatalogId, type CatalogId } from "../lib/catalog/ids.ts";
import type { CatalogRegistryStore } from "../electron/catalog-registry.ts";
import type { CatalogStartupSettingsPort } from "../electron/catalog-startup-migration.ts";
import type { CatalogV3MigrationInstallerInput } from "../electron/catalog-v3-migration.ts";

type StartupModule = typeof import("../electron/catalog-startup-migration.ts");

async function loadStartupModule(directory: string): Promise<StartupModule> {
  const outfile = path.join(directory, "catalog-startup-migration.mjs");
  await build({
    entryPoints: [path.resolve("electron/catalog-startup-migration.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    tsconfig: path.resolve("tsconfig.json"),
  });
  return import(`${pathToFileURL(outfile).href}?startup-migration-test`);
}

function getLegacyCatalogPath(userDataPath: string, rootPath: string): string {
  const key = createHash("sha256").update(path.resolve(rootPath)).digest("hex").slice(0, 16);
  return path.join(userDataPath, "catalogs", `${key}.json`);
}

function registryWithCatalogs(count: number): CatalogRegistryStore {
  const catalogs = Array.from({ length: count }, (_, index) => ({
    catalogId: createCatalogId(),
    displayName: `Catalog ${index}`,
    databasePath: `/catalog-${index}.sqlite`,
    health: "healthy" as const,
    lastOpenedAt: index,
  }));
  return {
    filePath: "/registry.json",
    async read() {
      return { version: 1 as const, catalogs };
    },
    async write() {},
    async upsert() {},
    async remove() {},
  };
}

function settings(lastFolderPath: string | null): {
  readonly port: CatalogStartupSettingsPort;
  readonly selected: () => CatalogId | null;
} {
  let selected: CatalogId | null = null;
  return {
    port: {
      async getLastFolder() {
        return lastFolderPath;
      },
      async setLastCatalogId(catalogId) {
        selected = catalogId;
      },
    },
    selected: () => selected,
  };
}

async function fixture(): Promise<{
  readonly directory: string;
  readonly userDataPath: string;
  readonly photoRoot: string;
  readonly catalogPath: string;
  readonly settingsPath: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "darkroom-startup-migration-"));
  const userDataPath = path.join(directory, "user-data");
  const photoRoot = path.join(directory, "photos");
  const catalogPath = getLegacyCatalogPath(userDataPath, photoRoot);
  const settingsPath = path.join(userDataPath, "settings.json");
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await mkdir(photoRoot);
  await writeFile(catalogPath, JSON.stringify({
    version: 2,
    rootPath: photoRoot,
    entries: {},
    albums: [],
    archivedEntryIds: [],
  }));
  await writeFile(settingsPath, JSON.stringify({ lastFolderPath: photoRoot }));
  return { directory, userDataPath, photoRoot, catalogPath, settingsPath };
}

test("startup leaves an existing v3 registry untouched", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "darkroom-startup-module-"));
  const { migrateLegacyCatalogAtStartup } = await loadStartupModule(directory);
  let settingsRead = false;
  try {
    const result = await migrateLegacyCatalogAtStartup({
      userDataPath: "/user-data",
      workerPath: "/worker.js",
      appVersion: "test",
      registry: registryWithCatalogs(1),
      settings: {
        async getLastFolder() {
          settingsRead = true;
          return null;
        },
        async setLastCatalogId() {},
      },
    });
    assert.deepEqual(result, { state: "not-needed", reason: "catalogs-exist" });
    assert.equal(settingsRead, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup builds one stable online migration and selects it", async () => {
  const value = await fixture();
  try {
    const { migrateLegacyCatalogAtStartup } = await loadStartupModule(value.directory);
    const selected = settings(value.photoRoot);
    const inputs: CatalogV3MigrationInstallerInput[] = [];
    const run = () => migrateLegacyCatalogAtStartup({
      userDataPath: value.userDataPath,
      workerPath: path.join(value.directory, "worker.js"),
      appVersion: "test",
      registry: registryWithCatalogs(0),
      settings: selected.port,
      now: () => 123,
      scan: async () => ({
        observations: [{
          name: "photo.dng",
          relativePath: "photo.dng",
          size: 45,
          lastModified: 12,
        }],
        directoriesVisited: 1,
        filesConsidered: 1,
        acceptedCount: 1,
        currentPath: null,
      }),
      install: async (input) => {
        inputs.push(input);
        return { databasePath: path.join(value.directory, "catalog.sqlite"), limitations: ["dng-unavailable"] };
      },
    });

    const first = await run();
    const second = await run();
    assert.equal(first.state, "migrated");
    assert.equal(second.state, "migrated");
    assert.equal(inputs[0]?.catalogId, inputs[1]?.catalogId);
    assert.equal(inputs[0]?.rootId, inputs[1]?.rootId);
    assert.equal(inputs[0]?.migrationId, inputs[1]?.migrationId);
    assert.equal(inputs[0]?.onlineScan?.complete, true);
    assert.equal(inputs[0]?.onlineScan?.observations[0]?.formatId, "dng");
    assert.equal(inputs[0]?.xmpByRelativePath?.["photo.dng"]?.state, "absent");
    assert.equal(selected.selected(), inputs[0]?.catalogId ?? null);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("startup falls back to an explicit offline migration when scanning fails", async () => {
  const value = await fixture();
  try {
    const { migrateLegacyCatalogAtStartup } = await loadStartupModule(value.directory);
    let input: CatalogV3MigrationInstallerInput | undefined;
    const result = await migrateLegacyCatalogAtStartup({
      userDataPath: value.userDataPath,
      workerPath: path.join(value.directory, "worker.js"),
      appVersion: "test",
      registry: registryWithCatalogs(0),
      settings: settings(value.photoRoot).port,
      scan: async () => {
        throw new Error("root unavailable");
      },
      install: async (valueInput) => {
        input = valueInput;
        return { databasePath: path.join(value.directory, "catalog.sqlite"), limitations: ["offline"] };
      },
    });
    assert.equal(result.state, "migrated");
    assert.equal(result.state === "migrated" ? result.scan : null, "offline");
    assert.equal(input?.onlineScan, undefined);
    assert.equal(input?.xmpByRelativePath, undefined);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("startup reports recovery and discovers a lone catalog when settings cannot identify it", async () => {
  const value = await fixture();
  try {
    const { migrateLegacyCatalogAtStartup } = await loadStartupModule(value.directory);
    const result = await migrateLegacyCatalogAtStartup({
      userDataPath: value.userDataPath,
      workerPath: path.join(value.directory, "worker.js"),
      appVersion: "test",
      registry: registryWithCatalogs(0),
      settings: settings(null).port,
      scan: async () => {
        throw new Error("offline");
      },
      install: async () => {
        throw new Error("settings source is not valid JSON");
      },
    });
    assert.equal(result.state, "recovery-required");
    assert.notEqual(result.state === "recovery-required" ? result.catalogId : null, null);
    assert.match(result.state === "recovery-required" ? result.diagnostic : "", /settings source/);
    assert.match(result.state === "recovery-required" ? result.recoveryDirectory ?? "" : "", /catalog-migration-recovery/);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});
