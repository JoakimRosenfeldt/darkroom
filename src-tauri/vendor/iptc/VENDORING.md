Source: `iptc` 0.3.0 from crates.io (`https://crates.io/crates/iptc/0.3.0`), MIT licensed. The crate sources, original manifest, README, and license are preserved here.

Local patch: remove the two unconditional stdout notices in `IPTC::read_from_buffer` for TIFF and other detected formats. TIFF IPTC parsing and all return values remain unchanged. The notices polluted Darkroom's diagnostic backend JSON stream and did not indicate a parsing failure.
