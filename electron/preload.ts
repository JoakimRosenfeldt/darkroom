import { contextBridge, ipcRenderer } from "electron";

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

  getLastFolder(): Promise<string | null> {
    return ipcRenderer.invoke("darkroom:get-last-folder");
  },

  setLastFolder(folderPath: string | null): Promise<void> {
    return ipcRenderer.invoke("darkroom:set-last-folder", folderPath);
  },

  folderExists(folderPath: string): Promise<boolean> {
    return ipcRenderer.invoke("darkroom:folder-exists", folderPath);
  },
};

contextBridge.exposeInMainWorld("darkroom", darkroom);
