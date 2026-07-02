<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

Darkroom is a single-product Electron + Next.js 16 (static-export, webpack) desktop photo library. Standard commands live in `package.json`/`README.md`: `npm run lint`, `npm run build`, and `npm run electron:dev` (dev). No databases, secrets, or external services are needed.

Non-obvious caveats:

- **Run the GUI on the desktop display**: launch with `DISPLAY=:1 ELECTRON_DISABLE_SANDBOX=1 npm run electron:dev`. The container has no Electron sandbox, so it must be disabled, and the D-Bus / GPU-process errors printed to the log are benign. The Electron window (and a detached DevTools window) appear on `DISPLAY=:1`, viewable via computer use.
- **Auto-load photos without the native dialog**: the `Import` button opens a native OS folder dialog and is disabled outside Electron, so it is hard to drive programmatically. On launch the app auto-restores the last folder from `~/.config/darkroom/settings.json` — seed it with `{"lastFolderPath": "/workspace/public/demo"}` to load the 7 bundled demo photos (`public/demo`).
- `npm run dev` alone only serves the UI in a browser; native file access / IPC (`window.darkroom`) requires the full Electron app.
- Renderer console logs (`[darkroom:fs]`, `[Darkroom]`) go to the Electron DevTools console, not the `electron:dev` stdout/log.
- `scripts/capture-screenshots.mjs` mocks `window.showDirectoryPicker`, which the current import flow no longer uses (it uses Electron IPC), so that script is stale for driving imports.
- `npm run lint` currently reports pre-existing errors in the repo's existing code.
