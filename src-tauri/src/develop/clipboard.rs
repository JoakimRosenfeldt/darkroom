use std::{collections::HashSet, sync::Mutex};
use serde_json::{Value, json};
use super::{assets, presets, store_io};

const PREFIX: &str = "DARKROOM-DEVELOP-SETTINGS/1\n";
static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

pub fn validate(value: &Value) -> Result<(), String> {
    fn visit(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
        *nodes += 1;
        if depth > 16 || *nodes > 100_000 { return Err("Develop clipboard data exceeds structural limits.".into()); }
        match value {
            Value::String(s) if s.encode_utf16().count() > 4096 || s.contains('\0') => return Err("Develop clipboard string is invalid.".into()),
            Value::Array(values) => for child in values { visit(child, depth + 1, nodes)?; },
            Value::Object(values) => for (key, child) in values {
                if key.is_empty() || key.encode_utf16().count() > 256 || key.contains('\0') || matches!(key.as_str(), "__proto__"|"prototype"|"constructor") { return Err("Develop clipboard key is invalid.".into()); }
                visit(child, depth + 1, nodes)?;
            },
            _ => (),
        }
        Ok(())
    }
    visit(value, 0, &mut 0)?;
    if value.to_string().len() > 2 * 1024 * 1024 { return Err("Develop clipboard data exceeds the byte limit.".into()); }
    store_io::object_keys(value, &["schemaVersion","source","document","createdAt","selectedGroups","payload","assetRefs","metadata"])?;
    if value["schemaVersion"] != 1 { return Err("Develop clipboard version is unsupported.".into()); }
    store_io::object_keys(&value["source"], &["catalogId","entryId","sourceId","assetId","assetRevision","size","lastModified"])?;
    for key in ["catalogId","entryId","sourceId","assetId"] { uuid::Uuid::parse_str(store_io::text(&value["source"], key)?).map_err(|_| "Develop clipboard source ID is invalid.")?; }
    for (object, key) in [(&value["source"], "assetRevision"),(&value["source"], "size"),(value,"createdAt")] {
        if !object[key].as_f64().is_some_and(|n| n >= 0.0 && n <= 9_007_199_254_740_991.0 && n.fract() == 0.0) { return Err("Develop clipboard number is invalid.".into()); }
    }
    if !value["source"]["lastModified"].as_f64().is_some_and(|n| n >= 0.0 && n <= 9_007_199_254_740_991.0) { return Err("Develop clipboard modified time is invalid.".into()); }
    store_io::object_keys(&value["document"], &["process","schemaRevision"])?;
    if value["document"]["process"] != "darkroom-v3" || value["document"]["schemaRevision"] != "darkroom-v3-document-2" { return Err("Develop clipboard process is unsupported.".into()); }
    let groups = value["selectedGroups"].as_array().filter(|v| !v.is_empty() && v.len() <= 9).ok_or("Develop clipboard groups are invalid.")?;
    let mut seen = HashSet::new();
    for group in groups {
        let group = group.as_str().ok_or("Develop clipboard group is invalid.")?;
        if !["basic","mixer","effects","tone-curves","camera-profile","crop","manual-masks","ai-masks","metadata"].contains(&group) || !seen.insert(group) { return Err("Develop clipboard groups are invalid.".into()); }
    }
    let fields: Vec<_> = groups.iter().filter(|v| **v != "metadata").cloned().collect();
    if fields.is_empty() {
        if value["payload"] != json!([]) { return Err("Metadata clipboard must have an empty Develop payload.".into()); }
    } else {
        presets::validate(&json!({"schemaVersion":1,"presetId":"00000000-0000-4000-8000-000000000001","revision":1,"name":"Clipboard","author":"Darkroom","category":"Clipboard","source":"user","favorite":false,"fields":fields,"payload":value["payload"],"compatibility":{"process":"darkroom-v3","documentSchemaRevision":"darkroom-v3-document-2"}}))?;
    }
    let payload = value["payload"].as_array().ok_or("Develop clipboard payload is invalid.")?;
    for entry in payload.iter().filter(|entry| entry["field"] == "tone-curves") {
        for channel in ["rgb","red","green","blue"] {
            let points = entry["value"][channel].as_array().ok_or("Develop clipboard curves are invalid.")?;
            if points.len() != 256 || points.iter().enumerate().any(|(i,p)| p["x"].as_f64() != Some(i as f64 / 255.0)) { return Err("Develop clipboard curves require 256 normalized samples.".into()); }
        }
    }
    let refs = value["assetRefs"].as_array().filter(|v| v.len() <= 256).ok_or("Develop clipboard asset references are invalid.")?;
    let mut ids=HashSet::new();
    for reference in refs {
        store_io::object_keys(reference,&["assetId","kind","sha256","producerRevision","coordinateFrameRevision","colorStageId"])?;
        assets::validate_ref(reference)?;
        if !ids.insert(reference["assetId"].as_str().ok_or("Develop clipboard asset address is invalid.")?) { return Err("Develop clipboard asset references contain duplicates.".into()) }
    }
    let expected: Vec<_> = payload.iter().filter(|entry|entry["field"]=="ai-masks").flat_map(|entry| entry["value"]["assetRefs"].as_array().into_iter().flatten().cloned()).collect();
    if *refs != expected { return Err("Develop clipboard asset references do not match its payload.".into()); }
    let metadata = &value["metadata"];
    if seen.contains("metadata") != !metadata.is_null() { return Err("Develop clipboard metadata does not match selected groups.".into()); }
    if !metadata.is_null() {
        store_io::object_keys(metadata, &["pick","rating","colorLabel"])?;
        if !metadata["pick"].as_str().is_some_and(|v|["none","pick","reject"].contains(&v)) || !metadata["rating"].as_u64().is_some_and(|v|v <= 5) || !(metadata["colorLabel"].is_null() || metadata["colorLabel"].as_str().is_some_and(|v|["red","yellow","green","blue","purple"].contains(&v))) { return Err("Develop clipboard metadata is invalid.".into()); }
    }
    Ok(())
}

fn with_clipboard<T>(work: impl FnOnce(&mut arboard::Clipboard) -> Result<T,String>) -> Result<T,String> {
    let mut guard = CLIPBOARD.lock().map_err(|_| "Clipboard is unavailable.")?;
    if guard.is_none() { *guard = Some(arboard::Clipboard::new().map_err(|e|e.to_string())?); }
    work(guard.as_mut().unwrap())
}

pub fn write_payload(value: &Value) -> Result<(), String> {
    validate(value)?;
    let text = format!("{PREFIX}{}", crate::catalog::history::js_stringify(value));
    with_clipboard(|clipboard| clipboard.set_text(text).map_err(|e|e.to_string()))
}

pub fn read() -> Result<Value, String> {
    let text = with_clipboard(|clipboard| match clipboard.get_text() { Ok(text)=>Ok(text), Err(arboard::Error::ContentNotAvailable)=>Ok(String::new()), Err(e)=>Err(e.to_string()) })?;
    if text.is_empty() { return Ok(json!({"kind":"empty"})); }
    let result = (|| {
        if text.len() > 2 * 1024 * 1024 + PREFIX.len() { return Err("Develop clipboard data exceeds the byte limit.".to_owned()); }
        let raw = text.strip_prefix(PREFIX).ok_or("Clipboard does not contain Darkroom Develop settings.")?;
        let value: Value = serde_json::from_str(raw).map_err(|_| "Develop clipboard data is not valid JSON.")?;
        validate(&value)?;
        Ok(value)
    })();
    Ok(match result { Ok(payload)=>json!({"kind":"ready","payload":payload}), Err(reason)=>json!({"kind":"invalid","reason":reason.chars().take(512).collect::<String>()}) })
}

pub fn read_payload() -> Result<Value,String> {
    let result = read()?;
    if result["kind"] == "ready" { Ok(result["payload"].clone()) } else { Err(result["reason"].as_str().unwrap_or("The clipboard has no Develop settings.").into()) }
}
