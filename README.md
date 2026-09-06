# Darkroom

A desktop photo library inspired by Lightroom. Darkroom reads photos directly from local folders on your machine — nothing is uploaded or copied to a server.

Darkroom uses **Electron**, React, and Vite, with native folder access and automatic restoration of your last library on launch.

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
- **JPEG export** — quality and size controls, embedded sRGB profile, metadata and GPS choices, collision handling, and cancellation

## Getting started

```bash
npm install
npm run electron:dev
```

This starts the Vite dev server on port 3000 and opens the Electron window. Click **Import folder**, create a catalog, and select a photo folder.

Use Node.js 24 for development.

`npm run typecheck` checks TypeScript. `npm run build` checks types and writes the renderer to `out/` before building Electron.

### Production build

```bash
npm run build
npm run electron:start
```

### Packaged app

```bash
npm run dist
```

Installers are written to `release/`.

The macOS arm64 package injects the approved Nikon runtime from
`~/.darkroom-sdk/nikon-nef`. Set `DARKROOM_NEF_SDK_ROOT` to use another private
location. Packaging fails when a required runtime file is missing.

The Nikon helper expects `prm.bin` under `Contents/Resources/Contents/Resources` in the packaged app. The release configuration copies it there.

## Architecture

```
app/                    React entry point, routes, and styles
components/             UI: folder picker, grid, viewer
electron/               Main process, preload, native file I/O
lib/fs/                 Folder scanning, file reads, persistence
lib/raw/                Extensible decoder profile system
lib/cache/              Thumbnail cache
stores/                 Zustand library state
```

### Data flow

1. User picks a folder via the native OS dialog (Electron `dialog.showOpenDialog`)
2. Main process scans recursively for supported extensions
3. Library index snapshot saved to IndexedDB; folder path saved in app settings
4. Thumbnails decode in the background (libraw-wasm worker for RAW, canvas for standard)
5. Full decode runs only on the photo detail page

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

- [Electron](https://www.electronjs.org/) — desktop shell and native file access
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

## Check the local RAW workflow

Start the development server with `npm run dev`. In another terminal, run:

```bash
npm run test:develop:electron
```

The check uses a temporary catalog and copies of the bundled photos. It checks edits, undo, redo, virtual copies, preset batches, edited previews, 100% detail, JPEG metadata, cancellation, and recovery after process interruption. It prints the location of screenshots, exported files, and timing results.

Set `DARKROOM_SMOKE_URL` if the server uses a different port. Set `DARKROOM_SMOKE_RAW` to test another Nikon file. The check expects a working RAW decoder; embedded previews do not qualify.

Development builds find the Nikon helper under `~/.darkroom-sdk/nikon-nef`. Set `DARKROOM_NEF_SDK_ROOT` or `DARKROOM_NEF_HELPER_PATH` to use another installation.

Experimental tools are available under **Develop > Edit > Advanced**. The normal editor keeps histogram, white balance, and tone in **Basic**.
