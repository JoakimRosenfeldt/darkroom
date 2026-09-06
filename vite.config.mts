import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  server: { port: 3000, strictPort: true },
  build: { outDir: "out", target: "es2022" },
  worker: { format: "es" },
  optimizeDeps: {
    entries: ["index.html"],
    exclude: ["libraw-wasm", "onnxruntime-web"],
  },
});
