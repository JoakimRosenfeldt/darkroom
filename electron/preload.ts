import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  isAiModelProgress,
  parseAiModelId,
  type AiModelDisclosureLink,
  type AiModelId,
  type AiModelProgress,
  type AiModelState,
  type Unsubscribe,
} from "../lib/ai/types";
import type { PhotoCatalog } from "../lib/catalog/types";
import type { NefDecodeRequest, NefDecodeResult } from "./nef-decoder-service";
import type {
  ExportDestinationRequest,
  ExportEncodeOptions,
  ExportFinalizeResult,
  ExportFormatDescriptor,
  ExportPixelPayload,
  ExportResult,
} from "./export-service";
import type {
  ExportOptionsSettings,
  ExportOptionsSettingsInput,
} from "./settings";

interface ScannedFile {
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
}

const darkroom = {
  isElectron: true as const,

  pickFolder(): Promise<{ path: string; name: string } | null> {
    return ipcRenderer.invoke("darkroom:pick-folder");
  },

  scanFolder(rootPath: string): Promise<ScannedFile[]> {
    return ipcRenderer.invoke("darkroom:scan-folder", rootPath);
  },

  readFile(absolutePath: string): Promise<ArrayBuffer> {
    return ipcRenderer.invoke("darkroom:read-file", absolutePath);
  },

  readFileHead(absolutePath: string, maxBytes: number): Promise<ArrayBuffer> {
    return ipcRenderer.invoke("darkroom:read-file-head", absolutePath, maxBytes);
  },

  statFile(absolutePath: string): Promise<{ size: number; lastModified: number }> {
    return ipcRenderer.invoke("darkroom:stat-file", absolutePath);
  },

  decodeNef(request: NefDecodeRequest): Promise<NefDecodeResult> {
    return ipcRenderer.invoke("darkroom:decode-nef", request);
  },

  getLastFolder(): Promise<string | null> {
    return ipcRenderer.invoke("darkroom:get-last-folder");
  },

  setLastFolder(folderPath: string | null): Promise<void> {
    return ipcRenderer.invoke("darkroom:set-last-folder", folderPath);
  },

  folderExists(folderPath: string): Promise<boolean> {
    return ipcRenderer.invoke("darkroom:folder-exists", folderPath);
  },

  readCatalog(rootPath: string): Promise<PhotoCatalog | null> {
    return ipcRenderer.invoke("darkroom:catalog-read", rootPath);
  },

  writeCatalog(catalog: PhotoCatalog): Promise<void> {
    return ipcRenderer.invoke("darkroom:catalog-write", catalog);
  },

  deleteCatalog(rootPath: string): Promise<void> {
    return ipcRenderer.invoke("darkroom:catalog-delete", rootPath);
  },

  deleteFiles(absolutePaths: string[]): Promise<void> {
    return ipcRenderer.invoke("darkroom:delete-files", absolutePaths);
  },

  readSidecar(
    rootPath: string,
    relativePath: string,
  ): Promise<{ contents: string; lastModified: number } | null> {
    return ipcRenderer.invoke("darkroom:read-sidecar", rootPath, relativePath);
  },

  writeSidecar(
    rootPath: string,
    relativePath: string,
    contents: string,
  ): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:write-sidecar",
      rootPath,
      relativePath,
      contents,
    );
  },

  getExportFormats(): Promise<ExportFormatDescriptor[]> {
    return ipcRenderer.invoke("darkroom:get-export-formats");
  },

  chooseExportDestination(
    request: ExportDestinationRequest,
  ): Promise<{ token: string } | null> {
    return ipcRenderer.invoke("darkroom:choose-export-destination", request);
  },

  encodeAndSaveExport(
    token: string,
    basename: string,
    pixels: ArrayBuffer | Uint8Array | ExportPixelPayload,
    options: ExportEncodeOptions,
  ): Promise<ExportResult> {
    return ipcRenderer.invoke(
      "darkroom:encode-and-save-export",
      token,
      basename,
      pixels,
      options,
    );
  },

  finalizeExport(token: string): Promise<ExportFinalizeResult> {
    return ipcRenderer.invoke("darkroom:finalize-export", token);
  },

  getExportOptions(): Promise<ExportOptionsSettings> {
    return ipcRenderer.invoke("darkroom:get-export-options");
  },

  setExportOptions(options: ExportOptionsSettingsInput): Promise<void> {
    return ipcRenderer.invoke("darkroom:set-export-options", options);
  },

  showInFolder(revealToken: string): Promise<void> {
    return ipcRenderer.invoke("darkroom:show-in-folder", revealToken);
  },

  getAiModelState(modelId: AiModelId): Promise<AiModelState> {
    return ipcRenderer.invoke("darkroom:get-ai-model-state", parseAiModelId(modelId));
  },

  downloadAiModel(modelId: AiModelId): Promise<void> {
    return ipcRenderer.invoke("darkroom:download-ai-model", parseAiModelId(modelId));
  },

  cancelAiModelDownload(modelId: AiModelId): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:cancel-ai-model-download",
      parseAiModelId(modelId),
    );
  },

  removeAiModel(modelId: AiModelId): Promise<void> {
    return ipcRenderer.invoke("darkroom:remove-ai-model", parseAiModelId(modelId));
  },

  openAiModelLink(modelId: AiModelId, link: AiModelDisclosureLink): Promise<void> {
    return ipcRenderer.invoke(
      "darkroom:open-ai-model-link",
      parseAiModelId(modelId),
      link,
    );
  },

  onAiModelProgress(
    listener: (progress: AiModelProgress) => void,
  ): Unsubscribe {
    if (typeof listener !== "function") {
      throw new Error("AI model progress listener must be a function.");
    }
    const wrapped = (_event: IpcRendererEvent, value: unknown) => {
      if (isAiModelProgress(value)) {
        listener(value);
      }
    };
    ipcRenderer.on("darkroom:ai-model-progress", wrapped);
    return () => {
      ipcRenderer.removeListener("darkroom:ai-model-progress", wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("darkroom", darkroom);
