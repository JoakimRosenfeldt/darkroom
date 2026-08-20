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
  count: number;
  format: ExportFormatId;
  suggestedFilename: string;
  sources: Array<{
    rootPath: string;
    relativePath: string;
  }>;
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

export type ExportFileStatus = "success" | "skipped" | "warning" | "error";

export interface ExportFileResult {
  entryId: string;
  sourceName?: string;
  outputName?: string;
  status: ExportFileStatus;
  warning?: string;
  error?: string;
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
