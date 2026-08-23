import type { AssetId, CatalogId } from "../catalog/ids.ts";

export interface AssetCacheIdentity {
  catalogId: CatalogId;
  assetId: AssetId;
  revision: number;
}

function requireKeyPart(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  if (value.includes(":")) {
    throw new Error(`${name} must not contain ':'.`);
  }
  if (value.includes("\0")) {
    throw new Error(`${name} must not contain NUL.`);
  }
}

export function assetCacheKey(
  identity: AssetCacheIdentity,
  variant: string,
): string {
  requireKeyPart(identity.catalogId, "catalogId");
  requireKeyPart(identity.assetId, "assetId");
  if (!Number.isInteger(identity.revision) || identity.revision < 0) {
    throw new Error("revision must be a nonnegative integer.");
  }
  requireKeyPart(variant, "variant");
  return `${identity.catalogId}:${identity.assetId}:${identity.revision}:${variant}`;
}
