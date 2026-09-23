use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{NativeContext, binary_value};

const MAX_SIDECAR_BYTES: u64 = 16 * 1024 * 1024;

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.is_file()
        && right.is_file()
        && left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
}
#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.is_file()
        && right.is_file()
        && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
}

pub(super) fn open_regular(path: &Path) -> Result<(File, fs::Metadata), String> {
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err("Asset is not a regular file.".into());
    }
    #[cfg(windows)]
    let before_identity =
        super::windows_path_identity(path).ok_or("Asset changed before it was opened.")?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if !same_file(&before, &opened) {
        return Err("Asset changed before it was opened.".into());
    }
    #[cfg(windows)]
    {
        let opened_identity =
            super::windows_handle_identity(&file).ok_or("Asset changed before it was opened.")?;
        if before_identity != opened_identity
            || super::windows_path_identity(path) != Some(opened_identity)
        {
            return Err("Asset changed before it was opened.".into());
        }
    }
    Ok((file, opened))
}
pub(super) fn check_open_regular(
    path: &Path,
    file: &File,
    opened: &fs::Metadata,
) -> Result<(), String> {
    let after = file.metadata().map_err(|e| e.to_string())?;
    let current = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !same_file(opened, &after) || !same_file(&after, &current) {
        return Err("Asset changed while it was read.".into());
    }
    #[cfg(windows)]
    {
        let opened_identity =
            super::windows_handle_identity(file).ok_or("Asset changed while it was read.")?;
        if super::windows_path_identity(path) != Some(opened_identity) {
            return Err("Asset changed while it was read.".into());
        }
    }
    Ok(())
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err("Asset root is not canonical.".into());
    }
    let actual = fs::canonicalize(root).map_err(|_| "Asset root is unavailable.")?;
    if actual != root
        || !fs::symlink_metadata(root)
            .map_err(|_| "Asset root is unavailable.")?
            .file_type()
            .is_dir()
    {
        return Err("Asset root is unavailable.".into());
    }
    Ok(actual)
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\0') || value.contains('\\') {
        return Err("Asset path is invalid.".into());
    }
    let relative = Path::new(value);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Asset path is invalid.".into());
    }
    Ok(relative.to_path_buf())
}

fn validated_path(root: &Path, relative: &Path, must_exist: bool) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    let mut current = root.clone();
    let components: Vec<_> = relative.components().collect();
    if components.is_empty() {
        return Err("Asset path is invalid.".into());
    }
    for (index, component) in components.iter().enumerate() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("Symlinked asset paths are not allowed.".into());
                }
                if index + 1 != components.len() && !metadata.is_dir() {
                    return Err("Asset path is unavailable.".into());
                }
            }
            Err(error)
                if !must_exist
                    && index + 1 == components.len()
                    && error.kind() == std::io::ErrorKind::NotFound =>
            {
                ()
            }
            Err(_) => return Err("Asset path is unavailable.".into()),
        }
    }
    if !current.starts_with(&root) || current == root {
        return Err("Asset path is outside its root.".into());
    }
    Ok(current)
}

fn location(value: &Value) -> Result<(PathBuf, PathBuf), String> {
    let root = value
        .get("canonicalRootPath")
        .and_then(Value::as_str)
        .ok_or("Asset location is invalid.")?;
    let relative = value
        .get("relativePath")
        .and_then(Value::as_str)
        .ok_or("Asset location is invalid.")?;
    Ok((PathBuf::from(root), relative_path(relative)?))
}

pub fn resolve_asset(value: &Value) -> Result<PathBuf, String> {
    let (root, relative) = location(value)?;
    let path = validated_path(&root, &relative, true)?;
    if !fs::symlink_metadata(&path)
        .map_err(|_| "Asset is unavailable.")?
        .is_file()
    {
        return Err("Asset is not a regular file.".into());
    }
    Ok(path)
}

pub fn read_asset_bytes(value: &Value, head: Option<usize>) -> Result<Vec<u8>, String> {
    let path = resolve_asset(value)?;
    let (mut file, opened) = open_regular(&path)?;
    let mut buffer = Vec::new();
    match head {
        Some(max) if max > 0 && max <= 16 * 1024 * 1024 => {
            (&mut file)
                .take(max as u64)
                .read_to_end(&mut buffer)
                .map_err(|_| "Asset is unavailable.")?;
        }
        Some(_) => return Err("Asset head size is invalid.".into()),
        None => {
            file.read_to_end(&mut buffer)
                .map_err(|_| "Asset is unavailable.")?;
        }
    }
    check_open_regular(&path, &file, &opened)?;
    Ok(buffer)
}

fn read_asset(value: &Value, head: Option<usize>) -> Result<Value, String> {
    Ok(binary_value(&read_asset_bytes(value, head)?))
}

fn sidecar_path(value: &Value) -> Result<PathBuf, String> {
    let (root, relative) = location(value)?;
    resolve_asset(value)?;
    let ext_is_nef = relative
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("nef"));
    let name = if ext_is_nef {
        relative.file_stem()
    } else {
        relative.file_name()
    }
    .ok_or("Asset path is invalid.")?;
    let sidecar = relative
        .parent()
        .unwrap_or(Path::new(""))
        .join(format!("{}.xmp", name.to_string_lossy()));
    validated_path(&root, &sidecar, false)
}

fn modified_ms(metadata: &fs::Metadata) -> Result<f64, String> {
    Ok(metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos() as f64
        / 1_000_000.0)
}

fn sidecar_version(
    path: &Path,
    expected: Option<Option<f64>>,
) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("Sidecar is not a regular file.".into());
            }
            if let Some(expected) = expected {
                if expected != Some(modified_ms(&metadata)?) {
                    return Err(
                        "Sidecar changed after it was read. Reload before saving keywords.".into(),
                    );
                }
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if expected.is_some_and(|v| v.is_some()) {
                return Err(
                    "Sidecar changed after it was read. Reload before saving keywords.".into(),
                );
            }
            Ok(None)
        }
        Err(_) => Err("Sidecar is unavailable.".into()),
    }
}

fn backup_sidecar(path: &Path, backup_root: &Path, operation: &str) -> Result<(), String> {
    let Some(metadata) = sidecar_version(path, None)? else {
        return Ok(());
    };
    if metadata.len() > MAX_SIDECAR_BYTES {
        return Err("Sidecar is too large.".into());
    }
    let (mut file, opened) =
        open_regular(path).map_err(|_| "Could not create the sidecar recovery backup.")?;
    if !same_file(&metadata, &opened) {
        return Err("Sidecar changed before it could be backed up.".into());
    }
    let mut contents = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut contents)
        .map_err(|_| "Could not create the sidecar recovery backup.")?;
    check_open_regular(path, &file, &opened)?;
    if contents.len() as u64 != metadata.len() {
        return Err("Sidecar changed while it was backed up.".into());
    }
    let digest = format!("{:x}", Sha256::digest(&contents));
    let directory = backup_root.join("objects").join(&digest[..2]);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let object_path = directory.join(format!("{digest}.xmp"));
    let receipts = backup_root.join("receipts");
    fs::create_dir_all(&receipts).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for folder in [
            backup_root,
            &backup_root.join("objects"),
            &directory,
            &receipts,
        ] {
            fs::set_permissions(folder, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    let mut object = OpenOptions::new();
    object.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        object.mode(0o600);
    }
    match object.open(&object_path) {
        Ok(mut file) => {
            if let Err(error) = file.write_all(&contents).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = fs::remove_file(&object_path);
                return Err(error.to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let (mut file, opened) = open_regular(&object_path)?;
            let mut existing = Vec::new();
            file.read_to_end(&mut existing).map_err(|e| e.to_string())?;
            check_open_regular(&object_path, &file, &opened)?;
            if existing != contents {
                return Err("Sidecar recovery object has conflicting contents.".into());
            }
        }
        Err(error) => return Err(error.to_string()),
    }
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let receipt = json!({"version":1,"operation":operation,"sha256":digest,"byteLength":metadata.len(),"createdAt":created});
    let receipt_path = receipts.join(format!("{created}-{}.json", uuid::Uuid::new_v4()));
    let mut output = OpenOptions::new();
    output.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        output.mode(0o600);
    }
    let mut output = output.open(&receipt_path).map_err(|e| e.to_string())?;
    if let Err(error) = output
        .write_all(receipt.to_string().as_bytes())
        .and_then(|_| output.sync_all())
    {
        drop(output);
        let _ = fs::remove_file(&receipt_path);
        return Err(error.to_string());
    }
    Ok(())
}

fn write_sidecar(
    value: &Value,
    contents: &Value,
    expected: Option<&Value>,
    ctx: &NativeContext,
) -> Result<Value, String> {
    let path = sidecar_path(value)?;
    let expected = expected
        .map(|v| {
            if v.is_null() {
                Ok(None)
            } else {
                v.as_f64().map(Some).ok_or("Sidecar version is invalid.")
            }
        })
        .transpose()?;
    sidecar_version(&path, expected)?;
    let bytes = contents.as_str().map(str::as_bytes);
    if bytes.is_none() && !contents.is_null() {
        return Err("Sidecar contents are invalid.".into());
    }
    if bytes.is_some_and(|bytes| bytes.len() as u64 > MAX_SIDECAR_BYTES) {
        return Err("Sidecar is too large.".into());
    }
    backup_sidecar(
        &path,
        &ctx.app_data.join("xmp-backups"),
        if bytes.is_some() { "replace" } else { "delete" },
    )?;
    match bytes {
        Some(bytes) => {
            let temp = path.with_extension(format!("xmp.{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| -> Result<(), String> {
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&temp)
                    .map_err(|e| e.to_string())?;
                file.write_all(bytes).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                sidecar_version(&path, expected)?;
                fs::rename(&temp, &path).map_err(|e| e.to_string())
            })();
            if result.is_err() {
                let _ = fs::remove_file(temp);
            }
            result?;
        }
        None => {
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(Value::Null)
}

pub fn handle(command: &str, args: &[Value], ctx: &NativeContext) -> Result<Value, String> {
    // The host supplies the approved catalog location as the last argument. Never trust a renderer-supplied root.
    let approved = args.last().ok_or("Approved asset location is missing.")?;
    match command {
        "darkroom:catalog-read-asset" => read_asset(approved, None),
        "darkroom:catalog-read-asset-head" => {
            let max = args
                .first()
                .and_then(|v| v.get("maxBytes"))
                .and_then(Value::as_u64)
                .ok_or("Asset head size is invalid.")?;
            read_asset(
                approved,
                Some(usize::try_from(max).map_err(|_| "Asset head size is invalid.")?),
            )
        }
        "darkroom:catalog-stat-asset" => {
            let path = resolve_asset(approved)?;
            let (file, metadata) = open_regular(&path)?;
            check_open_regular(&path, &file, &metadata)?;
            Ok(json!({"size":metadata.len(),"lastModified":modified_ms(&metadata)?}))
        }
        "darkroom:catalog-read-sidecar" => {
            let path = sidecar_path(approved)?;
            let Some(metadata) = sidecar_version(&path, None)? else {
                return Ok(Value::Null);
            };
            if metadata.len() > MAX_SIDECAR_BYTES {
                return Err("Sidecar is too large.".into());
            }
            let (mut file, opened) = open_regular(&path)?;
            if !same_file(&metadata, &opened) {
                return Err("Sidecar changed before it was read.".into());
            }
            let mut contents = String::new();
            (&mut file)
                .take(MAX_SIDECAR_BYTES + 1)
                .read_to_string(&mut contents)
                .map_err(|e| e.to_string())?;
            check_open_regular(&path, &file, &opened)?;
            if contents.len() as u64 != metadata.len() {
                return Err("Sidecar changed while it was read.".into());
            }
            Ok(json!({"contents":contents,"lastModified":modified_ms(&metadata)?}))
        }
        "darkroom:catalog-write-sidecar" => {
            let request = args.first().ok_or("Sidecar request is missing.")?;
            write_sidecar(
                approved,
                &request["contents"],
                request.get("expectedLastModified"),
                ctx,
            )
        }
        _ => Err(format!("Unknown asset command: {command}")),
    }
}
