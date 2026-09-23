use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Component, Path, PathBuf}};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{binary_value, NativeContext};

const MAX_SIDECAR_BYTES: u64 = 16 * 1024 * 1024;

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() || root.components().any(|part| matches!(part, Component::CurDir | Component::ParentDir)) {
        return Err("Asset root is not canonical.".into());
    }
    let actual = fs::canonicalize(root).map_err(|_| "Asset root is unavailable.")?;
    if actual != root || !fs::symlink_metadata(root).map_err(|_| "Asset root is unavailable.")?.file_type().is_dir() {
        return Err("Asset root is unavailable.".into());
    }
    Ok(actual)
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\0') || value.contains('\\') { return Err("Asset path is invalid.".into()); }
    let relative = Path::new(value);
    if relative.components().any(|component| !matches!(component, Component::Normal(_))) { return Err("Asset path is invalid.".into()); }
    Ok(relative.to_path_buf())
}

fn validated_path(root: &Path, relative: &Path, must_exist: bool) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    let mut current = root.clone();
    let components: Vec<_> = relative.components().collect();
    if components.is_empty() { return Err("Asset path is invalid.".into()); }
    for (index, component) in components.iter().enumerate() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() { return Err("Symlinked asset paths are not allowed.".into()); }
                if index + 1 != components.len() && !metadata.is_dir() { return Err("Asset path is unavailable.".into()); }
            }
            Err(error) if !must_exist && index + 1 == components.len() && error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("Asset path is unavailable.".into()),
        }
    }
    if !current.starts_with(&root) || current == root { return Err("Asset path is outside its root.".into()); }
    Ok(current)
}

fn location(value: &Value) -> Result<(PathBuf, PathBuf), String> {
    let root = value.get("canonicalRootPath").and_then(Value::as_str).ok_or("Asset location is invalid.")?;
    let relative = value.get("relativePath").and_then(Value::as_str).ok_or("Asset location is invalid.")?;
    Ok((PathBuf::from(root), relative_path(relative)?))
}

pub fn resolve_asset(value: &Value) -> Result<PathBuf, String> {
    let (root, relative) = location(value)?;
    let path = validated_path(&root, &relative, true)?;
    if !fs::symlink_metadata(&path).map_err(|_| "Asset is unavailable.")?.is_file() { return Err("Asset is not a regular file.".into()); }
    Ok(path)
}

pub fn read_asset_bytes(value: &Value, head: Option<usize>) -> Result<Vec<u8>, String> {
    let path = resolve_asset(value)?;
    let mut file = File::open(path).map_err(|_| "Asset is unavailable.")?;
    let mut buffer = Vec::new();
    match head {
        Some(max) => { file.take(max as u64).read_to_end(&mut buffer).map_err(|_| "Asset is unavailable.")?; }
        None => { file.read_to_end(&mut buffer).map_err(|_| "Asset is unavailable.")?; }
    }
    Ok(buffer)
}

fn read_asset(value: &Value, head: Option<usize>) -> Result<Value, String> {
    Ok(binary_value(&read_asset_bytes(value, head)?))
}

fn sidecar_path(value: &Value) -> Result<PathBuf, String> {
    let (root, relative) = location(value)?;
    resolve_asset(value)?;
    let ext_is_nef = relative.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("nef"));
    let name = if ext_is_nef { relative.file_stem() } else { relative.file_name() }.ok_or("Asset path is invalid.")?;
    let sidecar = relative.parent().unwrap_or(Path::new("")).join(format!("{}.xmp", name.to_string_lossy()));
    validated_path(&root, &sidecar, false)
}

fn modified_ms(metadata: &fs::Metadata) -> Result<f64, String> {
    Ok(metadata.modified().map_err(|e| e.to_string())?.duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos() as f64 / 1_000_000.0)
}

fn sidecar_version(path: &Path, expected: Option<Option<f64>>) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() { return Err("Sidecar is not a regular file.".into()); }
            if let Some(expected) = expected {
                if expected != Some(modified_ms(&metadata)?) { return Err("Sidecar changed after it was read. Reload before saving keywords.".into()); }
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if expected.is_some_and(|v| v.is_some()) { return Err("Sidecar changed after it was read. Reload before saving keywords.".into()); }
            Ok(None)
        }
        Err(_) => Err("Sidecar is unavailable.".into()),
    }
}

fn backup_sidecar(path: &Path, backup_root: &Path) -> Result<(), String> {
    let Some(metadata) = sidecar_version(path, None)? else { return Ok(()); };
    if metadata.len() > MAX_SIDECAR_BYTES { return Err("Sidecar is too large.".into()); }
    let contents = fs::read(path).map_err(|_| "Could not create the sidecar recovery backup.")?;
    let digest = format!("{:x}", Sha256::digest(&contents));
    let directory = backup_root.join("objects").join(&digest[..2]);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let object_path = directory.join(format!("{digest}.xmp"));
    if !object_path.exists() { fs::write(&object_path, contents).map_err(|e| e.to_string())?; }
    let receipts = backup_root.join("receipts");
    fs::create_dir_all(&receipts).map_err(|e| e.to_string())?;
    let receipt = json!({"version":1,"operation":"replace","sha256":digest,"byteLength":metadata.len(),"createdAt":modified_ms(&metadata)?});
    fs::write(receipts.join(format!("{}.json", uuid::Uuid::new_v4())), receipt.to_string()).map_err(|e| e.to_string())
}

fn write_sidecar(value: &Value, contents: &Value, expected: Option<&Value>, ctx: &NativeContext) -> Result<Value, String> {
    let path = sidecar_path(value)?;
    let expected = expected.map(|v| if v.is_null() { Ok(None) } else { v.as_f64().map(Some).ok_or("Sidecar version is invalid.") }).transpose()?;
    sidecar_version(&path, expected)?;
    let bytes = contents.as_str().map(str::as_bytes);
    if bytes.is_none() && !contents.is_null() { return Err("Sidecar contents are invalid.".into()); }
    if bytes.is_some_and(|bytes| bytes.len() as u64 > MAX_SIDECAR_BYTES) { return Err("Sidecar is too large.".into()); }
    backup_sidecar(&path, &ctx.app_data.join("xmp-backups"))?;
    match bytes {
        Some(bytes) => {
            let temp = path.with_extension(format!("xmp.{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| -> Result<(), String> {
                let mut file = OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|e| e.to_string())?;
                file.write_all(bytes).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                sidecar_version(&path, expected)?;
                fs::rename(&temp, &path).map_err(|e| e.to_string())
            })();
            if result.is_err() { let _ = fs::remove_file(temp); }
            result?;
        }
        None => { if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; } }
    }
    Ok(Value::Null)
}

pub fn handle(command: &str, args: &[Value], ctx: &NativeContext) -> Result<Value, String> {
    // The host supplies the approved catalog location as the last argument. Never trust a renderer-supplied root.
    let approved = args.last().ok_or("Approved asset location is missing.")?;
    match command {
        "darkroom:catalog-read-asset" => read_asset(approved, None),
        "darkroom:catalog-read-asset-head" => {
            let max = args.first().and_then(|v| v.get("maxBytes")).and_then(Value::as_u64).ok_or("Asset head size is invalid.")?;
            read_asset(approved, Some(usize::try_from(max).map_err(|_| "Asset head size is invalid.")?))
        }
        "darkroom:catalog-stat-asset" => {
            let metadata = fs::metadata(resolve_asset(approved)?).map_err(|e| e.to_string())?;
            Ok(json!({"size":metadata.len(),"lastModified":modified_ms(&metadata)?}))
        }
        "darkroom:catalog-read-sidecar" => {
            let path = sidecar_path(approved)?;
            let Some(metadata) = sidecar_version(&path, None)? else { return Ok(Value::Null); };
            if metadata.len() > MAX_SIDECAR_BYTES { return Err("Sidecar is too large.".into()); }
            Ok(json!({"contents":fs::read_to_string(path).map_err(|e| e.to_string())?,"lastModified":modified_ms(&metadata)?}))
        }
        "darkroom:catalog-write-sidecar" => {
            let request = args.first().ok_or("Sidecar request is missing.")?;
            write_sidecar(approved, &request["contents"], request.get("expectedLastModified"), ctx)
        }
        _ => Err(format!("Unknown asset command: {command}")),
    }
}
