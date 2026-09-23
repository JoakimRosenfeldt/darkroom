use super::*;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

fn event(
    callback: &Option<Arc<dyn Fn(&str, Value) + Send + Sync>>,
    sequence: &Arc<AtomicU64>,
    catalog_id: &str,
    session_id: &str,
    root_id: &str,
    operation_id: &str,
    kind: &str,
    payload: Value,
) {
    if let Some(callback) = callback {
        let value = json!({"catalogId":catalog_id,"sessionId":session_id,"rootId":root_id,"operationId":operation_id,"sequence":sequence.fetch_add(1,Ordering::SeqCst)+1,"kind":kind,"payload":payload});
        callback("darkroom:catalog-event", value);
    }
}

fn mutate(db_path: &Path, catalog_id: &str, mutations: Vec<Value>) -> Result<(), String> {
    for _ in 0..4 {
        let db = Connection::open(db_path).map_err(|e| e.to_string())?;
        db.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let mut service = CatalogService::for_worker(db);
        let revision = service.revision(catalog_id)?;
        match service.apply(
            &json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":mutations}),
        ) {
            Ok(_) => return Ok(()),
            Err(error) if error.contains("revision") && error.contains("stale") => continue,
            Err(error) => return Err(error),
        }
    }
    Err("Watch reconcile revision stayed stale.".into())
}

fn set_state(db_path: &Path, catalog_id: &str, root_id: &str, status: &str) -> Result<(), String> {
    let state = if status == "active" || status == "reconciling" {
        "active"
    } else {
        "error"
    };
    mutate(
        db_path,
        catalog_id,
        vec![json!({"kind":"root-watch","rootId":root_id,"watchState":state})],
    )
}

fn reconcile(
    db_path: &Path,
    catalog_id: &str,
    root_id: &str,
    root_path: &Path,
    stop: &AtomicBool,
) -> Result<usize, String> {
    let (mut observations, _, _, _) = super::scan::scan_folder(
        root_path,
        stop,
        Duration::from_secs(300),
        |_, _, _, _, _| {},
    )?;
    if stop.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    let old = rows(
        &db,
        "SELECT relative_path AS relativePath,health,format_id AS formatId,observed_byte_length AS byteLength,observed_modified_at AS modifiedAt,observed_at AS observedAt,local_file_id AS localFileId FROM assets WHERE catalog_id=? AND root_id=?",
        values(&[&json!(catalog_id), &json!(root_id)]),
    )?;
    let by_path = old
        .iter()
        .filter_map(|row| row["relativePath"].as_str().map(|v| (v.to_string(), row)))
        .collect::<HashMap<_, _>>();
    let mut seen = std::collections::HashSet::new();
    let mut changed = 0usize;
    for current in &mut observations {
        let path = string(current, "relativePath")?;
        seen.insert(path.to_string());
        match by_path.get(path) {
            Some(previous) => {
                let obs = &current["observation"];
                let same = previous["byteLength"] == obs["byteLength"]
                    && previous["modifiedAt"] == obs["modifiedAt"]
                    && (obs["localFileId"].is_null()
                        || previous["localFileId"] == obs["localFileId"]);
                if same {
                    current["observation"]["observedAt"] = previous["observedAt"].clone();
                }
                if !same
                    || previous["health"] != "present"
                    || previous["formatId"] != current["formatId"]
                {
                    changed += 1
                }
            }
            None => changed += 1,
        }
    }
    changed += old
        .iter()
        .filter(|row| {
            row["health"] != "missing" && !seen.contains(row["relativePath"].as_str().unwrap_or(""))
        })
        .count();
    if stop.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    mutate(
        db_path,
        catalog_id,
        vec![json!({"kind":"reconcile-complete","rootId":root_id,"observations":observations})],
    )?;
    Ok(changed)
}

fn classify(error: &str) -> (&'static str, &'static str) {
    let lower = error.to_ascii_lowercase();
    if lower.contains("no such file") || lower.contains("not found") {
        ("missing", "missing")
    } else if lower.contains("permission") || lower.contains("access denied") {
        ("permission-denied", "permission-denied")
    } else if lower.contains("overflow") || lower.contains("no space") {
        ("degraded", "overflow")
    } else {
        ("degraded", "error")
    }
}

fn run_root(
    db_path: PathBuf,
    catalog_id: String,
    session_id: String,
    root_id: String,
    root_path: PathBuf,
    stop: Arc<AtomicBool>,
    callback: Option<Arc<dyn Fn(&str, Value) + Send + Sync>>,
    sequence: Arc<AtomicU64>,
) {
    let mut retry = 0usize;
    while !stop.load(Ordering::SeqCst) && retry <= 5 {
        let (sender, receiver) = mpsc::channel();
        let watch = RecommendedWatcher::new(
            move |result| {
                let _ = sender.send(result);
            },
            notify::Config::default(),
        );
        let result = watch.and_then(|mut handle| {
            handle.watch(&root_path, RecursiveMode::Recursive)?;
            Ok(handle)
        });
        let watcher = match result {
            Ok(handle) => handle,
            Err(error) => {
                let (status, code) = classify(&error.to_string());
                retry += 1;
                let operation = Uuid::new_v4().to_string();
                event(
                    &callback,
                    &sequence,
                    &catalog_id,
                    &session_id,
                    &root_id,
                    &operation,
                    "watch-state",
                    json!({"status":status,"retryAttempt":retry,"errorCode":code}),
                );
                let _ = set_state(&db_path, &catalog_id, &root_id, status);
                if retry > 5 {
                    return;
                }
                let mut remaining = (150u64 << retry.min(5)).min(30_000);
                while remaining > 0 && !stop.load(Ordering::SeqCst) {
                    let step = remaining.min(250);
                    std::thread::sleep(Duration::from_millis(step));
                    remaining -= step;
                }
                continue;
            }
        };
        retry = 0;
        let operation = Uuid::new_v4().to_string();
        event(
            &callback,
            &sequence,
            &catalog_id,
            &session_id,
            &root_id,
            &operation,
            "watch-state",
            json!({"status":"active","retryAttempt":0,"errorCode":null}),
        );
        let _ = set_state(&db_path, &catalog_id, &root_id, "active");
        let mut pending = false;
        let mut last = Instant::now();
        while !stop.load(Ordering::SeqCst) {
            let timeout = if pending {
                Duration::from_millis(150)
                    .saturating_sub(last.elapsed())
                    .max(Duration::from_millis(1))
            } else {
                Duration::from_millis(250)
            };
            match receiver.recv_timeout(timeout) {
                Ok(Ok(change)) => {
                    if change.paths.iter().any(|path| {
                        path.components()
                            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
                    }) {
                        continue;
                    }
                    pending = true;
                    last = Instant::now();
                }
                Ok(Err(error)) => {
                    let (status, code) = classify(&error.to_string());
                    retry += 1;
                    let operation = Uuid::new_v4().to_string();
                    event(
                        &callback,
                        &sequence,
                        &catalog_id,
                        &session_id,
                        &root_id,
                        &operation,
                        "watch-state",
                        json!({"status":status,"retryAttempt":retry,"errorCode":code}),
                    );
                    let _ = set_state(&db_path, &catalog_id, &root_id, status);
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    retry += 1;
                    break;
                }
                Err(RecvTimeoutError::Timeout) => (),
            }
            if pending && last.elapsed() >= Duration::from_millis(150) {
                pending = false;
                let operation = Uuid::new_v4().to_string();
                let scopes = json!([{"kind":"root"}]);
                event(
                    &callback,
                    &sequence,
                    &catalog_id,
                    &session_id,
                    &root_id,
                    &operation,
                    "watch-state",
                    json!({"status":"reconciling","retryAttempt":retry,"errorCode":null}),
                );
                event(
                    &callback,
                    &sequence,
                    &catalog_id,
                    &session_id,
                    &root_id,
                    &operation,
                    "reconcile-started",
                    json!({"scopes":scopes}),
                );
                match reconcile(&db_path, &catalog_id, &root_id, &root_path, &stop) {
                    Ok(changed) => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        event(
                            &callback,
                            &sequence,
                            &catalog_id,
                            &session_id,
                            &root_id,
                            &operation,
                            "reconcile-completed",
                            json!({"scopes":scopes,"changedCount":changed}),
                        );
                        event(
                            &callback,
                            &sequence,
                            &catalog_id,
                            &session_id,
                            &root_id,
                            &operation,
                            "watch-state",
                            json!({"status":"active","retryAttempt":0,"errorCode":null}),
                        );
                        let _ = set_state(&db_path, &catalog_id, &root_id, "active");
                        retry = 0;
                    }
                    Err(error) => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let (status, code) = classify(&error);
                        retry += 1;
                        event(
                            &callback,
                            &sequence,
                            &catalog_id,
                            &session_id,
                            &root_id,
                            &operation,
                            "reconcile-failed",
                            json!({"scopes":scopes,"retryAttempt":retry,"errorCode":code}),
                        );
                        event(
                            &callback,
                            &sequence,
                            &catalog_id,
                            &session_id,
                            &root_id,
                            &operation,
                            "watch-state",
                            json!({"status":status,"retryAttempt":retry,"errorCode":code}),
                        );
                        let _ = set_state(&db_path, &catalog_id, &root_id, status);
                        if retry > 5 {
                            break;
                        }
                        pending = true;
                        last = Instant::now();
                    }
                }
            }
        }
        drop(watcher);
    }
}

impl CatalogService {
    pub(super) fn stop_watchers(&mut self) {
        if let Ok(mut stops) = self.watcher_stops.lock() {
            for stop in stops.drain(..) {
                stop.store(true, Ordering::SeqCst);
            }
        }
        for handle in self.watcher_handles.drain(..) {
            let _ = handle.join();
        }
    }

    pub(super) fn start_watchers(&mut self) -> Result<(), String> {
        let active = self.active.as_ref().ok_or("Catalog session is inactive.")?;
        let roots = rows(
            self.db()?,
            "SELECT root_id AS rootId,canonical_path AS canonicalPath FROM roots WHERE catalog_id=? AND health='online' AND canonical_path IS NOT NULL",
            vec![SqlValue::Text(active.catalog_id.clone())],
        )?;
        for root in roots {
            let stop = Arc::new(AtomicBool::new(false));
            self.watcher_stops
                .lock()
                .map_err(|e| e.to_string())?
                .push(stop.clone());
            let path = active.database_path.clone();
            let catalog_id = active.catalog_id.clone();
            let session_id = active.session_id.clone();
            let root_id = string(&root, "rootId")?.to_string();
            let root_path = PathBuf::from(string(&root, "canonicalPath")?);
            let callback = self.emit.clone();
            let sequence = self.event_sequence.clone();
            self.watcher_handles.push(std::thread::spawn(move || {
                run_root(
                    path, catalog_id, session_id, root_id, root_path, stop, callback, sequence,
                )
            }));
        }
        Ok(())
    }
}
