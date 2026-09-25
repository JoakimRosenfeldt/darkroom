mod catalog;
mod commands;
mod compute;
mod develop;
mod gpu;
mod menu;
mod native;

use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{Emitter, Manager};

struct Backend {
    native_catalog_work: Arc<tokio::sync::Mutex<()>>,
    catalog: Mutex<catalog::CatalogService>,
    develop: Mutex<develop::DevelopService>,
    batch: Mutex<develop::batch::BatchService>,
    native: native::NativeContext,
}

fn user_data_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("DARKROOM_USER_DATA") {
        return Ok(PathBuf::from(path));
    }
    let base = directories::BaseDirs::new().ok_or("The user data directory is unavailable.")?;
    // Keep the Electron location so existing catalogs and settings remain available.
    Ok(base.config_dir().join("darkroom"))
}

fn trusted_url(url: &tauri::Url) -> bool {
    if cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(3000)
    {
        return true;
    }
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
}

fn main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .on_navigation(trusted_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    #[cfg(target_os = "linux")]
    window.with_webview(|view| {
        use webkit2gtk::{WebContextExt, WebViewExt};
        if let Some(context) = view.inner().context() {
            // Darkroom owns its bounded photo caches and never browses remote pages.
            context.set_cache_model(webkit2gtk::CacheModel::DocumentViewer);
        }
    })?;
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}

#[tauri::command]
async fn darkroom_invoke(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Backend>>,
    channel: String,
    mut args: Value,
) -> Result<Value, String> {
    if window.label() != "main"
        || !trusted_url(&window.url().map_err(|e| e.to_string())?)
        || !channel.starts_with("darkroom:")
    {
        return Err("Untrusted desktop request.".into());
    }
    let count = commands::argument_count(&channel).ok_or("Unknown desktop command.")?;
    if args.as_array().is_none_or(|items| items.len() != count) {
        return Err("Desktop arguments are invalid.".into());
    }
    let backend = state.inner().clone();
    if channel == "darkroom:catalog-relink-files-prepare" {
        let selected = rfd::AsyncFileDialog::new()
            .set_title("Choose files to relink")
            .pick_files()
            .await;
        args.as_array_mut()
            .unwrap()
            .push(selected.map_or(Value::Null, |items| {
                json!(items.iter().map(|file| file.path()).collect::<Vec<_>>())
            }));
    }
    if matches!(
        channel.as_str(),
        "darkroom:catalog-admin-validate-package" | "darkroom:catalog-admin-import-as-new"
    ) {
        let directory = rfd::AsyncFileDialog::new()
            .set_title("Choose catalog package")
            .pick_folder()
            .await;
        let Some(directory) = directory else {
            return Ok(Value::Null);
        };
        args.as_array_mut().unwrap().push(json!(directory.path()));
    }
    if channel == "darkroom:catalog-admin-export" {
        let destination = rfd::AsyncFileDialog::new()
            .set_title("Export catalog package")
            .set_file_name("Darkroom catalog")
            .save_file()
            .await;
        let Some(destination) = destination else {
            return Ok(Value::Null);
        };
        args.as_array_mut().unwrap().push(json!(destination.path()));
    }
    if matches!(
        channel.as_str(),
        "darkroom:catalog-create" | "darkroom:catalog-add-root" | "darkroom:catalog-relink-root"
    ) {
        #[cfg(feature = "diagnostics")]
        if let Some(folder) = std::env::var_os("DARKROOM_SMOKE_PHOTOS") {
            args.as_array_mut()
                .unwrap()
                .push(json!(PathBuf::from(folder)));
            return invoke_backend(backend, channel, args).await;
        }
        let folder = rfd::AsyncFileDialog::new()
            .set_title("Choose photo folder")
            .pick_folder()
            .await;
        args.as_array_mut()
            .unwrap()
            .push(folder.map_or(Value::Null, |v| json!(v.path())));
    }
    invoke_backend(backend, channel, args).await
}

async fn invoke_backend(
    backend: Arc<Backend>,
    channel: String,
    mut args: Value,
) -> Result<Value, String> {
    if channel == "darkroom:catalog-analyze-metadata" {
        let plan = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .prepare_metadata_analysis(&args[0])?;
        return tauri::async_runtime::spawn_blocking(move || catalog::run_metadata_analysis(plan))
            .await
            .map_err(|e| e.to_string())?;
    }
    if channel == "darkroom:catalog-cancel-metadata-analysis" {
        return backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .cancel_metadata_analysis(&args[0]);
    }
    if channel == "darkroom:develop-defaults-install" {
        return tauri::async_runtime::spawn_blocking(move || {
            develop::default_install::install(backend, args[0].clone())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if channel == "darkroom:develop-defaults-cancel" {
        return develop::default_install::cancel(&args[0]);
    }
    if channel == "darkroom:develop-defaults-installed" {
        return develop::default_install::installed(
            &mut *backend
                .catalog
                .lock()
                .map_err(|_| "Catalog service is unavailable.")?,
            &args[0],
        );
    }
    if channel == "darkroom:catalog-import-run" {
        let task = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .begin_import(&args[0])?;
        return tauri::async_runtime::spawn_blocking(move || task.wait())
            .await
            .map_err(|e| e.to_string())?;
    }
    if channel == "darkroom:catalog-trash-exact-duplicates" {
        let _work = backend.native_catalog_work.clone().lock_owned().await;
        let plan = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .prepare_exact_duplicate_trash(&args[0])?;
        return tauri::async_runtime::spawn_blocking(move || {
            catalog::run_exact_duplicate_trash(plan)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if matches!(
        channel.as_str(),
        "darkroom:catalog-fingerprint-start"
            | "darkroom:catalog-fingerprint-resume"
            | "darkroom:catalog-fingerprint-recover"
    ) {
        let mut progress = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .dispatch(&channel, args.clone())?;
        args[0]["operationId"] = progress["operationId"].clone();
        while progress["state"] == "planned" || progress["state"] == "running" {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            progress = backend
                .catalog
                .lock()
                .map_err(|_| "Catalog service is unavailable.")?
                .dispatch("darkroom:catalog-fingerprint-status", args.clone())?;
        }
        return Ok(progress);
    }
    if channel == "darkroom:develop-clipboard-write" {
        develop::clipboard::write_payload(&args[0])?;
        return native::handle(
            "darkroom:develop-clipboard-groups-set",
            json!([args[0]["selectedGroups"]]),
            &backend.native,
        )
        .await;
    }
    if channel == "darkroom:develop-clipboard-read" {
        return develop::clipboard::read();
    }
    if channel.starts_with("darkroom:develop-batch-") {
        return tauri::async_runtime::spawn_blocking(move || {
            let mut batch = backend
                .batch
                .lock()
                .map_err(|_| "Develop batch service is unavailable.")?;
            let catalog = backend
                .catalog
                .lock()
                .map_err(|_| "Catalog service is unavailable.")?;
            let mut develop = backend
                .develop
                .lock()
                .map_err(|_| "Develop service is unavailable.")?;
            batch.handle(&catalog, &mut develop, &channel, &args[0])
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if channel == "darkroom:catalog-wait-operation" {
        loop {
            let snapshot = backend
                .catalog
                .lock()
                .map_err(|_| "Catalog service is unavailable.")?
                .dispatch("darkroom:catalog-get-operation", args.clone())?;
            if snapshot["status"] != "running" {
                return Ok(snapshot);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }
    if matches!(
        channel.as_str(),
        "darkroom:catalog-read-asset"
            | "darkroom:catalog-read-asset-head"
            | "darkroom:catalog-stat-asset"
            | "darkroom:catalog-read-sidecar"
            | "darkroom:catalog-write-sidecar"
            | "darkroom:catalog-decode-asset"
    ) {
        let location = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .resolve_asset(&args[0])?;
        args.as_array_mut().unwrap().push(location);
        return native::handle(&channel, args, &backend.native).await;
    }
    if channel == "darkroom:choose-export-destination" {
        let source_backend = backend.clone();
        let request = args[0].clone();
        let sources=tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Value>,String> {
            let catalog=source_backend.catalog.lock().map_err(|_|"Catalog service is unavailable.")?;
            catalog.require_session(&request)?;
            let database=catalog.active_database().ok_or("Catalog is not open.")?;
            // Protect every source, including photos outside the current export selection.
            let locations=catalog::rows(database,"SELECT a.asset_id AS assetId,a.relative_path AS relativePath,r.canonical_path AS canonicalRootPath FROM assets a JOIN roots r ON r.catalog_id=a.catalog_id AND r.root_id=a.root_id WHERE a.catalog_id=? AND a.health='present' AND r.health='online'",catalog::values(&[&request["catalogId"]]))?;
            locations.into_iter().map(|location| {
                let path=native::resolve_asset_path(&location)?;
                Ok(json!({"path":path,"assetId":location["assetId"]}))
            }).collect()
        }).await.map_err(|e|e.to_string())??;
        args.as_array_mut().unwrap().push(json!(sources));
    }
    if channel.starts_with("darkroom:develop-presets-")
        || channel.starts_with("darkroom:camera-profiles-")
        || channel.starts_with("darkroom:develop-defaults-")
        || channel.starts_with("darkroom:develop-asset-")
        || channel.starts_with("darkroom:develop-jobs-")
    {
        return tauri::async_runtime::spawn_blocking(move || {
            backend
                .develop
                .lock()
                .map_err(|_| "Develop service is unavailable.")?
                .handle(&channel, args.as_array().unwrap())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if channel.starts_with("darkroom:catalog-") || channel.starts_with("darkroom:develop-history-")
    {
        let _native_work = if matches!(
            channel.as_str(),
            "darkroom:catalog-bootstrap"
                | "darkroom:catalog-create"
                | "darkroom:catalog-open"
                | "darkroom:catalog-switch"
                | "darkroom:catalog-close"
                | "darkroom:catalog-relink-root"
        ) || channel.starts_with("darkroom:catalog-admin-")
        {
            Some(backend.native_catalog_work.clone().lock_owned().await)
        } else {
            None
        };
        tauri::async_runtime::spawn_blocking(move || {
            if matches!(
                channel.as_str(),
                "darkroom:catalog-bootstrap"
                    | "darkroom:catalog-create"
                    | "darkroom:catalog-open"
                    | "darkroom:catalog-switch"
                    | "darkroom:catalog-close"
            ) || channel.starts_with("darkroom:catalog-admin-")
            {
                let mut batch = backend
                    .batch
                    .lock()
                    .map_err(|_| "Develop batch service is unavailable.")?;
                batch.stop();
                let mut catalog = backend
                    .catalog
                    .lock()
                    .map_err(|_| "Catalog service is unavailable.")?;
                let result = catalog.dispatch(&channel, args);
                let registry = backend
                    .develop
                    .lock()
                    .map_err(|_| "Develop service is unavailable.")?
                    .profiles
                    .list();
                batch.resume(&catalog, registry)?;
                result
            } else {
                let result = backend
                    .catalog
                    .lock()
                    .map_err(|_| "Catalog service is unavailable.".to_owned())?
                    .dispatch(&channel, args);
                if result.is_ok() && channel == "darkroom:develop-history-commit" {
                    backend
                        .batch
                        .lock()
                        .map_err(|_| "Develop batch service is unavailable.")?
                        .wake();
                }
                result
            }
        })
        .await
        .map_err(|e| e.to_string())?
    } else {
        native::handle(&channel, args, &backend.native).await
    }
}

#[tauri::command]
async fn darkroom_read(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Backend>>,
    channel: String,
    args: Value,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" || !trusted_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted desktop request.".into());
    }
    if args.as_array().is_none_or(|items| items.len() != 1) {
        return Err("Asset read arguments are invalid.".into());
    }
    let head = match channel.as_str() {
        "darkroom:catalog-read-asset" => None,
        "darkroom:catalog-read-asset-head" => Some(
            args[0]["maxBytes"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 16 * 1024 * 1024)
                .ok_or("Asset head size is invalid.")? as usize,
        ),
        _ => return Err("Invalid binary read command.".into()),
    };
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let location = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .resolve_asset(&args[0])?;
        native::read_asset_bytes(&location, head).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn darkroom_preview(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Backend>>,
    request: Value,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" || !trusted_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted desktop request.".into());
    }
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let location = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .resolve_asset(&request)?;
        native::read_embedded_preview(&location).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

static NEF_DECODE_QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Default)]
struct RawDecodeJobs(Mutex<HashMap<String, Arc<RawDecodeCancellation>>>);

#[derive(Default)]
struct RawDecodeCancellation {
    requested: AtomicBool,
    queued: tokio::sync::Notify,
}

impl RawDecodeCancellation {
    fn cancel(&self) {
        self.requested.store(true, Ordering::Relaxed);
        self.queued.notify_one();
    }
}

struct RawDecodeJob {
    id: String,
    cancelled: Arc<RawDecodeCancellation>,
    jobs: Arc<RawDecodeJobs>,
}

impl Drop for RawDecodeJob {
    fn drop(&mut self) {
        self.cancelled.cancel();
        if let Ok(mut jobs) = self.jobs.0.lock() {
            jobs.remove(&self.id);
        }
    }
}

#[tauri::command]
async fn darkroom_libraw_decode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Backend>>,
    jobs: tauri::State<'_, Arc<RawDecodeJobs>>,
    request_id: String,
    request: Value,
    options: native::LibRawDecodeOptions,
    on_started: tauri::ipc::Channel<()>,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" || !trusted_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted desktop request.".into());
    }
    if uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("RAW decode request id is invalid.".into());
    }
    let cancelled = Arc::new(RawDecodeCancellation::default());
    {
        let mut active = jobs
            .inner()
            .0
            .lock()
            .map_err(|_| "RAW decoder is unavailable.")?;
        if active.contains_key(&request_id) {
            return Err("RAW decode request id is already active.".into());
        }
        active.insert(request_id.clone(), cancelled.clone());
    }
    let job = RawDecodeJob {
        id: request_id,
        cancelled,
        jobs: jobs.inner().clone(),
    };
    // Acknowledge registration before the caller can send cancellation.
    on_started.send(()).map_err(|e| e.to_string())?;
    let permit = tokio::select! {
        biased;
        _ = job.cancelled.queued.notified() => return Err("RAW decode was cancelled.".into()),
        permit = NEF_DECODE_QUEUE.acquire() => permit.map_err(|e| e.to_string())?,
    };
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let job = job;
        if job.cancelled.requested.load(Ordering::Relaxed) {
            return Err("RAW decode was cancelled.".into());
        }
        let location = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .resolve_asset(&request)?;
        native::decode_libraw(&location, &options, &job.cancelled.requested)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn darkroom_libraw_cancel(
    window: tauri::WebviewWindow,
    jobs: tauri::State<'_, Arc<RawDecodeJobs>>,
    request_id: String,
) -> Result<(), String> {
    if window.label() != "main" || !trusted_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted desktop request.".into());
    }
    let active = jobs
        .inner()
        .0
        .lock()
        .map_err(|_| "RAW decoder is unavailable.")?;
    if let Some(cancelled) = active.get(&request_id) {
        cancelled.cancel();
    }
    Ok(())
}

#[tauri::command]
async fn darkroom_decode(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Backend>>,
    mut args: Value,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" || !trusted_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted desktop request.".into());
    }
    if args.as_array().is_none_or(|items| items.len() != 2) {
        return Err("Asset decode arguments are invalid.".into());
    }
    let permit = NEF_DECODE_QUEUE
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let location = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?
            .resolve_asset(&args[0])?;
        args.as_array_mut().unwrap().push(location);
        native::decode_asset_binary(args.as_array().unwrap(), &backend.native)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn darkroom_export(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Backend>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    if window.label() != "main" || !trusted_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted desktop request.".into());
    }
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("Export needs a binary request.".into());
    };
    if body.len() < 4 || body.len() > 201_048_580 {
        return Err("Export request size is invalid.".into());
    }
    let length = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    if length > 1024 * 1024 || length > body.len() - 4 {
        return Err("Export metadata size is invalid.".into());
    }
    let args: Vec<Value> =
        serde_json::from_slice(&body[4..4 + length]).map_err(|_| "Export metadata is invalid.")?;
    if args.len() != commands::argument_count("darkroom:encode-and-save-export").unwrap_or(4) {
        return Err("Export arguments are invalid.".into());
    }
    let pixels = body[4 + length..].to_vec();
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        native::encode_export_raw(&args, pixels, &backend.native)
    })
    .await
    .map_err(|e| e.to_string())?
}

struct GpuState {
    generation: u64,
    renderer: Result<gpu::NativeGpu, String>,
}

impl GpuState {
    fn new() -> Self {
        Self {
            generation: GPU_GENERATION.load(Ordering::Acquire),
            renderer: gpu::NativeGpu::new(),
        }
    }

    fn sync_generation(&mut self) -> u64 {
        let generation = GPU_GENERATION.load(Ordering::Acquire);
        if self.generation != generation {
            if let Ok(renderer) = self.renderer.as_mut() {
                renderer.clear_sessions();
            }
            self.generation = generation;
        }
        generation
    }
}

static GPU: std::sync::OnceLock<Mutex<GpuState>> = std::sync::OnceLock::new();
static GPU_GENERATION: AtomicU64 = AtomicU64::new(0);
static GPU_QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

fn reset_gpu_sessions() {
    GPU_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Some(gpu) = GPU.get() {
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut state) = gpu.lock() {
                state.sync_generation();
            }
        });
    }
}

#[tauri::command]
async fn darkroom_gpu(
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let generation = GPU_GENERATION.load(Ordering::Acquire);
    if window.label() != "main" || !trusted_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted desktop request.".into());
    }
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("Native rendering needs a binary request.".into());
    };
    if body.len() < 4 || body.len() > 512 * 1024 * 1024 {
        return Err("Native render request size is invalid.".into());
    }
    let permit = GPU_QUEUE.acquire().await.map_err(|e| e.to_string())?;
    if GPU_GENERATION.load(Ordering::Acquire) != generation {
        return Err("Native render request belongs to a previous document.".into());
    }
    let bytes = body.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut state = GPU
            .get_or_init(|| Mutex::new(GpuState::new()))
            .lock()
            .map_err(|_| "Native renderer is unavailable.")?;
        if state.sync_generation() != generation {
            return Err("Native render request belongs to a previous document.".into());
        }
        let result = state
            .renderer
            .as_mut()
            .map_err(|e| e.clone())?
            .execute(&bytes);
        if state.sync_generation() != generation {
            return Err("Native render request belongs to a previous document.".into());
        }
        result.map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?;
    drop(permit);
    result
}

#[tauri::command]
async fn darkroom_gpu_info(window: tauri::WebviewWindow) -> Result<Value, String> {
    if window.label() != "main" || !trusted_url(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted desktop request.".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let mut state = GPU
            .get_or_init(|| Mutex::new(GpuState::new()))
            .lock()
            .map_err(|_| "Native renderer is unavailable.")?;
        state.sync_generation();
        serde_json::to_value(state.renderer.as_ref().map_err(|e| e.clone())?.info())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    let builder = tauri::Builder::default().on_page_load(|webview, payload| {
        if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
            // Document reloads bypass the JavaScript renderer's normal disposal.
            reset_gpu_sessions();
            if let Some(jobs) = webview.try_state::<Arc<RawDecodeJobs>>() {
                if let Ok(active) = jobs.inner().0.lock() {
                    for cancelled in active.values() {
                        cancelled.cancel();
                    }
                }
            }
        }
    });
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        eprintln!(
            "Darkroom web content process terminated; reloading {}.",
            webview.label()
        );
        if let Err(error) = webview.reload() {
            eprintln!("Could not reload Darkroom after web content process termination: {error}");
        }
    });
    builder
        .on_menu_event(menu::handle_event)
        .register_asynchronous_uri_scheme_protocol(
            "darkroom-model",
            |context, request, responder| {
                let app = context.app_handle().clone();
                std::thread::spawn(move || {
                    let backend = app.state::<Arc<Backend>>();
                    let id = request.uri().path().trim_start_matches('/');
                    let body = if request.method() == "GET" && request.uri().query().is_none() {
                        native::verified_model_path(&backend.native.app_data, id)
                            .and_then(|p| std::fs::read(p).map_err(|e| e.to_string()))
                    } else {
                        Err("Invalid model request.".into())
                    };
                    let (status, bytes) = match body {
                        Ok(bytes) => (200, bytes),
                        Err(_) => (404, b"Model unavailable".to_vec()),
                    };
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(status)
                            .header("Content-Type", "application/octet-stream")
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Cross-Origin-Resource-Policy", "cross-origin")
                            .header("X-Content-Type-Options", "nosniff")
                            .header("Cache-Control", "no-store")
                            .body(bytes)
                            .unwrap(),
                    );
                });
            },
        )
        .setup(|app| {
            let user_data = user_data_path()?;
            let resources = app.path().resource_dir()?;
            let app_handle = app.handle().clone();
            let emit = Arc::new(move |event: &str, payload: Value| {
                if let Err(error) = app_handle.emit_to("main", event, payload) {
                    eprintln!("Could not deliver {event}: {error}");
                }
            });
            let mut catalog = catalog::CatalogService::new(user_data.clone())?;
            catalog.set_emit(emit.clone());
            let mut develop = develop::DevelopService::new(&user_data)?;
            develop.jobs.set_emitter(emit.clone())?;
            let backend = Arc::new(Backend {
                native_catalog_work: Arc::new(tokio::sync::Mutex::new(())),
                catalog: Mutex::new(catalog),
                develop: Mutex::new(develop),
                batch: Mutex::new(develop::batch::BatchService::new(emit.clone())),
                native: native::NativeContext::new(user_data, resources, emit),
            });
            app.manage(backend);
            app.manage(Arc::new(RawDecodeJobs::default()));
            menu::install(app.handle())?;
            main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            darkroom_invoke,
            darkroom_read,
            darkroom_preview,
            darkroom_decode,
            darkroom_libraw_decode,
            darkroom_libraw_cancel,
            darkroom_export,
            darkroom_gpu,
            darkroom_gpu_info,
            menu::darkroom_menu_state
        ])
        .build(tauri::generate_context!())
        .expect("Could not start Darkroom")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } = &event
            {
                if label == "main" {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else if let Err(error) = main_window(app) {
                    eprintln!("Could not reopen Darkroom: {error}");
                }
            }
            if let tauri::RunEvent::Exit = event {
                if let Some(backend) = app.try_state::<Arc<Backend>>() {
                    if let Ok(mut batch) = backend.batch.lock() {
                        batch.stop();
                    }
                }
            }
        });
}

#[cfg(feature = "diagnostics")]
pub fn run_backend_console() -> Result<(), String> {
    use std::io::{BufRead, Write};
    let app_data = user_data_path()?;
    let emit = Arc::new(|channel: &str, payload: Value| {
        eprintln!("{}", json!({"event":channel,"payload":payload}));
    });
    let mut catalog = catalog::CatalogService::new(app_data.clone())?;
    catalog.set_emit(emit.clone());
    let mut develop = develop::DevelopService::new(&app_data)?;
    develop.jobs.set_emitter(emit.clone())?;
    let backend = Arc::new(Backend {
        native_catalog_work: Arc::new(tokio::sync::Mutex::new(())),
        catalog: Mutex::new(catalog),
        develop: Mutex::new(develop),
        batch: Mutex::new(develop::batch::BatchService::new(emit.clone())),
        native: native::NativeContext::new(
            app_data,
            std::env::current_dir().map_err(|e| e.to_string())?,
            emit,
        ),
    });
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let channel = request["channel"]
            .as_str()
            .ok_or("Missing diagnostic channel.")?
            .to_owned();
        let started = std::time::Instant::now();
        let result = runtime.block_on(invoke_backend(
            backend.clone(),
            channel,
            request["args"].clone(),
        ));
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let response = match result {
            Ok(value) => json!({"id":request["id"],"value":value,"elapsedMs":elapsed}),
            Err(error) => json!({"id":request["id"],"error":error,"elapsedMs":elapsed}),
        };
        println!("{response}");
        std::io::stdout().flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
