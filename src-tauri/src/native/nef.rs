use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    NativeContext,
    assets::{check_open_regular, open_regular, resolve_asset},
    binary_value,
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

fn run_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
    let mut child = command
        .spawn()
        .map_err(|_| "Nikon decoder could not start.")?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Nikon decoder timed out.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
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
                    let status = run_with_timeout(command, Duration::from_secs(5))?;
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

fn failure(code: &str, message: &str) -> Value {
    json!({"available":false,"code":code,"message":message})
}

fn decode(args: &[Value], ctx: &NativeContext) -> Result<Value, String> {
    let request = args.get(1).ok_or("Invalid Nikon decode request.")?;
    let mode = request.get("mode").and_then(Value::as_str).unwrap_or("");
    let max_edge = request.get("maxEdge").and_then(Value::as_u64).unwrap_or(0);
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
    let work = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = work.path().join("input.nef");
    let output = work.path().join("output");
    fs::create_dir(&output).map_err(|e| e.to_string())?;
    let (mut source, metadata) = open_regular(&path).map_err(|_| "NEF file is unavailable.")?;
    if metadata.len() > 2 * 1024 * 1024 * 1024 {
        return Ok(failure(
            "LIMIT_EXCEEDED",
            "NEF input exceeds the supported size.",
        ));
    }
    let mut target = File::create(&input).map_err(|e| e.to_string())?;
    let copied = std::io::copy(&mut source, &mut target).map_err(|e| e.to_string())?;
    if copied != metadata.len() || check_open_regular(&path, &source, &metadata).is_err() {
        return Ok(failure("INPUT_IO", "NEF source changed during decoding."));
    }
    target.sync_all().map_err(|e| e.to_string())?;
    let stderr = work.path().join("stderr");
    let mut command = Command::new(&helper);
    command
        .arg("--input")
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--mode")
        .arg(mode)
        .arg("--max-edge")
        .arg(max_edge.min(2560).to_string())
        .arg("--pixel-format")
        .arg("rgb16le")
        .current_dir(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(
            File::create(&stderr).map_err(|e| e.to_string())?,
        ));
    match run_with_timeout(command, Duration::from_secs(60)) {
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
    let pixels = fs::read(output.join("pixels.bin")).map_err(|e| e.to_string())?;
    if pixels.len() as u64 != byte_count {
        return Ok(failure(
            "INVALID_OUTPUT",
            "Nikon decoder pixel byte count is invalid.",
        ));
    }
    if checksum(&helper)? != digest {
        return Ok(failure(
            "SDK_UNAVAILABLE",
            "Nikon decoder changed during decoding.",
        ));
    }
    Ok(
        json!({"available":true,"provenance":if state=="packaged"{"nikon-sdk"}else{"nikon-test-only"},"version":1,"width":width,"height":height,"channels":3,"bitDepth":16,"byteCount":byte_count,"pixelFormat":"rgb16le","orientation":orientation,"colorSpace":"srgb","transferFunction":"srgb","pixels":binary_value(&pixels)}),
    )
}

pub fn handle(command: &str, args: &[Value], ctx: &NativeContext) -> Result<Value, String> {
    match command {
        "darkroom:get-format-capability-report" => report(ctx),
        "darkroom:catalog-decode-asset" => decode(args, ctx),
        _ => Err(format!("Unknown Nikon command: {command}")),
    }
}
