import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch, cpus, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(path.join(tmpdir(), "darkroom-native-benchmark-"));
async function buildProbe() {
  if (process.env.DARKROOM_GPU_PROBE) return process.env.DARKROOM_GPU_PROBE;
  const manifest = await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const dependencies = ["serde", "serde_json", "rayon", "wgpu", "pollster", "half"].map((name) => {
    const declaration = manifest.split("\n").find((line) => line.startsWith(`${name} = `));
    if (!declaration) throw new Error(`Missing native benchmark dependency ${name}.`);
    return declaration;
  });
  await mkdir(path.join(directory, "src"));
  await writeFile(path.join(directory, "Cargo.toml"), `[package]\nname = "darkroom-native-benchmark"\nversion = "0.1.0"\nedition = "2024"\n[dependencies]\n${dependencies.join("\n")}\n`);
  await copyFile(path.join(root, "src-tauri/Cargo.lock"), path.join(directory, "Cargo.lock"));
  await writeFile(path.join(directory, "src/main.rs"), [
    `#[path=${JSON.stringify(path.join(root, "src-tauri/src/gpu.rs"))}] mod gpu;`,
    `#[path=${JSON.stringify(path.join(root, "src-tauri/src/compute.rs"))}] mod compute;`,
    `include!(${JSON.stringify(path.join(root, "scripts/benchmark-native-renderer.rs"))});`,
  ].join("\n"));
  const target = path.join(root, "src-tauri/target/native-benchmark");
  const cargo = process.env.CARGO ?? path.join(homedir(), ".cargo/bin", platform() === "win32" ? "cargo.exe" : "cargo");
  await new Promise((resolve, reject) => {
    const build = spawn(cargo, ["build", "--release", "--manifest-path", path.join(directory, "Cargo.toml"), "--target-dir", target], { stdio: "inherit" });
    build.on("error", reject);
    build.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Native benchmark build failed with code ${code}.`)));
  });
  return path.join(target, "release", platform() === "win32" ? "darkroom-native-benchmark.exe" : "darkroom-native-benchmark");
}
let executable;
try { executable = await buildProbe(); } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
const output = process.env.DARKROOM_GPU_REPORT ?? path.join(root, "docs/performance/native-renderer.json");
const probe = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
const waiting = [];
let responseHeader = null;
let probeLog = "";
let stopped = false;
probe.stderr.on("data", (chunk) => { probeLog += chunk; process.stderr.write(chunk); });
probe.stdout.on("readable", () => {
  for (;;) {
    if (responseHeader === null) {
      const header = probe.stdout.read(4);
      if (!header) return;
      responseHeader = header.readUInt32LE(0);
    }
    const length = responseHeader & 0x7fffffff;
    const bytes = length ? probe.stdout.read(length) : Buffer.alloc(0);
    if (!bytes) return;
    const next = waiting.shift();
    if (!next) throw new Error("Unrequested native GPU response.");
    if (responseHeader >>> 31) next.reject(new Error(bytes.toString("utf8")));
    else next.resolve(bytes);
    responseHeader = null;
  }
});
function fail(error) { stopped = true; for (const pending of waiting.splice(0)) pending.reject(error); }
probe.on("error", fail);
probe.on("exit", (code) => fail(new Error(`Native GPU probe stopped with code ${code}. ${probeLog}`)));
function nativeRequest(bytes) {
  if (stopped) return Promise.reject(new Error(`Native GPU probe is unavailable: ${probeLog}`));
  return new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    probe.stdin.write(Buffer.concat([header, bytes]));
  });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/gpu") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await nativeRequest(Buffer.concat(chunks));
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(result);
    } else if (request.url === "/bundle.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(await readFile(path.join(directory, "bundle.js")));
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><title>Native renderer benchmark</title><script type="module" src="/bundle.js"></script>');
    }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
let browser;
try {
  await build({
    entryPoints: [path.join(root, "scripts/native-renderer-benchmark.browser.mjs")],
    outfile: path.join(directory, "bundle.js"), bundle: true, format: "esm", platform: "browser",
    alias: { "@": root }, target: "es2022", logLevel: "warning",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const webglBackend = process.env.DARKROOM_WEBGL_BACKEND ?? (platform() === "linux" ? "gl" : platform() === "darwin" ? "metal" : "d3d11");
  const browserArgs = ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-gl=angle", `--use-angle=${webglBackend}`];
  browser = await chromium.launch({
    ...(process.env.DARKROOM_CHROMIUM ? { executablePath: process.env.DARKROOM_CHROMIUM } : {}),
    headless: true, args: browserArgs,
  }).catch((error) => {
    if (process.env.DARKROOM_CHROMIUM || platform() !== "linux") throw error;
    return chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: browserArgs });
  });
  const page = await browser.newPage();
  page.on("console", (message) => console.log(message.text()));
  page.on("pageerror", (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.runNativeRendererBenchmark === "function");
  const report = await page.evaluate(() => window.runNativeRendererBenchmark());
  Object.assign(report, {
    measuredAt: new Date().toISOString(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    executable, nativeProbeLog: probeLog.trim(),
    timingScope: "Preview measures bitmap handoff. Native includes GPU readback and binary HTTP diagnostics transport; WebGL can hand off a GPU bitmap without waiting for pixel readback. Export measures completed CPU pixel readback for both backends. Source decoding and runtime request preparation are excluded. Two warmup frames precede four measured frames. Check adapter identities before comparing backends.",
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks.length,
    timings: report.timings.map(({ backend, operation, medianWarmMs }) => ({ backend, operation, medianWarmMs })) }));
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  probe.kill();
  await rm(directory, { recursive: true, force: true });
}
