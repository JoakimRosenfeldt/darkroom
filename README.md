# Darkroom

A desktop photo library inspired by Lightroom. Darkroom reads photos directly from local folders on your machine — nothing is uploaded or copied to a server.

Built as an **Electron** app with a Next.js UI, native folder access, and automatic restoration of your last library on launch.

## Features

- **Native folder import** — pick a directory and browse supported images in place
- **No uploads** — files are read on demand from disk
- **Persistent library** — your last folder is remembered across app restarts
- **RAW support (NEF)** — Nikon NEF files decode via [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm), with the native Nikon SDK as a macOS fallback
- **Standard images** — JPEG, PNG, and WebP via native browser decoding
- **Virtualized grid** — handles large libraries without rendering every tile at once
- **Thumbnail cache** — decoded previews cached in IndexedDB by path and modification time
- **Photo detail view** — full decode preview with metadata sidebar

## Getting started

```bash
npm install
npm run electron:dev
```

This starts the Next.js dev server and opens the Electron window. Click **Import** in the toolbar and select a photo folder.

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

## Architecture

```
app/                    Next.js routes (client-only, static export)
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
- [Next.js 16](https://nextjs.org/) (App Router, static export)
- [React 19](https://react.dev/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- [Zustand](https://github.com/pmndrs/zustand) — library state
- [@tanstack/react-virtual](https://tanstack.com/virtual) — virtualized grid
- [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) — in-browser RAW decoding
- [idb-keyval](https://github.com/jakearchibald/idb-keyval) — IndexedDB helpers

## Limitations (v1)

- Read-only — no export or non-destructive editing yet
- Single folder library
- RAW decode is CPU-intensive; large NEF files may take a few seconds per thumbnail

## License

Private project.
