import exifr from "exifr";
import type { AssetId } from "../lib/catalog/ids";
import type {
  MetadataAnalysisItem,
  MetadataAnalysisProgress,
  MetadataAnalysisRequest,
  MetadataAnalysisResult,
} from "../lib/library/metadata-analysis";
import {
  entryAnalysisCacheSignature,
  type CaptureTimeProvenance,
  type EntryAnalysis,
} from "../lib/library/model";

const EXIF_FIELDS = [
  "DateTimeOriginal",
  "SubSecTimeOriginal",
  "OffsetTimeOriginal",
  "CreateDate",
  "OffsetTimeDigitized",
  "Make",
  "Model",
  "LensModel",
  "Lens",
  "ISO",
  "ISOSpeedRatings",
  "FocalLength",
  "City",
  "ProvinceState",
  "State",
  "Country",
  "CountryPrimaryLocationName",
] as const;

export interface MetadataAnalysisTarget {
  readonly entryId: AssetId;
  readonly filePath: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface MetadataAnalysisServiceOptions {
  readonly concurrency?: number;
  readonly now?: () => number;
}

type ExifRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ExifRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && typeof value[0] === "number" && Number.isFinite(value[0])) {
    return value[0];
  }
  return null;
}

function firstText(record: ExifRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstNumber(record: ExifRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) return value;
  }
  return null;
}

interface CaptureTime {
  readonly key: number;
  readonly display: string;
  readonly provenance: CaptureTimeProvenance;
}

function dateParts(value: unknown): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly display: string;
} | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
      display: value.toISOString(),
    };
  }
  const text = textValue(value);
  if (text === null) return null;
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(text);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (values.length !== 6 || values.some((item) => !Number.isFinite(item))) return null;
  const [year, month, day, hour, minute, second] = values;
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined || minute === undefined || second === undefined ||
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 60
  ) return null;
  return { year, month, day, hour, minute, second, display: text };
}

function offsetMinutes(value: unknown): number | null {
  const offset = textValue(value);
  if (offset === null) return null;
  if (offset === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(offset);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function captureTime(
  value: unknown,
  subsecondValue: unknown,
  offsetValue: unknown,
  provenance: CaptureTimeProvenance,
): CaptureTime | null {
  const parts = dateParts(value);
  if (!parts) return null;
  const subsecond = textValue(subsecondValue)?.replace(/\D/gu, "") ?? "";
  const milliseconds = Number((subsecond + "000").slice(0, 3));
  const utcWallTime = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    milliseconds,
  );
  if (!Number.isFinite(utcWallTime)) return null;
  const offset = offsetMinutes(offsetValue);
  return {
    key: offset === null ? utcWallTime : utcWallTime - offset * 60_000,
    display: [parts.display, subsecond ? `.${subsecond}` : "", textValue(offsetValue) ?? ""]
      .join(""),
    provenance,
  };
}

function normalizedError(error: unknown): string {
  if (error instanceof Error && /unsupported|invalid|malformed/iu.test(error.message)) {
    return "Embedded metadata is unsupported or malformed.";
  }
  return "Embedded metadata could not be read.";
}

async function hasGps(filePath: string): Promise<boolean | null> {
  try {
    const gps: unknown = await exifr.gps(filePath);
    if (!isRecord(gps)) return false;
    return numberValue(gps.latitude) !== null && numberValue(gps.longitude) !== null;
  } catch {
    return null;
  }
}

async function analyzeTarget(
  target: MetadataAnalysisTarget,
  now: () => number,
): Promise<{ readonly item: MetadataAnalysisItem; readonly failed: boolean }> {
  const base = {
    cacheSignature: entryAnalysisCacheSignature(target.size, target.modifiedAt),
    size: target.size,
    modifiedAt: target.modifiedAt,
    analyzedAt: now(),
  };
  try {
    const parsed: unknown = await exifr.parse(target.filePath, {
      pick: [...EXIF_FIELDS],
      reviveValues: false,
      translateValues: true,
      tiff: true,
      exif: true,
      gps: true,
      iptc: true,
      xmp: true,
    });
    const fields = isRecord(parsed) ? parsed : {};
    const subsecond = textValue(fields.SubSecTimeOriginal);
    const captured = captureTime(
      fields.DateTimeOriginal,
      subsecond,
      fields.OffsetTimeOriginal,
      subsecond === null ? "date-time-original" : "date-time-original-subsecond",
    ) ?? captureTime(
      fields.CreateDate,
      null,
      fields.OffsetTimeDigitized,
      "create-date",
    );
    const analysis: EntryAnalysis = {
      ...base,
      captureTimeKey: captured?.key ?? null,
      captureTimeDisplay: captured?.display ?? null,
      captureTimeProvenance: captured?.provenance ?? null,
      cameraMake: firstText(fields, ["Make"]),
      cameraModel: firstText(fields, ["Model"]),
      lens: firstText(fields, ["LensModel", "Lens"]),
      iso: firstNumber(fields, ["ISO", "ISOSpeedRatings"]),
      focalLength: firstNumber(fields, ["FocalLength"]),
      location: {
        city: firstText(fields, ["City"]),
        state: firstText(fields, ["State", "ProvinceState"]),
        country: firstText(fields, ["Country", "CountryPrimaryLocationName"]),
      },
      hasGps: await hasGps(target.filePath),
      error: null,
    };
    return { item: { entryId: target.entryId, analysis }, failed: false };
  } catch (error) {
    return {
      item: {
        entryId: target.entryId,
        analysis: {
          ...base,
          captureTimeKey: null,
          captureTimeDisplay: null,
          captureTimeProvenance: null,
          cameraMake: null,
          cameraModel: null,
          lens: null,
          iso: null,
          focalLength: null,
          location: { city: null, state: null, country: null },
          hasGps: null,
          error: normalizedError(error),
        },
      },
      failed: true,
    };
  }
}

export async function analyzeMetadataTargets(
  request: MetadataAnalysisRequest,
  targets: readonly MetadataAnalysisTarget[],
  signal: AbortSignal,
  onProgress: (progress: MetadataAnalysisProgress) => void,
  options: MetadataAnalysisServiceOptions = {},
): Promise<MetadataAnalysisResult> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("Metadata analysis concurrency is invalid.");
  }
  const now = options.now ?? Date.now;
  const items: MetadataAnalysisItem[] = [];
  let nextIndex = 0;
  let completed = 0;
  let failed = 0;
  const progress = (): MetadataAnalysisProgress => ({
    catalogId: request.catalogId,
    sessionId: request.sessionId,
    operationId: request.operationId,
    total: targets.length,
    completed,
    failed,
    cancelled: signal.aborted,
  });
  onProgress(progress());

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const target = targets[index];
      if (!target) return;
      const result = await analyzeTarget(target, now);
      items.push(result.item);
      completed += 1;
      if (result.failed) failed += 1;
      onProgress(progress());
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()),
  );
  return { ...progress(), items };
}
