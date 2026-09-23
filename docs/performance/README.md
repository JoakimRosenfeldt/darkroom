# Rust migration measurements

Rust speeds up catalog import and the migrated CPU kernels in these runs, and uses less idle memory. The Linux app payload is much smaller. Startup through the automation harness and loaded-library memory did not improve. These measurements do not establish an application-wide speedup.

## Packaging builds

An unchanged `npm run dist -- --bundles deb` fell from **97.104 seconds to 4.294 and 4.314 seconds** after fixing build invalidation (about 95.6% less time). Both repeated builds preserved the executable's SHA-256. Cargo's part fell from about 93 seconds to 0.22–0.23 seconds. The initial build after the fix still took 97.508 seconds; this is a warm-build improvement, not a claim that compiling changed Rust code became 23 times faster.

Measured on 23 September 2026 on the Linux Ryzen 9 5900X workstation described below, using Node 24.21.0 and Rust 1.98.1. Dependencies were already compiled. The baseline was commit `92926f0`; it ran once to warm its cache, then once unchanged. The revised pipeline likewise ran once to warm its cache, then twice unchanged. Timings include TypeScript checks, Vite, Rust, and Debian packaging, and used a monotonic wall clock. [Recorded samples](build-times.json) contain the individual runs. These small samples do not predict macOS signing, DMG creation, Windows installers, cold builds, or changed-code builds.

There were two independent invalidation causes. The release script passed new temporary Nikon paths into `TAURI_CONFIG`, which Tauri's Rust build script watches. Vite also rewrote identical assets that Rust tracks through `include_bytes!`; the baseline Cargo trace identified the unchanged `out/window.svg` as stale. Compilation now uses stable configuration, with the temporary runtime configuration applied by a separate `tauri bundle` command. Vite builds into a temporary directory and copies only changed output into `out`, retaining unchanged file and directory timestamps. Rust also watches the output directory so newly added and removed assets trigger compilation. Type checking, release optimization, signing, startup checks, and decoded-output validation remain enabled.

The user also measured `npm run dist` on macOS at commit `2725bc6`: **197.250 seconds first run, 34.687 seconds unchanged** (82.4% less wall time). These user-reported totals include macOS packaging; they do not isolate compilation from signing or DMG creation.

### Rebuilding changed Rust code

The application crate now uses 16 codegen units and incremental release compilation. Optimization level 3, thin LTO, stripping, and dependency compilation settings are retained. On the same Linux workstation, rebuilding after changing a live error-message string in `src-tauri/src/native/nef.rs` took **93.217 seconds** with the previous profile, **35.442 seconds** on the first candidate build, then **17.485 and 17.656 seconds** for two further edits with a warm incremental cache: about **81% less time** than the baseline. The source was restored after measurement.

These are Cargo release executable build times, excluding renderer compilation and packaging. This measures one small native-module edit, with dependencies already built, one baseline and two warm candidate samples. It does not predict arbitrary pulls, broad source changes, changed dependencies, cold builds, or macOS results. Incremental artifacts use additional disk space under `src-tauri/target`; deleting that directory loses the benefit. [Recorded samples](changed-build-times.json) include the command and settings. Codegen partitioning can affect runtime performance even with the same optimization level; the runtime comparison below checks specific workloads, not every editing operation.

Runtime checks compared the previous and revised release diagnostic backends sequentially on the same workstation: 400 synthetic catalog entries, one warmup and five samples per operation. Catalog projections, approved file reads, and decoded pixels from all four image operations matched exactly. Median native job times (including IPC and artifact encoding) were:

| Operation | Previous profile | Incremental / 16 codegen units |
| --- | ---: | ---: |
| Depth | 11.367 ms | 11.846 ms |
| Denoise | 45.325 ms | 44.235 ms |
| Raw details | 41.752 ms | 42.397 ms |
| Super resolution | 112.031 ms | 115.720 ms |

The eight-query catalog batch's backend median was 51.330 → 51.386 ms. Twenty approved 32 KB reads took 2.3445 → 2.3449 ms round trip. Image-operation differences were small and mixed (2.4% faster to 4.2% slower); these samples demonstrate no runtime gain and do not establish equivalent performance for every workload. [Runtime samples and output hashes](release-profile-runtime.json) preserve the evidence. The release profile change targets build time, not editing speed.

For repeated coding, `npm run desktop:dev` avoids release linking and provides live frontend updates. On macOS, `npm run dist -- --bundles app` skips DMG creation, and adding `--debug` selects a packaged local-testing build without release optimization. The first build of either profile can still take time.

## Whole desktop app

Measured on 23 September 2026 on the same Linux workstation: AMD Ryzen 9 5900X, Linux 7.2.5, Node 24.21.0 automation, WebKitGTK 2.52.6, and an isolated 1600 × 1000 Xvfb display. Both builds use their production renderer and release backend. The Tauri build enables diagnostic folder selection so the harness can use native import without a dialog. Electron is the unchanged implementation at `3917042`, with its folder dialog selecting the same fixture.

Each app ran five times with a fresh profile and a catalog containing 1,000 copies of the seven bundled JPEGs. Both used exactly 1440 × 900 content pixels at device pixel ratio 1, verified and recorded on every run. The harness sets GTK scaling for both child processes and sets Electron's content size explicitly. Values are medians. Memory is the sum of proportional set size (PSS) for the app and its child processes, excluding automation drivers.

| Measurement | Electron | Rust/Tauri | Change |
| --- | ---: | ---: | ---: |
| Import click to 1,000 visible catalog entries | 688.5 ms | 536 ms | 22.1% faster |
| Automation launch to bridge and first button | 828 ms | 1,273 ms | 53.8% slower |
| Idle PSS, one second after ready | 338.4 MiB | 288.5 MiB | 14.7% lower |
| Library PSS, ten seconds after queries | 646.7 MiB | 714.1 MiB | 10.4% higher |
| Complete catalog snapshot including IPC | 36.60 ms | 36.00 ms | 1.6% lower |

The startup measurement includes different driver handshakes: Playwright for Electron and WebDriver for Tauri, plus Electron's content resize and viewport validation. It is not an isolated process-start benchmark. Import stops when the count is visible, before all background metadata and thumbnails finish. Twenty full catalog queries per run follow import immediately and contend with that background work; the table pools those 100 samples. The small query difference is not evidence of a material gain given the sample variability. The ten-second memory snapshot is neither peak memory nor a guarantee that every background task has settled. The raw files also include the earlier two-second snapshot, individual times, RSS, and process counts.

This is a synthetic JPEG collection on one Linux machine. Xvfb uses software graphics; these results cannot predict physical GPU throughput, a large RAW collection, or macOS/Windows behavior. Linux uses WebKit's document-viewer cache policy because Darkroom owns its photo caches.

Raw results: [Electron](electron-desktop.json), [Rust/Tauri](rust-desktop.json). Harness: [`benchmark-desktop.mjs`](../../scripts/benchmark-desktop.mjs).

## App payload

The unpacked Linux payload fell from **529.3 MiB to 33.2 MiB**, a **93.7% reduction**. Electron was packaged with its original `electron-builder --linux --dir`; Tauri was built without diagnostics and bundled as a Debian package. The comparison uses `du -sb` on Electron's unpacked directory and Tauri's Debian `data` directory. The compressed Tauri `.deb` is 16.4 MiB.

Electron includes Chromium and Node; Tauri uses the installed WebKitGTK and GTK libraries. Their shared system footprint is excluded, so this is a payload comparison, not the full disk cost on a clean machine. Private macOS Nikon libraries, downloaded models, and development dependencies are excluded. [Exact byte counts](package-size.json).

## Native CPU kernels

The existing TypeScript prototype kernels and their Rust ports processed the same synthetic 512 × 512 RGBA input, with one warm-up and five timed samples. Rust uses release optimization, thin LTO, and one codegen unit. TypeScript runs in Node 24.21.0. Values are median milliseconds.

| Kernel | TypeScript | Rust | Ratio |
| --- | ---: | ---: | ---: |
| Depth | 11.70 | 2.14 | 5.46× |
| Denoise, strength 55 | 471.61 | 42.33 | 11.14× |
| RAW detail, amount 67 | 14.47 | 9.80 | 1.48× |
| Super resolution, 2× | 1,445.35 | 153.18 | 9.44× |
| Local removal | 6.06 | 4.10 | 1.48× |

These are deterministic prototype operations, not learned-model inference. Timings exclude IPC, decoding, PNG encoding, disk access, and UI rendering. Node is a kernel comparison harness, not the original Electron renderer engine. A separate small fixture comparison found exact output pixels and depth float bits for all five ports. The workstation was not CPU isolated.

Raw samples and method: [prototype-benchmark.json](prototype-benchmark.json). Reproduce with:

```sh
node --experimental-strip-types scripts/benchmark-prototypes.mjs
```

## GPU and workflow evidence

The existing Develop shaders stay on WebGL2. WebKit uses a DOM canvas on the main thread because worker WebGL is unavailable or unstable there; export tiles yield between draws. Other engines retain the GPU worker, with a CPU worker fallback. Temporary canvases and disposed GL contexts release their backing storage.

The real desktop JPEG and Nikon D500 NEF workflows each passed nine checks: edit/save/undo/redo, edited thumbnails and virtual copies, preset batch and undo, cancellation, full/detail pixel agreement, 100% scale, JPEG metadata/ICC/resize/collisions, recovery after process termination, and unchanged source hashes. Both runs required GPU previews and export and checked nonblank output. This verifies the GPU code path under software rendering, not hardware acceleration performance.

A separate release-renderer check opened the same NEF at `tauri://localhost` with the production content-security policy enabled. The decoded image rendered at 1704 × 2560 and the editor reached Saved, with no observed page or CSP errors.

[Workflow observations](desktop-workflow.json) retain the checks and timings. Screenshots: [JPEG](jpeg-reopened.png), [RAW](raw-reopened.png). The RAW fixture was a Nikon D500 sample from Photography Blog and is not bundled in the repository. The private Nikon SDK fallback was not available on this Linux host.

## Reproduce desktop measurements

Install the platform prerequisites, `tauri-driver`, and a matching WebKitWebDriver. Build the renderer and diagnostic release app:

```sh
npm run build:renderer
cargo build --manifest-path src-tauri/Cargo.toml --release --features custom-protocol,diagnostics --bin darkroom --locked
node scripts/benchmark-desktop.mjs --iterations=5 --output=/tmp/rust-desktop.json
```

Run under a suitable display, or `xvfb-run -a -s '-screen 0 1600x1000x24'`. The harness accepts `--driver`, `--native-driver`, and `--binary`. Build the Electron baseline's renderer and Electron entry point in a separate checkout, then use `--electron-root=/absolute/path/to/baseline`. Run the two apps sequentially without compilation or other GUI checks competing for resources. Every run uses temporary profiles and photo copies.
