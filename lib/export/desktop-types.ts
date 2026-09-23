import type { ExportEncodeResult, ExportPreferences } from "./types";

export type {
  ExportDestinationRequest,
  ExportEncodeOptions,
  ExportFormatDescriptor,
  ExportPixelPayload,
} from "./types";

export type ExportResult = ExportEncodeResult;
export type ExportOptionsSettings = ExportPreferences;
export type ExportOptionsSettingsInput = Partial<ExportOptionsSettings>;

export interface ExportFinalizeResult {
  revealToken: string | null;
  outputPath: string | null;
}
