export interface ScannedFile {
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
}

export interface CatalogEntryMetadata {
  pick: "none" | "pick" | "reject";
  rating: 0 | 1 | 2 | 3 | 4 | 5;
  colorLabel: "red" | "yellow" | "green" | "blue" | "purple" | null;
  updatedAt: number;
}

export interface PhotoCatalog {
  version: 1;
  rootPath: string;
  entries: Record<string, CatalogEntryMetadata>;
}

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
}

declare global {
  interface Window {
    darkroom?: DarkroomAPI;
  }
}

export {};
