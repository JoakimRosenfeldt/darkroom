import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
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
import {
  createNefDecoderService,
  type NefDecodeRequest,
  type NefDecoderCommand,
} from "./nef-decoder-service";
import { createSettingsStore } from "./settings";
import { getAppRoot, getOutDir, startStaticServer } from "./static-server";

const isDev = process.env.ELECTRON_DEV === "1" || !app.isPackaged;
const DEV_SERVER_URL = process.env.DARKROOM_DEV_URL ?? "http://localhost:3000";

let mainWindow: BrowserWindow | null = null;
let staticServerPort: number | null = null;
let activeLibraryRoot: string | null = null;

const settingsStore = createSettingsStore(app.getPath("userData"));
const catalogStore = createCatalogStore(app.getPath("userData"));
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;

function getNefDecoderCommand(): NefDecoderCommand | null {
  const privateHelper = process.env.DARKROOM_NEF_HELPER_PATH;
  if (!app.isPackaged && privateHelper && path.isAbsolute(privateHelper)) {
    return { executable: privateHelper };
  }
  if (!app.isPackaged && process.env.DARKROOM_ENABLE_NEF_MOCK === "1") {
    return {
      executable: process.execPath,
      fixedArgs: [path.join(app.getAppPath(), "native/nikon-nef-decoder/mock-decoder.mjs")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  if (process.platform !== "darwin" && process.platform !== "win32") return null;
  return {
    executable: path.join(
      process.resourcesPath,
      "nikon-nef-decoder",
      process.platform === "win32" ? "nikon-nef-decoder.exe" : "nikon-nef-decoder",
    ),
  };
}

async function activateLibraryRoot(rootPath: string): Promise<string> {
  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) {
    throw new Error("Library root must be a directory.");
  }
  const root = await fs.realpath(rootPath);
  activeLibraryRoot = root;
  return root;
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (event.sender !== mainWindow?.webContents) {
    throw new Error("Desktop API is only available to the main Darkroom window.");
  }
  if (!event.senderFrame) {
    throw new Error("Desktop API request has no renderer frame.");
  }

  const expectedOrigin = isDev
    ? new URL(DEV_SERVER_URL).origin
    : `http://127.0.0.1:${staticServerPort}`;
  if (new URL(event.senderFrame.url).origin !== expectedOrigin) {
    throw new Error("Desktop API request came from an untrusted origin.");
  }
}

async function resolveLibraryFile(
  event: IpcMainInvokeEvent,
  rootPath: string,
  relativePath: string,
): Promise<string> {
  assertTrustedRenderer(event);
  if (!activeLibraryRoot) {
    throw new Error("No approved library folder is open.");
  }

  const requestedRoot = await fs.realpath(rootPath);
  if (requestedRoot !== activeLibraryRoot) {
    throw new Error("Sidecar path must use the active library.");
  }

  const absolute = path.resolve(activeLibraryRoot, relativePath);
  const relative = path.relative(activeLibraryRoot, absolute);

  if (
    !relativePath ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Sidecar path must stay inside the active library.");
  }

  const directory = await fs.realpath(path.dirname(absolute));
  const directoryRelative = path.relative(activeLibraryRoot, directory);
  if (
    directoryRelative === ".." ||
    directoryRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(directoryRelative)
  ) {
    throw new Error("Sidecar path cannot follow a symlink outside the library.");
  }

  return path.join(directory, path.basename(absolute));
}

async function getSidecarPath(
  event: IpcMainInvokeEvent,
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const source = await resolveLibraryFile(event, rootPath, relativePath);
  const parsed = path.parse(source);
  return path.join(
    parsed.dir,
    parsed.ext.toLowerCase() === ".nef"
      ? `${parsed.name}.xmp`
      : `${parsed.base}.xmp`,
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

async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  await assertRegularSidecar(filePath);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, "utf8");
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
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
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const expectedOrigin = isDev
      ? new URL(DEV_SERVER_URL).origin
      : `http://127.0.0.1:${staticServerPort}`;
    if (new URL(url).origin !== expectedOrigin) {
      event.preventDefault();
    }
  });

  await loadWindow(mainWindow);
}

function registerIpcHandlers(): void {
  const nefDecoder = createNefDecoderService({
    helper: getNefDecoderCommand(),
    tempRoot: app.getPath("temp"),
  });

  ipcMain.handle("darkroom:pick-folder", async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select photo folder",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const folderPath = await activateLibraryRoot(result.filePaths[0]!);
    return {
      path: folderPath,
      name: getFolderName(folderPath),
    };
  });

  ipcMain.handle("darkroom:scan-folder", async (event, rootPath: string) => {
    assertTrustedRenderer(event);
    return scanFolderTree(rootPath);
  });

  ipcMain.handle("darkroom:read-file", async (event, absolutePath: string) => {
    assertTrustedRenderer(event);
    const buffer = await readFileBuffer(absolutePath);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
  });

  ipcMain.handle(
    "darkroom:read-file-head",
    async (event, absolutePath: string, maxBytes: number) => {
      assertTrustedRenderer(event);
      const buffer = await readFileHead(absolutePath, maxBytes);
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
    },
  );

  ipcMain.handle("darkroom:stat-file", async (event, absolutePath: string) => {
    assertTrustedRenderer(event);
    return statFile(absolutePath);
  });

  ipcMain.handle(
    "darkroom:decode-nef",
    async (event, request: NefDecodeRequest) => {
      assertTrustedRenderer(event);
      return nefDecoder.decode(activeLibraryRoot, request);
    },
  );

  ipcMain.handle("darkroom:get-last-folder", async (event) => {
    assertTrustedRenderer(event);
    const folderPath = await settingsStore.getLastFolder();
    if (folderPath) {
      try {
        await activateLibraryRoot(folderPath);
      } catch {
        activeLibraryRoot = null;
      }
    }
    return folderPath;
  });

  ipcMain.handle("darkroom:set-last-folder", async (event, folderPath: string | null) => {
    assertTrustedRenderer(event);
    if (folderPath) {
      const requestedRoot = await fs.realpath(folderPath);
      if (requestedRoot !== activeLibraryRoot) {
        throw new Error("Library folder was not selected through Darkroom.");
      }
    } else {
      activeLibraryRoot = null;
    }
    await settingsStore.setLastFolder(folderPath);
  });

  ipcMain.handle("darkroom:folder-exists", async (event, folderPath: string) => {
    assertTrustedRenderer(event);
    return folderExists(folderPath);
  });

  ipcMain.handle("darkroom:catalog-read", async (event, rootPath: string) => {
    assertTrustedRenderer(event);
    return catalogStore.read(rootPath);
  });

  ipcMain.handle("darkroom:catalog-write", async (event, catalog) => {
    assertTrustedRenderer(event);
    await catalogStore.write(catalog);
  });

  ipcMain.handle("darkroom:catalog-delete", async (event, rootPath: string) => {
    assertTrustedRenderer(event);
    await catalogStore.remove(rootPath);
  });

  ipcMain.handle(
    "darkroom:delete-files",
    async (event, absolutePaths: string[]) => {
      assertTrustedRenderer(event);
      await trashFiles(absolutePaths);
    },
  );

  ipcMain.handle(
    "darkroom:read-sidecar",
    async (event, rootPath: string, relativePath: string) => {
      const sidecarPath = await getSidecarPath(event, rootPath, relativePath);
      try {
        if (!await assertRegularSidecar(sidecarPath)) {
          return null;
        }
        const stat = await fs.lstat(sidecarPath);
        if (stat.size > MAX_SIDECAR_BYTES) {
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
      contents: string | null,
    ) => {
      const sidecarPath = await getSidecarPath(event, rootPath, relativePath);
      if (contents === null) {
        try {
          if (!await assertRegularSidecar(sidecarPath)) {
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

      await writeFileAtomically(sidecarPath, contents);
    },
  );

  ipcMain.handle(
    "darkroom:save-export",
    async (event, suggestedName: string, data: ArrayBuffer) => {
      assertTrustedRenderer(event);
      if (data.byteLength > 512 * 1024 * 1024) {
        throw new Error("Export is too large.");
      }
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
