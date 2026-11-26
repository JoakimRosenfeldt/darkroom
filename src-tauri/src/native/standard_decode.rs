use std::{
    io::{Cursor, Read},
    sync::atomic::{AtomicBool, Ordering},
};

use image::{ImageDecoder, ImageFormat, ImageReader, metadata::Orientation};
use serde::Deserialize;
use serde_json::{Value, json};

use super::assets::{check_open_regular, open_regular, resolve_asset};

const MAX_INPUT: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT: usize = 512 * 1024 * 1024;
pub(super) const STANDARD_DECODER_REVISION: &str = "native-image-rgba8-v1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StandardDecodeOptions {
    #[serde(default)]
    handle_only: bool,
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("Image decode was cancelled.".into())
    } else {
        Ok(())
    }
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

fn is_srgb_icc_profile(profile: &[u8]) -> bool {
    if profile.is_empty() {
        return true;
    }
    let has_wide_gamut = [
        b"display p3".as_slice(),
        b"dci-p3".as_slice(),
        b"adobe rgb".as_slice(),
        b"adobergb".as_slice(),
        b"prophoto".as_slice(),
        b"rec2020".as_slice(),
        b"rec. 2020".as_slice(),
        b"bt.2020".as_slice(),
    ]
    .iter()
    .any(|token| contains_ascii_case_insensitive(profile, token));
    if has_wide_gamut {
        return false;
    }
    [
        b"srgb".as_slice(),
        b"iec61966-2.1".as_slice(),
        b"iec 61966-2.1".as_slice(),
    ]
    .iter()
    .any(|token| contains_ascii_case_insensitive(profile, token))
}

fn mime_type(format: ImageFormat) -> Option<&'static str> {
    match format {
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Png => Some("image/png"),
        ImageFormat::WebP => Some("image/webp"),
        _ => None,
    }
}

pub fn decode_standard(
    location: &Value,
    options: &StandardDecodeOptions,
    cancelled: &AtomicBool,
) -> Result<(Vec<u8>, Option<String>), String> {
    check_cancelled(cancelled)?;
    let path = resolve_asset(location)?;
    let (mut file, opened) = open_regular(&path)?;
    if opened.len() == 0 || opened.len() > MAX_INPUT {
        return Err("Image input is empty or exceeds the native decode limit.".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    let mut chunk = [0_u8; 256 * 1024];
    loop {
        check_cancelled(cancelled)?;
        let count = file.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        if bytes.len() as u64 + count as u64 > opened.len() {
            return Err("Image input changed while reading.".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() as u64 != opened.len() {
        return Err("Image input changed while reading.".into());
    }
    check_open_regular(&path, &file, &opened)?;
    check_cancelled(cancelled)?;

    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let format = reader
        .format()
        .ok_or_else(|| "Image format is unrecognized.".to_owned())?;
    let mime = mime_type(format).ok_or_else(|| "Unsupported native image format.".to_owned())?;
    let mut decoder = reader.into_decoder().map_err(|error| error.to_string())?;

    if let Ok(Some(icc)) = decoder.icc_profile()
        && !is_srgb_icc_profile(&icc)
    {
        return Err("Non-sRGB ICC profile requires browser color management.".into());
    }

    let (raw_w, raw_h) = decoder.dimensions();
    if raw_w == 0
        || raw_h == 0
        || raw_w > 65_535
        || raw_h > 65_535
        || (raw_w as usize)
            .checked_mul(raw_h as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .is_none_or(|n| n > MAX_OUTPUT)
    {
        return Err("Image dimensions exceed the native decode limit.".into());
    }

    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    check_cancelled(cancelled)?;
    let mut dynamic = image::DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?;
    check_cancelled(cancelled)?;
    if orientation != Orientation::NoTransforms {
        dynamic.apply_orientation(orientation);
    }
    check_cancelled(cancelled)?;

    let width = dynamic.width();
    let height = dynamic.height();
    let has_alpha = dynamic.color().has_alpha();
    let (colors, source_format, data): (u32, crate::NativeSourceFormat, Vec<u8>) = if has_alpha {
        (4, crate::NativeSourceFormat::Rgba8, dynamic.into_rgba8().into_raw())
    } else {
        (3, crate::NativeSourceFormat::Rgb8, dynamic.into_rgb8().into_raw())
    };
    let byte_count = data.len();
    if byte_count != width as usize * height as usize * colors as usize || byte_count > MAX_OUTPUT {
        return Err("Decoded image pixel buffer size is invalid.".into());
    }
    check_cancelled(cancelled)?;

    let can_register = byte_count <= crate::RAW_SOURCE_LIMIT;
    let source_handle = can_register.then(|| uuid::Uuid::new_v4().to_string());
    let pixels_omitted = options.handle_only && source_handle.is_some();

    let mut header_value = json!({
        "version": 1,
        "width": width,
        "height": height,
        "bits": 8,
        "colors": colors,
        "byteCount": byte_count,
        "decoderRevision": STANDARD_DECODER_REVISION,
        "format": mime,
        "pixelsOmitted": pixels_omitted,
    });
    if let Some(handle) = &source_handle {
        header_value["sourceHandle"] = json!(handle);
    }
    let mut header = serde_json::to_vec(&header_value).map_err(|error| error.to_string())?;
    header.resize(header.len().next_multiple_of(4), b' ');

    check_open_regular(&path, &file, &opened)?;
    check_cancelled(cancelled)?;

    if pixels_omitted {
        let handle = source_handle.expect("handle present when pixels omitted");
        let inserted = crate::raw_sources()
            .lock()
            .map(|mut sources| {
                sources.insert(
                    handle.clone(),
                    crate::RawSource {
                        width,
                        height,
                        format: source_format,
                        data,
                    },
                );
                true
            })
            .unwrap_or(false);
        if !inserted {
            return Err("Native source cache is unavailable.".into());
        }
        let mut response = Vec::with_capacity(4 + header.len());
        response.extend_from_slice(&(header.len() as u32).to_le_bytes());
        response.extend_from_slice(&header);
        return Ok((response, Some(handle)));
    }

    let source_handle = source_handle.filter(|handle| {
        let Ok(mut sources) = crate::raw_sources().lock() else {
            return false;
        };
        sources.insert(
            handle.clone(),
            crate::RawSource {
                width,
                height,
                format: source_format,
                data: data.clone(),
            },
        );
        true
    });
    let mut response = Vec::with_capacity(4 + header.len() + byte_count);
    response.extend_from_slice(&(header.len() as u32).to_le_bytes());
    response.extend_from_slice(&header);
    response.extend_from_slice(&data);
    Ok((response, source_handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icc_srgb_classifier_rejects_wide_gamut_profiles() {
        assert!(is_srgb_icc_profile(b""));
        assert!(is_srgb_icc_profile(b"sRGB IEC61966-2.1"));
        assert!(!is_srgb_icc_profile(b"Display P3"));
        assert!(!is_srgb_icc_profile(b"Adobe RGB (1998)"));
        assert!(!is_srgb_icc_profile(b"ProPhoto RGB"));
        assert!(!is_srgb_icc_profile(b"Unknown Custom Profile"));
    }

    #[test]
    fn decodes_jpeg_handle_only_and_populates_raw_sources() {
        let _guard = crate::RAW_SOURCES_TEST_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("sample.jpg");
        let img = image::RgbImage::from_fn(16, 12, |x, y| {
            image::Rgb([(x * 16) as u8, (y * 20) as u8, 128])
        });
        img.save(&file_path).unwrap();

        let location = json!({
            "canonicalRootPath": std::fs::canonicalize(dir.path()).unwrap().to_str().unwrap(),
            "relativePath": "sample.jpg",
        });
        let cancelled = AtomicBool::new(false);
        let (response, handle) = decode_standard(
            &location,
            &StandardDecodeOptions { handle_only: true },
            &cancelled,
        )
        .unwrap();
        let handle = handle.expect("expected native source handle");
        let meta_len = u32::from_le_bytes(response[..4].try_into().unwrap()) as usize;
        assert_eq!(response.len(), 4 + meta_len);
        let header: Value = serde_json::from_slice(&response[4..4 + meta_len]).unwrap();
        assert_eq!(header["width"], 16);
        assert_eq!(header["height"], 12);
        assert_eq!(header["colors"], 3);
        assert_eq!(header["pixelsOmitted"], true);
        assert_eq!(header["sourceHandle"], handle);

        let stored = crate::raw_sources().lock().unwrap().get(&handle).unwrap();
        assert_eq!(stored.width, 16);
        assert_eq!(stored.height, 12);
        assert_eq!(stored.format, crate::NativeSourceFormat::Rgb8);
        assert_eq!(stored.data.len(), 16 * 12 * 3);
    }
}
