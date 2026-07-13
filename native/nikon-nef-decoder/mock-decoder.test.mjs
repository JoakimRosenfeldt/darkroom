import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./mock-decoder.mjs", import.meta.url));

async function fixture(extension = ".nef") {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-nef-mock-"));
  const input = path.join(root, `input${extension}`);
  const output = path.join(root, "output");
  const original = Buffer.from("source-nef-remains-unchanged");
  await writeFile(input, original);
  await mkdir(output);
  return { root, input, output, original };
}

function run(input, output) {
  return spawnSync(process.execPath, [
    helper,
    "--input", input,
    "--output", output,
    "--mode", "preview",
    "--max-edge", "2560",
    "--pixel-format", "rgb16le",
  ], { encoding: "utf8" });
}

test("writes deterministic RGB16 output without modifying the NEF", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));

  const completed = run(sample.input, sample.output);
  assert.equal(completed.status, 0, completed.stderr);

  const result = JSON.parse(await readFile(path.join(sample.output, "result.json"), "utf8"));
  const pixels = await readFile(path.join(sample.output, "pixels.bin"));
  assert.deepEqual(result, {
    version: 1,
    width: 8,
    height: 6,
    channels: 3,
    bitDepth: 16,
    byteCount: 288,
    pixelFormat: "rgb16le",
    orientation: 1,
    colorSpace: "srgb",
    transferFunction: "srgb",
  });
  assert.equal(pixels.byteLength, result.byteCount);
  assert.equal(pixels.readUInt16LE(0), 0);
  assert.equal(pixels.readUInt16LE(pixels.byteLength - 2), 65535);
  assert.deepEqual(await readFile(sample.input), sample.original);
});

test("rejects non-NEF input without writing output", async (t) => {
  const sample = await fixture(".jpg");
  t.after(() => rm(sample.root, { recursive: true, force: true }));

  const completed = run(sample.input, sample.output);
  assert.notEqual(completed.status, 0);
  assert.equal(JSON.parse(completed.stderr).code, "UNSUPPORTED_FILE");
  await assert.rejects(readFile(path.join(sample.output, "result.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(sample.output, "pixels.bin")), { code: "ENOENT" });
  assert.deepEqual(await readFile(sample.input), sample.original);
});
