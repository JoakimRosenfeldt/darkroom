export interface ScannedFile {
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
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
}

declare global {
  interface Window {
    darkroom?: DarkroomAPI;
  }
}

export {};
