fn main() {
    if !tauri_build::is_dev() {
        // Track added and removed assets as well as the files embedded by the macro.
        println!("cargo:rerun-if-changed=../out");
    }
    tauri_build::build();
}
