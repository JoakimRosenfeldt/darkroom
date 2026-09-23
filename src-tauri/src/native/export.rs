use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use image::{
    ExtendedColorType, ImageBuffer, ImageEncoder, Rgba,
    codecs::{avif::AvifEncoder, jpeg::JpegEncoder, png::PngEncoder, webp::WebPEncoder},
    imageops::FilterType,
};
use little_exif::{exif_tag::ExifTag, filetype::FileExtension, metadata::Metadata};
use serde_json::{Value, json};

use super::{NativeContext, parse_binary};

const SRGB_ICC: &[u8] = include_bytes!("srgb.icc");

struct Destination {
    directory: PathBuf,
    selected_path: Option<PathBuf>,
    format: String,
    sources: HashMap<PathBuf, Source>,
    produced: Vec<PathBuf>,
    expires: Instant,
}
struct Source {
    selected: bool,
    identity: Option<FileIdentity>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn file_identity(_path: &Path, metadata: &fs::Metadata) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}
#[cfg(windows)]
fn file_identity(path: &Path, _metadata: &fs::Metadata) -> Option<FileIdentity> {
    let (device, inode) = super::windows_path_identity(path)?;
    Some(FileIdentity { device, inode })
}
#[cfg(not(any(unix, windows)))]
fn file_identity(_path: &Path, _metadata: &fs::Metadata) -> Option<FileIdentity> {
    None
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn provenance_path(ctx: &NativeContext) -> PathBuf {
    ctx.app_data.join("export-provenance.json")
}
fn known_outputs(ctx: &NativeContext) -> HashMap<PathBuf, FileIdentity> {
    let mut known = HashMap::new();
    let Ok(bytes) = fs::read(provenance_path(ctx)) else {
        return known;
    };
    if bytes.len() > 1024 * 1024 {
        return known;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return known;
    };
    let Some(records) = value
        .get("outputs")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
    else {
        return known;
    };
    for record in records.iter().rev().take(4096).rev() {
        let Some(path) = record.get("path").and_then(Value::as_str) else {
            continue;
        };
        let (Some(device), Some(inode)) = (
            record.get("device").and_then(Value::as_u64),
            record.get("inode").and_then(Value::as_u64),
        ) else {
            continue;
        };
        let path = PathBuf::from(path);
        if path.is_absolute() {
            known.insert(path, FileIdentity { device, inode });
        }
    }
    known
}
fn remember_output(ctx: &NativeContext, path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    let Some(identity) = file_identity(path, &metadata) else {
        return;
    };
    let mut known = known_outputs(ctx);
    known.retain(|old, _| !same_path(old, path));
    let mut records = known
        .into_iter()
        .map(|(path, id)| json!({"path":path,"device":id.device,"inode":id.inode}))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    if records.len() > 4095 {
        records.drain(..records.len() - 4095);
    }
    records.push(json!({"path":path,"device":identity.device,"inode":identity.inode}));
    let path = provenance_path(ctx);
    let Some(parent) = path.parent() else { return };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temporary = parent.join(format!(".export-provenance-{}.tmp", uuid::Uuid::new_v4()));
    if let Ok(mut file) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
    {
        if file
            .write_all(
                json!({"version":1,"outputs":records})
                    .to_string()
                    .as_bytes(),
            )
            .is_ok()
            && file.sync_all().is_ok()
        {
            let _ = fs::rename(&temporary, &path);
        }
    }
    let _ = fs::remove_file(temporary);
}
struct Reveal {
    path: PathBuf,
    expires: Instant,
}
static DESTINATIONS: OnceLock<Mutex<HashMap<String, Destination>>> = OnceLock::new();
static REVEALS: OnceLock<Mutex<HashMap<String, Reveal>>> = OnceLock::new();
fn destinations() -> &'static Mutex<HashMap<String, Destination>> {
    DESTINATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn reveals() -> &'static Mutex<HashMap<String, Reveal>> {
    REVEALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn format_descriptor(id: &str) -> Option<Value> {
    Some(match id {
        "jpeg" => {
            json!({"id":"jpeg","label":"JPEG","extensions":["jpg","jpeg"],"supportsQuality":true,"supportsLossless":false,"defaultQuality":90})
        }
        "png" => {
            json!({"id":"png","label":"PNG","extensions":["png"],"supportsQuality":false,"supportsLossless":false})
        }
        "webp" => {
            json!({"id":"webp","label":"WebP","extensions":["webp"],"supportsQuality":true,"supportsLossless":true,"defaultQuality":85})
        }
        "avif" => {
            json!({"id":"avif","label":"AVIF","extensions":["avif"],"supportsQuality":true,"supportsLossless":false,"defaultQuality":55})
        }
        "tiff" => {
            json!({"id":"tiff","label":"TIFF","extensions":["tif","tiff"],"supportsQuality":false,"supportsLossless":false})
        }
        _ => return None,
    })
}
fn extension(id: &str) -> &'static str {
    match id {
        "jpeg" => "jpg",
        "png" => "png",
        "webp" => "webp",
        "avif" => "avif",
        _ => "tif",
    }
}

fn valid_basename(input: &str) -> Result<String, String> {
    if input.is_empty() || input.contains(['\0', '/', '\\']) || input.contains("..") {
        return Err("Filename contains an invalid path sequence.".into());
    }
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Filename is empty after sanitization.".into());
    }
    let base = Path::new(trimmed)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or(trimmed);
    if ["jpg", "jpeg", "png", "webp", "avif", "tif", "tiff"].contains(
        &Path::new(trimmed)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
    ) {
        Ok(base.chars().take(240).collect())
    } else {
        Ok(trimmed.chars().take(240).collect())
    }
}

async fn choose(args: &[Value]) -> Result<Value, String> {
    let request = args
        .first()
        .ok_or("Export destination request is invalid.")?;
    let format = request
        .get("format")
        .and_then(Value::as_str)
        .ok_or("Export destination request is invalid.")?;
    format_descriptor(format).ok_or("Export format is unavailable.")?;
    let ids = request
        .get("assetIds")
        .and_then(Value::as_array)
        .ok_or("Export selection is invalid.")?;
    let count = request
        .get("count")
        .and_then(Value::as_u64)
        .ok_or("Export selection is invalid.")?;
    if ids.is_empty() || ids.len() as u64 > count {
        return Err("Export selection is invalid.".into());
    }
    let approved = args
        .get(1)
        .and_then(Value::as_array)
        .ok_or("Approved export sources are missing.")?;
    let selected = ids
        .iter()
        .map(|id| id.as_str().ok_or("Export selection is invalid."))
        .collect::<Result<HashSet<_>, _>>()?;
    if selected.len() != ids.len() {
        return Err("Export selection is invalid.".into());
    }
    let mut sources = HashMap::new();
    let mut found = HashSet::new();
    for source in approved {
        let path = source
            .get("path")
            .and_then(Value::as_str)
            .ok_or("Export source is invalid.")?;
        let canonical = fs::canonicalize(path).map_err(|_| "Export source is unavailable.")?;
        if !canonical.is_file() {
            return Err("Export source is not a regular file.".into());
        }
        let id = source
            .get("assetId")
            .and_then(Value::as_str)
            .ok_or("Export source is invalid.")?;
        let is_selected = selected.contains(id);
        if is_selected {
            found.insert(id);
        }
        let identity = fs::metadata(&canonical)
            .ok()
            .and_then(|meta| file_identity(&canonical, &meta));
        #[cfg(windows)]
        if identity.is_none() {
            return Err("Export source identity is unavailable.".into());
        }
        sources
            .entry(canonical)
            .and_modify(|entry: &mut Source| entry.selected |= is_selected)
            .or_insert(Source {
                selected: is_selected,
                identity,
            });
    }
    if found.len() != ids.len() {
        return Err("Export selection is invalid.".into());
    }
    #[cfg(feature = "diagnostics")]
    let smoke_path = std::env::var_os("DARKROOM_SMOKE_EXPORT_FILE").map(PathBuf::from);
    #[cfg(not(feature = "diagnostics"))]
    let smoke_path: Option<PathBuf> = None;
    let (directory, selected_path) = if count == 1 {
        let suggested = valid_basename(
            request
                .get("suggestedFilename")
                .and_then(Value::as_str)
                .ok_or("Suggested filename is invalid.")?,
        )?;
        let filename = format!("{suggested}.{}", extension(format));
        let path = if let Some(path) = smoke_path.clone() {
            path
        } else {
            let dialog = rfd::AsyncFileDialog::new()
                .set_file_name(&filename)
                .set_title("Export edited photo")
                .save_file()
                .await;
            let Some(path) = dialog.map(|file| file.path().to_path_buf()) else {
                return Ok(Value::Null);
            };
            path
        };
        let directory = fs::canonicalize(
            path.parent()
                .ok_or("The selected export path is invalid.")?,
        )
        .map_err(|e| e.to_string())?;
        if !directory.is_dir() {
            return Err("The selected export path is invalid.".into());
        }
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("The selected export path is invalid.")?;
        let filename = valid_basename(filename)?;
        let path = directory.join(format!("{filename}.{}", extension(format)));
        (directory, Some(path))
    } else {
        let path = if let Some(path) = smoke_path {
            path
        } else {
            let dialog = rfd::AsyncFileDialog::new()
                .set_title("Choose export folder")
                .pick_folder()
                .await;
            let Some(path) = dialog.map(|folder| folder.path().to_path_buf()) else {
                return Ok(Value::Null);
            };
            path
        };
        let directory = fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !directory.is_dir() {
            return Err("The selected export folder is invalid.".into());
        }
        (directory, None)
    };
    let token = uuid::Uuid::new_v4().to_string();
    let mut all = destinations().lock().map_err(|e| e.to_string())?;
    all.retain(|_, entry| entry.expires > Instant::now());
    while all.len() >= 64 {
        let Some(oldest) = all
            .iter()
            .min_by_key(|(_, entry)| entry.expires)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        all.remove(&oldest);
    }
    all.insert(
        token.clone(),
        Destination {
            directory,
            selected_path,
            format: format.to_owned(),
            sources,
            produced: Vec::new(),
            expires: Instant::now() + Duration::from_secs(15 * 60),
        },
    );
    Ok(json!({"token":token}))
}

fn pixel_data(value: &Value, options: &Value) -> Result<(Vec<u8>, u32, u32), String> {
    let wrapped = value.get("pixels").is_some();
    let dims = if wrapped { value } else { options };
    let width = dims
        .get("width")
        .and_then(Value::as_u64)
        .ok_or("Export width is invalid.")?;
    let height = dims
        .get("height")
        .and_then(Value::as_u64)
        .ok_or("Export height is invalid.")?;
    if width == 0
        || height == 0
        || width > 100_000
        || height > 100_000
        || width * height > 50_000_000
    {
        return Err("Export dimensions are invalid.".into());
    }
    let encoded = if wrapped { &value["pixels"] } else { value };
    if encoded
        .get("__darkroomBinary")
        .and_then(Value::as_str)
        .is_some_and(|text| text.len() > 266_666_668)
    {
        return Err("Export pixel data exceeds its maximum size.".into());
    }
    let data = parse_binary(encoded)?;
    if data.len() as u64 != width * height * 4 {
        return Err("Export pixel data does not match its dimensions.".into());
    }
    Ok((data, width as u32, height as u32))
}

fn resize(
    mut raw: Vec<u8>,
    width: u32,
    height: u32,
    options: &Value,
) -> Result<(ImageBuffer<Rgba<u8>, Vec<u8>>, u32, u32), String> {
    for pixel in raw.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    let image = ImageBuffer::from_raw(width, height, raw)
        .ok_or("Export pixel data does not match its dimensions.")?;
    let size = &options["size"];
    let never_upscale = size
        .get("neverUpscale")
        .or_else(|| options.get("neverUpscale"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let bounds = match size.get("mode").and_then(Value::as_str) {
        None | Some("original") => return Ok((image, width, height)),
        Some("long-edge" | "longEdge") => {
            let edge = size
                .get("longEdge")
                .or_else(|| size.get("pixels"))
                .and_then(Value::as_u64)
                .ok_or("Long edge is invalid.")?;
            if !(1..=100_000).contains(&edge) {
                return Err("Long edge is too large.".into());
            }
            let ratio = edge as f64 / width.max(height) as f64;
            (
                (width as f64 * ratio).round().max(1.0) as u32,
                (height as f64 * ratio).round().max(1.0) as u32,
            )
        }
        Some("fit") => {
            let fit_width = size
                .get("width")
                .and_then(Value::as_u64)
                .ok_or("Fit width is invalid.")?;
            let fit_height = size
                .get("height")
                .and_then(Value::as_u64)
                .ok_or("Fit height is invalid.")?;
            if !(1..=100_000).contains(&fit_width) || !(1..=100_000).contains(&fit_height) {
                return Err("Fit dimensions are too large.".into());
            }
            let ratio = (fit_width as f64 / width as f64).min(fit_height as f64 / height as f64);
            (
                (width as f64 * ratio).round().max(1.0) as u32,
                (height as f64 * ratio).round().max(1.0) as u32,
            )
        }
        _ => return Err("Unsupported export size mode.".into()),
    };
    if bounds.0 as u64 * bounds.1 as u64 > 50_000_000 {
        return Err("Export dimensions are invalid.".into());
    }
    if (bounds.0 >= width && bounds.1 >= height && never_upscale) || bounds == (width, height) {
        return Ok((image, width, height));
    }
    let resized = image::imageops::resize(&image, bounds.0, bounds.1, FilterType::Lanczos3);
    Ok((resized, bounds.0, bounds.1))
}

fn encode(
    data: Vec<u8>,
    width: u32,
    height: u32,
    format: &str,
    options: &Value,
) -> Result<Vec<u8>, String> {
    let descriptor = format_descriptor(format).ok_or("Export format is unavailable.")?;
    let quality = options
        .get("quality")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            descriptor
                .get("defaultQuality")
                .and_then(Value::as_u64)
                .unwrap_or(90)
        });
    if descriptor["supportsQuality"] == true && !(1..=100).contains(&quality) {
        return Err("Export quality must be an integer from 1 to 100.".into());
    }
    if descriptor["supportsQuality"] == false && options.get("quality").is_some() {
        return Err("Export format does not support quality.".into());
    }
    let lossless = options
        .get("lossless")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if lossless && format != "webp" {
        return Err("Export format does not support lossless mode.".into());
    }
    let (image, width, height) = resize(data, width, height, options)?;
    let rgba = image.as_raw();
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for pixel in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
    }
    let mut bytes = Vec::new();
    match format {
        "jpeg" => {
            let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality as u8);
            encoder
                .set_icc_profile(SRGB_ICC.to_vec())
                .map_err(|e| e.to_string())?;
            encoder.write_image(&rgb, width, height, ExtendedColorType::Rgb8)
        }
        "png" => {
            let mut encoder = PngEncoder::new(&mut bytes);
            encoder
                .set_icc_profile(SRGB_ICC.to_vec())
                .map_err(|e| e.to_string())?;
            encoder.write_image(&rgb, width, height, ExtendedColorType::Rgb8)
        }
        "webp" if lossless => WebPEncoder::new_lossless(&mut bytes).write_image(
            &rgb,
            width,
            height,
            ExtendedColorType::Rgb8,
        ),
        "webp" => {
            let encoded = webp::Encoder::from_rgb(&rgb, width, height).encode(quality as f32);
            bytes.extend_from_slice(&encoded);
            Ok(())
        }
        "avif" => AvifEncoder::new_with_speed_quality(&mut bytes, 4, quality as u8).write_image(
            rgba,
            width,
            height,
            ExtendedColorType::Rgba8,
        ),
        "tiff" => {
            let mut encoder = tiff::encoder::TiffEncoder::new(Cursor::new(&mut bytes))
                .map_err(|e| e.to_string())?
                .with_compression(tiff::encoder::Compression::Lzw)
                .with_predictor(tiff::encoder::Predictor::Horizontal);
            let mut image = encoder
                .new_image::<tiff::encoder::colortype::RGB8>(width, height)
                .map_err(|e| e.to_string())?;
            image
                .encoder()
                .write_tag(tiff::tags::Tag::IccProfile, SRGB_ICC)
                .map_err(|e| e.to_string())?;
            image.write_data(&rgb).map_err(|e| e.to_string())?;
            Ok(())
        }
        _ => return Err("Export format is unavailable.".into()),
    }
    .map_err(|e| e.to_string())?;
    if format == "avif" {
        insert_avif_srgb_colr(&mut bytes)?;
    }
    embed_metadata(&mut bytes, format, options, width, height)?;
    Ok(bytes)
}

fn embed_metadata(
    bytes: &mut Vec<u8>,
    format: &str,
    options: &Value,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if format == "webp" {
        ensure_webp_extended(
            bytes,
            width,
            height,
            options.get("exif").is_some(),
            options.get("xmp").is_some(),
            true,
        )?;
        insert_webp_icc(bytes, SRGB_ICC)?;
    }
    if let Some(exif) = options.get("exif") {
        let exif = exif.as_object().ok_or("Export EXIF is invalid.")?;
        let mut metadata = if format == "tiff" {
            Metadata::new_from_vec(bytes, FileExtension::TIFF)
                .map_err(|e| format!("Could not read TIFF metadata: {e}"))?
        } else {
            Metadata::new()
        };
        for (group, tags) in exif {
            if !matches!(group.as_str(), "IFD0" | "IFD2") {
                return Err("Export EXIF is invalid.".into());
            }
            let tags = tags.as_object().ok_or("Export EXIF is invalid.")?;
            for (tag, value) in tags {
                let value = value
                    .as_str()
                    .filter(|value| value.len() <= 4096)
                    .ok_or("Export EXIF is invalid.")?;
                let encoded = match (group.as_str(), tag.as_str()) {
                    ("IFD0", "Orientation") => ExifTag::Orientation(vec![
                        value
                            .parse::<u16>()
                            .map_err(|_| "Export EXIF is invalid.")?,
                    ]),
                    ("IFD0", "Copyright") => ExifTag::Copyright(value.to_owned()),
                    ("IFD0", "Make") => ExifTag::Make(value.to_owned()),
                    ("IFD0", "Model") => ExifTag::Model(value.to_owned()),
                    ("IFD2", "LensModel") => ExifTag::LensModel(value.to_owned()),
                    ("IFD2", "DateTimeOriginal") => ExifTag::DateTimeOriginal(value.to_owned()),
                    ("IFD2", "FocalLength") => ExifTag::FocalLength(vec![
                        value
                            .parse::<f64>()
                            .map_err(|_| "Export EXIF is invalid.")?
                            .into(),
                    ]),
                    ("IFD2", "FNumber") => ExifTag::FNumber(vec![
                        value
                            .parse::<f64>()
                            .map_err(|_| "Export EXIF is invalid.")?
                            .into(),
                    ]),
                    ("IFD2", "ExposureTime") => ExifTag::ExposureTime(vec![
                        value
                            .parse::<f64>()
                            .map_err(|_| "Export EXIF is invalid.")?
                            .into(),
                    ]),
                    ("IFD2", "ISOSpeedRatings") => ExifTag::ISOSpeed(vec![
                        value
                            .parse::<u32>()
                            .map_err(|_| "Export EXIF is invalid.")?,
                    ]),
                    _ => return Err("Export EXIF is invalid.".into()),
                };
                metadata.set_tag(encoded);
            }
        }
        let file_type = match format {
            "jpeg" => FileExtension::JPEG,
            "png" => FileExtension::PNG {
                as_zTXt_chunk: false,
            },
            "webp" => FileExtension::WEBP,
            "avif" => FileExtension::HEIF,
            "tiff" => FileExtension::TIFF,
            _ => return Err("Export format is unavailable.".into()),
        };
        metadata
            .write_to_vec(bytes, file_type)
            .map_err(|e| format!("Could not write EXIF metadata: {e}"))?;
    }
    if let Some(xmp) = options.get("xmp") {
        let xmp = xmp
            .as_str()
            .filter(|xmp| xmp.len() <= 16 * 1024 * 1024)
            .ok_or("Export XMP is invalid or too large.")?;
        match format {
            "jpeg" => insert_jpeg_xmp(bytes, xmp.as_bytes())?,
            "png" => insert_png_xmp(bytes, xmp.as_bytes())?,
            "webp" => insert_webp_xmp(bytes, xmp.as_bytes())?,
            "tiff" => insert_tiff_xmp(bytes, xmp.as_bytes())?,
            "avif" => insert_avif_xmp(bytes, xmp.as_bytes())?,
            _ => return Err("XMP metadata is unavailable for this export format.".into()),
        }
    }
    Ok(())
}

fn insert_jpeg_xmp(bytes: &mut Vec<u8>, xmp: &[u8]) -> Result<(), String> {
    const HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err("Encoded JPEG is invalid.".into());
    }
    let mut segments = Vec::new();
    if 2 + HEADER.len() + xmp.len() <= u16::MAX as usize {
        append_jpeg_app1(&mut segments, HEADER, xmp)?;
    } else {
        const EXTENSION: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";
        let guid = uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .to_ascii_uppercase();
        let standard = format!(
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmpNote=\"http://ns.adobe.com/xmp/note/\" xmpNote:HasExtendedXMP=\"{guid}\"/></rdf:RDF></x:xmpmeta>"
        );
        append_jpeg_app1(&mut segments, HEADER, standard.as_bytes())?;
        let chunk_size = u16::MAX as usize - 2 - EXTENSION.len() - 32 - 8;
        for (offset, chunk) in xmp.chunks(chunk_size).enumerate() {
            let start = offset * chunk_size;
            let mut payload = Vec::with_capacity(40 + chunk.len());
            payload.extend_from_slice(guid.as_bytes());
            payload.extend_from_slice(&(xmp.len() as u32).to_be_bytes());
            payload.extend_from_slice(&(start as u32).to_be_bytes());
            payload.extend_from_slice(chunk);
            append_jpeg_app1(&mut segments, EXTENSION, &payload)?;
        }
    }
    bytes.splice(2..2, segments);
    Ok(())
}

fn append_jpeg_app1(target: &mut Vec<u8>, header: &[u8], payload: &[u8]) -> Result<(), String> {
    let length = 2 + header.len() + payload.len();
    if length > u16::MAX as usize {
        return Err("Export XMP exceeds the JPEG packet limit.".into());
    }
    target.extend_from_slice(&[0xff, 0xe1]);
    target.extend_from_slice(&(length as u16).to_be_bytes());
    target.extend_from_slice(header);
    target.extend_from_slice(payload);
    Ok(())
}

fn insert_png_xmp(bytes: &mut Vec<u8>, xmp: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Encoded PNG is invalid.".into());
    }
    let data = [b"XML:com.adobe.xmp\0\0\0\0\0".as_slice(), xmp].concat();
    let mut chunk = Vec::with_capacity(data.len() + 12);
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(b"iTXt");
    chunk.extend_from_slice(&data);
    let crc = png_crc(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());
    bytes.splice(8..8, chunk);
    Ok(())
}

fn insert_webp_xmp(bytes: &mut Vec<u8>, xmp: &[u8]) -> Result<(), String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("Encoded WebP is invalid.".into());
    }
    bytes.extend_from_slice(b"XMP ");
    bytes.extend_from_slice(&(xmp.len() as u32).to_le_bytes());
    bytes.extend_from_slice(xmp);
    if xmp.len() % 2 != 0 {
        bytes.push(0);
    }
    let riff_size = (bytes.len() - 8) as u32;
    bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Ok(())
}

fn insert_webp_icc(bytes: &mut Vec<u8>, icc: &[u8]) -> Result<(), String> {
    if bytes.len() < 30 || &bytes[12..16] != b"VP8X" {
        return Err("Encoded WebP is invalid.".into());
    }
    let mut chunk = Vec::with_capacity(8 + icc.len() + 1);
    chunk.extend_from_slice(b"ICCP");
    chunk.extend_from_slice(&(icc.len() as u32).to_le_bytes());
    chunk.extend_from_slice(icc);
    if icc.len() % 2 != 0 {
        chunk.push(0);
    }
    bytes.splice(30..30, chunk);
    let riff_size = (bytes.len() - 8) as u32;
    bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Ok(())
}

fn ensure_webp_extended(
    bytes: &mut Vec<u8>,
    width: u32,
    height: u32,
    exif: bool,
    xmp: bool,
    icc: bool,
) -> Result<(), String> {
    if bytes.len() < 20 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("Encoded WebP is invalid.".into());
    }
    let mut flags = 0_u8;
    if exif {
        flags |= 0x08;
    }
    if xmp {
        flags |= 0x04;
    }
    if icc {
        flags |= 0x20;
    }
    if &bytes[12..16] == b"VP8X" {
        if bytes.len() < 30 {
            return Err("Encoded WebP is invalid.".into());
        }
        bytes[20] |= flags;
        return Ok(());
    }
    if width == 0 || height == 0 || width > 0x1000000 || height > 0x1000000 {
        return Err("Encoded WebP dimensions are invalid.".into());
    }
    let mut chunk = Vec::with_capacity(18);
    chunk.extend_from_slice(b"VP8X");
    chunk.extend_from_slice(&10_u32.to_le_bytes());
    chunk.push(flags);
    chunk.extend_from_slice(&[0, 0, 0]);
    let w = (width - 1).to_le_bytes();
    let h = (height - 1).to_le_bytes();
    chunk.extend_from_slice(&w[..3]);
    chunk.extend_from_slice(&h[..3]);
    bytes.splice(12..12, chunk);
    let riff_size = (bytes.len() - 8) as u32;
    bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Ok(())
}

fn png_crc(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0_u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn insert_tiff_xmp(bytes: &mut Vec<u8>, xmp: &[u8]) -> Result<(), String> {
    if bytes.len() < 8 {
        return Err("Encoded TIFF is invalid.".into());
    }
    let little = match &bytes[..4] {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return Err("Encoded TIFF is invalid.".into()),
    };
    let read_u16 = |data: &[u8]| -> u16 {
        if little {
            u16::from_le_bytes([data[0], data[1]])
        } else {
            u16::from_be_bytes([data[0], data[1]])
        }
    };
    let read_u32 = |data: &[u8]| -> u32 {
        if little {
            u32::from_le_bytes([data[0], data[1], data[2], data[3]])
        } else {
            u32::from_be_bytes([data[0], data[1], data[2], data[3]])
        }
    };
    let put_u16 = |value: u16| -> [u8; 2] {
        if little {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        }
    };
    let put_u32 = |value: u32| -> [u8; 4] {
        if little {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        }
    };
    let offset = read_u32(&bytes[4..8]) as usize;
    if offset + 2 > bytes.len() {
        return Err("Encoded TIFF is invalid.".into());
    }
    let count = read_u16(&bytes[offset..offset + 2]) as usize;
    let end = offset
        .checked_add(2 + count * 12 + 4)
        .filter(|end| *end <= bytes.len())
        .ok_or("Encoded TIFF is invalid.")?;
    if count >= u16::MAX as usize {
        return Err("Encoded TIFF has too many tags.".into());
    }
    let original_entries = bytes[offset + 2..offset + 2 + count * 12].to_vec();
    let next = bytes[end - 4..end].to_vec();
    let xmp_offset = bytes.len();
    bytes.extend_from_slice(xmp);
    if bytes.len() % 2 != 0 {
        bytes.push(0);
    }
    let ifd_offset = bytes.len();
    if ifd_offset > u32::MAX as usize || xmp.len() > u32::MAX as usize {
        return Err("Export XMP is too large.".into());
    }
    let existing_xmp = original_entries
        .chunks_exact(12)
        .any(|entry| read_u16(&entry[..2]) == 700);
    bytes.extend_from_slice(&put_u16((count + usize::from(!existing_xmp)) as u16));
    let mut inserted = false;
    for entry in original_entries.chunks_exact(12) {
        if !inserted && read_u16(&entry[..2]) > 700 {
            bytes.extend_from_slice(&put_u16(700));
            bytes.extend_from_slice(&put_u16(1));
            bytes.extend_from_slice(&put_u32(xmp.len() as u32));
            if xmp.len() <= 4 {
                let mut inline = [0_u8; 4];
                inline[..xmp.len()].copy_from_slice(xmp);
                bytes.extend_from_slice(&inline);
            } else {
                bytes.extend_from_slice(&put_u32(xmp_offset as u32));
            }
            inserted = true;
        }
        if read_u16(&entry[..2]) != 700 {
            bytes.extend_from_slice(entry);
        }
    }
    if !inserted {
        bytes.extend_from_slice(&put_u16(700));
        bytes.extend_from_slice(&put_u16(1));
        bytes.extend_from_slice(&put_u32(xmp.len() as u32));
        if xmp.len() <= 4 {
            let mut inline = [0_u8; 4];
            inline[..xmp.len()].copy_from_slice(xmp);
            bytes.extend_from_slice(&inline);
        } else {
            bytes.extend_from_slice(&put_u32(xmp_offset as u32));
        }
    }
    bytes.extend_from_slice(&next);
    bytes[4..8].copy_from_slice(&put_u32(ifd_offset as u32));
    Ok(())
}

fn insert_avif_xmp(bytes: &mut Vec<u8>, xmp: &[u8]) -> Result<(), String> {
    std::str::from_utf8(xmp).map_err(|_| "Export XMP is invalid UTF-8.")?;
    let (meta_start, meta_end) = avif_box(bytes, 0, bytes.len(), b"meta")?;
    let (iloc_start, iloc_end) = avif_box(bytes, meta_start + 12, meta_end, b"iloc")?;
    let size = 24_usize
        .checked_add(xmp.len())
        .ok_or("Export XMP is too large.")?;
    if size > u32::MAX as usize || meta_end.checked_add(size).is_none() {
        return Err("Export XMP is too large.".into());
    }
    shift_avif_iloc(bytes, iloc_start, iloc_end, meta_end, size)?;
    let mut box_bytes = Vec::with_capacity(size);
    box_bytes.extend_from_slice(&(size as u32).to_be_bytes());
    box_bytes.extend_from_slice(b"uuid");
    box_bytes.extend_from_slice(&[
        0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf,
        0xac,
    ]);
    box_bytes.extend_from_slice(xmp);
    bytes.splice(meta_end..meta_end, box_bytes);
    let new_size = meta_end - meta_start + size;
    bytes[meta_start..meta_start + 4].copy_from_slice(
        &(u32::try_from(new_size).map_err(|_| "Export AVIF metadata is too large.")?).to_be_bytes(),
    );
    Ok(())
}

fn insert_avif_srgb_colr(bytes: &mut Vec<u8>) -> Result<(), String> {
    let (meta_start, meta_end) = avif_box(bytes, 0, bytes.len(), b"meta")?;
    let (iloc_start, iloc_end) = avif_box(bytes, meta_start + 12, meta_end, b"iloc")?;
    let (iprp_start, iprp_end) = avif_box(bytes, meta_start + 12, meta_end, b"iprp")?;
    let (ipco_start, ipco_end) = avif_box(bytes, iprp_start + 8, iprp_end, b"ipco")?;
    let (ipma_start, ipma_end) = avif_box(bytes, iprp_start + 8, iprp_end, b"ipma")?;
    if bytes[ipma_start + 8..ipma_start + 12] != [0, 0, 0, 0]
        || bytes[ipma_start + 12..ipma_start + 16] != [0, 0, 0, 1]
        || ipma_start + 19 > ipma_end
    {
        return Err("Encoded AVIF property associations are unsupported.".into());
    }
    let mut properties = 0_u8;
    let mut cursor = ipco_start + 8;
    while cursor < ipco_end {
        if cursor + 8 > ipco_end {
            return Err("Encoded AVIF properties are invalid.".into());
        }
        let size = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().expect("slice length"))
            as usize;
        if size < 8 || cursor + size > ipco_end {
            return Err("Encoded AVIF properties are invalid.".into());
        }
        properties = properties
            .checked_add(1)
            .ok_or("Encoded AVIF has too many properties.")?;
        cursor += size;
    }
    let associated = bytes[ipma_start + 18] as usize;
    if properties >= 126
        || associated != properties as usize
        || ipma_start + 19 + associated != ipma_end
    {
        return Err("Encoded AVIF property associations are unsupported.".into());
    }
    let icc_box_size = 12_usize
        .checked_add(SRGB_ICC.len())
        .ok_or("Export AVIF color profile is too large.")?;
    let property_bytes = 19_usize
        .checked_add(icc_box_size)
        .ok_or("Export AVIF color profile is too large.")?;
    let added = property_bytes + 2;
    shift_avif_iloc(bytes, iloc_start, iloc_end, meta_end, added)?;
    let colr: [u8; 19] = [
        0, 0, 0, 19, b'c', b'o', b'l', b'r', b'n', b'c', b'l', b'x', 0, 1, 0, 13, 0, 6, 0x80,
    ];
    let mut color_properties = Vec::with_capacity(property_bytes);
    color_properties.extend_from_slice(&colr);
    color_properties.extend_from_slice(
        &u32::try_from(icc_box_size)
            .map_err(|_| "Export AVIF color profile is too large.")?
            .to_be_bytes(),
    );
    color_properties.extend_from_slice(b"colrprof");
    color_properties.extend_from_slice(SRGB_ICC);
    bytes.splice(ipco_end..ipco_end, color_properties);
    let ipma_start = ipma_start + property_bytes;
    let ipma_end = ipma_end + property_bytes;
    bytes[ipma_start + 18] += 2;
    bytes.splice(ipma_end..ipma_end, [properties + 1, properties + 2]);
    for (start, length) in [
        (ipco_start, ipco_end - ipco_start + property_bytes),
        (ipma_start, ipma_end - ipma_start + 2),
        (iprp_start, iprp_end - iprp_start + added),
        (meta_start, meta_end - meta_start + added),
    ] {
        bytes[start..start + 4].copy_from_slice(
            &u32::try_from(length)
                .map_err(|_| "Export AVIF metadata is too large.")?
                .to_be_bytes(),
        );
    }
    Ok(())
}

fn avif_box(
    bytes: &[u8],
    start: usize,
    end: usize,
    name: &[u8; 4],
) -> Result<(usize, usize), String> {
    let mut cursor = start;
    while cursor + 8 <= end {
        let size = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().expect("slice length"))
            as usize;
        if size < 8 || cursor.checked_add(size).is_none_or(|next| next > end) {
            return Err("Encoded AVIF box is invalid.".into());
        }
        if &bytes[cursor + 4..cursor + 8] == name {
            return Ok((cursor, cursor + size));
        }
        cursor += size;
    }
    Err("Encoded AVIF box is missing.".into())
}

fn shift_avif_iloc(
    bytes: &mut [u8],
    start: usize,
    end: usize,
    insert_at: usize,
    delta: usize,
) -> Result<(), String> {
    if end < start + 16 || bytes[start + 8] != 0 {
        return Err("Encoded AVIF item locations are unsupported.".into());
    }
    let offset_size = usize::from(bytes[start + 12] >> 4);
    let length_size = usize::from(bytes[start + 12] & 15);
    let base_size = usize::from(bytes[start + 13] >> 4);
    let index_size = usize::from(bytes[start + 13] & 15);
    if !matches!(offset_size, 4 | 8)
        || !matches!(length_size, 4 | 8)
        || base_size != 0
        || index_size != 0
    {
        return Err("Encoded AVIF item locations are unsupported.".into());
    }
    let count = u16::from_be_bytes([bytes[start + 14], bytes[start + 15]]) as usize;
    let mut cursor = start + 16;
    for _ in 0..count {
        if cursor + 6 > end {
            return Err("Encoded AVIF item locations are invalid.".into());
        }
        cursor += 4;
        let extents = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
        cursor += 2;
        for _ in 0..extents {
            if cursor + offset_size + length_size > end {
                return Err("Encoded AVIF item extent is invalid.".into());
            }
            let mut offset = 0_u64;
            for byte in &bytes[cursor..cursor + offset_size] {
                offset = offset * 256 + u64::from(*byte)
            }
            if offset >= insert_at as u64 {
                offset = offset
                    .checked_add(delta as u64)
                    .ok_or("Encoded AVIF offset overflowed.")?;
                if offset_size == 4 && offset > u32::MAX as u64 {
                    return Err("Encoded AVIF offset overflowed.".into());
                }
                for place in (cursor..cursor + offset_size).rev() {
                    bytes[place] = offset as u8;
                    offset >>= 8;
                }
            }
            cursor += offset_size + length_size;
        }
    }
    Ok(())
}

fn target_path(
    destination: &Destination,
    basename: &str,
    options: &Value,
) -> Result<PathBuf, String> {
    if let Some(path) = &destination.selected_path {
        return Ok(path.clone());
    }
    let base = valid_basename(basename)?;
    let suffix = options
        .get("filenameSuffix")
        .or_else(|| options.get("suffix"))
        .and_then(Value::as_str)
        .unwrap_or("-darkroom");
    if !suffix.is_empty() {
        valid_basename(suffix)?;
    }
    Ok(destination
        .directory
        .join(format!("{base}{suffix}.{}", extension(&destination.format))))
}

fn safe_target(path: &Path, destination: &Destination, ctx: &NativeContext) -> Result<(), String> {
    if path.parent() != Some(destination.directory.as_path()) {
        return Err("Export target must stay inside the approved folder.".into());
    }
    let mut actual_path = None;
    let mut identity = None;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Export target is not a regular file.".into());
        }
        actual_path = Some(fs::canonicalize(path).map_err(|e| e.to_string())?);
        identity = file_identity(path, &metadata);
        #[cfg(windows)]
        if identity.is_none() {
            return Err("Export target identity is unavailable.".into());
        }
    }
    let matches = destination
        .sources
        .iter()
        .filter(|(source, item)| {
            same_path(source, path)
                || actual_path
                    .as_deref()
                    .is_some_and(|actual| same_path(source, actual))
                || identity.is_some() && identity == item.identity
        })
        .collect::<Vec<_>>();
    if !matches.is_empty() {
        let known = known_outputs(ctx);
        let proven = identity.is_some_and(|identity| {
            known.iter().any(|(known_path, known_identity)| {
                same_path(known_path, path) && *known_identity == identity
            })
        });
        if matches.iter().any(|(_, source)| source.selected) || !proven {
            return Err("Export cannot overwrite a source photo.".into());
        }
    }
    Ok(())
}

fn save(
    token: &str,
    basename: &str,
    pixels: &Value,
    raw_override: Option<Vec<u8>>,
    options: &Value,
    ctx: &NativeContext,
) -> Result<Value, String> {
    let mut all = destinations().lock().map_err(|e| e.to_string())?;
    let destination = all
        .get_mut(token)
        .ok_or("Export destination is no longer approved.")?;
    if destination.expires < Instant::now() {
        all.remove(token);
        return Err("Export destination is no longer approved.".into());
    }
    if options.get("format").and_then(Value::as_str) != Some(destination.format.as_str()) {
        return Err("Export format does not match the selected destination.".into());
    }
    if fs::canonicalize(&destination.directory).map_err(|e| e.to_string())? != destination.directory
    {
        return Err("Export destination changed after it was approved.".into());
    }
    let target = target_path(destination, basename, options)?;
    safe_target(&target, destination, ctx)?;
    let (data, width, height) = if let Some(data) = raw_override {
        let dims = if pixels.get("width").is_some() {
            pixels
        } else {
            options
        };
        let width = dims
            .get("width")
            .and_then(Value::as_u64)
            .ok_or("Export width is invalid.")?;
        let height = dims
            .get("height")
            .and_then(Value::as_u64)
            .ok_or("Export height is invalid.")?;
        if width == 0
            || height == 0
            || width > 100_000
            || height > 100_000
            || width * height > 50_000_000
            || data.len() as u64 != width * height * 4
        {
            return Err("Export pixel data does not match its dimensions.".into());
        }
        (data, width as u32, height as u32)
    } else {
        pixel_data(pixels, options)?
    };
    let encoded = encode(data, width, height, &destination.format, options)?;
    let behavior = options
        .get("conflict")
        .and_then(Value::as_str)
        .unwrap_or("rename");
    let final_target = match behavior {
        "skip" if target.exists() => return Ok(json!({"status":"skipped","path":target})),
        "skip" | "replace" => target,
        "rename" => {
            if !target.exists() {
                target
            } else {
                let stem = target
                    .file_stem()
                    .and_then(|v| v.to_str())
                    .ok_or("Export filename is invalid.")?;
                let ext = target
                    .extension()
                    .and_then(|v| v.to_str())
                    .ok_or("Export filename is invalid.")?;
                (1..=999)
                    .map(|n| destination.directory.join(format!("{stem}-{n}.{ext}")))
                    .find(|p| !p.exists())
                    .ok_or("Could not find an available export filename.")?
            }
        }
        _ => return Err("Unsupported export conflict behavior.".into()),
    };
    safe_target(&final_target, destination, ctx)?;
    if behavior == "replace" {
        let temp = destination
            .directory
            .join(format!(".darkroom-export-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            file.write_all(&encoded).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            safe_target(&final_target, destination, ctx)?;
            fs::rename(&temp, &final_target).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result?;
    } else {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&final_target)
            .map_err(|e| e.to_string())?;
        if let Err(error) = file.write_all(&encoded).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&final_target);
            return Err(error.to_string());
        }
    }
    destination.produced.push(final_target.clone());
    remember_output(ctx, &final_target);
    destination.expires = Instant::now() + Duration::from_secs(15 * 60);
    Ok(json!({"status":"exported","path":final_target}))
}

fn finalize(token: &str) -> Result<Value, String> {
    let destination = destinations()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(token)
        .ok_or("Export destination is no longer approved.")?;
    let Some(path) = destination.produced.last() else {
        return Ok(json!({"revealToken":null,"outputPath":null}));
    };
    let reveal = uuid::Uuid::new_v4().to_string();
    let mut all = reveals().lock().map_err(|e| e.to_string())?;
    all.retain(|_, entry| entry.expires > Instant::now());
    while all.len() >= 64 {
        let Some(oldest) = all
            .iter()
            .min_by_key(|(_, entry)| entry.expires)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        all.remove(&oldest);
    }
    all.insert(
        reveal.clone(),
        Reveal {
            path: path.clone(),
            expires: Instant::now() + Duration::from_secs(30 * 60),
        },
    );
    Ok(json!({"revealToken":reveal,"outputPath":path}))
}

pub async fn handle(command: &str, args: &[Value], ctx: &NativeContext) -> Result<Value, String> {
    match command {
        "darkroom:get-export-formats" => Ok(Value::Array(
            ["jpeg", "png", "webp", "avif", "tiff"]
                .iter()
                .filter_map(|id| format_descriptor(id))
                .collect(),
        )),
        "darkroom:choose-export-destination" => choose(args).await,
        "darkroom:encode-and-save-export" => save(
            args.first()
                .and_then(Value::as_str)
                .ok_or("Invalid export destination token.")?,
            args.get(1)
                .and_then(Value::as_str)
                .ok_or("Filename is invalid.")?,
            args.get(2).ok_or("Export pixels are missing.")?,
            None,
            args.get(3).ok_or("Export options are required.")?,
            ctx,
        ),
        "darkroom:finalize-export" => finalize(
            args.first()
                .and_then(Value::as_str)
                .ok_or("Invalid export destination token.")?,
        ),
        "darkroom:show-in-folder" => {
            let token = args
                .first()
                .and_then(Value::as_str)
                .ok_or("Invalid export reveal capability.")?;
            let reveal = reveals()
                .lock()
                .map_err(|e| e.to_string())?
                .remove(token)
                .ok_or("Export reveal capability is no longer valid.")?;
            if reveal.expires < Instant::now() {
                return Err("Export reveal capability is no longer valid.".into());
            }
            open::that(
                reveal
                    .path
                    .parent()
                    .ok_or("Export reveal capability is invalid.")?,
            )
            .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err(format!("Unknown export command: {command}")),
    }
}

pub fn encode_export_raw(
    args: &[Value],
    pixels: Vec<u8>,
    ctx: &NativeContext,
) -> Result<Value, String> {
    save(
        args.first()
            .and_then(Value::as_str)
            .ok_or("Invalid export destination token.")?,
        args.get(1)
            .and_then(Value::as_str)
            .ok_or("Filename is invalid.")?,
        args.get(2).ok_or("Export dimensions are missing.")?,
        Some(pixels),
        args.get(3).ok_or("Export options are required.")?,
        ctx,
    )
}
