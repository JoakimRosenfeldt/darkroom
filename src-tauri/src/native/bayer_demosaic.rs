use std::{
    mem::MaybeUninit,
    slice,
    sync::atomic::{AtomicBool, Ordering},
};

use libraw_rs_vendor as raw;
use rayon::prelude::*;

const MAX_OUTPUT: usize = 512 * 1024 * 1024;
const LIBRAW_DECODER_FIXEDMAXC: u32 = 1 << 8;
const LIBRAW_DEFAULT_ADJUST_MAXIMUM_THRESHOLD: f32 = 0.75;

#[inline(always)]
fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("RAW decode was cancelled.".into())
    } else {
        Ok(())
    }
}

#[inline(always)]
fn fc(filters: u32, row: usize, col: usize) -> usize {
    ((filters >> ((((row << 1) & 14) | (col & 1)) << 1)) & 3) as usize
}

#[inline(always)]
fn clip_u16(val: i32) -> u16 {
    val.clamp(0, 65535) as u16
}

#[inline(always)]
fn ulim_u16(x: i32, y: u16, z: u16) -> u16 {
    let (lo, hi) = if y < z {
        (i32::from(y), i32::from(z))
    } else {
        (i32::from(z), i32::from(y))
    };
    x.clamp(lo, hi) as u16
}

#[inline(always)]
fn scale_sample(raw_val: u16, black: u16, mul: f32) -> u16 {
    let sub = raw_val.saturating_sub(black);
    if sub == 0 {
        return 0;
    }
    let scaled = f32::from(sub) * mul;
    if scaled >= 65535.0 {
        65535
    } else if scaled <= 0.0 {
        0
    } else {
        scaled as u16
    }
}

/// Replicates `LibRaw::adjust_bl()` on local copies of `black` and `cblack`.
/// Returns `None` if a non-2x2 repeat block remains so the caller can fall back to LibRaw.
fn adjust_black_levels(
    filters: u32,
    mut black: u32,
    mut cblack: [u32; 4104],
    params: &raw::libraw_output_params_t,
) -> Option<(u32, [u16; 4])> {
    let mut clear_repeat = false;
    if params.user_black >= 0 {
        black = params.user_black as u32;
        clear_repeat = true;
    }
    for i in 0..4 {
        if params.user_cblack[i] > -1_000_000 {
            cblack[i] = params.user_cblack[i] as u32;
            clear_repeat = true;
        }
    }
    if clear_repeat {
        cblack[4] = 0;
        cblack[5] = 0;
    }
    if filters > 1000 && (cblack[4] + 1) / 2 == 1 && (cblack[5] + 1) / 2 == 1 {
        let mut clrs = [0_usize; 4];
        let mut lastg: Option<usize> = None;
        let mut gcnt = 0_usize;
        for (c, slot) in clrs.iter_mut().enumerate() {
            *slot = fc(filters, c / 2, c % 2);
            if *slot == 1 {
                gcnt += 1;
                lastg = Some(c);
            }
        }
        if gcnt > 1
            && let Some(idx) = lastg
        {
            clrs[idx] = 3;
        }
        let rows = cblack[4] as usize;
        let cols = cblack[5] as usize;
        for (c, &clr) in clrs.iter().enumerate() {
            let repeat_idx = 6 + ((c / 2) % rows) * cols + ((c % 2) % cols);
            cblack[clr] = cblack[clr].wrapping_add(cblack[repeat_idx]);
        }
        cblack[4] = 0;
        cblack[5] = 0;
    }
    // Remove common part from cblack[0..4]
    let min_c = (0..4).map(|c| cblack[c] as i32).min().unwrap_or(0);
    for c in 0..4 {
        cblack[c] = (cblack[c] as i32 - min_c) as u32;
    }
    black = (black as i32 + min_c) as u32;

    if cblack[4] != 0 && cblack[5] != 0 {
        let count = (cblack[4] as usize).checked_mul(cblack[5] as usize)?;
        if 6 + count > cblack.len() {
            return None;
        }
        let mut min_r = cblack[6] as i32;
        for c in 1..count {
            min_r = min_r.min(cblack[6 + c] as i32);
        }
        let mut nonz = 0_usize;
        for c in 0..count {
            cblack[6 + c] = (cblack[6 + c] as i32 - min_r) as u32;
            if cblack[6 + c] != 0 {
                nonz += 1;
            }
        }
        black = (black as i32 + min_r) as u32;
        if nonz == 0 {
            cblack[4] = 0;
            cblack[5] = 0;
        } else {
            return None;
        }
    }

    let mut out = [0_u16; 4];
    for c in 0..4 {
        let total = cblack[c].wrapping_add(black);
        out[c] = total as u16;
    }
    Some((black, out))
}

/// Computes `scale_mul[4]` identically to `LibRaw::scale_colors()` when `use_camera_wb == 1`.
fn compute_scale_mul(
    filters: u32,
    color: &raw::libraw_colordata_t,
    black: u32,
    cblack: [u16; 4],
    maximum_after_adjust: u32,
    highlight: i32,
) -> Option<[f32; 4]> {
    if color.cam_mul[0] <= 0.00001 {
        return None;
    }
    let mut pre_mul = color.pre_mul;
    let mut sum = [0_u32; 8];
    for row in 0..8 {
        for col in 0..8 {
            let c = fc(filters, row, col);
            let val = i32::from(color.white[row][col]) - i32::from(cblack[c]);
            if val > 0 {
                sum[c] = sum[c].wrapping_add(val as u32);
            }
            sum[c + 4] += 1;
        }
    }
    if color.as_shot_wb_applied != 0 {
        pre_mul = [1.0; 4];
    } else if sum[0] != 0 && sum[1] != 0 && sum[2] != 0 && sum[3] != 0 {
        for c in 0..4 {
            pre_mul[c] = sum[c + 4] as f32 / sum[c] as f32;
        }
    } else if color.cam_mul[0] > 0.00001 && color.cam_mul[2] > 0.00001 {
        pre_mul = color.cam_mul;
    }
    if pre_mul[1] == 0.0 {
        pre_mul[1] = 1.0;
    }
    if pre_mul[3] == 0.0 {
        pre_mul[3] = pre_mul[1];
    }

    let maximum = maximum_after_adjust.wrapping_sub(black) as i32;
    let mut dmin = f64::MAX;
    let mut dmax = 0.0_f64;
    for &m in &pre_mul {
        let mf = f64::from(m);
        if dmin > mf {
            dmin = mf;
        }
        if dmax < mf {
            dmax = mf;
        }
    }
    if highlight == 0 {
        dmax = dmin;
    }
    let mut scale_mul = [1.0_f32; 4];
    if dmax > 0.00001 && maximum > 0 {
        let denom = dmax as f32;
        let max_f = maximum as f32;
        for c in 0..4 {
            pre_mul[c] /= denom;
            scale_mul[c] = pre_mul[c] * 65535.0_f32 / max_f;
        }
    }
    Some(scale_mul)
}

#[inline(always)]
fn normalized_flip(flip: i32) -> i32 {
    match (flip + 3600) % 360 {
        270 => 5,
        180 => 3,
        90 => 6,
        _ => flip,
    }
}

/// Validates that `filters` is a standard 2x2 3-color Bayer CFA (RGGB, BGGR, GRBG, or GBRG)
/// and returns the collapsed post-`pre_interpolate` filter mask (G2=3 mapped to G=1).
fn validate_standard_bayer(filters: u32) -> Option<u32> {
    if filters <= 1000 {
        return None;
    }
    let collapsed = filters & !((filters & 0x5555_5555_u32) << 1);
    let mut seen_raw = [false; 4];
    for r in 0..2 {
        for c in 0..2 {
            seen_raw[fc(filters, r, c)] = true;
        }
    }
    if !seen_raw.iter().all(|&s| s) {
        return None;
    }
    for r in 0..4 {
        for c in 0..8 {
            if fc(filters, r, c) != fc(filters, r & 1, c & 1) {
                return None;
            }
            let cur = fc(collapsed, r, c);
            if cur > 2 || cur == fc(collapsed, r + 1, c) || cur == fc(collapsed, r, c + 1) {
                return None;
            }
        }
    }
    Some(collapsed)
}

/// Pure-Rust Rayon-parallel replacement for `libraw_dcraw_process` + `extract_rgb16_direct`
/// on standard 3-color 2x2 Bayer RAW images. Runs across all CPU cores on macOS, Linux, and
/// Windows without requiring OpenMP, while matching LibRaw's PPG / half-size output bit-for-bit.
///
/// Returns `Ok(None)` if the RAW uses any non-standard layout so the caller seamlessly falls back
/// to `libraw_dcraw_process`.
pub(super) unsafe fn process_bayer_fast(
    handle: *mut raw::libraw_data_t,
    preview: bool,
    max_edge: u32,
    cancelled: &AtomicBool,
) -> Result<Option<(usize, usize, Vec<u8>)>, String> {
    let data = unsafe { &*handle };
    if data.rawdata.raw_image.is_null()
        || !data.rawdata.color3_image.is_null()
        || !data.rawdata.color4_image.is_null()
        || !data.rawdata.float_image.is_null()
        || !data.rawdata.float3_image.is_null()
        || !data.rawdata.float4_image.is_null()
    {
        return Ok(None);
    }
    let iparams = &data.rawdata.iparams;
    let sizes = &data.rawdata.sizes;
    let ioparams = &data.rawdata.ioparams;
    let params = &data.params;
    if iparams.colors != 3
        || iparams.is_foveon != 0
        || ioparams.fuji_width != 0
        || ioparams.zero_is_bad != 0
        || params.output_bps != 16
        || params.output_color != 0
        || params.no_auto_bright != 1
        || params.use_camera_wb != 1
        || params.use_camera_matrix != 0
        || params.four_color_rgb != 0
        || params.highlight != 0
        || params.med_passes != 0
        || params.exp_correc != 0
        || params.green_matching != 0
        || params.user_sat > 0
        || params.threshold != 0.0
        || !params.bad_pixels.is_null()
        || !params.dark_frame.is_null()
        || (params.gamm[0] - 1.0).abs() > 1e-9
        || (params.gamm[1] - 1.0).abs() > 1e-9
        || (f64::from(params.bright) - 1.0).abs() > 1e-9
        || !(0.995..=1.005).contains(&sizes.pixel_aspect)
    {
        return Ok(None);
    }
    if params.cropbox[2] != u32::MAX && params.cropbox[3] != u32::MAX {
        return Ok(None);
    }
    let Some(collapsed_filters) = validate_standard_bayer(iparams.filters) else {
        return Ok(None);
    };

    let mut decoder_info: raw::libraw_decoder_info_t = unsafe { std::mem::zeroed() };
    if unsafe { raw::libraw_get_decoder_info(handle, &mut decoder_info) } != 0 {
        return Ok(None);
    }
    if !decoder_info.decoder_name.is_null() {
        let name = unsafe { std::ffi::CStr::from_ptr(decoder_info.decoder_name) };
        if let Ok(text) = name.to_str()
            && (text.starts_with("phase_one") || text.starts_with("canon_600"))
        {
            return Ok(None);
        }
    }

    let width = usize::from(sizes.width);
    let height = usize::from(sizes.height);
    let raw_width = usize::from(sizes.raw_width);
    let raw_height = usize::from(sizes.raw_height);
    let top_margin = usize::from(sizes.top_margin);
    let left_margin = usize::from(sizes.left_margin);
    let raw_pitch = sizes.raw_pitch as usize;
    if width < 8
        || height < 8
        || raw_pitch % 2 != 0
        || top_margin + height > raw_height
        || left_margin + width > raw_width
    {
        return Ok(None);
    }
    let raw_stride = raw_pitch / 2;
    if raw_stride < left_margin + width {
        return Ok(None);
    }

    let color = &data.rawdata.color;
    let Some((black, cblack)) =
        adjust_black_levels(iparams.filters, color.black, color.cblack, params)
    else {
        return Ok(None);
    };

    let raw_slice =
        unsafe { slice::from_raw_parts(data.rawdata.raw_image, raw_height * raw_stride) };
    let fixed_maxc = (decoder_info.decoder_flags & LIBRAW_DECODER_FIXEDMAXC) != 0;

    let mut maximum = color.maximum;
    if !fixed_maxc && params.adjust_maximum_thr >= 0.00001 {
        let auto_threshold = if params.adjust_maximum_thr > 0.99999 {
            LIBRAW_DEFAULT_ADJUST_MAXIMUM_THRESHOLD
        } else {
            params.adjust_maximum_thr
        };
        let dmax = find_black_subtracted_max(
            raw_slice,
            raw_stride,
            top_margin,
            left_margin,
            width,
            height,
            iparams.filters,
            cblack,
            cancelled,
        )?;
        let real_max = u32::from(dmax);
        if real_max > 0
            && real_max < maximum
            && (real_max as f32) > (maximum as f32) * auto_threshold
        {
            maximum = real_max;
        }
    }

    let Some(scale_mul) =
        compute_scale_mul(iparams.filters, color, black, cblack, maximum, params.highlight)
    else {
        return Ok(None);
    };

    let flip = normalized_flip(if params.user_flip >= 0 {
        params.user_flip
    } else {
        sizes.flip
    });

    if preview {
        return process_preview_half_size(
            raw_slice,
            raw_stride,
            top_margin,
            left_margin,
            width,
            height,
            iparams.filters,
            cblack,
            scale_mul,
            flip,
            max_edge,
            cancelled,
        )
        .map(Some);
    }

    process_full_ppg(
        raw_slice,
        raw_stride,
        top_margin,
        left_margin,
        width,
        height,
        iparams.filters,
        collapsed_filters,
        cblack,
        scale_mul,
        flip,
        cancelled,
    )
    .map(Some)
}

#[allow(clippy::too_many_arguments)]
fn find_black_subtracted_max(
    raw_slice: &[u16],
    raw_stride: usize,
    top_margin: usize,
    left_margin: usize,
    width: usize,
    height: usize,
    filters: u32,
    cblack: [u16; 4],
    cancelled: &AtomicBool,
) -> Result<u16, String> {
    let row_blk = [
        [cblack[fc(filters, 0, 0)], cblack[fc(filters, 0, 1)]],
        [cblack[fc(filters, 1, 0)], cblack[fc(filters, 1, 1)]],
    ];
    let scan_row = |row: usize| -> u16 {
        if cancelled.load(Ordering::Relaxed) {
            return 0;
        }
        let src = &raw_slice[(row + top_margin) * raw_stride + left_margin
            ..(row + top_margin) * raw_stride + left_margin + width];
        let [b0, b1] = row_blk[row & 1];
        let mut max0 = 0_u16;
        let mut max1 = 0_u16;
        let mut pairs = src.chunks_exact(2);
        for pair in &mut pairs {
            max0 = max0.max(pair[0]);
            max1 = max1.max(pair[1]);
        }
        if let Some(&tail) = pairs.remainder().first() {
            max0 = max0.max(tail);
        }
        max0.saturating_sub(b0).max(max1.saturating_sub(b1))
    };
    let dmax = if width * height >= 262_144
        && let Some(pool) = crate::compute::pool()
    {
        pool.install(|| (0..height).into_par_iter().map(scan_row).reduce(|| 0, u16::max))
    } else {
        (0..height).map(scan_row).fold(0, u16::max)
    };
    check_cancelled(cancelled)?;
    Ok(dmax)
}

#[allow(clippy::too_many_arguments)]
fn process_preview_half_size(
    raw_slice: &[u16],
    raw_stride: usize,
    top_margin: usize,
    left_margin: usize,
    width: usize,
    height: usize,
    filters: u32,
    cblack: [u16; 4],
    scale_mul: [f32; 4],
    flip: i32,
    max_edge: u32,
    cancelled: &AtomicBool,
) -> Result<(usize, usize, Vec<u8>), String> {
    let iwidth = width.div_ceil(2);
    let iheight = height.div_ceil(2);
    let (src_w, src_h) = if (flip & 4) != 0 {
        (iheight, iwidth)
    } else {
        (iwidth, iheight)
    };
    let scale = (f64::from(max_edge) / src_w.max(src_h) as f64).min(1.0);
    let out_w = (src_w as f64 * scale).round().max(1.0) as usize;
    let out_h = (src_h as f64 * scale).round().max(1.0) as usize;
    let byte_count = out_w
        .checked_mul(out_h)
        .and_then(|pixels| pixels.checked_mul(6))
        .filter(|bytes| *bytes <= MAX_OUTPUT)
        .ok_or("LibRaw output exceeds the supported size.")?;

    let cell_c = [
        [fc(filters, 0, 0), fc(filters, 0, 1)],
        [fc(filters, 1, 0), fc(filters, 1, 1)],
    ];
    let x_map: Vec<usize> = (0..out_w)
        .map(|x| {
            (((x as f64 + 0.5) * src_w as f64 / out_w as f64).floor() as usize).min(src_w - 1)
        })
        .collect();

    let mut output: Vec<MaybeUninit<u8>> = Vec::with_capacity(byte_count);
    // SAFETY: Every byte is initialized by `render_row` unless cancelled (in which case dropped uninitialized).
    unsafe { output.set_len(byte_count) };
    let row_bytes = out_w * 6;
    let render_row = |(y, dst): (usize, &mut [MaybeUninit<u8>])| {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        let sy = (((y as f64 + 0.5) * src_h as f64 / out_h as f64).floor() as usize)
            .min(src_h - 1);
        for (&sx, out) in x_map.iter().zip(dst.chunks_exact_mut(6)) {
            let (mut hy, mut hx) = if (flip & 4) != 0 { (sx, sy) } else { (sy, sx) };
            if (flip & 2) != 0 {
                hy = iheight - 1 - hy;
            }
            if (flip & 1) != 0 {
                hx = iwidth - 1 - hx;
            }
            let r0 = hy * 2;
            let c0 = hx * 2;
            let mut ch = [0_u16; 4];
            let base0 = (r0 + top_margin) * raw_stride + left_margin + c0;
            let c00 = cell_c[0][0];
            ch[c00] = scale_sample(raw_slice[base0], cblack[c00], scale_mul[c00]);
            if c0 + 1 < width {
                let c01 = cell_c[0][1];
                ch[c01] = scale_sample(raw_slice[base0 + 1], cblack[c01], scale_mul[c01]);
            }
            if r0 + 1 < height {
                let base1 = base0 + raw_stride;
                let c10 = cell_c[1][0];
                ch[c10] = scale_sample(raw_slice[base1], cblack[c10], scale_mul[c10]);
                if c0 + 1 < width {
                    let c11 = cell_c[1][1];
                    ch[c11] = scale_sample(raw_slice[base1 + 1], cblack[c11], scale_mul[c11]);
                }
            }
            let r = ch[0].to_le_bytes();
            let g = (((u32::from(ch[1]) + u32::from(ch[3])) >> 1) as u16).to_le_bytes();
            let b = ch[2].to_le_bytes();
            out[0].write(r[0]);
            out[1].write(r[1]);
            out[2].write(g[0]);
            out[3].write(g[1]);
            out[4].write(b[0]);
            out[5].write(b[1]);
        }
    };

    if byte_count >= 1 << 20
        && let Some(pool) = crate::compute::pool()
    {
        pool.install(|| {
            output
                .par_chunks_mut(row_bytes)
                .enumerate()
                .for_each(render_row);
        });
    } else {
        output
            .chunks_mut(row_bytes)
            .enumerate()
            .for_each(render_row);
    }
    check_cancelled(cancelled)?;
    let mut output = std::mem::ManuallyDrop::new(output);
    // SAFETY: Not cancelled, so every byte was initialized.
    let output = unsafe {
        Vec::from_raw_parts(output.as_mut_ptr().cast::<u8>(), output.len(), output.capacity())
    };
    Ok((out_w, out_h, output))
}

#[inline(always)]
fn border_channel(
    bayer: &[u16],
    width: usize,
    height: usize,
    collapsed_filters: u32,
    row: usize,
    col: usize,
    target_color: usize,
) -> u16 {
    let mut sum = 0_u32;
    let mut count = 0_u32;
    let y_start = row.saturating_sub(1);
    let y_end = (row + 1).min(height - 1);
    let x_start = col.saturating_sub(1);
    let x_end = (col + 1).min(width - 1);
    for y in y_start..=y_end {
        let row_off = y * width;
        for x in x_start..=x_end {
            if fc(collapsed_filters, y, x) == target_color {
                sum += u32::from(bayer[row_off + x]);
                count += 1;
            }
        }
    }
    if count > 0 { (sum / count) as u16 } else { 0 }
}

#[inline(always)]
fn ppg_rgb_at(
    bayer: &[u16],
    green: &[u16],
    width: usize,
    height: usize,
    collapsed_filters: u32,
    row: usize,
    col: usize,
) -> [u16; 3] {
    let idx = row * width + col;
    let c_self = fc(collapsed_filters, row, col);
    if row == 0 || row == height - 1 || col == 0 || col == width - 1 {
        let mut rgb = [0_u16; 3];
        rgb[c_self] = bayer[idx];
        for (c, slot) in rgb.iter_mut().enumerate() {
            if c != c_self {
                *slot = if c == 1 {
                    green[idx]
                } else {
                    border_channel(bayer, width, height, collapsed_filters, row, col, c)
                };
            }
        }
        return rgb;
    }

    let g0 = i32::from(green[idx]);
    if c_self == 1 {
        // Green site: interpolate horizontal color `c_h` and vertical color `2 - c_h`.
        let c_h = fc(collapsed_filters, row, col + 1);
        let c_v = 2 - c_h;
        let h_val = clip_u16(
            (i32::from(bayer[idx - 1])
                + i32::from(bayer[idx + 1])
                + 2 * g0
                - i32::from(green[idx - 1])
                - i32::from(green[idx + 1]))
                >> 1,
        );
        let v_val = clip_u16(
            (i32::from(bayer[idx - width])
                + i32::from(bayer[idx + width])
                + 2 * g0
                - i32::from(green[idx - width])
                - i32::from(green[idx + width]))
                >> 1,
        );
        let mut rgb = [0_u16; 3];
        rgb[1] = green[idx];
        rgb[c_h] = h_val;
        rgb[c_v] = v_val;
        rgb
    } else {
        // Red or Blue site: interpolate opposite color along diagonals `width + 1` and `width - 1`.
        let c_opp = 2 - c_self;
        let d0 = width + 1;
        let d1 = width - 1;

        let b_nw = i32::from(bayer[idx - d0]);
        let b_se = i32::from(bayer[idx + d0]);
        let g_nw = i32::from(green[idx - d0]);
        let g_se = i32::from(green[idx + d0]);
        let diff0 = (b_nw - b_se).abs() + (g_nw - g0).abs() + (g_se - g0).abs();
        let guess0 = b_nw + b_se + 2 * g0 - g_nw - g_se;

        let b_ne = i32::from(bayer[idx - d1]);
        let b_sw = i32::from(bayer[idx + d1]);
        let g_ne = i32::from(green[idx - d1]);
        let g_sw = i32::from(green[idx + d1]);
        let diff1 = (b_ne - b_sw).abs() + (g_ne - g0).abs() + (g_sw - g0).abs();
        let guess1 = b_ne + b_sw + 2 * g0 - g_ne - g_sw;

        let opp = if diff0 != diff1 {
            clip_u16((if diff0 > diff1 { guess1 } else { guess0 }) >> 1)
        } else {
            clip_u16((guess0 + guess1) >> 2)
        };
        let mut rgb = [0_u16; 3];
        rgb[c_self] = bayer[idx];
        rgb[1] = green[idx];
        rgb[c_opp] = opp;
        rgb
    }
}

#[allow(clippy::too_many_arguments)]
fn process_full_ppg(
    raw_slice: &[u16],
    raw_stride: usize,
    top_margin: usize,
    left_margin: usize,
    width: usize,
    height: usize,
    filters: u32,
    collapsed_filters: u32,
    cblack: [u16; 4],
    scale_mul: [f32; 4],
    flip: i32,
    cancelled: &AtomicBool,
) -> Result<(usize, usize, Vec<u8>), String> {
    let (out_w, out_h) = if (flip & 4) != 0 {
        (height, width)
    } else {
        (width, height)
    };
    let byte_count = out_w
        .checked_mul(out_h)
        .and_then(|pixels| pixels.checked_mul(6))
        .filter(|bytes| *bytes <= MAX_OUTPUT)
        .ok_or("LibRaw output exceeds the supported size.")?;

    let pixel_count = width * height;
    let use_pool = pixel_count >= 262_144;

    // Pass 1: Black-subtract + WB-scale into compact 1-channel Bayer plane (2 bytes/px).
    let row_params = [
        [
            (cblack[fc(filters, 0, 0)], scale_mul[fc(filters, 0, 0)]),
            (cblack[fc(filters, 0, 1)], scale_mul[fc(filters, 0, 1)]),
        ],
        [
            (cblack[fc(filters, 1, 0)], scale_mul[fc(filters, 1, 0)]),
            (cblack[fc(filters, 1, 1)], scale_mul[fc(filters, 1, 1)]),
        ],
    ];
    let mut bayer_uninit: Vec<MaybeUninit<u16>> = Vec::with_capacity(pixel_count);
    // SAFETY: Every element is written in `fill_bayer_row` unless cancelled.
    unsafe { bayer_uninit.set_len(pixel_count) };
    let fill_bayer_row = |(row, dst): (usize, &mut [MaybeUninit<u16>])| {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        let src = &raw_slice[(row + top_margin) * raw_stride + left_margin
            ..(row + top_margin) * raw_stride + left_margin + width];
        let [(b0, m0), (b1, m1)] = row_params[row & 1];
        let mut s_pairs = src.chunks_exact(2);
        let mut d_pairs = dst.chunks_exact_mut(2);
        for (sp, dp) in (&mut s_pairs).zip(&mut d_pairs) {
            dp[0].write(scale_sample(sp[0], b0, m0));
            dp[1].write(scale_sample(sp[1], b1, m1));
        }
        if let (Some(&st), Some(dt)) = (s_pairs.remainder().first(), d_pairs.into_remainder().first_mut()) {
            dt.write(scale_sample(st, b0, m0));
        }
    };
    if use_pool && let Some(pool) = crate::compute::pool() {
        pool.install(|| {
            bayer_uninit
                .par_chunks_mut(width)
                .enumerate()
                .for_each(fill_bayer_row);
        });
    } else {
        bayer_uninit
            .chunks_mut(width)
            .enumerate()
            .for_each(fill_bayer_row);
    }
    check_cancelled(cancelled)?;
    let mut bayer_uninit = std::mem::ManuallyDrop::new(bayer_uninit);
    // SAFETY: Not cancelled, so every row initialized every u16.
    let bayer = unsafe {
        Vec::from_raw_parts(
            bayer_uninit.as_mut_ptr().cast::<u16>(),
            bayer_uninit.len(),
            bayer_uninit.capacity(),
        )
    };

    // Pass 2: Full-resolution PPG Green plane (2 bytes/px), reading only `bayer`.
    let mut green_uninit: Vec<MaybeUninit<u16>> = Vec::with_capacity(pixel_count);
    // SAFETY: Every element is written in `fill_green_row` unless cancelled.
    unsafe { green_uninit.set_len(pixel_count) };
    let w2 = width * 2;
    let w3 = width * 3;
    let fill_green_row = |(row, dst): (usize, &mut [MaybeUninit<u16>])| {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        let row_off = row * width;
        let is_border_row = row < 3 || row >= height - 3;
        if is_border_row {
            for (col, slot) in dst.iter_mut().enumerate() {
                let g = if fc(collapsed_filters, row, col) == 1 {
                    bayer[row_off + col]
                } else {
                    border_channel(&bayer, width, height, collapsed_filters, row, col, 1)
                };
                slot.write(g);
            }
            return;
        }
        // Left 3 border columns
        for col in 0..3 {
            let g = if fc(collapsed_filters, row, col) == 1 {
                bayer[row_off + col]
            } else {
                border_channel(&bayer, width, height, collapsed_filters, row, col, 1)
            };
            dst[col].write(g);
        }
        // Interior columns: copy green sites, PPG-interpolate R/B sites.
        let green_at_3 = fc(collapsed_filters, row, 3) == 1;
        for col in 3..width - 3 {
            let is_green = ((col - 3) & 1 == 0) == green_at_3;
            let idx = row_off + col;
            if is_green {
                dst[col].write(bayer[idx]);
            } else {
                let c0 = i32::from(bayer[idx]);
                // Horizontal (d = 1)
                let gl = i32::from(bayer[idx - 1]);
                let gr = i32::from(bayer[idx + 1]);
                let cl2 = i32::from(bayer[idx - 2]);
                let cr2 = i32::from(bayer[idx + 2]);
                let gl3 = i32::from(bayer[idx - 3]);
                let gr3 = i32::from(bayer[idx + 3]);
                let guess0 = (gl + c0 + gr) * 2 - cl2 - cr2;
                let diff0 = ((cl2 - c0).abs() + (cr2 - c0).abs() + (gl - gr).abs()) * 3
                    + ((gr3 - gr).abs() + (gl3 - gl).abs()) * 2;
                // Vertical (d = width)
                let gu = i32::from(bayer[idx - width]);
                let gd = i32::from(bayer[idx + width]);
                let cu2 = i32::from(bayer[idx - w2]);
                let cd2 = i32::from(bayer[idx + w2]);
                let gu3 = i32::from(bayer[idx - w3]);
                let gd3 = i32::from(bayer[idx + w3]);
                let guess1 = (gu + c0 + gd) * 2 - cu2 - cd2;
                let diff1 = ((cu2 - c0).abs() + (cd2 - c0).abs() + (gu - gd).abs()) * 3
                    + ((gd3 - gd).abs() + (gu3 - gu).abs()) * 2;
                let g = if diff0 > diff1 {
                    ulim_u16(guess1 >> 2, bayer[idx + width], bayer[idx - width])
                } else {
                    ulim_u16(guess0 >> 2, bayer[idx + 1], bayer[idx - 1])
                };
                dst[col].write(g);
            }
        }
        // Right 3 border columns
        for col in (width - 3)..width {
            let g = if fc(collapsed_filters, row, col) == 1 {
                bayer[row_off + col]
            } else {
                border_channel(&bayer, width, height, collapsed_filters, row, col, 1)
            };
            dst[col].write(g);
        }
    };
    if use_pool && let Some(pool) = crate::compute::pool() {
        pool.install(|| {
            green_uninit
                .par_chunks_mut(width)
                .enumerate()
                .for_each(fill_green_row);
        });
    } else {
        green_uninit
            .chunks_mut(width)
            .enumerate()
            .for_each(fill_green_row);
    }
    check_cancelled(cancelled)?;
    let mut green_uninit = std::mem::ManuallyDrop::new(green_uninit);
    // SAFETY: Not cancelled, so every row initialized every u16.
    let green = unsafe {
        Vec::from_raw_parts(
            green_uninit.as_mut_ptr().cast::<u16>(),
            green_uninit.len(),
            green_uninit.capacity(),
        )
    };

    // Pass 3: Fused PPG R/B interpolation + EXIF orientation flip directly into packed RGB16LE.
    let mut output_uninit: Vec<MaybeUninit<u8>> = Vec::with_capacity(byte_count);
    // SAFETY: Every byte is written in `emit_rows` unless cancelled.
    unsafe { output_uninit.set_len(byte_count) };
    let row_bytes = out_w * 6;
    let rows_per_chunk = (32_768 / out_w.max(1)).max(1);
    let emit_rows = |(chunk_idx, chunk): (usize, &mut [MaybeUninit<u8>])| {
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        let first_y = chunk_idx * rows_per_chunk;
        let rows = chunk.len() / row_bytes;
        for local_y in 0..rows {
            let y = first_y + local_y;
            let dst = &mut chunk[local_y * row_bytes..(local_y + 1) * row_bytes];
            if flip == 0 {
                for (x, out) in dst.chunks_exact_mut(6).enumerate() {
                    let px = ppg_rgb_at(&bayer, &green, width, height, collapsed_filters, y, x);
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
                for (x, out) in dst.chunks_exact_mut(6).enumerate() {
                    let (mut r, mut c) = if (flip & 4) != 0 { (x, y) } else { (y, x) };
                    if (flip & 2) != 0 {
                        r = height - 1 - r;
                    }
                    if (flip & 1) != 0 {
                        c = width - 1 - c;
                    }
                    let px = ppg_rgb_at(&bayer, &green, width, height, collapsed_filters, r, c);
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
            output_uninit
                .par_chunks_mut(row_bytes * rows_per_chunk)
                .enumerate()
                .for_each(emit_rows);
        });
    } else {
        output_uninit
            .chunks_mut(row_bytes * rows_per_chunk)
            .enumerate()
            .for_each(emit_rows);
    }
    check_cancelled(cancelled)?;
    let mut output_uninit = std::mem::ManuallyDrop::new(output_uninit);
    // SAFETY: Not cancelled, so every chunk initialized every byte.
    let output = unsafe {
        Vec::from_raw_parts(
            output_uninit.as_mut_ptr().cast::<u8>(),
            output_uninit.len(),
            output_uninit.capacity(),
        )
    };
    Ok((out_w, out_h, output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::libraw_profile::{ProcessedImage, RawHandle};

    fn synthetic_bayer_dng(
        width: u32,
        height: u32,
        orientation: u16,
        cfa_pattern: u32,
        black_level: u32,
    ) -> Vec<u8> {
        let pixel_count = (width as usize) * (height as usize);
        let data_offset: u32 = 8 + 2 + 19 * 12 + 4 + 256;
        let mut buf = vec![0u8; data_offset as usize + pixel_count * 2];
        buf[0..2].copy_from_slice(b"II");
        buf[2..4].copy_from_slice(&42u16.to_le_bytes());
        buf[4..8].copy_from_slice(&8u32.to_le_bytes());
        let mut extra_off = 8 + 2 + 19 * 12 + 4;
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
        let entries: [(u16, u16, u32, u32); 19] = [
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
            (33422, 1, 4, cfa_pattern),
            (50706, 1, 4, 0x0000_0401),
            (50714, 4, 1, black_level),
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
                let v = (((x * 37 + y * 53 + (x ^ y) * 19) & 0x3FFF) as u16).wrapping_add(256);
                let idx = (y * width as usize + x) * 2;
                pix[idx..idx + 2].copy_from_slice(&v.to_le_bytes());
            }
        }
        buf
    }

    #[test]
    fn fast_ppg_matches_libraw_bit_for_bit_across_all_cfa_patterns_and_orientations() {
        let cancelled = AtomicBool::new(false);
        // RGGB, BGGR, GRBG, GBRG
        let patterns: [(&str, u32); 4] = [
            ("RGGB", 0x0201_0100),
            ("BGGR", 0x0001_0102),
            ("GRBG", 0x0102_0001),
            ("GBRG", 0x0100_0201),
        ];
        for (name, cfa) in patterns {
            for orientation in 1_u16..=8 {
                let dng = synthetic_bayer_dng(36, 26, orientation, cfa, 512);
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
                    assert_eq!(
                        raw::libraw_open_buffer(handle.0, dng.as_ptr().cast(), dng.len()),
                        0
                    );
                    assert_eq!(raw::libraw_unpack(handle.0), 0);
                    let (fw, fh, fast) = process_bayer_fast(handle.0, false, 2560, &cancelled)
                        .unwrap()
                        .expect("expected fast Bayer PPG path");
                    assert_eq!(raw::libraw_dcraw_process(handle.0), 0);
                    let mut err = 0;
                    let mem = ProcessedImage(raw::libraw_dcraw_make_mem_image(handle.0, &mut err));
                    assert!(!mem.0.is_null(), "make_mem_image failed {err}");
                    let img = &*mem.0;
                    assert_eq!(fw, usize::from(img.width), "{name} orient {orientation}");
                    assert_eq!(fh, usize::from(img.height), "{name} orient {orientation}");
                    let reference = slice::from_raw_parts(img.data.as_ptr(), img.data_size as usize);
                    assert_eq!(
                        fast, reference,
                        "full PPG mismatch for {name} orientation {orientation}"
                    );
                }
            }
        }
    }

    #[test]
    fn fast_preview_half_size_matches_libraw_bit_for_bit() {
        let cancelled = AtomicBool::new(false);
        for orientation in 1_u16..=8 {
            // Include odd dimensions to exercise half_size ceil behavior too.
            let dng = synthetic_bayer_dng(35, 25, orientation, 0x0201_0100, 400);
            let handle = RawHandle(unsafe { raw::libraw_init(0) });
            assert!(!handle.0.is_null());
            unsafe {
                let params = &mut (*handle.0).params;
                params.half_size = 1;
                params.output_bps = 16;
                params.output_color = 0;
                params.gamm[0] = 1.0;
                params.gamm[1] = 1.0;
                params.no_auto_bright = 1;
                params.use_camera_matrix = 0;
                params.use_camera_wb = 1;
                params.user_qual = 0;
                assert_eq!(
                    raw::libraw_open_buffer(handle.0, dng.as_ptr().cast(), dng.len()),
                    0
                );
                assert_eq!(raw::libraw_unpack(handle.0), 0);
                let (fw, fh, fast) = process_bayer_fast(handle.0, true, 2560, &cancelled)
                    .unwrap()
                    .expect("expected fast Bayer preview path");
                assert_eq!(raw::libraw_dcraw_process(handle.0), 0);
                let mut err = 0;
                let mem = ProcessedImage(raw::libraw_dcraw_make_mem_image(handle.0, &mut err));
                assert!(!mem.0.is_null(), "make_mem_image failed {err}");
                let img = &*mem.0;
                assert_eq!(fw, usize::from(img.width), "preview orient {orientation}");
                assert_eq!(fh, usize::from(img.height), "preview orient {orientation}");
                let reference = slice::from_raw_parts(img.data.as_ptr(), img.data_size as usize);
                assert_eq!(
                    fast, reference,
                    "preview half-size mismatch for orientation {orientation}"
                );
            }
        }
    }
}
