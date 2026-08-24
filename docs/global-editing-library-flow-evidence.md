# Global editing and Library flow evidence

This file records the Step 0 baseline for the global editing and Library flow plan. It does not mark Gate 0 as complete.

## Baseline identity

| Field | Recorded value |
| --- | --- |
| Base commit | `1a488197e8fe48217b4b802291666bf9788ee78d` |
| Process behavior | Frozen v2, `version: 2` |
| Working tree before implementation | Clean; the orchestrator later created an untracked screenshot directory at `docs/pr-screenshots/global-editing-library-flow/`. |
| Contract process | `darkroom-v3`, `version: 3` |
| Baseline capability tier | `baseline-sdr-rgba8` |
| Coordinate frame | `oriented-source-normalized-bottom-left-v1` |
| Semantic stage registry | `darkroom-v3-semantic-stages-1` |

## Recorded automated checks

The orchestrator ran these commands on the untouched base commit before implementation.

| Command | Recorded result |
| --- | --- |
| `npm test` | Passed, 241 of 241 tests. |
| `npm run build` | Passed. The output contained the existing workspace-root warning and two circular chunk warnings. |
| `npm run lint` | Failed with one existing error at `hooks/useScrollToSelectedRow.ts:20`. It also reported existing TanStack incompatible-library warnings at `components/library/DynamicPhotoGrid.tsx:147`, `components/library/PhotoGrid.tsx:54`, and `components/viewer/Filmstrip.tsx:49`. |

These results prove the base command state. They do not prove v2 pixel parity or any v3 capability.

## Recorded code hashes

Each value is a SHA-256 hash of the file content from commit `1a488197e8fe48217b4b802291666bf9788ee78d`.

| File | SHA-256 |
| --- | --- |
| `lib/develop/types.ts` | `958aacdd4e9f91294e2935b040ec4342924124b5703d7d8551e95e0f7964ebcb` |
| `lib/develop/document.ts` | `7a3b3cdeb6b8de68494405f2930897185cdcdd369dfd4e45a00be92cf7136928` |
| `lib/develop/renderer.ts` | `5afd2cbb7f29f0b4cc2ee7fc13d8cdb1440f8a7eea16ffd0ebaed7f4e60999c7` |
| `lib/develop/source-transform.ts` | `e7eb99647a2d4c07e963fc1ac7b85ada5b2da6abf91f659a866f18e402dc044b` |
| `lib/develop/xmp.ts` | `52c390643dec67cf3a944a0dfa67339a22f16a21bf9065d1c3b36952124f9ecb` |
| `lib/raw/libraw-client.ts` | `81079c3c374831a098e24fb20840020ebfc1999bddf03fe3452c87c41636e2a1` |
| `lib/raw/profiles/nef.ts` | `7af3b21f318d8213e26284512ed3e88d46331e044f29f1ecd71d23bc8ffbe2e9` |
| `lib/raw/profiles/standard.ts` | `565da707261d68a82101bfa3886eb2f67bff8448432c100c417eba28bd60330c` |
| `lib/export/runner.ts` | `c64f802a3a6111f2ef1314de5c2752743c699b6c9c9de4b2453aa19ef27c5a43` |
| `electron/export-service.ts` | `dfdd0afb4fa66b71a2912850dcc5e9265fc949edea51646dd23eebc1e604a302` |
| `electron/nef-decoder-service.ts` | `3c5d91c2b2af4e1dc69afb31c92197642c8de96de22bf3b9b668500fb7e1a16b` |
| `electron/ai-model-manifest.ts` | `062933d8a5d9139027ec16aa52980c1706406351368d184e3fa08aee2071cefc` |

Regenerate the table from the base commit with:

```sh
for file in lib/develop/types.ts lib/develop/document.ts lib/develop/renderer.ts lib/develop/source-transform.ts lib/develop/xmp.ts lib/raw/libraw-client.ts lib/raw/profiles/nef.ts lib/raw/profiles/standard.ts lib/export/runner.ts electron/export-service.ts electron/nef-decoder-service.ts electron/ai-model-manifest.ts; do
	git show "1a488197e8fe48217b4b802291666bf9788ee78d:$file" | shasum -a 256 | awk -v file="$file" '{print $1 "  " file}'
done
```

## Recorded source fixture hashes

The bundled demo files are source fixtures. They are not captured v2 documents or rendered output fixtures.

| File | SHA-256 |
| --- | --- |
| `public/demo/city-night.jpg` | `970a68a6cc4497b67ca44ec34cbf6e9f75f334bb39eb686cfc9d79b08abce457` |
| `public/demo/coastal-light.jpg` | `3f902b789ab1711be778b0390cb38ca468c9bb9696f5d92c54907ec894166ed7` |
| `public/demo/desert-glow.jpg` | `f7a3c9d1bb8ad49864cdcccaa934bb8e1aeb8c58b0ab507e9e07c58551368a94` |
| `public/demo/forest-path.jpg` | `96d8b5a4cf01e1809190c5c8eb492a2ee91daedd406847c2dca78f661f9cfc2c` |
| `public/demo/lake-reflection.jpg` | `43058a676a28837a924c0306c92fa070f45bc384d2f6c92f6ce25e8f5ef1ddd3` |
| `public/demo/mountain-dawn.jpg` | `f1d07ecaa28e641221f182f19e38588a2966793b9450812e7bf3edd3c3aed58f` |
| `public/demo/portrait-street.jpg` | `3fa9e43fcb9edc933e33870b9523c0a7a296fb0691faa866bf4eb7ced383a3e7` |

Regenerate the table with `shasum -a 256 public/demo/*`.

## Current capability decisions

`BASELINE_CAPABILITY_REPORT` in `lib/develop/process.ts` is the code contract for these decisions.

| Capability | Current evidence | Required behavior |
| --- | --- | --- |
| Qualified native Nikon source decode | The native protocol accepts RGB16LE with 16 bits per component, sRGB color, and sRGB transfer. The renderer accepts the `Uint16Array` through its RGB16UI upload path. | Preserve the precision and provenance in `SourceRecord`. Do not describe the later render or export path as high-bit. |
| Active LibRaw decode | `lib/raw/libraw-client.ts` requests `outputBps: 8`. | Use the current 8-bit result and emit a precision diagnostic. |
| Standard-image decode | Browser canvas returns RGBA8. | Use the current RGBA8 result. Do not infer an input profile that the decoder did not provide. |
| Intermediate render and readback | No RGBA16F probe has passed. Current WebGL readback uses `UNSIGNED_BYTE`. | Keep the SDR RGBA8 path. Block high-bit claims. |
| Full-resolution export assembly | The current renderer uses overlapping tiles and assembles the full output before RGBA8 readback. | Preserve tiled assembly without describing its final pixel payload as high-bit. |
| Export boundary | `electron/export-service.ts` requires four bytes per pixel before Sharp encode. | Block requested high-bit output unless a later full-path probe changes the capability report. |
| Input and camera profiles | No end-to-end ICC fixture or licensed camera profile dataset is present. | Use decoder-provided color only when provenance proves it. Otherwise report unavailable input characterization. |
| Lens profiles | No licensed lens profile dataset is present. | Keep automatic profile correction neutral and visible. Allow built-in manual optics controls only. Never substitute unrelated lens data. |
| Subject and Sky models | Both local models have pinned revisions, licenses, and artifact checksums. | These are the only currently accepted local model families. |
| People, Reflection, and Dust models | No accepted licensed local model is present. | Offer manual cleanup. Do not generate or claim model output. |
| Depth model | No accepted licensed local depth model is present. | Block generated depth and Lens Blur claims. |
| Proof transform and gamut warning | No profile transform or gamut fixture has passed. | Disable proof and gamut claims. Keep proof controls in view state, outside persisted edits. |
| HDR display and output | No Electron HDR display or encoder metadata probe has passed. | Use an explicit SDR preview and retain `scene-headroom`. Block HDR output unless a future probe proves the full path. Do not add HDR merge. |

## Explicit capability tiers

| Tier | Status | Limit |
| --- | --- | --- |
| `baseline-sdr-rgba8` | Implemented | This is the only current end-to-end preview and export tier. Its v2 output hashes are still missing. |
| High-bit SDR | Unsupported until proven | Typed high-bit decode, RGBA16F intermediates, typed readback, and typed export must all pass on the target platform. A high-bit source alone does not qualify the tier. |
| HDR display | Unsupported until proven | Electron display state, the scene-linear path, the display transfer, and visual verification must all pass. |
| HDR output | Unsupported until proven | The typed render path, the encoder, the output profile, the transfer, and HDR metadata must all pass. |
| Proof and gamut | Unsupported until proven | A licensed profile source, the proof transform, the out-of-gamut mask, and fixtures must all pass. |

## Manual evidence still required

No output hash has been recorded for the following v2 cases:

- decoded NEF
- embedded-preview NEF
- JPEG
- PNG
- crop
- curve
- mixer
- masks
- sharpening
- noise reduction
- full-resolution export

Each manual run must record the source hash, the canonical v2 document hash, the output hash, the output dimensions, the decoder provenance, the command or UI procedure, and the observed result. Export runs must also record the decoded output bit depth, profile, transfer, and dimensions.

The following v3 probes are also still required:

- LibRaw 16-bit output
- standard-image profile decode
- RGBA16F intermediate render targets
- typed tiled readback
- Sharp bit-depth and profile metadata
- HDR display state
- proof transforms and gamut masks
- camera-profile, saturated-color, gradient, HDR, and proof fixtures

Run the Electron manual checks with `DISPLAY=:1 ELECTRON_DISABLE_SANDBOX=1 npm run electron:dev`. Seed `~/.config/darkroom/settings.json` with `{"lastFolderPath":"/workspace/public/demo"}` only when the workspace uses the documented `/workspace` layout. Otherwise, set `lastFolderPath` to this checkout's `public/demo` directory.

## Gate 0 status

Gate 0 is open. The code contracts assign one owner to each state class and semantic stage, and the capability matrix names unsupported paths. The gate remains open because v2 output fixtures are missing, the high-bit path is not proven end to end, profile and model sources remain unavailable, and no HDR or proof path has passed.

## Implementation evidence

The feature branch now contains the full code path described by the plan:

- exact Library query and ordered-ID snapshots, including missing-entry handling and explicit refresh;
- one current-process Develop editor and one version-aware repository for legacy input, XMP, catalog persistence, undo, redo, render, export, and batch work;
- automatic legacy-document migration with live source validation, copied mask-asset validation, persisted-revision verification, and no UI path back to the legacy process;
- strict current documents, retained migration compatibility data, stale-source checks, semantic render plans, SDR RGBA8 preview, and tiled export;
- input-profile and optics capability states, canonical geometry, global tone and color, live analysis, presence, detail, local masks, manual cleanup, generated-job contracts, HDR and proof capability blocks, and exact-result batch policy;
- production UI for one Crop/Edit/Mask/Cleanup/Info flow, Auto Tone, histogram and diagnostics, zoom, pan, hold-to-view Before, manual crop, local and AI masks, white-balance and Point Color sampling, and per-photo batch selection.

Unsupported high-bit, HDR, proof, licensed profile, depth, People, Reflection, and Dust paths remain visible and blocked. The implementation does not substitute data or silently reduce those claims.

## Live Electron run

The run used the seven bundled demo photos through the real Electron bridge and a temporary application profile.

| Case | Observed result |
| --- | --- |
| Exact Library result | The Library showed all seven ordered demo entries and retained the selected first photo. |
| Develop navigation | `city-night.jpg` opened as photo 1 of 7 with the saved filmstrip order. |
| Unified editor | Develop opened directly into one current editor with Crop, Edit, Mask, Cleanup, and Info rail actions. No process-version choice or comparison screen was shown. |
| Source identity | A real fractional filesystem modification time passed unchanged through the v3 source, asset, and generated-job validators after their contracts were aligned with the catalog identity. |
| Automatic migration | `coastal-light.jpg` was seeded with a legacy crop, geometry, RGB curve, denoise, and sharpening document with no sidecar. Concurrent opens shared one hydration and write, migrated without user input, reached `Saved · SDR · 8-bit output`, and a direct catalog query confirmed persisted version 3 without a sidecar race. |
| Canvas inspection | The migrated photo exposed Fit, zoom, pan, and hold-to-view Before controls in the same editor. Before used the decoded, EXIF-oriented source. |
| Preview response | On a 1,707 by 2,560 source, the isolated CPU path rendered active slider frames in `51 ms` and settled frames in `163 to 170 ms`. The live Electron canvas began updating `88 ms` after slider input and settled `162 ms` after release. |
| Auto Tone | The accepted analysis wrote ordinary stored values: Exposure `+0.59 EV`, Contrast `+4`, Highlights `0`, Shadows `+2`, Whites `-8`, and Blacks `-3`. Undo became available. |
| Masks | The unified Mask panel loaded a persisted brush mask and exposed rename, copy, reorder, delete, size, feather, flow, density, invert, local adjustments, and Subject/Sky actions. The local models remained undownloaded, so inference was not run. |
| Batch scope | The dialog selected the exact seven-photo stored result and named the current semantic group. A catalog revision change blocked execution until the explicit `Refresh result` action, as required. |

The screenshots under `docs/pr-screenshots/global-editing-library-flow/` record the Library result, unified editor, Auto Tone control, Cleanup panel, mask tools, and exact batch selection.

## Final command state

| Command | Result |
| --- | --- |
| `npm test` | Passed, 241 of 241 tests. |
| `npm run build` | Passed. The output retained the existing workspace-root warning and two circular chunk warnings. |
| `npx tsc --noEmit --pretty false` | Passed after the production build completed. |
| Scoped ESLint on changed TypeScript files | Passed during each correction pass. |
| `git diff --check` | Passed on the final working tree. |
| `npm run lint` | Matched the baseline: one existing error in `hooks/useScrollToSelectedRow.ts` and three existing TanStack incompatible-library warnings. |

## Remaining gate status

The implementation steps are present, but the evidence gates remain conservative:

- Gate 1 has live exact-result navigation evidence. A complete hard-refresh, every-filter, missing-entry matrix is still absent.
- Gate 2 remains open because the Step 0 v2 pixel fixtures were not available.
- Gate 3 has a passing standard-image SDR RGBA8 migrated edit. It remains open for the required v2 hashes and decoded export metadata matrix.
- Gates 4 through 7 have contracts, controls, render stages, persistence, and manual workflows. Their full camera, lens, geometry, color, detail, cleanup, and export fixture matrices are still absent.
- Gates 8 and 9 remain open because the required licensed models, depth, HDR, and proof capabilities are unavailable.
- Gate 10 has exact-selection and stale-result evidence. The full changed, skipped, and failed per-photo persistence matrix is still absent.
- Gate 11 remains open because the plan's full fixture matrix was not supplied or run.
- Gate 12 is evaluated from the created pull request.

For the same reason, the pull request describes the implemented capability boundaries instead of claiming that unsupported or unverified outcomes are complete.
