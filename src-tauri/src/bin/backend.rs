fn main() {
    if let Err(error) = darkroom_lib::run_backend_console() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
