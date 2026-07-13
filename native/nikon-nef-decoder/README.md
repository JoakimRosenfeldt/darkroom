# Nikon NEF decoder helper contract

This directory currently contains a mock helper only. It does not contain, load,
or redistribute Nikon SDK code or binaries. A production helper may implement
this contract after the SDK licence and redistribution terms have been approved.

## Version 1 command line

Electron starts the helper directly (never through a shell) with:

```text
nikon-nef-decoder \
  --input <absolute-existing-nef> \
  --output <absolute-existing-private-directory> \
  --mode preview|full \
  --max-edge <positive-integer> \
  --pixel-format rgb16le
```

- `--input` is read-only and must end in `.nef` (case-insensitive). The helper
  must never modify, replace, rename, or delete it.
- `--output` is selected and created by Electron. The helper may write only
  `result.json` and `pixels.bin` directly inside that directory.
- `preview` scales the decoded image so its longest edge is no larger than
  `min(--max-edge, 2560)`. `full` returns full resolution; `--max-edge` is
  accepted for a uniform invocation but does not scale full output.
- Version 1 supports only `rgb16le`: tightly packed, row-major, interleaved RGB
  channels as unsigned little-endian 16-bit values. There is no row padding.
- A successful process exits `0`. Failure exits non-zero, writes no usable
  result, and writes one compact JSON object to stderr containing `version`,
  `code`, and `message`. Stderr is diagnostic only and must not contain pixels.

The caller owns the timeout, concurrency limit, input path validation, output
directory, and cleanup. A helper must not access the network or spawn another
process.

## Successful output

`pixels.bin` contains exactly the pixels described above. After that file is
complete, the helper atomically publishes `result.json` with this shape:

```json
{
  "version": 1,
  "width": 8,
  "height": 6,
  "channels": 3,
  "bitDepth": 16,
  "byteCount": 288,
  "pixelFormat": "rgb16le",
  "orientation": 1,
  "colorSpace": "srgb",
  "transferFunction": "srgb"
}
```

Fields are required and no numeric field may be fractional. `orientation` is
the EXIF value `1` through `8`. A helper may physically normalize pixels and
report `1`; otherwise the renderer applies the reported orientation.
`colorSpace` describes RGB primaries and is one of `srgb`, `display-p3`, or
`unknown`. `transferFunction` is one of `linear`, `srgb`, or `unknown`.
Implementations must report what the SDK actually emits.
Darkroom's current version 1 service accepts only `srgb` color space with the
`srgb` transfer function; the other enum values are reserved for a future
color-managed renderer.

Before reading pixels, Electron must reject a result unless all of these hold:

- `version === 1`, `channels === 3`, `bitDepth === 16`, and
  `pixelFormat === "rgb16le"`;
- width and height are positive integers no greater than `65535`;
- preview's longest edge is no greater than `2560` and the requested maximum;
- `byteCount === width * height * channels * (bitDepth / 8)`;
- `byteCount` is no greater than 512 MiB and exactly matches `pixels.bin`;
- orientation, color space, and transfer function use the values above;
- both outputs are regular files contained directly in the private output
  directory (not symbolic links).

The 512 MiB protocol ceiling is a safety limit, not a promise that Electron can
hold a buffer of that size. Full-resolution callers may impose a smaller limit.

## Error codes

Version 1 reserves these stable codes:

- `INVALID_ARGUMENT`: missing, repeated, or invalid command-line input.
- `UNSUPPORTED_FILE`: input is not a `.nef` file or the SDK cannot decode it.
- `INPUT_IO`: input cannot be opened or read.
- `DECODE_FAILED`: the SDK reports corrupt/truncated data or decode failure.
- `OUTPUT_IO`: output cannot be safely written.
- `LIMIT_EXCEEDED`: dimensions or output bytes exceed the contract limits.
- `SDK_UNAVAILABLE`: SDK libraries are absent or unsupported on this platform.
- `INTERNAL`: any other helper failure.

Electron may expose these as diagnostics, but must retain the embedded-preview
fallback for every helper failure.

## Mock helper

`mock-decoder.mjs` validates the version 1 arguments and writes a deterministic,
small RGB16 gradient. It is for protocol and IPC tests only: it never decodes
the input and must not be shipped or described as Nikon SDK support.
