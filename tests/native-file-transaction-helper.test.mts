import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNativeFileTransactionFileSystem,
  NativeFileTransactionUnavailableError,
} from "../electron/native-file-transaction-helper.ts";
import { buildFileTransactionHelper } from "../native/file-transaction-helper/build.mjs";

async function temporaryDirectory(): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-native-tx-")));
}

async function buildHelperForTest(t: test.TestContext): Promise<string> {
  const directory = await temporaryDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const executable = await buildFileTransactionHelper(directory);
  if (executable === null) throw new Error("Native helper is unavailable on this platform.");
  return executable;
}

interface HelperResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function runHelper(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
  });
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fsp.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("Native helper pause marker was not created.");
}

test("missing native helper is typed unavailable and never falls back to path mutation", async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationPath = path.join(directory, "destination.jpg");
    await fsp.writeFile(sourcePath, "source");
    const fileSystem = createNativeFileTransactionFileSystem({ helperPath: null });
    await assert.rejects(
      fileSystem.copyFile(sourcePath, destinationPath),
      (error: unknown) => error instanceof NativeFileTransactionUnavailableError &&
        error.message === "Native file transactions are unavailable on this build.",
    );
    await assert.rejects(fsp.lstat(destinationPath));
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("native helper performs fd-relative copy, observe, digest, rename, and remove", { skip: process.platform === "win32" }, async (t) => {
  const executable = await buildHelperForTest(t);
  const directory = await temporaryDirectory();
  try {
    const sourcePath = path.join(directory, "source.jpg");
    const destinationDirectory = path.join(directory, "nested", "output");
    const destinationPath = path.join(destinationDirectory, "photo.jpg");
    const renamedPath = path.join(destinationDirectory, "renamed.jpg");
    await fsp.writeFile(sourcePath, "source");
    let result = await runHelper(executable, ["mkdir", destinationDirectory]);
    assert.equal(result.status, 0, result.stderr.toString());
    result = await runHelper(executable, ["copy", sourcePath, destinationPath]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(await fsp.readFile(destinationPath, "utf8"), "source");
    result = await runHelper(executable, ["observe", destinationPath]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.match(result.stderr.toString(), /^OBS \d+ \d+ \d+ \d+$/m);
    result = await runHelper(executable, ["digest", destinationPath]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), "source");
    assert.match(result.stderr.toString(), /^META \d+ \d+ \d+ \d+$/m);
    result = await runHelper(executable, ["rename", destinationPath, renamedPath]);
    assert.equal(result.status, 0, result.stderr.toString());
    result = await runHelper(executable, ["remove", renamedPath]);
    assert.equal(result.status, 0, result.stderr.toString());
    result = await runHelper(executable, ["exists", renamedPath]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString().trim(), "EXISTS 0");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("native helper keeps a parent-fd rename inside the opened tree after a symlink swap", { skip: process.platform === "win32" }, async (t) => {
  const executable = await buildHelperForTest(t);
  const directory = await temporaryDirectory();
  try {
    const destinationParent = path.join(directory, "destination");
    const displacedParent = path.join(directory, "destination-displaced");
    const outsideParent = path.join(directory, "outside");
    const sourcePath = path.join(destinationParent, "staged.jpg");
    const destinationPath = path.join(destinationParent, "published.jpg");
    const outsideDestinationPath = path.join(outsideParent, "published.jpg");
    const readyPath = path.join(directory, "pause-ready");
    const resumePath = path.join(directory, "pause-resume");
    await fsp.mkdir(destinationParent);
    await fsp.mkdir(outsideParent);
    await fsp.writeFile(sourcePath, "staged");
    const childPromise = runHelper(
      executable,
      ["rename", sourcePath, destinationPath],
      {
        ...process.env,
        DARKROOM_FILE_TRANSACTION_TEST_PAUSE_READY: readyPath,
        DARKROOM_FILE_TRANSACTION_TEST_PAUSE_RESUME: resumePath,
      },
    );
    await waitForFile(readyPath);
    await fsp.rename(destinationParent, displacedParent);
    await fsp.symlink(outsideParent, destinationParent);
    await fsp.writeFile(resumePath, "resume");
    const result = await childPromise;
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(await fsp.readFile(path.join(displacedParent, "published.jpg"), "utf8"), "staged");
    await assert.rejects(fsp.lstat(outsideDestinationPath));
    assert.equal((await fsp.lstat(destinationParent)).isSymbolicLink(), true);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
