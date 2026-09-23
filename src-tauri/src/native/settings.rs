use std::{fs, io::Write, path::Path, sync::Mutex};

use serde_json::{json, Value};

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn path(root: &Path) -> std::path::PathBuf { root.join("settings.json") }

fn read(root: &Path) -> Value {
    fs::read(path(root)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn write(root: &Path, settings: &Value) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let target = path(root);
    let temp = root.join(format!("settings.json.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, target).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

fn valid_size(value: &Value) -> Value {
    match value.get("mode").and_then(Value::as_str) {
        Some("original") => json!({"mode":"original"}),
        Some("long-edge" | "longEdge") => {
            let pixels = value.get("pixels").or_else(|| value.get("longEdge")).and_then(Value::as_u64).unwrap_or(0);
            if !(1..=100_000).contains(&pixels) { return json!({"mode":"original"}); }
            let mut size = json!({"mode":"long-edge","pixels":pixels});
            if let Some(flag) = value.get("neverUpscale").and_then(Value::as_bool) { size["neverUpscale"] = json!(flag); }
            size
        }
        Some("fit") => {
            let width = value.get("width").and_then(Value::as_u64).unwrap_or(0);
            let height = value.get("height").and_then(Value::as_u64).unwrap_or(0);
            if !(1..=100_000).contains(&width) || !(1..=100_000).contains(&height) { return json!({"mode":"original"}); }
            let mut size = json!({"mode":"fit","width":width,"height":height});
            if let Some(flag) = value.get("neverUpscale").and_then(Value::as_bool) { size["neverUpscale"] = json!(flag); }
            size
        }
        _ => json!({"mode":"original"}),
    }
}

fn normalize_export(input: &Value) -> Value {
    let format = input.get("format").and_then(Value::as_str).filter(|v| matches!(*v,"jpeg"|"png"|"webp"|"avif"|"tiff")).unwrap_or("jpeg");
    let quality = input.get("quality").and_then(Value::as_u64).filter(|n| (1..=100).contains(n)).unwrap_or(90);
    let metadata = input.get("metadata").and_then(Value::as_str).filter(|v| matches!(*v,"none"|"copyright")).unwrap_or("all");
    let suffix = input.get("suffix").and_then(Value::as_str).filter(|v| v.len() <= 200 && !v.contains(['\0','/','\\']) && !v.contains("..")).unwrap_or("-darkroom");
    let conflict = input.get("conflict").and_then(Value::as_str).filter(|v| matches!(*v,"rename"|"skip"|"replace")).unwrap_or("rename");
    json!({"format":format,"quality":quality,"metadata":metadata,"includeLocation":input.get("includeLocation")==Some(&Value::Bool(true)),"lossless":input.get("lossless").and_then(Value::as_bool).unwrap_or(false),"size":valid_size(input.get("size").unwrap_or(&Value::Null)),"suffix":suffix,"conflict":conflict})
}

pub fn get_export_options(root: &Path) -> Result<Value, String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    Ok(normalize_export(&read(root)["exportOptions"]))
}

pub fn set_export_options(root: &Path, options: Value) -> Result<Value, String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut settings = read(root);
    let mut merged = normalize_export(&settings["exportOptions"]);
    if let Some(input) = options.as_object() { for (key, value) in input { merged[key] = value.clone(); } }
    settings["exportOptions"] = normalize_export(&merged);
    write(root, &settings)?;
    Ok(Value::Null)
}

const CLIPBOARD_GROUPS: &[&str] = &["basic","mixer","effects","tone-curves","camera-profile","crop","manual-masks","ai-masks","metadata"];

pub fn get_clipboard_groups(root: &Path) -> Result<Value, String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let groups = &read(root)["developClipboardGroups"];
    Ok(validate_groups(groups).unwrap_or_else(|_| json!(["basic","mixer","effects","tone-curves"])))
}

fn validate_groups(value: &Value) -> Result<Value, String> {
    let values = value.as_array().ok_or("Develop clipboard groups are invalid.")?;
    if values.is_empty() || values.len()>CLIPBOARD_GROUPS.len() { return Err("Develop clipboard groups are invalid.".into()); }
    let mut seen = std::collections::HashSet::new();
    for item in values {
        let name = item.as_str().ok_or("Develop clipboard groups are invalid.")?;
        if !CLIPBOARD_GROUPS.contains(&name) || !seen.insert(name) { return Err("Develop clipboard groups are invalid.".into()); }
    }
    Ok(value.clone())
}

pub fn set_clipboard_groups(root: &Path, groups: Value) -> Result<Value, String> {
    let groups = validate_groups(&groups)?;
    let _guard = SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    let mut settings = read(root);
    settings["developClipboardGroups"] = groups;
    write(root, &settings)?;
    Ok(Value::Null)
}
