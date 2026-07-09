import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  folderExists,
  getFolderName,
  readFileBuffer,
  readFileHead,
  scanFolderTree,
  statFile,
  trashFiles,
} from "./fs-service";
import { createCatalogStore } from "./catalog-store";
import { createSettingsStore } from "./settings";
import { getAppRoot, getOutDir, startStaticServer } from "./static-server";

const isDev = process.env.ELECTRON_DEV === "1" || !app.isPackaged;
const DEV_SERVER_URL = process.env.DARKROOM_DEV_URL ?? "http://localhost:3000";

let mainWindow: BrowserWindow | null = null;
let staticServerPort: number | null = null;

const settingsStore = createSettingsStore(app.getPath("userData"));
const catalogStore = createCatalogStore(app.getPath("userData"));

function resolveLibraryFile(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Sidecar path must stay inside the active library.");
  }

  return absolute;
}

function getSidecarPath(rootPath: string, relativePath: string): string {
  const source = resolveLibraryFile(rootPath, relativePath);
  const parsed = path.parse(source);
  const isRaw = parsed.ext.toLowerCase() === ".nef";
  return path.join(
    parsed.dir,
    isRaw ? `${parsed.name}.xmp` : `${parsed.base}.xmp`,
  );
}

async function assertRegularSidecar(sidecarPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(sidecarPath);
    if (stat.isSymbolicLink()) {
      throw new Error("Refusing to follow a symbolic-link XMP sidecar.");
    }
    if (!stat.isFile()) {
      throw new Error("XMP sidecar is not a regular file.");
    }
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function writeSidecarAtomically(
  sidecarPath: string,
  contents: string,
): Promise<void> {
  await assertRegularSidecar(sidecarPath);
  const temporaryPath = path.join(
    path.dirname(sidecarPath),
    `.${path.basename(sidecarPath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, sidecarPath);
  } finally {
    await fs.unlink(temporaryPath).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    });
  }
}

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

  ipcMain.handle(
    "darkroom:read-file-head",
    async (_event, absolutePath: string, maxBytes: number) => {
      const buffer = await readFileHead(absolutePath, maxBytes);
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
    },
  );

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

  ipcMain.handle("darkroom:catalog-read", async (_event, rootPath: string) => {
    return catalogStore.read(rootPath);
  });

  ipcMain.handle("darkroom:catalog-write", async (_event, catalog) => {
    await catalogStore.write(catalog);
  });

  ipcMain.handle("darkroom:catalog-delete", async (_event, rootPath: string) => {
    await catalogStore.remove(rootPath);
  });

  ipcMain.handle(
    "darkroom:delete-files",
    async (_event, absolutePaths: string[]) => {
      await trashFiles(absolutePaths);
    },
  );

  ipcMain.handle(
    "darkroom:read-sidecar",
    async (_event, rootPath: string, relativePath: string) => {
      const sidecarPath = getSidecarPath(rootPath, relativePath);
      try {
        const exists = await assertRegularSidecar(sidecarPath);
        if (!exists) {
          return null;
        }
        const [contents, stat] = await Promise.all([
          fs.readFile(sidecarPath, "utf8"),
          fs.lstat(sidecarPath),
        ]);
        return { contents, lastModified: stat.mtimeMs };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      }
    },
  );

  ipcMain.handle(
    "darkroom:write-sidecar",
    async (
      _event,
      rootPath: string,
      relativePath: string,
      contents: string | null,
    ) => {
      const sidecarPath = getSidecarPath(rootPath, relativePath);
      if (contents === null) {
        try {
          const exists = await assertRegularSidecar(sidecarPath);
          if (!exists) {
            return;
          }
          await fs.unlink(sidecarPath);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return;
          }
          throw error;
        }
        return;
      }

      await writeSidecarAtomically(sidecarPath, contents);
    },
  );

  ipcMain.handle(
    "darkroom:save-export",
    async (_event, suggestedName: string, data: ArrayBuffer) => {
      const result = await dialog.showSaveDialog({
        title: "Export edited photo",
        defaultPath: suggestedName,
        filters: [{ name: "JPEG", extensions: ["jpg", "jpeg"] }],
      });

      if (result.canceled || !result.filePath) {
        return null;
      }

      await fs.writeFile(result.filePath, Buffer.from(new Uint8Array(data)));
      return result.filePath;
    },
  );
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
