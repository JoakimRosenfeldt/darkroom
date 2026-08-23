import assert from "node:assert/strict";
import test from "node:test";
import {
  createFormatCapabilityReport,
  FORMAT_CAPABILITIES,
  getFormatCapabilityForFileName,
  getFormatFamilyForEntry,
  getFormatLabelForEntry,
  OPERATION_CAPABILITIES,
  recognizeFormatFromBytes,
  serializeFormatCapabilityReport,
  SUPPORTED_INPUT_EXTENSIONS,
} from "../lib/formats/index.ts";

test("registry preserves the supported scan set and profile grouping", () => {
  assert.deepEqual(SUPPORTED_INPUT_EXTENSIONS, [
    ".nef",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
  ]);
  assert.equal(getFormatFamilyForEntry("photo.NEF", "nef"), "raw");
  assert.equal(getFormatFamilyForEntry("photo.JPG", "standard"), "standard");
  assert.equal(getFormatCapabilityForFileName("photo.dng")?.recognition, "recognized-unsupported");
  assert.equal(getFormatCapabilityForFileName("photo.tiff")?.exportFormats.includes("tiff"), true);
});

test("WebP signature recognition requires both RIFF and WEBP markers", () => {
  const valid = new Uint8Array(12);
  valid.set([0x52, 0x49, 0x46, 0x46], 0);
  valid.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(recognizeFormatFromBytes(valid)?.id, "webp");

  const invalid = new Uint8Array(valid);
  invalid[8] = 0x4a;
  assert.equal(recognizeFormatFromBytes(invalid), null);
});

test("report is deterministic and keeps DNG unavailable", () => {
  const report = createFormatCapabilityReport({
    appVersion: "test",
    platform: "test-platform",
    architecture: "test-architecture",
  });
  const dng = report.formats.find((format) => format.id === "dng");
  const copyAsDng = report.operations.find((operation) => operation.id === "copy-as-dng");

  assert.equal(dng?.recognition, "recognized-unsupported");
  assert.equal(dng?.preview.status, "unavailable");
  assert.equal(copyAsDng?.status, "unavailable");
  assert.equal(copyAsDng?.issueId, 89);
  assert.deepEqual(
    report.formats.map((format) => format.id),
    FORMAT_CAPABILITIES.map((format) => format.id),
  );
  assert.deepEqual(
    report.operations.map((operation) => operation.id),
    OPERATION_CAPABILITIES.map((operation) => operation.id),
  );
  assert.equal(serializeFormatCapabilityReport(report).endsWith("\n"), true);
  assert.equal(getFormatLabelForEntry("photo.nef", "nef"), "NEF");
});
