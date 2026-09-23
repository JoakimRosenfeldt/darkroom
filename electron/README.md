# Compatibility reference

This directory preserves the previous backend for the existing catalog, recovery, migration, and file-operation regression checks. It is not built or loaded by the desktop app. All production desktop commands run in `src-tauri/src`.

`npm test` still exercises these reference implementations and shared TypeScript contracts. Native workflow checks and differential migration probes validate the Rust implementation separately. The Electron package remains a development dependency for type checking this reference code; it is excluded from Tauri installers.

For performance comparisons, use a separate checkout of the baseline commit, build it with its original scripts, and pass that checkout to `scripts/benchmark-desktop.mjs --electron-root=...`.
