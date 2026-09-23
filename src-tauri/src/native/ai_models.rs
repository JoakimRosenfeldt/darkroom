use std::{collections::HashMap, fs, io::{Read, Write}, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex, OnceLock}};

use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::NativeContext;

const CACHE_BEHAVIOR: &str = "Darkroom downloads this model once, verifies it, and keeps it in private app storage for offline use until you remove it.";

struct Model {
    id: &'static str, bytes: u64, revision: &'static str, width: u32, height: u32,
    purpose: &'static str, source: &'static str, license: &'static str,
    artifact: &'static str, filename: &'static str, sha256: &'static str,
}

const SUBJECT: Model = Model {
    id: "subject", bytes: 98_484_532, revision: "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7", width: 512, height: 512,
    purpose: "Select salient foreground subjects on this device.",
    source: "https://huggingface.co/studioludens/birefnet-lite-512/tree/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7",
    license: "https://huggingface.co/studioludens/birefnet-lite-512/blob/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/README.md",
    artifact: "https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/onnx/model_fp16.onnx?download=true",
    filename: "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
    sha256: "eff9216bb2f9d3f023d9c2b7196845a7485739ab1f231593633e4d2344ffc516",
};
const SKY: Model = Model {
    id: "sky", bytes: 99_310_780, revision: "dac255883ec5faf508561a47172096bfd8708db0", width: 384, height: 384,
    purpose: "Select sky pixels on this device.",
    source: "https://huggingface.co/Realcat/skywater_seg/tree/dac255883ec5faf508561a47172096bfd8708db0",
    license: "https://huggingface.co/Realcat/skywater_seg/blob/dac255883ec5faf508561a47172096bfd8708db0/README.md",
    artifact: "https://huggingface.co/Realcat/skywater_seg/resolve/dac255883ec5faf508561a47172096bfd8708db0/skywater_segformer_b2_fp32.onnx?download=true",
    filename: "skywater_segformer_b2_fp32.onnx",
    sha256: "e4e9a6927c2d910c3243f86e392b18da715b41c03e6e6f41672f8f6b8eaa71b5",
};

fn model(id: &str) -> Result<&'static Model, String> {
    match id { "subject" => Ok(&SUBJECT), "sky" => Ok(&SKY), _ => Err("Unknown AI model.".into()) }
}

fn disclosure(model: &Model) -> Value {
    json!({"id":model.id,"selector":model.id,"purpose":model.purpose,"bytes":model.bytes,"revision":model.revision,"input":{"width":model.width,"height":model.height},"sourceUrl":model.source,"license":{"name":"MIT","url":model.license},"offlineCacheBehavior":CACHE_BEHAVIOR})
}

fn directory(root: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|_| "The private model cache is unavailable.")?;
    let path = root.join("models");
    fs::create_dir_all(&path).map_err(|_| "The private model cache is unavailable.")?;
    let actual = fs::canonicalize(&path).map_err(|_| "The private model cache is unavailable.")?;
    if actual != path || !actual.starts_with(&root) || !fs::symlink_metadata(&path).map_err(|e| e.to_string())?.is_dir() { return Err("The private model cache is outside app storage.".into()); }
    Ok(path)
}

fn verified_path(root: &Path, model: &Model) -> Result<Option<PathBuf>, String> {
    let path = directory(root)?.join(model.filename);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("The cached model is unavailable.".into()),
    };
    if !metadata.is_file() || metadata.len() != model.bytes { return Err("The cached model failed verification.".into()); }
    let mut file = fs::File::open(&path).map_err(|_| "The cached model is unavailable.")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| "The cached model is unavailable.")?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    if format!("{:x}", hasher.finalize()) != model.sha256 { return Err("The cached model failed verification.".into()); }
    Ok(Some(path))
}

pub fn verified_model_path(root: &Path, model_id: &str) -> Result<PathBuf, String> {
    verified_path(root, model(model_id)?)?.ok_or_else(|| "Model is not downloaded.".into())
}

struct Download { cancelled: AtomicBool, received: AtomicU64, finished: AtomicBool, cancel_notify: tokio::sync::Notify, finish_notify: tokio::sync::Notify }
static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<Download>>>> = OnceLock::new();
static ERRORS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
fn active() -> &'static Mutex<HashMap<String, Arc<Download>>> { ACTIVE.get_or_init(|| Mutex::new(HashMap::new())) }
fn errors() -> &'static Mutex<HashMap<String, String>> { ERRORS.get_or_init(|| Mutex::new(HashMap::new())) }

fn progress(ctx: &NativeContext, model: &Model, received: u64) {
    (ctx.emit)("darkroom:ai-model-progress", json!({"modelId":model.id,"receivedBytes":received,"totalBytes":model.bytes}));
}

async fn download(root: &Path, model: &Model, ctx: &NativeContext, state: &Download) -> Result<(), String> {
    if state.cancelled.load(Ordering::Relaxed) { return Err("Model download was cancelled.".into()); }
    if verified_path(root, model)?.is_some() { return Ok(()); }
    let directory = directory(root)?;
    let temporary = directory.join(format!(".{}.{}.tmp", model.filename, uuid::Uuid::new_v4()));
    let result = async {
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
        let mut url = reqwest::Url::parse(model.artifact).map_err(|e| e.to_string())?;
        let mut response = None;
        for redirects in 0..=5 {
            if state.cancelled.load(Ordering::Relaxed) { return Err("Model download was cancelled.".into()); }
            if url.scheme() != "https" || !matches!(url.host_str(), Some("huggingface.co"|"us.aws.cdn.hf.co")) || !url.username().is_empty() || url.password().is_some() {
                return Err("The model server redirected to an unapproved location.".into());
            }
            let request = client.get(url.clone()).header("Accept", "application/octet-stream").header("Accept-Encoding", "identity")
                .header("User-Agent", "Darkroom/0.1 model downloader").send();
            let next = tokio::select! {
                result = request => result.map_err(|_| "The model download failed.".to_owned())?,
                _ = state.cancel_notify.notified() => return Err("Model download was cancelled.".into()),
            };
            if next.status().is_redirection() {
                if redirects == 5 { return Err("The model server returned too many redirects.".into()); }
                let location = next.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or("The model server returned too many redirects.")?;
                url = url.join(location).map_err(|_| "The model server redirected to an unapproved location.")?;
                continue;
            }
            if !next.status().is_success() { return Err(format!("The model server returned HTTP {}.", next.status().as_u16())); }
            response = Some(next);
            break;
        }
        let response = response.ok_or("The model server returned too many redirects.")?;
        if response.content_length().is_some_and(|len| len != model.bytes) { return Err("The model server returned the wrong file size.".into()); }
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "Darkroom could not write the model download.")?;
        let mut hash = Sha256::new();
        progress(ctx, model, 0);
        let mut stream = response.bytes_stream();
        loop {
            if state.cancelled.load(Ordering::Relaxed) { return Err("Model download was cancelled.".into()); }
            let next = tokio::select! {
                result = stream.next() => result,
                _ = state.cancel_notify.notified() => return Err("Model download was cancelled.".into()),
            };
            let Some(chunk) = next else { break; };
            if state.cancelled.load(Ordering::Relaxed) { return Err("Model download was cancelled.".into()); }
            let chunk = chunk.map_err(|_| "The model download failed.")?;
            let count = state.received.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
            if count > model.bytes { return Err("The model server returned too many bytes.".into()); }
            file.write_all(&chunk).map_err(|_| "Darkroom could not write the model download.")?;
            hash.update(&chunk);
            progress(ctx, model, count);
        }
        if state.cancelled.load(Ordering::Relaxed) { return Err("Model download was cancelled.".into()); }
        if state.received.load(Ordering::Relaxed) != model.bytes || format!("{:x}", hash.finalize()) != model.sha256 { return Err("The downloaded model failed verification.".into()); }
        file.sync_all().map_err(|_| "Darkroom could not write the model download.")?;
        drop(file);
        let target = directory.join(model.filename);
        let backup = directory.join(format!(".{}.previous", model.filename));
        if target.exists() { fs::rename(&target, &backup).map_err(|e| e.to_string())?; }
        if let Err(error) = fs::rename(&temporary, &target) {
            if backup.exists() { let _ = fs::rename(&backup, &target); }
            return Err(error.to_string());
        }
        let _ = fs::remove_file(backup);
        Ok(())
    }.await;
    let _ = fs::remove_file(temporary);
    result
}

async fn cancel(id: &str) -> Result<(),String> {
    let state = active().lock().map_err(|e| e.to_string())?.get(id).cloned();
    if let Some(state) = state {
        state.cancelled.store(true, Ordering::Relaxed);
        state.cancel_notify.notify_waiters();
        loop {
            let notified = state.finish_notify.notified();
            if state.finished.load(Ordering::Acquire) { break; }
            notified.await;
        }
    }
    Ok(())
}

pub async fn handle(command: &str, args: &[Value], ctx: &NativeContext) -> Result<Value, String> {
    let id = args.first().and_then(Value::as_str).ok_or("Unknown AI model.")?;
    let model = model(id)?;
    match command {
        "darkroom:get-ai-model-state" => {
            if let Some(state) = active().lock().map_err(|e| e.to_string())?.get(id) {
                return Ok(json!({"status":"downloading","model":disclosure(model),"receivedBytes":state.received.load(Ordering::Relaxed),"totalBytes":model.bytes}));
            }
            match verified_path(&ctx.app_data, model) {
                Ok(Some(_)) => Ok(json!({"status":"ready","model":disclosure(model)})),
                Ok(None) => match errors().lock().map_err(|e| e.to_string())?.get(id) {
                    Some(message) => Ok(json!({"status":"error","model":disclosure(model),"message":message})),
                    None => Ok(json!({"status":"missing","model":disclosure(model)})),
                },
                Err(message) => Ok(json!({"status":"error","model":disclosure(model),"message":message})),
            }
        }
        "darkroom:download-ai-model" => {
            let state = {
                let mut active = active().lock().map_err(|e| e.to_string())?;
                if active.contains_key(id) { return Ok(Value::Null); }
                let state = Arc::new(Download { cancelled: AtomicBool::new(false), received: AtomicU64::new(0), finished: AtomicBool::new(false), cancel_notify: tokio::sync::Notify::new(), finish_notify: tokio::sync::Notify::new() });
                active.insert(id.to_owned(), state.clone());
                state
            };
            let result = download(&ctx.app_data, model, ctx, &state).await;
            state.finished.store(true, Ordering::Release);
            state.finish_notify.notify_waiters();
            active().lock().map_err(|e| e.to_string())?.remove(id);
            match &result {
                Ok(()) => { errors().lock().map_err(|e| e.to_string())?.remove(id); }
                Err(message) if !state.cancelled.load(Ordering::Relaxed) => { errors().lock().map_err(|e| e.to_string())?.insert(id.to_owned(), message.clone()); }
                _ => (),
            }
            result.map(|_| Value::Null)
        }
        "darkroom:cancel-ai-model-download" => {
            cancel(id).await?;
            Ok(Value::Null)
        }
        "darkroom:remove-ai-model" => {
            cancel(id).await?;
            let directory = directory(&ctx.app_data)?;
            for path in [directory.join(model.filename), directory.join(format!(".{}.previous", model.filename))] {
                if path.exists() {
                    if !fs::symlink_metadata(&path).map_err(|e| e.to_string())?.is_file() { return Err("The cached model is not a regular file.".into()); }
                    fs::remove_file(path).map_err(|_| "Darkroom could not remove the cached model.")?;
                }
            }
            errors().lock().map_err(|e| e.to_string())?.remove(id);
            Ok(Value::Null)
        }
        "darkroom:open-ai-model-link" => {
            let url = match args.get(1).and_then(Value::as_str) { Some("source") => model.source, Some("license") => model.license, _ => return Err("Unknown AI model link.".into()) };
            open::that(url).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err(format!("Unknown AI command: {command}")),
    }
}
