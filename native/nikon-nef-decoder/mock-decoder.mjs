#!/usr/bin/env node

import { access, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const VERSION = 1;
const PREVIEW_MAX_EDGE = 2560;
const MOCK_WIDTH = 8;
const MOCK_HEIGHT = 6;

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ version: VERSION, code, message })}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const allowed = new Set(["input", "output", "mode", "max-edge", "pixel-format"]);
  const values = new Map();

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (!allowed.has(name) || values.has(name)) {
      throw new Error(`unknown or repeated argument: ${flag}`);
    }
    values.set(name, value);
  }

  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`missing argument: --${name}`);
  }

  const maxEdge = Number(values.get("max-edge"));
  if (!Number.isSafeInteger(maxEdge) || maxEdge <= 0) {
    throw new Error("--max-edge must be a positive integer");
  }
  if (!path.isAbsolute(values.get("input")) || !path.isAbsolute(values.get("output"))) {
    throw new Error("--input and --output must be absolute paths");
  }
  if (!/\.nef$/i.test(values.get("input"))) {
    const error = new Error("--input must name a .nef file");
    error.code = "UNSUPPORTED_FILE";
    throw error;
  }
  if (!new Set(["preview", "full"]).has(values.get("mode"))) {
    throw new Error("--mode must be preview or full");
  }
  if (values.get("pixel-format") !== "rgb16le") {
    throw new Error("--pixel-format must be rgb16le");
  }
  if (values.get("mode") === "preview" && maxEdge > PREVIEW_MAX_EDGE) {
    throw new Error(`preview --max-edge must not exceed ${PREVIEW_MAX_EDGE}`);
  }

  return {
    input: values.get("input"),
    output: values.get("output"),
    mode: values.get("mode"),
    maxEdge,
  };
}

function makeGradient(width, height) {
  const pixels = Buffer.alloc(width * height * 3 * 2);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const channels = [
        Math.round((x / (width - 1)) * 65535),
        Math.round((y / (height - 1)) * 65535),
        Math.round(((x + y) / (width + height - 2)) * 65535),
      ];
      for (const channel of channels) {
        pixels.writeUInt16LE(channel, offset);
        offset += 2;
      }
    }
  }
  return pixels;
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    fail(error.code ?? "INVALID_ARGUMENT", error.message);
    return;
  }

  try {
    await access(args.input);
    const [inputInfo, outputInfo] = await Promise.all([stat(args.input), stat(args.output)]);
    if (!inputInfo.isFile()) throw Object.assign(new Error("input is not a regular file"), { code: "INPUT_IO" });
    if (!outputInfo.isDirectory()) throw Object.assign(new Error("output is not a directory"), { code: "OUTPUT_IO" });

    const width = args.mode === "preview" ? Math.min(MOCK_WIDTH, args.maxEdge) : MOCK_WIDTH;
    const height = args.mode === "preview"
      ? Math.max(1, Math.round(MOCK_HEIGHT * (width / MOCK_WIDTH)))
      : MOCK_HEIGHT;
    const pixels = makeGradient(width, height);
    const result = {
      version: VERSION,
      width,
      height,
      channels: 3,
      bitDepth: 16,
      byteCount: pixels.byteLength,
      pixelFormat: "rgb16le",
      orientation: 1,
      colorSpace: "srgb",
      transferFunction: "srgb",
    };

    const pixelsPath = path.join(args.output, "pixels.bin");
    const resultPath = path.join(args.output, "result.json");
    const temporaryResultPath = path.join(args.output, ".result.json.tmp");
    await writeFile(pixelsPath, pixels, { flag: "wx" });
    await writeFile(temporaryResultPath, `${JSON.stringify(result)}\n`, { flag: "wx" });
    await rename(temporaryResultPath, resultPath);
  } catch (error) {
    const code = error.code === "ENOENT" || error.code === "EACCES"
      ? "INPUT_IO"
      : error.code === "INPUT_IO" || error.code === "OUTPUT_IO"
        ? error.code
        : "OUTPUT_IO";
    fail(code, error.message);
  }
}

await main();
