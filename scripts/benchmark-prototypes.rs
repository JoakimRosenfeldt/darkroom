#[path = "../src-tauri/src/develop/prototype.rs"]
mod prototype;
mod native {
    pub fn parse_binary(v: &serde_json::Value) -> Result<Vec<u8>, String> {
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            v["__darkroomBinary"].as_str().ok_or("Missing binary")?,
        )
        .map_err(|e| e.to_string())
    }
}
use serde_json::json;
use std::{hint::black_box, sync::atomic::AtomicBool, time::Instant};
fn main() {
    let image = prototype::Image {
        width: 512,
        height: 512,
        channels: 4,
        pixels: (0..512 * 512 * 4)
            .map(|i| {
                if i % 4 == 3 {
                    255
                } else {
                    ((i * 23 + 41) % 256) as u8
                }
            })
            .collect(),
    };
    let selection = (0..512 * 512)
        .map(|i| if i % 9 == 0 { 128u8 } else { 0u8 })
        .collect::<Vec<_>>();
    let mut timings = vec![];
    for (kind, extra) in [
        ("depth", json!({})),
        ("denoise", json!({"strength":55})),
        ("raw-details", json!({"amount":67})),
        ("super-resolution", json!({})),
        ("generative-remove", json!({"seed":12345,"searchRadius":7})),
    ] {
        let mut request = extra;
        request["kind"] = json!(kind);
        let cancel = AtomicBool::new(false);
        black_box(prototype::process(&request, &image, Some(&selection), &cancel).unwrap());
        let mut times = vec![];
        for _ in 0..5 {
            let start = Instant::now();
            let output = prototype::process(&request, &image, Some(&selection), &cancel).unwrap();
            black_box(output);
            times.push(start.elapsed().as_secs_f64() * 1000.);
        }
        timings.push(json!({"operation":kind,"milliseconds":times}));
    }
    println!("{}", json!(timings));
}
