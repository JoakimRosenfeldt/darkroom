# Native renderer POC

Desktop v3 Develop rendering uses Vulkan on Linux and Windows, and Metal on macOS. The Rust `wgpu` dependency enables those native backends. It does not use browser WebGPU.

The previous photo renderer uses WebGL2. This POC retains its shader math, edit documents, geometry, mask coverage, analysis taps, and export rules. It translates the four GLSL passes into native shader modules and packs their uniforms into binary buffers.

## Scope

Develop, Compare, edited thumbnails, full-resolution regions, and v3 export use the native path through `V3PreviewWorkerClient`. Frozen v2 documents retain their existing rendering path. Features that already require the CPU keep that fallback, including cleanup, some mask sources, defringe, and denoise with transformed geometry. A missing native GPU also selects the CPU fallback.

The interface remains a Tauri webview. RAW decoding and ONNX inference retain their existing implementations. ONNX inference can still use browser WebGPU or WASM. This POC changes photo rendering, not model execution.

## Execution and resource use

Each image worker prepares geometry, mask coverage, uniforms, and render passes. The UI thread forwards transferable binary buffers to Rust. Rust owns one native GPU device and serializes GPU submissions outside the UI thread. Two requests can enter the native queue at once.

Preview workers start on the first render request. They finish loading their modules before receiving source pixels or being terminated. Cancellation still resolves immediately. This avoids terminating unfinished module imports during React StrictMode cleanup or rapid photo switching. The reported macOS crash occurs in `WorkerThreadableLoader` destruction through `WorkerModuleScriptLoader` and `ScriptModuleLoader`. [WebKit's module-loader source](https://github.com/WebKit/WebKit/blob/WebKit-7624.5.1.11.3/Source/WebCore/bindings/js/ScriptModuleLoader.cpp#L455) removes completed loads, which points to unfinished imports in that stack. The [Linux lifecycle comparison](performance/native-worker-lifecycle.json) reduced premature terminations from 33 to zero across 16 rapid photo switches. The affected Mac user confirmed that commit `8eeffc2` stopped the reloads.

A failed module load rejects render requests and detaches photo references without forcing termination. Other imports can still be pending when the error arrives. WebKit may retain that uninitialized worker until the document closes.

Native workers create preview bitmaps directly from rendered pixels and do not require `OffscreenCanvas`. This preserves support for older macOS 13 webviews, since WebKit added Offscreen Canvas 2D support in [Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/).

The native renderer retains source textures between edits, caches shader modules and pipelines across images, and reuses uniform and readback buffers. Uploads and uniforms use raw binary IPC rather than JSON pixel arrays. RGB16 expansion and row flipping write directly into the final request. An [allocation comparison](performance/native-upload-allocation.json) confirmed one large buffer instead of two, with identical uploaded pixels. Requests above the existing 512 MiB limit are rejected before allocating the packet. GPU textures share a 1.5 GiB limit across at most 16 image sessions. Disposal releases image resources, including requests that finish after their worker closes. Full document reloads also clear GPU sessions and reject requests queued before the reload. The GPU device and compiled shaders remain available. A [repeated reload check](performance/native-reload-cleanup.json) now stays at four sessions and 523 MiB of textures. Previously it reached eleven sessions and 1463 MiB after two reloads.

Full-resolution RAW decoding on the WASM fallback releases its LibRaw worker after completion. Decoded pixels remain cached for zooming, while the worker's grown WASM heap is freed. In a [paired RAW navigation measurement](performance/native-photo-memory.json), peak WebKit memory fell from 3047 to 2176 MiB and sampled aggregate RSS from 4057 to 3157 MiB. The run switched twelve times between two Nikon RAW photos with two seconds on each photo. Photo readiness did not regress. This Linux measurement does not establish the cause of a reported macOS UI reload. macOS now prints a terminal message if its web content process terminates, before retaining Tauri's existing reload behavior.

Desktop NEFs using the LibRaw camera profile now decode through the existing native LibRaw library before reading compressed RAW bytes into the webview. Rust returns camera RGB16 through binary IPC, with previews reduced to the requested size before transfer. Native LibRaw and Nikon helper decoding share a two-job limit. Cancellation stops queued jobs before decoding and active jobs at LibRaw progress callbacks or stage boundaries. Document reloads cancel outstanding jobs.

The native decoder preserves the current WASM gamma behavior, camera-profile identity, and Develop default matching. Native execution has a separate decoder revision. Unsupported inputs retain the existing WASM, Nikon helper, and embedded-preview fallback rules. Native input reads validate catalog access and file identity; dimensions are bounded before processing and output is checked before transfer.

The [native NEF decode comparison](performance/native-nef-decoding.json) found identical pixels across 162 million RGB16 samples from D500 and Z6 III previews and full-resolution portraits, including preview resizing. Camera matrices differed by at most 1.2e-7; compared capture metadata and original dimensions matched. In paired Linux development runs, cold first paint fell from 1812 to 1293 ms. An uncached photo selected after startup reached settled Fit quality in 800 ms, down from 1163 ms. These are single instrumented observations, not Mac measurements. Cancellation while queued now rejects without waiting for active decodes to finish; active cancellation remains cooperative at LibRaw progress or stage boundaries.

The native Nikon helper returns decoded pixels through binary IPC, avoiding base64 strings and JavaScript decoding loops. At most two helper decodes run concurrently. Catalog authorization, decoded-pixel validation, and the existing JSON diagnostic command remain in place.

Native export uses 1024-pixel tiles, bounded by the adapter limits, with the same neighborhood overlap as the existing renderer. A [paired 1-megapixel benchmark](performance/native-tile-comparison.json) reduced completed export time from 47.95 ms to 27.0 ms by cutting native calls from six to two. The larger tiles use more cached texture memory, about 103 MB in that workload instead of 46 MB. Adapters with smaller color attachment limits split multiple float outputs into separate draws. The renderer queries the adapter's texture limits instead of assuming a fixed maximum size.

Spatial filters compute interpolation weights from their sample offsets. This keeps those weights independent of a pixel's position inside a tile. The 1024-pixel boundary check caught and fixed a one-channel rounding difference between a full export and a separately rendered region.

Rust image operations use one shared Rayon pool with one logical CPU reserved for other work. Large rows run in parallel. Small images and systems that cannot create the pool use the serial path. Denoise and detail share neighbor calculations, and super-resolution reuses cubic interpolation weights.

Native previews currently read GPU pixels back into memory and send them to the webview for display. This is a working POC, not a zero-copy native display implementation. That transfer can make interactive previews slower than a browser GPU canvas even when the shader execution is fast.

## Editing and zooming

Interactive frames render before histogram analysis. A separate worker updates the histogram at a smaller resolution during a drag; settled analysis retains the existing resolution and all analysis taps. Completed preview frames can appear while newer inputs are queued within the same gesture. Release, cancellation, source changes, and tool changes reject obsolete frames. Interactive analysis cannot enable Auto Tone from an earlier slider value.

Photo switching keeps the inactive canvas tool stable across parent renders. Previously each quick frame updated diagnostics, recreated that tool value, and cancelled the pending settled frame. The [NEF navigation comparison](performance/native-nef-navigation.json) reduced preview requests from 1377 to 70 and main-canvas paints from 575 to 16 over the same interaction sequence. Fit reached settled quality and stopped painting while idle. Previously it continued painting 16 to 20 quick frames per second.

NEF navigation decodes one 2560-pixel preview instead of decoding the same half-size RAW twice for 720-pixel and 2560-pixel outputs. Nearby preloads use the same preview cache entry and start after the selected photo's pixels are ready. On the WASM fallback, an aborted active RAW conversion terminates its already-initialized LibRaw worker, releasing the queue for the next photo. Camera-profile settings and decoded pixels remain unchanged. The affected Mac user confirmed that commit `9b07c07` made Fit previews become sharp reliably, but new-photo decoding remained slow.

In the instrumented navigation run, cached selection reached settled quality in 479 ms and slider release in 129 ms. Neither reached settled quality within the five-second baseline observation window. A separate paired cold-open check measured 2097 ms before delaying neighboring preloads and 1838 ms afterward, both using the 2560-pixel source. These are single Linux observations, including decoding and presentation, not macOS latency measurements.

Zoom transforms and cached tiles appear without animation or fades. The main preview stays at Fit resolution while the detail viewer renders the visible region. Crop, mask, and point-color tools retain their existing enlarged preview resolution. Covered low-resolution tiles and offscreen prefetch completions no longer redraw the viewport. Prefetch uses spare cache space instead of repeatedly evicting other prefetched tiles.

After a small region confirms GPU support for the current document, missing visible tiles share one bounded render request where possible. CPU fallback keeps progressive single-tile rendering. During slider changes, sharp detail waits for a 100 ms pause; release resumes it immediately. Native display readback also flips rows during packing and exposes buffer views, removing JavaScript pixel copies. Neutral grain and vignette skip their identity shader pass.

The [paired interaction measurements](performance/native-interaction.json) compare the initial native POC (`d322123`) with these optimizations. Both used production frontend bundles and the same optimized diagnostics executable on a Ryzen 9 5900X and RTX 3080, with a 4000 by 2667 JPEG, an 896 by 613 CSS-pixel viewport, and DPR 2.

| Operation | Before | After |
| --- | ---: | ---: |
| Fit edit, median / p95 | 102 / 193 ms | 60 / 68 ms |
| Zoomed edit, median / p95 | 95 / 102 ms | 82 / 92 ms |
| Cached zoom, median / p95 | 45 / 149 ms | 19 / 20 ms |
| Cached pan response, median / p95 | 17 / 19 ms | 17 / 20 ms |
| Cold zoom to sharp detail | 3235 ms | 187 ms |
| Sharp detail after edit release | 2267 ms | 239 ms |
| Sharp detail while holding a slider still | 995 ms | 291 ms |

Repeated phases contain 12 measured samples after three warmups. This first comparison retained the existing adaptive preview resolution; at the shared 309 by 206 raster size, Fit edits also measured 102 ms before and 60 ms after. Cold zoom and restoration times are single observations. A roughly half-second rapid drag painted zero frames before and five afterward, with three histogram updates. The optimized run restored exact pixels and document state after cancellation; the baseline timed out on cancellation readiness after its timing phases completed.

A [follow-up slider comparison](performance/native-slider-quality.json) fixes excessive resolution reduction during dragging. The native controller measures pixel preparation and GPU execution separately from IPC queue delay. It can reduce resolution when processing is slow, but fixed transport delay no longer drives it down to its minimum. Native drag frames have a one-megapixel ceiling; refined and settled frames retain their existing resolution.

On the same Linux setup, this increased drag frames from 309 by 206 to 1224 by 816, about 16 times as many pixels. Production Fit edits measured 69 ms median and 87 ms p95, versus 62 and 66 ms before. Zoomed edits measured 85 and 96 ms, versus 79 and 91 ms. This trades a small latency increase for higher resolution. Cached zoom remained about one frame.

The development profile optimizes the Darkroom Rust crate at level 2 and native LibRaw at level 3. Debug assertions, overflow checks, and symbols retain their development settings. With the same 1224 by 816 frontend, the earlier Rust crate optimization reduced Fit edits from 93 to 76 ms median and zoomed edits from 120 to 88 ms. These timings use Vite development mode and are separate from the production comparison.

These Linux Xvfb measurements record canvas submission followed by a paint opportunity, not physical display presentation. Cached navigation is near one frame in this setup. Edited previews still take several frames, and uncached detail takes longer. Native readback and webview scheduling remain costs; this POC does not claim instant rendering or measured Windows/macOS latency.

## Verification

[Native pixel measurements](performance/native-renderer.json) passed all 29 cases covering source formats, edits, masks, geometry, analysis, and export-region agreement. Completed 1-megapixel export measured 32.6 ms on Vulkan versus 110.1 ms on hardware WebGL using the same RTX 3080. The benchmark reports preview timing, which can return before browser GPU work finishes, and export timing, which waits for pixel readback. Compare timings only after checking the recorded drivers and timing scope.

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

For interaction timings, build an optimized diagnostics executable that retains the local development URL:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --release --features diagnostics \
  --bin darkroom --locked --config 'profile.release.package.darkroom.debug-assertions=true'
node scripts/serve-develop-benchmark.mjs
```

The second command serves a production frontend on port 3000 with temporary benchmark access to its modules. It accepts a source checkout path for before/after comparisons. These hooks are absent from the shipping bundle. With that server running, use a separate terminal:

```sh
DARKROOM_SMOKE_BINARY=src-tauri/target/release/darkroom \
  DARKROOM_SMOKE_BENCHMARK=1 DARKROOM_BENCHMARK_MIN_DRAG_PAINTS=1 \
  DARKROOM_SMOKE_BENCHMARK_OUTPUT=/tmp/darkroom-interaction.json \
  node scripts/develop-workflow-smoke.mjs
```

Keep the benchmark executable separate if building the shipping app as well: `npm run build` replaces the release binary. The interaction runner records samples and optional latency budgets; `DARKROOM_BENCHMARK_EDIT_P95_MS`, `DARKROOM_BENCHMARK_ZOOM_P95_MS`, `DARKROOM_BENCHMARK_PAN_P95_MS`, and `DARKROOM_BENCHMARK_COLD_ZOOM_MS` make exceeded budgets fail the run. Stop the temporary frontend with Ctrl-C when finished.
