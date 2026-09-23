`libraw/` is the unmodified LibRaw 0.22.1 source from the official tag
`https://github.com/LibRaw/LibRaw/releases/tag/0.22.1`. The downloaded GitHub
archive had SHA-256
`e676248284075605aa2697a66eeed7dc258820bd1d4988c724d29edffd726726`.
LibRaw's LGPL-2.1 and CDDL-1.0 licenses and copyright notices remain in that
directory.

This crate keeps the existing narrow C API binding and platform build flags in
`build.rs`. Its source list now includes the four decoder/decompressor files
added to LibRaw's standard library build since 0.21.1. No LibRaw source file is
patched.
