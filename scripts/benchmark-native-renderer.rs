use std::io::{self, Read, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut gpu = gpu::NativeGpu::new()?;
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
        let (response, failed) = match gpu.execute(&request) {
            Ok(response) => (response, false),
            Err(error) => (error.into_bytes(), true),
        };
        let size = response.len() as u32 | if failed { 1 << 31 } else { 0 };
        output.write_all(&size.to_le_bytes())?;
        output.write_all(&response)?;
        output.flush()?;
    }
}
