use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    NativeContext,
    assets::{check_open_regular, open_regular, resolve_asset},
    binary_value,
    raw_preview_cache::{FullDecodeCache, PreviewCache},
};

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}
fn architecture() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

fn helper(ctx: &NativeContext) -> Option<(PathBuf, &'static str)> {
    if cfg!(debug_assertions) {
        if let Ok(path) = std::env::var("DARKROOM_NEF_HELPER_PATH") {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                return Some((path, "development"));
            }
        }
        if cfg!(target_os = "macos") {
            let sdk_root = std::env::var_os("DARKROOM_NEF_SDK_ROOT")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .map(|home| PathBuf::from(home).join(".darkroom-sdk/nikon-nef"))
                });
            if let Some(path) = sdk_root.map(|root| {
                root.join("spike/DarkroomNefSpike.app/Contents/MacOS/nikon-nef-decoder")
            }) {
                if path.exists() {
                    return Some((path, "development"));
                }
            }
        }
    }
    if cfg!(target_os = "macos") {
        Some((
            ctx.resources
                .join("nikon-nef-decoder/MacOS/nikon-nef-decoder"),
            "packaged",
        ))
    } else {
        None
    }
}

fn is_cancelled(cancelled: Option<&AtomicBool>) -> bool {
    cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed))
}

fn is_stopped(cancelled: Option<&AtomicBool>, preempted: Option<&AtomicBool>) -> bool {
    is_cancelled(cancelled) || is_cancelled(preempted)
}

/// Serializes `nikon-nef-decoder` spawns to 1 concurrent process (the Nikon SDK
/// already saturates all CPU cores via TBB and allocates 500–900 MB RSS per
/// process), orders waiting jobs by descending priority, and preempts low-priority
/// background preloads when a foreground user request arrives.
struct NikonHelperGateState {
    busy: bool,
    active: Option<(i32, Arc<AtomicBool>)>,
    next_seq: u64,
    waiters: BinaryHeap<(i32, Reverse<u64>)>,
}

struct NikonHelperGate {
    state: Mutex<NikonHelperGateState>,
    condvar: Condvar,
}

struct NikonHelperPermit {
    gate: &'static NikonHelperGate,
    preempted: Arc<AtomicBool>,
}

impl Drop for NikonHelperPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() {
            state.busy = false;
            state.active = None;
            self.gate.condvar.notify_all();
        }
    }
}

impl NikonHelperGate {
    fn new() -> Self {
        Self {
            state: Mutex::new(NikonHelperGateState {
                busy: false,
                active: None,
                next_seq: 0,
                waiters: BinaryHeap::new(),
            }),
            condvar: Condvar::new(),
        }
    }

    fn acquire(
        &'static self,
        priority: i32,
        cancelled: Option<&AtomicBool>,
    ) -> Result<NikonHelperPermit, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Nikon decoder queue is unavailable.")?;
        if is_cancelled(cancelled) {
            return Err("Nikon decode was cancelled.".into());
        }
        let seq = state.next_seq;
        state.next_seq = state.next_seq.wrapping_add(1);
        let key = (priority, Reverse(seq));
        state.waiters.push(key);
        loop {
            if is_cancelled(cancelled) {
                state.waiters.retain(|item| *item != key);
                self.condvar.notify_all();
                return Err("Nikon decode was cancelled.".into());
            }
            if state.busy
                && priority >= 50
                && let Some((active_prio, ref active_preempt)) = state.active
                && active_prio < 0
            {
                active_preempt.store(true, Ordering::Relaxed);
            }
            if !state.busy && state.waiters.peek() == Some(&key) {
                state.waiters.pop();
                state.busy = true;
                let preempted = Arc::new(AtomicBool::new(false));
                state.active = Some((priority, Arc::clone(&preempted)));
                return Ok(NikonHelperPermit {
                    gate: self,
                    preempted,
                });
            }
            let (guard, _) = self
                .condvar
                .wait_timeout(state, Duration::from_millis(5))
                .map_err(|_| "Nikon decoder queue is unavailable.")?;
            state = guard;
        }
    }
}

fn nikon_helper_gate() -> &'static NikonHelperGate {
    static GATE: OnceLock<NikonHelperGate> = OnceLock::new();
    GATE.get_or_init(NikonHelperGate::new)
}

#[cfg(target_os = "macos")]
fn try_clone_snapshot(source: &File, work_dir: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::io::AsRawFd;

    unsafe extern "C" {
        fn fclonefileat(
            srcfd: libc::c_int,
            dst_dirfd: libc::c_int,
            dst: *const libc::c_char,
            flags: u32,
        ) -> libc::c_int;
    }

    let Ok(dir) = File::open(work_dir) else {
        return false;
    };
    let Ok(name) = CString::new("input.nef") else {
        return false;
    };
    unsafe { fclonefileat(source.as_raw_fd(), dir.as_raw_fd(), name.as_ptr(), 0) == 0 }
}

#[cfg(not(target_os = "macos"))]
fn try_clone_snapshot(_source: &File, _work_dir: &Path) -> bool {
    false
}

fn read_exact_file(path: &Path, byte_count: usize, cancelled: Option<&AtomicBool>) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() as usize != byte_count {
        return Err("Nikon decoder pixel byte count is invalid.".into());
    }
    let mut pixels = vec![0_u8; byte_count];
    for chunk in pixels.chunks_mut(4 * 1024 * 1024) {
        if is_cancelled(cancelled) {
            return Err("Nikon decode was cancelled.".into());
        }
        file.read_exact(chunk).map_err(|e| e.to_string())?;
    }
    Ok(pixels)
}

fn run_with_timeout(
    mut command: Command,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
    preempted: Option<&AtomicBool>,
) -> Result<std::process::ExitStatus, String> {
    if is_stopped(cancelled, preempted) {
        return Err("Nikon decode was cancelled.".into());
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Nikon decoder could not start.")?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if is_stopped(cancelled, preempted) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Nikon decode was cancelled.".into());
            }
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Nikon decoder timed out.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return Err("Nikon decoder failed.".into()),
        }
    }
}

fn checksum(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Nikon decoder is not installed.")?;
    if !metadata.is_file() {
        return Err("Nikon decoder is not installed.".into());
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn runtime_approved(ctx: &NativeContext, state: &str, digest: &str) -> bool {
    if state == "packaged" {
        let manifest = ctx.resources.join("nikon-nef-decoder/runtime.json");
        let Ok(metadata) = fs::symlink_metadata(&manifest) else {
            return false;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return false;
        }
        let Ok(bytes) = fs::read(manifest) else {
            return false;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return false;
        };
        return value["version"] == 1
            && value["checksum"].as_str().is_some_and(|checksum| {
                checksum.len() == 64
                    && checksum
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    && checksum == digest
            });
    }
    cfg!(debug_assertions)
        && std::env::var("DARKROOM_NEF_APPROVED_CHECKSUM")
            .ok()
            .as_deref()
            == Some(digest)
}

fn development_helper_allowed(state: &str) -> bool {
    cfg!(debug_assertions)
        && state == "development"
        && std::env::var_os("DARKROOM_NEF_APPROVED_CHECKSUM").is_none()
}

fn report(ctx: &NativeContext) -> Result<Value, String> {
    let mut report: Value =
        serde_json::from_str(include_str!("formats.json")).map_err(|e| e.to_string())?;
    let nikon = if let Some((path, state)) = helper(ctx) {
        match checksum(&path) {
            Ok(before) => {
                let mut legacy_lookup_warnings = false;
                let probe = (|| -> Result<Option<Value>, String> {
                    let work = tempfile::tempdir().map_err(|e| e.to_string())?;
                    let stdout = work.path().join("probe.json");
                    let stderr = work.path().join("probe.err");
                    let mut command = Command::new(&path);
                    command
                        .arg("--probe")
                        .stdout(Stdio::from(
                            File::create(&stdout).map_err(|e| e.to_string())?,
                        ))
                        .stderr(Stdio::from(
                            File::create(&stderr).map_err(|e| e.to_string())?,
                        ));
                    let status = run_with_timeout(command, Duration::from_secs(5), None, None)?;
                    if fs::metadata(&stdout).map_err(|e| e.to_string())?.len() > 16 * 1024
                        || fs::metadata(&stderr).map_err(|e| e.to_string())?.len() > 16 * 1024
                    {
                        return Err("Nikon probe output is too large.".into());
                    }
                    let stdout_bytes = fs::read(&stdout).map_err(|e| e.to_string())?;
                    let stderr_bytes = fs::read(&stderr).map_err(|e| e.to_string())?;
                    if checksum(&path)? != before {
                        return Err("Nikon decoder changed during its probe.".into());
                    }
                    if !status.success() {
                        let stdout = String::from_utf8_lossy(&stdout_bytes);
                        let lookup_messages = path.ancestors().nth(3).map(|root| {
                            ["enum_string.csv", "uuid_string.csv"].map(|name| {
                                format!(
                                    "NOT FOUND \"{}\"",
                                    root.join("Contents/Resources").join(name).display()
                                )
                            })
                        });
                        let known_stdout = stdout.lines().all(|line| {
                            line.trim().is_empty()
                                || lookup_messages.as_ref().is_some_and(|messages| {
                                    messages.iter().any(|message| message == line)
                                })
                        });
                        if status.code().is_some_and(|code| code > 0)
                            && known_stdout
                            && String::from_utf8_lossy(&stderr_bytes).trim() == "invalid arguments"
                        {
                            legacy_lookup_warnings = !stdout.trim().is_empty();
                            return Ok(None);
                        }
                        return Err("Nikon probe exited unsuccessfully.".into());
                    }
                    let response: Value = serde_json::from_slice(&stdout_bytes)
                        .map_err(|_| "Nikon probe response is invalid.")?;
                    if response["version"] != 1
                        || response["pixelProtocol"] != "rgb16le-v1"
                        || response["architecture"] != architecture()
                        || response["backend"] != "nikon-sdk"
                        || !response["helperVersion"].is_string()
                    {
                        return Err("Nikon decoder probe is invalid.".into());
                    }
                    Ok(Some(response))
                })();
                match probe {
                    Ok(Some(response)) => {
                        let qualified = runtime_approved(ctx, state, &before);
                        json!({"status":if qualified {"available"} else {"misconfigured"},"kind":"native","packageState":state,"version":response["helperVersion"],"architecture":response["architecture"],"checksum":before,"backend":"nikon-sdk","pixelProtocol":"rgb16le-v1","reason":if qualified {"Qualified Nikon native runtime passed its versioned probe."} else if development_helper_allowed(state) {"Development Nikon decoder can run locally but is not release-qualified."} else {"Nikon decoder checksum does not match its approved runtime."}})
                    }
                    Ok(None) => {
                        let reason = if runtime_approved(ctx, state, &before) {
                            "Legacy Nikon decoder starts without a capability probe. Its checksum is verified; decoding can be attempted and each image output is validated."
                        } else if development_helper_allowed(state) {
                            "Legacy development Nikon decoder starts without a capability probe. Local decoding is test-only."
                        } else {
                            "Legacy Nikon decoder starts without a capability probe, but its checksum is unapproved; decoding is unavailable."
                        };
                        let reason = if legacy_lookup_warnings {
                            format!(
                                "{reason} The SDK also reported missing enum/UUID lookup tables."
                            )
                        } else {
                            reason.to_owned()
                        };
                        json!({"status":"misconfigured","kind":"native","packageState":state,"version":null,"architecture":null,"checksum":before,"backend":null,"pixelProtocol":null,"reason":reason})
                    }
                    Err(reason) => {
                        json!({"status":"misconfigured","kind":"native","packageState":state,"version":null,"architecture":null,"checksum":before,"backend":null,"pixelProtocol":null,"reason":reason})
                    }
                }
            }
            Err(reason) => {
                json!({"status":"unavailable","kind":"native","packageState":state,"version":null,"architecture":null,"checksum":null,"backend":null,"pixelProtocol":null,"reason":reason})
            }
        }
    } else {
        json!({"status":"unavailable","kind":"none","packageState":"unavailable","version":null,"architecture":null,"checksum":null,"backend":null,"pixelProtocol":null,"reason":"No Nikon decoder helper is configured."})
    };
    report["version"] = json!(1);
    report["appVersion"] = json!(env!("CARGO_PKG_VERSION"));
    report["platform"] = json!(platform());
    report["architecture"] = json!(architecture());
    report["cameraRows"] = json!([]);
    report["nikon"] = nikon;
    Ok(report)
}

struct DecodedAsset {
    metadata: Value,
    pixels: Vec<u8>,
    source_handle: Option<String>,
    pixels_omitted: bool,
}

impl DecodedAsset {
    fn from_binary(mut bytes: Vec<u8>) -> Option<Self> {
        let length = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        let metadata: Value = serde_json::from_slice(bytes.get(4..4 + length)?).ok()?;
        let pixels = bytes.split_off(4 + length);
        if metadata["available"] != true || metadata["byteCount"].as_u64()? != pixels.len() as u64 {
            return None;
        }
        Some(Self {
            metadata,
            pixels,
            source_handle: None,
            pixels_omitted: false,
        })
    }

    fn into_json(mut self) -> Value {
        if self.metadata["available"] == true {
            self.metadata["pixels"] = binary_value(&self.pixels);
        }
        self.metadata
    }

    fn to_binary(&self) -> Result<Vec<u8>, String> {
        let metadata = serde_json::to_vec(&self.metadata).map_err(|e| e.to_string())?;
        let payload_len = if self.pixels_omitted {
            0
        } else {
            self.pixels.len()
        };
        let mut response = Vec::with_capacity(4 + metadata.len() + payload_len);
        response.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        response.extend_from_slice(&metadata);
        if !self.pixels_omitted {
            response.extend_from_slice(&self.pixels);
        }
        Ok(response)
    }
}

/// Full output must never be scaled: send the protocol's largest edge so a
/// helper that honors --max-edge in both modes cannot cap it at preview size.
fn helper_max_edge(mode: &str, max_edge: u64) -> u64 {
    if mode == "full" {
        65_535
    } else {
        max_edge.min(2560)
    }
}

fn failure(code: &str, message: &str) -> DecodedAsset {
    DecodedAsset {
        metadata: json!({"available":false,"code":code,"message":message}),
        pixels: Vec::new(),
        source_handle: None,
        pixels_omitted: false,
    }
}

fn package_full_decoded(
    mut metadata: Value,
    pixels: Vec<u8>,
    width: u64,
    height: u64,
    handle_only: bool,
) -> Result<(DecodedAsset, Option<Arc<crate::RawSource>>), String> {
    if pixels.len() <= crate::RAW_SOURCE_LIMIT {
        let handle = uuid::Uuid::new_v4().to_string();
        if handle_only {
            let arc = Arc::new(crate::RawSource {
                width: width as u32,
                height: height as u32,
                format: crate::NativeSourceFormat::Rgb16,
                data: pixels,
            });
            let inserted = crate::raw_sources()
                .lock()
                .map(|mut sources| {
                    sources.insert_arc(handle.clone(), Arc::clone(&arc));
                    true
                })
                .unwrap_or(false);
            if !inserted {
                return Err("Native source cache is unavailable.".into());
            }
            metadata["sourceHandle"] = json!(handle);
            metadata["pixelsOmitted"] = json!(true);
            return Ok((
                DecodedAsset {
                    metadata,
                    pixels: Vec::new(),
                    source_handle: Some(handle),
                    pixels_omitted: true,
                },
                Some(arc),
            ));
        }
        let arc = Arc::new(crate::RawSource {
            width: width as u32,
            height: height as u32,
            format: crate::NativeSourceFormat::Rgb16,
            data: pixels.clone(),
        });
        let stored = crate::raw_sources()
            .lock()
            .map(|mut sources| {
                sources.insert_arc(handle.clone(), Arc::clone(&arc));
                true
            })
            .unwrap_or(false);
        if stored {
            metadata["sourceHandle"] = json!(handle);
            return Ok((
                DecodedAsset {
                    metadata,
                    pixels,
                    source_handle: Some(handle),
                    pixels_omitted: false,
                },
                Some(arc),
            ));
        }
    }
    Ok((
        DecodedAsset {
            metadata,
            pixels,
            source_handle: None,
            pixels_omitted: false,
        },
        None,
    ))
}

fn spawn_preview_from_full(
    preview_cache: PreviewCache,
    source: Arc<crate::RawSource>,
    base_metadata: Value,
) {
    if preview_cache.exists() {
        return;
    }
    let _ = std::thread::Builder::new().spawn(move || {
        let src_w = source.width as usize;
        let src_h = source.height as usize;
        if src_w == 0 || src_h == 0 {
            return;
        }
        let scale = (2560.0_f64 / src_w.max(src_h) as f64).min(1.0);
        let dst_w = (src_w as f64 * scale).round().max(1.0) as usize;
        let dst_h = (src_h as f64 * scale).round().max(1.0) as usize;
        let never_cancel = AtomicBool::new(false);
        let pixels = if dst_w == src_w && dst_h == src_h {
            source.data.clone()
        } else {
            let Ok(resized) = super::libraw_decode::resize_rgb16_parallel(
                &source.data,
                src_w,
                src_h,
                dst_w,
                dst_h,
                &never_cancel,
            ) else {
                return;
            };
            resized
        };
        let mut metadata = base_metadata;
        metadata["width"] = json!(dst_w);
        metadata["height"] = json!(dst_h);
        metadata["byteCount"] = json!(pixels.len());
        metadata["fullWidth"] = json!(src_w);
        metadata["fullHeight"] = json!(src_h);
        if let Some(obj) = metadata.as_object_mut() {
            obj.remove("sourceHandle");
            obj.remove("pixelsOmitted");
        }
        let preview_asset = DecodedAsset {
            metadata,
            pixels,
            source_handle: None,
            pixels_omitted: false,
        };
        if let Ok(bytes) = preview_asset.to_binary() {
            preview_cache.store(&bytes, None);
        }
    });
}

fn decode(
    args: &[Value],
    ctx: &NativeContext,
    cancelled: Option<&AtomicBool>,
    allow_handle_only: bool,
) -> Result<DecodedAsset, String> {
    if is_cancelled(cancelled) {
        return Err("Nikon decode was cancelled.".into());
    }
    let request = args.get(1).ok_or("Invalid Nikon decode request.")?;
    let mode = request.get("mode").and_then(Value::as_str).unwrap_or("");
    let max_edge = request.get("maxEdge").and_then(Value::as_u64).unwrap_or(0);
    let priority = request
        .get("priority")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let handle_only =
        allow_handle_only && request.get("handleOnly").and_then(Value::as_bool).unwrap_or(false);
    if !matches!(mode, "preview" | "full") || max_edge == 0 {
        return Ok(failure("INVALID_ARGUMENT", "Invalid Nikon decode request."));
    }
    let approved = args.last().ok_or("Approved asset location is missing.")?;
    let path = match resolve_asset(approved) {
        Ok(path) => path,
        Err(_) => return Ok(failure("INPUT_IO", "NEF file is unavailable.")),
    };
    if !path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("nef"))
    {
        return Ok(failure(
            "UNSUPPORTED_FILE",
            "Nikon fallback accepts only NEF files.",
        ));
    }
    let Some((helper, state)) = helper(ctx) else {
        return Ok(failure(
            "SDK_UNAVAILABLE",
            "Nikon decoder is unavailable on this platform.",
        ));
    };
    if !helper.is_file() {
        return Ok(failure(
            "SDK_UNAVAILABLE",
            "Nikon decoder is not installed.",
        ));
    }
    let started = Instant::now();
    let digest = checksum(&helper)?;
    // Local development helpers retain test-only provenance, as in Electron.
    if !development_helper_allowed(state) && !runtime_approved(ctx, state, &digest) {
        return Ok(failure(
            "SDK_UNAVAILABLE",
            if state == "development" {
                "Nikon decoder checksum does not match DARKROOM_NEF_APPROVED_CHECKSUM."
            } else {
                "Nikon decoder is not release-qualified."
            },
        ));
    }
    let (mut source, source_metadata) = open_regular(&path).map_err(|_| "NEF file is unavailable.")?;
    if source_metadata.len() > 2 * 1024 * 1024 * 1024 {
        return Ok(failure(
            "LIMIT_EXCEEDED",
            "NEF input exceeds the supported size.",
        ));
    }
    let cache_revision = format!(
        "nikon-native-rgb16le-v1:{digest}:{state}:{}",
        super::libraw_decode::DECODER_REVISION,
    );
    let cache = PreviewCache::if_enabled(
        mode == "preview",
        ctx.app_cache.as_deref(),
        &path,
        &source_metadata,
        &cache_revision,
        max_edge,
    );
    if let Some(decoded) = cache
        .as_ref()
        .and_then(|cache| cache.load(cancelled))
        .and_then(DecodedAsset::from_binary)
    {
        if is_cancelled(cancelled) {
            return Err("Nikon decode was cancelled.".into());
        }
        if check_open_regular(&path, &source, &source_metadata).is_err() {
            return Ok(failure("INPUT_IO", "NEF source changed during decoding."));
        }
        crate::timing(format_args!(
            "nikon preview cache-hit: {} ms",
            started.elapsed().as_millis()
        ));
        return Ok(decoded);
    }
    let full_cache = (mode == "full")
        .then(|| FullDecodeCache::new(ctx.app_cache.as_deref(), &path, &source_metadata, &cache_revision))
        .flatten();
    if let Some((cached_meta, cached_pixels)) =
        full_cache.as_ref().and_then(|cache| cache.load(cancelled))
    {
        if is_cancelled(cancelled) {
            return Err("Nikon decode was cancelled.".into());
        }
        if check_open_regular(&path, &source, &source_metadata).is_err() {
            return Ok(failure("INPUT_IO", "NEF source changed during decoding."));
        }
        let width = cached_meta["width"].as_u64().unwrap_or(0);
        let height = cached_meta["height"].as_u64().unwrap_or(0);
        if width > 0 && height > 0 && width * height * 6 == cached_pixels.len() as u64 {
            crate::timing(format_args!(
                "nikon full cache-hit {width}x{height}: {} ms",
                started.elapsed().as_millis()
            ));
            let (decoded, _) =
                package_full_decoded(cached_meta, cached_pixels, width, height, handle_only)?;
            return Ok(decoded);
        }
    }
    if is_cancelled(cancelled) {
        return Err("Nikon decode was cancelled.".into());
    }
    let gate_started = Instant::now();
    let gate_permit = nikon_helper_gate().acquire(priority, cancelled)?;
    let gate_waited_ms = gate_started.elapsed().as_millis();
    // Re-check disk caches in case an earlier in-flight decode just populated them.
    if let Some(decoded) = cache
        .as_ref()
        .and_then(|cache| cache.load(cancelled))
        .and_then(DecodedAsset::from_binary)
    {
        if is_cancelled(cancelled) {
            return Err("Nikon decode was cancelled.".into());
        }
        if check_open_regular(&path, &source, &source_metadata).is_err() {
            return Ok(failure("INPUT_IO", "NEF source changed during decoding."));
        }
        return Ok(decoded);
    }
    if let Some((cached_meta, cached_pixels)) =
        full_cache.as_ref().and_then(|cache| cache.load(cancelled))
    {
        if is_cancelled(cancelled) {
            return Err("Nikon decode was cancelled.".into());
        }
        if check_open_regular(&path, &source, &source_metadata).is_err() {
            return Ok(failure("INPUT_IO", "NEF source changed during decoding."));
        }
        let width = cached_meta["width"].as_u64().unwrap_or(0);
        let height = cached_meta["height"].as_u64().unwrap_or(0);
        if width > 0 && height > 0 && width * height * 6 == cached_pixels.len() as u64 {
            let (decoded, _) =
                package_full_decoded(cached_meta, cached_pixels, width, height, handle_only)?;
            return Ok(decoded);
        }
    }
    let work = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = work.path().join("input.nef");
    let output = work.path().join("output");
    fs::create_dir(&output).map_err(|e| e.to_string())?;
    if try_clone_snapshot(&source, work.path()) {
        if check_open_regular(&path, &source, &source_metadata).is_err() {
            return Ok(failure("INPUT_IO", "NEF source changed during decoding."));
        }
    } else {
        let mut target = File::create(&input).map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut source, &mut target).map_err(|e| e.to_string())?;
        if copied != source_metadata.len()
            || check_open_regular(&path, &source, &source_metadata).is_err()
        {
            return Ok(failure("INPUT_IO", "NEF source changed during decoding."));
        }
        // Flush userspace buffers and close the throwaway snapshot before spawning
        // the helper; skipping fsync avoids APFS F_FULLFSYNC stalls on temp files.
        target.flush().map_err(|e| e.to_string())?;
        drop(target);
    }
    let copied_at = Instant::now();
    let stderr = work.path().join("stderr");
    let helper_max_edge = helper_max_edge(mode, max_edge);
    let mut command = Command::new(&helper);
    command
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--mode")
        .arg(mode)
        .arg("--max-edge")
        .arg(helper_max_edge.to_string())
        .arg("--pixel-format")
        .arg("rgb16le")
        .current_dir(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(
            File::create(&stderr).map_err(|e| e.to_string())?,
        ));
    let status = run_with_timeout(
        command,
        Duration::from_secs(60),
        cancelled,
        Some(&gate_permit.preempted),
    );
    drop(gate_permit);
    let decoded_at = Instant::now();
    match status {
        Ok(status) if status.success() => (),
        Ok(_) => {
            let text = fs::read_to_string(stderr).unwrap_or_default();
            if let Ok(error) = serde_json::from_str::<Value>(&text) {
                if error["version"] == 1 {
                    if let Some(code) = error["code"].as_str().filter(|code| {
                        matches!(
                            *code,
                            "INVALID_ARGUMENT"
                                | "UNSUPPORTED_FILE"
                                | "INPUT_IO"
                                | "DECODE_FAILED"
                                | "OUTPUT_IO"
                                | "LIMIT_EXCEEDED"
                                | "SDK_UNAVAILABLE"
                                | "INTERNAL"
                        )
                    }) {
                        return Ok(failure(code, &format!("Nikon decoder reported {code}.")));
                    }
                }
            }
            return Ok(failure("HELPER_CRASH", "Nikon decoder failed."));
        }
        Err(message) if message.contains("cancelled") => {
            return Err(message);
        }
        Err(message) if message.contains("timed out") => {
            return Ok(failure("TIMEOUT", "Nikon decoder timed out."));
        }
        Err(_) => return Ok(failure("HELPER_CRASH", "Nikon decoder could not start.")),
    }
    let entries: Vec<_> = fs::read_dir(&output)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect();
    if entries.len() != 2 {
        return Ok(failure(
            "INVALID_OUTPUT",
            "Nikon decoder produced unexpected files.",
        ));
    }
    let raw = fs::read(output.join("result.json")).map_err(|e| e.to_string())?;
    if raw.is_empty() || raw.len() > 64 * 1024 {
        return Ok(failure(
            "INVALID_OUTPUT",
            "Nikon decoder metadata has an invalid size.",
        ));
    }
    let result: Value =
        serde_json::from_slice(&raw).map_err(|_| "Nikon decoder metadata is invalid.")?;
    let width = result["width"].as_u64().unwrap_or(0);
    let height = result["height"].as_u64().unwrap_or(0);
    let orientation = result["orientation"].as_u64().unwrap_or(0);
    let byte_count = width.saturating_mul(height).saturating_mul(6);
    if result["version"] != 1
        || result["channels"] != 3
        || result["bitDepth"] != 16
        || result["pixelFormat"] != "rgb16le"
        || result["colorSpace"] != "srgb"
        || result["transferFunction"] != "srgb"
        || width == 0
        || width > 65535
        || height == 0
        || height > 65535
        || !(1..=8).contains(&orientation)
        || byte_count > 512 * 1024 * 1024
        || result["byteCount"] != byte_count
        || (mode == "preview" && width.max(height) > max_edge.min(2560))
    {
        return Ok(failure(
            "INVALID_OUTPUT",
            "Nikon decoder metadata violates protocol version 1.",
        ));
    }
    let pixels = match read_exact_file(&output.join("pixels.bin"), byte_count as usize, cancelled) {
        Ok(pixels) => pixels,
        Err(message) if message.contains("cancelled") => return Err(message),
        Err(_) => {
            return Ok(failure(
                "INVALID_OUTPUT",
                "Nikon decoder pixel byte count is invalid.",
            ));
        }
    };
    if checksum(&helper)? != digest {
        return Ok(failure(
            "SDK_UNAVAILABLE",
            "Nikon decoder changed during decoding.",
        ));
    }
    crate::timing(format_args!(
        "nikon {mode} {width}x{height}: gate {gate_waited_ms} ms, checksum+copy {} ms, helper {} ms, read {} ms",
        (copied_at - started).as_millis(),
        (decoded_at - copied_at).as_millis(),
        decoded_at.elapsed().as_millis()
    ));
    let mut metadata = json!({"available":true,"provenance":if state=="packaged"{"nikon-sdk"}else{"nikon-test-only"},"version":1,"width":width,"height":height,"channels":3,"bitDepth":16,"byteCount":byte_count,"pixelFormat":"rgb16le","orientation":orientation,"colorSpace":"srgb","transferFunction":"srgb"});
    // Lets the viewer zoom a preview before the slower full-resolution decode finishes.
    if mode == "preview"
        && let Some((full_width, full_height)) = super::raw_dimensions(&input)
    {
        metadata["fullWidth"] = json!(full_width);
        metadata["fullHeight"] = json!(full_height);
    }
    // Remove temporary 55–272 MB files off the critical response path.
    let _ = std::thread::Builder::new().spawn(move || drop(work));
    if is_cancelled(cancelled) {
        return Err("Nikon decode was cancelled.".into());
    }
    if check_open_regular(&path, &source, &source_metadata).is_err() {
        return Ok(failure("INPUT_IO", "NEF source changed during decoding."));
    }
    if mode == "full" {
        let cache_meta = metadata.clone();
        let (decoded, arc_source) =
            package_full_decoded(metadata, pixels, width, height, handle_only)?;
        if let Some(arc) = arc_source {
            if let Some(full_cache) = full_cache {
                full_cache.store_arc(cache_meta.clone(), Arc::clone(&arc), cancelled);
            }
            if let Some(preview_cache) = PreviewCache::new(
                ctx.app_cache.as_deref(),
                &path,
                &source_metadata,
                &cache_revision,
                2560,
            ) {
                spawn_preview_from_full(preview_cache, arc, cache_meta);
            }
        }
        return Ok(decoded);
    }
    let decoded = DecodedAsset {
        metadata,
        pixels,
        source_handle: None,
        pixels_omitted: false,
    };
    if let Some(cache) = cache
        && let Ok(bytes) = decoded.to_binary()
    {
        cache.store(&bytes, cancelled);
    }
    Ok(decoded)
}

pub fn decode_asset_binary(
    args: &[Value],
    ctx: &NativeContext,
    cancelled: Option<&AtomicBool>,
) -> Result<(Vec<u8>, Option<String>), String> {
    let decoded = decode(args, ctx, cancelled, true)?;
    let handle = decoded.source_handle.clone();
    let bytes = decoded.to_binary()?;
    Ok((bytes, handle))
}

pub fn handle(command: &str, args: &[Value], ctx: &NativeContext) -> Result<Value, String> {
    match command {
        "darkroom:get-format-capability-report" => report(ctx),
        "darkroom:catalog-decode-asset" => {
            decode(args, ctx, None, false).map(DecodedAsset::into_json)
        }
        _ => Err(format!("Unknown Nikon command: {command}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_mode_never_caps_at_preview_edge() {
        assert_eq!(helper_max_edge("full", 2560), 65_535);
        assert_eq!(helper_max_edge("full", 99_999), 65_535);
        assert_eq!(helper_max_edge("preview", 99_999), 2560);
        assert_eq!(helper_max_edge("preview", 720), 720);
    }

    #[test]
    fn handle_only_omits_pixels_and_stores_raw_source() {
        let _guard = crate::RAW_SOURCES_TEST_LOCK.lock().unwrap();
        let width = 8_u64;
        let height = 6_u64;
        let byte_count = width * height * 6;
        let pixels = vec![42_u8; byte_count as usize];
        let metadata = json!({
            "available": true,
            "provenance": "nikon-sdk",
            "version": 1,
            "width": width,
            "height": height,
            "channels": 3,
            "bitDepth": 16,
            "byteCount": byte_count,
            "pixelFormat": "rgb16le",
            "orientation": 1,
            "colorSpace": "srgb",
            "transferFunction": "srgb",
        });
        let (decoded, _) =
            package_full_decoded(metadata, pixels.clone(), width, height, true).unwrap();
        let handle = decoded
            .source_handle
            .clone()
            .expect("expected native source handle");
        assert!(decoded.pixels_omitted);
        let binary = decoded.to_binary().unwrap();
        let header_len = u32::from_le_bytes(binary[..4].try_into().unwrap()) as usize;
        assert_eq!(binary.len(), 4 + header_len);
        let header: Value = serde_json::from_slice(&binary[4..4 + header_len]).unwrap();
        assert_eq!(header["pixelsOmitted"], true);
        assert_eq!(header["sourceHandle"], handle);
        let cached = crate::raw_sources()
            .lock()
            .unwrap()
            .get(&handle)
            .expect("source should be cached");
        assert_eq!(cached.width, width as u32);
        assert_eq!(cached.height, height as u32);
        assert_eq!(cached.format, crate::NativeSourceFormat::Rgb16);
        assert_eq!(cached.data, pixels);
    }

    #[test]
    fn nikon_helper_gate_preempts_background_for_foreground() {
        static TEST_GATE: OnceLock<NikonHelperGate> = OnceLock::new();
        let gate = TEST_GATE.get_or_init(NikonHelperGate::new);
        let bg_permit = gate.acquire(-20, None).unwrap();
        let bg_preempted = Arc::clone(&bg_permit.preempted);
        let bg_thread = std::thread::spawn(move || {
            let start = Instant::now();
            while !bg_permit.preempted.load(Ordering::Relaxed)
                && start.elapsed() < Duration::from_secs(2)
            {
                std::thread::sleep(Duration::from_millis(2));
            }
            drop(bg_permit);
        });
        let started = Instant::now();
        let fg_permit = gate.acquire(200, None).unwrap();
        drop(fg_permit);
        bg_thread.join().unwrap();
        assert!(bg_preempted.load(Ordering::Relaxed));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_kills_process_on_cancel() {
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let trigger = cancelled.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            trigger.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let err = run_with_timeout(cmd, Duration::from_secs(10), Some(&cancelled), None)
            .expect_err("expected cancelled error");
        handle.join().unwrap();
        assert!(err.contains("cancelled"), "unexpected error: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancellation took too long: {:?}",
            started.elapsed()
        );
    }
}
