# Metadata and viewer flow evidence

This file records the implementation boundary for the metadata and viewer flow. It is a reference for review and issue closure.

## Ownership

| Data | Owner | Persistence | Rebuild source |
| --- | --- | --- | --- |
| Source metadata snapshot | Electron metadata service | `metadata-cache/<CatalogId>/<AssetId>.json` | Original asset bytes |
| Catalog metadata override | Catalog library workspace | Catalog v3 `library_state_json` | Catalog backup |
| Effective search projection | `buildQueryIndex` | Derived in memory | Source snapshot and catalog override |
| XMP sync baseline and conflicts | Catalog library workspace | Catalog v3 `library_state_json` | Catalog backup and current sidecar |
| Viewer session | Renderer | `sessionStorage` | Current library result |
| Reference photo identity | Renderer | `sessionStorage` by catalog | User selection |
| Prior XMP bytes | Electron | `xmp-backups/objects/<prefix>/<sha256>.xmp` | Exact pre-write sidecar bytes |
| XMP backup receipt | Electron | `xmp-backups/receipts/*.json` | Created before replacement or deletion |

Source facts do not enter catalog durability. Catalog overrides and XMP sync state do not enter the extraction cache.

## Field matrix

| Field | Embedded sources | Catalog edit | XMP node | Search or facet | Export |
| --- | --- | --- | --- | --- | --- |
| Title | XMP, IPTC, EXIF | Set, clear, reset | `dc:title` `x-default` | Text | XMP |
| Caption | XMP, IPTC, EXIF | Set, append, clear, reset | `dc:description` `x-default` | Text | XMP |
| Copyright | XMP, IPTC, EXIF | Set, clear, reset | `dc:rights` `x-default` | Text | XMP |
| Keywords | XMP, IPTC | Replace, append, clear, reset | `dc:subject` | Text and keyword facet | XMP |
| Capture time | EXIF | Set, clear, reset | `photoshop:DateCreated` | Capture sort and year facet | XMP |
| Latitude | EXIF GPS | Set, clear, reset | `exif:GPSLatitude` | Location projection | XMP |
| Longitude | EXIF GPS | Set, clear, reset | `exif:GPSLongitude` | Location projection | XMP |
| Camera and lens | EXIF or catalog fallback | Read-only | Preserved | Text, camera facet, lens facet | Not projected |
| ISO and focal length | EXIF | Read-only | Preserved | Range facets | Not projected |
| Dimensions, orientation, bit depth, and color space | Container, EXIF, ICC | Read-only | Not owned | Metadata panel | Output encoder owns dimensions and color space |

The XMP writer changes only owned nodes. It retains unknown namespaces, attributes, child nodes, and non-default language alternatives.

## Extraction

`metadata-analysis-service.ts` hashes the original asset before parsing. The cache identity contains the asset SHA-256, the `exifr` parser version, and either the standard or RAW adapter version.

Extraction runs outside preview decode. A failed parser result stays typed as unavailable or malformed. Manual re-read bypasses the cache. The service limits concurrency to a validated range from 1 through 16.

## Catalog editing

The metadata panel groups File, Capture, Description, Location, Develop and sync, and Diagnostics. Edit mode uses explicit **Save**, **Cancel**, and **Reset to source** actions.

The batch dialog applies one catalog operation to the selected IDs. Each field has Unchanged, Set value, and Clear modes. Caption and keyword fields support replace or append. Presets support create, update, duplicate, apply, and delete. An explicit XMP option publishes sidecars sequentially, reports progress, and counts conflicts and failures without hiding a completed catalog save.

Catalog metadata saves never publish XMP without an explicit action.

## XMP publication and recovery

Publication follows these checks:

1. The renderer reads the current sidecar and its modification time.
2. `reconcileMetadataXmp` compares the stored baseline, the catalog projection, and the sidecar projection.
3. A conflict blocks the write until the user chooses the catalog or the sidecar.
4. Electron checks the expected modification time before publication.
5. Electron stores the exact prior bytes by SHA-256 and writes a receipt.
6. Electron writes and syncs a temporary file.
7. Electron checks the sidecar again and renames the temporary file.
8. The renderer reads the published sidecar and stores its new digest, modification time, and baseline.

The content-addressed object permits recovery even after several later writes. Receipts do not store native asset paths.

## Mask interchange boundary

Darkroom keeps its versioned mask payload in `darkroom:MaskingData`. `lightroomMaskPreflight` classifies geometric masks and blocks unverified AI raster encodings. The XMP packet also stores stable mask and component IDs in `darkroom:LightroomMaskInterchange`.

The adapter does not claim a Lightroom round trip without an external Lightroom run. Lightroom Classic versions and operating systems remain an external acceptance requirement.

## Viewer behavior

`ViewerSession` stores the query revision, the ordered IDs, the active ID, and the origin selection. The photo route carries only the active ID and the short session ID.

If the library result changes, `resolveViewerSession` retains surviving IDs, appends new IDs in live order, and selects the nearest surviving active ID. An expired session rebuilds from the current result and displays a notice.

Before and After modes share the active source and Develop document. Side-by-side mode supports linked or independent transforms. Split mode uses one keyboard-accessible divider. Reference mode loads and renders each asset independently. Reference identity survives a renderer reload and clears when the app process ends.

Develop commands continue to target only the active entry. The Reference pane has no edit controls.

## Export

The export runner resolves the effective catalog override, the active Develop document, and the descriptive catalog fields. It serializes one XMP packet and passes the packet to Sharp with the rendered pixels. The output packet includes Develop settings, curation metadata, descriptive metadata, capture time, and coordinates when those values exist.

## Migration and rollback

The change does not add a SQLite schema migration. The catalog workspace parser supplies empty override, preset, and sync collections for older v3 catalogs.

Rollback can ignore the new workspace keys. Existing curation and Develop fields remain valid. Source metadata cache files are disposable. XMP backups remain available after rollback because the backup store is outside the catalog and the application bundle.

## Verification record

Local verification on macOS arm64:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| `npm run build` | Pass. Next.js 16.2.10 static export and Electron bundles completed. |
| `npm test -- --runInBand` | Pass. 241 tests passed. |
| `npm run lint` | Existing repository failure remains in `hooks/useScrollToSelectedRow.ts:20`. New files add no lint errors. TanStack Virtual warnings remain in existing grid and filmstrip code. |

The local run does not prove Windows behavior, Linux behavior, Lightroom Classic round trips, or large-catalog latency budgets. The PR must use `Refs` for acceptance issues that depend on those runs.
