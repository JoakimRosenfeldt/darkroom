import assert from "node:assert/strict";
import test from "node:test";
import { assetCacheKey } from "../lib/cache/asset-cache-key.ts";
import { createAssetId, createCatalogId } from "../lib/catalog/ids.ts";

test("asset cache keys use the exact stable identity contract", () => {
  const identity = { catalogId: createCatalogId(), assetId: createAssetId(), revision: 3 };
  assert.equal(
    assetCacheKey(identity, "thumbnail"),
    `${identity.catalogId}:${identity.assetId}:3:thumbnail`,
  );
  assert.notEqual(
    assetCacheKey(identity, "thumbnail"),
    assetCacheKey({ ...identity, catalogId: createCatalogId() }, "thumbnail"),
  );
  assert.notEqual(
    assetCacheKey(identity, "thumbnail"),
    assetCacheKey({ ...identity, revision: 4 }, "thumbnail"),
  );
  assert.notEqual(assetCacheKey(identity, "thumbnail"), assetCacheKey(identity, "develop-preview"));
});

test("asset cache keys reject ambiguous identity parts", () => {
  const identity = { catalogId: createCatalogId(), assetId: createAssetId(), revision: 0 };
  assert.throws(() => assetCacheKey({ ...identity, revision: -1 }, "thumbnail"));
  assert.throws(() => assetCacheKey({ ...identity, revision: 1.5 }, "thumbnail"));
  assert.throws(() => assetCacheKey(identity, ""));
  assert.throws(() => assetCacheKey(identity, "thumb:narrow"));
  assert.throws(() => assetCacheKey(identity, "thumb\0narrow"));
});
