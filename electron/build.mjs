import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const outDir = path.join(rootDir, "electron-dist");

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
};

await esbuild.build({
  ...shared,
  entryPoints: [path.join(rootDir, "electron/main.ts")],
  outfile: path.join(outDir, "main.js"),
  format: "cjs",
});

await esbuild.build({
  ...shared,
  entryPoints: [path.join(rootDir, "electron/preload.ts")],
  outfile: path.join(outDir, "preload.js"),
  format: "cjs",
});

console.log("Built Electron main and preload to electron-dist/");
