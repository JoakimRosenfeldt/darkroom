import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const electronDir = path.join(rootDir, "node_modules", "electron");

function getPlatformPaths() {
  switch (process.platform) {
    case "darwin":
      return {
        relativePath: "Electron.app/Contents/MacOS/Electron",
        frameworkPath: "Electron.app/Contents/Frameworks/Electron Framework.framework",
      };
    case "win32":
      return {
        relativePath: "electron.exe",
        frameworkPath: null,
      };
    default:
      return {
        relativePath: "electron",
        frameworkPath: null,
      };
  }
}

function isElectronInstallValid() {
  if (!fs.existsSync(electronDir)) {
    return false;
  }

  const { relativePath, frameworkPath } = getPlatformPaths();
  const distDir = path.join(electronDir, "dist");
  const executablePath = path.join(distDir, relativePath);
  const pathFile = path.join(electronDir, "path.txt");

  if (!fs.existsSync(executablePath)) {
    return false;
  }

  if (frameworkPath && !fs.existsSync(path.join(distDir, frameworkPath))) {
    return false;
  }

  if (!fs.existsSync(pathFile)) {
    return false;
  }

  return fs.readFileSync(pathFile, "utf8").trim() === relativePath;
}

function wipeElectronDist() {
  const distDir = path.join(electronDir, "dist");
  const pathFile = path.join(electronDir, "path.txt");

  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }

  if (fs.existsSync(pathFile)) {
    fs.rmSync(pathFile, { force: true });
  }
}

function extractZip(zipPath, distDir) {
  const absoluteDist = path.resolve(distDir);
  fs.mkdirSync(absoluteDist, { recursive: true });

  if (process.platform === "win32") {
    const extract = require("extract-zip");
    return extract(zipPath, { dir: absoluteDist });
  }

  const result = spawnSync("unzip", ["-q", zipPath, "-d", absoluteDist], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`unzip failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function downloadAndInstallElectron() {
  const { downloadArtifact } = require("@electron/get");
  const { version } = require(path.join(electronDir, "package.json"));
  const distDir = path.join(electronDir, "dist");

  console.log(`downloading electron ${version} for ${process.platform}-${process.arch}...`);

  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
    force: true,
  });

  wipeElectronDist();
  await extractZip(zipPath, distDir);

  const { relativePath } = getPlatformPaths();
  fs.writeFileSync(path.join(electronDir, "path.txt"), relativePath);
}

async function main() {
  if (!fs.existsSync(electronDir)) {
    return;
  }

  if (isElectronInstallValid()) {
    console.log("electron binary is ready");
    return;
  }

  console.log("electron install is missing or incomplete — reinstalling...");
  await downloadAndInstallElectron();

  if (!isElectronInstallValid()) {
    console.error(
      [
        "Electron failed to install correctly.",
        "Try:",
        "  rm -rf node_modules/electron",
        "  npm install",
        "",
        "If npm cache permissions are broken, run:",
        "  sudo chown -R $(whoami) ~/.npm",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log("electron binary installed successfully");
}

await main();
