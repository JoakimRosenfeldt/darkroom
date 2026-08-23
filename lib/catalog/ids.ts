import { randomUUID } from "node:crypto";

type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type CatalogId = Brand<string, "CatalogId">;
export type RootId = Brand<string, "RootId">;
export type AssetId = Brand<string, "AssetId">;
export type OperationId = Brand<string, "OperationId">;
export type PresetId = Brand<string, "PresetId">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseId<Name extends string>(value: unknown, name: Name): Brand<string, Name> {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return value.toLowerCase() as Brand<string, Name>;
}

function createId<Name extends string>(value: string | undefined, name: Name): Brand<string, Name> {
  return parseId(value ?? randomUUID(), name);
}

export function isCatalogId(value: unknown): value is CatalogId {
  try {
    parseCatalogId(value);
    return true;
  } catch {
    return false;
  }
}

export function parseCatalogId(value: unknown): CatalogId {
  return parseId(value, "CatalogId");
}

export function createCatalogId(value?: string): CatalogId {
  return createId(value, "CatalogId");
}

export function isRootId(value: unknown): value is RootId {
  try {
    parseRootId(value);
    return true;
  } catch {
    return false;
  }
}

export function parseRootId(value: unknown): RootId {
  return parseId(value, "RootId");
}

export function createRootId(value?: string): RootId {
  return createId(value, "RootId");
}

export function isAssetId(value: unknown): value is AssetId {
  try {
    parseAssetId(value);
    return true;
  } catch {
    return false;
  }
}

export function parseAssetId(value: unknown): AssetId {
  return parseId(value, "AssetId");
}

export function createAssetId(value?: string): AssetId {
  return createId(value, "AssetId");
}

export function isOperationId(value: unknown): value is OperationId {
  try {
    parseOperationId(value);
    return true;
  } catch {
    return false;
  }
}

export function parseOperationId(value: unknown): OperationId {
  return parseId(value, "OperationId");
}

export function createOperationId(value?: string): OperationId {
  return createId(value, "OperationId");
}

export function isPresetId(value: unknown): value is PresetId {
  try {
    parsePresetId(value);
    return true;
  } catch {
    return false;
  }
}

export function parsePresetId(value: unknown): PresetId {
  return parseId(value, "PresetId");
}

export function createPresetId(value?: string): PresetId {
  return createId(value, "PresetId");
}
