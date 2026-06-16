# Darkroom

A client-side photo library inspired by Lightroom. Darkroom reads photos directly from local folders on your machine — nothing is uploaded or copied to a server.

## Browser requirements

Darkroom requires a **Chromium-based browser** (Chrome or Edge) because it uses the [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) for local folder access.

Safari and Firefox are not supported in v1.

## Features

- **Local folder import** — pick a directory and browse supported images in place
- **No uploads** — files are read on demand via `FileSystemFileHandle`
- **Folder persistence** — the last opened folder handle is stored in IndexedDB; re-grant access on return visits
- **RAW support (NEF)** — Nikon NEF files decode in the browser via [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm)
- **Standard images** — JPEG, PNG, and WebP via native browser decoding
- **Virtualized grid** — handles large libraries without rendering every tile at once
- **Thumbnail cache** — decoded previews cached in IndexedDB by path and modification time
- **Photo detail view** — full decode preview with metadata sidebar

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in Chrome or Edge, click **Open folder**, and select a directory containing photos.

### Production build

```bash
npm run build
```

The app is configured for static export (`output: "export"`) and can be deployed to Vercel, Cloudflare Pages, or any static host.

## Architecture

```
app/                    Next.js routes (client-only)
components/             UI: folder picker, grid, viewer
lib/fs/                 File System Access API + IndexedDB persistence
lib/raw/                Extensible decoder profile system
lib/cache/              Thumbnail cache
stores/                 Zustand library state
```

### Data flow

1. User picks a folder via `showDirectoryPicker()`
2. App scans recursively for supported extensions
3. Directory handle + library index snapshot saved to IndexedDB
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
| NEF    | `nef`      | libraw-wasm |
| JPEG   | `standard` | Browser `createImageBitmap` |
| PNG    | `standard` | Browser `createImageBitmap` |
| WebP   | `standard` | Browser `createImageBitmap` |

## Tech stack

- [Next.js 16](https://nextjs.org/) (App Router, static export)
- [React 19](https://react.dev/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- [Zustand](https://github.com/pmndrs/zustand) — library state
- [@tanstack/react-virtual](https://tanstack.com/virtual) — virtualized grid
- [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) — in-browser RAW decoding
- [idb-keyval](https://github.com/jakearchibald/idb-keyval) — IndexedDB helpers

## Limitations (v1)

- Chromium-only (no Safari/Firefox folder picker)
- Read-only — no export or non-destructive editing yet
- Single folder library
- RAW decode is CPU-intensive; large NEF files may take a few seconds per thumbnail

## License

Private project.
