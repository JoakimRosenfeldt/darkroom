import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test, { after, before } from "node:test";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { createAssetId, createCatalogId, createEntryId, createRootId, createSourceId } from "../lib/catalog/ids.ts";
import { createSessionId } from "../lib/catalog/runtime.ts";
import type { LibraryEntry } from "../lib/fs/types.ts";

type RegressionModule = typeof import("../lib/develop/xmp.ts") & {
  createEntryMetadata: typeof import("../lib/catalog/defaults.ts").createEntryMetadata;
  createDefaultV3DevelopDocument: typeof import("../lib/develop/v3/document.ts").createDefaultV3DevelopDocument;
  createDefaultDevelopDocument: typeof import("../lib/develop/document.ts").createDefaultDevelopDocument;
  createV3MigrationCandidate: typeof import("../lib/develop/v3/migration.ts").createV3MigrationCandidate;
  useLibraryStore: typeof import("../stores/library-store.ts").useLibraryStore;
  parseLibraryWorkspaceState: typeof import("../lib/library/model.ts").parseLibraryWorkspaceState;
};

declare global {
  interface Window {
    metadataRegressions: RegressionModule;
  }
}

let browser: Browser;
let page: Page;

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        export * from "./lib/develop/xmp.ts";
        export { createEntryMetadata } from "./lib/catalog/defaults.ts";
        export { createDefaultV3DevelopDocument } from "./lib/develop/v3/document.ts";
        export { createDefaultDevelopDocument } from "./lib/develop/document.ts";
        export { createV3MigrationCandidate } from "./lib/develop/v3/migration.ts";
        export { useLibraryStore } from "./stores/library-store.ts";
        export { parseLibraryWorkspaceState } from "./lib/library/model.ts";
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "iife",
    globalName: "metadataRegressions",
    platform: "browser",
    write: false,
  });
  const installedChromium = await access(chromium.executablePath()).then(() => true, () => false);
  if (installedChromium) {
    browser = await chromium.launch({ headless: true });
  } else {
    // CI runs plain `npm ci` (plus the workflow's playwright install step);
    // fall back to system browsers under their common names/paths.
    const candidates = [
      process.env.CHROMIUM_PATH,
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ].filter((candidate): candidate is string => Boolean(candidate));
    let launched: Browser | undefined;
    for (const executablePath of candidates) {
      if (await access(executablePath).then(() => true, () => false)) {
        launched = await chromium.launch({ executablePath, headless: true });
        break;
      }
    }
    browser = launched ?? (await chromium.launch({ channel: "chrome", headless: true }));
  }
  page = await browser.newPage();
  await page.route("https://darkroom.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("https://darkroom.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});

after(async () => {
  await browser?.close();
});

test("HH-07 keyword merges reject self and direct or indirect descendants", async () => {
  const result = await page.evaluate(() => {
    const { useLibraryStore, parseLibraryWorkspaceState } = window.metadataRegressions;
    const keywords = [
      { id: "parent", parentId: null }, { id: "child", parentId: "parent" },
      { id: "grandchild", parentId: "child" }, { id: "other", parentId: null },
    ].map((keyword) => ({ ...keyword, name: keyword.id, synonyms: [], export: true, createdAt: 1, updatedAt: 1 }));
    const workspace = { ...useLibraryStore.getState().libraryWorkspace, keywords, entryKeywordIds: { photo: ["parent"] } };
    useLibraryStore.setState({ libraryWorkspace: workspace });
    const rejected = ["parent", "child", "grandchild"].map((target) => {
      useLibraryStore.getState().mergeKeyword("parent", target);
      return useLibraryStore.getState().libraryWorkspace === workspace;
    });
    useLibraryStore.getState().mergeKeyword("parent", "other");
    const merged = useLibraryStore.getState().libraryWorkspace;
    parseLibraryWorkspaceState(merged, [], new Set(["photo"]));
    return { rejected, childParent: merged.keywords.find((item) => item.id === "child")?.parentId, assignment: merged.entryKeywordIds.photo };
  });
  assert.deepEqual(result, { rejected: [true, true, true], childParent: "other", assignment: ["other"] });
});

test("HH-10 XMP capture time preserves offsets, fractions, and the instant", async () => {
  for (const timestamp of ["2024-06-07T12:34:56+02:00", "2024-06-07T12:34:56-05:30", "2024-06-07T12:34:56.125Z", "2024-06-07T12:34:56"]) {
    const result = await page.evaluate((value) => {
      const { parseMetadataXmp, serializeMetadataXmp } = window.metadataRegressions;
      const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:DateCreated="${value}"/></rdf:RDF>`;
      const parsed = parseMetadataXmp(xml);
      const roundtrip = parseMetadataXmp(serializeMetadataXmp(xml, parsed));
      const capture = roundtrip.captureTime;
      // Offset-less wall times sort as UTC (matching metadata analysis),
      // independent of the test browser's local timezone.
      const expectedKey = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`);
      return { parsed: parsed.captureTime, roundtrip: capture, full: capture?.kind === "set" ? capture.value.value + (capture.value.offset ?? "") : null, expectedKey };
    }, timestamp);
    assert.equal(result.full, timestamp);
    assert.deepEqual(result.roundtrip, result.parsed);
    assert.equal(result.roundtrip?.kind === "set" ? result.roundtrip.value.sortKey : null, result.expectedKey);
  }
});

test("HH-09 successful publish applies merged metadata and retains conflict behavior", async () => {
  const entry = {
    id: createEntryId(), sourceId: createSourceId(), assetId: createAssetId(),
    catalogId: createCatalogId(), sessionId: createSessionId(), rootId: createRootId(),
    name: "photo.jpg", relativePath: "photo.jpg", size: 1, lastModified: 1,
    profileId: "standard", assetRevision: 1, health: "present", formatId: "jpeg",
    formatAvailability: { status: "supported", reason: null }, entryCreatedAt: 1,
    entryKind: "original", parentEntryId: null, displayName: null,
  } satisfies LibraryEntry;
  const result = await page.evaluate(async (photo) => {
    const { useLibraryStore, serializeMetadataXmp, parseMetadataXmp, createEntryMetadata } = window.metadataRegressions;
    let contents = serializeMetadataXmp(null, { title: { kind: "set", value: "old title" }, caption: { kind: "set", value: "sidecar caption" } });
    let writes = 0;
    Object.defineProperty(window, "darkroom", { configurable: true, value: {
      isDesktop: true,
      catalogReadSidecar: async () => ({ contents, lastModified: 1 }),
      catalogWriteSidecar: async (request: { contents: string }) => { contents = request.contents; writes += 1; },
    } });
    const workspace = useLibraryStore.getState().libraryWorkspace;
    useLibraryStore.setState({
      catalogId: photo.catalogId, sessionId: photo.sessionId, entries: [photo], entryMetadata: { [photo.id]: createEntryMetadata({ title: "catalog title", caption: "old caption" }) },
      libraryWorkspace: {
        ...workspace,
        metadataOverridesByEntryId: { [photo.id]: { title: { kind: "set", value: "catalog title" }, caption: { kind: "set", value: "old caption" } } },
        metadataSyncByEntryId: { [photo.id]: {
          status: "catalog-only", sidecarSha256: null, sidecarModifiedAt: 1, catalogRevision: 0,
          baseline: { title: { kind: "set", value: "old title" }, caption: { kind: "set", value: "old caption" } },
          ownedFields: ["title", "caption"], conflicts: [], message: null, updatedAt: 1,
        } },
      },
    });
    const published = await useLibraryStore.getState().publishMetadataXmp(photo.id);
    const state = useLibraryStore.getState();
    const merged = state.libraryWorkspace.metadataOverridesByEntryId[photo.id];
    const sync = state.libraryWorkspace.metadataSyncByEntryId[photo.id];
    const agreement = JSON.stringify(merged) === JSON.stringify(parseMetadataXmp(contents)) && JSON.stringify(sync.baseline) === JSON.stringify(merged);
    const catalog = state.entryMetadata[photo.id];
    useLibraryStore.getState().applyMetadataOverrides([photo.id], { title: { kind: "set", value: "second catalog title" } });
    contents = serializeMetadataXmp(contents, { title: { kind: "set", value: "second sidecar title" } });
    const conflict = await useLibraryStore.getState().publishMetadataXmp(photo.id);
    const conflictState = useLibraryStore.getState();
    return { published, title: catalog.title, caption: catalog.caption, status: sync.status, ownedFields: sync.ownedFields, agreement, writes, conflict, conflictTitle: conflictState.entryMetadata[photo.id].title, conflicts: conflictState.libraryWorkspace.metadataSyncByEntryId[photo.id].conflicts.map((item) => item.field) };
  }, entry);
  assert.deepEqual(result, { published: "published", title: "catalog title", caption: "sidecar caption", status: "clean", ownedFields: ["title", "caption"], agreement: true, writes: 1, conflict: "conflict", conflictTitle: "second catalog title", conflicts: ["title"] });
});

test("HH-09 merge publish preserves catalog-only metadata the merge never considered", async () => {
  const entry = {
    id: createEntryId(), sourceId: createSourceId(), assetId: createAssetId(),
    catalogId: createCatalogId(), sessionId: createSessionId(), rootId: createRootId(),
    name: "photo.jpg", relativePath: "photo.jpg", size: 1, lastModified: 1,
    profileId: "standard", assetRevision: 1, health: "present", formatId: "jpeg",
    formatAvailability: { status: "supported", reason: null }, entryCreatedAt: 1,
    entryKind: "original", parentEntryId: null, displayName: null,
  } satisfies LibraryEntry;
  const result = await page.evaluate(async (photo) => {
    const { useLibraryStore, serializeMetadataXmp, createEntryMetadata } = window.metadataRegressions;
    let contents = serializeMetadataXmp(null, { caption: { kind: "set", value: "sidecar caption" } });
    Object.defineProperty(window, "darkroom", { configurable: true, value: {
      isDesktop: true,
      catalogReadSidecar: async () => ({ contents, lastModified: 1 }),
      catalogWriteSidecar: async (request: { contents: string }) => { contents = request.contents; },
    } });
    const workspace = useLibraryStore.getState().libraryWorkspace;
    useLibraryStore.setState({
      catalogId: photo.catalogId, sessionId: photo.sessionId, entries: [photo],
      // Title exists only in catalog metadata (e.g. written by an import
      // preset): no override, no baseline field, no sidecar field.
      entryMetadata: { [photo.id]: createEntryMetadata({ title: "preset title", caption: "old caption" }) },
      libraryWorkspace: {
        ...workspace,
        metadataOverridesByEntryId: { [photo.id]: { caption: { kind: "set", value: "old caption" } } },
        metadataSyncByEntryId: { [photo.id]: {
          status: "catalog-only", sidecarSha256: null, sidecarModifiedAt: 1, catalogRevision: 0,
          baseline: { caption: { kind: "set", value: "old caption" } },
          ownedFields: ["caption"], conflicts: [], message: null, updatedAt: 1,
        } },
      },
    });
    const published = await useLibraryStore.getState().publishMetadataXmp(photo.id);
    const catalog = useLibraryStore.getState().entryMetadata[photo.id];
    return { published, title: catalog.title, caption: catalog.caption };
  }, entry);
  assert.deepEqual(result, { published: "published", title: "preset title", caption: "sidecar caption" });
});

test("HH-03 new v3 documents project current tone, color, crop, curves, detail, and effects", async () => {
  const result = await page.evaluate(() => {
    const { createDefaultV3DevelopDocument, serializeDevelopXmp, parseDevelopXmp } = window.metadataRegressions;
    const defaults = createDefaultV3DevelopDocument();
    const document = {
      ...defaults,
      tone: { basic: { exposure: 1.25, contrast: 12, highlights: -23, shadows: 34, whites: 45, blacks: -56 }, curves: { ...defaults.tone.curves, red: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] } },
      color: { ...defaults.color, global: { vibrance: 31, saturation: -14 }, whiteBalance: { ...defaults.color.whiteBalance, resolved: { temperatureKelvin: 6200, tint: 13, gains: [1, 1, 1] as const } }, mixer: { ...defaults.color.mixer, red: { hue: 11, saturation: 22, luminance: 33 } }, grading: { shadows: { hueDegrees: 210, saturation: 25, luminance: -10 }, midtones: { hueDegrees: 0, saturation: 0, luminance: 0 }, highlights: { hueDegrees: 40, saturation: 15, luminance: 5 }, balance: 0, blending: 60 } },
      geometry: { ...defaults.geometry, crop: { ...defaults.geometry.crop, enabled: true, x: 0.1, y: 0.2, width: 0.7, height: 0.6 }, orientation: { ...defaults.geometry.orientation, fineAngleDegrees: 2.5 } },
      detail: { sharpening: { ...defaults.detail.sharpening, sharpening: 37 }, noiseReduction: { ...defaults.detail.noiseReduction, noiseReduction: 28 } },
      effects: { postCrop: { ...defaults.effects.postCrop, vignette: -19, grain: 23 } },
      presence: { texture: 17, clarity: 18, dehaze: 19 },
    };
    const xml = serializeDevelopXmp(document, { rating: 0, colorLabel: null }, null)!;
    const description = new DOMParser().parseFromString(xml, "application/xml").getElementsByTagNameNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "Description")[0];
    const props = Object.fromEntries(Array.from(description.attributes).filter((attribute) => attribute.prefix === "crs").map((attribute) => [attribute.localName, attribute.value]));
    const curve = description.getElementsByTagNameNS("http://ns.adobe.com/camera-raw-settings/1.0/", "ToneCurvePV2012Red")[0];
    return { props, redCurve: Array.from(curve?.getElementsByTagNameNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "li") ?? []).map((point) => point.textContent), roundtrip: parseDevelopXmp(xml)?.document, document };
  });
  for (const [key, value] of Object.entries({ Exposure2012: "1.25", Contrast2012: "12", Highlights2012: "-23", Shadows2012: "34", Whites2012: "45", Blacks2012: "-56", Temperature: "6200", Tint: "13", Vibrance: "31", Saturation: "-14", HueAdjustmentRed: "11", SaturationAdjustmentRed: "22", LuminanceAdjustmentRed: "33", Texture: "17", Clarity2012: "18", Dehaze: "19", ColorGradeShadowHue: "210", ColorGradeShadowSat: "25", ColorGradeShadowLum: "-10", ColorGradeHighlightHue: "40", ColorGradeHighlightSat: "15", ColorGradeHighlightLum: "5", ColorGradeBlending: "60", HasCrop: "True", CropLeft: "0.100000", CropTop: "0.200000", CropRight: "0.800000", CropBottom: "0.800000", CropAngle: "2.50", Sharpness: "37", LuminanceSmoothing: "28", PostCropVignetteAmount: "-19", GrainAmount: "23" })) {
    assert.equal(result.props[key], value, key);
  }
  assert.deepEqual(result.redCurve, ["0, 26", "255, 255"]);
  assert.deepEqual(result.roundtrip, result.document);
});

test("HH-03 migrated documents replace stale CRS and mask payloads and omit unsupported transforms", async () => {
  const result = await page.evaluate(() => {
    const { createDefaultDevelopDocument, createV3MigrationCandidate, serializeDevelopXmp } = window.metadataRegressions;
    const legacy = createDefaultDevelopDocument();
    legacy.settings.basic.exposure = -2;
    legacy.settings.crop.perspectiveX = 20;
    legacy.settings.crop.distortion = 10;
    const migrated = createV3MigrationCandidate(legacy).document;
    const document = { ...migrated, tone: { ...migrated.tone, basic: { ...migrated.tone.basic, exposure: 2 } }, geometry: { ...migrated.geometry, orientation: { ...migrated.geometry.orientation, flipHorizontal: true } } };
    const existingDoc = new DOMParser().parseFromString(serializeDevelopXmp(legacy, { rating: 1, colorLabel: null }, null)!, "application/xml");
    const existingDescription = existingDoc.getElementsByTagNameNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "Description")[0];
    existingDescription.setAttribute("crs:CameraProfile", "Adobe Standard");
    const existing = new XMLSerializer().serializeToString(existingDoc);
    const xml = serializeDevelopXmp(document, { rating: 3, colorLabel: null }, existing)!;
    const description = new DOMParser().parseFromString(xml, "application/xml").getElementsByTagNameNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "Description")[0];
    return { exposure: description.getAttribute("crs:Exposure2012"), stale: ["crs:PerspectiveHorizontal", "crs:PerspectiveVertical", "crs:LensManualDistortionAmount", "crs:HasCrop", "crs:CropLeft", "crs:CropAngle", "darkroom:MaskingData", "darkroom:LightroomMaskInterchange"].filter((key) => description.hasAttribute(key)), blob: description.hasAttribute("darkroom:DevelopDocumentV3"), preserved: description.getAttribute("crs:CameraProfile") };
  });
  assert.deepEqual(result, { exposure: "2.00", stale: [], blob: true, preserved: "Adobe Standard" });
});
