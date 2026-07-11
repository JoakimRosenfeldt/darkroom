import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createNefDecoderService } from "../electron/nef-decoder-service.ts";

const mock = fileURLToPath(new URL("../native/nikon-nef-decoder/mock-decoder.mjs", import.meta.url));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-nef-service-test-"));
  const library = path.join(root, "library");
  const temp = path.join(root, "temp");
  await Promise.all([mkdir(library), mkdir(temp)]);
  const original = Buffer.from("source-nef-remains-unchanged");
  await writeFile(path.join(library, "photo.nef"), original);
  const service = createNefDecoderService({
    helper: { executable: process.execPath, fixedArgs: [mock] },
    tempRoot: temp,
  });
  return { root, library, temp, original, service };
}

test("decodes through the mock, caps preview size, and removes temporary output", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));

  const result = await sample.service.decode(sample.library, {
    relativePath: "photo.nef",
    mode: "preview",
    maxEdge: 99_999,
  });

  assert.equal(result.available, true);
  if (!result.available) return;
  assert.deepEqual(
    { width: result.width, height: result.height, byteCount: result.byteCount, pixelFormat: result.pixelFormat },
    { width: 8, height: 6, byteCount: 288, pixelFormat: "rgb16le" },
  );
  assert.equal(result.pixels.byteLength, 288);
  assert.deepEqual(await readFile(path.join(sample.library, "photo.nef")), sample.original);
  assert.deepEqual(await readdir(sample.temp), []);
});

test("passes only a private snapshot to the helper and preserves the original", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const report = path.join(sample.root, "received-input.txt");
  const helper = path.join(sample.root, "snapshot-writer.mjs");
  await writeFile(helper, `
    import { chmod, writeFile } from "node:fs/promises";
    import path from "node:path";
    const input = process.argv[process.argv.indexOf("--input") + 1];
    const output = process.argv[process.argv.indexOf("--output") + 1];
    await writeFile(process.env.REPORT_PATH, input);
    await chmod(input, 0o600);
    await writeFile(input, "helper changed its snapshot");
    await writeFile(path.join(output, "pixels.bin"), Buffer.alloc(6));
    await writeFile(path.join(output, "result.json"), JSON.stringify({
      version: 1, width: 1, height: 1, channels: 3, bitDepth: 16,
      byteCount: 6, pixelFormat: "rgb16le", orientation: 1,
      colorSpace: "srgb", transferFunction: "srgb"
    }));
  `);
  const service = createNefDecoderService({
    helper: { executable: process.execPath, fixedArgs: [helper], env: { REPORT_PATH: report } },
    tempRoot: sample.temp,
  });

  const result = await service.decode(sample.library, {
    relativePath: "photo.nef",
    mode: "preview",
    maxEdge: 2560,
  });

  assert.equal(result.available, true);
  const receivedInput = await readFile(report, "utf8");
  assert.notEqual(receivedInput, path.join(sample.library, "photo.nef"));
  assert.equal(path.basename(receivedInput), "input.nef");
  assert.equal(receivedInput.startsWith(`${sample.temp}${path.sep}`), true);
  assert.deepEqual(await readFile(path.join(sample.library, "photo.nef")), sample.original);
  assert.deepEqual(await readdir(sample.temp), []);
});

test("resolves queued inputs only after a decode slot is available", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const control = path.join(sample.root, "control");
  await mkdir(control);
  await Promise.all([
    writeFile(path.join(sample.library, "hold-one.nef"), "hold"),
    writeFile(path.join(sample.library, "hold-two.nef"), "hold"),
    writeFile(path.join(sample.library, "queued.nef"), "queued"),
  ]);
  const outside = path.join(sample.root, "outside.nef");
  await writeFile(outside, "outside");
  const helper = path.join(sample.root, "queued-helper.mjs");
  await writeFile(helper, `
    import { access, readFile, writeFile } from "node:fs/promises";
    import path from "node:path";
    const input = process.argv[process.argv.indexOf("--input") + 1];
    const output = process.argv[process.argv.indexOf("--output") + 1];
    if ((await readFile(input, "utf8")) === "hold") {
      await writeFile(path.join(process.env.CONTROL, \`started-\${process.pid}\`), "");
      while (true) {
        try { await access(path.join(process.env.CONTROL, "release")); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
    }
    await writeFile(path.join(output, "pixels.bin"), Buffer.alloc(6));
    await writeFile(path.join(output, "result.json"), JSON.stringify({
      version: 1, width: 1, height: 1, channels: 3, bitDepth: 16,
      byteCount: 6, pixelFormat: "rgb16le", orientation: 1,
      colorSpace: "srgb", transferFunction: "srgb"
    }));
  `);
  const service = createNefDecoderService({
    helper: { executable: process.execPath, fixedArgs: [helper], env: { CONTROL: control } },
    tempRoot: sample.temp,
  });
  const request = (relativePath: string) => service.decode(sample.library, {
    relativePath,
    mode: "preview",
    maxEdge: 2560,
  });
  const first = request("hold-one.nef");
  const second = request("hold-two.nef");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readdir(control)).filter((name) => name.startsWith("started-")).length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await readdir(control)).filter((name) => name.startsWith("started-")).length, 2);

  const queued = request("queued.nef");
  await rm(path.join(sample.library, "queued.nef"));
  await symlink(outside, path.join(sample.library, "queued.nef"));
  await writeFile(path.join(control, "release"), "");
  const [firstResult, secondResult, queuedResult] = await Promise.all([first, second, queued]);

  assert.equal(firstResult.available, true);
  assert.equal(secondResult.available, true);
  assert.equal(queuedResult.available ? "success" : queuedResult.code, "INVALID_ARGUMENT");
  assert.deepEqual(await readdir(sample.temp), []);
});

test("rejects traversal, absolute paths, non-NEF files, and symlink escapes", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const outside = path.join(sample.root, "outside.nef");
  await writeFile(outside, "outside");
  await writeFile(path.join(sample.library, "photo.jpg"), "jpg");
  await symlink(outside, path.join(sample.library, "escape.nef"));

  for (const [relativePath, code] of [
    ["../outside.nef", "INVALID_ARGUMENT"],
    [outside, "INVALID_ARGUMENT"],
    ["photo.jpg", "UNSUPPORTED_FILE"],
    ["escape.nef", "INVALID_ARGUMENT"],
  ] as const) {
    const result = await sample.service.decode(sample.library, { relativePath, mode: "preview", maxEdge: 2560 });
    assert.deepEqual(result.available ? "success" : result.code, code);
  }
  assert.deepEqual(await readdir(sample.temp), []);
});

test("rejects oversized input before launching the helper", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  await truncate(path.join(sample.library, "photo.nef"), 2 * 1024 * 1024 * 1024 + 1);

  const result = await sample.service.decode(sample.library, {
    relativePath: "photo.nef",
    mode: "full",
    maxEdge: 2560,
  });
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.code, "LIMIT_EXCEEDED");
});

test("rejects malformed helper output and cleans it up", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const helper = path.join(sample.root, "malformed.mjs");
  await writeFile(helper, `
    import { writeFile } from "node:fs/promises";
    import path from "node:path";
    const output = process.argv[process.argv.indexOf("--output") + 1];
    await writeFile(path.join(output, "pixels.bin"), Buffer.alloc(2));
    await writeFile(path.join(output, "result.json"), JSON.stringify({
      version: 1, width: 1, height: 1, channels: 3, bitDepth: 16,
      byteCount: 6, pixelFormat: "rgb16le", orientation: 1,
      colorSpace: "srgb", transferFunction: "srgb"
    }));
  `);
  const service = createNefDecoderService({
    helper: { executable: process.execPath, fixedArgs: [helper] },
    tempRoot: sample.temp,
  });

  const result = await service.decode(sample.library, {
    relativePath: "photo.nef",
    mode: "preview",
    maxEdge: 2560,
  });
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.code, "INVALID_OUTPUT");
  assert.deepEqual(await readdir(sample.temp), []);
});

test("rejects non-sRGB protocol v1 output", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const helper = path.join(sample.root, "unsupported-color.mjs");
  await writeFile(helper, `
    import { writeFile } from "node:fs/promises";
    import path from "node:path";
    const output = process.argv[process.argv.indexOf("--output") + 1];
    await writeFile(path.join(output, "pixels.bin"), Buffer.alloc(6));
    await writeFile(path.join(output, "result.json"), JSON.stringify({
      version: 1, width: 1, height: 1, channels: 3, bitDepth: 16,
      byteCount: 6, pixelFormat: "rgb16le", orientation: 1,
      colorSpace: process.env.COLOR_SPACE, transferFunction: process.env.TRANSFER_FUNCTION
    }));
  `);

  for (const [colorSpace, transferFunction] of [["display-p3", "srgb"], ["srgb", "linear"]]) {
    const result = await createNefDecoderService({
      helper: {
        executable: process.execPath,
        fixedArgs: [helper],
        env: { COLOR_SPACE: colorSpace, TRANSFER_FUNCTION: transferFunction },
      },
      tempRoot: sample.temp,
    }).decode(sample.library, { relativePath: "photo.nef", mode: "preview", maxEdge: 2560 });

    assert.equal(result.available ? "success" : result.code, "INVALID_OUTPUT");
    assert.deepEqual(await readdir(sample.temp), []);
  }
});

test("rejects symlinked helper output", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const helper = path.join(sample.root, "symlink-output.mjs");
  await writeFile(helper, `
    import { symlink, writeFile } from "node:fs/promises";
    import path from "node:path";
    const output = process.argv[process.argv.indexOf("--output") + 1];
    const metadata = path.join(output, "..", "metadata.json");
    await writeFile(path.join(output, "pixels.bin"), Buffer.alloc(6));
    await writeFile(metadata, JSON.stringify({
      version: 1, width: 1, height: 1, channels: 3, bitDepth: 16,
      byteCount: 6, pixelFormat: "rgb16le", orientation: 1,
      colorSpace: "srgb", transferFunction: "srgb"
    }));
    await symlink(metadata, path.join(output, "result.json"));
  `);
  const result = await createNefDecoderService({
    helper: { executable: process.execPath, fixedArgs: [helper] },
    tempRoot: sample.temp,
  }).decode(sample.library, { relativePath: "photo.nef", mode: "preview", maxEdge: 2560 });

  assert.equal(result.available ? "success" : result.code, "INVALID_OUTPUT");
  assert.deepEqual(await readdir(sample.temp), []);
});

test("rejects missing and oversized helper output", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const missing = path.join(sample.root, "missing-output.mjs");
  const oversized = path.join(sample.root, "oversized-output.mjs");
  await writeFile(missing, "// Successful exit without protocol output.");
  await writeFile(oversized, `
    import { writeFile } from "node:fs/promises";
    import path from "node:path";
    const output = process.argv[process.argv.indexOf("--output") + 1];
    await writeFile(path.join(output, "pixels.bin"), Buffer.alloc(2));
    await writeFile(path.join(output, "result.json"), JSON.stringify({
      version: 1, width: 65535, height: 65535, channels: 3, bitDepth: 16,
      byteCount: 25769017350, pixelFormat: "rgb16le", orientation: 1,
      colorSpace: "srgb", transferFunction: "srgb"
    }));
  `);

  for (const helper of [missing, oversized]) {
    const result = await createNefDecoderService({
      helper: { executable: process.execPath, fixedArgs: [helper] },
      tempRoot: sample.temp,
    }).decode(sample.library, { relativePath: "photo.nef", mode: "full", maxEdge: 2560 });
    assert.equal(result.available ? "success" : result.code, "INVALID_OUTPUT");
    assert.deepEqual(await readdir(sample.temp), []);
  }
});

test("kills a timed-out helper and cleans temporary output", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const helper = path.join(sample.root, "slow.mjs");
  await writeFile(helper, "setTimeout(() => {}, 10_000);");
  const service = createNefDecoderService({
    helper: { executable: process.execPath, fixedArgs: [helper] },
    tempRoot: sample.temp,
    timeoutMs: 25,
  });

  const result = await service.decode(sample.library, {
    relativePath: "photo.nef",
    mode: "preview",
    maxEdge: 2560,
  });
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.code, "TIMEOUT");
  assert.deepEqual(await readdir(sample.temp), []);
});

test("reports helper crashes and missing helpers without leaking output", async (t) => {
  const sample = await fixture();
  t.after(() => rm(sample.root, { recursive: true, force: true }));
  const crashing = path.join(sample.root, "crash.mjs");
  await writeFile(crashing, "process.exit(2);");

  const crashed = await createNefDecoderService({
    helper: { executable: process.execPath, fixedArgs: [crashing] },
    tempRoot: sample.temp,
  }).decode(sample.library, { relativePath: "photo.nef", mode: "preview", maxEdge: 2560 });
  const missing = await createNefDecoderService({
    helper: { executable: path.join(sample.root, "missing-helper") },
    tempRoot: sample.temp,
  }).decode(sample.library, { relativePath: "photo.nef", mode: "preview", maxEdge: 2560 });

  assert.equal(crashed.available ? "success" : crashed.code, "HELPER_CRASH");
  assert.equal(missing.available ? "success" : missing.code, "SDK_UNAVAILABLE");
  assert.deepEqual(await readdir(sample.temp), []);
});
