use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && !s.contains('\0'))
        .ok_or_else(|| format!("{key} is invalid."))
}
pub(crate) fn object_keys(v: &Value, keys: &[&str]) -> Result<(), String> {
    let o = v.as_object().ok_or("Expected an object.")?;
    if o.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("Object contains unsupported fields.".into());
    }
    Ok(())
}
pub(crate) fn directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Storage root must be a regular directory.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len()
            && a.modified().ok() == b.modified().ok()
            && a.created().ok() == b.created().ok()
    }
}
pub(crate) fn read(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() > limit as u64 {
        return Err("File is not a bounded regular file.".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if !same_file(&before, &opened) {
        return Err("File changed before reading.".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    (&file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if bytes.len() > limit
        || bytes.len() != opened.len() as usize
        || after.file_type().is_symlink()
        || !same_file(&opened, &after)
        || !same_file(&opened, &file.metadata().map_err(|e| e.to_string())?)
    {
        return Err("File changed while reading.".into());
    }
    Ok(bytes)
}
pub(crate) fn read_json(path: &Path, limit: usize) -> Result<Value, String> {
    serde_json::from_slice(&read(path, limit)?).map_err(|e| e.to_string())
}
pub(crate) fn atomic_json(path: &Path, value: &Value, limit: usize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Store exceeds its byte limit.".into());
    }
    atomic_write(path, &bytes, false)
}

#[cfg(unix)]
pub(crate) fn atomic_write(path: &Path, bytes: &[u8], exclusive: bool) -> Result<(), String> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
    };
    let parent = path.parent().ok_or("Storage parent is missing.")?;
    directory(parent)?;
    let dir = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent)
        .map_err(|e| e.to_string())?;
    let name = CString::new(path.file_name().ok_or("File name is missing.")?.as_bytes())
        .map_err(|e| e.to_string())?;
    let temp = CString::new(format!(".{}.tmp", uuid::Uuid::new_v4())).unwrap();
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        let rc = unsafe {
            if exclusive {
                libc::linkat(
                    dir.as_raw_fd(),
                    temp.as_ptr(),
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    0,
                )
            } else {
                libc::renameat(
                    dir.as_raw_fd(),
                    temp.as_ptr(),
                    dir.as_raw_fd(),
                    name.as_ptr(),
                )
            }
        };
        if rc != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        dir.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    unsafe { libc::unlinkat(dir.as_raw_fd(), temp.as_ptr(), 0) };
    result
}
#[cfg(not(unix))]
pub(crate) fn atomic_write(path: &Path, bytes: &[u8], exclusive: bool) -> Result<(), String> {
    let parent = path.parent().ok_or("Storage parent is missing.")?;
    directory(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    if exclusive {
        file.persist_noclobber(path).map_err(|e| e.to_string())?;
    } else {
        file.persist(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
