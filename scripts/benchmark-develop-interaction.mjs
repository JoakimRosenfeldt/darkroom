import assert from "node:assert/strict";

export async function benchmarkDevelopInteraction(page, report) {
  const iterations = Number(process.env.DARKROOM_BENCHMARK_ITERATIONS ?? 12);
  assert.ok(Number.isSafeInteger(iterations) && iterations > 0, "Iterations must be a positive integer");
  const warmup = 3;
  await page.evaluate(() => {
    const store = window.smokeModule("stores/develop-store.ts").useDevelopStore;
    const main = () => [...document.querySelectorAll('canvas[role="img"]')].find((canvas) => !canvas.getAttribute("aria-label")?.includes("full-resolution edited detail"));
    const detail = () => document.querySelector('canvas[aria-label$=", full-resolution edited detail"]');
    const shell = () => main().closest("[aria-busy]");
    const transform = () => shell().querySelector(".will-change-transform");
    const detailShell = () => document.querySelector('[aria-label="100 percent detail; drag to pan"]');
    const draws = [];
    const requests = [];
    const workerResults = [];
    const nativeRequests = [];
    const workerRequests = new WeakMap();
    const nativeSince = (start) => nativeRequests.filter((request) => request.at + (request.durationMs ?? Infinity) >= start)
      .map(({ at, ...request }) => ({ ...request, afterMs: at - start }));
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (!workerRequests.has(this)) {
        const pending = new Map();
        workerRequests.set(this, pending);
        this.addEventListener("message", ({ data }) => {
          if (data.kind === "result") workerResults.push({ at: performance.now(), requestId: data.requestId });
          if (data.kind !== "native-gpu") return;
          const request = { at: performance.now(), inputBytes: data.bytes.byteLength, durationMs: null, outputBytes: null };
          nativeRequests.push(request);
          pending.set(data.id, request);
        });
      }
      if (message?.kind === "native-gpu-result" || message?.kind === "native-gpu-error") {
        const pending = workerRequests.get(this);
        const request = pending.get(message.id);
        if (request) {
          request.durationMs = performance.now() - request.at;
          request.outputBytes = message.bytes?.byteLength ?? 0;
          pending.delete(message.id);
        }
      }
      if (message?.kind === "render" || message?.kind === "export") {
        requests.push({ at: performance.now(), kind: message.kind, mode: message.previewMode, analysis: message.includeAnalysis, pointColor: message.includePointColor, viewport: message.viewportDimensions, size: message.size, region: message.region });
      }
      return originalPostMessage.call(this, message, ...rest);
    };
    let detailAlpha = 1;
    let detailDraws = 0;
    let detailFullArea = 0;
    let serial = 0;
    for (const name of ["drawImage", "putImageData", "clearRect"]) {
      const original = CanvasRenderingContext2D.prototype[name];
      CanvasRenderingContext2D.prototype[name] = function (...args) {
        const started = performance.now();
        const result = original.apply(this, args);
        const submitted = performance.now();
        if (this.canvas === detail()) {
          if (name === "clearRect") { detailAlpha = 1; detailDraws = 0; detailFullArea = 0; }
          else {
            detailAlpha = Math.min(detailAlpha, this.globalAlpha);
            detailDraws += 1;
            if (name === "drawImage" && args.length === 5 && args[3] / args[0].width * devicePixelRatio <= 1.001) {
              const width = this.canvas.width / devicePixelRatio;
              const height = this.canvas.height / devicePixelRatio;
              detailFullArea += Math.max(0, Math.min(width, args[1] + args[3]) - Math.max(0, args[1])) * Math.max(0, Math.min(height, args[2] + args[4]) - Math.max(0, args[2]));
            }
          }
        }
        if (name !== "clearRect" && (this.canvas === main() || this.canvas === detail())) {
          draws.push({ at: submitted, kind: this.canvas === main() ? "main" : "detail", alpha: this.globalAlpha, width: this.canvas.width, height: this.canvas.height, durationMs: submitted - started, scale: name === "drawImage" && args.length === 5 ? Math.round(args[3] / args[0].width * devicePixelRatio * 1000) / 1000 : null });
        }
        return result;
      };
    }
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const button = (text) => [...shell().querySelectorAll("button")].find((item) => item.textContent.trim().toLowerCase() === text.toLowerCase());
    const autoTone = () => [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "Auto" && item.hasAttribute("title"));
    const detailReady = () => detailShell()?.getAttribute("aria-busy") === "false" && detailDraws > 0 && detailFullArea >= detail().width * detail().height / devicePixelRatio ** 2 * 0.9999;
    async function until(predicate, label) {
      const start = performance.now();
      while (!predicate()) {
        if (performance.now() - start > 30_000) throw new Error(`Timed out: ${label}`);
        await frame();
      }
    }
    function changeTone(index) {
      const state = store.getState();
      const current = state.sessions[state.activeEntryId].previewDocument;
      state.dispatchV3({ kind: "patch-v3-semantic-group", group: "tone", patch: { basic: { ...current.tone.basic, exposure: 0.1 + index * 0.017, contrast: (index % 7) * 0.01 } } }, "Interaction benchmark");
    }
    async function measureEdit(index) {
      const begin = draws.length;
      const requestBegin = requests.length;
      const start = performance.now();
      changeTone(index);
      await until(() => draws.slice(begin).some((draw) => draw.kind === "main"), "changed edit painted");
      const first = draws.slice(begin).find((draw) => draw.kind === "main");
      return { submittedMs: first.at - start, paintOpportunityMs: performance.now() - start, width: first.width, height: first.height, requests: requests.slice(requestBegin).map(({ at, ...request }) => ({ ...request, afterMs: at - start })), nativeRequests: nativeSince(start) };
    }
    async function measureView(trigger, label) {
      const before = getComputedStyle(transform()).transform;
      const begin = draws.length;
      const requestBegin = requests.length;
      const start = performance.now();
      trigger();
      let firstVisualMs;
      let firstDetailMs;
      await until(() => {
        if (firstVisualMs === undefined && getComputedStyle(transform()).transform !== before) firstVisualMs = performance.now() - start;
        const first = draws.slice(begin).find((draw) => draw.kind === "detail");
        if (first && firstDetailMs === undefined) firstDetailMs = first.at - start;
        return firstVisualMs !== undefined && firstDetailMs !== undefined && detailReady();
      }, label);
      const readyMs = performance.now() - start;
      await until(() => detailAlpha >= 1, `${label} fully opaque`);
      const viewDraws = draws.slice(begin).filter((draw) => draw.kind === "detail");
      const drawScales = {};
      for (const draw of viewDraws) drawScales[draw.scale] = (drawScales[draw.scale] ?? 0) + 1;
      return { firstVisualMs, firstDetailMs, readyMs, fullyOpaqueMs: performance.now() - start, width: detail().width, height: detail().height, drawCount: viewDraws.length, drawCpuMs: viewDraws.reduce((sum, draw) => sum + draw.durationMs, 0), drawScales, requests: requests.slice(requestBegin).map(({ at, ...request }) => ({ ...request, afterMs: at - start })), nativeRequests: nativeSince(start) };
    }
    window.interactionBenchmark = {
      async rapidDrag() {
        button("Fit").click();
        await delay(350);
        await until(() => autoTone()?.disabled === false, "settled analysis before rapid drag");
        store.getState().beginEditGroup("Rapid interaction benchmark");
        await delay(200);
        const begin = draws.length;
        const resultBegin = workerResults.length;
        const requestBegin = requests.length;
        const start = performance.now();
        const inputs = [];
        let histogramUpdates = 0;
        const histogram = () => document.querySelector('svg[aria-label^="Full-frame RGB histogram"]')?.innerHTML;
        let previousHistogram = histogram();
        let autoDisabledDuringDrag = true;
        while (performance.now() - start < 500) {
          inputs.push(performance.now() - start);
          changeTone(++serial);
          await delay(16);
          autoDisabledDuringDrag &&= autoTone()?.disabled === true;
          const currentHistogram = histogram();
          if (currentHistogram !== previousHistogram) { histogramUpdates += 1; previousHistogram = currentHistogram; }
        }
        const released = performance.now();
        store.getState().endEditGroup();
        await until(() => draws.slice(begin).some((draw) => draw.kind === "main" && draw.at >= released) && shell().getAttribute("aria-busy") === "false", "rapid drag final frame");
        const mainDraws = draws.slice(begin).filter((draw) => draw.kind === "main");
        return { histogramUpdates, autoDisabledDuringDrag, durationMs: released - start, inputsMs: inputs, paintsDuringDrag: mainDraws.filter((draw) => draw.at < released).length, paintsMs: mainDraws.map((draw) => draw.at - start), workerResultsDuringDrag: workerResults.slice(resultBegin).filter((result) => result.at < released).length, firstPaintAfterReleaseMs: mainDraws.find((draw) => draw.at >= released).at - released, settledAfterReleaseMs: performance.now() - released, requests: requests.slice(requestBegin).map(({ at, ...request }) => ({ ...request, afterMs: at - start })), nativeRequests: nativeSince(start) };
      },
      async cancelDrag() {
        await until(() => autoTone()?.disabled === false, "settled tone analysis");
        await delay(350);
        const before = main().getContext("2d").getImageData(0, 0, main().width, main().height);
        const current = store.getState();
        const documentBefore = JSON.stringify(current.sessions[current.activeEntryId].persistedDocument);
        current.beginEditGroup("Cancelled interaction benchmark");
        for (let index = 0; index < 8; index++) { changeTone(++serial); await delay(16); }
        const cancelled = performance.now();
        store.getState().cancelEditGroup();
        await until(() => shell().getAttribute("aria-busy") === "false" && autoTone()?.disabled === false, "cancelled drag restored");
        await delay(100);
        const after = main().getContext("2d").getImageData(0, 0, main().width, main().height);
        const state = store.getState();
        return { restoredMs: performance.now() - cancelled, documentRestored: JSON.stringify(state.sessions[state.activeEntryId].persistedDocument) === documentBefore, pixelsRestored: before.width === after.width && before.height === after.height && before.data.every((value, index) => value === after.data[index]), width: after.width, height: after.height };
      },
      async edits(iterations) {
        store.getState().beginEditGroup("Interaction benchmark");
        await delay(200);
        const samples = [];
        for (let index = 0; index < iterations; index++) samples.push(await measureEdit(++serial));
        store.getState().endEditGroup();
        await delay(350);
        return samples;
      },
      async pausedZoomedEdit() {
        store.getState().beginEditGroup("Paused zoomed interaction benchmark");
        await delay(200);
        const begin = draws.length;
        const start = performance.now();
        changeTone(++serial);
        await until(() => draws.slice(begin).some((draw) => draw.kind === "main") && draws.slice(begin).some((draw) => draw.kind === "detail") && detailReady(), "paused zoomed edit full detail");
        const fullDetailMs = performance.now() - start;
        store.getState().endEditGroup();
        return { fullDetailMs, width: detail().width, height: detail().height };
      },
      async zoomedEdits(iterations) {
        store.getState().beginEditGroup("Zoomed interaction benchmark");
        await delay(200);
        const samples = [];
        for (let index = 0; index < iterations; index++) samples.push(await measureEdit(++serial));
        const released = performance.now();
        store.getState().endEditGroup();
        await frame();
        await until(detailReady, "zoomed edit detail restored");
        return { samples, detailRestoredMs: performance.now() - released };
      },
      async zooms(iterations) {
        const samples = [];
        for (let index = 0; index < iterations; index++) {
          button("Fit").click();
          await delay(220);
          samples.push(await measureView(() => button("100%").click(), "100% detail ready"));
          await delay(220);
        }
        return samples;
      },
      armPan() {
        const target = shell();
        const box = target.getBoundingClientRect();
        window.interactionPan = null;
        const listener = (event) => {
          if (event.buttons !== 1) return;
          target.removeEventListener("pointermove", listener, true);
          window.interactionPan = measureView(() => {}, "panned detail ready");
        };
        target.addEventListener("pointermove", listener, true);
        return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      },
      async finishPan() {
        if (!window.interactionPan) throw new Error("Pointer move did not reach the photo");
        const sample = await window.interactionPan;
        await delay(100);
        return sample;
      },
      async snapshot() {
        const state = store.getState();
        const ls = window.smokeModule("stores/library-store.ts").useLibraryStore.getState();
        const entry = ls.entries.find((item) => item.id === state.activeEntryId);
        const image = await window.smokeModule("lib/cache/develop-image-cache.ts").loadDevelopExportImage(entry);
        return { source: { width: image.width, height: image.height }, viewport: { width: shell().clientWidth, height: shell().clientHeight, dpr: devicePixelRatio }, main: { width: main().width, height: main().height }, native: await window.__TAURI_INTERNALS__.invoke("darkroom_gpu_info") };
      },
    };
  });
  const summarize = (samples) => {
    const measured = samples.slice(warmup);
    return {
      warmupSamples: samples.slice(0, warmup), samples: measured,
      metrics: Object.fromEntries(Object.keys(measured[0]).filter((key) => key.endsWith("Ms")).map((key) => {
        const values = measured.map((sample) => sample[key]).filter(Number.isFinite).sort((a, b) => a - b);
        return [key, { p50: values[Math.ceil(values.length * 0.5) - 1], p95: values[Math.ceil(values.length * 0.95) - 1] }];
      })),
    };
  };
  const initial = await page.evaluate(() => window.interactionBenchmark.snapshot());
  assert.ok(["Vulkan", "Metal"].includes(initial.native.backend));
  assert.ok(initial.source.width >= initial.viewport.width * initial.viewport.dpr && initial.source.height >= initial.viewport.height * initial.viewport.dpr, "The benchmark photo must cover the viewport at 100%");
  report.interactionBenchmark = { initial };
  const editSamples = await page.evaluate((count) => window.interactionBenchmark.edits(count), iterations + warmup);
  report.interactionBenchmark.edit = summarize(editSamples);
  const zoomSamples = await page.evaluate((count) => window.interactionBenchmark.zooms(count), iterations + warmup);
  report.interactionBenchmark.zoom = summarize(zoomSamples);
  const panSamples = [];
  for (let index = 0; index < iterations + warmup; index++) {
    const { x, y } = await page.evaluate(() => window.interactionBenchmark.armPan());
    await page.performActions([{ type: "pointer", id: "photo-pan", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", duration: 0, origin: "viewport", x, y },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 0, origin: "viewport", x: x + (index % 2 ? -160 : 160), y: y + (index % 2 ? -80 : 80) },
      { type: "pointerUp", button: 0 },
    ] }]);
    panSamples.push(await page.evaluate(() => window.interactionBenchmark.finishPan()));
  }
  report.interactionBenchmark.pan = summarize(panSamples);
  const zoomedEdit = await page.evaluate((count) => window.interactionBenchmark.zoomedEdits(count), iterations + warmup);
  report.interactionBenchmark.zoomedEdit = { ...summarize(zoomedEdit.samples), detailRestoredMs: zoomedEdit.detailRestoredMs };
  const pausedZoomedEdit = await page.evaluate(() => window.interactionBenchmark.pausedZoomedEdit());
  report.interactionBenchmark.pausedZoomedEdit = pausedZoomedEdit;
  const rapidDrag = await page.evaluate(() => window.interactionBenchmark.rapidDrag());
  report.interactionBenchmark.rapidDrag = rapidDrag;
  let cancelledDrag;
  try { cancelledDrag = await page.evaluate(() => window.interactionBenchmark.cancelDrag()); }
  catch (error) { cancelledDrag = { failure: String(error) }; }
  report.interactionBenchmark = {
    method: "In-page performance.now; canvas draw interception and requestAnimationFrame followed by a task. This records frame submission and the next paint opportunity, not compositor presentation. Edits change exposure and contrast inside a real edit group. Zoom uses the 100% button; panning uses trusted WebDriver pointer actions. Detail readiness requires full-resolution coverage; fullyOpaque also includes tile fades. JPEG fixture resized to 4000px wide. Three warmup samples excluded from quantiles. The first zoom warmup sample records cold detail latency.",
    initial, final: await page.evaluate(() => window.interactionBenchmark.snapshot()),
    rapidDrag, cancelledDrag, pausedZoomedEdit,
    edit: summarize(editSamples), zoom: summarize(zoomSamples), pan: summarize(panSamples),
    zoomedEdit: { ...summarize(zoomedEdit.samples), detailRestoredMs: zoomedEdit.detailRestoredMs },
    idleFrameIntervalsMs: await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const intervals = [];
      let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
      for (let index = 0; index < 60; index++) {
        const next = await new Promise((resolve) => requestAnimationFrame(resolve));
        intervals.push(next - previous);
        previous = next;
      }
      const sorted = [...intervals].sort((a, b) => a - b);
      return { samples: intervals, p50: sorted[29], p95: sorted[56], max: sorted[59] };
    }),

  };
  for (const kind of ["edit", "zoom", "pan", "zoomedEdit"]) console.log(`${kind}: ${JSON.stringify(report.interactionBenchmark[kind].metrics)}`);
  const budgets = { edit: ["paintOpportunityMs", Number(process.env.DARKROOM_BENCHMARK_EDIT_P95_MS ?? Infinity)], zoom: ["readyMs", Number(process.env.DARKROOM_BENCHMARK_ZOOM_P95_MS ?? Infinity)], pan: ["firstVisualMs", Number(process.env.DARKROOM_BENCHMARK_PAN_P95_MS ?? Infinity)] };
  for (const [kind, [metric, budget]] of Object.entries(budgets)) {
    assert.ok(report.interactionBenchmark[kind].metrics[metric].p95 <= budget, `${kind} p95 exceeded ${budget}ms`);
  }
  assert.ok(cancelledDrag.documentRestored && cancelledDrag.pixelsRestored, "Cancelling a drag must restore its document and exact settled pixels");
  assert.ok(rapidDrag.autoDisabledDuringDrag, "Auto Tone must stay disabled during a transient drag");
  const minimumDragPaints = Number(process.env.DARKROOM_BENCHMARK_MIN_DRAG_PAINTS ?? 0);
  assert.ok(rapidDrag.paintsDuringDrag >= minimumDragPaints, `Rapid drag painted fewer than ${minimumDragPaints} frames`);
  const coldZoomBudget = Number(process.env.DARKROOM_BENCHMARK_COLD_ZOOM_MS ?? Infinity);
  assert.ok(zoomSamples[0].readyMs <= coldZoomBudget, `Cold zoom exceeded ${coldZoomBudget}ms`);
}
