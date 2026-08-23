import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogV3StateSha256,
  type CatalogV3State,
  type CatalogV3StateAsset,
} from "../electron/catalog-v3-state.ts";
import { createRootId } from "../lib/catalog/ids.ts";

function replaceFirstAsset(
  state: CatalogV3State,
  replace: (asset: CatalogV3StateAsset) => CatalogV3StateAsset,
): CatalogV3State {
  const first = state.assets[0];
  if (first === undefined) throw new Error("State fixture needs an asset.");
  return { ...state, assets: [replace(first), ...state.assets.slice(1)] };
}

function stateFixture(): CatalogV3State {
  const rootId = createRootId();
  return {
    assets: [
      {
        rootId,
        relativePath: "a.jpg",
        observation: { byteLength: 10, modifiedAt: 20, observedAt: 30, localFileId: "file-a" },
        health: "present",
        formatId: "jpeg",
        cameraMake: "Make",
        cameraModel: "Model",
        lensModel: "Lens",
        legacyIds: ["a.jpg"],
        metadata: {
          archive: true,
          pick: "pick",
          rating: 4,
          colorLabel: "red",
          developJson: '{"version":2,"settings":{"basic":{"exposure":1.25}},"maskAssets":{}}',
          developUpdatedAt: 40,
          updatedAt: 41,
          title: "Title",
          caption: "Caption",
          copyright: "Copyright",
          keywordsJson: '["one","two"]',
          rawXmp: "<x:xmpmeta>one</x:xmpmeta>",
          xmpState: "preserved",
          xmpMtime: 42,
          xmpSha256: "a".repeat(64),
        },
        fingerprint: {
          status: "missing",
          sha256: null,
          observedAt: 30,
          observedByteLength: 10,
          observedModifiedAt: 20,
          localFileId: "file-a",
        },
      },
      {
        rootId,
        relativePath: "b.jpg",
        observation: null,
        health: "missing",
        formatId: "jpeg",
        cameraMake: null,
        cameraModel: null,
        lensModel: null,
        legacyIds: ["b.jpg"],
        metadata: {
          archive: false,
          pick: "none",
          rating: 0,
          colorLabel: null,
          developJson: null,
          developUpdatedAt: 0,
          updatedAt: 0,
          title: null,
          caption: null,
          copyright: null,
          keywordsJson: "[]",
          rawXmp: null,
          xmpState: "absent",
          xmpMtime: null,
          xmpSha256: null,
        },
        fingerprint: {
          status: "missing",
          sha256: null,
          observedAt: null,
          observedByteLength: null,
          observedModifiedAt: null,
          localFileId: null,
        },
      },
    ],
    albums: [
      {
        id: "z-first",
        name: "First",
        createdAt: 1,
        updatedAt: 2,
        position: 0,
        members: [
          { rootId, relativePath: "a.jpg" },
          { rootId, relativePath: "b.jpg" },
        ],
      },
      {
        id: "a-second",
        name: "Second",
        createdAt: 3,
        updatedAt: 4,
        position: 1,
        members: [],
      },
    ],
  };
}

test("catalog v3 state digest changes for every protected migration field", () => {
  const base = stateFixture();
  const digest = catalogV3StateSha256(base);
  assert.equal(catalogV3StateSha256(structuredClone(base)), digest);

  const mutations: readonly [string, (state: CatalogV3State) => CatalogV3State][] = [
    ["alias association", (state) => ({
      ...state,
      assets: [
        { ...state.assets[0]!, legacyIds: ["b.jpg"] },
        { ...state.assets[1]!, legacyIds: ["a.jpg"] },
      ],
    })],
    ["metadata", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      metadata: { ...asset.metadata, rating: 3 },
    }))],
    ["full Develop JSON", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      metadata: { ...asset.metadata, developJson: asset.metadata.developJson?.replace("1.25", "-0.5") ?? null },
    }))],
    ["raw XMP", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      metadata: { ...asset.metadata, rawXmp: "<x:xmpmeta>two</x:xmpmeta>" },
    }))],
    ["XMP state", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      metadata: { ...asset.metadata, rawXmp: null, xmpState: "unknown" },
    }))],
    ["XMP digest", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      metadata: { ...asset.metadata, xmpSha256: "b".repeat(64) },
    }))],
    ["XMP mtime", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      metadata: { ...asset.metadata, xmpMtime: 43 },
    }))],
    ["archive target", (state) => ({
      ...state,
      assets: [
        { ...state.assets[0]!, metadata: { ...state.assets[0]!.metadata, archive: false } },
        { ...state.assets[1]!, metadata: { ...state.assets[1]!.metadata, archive: true } },
      ],
    })],
    ["album list order", (state) => ({
      ...state,
      albums: [
        { ...state.albums[1]!, position: 0 },
        { ...state.albums[0]!, position: 1 },
      ],
    })],
    ["album member order", (state) => ({
      ...state,
      albums: [{ ...state.albums[0]!, members: [...state.albums[0]!.members].reverse() }, ...state.albums.slice(1)],
    })],
    ["observed byte length", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      observation: { ...asset.observation!, byteLength: 11 },
    }))],
    ["observed mtime", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      observation: { ...asset.observation!, modifiedAt: 21 },
    }))],
    ["observation time", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      observation: { ...asset.observation!, observedAt: 31 },
    }))],
    ["local file ID", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      observation: { ...asset.observation!, localFileId: "file-b" },
    }))],
    ["fingerprint status", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      fingerprint: { ...asset.fingerprint, status: "hashing" },
    }))],
    ["fingerprint evidence", (state) => replaceFirstAsset(state, (asset) => ({
      ...asset,
      fingerprint: { ...asset.fingerprint, observedByteLength: 11 },
    }))],
  ];

  for (const [label, mutate] of mutations) {
    assert.notEqual(catalogV3StateSha256(mutate(base)), digest, label);
  }
});
