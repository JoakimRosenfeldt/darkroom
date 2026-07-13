import { contextBridge, ipcRenderer } from "electron";
import type { PhotoCatalog } from "../lib/catalog/types";
import type { NefDecodeRequest, NefDecodeResult } from "./nef-decoder-service";

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

  saveExport(suggestedName: string, data: ArrayBuffer): Promise<string | null> {
    return ipcRenderer.invoke("darkroom:save-export", suggestedName, data);
  },
};

contextBridge.exposeInMainWorld("darkroom", darkroom);
