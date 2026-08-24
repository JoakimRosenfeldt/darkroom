import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
import { normalizeSourceMetadata, type SourceMetadataFallback } from "../lib/metadata/normalize";
import {
  SOURCE_METADATA_ADAPTER_VERSION,
  SOURCE_METADATA_PARSER_VERSION,
  metadataValue,
} from "../lib/metadata/types";
import type { MetadataCache } from "./metadata-cache";

export interface MetadataAnalysisTarget {
  readonly entryId: AssetId;
  readonly filePath: string;
  readonly size: number;
  readonly modifiedAt: number;
  readonly fallback?: SourceMetadataFallback;
}

export interface MetadataAnalysisServiceOptions {
  readonly concurrency?: number;
  readonly now?: () => number;
  readonly cache?: MetadataCache;
}

function normalizedError(error: unknown): string {
  if (error instanceof Error && /unsupported|invalid|malformed/iu.test(error.message)) {
    return "Embedded metadata is unsupported or malformed.";
  }
  return "Embedded metadata could not be read.";
}

const RAW_METADATA_EXTENSIONS = new Set([
  ".3fr", ".arw", ".cr2", ".cr3", ".dng", ".erf", ".fff", ".iiq", ".kdc",
  ".mef", ".mos", ".mrw", ".nef", ".nrw", ".orf", ".pef", ".raf", ".raw",
  ".rw2", ".rwl", ".sr2", ".srf", ".srw", ".x3f",
]);

function adapterVersion(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLocaleLowerCase();
  return `${SOURCE_METADATA_ADAPTER_VERSION}-${RAW_METADATA_EXTENSIONS.has(extension) ? "raw" : "standard"}`;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function provenance(tag: string | undefined): CaptureTimeProvenance | null {
  if (!tag) return null;
  if (tag.includes("DateTimeOriginal")) return "date-time-original";
  return tag.includes("CreateDate") ? "create-date" : null;
}

function analysisFromSnapshot(input: {
  readonly target: MetadataAnalysisTarget;
  readonly sourceSha256: string;
  readonly extractedAt: number;
  readonly parsed: unknown;
  readonly adapterVersion: string;
}): EntryAnalysis {
  const source = normalizeSourceMetadata({
    parsed: input.parsed,
    sourceSha256: input.sourceSha256,
    byteLength: input.target.size,
    modifiedAt: input.target.modifiedAt,
    extractedAt: input.extractedAt,
    adapterVersion: input.adapterVersion,
    fallback: input.target.fallback,
  });
  const captured = metadataValue(source.capture.time);
  const latitude = metadataValue(source.location.latitude);
  const longitude = metadataValue(source.location.longitude);
  return {
    cacheSignature: entryAnalysisCacheSignature(input.target.size, input.target.modifiedAt),
    size: input.target.size,
    modifiedAt: input.target.modifiedAt,
    sourceSha256: input.sourceSha256,
    parserVersion: SOURCE_METADATA_PARSER_VERSION,
    adapterVersion: input.adapterVersion,
    cacheHit: false,
    source,
    captureTimeKey: captured?.sortKey ?? null,
    captureTimeDisplay: captured === null
      ? null
      : `${captured.value}${captured.offset ?? ""}`,
    captureTimeProvenance: provenance(source.capture.time.kind === "value" ? source.capture.time.tag : undefined),
    cameraMake: metadataValue(source.capture.cameraMake),
    cameraModel: metadataValue(source.capture.cameraModel),
    lens: metadataValue(source.capture.lens),
    iso: metadataValue(source.capture.iso),
    focalLength: metadataValue(source.capture.focalLength),
    location: {
      city: metadataValue(source.location.city),
      state: metadataValue(source.location.state),
      country: metadataValue(source.location.country),
    },
    hasGps: latitude === null || longitude === null ? false : true,
    error: null,
    analyzedAt: input.extractedAt,
  };
}

function cachedForTarget(cached: EntryAnalysis, target: MetadataAnalysisTarget): EntryAnalysis {
  return {
    ...cached,
    cacheSignature: entryAnalysisCacheSignature(target.size, target.modifiedAt),
    size: target.size,
    modifiedAt: target.modifiedAt,
    cacheHit: true,
    source: cached.source === null
      ? null
      : {
          ...cached.source,
          file: {
            ...cached.source.file,
            byteLength: target.size,
            modifiedAt: target.modifiedAt,
          },
        },
  };
}

async function analyzeTarget(
  request: MetadataAnalysisRequest,
  target: MetadataAnalysisTarget,
  now: () => number,
  cache: MetadataCache | undefined,
): Promise<{ readonly item: MetadataAnalysisItem; readonly failed: boolean }> {
  const digest = await sha256(target.filePath);
  const targetAdapterVersion = adapterVersion(target.filePath);
  if (!request.force && cache) {
    const cached = await cache.read({
      catalogId: request.catalogId,
      entryId: target.entryId,
      sourceSha256: digest,
      parserVersion: SOURCE_METADATA_PARSER_VERSION,
      adapterVersion: targetAdapterVersion,
    });
    if (cached) {
      return {
        item: { entryId: target.entryId, analysis: cachedForTarget(cached, target) },
        failed: cached.error !== null,
      };
    }
  }

  try {
    const parsed: unknown = await exifr.parse(target.filePath, {
      mergeOutput: false,
      reviveValues: false,
      translateKeys: true,
      translateValues: true,
      sanitize: true,
      multiSegment: false,
      tiff: true,
      ifd0: {},
      exif: true,
      gps: true,
      iptc: true,
      xmp: true,
      icc: true,
      ihdr: true,
    });
    const analysis = analysisFromSnapshot({
      target,
      sourceSha256: digest,
      extractedAt: now(),
      parsed,
      adapterVersion: targetAdapterVersion,
    });
    await cache?.write({ catalogId: request.catalogId, entryId: target.entryId, analysis });
    return { item: { entryId: target.entryId, analysis }, failed: false };
  } catch (error) {
    const analysis: EntryAnalysis = {
      cacheSignature: entryAnalysisCacheSignature(target.size, target.modifiedAt),
      size: target.size,
      modifiedAt: target.modifiedAt,
      sourceSha256: digest,
      parserVersion: SOURCE_METADATA_PARSER_VERSION,
      adapterVersion: targetAdapterVersion,
      cacheHit: false,
      source: null,
      captureTimeKey: null,
      captureTimeDisplay: null,
      captureTimeProvenance: null,
      cameraMake: target.fallback?.cameraMake ?? null,
      cameraModel: target.fallback?.cameraModel ?? null,
      lens: target.fallback?.lens ?? null,
      iso: null,
      focalLength: null,
      location: { city: null, state: null, country: null },
      hasGps: null,
      error: normalizedError(error),
      analyzedAt: now(),
    };
    await cache?.write({ catalogId: request.catalogId, entryId: target.entryId, analysis });
    return { item: { entryId: target.entryId, analysis }, failed: true };
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
      const result = await analyzeTarget(request, target, now, options.cache);
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
