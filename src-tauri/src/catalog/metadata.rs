use super::*;
use std::{collections::HashSet, io::Write, sync::OnceLock};

const PARSER_VERSION: &str = "kamadak-exif-0.6.1+xmpkit-0.1.6+iptc-0.3";

struct MetadataJob {
    catalog_id: String,
    session_id: String,
    cancelled: Arc<AtomicBool>,
}
static JOBS: OnceLock<Mutex<HashMap<String, MetadataJob>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, MetadataJob>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct MetadataTarget {
    entry_id: String,
    location: Option<Value>,
    size: f64,
    modified_at: f64,
}
pub struct MetadataPlan {
    catalog_id: String,
    session_id: String,
    operation_id: String,
    targets: Vec<MetadataTarget>,
    cache_root: PathBuf,
    cancelled: Arc<AtomicBool>,
    emit: Option<Arc<dyn Fn(&str, Value) + Send + Sync>>,
    force: bool,
}
impl Drop for MetadataPlan {
    fn drop(&mut self) {
        if let Ok(mut jobs) = jobs().lock() {
            jobs.remove(&self.operation_id);
        }
    }
}

fn valid_id(value: &Value, key: &str) -> Result<String, String> {
    let id = string(value, key)?;
    Uuid::parse_str(id).map_err(|_| format!("Metadata analysis {key} is invalid."))?;
    Ok(id.to_owned())
}
fn cache_path(plan: &MetadataPlan, entry: &str) -> PathBuf {
    plan.cache_root
        .join(&plan.catalog_id)
        .join(format!("{entry}.json"))
}
fn adapter(location: &Value) -> &'static str {
    let path = location["relativePath"].as_str().unwrap_or("");
    let extension = Path::new(path)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "3fr"
            | "arw"
            | "cr2"
            | "cr3"
            | "dng"
            | "erf"
            | "fff"
            | "iiq"
            | "kdc"
            | "mef"
            | "mos"
            | "mrw"
            | "nef"
            | "nrw"
            | "orf"
            | "pef"
            | "raf"
            | "raw"
            | "rw2"
            | "rwl"
            | "sr2"
            | "srf"
            | "srw"
            | "x3f"
    ) {
        "1.0.0-raw"
    } else {
        "1.0.0-standard"
    }
}
fn js_number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}
fn signature(size: f64, modified: f64) -> String {
    format!("{}:{}", js_number(size), js_number(modified))
}

fn failure(target: &MetadataTarget, sha: Option<&str>, parse_failed: bool) -> Value {
    let timestamp = now();
    let parsed = target.location.as_ref().is_some_and(|_| parse_failed);
    json!({"cacheSignature":signature(target.size,target.modified_at),"size":target.size,"modifiedAt":target.modified_at,
        "sourceSha256":sha,"parserVersion":if parsed {Some(PARSER_VERSION)} else {None},
        "adapterVersion":if parsed {target.location.as_ref().map(adapter)} else {None},"cacheHit":false,
        "source":null,"captureTimeKey":null,"captureTimeDisplay":null,"captureTimeProvenance":null,
        "cameraMake":target.location.as_ref().and_then(|v|v["fallback"]["cameraMake"].as_str()),
        "cameraModel":target.location.as_ref().and_then(|v|v["fallback"]["cameraModel"].as_str()),
        "lens":target.location.as_ref().and_then(|v|v["fallback"]["lens"].as_str()),
        "iso":null,"focalLength":null,"location":{"city":null,"state":null,"country":null},"hasGps":null,
        "error":if parsed {"Embedded metadata could not be read."} else {"The source file is unavailable for metadata analysis."},
        "analyzedAt":timestamp})
}
fn update_observation(analysis: &mut Value, target: &MetadataTarget) {
    analysis["cacheSignature"] = json!(signature(target.size, target.modified_at));
    analysis["size"] = json!(target.size);
    analysis["modifiedAt"] = json!(target.modified_at);
    if analysis["source"].is_object() {
        analysis["source"]["file"]["byteLength"] = json!(target.size);
        analysis["source"]["file"]["modifiedAt"] = json!(target.modified_at);
    }
}
fn read_cache(plan: &MetadataPlan, target: &MetadataTarget, digest: &str) -> Option<Value> {
    let location = target.location.as_ref()?;
    let data = fs::read(cache_path(plan, &target.entry_id)).ok()?;
    let parsed: Value = serde_json::from_slice(&data).ok()?;
    if parsed["version"] != 1
        || parsed["sourceSha256"] != digest
        || parsed["parserVersion"] != PARSER_VERSION
        || parsed["adapterVersion"] != adapter(location)
    {
        return None;
    }
    let mut analysis = parsed.get("analysis")?.clone();
    if !analysis.is_object() {
        return None;
    }
    update_observation(&mut analysis, target);
    analysis["cacheHit"] = json!(true);
    Some(analysis)
}
fn write_cache(plan: &MetadataPlan, target: &MetadataTarget, analysis: &Value) {
    if !analysis["sourceSha256"].is_string() || !analysis["parserVersion"].is_string() {
        return;
    }
    let destination = cache_path(plan, &target.entry_id);
    let Some(parent) = destination.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp = parent.join(format!(".{}.{}.tmp", target.entry_id, Uuid::new_v4()));
    let payload = json!({"version":1,"sourceSha256":analysis["sourceSha256"],"parserVersion":analysis["parserVersion"],"adapterVersion":analysis["adapterVersion"],"analysis":analysis});
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        if let Ok(mut file) = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
        {
            if file.write_all(&bytes).is_ok() {
                let _ = fs::rename(&temp, &destination);
            }
        }
    }
    let _ = fs::remove_file(temp);
}
fn analyze(plan: &MetadataPlan, target: &MetadataTarget) -> Value {
    let Some(location) = &target.location else {
        return failure(target, None, false);
    };
    let path = match crate::native::resolve_asset_path(location) {
        Ok(path) => path,
        Err(_) => return failure(target, None, false),
    };
    let digest = match crate::native::metadata_sha256(&path) {
        Ok(hash) => hash,
        Err(_) => return failure(target, None, false),
    };
    if !plan.force {
        if let Some(cached) = read_cache(plan, target, &digest) {
            return cached;
        }
    }
    let mut analysis = match crate::native::analyze_file_with_digest(location, Some(digest.clone()))
    {
        Ok(analysis) => analysis,
        Err(_) => failure(target, Some(&digest), true),
    };
    update_observation(&mut analysis, target);
    write_cache(plan, target, &analysis);
    analysis
}

fn progress(plan: &MetadataPlan, total: usize, completed: usize, failed: usize) -> Value {
    json!({"catalogId":plan.catalog_id,"sessionId":plan.session_id,"operationId":plan.operation_id,
        "total":total,"completed":completed,"failed":failed,"cancelled":plan.cancelled.load(std::sync::atomic::Ordering::SeqCst)})
}
pub fn run_metadata_analysis(plan: MetadataPlan) -> Result<Value, String> {
    let total = plan.targets.len();
    let mut items = Vec::with_capacity(total);
    let mut failed = 0;
    let mut report = progress(&plan, total, 0, 0);
    if let Some(emit) = &plan.emit {
        emit(
            "darkroom:catalog-metadata-analysis-progress",
            report.clone(),
        );
    }
    for target in &plan.targets {
        if plan.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        let analysis = analyze(&plan, target);
        if analysis["error"].is_string() {
            failed += 1;
        }
        items.push(json!({"entryId":target.entry_id,"analysis":analysis}));
        report = progress(&plan, total, items.len(), failed);
        if let Some(emit) = &plan.emit {
            emit(
                "darkroom:catalog-metadata-analysis-progress",
                report.clone(),
            );
        }
    }
    report["items"] = json!(items);
    Ok(report)
}

impl CatalogService {
    pub fn prepare_metadata_analysis(&self, request: &Value) -> Result<MetadataPlan, String> {
        self.require_session(request)?;
        let catalog_id = valid_id(request, "catalogId")?;
        let session_id = valid_id(request, "sessionId")?;
        let operation_id = valid_id(request, "operationId")?;
        let ids = request["entryIds"]
            .as_array()
            .filter(|items| items.len() <= 50_000)
            .ok_or("Metadata analysis entryIds are invalid.")?;
        let mut seen = HashSet::new();
        let mut targets = Vec::new();
        for value in ids {
            let entry_id = value
                .as_str()
                .ok_or("Metadata analysis entryIds are invalid.")?;
            Uuid::parse_str(entry_id).map_err(|_| "Metadata analysis entryIds are invalid.")?;
            if !seen.insert(entry_id.to_owned()) {
                continue;
            }
            let row = one(
                self.db()?,
                "SELECT a.root_id AS rootId,a.relative_path AS relativePath,a.observed_byte_length AS size,a.observed_modified_at AS modifiedAt,a.health,a.camera_make AS cameraMake,a.camera_model AS cameraModel,a.lens_model AS lens,r.canonical_path AS canonicalRootPath,r.health AS rootHealth FROM assets a JOIN roots r ON r.catalog_id=a.catalog_id AND r.root_id=a.root_id WHERE a.catalog_id=? AND a.asset_id=?",
                vec![
                    SqlValue::Text(catalog_id.clone()),
                    SqlValue::Text(entry_id.into()),
                ],
            )?;
            let size = row
                .as_ref()
                .and_then(|row| row["size"].as_f64())
                .unwrap_or(0.0);
            let modified_at = row
                .as_ref()
                .and_then(|row| row["modifiedAt"].as_f64())
                .unwrap_or(0.0);
            let location=row.as_ref().filter(|row|row["health"]=="present" && row["rootHealth"]=="online")
                .and_then(|row|{
                    let mut location=self.resolve_asset(&json!({"catalogId":catalog_id,"sessionId":session_id,"assetId":entry_id})).ok()?;
                    location["fallback"]=json!({"cameraMake":row["cameraMake"],"cameraModel":row["cameraModel"],"lens":row["lens"]});
                    Some(location)
                });
            targets.push(MetadataTarget {
                entry_id: entry_id.into(),
                location,
                size,
                modified_at,
            });
        }
        let mut registry = jobs().lock().map_err(|e| e.to_string())?;
        if registry.contains_key(&operation_id) {
            return Err("Metadata analysis operation is already active.".into());
        }
        if registry.values().any(|job| job.catalog_id == catalog_id) {
            return Err("Metadata analysis is already active for this catalog.".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        registry.insert(
            operation_id.clone(),
            MetadataJob {
                catalog_id: catalog_id.clone(),
                session_id: session_id.clone(),
                cancelled: cancelled.clone(),
            },
        );
        Ok(MetadataPlan {
            catalog_id,
            session_id,
            operation_id,
            targets,
            cache_root: self.user_data.join("metadata-cache"),
            cancelled,
            emit: self.emit.clone(),
            force: request["force"] == true,
        })
    }
    pub fn cancel_metadata_analysis(&self, request: &Value) -> Result<Value, String> {
        self.require_session(request)?;
        let operation = valid_id(request, "operationId")?;
        let registry = jobs().lock().map_err(|e| e.to_string())?;
        if let Some(job) = registry.get(&operation) {
            if job.catalog_id == string(request, "catalogId")?
                && job.session_id == string(request, "sessionId")?
            {
                job.cancelled
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        Ok(Value::Null)
    }
}
