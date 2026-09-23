use super::*;
use crate::develop::store_io;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::sync::{Condvar, atomic::Ordering};

pub(super) struct StoredDraft {
    plan: Value,
    view: Value,
    expires: i64,
    cancelled: Arc<AtomicBool>,
}
#[derive(Clone)]
pub(super) struct ImportJob {
    cancelled: Arc<AtomicBool>,
    result: Arc<(Mutex<Option<Result<Value, String>>>, Condvar)>,
}
pub struct ImportTask(ImportJob);
impl ImportTask {
    pub fn wait(self) -> Result<Value, String> {
        let (lock, ready) = &*self.0.result;
        let mut result = lock.lock().map_err(|_| "Import result lock failed.")?;
        while result.is_none() {
            result = ready
                .wait(result)
                .map_err(|_| "Import result lock failed.")?;
        }
        result.clone().unwrap()
    }
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn canonical(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!("{}:{}", json!(key), canonical(&object[*key])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => history::js_stringify(value),
    }
}
fn uuid(value: &Value, key: &str) -> Result<(), String> {
    Uuid::parse_str(string(value, key)?).map_err(|_| "Import identity is invalid.".to_string())?;
    Ok(())
}
fn relative(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains(['\\', '\0'])
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("Import relative path is invalid.".into());
    }
    Ok(())
}
fn checked_path(root: &Path, path: &str, create_parents: bool) -> Result<PathBuf, String> {
    relative(path)?;
    if fs::canonicalize(root).map_err(|_| "Import root is unavailable.")? != root {
        return Err("Import root changed.".into());
    }
    let mut result = root.to_path_buf();
    let components = path.split('/').collect::<Vec<_>>();
    for (index, part) in components.iter().enumerate() {
        result.push(part);
        match fs::symlink_metadata(&result) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Import path is symlinked.".into());
            }
            Ok(metadata) if index + 1 < components.len() && !metadata.is_dir() => {
                return Err("Import parent is not a directory.".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if create_parents && index + 1 < components.len() {
                    fs::create_dir(&result).map_err(|_| "Import folder could not be created.")?;
                }
            }
            Err(_) => return Err("Import path is unavailable.".into()),
        }
    }
    Ok(result)
}
fn root_path(service: &CatalogService, catalog: &str, root: &str) -> Result<PathBuf, String> {
    let row = one(
        service.db()?,
        "SELECT canonical_path AS path,health FROM roots WHERE catalog_id=? AND root_id=?",
        vec![SqlValue::Text(catalog.into()), SqlValue::Text(root.into())],
    )?
    .ok_or("Import root is missing.")?;
    if row["health"] != "online" {
        return Err("Import root is offline.".into());
    }
    Ok(PathBuf::from(string(&row, "path")?))
}
fn observation(path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Import source is unavailable.")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Import source is not a regular file.".into());
    }
    Ok(fingerprint::file_observation(&metadata))
}
fn read_file(path: &Path) -> Result<fs::File, String> {
    let expected = observation(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "Import source could not be opened.")?;
    if !fingerprint::same_stat(
        &expected,
        &fingerprint::file_observation(&file.metadata().map_err(|_| "Import source stat failed.")?),
    ) {
        return Err("Import source changed before open.".into());
    }
    Ok(file)
}
fn file_hash(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let mut file = read_file(path)?;
    let before =
        fingerprint::file_observation(&file.metadata().map_err(|_| "Import source stat failed.")?);
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Import was cancelled.".into());
        }
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Import source read failed.")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if !fingerprint::same_stat(&before, &observation(path)?)
        || !fingerprint::same_stat(
            &before,
            &fingerprint::file_observation(
                &file.metadata().map_err(|_| "Import source stat failed.")?,
            ),
        )
    {
        return Err("Import source changed while reading.".into());
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn format_id(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("jpeg"),
        "png" => Some("png"),
        "webp" => Some("webp"),
        "nef" => Some("nef"),
        "dng" => Some("dng"),
        "cr2" => Some("cr2"),
        "cr3" => Some("cr3"),
        "arw" => Some("arw"),
        "raf" => Some("raf"),
        "orf" => Some("orf"),
        "rw2" => Some("rw2"),
        "heic" | "heif" | "hif" => Some("heif"),
        "tif" | "tiff" => Some("tiff"),
        "psd" | "psb" => Some("psd"),
        "jxl" => Some("jxl"),
        "mp4" | "mov" | "avi" | "mkv" | "m4v" => Some("video"),
        _ => None,
    }
}
fn xmp_path(relative: &str) -> String {
    Path::new(relative)
        .with_extension("xmp")
        .to_string_lossy()
        .into_owned()
}
pub(super) fn render(
    pattern: &str,
    source: &Value,
    asset: Option<&Value>,
) -> Result<String, String> {
    if pattern.is_empty() || pattern.len() > 512 {
        return Err("Import template is invalid.".into());
    }
    let path = Path::new(string(source, "relativePath")?);
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Import source filename is invalid.")?;
    use chrono::{Datelike, TimeZone};
    let date = chrono::Local
        .timestamp_millis_opt(
            source["observation"]["modifiedAt"]
                .as_f64()
                .unwrap_or(now() as f64) as i64,
        )
        .single()
        .ok_or("Import date is invalid.")?;
    let (year, month, day) = (date.year(), date.month(), date.day());
    let tokens = HashMap::from([
        ("filename", filename.to_string()),
        ("original", filename.to_string()),
        (
            "stem",
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(filename)
                .to_string(),
        ),
        (
            "extension",
            path.extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string(),
        ),
        (
            "cameraMake",
            asset
                .and_then(|a| a["cameraMake"].as_str())
                .unwrap_or("Unknown")
                .to_string(),
        ),
        (
            "cameraModel",
            asset
                .and_then(|a| a["cameraModel"].as_str())
                .unwrap_or("Unknown")
                .to_string(),
        ),
        ("sequence", "0001".into()),
        ("year", format!("{year:04}")),
        ("month", format!("{month:02}")),
        ("day", format!("{day:02}")),
    ]);
    let mut output = String::new();
    let mut rest = pattern;
    while let Some(index) = rest.find("{{") {
        output.push_str(&rest[..index]);
        let after = &rest[index + 2..];
        let end = after
            .find("}}")
            .ok_or("Import template contains an unmatched token.")?;
        let key = &after[..end];
        let value = tokens
            .get(key)
            .ok_or("Import template contains an unknown token.")?;
        output.push_str(value.replace(['/', '\\', '\0'], "_").trim());
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    if output.contains("}}") {
        return Err("Import template contains an unmatched token.".into());
    }
    let output = output.replace('\\', "/");
    relative(&output)?;
    Ok(output)
}
pub(super) fn freeze(mut plan: Value) -> Value {
    let preset = plan["preset"].clone();
    let serialized = canonical(&preset);
    plan["preset"] = json!({"catalogId":preset["catalogId"],"presetId":preset["presetId"],"name":preset["name"],"version":preset["version"],"canonicalJson":serialized,"sha256":sha(serialized.as_bytes())});
    plan["planSha256"] = json!(sha(canonical(&plan).as_bytes()));
    plan
}
pub(super) fn verify(plan: &Value) -> Result<(), String> {
    for key in ["catalogId", "operationId", "destinationRootId"] {
        uuid(plan, key)?;
    }
    let mut unhashed = plan.clone();
    unhashed
        .as_object_mut()
        .ok_or("Import plan is invalid.")?
        .remove("planSha256");
    if plan["planSha256"] != sha(canonical(&unhashed).as_bytes()) {
        return Err("Frozen import plan hash does not match.".into());
    }
    let preset_json = string(&plan["preset"], "canonicalJson")?;
    let preset: Value =
        serde_json::from_str(preset_json).map_err(|_| "Frozen preset is invalid.")?;
    if canonical(&preset) != preset_json || plan["preset"]["sha256"] != sha(preset_json.as_bytes())
    {
        return Err("Frozen preset hash does not match.".into());
    }
    let items = plan["items"]
        .as_array()
        .ok_or("Frozen import items are invalid.")?;
    if items.is_empty() || items.len() > 500 {
        return Err("Frozen import item count is invalid.".into());
    }
    let mut seen = HashSet::new();
    for item in items {
        for key in ["itemId", "destinationAssetId"] {
            uuid(item, key)?;
        }
        if !seen.insert(string(item, "itemId")?) {
            return Err("Frozen import item identity is duplicated.".into());
        }
        uuid(&item["source"], "rootId")?;
        relative(string(&item["source"], "relativePath")?)?;
        relative(string(item, "destinationRelativePath")?)?;
        if !matches!(
            item["action"].as_str(),
            Some("add" | "copy" | "move" | "rename")
        ) {
            return Err("Frozen import action is invalid.".into());
        }
        if matches!(item["action"].as_str(), Some("move" | "rename"))
            && !item["sourceAssetId"].is_null()
            && item["sourceAssetId"] != item["destinationAssetId"]
        {
            return Err("Move must retain its source identity.".into());
        }
        if let Some(xmp) = item["xmpDestinationRelativePath"].as_str() {
            relative(xmp)?;
            if xmp != xmp_path(string(item, "destinationRelativePath")?) {
                return Err("Frozen import sidecar path is invalid.".into());
            }
        }
    }
    Ok(())
}
impl CatalogService {
    pub(super) fn import_dispatch(&mut self, command: &str, args: &Value) -> Result<Value, String> {
        let request = first(args)?;
        self.require_session(request)?;
        self.import_drafts.retain(|_, draft| draft.expires > now());
        if command == "darkroom:catalog-import-prepare" {
            let selected = rfd::FileDialog::new()
                .set_title("Select photos to import")
                .pick_files()
                .ok_or("No import files were selected.")?;
            return self.prepare_import(request, &selected);
        }
        let operation = string(request, "operationId")?;
        if command == "darkroom:catalog-import-cancel" {
            if let Some(draft) = self.import_drafts.get(operation) {
                draft.cancelled.store(true, Ordering::SeqCst);
            }
            if let Some(job) = self.import_jobs.get(operation) {
                job.cancelled.store(true, Ordering::SeqCst);
            }
            return Ok(Value::Null);
        }
        let draft = self
            .import_drafts
            .get(operation)
            .ok_or("Import draft expired or is unavailable.")?;
        if draft.view["catalogId"] != request["catalogId"]
            || draft.view["sessionId"] != request["sessionId"]
        {
            return Err("Import draft belongs to another session.".into());
        }
        Ok(draft.view.clone())
    }
    pub(super) fn prepare_import(
        &mut self,
        request: &Value,
        selected: &[PathBuf],
    ) -> Result<Value, String> {
        self.require_session(request)?;
        if selected.is_empty() || selected.len() > 500 {
            return Err("Select between one and 500 import files.".into());
        }
        let catalog = string(request, "catalogId")?;
        let action = string(request, "action")?;
        if !matches!(action, "add" | "copy" | "move") {
            return Err("Import action is invalid.".into());
        }
        let duplicate_policy = string(request, "duplicatePolicy")?;
        let destination_policy = string(request, "destinationPolicy")?;
        if !matches!(
            duplicate_policy,
            "skip-incoming" | "continue-unchecked" | "keep-both"
        ) || !matches!(destination_policy, "skip" | "replace" | "rename")
        {
            return Err("Import conflict policy is invalid.".into());
        }
        let destination = root_path(self, catalog, string(request, "destinationRootId")?)?;
        let state = self.query(&json!({"catalogId":catalog}))?;
        let roots = rows(
            self.db()?,
            "SELECT root_id AS rootId,canonical_path AS path,health FROM roots WHERE catalog_id=?",
            vec![SqlValue::Text(catalog.into())],
        )?;
        let preset = if request["presetId"].is_null() {
            json!({"catalogId":catalog,"presetId":Uuid::new_v4().to_string(),"name":"Default import","version":1,"template":{"pattern":"{{filename}}"},"payload":{"metadata":{"keywords":[]}},"updatedAt":now()})
        } else {
            let row = state["presets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["presetId"] == request["presetId"])
                .ok_or("Import preset is unavailable.")?;
            json!({"catalogId":catalog,"presetId":row["presetId"],"name":row["name"],"version":row["revision"],"template":row["template"],"payload":row["payload"],"updatedAt":row["updatedAt"]})
        };
        let assets = state["assets"]
            .as_array()
            .ok_or("Import catalog assets are invalid.")?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let operation = Uuid::new_v4().to_string();
        let mut sources = Vec::new();
        let mut views = Vec::new();
        let mut can_run = true;
        let mut selected_paths = HashSet::new();
        for selected_path in selected {
            if !selected_path.is_absolute() {
                return Err("Import selection must use absolute paths.".into());
            }
            let canonical =
                fs::canonicalize(selected_path).map_err(|_| "Import selection is unavailable.")?;
            if canonical != *selected_path {
                return Err("Import selection contains a symlink or noncanonical path.".into());
            }
            let selected_path = canonical;
            if !selected_paths.insert(selected_path.clone()) {
                continue;
            }
            let root = roots
                .iter()
                .filter(|root| root["health"] == "online")
                .filter_map(|root| {
                    let path = PathBuf::from(root["path"].as_str()?);
                    selected_path.strip_prefix(&path).ok().map(|relative| {
                        (
                            root,
                            path.clone(),
                            relative.to_string_lossy().replace('\\', "/"),
                        )
                    })
                })
                .max_by_key(|(_, path, _)| path.components().count())
                .ok_or("Import files must belong to an active catalog root.")?;
            let path = checked_path(&root.1, &root.2, false)?;
            let observed = observation(&path)?;
            let asset = assets.iter().find(|asset| {
                asset["rootId"] == root.0["rootId"]
                    && asset["relativePath"] == root.2
                    && asset["entryKind"] == "original"
            });
            if let Some(asset) = asset {
                let expected = json!({"size":asset["observation"]["byteLength"],"modifiedAt":asset["observation"]["modifiedAt"],"localFileId":asset["observation"]["localFileId"]});
                if asset["health"] != "present" || !fingerprint::same_stat(&expected, &observed) {
                    return Err("Import source observation is stale; scan the folder again.".into());
                }
            } else if action != "add" {
                can_run = false;
            }
            let format = format_id(&path).unwrap_or("unknown");
            let supported = matches!(format, "jpeg" | "png" | "webp" | "nef");
            if !supported {
                can_run = false;
            }
            let xmp = checked_path(&root.1, &xmp_path(&root.2), false)?;
            let xmp_state = match fs::symlink_metadata(&xmp) {
                Ok(meta) if meta.is_file() && read_file(&xmp).is_ok() => "present",
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => "absent",
                _ => {
                    can_run = false;
                    "unreadable"
                }
            };
            let source = json!({"rootId":root.0["rootId"],"relativePath":root.2,"observation":observed,"xmpState":xmp_state,"formatId":format});
            let dest_relative = if action == "add" {
                root.2.clone()
            } else {
                render(string(&preset["template"], "pattern")?, &source, asset)?
            };
            let item = json!({"itemId":Uuid::new_v4().to_string(),"sourceAssetId":asset.map(|a|a["assetId"].clone()),"destinationAssetId":if action=="copy" || asset.is_none(){json!(Uuid::new_v4().to_string())}else{asset.unwrap()["assetId"].clone()},"action":action,"source":source,"destinationRelativePath":dest_relative,"xmpDestinationRelativePath":if xmp_state=="present"{json!(xmp_path(&dest_relative))}else{Value::Null},"conflictDecisions":{"duplicate":null,"destination":null}});
            let view = json!({"itemId":item["itemId"],"sourceName":path.file_name().unwrap_or_default().to_string_lossy(),"sourceRelativePath":root.2,"destinationRelativePath":dest_relative,"formatId":format,"duplicate":"unique","destinationConflict":false,"outcome":if supported{"run"}else{"skip"}});
            views.push(view);
            sources.push((item, path, supported));
        }
        let mut hashes = HashMap::new();
        for (item, path, _) in &sources {
            hashes.insert(
                item["itemId"].as_str().unwrap().to_string(),
                file_hash(path, &cancelled),
            );
        }
        let mut reserved = HashSet::new();
        let mut items = Vec::new();
        for (index, (mut item, source_path, supported)) in sources.into_iter().enumerate() {
            if !supported {
                continue;
            }
            let hash = hashes.get(item["itemId"].as_str().unwrap()).unwrap();
            let mut duplicate = false;
            let mut unchecked = hash.is_err();
            if let Ok(hash) = hash {
                duplicate = hashes.iter().any(|(id, candidate)| {
                    id != item["itemId"].as_str().unwrap()
                        && candidate.as_ref().is_ok_and(|v| v == hash)
                });
                let mut checked = HashSet::new();
                for asset in assets {
                    if asset["assetId"] == item["sourceAssetId"]
                        || !checked.insert(asset["assetId"].clone().to_string())
                        || asset["observation"]["byteLength"]
                            != item["source"]["observation"]["size"]
                    {
                        continue;
                    }
                    let candidate = (|| -> Result<String, String> {
                        let root = root_path(self, catalog, string(asset, "rootId")?)?;
                        let path = checked_path(&root, string(asset, "relativePath")?, false)?;
                        let expected = json!({"size":asset["observation"]["byteLength"],"modifiedAt":asset["observation"]["modifiedAt"],"localFileId":asset["observation"]["localFileId"]});
                        if !fingerprint::same_stat(&expected, &observation(&path)?) {
                            return Err("Import duplicate observation is stale.".into());
                        }
                        file_hash(&path, &cancelled)
                    })();
                    match candidate {
                        Ok(value) if value == *hash => duplicate = true,
                        Err(_) => unchecked = true,
                        _ => {}
                    }
                }
            }
            let duplicate_state = if duplicate {
                "duplicate"
            } else if unchecked {
                "not-fully-checked"
            } else {
                "unique"
            };
            views[index]["duplicate"] = json!(duplicate_state);
            if duplicate || unchecked {
                if (duplicate && duplicate_policy == "continue-unchecked")
                    || (!duplicate && duplicate_policy == "keep-both")
                {
                    can_run = false;
                } else {
                    item["conflictDecisions"]["duplicate"] = json!({"kind":duplicate_policy});
                }
            }
            let dest_relative = string(&item, "destinationRelativePath")?.to_string();
            let dest_path = checked_path(&destination, &dest_relative, false)?;
            let occupied = |relative: &str| -> Result<bool, String> {
                Ok(checked_path(&destination, relative, false)?.exists()
                    || checked_path(&destination, &xmp_path(relative), false)?.exists()
                    || assets.iter().any(|a| {
                        a["rootId"] == request["destinationRootId"] && a["relativePath"] == relative
                    }))
            };
            let conflict = action != "add"
                && (dest_path == source_path
                    || reserved.contains(&dest_relative)
                    || occupied(&dest_relative)?);
            views[index]["destinationConflict"] = json!(conflict);
            if conflict {
                match destination_policy {
                    "skip" => item["conflictDecisions"]["destination"] = json!({"kind":"skip"}),
                    "replace" => {
                        item["conflictDecisions"]["destination"] = json!({"kind":"replace"});
                        can_run = false;
                    }
                    "rename" => {
                        let path = Path::new(&dest_relative);
                        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
                        let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                        let mut renamed = None;
                        for number in 1..=500 {
                            let name = format!(
                                "{stem} ({number}){}",
                                if extension.is_empty() {
                                    String::new()
                                } else {
                                    format!(".{extension}")
                                }
                            );
                            let relative = path.with_file_name(name).to_string_lossy().into_owned();
                            if !reserved.contains(&relative) && !occupied(&relative)? {
                                renamed = Some(relative);
                                break;
                            }
                        }
                        let renamed = renamed
                            .ok_or("Import could not find an available destination name.")?;
                        item["destinationRelativePath"] = json!(renamed);
                        views[index]["destinationRelativePath"] = json!(renamed);
                        if !item["xmpDestinationRelativePath"].is_null() {
                            item["xmpDestinationRelativePath"] = json!(xmp_path(&renamed));
                        }
                        item["conflictDecisions"]["destination"] =
                            json!({"kind":"rename","destinationRelativePath":renamed});
                    }
                    _ => unreachable!(),
                }
            }
            let skip = item["conflictDecisions"]["duplicate"]["kind"] == "skip-incoming"
                || item["conflictDecisions"]["destination"]["kind"] == "skip";
            views[index]["outcome"] = json!(if skip {
                "skip"
            } else if conflict {
                destination_policy
            } else {
                "run"
            });
            if !skip {
                if !reserved.insert(string(&item, "destinationRelativePath")?.to_string()) {
                    can_run = false;
                }
            }
            items.push(item);
        }
        if items.is_empty() {
            can_run = false;
        }
        let view = json!({"catalogId":catalog,"sessionId":request["sessionId"],"operationId":operation,"action":action,"presetName":preset["name"],"items":views,"canRun":can_run,"copyAsDng":{"status":"unavailable","reason":"DNG import is unavailable until a conversion backend exists."}});
        let plan = freeze(
            json!({"operationId":operation,"catalogId":catalog,"destinationRootId":request["destinationRootId"],"preset":preset,"items":items,"createdAt":now()}),
        );
        self.import_drafts.insert(
            operation,
            StoredDraft {
                plan,
                view: view.clone(),
                expires: now() + 15 * 60 * 1000,
                cancelled,
            },
        );
        Ok(view)
    }
    pub fn begin_import(&mut self, request: &Value) -> Result<ImportTask, String> {
        self.require_session(request)?;
        let operation = string(request, "operationId")?.to_string();
        if let Some(job) = self.import_jobs.get(&operation) {
            return Ok(ImportTask(job.clone()));
        }
        let (plan, cancelled) = if let Some(draft) = self.import_drafts.get(&operation) {
            if draft.expires < now()
                || draft.view["sessionId"] != request["sessionId"]
                || draft.view["catalogId"] != request["catalogId"]
            {
                return Err("Import draft expired or belongs to another session.".into());
            }
            if draft.view["canRun"] != true && !draft.cancelled.load(Ordering::SeqCst) {
                return Err("Import plan has blocking conflicts.".into());
            }
            (draft.plan.clone(), draft.cancelled.clone())
        } else {
            let row = one(self.db()?, "SELECT payload_json AS payload FROM operations WHERE catalog_id=? AND operation_id=? AND kind='import'", values(&[&request["catalogId"], &request["operationId"]]))?.ok_or("Import operation is unavailable.")?;
            let payload: Value = serde_json::from_str(string(&row, "payload")?)
                .map_err(|_| "Persisted import operation is invalid.")?;
            (payload["plan"].clone(), Arc::new(AtomicBool::new(false)))
        };
        if cancelled.load(Ordering::SeqCst) {
            let items = plan["items"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| {
                            let mut result = initial_result(item);
                            result["status"] = json!("cancelled");
                            result
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let result = json!({"catalogId":request["catalogId"],"sessionId":request["sessionId"],"operationId":operation,"state":"cancelled","items":items,"error":null});
            return Ok(ImportTask(ImportJob {
                cancelled,
                result: Arc::new((Mutex::new(Some(Ok(result))), Condvar::new())),
            }));
        }
        verify(&plan)?;
        if plan["catalogId"] != request["catalogId"] || plan["operationId"] != operation {
            return Err("Import plan belongs to another catalog.".into());
        }
        let job = ImportJob {
            cancelled: cancelled.clone(),
            result: Arc::new((Mutex::new(None), Condvar::new())),
        };
        self.import_jobs.insert(operation, job.clone());
        let database = self
            .active_path()
            .ok_or("No catalog is open.")?
            .to_path_buf();
        let user_data = self.user_data.clone();
        let result = job.result.clone();
        let session = request["sessionId"].clone();
        std::thread::spawn(move || {
            let outcome = (|| -> Result<Value, String> {
                let db = Connection::open(database)
                    .map_err(|_| "Import catalog could not be opened.")?;
                db.pragma_update(None, "foreign_keys", "ON")
                    .map_err(|e| e.to_string())?;
                db.busy_timeout(std::time::Duration::from_secs(10))
                    .map_err(|e| e.to_string())?;
                let mut service = CatalogService::for_worker(db);
                let mut execution = execute_plan(&mut service, &plan, &cancelled, &user_data)?;
                execution["catalogId"] = plan["catalogId"].clone();
                execution["sessionId"] = session;
                Ok(execution)
            })();
            let (lock, ready) = &*result;
            if let Ok(mut slot) = lock.lock() {
                *slot = Some(outcome);
                ready.notify_all();
            }
        });
        Ok(ImportTask(job))
    }
    pub(super) fn cancel_imports(&mut self) {
        for draft in self.import_drafts.values() {
            draft.cancelled.store(true, Ordering::SeqCst);
        }
        for job in self.import_jobs.values() {
            job.cancelled.store(true, Ordering::SeqCst);
        }
        for job in self.import_jobs.values() {
            let _ = ImportTask(job.clone()).wait();
        }
        self.import_drafts.clear();
        self.import_jobs.clear();
    }
    pub(super) fn recover_imports(&mut self) -> Result<(), String> {
        let Some(active) = self.active.clone() else {
            return Ok(());
        };
        let pending = rows(
            self.db()?,
            "SELECT operation_id AS operationId FROM operations WHERE catalog_id=? AND kind='import' AND state IN ('planned','running') ORDER BY created_at",
            vec![SqlValue::Text(active.catalog_id.clone())],
        )?;
        for operation in pending {
            self.begin_import(&json!({"catalogId":active.catalog_id,"sessionId":active.session_id,"operationId":operation["operationId"]}))?;
        }
        Ok(())
    }
}
fn apply(service: &mut CatalogService, catalog: &str, mutations: Vec<Value>) -> Result<(), String> {
    for _ in 0..8 {
        let revision = service.revision(catalog)?;
        match service
            .apply(&json!({"catalogId":catalog,"expectedRevision":revision,"mutations":mutations}))
        {
            Ok(_) => return Ok(()),
            Err(error) if error.contains("revision") && error.contains("stale") => continue,
            Err(error) => return Err(error),
        }
    }
    Err("Import catalog stayed busy.".into())
}
fn operation_mutation(plan: &Value, state: &str, error: Value) -> Value {
    json!({"kind":"operation-upsert","operation":{"operationId":plan["operationId"],"kind":"import","state":state,"payload":{"version":1,"kind":"import","planHash":plan["planSha256"],"plan":plan,"error":error},"createdAt":plan["createdAt"],"updatedAt":now()}})
}
fn item_mutation(plan: &Value, item: &Value, result: &Value) -> Value {
    let applied = result["status"] != "skipped"
        && matches!(
            result["stage"].as_str(),
            Some("catalog-applied" | "source-cleaned")
        );
    json!({"kind":"operation-item-upsert","item":{"operationId":plan["operationId"],"itemId":item["itemId"],"assetId":if applied{item["destinationAssetId"].clone()}else{Value::Null},"state":if result["status"]=="skipped"{json!("completed")}else{result["status"].clone()},"payload":{"version":1,"stage":result["stage"],"action":item["action"],"sourceRootId":item["source"]["rootId"],"sourceRelativePath":item["source"]["relativePath"],"destinationRootId":plan["destinationRootId"],"destinationRelativePath":item["destinationRelativePath"],"xmpStatus":result["xmpStatus"],"status":result["status"],"error":result["error"],"updatedAt":now()}}})
}
fn initial_result(item: &Value) -> Value {
    json!({"itemId":item["itemId"],"destinationAssetId":item["destinationAssetId"],"stage":"planned","status":"planned","xmpStatus":if item["source"]["xmpState"]=="present"{"preserved"}else{"absent"},"sourceRetained":true,"error":null})
}
fn persist_plan(service: &mut CatalogService, plan: &Value) -> Result<(), String> {
    let catalog = string(plan, "catalogId")?;
    if let Some(row) = one(
        service.db()?,
        "SELECT payload_json AS payload FROM operations WHERE catalog_id=? AND operation_id=?",
        values(&[&plan["catalogId"], &plan["operationId"]]),
    )? {
        let payload: Value = serde_json::from_str(string(&row, "payload")?)
            .map_err(|_| "Persisted import plan is invalid.")?;
        if payload["planHash"] != plan["planSha256"]
            || canonical(&payload["plan"]) != canonical(plan)
        {
            return Err("Persisted import plan does not match.".into());
        }
        return Ok(());
    }
    let db = service.db()?;
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let mutation = operation_mutation(plan, "planned", Value::Null);
        let op = &mutation["operation"];
        execute(
            db,
            "INSERT INTO operations(catalog_id,operation_id,kind,state,payload_json,revision,created_at,updated_at) VALUES (?,?,'import','planned',?,1,?,?)",
            values(&[
                &plan["catalogId"],
                &plan["operationId"],
                &op["payload"],
                &plan["createdAt"],
                &json!(now()),
            ]),
        )?;
        for item in plan["items"].as_array().unwrap() {
            let mutation = item_mutation(plan, item, &initial_result(item));
            execute(
                db,
                "INSERT INTO operation_items(catalog_id,operation_id,item_id,asset_id,state,payload_json) VALUES (?,?,?,NULL,'planned',?)",
                values(&[
                    &plan["catalogId"],
                    &plan["operationId"],
                    &item["itemId"],
                    &mutation["item"]["payload"],
                ]),
            )?;
        }
        execute(
            db,
            "UPDATE catalog_meta SET revision=revision+1,updated_at=? WHERE catalog_id=?",
            vec![SqlValue::Integer(now()), SqlValue::Text(catalog.into())],
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => db.execute_batch("COMMIT").map_err(|e| e.to_string()),
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
fn journal_path(user_data: &Path, plan: &Value, item: &Value) -> Result<PathBuf, String> {
    Ok(user_data
        .join("catalog-import-state")
        .join(string(plan, "catalogId")?)
        .join("file-transactions")
        .join(string(plan, "operationId")?)
        .join(format!("{}.json", string(item, "itemId")?)))
}
fn journal_write(path: &Path, record: &mut Value, stage: &str) -> Result<(), String> {
    record["stage"] = json!(stage);
    record["updatedAt"] = json!(now());
    store_io::atomic_json(
        path,
        &json!({"version":1,"kind":"darkroom-file-transaction-journal","record":record}),
        64 * 1024,
    )
}
fn staged_copy(
    source: &Path,
    destination: &Path,
    expected: &Value,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if !fingerprint::same_stat(expected, &observation(source)?) {
        return Err("Import source observation changed.".into());
    }
    if destination.exists() {
        if file_hash(source, cancel)? != file_hash(destination, cancel)? {
            return Err("Import staged file does not match its source.".into());
        }
        return Ok(());
    }
    let mut input = read_file(source)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "Import staged file could not be created.")?;
    let result = (|| -> Result<(), String> {
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("Import was cancelled.".into());
            }
            let count = input
                .read(&mut buffer)
                .map_err(|_| "Import source read failed.")?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|_| "Import destination write failed.")?;
        }
        output
            .sync_all()
            .map_err(|_| "Import destination sync failed.")?;
        if !fingerprint::same_stat(expected, &observation(source)?)
            || file_hash(source, cancel)? != file_hash(destination, cancel)?
        {
            return Err("Import copy verification failed.".into());
        }
        Ok(())
    })();
    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(destination);
    }
    result
}
fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::File::open(path.parent().ok_or("Import parent is missing.")?)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Import directory sync failed.")?;
    }
    Ok(())
}
fn publish(
    source: &Path,
    stage: &Path,
    destination: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if destination.exists() {
        if file_hash(source, cancel)? != file_hash(destination, cancel)? {
            return Err("Import destination already exists with different contents.".into());
        }
    } else {
        let staged = read_file(stage)?;
        let expected = fingerprint::file_observation(
            &staged.metadata().map_err(|_| "Import stage stat failed.")?,
        );
        if !fingerprint::same_stat(&expected, &observation(stage)?) {
            return Err("Import stage changed before publication.".into());
        }
        fs::hard_link(stage, destination)
            .map_err(|_| "Import destination could not be published without replacement.")?;
        if !fingerprint::same_stat(&expected, &observation(destination)?) {
            return Err("Import destination changed during publication.".into());
        }
        sync_parent(destination)?;
    }
    Ok(())
}
fn catalog_item(
    service: &mut CatalogService,
    plan: &Value,
    item: &Value,
    destination: &Path,
) -> Result<(), String> {
    let catalog = string(plan, "catalogId")?;
    let observed = observation(destination)?;
    let live_observed = json!({"byteLength":observed["size"],"modifiedAt":observed["modifiedAt"],"localFileId":observed["localFileId"],"observedAt":observed["observedAt"]});
    let root = if item["action"] == "add" {
        &item["source"]["rootId"]
    } else {
        &plan["destinationRootId"]
    };
    let existing = one(
        service.db()?,
        "SELECT root_id AS rootId,relative_path AS relativePath,observed_byte_length AS size,observed_modified_at AS modifiedAt,local_file_id AS localFileId FROM assets WHERE catalog_id=? AND asset_id=?",
        values(&[&plan["catalogId"], &item["destinationAssetId"]]),
    )?;
    if let Some(existing) = &existing {
        if existing["rootId"] == *root
            && existing["relativePath"] == item["destinationRelativePath"]
        {
            if !fingerprint::same_stat(existing, &observed) {
                return Err("Import catalog destination observation changed.".into());
            }
            return Ok(());
        }
    }
    let mutation = if item["action"] == "add" {
        json!({"kind":"reconcile","rootId":root,"complete":false,"observations":[{"assetId":item["destinationAssetId"],"relativePath":item["destinationRelativePath"],"observation":live_observed,"health":"present","formatId":item["source"]["formatId"],"cameraMake":null,"cameraModel":null,"lensModel":null}]})
    } else if item["action"] == "copy" {
        json!({"kind":"asset-copy","sourceAssetId":item["sourceAssetId"],"newAssetId":item["destinationAssetId"],"rootId":root,"relativePath":item["destinationRelativePath"],"observation":live_observed,"health":"present"})
    } else {
        json!({"kind":"asset-relocate","assetId":item["destinationAssetId"],"rootId":root,"relativePath":item["destinationRelativePath"],"observation":live_observed,"health":"present"})
    };
    apply(service, catalog, vec![mutation])
}
fn apply_metadata(service: &mut CatalogService, plan: &Value, item: &Value) -> Result<(), String> {
    let preset: Value = serde_json::from_str(string(&plan["preset"], "canonicalJson")?)
        .map_err(|_| "Import preset snapshot is invalid.")?;
    let payload = &preset["payload"];
    let metadata = payload
        .get("metadata")
        .filter(|m| m.is_object())
        .unwrap_or(payload);
    let keywords = metadata
        .get("keywords")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!([]));
    if !keywords
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
    {
        return Err("Import metadata keywords are invalid.".into());
    }
    let develop = payload
        .get("develop")
        .or_else(|| payload.get("developDefaults"))
        .or_else(|| metadata.get("develop"))
        .unwrap_or(&Value::Null);
    let mut patch = json!({"version":1,"title":metadata["title"],"caption":metadata["caption"],"copyright":metadata["copyright"],"keywordsJson":canonical(&keywords),"developJson":if develop.is_null(){Value::Null}else{json!(canonical(develop))},"developUpdatedAt":now(),"updatedAt":now()});
    for key in ["title", "caption", "copyright"] {
        if !patch[key].is_null() && !patch[key].is_string() {
            return Err("Import metadata text is invalid.".into());
        }
    }
    // Do not reset edits when recovering an already-completed import item.
    patch["updatedAt"] = json!(now());
    apply(
        service,
        string(plan, "catalogId")?,
        vec![json!({"kind":"metadata-patch","assetId":item["destinationAssetId"],"patch":patch})],
    )
}
fn execute_item(
    service: &mut CatalogService,
    plan: &Value,
    item: &Value,
    cancel: &AtomicBool,
    user_data: &Path,
    result: &mut Value,
) -> Result<(), String> {
    if item["conflictDecisions"]["duplicate"]["kind"] == "skip-incoming"
        || item["conflictDecisions"]["destination"]["kind"] == "skip"
    {
        result["status"] = json!("skipped");
        result["stage"] = json!("catalog-applied");
        return Ok(());
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("Import was cancelled.".into());
    }
    let catalog = string(plan, "catalogId")?;
    let source_root = root_path(service, catalog, string(&item["source"], "rootId")?)?;
    let source = checked_path(
        &source_root,
        string(&item["source"], "relativePath")?,
        false,
    )?;
    if item["action"] == "add" {
        if !fingerprint::same_stat(&item["source"]["observation"], &observation(&source)?) {
            return Err("Import source observation changed.".into());
        }
        catalog_item(service, plan, item, &source)?;
        result["stage"] = json!("catalog-applied");
        apply_metadata(service, plan, item)?;
        result["status"] = json!("completed");
        return Ok(());
    }
    if item["conflictDecisions"]["destination"]["kind"] == "replace" {
        return Err("Import replacement requires explicit review before execution.".into());
    }
    let destination_root = root_path(service, catalog, string(plan, "destinationRootId")?)?;
    let destination = checked_path(
        &destination_root,
        string(item, "destinationRelativePath")?,
        true,
    )?;
    if source == destination {
        return Err("Import source and destination must differ.".into());
    }
    let stage = PathBuf::from(format!(
        "{}.darkroom-stage-{}-{}",
        destination.to_string_lossy(),
        string(plan, "operationId")?,
        string(item, "itemId")?
    ));
    let xmp_source = if item["source"]["xmpState"] == "present" {
        Some(checked_path(
            &source_root,
            &xmp_path(string(&item["source"], "relativePath")?),
            false,
        )?)
    } else {
        None
    };
    let xmp_dest = item["xmpDestinationRelativePath"]
        .as_str()
        .map(|path| checked_path(&destination_root, path, true))
        .transpose()?;
    let xmp_stage = xmp_dest.as_ref().map(|path| {
        PathBuf::from(format!(
            "{}.darkroom-stage-{}-{}",
            path.to_string_lossy(),
            string(plan, "operationId").unwrap(),
            string(item, "itemId").unwrap()
        ))
    });
    let journal = journal_path(user_data, plan, item)?;
    let mut expected = json!({"operationId":plan["operationId"],"itemId":item["itemId"],"action":item["action"],"destinationAssetId":item["destinationAssetId"],"stage":"planned","sourcePath":source,"destinationPath":destination,"xmpSourcePath":xmp_source,"xmpDestinationPath":xmp_dest,"imageStagePath":stage,"xmpStagePath":xmp_stage,"imageBackupPath":null,"xmpBackupPath":null,"imageBackupProof":null,"xmpBackupProof":null,"xmpStatus":result["xmpStatus"],"updatedAt":now()});
    let mut record = if journal.exists() {
        let envelope = store_io::read_json(&journal, 64 * 1024)?;
        if envelope["version"] != 1 || envelope["kind"] != "darkroom-file-transaction-journal" {
            return Err("Import transaction journal is invalid.".into());
        }
        let record = envelope["record"].clone();
        for key in [
            "operationId",
            "itemId",
            "action",
            "destinationAssetId",
            "sourcePath",
            "destinationPath",
            "xmpSourcePath",
            "xmpDestinationPath",
            "imageStagePath",
            "xmpStagePath",
        ] {
            if record[key] != expected[key] {
                return Err("Import transaction journal does not match its plan.".into());
            }
        }
        record
    } else {
        journal_write(&journal, &mut expected, "planned")?;
        expected
    };
    if !matches!(
        record["stage"].as_str(),
        Some(
            "planned"
                | "destination-prepared"
                | "destination-published"
                | "catalog-applied"
                | "source-cleaned"
        )
    ) {
        return Err("Import transaction stage is invalid.".into());
    }
    result["stage"] = record["stage"].clone();
    if record["stage"] == "planned" {
        staged_copy(&source, &stage, &item["source"]["observation"], cancel)?;
        if let (Some(source), Some(stage)) = (&xmp_source, &xmp_stage) {
            staged_copy(source, stage, &observation(source)?, cancel)?;
        }
        journal_write(&journal, &mut record, "destination-prepared")?;
        result["stage"] = record["stage"].clone();
    }
    let finish_bundle = AtomicBool::new(false);
    if record["stage"] == "destination-prepared" || record["stage"] == "destination-published" {
        if cancel.load(Ordering::SeqCst) {
            return Err("Import was cancelled.".into());
        }
        if !fingerprint::same_stat(&item["source"]["observation"], &observation(&source)?) {
            return Err("Import source observation changed.".into());
        }
        publish(&source, &stage, &destination, &finish_bundle)?;
        if let (Some(source), Some(stage), Some(dest)) = (&xmp_source, &xmp_stage, &xmp_dest) {
            publish(source, stage, dest, &finish_bundle)?;
        }
        journal_write(&journal, &mut record, "destination-published")?;
        result["stage"] = record["stage"].clone();
        catalog_item(service, plan, item, &destination)?;
        journal_write(&journal, &mut record, "catalog-applied")?;
        result["stage"] = record["stage"].clone();
    }
    if record["stage"] == "catalog-applied" {
        for stage in std::iter::once(&stage).chain(xmp_stage.iter()) {
            if stage.exists() {
                fs::remove_file(stage).map_err(|_| "Import stage cleanup failed.")?;
            }
        }
        observation(&destination)?;
        if let Some(dest) = &xmp_dest {
            observation(dest).map_err(|_| "Published import sidecar is missing.")?;
        }
        if matches!(item["action"].as_str(), Some("move" | "rename")) {
            // Verify every source before removing any member of the image/sidecar pair.
            if source.exists()
                && !fingerprint::same_stat(&item["source"]["observation"], &observation(&source)?)
            {
                return Err("Import source changed before cleanup.".into());
            }
            if let (Some(source), Some(dest)) = (&xmp_source, &xmp_dest) {
                if source.exists()
                    && file_hash(source, &finish_bundle)? != file_hash(dest, &finish_bundle)?
                {
                    result["xmpStatus"] = json!("mismatch");
                    return Err("Import sidecar changed before cleanup.".into());
                }
            }
            if source.exists() {
                fs::remove_file(&source).map_err(|_| "Import source cleanup failed.")?;
                sync_parent(&source)?;
            }
            if let Some(source) = &xmp_source {
                if source.exists() {
                    fs::remove_file(source).map_err(|_| "Import sidecar cleanup failed.")?;
                    sync_parent(source)?;
                }
            }
        }
        journal_write(&journal, &mut record, "source-cleaned")?;
        result["stage"] = record["stage"].clone();
    }
    observation(&destination)?;
    result["sourceRetained"] = json!(!matches!(item["action"].as_str(), Some("move" | "rename")));
    apply_metadata(service, plan, item)?;
    result["status"] = json!("completed");
    Ok(())
}
pub(super) fn execute_plan(
    service: &mut CatalogService,
    plan: &Value,
    cancel: &AtomicBool,
    user_data: &Path,
) -> Result<Value, String> {
    execute_plan_retryable(service, plan, cancel, user_data, false)
}
pub(super) fn execute_plan_retryable(
    service: &mut CatalogService,
    plan: &Value,
    cancel: &AtomicBool,
    user_data: &Path,
    retryable_failure: bool,
) -> Result<Value, String> {
    verify(plan)?;
    persist_plan(service, plan)?;
    let catalog = string(plan, "catalogId")?;
    let previous = rows(
        service.db()?,
        "SELECT item_id AS itemId,state,payload_json AS payload FROM operation_items WHERE catalog_id=? AND operation_id=?",
        values(&[&plan["catalogId"], &plan["operationId"]]),
    )?;
    let operation=one(service.db()?,"SELECT state,payload_json AS payload FROM operations WHERE catalog_id=? AND operation_id=?",values(&[&plan["catalogId"],&plan["operationId"]]))?.ok_or("Import operation is missing.")?;
    if matches!(
        operation["state"].as_str(),
        Some("completed" | "failed" | "cancelled")
    ) {
        let payload: Value = serde_json::from_str(string(&operation, "payload")?)
            .map_err(|_| "Import operation payload is invalid.")?;
        let mut results = Vec::new();
        for item in plan["items"].as_array().unwrap() {
            let row = previous
                .iter()
                .find(|row| row["itemId"] == item["itemId"])
                .ok_or("Import operation item is missing.")?;
            let persisted: Value = serde_json::from_str(string(row, "payload")?)
                .map_err(|_| "Import item payload is invalid.")?;
            let mut result = initial_result(item);
            for key in ["stage", "status", "xmpStatus", "error"] {
                result[key] = persisted[key].clone();
            }
            result["sourceRetained"] = json!(
                !(result["stage"] == "source-cleaned"
                    && matches!(item["action"].as_str(), Some("move" | "rename")))
            );
            results.push(result);
        }
        return Ok(
            json!({"operationId":plan["operationId"],"state":operation["state"],"items":results,"error":payload["error"]}),
        );
    }
    apply(
        service,
        catalog,
        vec![operation_mutation(plan, "running", Value::Null)],
    )?;
    let mut results = Vec::new();
    for item in plan["items"].as_array().unwrap() {
        let mut result = initial_result(item);
        let prior = previous
            .iter()
            .find(|row| row["itemId"] == item["itemId"])
            .and_then(|row| serde_json::from_str::<Value>(row["payload"].as_str()?).ok());
        if let Some(prior) = prior.filter(|prior| {
            matches!(
                prior["status"].as_str(),
                Some("completed" | "skipped" | "cancelled")
            )
        }) {
            for key in ["stage", "status", "xmpStatus", "error"] {
                result[key] = prior[key].clone();
            }
            result["sourceRetained"] = json!(
                !(result["stage"] == "source-cleaned"
                    && matches!(item["action"].as_str(), Some("move" | "rename")))
            );
        } else {
            if let Err(error) = execute_item(service, plan, item, cancel, user_data, &mut result) {
                result["status"] = json!(if cancel.load(Ordering::SeqCst) {
                    "cancelled"
                } else {
                    "failed"
                });
                if cancel.load(Ordering::SeqCst) {
                    if let Ok(path) = journal_path(user_data, plan, item) {
                        if let Ok(mut envelope) = store_io::read_json(&path, 64 * 1024) {
                            let record = &mut envelope["record"];
                            if record["operationId"] == plan["operationId"]
                                && record["itemId"] == item["itemId"]
                                && matches!(
                                    record["stage"].as_str(),
                                    Some("planned" | "destination-prepared")
                                )
                            {
                                if let Ok(root) =
                                    root_path(service, catalog, string(plan, "destinationRootId")?)
                                {
                                    for relative in
                                        std::iter::once(item["destinationRelativePath"].as_str())
                                            .chain(std::iter::once(
                                                item["xmpDestinationRelativePath"].as_str(),
                                            ))
                                            .flatten()
                                    {
                                        let stage = format!(
                                            "{relative}.darkroom-stage-{}-{}",
                                            string(plan, "operationId")?,
                                            string(item, "itemId")?
                                        );
                                        if let Ok(stage) = checked_path(&root, &stage, false) {
                                            let _ = fs::remove_file(stage);
                                        }
                                    }
                                }
                                journal_write(&path, record, "planned")?;
                                result["stage"] = json!("planned");
                            }
                        }
                    }
                    result["error"] = Value::Null;
                } else {
                    result["error"] = json!(if error.contains(['/', '\\']) || error.len() > 500 {
                        "Import operation could not complete.".to_string()
                    } else {
                        error
                    });
                }
            }
            let mut persisted_result = result.clone();
            if retryable_failure && result["status"] == "failed" {
                persisted_result["status"] = json!("running");
            }
            apply(
                service,
                catalog,
                vec![item_mutation(plan, item, &persisted_result)],
            )?;
        }
        results.push(result);
    }
    let state = if results.iter().any(|r| r["status"] == "failed") {
        "failed"
    } else if results.iter().any(|r| r["status"] == "cancelled") {
        "cancelled"
    } else {
        "completed"
    };
    let error = results
        .iter()
        .find(|r| !r["error"].is_null())
        .map(|r| r["error"].clone())
        .unwrap_or(Value::Null);
    apply(
        service,
        catalog,
        vec![operation_mutation(
            plan,
            if retryable_failure && state == "failed" {
                "running"
            } else {
                state
            },
            error.clone(),
        )],
    )?;
    Ok(json!({"operationId":plan["operationId"],"state":state,"items":results,"error":error}))
}
