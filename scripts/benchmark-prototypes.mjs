import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  createPrototypeDepthMap,
  denoisePrototypeImage,
  enhancePrototypeRawDetails,
  superResolvePrototypeImage,
  generativeRemovePrototype,
} from "../lib/develop/v3/prototype-operations.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), "darkroom-prototype-benchmark-"));
const cargo = process.env.CARGO ?? "cargo";
try {
  mkdirSync(path.join(directory, "src"));
  writeFileSync(path.join(directory, "Cargo.toml"), `[package]
name = "darkroom-prototype-benchmark"
version = "0.1.0"
edition = "2024"
[dependencies]
serde_json = "1"
base64 = "0.22"
rayon = "1.11"
[profile.release]
lto = "thin"
codegen-units = 1
`);
  const rustSource = readFileSync(new URL("./benchmark-prototypes.rs", import.meta.url), "utf8")
    .replace(/#\[path = "[^"]+"\]\s*mod prototype;/, `#[path=${JSON.stringify(path.join(root, "src-tauri/src/develop/prototype.rs"))}] mod prototype;\n#[path=${JSON.stringify(path.join(root, "src-tauri/src/compute.rs"))}] mod compute;`);
  writeFileSync(path.join(directory, "src/main.rs"), rustSource);
  const rust = JSON.parse(execFileSync(cargo, ["run", "--release", "--quiet", "--manifest-path", path.join(directory, "Cargo.toml")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }));
  const image = { dimensions: { width: 512, height: 512 }, channels: 4,
    pixels: Uint8Array.from({ length: 512 * 512 * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 23 + 41) % 256) };
  const selection = Uint8Array.from({ length: 512 * 512 }, (_, i) => i % 9 === 0 ? 128 : 0);
  const input = { image, isCancelled: () => false };
  const operations = [
    ["depth", () => createPrototypeDepthMap(input)],
    ["denoise", () => denoisePrototypeImage({ ...input, parameters: { strength: 55 } })],
    ["raw-details", () => enhancePrototypeRawDetails({ ...input, parameters: { amount: 67 } })],
    ["super-resolution", () => superResolvePrototypeImage(input)],
    ["generative-remove", () => generativeRemovePrototype({ ...input, parameters: { selection, seed: 12345, searchRadius: 7 } })],
  ];
  const node = operations.map(([operation, run]) => {
    run();
    const milliseconds = Array.from({ length: 5 }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    });
    return { operation, milliseconds };
  });
  console.log(JSON.stringify({ nodeVersion: process.version, dimensions: [512, 512], channels: 4, warmups: 1, samples: 5, node, rust }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
