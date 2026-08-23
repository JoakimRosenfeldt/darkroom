# Darkroom feature inventory vs Lightroom parity

This is a source audit of the running wiring in `app/`, `components/`, `electron/`, `hooks/`, `lib/`, `stores/`, `types/`, `tests/`, `package.json`, and `README.md`. I did not run the GUI, use external sources, or infer a feature from a filename alone.

Status labels:

- `working`: a user path reaches real state, rendering, file I/O, or persistence.
- `partial`: the path works, but has a material scope, fidelity, platform, or workflow limit.
- `UI only or simulated`: the visible path is explanatory, test-only, or produces a simulated result rather than the requested production result.
- `dead/unreachable`: documentation or code describes a path that the current runtime does not wire.
- `missing`: no runtime path was found in the audited tree.

"Lightroom parity" below means the usual library, curation, Develop, and delivery feature classes expected of a Lightroom-style desktop photo manager. It does not claim a comparison against a particular Adobe release.

## Executive readout

| Area | Status | What is present | Main parity blocker |
| --- | --- | --- | --- |
| Import and catalog | `partial` | Recursive local-folder scan, NEF/JPEG/PNG/WebP decode, per-root JSON catalog, last-folder relink | One active local folder; no broad RAW/video support, watched index, cloud sync, or multi-library workflow (`lib/fs/types.ts:10-20`, `electron/catalog-store.ts:11-39`, `stores/library-store.ts:81-85`). |
| Browse and curation | `working` / `partial` | Virtualized grids, folder tree, flat albums, archive, flags, five-star ratings, five color labels, sorting and format filters | No library search or smart collections; folder selection is direct-parent only; date sort uses file mtime, not capture time (`lib/library/folders.ts:66-94`, `lib/library/curation.ts:119-158`). |
| Viewer | `partial` | Single-photo Develop route, filmstrip, zoom, before/original hold, crop, metadata sidebar | No compare, survey, synced multi-view, or full viewer/navigation modes (`app/photo/page.tsx:10-53`, `components/viewer/Filmstrip.tsx:71-79`). |
| Develop | `working` / `partial` | Exposure/tone/color, curves, HSL mixer, detail effects, crop geometry, WebGL rendering, XMP sidecars | No profiles/lens correction/dehaze/color grading/calibration tool path; RAW fidelity can fall back to an embedded preview (`components/develop/EditPanel.tsx:126-140`, `lib/develop/types.ts:80-90`, `components/develop/DevelopCanvas.tsx:575-578`). |
| Masks and AI | `working` / `partial` | Brush, linear, radial, add/subtract components, local basic adjustments, subject and sky masks | AI selection is only subject/sky, desktop-only, model-download dependent, and downscales inference to 2,048 px (`lib/ai/types.ts:1-20`, `lib/ai/image-preparation.ts:7-8`, `components/develop/AiMaskActions.tsx:362-365`). |
| Presets, history, batch edits | `partial` / `missing` | Per-photo undo/redo capped at 100 entries; reset controls; multi-select for curation/export | No preset browser/save/apply, copy/paste settings, sync-settings, batch Develop, or visible/persistent history panel (`stores/develop-store.ts:78-80`, `stores/develop-store.ts:157-184`). |
| Export | `working` / `partial` | JPEG/PNG/WebP/AVIF/TIFF, resize, quality/lossless where supported, conflict handling, batch progress | Native encoder removes alpha and writes pixels without a metadata-preserving export path; jobs run sequentially and are desktop-only (`electron/export-service.ts:652-689`, `lib/export/runner.ts:150-264`). |
| File operations | `working` / `partial` | Archive, remove from album, move source files to system trash | No rename, move, copy, duplicate, or import-to-catalog-without-folder workflow (`hooks/useLibraryContextMenu.tsx:335-354`, `electron/fs-service.ts:116-134`). |
| Performance and platform | `partial` | Virtualization, thumbnail IDB/memory cache, in-flight dedupe, bounded decode queues, macOS/Windows/Linux packaging targets | Full Develop/export decodes remain expensive; NEF native fallback is macOS-only and the packaged SDK is private; no mobile app (`lib/cache/develop-image-cache.ts:20-22`, `electron/main.ts:80-96`, `scripts/package-release.mjs:16-38`). |

## Import, formats, and catalog persistence

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Native folder import | `working` | The toolbar opens Electron's native `openDirectory` dialog, activates the selected real path, then scans it (`electron/main.ts:272-293`). The renderer converts each scanned file into a `LibraryEntry` and reports progress (`lib/fs/directory.ts:12-43`). |
| Recursive folder scan | `working` / `partial` | The scanner walks subdirectories breadth-first and sorts relative paths. It skips dot-prefixed names and unsupported/non-regular entries, and aborts after 10,000 visited directories (`electron/fs-service.ts:18-72`). There is no live filesystem watcher or incremental catalog update in this path. |
| Supported import formats | `partial` | The actual file gate accepts only `.nef`, `.jpg`, `.jpeg`, `.png`, and `.webp` (`lib/fs/types.ts:10-20`). This excludes common Lightroom inputs such as DNG, CR2/CR3, ARW, RAF, ORF, RW2, HEIF/HEIC, video, and audio. Those exclusions are based on the actual extension gate, not on a decoder filename. |
| RAW decode | `partial` | `lib/raw/decode.ts` registers exactly two profiles, standard and NEF (`lib/raw/decode.ts:8-13`). NEF first uses LibRaw, then can call the native fallback, and finally falls back to the embedded preview (`lib/raw/profiles/nef.ts:39-105`). LibRaw is configured for 8-bit output and serializes one LibRaw instance (`lib/raw/libraw-client.ts:25-49`). |
| Native NEF fallback | `partial` | The production Nikon helper path is real, but only on macOS or through an explicitly configured development helper (`electron/main.ts:80-96`). A packaged macOS build requires private Nikon runtime files that are not in this repository, so the production helper cannot be verified from source (`scripts/package-release.mjs:176-200`). |
| Mock NEF helper | `UI only or simulated` | The repository's checked-in helper is test-only. Its README says it writes a deterministic gradient and never decodes the input (`native/nikon-nef-decoder/README.md:1-5`, `native/nikon-nef-decoder/README.md:98-102`). It does not invalidate the separate production protocol, but it cannot prove production Nikon decoding. |
| Standard-image metadata | `partial` | JPEG/PNG/WebP use browser `createImageBitmap` and return only `{format, source: "standard"}` metadata (`lib/raw/profiles/standard.ts:104-127`). Their dimensions render, but camera EXIF/IPTC/XMP is not parsed by this profile. |
| RAW metadata | `partial` | LibRaw metadata is carried into decoded images and the sidebar maps a small capture set, including make, model, lens, focal length, aperture, shutter, ISO, and timestamp (`components/viewer/MetadataPanel.tsx:12-21`, `components/viewer/MetadataPanel.tsx:64-115`). This is display-only; it is not a complete metadata editor. |
| Per-root catalog | `working` | Catalogs are JSON files under the Electron user-data `catalogs` directory, keyed by a hash of the resolved root path (`electron/catalog-store.ts:6-39`). Version 1 migrates to version 2, which stores entry metadata, flat albums, and archive IDs (`lib/catalog/types.ts:28-44`, `lib/catalog/types.ts:115-146`). |
| Catalog write behavior | `working` / `partial` | Catalog writes debounce for 300 ms and serialize through a per-root promise queue (`lib/catalog/persistence.ts:10-43`). It stores curation and Develop documents, but not the view settings, which live separately in browser local storage (`hooks/useLibraryViewSettings.ts:11-26`, `hooks/useLibraryViewSettings.ts:110-125`). |
| Last-folder restore and relink | `working` | Settings persist only `lastFolderPath` and export preferences (`electron/settings.ts:19-38`). Bootstrap checks the saved path, restores it, or exposes a re-link state when it is missing (`stores/library-store.ts:803-865`, `app/page.tsx:170-205`). |
| Catalog scope | `partial` | The store has one active root and four views: all, one folder path, one flat album, or archive (`stores/library-store.ts:81-85`). There is no multi-root library, collection hierarchy, cloud catalog, sync conflict flow, or offline/online account path. |
| Scan failure behavior | `partial` | Scans time out after 90 seconds, with a message that specifically warns about iCloud, OneDrive, and Google Drive synced folders (`stores/library-store.ts:213-237`). That is a failure guard, not a cloud-library integration. |
| Scan progress and cancellation | `partial` | Electron finishes the recursive filesystem scan before renderer-side progress begins. The progress count then walks the returned array, and cancel invalidates the result generation without aborting the filesystem work already running (`lib/fs/directory.ts:16-40`, `stores/library-store.ts:223-271`, `stores/library-store.ts:895-910`). |

## Browse, grid, search, and curation

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Contact-sheet grid | `working` | `PhotoGrid` packs square rows and virtualizes them with overscan 6 (`components/library/PhotoGrid.tsx:24-60`). Tiles load only near the viewport through an `IntersectionObserver` (`components/library/PhotoTile.tsx:69-111`). |
| Justified/dynamic grid | `working` | `DynamicPhotoGrid` probes aspect ratios, packs justified rows, virtualizes them with overscan 4, and groups headers by the entry's `lastModified` date and parent folder (`components/library/DynamicPhotoGrid.tsx:105-155`, `components/library/DynamicPhotoGrid.tsx:277-307`). |
| Selection | `working` | Single selection, Cmd/Ctrl toggling, Shift range selection, grid arrows, Enter to open, and Escape to clear are wired in the store and grid shortcut hook (`stores/library-store.ts:367-406`, `hooks/useEntryMetadataShortcuts.ts:127-235`). |
| Folder tree | `working` / `partial` | The side panel builds nested folder nodes and counts files (`lib/library/folders.ts:24-64`, `components/shell/SidePanel.tsx:313-360`). Selecting a folder filters only files whose immediate parent exactly equals that path; it does not include descendants (`lib/library/folders.ts:66-81`). |
| Albums | `working` / `partial` | Create, rename, delete, add, and remove work and persist to the catalog (`stores/library-store.ts:504-661`). Albums are flat records with `name` and `entryIds`, not nested collections or rule-based smart collections (`lib/catalog/types.ts:20-26`). |
| Archive | `working` / `partial` | Archive removes photos from active views and also removes their album membership. Restore clears only the archive flag, so the previous album memberships are not restored (`stores/library-store.ts:663-735`, `lib/library/archive.ts:3-31`). It is an internal catalog state, not a source-file move. |
| Flags, ratings, labels | `working` | Pick/reject/unflagged, 0-5 stars, and red/yellow/green/blue/purple labels are applied to one or many selected entries, persisted in the catalog, and exposed in the grid and Develop footer (`stores/library-store.ts:408-447`, `components/library/EntryMetadataBar.tsx:75-135`). |
| Curation filters | `working` / `partial` | The filter popover exposes pick state, rated, exact 1-5 ratings, five color labels, and RAW/standard filters (`components/shell/LibraryToolbar.tsx:308-414`). There is no search text, keyword predicate, face predicate, camera/lens predicate, or smart collection predicate. |
| Sort behavior | `partial` | The UI offers file name, "Capture date", rating, and pick status (`components/shell/LibraryToolbar.tsx:44-52`). The date implementation sorts `LibraryEntry.lastModified`, which the scanner sets from filesystem mtime (`lib/library/curation.ts:119-158`, `electron/fs-service.ts:61-67`), not the EXIF capture timestamp. |
| Format-filter label | `partial` | The underlying standard profile includes WebP (`lib/raw/profiles/standard.ts:3-4`), but the toolbar labels the standard filter "JPEG / PNG" and omits WebP (`components/shell/LibraryToolbar.tsx:95-99`, `components/shell/LibraryToolbar.tsx:396-414`). |
| Library search | `missing` | The library toolbar's only filter controls are flag, rating, color label, and file type (`components/shell/LibraryToolbar.tsx:282-414`). The only text search control found in the audited UI is album-name filtering inside the add-to-album popup (`components/library/AlbumPickerPopup.tsx:145-162`). |
| Smart collections and saved searches | `missing` | `CatalogView` has no smart-collection variant and the persisted `Album` shape has no rule/query field (`stores/library-store.ts:81-85`, `lib/catalog/types.ts:20-26`). |
| People, faces, keywords, geotags, maps, and capture-based grouping | `missing` | No runtime state or UI path for these fields appears in the catalog type, toolbar filters, metadata panel, or module list (`lib/catalog/types.ts:7-42`, `components/viewer/MetadataPanel.tsx:12-21`, `components/shell/ModuleSpine.tsx:27-43`). |

## Metadata and viewer

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Metadata sidebar | `working` / `partial` | The Info panel displays file name, profile, dimensions, selected capture fields, and an expandable dump of decoded metadata (`components/viewer/MetadataPanel.tsx:64-119`, `components/develop/DevelopSidePanels.tsx:53-67`). Standard images supply almost none of the capture fields because their profile returns only format/source metadata (`lib/raw/profiles/standard.ts:119-127`). |
| Metadata editing | `missing` | Catalog `EntryMetadata` contains only pick, rating, color label, Develop, and timestamps (`lib/catalog/types.ts:7-18`). XMP writes rating, label, Develop controls, and Darkroom mask data, but no editor for EXIF/IPTC/keywords/caption/copyright/GPS (`lib/develop/xmp.ts:119-150`). |
| Single-photo route | `working` | `/photo?id=...` resolves an entry and renders `PhotoViewer`; invalid or missing IDs show a library fallback (`app/photo/page.tsx:10-53`). |
| Filmstrip navigation | `working` / `partial` | The filmstrip virtualizes thumbnails, shows index/selection state, and provides previous/next controls (`components/viewer/Filmstrip.tsx:71-101`, `components/viewer/Filmstrip.tsx:121-187`). Entering `/photo` discards the current library view, filters, sort order, and archive scope; it passes every catalog entry sorted by filename, which can navigate from an album into unrelated or archived photos (`app/page.tsx:73-104`, `app/photo/page.tsx:12-17`, `app/photo/page.tsx:53`). |
| Zoom and pan | `working` | The canvas toggles between fit and a detail zoom on click and supports panning at detail zoom (`components/develop/DevelopCanvas.tsx:430-462`). |
| Before/original view | `working` / `partial` | Holding `\\` toggles `showOriginal`, and the renderer receives that flag (`components/develop/DevelopCanvas.tsx:464-482`, `lib/develop/renderer.ts:1771-1818`). This is a hold-to-view original state, not a side-by-side or split compare. |
| Compare and survey views | `missing` | The only viewer route is the single `PhotoViewer`, and the filmstrip only selects a relative photo (`app/photo/page.tsx:53-53`, `components/viewer/Filmstrip.tsx:71-79`). No compare/survey state or component path is present in the audited tree. |
| Viewer keyboard controls | `working` / `partial` | Arrow navigation, crop Enter/Escape, mask O/K/M/Shift+M/Delete, Ctrl/Cmd+Z, Shift+Z redo, and Escape back to Library are wired (`components/viewer/PhotoViewer.tsx:443-557`). Library curation shortcuts cover P/X/U, 0-5, color-label keys, arrows, Enter, and Escape (`hooks/useEntryMetadataShortcuts.ts:22-85`, `hooks/useEntryMetadataShortcuts.ts:127-235`). No runtime shortcuts for search, compare, presets, copy/paste settings, or batch Develop exist. |

## Develop controls and rendering

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Basic light controls | `working` | The Edit panel exposes exposure, contrast, highlights, shadows, whites, and blacks (`components/develop/EditPanel.tsx:174-205`). The settings schema and command store persist and render those values (`lib/develop/types.ts:1-12`, `stores/develop-store.ts:240-274`). |
| White balance and global color | `working` | Temperature, tint, vibrance, and saturation are exposed and dispatched through the same Develop document (`components/develop/EditPanel.tsx:207-233`, `lib/develop/types.ts:80-87`). |
| Tone curves | `working` | The UI supports RGB and individual red/green/blue curve points, with reset and drag/add/delete interactions (`components/develop/EditPanel.tsx:236-253`, `components/develop/ToneCurveEditor.tsx:46-285`). |
| HSL/color mixer | `working` | Eight color bands, each with hue, saturation, and luminance, are represented in the schema and panel (`lib/develop/types.ts:41-57`, `components/develop/EditPanel.tsx:256-334`). |
| Detail and effects | `working` | The Detail tab contains sharpening, noise reduction, vignette, and grain controls (`components/develop/EditPanel.tsx:337-399`). The renderer binds those effects in its WebGL shader (`lib/develop/renderer.ts:1918-2000`). |
| Crop and geometry | `working` / `partial` | Crop supports free/original/aspect presets, custom ratios, rotation, perspective X/Y, distortion, drag handles, and auto-straighten (`components/develop/CropPanel.tsx:91-178`, `components/viewer/PhotoViewer.tsx:692-737`). Geometry is not a full Lightroom Transform/lens-correction tool. |
| Auto-straighten | `working` / `partial` | The heuristic estimates an angle from luminance projections, caps the analyzed edge at 240 px, and limits the result to ±15 degrees (`lib/develop/auto-straighten.ts:3-5`, `lib/develop/auto-straighten.ts:60-144`). |
| Rendering backend | `working` / `partial` | The renderer applies crop, global controls, curves, mixer, effects, and masks through WebGL2 (`lib/develop/renderer.ts:69-191`, `lib/develop/renderer.ts:1893-2002`). It throws when WebGL2 is unavailable (`lib/develop/renderer.ts:1072-1112`), with no alternate CPU Develop renderer. |
| RAW source fidelity | `partial` | Native NEF output can be 16-bit RGB, but the fallback protocol accepts only sRGB and the Develop canvas explicitly warns when it edits an embedded preview (`electron/nef-decoder-service.ts:38-50`, `native/nikon-nef-decoder/README.md:60-65`, `components/develop/DevelopCanvas.tsx:575-578`). |
| Lens/camera correction and advanced tools | `missing` | `DevelopSettings` contains only basic, crop, curve, mixer, effects, and masking (`lib/develop/types.ts:80-90`), and the global plugin registry exposes those same five global plugins (`lib/develop/registry.ts:15-39`). No runtime path exists for profiles, lens correction, chromatic aberration/defringe, Texture, Clarity, Dehaze, B&W controls, Point Color, Color Grading, Calibration, histogram/clipping warnings, heal/clone/remove, red-eye, rotate/flip, HDR merge, panorama, or soft proof (`components/develop/DevelopPanelRail.tsx:5-17`, `components/develop/EditPanel.tsx:126-140`). |
| Reset controls | `working` | Each visible Develop section has a reset path and the panel has Reset all (`components/develop/EditPanel.tsx:67-99`, `components/develop/EditPanel.tsx:145-170`). |
| Non-destructive Develop persistence | `working` / `partial` | The active session mirrors edits into the catalog and debounces XMP writes for 500 ms; a newer sidecar can hydrate the catalog document (`components/develop/useDevelopSettingsSync.ts:80-109`, `components/develop/useDevelopSettingsSync.ts:170-224`). The XMP representation is a Darkroom subset, not a full Lightroom settings interchange implementation (`lib/develop/xmp.ts:119-150`). |
| Develop history | `partial` | Undo/redo covers document and metadata edits, with a bounded 100-entry in-memory stack per session (`stores/develop-store.ts:19-40`, `stores/develop-store.ts:78-80`, `stores/develop-store.ts:289-326`). There is no visible history panel and the history stack is not part of the persisted catalog document. |
| Presets | `missing` | No preset type, preset storage, preset browser, save preset, or apply preset control exists in the Develop rail/panel or Develop store API (`components/develop/DevelopPanelRail.tsx:5-17`, `stores/develop-store.ts:157-184`). |
| Copy/paste, sync, and batch Develop | `missing` | Multi-selection is wired into curation and export targets, but `DevelopStore` exposes only one active `entryId` and per-entry document commands (`components/viewer/PhotoViewer.tsx:184-189`, `stores/develop-store.ts:157-184`). No copy/paste settings or apply-to-selected Develop action is present. |

## Masks and AI selection

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Brush masks | `working` / `partial` | The masking panel and overlay create brush strokes with size, feather, flow, and density, and local Basic adjustments apply to the mask (`components/develop/MaskingPanel.tsx:208-237`, `components/develop/MaskingPanel.tsx:337-342`, `lib/develop/types.ts:123-140`). |
| Linear and radial gradients | `working` | Both components are represented, selectable, and rendered; add/subtract operations are stored per component (`lib/develop/types.ts:142-159`, `components/develop/MaskingPanel.tsx:281-331`, `components/viewer/PhotoViewer.tsx:746-798`). |
| Mask composition | `working` / `partial` | Masks support enable/disable, invert, reorder, duplicate, delete, and up to 64 components per mask (`components/develop/MaskingPanel.tsx:239-344`, `lib/develop/document.ts:25-31`). The document validator caps the whole document at 16 masks (`lib/develop/document.ts:405-410`). |
| Mask rendering and persistence | `working` / `partial` | Mask raster assets are embedded as validated PNG/Base64 payloads and uploaded as WebGL texture-array layers (`lib/develop/document.ts:362-410`, `lib/develop/renderer.ts:1645-1759`). The hard limits and WebGL texture-layer/device limits are materially smaller than an unconstrained desktop editor. |
| AI subject/sky selection | `working` / `partial` | The only model IDs and selectors are `subject` and `sky` (`lib/ai/types.ts:1-2`). Desktop UI can download, cache, run, cancel, retry, and update masks (`components/develop/AiMaskActions.tsx:362-475`). WebGPU falls back to ONNX WASM CPU (`lib/ai/inference-worker.ts:448-487`). |
| AI model availability | `partial` | Models are downloaded to a private app cache and verified before offline use (`electron/ai-model-manifest.ts:15-16`, `electron/ai-model-service.ts:350-539`). Browser mode only displays an explanatory "desktop app" message (`components/develop/AiMaskActions.tsx:495-503`). |
| AI fidelity and scope | `partial` | Source preparation first caps the oriented source at 2,048 px. The subject model then runs at 512×512 and the sky model at 384×384 before the matte is resized back up (`lib/ai/image-preparation.ts:90-129`, `lib/ai/inference-worker.ts:18-19`, `lib/ai/inference-worker.ts:393-411`, `electron/ai-model-manifest.ts:18-40`). There is no path for people, background, object, depth-range, sky refinement, AI denoise, or AI enhance models (`lib/ai/types.ts:1-20`, `components/develop/AiMaskActions.tsx:73-77`). |

## Presets, history, copy/paste, and batch workflows

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Per-photo undo/redo | `working` / `partial` | Buttons and Ctrl/Cmd+Z/Shift+Z call the active session's undo/redo (`components/viewer/PhotoViewer.tsx:507-511`, `components/viewer/PhotoViewer.tsx:632-647`). The stack is session memory and capped at 100 entries (`stores/develop-store.ts:78-80`). |
| Metadata undo/redo | `working` / `partial` | Metadata changes are recorded as history entries and can call a metadata writer on undo/redo (`stores/develop-store.ts:328-342`, `stores/develop-store.ts:289-326`). This does not create a persistent catalog-wide history timeline. |
| Reset one section/all settings | `working` | Global plugin reset commands are wired to the visible panel and Reset all button (`stores/develop-store.ts:268-274`, `components/develop/EditPanel.tsx:93-99`). |
| Preset save/apply/manage | `missing` | No preset data model, storage, menu, or command appears in the Develop store API or panel rail (`stores/develop-store.ts:157-184`, `components/develop/DevelopPanelRail.tsx:5-17`). |
| Copy/paste Develop settings | `missing` | No copy/paste command or clipboard serialization path exists in `lib/develop/commands.ts` or `stores/develop-store.ts`; the only multi-entry actions in the viewer are selection and export (`lib/develop/commands.ts:20-59`, `components/viewer/PhotoViewer.tsx:184-189`). |
| Batch Develop / sync settings | `missing` | Export loops over selected entries, but its loop resolves each entry's own document and renders it; it does not apply one source document to other entries (`lib/export/runner.ts:150-208`). |
| Batch metadata curation | `working` | The library store applies one patch to every selected entry and records each change (`stores/library-store.ts:408-447`). |
| Batch export | `working` / `partial` | The export dialog accepts multiple selected entries and reports per-file success, skip, failure, and warning states (`components/export/ExportDialog.tsx:315-363`, `components/export/ExportDialog.tsx:604-631`). Processing is sequential (`lib/export/runner.ts:170-242`). |

## Export and delivery

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Export formats | `working` / `partial` | The native service advertises JPEG, PNG, WebP, AVIF, and TIFF, filtered by Sharp capabilities (`electron/export-service.ts:75-114`, `electron/export-service.ts:1013-1021`). This is output-format support, not broad input support. |
| Export sizing | `working` | The dialog supports original, long-edge, fit-within, and never-upscale controls (`components/export/ExportDialog.tsx:462-529`, `components/export/ExportDialog.tsx:561-570`). The boundary caps output at 50 MP and 100,000 px edge (`lib/export/types.ts:10-12`). |
| Quality and lossless | `working` / `partial` | JPEG/ WebP quality and WebP lossless are exposed where the format descriptor allows them (`components/export/ExportDialog.tsx:480-540`, `electron/export-service.ts:75-113`). PNG/TIFF are encoded with fixed native settings. |
| Destination selection | `working` | Single-file exports use a save dialog; batches use a directory picker; the main process validates destinations and selected library sources (`electron/export-service.ts:1023-1117`, `electron/main.ts:448-481`). |
| Conflict handling | `working` | Rename, skip, and replace are implemented with target-safety checks and a provenance registry (`components/export/ExportDialog.tsx:550-559`, `electron/export-service.ts:1120-1235`). |
| Export rendering | `working` / `partial` | The runner resolves active session edits first, then newer XMP than catalog, decodes full resolution, renders through the Develop renderer, and encodes the result (`lib/export/runner.ts:116-130`, `lib/export/runner.ts:170-240`). Full source dimensions are supported when decode succeeds, but every export is read back from WebGL as 8-bit RGBA; there is no 16-bit TIFF render path (`lib/develop/renderer.ts:1825-1827`, `lib/develop/renderer.ts:2237-2245`). Embedded-preview exports carry warnings, but they are still exportable. |
| Export metadata and alpha | `partial` | The native encoder takes raw 8-bit RGBA and calls `.removeAlpha()` before writing (`electron/export-service.ts:652-689`). No path passes original EXIF/IPTC/XMP metadata into Sharp or writes export metadata, and transparent input cannot retain alpha. |
| Export progress/cancel | `working` | The UI shows decode/render/encode progress and stops before the next file when cancelled (`components/export/ExportDialog.tsx:261-279`, `components/export/ExportDialog.tsx:588-600`). |
| Export availability | `partial` | The dialog explicitly says export is desktop-only (`components/export/ExportDialog.tsx:433-440`). The browser route can render the dialog shell but cannot perform native destination/encode IPC. |

## Keyboard commands and file operations

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Curation shortcuts | `working` | P, X, U, 0-5, color-label keys, arrows, Shift range, Enter open, and Escape clear are implemented (`hooks/useEntryMetadataShortcuts.ts:22-85`, `hooks/useEntryMetadataShortcuts.ts:127-235`). |
| Develop shortcuts | `working` / `partial` | Crop Enter/Escape, mask O/K/M/Shift+M/Delete, undo/redo, arrows, and Escape back to Library are wired (`components/viewer/PhotoViewer.tsx:456-557`). No command palette or discoverable complete shortcut map exists. |
| Remove from imported | `working` | "Remove from imported" archives selected IDs and removes them from active views (`hooks/useLibraryContextMenu.tsx:335-344`, `stores/library-store.ts:663-699`). |
| Remove from album | `working` | The context menu calls album membership removal without deleting the source (`hooks/useLibraryContextMenu.tsx:315-333`, `stores/library-store.ts:609-637`). |
| Remove from disk | `working` / `partial` | Confirmation passes source paths to Electron, which moves them sequentially to system Trash/Recycle Bin (`components/library/DeleteFromDiskConfirm.tsx:43-100`, `electron/fs-service.ts:116-134`). If a later file fails, earlier files may already be in Trash while the store retains all requested catalog entries because it catches the aggregate failure (`stores/library-store.ts:737-759`). |
| Rename/move/copy/duplicate source | `missing` | The exposed filesystem actions are scan/read/stat/trash and sidecar read/write; no source rename, move, copy, duplicate, or import-copy action is wired (`lib/fs/directory.ts:46-82`, `electron/fs-service.ts:75-134`, `electron/preload.ts:70-86`). |
| Write sidecars | `working` / `partial` | XMP sidecars use `${name}.xmp` for NEF and `${base}.xmp` for standard files, with active-root and symlink containment checks (`electron/main.ts:124-176`). Sidecars preserve existing XML but only Darkroom's supported Develop, rating, and color-label subset is read and written. Pick/reject state remains catalog-only (`lib/develop/xmp.ts:119-165`, `components/develop/useDevelopSettingsSync.ts:265-274`). |

## Performance, caching, and scale limits

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Thumbnail cache | `working` | Thumbnails use an IndexedDB key of relative path + mtime, a 300-item memory LRU, and in-flight request deduplication (`lib/cache/thumbnail-cache.ts:5-27`, `lib/cache/thumbnail-cache.ts:66-110`, `lib/cache/thumbnail-cache.ts:113-163`). |
| Aspect-ratio cache | `working` / `partial` | Standard image headers and LibRaw dimensions feed a persisted aspect-ratio cache; RAW probes still read and decode file data (`components/library/useEntryAspectRatios.ts:47-79`, `components/library/useEntryAspectRatios.ts:81-116`). |
| Develop image cache | `partial` | Only three Develop images are retained, previews are capped at 2,560 px, and adjacent photos are preloaded (`lib/cache/develop-image-cache.ts:20-22`, `lib/cache/develop-image-cache.ts:75-105`, `lib/cache/develop-image-cache.ts:143-159`). Full-resolution export and AI inference bypass this cache (`lib/cache/develop-image-cache.ts:108-134`). |
| Decode concurrency | `working` / `partial` | Thumbnail work is limited to two concurrent jobs and aspect probes to eight (`lib/cache/concurrency.ts:102-116`). LibRaw itself remains a serialized singleton (`lib/raw/libraw-client.ts:9-37`). |
| Grid scale strategy | `working` | Both grid modes use TanStack virtualization and tiles load near the viewport, so the DOM does not render every library tile at once (`components/library/PhotoGrid.tsx:54-60`, `components/library/DynamicPhotoGrid.tsx:147-155`, `components/library/PhotoTile.tsx:69-111`). |
| Catalog scale | `partial` | A scan fails after 10,000 visited directories and the store times out at 90 seconds (`electron/fs-service.ts:18-33`, `stores/library-store.ts:213-237`). There is no background indexer, preview-generation queue across launches, or file-watch update path. |
| Browser storage claim | `partial` / `dead/unreachable` | The README says the library index snapshot is saved to IndexedDB (`README.md:60-64`), but the runtime catalog is JSON through Electron IPC (`lib/catalog/persistence.ts:46-64`, `electron/catalog-store.ts:11-39`). IndexedDB is used for caches, not the catalog (`lib/cache/idb.ts:1-93`). |
| Catalog reset | `partial` | The visible Reset action has no confirmation and deletes the per-root catalog. This removes albums, archive state, picks, and other catalog-only metadata, although source files remain in place (`components/shell/SidePanel.tsx:278-294`, `stores/library-store.ts:913-925`). |

## OS, platform, and packaging

| Capability | Status | Runtime evidence and observed difference |
| --- | --- | --- |
| Desktop shell | `working` | The app is an Electron 43 desktop app with Next static export, native file access, Sharp, LibRaw, ONNX runtime, and Zustand (`package.json:18-43`, `package.json:48-113`). |
| Browser mode | `partial` | Library bootstrap reports that the app must run as a desktop app when native access is unavailable (`components/shell/LibraryBootstrap.tsx:24-34`). Export and AI also stop at explicit desktop-only messages (`components/export/ExportDialog.tsx:433-440`, `components/develop/AiMaskActions.tsx:495-503`). |
| Packaged targets | `partial` | Release staging defines macOS arm64, Windows x64, and Linux x64 targets (`scripts/package-release.mjs:16-38`). The Electron Builder config has mac arm64 DMG/ZIP, Windows NSIS, and Linux AppImage targets (`package.json:67-112`). There is no evidence of mac Intel, Windows ARM, Linux ARM, iOS, or Android packaging. |
| Nikon SDK packaging | `partial` | macOS release packaging fails if private Nikon runtime files are missing, while non-macOS native NEF fallback returns unavailable (`scripts/package-release.mjs:176-200`, `electron/nef-decoder-service.ts:449-457`). LibRaw and embedded-preview paths remain available where they succeed. |
| Local-only data model | `working` / `partial` | Source files stay in the chosen local folder and catalog/XMP/model caches are local app data (`README.md:3-5`, `electron/settings.ts:141-180`, `electron/ai-model-service.ts:285-311`). There is no account, cloud sync, shared library, or cross-device state path. |

## Hidden, unfinished, and contradictory paths

| Finding | Status | Evidence and impact |
| --- | --- | --- |
| README says read-only/no export/no non-destructive edits | `dead/unreachable` | The limitations still say "Read-only" and "no export or non-destructive editing" (`README.md:113-117`), but the current app writes XMP and exports through native IPC (`components/develop/useDevelopSettingsSync.ts:241-289`, `electron/main.ts:448-511`). The limitation text is stale. |
| README describes an extensible profile registry | `dead/unreachable` | The README points to `lib/raw/profiles/index.ts` and a CR2 example (`README.md:66-91`), while the runtime decoder uses a hardcoded `PROFILES` array with only standard and NEF (`lib/raw/decode.ts:8-13`). No runtime registration API is wired. |
| Screenshot driver uses the old browser picker | `dead/unreachable` | `scripts/capture-screenshots.mjs` mocks `window.showDirectoryPicker` and clicks an Import button (`scripts/capture-screenshots.mjs:34-80`, `scripts/capture-screenshots.mjs:102-125`), but current import uses Electron `dialog.showOpenDialog` IPC (`electron/main.ts:272-293`, `components/shell/FolderPickerButton.tsx:3-107`). The script cannot prove the current import flow. |
| Mock NEF decoder | `UI only or simulated` | The mock is deliberately test-only and produces a deterministic gradient without reading the input (`native/nikon-nef-decoder/README.md:98-102`). It must not be counted as production Nikon support. |
| Product modules | `partial` | The module spine exposes only Library and Develop (`components/shell/ModuleSpine.tsx:7-43`). The app routes are only `/` and `/photo` (`app/page.tsx:35-53`, `app/photo/page.tsx:10-67`). There are no import-manager, map, book, print, slideshow, web, publish, settings, preset, compare, or account routes. |
| Test coverage | `partial` | The repository has only crop geometry, NEF decoder service, and RAW utility tests (`tests/crop-geometry.test.mts:1-75`, `tests/nef-decoder-service.test.mts:25-335`, `tests/raw-utils.test.mts:1-68`). There are no UI/integration tests for import/catalog, grids, metadata, Develop, masks, keyboard, or export. |

## Parity gap matrix

This matrix ranks gaps by how directly they prevent a Lightroom-style workflow. It is a prioritization aid, not a claim about Adobe's internal implementation.

| Priority | Gap | Status | Exact current boundary | Evidence |
| --- | --- | --- | --- | --- |
| P0 | Library search | `missing` | No photo-name/metadata/keyword search predicate or control | `components/shell/LibraryToolbar.tsx:282-414`, `components/library/AlbumPickerPopup.tsx:145-162` |
| P0 | Smart collections/saved searches | `missing` | Only flat albums and all/folder/album/archive views | `lib/catalog/types.ts:20-26`, `stores/library-store.ts:81-85` |
| P0 | Compare/survey | `missing` | One active `PhotoViewer` with previous/next filmstrip | `app/photo/page.tsx:53-53`, `components/viewer/Filmstrip.tsx:71-79` |
| P0 | Presets | `missing` | No preset model, storage, browser, save, or apply path | `stores/develop-store.ts:157-184`, `components/develop/DevelopPanelRail.tsx:5-17` |
| P0 | Copy/paste and batch Develop | `missing` | Develop commands address one active entry; multi-select only drives curation/export | `stores/develop-store.ts:157-184`, `components/viewer/PhotoViewer.tsx:184-189` |
| P0 | Metadata editing | `missing` | Displayed metadata is not editable; persisted metadata is curation plus Develop | `lib/catalog/types.ts:7-18`, `lib/develop/xmp.ts:119-150` |
| P0 | Capture-time sorting | `partial` | "Capture date" sorts filesystem mtime | `lib/library/curation.ts:119-158`, `electron/fs-service.ts:61-67` |
| P0 | Broad RAW/input formats | `partial` | File gate and profiles only accept NEF/JPEG/PNG/WebP | `lib/fs/types.ts:10-20`, `lib/raw/decode.ts:8-13` |
| P1 | Camera/lens profiles and corrections | `missing` | No settings or panel path for profiles, lens correction, CA, dehaze, calibration | `lib/develop/types.ts:80-90`, `lib/develop/registry.ts:15-39` |
| P1 | Advanced color/HDR workflows | `missing` | No color grading, HDR merge, panorama, soft proof, or camera calibration path | `components/develop/EditPanel.tsx:126-140`, `lib/develop/types.ts:80-90` |
| P1 | Persistent history panel | `partial` | Undo/redo exists, but history is session memory capped at 100 and has no panel | `stores/develop-store.ts:19-40`, `stores/develop-store.ts:78-80` |
| P1 | AI selection breadth | `partial` | Only subject and sky models, max 2,048 px inference edge | `lib/ai/types.ts:1-2`, `lib/ai/image-preparation.ts:7-8` |
| P1 | Metadata-preserving export | `partial` | Raw RGBA is encoded after alpha removal with no metadata injection | `electron/export-service.ts:652-689` |
| P1 | Multi-root/cloud catalog | `partial` | One active local root, per-root JSON, no sync/account path | `stores/library-store.ts:81-85`, `electron/catalog-store.ts:11-39` |
| P2 | Rename/move/copy/duplicate files | `missing` | Only scan/read/stat/trash and sidecar operations are exposed | `lib/fs/directory.ts:46-82`, `electron/fs-service.ts:75-134` |
| P2 | Module breadth | `partial` | Only Library and Develop routes/modules exist | `components/shell/ModuleSpine.tsx:7-43`, `app/photo/page.tsx:56-67` |
| P2 | Mobile/cross-device delivery | `missing` | Packaging targets are desktop Electron only | `scripts/package-release.mjs:16-38`, `package.json:67-112` |
