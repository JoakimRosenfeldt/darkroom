import {
  SOURCE_METADATA_ADAPTER_VERSION,
  SOURCE_METADATA_PARSER_VERSION,
  SOURCE_METADATA_VERSION,
  type CaptureWallTime,
  type MetadataClaim,
  type MetadataEditableField,
  type MetadataSource,
  type MetadataValue,
  type SourceMetadataSnapshot,
} from "./types";

type MetadataRecord = Record<string, unknown>;

export interface SourceMetadataFallback {
  readonly cameraMake?: string | null;
  readonly cameraModel?: string | null;
  readonly lens?: string | null;
}

export interface NormalizeSourceMetadataInput {
  readonly parsed: unknown;
  readonly sourceSha256: string;
  readonly byteLength: number;
  readonly modifiedAt: number;
  readonly extractedAt: number;
  readonly adapterVersion?: string;
  readonly fallback?: SourceMetadataFallback;
}

interface Candidate {
  readonly source: MetadataSource;
  readonly tag: string;
  readonly value: unknown;
}

function isRecord(value: unknown): value is MetadataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): MetadataRecord {
  return isRecord(value) ? value : {};
}

function recordsFor(parsed: unknown): Readonly<Record<MetadataSource, MetadataRecord>> {
  const root = record(parsed);
  return {
    container: root,
    exif: { ...record(root.ifd0), ...record(root.exif), ...record(root.gps) },
    iptc: record(root.iptc),
    xmp: Object.fromEntries(
      Object.entries(root).filter(([key, value]) => (
        !["ifd0", "ifd1", "exif", "gps", "iptc", "icc", "jfif", "ihdr", "errors"].includes(key) &&
        isRecord(value)
      )),
    ),
    raw: root,
    "catalog-fallback": {},
    filesystem: {},
  };
}

function deepValue(value: unknown, wanted: ReadonlySet<string>, depth = 0): { tag: string; value: unknown } | null {
  if (!isRecord(value) || depth > 4) return null;
  for (const [key, item] of Object.entries(value)) {
    const localName = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
    if (wanted.has(localName.toLocaleLowerCase())) return { tag: key, value: item };
  }
  for (const [key, item] of Object.entries(value)) {
    const nested = deepValue(item, wanted, depth + 1);
    if (nested) return { tag: `${key}.${nested.tag}`, value: nested.value };
  }
  return null;
}

function candidate(
  source: MetadataSource,
  sourceRecord: MetadataRecord,
  keys: readonly string[],
): Candidate | null {
  const found = deepValue(
    sourceRecord,
    new Set(keys.map((key) => key.toLocaleLowerCase())),
  );
  return found ? { source, ...found } : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (isRecord(value)) {
    return text(value.value) ?? text(value["x-default"]);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = text(item);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = number(item);
      if (parsed !== null) return parsed;
    }
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function texts(value: unknown): readonly string[] | null {
  const values = Array.isArray(value) ? value : [value];
  const parsed = values.flatMap((item) => {
    const itemText = text(item);
    return itemText === null ? [] : [itemText];
  });
  const unique = [...new Map(parsed.map((item) => [item.toLocaleLowerCase(), item])).values()];
  return unique.length > 0 ? unique : null;
}

function valueFrom<T>(
  candidates: readonly (Candidate | null)[],
  parse: (value: unknown) => T | null,
): MetadataValue<T> {
  for (const item of candidates) {
    if (!item) continue;
    const parsed = parse(item.value);
    if (parsed !== null) {
      return { kind: "value", value: parsed, source: item.source, tag: item.tag };
    }
  }
  return { kind: "absent" };
}

function fallbackValue(value: string | null | undefined, tag: string): MetadataValue<string> {
  const parsed = text(value);
  return parsed === null
    ? { kind: "absent" }
    : { kind: "value", value: parsed, source: "catalog-fallback", tag };
}

function offset(value: unknown): string | null {
  const parsed = text(value);
  if (parsed === "Z") return parsed;
  return parsed !== null && /^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/u.test(parsed)
    ? parsed
    : null;
}

function dateParts(value: unknown): {
  readonly wallTime: string;
  readonly sortKey: number;
} | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const iso = value.toISOString();
    return { wallTime: iso.slice(0, 19), sortKey: value.getTime() };
  }
  const parsed = text(value);
  if (parsed === null) return null;
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/u.exec(parsed);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    !year || !month || !day ||
    hour === undefined || minute === undefined || second === undefined ||
    month > 12 || day > 31 || hour > 23 || minute > 59 || second > 60
  ) return null;
  const milliseconds = Number(((match[7] ?? "") + "000").slice(0, 3));
  const sortKey = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  if (!Number.isFinite(sortKey)) return null;
  const wallTime = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  return { wallTime, sortKey };
}

function captureTime(
  dateCandidate: Candidate | null,
  offsetCandidate: Candidate | null,
): MetadataValue<CaptureWallTime> {
  if (!dateCandidate) return { kind: "absent" };
  const parts = dateParts(dateCandidate.value);
  if (!parts) return { kind: "malformed", message: `${dateCandidate.tag} is not a valid capture time.` };
  const parsedOffset = offset(offsetCandidate?.value);
  const offsetMinutes = parsedOffset === null || parsedOffset === "Z"
    ? parsedOffset === "Z" ? 0 : null
    : (() => {
        const sign = parsedOffset.startsWith("-") ? -1 : 1;
        const [hours, minutes] = parsedOffset.slice(1).split(":").map(Number);
        return sign * ((hours ?? 0) * 60 + (minutes ?? 0));
      })();
  return {
    kind: "value",
    value: {
      value: parts.wallTime,
      offset: parsedOffset,
      sortKey: offsetMinutes === null ? parts.sortKey : parts.sortKey - offsetMinutes * 60_000,
    },
    source: dateCandidate.source,
    tag: dateCandidate.tag,
  };
}

function claimsFor(
  field: MetadataEditableField,
  candidates: readonly (Candidate | null)[],
  parse: (value: unknown) => string | number | readonly string[] | null,
): MetadataClaim[] {
  return candidates.flatMap((item) => {
    if (!item) return [];
    const parsed = parse(item.value);
    return parsed === null ? [] : [{ field, value: parsed, source: item.source, tag: item.tag }];
  });
}

function warningMessages(parsed: unknown): string[] {
  const errors = record(parsed).errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((error) => {
    if (typeof error === "string" && error.trim().length > 0) return [error.trim()];
    if (error instanceof Error && error.message.trim().length > 0) return [error.message.trim()];
    return [];
  });
}

export function normalizeSourceMetadata(
  input: NormalizeSourceMetadataInput,
): SourceMetadataSnapshot {
  const sources = recordsFor(input.parsed);
  const from = (source: MetadataSource, keys: readonly string[]) => candidate(source, sources[source], keys);
  const xmpTitle = from("xmp", ["title"]);
  const iptcTitle = from("iptc", ["ObjectName", "Headline"]);
  const exifTitle = from("exif", ["XPTitle", "ImageDescription"]);
  const xmpCaption = from("xmp", ["description", "caption"]);
  const iptcCaption = from("iptc", ["Caption", "LocalCaption"]);
  const exifCaption = from("exif", ["ImageDescription", "UserComment"]);
  const xmpCopyright = from("xmp", ["rights", "copyright"]);
  const iptcCopyright = from("iptc", ["CopyrightNotice"]);
  const exifCopyright = from("exif", ["Copyright", "Artist"]);
  const xmpKeywords = from("xmp", ["subject", "hierarchicalSubject"]);
  const iptcKeywords = from("iptc", ["Keywords", "SubjectReference"]);
  const date = from("exif", ["DateTimeOriginal", "CreateDate", "DateTimeDigitized"]);
  const dateOffset = from("exif", ["OffsetTimeOriginal", "OffsetTimeDigitized", "OffsetTime"]);
  const cameraMake = valueFrom([from("exif", ["Make"])], text);
  const cameraModel = valueFrom([from("exif", ["Model"])], text);
  const lens = valueFrom([from("exif", ["LensModel", "Lens", "LensInfo"])], text);
  const fallback = input.fallback ?? {};
  const titleCandidates = [xmpTitle, iptcTitle, exifTitle];
  const captionCandidates = [xmpCaption, iptcCaption, exifCaption];
  const copyrightCandidates = [xmpCopyright, iptcCopyright, exifCopyright];
  const keywordCandidates = [xmpKeywords, iptcKeywords];
  const latitude = from("exif", ["latitude", "GPSLatitude"]);
  const longitude = from("exif", ["longitude", "GPSLongitude"]);

  return {
    version: SOURCE_METADATA_VERSION,
    parserVersion: SOURCE_METADATA_PARSER_VERSION,
    adapterVersion: input.adapterVersion ?? SOURCE_METADATA_ADAPTER_VERSION,
    sourceSha256: input.sourceSha256,
    extractedAt: input.extractedAt,
    file: {
      byteLength: input.byteLength,
      modifiedAt: input.modifiedAt,
      width: valueFrom([from("container", ["ExifImageWidth", "ImageWidth", "PixelXDimension"])], number),
      height: valueFrom([from("container", ["ExifImageHeight", "ImageHeight", "PixelYDimension"])], number),
      orientation: valueFrom([from("exif", ["Orientation", "ImageOrientation"])], text),
      bitDepth: valueFrom([from("container", ["BitsPerSample", "BitDepth"])], number),
      colorSpace: valueFrom([from("container", ["ColorSpace", "ColorSpaceData", "ProfileDescription"])], text),
    },
    capture: {
      time: captureTime(date, dateOffset),
      cameraMake: cameraMake.kind === "value" ? cameraMake : fallbackValue(fallback.cameraMake, "catalog.cameraMake"),
      cameraModel: cameraModel.kind === "value" ? cameraModel : fallbackValue(fallback.cameraModel, "catalog.cameraModel"),
      lens: lens.kind === "value" ? lens : fallbackValue(fallback.lens, "catalog.lensModel"),
      focalLength: valueFrom([from("exif", ["FocalLength", "focal_len"])], number),
      aperture: valueFrom([from("exif", ["FNumber", "ApertureValue", "aperture"])], number),
      shutter: valueFrom([from("exif", ["ExposureTime", "ShutterSpeedValue", "shutter"])], number),
      iso: valueFrom([from("exif", ["ISO", "ISOSpeedRatings", "iso_speed"])], number),
    },
    description: {
      title: valueFrom(titleCandidates, text),
      caption: valueFrom(captionCandidates, text),
      copyright: valueFrom(copyrightCandidates, text),
      keywords: valueFrom(keywordCandidates, texts),
    },
    location: {
      latitude: valueFrom([latitude], number),
      longitude: valueFrom([longitude], number),
      altitude: valueFrom([from("exif", ["GPSAltitude", "altitude"])], number),
      city: valueFrom([from("xmp", ["City"]), from("iptc", ["City"])], text),
      state: valueFrom([from("xmp", ["State", "ProvinceState"]), from("iptc", ["State", "ProvinceState"])], text),
      country: valueFrom([from("xmp", ["Country", "CountryName"]), from("iptc", ["Country", "CountryPrimaryLocationName"])], text),
    },
    claims: [
      ...claimsFor("title", titleCandidates, text),
      ...claimsFor("caption", captionCandidates, text),
      ...claimsFor("copyright", copyrightCandidates, text),
      ...claimsFor("keywords", keywordCandidates, texts),
    ],
    warnings: warningMessages(input.parsed),
  };
}
