import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { DevelopDocument } from "../lib/develop/types.ts";
import type {
  Album,
  EntryMetadata,
  PhotoCatalog,
} from "../lib/catalog/types.ts";
import {
  canonicalRelativePath,
  decodeLegacyId,
  parseStrictMigrationSettings,
  prepareLegacyMigration,
  type LegacyCatalogParser,
  type MigrationSourceDescriptor,
} from "../lib/catalog/legacy-migration.ts";

function sourceDescriptor(): MigrationSourceDescriptor {
  const bytes = new TextEncoder().encode("{}");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    catalog: { path: "/tmp/legacy-catalog.json", bytes, text: "{}", sha256 },
  };
}

function rawSource(path: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return { path, bytes, text, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function developDocument(): DevelopDocument {
  const zeroBand = { hue: 0, saturation: 0, luminance: 0 };
  const basic = {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    vibrance: 0,
    saturation: 0,
  };
  return {
    version: 2,
    settings: {
      basic,
      crop: {
        enabled: false,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        angle: 0,
        perspectiveX: 0,
        perspectiveY: 0,
        distortion: 0,
        aspectPreset: "original",
        customAspectWidth: 1,
        customAspectHeight: 1,
      },
      curve: {
        rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        red: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      },
      mixer: {
        red: zeroBand,
        orange: zeroBand,
        yellow: zeroBand,
        green: zeroBand,
        aqua: zeroBand,
        blue: zeroBand,
        purple: zeroBand,
        magenta: zeroBand,
      },
      effects: {
        vignette: 0,
        vignetteMidpoint: 50,
        vignetteRoundness: 0,
        vignetteFeather: 50,
        vignetteHighlights: 0,
        grain: 0,
        grainSize: 25,
        grainRoughness: 50,
        sharpening: 0,
        sharpenRadius: 1,
        sharpenDetail: 25,
        sharpenMasking: 0,
        noiseReduction: 0,
        noiseDetail: 50,
        noiseContrast: 0,
        colorNoiseReduction: 0,
        colorNoiseDetail: 50,
        colorNoiseSmoothness: 50,
      },
      masking: { masks: [] },
    },
    maskAssets: {},
  };
}

function metadata(develop?: DevelopDocument): EntryMetadata {
  return {
    pick: "none",
    rating: 0,
    colorLabel: null,
    title: null,
    caption: null,
    copyright: null,
    keywords: [],
    ...(develop ? { develop } : {}),
    developUpdatedAt: 0,
    updatedAt: 0,
  };
}

function album(id: string, entryIds: string[]): Album {
  return { id, name: id, entryIds, createdAt: 1, updatedAt: 2 };
}

function parserFor(catalog: PhotoCatalog): LegacyCatalogParser {
  return () => catalog;
}

function catalogFor(
  entries: Record<string, EntryMetadata>,
  albums: Album[] = [],
  archivedEntryIds: string[] = [],
): PhotoCatalog {
  return {
    version: 2,
    rootPath: "/photos",
    entries,
    albums,
    archivedEntryIds,
  };
}

function observation(relativePath: string, byteLength = 100) {
  return {
    relativePath,
    byteLength,
    modifiedAt: 10,
    observedAt: 20,
    localFileId: null,
    formatId: "jpeg",
  };
}

test("v1 online migration unions relations and scan, preserves develop, and orders candidates", () => {
  const alpha = encodeURIComponent("album/a.jpg");
  const beta = encodeURIComponent("album/b.jpg");
  const gamma = encodeURIComponent("archive/c.jpg");
  const develop = developDocument();
  const catalog = catalogFor(
    { [alpha]: metadata(develop) },
    [album("album-1", [alpha, beta])],
    [gamma],
  );
  const plan = prepareLegacyMigration({
    catalog: { version: 1, rootPath: "/photos", entries: {} },
    source: sourceDescriptor(),
    parseCatalog: parserFor(catalog),
    onlineScan: {
      complete: true,
      xmpComplete: true,
      observations: [observation("album/a.jpg"), observation("album/b.jpg"), observation("scan-only.jpg")],
    },
    xmpByRelativePath: {
      "album/a.jpg": {
        state: "preserved",
        contents: "<x:xmpmeta/>\n",
        modifiedAt: 30,
        sha256: "0".repeat(64),
      },
    },
  });

  assert.equal(plan.rawCatalogVersion, 1);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.relativePath), [
    "album/a.jpg",
    "album/b.jpg",
    "archive/c.jpg",
    "scan-only.jpg",
  ]);
  assert.equal(plan.catalog.entries[alpha]?.develop, develop);
  assert.deepEqual(plan.albums[0]?.entryIds, [alpha, beta]);
  assert.deepEqual(plan.archivedEntryIds, [gamma]);
  assert.equal(plan.candidates[0]?.sourceFlags.entries, true);
  assert.equal(plan.candidates[1]?.sourceFlags.albums, true);
  assert.equal(plan.candidates[2]?.health, "missing");
  assert.equal(plan.candidates[3]?.health, "present");
  assert.equal(plan.candidates[3]?.legacyIdAlias, encodeURIComponent("scan-only.jpg"));
  assert.equal(plan.candidates[0]?.xmp.state, "preserved");
  assert.equal(plan.candidates[2]?.xmp.state, "absent");
  assert.deepEqual(plan.counts, {
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
});

test("v2 offline migration reports only the recoverable referenced inventory", () => {
  const metadataId = encodeURIComponent("metadata.jpg");
  const albumId = encodeURIComponent("album-only.jpg");
  const archiveId = encodeURIComponent("archive-only.jpg");
  const catalog = catalogFor(
    { [metadataId]: metadata() },
    [album("album-1", [albumId])],
    [archiveId],
  );
  const plan = prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos", entries: {} },
    source: sourceDescriptor(),
    parseCatalog: parserFor(catalog),
  });

  assert.equal(plan.scan, "offline");
  assert.equal(plan.candidates.every((candidate) => candidate.observation === null), true);
  assert.equal(plan.candidates.every((candidate) => candidate.health === "missing"), true);
  assert.equal(plan.candidates.every((candidate) => candidate.xmp.state === "unknown"), true);
  assert.equal(plan.counts.expectedTotalAssets, 3);
  assert.equal(plan.counts.expectedPresentAssets, 0);
  assert.equal(plan.counts.expectedMissingAssets, 3);
  assert.equal(plan.counts.offlineInventoryLimited, true);
});

test("online migration does not invent absent XMP without complete sidecar coverage", () => {
  const id = encodeURIComponent("photo.jpg");
  const plan = prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos", entries: {} },
    source: sourceDescriptor(),
    parseCatalog: parserFor(catalogFor({ [id]: metadata() })),
    onlineScan: {
      complete: true,
      xmpComplete: false,
      observations: [observation("photo.jpg")],
    },
  });
  assert.equal(plan.candidates[0]?.xmp.state, "unknown");
});

test("strict settings parser accepts existing settings shape and rejects malformed fields", () => {
  const settings = parseStrictMigrationSettings({
    lastFolderPath: "/photos",
    exportOptions: {
      format: "jpeg",
      quality: 90,
      lossless: false,
      size: { mode: "long-edge", pixels: 2_000, neverUpscale: true },
      suffix: "-darkroom",
      conflict: "rename",
    },
  });
  assert.equal(settings.exportOptions?.size.mode, "long-edge");
  assert.throws(() => parseStrictMigrationSettings({ exportOptions: { format: "jpeg" } }));
  assert.throws(() => parseStrictMigrationSettings({ lastFolderPath: 4 }));
  assert.throws(() => parseStrictMigrationSettings({ unexpected: true }));
});

test("migration captures the raw version and refuses malformed catalog or settings input", () => {
  const catalog = catalogFor({});
  assert.throws(() => prepareLegacyMigration({
    catalog: { version: 3, rootPath: "/photos" },
    source: sourceDescriptor(),
    parseCatalog: parserFor(catalog),
  }));

  const malformedSettings = {
    catalog: sourceDescriptor().catalog,
    settings: rawSource("/tmp/legacy-settings.json", "{\"exportOptions\": {\"quality\": \"bad\"}}"),
  };
  assert.throws(() => prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos" },
    source: malformedSettings,
    parseCatalog: parserFor(catalog),
  }));

  assert.throws(() => prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos" },
    source: sourceDescriptor(),
    parseCatalog: parserFor({ ...catalog, rootPath: "/photos/../photos" }),
  }));
});

test("unsafe IDs and paths are rejected before relation planning", () => {
  const unsafeIds = [
    "",
    "%",
    "%E0%A4%A",
    encodeURIComponent("\0"),
    "%2fabsolute",
    encodeURIComponent("/absolute.jpg"),
    encodeURIComponent("../escape.jpg"),
    encodeURIComponent("folder/../escape.jpg"),
    encodeURIComponent("folder\\file.jpg"),
    encodeURIComponent("C:\\file.jpg"),
    encodeURIComponent("//server/share.jpg"),
    encodeURIComponent("folder//file.jpg"),
  ];
  for (const unsafeId of unsafeIds) {
    assert.throws(() => decodeLegacyId(unsafeId), unsafeId);
  }
  assert.throws(() => canonicalRelativePath("folder/./file.jpg"));
  assert.throws(() => canonicalRelativePath("folder/../file.jpg"));
});

test("duplicate relations and incomplete scans block migration", () => {
  const id = encodeURIComponent("photo.jpg");
  const catalog = catalogFor({ [id]: metadata() }, [album("album", [id, id])], [id]);
  assert.throws(() => prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos", entries: {} },
    source: sourceDescriptor(),
    parseCatalog: parserFor(catalog),
  }));

  const duplicateAlbums = catalogFor({ [id]: metadata() }, [album("album", []), album("album", [])]);
  assert.throws(() => prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos", entries: {} },
    source: sourceDescriptor(),
    parseCatalog: parserFor(duplicateAlbums),
  }));

  const archiveDuplicate = catalogFor({ [id]: metadata() }, [], [id, id]);
  assert.throws(() => prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos", entries: {} },
    source: sourceDescriptor(),
    parseCatalog: parserFor(archiveDuplicate),
  }));

  assert.throws(() => prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos", entries: {} },
    source: sourceDescriptor(),
    parseCatalog: parserFor(catalogFor({ [id]: metadata() })),
    onlineScan: { complete: false, xmpComplete: false, observations: [] },
  }));
  assert.throws(() => prepareLegacyMigration({
    catalog: { version: 2, rootPath: "/photos", entries: {} },
    source: sourceDescriptor(),
    parseCatalog: parserFor(catalogFor({ [id]: metadata() })),
    onlineScan: { complete: true, xmpComplete: false, observations: [observation("photo.jpg"), observation("photo.jpg")] },
  }));
});
