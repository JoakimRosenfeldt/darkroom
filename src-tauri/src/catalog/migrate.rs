use super::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

struct LegacyAsset {
    alias: String,
    metadata: Option<Value>,
    archived: bool,
    observation: Option<Value>,
    xmp: Option<(String, f64, String)>,
    xmp_state: &'static str,
}

impl LegacyAsset {
    fn new(path: &str) -> Self {
        Self {
            alias: uri_encode(path),
            metadata: None,
            archived: false,
            observation: None,
            xmp: None,
            xmp_state: "unknown",
        }
    }
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn stable_uuid(namespace: &str, value: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update([0]);
    hash.update(value.as_bytes());
    let mut bytes: [u8; 16] = hash.finalize()[..16].try_into().expect("SHA-256 length");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn uri_encode(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

fn decode_alias(alias: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(alias.len());
    let source = alias.as_bytes();
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            if index + 2 >= source.len() {
                return Err("Legacy ID has malformed percent escapes.".into());
            }
            let digits = std::str::from_utf8(&source[index + 1..index + 3])
                .map_err(|_| "Legacy ID is invalid.")?;
            bytes.push(
                u8::from_str_radix(digits, 16)
                    .map_err(|_| "Legacy ID has malformed percent escapes.")?,
            );
            index += 3;
        } else {
            bytes.push(source[index]);
            index += 1;
        }
    }
    let relative = String::from_utf8(bytes).map_err(|_| "Legacy ID is not UTF-8.")?;
    if uri_encode(&relative) != alias {
        return Err("Legacy ID is not canonically encoded.".into());
    }
    valid_relative(&relative)?;
    Ok(relative)
}

fn valid_relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains(['\0', '\\'])
        || path.starts_with('/')
        || path.as_bytes().get(1) == Some(&b':')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Legacy relative path is invalid.".into());
    }
    Ok(())
}

fn regular(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            fs::read(path).map(Some).map_err(|e| e.to_string())
        }
        Ok(_) => Err(format!("{} is not a regular file.", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn regular_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(format!("{} is not a regular file.", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn finite(value: &Value, label: &str) -> Result<f64, String> {
    let number = value
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("{label} must be finite."))?;
    Ok(number)
}

fn metadata(value: &Value, version: u64) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or("Legacy entry metadata is invalid.")?;
    let pick = object
        .get("pick")
        .and_then(Value::as_str)
        .ok_or("Legacy pick is invalid.")?;
    if !["none", "pick", "reject"].contains(&pick) {
        return Err("Legacy pick is invalid.".into());
    }
    let rating = object
        .get("rating")
        .and_then(Value::as_u64)
        .filter(|v| *v <= 5)
        .ok_or("Legacy rating is invalid.")?;
    let color = object
        .get("colorLabel")
        .ok_or("Legacy color label is invalid.")?;
    if !color.is_null()
        && !matches!(
            color.as_str(),
            Some("red" | "yellow" | "green" | "blue" | "purple")
        )
    {
        return Err("Legacy color label is invalid.".into());
    }
    for key in ["title", "caption", "copyright"] {
        if object
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err(format!("Legacy {key} is invalid."));
        }
    }
    let keywords = object.get("keywords");
    if keywords.is_some_and(|value| {
        !value
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
    }) {
        return Err("Legacy keywords are invalid.".into());
    }
    let unique_keywords = keywords
        .and_then(Value::as_array)
        .map(|list| {
            let mut seen = BTreeSet::new();
            list.iter()
                .filter(|item| seen.insert(item.as_str().expect("validated").to_owned()))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let updated = finite(
        object
            .get("updatedAt")
            .ok_or("Legacy updatedAt is missing.")?,
        "Legacy updatedAt",
    )?;
    let develop = object.get("develop").cloned();
    if develop.is_some() && !develop.as_ref().is_some_and(Value::is_object) {
        return Err("Legacy Develop document is invalid.".into());
    }
    let develop_updated = if let Some(value) = object.get("developUpdatedAt") {
        finite(value, "Legacy developUpdatedAt")?
    } else if develop.is_some() {
        updated
    } else {
        0.0
    };
    let normalized_develop = if version == 1 {
        develop.map(migrate_v1_develop).transpose()?
    } else {
        develop
    };
    Ok(
        json!({"pick":pick,"rating":rating,"colorLabel":color,"title":object.get("title"),"caption":object.get("caption"),"copyright":object.get("copyright"),"keywords":unique_keywords,"develop":normalized_develop,"developUpdatedAt":develop_updated,"updatedAt":updated}),
    )
}

fn migrate_v1_develop(value: Value) -> Result<Value, String> {
    let source = value
        .as_object()
        .ok_or("Legacy Develop document is invalid.")?;
    let mut settings: Value = serde_json::from_str(include_str!("legacy-develop-defaults.json"))
        .map_err(|e| e.to_string())?;
    for key in ["basic", "crop", "effects"] {
        if let Some(part) = source.get(key) {
            let fields = part
                .as_object()
                .ok_or("Legacy Develop settings are invalid.")?;
            for (name, value) in fields {
                settings[key][name] = value.clone();
            }
        }
    }
    if let Some(curve) = source.get("curve") {
        settings["curve"] = normalize_curve(curve);
    }
    if let Some(mixer) = source.get("mixer") {
        let bands = mixer.as_object().ok_or("Legacy mixer is invalid.")?;
        for (band, values) in bands {
            if ![
                "red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta",
            ]
            .contains(&band.as_str())
            {
                continue;
            }
            let fields = values.as_object().ok_or("Legacy mixer band is invalid.")?;
            for (name, value) in fields {
                settings["mixer"][band][name] = value.clone();
            }
        }
    }
    Ok(json!({"version":2,"settings":settings,"maskAssets":{}}))
}

fn normalize_curve(value: &Value) -> Value {
    let linear = || json!([{"x":0,"y":0},{"x":1,"y":1}]);
    let legacy = ["shadows", "midtones", "highlights"]
        .iter()
        .any(|key| value[*key].as_f64().is_some_and(f64::is_finite));
    let mut result = json!({"rgb":linear(),"red":linear(),"green":linear(),"blue":linear()});
    if legacy {
        let mut points = Vec::new();
        for x in [0.0_f64, 64.0, 128.0, 192.0, 255.0] {
            let adjustment = match x as i64 {
                64 => value["shadows"].as_f64().unwrap_or(0.0),
                128 => value["midtones"].as_f64().unwrap_or(0.0),
                192 => value["highlights"].as_f64().unwrap_or(0.0),
                _ => 0.0,
            };
            points.push(json!({"x":x/255.0,"y":((x+adjustment)/255.0).clamp(0.0,1.0)}));
        }
        result["rgb"] = json!(points);
        return result;
    }
    for channel in ["rgb", "red", "green", "blue"] {
        let mut points = value[channel]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|point| {
                Some((
                    point["x"].as_f64()?.clamp(0.0, 1.0),
                    point["y"].as_f64()?.clamp(0.0, 1.0),
                ))
            })
            .filter(|(x, y)| x.is_finite() && y.is_finite())
            .collect::<Vec<_>>();
        points.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut unique = Vec::new();
        for (index, point) in points.iter().enumerate() {
            if index + 1 == points.len()
                || ((point.0 * 255.0 + 0.5).floor() as i64)
                    != ((points[index + 1].0 * 255.0 + 0.5).floor() as i64)
            {
                unique.push(*point)
            }
        }
        if unique.len() >= 2 {
            unique[0].0 = 0.0;
            unique.last_mut().expect("two points").0 = 1.0;
            result[channel] = json!(
                unique
                    .into_iter()
                    .map(|(x, y)| json!({"x":x,"y":y}))
                    .collect::<Vec<_>>()
            );
        }
    }
    result
}

fn add_alias(assets: &mut BTreeMap<String, LegacyAsset>, alias: &str) -> Result<String, String> {
    let path = decode_alias(alias)?;
    let item = assets
        .entry(path.clone())
        .or_insert_with(|| LegacyAsset::new(&path));
    if item.alias != uri_encode(&path) && item.alias != alias {
        return Err("Legacy path has conflicting aliases.".into());
    }
    item.alias = alias.into();
    Ok(path)
}

fn path_for(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |mut path, part| {
            path.push(part);
            path
        })
}

fn sidecar_for(root: &Path, relative: &str) -> PathBuf {
    let source = path_for(root, relative);
    if source
        .extension()
        .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("nef"))
    {
        source.with_extension("xmp")
    } else {
        PathBuf::from(format!("{}.xmp", source.to_string_lossy()))
    }
}

fn read_xmp(path: &Path) -> Result<(&'static str, Option<(String, f64, String)>), String> {
    let Some(bytes) = regular(path)? else {
        return Ok(("absent", None));
    };
    if bytes.len() > 16 * 1024 * 1024 {
        return Ok(("malformed", None));
    }
    let text = match String::from_utf8(bytes.clone()) {
        Ok(text) => text,
        Err(_) => return Ok(("malformed", None)),
    };
    let modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(("preserved", Some((text, modified, sha(&bytes)))))
}

fn snapshot(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Migration recovery path is invalid.")?)
        .map_err(|e| e.to_string())?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = regular(path)?.ok_or("Migration recovery source is missing.")?;
            if existing == bytes {
                Ok(())
            } else {
                Err("Migration recovery snapshot differs from the source.".into())
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

fn verify_database(
    path: &Path,
    id: &str,
    migration_id: &str,
    expected: &Value,
) -> Result<(), String> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let actual_id: String = db
        .query_row(
            "SELECT catalog_id FROM catalog_meta WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if actual_id != id {
        return Err("Migrated database has the wrong identity.".into());
    }
    let run=one(&db,"SELECT source_version AS sourceVersion,catalog_sha256 AS catalogSha256,settings_sha256 AS settingsSha256,phase FROM migration_runs WHERE catalog_id=? AND migration_id=?",vec![SqlValue::Text(id.into()),SqlValue::Text(migration_id.into())])?.ok_or("Migrated database has no migration record.")?;
    if run["catalogSha256"] != expected["catalogSha256"]
        || run["settingsSha256"] != expected["settingsSha256"]
        || run["phase"] != "validated"
    {
        return Err("Migrated database source or phase does not match.".into());
    }
    for (table, key) in [
        ("assets", "assets"),
        ("asset_metadata", "metadata"),
        ("albums", "albums"),
        ("album_assets", "albumAssets"),
        ("migration_aliases", "aliases"),
        ("fingerprints", "fingerprints"),
    ] {
        let query = format!("SELECT COUNT(*) FROM {table} WHERE catalog_id=?");
        let count: i64 = db
            .query_row(&query, [id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if expected[key].as_i64() != Some(count) {
            return Err(format!("Migrated {table} count differs from the source."));
        }
    }
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let foreign_keys: usize = rows(&db, "PRAGMA foreign_key_check", vec![])?.len();
    if integrity != "ok" || foreign_keys != 0 {
        return Err("Migrated database integrity check failed.".into());
    }
    Ok(())
}

fn write_database(
    path: &Path,
    id: &str,
    root_id: &str,
    migration_id: &str,
    legacy_path: &Path,
    settings_path: Option<&Path>,
    root: &Path,
    online: bool,
    version: u64,
    assets: &BTreeMap<String, LegacyAsset>,
    albums: &[Value],
    expected: &Value,
) -> Result<(), String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let stamp = now();
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Migrated catalog");
    let label = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Library");
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        db.execute("INSERT INTO catalog_meta (catalog_id,singleton,display_name,schema_version,app_version,install_state,revision,created_at,updated_at) VALUES (?1,1,?2,3,'0.1.0','ready',1,?3,?3)",params![id,name,stamp]).map_err(|e|e.to_string())?;
        db.execute("INSERT INTO migration_runs (catalog_id,migration_id,source_version,catalog_path,settings_path,catalog_sha256,settings_sha256,root_available,expected_counts_json,expected_state_sha256,phase,validation_report_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'validated',?11,?12,?12)",params![id,migration_id,version as i64,legacy_path.to_string_lossy(),settings_path.map(|p|p.to_string_lossy().into_owned()),expected["catalogSha256"].as_str(),expected["settingsSha256"].as_str(),i64::from(online),expected.to_string(),expected["stateSha256"].as_str(),json!({"clean":true,"counts":expected}).to_string(),stamp]).map_err(|e|e.to_string())?;
        let root_path = root.to_string_lossy();
        let canonical = if online {
            Some(root_path.as_ref())
        } else {
            None
        };
        db.execute("INSERT INTO roots (catalog_id,root_id,label,configured_path,canonical_path,health,scan_state,watch_state,revision) VALUES (?1,?2,?3,?4,?5,?6,?7,'disabled',1)",params![id,root_id,label,root_path.as_ref(),canonical,if online{"online"}else{"missing"},if online{"complete"}else{"unknown"}]).map_err(|e|e.to_string())?;
        let mut path_ids = BTreeMap::<String, String>::new();
        for (relative, item) in assets {
            let asset_id = Uuid::new_v4().to_string();
            path_ids.insert(relative.clone(), asset_id.clone());
            let observation = item.observation.as_ref();
            db.execute("INSERT INTO assets (catalog_id,asset_id,root_id,relative_path,observed_byte_length,observed_modified_at,observed_at,local_file_id,revision,health,format_id,camera_make,camera_model,lens_model) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?10,NULL,NULL,NULL)",params![id,asset_id,root_id,relative,observation.and_then(|v|v["byteLength"].as_i64()),observation.and_then(|v|v["modifiedAt"].as_f64()),observation.and_then(|v|v["observedAt"].as_f64()),observation.and_then(|v|v["localFileId"].as_str()),if observation.is_some(){"present"}else{"missing"},format_for(relative)]).map_err(|e|e.to_string())?;
            let meta = item.metadata.as_ref();
            let develop = meta
                .and_then(|m| m.get("develop"))
                .filter(|v| !v.is_null())
                .map(Value::to_string);
            let keywords = meta
                .and_then(|m| m.get("keywords"))
                .cloned()
                .unwrap_or_else(|| json!([]))
                .to_string();
            db.execute("INSERT INTO asset_metadata (catalog_id,asset_id,archive,pick,rating,color_label,develop_json,develop_updated_at,updated_at,title,caption,copyright,keywords_json,raw_xmp,xmp_state,xmp_mtime,xmp_sha256) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",params![id,asset_id,i64::from(item.archived),meta.and_then(|m|m["pick"].as_str()).unwrap_or("none"),meta.and_then(|m|m["rating"].as_i64()).unwrap_or(0),meta.and_then(|m|m["colorLabel"].as_str()),develop,meta.and_then(|m|m["developUpdatedAt"].as_f64()).unwrap_or(0.0),meta.and_then(|m|m["updatedAt"].as_f64()).unwrap_or(0.0),meta.and_then(|m|m["title"].as_str()),meta.and_then(|m|m["caption"].as_str()),meta.and_then(|m|m["copyright"].as_str()),keywords,item.xmp.as_ref().map(|v|v.0.as_str()),item.xmp_state,item.xmp.as_ref().map(|v|v.1),item.xmp.as_ref().map(|v|v.2.as_str())]).map_err(|e|e.to_string())?;
            db.execute("INSERT INTO fingerprints (catalog_id,fingerprint_id,asset_id,status,sha256,observed_at,observed_byte_length,observed_modified_at,local_file_id,updated_at) VALUES (?1,?2,?3,'missing',NULL,?4,?5,?6,?7,?8)",params![id,Uuid::new_v4().to_string(),asset_id,observation.and_then(|v|v["observedAt"].as_f64()),observation.and_then(|v|v["byteLength"].as_i64()),observation.and_then(|v|v["modifiedAt"].as_f64()),observation.and_then(|v|v["localFileId"].as_str()),stamp]).map_err(|e|e.to_string())?;
            db.execute("INSERT INTO migration_aliases (catalog_id,migration_id,legacy_id,root_id,relative_path,asset_id,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![id,migration_id,item.alias,root_id,relative,asset_id,stamp]).map_err(|e|e.to_string())?;
        }
        for (position, album) in albums.iter().enumerate() {
            let album_id = string(album, "id")?;
            let album_name = album
                .get("name")
                .and_then(Value::as_str)
                .ok_or("Legacy album name is invalid.")?;
            db.execute("INSERT INTO albums (catalog_id,album_id,name,created_at,updated_at,position) VALUES (?1,?2,?3,?4,?5,?6)",params![id,album_id,album_name,finite(&album["createdAt"],"Album createdAt")?,finite(&album["updatedAt"],"Album updatedAt")?,position as i64]).map_err(|e|e.to_string())?;
            for (index, legacy_id) in album["entryIds"]
                .as_array()
                .ok_or("Legacy album members are invalid.")?
                .iter()
                .enumerate()
            {
                let path = decode_alias(
                    legacy_id
                        .as_str()
                        .ok_or("Legacy album member is invalid.")?,
                )?;
                let asset_id = path_ids
                    .get(&path)
                    .ok_or("Legacy album member is missing.")?;
                db.execute("INSERT INTO album_assets (catalog_id,album_id,asset_id,position) VALUES (?1,?2,?3,?4)",params![id,album_id,asset_id,index as i64]).map_err(|e|e.to_string())?;
            }
        }
        db.execute("INSERT INTO audit_log (catalog_id,migration_id,event,payload_json,created_at) VALUES (?1,?2,'legacy-migration',?3,?4)",params![id,migration_id,expected.to_string(),stamp]).map_err(|e|e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => db.execute_batch("COMMIT").map_err(|e| e.to_string())?,
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" || !rows(&db, "PRAGMA foreign_key_check", vec![])?.is_empty() {
        return Err("Migrated catalog did not pass integrity checks.".into());
    }
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn format_for(path: &str) -> String {
    let extension = Path::new(path)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => "jpeg".into(),
        "tif" | "tiff" => "tiff".into(),
        "heic" | "heif" | "hif" => "heif".into(),
        "mov" | "mp4" | "m4v" | "avi" | "mkv" => "video".into(),
        _ => extension,
    }
}

fn build_assets(
    catalog: &Value,
    root: &Path,
    version: u64,
) -> Result<(BTreeMap<String, LegacyAsset>, Vec<Value>, bool), String> {
    let entries = catalog
        .get("entries")
        .and_then(Value::as_object)
        .ok_or("Legacy entries are invalid.")?;
    let albums = catalog
        .get("albums")
        .filter(|v| !v.is_null())
        .transpose_array("Legacy albums are invalid.")?;
    let archived = catalog
        .get("archivedEntryIds")
        .filter(|v| !v.is_null())
        .transpose_array("Legacy archive is invalid.")?;
    let mut assets = BTreeMap::<String, LegacyAsset>::new();
    for (alias, source) in entries {
        let path = add_alias(&mut assets, alias)?;
        assets.get_mut(&path).expect("inserted").metadata = Some(metadata(source, version)?);
    }
    let mut album_ids = BTreeSet::new();
    let mut normalized_albums = Vec::new();
    for album in albums.map_or(&[][..], Vec::as_slice) {
        let id = string(album, "id")?;
        if !album_ids.insert(id.to_owned()) {
            return Err("Legacy album ID is duplicated.".into());
        }
        if album.get("name").and_then(Value::as_str).is_none() {
            return Err("Legacy album name is invalid.".into());
        }
        finite(&album["createdAt"], "Album createdAt")?;
        finite(&album["updatedAt"], "Album updatedAt")?;
        let members = album
            .get("entryIds")
            .and_then(Value::as_array)
            .ok_or("Legacy album members are invalid.")?;
        let mut paths = BTreeSet::new();
        for member in members {
            let path = add_alias(
                &mut assets,
                member.as_str().ok_or("Legacy album member is invalid.")?,
            )?;
            if !paths.insert(path) {
                return Err("Legacy album member is duplicated.".into());
            }
        }
        normalized_albums.push(album.clone());
    }
    let mut archived_paths = BTreeSet::new();
    for alias in archived.map_or(&[][..], Vec::as_slice) {
        let path = add_alias(
            &mut assets,
            alias.as_str().ok_or("Legacy archive ID is invalid.")?,
        )?;
        if !archived_paths.insert(path.clone()) {
            return Err("Legacy archive ID is duplicated.".into());
        }
        assets.get_mut(&path).expect("inserted").archived = true;
    }
    let online = fs::canonicalize(root).ok().as_deref() == Some(root);
    if online {
        let scan = scan::scan_folder(
            root,
            &AtomicBool::new(false),
            Duration::from_secs(24 * 60 * 60),
            |_, _, _, _, _| {},
        );
        if let Ok((observations, _, _, _)) = scan {
            for found in observations {
                let relative = string(&found, "relativePath")?;
                valid_relative(relative)?;
                let item = assets
                    .entry(relative.into())
                    .or_insert_with(|| LegacyAsset::new(relative));
                item.observation = found.get("observation").cloned();
            }
            for (relative, item) in &mut assets {
                let sidecar = sidecar_for(root, relative);
                match read_xmp(&sidecar) {
                    Ok((state, xmp)) => {
                        item.xmp_state = state;
                        item.xmp = xmp
                    }
                    Err(_) => item.xmp_state = "unknown",
                }
            }
            return Ok((assets, normalized_albums, true));
        }
    }
    Ok((assets, normalized_albums, false))
}

trait OptionalArray<'a> {
    fn transpose_array(self, message: &str) -> Result<Option<&'a Vec<Value>>, String>;
}
impl<'a> OptionalArray<'a> for Option<&'a Value> {
    fn transpose_array(self, message: &str) -> Result<Option<&'a Vec<Value>>, String> {
        self.map(|value| value.as_array().ok_or_else(|| message.to_string()))
            .transpose()
    }
}

fn selected_legacy(user_data: &Path, last_folder: Option<&str>) -> Result<Option<PathBuf>, String> {
    let directory = user_data.join("catalogs");
    if let Some(last) = last_folder {
        let full = Path::new(last);
        if full.is_absolute() {
            let expected = directory.join(format!(
                "{}.json",
                &sha(full.to_string_lossy().as_bytes())[..16]
            ));
            if regular_exists(&expected)? {
                return Ok(Some(expected));
            }
        }
    }
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let path = entry.path();
        if regular_exists(&path)? {
            candidates.push(path)
        }
    }
    match candidates.len() {
        0 => Ok(None),
        1 => Ok(candidates.pop()),
        _ => Err(
            "More than one legacy catalog exists and the last opened catalog cannot be identified."
                .into(),
        ),
    }
}

fn run_migration(
    service: &mut CatalogService,
    legacy_path: &Path,
    last_folder: Option<&str>,
    identity: &mut (Option<String>, Option<String>),
) -> Result<(), String> {
    let catalog_bytes = regular(legacy_path)?.ok_or("Legacy catalog disappeared.")?;
    let catalog: Value = serde_json::from_slice(&catalog_bytes)
        .map_err(|e| format!("Legacy catalog is not valid JSON: {e}"))?;
    let version = catalog["version"]
        .as_u64()
        .filter(|version| *version == 1 || *version == 2)
        .ok_or("Legacy catalog version is unsupported.")?;
    let root = PathBuf::from(string(&catalog, "rootPath")?);
    if !root.is_absolute()
        || root.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("Legacy root path is not absolute and normalized.".into());
    }
    if let Some(last) = last_folder {
        if Path::new(last) != root {
            return Err("Legacy catalog root does not match the last opened folder.".into());
        }
    }
    let catalog_id = stable_uuid("darkroom.catalog-v3", &root.to_string_lossy());
    let root_id = stable_uuid("darkroom.catalog-v3.root", &root.to_string_lossy());
    identity.0 = Some(catalog_id.clone());
    let settings_path = service.user_data.join("settings.json");
    let settings_bytes = regular(&settings_path)?;
    let catalog_sha = sha(&catalog_bytes);
    let settings_sha = settings_bytes.as_ref().map(|bytes| sha(bytes));
    let migration_id = stable_uuid(
        "darkroom.catalog-v3.migration",
        &format!(
            "{}\0{}\0{}",
            legacy_path.display(),
            catalog_sha,
            settings_sha.as_deref().unwrap_or("none")
        ),
    );
    identity.1 = Some(migration_id.clone());
    let recovery = service
        .user_data
        .join("catalog-migration-recovery")
        .join(&migration_id);
    snapshot(&recovery.join("catalog.json"), &catalog_bytes)?;
    if let Some(bytes) = &settings_bytes {
        snapshot(&recovery.join("settings.json"), bytes)?
    }
    let (assets, albums, online) = build_assets(&catalog, &root, version)?;
    let archived = assets.values().filter(|item| item.archived).count();
    let memberships: usize = albums
        .iter()
        .map(|album| album["entryIds"].as_array().map_or(0, Vec::len))
        .sum();
    let state_sha = sha(serde_json::to_string(
        &json!({"assets":assets.keys().collect::<Vec<_>>(),"albums":albums,"archived":archived}),
    )
    .map_err(|e| e.to_string())?
    .as_bytes());
    let expected = json!({"catalogSha256":catalog_sha,"settingsSha256":settings_sha,"stateSha256":state_sha,"assets":assets.len(),"metadata":assets.len(),"albums":albums.len(),"albumAssets":memberships,"aliases":assets.len(),"fingerprints":assets.len(),"archived":archived,"present":assets.values().filter(|item|item.observation.is_some()).count(),"missing":assets.values().filter(|item|item.observation.is_none()).count(),"scan":if online{"online"}else{"offline"}});
    let migration_directory = service.user_data.join("catalog-migrations");
    let database_directory = service.user_data.join("catalogs-v3");
    fs::create_dir_all(&migration_directory).map_err(|e| e.to_string())?;
    fs::create_dir_all(&database_directory).map_err(|e| e.to_string())?;
    let envelope_path = migration_directory.join(format!("{migration_id}.json"));
    let envelope = json!({"version":1,"catalogId":catalog_id,"migrationId":migration_id,"catalogPath":legacy_path,"catalogSha256":catalog_sha,"settingsSha256":settings_sha,"expected":expected,"recoveryDirectory":recovery});
    if let Some(existing) = regular(&envelope_path)? {
        let prior: Value =
            serde_json::from_slice(&existing).map_err(|_| "Migration envelope is invalid.")?;
        if prior != envelope {
            return Err("Migration envelope differs from current sources.".into());
        }
    } else {
        write_json(&envelope_path, &envelope)?
    }
    let final_path = database_directory.join(format!("{catalog_id}.sqlite"));
    if !final_path.exists() {
        let staging = database_directory.join(format!(".{catalog_id}.{migration_id}.sqlite.tmp"));
        if staging.exists() {
            if verify_database(&staging, &catalog_id, &migration_id, &expected).is_err() {
                fs::remove_file(&staging).map_err(|e| e.to_string())?;
            }
        }
        if !staging.exists() {
            write_database(
                &staging,
                &catalog_id,
                &root_id,
                &migration_id,
                legacy_path,
                settings_bytes.as_ref().map(|_| settings_path.as_path()),
                &root,
                online,
                version,
                &assets,
                &albums,
                &expected,
            )?
        }
        verify_database(&staging, &catalog_id, &migration_id, &expected)?;
        if regular(legacy_path)?.as_ref().map(|bytes| sha(bytes)) != Some(catalog_sha.clone())
            || regular(&settings_path)?.as_ref().map(|bytes| sha(bytes)) != settings_sha
        {
            return Err("Legacy migration sources changed during installation.".into());
        }
        fs::hard_link(&staging, &final_path).map_err(|e| e.to_string())?;
        fs::remove_file(staging).map_err(|e| e.to_string())?;
    }
    verify_database(&final_path, &catalog_id, &migration_id, &expected)?;
    if regular(legacy_path)?.as_ref().map(|bytes| sha(bytes)) != Some(catalog_sha)
        || regular(&settings_path)?.as_ref().map(|bytes| sha(bytes)) != settings_sha
    {
        return Err("Legacy migration sources changed before activation.".into());
    }
    let display = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Migrated catalog");
    service.registry["catalogs"].as_array_mut().ok_or("Catalog registry is invalid.")?.push(json!({"catalogId":catalog_id,"displayName":display,"databasePath":final_path.to_string_lossy(),"health":"healthy","lastOpenedAt":now()}));
    service.save_registry()?;
    service.activate(&catalog_id, final_path)?;
    Ok(())
}

impl CatalogService {
    pub(super) fn migrate_legacy(&mut self) -> Result<Option<Value>, String> {
        if !self.registry["catalogs"]
            .as_array()
            .is_some_and(Vec::is_empty)
        {
            return Ok(None);
        }
        let settings = fs::read(self.user_data.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let last_folder = settings
            .as_ref()
            .and_then(|settings| settings["lastFolderPath"].as_str());
        let legacy = match selected_legacy(&self.user_data, last_folder) {
            Ok(legacy) => legacy,
            Err(error) => {
                return Ok(Some(
                    json!({"kind":"corrupt","catalogId":null,"message":format!("The existing library could not be migrated safely: {error}")}),
                ));
            }
        };
        let Some(legacy) = legacy else {
            return Ok(None);
        };
        let mut identity = (None, None);
        if let Err(error) = run_migration(self, &legacy, last_folder, &mut identity) {
            let recovery = identity.1.as_ref().map(|migration_id| {
                self.user_data
                    .join("catalog-migration-recovery")
                    .join(migration_id)
            });
            return Ok(Some(
                json!({"kind":"corrupt","catalogId":identity.0,"message":format!("The existing library could not be migrated safely. Its original files were not changed. {error}"),"migrationId":identity.1,"recoveryDirectory":recovery}),
            ));
        }
        Ok(None)
    }
}
