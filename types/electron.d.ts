import type { PhotoCatalog } from "../lib/catalog/types";

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
  saveExport(suggestedName: string, data: ArrayBuffer): Promise<string | null>;
}

declare global {
  interface Window {
    darkroom?: DarkroomAPI;
  }
}

export {};
