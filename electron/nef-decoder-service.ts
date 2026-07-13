import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const PREVIEW_MAX_EDGE = 2560;
const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_DIMENSION = 65_535;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

export interface NefDecodeRequest {
  relativePath: string;
  mode: "preview" | "full";
  maxEdge: number;
}

export type NefDecodeErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_FILE"
  | "INPUT_IO"
  | "DECODE_FAILED"
  | "OUTPUT_IO"
  | "LIMIT_EXCEEDED"
  | "SDK_UNAVAILABLE"
  | "INTERNAL"
  | "TIMEOUT"
  | "HELPER_CRASH"
  | "INVALID_OUTPUT";

export interface NefDecodeFailure {
  available: false;
  code: NefDecodeErrorCode;
  message: string;
}

export interface NefDecodeSuccess {
  available: true;
  version: 1;
  width: number;
  height: number;
  channels: 3;
  bitDepth: 16;
  byteCount: number;
  pixelFormat: "rgb16le";
  orientation: number;
  colorSpace: "srgb";
  transferFunction: "srgb";
  pixels: ArrayBuffer;
}

export type NefDecodeResult = NefDecodeSuccess | NefDecodeFailure;

export interface NefDecoderCommand {
  executable: string;
  fixedArgs?: readonly string[];
  env?: Record<string, string>;
}

interface NefDecoderServiceOptions {
  helper: NefDecoderCommand | null;
  tempRoot: string;
  timeoutMs?: number;
}

class DecodeError extends Error {
  readonly code: NefDecodeErrorCode;

  constructor(code: NefDecodeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateRequest(request: unknown): NefDecodeRequest {
  if (!request || typeof request !== "object") {
    throw new DecodeError("INVALID_ARGUMENT", "Invalid Nikon decode request.");
  }
  const { relativePath, mode, maxEdge } = request as Partial<NefDecodeRequest>;
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]+/).includes("..")
  ) {
    throw new DecodeError("INVALID_ARGUMENT", "NEF path must be relative to the active library.");
  }
  if (!/\.nef$/i.test(relativePath)) {
    throw new DecodeError("UNSUPPORTED_FILE", "Nikon fallback accepts only NEF files.");
  }
  if (mode !== "preview" && mode !== "full") {
    throw new DecodeError("INVALID_ARGUMENT", "Decode mode must be preview or full.");
  }
  if (typeof maxEdge !== "number" || !Number.isSafeInteger(maxEdge) || maxEdge <= 0) {
    throw new DecodeError("INVALID_ARGUMENT", "Maximum edge must be a positive integer.");
  }
  return { relativePath, mode, maxEdge: Math.min(maxEdge, PREVIEW_MAX_EDGE) };
}

async function snapshotInput(
  root: string,
  relativePath: string,
  snapshotPath: string,
): Promise<void> {
  let realRoot: string;
  let input: string;
  let inputIdentity: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    realRoot = await fs.realpath(root);
    input = await fs.realpath(path.resolve(realRoot, relativePath));
    inputIdentity = await fs.lstat(input);
  } catch {
    throw new DecodeError("INPUT_IO", "NEF file is unavailable.");
  }
  if (!isInside(realRoot, input)) {
    throw new DecodeError("INVALID_ARGUMENT", "NEF path cannot follow a symlink outside the library.");
  }
  if (!inputIdentity.isFile() || inputIdentity.isSymbolicLink()) {
    throw new DecodeError("INPUT_IO", "NEF input must be a regular file.");
  }
  if (inputIdentity.size > MAX_INPUT_BYTES) {
    throw new DecodeError("LIMIT_EXCEEDED", "NEF input exceeds the supported size.");
  }

  let source;
  try {
    source = await fs.open(input, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new DecodeError("INPUT_IO", "NEF file is unavailable.");
  }

  try {
    const stat = await source.stat();
    if (
      !stat.isFile() ||
      stat.dev !== inputIdentity.dev ||
      stat.ino !== inputIdentity.ino ||
      stat.size !== inputIdentity.size
    ) {
      throw new DecodeError("INPUT_IO", "NEF file changed while it was being opened.");
    }

    const target = await fs.open(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          Math.min(buffer.byteLength, stat.size - offset),
          offset,
        );
        if (bytesRead === 0) {
          throw new DecodeError("INPUT_IO", "NEF file changed while it was being copied.");
        }
        let written = 0;
        while (written < bytesRead) {
          const result = await target.write(buffer, written, bytesRead - written, offset + written);
          if (result.bytesWritten === 0) {
            throw new DecodeError("OUTPUT_IO", "Could not create the private NEF snapshot.");
          }
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      await target.sync();
    } finally {
      await target.close();
    }

    const after = await source.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new DecodeError("INPUT_IO", "NEF file changed while it was being copied.");
    }
    await fs.chmod(snapshotPath, 0o400);
  } finally {
    await source.close();
  }
}

async function assertHelper(command: NefDecoderCommand): Promise<void> {
  const stat = await fs.lstat(command.executable).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new DecodeError("SDK_UNAVAILABLE", "Nikon decoder is not installed.");
  }
  if (process.platform !== "win32") {
    await fs.access(command.executable, constants.X_OK).catch(() => {
      throw new DecodeError("SDK_UNAVAILABLE", "Nikon decoder is not executable.");
    });
  }
}

function runHelper(
  command: NefDecoderCommand,
  input: string,
  output: string,
  request: NefDecodeRequest,
  timeoutMs: number,
): Promise<void> {
  const args = [
    ...(command.fixedArgs ?? []),
    "--input", input,
    "--output", output,
    "--mode", request.mode,
    "--max-edge", String(request.maxEdge),
    "--pixel-format", "rgb16le",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      cwd: output,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        ...(process.platform === "win32" && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        ...(process.platform === "win32" && process.env.WINDIR
          ? { WINDIR: process.env.WINDIR }
          : {}),
        ...command.env,
      },
    });
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let killDeadline: NodeJS.Timeout | undefined;

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength >= MAX_STDERR_BYTES) return;
      stderr = Buffer.concat([stderr, chunk.subarray(0, MAX_STDERR_BYTES - stderr.byteLength)]);
    });

    const finish = (error?: DecodeError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killDeadline) clearTimeout(killDeadline);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      killDeadline = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);
    }, timeoutMs);

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(new DecodeError(
        error.code === "ENOENT" ? "SDK_UNAVAILABLE" : "HELPER_CRASH",
        error.code === "ENOENT" ? "Nikon decoder is not installed." : "Nikon decoder could not start.",
      ));
    });
    child.once("close", (code) => {
      if (timedOut) {
        finish(new DecodeError("TIMEOUT", "Nikon decoder timed out."));
      } else if (code === 0) {
        finish();
      } else {
        finish(helperFailure(stderr.toString("utf8")));
      }
    });
  });
}

function helperFailure(stderr: string): DecodeError {
  const helperCodes = new Set<NefDecodeErrorCode>([
    "INVALID_ARGUMENT", "UNSUPPORTED_FILE", "INPUT_IO", "DECODE_FAILED",
    "OUTPUT_IO", "LIMIT_EXCEEDED", "SDK_UNAVAILABLE", "INTERNAL",
  ]);
  try {
    const parsed = JSON.parse(stderr.trim()) as { version?: unknown; code?: unknown; message?: unknown };
    if (
      parsed.version === 1 &&
      typeof parsed.code === "string" &&
      helperCodes.has(parsed.code as NefDecodeErrorCode) &&
      typeof parsed.message === "string"
    ) {
      return new DecodeError(parsed.code as NefDecodeErrorCode, `Nikon decoder reported ${parsed.code}.`);
    }
  } catch {
    // Stderr is diagnostic only; malformed output becomes a generic crash.
  }
  return new DecodeError("HELPER_CRASH", "Nikon decoder failed.");
}

async function readOutput(
  output: string,
  request: NefDecodeRequest,
  outputIdentity: { dev: number; ino: number },
): Promise<NefDecodeSuccess> {
  const outputStat = await fs.lstat(output);
  if (
    !outputStat.isDirectory() ||
    outputStat.isSymbolicLink() ||
    outputStat.dev !== outputIdentity.dev ||
    outputStat.ino !== outputIdentity.ino
  ) {
    throw new DecodeError("INVALID_OUTPUT", "Nikon decoder replaced its private output directory.");
  }
  const names = (await fs.readdir(output)).sort();
  if (names.length !== 2 || names[0] !== "pixels.bin" || names[1] !== "result.json") {
    throw new DecodeError("INVALID_OUTPUT", "Nikon decoder produced unexpected files.");
  }

  const resultPath = path.join(output, "result.json");
  const pixelsPath = path.join(output, "pixels.bin");
  const [resultStat, pixelsStat] = await Promise.all([fs.lstat(resultPath), fs.lstat(pixelsPath)]);
  if (
    !resultStat.isFile() || resultStat.isSymbolicLink() ||
    !pixelsStat.isFile() || pixelsStat.isSymbolicLink()
  ) {
    throw new DecodeError("INVALID_OUTPUT", "Nikon decoder output must be regular files.");
  }
  if (resultStat.size <= 0 || resultStat.size > MAX_RESULT_BYTES) {
    throw new DecodeError("INVALID_OUTPUT", "Nikon decoder metadata has an invalid size.");
  }

  let resultFile;
  let pixelsFile;
  try {
    resultFile = await fs.open(resultPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    pixelsFile = await fs.open(pixelsPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    await Promise.allSettled([resultFile?.close(), pixelsFile?.close()]);
    throw new DecodeError("INVALID_OUTPUT", "Nikon decoder output is missing or unreadable.");
  }

  try {
    const [openedResultStat, openedPixelsStat] = await Promise.all([
      resultFile.stat(),
      pixelsFile.stat(),
    ]);
    if (
      !openedResultStat.isFile() || !openedPixelsStat.isFile() ||
      openedResultStat.dev !== resultStat.dev || openedResultStat.ino !== resultStat.ino ||
      openedPixelsStat.dev !== pixelsStat.dev || openedPixelsStat.ino !== pixelsStat.ino ||
      openedResultStat.size !== resultStat.size || openedPixelsStat.size !== pixelsStat.size
    ) {
      throw new DecodeError("INVALID_OUTPUT", "Nikon decoder output changed while it was being opened.");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await resultFile.readFile("utf8"));
    } catch {
      throw new DecodeError("INVALID_OUTPUT", "Nikon decoder metadata is invalid.");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DecodeError("INVALID_OUTPUT", "Nikon decoder metadata is invalid.");
    }
    const result = raw as Record<string, unknown>;
    const width = result.width;
    const height = result.height;
    if (
      result.version !== 1 ||
      result.channels !== 3 ||
      result.bitDepth !== 16 ||
      result.pixelFormat !== "rgb16le" ||
      !Number.isInteger(width) || Number(width) <= 0 || Number(width) > MAX_DIMENSION ||
      !Number.isInteger(height) || Number(height) <= 0 || Number(height) > MAX_DIMENSION ||
      !Number.isInteger(result.orientation) || Number(result.orientation) < 1 || Number(result.orientation) > 8 ||
      result.colorSpace !== "srgb" ||
      result.transferFunction !== "srgb"
    ) {
      throw new DecodeError("INVALID_OUTPUT", "Nikon decoder metadata violates protocol version 1.");
    }

    const expectedBytes = Number(width) * Number(height) * 3 * 2;
    const edgeLimit = Math.min(request.maxEdge, PREVIEW_MAX_EDGE);
    if (request.mode === "preview" && Math.max(Number(width), Number(height)) > edgeLimit) {
      throw new DecodeError("INVALID_OUTPUT", "Nikon preview exceeds the requested size.");
    }
    if (
      expectedBytes > MAX_OUTPUT_BYTES ||
      result.byteCount !== expectedBytes ||
      openedPixelsStat.size !== expectedBytes
    ) {
      throw new DecodeError("INVALID_OUTPUT", "Nikon decoder pixel byte count is invalid.");
    }

    const pixels = await pixelsFile.readFile();
    if (pixels.byteLength !== expectedBytes) {
      throw new DecodeError("INVALID_OUTPUT", "Nikon decoder pixel data changed while it was being read.");
    }
    return {
      available: true,
      version: 1,
      width: Number(width),
      height: Number(height),
      channels: 3,
      bitDepth: 16,
      byteCount: expectedBytes,
      pixelFormat: "rgb16le",
      orientation: Number(result.orientation),
      colorSpace: "srgb",
      transferFunction: "srgb",
      pixels: pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength),
    };
  } finally {
    await Promise.allSettled([resultFile.close(), pixelsFile.close()]);
  }
}

function asFailure(error: unknown): NefDecodeFailure {
  if (error instanceof DecodeError) {
    return { available: false, code: error.code, message: error.message };
  }
  return { available: false, code: "INTERNAL", message: "Nikon decoder failed unexpectedly." };
}

export function createNefDecoderService(options: NefDecoderServiceOptions) {
  let active = 0;
  const waiting: Array<() => void> = [];

  async function limited<T>(work: () => Promise<T>): Promise<T> {
    while (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function decode(activeLibraryRoot: string | null, rawRequest: unknown): Promise<NefDecodeResult> {
    try {
      const request = validateRequest(rawRequest);
      if (!activeLibraryRoot) {
        throw new DecodeError("INVALID_ARGUMENT", "No approved library folder is open.");
      }
      if (!options.helper) {
        throw new DecodeError("SDK_UNAVAILABLE", "Nikon decoder is unavailable on this platform.");
      }
      return await limited(async () => {
        await assertHelper(options.helper!);
        const work = await fs.mkdtemp(path.join(options.tempRoot, "darkroom-nef-"));
        try {
          await fs.chmod(work, 0o700);
          const input = path.join(work, "input.nef");
          const output = path.join(work, "output");
          await fs.mkdir(output, { mode: 0o700 });
          await snapshotInput(activeLibraryRoot, request.relativePath, input);
          const outputIdentity = await fs.lstat(output);
          await runHelper(options.helper!, input, output, request, options.timeoutMs ?? 60_000);
          try {
            return await readOutput(output, request, outputIdentity);
          } catch (error) {
            if (error instanceof DecodeError) throw error;
            throw new DecodeError("INVALID_OUTPUT", "Nikon decoder output is missing or unreadable.");
          }
        } finally {
          await fs.rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        }
      });
    } catch (error) {
      return asFailure(error);
    }
  }

  return { decode };
}
