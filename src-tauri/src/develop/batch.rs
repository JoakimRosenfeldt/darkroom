use super::{DevelopService, apply, store_io};
use crate::catalog::{CatalogService, history, now, one, rows, string, values};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
struct Running {
    stop: Arc<AtomicBool>,
    wake: std::sync::mpsc::Sender<()>,
    thread: JoinHandle<()>,
}
pub struct BatchService {
    running: HashMap<String, Running>,
    emit: Emit,
    registry: Value,
}

fn connect(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    db.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    install(&db)?;
    Ok(db)
}

pub fn install(db: &Connection) -> Result<(), String> {
    let tables = [
        "develop_batch_jobs",
        "develop_batch_items",
        "develop_auto_sync",
    ];
    let jobs = [
        "catalog_id",
        "batch_id",
        "operation_id",
        "request_sha256",
        "schema_version",
        "kind",
        "source_entry_id",
        "source_revision_id",
        "operation_json",
        "targets_json",
        "cancellation_requested",
        "created_at",
        "updated_at",
    ];
    let items = [
        "catalog_id",
        "batch_id",
        "position",
        "entry_id",
        "operation_id",
        "planned_revision_id",
        "expected_revision_id",
        "before_revision_id",
        "after_revision_id",
        "restore_revision_id",
        "state_json",
        "attempts",
        "updated_at",
    ];
    let auto = [
        "catalog_id",
        "source_entry_id",
        "source_revision_id",
        "targets_json",
        "fields_json",
        "enabled",
        "updated_at",
    ];
    let exists = |table: &str| -> Result<bool, String> {
        Ok(one(
            db,
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            values(&[&json!(table)]),
        )?
        .is_some())
    };
    let columns = |table: &str| -> Result<Vec<String>, String> {
        rows(db, &format!("PRAGMA table_info({table})"), vec![])?
            .iter()
            .map(|row| Ok(string(row, "name")?.to_owned()))
            .collect()
    };
    let validate = |table: &str, expected: &[&str]| -> Result<(), String> {
        if columns(table)? != expected {
            return Err(format!(
                "Develop batch table {table} has an incompatible shape."
            ));
        }
        let row = one(
            db,
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            values(&[&json!(table)]),
        )?
        .ok_or("Develop batch table is missing.")?;
        if !string(&row, "sql")?
            .trim()
            .to_ascii_uppercase()
            .ends_with("STRICT")
        {
            return Err(format!("Develop batch table {table} must be STRICT."));
        }
        Ok(())
    };
    transaction(db, || {
        let existing = tables
            .iter()
            .map(|table| exists(table))
            .collect::<Result<Vec<_>, _>>()?;
        let metadata = exists("develop_batch_schema_meta")?;
        if existing.iter().all(|value| !*value) && !metadata {
            db.execute_batch(include_str!("batch-schema.sql"))
                .map_err(|e| e.to_string())?;
        } else {
            if existing.iter().any(|value| !*value) {
                return Err(
                    "Develop batch schema is partial and cannot be upgraded safely.".into(),
                );
            }
            let jobs_v1 = columns(tables[0])? == jobs;
            let auto_v1 = columns(tables[2])? == auto;
            let jobs_v2 = [jobs.as_slice(), &["emission_sequence"]].concat();
            let auto_v2 = [auto.as_slice(), &["source_emission_sequence"]].concat();
            if jobs_v1 != auto_v1 {
                return Err("Develop batch schema versions are inconsistent.".into());
            }
            validate(tables[0], if jobs_v1 { &jobs } else { &jobs_v2 })?;
            validate(tables[1], &items)?;
            validate(tables[2], if auto_v1 { &auto } else { &auto_v2 })?;
            if jobs_v1 {
                db.execute_batch("ALTER TABLE develop_batch_jobs ADD COLUMN emission_sequence INTEGER; ALTER TABLE develop_auto_sync ADD COLUMN source_emission_sequence INTEGER NOT NULL DEFAULT 0;").map_err(|e|e.to_string())?;
            }
            let mut create_meta = !metadata;
            if metadata {
                validate(
                    "develop_batch_schema_meta",
                    &["singleton", "schema_version"],
                )?;
                let version: i64 = db
                    .query_row(
                        "SELECT schema_version FROM develop_batch_schema_meta WHERE singleton=1",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if version != 1 && version != 2 {
                    return Err("Develop batch schema version is unsupported.".into());
                }
                if version == 1 {
                    db.execute_batch("DROP TABLE develop_batch_schema_meta;")
                        .map_err(|e| e.to_string())?;
                    create_meta = true;
                }
            }
            if create_meta {
                db.execute_batch("CREATE TABLE develop_batch_schema_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=2)) STRICT; INSERT INTO develop_batch_schema_meta VALUES(1,2);").map_err(|e|e.to_string())?;
            }
        }
        for (sql, error) in [
            (
                "SELECT 1 FROM develop_batch_jobs WHERE kind='auto-sync' AND (source_entry_id IS NULL OR source_revision_id IS NULL) LIMIT 1",
                "Legacy Auto Sync Receipt source is incomplete.",
            ),
            (
                "SELECT 1 FROM develop_batch_jobs WHERE kind='auto-sync' GROUP BY catalog_id,source_entry_id,source_revision_id HAVING COUNT(*)>1 LIMIT 1",
                "Legacy Auto Sync Receipts repeat a source revision and cannot be collapsed safely.",
            ),
        ] {
            if one(db, sql, vec![])?.is_some() {
                return Err(error.into());
            }
        }
        let emissions = rows(
            db,
            "SELECT rowid AS rowId,catalog_id AS catalogId,emission_sequence AS emissionSequence FROM develop_batch_jobs WHERE kind='auto-sync' ORDER BY catalog_id,rowid",
            vec![],
        )?;
        let missing = emissions
            .iter()
            .any(|row| row["emissionSequence"].is_null());
        if missing
            && emissions
                .iter()
                .any(|row| !row["emissionSequence"].is_null())
        {
            return Err("Auto Sync emission sequences are only partially populated.".into());
        }
        if missing {
            let mut previous = String::new();
            let mut sequence = 0;
            for row in emissions {
                let catalog = string(&row, "catalogId")?;
                if catalog != previous {
                    previous = catalog.into();
                    sequence = 0;
                }
                sequence += 1;
                db.execute(
                    "UPDATE develop_batch_jobs SET emission_sequence=? WHERE rowid=?",
                    params![sequence, row["rowId"].as_i64()],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        for (sql, error) in [
            (
                "SELECT 1 FROM develop_batch_jobs WHERE (kind='auto-sync' AND (emission_sequence IS NULL OR emission_sequence<1)) OR (kind<>'auto-sync' AND emission_sequence IS NOT NULL) LIMIT 1",
                "Auto Sync emission sequence is invalid.",
            ),
            (
                "SELECT 1 FROM develop_batch_jobs WHERE kind='auto-sync' GROUP BY catalog_id,emission_sequence HAVING COUNT(*)>1 LIMIT 1",
                "Auto Sync emission sequence is duplicated.",
            ),
        ] {
            if one(db, sql, vec![])?.is_some() {
                return Err(error.into());
            }
        }
        db.execute_batch("UPDATE develop_auto_sync SET source_emission_sequence=COALESCE((SELECT emission_sequence FROM develop_batch_jobs j WHERE j.catalog_id=develop_auto_sync.catalog_id AND j.kind='auto-sync' AND j.source_entry_id=develop_auto_sync.source_entry_id AND j.source_revision_id=develop_auto_sync.source_revision_id),(SELECT MAX(emission_sequence) FROM develop_batch_jobs j WHERE j.catalog_id=develop_auto_sync.catalog_id AND j.kind='auto-sync'),0) WHERE source_emission_sequence=0;
        DROP INDEX IF EXISTS develop_auto_sync_source_revision_once;
        CREATE UNIQUE INDEX develop_auto_sync_source_revision_once ON develop_batch_jobs(catalog_id,source_entry_id,source_revision_id) WHERE kind='auto-sync';
        CREATE UNIQUE INDEX IF NOT EXISTS develop_auto_sync_emission_sequence_once ON develop_batch_jobs(catalog_id,emission_sequence) WHERE kind='auto-sync';
        CREATE INDEX IF NOT EXISTS develop_batch_jobs_by_catalog ON develop_batch_jobs(catalog_id,created_at DESC,batch_id);
        CREATE INDEX IF NOT EXISTS develop_batch_items_by_state ON develop_batch_items(catalog_id,batch_id,position);
        CREATE TABLE IF NOT EXISTS develop_batch_profile_snapshots(catalog_id TEXT NOT NULL,batch_id TEXT NOT NULL,registry_json TEXT NOT NULL CHECK(json_valid(registry_json)),PRIMARY KEY(catalog_id,batch_id),FOREIGN KEY(catalog_id,batch_id) REFERENCES develop_batch_jobs(catalog_id,batch_id)) STRICT;").map_err(|e|e.to_string())?;
        Ok(())
    })
}

fn transaction<T>(db: &Connection, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if !db.is_autocommit() {
        return work();
    }
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    match work() {
        Ok(v) => {
            db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

pub fn get(db: &Connection, id: &str, batch: &str) -> Result<Value, String> {
    let mut job=one(db,"SELECT 1 AS schemaVersion,catalog_id AS catalogId,batch_id AS batchId,operation_id AS operationId,kind,source_entry_id AS sourceEntryId,source_revision_id AS sourceRevisionId,targets_json AS targetEntryIds,operation_json AS operation,cancellation_requested AS cancellationRequested,created_at AS createdAt,updated_at AS updatedAt FROM develop_batch_jobs WHERE catalog_id=? AND batch_id=?",values(&[&json!(id),&json!(batch)]))?.ok_or("Develop batch receipt is missing.")?;
    for key in ["targetEntryIds", "operation"] {
        job[key] = serde_json::from_str(
            job[key]
                .as_str()
                .ok_or("Develop batch storage is invalid.")?,
        )
        .map_err(|e| e.to_string())?;
    }
    job["cancellationRequested"] = json!(job["cancellationRequested"] == 1);
    let mut items = rows(
        db,
        "SELECT position,entry_id AS entryId,operation_id AS operationId,planned_revision_id AS plannedRevisionId,expected_revision_id AS expectedRevisionId,before_revision_id AS beforeRevisionId,after_revision_id AS afterRevisionId,restore_revision_id AS restoreRevisionId,state_json AS state,attempts,updated_at AS updatedAt FROM develop_batch_items WHERE catalog_id=? AND batch_id=? ORDER BY position",
        values(&[&json!(id), &json!(batch)]),
    )?;
    for item in &mut items {
        item["state"] = serde_json::from_str(
            item["state"]
                .as_str()
                .ok_or("Develop batch state is invalid.")?,
        )
        .map_err(|e| e.to_string())?;
    }
    job["items"] = json!(items);
    Ok(job)
}

fn list(db: &Connection, id: &str, limit: i64) -> Result<Value, String> {
    let ids = rows(
        db,
        "SELECT batch_id AS batchId FROM develop_batch_jobs WHERE catalog_id=? ORDER BY created_at DESC,batch_id LIMIT ?",
        values(&[&json!(id), &json!(limit.clamp(1, 1000))]),
    )?;
    Ok(json!(
        ids.iter()
            .map(|v| get(db, id, string(v, "batchId")?))
            .collect::<Result<Vec<_>, String>>()?
    ))
}

fn source_id(db: &Connection, id: &str, entry: &str) -> Result<String, String> {
    db.query_row("SELECT source_id FROM edit_entries WHERE catalog_id=?1 AND entry_id=?2 AND tombstoned_at IS NULL",params![id,entry],|r|r.get(0)).map_err(|_|"Develop batch entry is inactive or missing.".into())
}

fn fields(v: &Value) -> Result<Vec<Value>, String> {
    let fields = v
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 8)
        .ok_or("Develop batch fields are invalid.")?;
    let mut seen = HashSet::new();
    if fields.iter().any(|v| {
        !v.as_str().is_some_and(|f| {
            [
                "basic",
                "mixer",
                "effects",
                "tone-curves",
                "camera-profile",
                "crop",
                "manual-masks",
                "ai-masks",
            ]
            .contains(&f)
                && seen.insert(f)
        })
    }) {
        return Err("Develop batch fields are invalid.".into());
    }
    Ok(fields.clone())
}

fn targets(v: &Value) -> Result<Vec<String>, String> {
    let entries = v
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 10_000)
        .ok_or("Develop batch target entries are invalid.")?;
    let mut seen = HashSet::new();
    entries
        .iter()
        .map(|v| {
            let id = v.as_str().ok_or("Develop batch target ID is invalid.")?;
            uuid::Uuid::parse_str(id).map_err(|_| "Develop batch target ID is invalid.")?;
            if !seen.insert(id) {
                return Err("Develop batch target entries contain duplicates.".into());
            }
            Ok(id.to_owned())
        })
        .collect()
}

fn control_path(control: &str) -> Result<&'static str, String> {
    match control {
        "exposure" => Ok("/tone/basic/exposure"),
        "contrast" => Ok("/tone/basic/contrast"),
        "highlights" => Ok("/tone/basic/highlights"),
        "shadows" => Ok("/tone/basic/shadows"),
        "whites" => Ok("/tone/basic/whites"),
        "blacks" => Ok("/tone/basic/blacks"),
        "vibrance" => Ok("/color/global/vibrance"),
        "saturation" => Ok("/color/global/saturation"),
        "texture" => Ok("/presence/texture"),
        "clarity" => Ok("/presence/clarity"),
        "dehaze" => Ok("/presence/dehaze"),
        _ => Err("Develop batch control is invalid.".into()),
    }
}

fn receipt_create(
    db: &Connection,
    request: &Value,
    source: Option<&str>,
    target_ids: &[String],
    operation: &Value,
    kind: &str,
    restores: Option<&Value>,
) -> Result<Value, String> {
    transaction(db, || {
        let id = string(request, "catalogId")?;
        let batch = string(request, "batchId")?;
        let op = string(request, "operationId")?;
        for value in [id, batch, op] {
            uuid::Uuid::parse_str(value).map_err(|_| "Develop batch identity is invalid.")?;
        }
        let mut stable_request = request.clone();
        stable_request
            .as_object_mut()
            .ok_or("Batch request is invalid.")?
            .remove("sessionId");
        let request_hash = store_io::digest(history::canonical_json(&stable_request).as_bytes());
        if let Some(existing) = one(
            db,
            "SELECT batch_id AS batchId,request_sha256 AS requestHash FROM develop_batch_jobs WHERE catalog_id=? AND operation_id=?",
            values(&[&json!(id), &json!(op)]),
        )? {
            if existing["batchId"] != batch || existing["requestHash"] != request_hash {
                return Err("Develop batch operation conflicts with a different request.".into());
            }
            return get(db, id, batch);
        }
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM develop_batch_jobs WHERE catalog_id=?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 10_000 {
            return Err("Develop batch catalog job limit reached.".into());
        }
        let op_json = history::js_stringify(operation);
        let targets_json = history::js_stringify(&json!(target_ids));
        if op_json.len() > 2 * 1024 * 1024
            || op_json.len() + targets_json.len() + target_ids.len() * 512 > 64 * 1024 * 1024
        {
            return Err("Develop batch metadata limit exceeded.".into());
        }
        let existing_bytes:i64=db.query_row("SELECT COALESCE((SELECT SUM(length(CAST(operation_json AS BLOB))+length(CAST(targets_json AS BLOB))) FROM develop_batch_jobs WHERE catalog_id=?1),0)+COALESCE((SELECT SUM(length(CAST(state_json AS BLOB))) FROM develop_batch_items WHERE catalog_id=?1),0)",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if existing_bytes as usize + op_json.len() + targets_json.len() + target_ids.len() * 17
            > 1024 * 1024 * 1024
        {
            return Err("Develop batch catalog metadata limit exceeded.".into());
        }
        let created = request
            .get("createdAt")
            .and_then(Value::as_f64)
            .unwrap_or(now() as f64);
        let source_revision =
            if let Some(revision) = request.get("sourceRevisionId").and_then(Value::as_str) {
                Some(revision.to_owned())
            } else {
                source
                    .map(|entry| history::head(db, id, entry))
                    .transpose()?
            };
        for target in target_ids {
            source_id(db, id, target)?;
        }
        transaction(db, || {
            let emission = if kind == "auto-sync" {
                Some(db.query_row("SELECT COALESCE(MAX(emission_sequence),0)+1 FROM develop_batch_jobs WHERE catalog_id=?1",params![id],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?)
            } else {
                None
            };
            db.execute("INSERT INTO develop_batch_jobs(catalog_id,batch_id,operation_id,request_sha256,schema_version,kind,source_entry_id,source_revision_id,operation_json,targets_json,cancellation_requested,created_at,updated_at,emission_sequence) VALUES(?1,?2,?3,?4,1,?5,?6,?7,?8,?9,0,?10,?10,?11)",params![id,batch,op,request_hash,kind,source,source_revision,op_json,targets_json,created,emission]).map_err(|e|e.to_string())?;
            for (position, target) in target_ids.iter().enumerate() {
                let restore = restores
                    .and_then(|v| v.as_array())
                    .and_then(|items| items.iter().find(|i| i["entryId"] == *target));
                let expected = if let Some(restore) = restore {
                    string(restore, "afterRevisionId")?.to_owned()
                } else if let Some(frozen) = request["frozenTargets"]
                    .as_array()
                    .and_then(|v| v.iter().find(|v| v["entryId"] == *target))
                {
                    string(frozen, "expectedRevisionId")?.to_owned()
                } else {
                    history::head(db, id, target)?
                };
                let before = restore.and_then(|v| v["beforeRevisionId"].as_str());
                db.execute("INSERT INTO develop_batch_items(catalog_id,batch_id,position,entry_id,operation_id,planned_revision_id,expected_revision_id,before_revision_id,after_revision_id,restore_revision_id,state_json,attempts,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,NULL,?8,'{\"kind\":\"queued\"}',0,?9)",params![id,batch,position as i64,target,uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),expected,before,created]).map_err(|e|e.to_string())?;
            }
            get(db, id, batch)
        })
    })
}

impl BatchService {
    pub fn new(emit: Emit) -> Self {
        Self {
            running: HashMap::new(),
            emit,
            registry: Value::Null,
        }
    }
    pub fn stop(&mut self) {
        for job in self.running.values() {
            job.stop.store(true, Ordering::SeqCst);
            let _ = job.wake.send(());
        }
        for (_, job) in self.running.drain() {
            let _ = job.thread.join();
        }
    }
    pub fn wake(&self) {
        for job in self.running.values() {
            let _ = job.wake.send(());
        }
    }
    pub fn resume(&mut self, catalog: &CatalogService, registry: Value) -> Result<(), String> {
        self.registry = registry;
        if let Some(path) = catalog.active_path() {
            let db = connect(path)?;
            let id: String = db
                .query_row("SELECT catalog_id FROM catalog_meta", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            transaction(&db, || {
                db.execute("UPDATE develop_batch_items SET state_json='{\"kind\":\"queued\"}',before_revision_id=NULL,after_revision_id=NULL WHERE catalog_id=? AND json_extract(state_json,'$.kind')='active'",params![id]).map_err(|e|e.to_string())?;
                for job in rows(
                    &db,
                    "SELECT batch_id AS batchId,operation_json AS operation FROM develop_batch_jobs WHERE catalog_id=? AND cancellation_requested=0",
                    values(&[&json!(id)]),
                )? {
                    let operation: Value = serde_json::from_str(string(&job, "operation")?)
                        .map_err(|e| e.to_string())?;
                    if pending(&operation) {
                        db.execute("UPDATE develop_batch_items SET state_json=?1,updated_at=?2 WHERE catalog_id=?3 AND batch_id=?4 AND json_extract(state_json,'$.kind')='queued'",params![json!({"kind":"failed","error":"Camera profile preparation was interrupted.","retryable":true}).to_string(),now(),id,job["batchId"].as_str()]).map_err(|e|e.to_string())?;
                    }
                }
                Ok(())
            })?;
            self.spawn(path.to_owned(), id, String::new());
        }
        Ok(())
    }
    fn spawn(&mut self, path: PathBuf, id: String, _batch: String) {
        self.running.retain(|_, job| !job.thread.is_finished());
        let key = id.clone();
        if let Some(job) = self.running.get(&key) {
            let _ = job.wake.send(());
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = stop.clone();
        let emit = self.emit.clone();
        let registry = self.registry.clone();
        let (wake, receiver) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            if let Err(error) = run_catalog(&path, &id, &registry, &cancelled, &emit, receiver) {
                eprintln!("Develop batch failed: {error}");
            }
        });
        self.running.insert(key, Running { stop, wake, thread });
    }

    pub fn handle(
        &mut self,
        catalog: &CatalogService,
        develop: &mut DevelopService,
        command: &str,
        request: &Value,
    ) -> Result<Value, String> {
        self.registry = develop.profiles.list();
        catalog.require_session(request)?;
        let path = catalog
            .active_path()
            .ok_or("Catalog is unavailable.")?
            .to_path_buf();
        let db = connect(&path)?;
        let id = string(request, "catalogId")?;
        let result = match command {
            "darkroom:develop-batch-list" => {
                let limit = request["limit"]
                    .as_i64()
                    .filter(|v| (1..=250).contains(v))
                    .ok_or("Develop batch list limit is invalid.")?;
                list(&db, id, limit)
            }
            "darkroom:develop-batch-auto-state" => auto_state(&db, id),
            "darkroom:develop-batch-auto-disable" => {
                db.execute(
                    "UPDATE develop_auto_sync SET enabled=0,updated_at=?1 WHERE catalog_id=?2",
                    params![now(), id],
                )
                .map_err(|e| e.to_string())?;
                auto_state(&db, id)
            }
            "darkroom:develop-batch-auto-enable" => {
                let source = string(request, "sourceEntryId")?;
                source_id(&db, id, source)?;
                let selected = fields(&request["fields"])?;
                let targets = targets(&request["targetEntryIds"])?;
                if targets.iter().any(|v| v == source) {
                    return Err("Auto Sync source cannot be a target.".into());
                }
                let frozen=targets.iter().map(|target|{source_id(&db,id,target)?;Ok(json!({"entryId":target,"expectedRevisionId":history::head(&db,id,target)?}))}).collect::<Result<Vec<_>,String>>()?;
                let revision = history::head(&db, id, source)?;
                let operation = freeze(&json!({"kind":"copy-fields","fields":selected}), &targets)?;
                let receipt = json!({"batchId":null,"sourceEntryId":source,"sourceRevisionId":revision,"operation":operation});
                let operation =
                    prepare_operation(&db, id, &receipt, &self.registry, &AtomicBool::new(false))?
                        .ok_or("Auto Sync preparation was cancelled.")?;
                let sequence:i64=db.query_row("SELECT COALESCE(MAX(emission_sequence),0) FROM develop_batch_jobs WHERE catalog_id=?1",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
                db.execute("INSERT INTO develop_auto_sync(catalog_id,source_entry_id,source_revision_id,targets_json,fields_json,enabled,updated_at,source_emission_sequence) VALUES(?1,?2,?3,?4,?5,1,?6,?7) ON CONFLICT(catalog_id) DO UPDATE SET source_entry_id=excluded.source_entry_id,source_revision_id=excluded.source_revision_id,targets_json=excluded.targets_json,fields_json=excluded.fields_json,enabled=1,updated_at=excluded.updated_at,source_emission_sequence=excluded.source_emission_sequence",params![id,source,revision,json!(frozen).to_string(),history::canonical_json(&operation),now(),sequence]).map_err(|e|e.to_string())?;
                auto_state(&db, id)
            }
            "darkroom:develop-batch-cancel" | "darkroom:develop-batch-retry" => {
                let batch = string(request, "batchId")?;
                get(&db, id, batch)?;
                let cancel = command.ends_with("-cancel");
                transaction(&db,||{
                    db.execute("UPDATE develop_batch_jobs SET cancellation_requested=?1,updated_at=?2 WHERE catalog_id=?3 AND batch_id=?4",params![cancel,now(),id,batch]).map_err(|e|e.to_string())?;
                    if cancel {db.execute("UPDATE develop_batch_items SET state_json='{\"kind\":\"cancelled\",\"reason\":\"not-started\"}',updated_at=?1 WHERE catalog_id=?2 AND batch_id=?3 AND json_extract(state_json,'$.kind')='queued'",params![now(),id,batch]).map_err(|e|e.to_string())?;}
                    else{db.execute("UPDATE develop_batch_items SET state_json='{\"kind\":\"queued\"}',updated_at=?1 WHERE catalog_id=?2 AND batch_id=?3 AND (json_extract(state_json,'$.kind')='cancelled' OR (json_extract(state_json,'$.kind')='failed' AND json_extract(state_json,'$.retryable')=1))",params![now(),id,batch]).map_err(|e|e.to_string())?;}
                    get(&db,id,batch)
                }).inspect(|_|{if !cancel{self.spawn(path.clone(),id.into(),batch.into());}})
            }
            "darkroom:develop-batch-start" => {
                let kind = string(request, "kind")?;
                let (source, targets) = if kind == "previous" {
                    let current = string(request, "currentEntryId")?;
                    let previous=one(&db,"SELECT h.entry_id AS entryId FROM develop_history_heads h JOIN develop_history_revisions r ON r.catalog_id=h.catalog_id AND r.entry_id=h.entry_id AND r.revision_id=h.revision_id JOIN edit_entries e ON e.catalog_id=h.catalog_id AND e.entry_id=h.entry_id WHERE h.catalog_id=? AND h.entry_id<>? AND e.tombstoned_at IS NULL AND r.ordinal>0 ORDER BY r.rowid DESC,h.entry_id LIMIT 1",values(&[&json!(id),&json!(current)]))?.ok_or("No previous committed Develop entry is available.")?;
                    (
                        string(&previous, "entryId")?.to_owned(),
                        vec![current.to_owned()],
                    )
                } else if kind == "sync" || kind == "batch" {
                    (
                        string(request, "sourceEntryId")?.to_owned(),
                        targets(&request["targetEntryIds"])?,
                    )
                } else {
                    return Err("Develop batch start kind is invalid.".into());
                };
                source_id(&db, id, &source)?;
                if kind == "sync" && targets.contains(&source) {
                    return Err("Sync source cannot also be a target.".into());
                }
                let operation = if kind == "sync" || kind == "previous" {
                    json!({"kind":"copy-fields","fields":fields(&request["fields"])?})
                } else {
                    let operation = &request["operation"];
                    match operation["kind"].as_str() {
                        Some("preset") => {
                            let preset = develop
                                .presets
                                .get_revision(
                                    string(operation, "presetId")?,
                                    operation["revision"]
                                        .as_u64()
                                        .ok_or("Preset revision is invalid.")?,
                                )
                                .ok_or("Develop preset revision is unavailable.")?;
                            let amount = operation["amount"]
                                .as_f64()
                                .filter(|value| (0.0..=100.0).contains(value))
                                .ok_or("Preset amount is invalid.")?;
                            let selected = if operation["fields"].is_null() {
                                Value::Null
                            } else {
                                let requested = fields(&operation["fields"])?;
                                let included: Vec<_> = requested
                                    .into_iter()
                                    .filter(|field| {
                                        preset["fields"]
                                            .as_array()
                                            .is_some_and(|fields| fields.contains(field))
                                    })
                                    .collect();
                                if included.is_empty() {
                                    return Err(
                                        "The preset does not contain any selected fields.".into()
                                    );
                                }
                                json!(included)
                            };
                            json!({"kind":"preset","preset":preset,"fields":selected,"amount":amount})
                        }
                        Some("section-reset") => {
                            json!({"kind":"section-reset","fields":fields(&operation["fields"])?})
                        }
                        Some("selected-control") => {
                            let document = history::loaded(&db, id, &source, None)?;
                            let control = string(operation, "control")?;
                            let value = document["value"]["document"]
                                .pointer(control_path(control)?)
                                .ok_or("Develop source control is unavailable.")?;
                            json!({"kind":"selected-control","control":control,"value":value})
                        }
                        Some("clipboard") => {
                            let payload = super::clipboard::read_payload()?;
                            let selected = fields(&operation["fields"])?;
                            if selected.iter().any(|field| {
                                !payload["payload"].as_array().is_some_and(|entries| {
                                    entries.iter().any(|entry| entry["field"] == *field)
                                })
                            }) {
                                return Err(
                                    "The clipboard does not contain every selected field.".into()
                                );
                            }
                            json!({"kind":"paste-settings","payload":payload["payload"],"fields":selected})
                        }
                        _ => return Err("Develop batch action is invalid.".into()),
                    }
                };
                let operation = freeze(&operation, &targets)?;
                let receipt = transaction(&db, || {
                    let receipt = receipt_create(
                        &db,
                        request,
                        if kind == "batch" { None } else { Some(&source) },
                        &targets,
                        &operation,
                        kind,
                        None,
                    )?;
                    record_registry(&db, id, &receipt, &self.registry)?;
                    Ok(receipt)
                })?;
                self.spawn(path.clone(), id.into(), string(request, "batchId")?.into());
                Ok(receipt)
            }
            "darkroom:develop-batch-undo" => {
                let source = get(&db, id, string(request, "batchId")?)?;
                let completed: Vec<_> = source["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|i| i["state"]["kind"] == "completed")
                    .cloned()
                    .collect();
                if completed.is_empty() {
                    return Err("Develop batch has no completed targets to undo.".into());
                }
                let target_ids = completed
                    .iter()
                    .map(|i| Ok(string(i, "entryId")?.to_owned()))
                    .collect::<Result<Vec<_>, String>>()?;
                let mut undo = request.clone();
                undo["batchId"] = json!(uuid::Uuid::new_v4().to_string());
                undo["operationId"] = json!(uuid::Uuid::new_v4().to_string());
                let operation = json!({"kind":"undo","sourceBatchId":request["batchId"]});
                let receipt = receipt_create(
                    &db,
                    &undo,
                    None,
                    &target_ids,
                    &operation,
                    "undo",
                    Some(&json!(completed)),
                )?;
                self.spawn(path.clone(), id.into(), string(&undo, "batchId")?.into());
                Ok(receipt)
            }
            _ => Err("Unknown Develop batch command.".into()),
        }?;
        (self.emit)(
            "darkroom:develop-batch-updated",
            json!({"catalogId":id,"receipts":list(&db,id,100)?}),
        );
        self.spawn(path, id.into(), String::new());
        Ok(result)
    }
}

impl Drop for BatchService {
    fn drop(&mut self) {
        self.stop();
    }
}

const PENDING: &str = "Camera profile preparation is pending.";
fn uses_profile(action: &Value) -> bool {
    if action["kind"] == "selected-control" {
        return false;
    }
    if action["kind"] == "preset" && action["fields"].is_null() {
        return action["preset"]["fields"]
            .as_array()
            .is_some_and(|v| v.iter().any(|f| *f == "camera-profile"));
    }
    action["fields"]
        .as_array()
        .is_some_and(|v| v.iter().any(|f| *f == "camera-profile"))
}
fn freeze(action: &Value, targets: &[String]) -> Result<Value, String> {
    let needs_profile = uses_profile(action);
    if needs_profile && targets.len() > 32 {
        return Err("Camera-profile batches are limited to 32 targets.".into());
    }
    Ok(
        json!({"kind":"frozen","action":action,"profileContexts":targets.iter().map(|entry|json!({"entryId":entry,"context":{"kind":"unavailable","reason":if needs_profile{PENDING}else{"Camera profile was not selected."}}})).collect::<Vec<_>>() }),
    )
}
fn pending(operation: &Value) -> bool {
    operation["kind"] == "frozen"
        && operation["profileContexts"].as_array().is_some_and(|v| {
            !v.is_empty()
                && v.iter().all(|v| {
                    v["context"]["kind"] == "unavailable" && v["context"]["reason"] == PENDING
                })
        })
}
fn registry_for_receipt(
    db: &Connection,
    id: &str,
    receipt: &Value,
    registry: &Value,
) -> Result<Value, String> {
    let operation = &receipt["operation"];
    let action = &operation["action"];
    let referenced = match action["kind"].as_str() {
        Some("copy-fields") => history::reconstruct(
            db,
            id,
            string(receipt, "sourceEntryId")?,
            string(receipt, "sourceRevisionId")?,
        )?["color"]["inputProfile"]
            .clone(),
        Some("preset" | "paste-settings") => {
            let payload = if action["kind"] == "preset" {
                &action["preset"]["payload"]
            } else {
                &action["payload"]
            };
            payload
                .as_array()
                .and_then(|v| v.iter().find(|v| v["field"] == "camera-profile"))
                .map(|v| v["value"].clone())
                .unwrap_or(Value::Null)
        }
        _ => Value::Null,
    };
    let mut selected_registry = registry.clone();
    selected_registry["profiles"] = json!(
        registry["profiles"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r["kind"] == "ready"
                && r["profile"]["id"] == referenced["selection"]["profileId"]
                && r["profile"]["revision"] == referenced["selection"]["profileRevision"])
            .cloned()
            .collect::<Vec<_>>()
    );
    Ok(selected_registry)
}
fn record_registry(
    db: &Connection,
    id: &str,
    receipt: &Value,
    registry: &Value,
) -> Result<(), String> {
    if pending(&receipt["operation"]) {
        let registry = registry_for_receipt(db, id, receipt, registry)?;
        db.execute("INSERT OR IGNORE INTO develop_batch_profile_snapshots(catalog_id,batch_id,registry_json) VALUES(?1,?2,?3)",params![id,string(receipt,"batchId")?,history::canonical_json(&registry)]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
fn prepare_operation(
    db: &Connection,
    id: &str,
    receipt: &Value,
    registry: &Value,
    stop: &AtomicBool,
) -> Result<Option<Value>, String> {
    if !pending(&receipt["operation"]) {
        return Ok(Some(receipt["operation"].clone()));
    }
    let batch = receipt["batchId"].as_str();
    let cancelled = || -> Result<bool, String> {
        Ok(stop.load(Ordering::SeqCst)
            || batch
                .map(|batch| get(db, id, batch))
                .transpose()?
                .is_some_and(|r| r["cancellationRequested"] == true))
    };
    let mut operation = receipt["operation"].clone();
    let selected_registry = registry_for_receipt(db, id, receipt, registry)?;
    for item in operation["profileContexts"].as_array_mut().unwrap() {
        if cancelled()? {
            return Ok(None);
        }
        let entry = string(item, "entryId")?;
        let target=one(db,"SELECT a.asset_id AS assetId,a.root_id AS rootId,a.relative_path AS relativePath,a.format_id AS formatId,a.camera_make AS cameraMake,a.camera_model AS cameraModel,r.canonical_path AS canonicalRootPath,r.health AS rootHealth,a.observed_byte_length AS byteLength,a.observed_modified_at AS modifiedAt,a.revision FROM edit_entries e JOIN assets a ON a.catalog_id=e.catalog_id AND a.asset_id=e.source_id JOIN roots r ON r.catalog_id=a.catalog_id AND r.root_id=a.root_id WHERE e.catalog_id=? AND e.entry_id=? AND e.tombstoned_at IS NULL",values(&[&json!(id),&json!(entry)]))?.ok_or("Develop batch target is inactive.")?;
        let document = history::loaded(db, id, entry, None)?["value"]["document"].clone();
        let context = if target["formatId"] != "nef"
            || target["cameraMake"].is_null()
            || target["cameraModel"].is_null()
        {
            json!({"kind":"unavailable","reason":"The target has no verified before-tone camera-profile stage."})
        } else {
            let current = &document["color"]["inputProfile"];
            let mut location = target.clone();
            location["catalogId"] = json!(id);
            let profile = if current["selection"]["kind"] == "decoder-default" {
                json!({"matrixToLinearSrgb":current["calibration"]["matrixToLinearSrgb"],"channelScale":current["calibration"]["channelScale"],"exposureOffsetEv":current["calibration"]["exposureOffsetEv"]})
            } else {
                let path = crate::native::resolve_asset_path(&location)?;
                let before =
                    std::fs::metadata(&path).map_err(|_| "Batch profile source is unavailable.")?;
                let modified = before
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|time| time.as_nanos() as f64 / 1_000_000.0);
                if Some(before.len() as f64) != target["byteLength"].as_f64()
                    || modified != target["modifiedAt"].as_f64()
                {
                    return Err("Batch profile source changed before verification.".into());
                }
                let digest = crate::native::metadata_sha256(&path)?;
                let profile =
                    crate::native::verify_libraw_profile(&location).unwrap_or(Value::Null);
                let after =
                    std::fs::metadata(&path).map_err(|_| "Batch profile source is unavailable.")?;
                if after.len() != before.len()
                    || after.modified().ok() != before.modified().ok()
                    || crate::native::metadata_sha256(&path)? != digest
                {
                    return Err("Batch profile source changed during verification.".into());
                }
                if !profile.is_null()
                    && ["make", "model"].iter().any(|field| {
                        profile["compatibility"][field]
                            .as_str()
                            .unwrap_or("")
                            .trim()
                            .to_lowercase()
                            != target[if *field == "make" {
                                "cameraMake"
                            } else {
                                "cameraModel"
                            }]
                            .as_str()
                            .unwrap_or("")
                            .trim()
                            .to_lowercase()
                    })
                {
                    Value::Null
                } else {
                    profile
                }
            };
            let camera =
                json!({"kind":"known","make":target["cameraMake"],"model":target["cameraModel"]});
            let mut context =
                super::default_install::profile_context(&selected_registry, &profile, &camera);
            if context["kind"] == "available-before-tone"
                && current["selection"]["kind"] == "decoder-default"
            {
                context["decoderDefault"] = current.clone();
            }
            context
        };
        let current=one(db,"SELECT a.asset_id AS assetId,a.revision,a.format_id AS formatId,a.camera_make AS cameraMake,a.camera_model AS cameraModel,a.root_id AS rootId,a.relative_path AS relativePath,a.observed_byte_length AS byteLength,a.observed_modified_at AS modifiedAt FROM edit_entries e JOIN assets a ON a.catalog_id=e.catalog_id AND a.asset_id=e.source_id WHERE e.catalog_id=? AND e.entry_id=? AND e.tombstoned_at IS NULL",values(&[&json!(id),&json!(entry)]))?.ok_or("Develop batch target became inactive.")?;
        for key in [
            "assetId",
            "revision",
            "formatId",
            "cameraMake",
            "cameraModel",
            "rootId",
            "relativePath",
            "byteLength",
            "modifiedAt",
        ] {
            if current[key] != target[key] {
                return Err(
                    "Develop batch entries changed while the operation was prepared.".into(),
                );
            }
        }
        item["context"] = context;
    }
    if cancelled()? {
        return Ok(None);
    }
    Ok(Some(operation))
}
fn prepare_profiles(
    db: &Connection,
    id: &str,
    receipt: &Value,
    registry: &Value,
    stop: &AtomicBool,
) -> Result<bool, String> {
    if !pending(&receipt["operation"]) {
        return Ok(true);
    }
    let snapshot=one(db,"SELECT registry_json AS registry FROM develop_batch_profile_snapshots WHERE catalog_id=? AND batch_id=?",values(&[&json!(id),&receipt["batchId"]]))?.map(|row|serde_json::from_str::<Value>(row["registry"].as_str().unwrap_or("null")).map_err(|e|e.to_string())).transpose()?.unwrap_or_else(||registry.clone());
    let Some(operation) = prepare_operation(db, id, receipt, &snapshot, stop)? else {
        return Ok(false);
    };
    transaction(db, || {
        if get(db, id, string(receipt, "batchId")?)?["cancellationRequested"] == true {
            return Ok(false);
        }
        db.execute("UPDATE develop_batch_jobs SET operation_json=?1,updated_at=?2 WHERE catalog_id=?3 AND batch_id=?4",params![history::canonical_json(&operation),now(),id,string(receipt,"batchId")?]).map_err(|e|e.to_string())?;
        Ok(true)
    })
}

fn reconcile_auto(db: &Connection, id: &str) -> Result<(), String> {
    transaction(db, || {
        let Some(config) = one(
            db,
            "SELECT source_entry_id AS sourceEntryId,source_revision_id AS sourceRevisionId,targets_json AS targets,fields_json AS fields FROM develop_auto_sync WHERE catalog_id=? AND enabled=1",
            values(&[&json!(id)]),
        )?
        else {
            return Ok(());
        };
        let source = string(&config, "sourceEntryId")?;
        let head = history::head(db, id, source)?;
        let cursor = string(&config, "sourceRevisionId")?;
        if head == cursor {
            return Ok(());
        }
        let mut next = None;
        let mut revision = head;
        for _ in 0..=500 {
            if revision == cursor {
                break;
            }
            let Some(found) = one(
                db,
                "SELECT revision_id AS revisionId,parent_revision_id AS parentRevisionId,operation_id AS operationId,created_at AS createdAt FROM develop_history_revisions WHERE catalog_id=? AND entry_id=? AND revision_id=?",
                values(&[&json!(id), &json!(source), &json!(revision)]),
            )?
            else {
                return Err("Auto Sync source history is incomplete.".into());
            };
            revision = string(&found, "parentRevisionId")?.to_owned();
            next = Some(found);
        }
        if revision != cursor {
            return Err("Auto Sync cursor is not retained in source history.".into());
        }
        let next = next.ok_or("Auto Sync source history cannot advance.")?;
        let frozen: Value =
            serde_json::from_str(string(&config, "targets")?).map_err(|e| e.to_string())?;
        let target_ids = frozen
            .as_array()
            .ok_or("Auto Sync targets are invalid.")?
            .iter()
            .map(|v| Ok(string(v, "entryId")?.to_owned()))
            .collect::<Result<Vec<_>, String>>()?;
        let stored: Value =
            serde_json::from_str(string(&config, "fields")?).map_err(|e| e.to_string())?;
        let operation = if stored.is_array() {
            json!({"kind":"copy-fields","fields":stored})
        } else {
            stored
        };
        let request = json!({"catalogId":id,"batchId":next["revisionId"],"operationId":next["operationId"],"sourceRevisionId":next["revisionId"],"createdAt":next["createdAt"],"frozenTargets":frozen});
        receipt_create(
            db,
            &request,
            Some(source),
            &target_ids,
            &operation,
            "auto-sync",
            None,
        )?;
        db.execute("UPDATE develop_auto_sync SET source_revision_id=?1,source_emission_sequence=(SELECT emission_sequence FROM develop_batch_jobs WHERE catalog_id=?2 AND batch_id=?1),updated_at=?3 WHERE catalog_id=?2 AND source_revision_id=?4 AND enabled=1",params![next["revisionId"].as_str(),id,now(),cursor]).map_err(|e|e.to_string())?;
        Ok(())
    })
}

fn run_catalog(
    path: &Path,
    id: &str,
    registry: &Value,
    stop: &AtomicBool,
    emit: &Emit,
    wake: std::sync::mpsc::Receiver<()>,
) -> Result<(), String> {
    let db = connect(path)?;
    let mut last_error = String::new();
    while !stop.load(Ordering::SeqCst) {
        if let Err(error) = reconcile_auto(&db, id) {
            if last_error != error {
                eprintln!("Could not reconcile Auto Sync: {error}");
                last_error = error;
            }
        }
        let jobs = rows(
            &db,
            "SELECT j.batch_id AS batchId FROM develop_batch_jobs j WHERE j.catalog_id=? AND j.cancellation_requested=0 AND EXISTS(SELECT 1 FROM develop_batch_items i WHERE i.catalog_id=j.catalog_id AND i.batch_id=j.batch_id AND json_extract(i.state_json,'$.kind') IN ('queued','active')) ORDER BY j.created_at,j.rowid",
            values(&[&json!(id)]),
        )?;
        if jobs.is_empty() {
            if wake.recv().is_err() {
                break;
            }
            continue;
        }
        for job in jobs {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let batch = string(&job, "batchId")?;
            let receipt = get(&db, id, batch)?;
            match prepare_profiles(&db, id, &receipt, registry, stop) {
                Ok(true) => run(path, id, batch, stop, emit)?,
                Ok(false) => (),
                Err(error) => {
                    db.execute("UPDATE develop_batch_items SET state_json=?1,updated_at=?2 WHERE catalog_id=?3 AND batch_id=?4 AND json_extract(state_json,'$.kind') IN ('queued','active')",params![json!({"kind":"failed","error":error,"retryable":true}).to_string(),now(),id,batch]).map_err(|e|e.to_string())?;
                    emit(
                        "darkroom:develop-batch-updated",
                        json!({"catalogId":id,"receipts":list(&db,id,100)?}),
                    );
                }
            }
        }
    }
    Ok(())
}

fn auto_state(db: &Connection, id: &str) -> Result<Value, String> {
    let Some(row) = one(
        db,
        "SELECT enabled,source_entry_id AS sourceEntryId,targets_json AS targets,fields_json AS fields FROM develop_auto_sync WHERE catalog_id=?",
        values(&[&json!(id)]),
    )?
    else {
        return Ok(
            json!({"kind":"auto-state","enabled":false,"sourceEntryId":null,"targetEntryIds":[],"fields":[]}),
        );
    };
    if row["enabled"] != 1 {
        return Ok(
            json!({"kind":"auto-state","enabled":false,"sourceEntryId":null,"targetEntryIds":[],"fields":[]}),
        );
    }
    let targets: Value =
        serde_json::from_str(string(&row, "targets")?).map_err(|e| e.to_string())?;
    let operation: Value =
        serde_json::from_str(string(&row, "fields")?).map_err(|e| e.to_string())?;
    let fields = if operation.is_array() {
        operation
    } else if operation["kind"] == "frozen" {
        operation["action"]["fields"].clone()
    } else {
        operation["fields"].clone()
    };
    Ok(
        json!({"kind":"auto-state","enabled":true,"sourceEntryId":row["sourceEntryId"],"targetEntryIds":targets.as_array().ok_or("Auto Sync targets are invalid.")?.iter().map(|t|t["entryId"].clone()).collect::<Vec<_>>(),"fields":fields}),
    )
}

fn execute_action(
    db: &Connection,
    id: &str,
    receipt: &Value,
    item: &Value,
    target: Value,
) -> Result<Value, String> {
    let operation = &receipt["operation"];
    let action = if operation["kind"] == "frozen" {
        &operation["action"]
    } else {
        operation
    };
    if action["kind"] == "undo" {
        return Ok(
            json!({"kind":"changed","document":history::reconstruct(db,id,string(item,"entryId")?,string(item,"restoreRevisionId")?)?,"warnings":[]}),
        );
    }
    if target["version"] != 3 || target["process"] != "darkroom-v3" {
        return Ok(
            json!({"kind":"skipped","reason":"Target is not an editable V3 Develop document."}),
        );
    }
    if action["kind"] == "selected-control" {
        let mut target = target;
        let path = control_path(string(action, "control")?)?;
        *target
            .pointer_mut(path)
            .ok_or("Target control is unavailable.")? = action["value"].clone();
        return Ok(json!({"kind":"changed","document":target,"warnings":[]}));
    }
    let context=operation["profileContexts"].as_array().and_then(|items|items.iter().find(|p|p["entryId"]==item["entryId"])).map(|p|p["context"].clone()).unwrap_or_else(||json!({"kind":"unavailable","reason":"Batch profile application requires a verified before-tone registry snapshot."}));
    let target_source = source_id(db, id, string(item, "entryId")?)?;
    if action["kind"] == "section-reset" {
        return apply::reset_fields(
            target,
            &fields(&action["fields"])?,
            &json!(target_source),
            &context,
        );
    }
    let (preset, selection, amount) = if action["kind"] == "preset" {
        (
            action["preset"].clone(),
            action["fields"].as_array().cloned(),
            action["amount"]
                .as_f64()
                .ok_or("Preset amount is invalid.")?,
        )
    } else {
        let selected = fields(&action["fields"])?;
        let payload = if action["kind"] == "paste-settings" {
            action["payload"].clone()
        } else if action["kind"] == "copy-fields" {
            let source = string(receipt, "sourceEntryId")?;
            let document =
                history::reconstruct(db, id, source, string(receipt, "sourceRevisionId")?)?;
            if document["version"] != 3 {
                return Ok(
                    json!({"kind":"skipped","reason":"Source is not an editable V3 Develop document."}),
                );
            }
            json!(apply::capture(
                &document,
                &selected,
                &json!(source_id(db, id, source)?)
            )?)
        } else {
            return Err("Unknown Develop batch action.".into());
        };
        (
            json!({"schemaVersion":1,"presetId":receipt["operationId"],"revision":1,"name":"Frozen batch settings","author":"Darkroom","category":"Batch","source":"user","favorite":false,"fields":selected,"payload":payload,"compatibility":{"process":"darkroom-v3","documentSchemaRevision":"darkroom-v3-document-2"}}),
            None,
            100.0,
        )
    };
    let application = apply::apply_preset(
        &target,
        &preset,
        selection.as_deref(),
        amount,
        &json!({"sourceId":target_source,"cameraProfile":context,"regenerateAiMasks":false}),
    )?;
    let warnings: Vec<_> = ["unsupported", "skipped", "regenerationRequests"]
        .iter()
        .flat_map(|key| application["report"][key].as_array().into_iter().flatten())
        .map(|v| {
            json!(format!(
                "{}: {}",
                v["field"].as_str().unwrap_or("field"),
                v["reason"].as_str().unwrap_or("unavailable")
            ))
        })
        .collect();
    if application["report"]["included"]
        .as_array()
        .is_none_or(Vec::is_empty)
    {
        return Ok(
            json!({"kind":"skipped","reason":warnings.first().cloned().unwrap_or(json!("No compatible Develop fields were selected."))}),
        );
    }
    Ok(json!({"kind":"changed","document":application["document"],"warnings":warnings}))
}

fn run(path: &Path, id: &str, batch: &str, stop: &AtomicBool, emit: &Emit) -> Result<(), String> {
    let db = connect(path)?;
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let receipt = get(&db, id, batch)?;
        if receipt["cancellationRequested"] == true {
            break;
        }
        let Some(item) = receipt["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["state"]["kind"] == "queued" || i["state"]["kind"] == "active")
            .cloned()
        else {
            break;
        };
        let position = item["position"]
            .as_i64()
            .ok_or("Batch position is invalid.")?;
        let claimed=db.execute("UPDATE develop_batch_items SET state_json='{\"kind\":\"active\",\"phase\":\"apply\"}',attempts=attempts+1,updated_at=?1 WHERE catalog_id=?2 AND batch_id=?3 AND position=?4 AND json_extract(state_json,'$.kind') IN ('queued','active') AND EXISTS(SELECT 1 FROM develop_batch_jobs WHERE catalog_id=?2 AND batch_id=?3 AND cancellation_requested=0)",params![now(),id,batch,position]).map_err(|e|e.to_string())?;
        if claimed == 0 {
            continue;
        }
        let result = (|| {
            let entry = string(&item, "entryId")?;
            source_id(&db, id, entry)?;
            let head = history::head(&db, id, entry)?;
            if item["plannedRevisionId"] == head {
                db.execute("UPDATE develop_batch_items SET before_revision_id=expected_revision_id,after_revision_id=planned_revision_id WHERE catalog_id=?1 AND batch_id=?2 AND position=?3",params![id,batch,position]).map_err(|e|e.to_string())?;
                return Ok(
                    json!({"kind":"completed","entryId":entry,"revisionId":head,"warnings":[]}),
                );
            }
            if item["expectedRevisionId"] != head {
                return Ok(
                    json!({"kind":"skipped","reason":"Target Develop revision changed after the batch was frozen."}),
                );
            }
            let target = history::reconstruct(&db, id, entry, &head)?;
            let prepared = execute_action(&db, id, &receipt, &item, target)?;
            if prepared["kind"] == "skipped" {
                return Ok(prepared);
            }
            transaction(&db, || {
                let result = history::commit(
                    &db,
                    &json!({"catalogId":id,"entryId":entry,"revisionId":item["plannedRevisionId"],"expectedParentRevisionId":item["expectedRevisionId"],"operationId":item["operationId"],"label":if receipt["kind"]=="undo"{"Undo Develop batch"}else{"Develop batch"},"document":prepared["document"],"createdAt":receipt["createdAt"].as_f64().unwrap_or(now() as f64)+position as f64/100000.0}),
                )?;
                let revision = &result["revision"]["revisionId"];
                let state = json!({"kind":"completed","entryId":entry,"revisionId":revision,"warnings":prepared["warnings"]});
                db.execute("UPDATE develop_batch_items SET before_revision_id=expected_revision_id,after_revision_id=?1,state_json=?5,updated_at=?6 WHERE catalog_id=?2 AND batch_id=?3 AND position=?4",params![revision.as_str(),id,batch,position,history::canonical_json(&state),now()]).map_err(|e|e.to_string())?;
                if receipt["kind"] == "auto-sync" {
                    if let Some(config) = one(
                        &db,
                        "SELECT targets_json AS targets FROM develop_auto_sync WHERE catalog_id=? AND enabled=1",
                        values(&[&json!(id)]),
                    )? {
                        let mut targets: Value = serde_json::from_str(string(&config, "targets")?)
                            .map_err(|e| e.to_string())?;
                        for target in targets
                            .as_array_mut()
                            .ok_or("Auto Sync targets are invalid.")?
                        {
                            if target["entryId"] == entry {
                                target["expectedRevisionId"] = revision.clone();
                            }
                        }
                        db.execute("UPDATE develop_auto_sync SET targets_json=?1,updated_at=?2 WHERE catalog_id=?3",params![history::canonical_json(&targets),now(),id]).map_err(|e|e.to_string())?;
                    }
                }
                Ok(state)
            })
        })();
        let state=result.unwrap_or_else(|error:String|json!({"kind":"failed","error":error.chars().take(1024).collect::<String>(),"retryable":true}));
        transaction(&db, || {
            db.execute("UPDATE develop_batch_items SET state_json=?1,updated_at=?2 WHERE catalog_id=?3 AND batch_id=?4 AND position=?5",params![history::js_stringify(&state),now(),id,batch,position]).map_err(|e|e.to_string())?;
            db.execute(
                "UPDATE develop_batch_jobs SET updated_at=?1 WHERE catalog_id=?2 AND batch_id=?3",
                params![now(), id, batch],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })?;
        emit(
            "darkroom:develop-batch-updated",
            json!({"catalogId":id,"receipts":list(&db,id,100)?}),
        );
    }
    Ok(())
}
