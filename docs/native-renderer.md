# Native renderer POC

Desktop v3 Develop rendering uses Vulkan on Linux and Windows, and Metal on macOS. The Rust `wgpu` dependency enables those native backends. It does not use browser WebGPU.

The previous photo renderer uses WebGL2. This POC retains its shader math, edit documents, geometry, mask coverage, analysis taps, and export rules. It translates the four GLSL passes into native shader modules and packs their uniforms into binary buffers.

## Scope

Develop, Compare, edited thumbnails, full-resolution regions, and v3 export use the native path through `V3PreviewWorkerClient`. Frozen v2 documents retain their existing rendering path. Features that already require the CPU keep that fallback, including cleanup, some mask sources, defringe, and denoise with transformed geometry. A missing native GPU also selects the CPU fallback.

The interface remains a Tauri webview. RAW decoding and ONNX inference retain their existing implementations. ONNX inference can still use browser WebGPU or WASM. This POC changes photo rendering, not model execution.

## Execution and resource use

Each image worker prepares geometry, mask coverage, uniforms, and render passes. The UI thread forwards transferable binary buffers to Rust. Rust owns one native GPU device and serializes GPU submissions outside the UI thread. Two requests can enter the native queue at once.

Native workers create preview bitmaps directly from rendered pixels and do not require `OffscreenCanvas`. This preserves support for older macOS 13 webviews, since WebKit added Offscreen Canvas 2D support in [Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/).

The native renderer retains source textures between edits, caches shader modules and pipelines across images, and reuses uniform and readback buffers. Uploads and uniforms use raw binary IPC rather than JSON pixel arrays. GPU textures share a 1.5 GiB limit across at most 16 image sessions. Disposal releases image resources, including requests that finish after their worker closes.

Native export uses 1024-pixel tiles, bounded by the adapter limits, with the same neighborhood overlap as the existing renderer. A [paired 1-megapixel benchmark](performance/native-tile-comparison.json) reduced completed export time from 47.95 ms to 27.0 ms by cutting native calls from six to two. The larger tiles use more cached texture memory, about 103 MB in that workload instead of 46 MB. Adapters with smaller color attachment limits split multiple float outputs into separate draws. The renderer queries the adapter's texture limits instead of assuming a fixed maximum size.

Spatial filters compute interpolation weights from their sample offsets. This keeps those weights independent of a pixel's position inside a tile. The 1024-pixel boundary check caught and fixed a one-channel rounding difference between a full export and a separately rendered region.

Rust image operations use one shared Rayon pool with one logical CPU reserved for other work. Large rows run in parallel. Small images and systems that cannot create the pool use the serial path. Denoise and detail share neighbor calculations, and super-resolution reuses cubic interpolation weights.

Native previews currently read GPU pixels back into memory and send them to the webview for display. This is a working POC, not a zero-copy native display implementation. That transfer can make interactive previews slower than a browser GPU canvas even when the shader execution is fast.

## Verification

[Native pixel measurements](performance/native-renderer.json) passed all 29 cases covering source formats, edits, masks, geometry, analysis, and export-region agreement. Completed 1-megapixel export measured 39.5 ms on Vulkan versus 115.2 ms on hardware WebGL using the same RTX 3080. The benchmark reports preview timing, which can return before browser GPU work finishes, and export timing, which waits for pixel readback. Compare timings only after checking the recorded drivers and timing scope.

[CPU measurements](performance/cpu-parallelism.json) record the original and parallel kernel results on a Ryzen 9 5900X. The measured median speedups range from 3.47 to 17.26 times for the recorded 512 by 512 workloads. A temporary differential check compared 208 cases against the original code, with identical pixels on the shared pool and on one CPU. These are kernel measurements, not whole-app speedups.

The [desktop workflow](performance/native-desktop-workflow.json) passed nine checks with Vulkan required on an NVIDIA RTX 3080. It covered edits, history, virtual copies, batches, detail viewing, export, cancellation, and restart recovery. The check ran on a dedicated Xvfb display because the desktop compositor suspended animation callbacks in an unfocused test window.

All five shader variants also passed Naga validation and Metal Shading Language 2.1 translation with explicit resource bindings. This does not exercise Apple's shader compiler or Metal hardware. The existing CI build matrix includes Linux, Windows, and macOS. Windows and macOS runtime checks remain necessary before treating this POC as a completed cross-platform migration.

## Run the POC

Use the normal desktop command:

```sh
npm run desktop:dev
```

Run the native pixel and performance benchmark with Node 24, Rust, and a working native GPU driver:

```sh
npm run benchmark:native
```

The benchmark builds a small native executable from the app's renderer module. It uses an installed Chromium browser or Playwright Chromium, starts a temporary local server, and closes both when finished. `DARKROOM_CHROMIUM` selects a browser binary. `DARKROOM_GPU_REPORT` selects the JSON output path.

For the real desktop workflow, start the development server and use the existing smoke command with native rendering required:

```sh
DARKROOM_SMOKE_REQUIRE_NATIVE=1 npm run test:develop:desktop
```

The workflow requires `tauri-driver` and a matching platform driver. Its report includes the native adapter and executed-frame counters, so a CPU fallback cannot satisfy the native requirement.
