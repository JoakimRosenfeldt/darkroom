use super::*;
use rusqlite::{MAIN_DB, OpenFlags};
use sha2::{Digest, Sha256};
use std::io::Read;

fn sha_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha_file(path: &Path) -> Result<(u64, String), String> {
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err("Catalog package entry is not a regular file.".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file.metadata().map_err(|e| e.to_string())?;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err("Catalog package entry changed while opening.".into());
        }
    }
    let mut buffer = [0u8; 1024 * 1024];
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes += read as u64;
    }
    let after = file.metadata().map_err(|e| e.to_string())?;
    if bytes != before.len()
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err("Catalog package entry changed while reading.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err("Catalog package entry changed while reading.".into());
        }
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}

fn package_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Catalog package path must be absolute.".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Catalog package may not contain symbolic links.".into());
        }
    }
    Ok(())
}

fn package_entries(
    directory: &Path,
    relative: &Path,
    found: &mut Vec<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory.join(relative)).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let child = relative.join(name);
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Catalog package may not contain symbolic links.".into());
        }
        if metadata.is_dir() {
            package_entries(directory, &child, found)?
        } else if metadata.is_file() {
            found.push(child.to_string_lossy().replace('\\', "/"));
            if found.len() > 100_000 {
                return Err("Catalog package contains too many entries.".into());
            }
        } else {
            return Err("Catalog package contains an unsupported filesystem entry.".into());
        }
    }
    Ok(())
}

fn count(db: &Connection, sql: &str, id: &str) -> Result<i64, String> {
    db.query_row(sql, [id], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn inspect(path: &Path) -> Result<Value, String> {
    let mut errors = Vec::<String>::new();
    let mut source = sha_file(path);
    for _ in 0..3 {
        if !source
            .as_ref()
            .err()
            .is_some_and(|error| error == "Catalog package entry changed while reading.")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        source = sha_file(path);
    }
    let (byte_length, digest) = match source {
        Ok(value) => value,
        Err(error) => {
            errors.push(error);
            (0, String::new())
        }
    };
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let application_id: i64 = db
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let user_version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if application_id != 1_146_243_891 {
        errors.push("Catalog application ID is invalid.".into())
    }
    if user_version != 3 {
        errors.push("Catalog schema version is invalid.".into())
    }
    let meta=one(&db,"SELECT catalog_id AS catalogId,display_name AS displayName,app_version AS appVersion,schema_version AS schemaVersion FROM catalog_meta WHERE singleton=1",vec![])?.ok_or("Catalog metadata is missing.")?;
    let id = string(&meta, "catalogId")?;
    let roots = rows(
        &db,
        "SELECT root_id AS rootId,label FROM roots WHERE catalog_id=? ORDER BY root_id",
        vec![SqlValue::Text(id.into())],
    )?;
    let count_sql = [
        ("assets", "SELECT COUNT(*) FROM assets WHERE catalog_id=?"),
        (
            "metadata",
            "SELECT COUNT(*) FROM asset_metadata WHERE catalog_id=?",
        ),
        ("albums", "SELECT COUNT(*) FROM albums WHERE catalog_id=?"),
        (
            "albumAssets",
            "SELECT COUNT(*) FROM album_assets WHERE catalog_id=?",
        ),
        (
            "fingerprints",
            "SELECT COUNT(*) FROM fingerprints WHERE catalog_id=?",
        ),
        (
            "presets",
            "SELECT COUNT(*) FROM import_presets WHERE catalog_id=?",
        ),
        (
            "rules",
            "SELECT COUNT(*) FROM auto_import_rules WHERE catalog_id=?",
        ),
        (
            "operations",
            "SELECT COUNT(*) FROM operations WHERE catalog_id=?",
        ),
        (
            "operationItems",
            "SELECT COUNT(*) FROM operation_items WHERE catalog_id=?",
        ),
        (
            "aliases",
            "SELECT COUNT(*) FROM migration_aliases WHERE catalog_id=?",
        ),
        (
            "auditEntries",
            "SELECT COUNT(*) FROM audit_log WHERE catalog_id=?",
        ),
        (
            "archived",
            "SELECT COUNT(*) FROM asset_metadata WHERE catalog_id=? AND archive=1",
        ),
        (
            "present",
            "SELECT COUNT(*) FROM assets WHERE catalog_id=? AND health='present'",
        ),
        (
            "missing",
            "SELECT COUNT(*) FROM assets WHERE catalog_id=? AND health='missing'",
        ),
        (
            "ambiguous",
            "SELECT COUNT(*) FROM assets WHERE catalog_id=? AND health='ambiguous'",
        ),
        (
            "unreadable",
            "SELECT COUNT(*) FROM assets WHERE catalog_id=? AND health='unreadable'",
        ),
    ];
    let mut counts = Map::new();
    for (key, sql) in count_sql {
        counts.insert(key.into(), json!(count(&db, sql, id)?));
    }
    let orphan_sql = [
        (
            "assetMetadata",
            "SELECT COUNT(*) FROM asset_metadata m LEFT JOIN assets a ON a.catalog_id=m.catalog_id AND a.asset_id=m.asset_id WHERE m.catalog_id=? AND a.asset_id IS NULL",
        ),
        (
            "fingerprints",
            "SELECT COUNT(*) FROM fingerprints f LEFT JOIN assets a ON a.catalog_id=f.catalog_id AND a.asset_id=f.asset_id WHERE f.catalog_id=? AND a.asset_id IS NULL",
        ),
        (
            "albums",
            "SELECT COUNT(*) FROM albums a LEFT JOIN catalog_meta c ON c.catalog_id=a.catalog_id WHERE a.catalog_id=? AND c.catalog_id IS NULL",
        ),
        (
            "albumAssets",
            "SELECT COUNT(*) FROM album_assets aa LEFT JOIN albums a ON a.catalog_id=aa.catalog_id AND a.album_id=aa.album_id LEFT JOIN assets x ON x.catalog_id=aa.catalog_id AND x.asset_id=aa.asset_id WHERE aa.catalog_id=? AND (a.album_id IS NULL OR x.asset_id IS NULL)",
        ),
        (
            "presets",
            "SELECT COUNT(*) FROM import_presets p LEFT JOIN catalog_meta c ON c.catalog_id=p.catalog_id WHERE p.catalog_id=? AND c.catalog_id IS NULL",
        ),
        (
            "rules",
            "SELECT COUNT(*) FROM auto_import_rules r LEFT JOIN roots d ON d.catalog_id=r.catalog_id AND d.root_id=r.destination_root_id LEFT JOIN import_presets p ON p.catalog_id=r.catalog_id AND p.preset_id=r.preset_id WHERE r.catalog_id=? AND (d.root_id IS NULL OR p.preset_id IS NULL)",
        ),
        (
            "operations",
            "SELECT COUNT(*) FROM operations o LEFT JOIN catalog_meta c ON c.catalog_id=o.catalog_id WHERE o.catalog_id=? AND c.catalog_id IS NULL",
        ),
        (
            "operationItems",
            "SELECT COUNT(*) FROM operation_items i LEFT JOIN operations o ON o.catalog_id=i.catalog_id AND o.operation_id=i.operation_id LEFT JOIN assets a ON a.catalog_id=i.catalog_id AND a.asset_id=i.asset_id WHERE i.catalog_id=? AND (o.operation_id IS NULL OR (i.asset_id IS NOT NULL AND a.asset_id IS NULL))",
        ),
        (
            "aliases",
            "SELECT COUNT(*) FROM migration_aliases m LEFT JOIN assets a ON a.catalog_id=m.catalog_id AND a.asset_id=m.asset_id LEFT JOIN roots r ON r.catalog_id=m.catalog_id AND r.root_id=m.root_id WHERE m.catalog_id=? AND (a.asset_id IS NULL OR r.root_id IS NULL)",
        ),
        (
            "auditEntries",
            "SELECT COUNT(*) FROM audit_log l LEFT JOIN catalog_meta c ON c.catalog_id=l.catalog_id WHERE l.catalog_id=? AND c.catalog_id IS NULL",
        ),
        (
            "archived",
            "SELECT COUNT(*) FROM asset_metadata m LEFT JOIN assets a ON a.catalog_id=m.catalog_id AND a.asset_id=m.asset_id WHERE m.catalog_id=? AND m.archive=1 AND a.asset_id IS NULL",
        ),
        (
            "albumPositions",
            "SELECT COUNT(*) FROM (SELECT catalog_id FROM albums WHERE catalog_id=? GROUP BY catalog_id HAVING MIN(position)<>0 OR MAX(position)<>COUNT(*)-1)",
        ),
        (
            "albumAssetPositions",
            "SELECT COUNT(*) FROM (SELECT catalog_id,album_id FROM album_assets WHERE catalog_id=? GROUP BY catalog_id,album_id HAVING MIN(position)<>0 OR MAX(position)<>COUNT(*)-1)",
        ),
    ];
    let mut orphans = Map::new();
    for (key, sql) in orphan_sql {
        orphans.insert(key.into(), json!(count(&db, sql, id)?));
    }
    let integrity = rows(&db, "PRAGMA integrity_check", vec![])?
        .into_iter()
        .map(|v| v["integrity_check"].clone())
        .collect::<Vec<_>>();
    let foreign_keys = rows(&db, "PRAGMA foreign_key_check", vec![])?.len();
    if integrity != vec![json!("ok")] {
        errors.push("Catalog integrity check failed.".into())
    }
    if foreign_keys > 0 {
        errors.push("Catalog foreign-key check failed.".into())
    }
    if orphans.values().any(|v| v.as_i64().unwrap_or(0) > 0) {
        errors.push("Catalog contains orphaned or invalid relations.".into())
    }
    Ok(
        json!({"catalogId":id,"schemaVersion":meta["schemaVersion"],"applicationId":application_id,"userVersion":user_version,"clean":errors.is_empty(),"sourceByteLength":byte_length,"sourceSha256":digest,"roots":roots,"counts":counts,"orphanCounts":orphans,"integrity":{"integrityCheck":integrity,"foreignKeyViolationCount":foreign_keys},"blockingErrors":errors}),
    )
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical(&map[*key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(array) => format!(
            "[{}]",
            array.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => history::js_stringify(value),
    }
}

fn policy_file(user_data: &Path) -> PathBuf {
    user_data.join("catalog-backup-policies.json")
}

impl CatalogService {
    pub(super) fn admin_dispatch(&mut self, command: &str, args: &Value) -> Result<Value, String> {
        if command == "darkroom:catalog-admin-validate-package" {
            return self.validate_package(args);
        }
        if command == "darkroom:catalog-admin-import-as-new" {
            return self.import_package(args);
        }
        let input = first(args)?;
        self.require_session(input)?;
        let id = string(input, "catalogId")?.to_string();
        let maintenance = matches!(
            command,
            "darkroom:catalog-admin-backup"
                | "darkroom:catalog-admin-export"
                | "darkroom:catalog-admin-optimize"
                | "darkroom:catalog-admin-run-scheduled-backup"
        );
        if maintenance {
            self.cancel_all_scans();
            self.cancel_imports();
            self.stop_watchers();
            self.stop_auto();
        }
        let result = match command {
            "darkroom:catalog-admin-inspect" => {
                inspect(self.active_path().ok_or("No catalog is open.")?)
            }
            "darkroom:catalog-admin-backup" => self.backup_package(&id, None),
            "darkroom:catalog-admin-export" => {
                let path = args
                    .as_array()
                    .and_then(|a| a.get(1))
                    .and_then(Value::as_str);
                if let Some(path) = path {
                    self.backup_package(&id, Some(Path::new(path)))
                } else {
                    Ok(Value::Null)
                }
            }
            "darkroom:catalog-admin-optimize-preview" => {
                let report = inspect(self.active_path().ok_or("No catalog is open.")?)?;
                if report["clean"] != true {
                    return Err("Catalog database validation failed.".into());
                }
                Ok(
                    json!({"catalogId":id,"sourceSha256":report["sourceSha256"],"sourceByteLength":report["sourceByteLength"],"provenOrphanCounts":report["orphanCounts"]}),
                )
            }
            "darkroom:catalog-admin-optimize" => self.optimize(&id),
            "darkroom:catalog-admin-get-backup-policy" => self.get_policy(&id),
            "darkroom:catalog-admin-set-backup-policy" => {
                self.set_policy(&id, field(input, "policy")?)
            }
            "darkroom:catalog-admin-run-scheduled-backup" => self.run_scheduled_backup(&id),
            _ => Err(format!("Unsupported catalog admin command: {command}")),
        };
        if maintenance && self.db.is_some() {
            let watchers = self.start_watchers();
            let auto = self.start_auto();
            if result.is_ok() {
                watchers?;
                auto?;
            }
        }
        result
    }

    fn get_policy(&self, id: &str) -> Result<Value, String> {
        let all = fs::read_to_string(policy_file(&self.user_data))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!({}));
        Ok(all.get(id).cloned().unwrap_or_else(||json!({"catalogId":id,"policy":{"schedule":{"kind":"off"},"retentionCount":3},"lastSuccessAt":null,"lastFailureAt":null,"lastFailureMessage":null})))
    }

    fn set_policy(&self, id: &str, policy: &Value) -> Result<Value, String> {
        let retention = number(policy, "retentionCount")?;
        if !(1..=100).contains(&retention) {
            return Err("Catalog backup retention is invalid.".into());
        }
        let schedule = field(policy, "schedule")?;
        match string(schedule, "kind")? {
            "off" => (),
            "interval" => {
                let interval = number(schedule, "intervalMs")?;
                if !(60_000..=365 * 24 * 60 * 60 * 1_000).contains(&interval) {
                    return Err("Catalog backup interval is invalid.".into());
                }
            }
            _ => return Err("Catalog backup schedule kind is invalid.".into()),
        }
        let mut all = fs::read_to_string(policy_file(&self.user_data))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let mut state = self.get_policy(id)?;
        state["policy"] = json!({"schedule":if schedule["kind"]=="off"{json!({"kind":"off"})}else{json!({"kind":"interval","intervalMs":schedule["intervalMs"]})},"retentionCount":retention});
        all[id] = state.clone();
        write_json(&policy_file(&self.user_data), &all)?;
        Ok(state)
    }

    fn run_scheduled_backup(&mut self, id: &str) -> Result<Value, String> {
        let mut state = self.get_policy(id)?;
        if state["policy"]["schedule"]["kind"] == "off" {
            return Ok(Value::Null);
        }
        let interval = state["policy"]["schedule"]["intervalMs"]
            .as_i64()
            .ok_or("Backup policy interval is invalid.")?;
        if state["lastSuccessAt"]
            .as_i64()
            .is_some_and(|last| now() - last < interval)
        {
            return Ok(Value::Null);
        }
        let backup = match self.backup_package(id, None) {
            Ok(backup) => backup,
            Err(error) => {
                state["lastFailureAt"] = json!(now());
                state["lastFailureMessage"] = json!(error);
                let mut all = fs::read_to_string(policy_file(&self.user_data))
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({}));
                all[id] = state;
                write_json(&policy_file(&self.user_data), &all)?;
                return Err(error);
            }
        };
        state["lastSuccessAt"] = json!(now());
        state["lastFailureAt"] = Value::Null;
        state["lastFailureMessage"] = Value::Null;
        let mut all = fs::read_to_string(policy_file(&self.user_data))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        all[id] = state.clone();
        write_json(&policy_file(&self.user_data), &all)?;
        self.prune_backups(id, number(&state["policy"], "retentionCount")? as usize)?;
        Ok(backup)
    }

    fn prune_backups(&self, id: &str, retain: usize) -> Result<(), String> {
        let directory = self.user_data.join("catalog-backups").join(id);
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let mut valid = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("backup-") {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            let report = match self.validate_package(&json!([entry.path().to_string_lossy()])) {
                Ok(report) => report,
                Err(_) => continue,
            };
            if report["clean"] == true && report["catalogId"] == id {
                valid.push((
                    entry.path(),
                    metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                ))
            }
        }
        valid.sort_by(|left, right| right.1.cmp(&left.1));
        for (path, _) in valid.into_iter().skip(retain) {
            fs::remove_dir_all(path).map_err(|e| e.to_string())?
        }
        Ok(())
    }

    fn backup_package(&self, id: &str, target: Option<&Path>) -> Result<Value, String> {
        let source = self.active_path().ok_or("No catalog is open.")?;
        let before = inspect(source)?;
        if before["clean"] != true || before["catalogId"] != id {
            return Err("Catalog database validation failed.".into());
        }
        let timestamp = now();
        let operation_id = Uuid::new_v4().to_string();
        let directory = if let Some(path) = target {
            path.to_path_buf()
        } else {
            self.user_data
                .join("catalog-backups")
                .join(id)
                .join(format!("backup-{operation_id}"))
        };
        let parent = directory
            .parent()
            .ok_or("Package destination is invalid.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if directory.exists() {
            return Err("Package destination already exists.".into());
        }
        let staged = parent.join(format!(".staging-{}", Uuid::new_v4()));
        fs::create_dir(&staged).map_err(|e| e.to_string())?;
        let result = (|| -> Result<Value, String> {
            let database = staged.join("catalog.sqlite");
            self.db()?
                .backup(MAIN_DB, &database, None)
                .map_err(|e| e.to_string())?;
            let verified = inspect(&database)?;
            if verified["clean"] != true || verified["catalogId"] != id {
                return Err("Catalog backup validation failed.".into());
            }
            let (length, hash) = sha_file(&database)?;
            let roots = rows(
                self.db()?,
                "SELECT root_id AS rootId,label,configured_path AS configuredPath FROM roots WHERE catalog_id=? ORDER BY root_id",
                vec![SqlValue::Text(id.into())],
            )?;
            let manifest = json!({"kind":"darkroom-catalog-package","version":1,"catalogId":id,"schemaVersion":3,"appVersion":"0.1.0","createdAt":timestamp,"roots":roots,"files":[{"name":"catalog.sqlite","byteLength":length,"sha256":hash}]});
            let text = format!("{}\n", canonical(&manifest));
            fs::write(staged.join("manifest.json"), &text).map_err(|e| e.to_string())?;
            fs::rename(&staged, &directory).map_err(|e| e.to_string())?;
            Ok(
                json!({"operationId":operation_id,"catalogId":id,"createdAt":timestamp,"sourceSha256":before["sourceSha256"],"packageSha256":sha_bytes(text.as_bytes()),"byteLength":length}),
            )
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staged);
        }
        result
    }

    fn validate_package(&self, args: &Value) -> Result<Value, String> {
        let Some(path) = args
            .as_array()
            .and_then(|a| a.get(0))
            .and_then(Value::as_str)
        else {
            return Ok(Value::Null);
        };
        let directory = Path::new(path);
        package_path(directory)?;
        let metadata = fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
        if !metadata.is_dir() {
            return Err("Catalog package directory is invalid.".into());
        }
        let mut found = Vec::new();
        package_entries(directory, Path::new(""), &mut found)?;
        let manifest_path = directory.join("manifest.json");
        let manifest_meta = fs::symlink_metadata(&manifest_path).map_err(|e| e.to_string())?;
        if !manifest_meta.is_file() || manifest_meta.len() > 4 * 1024 * 1024 {
            return Err("Catalog package manifest is invalid.".into());
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let manifest_file = options.open(&manifest_path).map_err(|e| e.to_string())?;
        let mut manifest_text = String::new();
        manifest_file
            .take(4 * 1024 * 1024 + 1)
            .read_to_string(&mut manifest_text)
            .map_err(|e| e.to_string())?;
        if manifest_text.len() > 4 * 1024 * 1024 {
            return Err("Catalog package manifest is too large.".into());
        }
        let manifest: Value = serde_json::from_str(&manifest_text).map_err(|e| e.to_string())?;
        let fields = [
            "kind",
            "version",
            "catalogId",
            "schemaVersion",
            "appVersion",
            "createdAt",
            "roots",
            "files",
        ];
        if !manifest.as_object().is_some_and(|m| {
            m.len() == fields.len() && fields.iter().all(|key| m.contains_key(*key))
        }) || manifest["kind"] != "darkroom-catalog-package"
            || manifest["version"] != 1
            || manifest["schemaVersion"] != 3
            || manifest["appVersion"].as_str().is_none_or(str::is_empty)
            || !manifest["createdAt"].is_number()
        {
            return Err("Catalog package manifest is invalid.".into());
        }
        let catalog_id = string(&manifest, "catalogId")?;
        if Uuid::parse_str(catalog_id).is_err() {
            return Err("Catalog package identity is invalid.".into());
        }
        let roots = manifest["roots"]
            .as_array()
            .ok_or("Catalog package roots are invalid.")?;
        let files = manifest["files"]
            .as_array()
            .ok_or("Catalog package files are invalid.")?;
        if files.is_empty()
            || files.len() > 100_000
            || !files.iter().any(|file| file["name"] == "catalog.sqlite")
        {
            return Err("Catalog package database is missing.".into());
        }
        let mut expected = std::collections::HashSet::new();
        expected.insert("manifest.json".to_string());
        for file in files {
            let fields = ["name", "byteLength", "sha256"];
            if !file.as_object().is_some_and(|m| {
                m.len() == fields.len() && fields.iter().all(|key| m.contains_key(*key))
            }) {
                return Err("Catalog package file record is invalid.".into());
            }
            let name = string(file, "name")?;
            if name.starts_with('/')
                || name.contains(['\\', '\0'])
                || name
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || !expected.insert(name.to_string())
            {
                return Err("Catalog package file name is invalid.".into());
            }
            let (length, hash) = sha_file(&directory.join(name))?;
            if file["byteLength"] != length || file["sha256"] != hash {
                return Err("Catalog package checksum mismatch.".into());
            }
        }
        if found.len() != expected.len() || found.iter().any(|name| !expected.contains(name)) {
            return Err("Catalog package entries do not match its manifest.".into());
        }
        let database = directory.join("catalog.sqlite");
        let report = inspect(&database)?;
        if report["clean"] != true || report["catalogId"] != catalog_id {
            return Err("Catalog package identity or integrity mismatch.".into());
        }
        let db = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let actual = rows(
            &db,
            "SELECT root_id AS rootId,label,configured_path AS configuredPath FROM roots WHERE catalog_id=? ORDER BY root_id",
            vec![SqlValue::Text(catalog_id.into())],
        )?;
        if roots.len() != actual.len() {
            return Err("Catalog package root mapping does not match its database.".into());
        }
        let mut root_ids = std::collections::HashSet::new();
        for root in roots {
            let fields = ["rootId", "label", "configuredPath"];
            if !root.as_object().is_some_and(|m| {
                m.len() == fields.len() && fields.iter().all(|key| m.contains_key(*key))
            }) || !root_ids.insert(root["rootId"].as_str().unwrap_or(""))
                || !actual.iter().any(|row| {
                    row["rootId"] == root["rootId"]
                        && row["label"] == root["label"]
                        && row["configuredPath"] == root["configuredPath"]
                })
            {
                return Err("Catalog package root mapping does not match its database.".into());
            }
        }
        Ok(report)
    }

    fn import_package(&mut self, args: &Value) -> Result<Value, String> {
        let input = first(args)?;
        let name = string(input, "displayName")?;
        let Some(package) = args
            .as_array()
            .and_then(|a| a.get(1))
            .and_then(Value::as_str)
        else {
            return Ok(Value::Null);
        };
        let report = self.validate_package(&json!([package]))?;
        if report["clean"] != true {
            return Err("Catalog package validation failed.".into());
        }
        let source_id = string(&report, "catalogId")?.to_string();
        let target_id = Uuid::new_v4().to_string();
        let destination = self
            .user_data
            .join("catalogs")
            .join(format!("{target_id}.sqlite"));
        fs::create_dir_all(
            destination
                .parent()
                .ok_or("Catalog destination is invalid.")?,
        )
        .map_err(|e| e.to_string())?;
        let source = Path::new(package).join("catalog.sqlite");
        let before = sha_file(&source)?;
        let mut source_options = fs::OpenOptions::new();
        source_options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            source_options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut source_file = source_options.open(&source).map_err(|e| e.to_string())?;
        let mut destination_options = fs::OpenOptions::new();
        destination_options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            destination_options.mode(0o600);
        }
        let mut destination_file = destination_options
            .open(&destination)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut source_file, &mut destination_file).map_err(|e| e.to_string())?;
        destination_file.sync_all().map_err(|e| e.to_string())?;
        drop(destination_file);
        drop(source_file);
        if sha_file(&source)? != before || sha_file(&destination)? != before {
            let _ = fs::remove_file(&destination);
            return Err("Source catalog changed while it was cloned.".into());
        }
        let result = (|| -> Result<Value, String> {
            let db = Connection::open(&destination).map_err(|e| e.to_string())?;
            db.execute_batch("PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE")
                .map_err(|e| e.to_string())?;
            db.execute("UPDATE catalog_meta SET catalog_id=?,display_name=?,app_version='0.1.0',revision=revision+1 WHERE catalog_id=?",params![target_id,name,source_id]).map_err(|e|e.to_string())?;
            for table in [
                "migration_runs",
                "roots",
                "assets",
                "asset_metadata",
                "edit_entries",
                "entry_metadata",
                "albums",
                "album_assets",
                "album_entries",
                "fingerprints",
                "import_presets",
                "auto_import_rules",
                "operations",
                "operation_items",
                "migration_aliases",
                "audit_log",
                "library_state",
                "develop_history_revisions",
                "develop_history_heads",
                "develop_revision_assets",
                "develop_history_refs",
                "develop_xmp_projections",
                "develop_default_installs",
                "develop_batch_jobs",
                "develop_batch_items",
                "develop_auto_sync",
            ] {
                let exists = one(
                    &db,
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                    vec![SqlValue::Text(table.into())],
                )?
                .is_some();
                if exists {
                    db.execute(
                        &format!("UPDATE {table} SET catalog_id=? WHERE catalog_id=?"),
                        params![target_id, source_id],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            db.execute("UPDATE roots SET canonical_path=NULL,health='missing',scan_state='unknown',watch_state='disabled' WHERE catalog_id=?",[&target_id]).map_err(|e|e.to_string())?;
            db.execute(
                "UPDATE auto_import_rules SET enabled=0 WHERE catalog_id=?",
                [&target_id],
            )
            .map_err(|e| e.to_string())?;
            db.execute_batch("COMMIT;PRAGMA foreign_keys=ON")
                .map_err(|e| e.to_string())?;
            let checked = inspect(&destination)?;
            if checked["clean"] != true {
                return Err("Cloned catalog validation failed.".into());
            }
            if sha_file(&source)? != before {
                return Err("Source catalog changed while it was cloned.".into());
            }
            Ok(
                json!({"operationId":Uuid::new_v4().to_string(),"sourceCatalogId":source_id,"catalogId":target_id,"displayName":name,"rootCount":checked["roots"].as_array().map_or(0,Vec::len),"assetCount":checked["counts"]["assets"]}),
            )
        })();
        match result {
            Ok(value) => {
                self.registry["catalogs"].as_array_mut().ok_or("Catalog registry is invalid.")?.push(json!({"catalogId":target_id,"displayName":name,"databasePath":destination.to_string_lossy(),"health":"healthy","lastOpenedAt":0}));
                self.save_registry()?;
                Ok(value)
            }
            Err(error) => {
                let _ = fs::remove_file(destination);
                Err(error)
            }
        }
    }

    fn optimize(&mut self, id: &str) -> Result<Value, String> {
        let source = self
            .active_path()
            .ok_or("No catalog is open.")?
            .to_path_buf();
        let before = inspect(&source)?;
        if before["clean"] != true || before["catalogId"] != id {
            return Err("Catalog database validation failed.".into());
        }
        let temporary = source.with_extension(format!("compact-{}", Uuid::new_v4()));
        self.db()?
            .execute("VACUUM INTO ?", [temporary.to_string_lossy().as_ref()])
            .map_err(|e| e.to_string())?;
        let result = (|| -> Result<Value, String> {
            let checked = inspect(&temporary)?;
            if checked["clean"] != true || checked["catalogId"] != id {
                return Err("Compacted catalog validation failed.".into());
            }
            let source_after = inspect(&source)?;
            if source_after["sourceSha256"] != before["sourceSha256"]
                || source_after["sourceByteLength"] != before["sourceByteLength"]
            {
                return Err("Catalog changed during optimization.".into());
            }
            let compact_sha = checked["sourceSha256"].clone();
            let compact_bytes = checked["sourceByteLength"].clone();
            let original_sha = before["sourceSha256"].clone();
            let original_bytes = before["sourceByteLength"].clone();
            self.db = None;
            let rollback = source.with_extension(format!("precompact-{}", Uuid::new_v4()));
            if let Err(error) = fs::rename(&source, &rollback) {
                self.db = Some(Connection::open(&source).map_err(|e| e.to_string())?);
                return Err(error.to_string());
            }
            if let Err(error) = fs::rename(&temporary, &source) {
                let _ = fs::rename(&rollback, &source);
                self.db = Some(Connection::open(&source).map_err(|e| e.to_string())?);
                return Err(error.to_string());
            }
            let reopened = Connection::open(&source).and_then(|db| {
                db.pragma_update(None, "foreign_keys", "ON")?;
                Ok(db)
            });
            match reopened {
                Ok(db) => {
                    self.db = Some(db);
                    let _ = fs::remove_file(rollback);
                }
                Err(error) => {
                    let _ = fs::remove_file(&source);
                    let _ = fs::rename(&rollback, &source);
                    self.db = Connection::open(&source).ok();
                    return Err(format!(
                        "Catalog optimization could not reopen the compacted database: {error}"
                    ));
                }
            }
            Ok(
                json!({"catalogId":id,"sourceSha256":original_sha,"compactSha256":compact_sha,"sourceByteLength":original_bytes,"compactByteLength":compact_bytes}),
            )
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}
