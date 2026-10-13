import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createAssetId, createCatalogId, createEntryId, createRootId, createSourceId } from "../lib/catalog/ids.ts";
import { createSessionId } from "../lib/catalog/runtime.ts";
import { COORDINATE_FRAME_REVISION } from "../lib/develop/process.ts";
import { parseSha256Digest } from "../lib/develop/render-contract.ts";
import type { DevelopImage } from "../lib/cache/develop-image-cache.ts";
import type { LibraryEntry } from "../lib/fs/types.ts";
import type { DevelopAssetReadResult } from "../lib/develop/v3/asset-store.ts";
import type { DevelopAssetDescriptor, DevelopAssetRef } from "../lib/develop/v3/assets.ts";
import type { V3PreviewWorkerMaskMatte } from "../lib/develop/v3/preview-worker-types.ts";

const temporary = await mkdtemp(join(process.cwd(), ".raw-depth-test-"));
after(() => rm(temporary, { recursive: true, force: true }));
const output = join(temporary, "modules.mjs");
await build({
  stdin: { contents: ["runtime", "document", "local-adjustments"].map((name) =>
    `export * from "./lib/develop/v3/${name}.ts";`).join("\n") + '\nexport * from "./lib/raw/libraw-client.ts";', resolveDir: process.cwd() },
  outfile: output, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent",
});
const modules = await import(pathToFileURL(output).href);
const runtime: typeof import("../lib/develop/v3/runtime.ts") = modules;
const documents: typeof import("../lib/develop/v3/document.ts") = modules;
const adjustments: typeof import("../lib/develop/v3/local-adjustments.ts") = modules;
const raw: typeof import("../lib/raw/libraw-client.ts") = modules;

test("camera-profile WASM settings use all six gamma coefficients and v2 provenance", async () => {
  const options = { cameraProfile: { kind: "libraw-camera-matrix" }, sourcePixels: true } as const;
  assert.deepEqual(raw.buildSettings(options, true).gamm, [1, 1, 0, 0, 0, 0]);
  const image = await raw.buildFromImageData({ data: new Uint16Array([100, 200, 300]), width: 1, height: 1, bits: 16, colors: 3 }, {
    camera_make: "Nikon", camera_model: "Test", color_data: { rgb_cam: [[1.1, -0.1, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
  }, options);
  assert.equal(image.pixelProvenance.transfer, "linear");
  assert.equal(image.pixelProvenance.decoderRevision, "darkroom-libraw-linear-camera-v2");
  assert.equal(image.pixelProvenance.cameraProfileStage.kind, "available");
});

function depthBytes(values: number[]): Uint8Array {
  const bytes = new Uint8Array(24 + values.length * 4);
  bytes.set(new TextEncoder().encode("DRDEPTH\0"));
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  bytes.set([1, 1], 10);
  view.setUint32(12, values.length, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, values.length * 4, true);
  values.forEach((value, index) => view.setFloat32(24 + index * 4, value, true));
  return bytes;
}

test("depth raster decoding validates the header, size and float values", () => {
  const descriptor = { dimensions: { width: 3, height: 1 }, byteLength: 36 };
  assert.deepEqual(runtime.decodeV3DepthAsset(descriptor, depthBytes([0, 0.5, 1])).pixels, new Uint8Array([0, 128, 255]));
  for (const value of [NaN, Infinity, -0.1, 1.1]) {
    assert.throws(() => runtime.decodeV3DepthAsset(descriptor, depthBytes([0, value, 1])), /values/);
  }
  const corrupt = depthBytes([0, 0.5, 1]);
  corrupt[8] = 2;
  assert.throws(() => runtime.decodeV3DepthAsset(descriptor, corrupt), /header/);
  assert.throws(() => runtime.decodeV3DepthAsset(descriptor, corrupt.subarray(1)), /size or signature/);
});

test("accepted depth masks render in preview and export; missing and stale assets block export", async () => {
  const entry: LibraryEntry = {
    id: createEntryId(), sourceId: createSourceId(), assetId: createAssetId(), catalogId: createCatalogId(),
    sessionId: createSessionId(), rootId: createRootId(), name: "photo.png", relativePath: "photo.png", size: 10,
    lastModified: 1, profileId: "standard", assetRevision: 1, health: "present", formatId: "png",
    formatAvailability: { status: "supported", reason: null }, entryCreatedAt: 1,
    entryKind: "original", parentEntryId: null, displayName: null,
  };
  const image: DevelopImage = {
    width: 2, height: 1, sourceWidth: 2, sourceHeight: 1, orientation: 1, metadata: {},
    rgb: new Uint8Array([80, 80, 80, 80, 80, 80]), bits: 8, colors: 3,
    pixelProvenance: { decoderPath: "processed-standard", decoderRevision: "test", colorSpace: "srgb", transfer: "encoded", bitDepth: 8,
      cameraProfileStage: { kind: "unavailable", reason: "Rendered sRGB" } },
  };
  const source = runtime.buildV3SourceRecord(entry, image, "preview");
  assert.equal(source.kind, "source");
  if (source.kind !== "source") return;
  const digest = parseSha256Digest("a".repeat(64));
  const reference: DevelopAssetRef = { assetId: digest, sha256: digest, kind: "depth-map", producerRevision: "1",
    coordinateFrameRevision: COORDINATE_FRAME_REVISION, colorStageId: "canonical-geometry" };
  const bytes = depthBytes([0.5, 1]);
  const descriptor: DevelopAssetDescriptor = { ...reference, producerId: "builtin-prototype-depth-v1", sourceSignature: source.source.signature,
    dimensions: { width: 2, height: 1 }, byteLength: bytes.byteLength, mimeType: "application/x-darkroom-depth" };
  const neutral = documents.createDefaultV3DevelopDocument();
  const local = adjustments.createDefaultLocalAdjustments();
  const document = { ...neutral, local: { ...neutral.local, maskAssetRefs: [reference], masks: [{
    id: "depth", name: "Depth", enabled: true, adjustments: { ...local, basic: { ...local.basic, exposure: 1 } },
    expression: { kind: "source", id: "range", enabled: true, source: { kind: "depth-range", asset: reference,
      source: source.source.signature, minimum: 0.25, maximum: 0.75, feather: 0, algorithm: "prototype-depth-map-v1" } },
  }] } } satisfies import("../lib/develop/v3/document.ts").DevelopDocumentV3;
  let readResult: DevelopAssetReadResult = { kind: "ready", descriptor, bytes };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { darkroom: { developAssetRead: async () => readResult } } });
  try {
    const transported: readonly V3PreviewWorkerMaskMatte[] = await runtime.loadV3PreviewMaskMattes(document, entry, image);
    assert.equal(transported[0]?.kind, "depth-map");
    const raster = transported[0];
    assert.ok(raster);
    const workerAssets = { hasAsset: (id: string) => id === digest, depthMap: (id: string) => id === digest ? raster : undefined };
    const preview = await runtime.renderV3Runtime(document, { kind: "v3-preview", entry, image,
      viewportDimensions: { width: 2, height: 1 }, devicePixelRatio: 1, previewMode: "settled", includeAnalysis: false, assets: workerAssets });
    assert.equal(preview.kind, "rendered");
    if (preview.kind === "rendered") assert.ok(preview.pixels.pixels[0]! > preview.pixels.pixels[4]!);
    const exported = await runtime.renderV3Runtime(document, { kind: "v3-export", entry, image, size: { mode: "original" }, format: "png", includeAnalysis: false });
    assert.equal(exported.kind, "rendered");
    if (exported.kind === "rendered") assert.ok(exported.pixels.pixels[0]! > exported.pixels.pixels[4]!);
    readResult = { kind: "missing", reason: "bytes-missing", action: "restore-or-rebuild", message: "Missing" };
    const missing = await runtime.renderV3Runtime(document, { kind: "v3-export", entry, image, size: { mode: "original" }, format: "png", includeAnalysis: false });
    assert.equal(missing.kind, "blocked");
    if (missing.kind === "blocked") assert.ok(missing.diagnostics.some((item) => item.kind === "missing-edit-asset"));
    const stale = await runtime.renderV3Runtime(document, { kind: "v3-export", entry: { ...entry, assetRevision: 2 }, image,
      size: { mode: "original" }, format: "png", includeAnalysis: false, assets: workerAssets });
    assert.equal(stale.kind, "blocked");
    const staleMask = { ...document.local.masks[0]!, expression: {
      ...document.local.masks[0]!.expression,
      source: { ...document.local.masks[0]!.expression.source, source: { ...source.source.signature, assetRevision: 0 } },
    } };
    const mixed = await runtime.renderV3Runtime({ ...document, local: { ...document.local, masks: [...document.local.masks, staleMask] } }, {
      kind: "v3-export", entry, image, size: { mode: "original" }, format: "png", includeAnalysis: false, assets: workerAssets,
    });
    assert.equal(mixed.kind, "blocked");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
