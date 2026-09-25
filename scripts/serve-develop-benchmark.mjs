import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, preview } from "vite";

const root = path.resolve(process.argv[2] ?? process.cwd());
const directory = await mkdtemp(path.join(os.tmpdir(), "darkroom-interaction-production-"));
const names = [
  "stores/develop-store.ts",
  "stores/library-store.ts",
  "lib/develop/repository.ts",
  "lib/develop/v3/local-adjustments.ts",
  "lib/cache/thumbnail-cache.ts",
  "lib/develop/presets/apply.ts",
  "lib/cache/develop-image-cache.ts",
  "lib/develop/v3/preview-worker-client.ts",
  "lib/export/runner.ts",
];
const imports = names.map((name, index) => `import * as benchmarkModule${index} from ${JSON.stringify(`@/${name}`)};`).join("\n");
const entries = names.map((name, index) => `[${JSON.stringify(name)}, benchmarkModule${index}]`).join(",");
let server;
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
async function close() {
  await server?.close();
}
try {
  await build({
    root,
    plugins: [{
      name: "interaction-benchmark-module-access",
      enforce: "pre",
      transform(code, id) {
        if (id !== path.join(root, "app/main.tsx")) return;
        return `${imports}\n${code}\nconst benchmarkModules = new Map([${entries}]); window.smokeModule = name => { if (!benchmarkModules.has(name)) throw new Error('Unknown benchmark module: ' + name); return benchmarkModules.get(name); };`;
      },
    }],
    build: { outDir: directory, emptyOutDir: true },
  });
  server = await preview({ root, build: { outDir: directory }, preview: { host: "localhost", port: 3000, strictPort: true } });
  console.log(`Production benchmark frontend: ${root}\nTemporary assets: ${directory}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close().then(() => process.exit(0)); });
} catch (error) {
  await close();
  throw error;
}
