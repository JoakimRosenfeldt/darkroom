use std::io::{self, Read, Write};

#[derive(Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum NativeSourceFormat {
    Rgb16,
    Rgb8,
    Rgba8,
}

impl NativeSourceFormat {
    fn spec_format(self) -> &'static str {
        match self {
            Self::Rgb16 => "rgb16uint",
            Self::Rgb8 => "rgb8unorm",
            Self::Rgba8 => "rgba8unorm",
        }
    }

    fn bytes_per_pixel(self) -> u64 {
        match self {
            Self::Rgb16 => 6,
            Self::Rgb8 => 3,
            Self::Rgba8 => 4,
        }
    }
}

struct RawSource {
    width: u32,
    height: u32,
    format: NativeSourceFormat,
    data: Vec<u8>,
}

struct RawSources;

impl RawSources {
    fn get(&mut self, _handle: &str) -> Option<std::sync::Arc<RawSource>> {
        None
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut gpu = gpu::NativeGpu::new()?;
    let sources = std::sync::Mutex::new(RawSources);
    eprintln!("{}", serde_json::to_string(&gpu.info())?);
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut header = [0; 4];
        match input.read_exact(&mut header) {
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            result => result?,
        }
        let size = u32::from_le_bytes(header) as usize;
        if size > 512 * 1024 * 1024 {
            return Err("GPU probe request exceeds 512 MiB".into());
        }
        let mut request = vec![0; size];
        input.read_exact(&mut request)?;
        let result = gpu.execute(&request, &sources);
        let (response, failed) = match result {
            Ok(response) => (response, false),
            Err(error) => (error.into_bytes(), true),
        };
        let size = response.len() as u32 | if failed { 1 << 31 } else { 0 };
        output.write_all(&size.to_le_bytes())?;
        output.write_all(&response)?;
        output.flush()?;
    }
}
