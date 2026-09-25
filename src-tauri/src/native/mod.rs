use std::{path::PathBuf, sync::Arc};

use serde_json::Value;

mod ai_models;
mod assets;
mod embedded_preview;
mod export;
mod libraw_profile;
mod metadata;
mod nef;
mod settings;
#[cfg(windows)]
mod windows_file;

#[cfg(windows)]
pub(crate) use windows_file::{windows_handle_identity, windows_path_identity};

pub use ai_models::verified_model_path;
pub use assets::read_asset_bytes;
pub(crate) use assets::resolve_asset as resolve_asset_path;
pub use embedded_preview::read_embedded_preview;
pub use export::encode_export_raw;
pub use libraw_profile::verify_libraw_profile;
pub use metadata::analyze_file;
pub(crate) use metadata::{analyze_file_with_digest, sha256 as metadata_sha256};
pub use nef::decode_asset_binary;

#[derive(Clone)]
pub struct NativeContext {
    pub app_data: PathBuf,
    pub resources: PathBuf,
    pub emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
}

impl NativeContext {
    pub fn new(
        app_data: PathBuf,
        resources: PathBuf,
        emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
    ) -> Self {
        Self {
            app_data,
            resources,
            emit,
        }
    }
}

pub async fn handle(command: &str, args: Value, ctx: &NativeContext) -> Result<Value, String> {
    let args = args
        .as_array()
        .ok_or("Native command arguments must be an array.")?;
    match command {
        "darkroom:get-export-options" => settings::get_export_options(&ctx.app_data),
        "darkroom:set-export-options" => settings::set_export_options(
            &ctx.app_data,
            args.first().cloned().unwrap_or(Value::Null),
        ),
        "darkroom:develop-clipboard-groups-get" => settings::get_clipboard_groups(&ctx.app_data),
        "darkroom:develop-clipboard-groups-set" => settings::set_clipboard_groups(
            &ctx.app_data,
            args.first().cloned().unwrap_or(Value::Null),
        ),
        "darkroom:get-export-formats"
        | "darkroom:choose-export-destination"
        | "darkroom:encode-and-save-export"
        | "darkroom:finalize-export"
        | "darkroom:show-in-folder" => export::handle(command, args, ctx).await,
        "darkroom:get-ai-model-state"
        | "darkroom:download-ai-model"
        | "darkroom:cancel-ai-model-download"
        | "darkroom:remove-ai-model"
        | "darkroom:open-ai-model-link" => ai_models::handle(command, args, ctx).await,
        "darkroom:catalog-read-asset"
        | "darkroom:catalog-read-asset-head"
        | "darkroom:catalog-stat-asset"
        | "darkroom:catalog-read-sidecar"
        | "darkroom:catalog-write-sidecar" => assets::handle(command, args, ctx),
        "darkroom:catalog-decode-asset" | "darkroom:get-format-capability-report" => {
            nef::handle(command, args, ctx)
        }
        _ => Err(format!("Unknown native command: {command}")),
    }
}

pub fn binary_value(bytes: &[u8]) -> Value {
    serde_json::json!({ "__darkroomBinary": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes), "type":"ArrayBuffer" })
}

pub fn parse_binary(value: &Value) -> Result<Vec<u8>, String> {
    let encoded = value
        .get("__darkroomBinary")
        .and_then(Value::as_str)
        .ok_or("Binary payload is missing.")?;
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
        .map_err(|_| "Binary payload is invalid.".to_owned())
}
