import {
  parseAssetId,
  parseCatalogId,
  type AssetId,
  type CatalogId,
} from "../catalog/ids.ts";
import { parseSessionId, type SessionId } from "../catalog/runtime.ts";

/** Format identifiers understood by the export encoder. */
export const EXPORT_FORMAT_IDS = [
  "jpeg",
  "png",
  "webp",
  "avif",
  "tiff",
] as const;

/** Raw RGBA dimensions accepted by the native export boundary. */
export const MAX_EXPORT_PIXELS = 50_000_000;
export const MAX_EXPORT_EDGE = 100_000;

export type ExportFormatId = (typeof EXPORT_FORMAT_IDS)[number];

export interface ExportFormatDescriptor {
  id: ExportFormatId;
  label: string;
  extensions: string[];
  supportsQuality: boolean;
  supportsLossless: boolean;
  defaultQuality?: number;
}

/** The request used to let the native save dialog choose a destination. */
export interface ExportDestinationRequest {
  catalogId: CatalogId;
  sessionId: SessionId;
  assetIds: AssetId[];
  count: number;
  format: ExportFormatId;
  suggestedFilename: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExportFormatId(value: unknown): value is ExportFormatId {
  return EXPORT_FORMAT_IDS.some((formatId) => formatId === value);
}

export function parseExportDestinationRequest(value: unknown): ExportDestinationRequest {
  if (
    !isRecord(value) ||
    !Array.isArray(value.assetIds) ||
    !Number.isSafeInteger(value.count) ||
    Number(value.count) < 1 ||
    !isExportFormatId(value.format) ||
    typeof value.suggestedFilename !== "string" ||
    value.suggestedFilename.length < 1 ||
    value.suggestedFilename.length > 512 ||
    value.suggestedFilename.includes("\0")
  ) {
    throw new Error("Export destination request is invalid.");
  }
  const count = Number(value.count);
  const assetIds = value.assetIds.map(parseAssetId);
  if (
    assetIds.length < 1 ||
    assetIds.length > count ||
    new Set(assetIds).size !== assetIds.length
  ) {
    throw new Error("Export selection is invalid.");
  }
  return {
    catalogId: parseCatalogId(value.catalogId),
    sessionId: parseSessionId(value.sessionId),
    assetIds,
    count,
    format: value.format,
    suggestedFilename: value.suggestedFilename,
  };
}

export interface ExportDestination {
  token: string;
}

/** Opaque, short-lived permission to reveal the last output in the file browser. */
export type ExportRevealCapability = string;

/** Options remembered between export sessions. */
export interface ExportPreferences {
  format: ExportFormatId;
  quality: number;
  lossless: boolean;
  size: ExportSizeOptions;
  suffix: string;
  conflict: ExportConflictBehavior;
}

export type ExportSizeMode = "original" | "long-edge" | "longEdge" | "fit";

/** Size controls for the encoder's resize step. */
export type ExportSizeOptions =
  | { mode: "original" }
  | {
      mode: "long-edge" | "longEdge";
      /** Target long edge in pixels. */
      pixels?: number;
      /** Alias accepted by renderer-side callers. */
      longEdge?: number;
      /** Defaults to true. */
      neverUpscale?: boolean;
    }
  | {
      mode: "fit";
      /** Target width, used when mode is "fit". */
      width: number;
      /** Target height, used when mode is "fit". */
      height: number;
      /** Defaults to true. */
      neverUpscale?: boolean;
    };

export type ExportConflictBehavior = "rename" | "skip" | "replace";

export const DEFAULT_EXPORT_SUFFIX = "-darkroom";

export const DEFAULT_EXPORT_PREFERENCES: ExportPreferences = {
  format: "jpeg",
  quality: 90,
  lossless: false,
  size: { mode: "original" },
  suffix: DEFAULT_EXPORT_SUFFIX,
  conflict: "rename",
};

export interface ExportJobOptions {
  format: ExportFormatId;
  size: ExportSizeOptions;
  quality?: number;
  lossless?: boolean;
  suffix?: string;
  filenameSuffix?: string;
  conflict: ExportConflictBehavior;
  destinationToken: string;
}

export interface ExportEncodeOptions {
  format: ExportFormatId;
  size?: ExportSizeOptions;
  quality?: number;
  lossless?: boolean;
  suffix?: string;
  filenameSuffix?: string;
  conflict?: ExportConflictBehavior;
  /** Legacy scalar dimensions accepted by the encoder boundary. */
  width?: number;
  height?: number;
  neverUpscale?: boolean;
  /** Fully rendered XMP packet for the output file. */
  xmp?: string;
}

export interface ExportPixelPayload {
  pixels: ArrayBuffer | Uint8Array;
  width: number;
  height: number;
}

export type ExportPixels = ArrayBuffer | Uint8Array | ExportPixelPayload;

export interface ExportEncodeResult {
  status: "exported" | "skipped";
  path?: string;
  warning?: string;
}

export type ExportActivePhase = "decode" | "render" | "encode" | "write";

export type ExportItemState =
  | { readonly kind: "queued" }
  | { readonly kind: "active"; readonly phase: ExportActivePhase }
  | {
      readonly kind: "completed";
      readonly outputPath: string;
      readonly warnings: readonly string[];
    }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: "not-started" }
  | {
      readonly kind: "failed";
      readonly error: string;
      readonly retryable: boolean;
    };

export interface ExportFileResult {
  readonly entryId: string;
  readonly sourceName: string;
  readonly state: ExportItemState;
}

export type ExportRenderProvenance = "decoded" | "embedded-preview";

export interface RawExportRenderResult {
  pixels: Uint8Array;
  width: number;
  height: number;
  provenance: ExportRenderProvenance;
  embeddedPreview: boolean;
  warning?: string;
}
