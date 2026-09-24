use rayon::prelude::*;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Clone)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub pixels: Vec<u8>,
}
pub enum Output {
    Depth(Vec<f32>),
    Images(Vec<Image>),
}
impl Image {
    pub fn parse(v: &Value) -> Result<Self, String> {
        let width = v["dimensions"]["width"]
            .as_u64()
            .filter(|n| (1..=2048).contains(n))
            .ok_or("Prototype width is invalid.")? as usize;
        let height = v["dimensions"]["height"]
            .as_u64()
            .filter(|n| (1..=2048).contains(n))
            .ok_or("Prototype height is invalid.")? as usize;
        let channels = v["channels"]
            .as_u64()
            .filter(|n| *n == 3 || *n == 4)
            .ok_or("Prototype channels are invalid.")? as usize;
        let pixels = crate::native::parse_binary(&v["pixels"])?;
        if pixels.len() != width * height * channels {
            return Err("Prototype pixels have the wrong length.".into());
        }
        Ok(Self {
            width,
            height,
            channels,
            pixels,
        })
    }
}
fn byte(n: f64) -> u8 {
    n.round().clamp(0., 255.) as u8
}
fn cancelled(c: &AtomicBool, y: usize) -> Result<(), String> {
    if y % 8 == 0 && c.load(Ordering::Relaxed) {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}
fn rows<T: Send>(
    output: &mut [T],
    stride: usize,
    parallel: bool,
    operation: impl Fn(usize, &mut [T]) -> Result<(), String> + Send + Sync,
) -> Result<(), String> {
    if parallel && let Some(pool) = crate::compute::pool() {
        return pool.install(|| {
            output
                .par_chunks_mut(stride)
                .with_min_len(4)
                .enumerate()
                .try_for_each(|(y, row)| operation(y, row))
        });
    }
    output
        .chunks_mut(stride)
        .enumerate()
        .try_for_each(|(y, row)| operation(y, row))
}
fn sample(x: isize, max: usize) -> usize {
    x.clamp(0, max as isize - 1) as usize
}
fn random(mut state: u32) -> u32 {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    state
}
fn cubic(value: f64) -> f64 {
    let a = value.abs();
    if a <= 1. {
        1.5 * a.powi(3) - 2.5 * a.powi(2) + 1.
    } else if a < 2. {
        -0.5 * a.powi(3) + 2.5 * a.powi(2) - 4. * a + 2.
    } else {
        0.
    }
}
pub fn process(
    request: &Value,
    image: &Image,
    selection: Option<&[u8]>,
    cancel: &AtomicBool,
) -> Result<Output, String> {
    let Image {
        width: w,
        height: h,
        channels: c,
        pixels: p,
    } = image;
    let (w, h, c) = (*w, *h, *c);
    let parallel = w * h >= 16 * 1024;
    let kind = request["kind"]
        .as_str()
        .ok_or("Prototype operation is invalid.")?;
    let maximum = match kind {
        "depth" => 4194304,
        "raw-details" => 2097152,
        _ => 1048576,
    };
    if w * h > maximum || (kind == "super-resolution" && (w > 1024 || h > 1024)) {
        return Err("device-limit".into());
    }
    match kind {
        "depth" => {
            let mut lum = vec![0f32; w * h];
            rows(&mut lum, w, parallel, |y, row| {
                cancelled(cancel, y)?;
                for x in 0..w {
                    let i = y * w + x;
                    row[x] = ((0.2126 * p[i * c] as f64
                        + 0.7152 * p[i * c + 1] as f64
                        + 0.0722 * p[i * c + 2] as f64)
                        / 255.) as f32;
                }
                Ok(())
            })?;
            let mut values = vec![0f32; w * h];
            rows(&mut values, w, parallel, |y, row| {
                cancelled(cancel, y)?;
                let vertical = if h == 1 {
                    0.5
                } else {
                    1. - y as f64 / (h - 1) as f64
                };
                for x in 0..w {
                    let i = y * w + x;
                    let left = lum[y * w + x.saturating_sub(1)] as f64;
                    let right = lum[y * w + (x + 1).min(w - 1)] as f64;
                    let above = lum[y.saturating_sub(1) * w + x] as f64;
                    let below = lum[(y + 1).min(h - 1) * w + x] as f64;
                    let edge = (right - left).hypot(below - above).min(1.);
                    row[x] = (0.5 * vertical + 0.35 * (1. - lum[i] as f64) + 0.15 * edge)
                        .clamp(0., 1.) as f32;
                }
                Ok(())
            })?;
            Ok(Output::Depth(values))
        }
        "denoise" => {
            let strength = request["strength"]
                .as_f64()
                .ok_or("Denoise strength is invalid.")?;
            let radius = (strength / 34.).ceil().max(1.) as isize;
            let spatial = 0.7 + strength / 50.;
            let range = 10. + strength * 0.8;
            // Byte differences and kernel offsets have a small, fixed domain.
            let range_weights: Vec<f64> = (-255..=255)
                .map(|difference: i32| {
                    (-(difference * difference) as f64 / (2. * range * range)).exp()
                })
                .collect();
            let diameter = (radius * 2 + 1) as usize;
            let mut spatial_weights = Vec::with_capacity(diameter * diameter);
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    spatial_weights
                        .push((-(dx * dx + dy * dy) as f64 / (2. * spatial * spatial)).exp());
                }
            }
            let mut output = image.clone();
            rows(&mut output.pixels, w * c, parallel, |y, row| {
                cancelled(cancel, y)?;
                for x in 0..w {
                    let center = (y * w + x) * c;
                    let mut weighted = [0.; 3];
                    let mut total = [0.; 3];
                    for dy in -radius..=radius {
                        let sy = sample(y as isize + dy, h);
                        for dx in -radius..=radius {
                            let sx = sample(x as isize + dx, w);
                            let offset = (sy * w + sx) * c;
                            let spatial_weight = spatial_weights
                                [(dy + radius) as usize * diameter + (dx + radius) as usize];
                            for channel in 0..3 {
                                let difference =
                                    p[offset + channel] as i32 - p[center + channel] as i32;
                                let weight =
                                    spatial_weight * range_weights[(difference + 255) as usize];
                                weighted[channel] += p[offset + channel] as f64 * weight;
                                total[channel] += weight;
                            }
                        }
                    }
                    for channel in 0..3 {
                        row[x * c + channel] = byte(
                            p[center + channel] as f64
                                + (weighted[channel] / total[channel].max(f64::EPSILON)
                                    - p[center + channel] as f64)
                                    * (strength / 100.),
                        );
                    }
                }
                Ok(())
            })?;
            Ok(Output::Images(vec![output]))
        }
        "raw-details" => {
            let amount = request["amount"]
                .as_f64()
                .ok_or("Raw Details amount is invalid.")?;
            let mut output = image.clone();
            rows(&mut output.pixels, w * c, parallel, |y, row| {
                cancelled(cancel, y)?;
                for x in 0..w {
                    let center = (y * w + x) * c;
                    let mut sum = [0.; 3];
                    for dy in -1..=1 {
                        for dx in -1..=1 {
                            let offset =
                                (sample(y as isize + dy, h) * w + sample(x as isize + dx, w)) * c;
                            for channel in 0..3 {
                                sum[channel] += p[offset + channel] as f64;
                            }
                        }
                    }
                    for channel in 0..3 {
                        row[x * c + channel] = byte(
                            p[center + channel] as f64
                                + (p[center + channel] as f64 - sum[channel] / 9.) * (amount / 80.),
                        );
                    }
                }
                Ok(())
            })?;
            Ok(Output::Images(vec![output]))
        }
        "super-resolution" => {
            let (ow, oh) = (w * 2, h * 2);
            let horizontal: Vec<[(usize, f64); 4]> = (0..ow)
                .map(|x| {
                    let sx = (x as f64 + 0.5) / 2. - 0.5;
                    let base = sx.floor() as isize;
                    std::array::from_fn(|i| {
                        let sample_x = base + i as isize - 1;
                        (sample(sample_x, w), cubic(sx - sample_x as f64))
                    })
                })
                .collect();
            let mut scaled = vec![0u8; ow * oh * c];
            rows(&mut scaled, ow * c, parallel, |y, row| {
                cancelled(cancel, y)?;
                let sy = (y as f64 + 0.5) / 2. - 0.5;
                let ybase = sy.floor() as isize;
                let vertical: [(usize, f64); 4] = std::array::from_fn(|i| {
                    let sample_y = ybase + i as isize - 1;
                    (sample(sample_y, h), cubic(sy - sample_y as f64))
                });
                for x in 0..ow {
                    for channel in 0..c {
                        let mut value = 0.;
                        let mut total = 0.;
                        for &(yy, yw) in &vertical {
                            for &(xx, xw) in &horizontal[x] {
                                let weight = yw * xw;
                                value += p[(yy * w + xx) * c + channel] as f64 * weight;
                                total += weight;
                            }
                        }
                        row[x * c + channel] = byte(value / total.max(f64::EPSILON));
                    }
                }
                Ok(())
            })?;
            let mut pixels = scaled.clone();
            rows(&mut pixels, ow * c, parallel, |y, row| {
                cancelled(cancel, y)?;
                for x in 0..ow {
                    let center = (y * ow + x) * c;
                    for channel in 0..3 {
                        let left = (y * ow + x.saturating_sub(1)) * c + channel;
                        let right = (y * ow + (x + 1).min(ow - 1)) * c + channel;
                        let above = (y.saturating_sub(1) * ow + x) * c + channel;
                        let below = ((y + 1).min(oh - 1) * ow + x) * c + channel;
                        let blur = (scaled[left] as f64
                            + scaled[right] as f64
                            + scaled[above] as f64
                            + scaled[below] as f64)
                            / 4.;
                        row[x * c + channel] = byte(
                            scaled[center + channel] as f64
                                + 0.18 * (scaled[center + channel] as f64 - blur),
                        );
                    }
                }
                Ok(())
            })?;
            Ok(Output::Images(vec![Image {
                width: ow,
                height: oh,
                channels: c,
                pixels,
            }]))
        }
        "generative-remove" => {
            let selected = selection
                .filter(|s| s.len() == w * h)
                .ok_or("Remove selection is invalid.")?;
            let count = selected.iter().filter(|v| **v > 0).count();
            if count == 0 {
                return Err("unsupported-input".into());
            }
            if count > 262144 {
                return Err("device-limit".into());
            }
            let seed = request["seed"].as_u64().ok_or("Remove seed is invalid.")? as u32;
            let radius = request["searchRadius"]
                .as_u64()
                .ok_or("Remove search radius is invalid.")? as usize;
            let mut outputs = vec![];
            for seed in [seed, random(seed ^ 0xa5a5a5a5)] {
                let mut state = if seed == 0 { 0x9e3779b9 } else { seed };
                // Preserve the original random stream before processing independent rows.
                let mut row_states = Vec::with_capacity(h);
                for (y, row) in selected.chunks(w).enumerate() {
                    cancelled(cancel, y)?;
                    row_states.push(state);
                    for (x, alpha) in row.iter().enumerate() {
                        if *alpha > 0 {
                            state = random(state.wrapping_add((y * w + x) as u32));
                        }
                    }
                }
                let mut output = image.clone();
                rows(&mut output.pixels, w * c, parallel, |y, row| {
                    cancelled(cancel, y)?;
                    let mut state = row_states[y];
                    for x in 0..w {
                        let i = y * w + x;
                        let alpha = selected[i] as f64 / 255.;
                        if alpha == 0. {
                            continue;
                        }
                        state = random(state.wrapping_add(i as u32));
                        let phase = state as f64 / 4294967296. * std::f64::consts::PI * 2.;
                        let mut sample_index = i;
                        for radius in 1..=radius {
                            let angle = phase + radius as f64 * 2.399963229728653;
                            let sx = ((x as f64 + angle.cos() * radius as f64) + 0.5)
                                .floor()
                                .clamp(0., w as f64 - 1.)
                                as usize;
                            let sy = ((y as f64 + angle.sin() * radius as f64) + 0.5)
                                .floor()
                                .clamp(0., h as f64 - 1.)
                                as usize;
                            let candidate = sy * w + sx;
                            if selected[candidate] == 0 {
                                sample_index = candidate;
                                break;
                            }
                        }
                        for channel in 0..3 {
                            row[x * c + channel] = byte(
                                p[i * c + channel] as f64 * (1. - alpha)
                                    + p[sample_index * c + channel] as f64 * alpha,
                            );
                        }
                    }
                    Ok(())
                })?;
                outputs.push(output);
            }
            Ok(Output::Images(outputs))
        }
        _ => Err("Prototype operation is unsupported.".into()),
    }
}
