import { V3GpuPreviewRenderer } from "../lib/develop/v3/gpu-backend.ts";
import { setNativeGpuTransport } from "../lib/develop/v3/native-context.ts";
import { prepareV3RuntimeRender } from "../lib/develop/v3/runtime.ts";
import { createDefaultV3DevelopDocument } from "../lib/develop/v3/document.ts";
import { DEFAULT_LOCAL_ADJUSTMENTS } from "../lib/develop/v3/local-adjustments.ts";
import { renderV3Cpu } from "../lib/develop/v3/cpu-backend.ts";

setNativeGpuTransport(async (bytes) => {
  const response = await fetch("/gpu", { method: "POST", body: bytes });
  if (!response.ok) throw new Error(await response.text());
  return response.arrayBuffer();
});

async function nativeInfo() {
  const metadata = new TextEncoder().encode(JSON.stringify({ session: "benchmark-info", info: true }));
  const request = new Uint8Array(4 + metadata.length);
  new DataView(request.buffer).setUint32(0, metadata.length, true);
  request.set(metadata, 4);
  const response = await fetch("/gpu", { method: "POST", body: request });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

const entry = {
  id: "native-renderer-benchmark", catalogId: "native-renderer-benchmark",
  assetRevision: 1, relativePath: "fixture.jpg", size: 1, lastModified: 1,
};

function image(width = 80, height = 64, bits = 8, orientation = 1) {
  const rgb = bits === 8 ? new Uint8Array(width * height * 3) : new Uint16Array(width * height * 3);
  const maximum = 2 ** bits - 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    rgb[offset] = Math.round(maximum * (0.04 + 0.89 * x / Math.max(1, width - 1)));
    rgb[offset + 1] = Math.round(maximum * (0.07 + 0.86 * y / Math.max(1, height - 1)));
    rgb[offset + 2] = Math.round(maximum * (0.04 + 0.88 * ((x * 13 + y * 7) % 97) / 96));
  }
  return {
    width: orientation >= 5 ? height : width, height: orientation >= 5 ? width : height,
    sourceWidth: width, sourceHeight: height, orientation, rgb, bits, colors: 3,
    metadata: {},
    pixelProvenance: {
      decoderPath: "processed-standard", decoderRevision: "benchmark-1",
      colorSpace: "srgb", transfer: "encoded", bitDepth: bits,
      cameraProfileStage: { kind: "unavailable", reason: "Synthetic sRGB fixture" },
    },
  };
}

async function prepare(document, source, preview = false) {
  const request = preview ? {
    kind: "v3-preview", viewportDimensions: { width: source.width, height: source.height },
    devicePixelRatio: 1, previewMode: "settled", includeAnalysis: true, includePointColor: true,
  } : { kind: "v3-export", size: { mode: "original" }, format: "jpeg", includeAnalysis: false };
  const prepared = await prepareV3RuntimeRender(document, { ...request, entry, image: source });
  if (prepared.kind !== "prepared") throw new Error(`Preparation failed: ${JSON.stringify(prepared)}`);
  return prepared.input;
}

function pixels(result) {
  if (result?.kind !== "rendered") throw new Error(`Render failed: ${JSON.stringify(result)}`);
  if (!("bitmap" in result)) return result.pixels.pixels;
  const canvas = new OffscreenCanvas(result.dimensions.width, result.dimensions.height);
  const context = canvas.getContext("2d");
  context.drawImage(result.bitmap, 0, 0);
  result.bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

function difference(left, right) {
  if (left.length !== right.length) throw new Error(`Pixel lengths differ: ${left.length} versus ${right.length}`);
  let maximum = 0;
  let sum = 0;
  let changed = 0;
  for (let index = 0; index < left.length; index++) {
    const delta = Math.abs(left[index] - right[index]);
    maximum = Math.max(maximum, delta);
    sum += delta;
    if (delta !== 0) changed++;
  }
  return { maximum, mean: sum / left.length, changed, samples: left.length };
}

function compareAnalysis(actual, expected) {
  let maximumScalarDelta = 0;
  let maximumHistogramBinDelta = 0;
  let structureMatches = true;
  const visit = (left, right, field = "") => {
    if (Array.isArray(left) && field.includes("histogram")) {
      if (!Array.isArray(right) || left.length !== right.length) { structureMatches = false; return; }
      let cumulative = 0;
      let distance = 0;
      for (let index = 0; index < left.length; index++) {
        cumulative += left[index] - right[index];
        distance += Math.abs(cumulative);
      }
      if (cumulative !== 0) structureMatches = false;
      maximumHistogramBinDelta = Math.max(maximumHistogramBinDelta, distance / Math.max(1, left.reduce((sum, count) => sum + count, 0)));
    } else if (typeof left === "number" && typeof right === "number") {
      maximumScalarDelta = Math.max(maximumScalarDelta, Math.abs(left - right));
    } else if (left !== null && typeof left === "object" && right !== null && typeof right === "object") {
      if (Object.keys(left).length !== Object.keys(right).length) structureMatches = false;
      for (const key of Object.keys(left)) visit(left[key], right[key], `${field}.${key}`);
    } else if (left !== right) structureMatches = false;
  };
  visit(actual, expected);
  return { maximumScalarDelta, maximumHistogramBinDelta, structureMatches,
    passed: structureMatches && maximumScalarDelta <= 0.005 && maximumHistogramBinDelta <= 1 };
}

function mask(index) {
  const adjustments = structuredClone(DEFAULT_LOCAL_ADJUSTMENTS);
  Object.assign(adjustments.basic, { exposure: 0.35, saturation: -12, temperature: 18, tint: -7 });
  Object.assign(adjustments, { texture: 8, clarity: 12, sharpness: 15, noise: 7, moire: 9, defringe: 4 });
  adjustments.colorize = { color: [0.7, 0.2, 0.1], amount: 15 };
  return {
    id: `mask-${index}`, name: `Mask ${index}`, enabled: true, adjustments,
    expression: {
      kind: "source", id: `source-${index}`, enabled: true,
      source: index % 2 ? {
        kind: "radial-gradient", center: { x: 0.45, y: 0.55 }, radiusX: 0.33,
        radiusY: 0.4, rotation: 17, feather: 60,
      } : { kind: "linear-gradient", start: { x: 0.1, y: 0.2 }, end: { x: 0.8, y: 0.9 } },
    },
  };
}

const cases = [
  ["neutral", () => {}],
  ["tone", (d) => Object.assign(d.tone.basic, { exposure: 0.8, contrast: 23, highlights: -36, shadows: 27, whites: -12, blacks: 17 })],
  ["curves", (d) => { d.tone.curves.rgb = [{ x: 0, y: 0 }, { x: 0.27, y: 0.19 }, { x: 0.7, y: 0.82 }, { x: 1, y: 1 }]; d.tone.curves.red = [{ x: 0, y: 0.03 }, { x: 1, y: 0.96 }]; }],
  ["white-balance-and-calibration", (d) => { d.color.whiteBalance.resolved.gains = [1.14, 0.96, 0.87]; d.color.inputProfile.calibration = { matrixToLinearSrgb: [0.91, 0.05, 0.04, 0.03, 0.95, 0.02, 0.04, 0.06, 0.9], channelScale: [0.9, 1.03, 1.08], exposureOffsetEv: 0.15 }; }],
  ["mixer-and-global-color", (d) => { d.color.global = { saturation: 12, vibrance: -18 }; for (const [index, band] of Object.values(d.color.mixer).entries()) Object.assign(band, { hue: index * 4 - 12, saturation: 24 - index * 5, luminance: index * 3 - 9 }); }],
  ["point-color", (d) => { d.color.pointColor.adjustments = [{ id: "sample", enabled: true, sourceHueDegrees: 40, sourceSaturation: 0.6, sourceLuminance: 0.5, hueRangeDegrees: 75, saturationRange: 0.5, luminanceRange: 0.6, falloff: 0.5, hueShiftDegrees: 27, saturationShift: -18, luminanceShift: 11 }]; }],
  ["monochrome", (d) => { d.color.monochrome.enabled = true; d.color.monochrome.mixer.red = 22; d.color.monochrome.mixer.blue = -18; }],
  ["grading", (d) => { d.color.grading.shadows = { hueDegrees: 220, saturation: 24, luminance: -7 }; d.color.grading.midtones = { hueDegrees: 30, saturation: 11, luminance: 5 }; d.color.grading.highlights = { hueDegrees: 60, saturation: 16, luminance: 9 }; d.color.grading.balance = 15; d.color.grading.blending = 63; }],
  ["denoise", (d) => Object.assign(d.detail.noiseReduction, { noiseReduction: 37, noiseDetail: 66, noiseContrast: 23, colorNoiseReduction: 43, colorNoiseDetail: 38, colorNoiseSmoothness: 74 })],
  ["spatial", (d) => { d.presence = { texture: 26, clarity: -14, dehaze: 19 }; Object.assign(d.detail.sharpening, { sharpening: 39, sharpenRadius: 1.3, sharpenDetail: 44, sharpenMasking: 20 }); }],
  ["grain-and-vignette", (d) => Object.assign(d.effects.postCrop, { vignette: -27, vignetteMidpoint: 37, vignetteRoundness: 23, vignetteFeather: 68, vignetteHighlights: 33, grain: 25, grainSize: 41, grainRoughness: 59 })],
  ["crop-and-geometry", (d) => { Object.assign(d.geometry.crop, { enabled: true, x: 0.13, y: 0.18, width: 0.7, height: 0.65 }); d.geometry.orientation.fineAngleDegrees = 4; d.optics.manualDistortion = 8; }],
  ["two-local-masks", (d) => { d.local.masks = [mask(0), mask(1)]; }],
  ["nine-local-masks", (d) => { d.local.masks = Array.from({ length: 9 }, (_, index) => mask(index)); }],
];

window.runNativeRendererBenchmark = async function () {
  const checks = [];
  const context = document.createElement("canvas").getContext("webgl2");
  const debug = context?.getExtension("WEBGL_debug_renderer_info");
  const webglAdapter = debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unavailable";
  context?.getExtension("WEBGL_lose_context")?.loseContext();
  const source = image();
  for (const [name, edit] of cases) {
    const document = structuredClone(createDefaultV3DevelopDocument());
    edit(document);
    const input = await prepare(document, source);
    const native = new V3GpuPreviewRenderer("native");
    const webgl = new V3GpuPreviewRenderer("webgl");
    try {
      const actual = pixels(await native.renderExport(input));
      const expected = pixels(await webgl.renderExport(input));
      const cpu = pixels(await renderV3Cpu(input));
      const delta = difference(actual, expected);
      checks.push({ name, nativeVsWebgl: delta, nativeVsCpu: difference(actual, cpu), passed: delta.maximum <= 2 });
      console.info(JSON.stringify(checks.at(-1)));
    } finally { native.dispose(); webgl.dispose(); }
  }
  for (const bits of [10, 12, 14, 16]) {
    const native = new V3GpuPreviewRenderer("native");
    const webgl = new V3GpuPreviewRenderer("webgl");
    try {
      const input = await prepare(createDefaultV3DevelopDocument(), image(83, 61, bits));
      const delta = difference(pixels(await native.renderExport(input)), pixels(await webgl.renderExport(input)));
      checks.push({ name: `${bits}-bit-source`, nativeVsWebgl: delta, passed: delta.maximum <= 2 });
    } finally { native.dispose(); webgl.dispose(); }
  }
  for (const kind of ["rgba8", "linear16"]) {
    const source = image(83, 61, kind === "linear16" ? 16 : 8);
    if (kind === "linear16") {
      source.pixelProvenance.decoderPath = "nikon-sdk";
      source.pixelProvenance.transfer = "linear";
    } else {
      const rgba = new Uint8Array(source.sourceWidth * source.sourceHeight * 4);
      for (let pixel = 0; pixel < rgba.length / 4; pixel++) {
        rgba.set(source.rgb.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
        rgba[pixel * 4 + 3] = pixel % 256;
      }
      source.colors = 4;
      source.rgb = rgba;
    }
    const native = new V3GpuPreviewRenderer("native");
    const webgl = new V3GpuPreviewRenderer("webgl");
    try {
      const input = await prepare(createDefaultV3DevelopDocument(), source);
      const actual = pixels(await native.renderExport(input));
      const delta = difference(actual, pixels(await webgl.renderExport(input)));
      const cpuDelta = difference(actual, pixels(await renderV3Cpu(input)));
      checks.push({ name: `${kind}-source`, nativeVsWebgl: delta, nativeVsCpu: cpuDelta, passed: delta.maximum <= 2 && cpuDelta.maximum <= 2 });
    } finally { native.dispose(); webgl.dispose(); }
  }
  for (let orientation = 2; orientation <= 8; orientation++) {
    const native = new V3GpuPreviewRenderer("native");
    const webgl = new V3GpuPreviewRenderer("webgl");
    try {
      const input = await prepare(createDefaultV3DevelopDocument(), image(83, 61, 8, orientation));
      const delta = difference(pixels(await native.renderExport(input)), pixels(await webgl.renderExport(input)));
      checks.push({ name: `orientation-${orientation}`, nativeVsWebgl: delta, passed: delta.maximum <= 2 });
    } finally { native.dispose(); webgl.dispose(); }
  }
  {
    const native = new V3GpuPreviewRenderer("native");
    const webgl = new V3GpuPreviewRenderer("webgl");
    try {
      const input = await prepare(createDefaultV3DevelopDocument(), source, true);
      const actual = await native.render(input, { includeAnalysis: true });
      const expected = await webgl.render(input, { includeAnalysis: true });
      const delta = difference(pixels(actual), pixels(expected));
      const pointColor = difference(actual.pointColorInput.pixels, expected.pointColorInput.pixels);
      const analysis = compareAnalysis(actual.analysis, expected.analysis);
      checks.push({ name: "preview-analysis-and-point-color", nativeVsWebgl: delta, pointColor, analysis, passed: delta.maximum <= 2 && pointColor.maximum <= 0.005 && analysis.passed });
    } finally { native.dispose(); webgl.dispose(); }
  }
  {
    const document = structuredClone(createDefaultV3DevelopDocument());
    cases.find(([name]) => name === "grain-and-vignette")[1](document);
    cases.find(([name]) => name === "spatial")[1](document);
    const native = new V3GpuPreviewRenderer("native");
    const webgl = new V3GpuPreviewRenderer("webgl");
    try {
      const input = await prepare(document, image(2051, 1537));
      const whole = pixels(await native.renderExport(input));
      const reference = pixels(await webgl.renderExport(input));
      const cpu = pixels(await renderV3Cpu(input));
      const region = { x: 1010, y: 1010, width: 61, height: 59 };
      const part = pixels(await native.renderRegion(input, region));
      const cropped = new Uint8Array(part.length);
      for (let y = 0; y < region.height; y++) cropped.set(whole.subarray(((y + region.y) * 2051 + region.x) * 4, ((y + region.y) * 2051 + region.x + region.width) * 4), y * region.width * 4);
      const delta = difference(whole, reference);
      const cpuDelta = difference(whole, cpu);
      const webglCpuDelta = difference(reference, cpu);
      const regionDelta = difference(part, cropped);
      checks.push({ name: "tiled-export-and-region", dimensions: { width: 2051, height: 1537 }, region,
        nativeVsWebgl: delta, nativeVsCpu: cpuDelta, webglVsCpu: webglCpuDelta, regionDelta,
        criterion: "Native output must match the CPU reference within 2/255 per channel; export regions must match exactly.",
        passed: cpuDelta.maximum <= 2 && regionDelta.maximum === 0 });
    } finally { native.dispose(); webgl.dispose(); }
  }
  const timings = [];
  for (const operation of ["preview", "export"]) for (const backend of ["native", "webgl"]) {
    const renderer = new V3GpuPreviewRenderer(backend);
    const source = image(1280, 800);
    try {
      const document = structuredClone(createDefaultV3DevelopDocument());
      cases.find(([name]) => name === "spatial")[1](document);
      const samples = [];
      const nativeFrames = [];
      for (let index = 0; index < 6; index++) {
        document.tone.basic.exposure = index * 0.05;
        const input = await prepare(document, source, operation === "preview");
        input.includePointColor = false;
        const start = performance.now();
        const result = operation === "preview"
          ? await renderer.render(input, { includeAnalysis: false }) : await renderer.renderExport(input);
        if (result?.kind !== "rendered") throw new Error(`${backend} benchmark render failed.`);
        const durationMs = performance.now() - start;
        if ("bitmap" in result) result.bitmap.close();
        samples.push(durationMs);
        if (backend === "native") nativeFrames.push(await nativeInfo());
      }
      const warm = samples.slice(2).sort((a, b) => a - b);
      timings.push({ backend, operation, width: source.width, height: source.height, coldMs: samples[0], warmMs: samples.slice(2), medianWarmMs: (warm[1] + warm[2]) / 2, ...(nativeFrames.length ? { nativeFrames } : {}) });
    } finally { renderer.dispose(); }
  }
  return { checks, timings, passed: checks.every((check) => check.passed), webglAdapter, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency };
};
