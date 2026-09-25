use std::{
    ffi::c_void,
    io::Read,
    slice,
    sync::atomic::{AtomicBool, Ordering},
};

use libraw_rs_vendor as raw;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    assets::{check_open_regular, open_regular, resolve_asset},
    libraw_profile::{ProcessedImage, RawHandle, c_text},
};

const MAX_INPUT: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT: usize = 512 * 1024 * 1024;
const DECODER_REVISION: &str = "libraw-native-0.22.1-compat-v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibRawDecodeOptions {
    mode: DecodeMode,
    max_edge: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum DecodeMode {
    Preview,
    Full,
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("RAW decode was cancelled.".into())
    } else {
        Ok(())
    }
}

fn optional_text(bytes: &[std::ffi::c_char]) -> String {
    let bytes = bytes
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

unsafe extern "C" fn progress(
    data: *mut c_void,
    _stage: raw::LibRaw_progress,
    _iteration: i32,
    _expected: i32,
) -> i32 {
    let cancelled = unsafe { &*data.cast::<AtomicBool>() };
    i32::from(cancelled.load(Ordering::Relaxed))
}

pub fn decode_libraw(
    location: &Value,
    options: &LibRawDecodeOptions,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    check_cancelled(cancelled)?;
    if options.max_edge == 0 || options.max_edge > 2560 {
        return Err("RAW preview size is invalid.".into());
    }
    let preview = matches!(options.mode, DecodeMode::Preview);
    let path = resolve_asset(location)?;
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("nef"))
    {
        return Err("Native RAW decoding requires a Nikon NEF file.".into());
    }
    let (mut file, opened) = open_regular(&path)?;
    if opened.len() == 0 || opened.len() > MAX_INPUT {
        return Err("RAW input is empty or exceeds the native decode limit.".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        check_cancelled(cancelled)?;
        let count = file.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        if bytes.len() as u64 + count as u64 > opened.len() {
            return Err("RAW input changed while reading.".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() as u64 != opened.len() {
        return Err("RAW input changed while reading.".into());
    }
    check_open_regular(&path, &file, &opened)?;
    let handle = RawHandle(unsafe { raw::libraw_init(0) });
    if handle.0.is_null() {
        return Err("Native RAW decoder could not start.".into());
    }
    unsafe {
        // The callback only borrows this flag while the local decoder is alive.
        raw::libraw_set_progress_handler(
            handle.0,
            Some(progress),
            std::ptr::from_ref(cancelled).cast_mut().cast(),
        );
        (*handle.0).rawparams.max_raw_memory_mb = 384;
        let params = &mut (*handle.0).params;
        params.half_size = i32::from(preview);
        params.output_bps = 16;
        params.output_color = 0;
        // WASM ignores our two-element gamma setting; keep its default curve for existing edits.
        params.no_auto_bright = 1;
        params.use_camera_matrix = 0;
        params.use_camera_wb = 1;
        params.user_qual = if preview { 0 } else { 2 };
    }
    let result = unsafe { raw::libraw_open_buffer(handle.0, bytes.as_ptr().cast(), bytes.len()) };
    check_cancelled(cancelled)?;
    if result != 0 {
        return Err(format!("LibRaw could not open NEF ({result})."));
    }
    let sizes = unsafe { &(*handle.0).sizes };
    let divisor = if preview { 2 } else { 1 };
    let expected_width = usize::from(sizes.width).div_ceil(divisor);
    let expected_height = usize::from(sizes.height).div_ceil(divisor);
    if expected_width == 0
        || expected_height == 0
        || expected_width
            .checked_mul(expected_height)
            .and_then(|pixels| pixels.checked_mul(6))
            .is_none_or(|bytes| bytes > MAX_OUTPUT)
    {
        return Err("RAW dimensions exceed the native decode limit.".into());
    }
    let metadata = unsafe {
        let data = &*handle.0;
        let (width, height) = if matches!(data.sizes.flip, 5..=7) {
            (data.sizes.height, data.sizes.width)
        } else {
            (data.sizes.width, data.sizes.height)
        };
        let make = c_text(&data.idata.make, "camera make")?;
        let model = c_text(&data.idata.model, "camera model")?;
        let matrix = data.color.rgb_cam.map(|row| row.map(f64::from));
        let gps = &data.other.parsed_gps;
        let thumb_format = [
            "unknown", "jpeg", "bitmap", "bitmap16", "layer", "rollei", "h265",
        ]
        .get(data.thumbnail.tformat as usize)
        .copied()
        .unwrap_or("unknown");
        json!({
            "width": width, "height": height,
            "raw_width": data.sizes.raw_width, "raw_height": data.sizes.raw_height,
            "top_margin": data.sizes.top_margin, "left_margin": data.sizes.left_margin,
            "flip": data.sizes.flip,
            "camera_make": make, "camera_model": model,
            "iso_speed": f64::from(data.other.iso_speed),
            "shutter": f64::from(data.other.shutter),
            "aperture": f64::from(data.other.aperture),
            "focal_len": f64::from(data.other.focal_len),
            "timestamp": data.other.timestamp,
            "shot_order": data.other.shot_order,
            "desc": optional_text(&data.other.desc),
            "artist": optional_text(&data.other.artist),
            "gps_data": {
                "latitude": gps.latitude.map(f64::from),
                "longitude": gps.longitude.map(f64::from),
                "altitude": f64::from(gps.altitude),
                "latref": (gps.latref != 0).then(|| char::from(gps.latref as u8).to_string()),
                "longref": (gps.longref != 0).then(|| char::from(gps.longref as u8).to_string()),
                "altref": gps.altref,
                "gpsstatus": (gps.gpsstatus != 0).then(|| char::from(gps.gpsstatus as u8).to_string()),
                "gpsparsed": gps.gpsparsed != 0,
            },
            "thumb_width": data.thumbnail.twidth,
            "thumb_height": data.thumbnail.theight,
            "thumb_format": thumb_format,
            "color_data": {
                "rgb_cam": matrix,
                "cam_mul": data.color.cam_mul.map(f64::from),
            },
            "lens": { "Lens": optional_text(&data.lens.Lens) },
            "shootinginfo": {
                "DriveMode": data.shootinginfo.DriveMode,
                "FocusMode": data.shootinginfo.FocusMode,
                "MeteringMode": data.shootinginfo.MeteringMode,
                "AFPoint": data.shootinginfo.AFPoint,
                "ExposureMode": data.shootinginfo.ExposureMode,
                "ExposureProgram": data.shootinginfo.ExposureProgram,
                "ImageStabilization": data.shootinginfo.ImageStabilization,
                "BodySerial": optional_text(&data.shootinginfo.BodySerial),
                "InternalBodySerial": optional_text(&data.shootinginfo.InternalBodySerial),
            },
            "nikon": { "NEFCompression": data.makernotes.nikon.NEFCompression },
            "colors": data.idata.colors,
        })
    };
    let result = unsafe { raw::libraw_unpack(handle.0) };
    check_cancelled(cancelled)?;
    if result != 0 {
        return Err(format!("LibRaw could not unpack NEF ({result})."));
    }
    let result = unsafe { raw::libraw_dcraw_process(handle.0) };
    check_cancelled(cancelled)?;
    if result != 0 {
        return Err(format!("LibRaw could not process NEF ({result})."));
    }
    let mut error = 0;
    let image = ProcessedImage(unsafe { raw::libraw_dcraw_make_mem_image(handle.0, &mut error) });
    check_cancelled(cancelled)?;
    if image.0.is_null() {
        return Err(format!("LibRaw could not produce RGB16 pixels ({error})."));
    }
    let image = unsafe { &*image.0 };
    let source_width = usize::from(image.width);
    let source_height = usize::from(image.height);
    let source_bytes = source_width
        .checked_mul(source_height)
        .and_then(|samples| samples.checked_mul(6))
        .filter(|bytes| *bytes <= MAX_OUTPUT)
        .ok_or("LibRaw output exceeds the supported size.")?;
    if image.type_ != 2
        || source_width == 0
        || source_height == 0
        || image.colors != 3
        || image.bits != 16
        || source_bytes > MAX_OUTPUT
        || image.data_size as usize != source_bytes
    {
        return Err("LibRaw did not produce bounded RGB16 camera pixels.".into());
    }
    let scale = if preview {
        (f64::from(options.max_edge) / source_width.max(source_height) as f64).min(1.0)
    } else {
        1.0
    };
    let width = (source_width as f64 * scale).round().max(1.0) as usize;
    let height = (source_height as f64 * scale).round().max(1.0) as usize;
    let byte_count = width * height * 6;
    let mut header = serde_json::to_vec(&json!({
        "version": 1, "width": width, "height": height, "bits": 16, "colors": 3,
        "byteCount": byte_count, "decoderRevision": DECODER_REVISION, "metadata": metadata,
    }))
    .map_err(|error| error.to_string())?;
    header.resize(header.len().next_multiple_of(4), b' ');
    let mut response = Vec::with_capacity(4 + header.len() + byte_count);
    response.extend_from_slice(&(header.len() as u32).to_le_bytes());
    response.extend_from_slice(&header);
    let pixels = unsafe { slice::from_raw_parts(image.data.as_ptr(), source_bytes) };
    if width == source_width && height == source_height && cfg!(target_endian = "little") {
        for row in pixels.chunks_exact(source_width * 6) {
            check_cancelled(cancelled)?;
            response.extend_from_slice(row);
        }
    } else {
        for y in 0..height {
            check_cancelled(cancelled)?;
            let source_y = (((y as f64 + 0.5) * source_height as f64 / height as f64).floor()
                as usize)
                .min(source_height - 1);
            for x in 0..width {
                let source_x = (((x as f64 + 0.5) * source_width as f64 / width as f64).floor()
                    as usize)
                    .min(source_width - 1);
                let offset = (source_y * source_width + source_x) * 6;
                #[cfg(target_endian = "little")]
                response.extend_from_slice(&pixels[offset..offset + 6]);
                #[cfg(target_endian = "big")]
                for sample in pixels[offset..offset + 6].chunks_exact(2) {
                    response.extend_from_slice(
                        &u16::from_ne_bytes([sample[0], sample[1]]).to_le_bytes(),
                    );
                }
            }
        }
    }
    check_cancelled(cancelled)?;
    Ok(response)
}
