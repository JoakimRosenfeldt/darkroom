# Darkroom

A desktop photo library inspired by Lightroom. Darkroom reads photos directly from local folders on your machine — nothing is uploaded or copied to a server.

Darkroom uses a Rust backend with Tauri 2, React, and Vite. Catalogs, file operations, metadata, history, exports, and background jobs run in Rust. The interface uses the operating system’s webview.

## Features

- **Native folder import** — pick a directory and browse supported images in place
- **No uploads** — files are read on demand from disk
- **Persistent library** — your last folder is remembered across app restarts
- **RAW support (NEF)** — Nikon NEF files decode via [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm), with the native Nikon SDK as a macOS fallback
- **Standard images** — JPEG, PNG, and WebP via native browser decoding
- **Virtualized grid** — handles large libraries without rendering every tile at once
- **Edited previews** — Library, filmstrip, and Compare render saved edits, with separate cache entries for each virtual copy and preview size
- **Photo editing** — crop, white balance, tone, masks, detail, presets, and persistent undo history
- **Actual-size viewing** — full-resolution 100% detail in Develop and linked Compare, including Retina displays
- **JPEG, PNG, WebP, AVIF, and TIFF export** — quality and size controls, embedded sRGB color information, metadata and GPS choices, collision handling, and cancellation

## Getting started

Install Node.js 24, stable Rust, and a C/C++ toolchain with libclang. Linux also needs GTK 3 and WebKitGTK 4.1 development libraries. See [Tauri’s platform prerequisites](https://v2.tauri.app/start/prerequisites/).

On Ubuntu 24.04:

```bash
sudo apt install build-essential libclang-dev libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev patchelf
npm ci
npm run desktop:dev
```

On macOS, install Xcode Command Line Tools. On Windows, install Visual Studio C++ Build Tools, LLVM, and WebView2. Set `LIBCLANG_PATH` if LLVM is outside the default installation path.

`desktop:dev` starts Vite on port 3000 and opens the desktop app. Click **Import folder**, create a catalog, and select a photo folder. `npm run dev` serves only the renderer; native access requires the desktop app.

### Production build

```bash
npm run build
npm start
```

`build` checks TypeScript, writes the renderer to `out/`, and builds the release Rust executable. `npm run typecheck`, `npm run lint`, and `npm run check:rust` run focused checks.

### Packaged app

```bash
npm run dist
```

Build on the target operating system. Installers are written to `src-tauri/target/release/bundle/`. Tauri uses WebKit on macOS/Linux and WebView2 on Windows; Electron and Node.js are not part of the shipped application.

The macOS package includes the private Nikon runtime from `~/.darkroom-sdk/nikon-nef`. Set `DARKROOM_NEF_SDK_ROOT` to use another location. Packaging validates the required files, signs the staged helper and frameworks, and records the helper checksum. Missing runtime files stop packaging. `APPLE_SIGNING_IDENTITY` selects the signing identity; Tauri’s usual signing and notarization variables apply to the app.

The Nikon helper also needs `prm.bin` under `Contents/Resources/Contents/Resources`; the packaging script preserves that layout.

### Existing libraries

Darkroom keeps the existing `darkroom` application data directory, SQLite catalog format, settings, presets, camera profiles, Develop assets, history, and recovery journals. Earlier catalog versions migrate through a validated staging database. Catalog backup and package import remain available in the Library controls.

Set `DARKROOM_USER_DATA` to a separate directory for development or measurement without touching your normal libraries.

## Architecture

```
app/                    React entry point, routes, and styles
components/             Library, Develop, Compare, and export controls
src-tauri/src/catalog/  SQLite catalogs, scans, import, migration, backups
src-tauri/src/develop/  History-linked batches, stores, assets, image jobs
src-tauri/src/native/   Native files, metadata, codecs, models, Nikon runtime
lib/desktop/            Typed Tauri transport and event subscriptions
lib/raw/                RAW decoding workers and profiles
lib/develop/            Develop documents and WebGL preview renderer
lib/cache/              Thumbnail and edited-image caches
stores/                 Renderer state
```

The renderer sends typed commands with catalog/session identifiers. Rust resolves file locations from the active catalog and validates paths. Photo reads and export pixels use binary IPC. Cancellable scans, import, metadata analysis, and image jobs run outside the UI thread.

Interactive previews retain the WebGL2 renderer, including its CPU fallback. RAW decoding remains in the existing LibRaw worker, with the qualified Nikon helper on macOS. Rust performs independent source/profile verification for automatic Develop defaults. Prototype image operations use native Rust kernels.

### Adding a new RAW profile

Profiles live in `lib/raw/profiles/`. Each profile implements the `ImageProfile` interface:

```typescript
// lib/raw/profiles/cr2.ts
import type { ImageProfile } from "../types";
import { decodeWithLibRaw } from "../libraw-client";

export const cr2Profile: ImageProfile = {
  id: "cr2",
  extensions: [".cr2"],
  detect: (file) => file.name.toLowerCase().endsWith(".cr2"),
  decode: (input, options) => decodeWithLibRaw(input, options),
};
```

Register it in `lib/raw/profiles/index.ts`:

```typescript
import { cr2Profile } from "./cr2";

registerProfile(cr2Profile);
```

For formats that need a different decoder than LibRaw, point `decode()` at a new worker module instead of `decodeWithLibRaw`.

## Supported formats

| Format | Profile ID | Decoder |
|--------|------------|---------|
| NEF    | `nef`      | libraw-wasm, then Nikon SDK fallback on macOS arm64 |
| JPEG   | `standard` | Browser `createImageBitmap` |
| PNG    | `standard` | Browser `createImageBitmap` |
| WebP   | `standard` | Browser `createImageBitmap` |

## Tech stack

- [Tauri 2](https://tauri.app/) and Rust — desktop host and backend
- SQLite through `rusqlite` — catalog and edit history
- [Vite](https://vite.dev/) for renderer development and builds
- [React Router](https://reactrouter.com/) for client navigation
- [React 19](https://react.dev/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- [Zustand](https://github.com/pmndrs/zustand) — library state
- [@tanstack/react-virtual](https://tanstack.com/virtual) — virtualized grid
- [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) — in-browser RAW decoding

## Limitations (v1)

- Output is 8-bit sRGB. Full-resolution output is limited to 50 megapixels.
- RAW qualification currently covers the bundled Nikon Z6 III files with the native Nikon decoder. Other cameras, lighting conditions, and automatic lens profiles need separate qualification.
- Full-resolution masked views can take several seconds. Export rendering runs in a worker so the interface remains responsive.
- The Nikon helper is required for the bundled high-efficiency NEFs. Embedded JPEG previews support culling, but editing and export require decoded RAW pixels.

## License

Private project.

## Check the local desktop workflow

Start the development server with `npm run dev`. In another terminal, run:

```bash
npm run test:develop:desktop
```

Install `tauri-driver` and a matching native WebDriver (WebKitWebDriver on Linux). The check uses the real Tauri backend, a temporary catalog, and copies of the bundled JPEG photos. Diagnostic builds select only the temporary import and export paths through environment variables. It checks edits, undo, redo, virtual copies, preset batches, edited previews, 100% detail, JPEG metadata, cancellation, and recovery after process interruption. It prints the location of screenshots, exported files, and timing results.

Set `DARKROOM_SMOKE_DRIVER` or `DARKROOM_SMOKE_NATIVE_DRIVER` for driver paths outside `PATH`. Set `DARKROOM_SMOKE_DRIVER_PORT` to change port 4460. Run under a desktop display or Xvfb on Linux. Set `DARKROOM_SMOKE_RAW` to a Nikon NEF to run the same workflow with RAW decoding; embedded previews do not qualify. `DARKROOM_SMOKE_BINARY` can select an existing diagnostic development build. Set `DARKROOM_SMOKE_REQUIRE_GPU=1` to require GPU previews and export in addition to pixel checks.

Development builds find the Nikon helper under `~/.darkroom-sdk/nikon-nef`. Set `DARKROOM_NEF_SDK_ROOT` or `DARKROOM_NEF_HELPER_PATH` to use another installation.

Experimental tools are available under **Develop > Edit > Advanced**. The normal editor keeps histogram, white balance, and tone in **Basic**.
