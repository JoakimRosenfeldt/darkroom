# Rust migration measurements

Rust speeds up catalog import and the migrated CPU kernels in these runs. The Linux app payload is much smaller. Startup through the automation harness and memory use did not improve. These measurements do not establish an application-wide speedup.

## Whole desktop app

Measured on 23 September 2026 on the same Linux workstation: AMD Ryzen 9 5900X, Linux 7.2.5, Node 24.21.0 automation, WebKitGTK 2.52.6, and an isolated 1600 × 1000 Xvfb display. Both builds use their production renderer and release backend. The Tauri build enables diagnostic folder selection so the harness can use native import without a dialog. Electron is the unchanged implementation at `3917042`, with its folder dialog selecting the same fixture.

Each app ran five times with a fresh profile and a catalog containing 1,000 copies of the seven bundled JPEGs. Values are medians. Memory is the sum of proportional set size (PSS) for the app and its child processes, excluding automation drivers.

| Measurement | Electron | Rust/Tauri | Change |
| --- | ---: | ---: | ---: |
| Import click to 1,000 visible catalog entries | 695 ms | 504 ms | 27.5% faster |
| Automation launch to bridge and first button | 829 ms | 1,281 ms | 54.5% slower |
| Idle PSS, one second after ready | 355.2 MiB | 364.6 MiB | 2.7% higher |
| Library PSS, ten seconds after queries | 627.5 MiB | 750.4 MiB | 19.6% higher |
| Complete catalog snapshot including IPC | 33.35 ms | 42.00 ms | 25.9% slower |

The startup measurement includes different driver handshakes: Playwright for Electron and WebDriver for Tauri. It is not an isolated process-start benchmark. Import stops when the count is visible, before all background metadata and thumbnails finish. Twenty full catalog queries per run follow import immediately and contend with that background work; the table pools those 100 samples. The ten-second memory snapshot is neither peak memory nor a guarantee that every background task has settled. The raw files also include the earlier two-second snapshot, individual times, RSS, and process counts.

This is a synthetic JPEG collection on one Linux machine. Xvfb uses software graphics; these results cannot predict physical GPU throughput, a large RAW collection, or macOS/Windows behavior. Linux uses WebKit's document-viewer cache policy because Darkroom owns its photo caches; a separate five-run check did not show a material memory improvement from that setting alone.

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
