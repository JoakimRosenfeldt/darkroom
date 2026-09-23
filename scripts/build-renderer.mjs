import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";

const root = process.cwd();
const output = path.join(root, "out");
const stage = await fs.mkdtemp(path.join(os.tmpdir(), "darkroom-renderer-"));

async function stat(pathname) {
  try {
    return await fs.lstat(pathname);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function validateStage(directory) {
  for (const name of await fs.readdir(directory)) {
    const pathname = path.join(directory, name);
    const info = await fs.lstat(pathname);
    if (info.isDirectory()) await validateStage(pathname);
    else if (!info.isFile()) throw new Error(`Vite output contains a non-file: ${pathname}`);
  }
}

async function sameFile(source, target, sourceInfo, targetInfo) {
  if (!targetInfo?.isFile() || sourceInfo.size !== targetInfo.size) return false;
  const [left, right] = await Promise.all([fs.readFile(source), fs.readFile(target)]);
  return left.equals(right);
}

async function syncDirectory(source, target) {
  const sourceNames = await fs.readdir(source);
  const targetNames = new Set(await fs.readdir(target));
  for (const name of sourceNames) {
    targetNames.delete(name);
    const from = path.join(source, name);
    const to = path.join(target, name);
    const sourceInfo = await fs.lstat(from);
    const targetInfo = await stat(to);
    if (sourceInfo.isDirectory()) {
      if (!targetInfo?.isDirectory()) {
        if (targetInfo) await fs.rm(to, { recursive: true, force: true });
        await fs.mkdir(to);
      }
      await syncDirectory(from, to);
    } else if (sourceInfo.isFile()) {
      if (await sameFile(from, to, sourceInfo, targetInfo)) continue;
      const temporary = path.join(target, `.${name}.${randomUUID()}.tmp`);
      try {
        await fs.copyFile(from, temporary, constants.COPYFILE_EXCL);
        if (targetInfo && !targetInfo.isFile()) await fs.rm(to, { recursive: true, force: true });
        try {
          await fs.rename(temporary, to);
        } catch (error) {
          if (!targetInfo?.isFile() || !["EEXIST", "EPERM"].includes(error.code)) throw error;
          await fs.rm(to, { force: true });
          await fs.rename(temporary, to);
        }
      } finally {
        await fs.rm(temporary, { force: true });
      }
    } else {
      throw new Error(`Vite output contains a non-file: ${from}`);
    }
  }
  for (const name of targetNames) {
    await fs.rm(path.join(target, name), { recursive: true, force: true });
  }
}

try {
  await build({ root, build: { outDir: stage, emptyOutDir: true } });
  if (!(await fs.lstat(stage)).isDirectory()) throw new Error(`Vite output is not a directory: ${stage}`);
  await validateStage(stage);
  const outputInfo = await stat(output);
  if (outputInfo && !outputInfo.isDirectory()) throw new Error(`Renderer output is not a directory: ${output}`);
  if (!outputInfo) await fs.mkdir(output);
  await syncDirectory(stage, output);
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
