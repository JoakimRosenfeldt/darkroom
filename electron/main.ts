import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import {
  folderExists,
  getFolderName,
  readFileBuffer,
  scanFolderTree,
  statFile,
} from "./fs-service";
import { createSettingsStore } from "./settings";
import { getAppRoot, getOutDir, startStaticServer } from "./static-server";

const isDev = process.env.ELECTRON_DEV === "1" || !app.isPackaged;
const DEV_SERVER_URL = process.env.DARKROOM_DEV_URL ?? "http://localhost:3000";

let mainWindow: BrowserWindow | null = null;
let staticServerPort: number | null = null;

const settingsStore = createSettingsStore(app.getPath("userData"));

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

async function loadWindow(window: BrowserWindow): Promise<void> {
  if (isDev) {
    await window.loadURL(DEV_SERVER_URL);
    window.webContents.openDevTools({ mode: "detach" });
    return;
  }

  const outDir = getOutDir(getAppRoot());
  staticServerPort ??= await startStaticServer(outDir);
  await window.loadURL(`http://127.0.0.1:${staticServerPort}`);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Darkroom",
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await loadWindow(mainWindow);
}

function registerIpcHandlers(): void {
  ipcMain.handle("darkroom:pick-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select photo folder",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const folderPath = result.filePaths[0]!;
    return {
      path: folderPath,
      name: getFolderName(folderPath),
    };
  });

  ipcMain.handle("darkroom:scan-folder", async (_event, rootPath: string) => {
    return scanFolderTree(rootPath);
  });

  ipcMain.handle("darkroom:read-file", async (_event, absolutePath: string) => {
    const buffer = await readFileBuffer(absolutePath);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
  });

  ipcMain.handle("darkroom:stat-file", async (_event, absolutePath: string) => {
    return statFile(absolutePath);
  });

  ipcMain.handle("darkroom:get-last-folder", async () => {
    return settingsStore.getLastFolder();
  });

  ipcMain.handle("darkroom:set-last-folder", async (_event, folderPath: string | null) => {
    await settingsStore.setLastFolder(folderPath);
  });

  ipcMain.handle("darkroom:folder-exists", async (_event, folderPath: string) => {
    return folderExists(folderPath);
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
