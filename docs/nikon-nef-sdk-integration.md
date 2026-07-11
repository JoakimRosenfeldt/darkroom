# Nikon NEF/NRW SDK integration gate and plan

Status: **local macOS HE\* integration verified; release packaging remains blocked**.

This is a clean-room architecture note based on Darkroom's source, Nikon's
public SDK pages, and the non-confidential legal review checklist. It does not
contain or describe confidential Nikon API material.

The user separately accepted Nikon's download agreement and supplied SDK
version 1.46.0 in private storage. No Nikon library, executable, header, sample,
or other SDK artifact is present in this repository. The files under
`native/nikon-nef-decoder/` remain a public contract, a mock process, and its
test. The private helper and SDK stay outside source control.

Public Nikon references, checked 2026-07-10:

- [Nikon SDK information and FAQ](https://sdk.nikonimaging.com/information/en/)
- [Nikon SDK application/download workflow](https://sdk.nikonimaging.com/apply/selectcategory)

The public workflow places the licence agreement before download. Nikon's FAQ
says applicable limitations are in that agreement. Therefore the public pages
alone are not sufficient authority to download, integrate, redistribute, sign,
or ship the SDK.

## Current boundaries

Darkroom is an Electron main process plus a Next.js static renderer:

1. A selected library becomes the main process's canonical
   `activeLibraryRoot`. Existing sidecar IPC checks the trusted renderer,
   matches the active root, rejects traversal, and checks real parent paths for
   symlink escapes.
2. The renderer represents photos as `LibraryEntry` values with relative paths,
   but the existing general file-read IPC currently receives absolute paths.
   The native decoder API must be narrower: it accepts only an entry-relative
   path and resolves it under the already-approved active root in the main
   process.
3. `lib/raw/decode.ts` selects an image profile. NEF currently routes to
   `libraw-wasm`; supported images are developed by LibRaw and unsupported
   images can fall back to their embedded preview. Fast library browsing keeps
   using embedded thumbnails.
4. Develop previews are capped at 2560 px and the LRU retains at most three.
   Full-resolution export is decoded separately and is not put in that LRU.
5. Native RGB16 output crosses into `DevelopRenderer` as typed pixels and uses
   an RGB16UI texture when supported. Unsupported GPUs use the validated RGBA8
   fallback and expose the selected precision in diagnostics.
6. Crop behavior remains renderer-owned. The private Nikon helper physically
   normalizes SDK output and reports orientation 1; LibRaw and embedded sources
   retain their existing orientation path.
7. Electron currently packages `electron-dist`, the static `out` directory,
   and `package.json`. No native helper or SDK runtime is currently included.

LibRaw remains the default for Develop and export. The native path is invoked
only after a LibRaw processing failure for a `.nef` file. Every native failure,
unsupported platform, or missing SDK preserves the visible embedded-preview
fallback. Standard images and successful LibRaw decodes never launch the
helper. Decoder diagnostics use the stable provenance values `libraw`,
`nikon-sdk`, and `embedded`.

## Public platform information and unresolved facts

Nikon's public change log says the NEF/NRW Image SDK added Z6 III support in
2024. It also records macOS 15 support, the end of macOS 12 support, the end of
Windows 10 support, native Apple Silicon support except for the separately
named Mini SDK, and the earlier end of 32-bit Windows support.

The accepted 1.46.0 archive contains universal macOS arm64/x64 libraries and
Windows x64 libraries. It contains no Windows ARM64 runtime. Linux is not
supported and receives no Nikon helper. The macOS runtime is effectively
macOS 13+ because of its bundled Boost libraries; Windows requires the matching
VC++ runtime.

## Legal go/no-go gate

The release decision remains **NO-GO** until every item below has written,
retained evidence:

- [Done locally] An authorized human accepted the download agreement and
  supplied SDK 1.46.0. This does not establish redistribution permission.
- Counsel or the product owner confirms whether redistribution is permitted and
  identifies every condition, including downstream EULA obligations, required
  notices, and any Nikon third-party-beneficiary language.
- Counsel resolves the SDK/archive/documentation confidentiality terms against
  Darkroom's public repository. SDK artifacts and any confidential build inputs
  remain in private storage.
- [Done] Private archive inspection inventoried macOS universal and Windows x64
  runtimes. Windows ARM64 is unavailable.
- Vendor signatures, macOS code-signing/notarization rules, and Windows signing
  rules are validated. Written Nikon approval is obtained if modification or
  re-signing of a Nikon artifact is required.
- Intel macOS and Windows ARM64 are separately confirmed or explicitly excluded.

Passing this gate authorizes an isolated spike. It does not by itself authorize
committing proprietary files to the public repository or releasing a package.

## Stable helper boundary

Prefer a separate executable to a Node addon so SDK crashes remain outside the
Electron process. Protocol version 1 is defined in
`native/nikon-nef-decoder/README.md`:

- Electron starts the helper directly with `shell: false`.
- Electron copies a validated NEF from a pinned read-only file handle into a
  private work directory and supplies only that read-only snapshot to the
  helper. The original library path is never passed to the helper, and the
  renderer never supplies an absolute path.
- The helper writes only `result.json` and `pixels.bin` inside that directory.
- Version 1 output is tightly packed, row-major `rgb16le`; metadata includes
  dimensions, byte count, orientation, color space, and transfer function.
- Preview output is capped at 2560 px. Full-resolution output is never added to
  the preview LRU.
- Electron validates protocol version, all integer fields, allowed enums,
  dimensions, exact byte count, maximum output size, regular-file status, and
  containment before exposing pixels.
- Electron limits concurrency to one or two jobs, imposes a hard timeout,
  captures bounded stderr, handles process crashes, and deletes temporary files
  after success, rejection, timeout, or crash.
- The helper does not use the network, spawn children, modify the source photo,
  choose an output path, or receive arguments through a shell.

The clean-room service does not yet provide an OS sandbox that can enforce the
no-network or no-child-process rules against a compromised helper. A production
helper remains blocked until platform sandboxing and the licensed runtime's
compatibility with it are designed and verified.

Protocol version 1 records color space and transfer function for the authorized
spike, but the current editor/export pipeline is still sRGB-oriented. Linear
and Display-P3 helper output must not be enabled in production until edits run
in the correct working space and exported files are converted and tagged.

The production implementation may change the supported pixel formats only by
adding a new protocol version after real SDK output is measured. Confidential
SDK types, identifiers, and examples do not belong in this contract.

## Authorized native-spike matrix

Run this only after the legal gate permits archive access. Use licensed,
locally held test photos with explicit testing permission; do not upload them or
commit them.

| Platform candidate | Architecture | Gate before running |
| --- | --- | --- |
| Currently supported macOS | arm64 | Confirm archive slice and deployment minimum |
| Currently supported macOS | x64 | Confirm Intel support and archive slice |
| Windows 11 | x64 | Confirm runtime set and deployment version |
| Windows 11 | ARM64 | Run only if Nikon explicitly supplies/supports it |

The private macOS spike verified Z6 III HE\* preview and full decode. Preview
produced upright 1707×2560 RGB16 sRGB in about 2.2 seconds with about 474 MB
peak RSS; full decode produced 2656×3984 in about 3.9 seconds with about 631 MB
peak RSS. A 64 KiB truncated private copy failed without usable output. The
available fixtures are all HE\*; HE and lossless acceptance cases remain open.

For licensed local development, point Darkroom at the private executable
without copying it into the repository:

```text
DARKROOM_NEF_HELPER_PATH=/absolute/path/to/nikon-nef-decoder npm run electron:dev
```

This override is ignored by packaged builds and requires an absolute path.

On every authorized platform, test all of these inputs:

| Input | Preview (max edge 2560) | Full resolution | Expected failure path |
| --- | --- | --- | --- |
| Z6 III HE NEF | Required | Required | None |
| Z6 III HE* NEF | Required | Required | None |
| Lossless-compressed NEF | Required | Required | None; compare LibRaw routing |
| Corrupt NEF | Required | Required | Bounded `DECODE_FAILED` or `UNSUPPORTED_FILE` |
| Truncated NEF | Required | Required | Bounded `DECODE_FAILED` or `INPUT_IO` |
| Portrait-orientation NEF | Required | Required | None; orientation must be preserved |

Record width, height, stored/oriented dimensions, EXIF orientation, channel
count, bit depth, pixel format, color primaries, transfer function, preview and
full-resolution latency, peak resident memory, output bytes, helper exit/error,
and whether the SDK can produce 16-bit integer or half-float RGB. Hash every
source before and after the run to prove it was not modified. Measure both a
single job and the intended maximum concurrency. Keep raw measurements and SDK
artifacts private when required by the agreement.

## Private helper build expectations

After the spike succeeds, build one small helper per approved platform and
architecture in a private, access-controlled build environment:

- Pin the approved SDK version and verify SDK archive checksums before building.
- Compile only against the files the agreement permits; do not copy samples,
  headers, documentation, debug symbols, or unused runtimes into release output.
- Produce a manifest of helper/runtime filenames, architectures, checksums,
  upstream version, licence approval reference, and required notices.
- Keep proprietary inputs and outputs out of public source control and public CI
  artifacts. Inject them only into authorized release jobs.
- Treat a missing or mismatched artifact as a clear failure when building a
  Nikon-enabled macOS or Windows release. Normal development, Linux builds, and
  explicitly SDK-disabled builds continue without those artifacts.
- Resolve libraries relative to the packaged helper/resources directory; never
  search the current working directory or user-controlled paths.
- Preserve vendor signatures where required and sign the helper/app only in the
  order approved by Nikon and the platform vendor.

## Licence-gated electron-builder plan

Do not implement this section until both redistribution and signing are
approved.

1. Add platform-and-architecture-specific `extraResources` entries containing
   only the Darkroom helper, the exact required Nikon runtime files, the approved
   notices, and the private manifest. Keep these files outside the ASAR so the
   operating system loader can access them.
2. Use separate macOS arm64 and x64 resources unless the archive and licence
   permit a universal helper and compatible universal Nikon libraries. Do not
   merge, thin, patch, change install names, or alter rpaths in a Nikon binary
   without explicit permission.
3. Add Windows x64 resources. Add Windows ARM64 only after Nikon confirms it and
   supplies the needed architecture. Restrict DLL resolution to the helper's
   resource directory.
4. Locate packaged helpers from `process.resourcesPath`; keep an explicit
   development-only path for privately built local artifacts. Absence resolves
   to `SDK_UNAVAILABLE`, not an application crash.
5. Exclude all Nikon resources and the helper from Linux packages. Linux keeps
   LibRaw and the embedded fallback and reports a clear
   `nikon-sdk-unavailable` diagnostic when an unsupported NEF reaches Develop or
   export.
6. Add release-time checks that inspect architecture, required runtime presence,
   checksums, signing state, notices, and accidental proprietary files outside
   the approved resource allowlist.

## Signing, notarization, and release questions

These need written answers before a clean-machine package test:

- The macOS SDK currently fails during library initialization without access to
  `/Library/Application Support/Nikon/Profiles`; bundling the same profiles in
  the helper app does not replace that system location. Approve an installer or
  obtain a supported Nikon deployment mechanism before claiming drag-install.
- Counsel must resolve the bundled TBB notice and confirm the complete required
  third-party notices before redistribution.

- May Nikon libraries be bundled inside a signed and notarized third-party app?
- Must Nikon's original signature remain intact, and is Darkroom permitted or
  required to re-sign any library?
- Are changes to install names, rpaths, loader paths, or universal slices
  permitted? If not, what unmodified layout is required?
- Does the macOS hardened runtime load the libraries without disabling library
  validation or adding broad entitlements?
- Does Apple's notarization service accept the complete nested code layout, and
  what is the required signing order?
- Which Windows files carry Nikon signatures, which files require Darkroom's
  Authenticode signature, and does the NSIS installer preserve them?
- Which Microsoft runtimes may or must be redistributed?
- What licence text, notices, attribution, EULA clauses, and third-party-
  beneficiary language must ship, and where must users see them?
- Do the agreement or platform rules restrict crash dumps, diagnostics, or logs
  that might expose Nikon implementation details?

## Verification and acceptance checklist

Legal and provenance:

- [ ] Every legal gate item above has retained written evidence.
- [ ] The approved SDK version, hashes, private storage, and release access are
      recorded.
- [ ] Required notices/EULA content is reviewed in the installed application.
- [ ] No unapproved Nikon artifact exists in source control or public artifacts.

Decoder and renderer:

- [ ] Supported NEFs still use LibRaw for preview and full export.
- [ ] Real Z6 III HE and HE* files use the native helper when installed/licensed
      (HE* verified on macOS; HE fixture still required).
- [ ] High-bit-depth pixels reach WebGL where the SDK and GPU support them; the
      lower-precision fallback is safe and visible in diagnostics.
- [ ] Embedded fallback remains visible and functional for every helper error.
- [ ] Provenance reports `libraw`, `nikon-sdk`, or `embedded` accurately.
- [ ] Standard images never invoke the helper.
- [ ] Full-resolution decode uses the same routing and never enters the preview
      cache.
- [ ] Exposure, highlights, shadows, curves, mixer, rotation, distortion, and
      export are unchanged.
- [ ] Crop handles cannot leave the oriented source; portrait and landscape crop
      ratios remain correct.

Security and resilience:

- [ ] IPC accepts only a relative `.nef` path under the active approved library.
- [ ] Traversal, symlink escapes, non-NEF input, oversized input, and untrusted
      renderer calls are rejected before spawn.
- [ ] Spawn uses an argument array with `shell: false`; no user-controlled shell
      command is constructed.
- [ ] Malformed JSON, invalid enums/dimensions, integer overflow, byte-count
      mismatch, oversized output, symlink output, timeout, and helper crash are
      rejected.
- [ ] Temporary files and child processes are cleaned up on every exit path.
- [ ] Concurrency stays at one or two jobs and measured peak memory is acceptable.
- [ ] Before/after hashes prove source NEF files are unchanged.
- [ ] The helper and release process make no network request and add no telemetry.

Build and release:

- [ ] `npm test`, touched-file ESLint, `npm run build`, `npm audit`, and
      `git diff --check` pass or have documented pre-existing exceptions.
- [ ] Packaged macOS arm64 and every claimed macOS x64 build pass on clean
      machines with signing, hardened runtime, and notarization verified.
- [ ] Packaged Windows x64 and every claimed ARM64 build pass on clean machines
      with helper/runtime loading and signatures verified.
- [ ] Linux packages contain no Nikon artifacts, remain functional with LibRaw,
      and clearly report SDK unavailability for unsupported NEFs.
- [ ] Smoke tests cover supported NEF, HE, HE*, lossless, corrupt/truncated,
      portrait orientation, crop beyond all four borders, and full export.
- [ ] The combined diff receives an independent correctness/security review and
      a final simplification pass.

The integration is not complete until redistribution is confirmed, real HE and
HE* files decode through the production helper, native output is edited and
exported, security/cleanup tests pass, and packaged macOS and Windows builds are
verified on clean machines.
