import type { Album } from "../catalog/types";
import {
  parseMetadataOverrides,
  parseMetadataPreset,
  parseMetadataSyncState,
  parseSourceMetadataSnapshot,
  type MetadataOverrides,
  type MetadataPreset,
  type MetadataSyncState,
  type SourceMetadataSnapshot,
} from "../metadata/types";

export const LIBRARY_WORKSPACE_VERSION = 1 as const;

export type CollectionNode =
  | {
      readonly kind: "set";
      readonly id: string;
      readonly name: string;
      readonly parentId: string | null;
      readonly order: number;
      readonly createdAt: number;
      readonly updatedAt: number;
    }
  | {
      readonly kind: "album";
      readonly id: string;
      readonly name: string;
      readonly parentId: string | null;
      readonly order: number;
      readonly createdAt: number;
      readonly updatedAt: number;
    }
  | {
      readonly kind: "smart";
      readonly id: string;
      readonly name: string;
      readonly parentId: string | null;
      readonly order: number;
      readonly rule: SmartRuleGroup;
      readonly createdAt: number;
      readonly updatedAt: number;
    };

export type SmartTextField =
  | "filename"
  | "path"
  | "format"
  | "camera"
  | "lens"
  | "location"
  | "album"
  | "keyword";

export type SmartNumberField =
  | "rating"
  | "captureTime"
  | "iso"
  | "focalLength";

export type SmartChoiceField = "pick" | "label" | "edited";

export type SmartPredicate =
  | {
      readonly kind: "text";
      readonly field: SmartTextField;
      readonly operator: "contains" | "equals" | "missing";
      readonly value: string | null;
    }
  | {
      readonly kind: "number";
      readonly field: SmartNumberField;
      readonly operator: "equals" | "atLeast" | "atMost" | "missing";
      readonly value: number | null;
    }
  | {
      readonly kind: "choice";
      readonly field: SmartChoiceField;
      readonly operator: "equals" | "missing";
      readonly value: string | boolean | null;
    };

export interface SmartRuleGroup {
  readonly version: 1;
  readonly match: "all" | "any";
  readonly children: readonly (SmartPredicate | SmartRuleGroup)[];
}

export interface Keyword {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly synonyms: readonly string[];
  readonly export: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StackRecord {
  readonly id: string;
  readonly entryIds: readonly string[];
  readonly coverEntryId: string;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ArchiveAlbumMembership {
  readonly albumId: string;
  readonly index: number;
}

export interface ArchiveMembershipSnapshot {
  readonly entryId: string;
  readonly albums: readonly ArchiveAlbumMembership[];
}

export type CaptureTimeProvenance =
  | "date-time-original-subsecond"
  | "date-time-original"
  | "create-date";

export interface EntryLocation {
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
}

export interface EntryAnalysis {
  readonly cacheSignature: string;
  readonly size: number;
  readonly modifiedAt: number;
  readonly sourceSha256: string | null;
  readonly parserVersion: string | null;
  readonly adapterVersion: string | null;
  readonly cacheHit: boolean;
  readonly source: SourceMetadataSnapshot | null;
  readonly captureTimeKey: number | null;
  readonly captureTimeDisplay: string | null;
  readonly captureTimeProvenance: CaptureTimeProvenance | null;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  readonly lens: string | null;
  readonly iso: number | null;
  readonly focalLength: number | null;
  readonly location: EntryLocation;
  readonly hasGps: boolean | null;
  readonly error: string | null;
  readonly analyzedAt: number;
}

export function entryAnalysisCacheSignature(size: number, modifiedAt: number): string {
  return `${size}:${modifiedAt}`;
}

export interface LibraryWorkspaceState {
  readonly version: typeof LIBRARY_WORKSPACE_VERSION;
  readonly collections: readonly CollectionNode[];
  readonly quickEntryIds: readonly string[];
  readonly targetAlbumId: string | null;
  readonly keywords: readonly Keyword[];
  readonly entryKeywordIds: Readonly<Record<string, readonly string[]>>;
  readonly stacks: readonly StackRecord[];
  readonly archiveMemberships: readonly ArchiveMembershipSnapshot[];
  readonly excludedEntryIds: readonly string[];
  readonly analysisByEntryId: Readonly<Record<string, EntryAnalysis>>;
  readonly metadataOverridesByEntryId: Readonly<Record<string, MetadataOverrides>>;
  readonly metadataPresets: readonly MetadataPreset[];
  readonly metadataSyncByEntryId: Readonly<Record<string, MetadataSyncState>>;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > 2_048 ||
    value.includes("\0")
  ) {
    throw new Error(`${path} is invalid.`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : stringValue(value, path, true);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a nonnegative integer.`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((item, index) => stringValue(item, `${path}[${index}]`));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function parseSmartTextField(value: unknown, path: string): SmartTextField {
  if (
    value === "filename" ||
    value === "path" ||
    value === "format" ||
    value === "camera" ||
    value === "lens" ||
    value === "location" ||
    value === "album" ||
    value === "keyword"
  ) {
    return value;
  }
  throw new Error(`${path} is invalid.`);
}

function parseSmartNumberField(value: unknown, path: string): SmartNumberField {
  if (
    value === "rating" ||
    value === "captureTime" ||
    value === "iso" ||
    value === "focalLength"
  ) {
    return value;
  }
  throw new Error(`${path} is invalid.`);
}

function parseSmartChoiceField(value: unknown, path: string): SmartChoiceField {
  if (value === "pick" || value === "label" || value === "edited") {
    return value;
  }
  throw new Error(`${path} is invalid.`);
}

function parseSmartPredicate(value: unknown, path: string): SmartPredicate {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  if (value.kind === "text") {
    const operator = value.operator;
    if (operator !== "contains" && operator !== "equals" && operator !== "missing") {
      throw new Error(`${path}.operator is invalid.`);
    }
    return {
      kind: "text",
      field: parseSmartTextField(value.field, `${path}.field`),
      operator,
      value: operator === "missing" ? null : stringValue(value.value, `${path}.value`, true),
    };
  }
  if (value.kind === "number") {
    const operator = value.operator;
    if (
      operator !== "equals" &&
      operator !== "atLeast" &&
      operator !== "atMost" &&
      operator !== "missing"
    ) {
      throw new Error(`${path}.operator is invalid.`);
    }
    return {
      kind: "number",
      field: parseSmartNumberField(value.field, `${path}.field`),
      operator,
      value: operator === "missing" ? null : finiteNumber(value.value, `${path}.value`),
    };
  }
  if (value.kind === "choice") {
    const operator = value.operator;
    if (operator !== "equals" && operator !== "missing") {
      throw new Error(`${path}.operator is invalid.`);
    }
    const field = parseSmartChoiceField(value.field, `${path}.field`);
    let choice: string | boolean | null = null;
    if (operator === "equals") {
      if (field === "edited") {
        if (typeof value.value !== "boolean") throw new Error(`${path}.value must be a boolean.`);
        choice = value.value;
      } else {
        choice = stringValue(value.value, `${path}.value`, true);
      }
    }
    return { kind: "choice", field, operator, value: choice };
  }
  throw new Error(`${path}.kind is invalid.`);
}

function parseSmartRuleGroup(
  value: unknown,
  path: string,
  depth = 1,
  counter = { value: 0 },
): SmartRuleGroup {
  if (depth > 5) throw new Error(`${path} exceeds the maximum rule depth.`);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.children)) {
    throw new Error(`${path} is malformed.`);
  }
  if (value.match !== "all" && value.match !== "any") {
    throw new Error(`${path}.match is invalid.`);
  }
  const children = value.children.map((child, index) => {
    counter.value += 1;
    if (counter.value > 100) throw new Error(`${path} exceeds 100 rule nodes.`);
    return isRecord(child) && child.version === 1
      ? parseSmartRuleGroup(child, `${path}.children[${index}]`, depth + 1, counter)
      : parseSmartPredicate(child, `${path}.children[${index}]`);
  });
  return { version: 1, match: value.match, children };
}

function parseCollection(value: unknown, path: string): CollectionNode {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const common = {
    id: stringValue(value.id, `${path}.id`),
    name: stringValue(value.name, `${path}.name`),
    parentId: nullableString(value.parentId, `${path}.parentId`),
    order: nonnegativeInteger(value.order, `${path}.order`),
    createdAt: finiteNumber(value.createdAt, `${path}.createdAt`),
    updatedAt: finiteNumber(value.updatedAt, `${path}.updatedAt`),
  };
  if (value.kind === "set") return { kind: "set", ...common };
  if (value.kind === "album") return { kind: "album", ...common };
  if (value.kind === "smart") {
    return {
      kind: "smart",
      ...common,
      rule: parseSmartRuleGroup(value.rule, `${path}.rule`),
    };
  }
  throw new Error(`${path}.kind is invalid.`);
}

function parseKeyword(value: unknown, path: string): Keyword {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  if (typeof value.export !== "boolean") throw new Error(`${path}.export must be a boolean.`);
  return {
    id: stringValue(value.id, `${path}.id`),
    parentId: nullableString(value.parentId, `${path}.parentId`),
    name: stringValue(value.name, `${path}.name`),
    synonyms: unique(stringArray(value.synonyms, `${path}.synonyms`)),
    export: value.export,
    createdAt: finiteNumber(value.createdAt, `${path}.createdAt`),
    updatedAt: finiteNumber(value.updatedAt, `${path}.updatedAt`),
  };
}

function parseStack(value: unknown, path: string): StackRecord {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const entryIds = unique(stringArray(value.entryIds, `${path}.entryIds`));
  const coverEntryId = stringValue(value.coverEntryId, `${path}.coverEntryId`);
  if (entryIds.length < 2 || !entryIds.includes(coverEntryId)) {
    throw new Error(`${path} needs at least two members and a member cover.`);
  }
  return {
    id: stringValue(value.id, `${path}.id`),
    entryIds,
    coverEntryId,
    reason: nullableString(value.reason, `${path}.reason`),
    createdAt: finiteNumber(value.createdAt, `${path}.createdAt`),
    updatedAt: finiteNumber(value.updatedAt, `${path}.updatedAt`),
  };
}

function parseArchiveSnapshot(value: unknown, path: string): ArchiveMembershipSnapshot {
  if (!isRecord(value) || !Array.isArray(value.albums)) {
    throw new Error(`${path} is malformed.`);
  }
  const seen = new Set<string>();
  const albums = value.albums.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${path}.albums[${index}] must be an object.`);
    const albumId = stringValue(item.albumId, `${path}.albums[${index}].albumId`);
    if (seen.has(albumId)) throw new Error(`${path}.albums contains duplicate albums.`);
    seen.add(albumId);
    return {
      albumId,
      index: nonnegativeInteger(item.index, `${path}.albums[${index}].index`),
    };
  });
  return { entryId: stringValue(value.entryId, `${path}.entryId`), albums };
}

export function parseEntryAnalysis(value: unknown, path = "analysis"): EntryAnalysis {
  if (!isRecord(value) || !isRecord(value.location)) {
    throw new Error(`${path} is malformed.`);
  }
  const provenance = value.captureTimeProvenance;
  if (
    provenance !== null &&
    provenance !== "date-time-original-subsecond" &&
    provenance !== "date-time-original" &&
    provenance !== "create-date"
  ) {
    throw new Error(`${path}.captureTimeProvenance is invalid.`);
  }
  if (value.hasGps !== null && typeof value.hasGps !== "boolean") {
    throw new Error(`${path}.hasGps is invalid.`);
  }
  if (value.cacheHit !== undefined && typeof value.cacheHit !== "boolean") {
    throw new Error(`${path}.cacheHit is invalid.`);
  }
  return {
    cacheSignature: stringValue(value.cacheSignature, `${path}.cacheSignature`),
    size: nonnegativeInteger(value.size, `${path}.size`),
    modifiedAt: finiteNumber(value.modifiedAt, `${path}.modifiedAt`),
    sourceSha256: value.sourceSha256 === undefined
      ? null
      : nullableString(value.sourceSha256, `${path}.sourceSha256`),
    parserVersion: value.parserVersion === undefined
      ? null
      : nullableString(value.parserVersion, `${path}.parserVersion`),
    adapterVersion: value.adapterVersion === undefined
      ? null
      : nullableString(value.adapterVersion, `${path}.adapterVersion`),
    cacheHit: value.cacheHit === true,
    source: value.source === undefined || value.source === null
      ? null
      : parseSourceMetadataSnapshot(value.source, `${path}.source`),
    captureTimeKey: value.captureTimeKey === null
      ? null
      : finiteNumber(value.captureTimeKey, `${path}.captureTimeKey`),
    captureTimeDisplay: nullableString(value.captureTimeDisplay, `${path}.captureTimeDisplay`),
    captureTimeProvenance: provenance,
    cameraMake: nullableString(value.cameraMake, `${path}.cameraMake`),
    cameraModel: nullableString(value.cameraModel, `${path}.cameraModel`),
    lens: nullableString(value.lens, `${path}.lens`),
    iso: value.iso === null ? null : finiteNumber(value.iso, `${path}.iso`),
    focalLength: value.focalLength === null
      ? null
      : finiteNumber(value.focalLength, `${path}.focalLength`),
    location: {
      city: nullableString(value.location.city, `${path}.location.city`),
      state: nullableString(value.location.state, `${path}.location.state`),
      country: nullableString(value.location.country, `${path}.location.country`),
    },
    hasGps: value.hasGps,
    error: nullableString(value.error, `${path}.error`),
    analyzedAt: finiteNumber(value.analyzedAt, `${path}.analyzedAt`),
  };
}

function assertUniqueIds<T extends { readonly id: string }>(values: readonly T[], path: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${path} contains duplicate id ${value.id}.`);
    ids.add(value.id);
  }
}

function assertAcyclicParents(
  values: readonly { readonly id: string; readonly parentId: string | null }[],
  path: string,
  validParent: (id: string) => boolean,
): void {
  const byId = new Map(values.map((value) => [value.id, value]));
  for (const value of values) {
    const seen = new Set([value.id]);
    let parentId = value.parentId;
    while (parentId !== null) {
      if (!validParent(parentId)) throw new Error(`${path}.${value.id}.parentId is invalid.`);
      if (seen.has(parentId)) throw new Error(`${path}.${value.id} creates a cycle.`);
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

function albumCollections(albums: readonly Album[]): CollectionNode[] {
  return albums.map((album, order) => ({
    kind: "album",
    id: album.id,
    name: album.name,
    parentId: null,
    order,
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
  }));
}

export function createLibraryWorkspaceState(albums: readonly Album[]): LibraryWorkspaceState {
  return {
    version: LIBRARY_WORKSPACE_VERSION,
    collections: albumCollections(albums),
    quickEntryIds: [],
    targetAlbumId: null,
    keywords: [],
    entryKeywordIds: {},
    stacks: [],
    archiveMemberships: [],
    excludedEntryIds: [],
    analysisByEntryId: {},
    metadataOverridesByEntryId: {},
    metadataPresets: [],
    metadataSyncByEntryId: {},
  };
}

export function parseLibraryWorkspaceState(
  value: unknown,
  albums: readonly Album[],
  validEntryIds: ReadonlySet<string>,
): LibraryWorkspaceState {
  if (value === null || value === undefined) return createLibraryWorkspaceState(albums);
  if (!isRecord(value) || value.version !== LIBRARY_WORKSPACE_VERSION) {
    throw new Error("Library workspace version is invalid.");
  }
  if (
    !Array.isArray(value.collections) ||
    !Array.isArray(value.keywords) ||
    !Array.isArray(value.stacks) ||
    !Array.isArray(value.archiveMemberships) ||
    !isRecord(value.entryKeywordIds) ||
    !isRecord(value.analysisByEntryId) ||
    (value.metadataOverridesByEntryId !== undefined && !isRecord(value.metadataOverridesByEntryId)) ||
    (value.metadataPresets !== undefined && !Array.isArray(value.metadataPresets)) ||
    (value.metadataSyncByEntryId !== undefined && !isRecord(value.metadataSyncByEntryId))
  ) {
    throw new Error("Library workspace is malformed.");
  }

  const collections = value.collections.map((item, index) =>
    parseCollection(item, `collections[${index}]`),
  );
  assertUniqueIds(collections, "collections");
  const albumById = new Map(albums.map((album) => [album.id, album]));
  const collectionById = new Map(collections.map((node) => [node.id, node]));
  const missingAlbumNodes = albums
    .filter((album) => !collectionById.has(album.id))
    .map((album, offset): CollectionNode => ({
      kind: "album",
      id: album.id,
      name: album.name,
      parentId: null,
      order: collections.length + offset,
      createdAt: album.createdAt,
      updatedAt: album.updatedAt,
    }));
  const normalizedCollections = [...collections, ...missingAlbumNodes]
    .filter((node) => node.kind !== "album" || albumById.has(node.id))
    .map((node) => node.kind === "album"
      ? { ...node, name: albumById.get(node.id)?.name ?? node.name }
      : node);
  const setIds = new Set(
    normalizedCollections.filter((node) => node.kind === "set").map((node) => node.id),
  );
  assertAcyclicParents(normalizedCollections, "collections", (id) => setIds.has(id));

  const keywords = value.keywords.map((item, index) => parseKeyword(item, `keywords[${index}]`));
  assertUniqueIds(keywords, "keywords");
  const keywordIds = new Set(keywords.map((keyword) => keyword.id));
  assertAcyclicParents(keywords, "keywords", (id) => keywordIds.has(id));

  const entryKeywordIds: Record<string, readonly string[]> = {};
  for (const [entryId, rawIds] of Object.entries(value.entryKeywordIds)) {
    if (!validEntryIds.has(entryId)) continue;
    entryKeywordIds[entryId] = unique(stringArray(rawIds, `entryKeywordIds.${entryId}`))
      .filter((id) => keywordIds.has(id));
  }

  const occupiedStackMembers = new Set<string>();
  const stacks: StackRecord[] = [];
  for (const [index, item] of value.stacks.entries()) {
    const stack = parseStack(item, `stacks[${index}]`);
    const entryIds = stack.entryIds.filter((id) => validEntryIds.has(id));
    const firstEntryId = entryIds[0];
    if (entryIds.length < 2 || firstEntryId === undefined) continue;
    if (entryIds.some((id) => occupiedStackMembers.has(id))) {
      throw new Error(`stacks.${stack.id} overlaps another stack.`);
    }
    entryIds.forEach((id) => occupiedStackMembers.add(id));
    stacks.push({
      ...stack,
      entryIds,
      coverEntryId: entryIds.includes(stack.coverEntryId) ? stack.coverEntryId : firstEntryId,
    });
  }
  assertUniqueIds(stacks, "stacks");

  const archiveMemberships = value.archiveMemberships
    .map((item, index) => parseArchiveSnapshot(item, `archiveMemberships[${index}]`))
    .filter((snapshot) => validEntryIds.has(snapshot.entryId))
    .map((snapshot) => ({
      ...snapshot,
      albums: snapshot.albums.filter((membership) => albumById.has(membership.albumId)),
    }));

  const analysisByEntryId: Record<string, EntryAnalysis> = {};
  for (const [entryId, analysis] of Object.entries(value.analysisByEntryId)) {
    if (validEntryIds.has(entryId)) {
      analysisByEntryId[entryId] = parseEntryAnalysis(analysis, `analysisByEntryId.${entryId}`);
    }
  }

  const metadataOverridesByEntryId: Record<string, MetadataOverrides> = {};
  for (const [entryId, overrides] of Object.entries(value.metadataOverridesByEntryId ?? {})) {
    if (validEntryIds.has(entryId)) {
      metadataOverridesByEntryId[entryId] = parseMetadataOverrides(
        overrides,
        `metadataOverridesByEntryId.${entryId}`,
      );
    }
  }
  const metadataPresets = (value.metadataPresets ?? []).map((preset, index) =>
    parseMetadataPreset(preset, `metadataPresets[${index}]`),
  );
  assertUniqueIds(metadataPresets, "metadataPresets");
  const metadataSyncByEntryId: Record<string, MetadataSyncState> = {};
  for (const [entryId, sync] of Object.entries(value.metadataSyncByEntryId ?? {})) {
    if (validEntryIds.has(entryId)) {
      metadataSyncByEntryId[entryId] = parseMetadataSyncState(
        sync,
        `metadataSyncByEntryId.${entryId}`,
      );
    }
  }

  const quickEntryIds = unique(stringArray(value.quickEntryIds, "quickEntryIds"))
    .filter((id) => validEntryIds.has(id));
  const targetAlbumId = nullableString(value.targetAlbumId, "targetAlbumId");
  const excludedEntryIds = unique(stringArray(value.excludedEntryIds, "excludedEntryIds"))
    .filter((id) => validEntryIds.has(id));

  return {
    version: LIBRARY_WORKSPACE_VERSION,
    collections: normalizedCollections,
    quickEntryIds,
    targetAlbumId: targetAlbumId !== null && albumById.has(targetAlbumId)
      ? targetAlbumId
      : null,
    keywords,
    entryKeywordIds,
    stacks,
    archiveMemberships,
    excludedEntryIds,
    analysisByEntryId,
    metadataOverridesByEntryId,
    metadataPresets,
    metadataSyncByEntryId,
  };
}

export function parseLibraryWorkspaceJson(
  json: string | null,
  albums: readonly Album[],
  validEntryIds: ReadonlySet<string>,
): LibraryWorkspaceState {
  if (json === null) return createLibraryWorkspaceState(albums);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Library workspace JSON is invalid.");
  }
  return parseLibraryWorkspaceState(parsed, albums, validEntryIds);
}

function mergeEntryRecords<T>(
  retained: Readonly<Record<string, T>>,
  active: Readonly<Record<string, T>>,
  activeEntryIds: ReadonlySet<string>,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const [entryId, value] of Object.entries(retained)) {
    if (!activeEntryIds.has(entryId)) merged[entryId] = value;
  }
  for (const [entryId, value] of Object.entries(active)) merged[entryId] = value;
  return merged;
}

export function mergeRetainedLibraryWorkspace(
  retained: LibraryWorkspaceState,
  active: LibraryWorkspaceState,
  activeEntryIds: ReadonlySet<string>,
): LibraryWorkspaceState {
  const activeStackById = new Map(active.stacks.map((stack) => [stack.id, stack]));
  const retainedStacks = retained.stacks.flatMap((stack) => {
    const hiddenEntryIds = stack.entryIds.filter((entryId) => !activeEntryIds.has(entryId));
    if (hiddenEntryIds.length === 0) return [];
    const activeStack = activeStackById.get(stack.id);
    if (activeStack) {
      activeStackById.delete(stack.id);
      return [{
        ...activeStack,
        entryIds: [...activeStack.entryIds, ...hiddenEntryIds],
        coverEntryId: activeEntryIds.has(stack.coverEntryId)
          ? activeStack.coverEntryId
          : stack.coverEntryId,
      }];
    }
    const retainedActiveCount = stack.entryIds.filter((entryId) => activeEntryIds.has(entryId)).length;
    return retainedActiveCount < 2 ? [stack] : [];
  });
  const hiddenQuickEntryIds = retained.quickEntryIds.filter((entryId) => !activeEntryIds.has(entryId));
  const hiddenArchiveMemberships = retained.archiveMemberships.filter(
    (snapshot) => !activeEntryIds.has(snapshot.entryId),
  );
  const hiddenExcludedEntryIds = retained.excludedEntryIds.filter(
    (entryId) => !activeEntryIds.has(entryId),
  );
  return {
    ...active,
    quickEntryIds: [...hiddenQuickEntryIds, ...active.quickEntryIds],
    entryKeywordIds: mergeEntryRecords(
      retained.entryKeywordIds,
      active.entryKeywordIds,
      activeEntryIds,
    ),
    stacks: [...retainedStacks, ...activeStackById.values()],
    archiveMemberships: [...hiddenArchiveMemberships, ...active.archiveMemberships],
    excludedEntryIds: [...hiddenExcludedEntryIds, ...active.excludedEntryIds],
    analysisByEntryId: mergeEntryRecords(
      retained.analysisByEntryId,
      active.analysisByEntryId,
      activeEntryIds,
    ),
    metadataOverridesByEntryId: mergeEntryRecords(
      retained.metadataOverridesByEntryId,
      active.metadataOverridesByEntryId,
      activeEntryIds,
    ),
    metadataSyncByEntryId: mergeEntryRecords(
      retained.metadataSyncByEntryId,
      active.metadataSyncByEntryId,
      activeEntryIds,
    ),
  };
}
