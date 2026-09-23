use super::*;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::atomic::Ordering;
use std::time::UNIX_EPOCH;

pub(super) struct FingerprintJob {
    progress: Value,
    pub(super) cancelled: Arc<AtomicBool>,
    error: Option<String>,
}

fn progress(snapshot: &Value, session_id: &str) -> Value {
    let mut counts = json!({"total":0,"indexed":0,"stale":0,"remaining":0,"processed":0,"failed":0,"unchecked":0});
    if let Some(items) = snapshot["items"].as_array() {
        counts["total"] = json!(items.len());
        for item in items {
            let key = match item["state"].as_str().unwrap_or("pending") {
                "indexed" => "indexed",
                "stale" => "stale",
                "failed" => "failed",
                "unchecked" => "unchecked",
                _ => "remaining",
            };
            counts[key] = json!(counts[key].as_u64().unwrap_or(0) + 1);
        }
        counts["processed"] =
            json!(items.len() - counts["remaining"].as_u64().unwrap_or(0) as usize);
    }
    json!({"catalogId":snapshot["catalogId"],"sessionId":session_id,"operationId":snapshot["operationId"],"state":snapshot["state"],"total":counts["total"],"indexed":counts["indexed"],"stale":counts["stale"],"remaining":counts["remaining"],"processed":counts["processed"],"failed":counts["failed"],"unchecked":counts["unchecked"]})
}

fn state_path(user_data: &Path, catalog_id: &str, operation_id: &str) -> PathBuf {
    user_data
        .join("fingerprint-backfill")
        .join(catalog_id)
        .join(format!("{operation_id}.json"))
}

fn load(user_data: &Path, catalog_id: &str, operation_id: &str) -> Result<Option<Value>, String> {
    let path = state_path(user_data, catalog_id, operation_id);
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if raw.len() > 4 * 1024 * 1024 {
        return Err("Fingerprint backfill snapshot is too large.".into());
    }
    let envelope: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if envelope["version"] != 1
        || envelope["kind"] != "darkroom-catalog-fingerprint-backfill"
        || envelope["catalogId"] != catalog_id
        || envelope["operationId"] != operation_id
    {
        return Err("Fingerprint backfill snapshot envelope is invalid.".into());
    }
    let snapshot = envelope["snapshot"].clone();
    if snapshot["version"] != 1
        || snapshot["catalogId"] != catalog_id
        || snapshot["operationId"] != operation_id
        || !snapshot["items"].is_array()
    {
        return Err("Fingerprint backfill snapshot is invalid.".into());
    }
    Ok(Some(snapshot))
}

fn save(user_data: &Path, snapshot: &Value) -> Result<(), String> {
    let id = string(snapshot, "catalogId")?;
    let op = string(snapshot, "operationId")?;
    let path = state_path(user_data, id, op);
    let directory = path.parent().ok_or("Fingerprint path is invalid.")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let envelope = json!({"version":1,"kind":"darkroom-catalog-fingerprint-backfill","catalogId":id,"operationId":op,"snapshot":snapshot});
    let bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Fingerprint backfill snapshot is too large.".into());
    }
    let temporary = directory.join(format!(".{op}.{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn latest(user_data: &Path, catalog_id: &str) -> Result<Option<Value>, String> {
    let directory = user_data.join("fingerprint-backfill").join(catalog_id);
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut snapshots = Vec::new();
    for item in entries {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name.ends_with(".tmp") {
            continue;
        }
        if !name.ends_with(".json") || !item.file_type().map_err(|e| e.to_string())?.is_file() {
            return Err("Fingerprint backfill namespace contains an unsafe entry.".into());
        }
        let operation_id = name.trim_end_matches(".json");
        Uuid::parse_str(operation_id)
            .map_err(|_| "Fingerprint backfill snapshot filename is invalid.")?;
        snapshots.push(
            load(user_data, catalog_id, operation_id)?
                .ok_or("Fingerprint snapshot disappeared.")?,
        );
    }
    snapshots.sort_by(|a, b| {
        b["updatedAt"]
            .as_i64()
            .cmp(&a["updatedAt"].as_i64())
            .then_with(|| b["operationId"].as_str().cmp(&a["operationId"].as_str()))
    });
    Ok(snapshots.into_iter().next())
}

fn eligible(db: &Connection, catalog_id: &str) -> Result<Vec<Value>, String> {
    rows(
        db,
        "SELECT a.asset_id AS assetId,a.root_id AS rootId,a.relative_path AS relativePath,a.observed_byte_length AS byteLength,a.observed_modified_at AS modifiedAt,a.observed_at AS observedAt,a.local_file_id AS localFileId,a.health,r.canonical_path AS canonicalRootPath,r.health AS rootHealth,f.status AS fingerprintStatus,f.sha256 AS fingerprintSha256,f.observed_at AS fingerprintObservedAt,f.observed_byte_length AS fingerprintObservedByteLength,f.observed_modified_at AS fingerprintObservedModifiedAt,f.local_file_id AS fingerprintLocalFileId FROM assets a JOIN roots r ON r.catalog_id=a.catalog_id AND r.root_id=a.root_id JOIN fingerprints f ON f.catalog_id=a.catalog_id AND f.asset_id=a.asset_id WHERE a.catalog_id=? AND a.health='present' AND a.observed_at IS NOT NULL ORDER BY a.asset_id",
        vec![SqlValue::Text(catalog_id.into())],
    )
}

pub(super) fn file_observation(metadata: &fs::Metadata) -> Value {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as f64 / 1_000_000.0);
    #[cfg(unix)]
    let local_id = {
        use std::os::unix::fs::MetadataExt;
        json!(format!("{}:{}", metadata.dev(), metadata.ino()))
    };
    #[cfg(not(unix))]
    let local_id = Value::Null;
    json!({"size":metadata.len(),"modifiedAt":modified,"localFileId":local_id,"observedAt":now()})
}

pub(super) fn same_stat(left: &Value, right: &Value) -> bool {
    left["size"].as_u64() == right["size"].as_u64()
        && left["modifiedAt"].as_f64() == right["modifiedAt"].as_f64()
        && (left["localFileId"].is_null()
            || right["localFileId"].is_null()
            || left["localFileId"] == right["localFileId"])
}

pub(super) fn hash(asset: &Value, cancelled: &AtomicBool) -> (String, Option<String>, Value) {
    let attempt = (|| -> Result<(String, Option<String>, Value), String> {
        let root = PathBuf::from(string(asset, "canonicalRootPath")?);
        if fs::canonicalize(&root).map_err(|e| e.to_string())? != root {
            return Err("Fingerprint asset root changed.".into());
        }
        let relative = Path::new(string(asset, "relativePath")?);
        if relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Fingerprint asset path is invalid.".into());
        }
        let mut path = root;
        for part in relative.components() {
            path.push(part.as_os_str());
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("Fingerprint asset path is symlinked.".into());
            }
        }
        let before = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !before.is_file() {
            return Err("Fingerprint source is not a regular file.".into());
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        let opened = file.metadata().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if before.dev() != opened.dev() || before.ino() != opened.ino() {
                return Err("Fingerprint source changed before open.".into());
            }
        }
        let before_obs = file_observation(&opened);
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 1024 * 1024];
        let mut bytes = 0u64;
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Ok(("cancelled".into(), None, Value::Null));
            }
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            bytes += count as u64;
        }
        let after = file.metadata().map_err(|e| e.to_string())?;
        let path_after = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if opened.dev() != after.dev()
                || opened.ino() != after.ino()
                || after.dev() != path_after.dev()
                || after.ino() != path_after.ino()
            {
                return Err("Fingerprint source changed during read.".into());
            }
        }
        let after_obs = file_observation(&after);
        if bytes != before.len() || !same_stat(&before_obs, &after_obs) {
            return Ok(("stale".into(), None, after_obs));
        }
        Ok((
            "indexed".into(),
            Some(format!("{:x}", digest.finalize())),
            after_obs,
        ))
    })();
    match attempt {
        Ok(value) => value,
        Err(_) => ("unchecked".into(), None, Value::Null),
    }
}

fn publish(
    user_data: &Path,
    db_path: &Path,
    db: &Connection,
    catalog_id: &str,
    snapshot: &mut Value,
    session_id: &str,
    jobs: &Arc<Mutex<HashMap<String, FingerprintJob>>>,
    callback: &Option<Arc<dyn Fn(&str, Value) + Send + Sync>>,
) -> Result<(), String> {
    snapshot["updatedAt"] = json!(now());
    let counts = progress(snapshot, session_id);
    snapshot["progress"] = json!({"total":counts["total"],"indexed":counts["indexed"],"stale":counts["stale"],"remaining":counts["remaining"],"processed":counts["processed"],"failed":counts["failed"],"unchecked":counts["unchecked"]});
    save(user_data, snapshot)?;
    if let Ok(mut all) = jobs.lock() {
        if let Some(job) = all.get_mut(snapshot["operationId"].as_str().unwrap_or("")) {
            job.progress = counts.clone();
        }
    }
    if let Some(callback) = callback {
        callback("darkroom:catalog-fingerprint-progress", counts);
    }
    let _ = (db_path, db, catalog_id);
    Ok(())
}

fn run(
    user_data: PathBuf,
    db_path: PathBuf,
    catalog_id: String,
    session_id: String,
    mut snapshot: Value,
    jobs: Arc<Mutex<HashMap<String, FingerprintJob>>>,
    cancelled: Arc<AtomicBool>,
    callback: Option<Arc<dyn Fn(&str, Value) + Send + Sync>>,
) -> Result<(), String> {
    let db = Connection::open(&db_path).map_err(|e| e.to_string())?;
    db.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let assets = eligible(&db, &catalog_id)?;
    let by_id = assets
        .iter()
        .filter_map(|asset| {
            asset["assetId"]
                .as_str()
                .map(|id| (id.to_string(), asset.clone()))
        })
        .collect::<HashMap<_, _>>();
    snapshot["state"] = json!("running");
    publish(
        &user_data,
        &db_path,
        &db,
        &catalog_id,
        &mut snapshot,
        &session_id,
        &jobs,
        &callback,
    )?;
    let count = snapshot["items"].as_array().map_or(0, Vec::len);
    for index in 0..count {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        if snapshot["items"][index]["state"] != "pending" {
            continue;
        }
        let asset_id = string(&snapshot["items"][index], "assetId")?.to_string();
        let asset = by_id
            .get(&asset_id)
            .ok_or("Fingerprint backfill asset disappeared.")?;
        let (state, sha, observed) = hash(asset, &cancelled);
        if state == "cancelled" || cancelled.load(Ordering::SeqCst) {
            break;
        }
        let catalog_observation = json!({"size":asset["byteLength"],"modifiedAt":asset["modifiedAt"],"localFileId":asset["localFileId"],"observedAt":asset["observedAt"]});
        let state = if state == "indexed" && !same_stat(&catalog_observation, &observed) {
            "stale".to_string()
        } else {
            state
        };
        let proof = if state == "indexed" {
            catalog_observation.clone()
        } else if observed.is_null() {
            catalog_observation.clone()
        } else {
            observed.clone()
        };
        let transition = json!({"assetId":asset_id,"status":if state=="indexed"{"valid"}else if state=="stale"{"stale"}else{"failed"},"sha256":if state=="indexed"{sha.clone()}else{None},"observedAt":proof["observedAt"],"observedByteLength":proof["size"],"observedModifiedAt":proof["modifiedAt"],"localFileId":proof["localFileId"]});
        let mut service =
            CatalogService::for_worker(Connection::open(&db_path).map_err(|e| e.to_string())?);
        let mut success = false;
        for _ in 0..4 {
            let revision = service.revision(&catalog_id)?;
            match service.apply(&json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":[{"kind":"fingerprint-set","fingerprint":transition}]})) {
                Ok(_)=>{success=true;break},Err(error) if error.contains("revision") && error.contains("stale")=>continue,Err(error)=>return Err(error),
            }
        }
        if !success {
            return Err("Fingerprint catalog revision stayed stale.".into());
        }
        let item = &mut snapshot["items"][index];
        item["state"] = json!(state);
        item["sha256"] = if state == "indexed" {
            sha.map_or(Value::Null, |v| json!(v))
        } else {
            Value::Null
        };
        item["observation"] = if state == "indexed" { proof } else { observed };
        item["reason"] = if state == "stale" {
            json!("File changed while it was being fingerprinted.")
        } else if state == "unchecked" {
            json!("File could not be fully checked.")
        } else {
            Value::Null
        };
        publish(
            &user_data,
            &db_path,
            &db,
            &catalog_id,
            &mut snapshot,
            &session_id,
            &jobs,
            &callback,
        )?;
    }
    snapshot["state"] = json!(if cancelled.load(Ordering::SeqCst) {
        "cancelled"
    } else {
        "completed"
    });
    publish(
        &user_data,
        &db_path,
        &db,
        &catalog_id,
        &mut snapshot,
        &session_id,
        &jobs,
        &callback,
    )
}

impl CatalogService {
    pub(super) fn fingerprint_dispatch(
        &mut self,
        command: &str,
        request: &Value,
    ) -> Result<Value, String> {
        self.require_session(request)?;
        let catalog_id = string(request, "catalogId")?.to_string();
        let session_id = string(request, "sessionId")?.to_string();
        if command == "darkroom:catalog-fingerprint-status" {
            let snapshot = if let Some(operation_id) = request["operationId"].as_str() {
                Uuid::parse_str(operation_id)
                    .map_err(|_| "Fingerprint operation ID is invalid.")?;
                load(&self.user_data, &catalog_id, operation_id)?
            } else {
                latest(&self.user_data, &catalog_id)?
            };
            let Some(snapshot) = snapshot else {
                return Ok(Value::Null);
            };
            let operation_id = string(&snapshot, "operationId")?;
            if let Some(job) = self
                .fingerprint_jobs
                .lock()
                .map_err(|e| e.to_string())?
                .get(operation_id)
            {
                if let Some(error) = &job.error {
                    return Err(error.clone());
                }
                return Ok(job.progress.clone());
            }
            return Ok(progress(&snapshot, &session_id));
        }
        if command == "darkroom:catalog-fingerprint-cancel" {
            let operation_id = string(request, "operationId")?;
            if let Some(job) = self
                .fingerprint_jobs
                .lock()
                .map_err(|e| e.to_string())?
                .get(operation_id)
            {
                job.cancelled.store(true, Ordering::SeqCst);
            }
            return Ok(Value::Null);
        }
        {
            let all = self.fingerprint_jobs.lock().map_err(|e| e.to_string())?;
            if all.values().any(|job| {
                job.progress["catalogId"] == catalog_id
                    && (job.progress["state"] == "planned" || job.progress["state"] == "running")
            }) {
                if command == "darkroom:catalog-fingerprint-recover" {
                    if let Some(job) = all.values().find(|job| {
                        job.progress["catalogId"] == catalog_id
                            && (job.progress["state"] == "planned"
                                || job.progress["state"] == "running")
                    }) {
                        return Ok(job.progress.clone());
                    }
                }
                return Err("A fingerprint backfill is already active for this catalog.".into());
            }
        }
        let mut source: Option<Value> = None;
        let operation_id = if command == "darkroom:catalog-fingerprint-recover" {
            let Some(snapshot) = latest(&self.user_data, &catalog_id)? else {
                return Ok(Value::Null);
            };
            if snapshot["state"] == "completed" || snapshot["state"] == "cancelled" {
                return Ok(progress(&snapshot, &session_id));
            }
            let id = string(&snapshot, "operationId")?.to_string();
            source = Some(snapshot);
            id
        } else {
            Uuid::new_v4().to_string()
        };
        if command == "darkroom:catalog-fingerprint-resume" {
            let source_id = string(request, "sourceOperationId")?;
            source = Some(
                load(&self.user_data, &catalog_id, source_id)?
                    .ok_or("Fingerprint backfill source snapshot does not exist.")?,
            );
        }
        let assets = eligible(self.db()?, &catalog_id)?;
        if assets.len() > 100_000 {
            return Err("Too many fingerprint backfill assets.".into());
        }
        let previous = source.as_ref().and_then(|v| v["items"].as_array());
        let mut items = Vec::with_capacity(assets.len());
        for asset in assets {
            let asset_id = string(&asset, "assetId")?;
            let observation = json!({"size":asset["byteLength"],"modifiedAt":asset["modifiedAt"],"localFileId":asset["localFileId"],"observedAt":asset["observedAt"]});
            let prior = previous.and_then(|items| items.iter().find(|v| v["assetId"] == asset_id));
            let cached = asset["fingerprintStatus"] == "valid"
                && asset["fingerprintSha256"]
                    .as_str()
                    .is_some_and(|v| v.len() == 64)
                && asset["fingerprintObservedAt"] == asset["observedAt"]
                && asset["fingerprintObservedByteLength"] == asset["byteLength"]
                && asset["fingerprintObservedModifiedAt"] == asset["modifiedAt"]
                && asset["fingerprintLocalFileId"] == asset["localFileId"];
            let from_prior = prior.is_some_and(|v| {
                v["state"] == "indexed" && same_stat(&v["observation"], &observation)
            });
            let indexed = cached || from_prior;
            let sha = if cached {
                asset["fingerprintSha256"].clone()
            } else {
                prior.map_or(Value::Null, |v| v["sha256"].clone())
            };
            items.push(json!({"assetId":asset_id,"state":if indexed{"indexed"}else{"pending"},"sha256":if indexed{sha}else{Value::Null},"observation":if indexed{observation}else{Value::Null},"reason":null}));
        }
        let mut snapshot = json!({"version":1,"operationId":operation_id,"catalogId":catalog_id,"state":"planned","items":items,"progress":null,"updatedAt":now()});
        let initial = progress(&snapshot, &session_id);
        snapshot["progress"] = json!({"total":initial["total"],"indexed":initial["indexed"],"stale":initial["stale"],"remaining":initial["remaining"],"processed":initial["processed"],"failed":initial["failed"],"unchecked":initial["unchecked"]});
        save(&self.user_data, &snapshot)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut all = self.fingerprint_jobs.lock().map_err(|e| e.to_string())?;
            all.insert(
                operation_id.clone(),
                FingerprintJob {
                    progress: initial.clone(),
                    cancelled: cancelled.clone(),
                    error: None,
                },
            );
        }
        let user_data = self.user_data.clone();
        let db_path = self
            .active_path()
            .ok_or("No catalog is open.")?
            .to_path_buf();
        let jobs = self.fingerprint_jobs.clone();
        let callback = self.emit.clone();
        let worker = std::thread::spawn(move || {
            if let Err(error) = run(
                user_data,
                db_path,
                catalog_id,
                session_id,
                snapshot,
                jobs.clone(),
                cancelled,
                callback,
            ) {
                if let Ok(mut all) = jobs.lock() {
                    if let Some(job) = all.get_mut(&operation_id) {
                        job.error = Some(error);
                    }
                }
            }
        });
        self.scan_handles.push(worker);
        Ok(initial)
    }
}
