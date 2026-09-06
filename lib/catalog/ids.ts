type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type CatalogId = Brand<string, "CatalogId">;
export type RootId = Brand<string, "RootId">;
export type AssetId = Brand<string, "AssetId">;
export type SourceId = Brand<string, "SourceId">;
export type EntryId = Brand<string, "EntryId">;
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
  return parseId(value ?? globalThis.crypto.randomUUID(), name);
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

export function isSourceId(value: unknown): value is SourceId {
  try {
    parseSourceId(value);
    return true;
  } catch {
    return false;
  }
}

export function parseSourceId(value: unknown): SourceId {
  return parseId(value, "SourceId");
}

export function createSourceId(value?: string): SourceId {
  return createId(value, "SourceId");
}

export function isEntryId(value: unknown): value is EntryId {
  try {
    parseEntryId(value);
    return true;
  } catch {
    return false;
  }
}

export function parseEntryId(value: unknown): EntryId {
  return parseId(value, "EntryId");
}

export function createEntryId(value?: string): EntryId {
  return createId(value, "EntryId");
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
