import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
const args = process.argv.slice(2);
const requestedPlatforms = args.filter((arg) => ["--mac", "--win", "--linux"].includes(arg));
if (new Set(requestedPlatforms).size > 1) throw new Error("Choose one installer platform per build.");
const requestedPlatform = requestedPlatforms[0];
const platforms = { "--mac": "darwin", "--win": "win32", "--linux": "linux" };
if (requestedPlatform && platforms[requestedPlatform] !== process.platform) {
  throw new Error("Build installers on their target operating system. The native CI workflow builds all three platforms.");
}
const forwarded = args.filter((arg) => !["--mac", "--win", "--linux"].includes(arg));
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status ?? "a signal"}.`);
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "darkroom-release-"));
try {
  const config = { bundle: { resources: {} } };
  if (process.platform === "darwin") {
    const sdk = path.resolve(process.env.DARKROOM_NEF_SDK_ROOT ?? path.join(os.homedir(), ".darkroom-sdk/nikon-nef"));
    const contents = path.join(sdk, "spike/DarkroomNefSpike.app/Contents");
    const required = [
      "MacOS/nikon-nef-decoder", "Frameworks/libImgSDK.dylib", "Frameworks/libRCSigProc.dylib",
      ...["atomic", "filesystem", "system", "thread"].map((name) => `Frameworks/libboost_${name}-clang-darwin150-mt-1_82.dylib`),
      "Frameworks/libtbb.dylib", "Frameworks/libtbbmalloc.dylib", "Frameworks/Elm.framework/Versions/A/Elm",
      "Resources/NKsRGB.icm", "Resources/prm.bin",
    ];
    for (const file of required) await fs.access(path.join(contents, file)).catch(() => { throw new Error(`Nikon release runtime is incomplete: ${file}`); });
    const staged = path.join(temporary, "nikon-nef-decoder");
    await fs.mkdir(path.join(staged, "MacOS"), { recursive: true });
    await fs.copyFile(path.join(contents, "MacOS/nikon-nef-decoder"), path.join(staged, "MacOS/nikon-nef-decoder"));
    for (const folder of ["Frameworks", "Resources"]) await fs.cp(path.join(contents, folder), path.join(staged, folder), { recursive: true, verbatimSymlinks: true });
    const stagedResources = path.join(temporary, "Contents", "Resources");
    await fs.mkdir(stagedResources, { recursive: true });
    const stagedParameters = path.join(stagedResources, "prm.bin");
    await fs.copyFile(path.join(contents, "Resources/prm.bin"), stagedParameters);
    await fs.copyFile(path.join(sdk, "Image SDK/Library/Mac/Doc/Third Party Legal Notices.rtf"), path.join(staged, "Third Party Legal Notices.rtf"));
    const identity = process.env.APPLE_SIGNING_IDENTITY ?? "-";
    const signingOptions = ["--options", identity === "-" ? "0" : "runtime", ...(identity === "-" ? [] : ["--timestamp"])];
    async function sign(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await sign(file);
          if (entry.name.endsWith(".framework")) run("codesign", ["--force", "--sign", identity, ...signingOptions, file]);
        } else if (entry.isFile() && entry.name.endsWith(".dylib")) {
          run("codesign", ["--force", "--sign", identity, ...signingOptions, file]);
        }
      }
    }
    await sign(path.join(staged, "Frameworks"));
    const helper = path.join(staged, "MacOS/nikon-nef-decoder");
    run("codesign", ["--force", "--sign", identity, ...signingOptions, helper]);
    const probe = spawnSync(helper, ["--probe"], { cwd: root, env: process.env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 });
    const probeDiagnostics = `status=${probe.status ?? "null"} signal=${probe.signal ?? "none"} error=${probe.error?.message?.slice(0, 1_024) ?? "none"} stderr=${JSON.stringify((probe.stderr ?? "").slice(0, 16 * 1024))} stdout=${JSON.stringify((probe.stdout ?? "").slice(0, 16 * 1024))}`;
    const knownLookups = new Set(["enum_string.csv", "uuid_string.csv"].map((name) => `NOT FOUND "${path.join(stagedResources, name)}"`));
    const probeLines = typeof probe.stdout === "string" ? probe.stdout.split(/\r?\n/) : [];
    const legacyOutput = typeof probe.stdout === "string" && probeLines.every((line) => line.trim() === "" || knownLookups.has(line));
    const legacyHelper = !probe.error && probe.status !== null && probe.status > 0 &&
      probe.signal === null && legacyOutput && probe.stderr?.trim() === "invalid arguments";
    if (legacyHelper) {
      for (const line of probeLines) if (knownLookups.has(line)) console.warn(`Nikon decoder probe: ${line}`);
      console.warn("Legacy Nikon decoder has no capability probe; startup succeeded. Verify RAW decoding in the packaged app.");
    } else if (probe.error || probe.status !== 0) {
      throw new Error(`Staged Nikon decoder probe failed: ${probeDiagnostics}`);
    } else {
      let capability;
      try {
        capability = JSON.parse(probe.stdout);
      } catch {
        throw new Error(`Staged Nikon decoder probe returned invalid JSON: ${probeDiagnostics}`);
      }
      if (capability?.version !== 1 || capability.backend !== "nikon-sdk" ||
          capability.pixelProtocol !== "rgb16le-v1" || typeof capability.helperVersion !== "string" ||
          !["arm64", "x64"].includes(capability.architecture)) {
        throw new Error(`Staged Nikon decoder probe returned an unsupported protocol: ${probeDiagnostics}`);
      }
    }
    const checksum = createHash("sha256").update(await fs.readFile(helper)).digest("hex");
    await fs.writeFile(path.join(staged, "runtime.json"), JSON.stringify({ version: 1, checksum }));
    // Preserve framework symlinks and their signatures through the final bundle copy.
    config.bundle.macOS = { files: { "Resources/nikon-nef-decoder": staged } };
    config.bundle.resources[stagedParameters] = "Contents/Resources/prm.bin";
  }
  const configuration = path.join(temporary, "tauri.release.json");
  await fs.writeFile(configuration, JSON.stringify(config));
  run(process.execPath, [cli, "build", "--config", configuration, ...forwarded]);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
