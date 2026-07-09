import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
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
let trustedOrigin: string | null = null;
let activeLibraryRoot: string | null = null;

const settingsStore = createSettingsStore(app.getPath("userData"));
const catalogStore = createCatalogStore(app.getPath("userData"));
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;

function assertTrustedIpc(event: IpcMainInvokeEvent): void {
  if (
    event.sender !== mainWindow?.webContents ||
    !trustedOrigin ||
    !event.senderFrame ||
    new URL(event.senderFrame.url).origin !== trustedOrigin
  ) {
    throw new Error("Darkroom IPC request came from an untrusted renderer.");
  }
}

async function setActiveLibraryRoot(rootPath: string): Promise<void> {
  const root = await fs.realpath(rootPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("Active library root must be a directory.");
  }
  activeLibraryRoot = root;
}

async function resolveLibraryFile(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const root = await fs.realpath(rootPath);
  if (root !== activeLibraryRoot) {
    throw new Error("Sidecar path must use the active library.");
  }
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Sidecar path must name a library file.");
  }

  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);

  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Sidecar path must stay inside the active library.");
  }

  const source = await fs.realpath(absolute);
  const sourceRelative = path.relative(root, source);
  if (
    sourceRelative === ".." ||
    sourceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(sourceRelative)
  ) {
    throw new Error("Sidecar source resolves outside the active library.");
  }

  return source;
}

async function getSidecarPath(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const source = await resolveLibraryFile(rootPath, relativePath);
  const parsed = path.parse(source);
  return path.join(parsed.dir, `${parsed.name}.xmp`);
}

async function writeSidecarAtomically(
  sidecarPath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(sidecarPath),
    `.${path.basename(sidecarPath)}.${randomUUID()}.tmp`,
  );

  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, sidecarPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

async function loadWindow(window: BrowserWindow): Promise<void> {
  let windowUrl: string;
  if (isDev) {
    windowUrl = DEV_SERVER_URL;
    trustedOrigin = new URL(windowUrl).origin;
    await window.loadURL(windowUrl);
    window.webContents.openDevTools({ mode: "detach" });
    return;
  }

  const outDir = getOutDir(getAppRoot());
  staticServerPort ??= await startStaticServer(outDir);
  windowUrl = `http://127.0.0.1:${staticServerPort}`;
  trustedOrigin = new URL(windowUrl).origin;
  await window.loadURL(windowUrl);
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
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!trustedOrigin || new URL(url).origin !== trustedOrigin) {
      event.preventDefault();
    }
  });

  await loadWindow(mainWindow);
}

function registerIpcHandlers(): void {
  ipcMain.handle("darkroom:pick-folder", async (event) => {
    assertTrustedIpc(event);
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

  ipcMain.handle("darkroom:scan-folder", async (event, rootPath: string) => {
    assertTrustedIpc(event);
    const files = await scanFolderTree(rootPath);
    await setActiveLibraryRoot(rootPath);
    return files;
  });

  ipcMain.handle("darkroom:read-file", async (event, absolutePath: string) => {
    assertTrustedIpc(event);
    const buffer = await readFileBuffer(absolutePath);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
  });

  ipcMain.handle(
    "darkroom:read-file-head",
    async (event, absolutePath: string, maxBytes: number) => {
      assertTrustedIpc(event);
      const buffer = await readFileHead(absolutePath, maxBytes);
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
    },
  );

  ipcMain.handle("darkroom:stat-file", async (event, absolutePath: string) => {
    assertTrustedIpc(event);
    return statFile(absolutePath);
  });

  ipcMain.handle("darkroom:get-last-folder", async (event) => {
    assertTrustedIpc(event);
    return settingsStore.getLastFolder();
  });

  ipcMain.handle("darkroom:set-last-folder", async (event, folderPath: string | null) => {
    assertTrustedIpc(event);
    await settingsStore.setLastFolder(folderPath);
  });

  ipcMain.handle("darkroom:folder-exists", async (event, folderPath: string) => {
    assertTrustedIpc(event);
    return folderExists(folderPath);
  });

  ipcMain.handle("darkroom:catalog-read", async (event, rootPath: string) => {
    assertTrustedIpc(event);
    return catalogStore.read(rootPath);
  });

  ipcMain.handle("darkroom:catalog-write", async (event, catalog) => {
    assertTrustedIpc(event);
    await catalogStore.write(catalog);
  });

  ipcMain.handle("darkroom:catalog-delete", async (event, rootPath: string) => {
    assertTrustedIpc(event);
    await catalogStore.remove(rootPath);
  });

  ipcMain.handle(
    "darkroom:delete-files",
    async (event, absolutePaths: string[]) => {
      assertTrustedIpc(event);
      await trashFiles(absolutePaths);
    },
  );

  ipcMain.handle(
    "darkroom:read-sidecar",
    async (event, rootPath: string, relativePath: string) => {
      assertTrustedIpc(event);
      const sidecarPath = await getSidecarPath(rootPath, relativePath);
      try {
        const stat = await fs.stat(sidecarPath);
        if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES) {
          throw new Error("XMP sidecar is not a supported file size.");
        }
        const contents = await fs.readFile(sidecarPath, "utf8");
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
      event,
      rootPath: string,
      relativePath: string,
      contents: string,
    ) => {
      assertTrustedIpc(event);
      const sidecarPath = await getSidecarPath(rootPath, relativePath);
      await writeSidecarAtomically(sidecarPath, contents);
    },
  );

  ipcMain.handle(
    "darkroom:save-export",
    async (event, suggestedName: string, data: ArrayBuffer) => {
      assertTrustedIpc(event);
      const result = await dialog.showSaveDialog({
        title: "Export edited photo",
        defaultPath: path.basename(suggestedName),
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
