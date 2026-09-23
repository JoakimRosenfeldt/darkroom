use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64}};

use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};
use serde_json::{json, Map, Value};
use uuid::Uuid;

mod live;
pub(crate) mod history;
mod scan;
mod admin;
mod fingerprint;
mod relink;
mod watch;
mod metadata;
#[allow(unused_imports)]
pub use metadata::{run_metadata_analysis,MetadataPlan};
mod trash_duplicates;
#[allow(unused_imports)]
pub use trash_duplicates::{run_exact_duplicate_trash,ExactDuplicateTrashPlan};
pub(crate) mod import;
#[allow(unused_imports)]
pub(crate) use import::ImportTask;
mod auto;
mod migrate;

const SCHEMA: &str = include_str!("schema.sql");

fn upgrade_v3(db:&Connection)->Result<(),String> {
    for table in ["catalog_meta","migration_runs","roots","assets","asset_metadata","albums","album_assets","fingerprints","import_presets","auto_import_rules","operations","operation_items","migration_aliases","audit_log"] {
        if one(db,"SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",vec![SqlValue::Text(table.into())])?.is_none() {return Err(format!("Catalog v3 table {table} is missing."))}
    }
    db.execute_batch(SCHEMA).map_err(|e|e.to_string())?;
    for column in ["display_name","parent_entry_id","tombstoned_at"] {
        if !rows(db,"PRAGMA table_info(edit_entries)",vec![])?.iter().any(|v|v["name"]==column) {db.execute_batch(&format!("ALTER TABLE edit_entries ADD COLUMN {column} {};",if column=="tombstoned_at"{"REAL"}else{"TEXT"})).map_err(|e|e.to_string())?}
    }
    db.execute_batch("BEGIN IMMEDIATE").map_err(|e|e.to_string())?;
    let result=db.execute_batch("INSERT OR IGNORE INTO edit_entries (catalog_id,entry_id,source_id,is_original,created_at,updated_at) SELECT catalog_id,asset_id,asset_id,1,COALESCE(observed_at,0),COALESCE(observed_at,0) FROM assets;
        INSERT OR IGNORE INTO entry_metadata (catalog_id,entry_id,archive,pick,rating,color_label,develop_json,develop_updated_at,updated_at,title,caption,copyright,keywords_json,raw_xmp,xmp_state,xmp_mtime,xmp_sha256) SELECT catalog_id,asset_id,archive,pick,rating,color_label,develop_json,develop_updated_at,updated_at,title,caption,copyright,keywords_json,raw_xmp,xmp_state,xmp_mtime,xmp_sha256 FROM asset_metadata;
        INSERT OR IGNORE INTO album_entries (catalog_id,album_id,entry_id,position) SELECT catalog_id,album_id,asset_id,position FROM album_assets;
        UPDATE edit_entries SET parent_entry_id=(SELECT original.entry_id FROM edit_entries original WHERE original.catalog_id=edit_entries.catalog_id AND original.source_id=edit_entries.source_id AND original.is_original=1) WHERE is_original=0 AND EXISTS (SELECT 1 FROM edit_entries original WHERE original.catalog_id=edit_entries.catalog_id AND original.source_id=edit_entries.source_id AND original.is_original=1) AND parent_entry_id IS NOT (SELECT original.entry_id FROM edit_entries original WHERE original.catalog_id=edit_entries.catalog_id AND original.source_id=edit_entries.source_id AND original.is_original=1);");
    match result {Ok(())=>db.execute_batch("COMMIT").map_err(|e|e.to_string()),Err(error)=>{let _=db.execute_batch("ROLLBACK");Err(error.to_string())}}
}

pub struct CatalogService {
    user_data: PathBuf,
    registry: Value,
    active: Option<ActiveCatalog>,
    db: Option<Connection>,
    operations: Arc<Mutex<HashMap<String, ScanOperation>>>,
    scan_handles: Vec<std::thread::JoinHandle<()>>,
    fingerprint_jobs: Arc<Mutex<HashMap<String, fingerprint::FingerprintJob>>>,
    relink_drafts: HashMap<String, relink::StoredDraft>,
    watcher_stops: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
    watcher_handles: Vec<std::thread::JoinHandle<()>>,
    import_drafts: HashMap<String,import::StoredDraft>,
    import_jobs: HashMap<String,import::ImportJob>,
    auto_stop: Arc<AtomicBool>,
    auto_guard: Arc<Mutex<()>>,
    auto_cancellations: Arc<Mutex<HashMap<String,Arc<AtomicBool>>>>,
    auto_handle: Option<std::thread::JoinHandle<()>>,
    emit: Option<Arc<dyn Fn(&str,Value)+Send+Sync>>,
    event_sequence: Arc<AtomicU64>,
}

#[derive(Clone)]
struct ActiveCatalog {
    catalog_id: String,
    session_id: String,
    database_path: PathBuf,
}

struct ScanOperation {
    snapshot: Value,
    cancelled: Arc<AtomicBool>,
}

pub(crate) fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value.get(key).ok_or_else(|| format!("Catalog {key} is missing."))
}

pub(crate) fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    field(value, key)?.as_str().filter(|v| !v.is_empty() && !v.contains('\0'))
        .ok_or_else(|| format!("Catalog {key} is invalid."))
}

pub(crate) fn number(value: &Value, key: &str) -> Result<i64, String> {
    field(value, key)?.as_i64().ok_or_else(|| format!("Catalog {key} is invalid."))
}

pub(crate) fn first(args: &Value) -> Result<&Value, String> {
    args.as_array().and_then(|a| a.first()).ok_or_else(|| "Catalog request is missing.".into())
}

pub(crate) fn sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Text(history::js_stringify(value)),
    }
}

pub(crate) fn row_object(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut result = Map::new();
    for index in 0..row.as_ref().column_count() {
        let key = row.as_ref().column_name(index)?.to_string();
        let value = match row.get_ref(index)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(v) => json!(v),
            rusqlite::types::ValueRef::Real(v) => json!(v),
            rusqlite::types::ValueRef::Text(v) => Value::String(String::from_utf8_lossy(v).into_owned()),
            rusqlite::types::ValueRef::Blob(v) => json!(v),
        };
        result.insert(key, value);
    }
    Ok(Value::Object(result))
}

pub(crate) fn rows(db: &Connection, sql: &str, values: Vec<SqlValue>) -> Result<Vec<Value>, String> {
    let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
    let selected = statement.query_map(params_from_iter(values), row_object).map_err(|e| e.to_string())?;
    selected.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

pub(crate) fn one(db: &Connection, sql: &str, values: Vec<SqlValue>) -> Result<Option<Value>, String> {
    Ok(rows(db, sql, values)?.into_iter().next())
}

pub(crate) fn execute(db: &Connection, sql: &str, values: Vec<SqlValue>) -> Result<usize, String> {
    db.execute(sql, params_from_iter(values)).map_err(|e| e.to_string())
}

pub(crate) fn values(fields: &[&Value]) -> Vec<SqlValue> { fields.iter().map(|v| sql_value(v)).collect() }

pub(crate) fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_millis() as i64
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid settings path.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".{}.{}.tmp", path.file_name().unwrap_or_default().to_string_lossy(), Uuid::new_v4()));
    fs::write(&temporary, format!("{}\n", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

impl CatalogService {
    pub(crate) fn for_worker(db: Connection) -> Self {
        Self { user_data:PathBuf::new(), registry:json!({"version":1,"catalogs":[]}), active:None, db:Some(db), operations:Arc::new(Mutex::new(HashMap::new())), scan_handles:Vec::new(), fingerprint_jobs:Arc::new(Mutex::new(HashMap::new())), relink_drafts:HashMap::new(), watcher_stops:Arc::new(Mutex::new(Vec::new())), watcher_handles:Vec::new(), import_drafts:HashMap::new(), import_jobs:HashMap::new(), auto_stop:Arc::new(AtomicBool::new(false)), auto_guard:Arc::new(Mutex::new(())), auto_cancellations:Arc::new(Mutex::new(HashMap::new())), auto_handle:None, emit:None, event_sequence:Arc::new(AtomicU64::new(0)) }
    }

    pub fn new(user_data: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&user_data).map_err(|e| e.to_string())?;
        let registry_path = user_data.join("catalog-registry.json");
        let registry = match fs::read_to_string(registry_path) {
            Ok(contents) => serde_json::from_str::<Value>(&contents).map_err(|e| e.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({"version": 1, "catalogs": []}),
            Err(error) => return Err(error.to_string()),
        };
        if registry.get("version") != Some(&json!(1)) || !registry.get("catalogs").is_some_and(Value::is_array) {
            return Err("Catalog registry document is invalid.".into());
        }
        Ok(Self { user_data, registry, active: None, db: None, operations: Arc::new(Mutex::new(HashMap::new())), scan_handles:Vec::new(), fingerprint_jobs: Arc::new(Mutex::new(HashMap::new())), relink_drafts: HashMap::new(), watcher_stops: Arc::new(Mutex::new(Vec::new())), watcher_handles:Vec::new(), import_drafts:HashMap::new(), import_jobs:HashMap::new(), auto_stop:Arc::new(AtomicBool::new(false)), auto_guard:Arc::new(Mutex::new(())), auto_cancellations:Arc::new(Mutex::new(HashMap::new())), auto_handle:None, emit: None, event_sequence: Arc::new(AtomicU64::new(0)) })
    }

    pub fn dispatch(&mut self, command: &str, args: Value) -> Result<Value, String> {
        match command {
            "darkroom:catalog-bootstrap" => self.bootstrap(),
            "darkroom:catalog-create" => self.create(&args),
            "darkroom:catalog-open" | "darkroom:catalog-switch" => self.open(string(first(&args)?, "catalogId")?),
            "darkroom:catalog-close" => { self.require_session(first(&args)?)?; self.cancel_all_scans(); self.cancel_imports(); self.stop_watchers(); self.stop_auto(); self.relink_drafts.clear(); self.active = None; self.db = None; self.set_last_catalog(None)?; Ok(Value::Null) },
            "darkroom:catalog-trash-asset" => { self.require_session(first(&args)?)?; Err("Removing files from disk is unavailable until recovery can be guaranteed.".into()) },
            "darkroom:catalog-remove" => self.remove(first(&args)?),
            "darkroom:catalog-query" => { self.require_session(first(&args)?)?; self.query(first(&args)?) },
            "darkroom:catalog-apply" => {
                let request=first(&args)?;
                self.require_session(request)?;
                let result=self.apply(request)?;
                if let Some(name)=request["mutations"].as_array().and_then(|items|items.iter().rev().find(|item|item["kind"]=="rename-catalog")).and_then(|item|item["displayName"].as_str()) {
                    if let Some(entry)=self.registry["catalogs"].as_array_mut().and_then(|items|items.iter_mut().find(|item|item["catalogId"]==request["catalogId"])) {
                        entry["displayName"]=json!(name);
                        self.save_registry()?;
                    }
                }
                Ok(result)
            },
            "darkroom:catalog-add-root" => self.add_root(&args),
            "darkroom:catalog-relink-root" => self.relink_root(&args),
            "darkroom:catalog-start-scan" => self.start_scan(first(&args)?),
            "darkroom:catalog-cancel-scan" => self.cancel_scan(first(&args)?),
            "darkroom:catalog-get-operation" => self.scan_operation(first(&args)?,false),
            "darkroom:catalog-wait-operation" => self.scan_operation(first(&args)?,true),
            "darkroom:catalog-fingerprint-status" | "darkroom:catalog-fingerprint-start" | "darkroom:catalog-fingerprint-resume" | "darkroom:catalog-fingerprint-recover" | "darkroom:catalog-fingerprint-cancel" => self.fingerprint_dispatch(command,first(&args)?),
            "darkroom:catalog-relink-files-prepare" | "darkroom:catalog-relink-files-apply" | "darkroom:catalog-relink-files-cancel" => self.relink_dispatch(command,&args),
            "darkroom:catalog-import-prepare" | "darkroom:catalog-import-review" | "darkroom:catalog-import-cancel" => self.import_dispatch(command,&args),
            "darkroom:catalog-import-run" => self.begin_import(first(&args)?)?.wait(),
            "darkroom:catalog-auto-import-configure" | "darkroom:catalog-auto-import-status" | "darkroom:catalog-auto-import-enable" | "darkroom:catalog-auto-import-disable" | "darkroom:catalog-auto-import-pause" | "darkroom:catalog-auto-import-resume" | "darkroom:catalog-auto-import-retry-failed" | "darkroom:catalog-auto-import-clear-failed" | "darkroom:catalog-auto-import-cancel" | "darkroom:catalog-auto-import-open-ingress" => self.auto_dispatch(command,first(&args)?),
            "darkroom:catalog-admin-inspect" | "darkroom:catalog-admin-backup" | "darkroom:catalog-admin-export" | "darkroom:catalog-admin-validate-package" | "darkroom:catalog-admin-import-as-new" | "darkroom:catalog-admin-optimize-preview" | "darkroom:catalog-admin-optimize" | "darkroom:catalog-admin-get-backup-policy" | "darkroom:catalog-admin-set-backup-policy" | "darkroom:catalog-admin-run-scheduled-backup" => self.admin_dispatch(command,&args),
            "darkroom:develop-history-load" | "darkroom:develop-history-list" | "darkroom:develop-history-refs" | "darkroom:develop-history-projection-get" | "darkroom:develop-history-commit" | "darkroom:develop-history-ref-mutate" | "darkroom:develop-history-projection-set" => self.history_dispatch(command,&args),
            _ => Err(format!("Unsupported catalog command: {command}")),
        }
    }

    pub fn active_database(&self) -> Option<&Connection> { self.db.as_ref() }

    pub fn set_emit(&mut self, callback: Arc<dyn Fn(&str,Value)+Send+Sync>) { self.emit=Some(callback); }

    pub fn active_path(&self) -> Option<&Path> { self.active.as_ref().map(|a| a.database_path.as_path()) }

    fn db(&self) -> Result<&Connection, String> { self.db.as_ref().ok_or_else(|| "No catalog is open.".into()) }

    fn registry_path(&self) -> PathBuf { self.user_data.join("catalog-registry.json") }

    fn save_registry(&self) -> Result<(), String> { write_json(&self.registry_path(), &self.registry) }

    fn catalog_list(&self) -> Vec<Value> {
        self.registry["catalogs"].as_array().into_iter().flatten().map(|item| json!({
            "catalogId": item["catalogId"], "displayName": item["displayName"],
            "health": item["health"], "lastOpenedAt": item["lastOpenedAt"]
        })).collect()
    }

    fn set_last_catalog(&self, catalog_id: Option<&str>) -> Result<(), String> {
        let path = self.user_data.join("settings.json");
        let mut settings = fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(Value::is_object).unwrap_or_else(|| json!({}));
        settings["lastCatalogId"] = catalog_id.map_or(Value::Null, |v| json!(v));
        write_json(&path, &settings)
    }

    fn bootstrap(&mut self) -> Result<Value, String> {
        let migration_recovery=if self.registry["catalogs"].as_array().is_some_and(Vec::is_empty){self.migrate_legacy()?}else{None};
        let settings = fs::read_to_string(self.user_data.join("settings.json")).ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let last = settings.as_ref().and_then(|v| v.get("lastCatalogId")).and_then(Value::as_str);
        let mut recovery = migration_recovery.unwrap_or(Value::Null);
        if self.active.is_none() {
            if let Some(id) = last {
                if self.open(id).is_err() {
                    recovery = json!({"kind":"corrupt", "catalogId":id, "message":"The last catalog could not be opened."});
                }
            }
        }
        Ok(json!({"catalogs":self.catalog_list(), "session":self.active_session()?, "recovery":recovery}))
    }

    fn active_session(&self) -> Result<Value, String> {
        let Some(active) = &self.active else { return Ok(Value::Null) };
        let roots = rows(self.db()?, "SELECT catalog_id AS catalogId, root_id AS rootId, label FROM roots WHERE catalog_id = ? ORDER BY root_id", vec![SqlValue::Text(active.catalog_id.clone())])?;
        Ok(json!({"catalogId":active.catalog_id,"sessionId":active.session_id,"roots":roots}))
    }

    fn activate(&mut self, catalog_id: &str, path: PathBuf) -> Result<Value, String> {
        self.cancel_all_scans();
        self.cancel_imports();
        self.stop_watchers();
        self.stop_auto();
        self.relink_drafts.clear();
        if !path.is_file() { return Err("Catalog file is missing.".into()) }
        let db = Connection::open(&path).map_err(|e| e.to_string())?;
        db.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
        let app_id: i64 = db.query_row("PRAGMA application_id", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        if app_id != 1_146_243_891 || version != 3 { return Err("Catalog database format is invalid.".into()) }
        let actual_id: String = db.query_row("SELECT catalog_id FROM catalog_meta", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        if actual_id != catalog_id { return Err("Catalog database identity mismatch.".into()) }
        upgrade_v3(&db)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS library_state (catalog_id TEXT PRIMARY KEY,state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json)='object'),updated_at REAL NOT NULL,FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id)) STRICT;").map_err(|e| e.to_string())?;
        history::install(&db)?;
        history::ensure_roots(&db,catalog_id)?;
        history::backfill_asset_refs(&db,catalog_id)?;
        self.db = Some(db);
        self.active = Some(ActiveCatalog { catalog_id: catalog_id.into(), session_id: Uuid::new_v4().to_string(), database_path: path });
        self.set_last_catalog(Some(catalog_id))?;
        let session = self.active_session()?;
        let entry = self.registry["catalogs"].as_array_mut().ok_or("Catalog registry is invalid.")?
            .iter_mut().find(|v| v["catalogId"] == catalog_id).ok_or("Catalog is not registered.")?;
        entry["health"] = json!("healthy"); entry["lastOpenedAt"] = json!(now());
        let catalog = json!({"catalogId":entry["catalogId"],"displayName":entry["displayName"],"health":entry["health"],"lastOpenedAt":entry["lastOpenedAt"]});
        self.save_registry()?;
        self.start_watchers()?;
        self.recover_imports()?;
        self.start_auto()?;
        Ok(json!({"catalog":catalog,"session":session}))
    }

    fn open(&mut self, catalog_id: &str) -> Result<Value, String> {
        let item = self.registry["catalogs"].as_array().ok_or("Catalog registry is invalid.")?
            .iter().find(|v| v["catalogId"] == catalog_id).ok_or("Catalog was not found.")?;
        let path = PathBuf::from(string(item, "databasePath")?);
        self.activate(catalog_id, path)
    }

    fn create(&mut self, args: &Value) -> Result<Value, String> {
        let input = first(args)?;
        let name = string(input, "displayName")?;
        let selected = args.as_array().and_then(|a| a.get(1)).and_then(Value::as_str)
            .ok_or("Folder selection was cancelled.")?;
        let canonical = fs::canonicalize(selected).map_err(|e| e.to_string())?;
        if !canonical.is_dir() { return Err("Catalog root must be a folder.".into()) }
        let catalog_id = Uuid::new_v4().to_string();
        let root_id = Uuid::new_v4().to_string();
        let database_path = self.user_data.join("catalogs").join(format!("{catalog_id}.sqlite"));
        fs::create_dir_all(database_path.parent().ok_or("Catalog path is invalid.")?).map_err(|e| e.to_string())?;
        let db = Connection::open(&database_path).map_err(|e| e.to_string())?;
        db.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
        db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS library_state (catalog_id TEXT PRIMARY KEY,state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json)='object'),updated_at REAL NOT NULL,FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id)) STRICT;").map_err(|e| e.to_string())?;
        history::install(&db)?;
        let timestamp = now();
        db.execute("INSERT INTO catalog_meta (catalog_id,singleton,display_name,schema_version,app_version,install_state,revision,created_at,updated_at) VALUES (?1,1,?2,3,'0.1.0','ready',1,?3,?3)", params![catalog_id,name,timestamp]).map_err(|e| e.to_string())?;
        let path = canonical.to_string_lossy().into_owned();
        let label = canonical.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| "Library".into());
        db.execute("INSERT INTO roots (catalog_id,root_id,label,configured_path,canonical_path,health,scan_state,watch_state,revision) VALUES (?1,?2,?3,?4,?4,'online','unknown','disabled',1)", params![catalog_id,root_id,label,path]).map_err(|e| e.to_string())?;
        db.execute("INSERT INTO audit_log (catalog_id,migration_id,event,payload_json,created_at) VALUES (?1,NULL,'live-create',?2,?3)", params![catalog_id,json!({"version":1,"revision":1,"rootId":root_id}).to_string(),timestamp]).map_err(|e| e.to_string())?;
        drop(db);
        self.registry["catalogs"].as_array_mut().ok_or("Catalog registry is invalid.")?.push(json!({
            "catalogId":catalog_id,"displayName":name,"databasePath":database_path.to_string_lossy(),"health":"healthy","lastOpenedAt":timestamp
        }));
        self.save_registry()?;
        self.activate(&catalog_id, database_path)
    }

    pub fn require_session(&self, request: &Value) -> Result<(), String> {
        let active = self.active.as_ref().ok_or("Catalog session is inactive.")?;
        if string(request,"catalogId")? != active.catalog_id || string(request,"sessionId")? != active.session_id {
            return Err("Catalog session is stale.".into())
        }
        Ok(())
    }

    pub fn resolve_asset(&self, request: &Value) -> Result<Value, String> {
        self.require_session(request)?;
        let asset_id=string(request,"assetId")?;
        let catalog_id=string(request,"catalogId")?;
        let row=one(self.db()?,"SELECT a.root_id AS rootId,a.relative_path AS relativePath,r.canonical_path AS canonicalRootPath,r.health AS rootHealth FROM assets a JOIN roots r ON r.catalog_id=a.catalog_id AND r.root_id=a.root_id WHERE a.catalog_id=? AND a.asset_id=?",values(&[&json!(catalog_id),&json!(asset_id)]))?.ok_or("Asset was not found in this catalog.")?;
        if row["rootHealth"]!="online" { return Err("Asset root is not online.".into()) }
        let relative=string(&row,"relativePath")?;
        let parsed=Path::new(relative);
        if parsed.is_absolute() || parsed.components().any(|component| !matches!(component,std::path::Component::Normal(_))) {
            return Err("Asset path is invalid.".into());
        }
        let canonical_root=string(&row,"canonicalRootPath")?;
        Ok(json!({"catalogId":catalog_id,"assetId":asset_id,"rootId":row["rootId"],"canonicalRootPath":canonical_root,"relativePath":relative}))
    }

    fn remove(&mut self, input: &Value) -> Result<Value, String> {
        let id = string(input,"catalogId")?.to_string();
        if self.active.as_ref().is_some_and(|active| active.catalog_id == id) {
            return Err("Close the active catalog before removing it.".into());
        }
        let catalogs = self.registry["catalogs"].as_array_mut().ok_or("Catalog registry is invalid.")?;
        let position = catalogs.iter().position(|v| v["catalogId"] == id).ok_or("Catalog was not found.")?;
        let entry = catalogs[position].clone();
        if input["deleteFile"] == true {
            if input["confirmation"] != entry["displayName"] { return Err("Catalog deletion confirmation does not match its name.".into()) }
            fs::remove_file(string(&entry,"databasePath")?).map_err(|e| e.to_string())?;
        }
        catalogs.remove(position);
        self.save_registry()?;
        Ok(Value::Null)
    }

    fn add_root(&mut self, args: &Value) -> Result<Value, String> {
        let input = first(args)?; self.require_session(input)?;
        let selected = args.as_array().and_then(|a| a.get(1)).and_then(Value::as_str).ok_or("Folder selection was cancelled.")?;
        let canonical = fs::canonicalize(selected).map_err(|e| e.to_string())?;
        if !canonical.is_dir() { return Err("Catalog root must be a folder.".into()) }
        let root_id = Uuid::new_v4().to_string();
        let catalog_id = string(input,"catalogId")?.to_string();
        let revision = self.revision(&catalog_id)?;
        let path = canonical.to_string_lossy().into_owned();
        let label = canonical.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| "Library".into());
        self.apply(&json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":[{"kind":"root-upsert","root":{"rootId":root_id,"label":label,"configuredPath":path,"canonicalPath":path,"health":"online","scanState":"unknown","watchState":"disabled"}}]}))?;
        self.stop_watchers(); self.start_watchers()?;
        Ok(json!({"catalogId":catalog_id,"sessionId":input["sessionId"],"rootId":root_id}))
    }

    fn relink_root(&mut self, args: &Value) -> Result<Value, String> {
        let input = first(args)?; self.require_session(input)?;
        let selected = args.as_array().and_then(|a| a.get(1)).and_then(Value::as_str).ok_or("Folder selection was cancelled.")?;
        let canonical = fs::canonicalize(selected).map_err(|e| e.to_string())?;
        let path = canonical.to_string_lossy().into_owned();
        let label = canonical.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| "Library".into());
        let catalog_id = string(input,"catalogId")?.to_string();
        let revision = self.revision(&catalog_id)?;
        self.apply(&json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":[{"kind":"root-relink","rootId":input["rootId"],"label":label,"configuredPath":path,"canonicalPath":path,"health":"online"}]}))?;
        self.stop_watchers(); self.start_watchers()?;
        let session = self.active_session()?;
        let entry = self.registry["catalogs"].as_array().and_then(|a| a.iter().find(|v| v["catalogId"] == catalog_id)).ok_or("Catalog is not registered.")?;
        let catalog = json!({"catalogId":entry["catalogId"],"displayName":entry["displayName"],"health":entry["health"],"lastOpenedAt":entry["lastOpenedAt"]});
        Ok(json!({"catalog":catalog,"session":session}))
    }

    fn revision(&self, catalog_id: &str) -> Result<i64,String> {
        self.db()?.query_row("SELECT revision FROM catalog_meta WHERE catalog_id = ?", [catalog_id], |r| r.get(0)).map_err(|e| e.to_string())
    }
}
