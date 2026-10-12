use std::io::{self, Read, Write};

struct RawSource {
    width: u32,
    height: u32,
    rgb16: Vec<u8>,
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
        let result = gpu.submit(&request, &sources).and_then(|submission| match submission {
            gpu::NativeGpuSubmission::Complete(bytes) => Ok(bytes),
            gpu::NativeGpuSubmission::Readback(mut readback) => {
                let result = readback.read();
                gpu.complete_readback(readback, result)
            }
        });
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
