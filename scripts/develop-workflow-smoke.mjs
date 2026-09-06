import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import sharp from "sharp";
import exifr from "exifr";

const root = process.cwd();
const url = process.env.DARKROOM_SMOKE_URL ?? "http://localhost:3000";
await fetch(url);
const directory = await mkdtemp(path.join(os.tmpdir(), "darkroom-develop-smoke-"));
const photos = path.join(directory, "photos");
const outputs = path.join(directory, "exports");
await mkdir(photos);
await mkdir(outputs);
const fixture = process.env.DARKROOM_SMOKE_RAW ?? path.join(root, "test_images/_DSC3972.NEF");
const originalHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
await copyFile(fixture, path.join(photos, "sample.NEF"));
await copyFile(fixture, path.join(photos, "second.NEF"));
const demo = (await readdir(path.join(root, "public/demo"))).find((name) => name.endsWith(".jpg"));
await copyFile(path.join(root, "public/demo", demo), path.join(photos, "demo.jpg"));
const report = { directory, checks: [], timingsMs: {} };
let app;
let page;

async function launch() {
  const env = { ...process.env, ELECTRON_DEV: "1", DARKROOM_DEV_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [root, `--user-data-dir=${path.join(directory, "profile")}`], env });
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (options) => ({ canceled: false, filePaths: [options.title?.includes("Export") ? paths.outputs : paths.photos] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${paths.outputs}/photo.jpg` });
  }, { photos, outputs });
  page = await app.firstWindow();
  await page.waitForURL(`${url}/`);
  await page.waitForFunction(() => window.darkroom?.isElectron);
  await runtime();
}
async function runtime() {
  await page.evaluate(() => {
    window.webpackChunk_N_E.push([[`smoke-${Date.now()}`], {}, (require) => {
      window.smokeModule = (name) => require(`(app-pages-browser)/./${name}`);
    }]);
  });
}
async function ready() {
  await runtime();
  await page.waitForFunction(() => {
    const store = window.smokeModule("stores/develop-store.ts").useDevelopStore.getState();
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
  await page.getByText("sample.NEF", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const started = Date.now();
  await page.getByText("sample.NEF", { exact: true }).dblclick();
  await ready();
  report.timingsMs.openRaw = Date.now() - started;
  const photoUrl = page.url();

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
      return { sizes, different: await small.text() !== await other.text() };
    });
    assert.ok(Math.max(...result.sizes.slice(2)) > Math.max(...result.sizes.slice(0, 2)));
    assert.equal(result.different, true);
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
        for (let index = 0; index < 4; index += 1) {
          const started = performance.now();
          const rendered = await worker.render(document, { viewportDimensions: { width: 900, height: 600 }, devicePixelRatio: 2, previewMode: "interactive", includeAnalysis: false });
          if (rendered.result.kind !== "rendered") throw new Error("Interactive render failed.");
          times.push(performance.now() - started);
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
        return { difference, cachedMs, interactiveMs: times.slice(1).sort((a, b) => a - b)[1] };
      } finally { worker.dispose(); }
    });
    assert.equal(result.difference, 0);
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
    const result = await page.evaluate(async () => {
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
        const summary = await run({ ...base, destinationToken: destination.token, options: { format: "jpeg", size: { mode: "long-edge", pixels: 1200 }, quality: 90, conflict: "rename", metadata: mode, includeLocation: mode === "all" } });
        summaries.push({ mode, ms: performance.now() - started, exported: summary.exported, failed: summary.failed, path: summary.lastOutputPath, results: summary.results });
      }
      let cancelled = false;
      const destination = await window.darkroom.chooseExportDestination({ catalogId: entry.catalogId, sessionId: entry.sessionId, assetIds: [entry.assetId], count: 1, format: "jpeg", suggestedFilename: "photo.jpg" });
      const cancel = await run({ ...base, destinationToken: destination.token, options: { format: "jpeg", size: { mode: "original" }, conflict: "rename" }, isCancelled: () => cancelled, onProgress: (progress) => { if (progress.phase === "render") cancelled = true; } });
      return { summaries, cancelled: cancel.cancelled, failed: cancel.failed };
    });
    for (const item of result.summaries) {
      assert.equal(item.failed, 0, JSON.stringify(item.results));
      assert.equal(item.exported, 1);
      const metadata = await sharp(item.path).metadata();
      assert.equal(Math.max(metadata.width, metadata.height), 1200);
      assert.ok(metadata.icc?.length);
      const exif = await exifr.parse(item.path);
      if (item.mode === "all") {
        assert.match(exif.Model, /NIKON/i);
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

  report.peakProcessMemoryMiB = await app.evaluate(({ app }) => app.getAppMetrics().map((process) => ({ type: process.type, peakWorkingSet: Math.round(process.memory.peakWorkingSetSize / 1024) })));
  await check("process interruption preserves the masked crop and virtual copy", async () => {
    await app.evaluate(() => { setTimeout(() => process.exit(0), 50); });
    await new Promise((resolve) => app.process().once("exit", resolve));
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
  assert.equal(createHash("sha256").update(await readFile(path.join(photos, "sample.NEF"))).digest("hex"), originalHash);
  report.checks.push("source files unchanged");
} finally {
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  await app?.close();
  console.log(`Evidence: ${directory}`);
}
