import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const indexPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/libraw-wasm/dist/index.js",
);

let content = readFileSync(indexPath, "utf8");

if (content.includes("error:e") || content.includes("reject(new Error(")) {
  console.log("libraw-wasm already patched");
  process.exit(0);
}

const fixed = content.replaceAll("throw:e", "error:e");
if (fixed === content) {
  console.error("libraw-wasm patch failed: expected pattern not found");
  process.exit(1);
}

writeFileSync(indexPath, fixed);
console.log("Patched libraw-wasm worker error handler");
