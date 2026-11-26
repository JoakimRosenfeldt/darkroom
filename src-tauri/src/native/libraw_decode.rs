use std::{
    ffi::c_void,
    io::Read,
    slice,
    sync::atomic::{AtomicBool, Ordering},
};

use libraw_rs_vendor as raw;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    NativeContext,
    assets::{check_open_regular, open_regular, resolve_asset},
    libraw_profile::{ProcessedImage, RawHandle, c_text},
    raw_preview_cache::PreviewCache,
};

const MAX_INPUT: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT: usize = 512 * 1024 * 1024;
pub(super) const DECODER_REVISION: &str = "libraw-native-0.22.1-linear-v2";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibRawDecodeOptions {
    mode: DecodeMode,
    max_edge: u32,
    #[serde(default)]
    handle_only: bool,
    #[serde(default)]
    priority: i32,
}

impl LibRawDecodeOptions {
    pub(crate) fn priority(&self) -> i32 {
        self.priority
    }
}

#[derive(Debug, Deserialize)]
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

/// Reads the oriented full-resolution size from the RAW header without unpacking pixels.
pub fn raw_dimensions(path: &std::path::Path) -> Option<(u16, u16)> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
    let handle = RawHandle(unsafe { raw::libraw_init(0) });
    if handle.0.is_null() || unsafe { raw::libraw_open_file(handle.0, path.as_ptr()) } != 0 {
        return None;
    }
    let sizes = unsafe { &(*handle.0).sizes };
    Some(if matches!(sizes.flip, 5..=7) {
        (sizes.height, sizes.width)
    } else {
        (sizes.width, sizes.height)
    })
}

pub fn decode_libraw(
    location: &Value,
    options: &LibRawDecodeOptions,
    cancelled: &AtomicBool,
    ctx: &NativeContext,
) -> Result<(Vec<u8>, Option<String>), String> {
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
    let cache = PreviewCache::if_enabled(
        preview,
        ctx.app_cache.as_deref(),
        &path,
        &opened,
        DECODER_REVISION,
        u64::from(options.max_edge),
    );
    if let Some(bytes) = cache.as_ref().and_then(|cache| cache.load(Some(cancelled))) {
        check_cancelled(cancelled)?;
        check_open_regular(&path, &file, &opened)?;
        return Ok((bytes, None));
    }
    check_cancelled(cancelled)?;
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
        (*handle.0).rawparams.max_raw_memory_mb = 512;
        let params = &mut (*handle.0).params;
        params.half_size = i32::from(preview);
        params.output_bps = 16;
        params.output_color = 0;
        params.gamm[0] = 1.0;
        params.gamm[1] = 1.0;
        params.no_auto_bright = 1;
        params.use_camera_matrix = 0;
        params.use_camera_wb = 1;
        params.user_qual = if preview { 0 } else { 2 };
    }
    let result = unsafe { raw::libraw_open_buffer(handle.0, bytes.as_ptr().cast(), bytes.len()) };
    check_cancelled(cancelled)?;
    if result != 0 {
        if result == raw::LibRaw_errors_LIBRAW_FILE_UNSUPPORTED
            || result == raw::LibRaw_errors_LIBRAW_NOT_IMPLEMENTED
        {
            return Err(format!("LIBRAW_UNSUPPORTED: LibRaw cannot open NEF ({result})."));
        }
        return Err(format!("LibRaw could not open NEF ({result})."));
    }
    unsafe {
        let mut info: raw::libraw_decoder_info_t = std::mem::zeroed();
        if raw::libraw_get_decoder_info(handle.0, &mut info) == 0 && !info.decoder_name.is_null() {
            let name = std::ffi::CStr::from_ptr(info.decoder_name);
            if name.to_str() == Ok("nikon_he_load_raw()") {
                return Err(
                    "LIBRAW_UNSUPPORTED: Nikon High Efficiency (HE/HE*) NEF requires Nikon decoder."
                        .into(),
                );
            }
        }
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
        if result == raw::LibRaw_errors_LIBRAW_FILE_UNSUPPORTED
            || result == raw::LibRaw_errors_LIBRAW_NOT_IMPLEMENTED
        {
            return Err(format!("LIBRAW_UNSUPPORTED: LibRaw cannot unpack NEF ({result})."));
        }
        return Err(format!("LibRaw could not unpack NEF ({result})."));
    }

    let (width, height, pixel_bytes) = if let Some(fast) =
        unsafe { super::bayer_demosaic::process_bayer_fast(handle.0, preview, options.max_edge, cancelled)? }
    {
        fast
    } else {
        let result = unsafe { raw::libraw_dcraw_process(handle.0) };
        check_cancelled(cancelled)?;
        if result != 0 {
            return Err(format!("LibRaw could not process NEF ({result})."));
        }

        if let Some((source_width, source_height, full_pixels)) =
            unsafe { extract_rgb16_direct(&*handle.0, cancelled)? }
        {
            if preview {
                let scale =
                    (f64::from(options.max_edge) / source_width.max(source_height) as f64).min(1.0);
                let width = (source_width as f64 * scale).round().max(1.0) as usize;
                let height = (source_height as f64 * scale).round().max(1.0) as usize;
                if width == source_width && height == source_height {
                    (width, height, full_pixels)
                } else {
                    let resized = resize_rgb16_parallel(
                        &full_pixels,
                        source_width,
                        source_height,
                        width,
                        height,
                        cancelled,
                    )?;
                    (width, height, resized)
                }
            } else {
                (source_width, source_height, full_pixels)
            }
        } else {
            let mut error = 0;
            let image =
                ProcessedImage(unsafe { raw::libraw_dcraw_make_mem_image(handle.0, &mut error) });
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
            let pixels = unsafe { slice::from_raw_parts(image.data.as_ptr(), source_bytes) };
            let output =
                if width == source_width && height == source_height && cfg!(target_endian = "little") {
                    let mut out = Vec::with_capacity(source_bytes);
                    for row in pixels.chunks_exact(source_width * 6) {
                        check_cancelled(cancelled)?;
                        out.extend_from_slice(row);
                    }
                    out
                } else {
                    resize_rgb16_parallel(
                        pixels,
                        source_width,
                        source_height,
                        width,
                        height,
                        cancelled,
                    )?
                };
            (width, height, output)
        }
    };
    check_cancelled(cancelled)?;

    let byte_count = width * height * 6;
    debug_assert_eq!(pixel_bytes.len(), byte_count);
    let source_handle = (!preview && byte_count <= crate::RAW_SOURCE_LIMIT)
        .then(|| uuid::Uuid::new_v4().to_string());
    let pixels_omitted = !preview && options.handle_only && source_handle.is_some();
    let mut header_value = json!({
        "version": 1, "width": width, "height": height, "bits": 16, "colors": 3,
        "byteCount": byte_count, "decoderRevision": DECODER_REVISION, "metadata": metadata,
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
                        width: width as u32,
                        height: height as u32,
                        format: crate::NativeSourceFormat::Rgb16,
                        data: pixel_bytes,
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
                width: width as u32,
                height: height as u32,
                format: crate::NativeSourceFormat::Rgb16,
                data: pixel_bytes.clone(),
            },
        );
        true
    });
    let mut response = Vec::with_capacity(4 + header.len() + byte_count);
    response.extend_from_slice(&(header.len() as u32).to_le_bytes());
    response.extend_from_slice(&header);
    response.extend_from_slice(&pixel_bytes);
    if let Some(cache) = cache {
        cache.store(&response, Some(cancelled));
    }
    check_cancelled(cancelled)?;
    Ok((response, source_handle))
}

/// Extracts RGB16 little-endian pixels directly from `libraw_data_t::image` in
/// parallel, matching `libraw_dcraw_make_mem_image` bit-for-bit when the linear
/// identity curve (`gamm = [1, 1]`, `no_auto_bright = 1`, `bright = 1.0`) and
/// square pixels are active.
unsafe fn extract_rgb16_direct(
    data: &raw::libraw_data_t,
    cancelled: &AtomicBool,
) -> Result<Option<(usize, usize, Vec<u8>)>, String> {
    if data.image.is_null()
        || data.idata.colors != 3
        || data.params.output_bps != 16
        || data.params.no_auto_bright != 1
        || (data.params.gamm[0] - 1.0).abs() > 1e-9
        || (data.params.gamm[1] - 1.0).abs() > 1e-9
        || (f64::from(data.params.bright) - 1.0).abs() > 1e-9
        || !(0.995..=1.005).contains(&data.sizes.pixel_aspect)
    {
        return Ok(None);
    }
    let iwidth = usize::from(data.sizes.width);
    let iheight = usize::from(data.sizes.height);
    if iwidth == 0 || iheight == 0 {
        return Ok(None);
    }
    let flip = data.sizes.flip;
    let (out_width, out_height) = if (flip & 4) != 0 {
        (iheight, iwidth)
    } else {
        (iwidth, iheight)
    };
    let byte_count = out_width
        .checked_mul(out_height)
        .and_then(|pixels| pixels.checked_mul(6))
        .filter(|bytes| *bytes <= MAX_OUTPUT)
        .ok_or("LibRaw output exceeds the supported size.")?;
    let source = unsafe { slice::from_raw_parts(data.image.cast::<[u16; 4]>(), iwidth * iheight) };
    let mut output: Vec<std::mem::MaybeUninit<u8>> = Vec::with_capacity(byte_count);
    // SAFETY: Every byte is initialized in `flip_row` below unless cancelled (in which case `output` is dropped as MaybeUninit without reading).
    unsafe { output.set_len(byte_count) };
    let row_bytes = out_width * 6;
    let rows_per_chunk = (32_768 / out_width.max(1)).max(1);
    let flip_row = |(chunk_idx, chunk): (usize, &mut [std::mem::MaybeUninit<u8>])| {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        let first_row = chunk_idx * rows_per_chunk;
        let rows = chunk.len() / row_bytes;
        for local_row in 0..rows {
            let y = first_row + local_row;
            let dst = &mut chunk[local_row * row_bytes..(local_row + 1) * row_bytes];
            if flip == 0 {
                let src_row = &source[y * iwidth..(y + 1) * iwidth];
                for (px, out) in src_row.iter().zip(dst.chunks_exact_mut(6)) {
                    let r = px[0].to_le_bytes();
                    let g = px[1].to_le_bytes();
                    let b = px[2].to_le_bytes();
                    out[0].write(r[0]);
                    out[1].write(r[1]);
                    out[2].write(g[0]);
                    out[3].write(g[1]);
                    out[4].write(b[0]);
                    out[5].write(b[1]);
                }
            } else {
                for x in 0..out_width {
                    let (mut r, mut c) = if (flip & 4) != 0 { (x, y) } else { (y, x) };
                    if (flip & 2) != 0 {
                        r = iheight - 1 - r;
                    }
                    if (flip & 1) != 0 {
                        c = iwidth - 1 - c;
                    }
                    let px = source[r * iwidth + c];
                    let out = &mut dst[x * 6..x * 6 + 6];
                    let rb = px[0].to_le_bytes();
                    let gb = px[1].to_le_bytes();
                    let bb = px[2].to_le_bytes();
                    out[0].write(rb[0]);
                    out[1].write(rb[1]);
                    out[2].write(gb[0]);
                    out[3].write(gb[1]);
                    out[4].write(bb[0]);
                    out[5].write(bb[1]);
                }
            }
        }
    };
    if byte_count >= 1 << 20
        && let Some(pool) = crate::compute::pool()
    {
        pool.install(|| {
            output
                .par_chunks_mut(row_bytes * rows_per_chunk)
                .enumerate()
                .for_each(flip_row);
        });
    } else {
        output
            .chunks_mut(row_bytes * rows_per_chunk)
            .enumerate()
            .for_each(flip_row);
    }
    check_cancelled(cancelled)?;
    let mut output = std::mem::ManuallyDrop::new(output);
    // SAFETY: Not cancelled, so every chunk ran to completion and initialized every byte.
    let output = unsafe {
        Vec::from_raw_parts(output.as_mut_ptr().cast::<u8>(), output.len(), output.capacity())
    };
    Ok(Some((out_width, out_height, output)))
}

fn resize_rgb16_parallel(
    pixels: &[u8],
    source_width: usize,
    source_height: usize,
    width: usize,
    height: usize,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    let row_bytes = width * 6;
    let mut output = vec![0_u8; height * row_bytes];
    let x_offsets: Vec<usize> = (0..width)
        .map(|x| {
            (((x as f64 + 0.5) * source_width as f64 / width as f64).floor() as usize)
                .min(source_width - 1)
                * 6
        })
        .collect();
    let resize_row = |(y, dst): (usize, &mut [u8])| {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        let source_y = (((y as f64 + 0.5) * source_height as f64 / height as f64).floor() as usize)
            .min(source_height - 1);
        let src_row = &pixels[source_y * source_width * 6..(source_y + 1) * source_width * 6];
        for (x, out) in x_offsets.iter().copied().zip(dst.chunks_exact_mut(6)) {
            #[cfg(target_endian = "little")]
            out.copy_from_slice(&src_row[x..x + 6]);
            #[cfg(target_endian = "big")]
            for (dst_s, src_s) in out.chunks_exact_mut(2).zip(src_row[x..x + 6].chunks_exact(2)) {
                dst_s.copy_from_slice(&u16::from_ne_bytes([src_s[0], src_s[1]]).to_le_bytes());
            }
        }
    };
    if output.len() >= 1 << 20
        && let Some(pool) = crate::compute::pool()
    {
        pool.install(|| {
            output
                .par_chunks_mut(row_bytes)
                .enumerate()
                .for_each(resize_row);
        });
    } else {
        output
            .chunks_mut(row_bytes)
            .enumerate()
            .for_each(resize_row);
    }
    check_cancelled(cancelled)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_bayer_dng(width: u32, height: u32, orientation: u16) -> Vec<u8> {
        let pixel_count = (width as usize) * (height as usize);
        let data_offset: u32 = 8 + 2 + 18 * 12 + 4 + 256;
        let mut buf = vec![0u8; data_offset as usize + pixel_count * 2];
        buf[0..2].copy_from_slice(b"II");
        buf[2..4].copy_from_slice(&42u16.to_le_bytes());
        buf[4..8].copy_from_slice(&8u32.to_le_bytes());
        let mut extra_off = 8 + 2 + 18 * 12 + 4;
        let mut write_extra = |b: &mut Vec<u8>, bytes: &[u8]| -> u32 {
            let off = extra_off;
            b[off as usize..off as usize + bytes.len()].copy_from_slice(bytes);
            extra_off += (bytes.len() as u32 + 3) & !3;
            off
        };
        let make_off = write_extra(&mut buf, b"NIKON CORPORATION\0");
        let model_off = write_extra(&mut buf, b"NIKON Z6_3\0");
        let mut cm = Vec::with_capacity(72);
        for num in [10000i32, -2000, -500, -3000, 11000, 1500, -500, 1500, 8000] {
            cm.extend_from_slice(&num.to_le_bytes());
            cm.extend_from_slice(&10000i32.to_le_bytes());
        }
        let cm_off = write_extra(&mut buf, &cm);
        let mut asn = Vec::with_capacity(24);
        for (n, d) in [(500u32, 1000u32), (1000, 1000), (650, 1000)] {
            asn.extend_from_slice(&n.to_le_bytes());
            asn.extend_from_slice(&d.to_le_bytes());
        }
        let asn_off = write_extra(&mut buf, &asn);
        let entries: [(u16, u16, u32, u32); 18] = [
            (254, 4, 1, 0),
            (256, 4, 1, width),
            (257, 4, 1, height),
            (258, 3, 1, 16),
            (259, 3, 1, 1),
            (262, 3, 1, 32803),
            (271, 2, 18, make_off),
            (272, 2, 11, model_off),
            (273, 4, 1, data_offset),
            (274, 3, 1, u32::from(orientation)),
            (277, 3, 1, 1),
            (278, 4, 1, height),
            (279, 4, 1, (pixel_count * 2) as u32),
            (33421, 3, 2, 0x0002_0002),
            (33422, 1, 4, 0x0201_0100),
            (50706, 1, 4, 0x0000_0401),
            (50721, 10, 9, cm_off),
            (50728, 5, 3, asn_off),
        ];
        buf[8..10].copy_from_slice(&(entries.len() as u16).to_le_bytes());
        for (i, (tag, typ, cnt, val)) in entries.iter().enumerate() {
            let off = 10 + i * 12;
            buf[off..off + 2].copy_from_slice(&tag.to_le_bytes());
            buf[off + 2..off + 4].copy_from_slice(&typ.to_le_bytes());
            buf[off + 4..off + 8].copy_from_slice(&cnt.to_le_bytes());
            buf[off + 8..off + 12].copy_from_slice(&val.to_le_bytes());
        }
        let pix = &mut buf[data_offset as usize..];
        for y in 0..height as usize {
            for x in 0..width as usize {
                let v = (((x * 37 + y * 53) & 0x3FFF) as u16).wrapping_add(512);
                let idx = (y * width as usize + x) * 2;
                pix[idx..idx + 2].copy_from_slice(&v.to_le_bytes());
            }
        }
        buf
    }

    #[test]
    fn direct_rgb16_extraction_matches_make_mem_image_for_all_orientations() {
        let cancelled = AtomicBool::new(false);
        for orientation in 1_u16..=8 {
            let dng = synthetic_bayer_dng(32, 24, orientation);
            let handle = RawHandle(unsafe { raw::libraw_init(0) });
            assert!(!handle.0.is_null());
            unsafe {
                let params = &mut (*handle.0).params;
                params.half_size = 0;
                params.output_bps = 16;
                params.output_color = 0;
                params.gamm[0] = 1.0;
                params.gamm[1] = 1.0;
                params.no_auto_bright = 1;
                params.use_camera_matrix = 0;
                params.use_camera_wb = 1;
                params.user_qual = 2;
                assert_eq!(raw::libraw_open_buffer(handle.0, dng.as_ptr().cast(), dng.len()), 0);
                assert_eq!(raw::libraw_unpack(handle.0), 0);
                assert_eq!(raw::libraw_dcraw_process(handle.0), 0);
                let (dw, dh, direct) = extract_rgb16_direct(&*handle.0, &cancelled)
                    .unwrap()
                    .expect("expected direct extraction");
                let mut err = 0;
                let mem = ProcessedImage(raw::libraw_dcraw_make_mem_image(handle.0, &mut err));
                assert!(!mem.0.is_null(), "make_mem_image failed {err}");
                let img = &*mem.0;
                assert_eq!(dw, usize::from(img.width));
                assert_eq!(dh, usize::from(img.height));
                let reference = slice::from_raw_parts(img.data.as_ptr(), img.data_size as usize);
                assert_eq!(direct, reference, "mismatch for EXIF orientation {orientation}");
            }
        }
    }
}
