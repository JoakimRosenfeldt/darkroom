import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import exifr from "exifr";

const root = process.cwd();
const url = process.env.DARKROOM_SMOKE_URL ?? "http://localhost:3000";
const serverDeadline = Date.now() + 30_000;
for (;;) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    break;
  } catch (error) {
    if (Date.now() >= serverDeadline) throw new Error(`Development server did not become ready at ${url} within 30 seconds. Start npm run dev.`, { cause: error });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const directory = await mkdtemp(path.join(os.tmpdir(), "darkroom-develop-smoke-"));
const photos = path.join(directory, "photos");
const outputs = path.join(directory, "exports");
await mkdir(photos);
await mkdir(outputs);
const raw = Boolean(process.env.DARKROOM_SMOKE_RAW);
const demo = (await readdir(path.join(root, "public/demo"))).find((name) => name.endsWith(".jpg"));
const fixture = process.env.DARKROOM_SMOKE_RAW ?? path.join(root, "public/demo", demo);
const sampleName = raw ? "sample.NEF" : "sample.jpg";
const originalHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
await copyFile(fixture, path.join(photos, sampleName));
await copyFile(fixture, path.join(photos, raw ? "second.NEF" : "second.jpg"));
await copyFile(path.join(root, "public/demo", demo), path.join(photos, "demo.jpg"));
const report = { directory, fixture, checks: [], timingsMs: {} };
const executable = path.resolve(process.env.DARKROOM_SMOKE_BINARY ?? "src-tauri/target/debug/darkroom");
const driverUrl = `http://127.0.0.1:${process.env.DARKROOM_SMOKE_DRIVER_PORT ?? "4460"}`;
const driverArgs = ["--port", new URL(driverUrl).port];
if (process.env.DARKROOM_SMOKE_NATIVE_DRIVER) driverArgs.push("--native-driver", process.env.DARKROOM_SMOKE_NATIVE_DRIVER);
const driver = spawn(process.env.DARKROOM_SMOKE_DRIVER ?? "tauri-driver", driverArgs, {
  env: { ...process.env, DARKROOM_USER_DATA: path.join(directory, "profile"), DARKROOM_SMOKE_PHOTOS: photos, DARKROOM_SMOKE_EXPORT_FILE: path.join(outputs, "photo.jpg") },
  stdio: ["ignore", "pipe", "pipe"],
});
let driverLog = "";
for (const stream of [driver.stdout, driver.stderr]) stream.on("data", (chunk) => { driverLog += chunk; });
let driverError;
driver.on("error", (error) => { driverError = error; });
let session;
let page;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(route, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${driverUrl}${route}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${route}: ${JSON.stringify(result.value)}`);
  return result.value;
}
async function evaluate(fn, argument) {
  const result = await request(`/session/${session}/execute/async`, {
    script: `const done=arguments[arguments.length-1];Promise.resolve((${fn.toString()})(arguments[0])).then(value=>done({value:value??null}),error=>done({failure:String(error),stack:error.stack}));`, args: [argument ?? null],
  });
  if (result.failure) throw new Error(`${result.failure}\n${result.stack ?? ""}`);
  return result.value;
}
async function waitForFunction(fn, argument, options = {}) {
  const deadline = Date.now() + (options.timeout ?? 90_000);
  do {
    if (await evaluate(fn, argument)) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${fn.toString()}`);
}
function locator(query) {
  const find = (query) => {
    const candidates = [...document.querySelectorAll(query.css ?? (query.role === "button" ? "button,[role=button]" : "*"))];
    const matches = candidates.filter((element) => element.getClientRects().length && (query.css || (query.placeholder ? element.getAttribute("placeholder") === query.placeholder : (element.getAttribute("aria-label") ?? element.textContent.trim()) === query.text)));
    return matches.find((element) => !matches.some((other) => other !== element && element.contains(other))) ?? null;
  };
  const element = async () => {
    await waitForFunction(find, query);
    const found = await evaluate(find, query);
    return found["element-6066-11e4-a52e-4f735466cecf"];
  };
  return {
    waitFor: () => waitForFunction(find, query),
    click: async () => request(`/session/${session}/element/${await element()}/click`, {}),
    fill: async (text) => {
      const id = await element();
      await request(`/session/${session}/element/${id}/clear`, {});
      await request(`/session/${session}/element/${id}/value`, { text });
    },
    dblclick: async () => {
      await element();
      await evaluate(new Function("query", `(${find.toString()})(query).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));`), query);
    },
    evaluate: async (fn) => evaluate(new Function("query", `return (${fn.toString()})((${find.toString()})(query));`), query),
  };
}
async function processTree() {
  const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,comm="]);
  const rows = stdout.trim().split("\n").map((line) => { const [pid, ppid, ...name] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), name: name.join(" ") }; });
  const descendants = new Set([driver.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  }
  return rows.filter((row) => descendants.has(row.pid));
}
async function launch() {
  for (let attempt = 0;; attempt += 1) {
    if (driverError) throw driverError;
    try { await request("/status"); break; } catch (error) { if (attempt > 100) throw error; await sleep(100); }
  }
  session = (await request("/session", { capabilities: { alwaysMatch: { "tauri:options": { application: executable } } } })).sessionId;
  await request(`/session/${session}/timeouts`, { script: 180_000 });
  page = {
    evaluate, waitForFunction, waitForTimeout: sleep, locator: (css) => locator({ css }),
    getByRole: (role, { name }) => locator({ role, text: name }),
    getByPlaceholder: (placeholder) => locator({ placeholder }),
    getByText: (text) => locator({ text }),
    url: () => request(`/session/${session}/url`),
    goto: (url) => request(`/session/${session}/url`, { url }),
    screenshot: async ({ path }) => writeFile(path, Buffer.from(await request(`/session/${session}/screenshot`), "base64")),
  };
  await page.waitForFunction(() => window.darkroom?.isDesktop);
  await runtime();
  console.log("Desktop bridge ready");
}
async function runtime() {
  await page.evaluate(async () => {
    const names = [
      "stores/develop-store.ts",
      "stores/library-store.ts",
      "lib/develop/repository.ts",
      "lib/develop/v3/local-adjustments.ts",
      "lib/cache/thumbnail-cache.ts",
      "lib/develop/presets/apply.ts",
      "lib/cache/develop-image-cache.ts",
      "lib/develop/v3/preview-worker-client.ts",
      "lib/export/runner.ts",
    ];
    const resources = performance.getEntriesByType("resource").map((entry) => new URL(entry.name));
    const modules = new Map(await Promise.all(names.map(async (name) => {
      // Reuse the app's module instance when a long-lived Vite server adds HMR timestamps.
      const loaded = resources.filter((resource) => resource.pathname === `/${name}`)
        .sort((a, b) => Number(b.searchParams.get("t") ?? 0) - Number(a.searchParams.get("t") ?? 0))[0];
      return [name, await import(loaded?.href ?? `/${name}`)];
    })));
    window.smokeModule = (name) => {
      if (!modules.has(name)) throw new Error(`Unknown smoke module: ${name}`);
      return modules.get(name);
    };
  });
}
async function ready() {
  await runtime();
  await page.waitForFunction(() => {
    const store = window.smokeModule("stores/develop-store.ts").useDevelopStore.getState();
    const ui = store.sessions[store.activeEntryId]?.ui;
    if (ui?.sidecarStatus === "error") throw new Error(ui.sidecarError);
    return store.activeEntryId && !Object.keys(store.pendingDefaultOperations).length &&
      store.sessions[store.activeEntryId]?.ui.sidecarStatus === "saved" &&
      document.querySelector('canvas[role="img"]')?.width > 1;
  }, null, { timeout: 90_000 });
}
async function check(name, run) {
  await run();
  report.checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  await launch();
  await page.getByRole("button", { name: "Import folder", exact: true }).click();
  await page.getByPlaceholder("Catalog name", { exact: true }).fill("Workflow smoke");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByText(sampleName, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const started = Date.now();
  await page.getByText(sampleName, { exact: true }).dblclick();
  await ready();
  report.timingsMs.openPhoto = Date.now() - started;
  const photoUrl = await page.url();

  await check("new photo, edit, undo, redo and delayed catalog save", async () => {
    const result = await page.evaluate(async () => {
      const loadModule = window.smokeModule;
      const ds = loadModule("stores/develop-store.ts").useDevelopStore;
      const state = ds.getState();
      const ls = loadModule("stores/library-store.ts").useLibraryStore.getState();
      const entry = ls.entries.find((candidate) => candidate.id === state.activeEntryId);
      const repository = loadModule("lib/develop/repository.ts").getDevelopRepository(entry);
      const document = structuredClone(state.sessions[entry.id].persistedDocument);
      document.tone.basic.exposure = 0.75;
      document.color.monochrome.enabled = true;
      document.geometry.crop = { ...document.geometry.crop, enabled: true, x: 0.15, y: 0.15, width: 0.7, height: 0.7 };
      const adjustments = loadModule("lib/develop/v3/local-adjustments.ts").createDefaultLocalAdjustments();
      adjustments.basic.exposure = -0.5;
      document.local.masks = [{ id: "smoke-mask", name: "Gradient", enabled: true, expression: { kind: "source", id: "smoke-gradient", enabled: true, source: { kind: "linear-gradient", start: { x: 0, y: 0 }, end: { x: 0, y: 1 } } }, adjustments }];
      state.dispatchV3({ kind: "replace-v3-complete-state", document }, "Smoke crop and mask");
      await repository.flush();
      ds.getState().undo();
      await repository.flush();
      const undo = ds.getState().sessions[entry.id].persistedDocument.tone.basic.exposure;
      ds.getState().redo();
      await repository.flush();
      window.smokeEntry = entry;
      return { undo, redo: ds.getState().sessions[entry.id].persistedDocument.tone.basic.exposure };
    });
    assert.deepEqual(result, { undo: 0, redo: 0.75 });
    await page.waitForTimeout(1_000);
    assert.equal(await page.evaluate(async () => {
      const entry = window.smokeEntry;
      const head = await window.darkroom.developHistoryLoad({ catalogId: entry.catalogId, entryId: entry.id, revisionId: null });
      return head.value.document.tone.basic.exposure;
    }), 0.75);
  });

  await check("edited thumbnail size and virtual-copy identity", async () => {
    const result = await page.evaluate(async () => {
      const loadModule = window.smokeModule;
      const ls = loadModule("stores/library-store.ts").useLibraryStore;
      const entry = window.smokeEntry;
      const copyId = await ls.getState().createVirtualCopy(entry.id, "Alternate");
      const document = (await window.darkroom.developHistoryLoad({ catalogId: entry.catalogId, entryId: entry.id, revisionId: null })).value.document;
      const copyDocument = (await window.darkroom.developHistoryLoad({ catalogId: entry.catalogId, entryId: copyId, revisionId: null })).value.document;
      const alternate = structuredClone(document);
      alternate.color.monochrome.enabled = false;
      const thumbnail = loadModule("lib/cache/thumbnail-cache.ts").loadThumbnailBlob;
      const small = await thumbnail(entry, 360, { document });
      const large = await thumbnail(entry, 1200, { document });
      const other = await thumbnail(ls.getState().entries.find((item) => item.id === copyId), 360, { document: alternate });
      const smallImage = await createImageBitmap(small);
      const largeImage = await createImageBitmap(large);
      const sizes = [smallImage.width, smallImage.height, largeImage.width, largeImage.height];
      smallImage.close(); largeImage.close();
      window.smokeCopyId = copyId;
      return { sizes, different: await small.text() !== await other.text(), document, copyDocument };
    });
    assert.ok(Math.max(...result.sizes.slice(2)) > Math.max(...result.sizes.slice(0, 2)));
    assert.equal(result.different, true);
    assert.equal(result.document.tone.basic.exposure, 0.75);
    assert.deepEqual(result.copyDocument, result.document);
  });

  await check("preset batch and undo", async () => {
    const batchId = await page.evaluate(async () => {
      const loadModule = window.smokeModule;
      const entry = window.smokeEntry;
      const document = (await window.darkroom.developHistoryLoad({ catalogId: entry.catalogId, entryId: entry.id, revisionId: null })).value.document;
      const fields = ["basic", "crop", "manual-masks"];
      const preset = await window.darkroom.developPresetsCreate({ schemaVersion: 1, presetId: crypto.randomUUID(), revision: 1, name: "Smoke preset", author: "Smoke", category: "Tests", source: "user", favorite: false, fields, payload: loadModule("lib/develop/presets/apply.ts").captureDevelopPresetPayload(document, fields, entry.sourceId), compatibility: { process: "darkroom-v3", documentSchemaRevision: "darkroom-v3-document-2" } });
      const batch = await window.darkroom.developBatchStart({ catalogId: entry.catalogId, sessionId: entry.sessionId, batchId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: "batch", sourceEntryId: entry.id, targetEntryIds: [window.smokeCopyId], operation: { kind: "preset", presetId: preset.presetId, revision: preset.revision, fields: null, amount: 100 } });
      return batch.batchId;
    });
    await page.waitForFunction(async (id) => {
      const e = window.smokeEntry;
      const batches = await window.darkroom.developBatchList({ catalogId: e.catalogId, sessionId: e.sessionId, limit: 10 });
      return batches.find((batch) => batch.batchId === id)?.items.every((item) => item.state.kind !== "queued" && item.state.kind !== "active");
    }, batchId);
    const result = await page.evaluate(async (id) => {
      const e = window.smokeEntry;
      const receipt = (await window.darkroom.developBatchList({ catalogId: e.catalogId, sessionId: e.sessionId, limit: 10 })).find((item) => item.batchId === id);
      if (!receipt || receipt.items.some((item) => item.state.kind !== "completed")) throw new Error(JSON.stringify(receipt));
      return await window.darkroom.developBatchUndo({ catalogId: e.catalogId, sessionId: e.sessionId, batchId: id });
    }, batchId);
    assert.ok(result);
  });

  await check("batch cancellation keeps completed edits and stops remaining items", async () => {
    const result = await page.evaluate(async () => {
      const entry = window.smokeEntry;
      const state = window.smokeModule("stores/library-store.ts").useLibraryStore.getState();
      const batch = await window.darkroom.developBatchStart({ catalogId: entry.catalogId, sessionId: entry.sessionId, batchId: crypto.randomUUID(), operationId: crypto.randomUUID(), kind: "sync", sourceEntryId: entry.id, targetEntryIds: state.entries.filter((candidate) => candidate.id !== entry.id).map((candidate) => candidate.id), fields: ["basic"] });
      await window.darkroom.developBatchCancel({ catalogId: entry.catalogId, sessionId: entry.sessionId, batchId: batch.batchId });
      return batch.batchId;
    });
    await page.waitForFunction(async (id) => {
      const entry = window.smokeEntry;
      const receipt = (await window.darkroom.developBatchList({ catalogId: entry.catalogId, sessionId: entry.sessionId, limit: 10 })).find((batch) => batch.batchId === id);
      return receipt?.cancellationRequested && receipt.items.every((item) => !["queued", "active"].includes(item.state.kind));
    }, result);
    const states = await page.evaluate(async (id) => {
      const entry = window.smokeEntry;
      const receipt = (await window.darkroom.developBatchList({ catalogId: entry.catalogId, sessionId: entry.sessionId, limit: 10 })).find((batch) => batch.batchId === id);
      return receipt.items.map((item) => item.state.kind);
    }, result);
    assert.ok(states.every((kind) => ["completed", "cancelled", "skipped"].includes(kind)));
    report.cancelledBatchId = result;
  });

  await check("detail regions match full output, and cached slider timing", async () => {
    const result = await page.evaluate(async () => {
      const loadModule = window.smokeModule;
      const entry = window.smokeEntry;
      const images = loadModule("lib/cache/develop-image-cache.ts");
      const image = await images.loadDevelopImage(entry, { rawColorMode: "libraw-camera-matrix" });
      const cachedAt = performance.now();
      await images.loadDevelopImage(entry, { rawColorMode: "libraw-camera-matrix" });
      const cachedMs = performance.now() - cachedAt;
      const document = (await window.darkroom.developHistoryLoad({ catalogId: entry.catalogId, entryId: entry.id, revisionId: null })).value.document;
      const WorkerClient = loadModule("lib/develop/v3/preview-worker-client.ts").V3PreviewWorkerClient;
      const worker = new WorkerClient(entry, image);
      try {
        const times = [];
        const backends = [];
        for (let index = 0; index < 4; index += 1) {
          const started = performance.now();
          const rendered = await worker.render(document, { viewportDimensions: { width: 900, height: 600 }, devicePixelRatio: 2, previewMode: "interactive", includeAnalysis: false });
          if (rendered.result.kind !== "rendered") throw new Error("Interactive render failed.");
          times.push(performance.now() - started);
          backends.push(rendered.backend);
          if ("bitmap" in rendered.result) rendered.result.bitmap.close();
        }
        const whole = await worker.renderExport(document, { mode: "original" });
        const region = { x: 100, y: 100, width: 100, height: 80 };
        const part = await worker.renderExport(document, { mode: "original" }, [], region);
        if (whole.result.kind !== "rendered" || part.result.kind !== "rendered" || "bitmap" in whole.result || "bitmap" in part.result) throw new Error("Region render failed.");
        let difference = 0;
        for (let y = 0; y < region.height; y += 1) for (let x = 0; x < region.width; x += 1) for (let channel = 0; channel < 4; channel += 1) {
          difference = Math.max(difference, Math.abs(whole.result.pixels.pixels[((region.y + y) * whole.result.dimensions.width + region.x + x) * 4 + channel] - part.result.pixels.pixels[(y * region.width + x) * 4 + channel]));
        }
        const pixels = whole.result.pixels.pixels;
        let min = 255; let max = 0;
        for (let index = 0; index < pixels.length; index += 4) { min = Math.min(min, pixels[index]); max = Math.max(max, pixels[index]); }
        return { difference, cachedMs, backends, exportBackend: whole.backend, pixelRange: max - min, interactiveMs: times.slice(1).sort((a, b) => a - b)[1] };
      } finally { worker.dispose(); }
    });
    assert.equal(result.difference, 0);
    assert.ok(result.pixelRange > 10, "Rendered export contains image detail.");
    report.renderBackends = { preview: result.backends, export: result.exportBackend };
    if (process.env.DARKROOM_SMOKE_REQUIRE_GPU === "1") {
      assert.ok(result.backends.every((backend) => backend === "gpu"));
      assert.equal(result.exportBackend, "gpu");
    }
    report.timingsMs.cachedDecode = result.cachedMs;
    report.timingsMs.interactiveWorker = result.interactiveMs;
  });

  await check("100% uses one source pixel per display pixel", async () => {
    await page.getByRole("button", { name: "100%", exact: true }).click();
    const start = Date.now();
    await page.waitForFunction(() => document.querySelector('[aria-label="100 percent detail; drag to pan"]')?.getAttribute("aria-busy") === "false", null, { timeout: 90_000 });
    report.timingsMs.actualSize = Date.now() - start;
    const scale = await page.locator('[aria-label="100 percent detail; drag to pan"] canvas').evaluate((canvas) => ({ actual: canvas.width / canvas.getBoundingClientRect().width, expected: devicePixelRatio }));
    assert.equal(scale.actual, scale.expected);
    await page.screenshot({ path: path.join(directory, "detail.png") });
    await page.getByRole("button", { name: "Fit", exact: true }).click();
  });

  await check("JPEG metadata, ICC, resize, collision and cancellation", async () => {
    const pixels = raw ? 1200 : 600;
    const result = await page.evaluate(async (pixels) => {
      const loadModule = window.smokeModule;
      const entry = window.smokeEntry;
      const ls = loadModule("stores/library-store.ts").useLibraryStore.getState();
      const run = loadModule("lib/export/runner.ts").runExportBatch;
      const source = ls.libraryWorkspace.analysisByEntryId[entry.id]?.source;
      const metadata = { ...ls.entryMetadata, [entry.id]: { ...ls.entryMetadata[entry.id], copyright: "Smoke copyright" } };
      const base = { entries: [entry], metadata, metadataOverrides: { [entry.id]: { latitude: { kind: "set", value: 55.67 }, longitude: { kind: "set", value: 12.56 } } }, sourceMetadata: { [entry.id]: source } };
      const summaries = [];
      for (const mode of ["all", "copyright", "none"]) {
        const destination = await window.darkroom.chooseExportDestination({ catalogId: entry.catalogId, sessionId: entry.sessionId, assetIds: [entry.assetId], count: 1, format: "jpeg", suggestedFilename: "photo.jpg" });
        const started = performance.now();
        const summary = await run({ ...base, destinationToken: destination.token, options: { format: "jpeg", size: { mode: "long-edge", pixels }, quality: 90, conflict: "rename", metadata: mode, includeLocation: mode === "all" } });
        summaries.push({ mode, ms: performance.now() - started, exported: summary.exported, failed: summary.failed, path: summary.lastOutputPath, results: summary.results });
      }
      let cancelled = false;
      const destination = await window.darkroom.chooseExportDestination({ catalogId: entry.catalogId, sessionId: entry.sessionId, assetIds: [entry.assetId], count: 1, format: "jpeg", suggestedFilename: "photo.jpg" });
      const cancel = await run({ ...base, destinationToken: destination.token, options: { format: "jpeg", size: { mode: "original" }, conflict: "rename" }, isCancelled: () => cancelled, onProgress: (progress) => { if (progress.phase === "render") cancelled = true; } });
      return { summaries, cancelled: cancel.cancelled, failed: cancel.failed };
    }, pixels);
    for (const item of result.summaries) {
      assert.equal(item.failed, 0, JSON.stringify(item.results));
      assert.equal(item.exported, 1);
      const metadata = await sharp(item.path).metadata();
      assert.equal(Math.max(metadata.width, metadata.height), pixels);
      assert.ok(metadata.icc?.length);
      const exif = await exifr.parse(await readFile(item.path));
      if (item.mode === "all") {
        if (raw) assert.match(exif.Model, /NIKON/i);
        assert.equal(exif.Copyright, "Smoke copyright");
        assert.match(metadata.xmp.toString(), /GPSLatitude="55.67"/);
      } else {
        assert.equal(exif?.Model, undefined);
        assert.ok(!metadata.xmp?.toString().includes("GPSLatitude"));
        assert.equal(exif?.Copyright, item.mode === "copyright" ? "Smoke copyright" : undefined);
      }
      report.timingsMs[`export-${item.mode}`] = item.ms;
    }
    assert.equal(new Set(result.summaries.map((item) => item.path)).size, 3);
    assert.equal(result.cancelled, 1);
    assert.equal(result.failed, 0);
  });

  report.processHighWaterMemoryMiB = await Promise.all((await processTree()).map(async ({ pid, name }) => {
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    return { pid, name, peakResident: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) / 1024 };
  }));
  await check("process interruption preserves the masked crop and virtual copy", async () => {
    const processes = await processTree();
    const app = processes.find((item) => item.name === path.basename(executable));
    assert.ok(app, "The launched desktop process is present.");
    process.kill(app.pid, "SIGKILL");
    await request(`/session/${session}`, undefined, "DELETE").catch(() => {});
    session = undefined;
    await launch();
    await page.goto(photoUrl);
    await ready();
    const state = await page.evaluate(() => {
      const ds = window.smokeModule("stores/develop-store.ts").useDevelopStore.getState();
      const ls = window.smokeModule("stores/library-store.ts").useLibraryStore.getState();
      const d = ds.sessions[ds.activeEntryId].persistedDocument;
      return { exposure: d.tone.basic.exposure, crop: d.geometry.crop.enabled, masks: d.local.masks.length, copies: ls.entries.filter((e) => e.entryKind === "virtual").length, error: ds.sessions[ds.activeEntryId].ui.sidecarError };
    });
    assert.deepEqual(state, { exposure: 0.75, crop: true, masks: 1, copies: 1, error: null });
    assert.equal(await page.evaluate(async (id) => {
      const state = window.smokeModule("stores/library-store.ts").useLibraryStore.getState();
      const receipts = await window.darkroom.developBatchList({ catalogId: state.catalogId, sessionId: state.sessionId, limit: 10 });
      return receipts.some((receipt) => receipt.batchId === id && receipt.cancellationRequested);
    }, report.cancelledBatchId), true);
    await page.screenshot({ path: path.join(directory, "reopened.png") });
  });
  const hash = createHash("sha256").update(await readFile(fixture)).digest("hex");
  assert.equal(hash, originalHash);
  assert.equal(createHash("sha256").update(await readFile(path.join(photos, sampleName))).digest("hex"), originalHash);
  report.checks.push("source files unchanged");
} catch (error) {
  report.failure = String(error);
  report.rendererState = await page?.evaluate(() => {
    const state = window.smokeModule?.("stores/develop-store.ts").useDevelopStore.getState();
    const session = state?.sessions[state.activeEntryId];
    return { url: location.href, activeEntryId: state?.activeEntryId, pendingDefaults: state?.pendingDefaultOperations, ui: session?.ui, text: document.body.innerText.slice(-5000) };
  }).catch(() => null);
  throw error;
} finally {
  const remainingApps = (await processTree()).filter((item) => item.name === path.basename(executable));
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  if (session) {
    await page?.screenshot({ path: path.join(directory, "final.png") }).catch(() => {});
    await request(`/session/${session}`, undefined, "DELETE").catch(() => {});
  }
  for (const app of remainingApps) { try { process.kill(app.pid, "SIGTERM"); } catch { /* The driver already reaped it. */ } }
  driver.kill();
  await writeFile(path.join(directory, "driver.log"), driverLog);
  console.log(`Evidence: ${directory}`);
}
