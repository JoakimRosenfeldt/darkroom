use std::{ffi::CString, path::Path, slice};

use libraw_rs_vendor as raw;
use serde_json::Value;

use super::assets::{check_open_regular, open_regular, resolve_asset};

const MAX_JPEG_BYTES: usize = 32 * 1024 * 1024;
const JPEG_IMAGE_FORMAT: u32 = 1;

struct RawHandle(*mut raw::libraw_data_t);

impl Drop for RawHandle {
    fn drop(&mut self) {
        unsafe { raw::libraw_close(self.0) };
    }
}

struct ProcessedImage(*mut raw::libraw_processed_image_t);

impl Drop for ProcessedImage {
    fn drop(&mut self) {
        unsafe { raw::libraw_dcraw_clear_mem(self.0) };
    }
}

fn open_raw(handle: *mut raw::libraw_data_t, path: &Path) -> Result<i32, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let path = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        Ok(unsafe { raw::libraw_open_wfile(handle, path.as_ptr()) })
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "NEF path is invalid.".to_owned())?;
        Ok(unsafe { raw::libraw_open_file(handle, path.as_ptr()) })
    }
}

pub fn read_embedded_preview(location: &Value) -> Result<Vec<u8>, String> {
    let path = resolve_asset(location)?;
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("nef"))
    {
        return Ok(Vec::new());
    }
    let (file, opened) = open_regular(&path)?;
    let handle = RawHandle(unsafe { raw::libraw_init(0) });
    if handle.0.is_null() {
        return Err("LibRaw preview decoder could not start.".into());
    }
    if open_raw(handle.0, &path)? != 0 || unsafe { raw::libraw_unpack_thumb(handle.0) } != 0 {
        return Ok(Vec::new());
    }
    let mut error = 0;
    let image_ptr = unsafe { raw::libraw_dcraw_make_mem_thumb(handle.0, &mut error) };
    if image_ptr.is_null() {
        return Ok(Vec::new());
    }
    let image = ProcessedImage(image_ptr);
    let image_ref = unsafe { &*image.0 };
    let length = image_ref.data_size as usize;
    if image_ref.type_ as u32 != JPEG_IMAGE_FORMAT || length < 4 || length > MAX_JPEG_BYTES {
        return Ok(Vec::new());
    }
    let bytes = unsafe { slice::from_raw_parts(image_ref.data.as_ptr(), length) };
    if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return Ok(Vec::new());
    }
    check_open_regular(&path, &file, &opened)?;
    Ok(bytes.to_vec())
}
