import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(sourceDirectory, "file-transaction-helper.c");

function helperName() {
  const suffix = `${process.platform}-${process.arch}`;
  return process.platform === "win32"
    ? `file-transaction-helper-${suffix}.exe`
    : `file-transaction-helper-${suffix}`;
}

export async function buildFileTransactionHelper(outputDirectory) {
  if (process.platform === "win32") {
    return null;
  }

  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, helperName());
  const compiler = process.env.CC ?? (process.platform === "darwin" ? "clang" : "cc");
  const result = spawnSync(compiler, [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    outputPath,
    sourcePath,
  ], {
    cwd: sourceDirectory,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${compiler} failed to build the file transaction helper.`);
  }
  await chmod(outputPath, 0o755);
  return outputPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outputArgument = process.argv[2];
  const outputDirectory = outputArgument ?? path.resolve(sourceDirectory, "..", "..", "electron-dist");
  if (!path.isAbsolute(outputDirectory)) {
    throw new Error("The file transaction helper output directory must be absolute.");
  }
  const outputPath = await buildFileTransactionHelper(outputDirectory);
  if (outputPath) console.log(`Built native file transaction helper at ${outputPath}`);
  else console.log("Native file transaction helper is unavailable on Windows.");
}
