import type { PhotoCatalog } from "../lib/catalog/types";
import type {
  AiModelId,
  AiModelDisclosureLink,
  AiModelProgress,
  AiModelState,
  Unsubscribe,
} from "../lib/ai/types";
import type { NefDecodeRequest, NefDecodeResult } from "../electron/nef-decoder-service";
import type {
  ExportDestinationRequest,
  ExportEncodeOptions,
  ExportFinalizeResult,
  ExportFormatDescriptor,
  ExportPixelPayload,
  ExportResult,
} from "../electron/export-service";
import type {
  ExportOptionsSettings,
  ExportOptionsSettingsInput,
} from "../electron/settings";

export interface ScannedFile {
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
}

export type { PhotoCatalog };

export interface DarkroomAPI {
  isElectron: true;
  pickFolder(): Promise<{ path: string; name: string } | null>;
  scanFolder(rootPath: string): Promise<ScannedFile[]>;
  readFile(absolutePath: string): Promise<ArrayBuffer>;
  readFileHead(absolutePath: string, maxBytes: number): Promise<ArrayBuffer>;
  statFile(absolutePath: string): Promise<{ size: number; lastModified: number }>;
  decodeNef(request: NefDecodeRequest): Promise<NefDecodeResult>;
  getLastFolder(): Promise<string | null>;
  setLastFolder(folderPath: string | null): Promise<void>;
  folderExists(folderPath: string): Promise<boolean>;
  readCatalog(rootPath: string): Promise<PhotoCatalog | null>;
  writeCatalog(catalog: PhotoCatalog): Promise<void>;
  deleteCatalog(rootPath: string): Promise<void>;
  deleteFiles(absolutePaths: string[]): Promise<void>;
  readSidecar(
    rootPath: string,
    relativePath: string,
  ): Promise<{ contents: string; lastModified: number } | null>;
  writeSidecar(
    rootPath: string,
    relativePath: string,
    contents: string,
  ): Promise<void>;
  getExportFormats(): Promise<ExportFormatDescriptor[]>;
  chooseExportDestination(
    request: ExportDestinationRequest,
  ): Promise<{ token: string } | null>;
  encodeAndSaveExport(
    token: string,
    basename: string,
    pixels: ArrayBuffer | Uint8Array | ExportPixelPayload,
    options: ExportEncodeOptions,
  ): Promise<ExportResult>;
  finalizeExport(token: string): Promise<ExportFinalizeResult>;
  getExportOptions(): Promise<ExportOptionsSettings>;
  setExportOptions(options: ExportOptionsSettingsInput): Promise<void>;
  showInFolder(revealToken: string): Promise<void>;
  getAiModelState(modelId: AiModelId): Promise<AiModelState>;
  downloadAiModel(modelId: AiModelId): Promise<void>;
  cancelAiModelDownload(modelId: AiModelId): Promise<void>;
  removeAiModel(modelId: AiModelId): Promise<void>;
  openAiModelLink(modelId: AiModelId, link: AiModelDisclosureLink): Promise<void>;
  onAiModelProgress(listener: (progress: AiModelProgress) => void): Unsubscribe;
}

declare global {
  interface Window {
    darkroom?: DarkroomAPI;
  }
}

export {};
