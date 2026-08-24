export const SOURCE_METADATA_VERSION = 1 as const;
export const SOURCE_METADATA_ADAPTER_VERSION = "1.0.0";
export const SOURCE_METADATA_PARSER_VERSION = "exifr-7.1.3";

export type MetadataSource =
  | "container"
  | "exif"
  | "iptc"
  | "xmp"
  | "raw"
  | "catalog-fallback"
  | "filesystem";

export type MetadataValue<T> =
  | {
      readonly kind: "value";
      readonly value: T;
      readonly source: MetadataSource;
      readonly tag: string;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "malformed"; readonly message: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface CaptureWallTime {
  readonly value: string;
  readonly offset: string | null;
  readonly sortKey: number;
}

export interface MetadataClaim {
  readonly field: MetadataEditableField;
  readonly value: string | number | readonly string[];
  readonly source: MetadataSource;
  readonly tag: string;
}

export interface SourceMetadataSnapshot {
  readonly version: typeof SOURCE_METADATA_VERSION;
  readonly parserVersion: string;
  readonly adapterVersion: string;
  readonly sourceSha256: string;
  readonly extractedAt: number;
  readonly file: {
    readonly byteLength: number;
    readonly modifiedAt: number;
    readonly width: MetadataValue<number>;
    readonly height: MetadataValue<number>;
    readonly orientation: MetadataValue<string>;
    readonly bitDepth: MetadataValue<number>;
    readonly colorSpace: MetadataValue<string>;
  };
  readonly capture: {
    readonly time: MetadataValue<CaptureWallTime>;
    readonly cameraMake: MetadataValue<string>;
    readonly cameraModel: MetadataValue<string>;
    readonly lens: MetadataValue<string>;
    readonly focalLength: MetadataValue<number>;
    readonly aperture: MetadataValue<number>;
    readonly shutter: MetadataValue<number>;
    readonly iso: MetadataValue<number>;
  };
  readonly description: {
    readonly title: MetadataValue<string>;
    readonly caption: MetadataValue<string>;
    readonly copyright: MetadataValue<string>;
    readonly keywords: MetadataValue<readonly string[]>;
  };
  readonly location: {
    readonly latitude: MetadataValue<number>;
    readonly longitude: MetadataValue<number>;
    readonly altitude: MetadataValue<number>;
    readonly city: MetadataValue<string>;
    readonly state: MetadataValue<string>;
    readonly country: MetadataValue<string>;
  };
  readonly claims: readonly MetadataClaim[];
  readonly warnings: readonly string[];
}

export type MetadataEditableField =
  | "title"
  | "caption"
  | "copyright"
  | "keywords"
  | "captureTime"
  | "latitude"
  | "longitude";

export type MetadataOverride<T> =
  | { readonly kind: "set"; readonly value: T }
  | { readonly kind: "clear" };

export interface MetadataOverrides {
  readonly title?: MetadataOverride<string>;
  readonly caption?: MetadataOverride<string>;
  readonly copyright?: MetadataOverride<string>;
  readonly keywords?: MetadataOverride<readonly string[]>;
  readonly captureTime?: MetadataOverride<CaptureWallTime>;
  readonly latitude?: MetadataOverride<number>;
  readonly longitude?: MetadataOverride<number>;
}

export interface MetadataPreset {
  readonly id: string;
  readonly name: string;
  readonly version: 1;
  readonly fields: MetadataOverrides;
  readonly captionMode: "replace" | "append";
  readonly keywordMode: "replace" | "append";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type MetadataSyncStatus =
  | "clean"
  | "catalog-only"
  | "sidecar-only"
  | "pending"
  | "conflict"
  | "error"
  | "disabled";

export interface MetadataFieldConflict {
  readonly field: MetadataEditableField;
  readonly base: unknown;
  readonly catalog: unknown;
  readonly sidecar: unknown;
}

export interface MetadataSyncState {
  readonly status: MetadataSyncStatus;
  readonly sidecarSha256: string | null;
  readonly sidecarModifiedAt: number | null;
  readonly catalogRevision: number;
  readonly baseline: MetadataOverrides;
  readonly ownedFields: readonly MetadataEditableField[];
  readonly conflicts: readonly MetadataFieldConflict[];
  readonly message: string | null;
  readonly updatedAt: number;
}

export function metadataValue<T>(value: MetadataValue<T>): T | null {
  return value.kind === "value" ? value.value : null;
}

export function effectiveMetadataValue<T>(
  source: MetadataValue<T>,
  override: MetadataOverride<T> | undefined,
): T | null {
  if (override?.kind === "set") return override.value;
  if (override?.kind === "clear") return null;
  return metadataValue(source);
}

export function emptyMetadataOverrides(): MetadataOverrides {
  return {};
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
}

function source(value: unknown, path: string): MetadataSource {
  if (
    value === "container" ||
    value === "exif" ||
    value === "iptc" ||
    value === "xmp" ||
    value === "raw" ||
    value === "catalog-fallback" ||
    value === "filesystem"
  ) return value;
  throw new Error(`${path} is invalid.`);
}

function metadataValueFrom<T>(
  value: unknown,
  path: string,
  parse: (input: unknown, fieldPath: string) => T,
): MetadataValue<T> {
  const input = record(value, path);
  if (input.kind === "absent") return { kind: "absent" };
  if (input.kind === "malformed") {
    return { kind: "malformed", message: text(input.message, `${path}.message`) };
  }
  if (input.kind === "unavailable") {
    return { kind: "unavailable", reason: text(input.reason, `${path}.reason`) };
  }
  if (input.kind !== "value") throw new Error(`${path}.kind is invalid.`);
  return {
    kind: "value",
    value: parse(input.value, `${path}.value`),
    source: source(input.source, `${path}.source`),
    tag: text(input.tag, `${path}.tag`),
  };
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function captureWallTime(value: unknown, path: string): CaptureWallTime {
  const input = record(value, path);
  return {
    value: text(input.value, `${path}.value`),
    offset: input.offset === null ? null : text(input.offset, `${path}.offset`),
    sortKey: finite(input.sortKey, `${path}.sortKey`),
  };
}

function editableField(value: unknown, path: string): MetadataEditableField {
  if (
    value === "title" || value === "caption" || value === "copyright" ||
    value === "keywords" || value === "captureTime" ||
    value === "latitude" || value === "longitude"
  ) return value;
  throw new Error(`${path} is invalid.`);
}

function claimValue(value: unknown, path: string): string | number | readonly string[] {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return stringArray(value, path);
}

export function parseSourceMetadataSnapshot(
  value: unknown,
  path = "source metadata",
): SourceMetadataSnapshot {
  const input = record(value, path);
  if (input.version !== SOURCE_METADATA_VERSION) {
    throw new Error(`${path}.version is invalid.`);
  }
  const file = record(input.file, `${path}.file`);
  const capture = record(input.capture, `${path}.capture`);
  const description = record(input.description, `${path}.description`);
  const location = record(input.location, `${path}.location`);
  if (!Array.isArray(input.claims) || !Array.isArray(input.warnings)) {
    throw new Error(`${path} claims or warnings are invalid.`);
  }
  return {
    version: SOURCE_METADATA_VERSION,
    parserVersion: text(input.parserVersion, `${path}.parserVersion`),
    adapterVersion: text(input.adapterVersion, `${path}.adapterVersion`),
    sourceSha256: text(input.sourceSha256, `${path}.sourceSha256`),
    extractedAt: finite(input.extractedAt, `${path}.extractedAt`),
    file: {
      byteLength: finite(file.byteLength, `${path}.file.byteLength`),
      modifiedAt: finite(file.modifiedAt, `${path}.file.modifiedAt`),
      width: metadataValueFrom(file.width, `${path}.file.width`, finite),
      height: metadataValueFrom(file.height, `${path}.file.height`, finite),
      orientation: metadataValueFrom(file.orientation, `${path}.file.orientation`, text),
      bitDepth: metadataValueFrom(file.bitDepth, `${path}.file.bitDepth`, finite),
      colorSpace: metadataValueFrom(file.colorSpace, `${path}.file.colorSpace`, text),
    },
    capture: {
      time: metadataValueFrom(capture.time, `${path}.capture.time`, captureWallTime),
      cameraMake: metadataValueFrom(capture.cameraMake, `${path}.capture.cameraMake`, text),
      cameraModel: metadataValueFrom(capture.cameraModel, `${path}.capture.cameraModel`, text),
      lens: metadataValueFrom(capture.lens, `${path}.capture.lens`, text),
      focalLength: metadataValueFrom(capture.focalLength, `${path}.capture.focalLength`, finite),
      aperture: metadataValueFrom(capture.aperture, `${path}.capture.aperture`, finite),
      shutter: metadataValueFrom(capture.shutter, `${path}.capture.shutter`, finite),
      iso: metadataValueFrom(capture.iso, `${path}.capture.iso`, finite),
    },
    description: {
      title: metadataValueFrom(description.title, `${path}.description.title`, text),
      caption: metadataValueFrom(description.caption, `${path}.description.caption`, text),
      copyright: metadataValueFrom(description.copyright, `${path}.description.copyright`, text),
      keywords: metadataValueFrom(description.keywords, `${path}.description.keywords`, stringArray),
    },
    location: {
      latitude: metadataValueFrom(location.latitude, `${path}.location.latitude`, finite),
      longitude: metadataValueFrom(location.longitude, `${path}.location.longitude`, finite),
      altitude: metadataValueFrom(location.altitude, `${path}.location.altitude`, finite),
      city: metadataValueFrom(location.city, `${path}.location.city`, text),
      state: metadataValueFrom(location.state, `${path}.location.state`, text),
      country: metadataValueFrom(location.country, `${path}.location.country`, text),
    },
    claims: input.claims.map((item, index) => {
      const claim = record(item, `${path}.claims[${index}]`);
      return {
        field: editableField(claim.field, `${path}.claims[${index}].field`),
        value: claimValue(claim.value, `${path}.claims[${index}].value`),
        source: source(claim.source, `${path}.claims[${index}].source`),
        tag: text(claim.tag, `${path}.claims[${index}].tag`),
      };
    }),
    warnings: input.warnings.map((item, index) => text(item, `${path}.warnings[${index}]`)),
  };
}

function optionalOverride<T>(
  input: UnknownRecord,
  key: MetadataEditableField,
  path: string,
  parse: (value: unknown, valuePath: string) => T,
): MetadataOverride<T> | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  const override = record(value, `${path}.${key}`);
  if (override.kind === "clear") return { kind: "clear" };
  if (override.kind !== "set") throw new Error(`${path}.${key}.kind is invalid.`);
  return { kind: "set", value: parse(override.value, `${path}.${key}.value`) };
}

function latitude(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < -90 || parsed > 90) throw new Error(`${path} must be from -90 to 90.`);
  return parsed;
}

function longitude(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (parsed < -180 || parsed > 180) throw new Error(`${path} must be from -180 to 180.`);
  return parsed;
}

export function parseMetadataOverrides(
  value: unknown,
  path = "metadata overrides",
): MetadataOverrides {
  const input = record(value, path);
  return {
    title: optionalOverride(input, "title", path, text),
    caption: optionalOverride(input, "caption", path, text),
    copyright: optionalOverride(input, "copyright", path, text),
    keywords: optionalOverride(input, "keywords", path, stringArray),
    captureTime: optionalOverride(input, "captureTime", path, captureWallTime),
    latitude: optionalOverride(input, "latitude", path, latitude),
    longitude: optionalOverride(input, "longitude", path, longitude),
  };
}

export function parseMetadataPreset(value: unknown, path = "metadata preset"): MetadataPreset {
  const input = record(value, path);
  if (input.version !== 1) throw new Error(`${path}.version is invalid.`);
  if (input.captionMode !== "replace" && input.captionMode !== "append") {
    throw new Error(`${path}.captionMode is invalid.`);
  }
  if (input.keywordMode !== "replace" && input.keywordMode !== "append") {
    throw new Error(`${path}.keywordMode is invalid.`);
  }
  return {
    id: text(input.id, `${path}.id`),
    name: text(input.name, `${path}.name`),
    version: 1,
    fields: parseMetadataOverrides(input.fields, `${path}.fields`),
    captionMode: input.captionMode,
    keywordMode: input.keywordMode,
    createdAt: finite(input.createdAt, `${path}.createdAt`),
    updatedAt: finite(input.updatedAt, `${path}.updatedAt`),
  };
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function syncStatus(value: unknown, path: string): MetadataSyncStatus {
  if (
    value === "clean" || value === "catalog-only" || value === "sidecar-only" ||
    value === "pending" || value === "conflict" || value === "error" || value === "disabled"
  ) return value;
  throw new Error(`${path} is invalid.`);
}

export function parseMetadataSyncState(
  value: unknown,
  path = "metadata sync state",
): MetadataSyncState {
  const input = record(value, path);
  if (!Array.isArray(input.ownedFields) || !Array.isArray(input.conflicts)) {
    throw new Error(`${path} owned fields or conflicts are invalid.`);
  }
  return {
    status: syncStatus(input.status, `${path}.status`),
    sidecarSha256: nullableText(input.sidecarSha256, `${path}.sidecarSha256`),
    sidecarModifiedAt: input.sidecarModifiedAt === null
      ? null
      : finite(input.sidecarModifiedAt, `${path}.sidecarModifiedAt`),
    catalogRevision: finite(input.catalogRevision, `${path}.catalogRevision`),
    baseline: parseMetadataOverrides(input.baseline, `${path}.baseline`),
    ownedFields: input.ownedFields.map((item, index) => editableField(item, `${path}.ownedFields[${index}]`)),
    conflicts: input.conflicts.map((item, index) => {
      const conflict = record(item, `${path}.conflicts[${index}]`);
      return {
        field: editableField(conflict.field, `${path}.conflicts[${index}].field`),
        base: conflict.base,
        catalog: conflict.catalog,
        sidecar: conflict.sidecar,
      };
    }),
    message: nullableText(input.message, `${path}.message`),
    updatedAt: finite(input.updatedAt, `${path}.updatedAt`),
  };
}
