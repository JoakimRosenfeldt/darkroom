use std::{fs,io::Read};

use libraw_rs_vendor as raw;
use serde_json::{json, Value};

use super::assets::resolve_asset;

const MAX_INPUT: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT: u64 = 256 * 1024 * 1024;

#[cfg(unix)]
fn same_file(left:&fs::Metadata,right:&fs::Metadata)->bool{
    use std::os::unix::fs::MetadataExt;
    left.is_file()&&right.is_file()&&left.dev()==right.dev()&&left.ino()==right.ino()
        &&left.len()==right.len()&&left.mtime()==right.mtime()&&left.mtime_nsec()==right.mtime_nsec()
}
#[cfg(not(unix))]
fn same_file(left:&fs::Metadata,right:&fs::Metadata)->bool{
    left.is_file()&&right.is_file()&&left.len()==right.len()&&left.modified().ok()==right.modified().ok()
}

struct RawHandle(*mut raw::libraw_data_t);
impl Drop for RawHandle {
    fn drop(&mut self) { unsafe { raw::libraw_close(self.0); } }
}
struct ProcessedImage(*mut raw::libraw_processed_image_t);
impl Drop for ProcessedImage {
    fn drop(&mut self) { unsafe { raw::libraw_dcraw_clear_mem(self.0); } }
}

fn c_text(bytes: &[std::ffi::c_char], label: &str) -> Result<String,String> {
    let length=bytes.iter().position(|byte|*byte==0).unwrap_or(bytes.len());
    let encoded=bytes[..length].iter().map(|byte|*byte as u8).collect::<Vec<_>>();
    let value = std::str::from_utf8(&encoded).map_err(|_|format!("LibRaw {label} is invalid."))?.trim();
    if value.is_empty() || value.len() > 256 || value.contains('\0') { return Err(format!("LibRaw {label} is invalid.")); }
    Ok(value.to_owned())
}
fn id_part(value: &str) -> Result<String,String> {
    let mut result = String::new();
    for character in value.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if result.len() == 80 { break; }
            result.push(character);
        } else if !result.is_empty() && !result.ends_with('-') && result.len() < 80 {
            result.push('-');
        }
    }
    let result = result.trim_matches('-').to_owned();
    if result.is_empty() { Err("LibRaw camera identity cannot form a profile id.".into()) } else { Ok(result) }
}

pub fn verify_libraw_profile(location: &Value) -> Result<Value,String> {
    let path = resolve_asset(location)?;
    if !path.extension().and_then(|s|s.to_str()).is_some_and(|s|s.eq_ignore_ascii_case("nef")) {
        return Err("LibRaw profile verification requires a Nikon NEF file.".into());
    }
    let before=fs::symlink_metadata(&path).map_err(|e|e.to_string())?;
    if !before.is_file()||before.file_type().is_symlink(){return Err("LibRaw profile input is not a regular file.".into())}
    let mut options=fs::OpenOptions::new();options.read(true);
    #[cfg(unix)]{
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file=options.open(&path).map_err(|e|e.to_string())?;
    let opened=file.metadata().map_err(|e|e.to_string())?;
    if !same_file(&before,&opened){return Err("LibRaw profile input changed before it was opened.".into())}
    let file_size=opened.len();
    if file_size == 0 || file_size > MAX_INPUT { return Err("LibRaw profile input is invalid or too large.".into()); }
    let mut bytes=Vec::with_capacity(file_size as usize);
    (&mut file).take(MAX_INPUT+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    let after=file.metadata().map_err(|e|e.to_string())?;
    let path_after=fs::symlink_metadata(&path).map_err(|e|e.to_string())?;
    if bytes.len() as u64 != file_size || !same_file(&opened,&after) || !same_file(&after,&path_after) { return Err("LibRaw profile input changed while reading.".into()); }
    let handle=RawHandle(unsafe { raw::libraw_init(0) });
    if handle.0.is_null() { return Err("LibRaw profile decoder could not start.".into()); }
    unsafe { (*handle.0).rawparams.max_raw_memory_mb=384; }
    let mut result=unsafe { raw::libraw_open_buffer(handle.0,bytes.as_ptr().cast(),bytes.len()) };
    if result != 0 { return Err(format!("LibRaw could not open NEF ({result}).")); }
    unsafe {
        let params=&mut (*handle.0).params;
        params.half_size=1;
        params.output_bps=16;
        params.output_color=0;
        params.gamm[0]=1.0;
        params.gamm[1]=1.0;
        params.no_auto_bright=1;
        params.use_camera_matrix=0;
        params.use_camera_wb=1;
        params.user_qual=0;
    }
    result=unsafe { raw::libraw_unpack(handle.0) };
    if result != 0 { return Err(format!("LibRaw could not unpack NEF ({result}).")); }
    result=unsafe { raw::libraw_dcraw_process(handle.0) };
    if result != 0 { return Err(format!("LibRaw could not process NEF ({result}).")); }
    let mut image_error=0;
    let image_guard=ProcessedImage(unsafe { raw::libraw_dcraw_make_mem_image(handle.0,&mut image_error) });
    if image_guard.0.is_null() { return Err(format!("LibRaw could not produce linear camera pixels ({image_error}).")); }
    let image=unsafe { &*image_guard.0 };
    let expected=image.width as u64 * image.height as u64 * 3 * 2;
    if image.width == 0 || image.height == 0 || image.colors != 3 || image.bits != 16 || expected > MAX_OUTPUT || image.data_size as u64 != expected {
        return Err("LibRaw did not produce bounded linear RGB16 camera pixels.".into());
    }
    let (make,model,matrix)=unsafe {
        let data=&*handle.0;
        let make=c_text(&data.idata.make,"camera make")?;
        let model=c_text(&data.idata.model,"camera model")?;
        let mut matrix=[0_f64;9];
        for row in 0..3 { for column in 0..3 { matrix[row*3+column]=f64::from(data.color.rgb_cam[row][column]); } }
        (make,model,matrix)
    };
    if matrix.iter().any(|value| !value.is_finite() || value.abs()>16.0) || matrix==[1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0] {
        return Err("LibRaw camera-to-sRGB matrix is invalid.".into());
    }
    let determinant=matrix[0]*(matrix[4]*matrix[8]-matrix[5]*matrix[7])
        -matrix[1]*(matrix[3]*matrix[8]-matrix[5]*matrix[6])
        +matrix[2]*(matrix[3]*matrix[7]-matrix[4]*matrix[6]);
    if determinant.abs()<1e-8 { return Err("LibRaw camera-to-sRGB matrix must be invertible.".into()); }
    let id=format!("darkroom.libraw-matrix.{}.{}",id_part(&make)?,id_part(&model)?);
    let label=format!("{make} {model} LibRaw matrix");
    if label.len()>256 { return Err("LibRaw camera profile label is too long.".into()); }
    Ok(json!({"version":1,"kind":"matrix","id":id,"revision":"libraw-rgb-cam-v1","label":label,
        "compatibility":{"make":make,"model":model},"matrixToLinearSrgb":matrix,"channelScale":[1,1,1],"exposureOffsetEv":0}))
}
