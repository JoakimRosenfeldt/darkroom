import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRuntimeFormatCapabilityReport,
  getPackagedNikonDecoderCommand,
  probeNikonRuntime,
} from "../electron/format-capability-service.ts";
import { serializeFormatCapabilityReport } from "../lib/formats/index.ts";
import type { NefDecoderCommand } from "../electron/nef-decoder-service.ts";

const mock = fileURLToPath(new URL("../native/nikon-nef-decoder/mock-decoder.mjs", import.meta.url));

function mockCommand(kind: "native" | "test-only" = "test-only"): NefDecoderCommand {
  return {
    executable: process.execPath,
    fixedArgs: [mock],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    kind,
  };
}

function expectedProbe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    helperVersion: "fixture-1.0.0",
    backend: "nikon-sdk",
    pixelProtocol: "rgb16le-v1",
    architecture: process.arch,
    ...overrides,
  };
}

async function fixtureScript(
  root: string,
  response: string,
  mode: "response" | "oversized" | "nonzero" | "timeout" | "replace" = "response",
): Promise<NefDecoderCommand> {
  const script = path.join(root, `probe-${mode}.mjs`);
  await writeFile(script, `
    const mode = process.env.PROBE_MODE;
    if (mode === "timeout") {
      setTimeout(() => undefined, 10000);
    } else if (mode === "oversized") {
      process.stdout.write("x".repeat(20000));
    } else if (mode === "nonzero") {
      process.stderr.write("probe failed");
      process.exitCode = 2;
    } else if (mode === "replace") {
      process.stdout.write(process.env.PROBE_RESPONSE ?? "");
      const { appendFile } = await import("node:fs/promises");
      await appendFile(process.env.REPLACE_PATH, "replacement");
    } else {
      process.stdout.write(process.env.PROBE_RESPONSE ?? "");
    }
  `);
  await chmod(script, 0o755);
  return {
    executable: process.execPath,
    fixedArgs: [script],
    env: { PROBE_MODE: mode, PROBE_RESPONSE: response, REPLACE_PATH: script },
    kind: "native",
  };
}

test("missing Nikon runtime is explicit and does not add camera rows", async () => {
  const report = await createRuntimeFormatCapabilityReport({
    appVersion: "test",
    platform: "test-platform",
    architecture: "test-architecture",
    helper: null,
    packageState: "unavailable",
    cameraRows: [{
      vendor: "Nikon",
      model: "Fixture",
      extension: "nef",
      compression: "lossless",
      bitDepth: 14,
      backend: "nikon-native",
      status: "supported",
      colorStatus: "unknown",
      sampleChecksum: null,
    }],
  });
  assert.equal(report.nikon.status, "unavailable");
  assert.equal(report.nikon.kind, "none");
  assert.deepEqual(report.cameraRows, []);
  assert.equal(report.formats.find((format) => format.id === "dng")?.recognition, "recognized-unsupported");
  assert.equal(report.operations.find((operation) => operation.id === "copy-as-dng")?.status, "unavailable");
});

test("the checked-in mock passes probe only as test-only, including a native command label", async () => {
  const testOnly = await probeNikonRuntime({ helper: mockCommand("test-only"), packageState: "test-only" });
  assert.equal(testOnly.status, "test-only");
  assert.equal(testOnly.kind, "test-only");
  assert.equal(testOnly.backend, "darkroom-test-mock");
  assert.equal(testOnly.pixelProtocol, "rgb16le-v1");
  assert.match(testOnly.checksum ?? "", /^[0-9a-f]{64}$/);

  const mislabeled = await probeNikonRuntime({ helper: mockCommand("native"), packageState: "development" });
  assert.equal(mislabeled.status, "test-only");
  assert.equal(mislabeled.kind, "test-only");
  assert.equal(mislabeled.backend, "darkroom-test-mock");
});

test("a qualified versioned native probe records backend, architecture, and checksum", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-format-probe-valid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = await fixtureScript(root, JSON.stringify(expectedProbe()));
  const development = await probeNikonRuntime({ helper, packageState: "development" });
  assert.equal(development.status, "misconfigured");
  assert.equal(development.packageState, "development");
  const packagedHelper = { ...helper, packageState: "packaged" as const, expectedChecksum: development.checksum ?? "" };
  const first = await probeNikonRuntime({ helper: packagedHelper, packageState: "packaged", approvedChecksum: development.checksum ?? "" });
  const second = await probeNikonRuntime({ helper: packagedHelper, packageState: "packaged", approvedChecksum: development.checksum ?? "" });
  assert.equal(first.status, "available");
  assert.equal(first.kind, "native");
  assert.equal(first.backend, "nikon-sdk");
  assert.equal(first.architecture, process.arch);
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.version, "fixture-1.0.0");
});

test("development native helpers cannot claim packaged availability", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-format-probe-development-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = await fixtureScript(root, JSON.stringify(expectedProbe()));
  const result = await probeNikonRuntime({ helper, packageState: "development" });
  assert.equal(result.status, "misconfigured");
  assert.equal(result.kind, "native");
  assert.equal(result.packageState, "development");
});

test("packaged probes require an approved checksum and reject replacement during probe", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-format-probe-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stableHelper = await fixtureScript(root, JSON.stringify(expectedProbe()));
  const stable = await probeNikonRuntime({ helper: stableHelper, packageState: "development" });
  assert.match(stable.checksum ?? "", /^[0-9a-f]{64}$/);
  const mismatch = await probeNikonRuntime({
    helper: { ...stableHelper, packageState: "packaged" },
    packageState: "packaged",
    approvedChecksum: "0".repeat(64),
  });
  assert.equal(mismatch.status, "misconfigured");
  assert.match(mismatch.reason, /checksum/);

  const replacingHelper = await fixtureScript(root, JSON.stringify(expectedProbe()), "replace");
  const replacing = await probeNikonRuntime({ helper: replacingHelper, packageState: "development" });
  assert.equal(replacing.status, "misconfigured");
  assert.match(replacing.reason, /changed during its probe/);
});

test("malformed, oversized, nonzero, and timed-out probes stay misconfigured", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-format-probe-failures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ["malformed", "not-json", "response"],
    ["oversized", "", "oversized"],
    ["nonzero", "", "nonzero"],
    ["timeout", "", "timeout"],
  ] as const;
  for (const [label, response, mode] of cases) {
    const helper = await fixtureScript(root, response, mode);
    const result = await probeNikonRuntime({ helper, packageState: "development", timeoutMs: 60 });
    assert.equal(result.status, "misconfigured", label);
    assert.match(result.checksum ?? "", /^[0-9a-f]{64}$/, `${label}: ${result.reason}`);
  }
});

test("probe rejects symlinks, architecture, protocol, and backend mismatches", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-format-probe-gates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  await writeFile(target, "not an executable");
  await chmod(target, 0o755);
  const link = path.join(root, "link");
  await symlink(target, link);
  const symlinkResult = await probeNikonRuntime({ helper: { executable: link, kind: "native" }, packageState: "development" });
  assert.equal(symlinkResult.status, "misconfigured");

  const mismatches = [
    expectedProbe({ architecture: process.arch === "x64" ? "arm64" : "x64" }),
    expectedProbe({ pixelProtocol: "rgb16le-v2" }),
    expectedProbe({ backend: "darkroom-test-mock" }),
  ];
  for (const response of mismatches) {
    const helper = await fixtureScript(root, JSON.stringify(response));
    const result = await probeNikonRuntime({ helper, packageState: "development" });
    assert.equal(result.status, "misconfigured");
  }
});

test("runtime reports are deterministic and packaged helper resolution is explicit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darkroom-format-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = await fixtureScript(root, JSON.stringify(expectedProbe()));
  const input = { appVersion: "test", platform: "darwin", architecture: process.arch, helper, packageState: "development" as const };
  const first = await createRuntimeFormatCapabilityReport(input);
  const second = await createRuntimeFormatCapabilityReport(input);
  assert.equal(serializeFormatCapabilityReport(first), serializeFormatCapabilityReport(second));
  assert.deepEqual(getPackagedNikonDecoderCommand("/private/resources", "linux"), null);
  assert.deepEqual(getPackagedNikonDecoderCommand("/private/resources", "darwin"), {
    executable: "/private/resources/nikon-nef-decoder/MacOS/nikon-nef-decoder",
    kind: "native",
    packageState: "packaged",
  });
});
