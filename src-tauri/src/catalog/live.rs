use super::*;

const SNAPSHOTS: &str = "SELECT a.catalog_id AS catalogId,e.entry_id AS entryId,e.source_id AS sourceId,e.is_original AS isOriginal,e.parent_entry_id AS parentEntryId,e.display_name AS displayName,e.created_at AS entryCreatedAt,a.asset_id AS assetId,a.root_id AS rootId,a.relative_path AS relativePath,a.observed_byte_length AS observedByteLength,a.observed_modified_at AS observedModifiedAt,a.observed_at AS observedAt,a.local_file_id AS localFileId,a.revision AS assetRevision,a.health,a.format_id AS formatId,a.camera_make AS cameraMake,a.camera_model AS cameraModel,a.lens_model AS lensModel,f.fingerprint_id AS fingerprintId,f.status AS fingerprintStatus,f.sha256 AS fingerprintSha256,f.observed_at AS fingerprintObservedAt,f.observed_byte_length AS fingerprintObservedByteLength,f.observed_modified_at AS fingerprintObservedModifiedAt,f.local_file_id AS fingerprintLocalFileId,m.archive,m.pick,m.rating,m.color_label AS colorLabel,m.develop_json AS developJson,m.develop_updated_at AS developUpdatedAt,m.updated_at AS updatedAt,m.title,m.caption,m.copyright,m.keywords_json AS keywordsJson,m.raw_xmp AS rawXmp,m.xmp_state AS xmpState,m.xmp_mtime AS xmpMtime,m.xmp_sha256 AS xmpSha256 FROM edit_entries e JOIN assets a ON a.catalog_id=e.catalog_id AND a.asset_id=e.source_id JOIN entry_metadata m ON m.catalog_id=e.catalog_id AND m.entry_id=e.entry_id JOIN fingerprints f ON f.catalog_id=a.catalog_id AND f.asset_id=a.asset_id";

fn required_json(raw: &Value) -> Result<Value, String> {
    serde_json::from_str(raw.as_str().ok_or("Catalog JSON column is invalid.")?)
        .map_err(|e| e.to_string())
}

fn operation_rank(state: &Value) -> Result<u8, String> {
    match state.as_str() {
        Some("planned") => Ok(0),
        Some("running") => Ok(1),
        Some("completed" | "failed" | "cancelled") => Ok(2),
        _ => Err("Catalog operation state is invalid.".into()),
    }
}

fn stage_rank(stage: &Value) -> Result<u8, String> {
    match stage.as_str() {
        Some("planned") => Ok(0),
        Some("destination-prepared") => Ok(1),
        Some("destination-published") => Ok(2),
        Some("catalog-applied") => Ok(3),
        Some("source-cleaned") => Ok(4),
        _ => Err("Catalog operation item stage is invalid.".into()),
    }
}

fn status_rank(status: &Value) -> Result<u8, String> {
    if status == "skipped" {
        Ok(2)
    } else {
        operation_rank(status)
    }
}

fn same(left: &Value, right: &Value) -> bool {
    left == right || (left.is_number() && right.is_number() && left.as_f64() == right.as_f64())
}

fn observation_from_row(row: &Value) -> Value {
    if row["observedAt"].is_null()
        && row["observedByteLength"].is_null()
        && row["observedModifiedAt"].is_null()
        && row["localFileId"].is_null()
    {
        Value::Null
    } else {
        json!({"byteLength":row["observedByteLength"],"modifiedAt":row["observedModifiedAt"],"observedAt":row["observedAt"],"localFileId":row["localFileId"]})
    }
}

fn snapshot(row: &Value) -> Value {
    json!({
        "catalogId":row["catalogId"],"entryId":row["entryId"],"sourceId":row["sourceId"],
        "entryKind":if row["isOriginal"] == 1 {"original"} else {"virtual"},
        "parentEntryId":row["parentEntryId"],"displayName":row["displayName"],"entryCreatedAt":row["entryCreatedAt"],
        "assetId":row["assetId"],"rootId":row["rootId"],"relativePath":row["relativePath"],"observation":observation_from_row(row),
        "revision":row["assetRevision"],"health":row["health"],"formatId":row["formatId"],
        "cameraMake":row["cameraMake"],"cameraModel":row["cameraModel"],"lensModel":row["lensModel"],
        "fingerprintId":row["fingerprintId"],"fingerprintStatus":row["fingerprintStatus"],"fingerprintSha256":row["fingerprintSha256"],
        "fingerprintObservedAt":row["fingerprintObservedAt"],"fingerprintObservedByteLength":row["fingerprintObservedByteLength"],
        "fingerprintObservedModifiedAt":row["fingerprintObservedModifiedAt"],"fingerprintLocalFileId":row["fingerprintLocalFileId"],
        "metadata":{"archive":row["archive"] == 1,"pick":row["pick"],"rating":row["rating"],"colorLabel":row["colorLabel"],
            "developJson":row["developJson"],"developUpdatedAt":row["developUpdatedAt"],"updatedAt":row["updatedAt"],
            "title":row["title"],"caption":row["caption"],"copyright":row["copyright"],"keywordsJson":row["keywordsJson"],
            "rawXmp":row["rawXmp"],"xmpState":row["xmpState"],"xmpMtime":row["xmpMtime"],"xmpSha256":row["xmpSha256"]}
    })
}

impl CatalogService {
    pub(super) fn query(&self, request: &Value) -> Result<Value, String> {
        let db = self.db()?;
        let id = string(request, "catalogId")?;
        let catalog = one(db,"SELECT catalog_id AS catalogId,display_name AS displayName,app_version AS appVersion,install_state AS installState,revision FROM catalog_meta WHERE catalog_id=?",vec![SqlValue::Text(id.into())])?.ok_or("Catalog is missing.")?;
        if catalog["installState"] != "ready" {
            return Err("Catalog is not ready.".into());
        }
        if request
            .get("expectedRevision")
            .is_some_and(|v| !v.is_null() && *v != catalog["revision"])
        {
            return Err(format!(
                "Catalog live revision {} is stale; current revision is {}.",
                request["expectedRevision"], catalog["revision"]
            ));
        }
        let roots = rows(
            db,
            "SELECT root_id AS rootId,label,health,scan_state AS scanState,watch_state AS watchState,revision FROM roots WHERE catalog_id=? ORDER BY root_id",
            vec![SqlValue::Text(id.into())],
        )?;
        let mut sql = format!("{SNAPSHOTS} WHERE a.catalog_id=? AND e.tombstoned_at IS NULL");
        let mut parameters = vec![SqlValue::Text(id.into())];
        for (key, column) in [
            ("entryId", "e.entry_id"),
            ("assetId", "a.asset_id"),
            ("rootId", "a.root_id"),
        ] {
            if let Some(value) = request.get(key).and_then(Value::as_str) {
                sql.push_str(&format!(" AND {column}=?"));
                parameters.push(SqlValue::Text(value.into()));
            }
        }
        sql.push_str(
            " ORDER BY a.relative_path,a.asset_id,e.is_original DESC,e.created_at,e.entry_id",
        );
        let assets = rows(db, &sql, parameters)?
            .iter()
            .map(snapshot)
            .collect::<Vec<_>>();
        let tombstones = rows(db,"SELECT entry_id AS entryId FROM edit_entries WHERE catalog_id=? AND tombstoned_at IS NOT NULL ORDER BY entry_id",vec![SqlValue::Text(id.into())])?.into_iter().map(|v| v["entryId"].clone()).collect::<Vec<_>>();
        let album_rows = rows(
            db,
            "SELECT album_id AS albumId,name,created_at AS createdAt,updated_at AS updatedAt,position FROM albums WHERE catalog_id=? ORDER BY position",
            vec![SqlValue::Text(id.into())],
        )?;
        let mut albums = Vec::new();
        for album in album_rows {
            let members = rows(
                db,
                "SELECT ae.entry_id AS entryId,ee.source_id AS assetId FROM album_entries ae JOIN edit_entries ee ON ee.catalog_id=ae.catalog_id AND ee.entry_id=ae.entry_id WHERE ae.catalog_id=? AND ae.album_id=? AND ee.tombstoned_at IS NULL ORDER BY ae.position",
                values(&[&json!(id), &album["albumId"]]),
            )?;
            albums.push(json!({"albumId":album["albumId"],"name":album["name"],"createdAt":album["createdAt"],"updatedAt":album["updatedAt"],"position":album["position"],"entryIds":members.iter().map(|m|m["entryId"].clone()).collect::<Vec<_>>(),"assetIds":members.iter().map(|m|m["assetId"].clone()).collect::<Vec<_>>()}));
        }
        let operation_rows = rows(
            db,
            "SELECT operation_id AS operationId,kind,state,revision,created_at AS createdAt,updated_at AS updatedAt FROM operations WHERE catalog_id=? ORDER BY created_at,operation_id",
            vec![SqlValue::Text(id.into())],
        )?;
        let mut operations = Vec::new();
        for operation in operation_rows {
            let items = rows(
                db,
                "SELECT operation_id AS operationId,item_id AS itemId,asset_id AS assetId,state,payload_json AS payloadJson FROM operation_items WHERE catalog_id=? AND operation_id=? ORDER BY item_id",
                values(&[&json!(id), &operation["operationId"]]),
            )?;
            let mut projected = Vec::new();
            for item in items {
                projected.push(json!({"operationId":item["operationId"],"itemId":item["itemId"],"assetId":item["assetId"],"state":item["state"],"payload":required_json(&item["payloadJson"])?}));
            }
            operations.push(json!({"operationId":operation["operationId"],"kind":operation["kind"],"state":operation["state"],"revision":operation["revision"],"createdAt":operation["createdAt"],"updatedAt":operation["updatedAt"],"items":projected}));
        }
        let mut presets = Vec::new();
        for preset in rows(
            db,
            "SELECT preset_id AS presetId,name,payload_json AS payloadJson,revision,created_at AS createdAt,updated_at AS updatedAt FROM import_presets WHERE catalog_id=? ORDER BY created_at,preset_id",
            vec![SqlValue::Text(id.into())],
        )? {
            let payload = required_json(&preset["payloadJson"])?;
            presets.push(json!({"presetId":preset["presetId"],"name":preset["name"],"template":payload["template"],"payload":payload["payload"],"isDefault":payload["isDefault"],"revision":preset["revision"],"createdAt":preset["createdAt"],"updatedAt":preset["updatedAt"]}));
        }
        let mut rules = Vec::new();
        for rule in rows(
            db,
            "SELECT rule_id AS ruleId,name,enabled,destination_root_id AS destinationRootId,preset_id AS presetId,config_json AS configJson,revision,created_at AS createdAt,updated_at AS updatedAt FROM auto_import_rules WHERE catalog_id=? ORDER BY rule_id",
            vec![SqlValue::Text(id.into())],
        )? {
            rules.push(json!({"ruleId":rule["ruleId"],"name":rule["name"],"enabled":rule["enabled"] == 1,"destinationRootId":rule["destinationRootId"],"presetId":rule["presetId"],"config":required_json(&rule["configJson"] )?,"revision":rule["revision"],"createdAt":rule["createdAt"],"updatedAt":rule["updatedAt"]}));
        }
        let library_state = one(
            db,
            "SELECT state_json AS stateJson FROM library_state WHERE catalog_id=?",
            vec![SqlValue::Text(id.into())],
        )?
        .map(|v| v["stateJson"].clone())
        .unwrap_or(Value::Null);
        let coverage=one(db,"SELECT COUNT(*) AS total,COALESCE(SUM(status='missing'),0) AS missing,COALESCE(SUM(status='hashing'),0) AS hashing,COALESCE(SUM(status='valid'),0) AS valid,COALESCE(SUM(status='stale'),0) AS stale,COALESCE(SUM(status='failed'),0) AS failed FROM fingerprints WHERE catalog_id=?",vec![SqlValue::Text(id.into())])?.ok_or("Fingerprint coverage is missing.")?;
        let matches = if let Some(sha) = request.get("fingerprintSha256").and_then(Value::as_str) {
            rows(
                db,
                "SELECT fingerprint_id AS fingerprintId,asset_id AS assetId,sha256 FROM fingerprints WHERE catalog_id=? AND status='valid' AND sha256=? ORDER BY asset_id",
                vec![SqlValue::Text(id.into()), SqlValue::Text(sha.into())],
            )?
        } else {
            Vec::new()
        };
        Ok(
            json!({"catalog":catalog,"roots":roots,"assets":assets,"tombstonedEntryIds":tombstones,"albums":albums,"operations":operations,"presets":presets,"rules":rules,"libraryStateJson":library_state,"fingerprintCoverage":coverage,"fingerprintMatches":matches}),
        )
    }

    pub(super) fn apply(&mut self, request: &Value) -> Result<Value, String> {
        let id = string(request, "catalogId")?.to_string();
        let expected = number(request, "expectedRevision")?;
        let mutations = field(request, "mutations")?
            .as_array()
            .ok_or("Catalog mutations are invalid.")?;
        if mutations.len() > 250 {
            return Err("Catalog has too many mutations.".into());
        }
        let db = self.db()?;
        db.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| -> Result<Value, String> {
            let revision = self.revision(&id)?;
            if expected != revision {
                return Err(format!(
                    "Catalog live revision {expected} is stale; current revision is {revision}."
                ));
            }
            if one(db,"SELECT 1 FROM edit_entries e LEFT JOIN develop_history_heads h ON h.catalog_id=e.catalog_id AND h.entry_id=e.entry_id WHERE e.catalog_id=? AND h.entry_id IS NULL LIMIT 1",vec![SqlValue::Text(id.clone())])?.is_some() { return Err("Develop history Head is missing; recovery is required.".into()) }
            let timestamp = request
                .get("now")
                .and_then(Value::as_i64)
                .unwrap_or_else(now);
            let mut changed = false;
            let mut kinds = Vec::new();
            for mutation in mutations {
                let kind = string(mutation, "kind")?;
                kinds.push(kind);
                if kind == "metadata-patch" && mutation["patch"].get("developJson").is_some() {
                    let entry_id = mutation
                        .get("entryId")
                        .or_else(|| mutation.get("assetId"))
                        .and_then(Value::as_str)
                        .ok_or("Catalog edit entry is missing.")?;
                    let current=one(db,"SELECT develop_updated_at AS developUpdatedAt FROM entry_metadata WHERE catalog_id=? AND entry_id=?",values(&[&json!(id),&json!(entry_id)]))?.ok_or("Catalog metadata is missing.")?;
                    let stale = mutation["patch"]
                        .get("developUpdatedAt")
                        .and_then(Value::as_f64)
                        .is_some_and(|at| {
                            at <= current["developUpdatedAt"].as_f64().unwrap_or(0.0)
                        });
                    let mut metadata_mutation = mutation.clone();
                    metadata_mutation["patch"]
                        .as_object_mut()
                        .ok_or("Catalog metadata patch is invalid.")?
                        .remove("developJson");
                    if stale {
                        metadata_mutation["patch"]
                            .as_object_mut()
                            .unwrap()
                            .remove("developUpdatedAt");
                    }
                    changed = self.apply_mutation(&id, &metadata_mutation, timestamp)? || changed;
                    if !stale {
                        let next = if mutation["patch"]["developJson"].is_null() {
                            Value::Null
                        } else {
                            required_json(&mutation["patch"]["developJson"])?
                        };
                        let head_id = history::head(db, &id, entry_id)?;
                        let before = history::reconstruct(db, &id, entry_id, &head_id)?;
                        if history::canonical_json(&before) != history::canonical_json(&next) {
                            let created_at = mutation["patch"]
                                .get("developUpdatedAt")
                                .or_else(|| mutation["patch"].get("updatedAt"))
                                .cloned()
                                .unwrap_or(json!(timestamp));
                            history::commit(
                                db,
                                &json!({"catalogId":id,"entryId":entry_id,"revisionId":Uuid::new_v4().to_string(),"expectedParentRevisionId":head_id,"operationId":Uuid::new_v4().to_string(),"label":"Edit","document":next,"createdAt":created_at}),
                            )?;
                            changed = true;
                        }
                    }
                } else {
                    changed = self.apply_mutation(&id, mutation, timestamp)? || changed;
                }
            }
            history::ensure_roots_inner(db, &id)?;
            if !changed {
                return Ok(
                    json!({"catalogId":id,"revision":revision,"changed":false,"appliedMutations":mutations.len(),"auditId":null}),
                );
            }
            execute(
                db,
                "UPDATE catalog_meta SET revision=?,updated_at=? WHERE catalog_id=? AND revision=?",
                vec![
                    SqlValue::Integer(revision + 1),
                    SqlValue::Integer(timestamp),
                    SqlValue::Text(id.clone()),
                    SqlValue::Integer(revision),
                ],
            )?;
            let audit=json!({"version":1,"expectedRevision":expected,"revision":revision+1,"mutationKinds":kinds}).to_string();
            execute(
                db,
                "INSERT INTO audit_log (catalog_id,migration_id,event,payload_json,created_at) VALUES (?,NULL,'live-apply',?,?)",
                vec![
                    SqlValue::Text(id.clone()),
                    SqlValue::Text(audit),
                    SqlValue::Integer(timestamp),
                ],
            )?;
            let audit_id = db.last_insert_rowid();
            Ok(
                json!({"catalogId":id,"revision":revision+1,"changed":true,"appliedMutations":mutations.len(),"auditId":audit_id}),
            )
        })();
        match result {
            Ok(value) => {
                db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(value)
            }
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn apply_mutation(&self, id: &str, mutation: &Value, timestamp: i64) -> Result<bool, String> {
        let db = self.db()?;
        let kind = string(mutation, "kind")?;
        match kind {
            "rename-catalog" => {
                let name = string(mutation, "displayName")?;
                let current: String = db
                    .query_row(
                        "SELECT display_name FROM catalog_meta WHERE catalog_id=?",
                        [id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if current == name {
                    return Ok(false);
                }
                execute(
                    db,
                    "UPDATE catalog_meta SET display_name=? WHERE catalog_id=?",
                    vec![SqlValue::Text(name.into()), SqlValue::Text(id.into())],
                )?;
                Ok(true)
            }
            "root-upsert" => {
                let root = field(mutation, "root")?;
                let root_id = string(root, "rootId")?;
                let existing = one(
                    db,
                    "SELECT label,configured_path AS configuredPath,canonical_path AS canonicalPath,health,scan_state AS scanState,watch_state AS watchState FROM roots WHERE catalog_id=? AND root_id=?",
                    vec![SqlValue::Text(id.into()), SqlValue::Text(root_id.into())],
                )?;
                let same = existing.as_ref().is_some_and(|v| {
                    [
                        "label",
                        "configuredPath",
                        "canonicalPath",
                        "health",
                        "scanState",
                        "watchState",
                    ]
                    .iter()
                    .all(|key| v[*key] == root[*key])
                });
                if same {
                    return Ok(false);
                }
                let fields = values(&[
                    &root["label"],
                    &root["configuredPath"],
                    &root["canonicalPath"],
                    &root["health"],
                    &root["scanState"],
                    &root["watchState"],
                ]);
                if existing.is_some() {
                    let mut params = fields;
                    params.extend([SqlValue::Text(id.into()), SqlValue::Text(root_id.into())]);
                    execute(
                        db,
                        "UPDATE roots SET label=?,configured_path=?,canonical_path=?,health=?,scan_state=?,watch_state=?,revision=revision+1 WHERE catalog_id=? AND root_id=?",
                        params,
                    )?;
                } else {
                    let mut params =
                        vec![SqlValue::Text(id.into()), SqlValue::Text(root_id.into())];
                    params.extend(fields);
                    execute(
                        db,
                        "INSERT INTO roots (catalog_id,root_id,label,configured_path,canonical_path,health,scan_state,watch_state,revision) VALUES (?,?,?,?,?,?,?,?,1)",
                        params,
                    )?;
                }
                Ok(true)
            }
            "root-health" | "root-scan" | "root-watch" | "root-relink" => {
                let root_id = string(mutation, "rootId")?;
                let old=one(db,"SELECT label,configured_path AS configuredPath,canonical_path AS canonicalPath,health,scan_state AS scanState,watch_state AS watchState FROM roots WHERE catalog_id=? AND root_id=?",vec![SqlValue::Text(id.into()),SqlValue::Text(root_id.into())])?.ok_or("Catalog root is missing.")?;
                let mut next = old.clone();
                let keys: &[&str] = match kind {
                    "root-health" => &["health", "canonicalPath"],
                    "root-scan" => &["scanState"],
                    "root-watch" => &["watchState"],
                    _ => &["label", "configuredPath", "canonicalPath", "health"],
                };
                for key in keys {
                    next[*key] = mutation[*key].clone();
                }
                if next == old {
                    return Ok(false);
                }
                execute(
                    db,
                    "UPDATE roots SET label=?,configured_path=?,canonical_path=?,health=?,scan_state=?,watch_state=?,revision=revision+1 WHERE catalog_id=? AND root_id=?",
                    values(&[
                        &next["label"],
                        &next["configuredPath"],
                        &next["canonicalPath"],
                        &next["health"],
                        &next["scanState"],
                        &next["watchState"],
                        &json!(id),
                        &json!(root_id),
                    ]),
                )?;
                Ok(true)
            }
            "metadata-patch" | "archive-set" => {
                let entry_id = mutation
                    .get("entryId")
                    .or_else(|| mutation.get("assetId"))
                    .and_then(Value::as_str)
                    .ok_or("Catalog entry ID is missing.")?;
                let mut current=one(db,"SELECT archive,pick,rating,color_label AS colorLabel,develop_json AS developJson,develop_updated_at AS developUpdatedAt,updated_at AS updatedAt,title,caption,copyright,keywords_json AS keywordsJson,raw_xmp AS rawXmp,xmp_state AS xmpState,xmp_mtime AS xmpMtime,xmp_sha256 AS xmpSha256 FROM entry_metadata WHERE catalog_id=? AND entry_id=?",vec![SqlValue::Text(id.into()),SqlValue::Text(entry_id.into())])?.ok_or("Catalog metadata is missing.")?;
                current["archive"] = json!(current["archive"] == 1);
                let mut next = current.clone();
                if kind == "archive-set" {
                    next["archive"] = json!(mutation["archived"] == true);
                } else {
                    let patch = field(mutation, "patch")?;
                    for key in [
                        "archive",
                        "pick",
                        "rating",
                        "colorLabel",
                        "developJson",
                        "developUpdatedAt",
                        "updatedAt",
                        "title",
                        "caption",
                        "copyright",
                        "keywordsJson",
                        "rawXmp",
                        "xmpState",
                        "xmpMtime",
                        "xmpSha256",
                    ] {
                        if let Some(value) = patch.get(key) {
                            next[key] = value.clone()
                        }
                    }
                }
                if next == current {
                    return Ok(false);
                }
                next["updatedAt"] = mutation
                    .get("patch")
                    .and_then(|v| v.get("updatedAt"))
                    .cloned()
                    .unwrap_or(json!(timestamp));
                if next["xmpState"] == "preserved" && next["rawXmp"].is_null() {
                    return Err("Catalog metadata XMP state is inconsistent.".into());
                }
                if next["xmpState"] == "absent" && !next["rawXmp"].is_null() {
                    return Err("Catalog metadata XMP state is inconsistent.".into());
                }
                let mut params = values(&[
                    &next["archive"],
                    &next["pick"],
                    &next["rating"],
                    &next["colorLabel"],
                    &next["developJson"],
                    &next["developUpdatedAt"],
                    &next["updatedAt"],
                    &next["title"],
                    &next["caption"],
                    &next["copyright"],
                    &next["keywordsJson"],
                    &next["rawXmp"],
                    &next["xmpState"],
                    &next["xmpMtime"],
                    &next["xmpSha256"],
                ]);
                params.extend([SqlValue::Text(id.into()), SqlValue::Text(entry_id.into())]);
                execute(
                    db,
                    "UPDATE entry_metadata SET archive=?,pick=?,rating=?,color_label=?,develop_json=?,develop_updated_at=?,updated_at=?,title=?,caption=?,copyright=?,keywords_json=?,raw_xmp=?,xmp_state=?,xmp_mtime=?,xmp_sha256=? WHERE catalog_id=? AND entry_id=?",
                    params,
                )?;
                if one(db,"SELECT 1 FROM edit_entries WHERE catalog_id=? AND entry_id=? AND is_original=1",vec![SqlValue::Text(id.into()),SqlValue::Text(entry_id.into())])?.is_some() {
                    let mut params=values(&[&next["archive"],&next["pick"],&next["rating"],&next["colorLabel"],&next["developJson"],&next["developUpdatedAt"],&next["updatedAt"],&next["title"],&next["caption"],&next["copyright"],&next["keywordsJson"],&next["rawXmp"],&next["xmpState"],&next["xmpMtime"],&next["xmpSha256"]]);
                    params.extend([SqlValue::Text(id.into()),SqlValue::Text(entry_id.into())]);
                    execute(db,"UPDATE asset_metadata SET archive=?,pick=?,rating=?,color_label=?,develop_json=?,develop_updated_at=?,updated_at=?,title=?,caption=?,copyright=?,keywords_json=?,raw_xmp=?,xmp_state=?,xmp_mtime=?,xmp_sha256=? WHERE catalog_id=? AND asset_id=?",params)?;
                }
                Ok(true)
            }
            "album-create" => {
                let existing = one(
                    db,
                    "SELECT album_id FROM albums WHERE catalog_id=? AND album_id=?",
                    values(&[&json!(id), &mutation["albumId"]]),
                )?;
                if existing.is_some() {
                    return Ok(false);
                }
                execute(
                    db,
                    "INSERT INTO albums (catalog_id,album_id,name,created_at,updated_at,position) VALUES (?,?,?,?,?,?)",
                    values(&[
                        &json!(id),
                        &mutation["albumId"],
                        &mutation["name"],
                        &mutation["createdAt"],
                        &mutation["updatedAt"],
                        &mutation["position"],
                    ]),
                )?;
                Ok(true)
            }
            "album-rename" => {
                let old = one(
                    db,
                    "SELECT name FROM albums WHERE catalog_id=? AND album_id=?",
                    values(&[&json!(id), &mutation["albumId"]]),
                )?
                .ok_or("Catalog album is missing.")?;
                if old["name"] == mutation["name"] {
                    return Ok(false);
                }
                execute(
                    db,
                    "UPDATE albums SET name=?,updated_at=? WHERE catalog_id=? AND album_id=?",
                    values(&[
                        &mutation["name"],
                        &mutation["updatedAt"],
                        &json!(id),
                        &mutation["albumId"],
                    ]),
                )?;
                Ok(true)
            }
            "album-delete" => {
                execute(
                    db,
                    "DELETE FROM album_entries WHERE catalog_id=? AND album_id=?",
                    values(&[&json!(id), &mutation["albumId"]]),
                )?;
                execute(
                    db,
                    "DELETE FROM album_assets WHERE catalog_id=? AND album_id=?",
                    values(&[&json!(id), &mutation["albumId"]]),
                )?;
                Ok(execute(
                    db,
                    "DELETE FROM albums WHERE catalog_id=? AND album_id=?",
                    values(&[&json!(id), &mutation["albumId"]]),
                )? > 0)
            }
            "album-membership-replace" => self.album_membership(id, mutation),
            "library-state-replace" => {
                let state = string(mutation, "stateJson")?;
                let parsed: Value = serde_json::from_str(state).map_err(|e| e.to_string())?;
                if !parsed.is_object() {
                    return Err("Catalog library state must be an object.".into());
                }
                let old = one(
                    db,
                    "SELECT state_json AS stateJson FROM library_state WHERE catalog_id=?",
                    vec![SqlValue::Text(id.into())],
                )?;
                if old.as_ref().is_some_and(|v| v["stateJson"] == state) {
                    return Ok(false);
                }
                execute(
                    db,
                    "INSERT INTO library_state (catalog_id,state_json,updated_at) VALUES (?,?,?) ON CONFLICT(catalog_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at",
                    vec![
                        SqlValue::Text(id.into()),
                        SqlValue::Text(state.into()),
                        SqlValue::Integer(timestamp),
                    ],
                )?;
                Ok(true)
            }
            "preset-upsert" => self.preset_upsert(id, mutation),
            "preset-rename" => {
                let old = one(
                    db,
                    "SELECT name FROM import_presets WHERE catalog_id=? AND preset_id=?",
                    values(&[&json!(id), &mutation["presetId"]]),
                )?
                .ok_or("Catalog preset is missing.")?;
                if old["name"] == mutation["name"] {
                    return Ok(false);
                }
                execute(
                    db,
                    "UPDATE import_presets SET name=?,updated_at=?,revision=revision+1 WHERE catalog_id=? AND preset_id=?",
                    values(&[
                        &mutation["name"],
                        &mutation["updatedAt"],
                        &json!(id),
                        &mutation["presetId"],
                    ]),
                )?;
                Ok(true)
            }
            "preset-delete" => Ok(execute(
                db,
                "DELETE FROM import_presets WHERE catalog_id=? AND preset_id=?",
                values(&[&json!(id), &mutation["presetId"]]),
            )? > 0),
            "preset-set-default" => self.preset_default(
                id,
                string(mutation, "presetId")?,
                mutation
                    .get("updatedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(timestamp),
            ),
            "rule-upsert" => self.rule_upsert(id, mutation),
            "rule-delete" => Ok(execute(
                db,
                "DELETE FROM auto_import_rules WHERE catalog_id=? AND rule_id=?",
                values(&[&json!(id), &mutation["ruleId"]]),
            )? > 0),
            "operation-upsert" => self.operation_upsert(id, field(mutation, "operation")?),
            "operation-item-upsert" => self.operation_item_upsert(id, field(mutation, "item")?),
            "fingerprint-set" => {
                self.fingerprint_set(id, field(mutation, "fingerprint")?, timestamp)
            }
            "reconcile" | "reconcile-complete" => self.reconcile(id, mutation, timestamp),
            "asset-relocate" => self.asset_relocate(id, mutation, timestamp),
            "asset-copy" => self.asset_copy(id, mutation, timestamp),
            "edit-entry-create" => self.edit_entry_create(id, mutation),
            "edit-entry-rename" => self.edit_entry_rename(id, mutation),
            "edit-entry-delete" => self.edit_entry_delete(id, mutation),
            _ => Err(format!("Unsupported catalog mutation: {kind}")),
        }
    }
}

impl CatalogService {
    fn edit_entry_create(&self, id: &str, mutation: &Value) -> Result<bool, String> {
        let db = self.db()?;
        let source = string(mutation, "sourceEntryId")?;
        let target = string(mutation, "entryId")?;
        if one(
            db,
            "SELECT 1 FROM edit_entries WHERE catalog_id=? AND entry_id=?",
            values(&[&json!(id), &json!(target)]),
        )?
        .is_some()
        {
            return Err("Edit entry already exists.".into());
        }
        let source_row=one(db,"SELECT source_id AS sourceId FROM edit_entries WHERE catalog_id=? AND entry_id=? AND tombstoned_at IS NULL",values(&[&json!(id),&json!(source)]))?.ok_or("Source edit entry is missing.")?;
        let source_id = string(&source_row, "sourceId")?;
        let original=one(db,"SELECT entry_id AS entryId FROM edit_entries WHERE catalog_id=? AND source_id=? AND is_original=1 AND tombstoned_at IS NULL",values(&[&json!(id),&json!(source_id)]))?.ok_or("Original edit entry is missing.")?;
        let metadata = one(
            db,
            "SELECT updated_at AS updatedAt FROM entry_metadata WHERE catalog_id=? AND entry_id=?",
            values(&[&json!(id), &json!(source)]),
        )?
        .ok_or("Source edit metadata is missing.")?;
        if !same(
            &metadata["updatedAt"],
            &mutation["expectedSourceMetadataUpdatedAt"],
        ) {
            return Err("Source edit metadata changed before copy.".into());
        }
        execute(
            db,
            "INSERT INTO edit_entries (catalog_id,entry_id,source_id,is_original,parent_entry_id,display_name,created_at,updated_at) VALUES (?,?,?,0,?,?,?,?)",
            values(&[
                &json!(id),
                &json!(target),
                &json!(source_id),
                &original["entryId"],
                &mutation["displayName"],
                &mutation["createdAt"],
                &mutation["createdAt"],
            ]),
        )?;
        execute(
            db,
            "INSERT INTO entry_metadata (catalog_id,entry_id,archive,pick,rating,color_label,develop_json,develop_updated_at,updated_at,title,caption,copyright,keywords_json,raw_xmp,xmp_state,xmp_mtime,xmp_sha256) SELECT catalog_id,?,archive,pick,rating,color_label,?,?,?,title,caption,copyright,keywords_json,NULL,'absent',NULL,NULL FROM entry_metadata WHERE catalog_id=? AND entry_id=?",
            values(&[
                &json!(target),
                &mutation["developJson"],
                &mutation["createdAt"],
                &mutation["createdAt"],
                &json!(id),
                &json!(source),
            ]),
        )?;
        let memberships = rows(
            db,
            "SELECT album_id AS albumId,position FROM album_entries WHERE catalog_id=? AND entry_id=? ORDER BY album_id",
            values(&[&json!(id), &json!(source)]),
        )?;
        for membership in memberships {
            let album_id = string(&membership, "albumId")?;
            let mut members=rows(db,"SELECT entry_id AS entryId FROM album_entries WHERE catalog_id=? AND album_id=? ORDER BY position",values(&[&json!(id),&json!(album_id)]))?.into_iter().map(|v|v["entryId"].clone()).collect::<Vec<_>>();
            if let Some(position) = members.iter().position(|v| v == source) {
                members.insert(position + 1, json!(target));
            }
            self.album_membership(id, &json!({"albumId":album_id,"entryIds":members}))?;
        }
        Ok(true)
    }

    fn edit_entry_rename(&self, id: &str, mutation: &Value) -> Result<bool, String> {
        let db = self.db()?;
        let target = string(mutation, "entryId")?;
        let old=one(db,"SELECT is_original AS isOriginal,display_name AS displayName FROM edit_entries WHERE catalog_id=? AND entry_id=? AND tombstoned_at IS NULL",values(&[&json!(id),&json!(target)]))?.ok_or("Edit entry is missing.")?;
        if old["isOriginal"] == 1 {
            return Err("Original edit entry cannot be renamed.".into());
        }
        if old["displayName"] == mutation["displayName"] {
            return Ok(false);
        }
        execute(
            db,
            "UPDATE edit_entries SET display_name=?,updated_at=? WHERE catalog_id=? AND entry_id=? AND is_original=0",
            values(&[
                &mutation["displayName"],
                &mutation["updatedAt"],
                &json!(id),
                &json!(target),
            ]),
        )?;
        Ok(true)
    }

    fn edit_entry_delete(&self, id: &str, mutation: &Value) -> Result<bool, String> {
        let db = self.db()?;
        let target = string(mutation, "entryId")?;
        let old = one(
            db,
            "SELECT is_original AS isOriginal,tombstoned_at AS tombstonedAt FROM edit_entries WHERE catalog_id=? AND entry_id=?",
            values(&[&json!(id), &json!(target)]),
        )?;
        let Some(old) = old else { return Ok(false) };
        if old["isOriginal"] == 1 {
            return Err("Original edit entry cannot be deleted.".into());
        }
        if !old["tombstonedAt"].is_null() {
            return Ok(false);
        }
        execute(
            db,
            "UPDATE edit_entries SET tombstoned_at=?,updated_at=? WHERE catalog_id=? AND entry_id=? AND is_original=0 AND tombstoned_at IS NULL",
            values(&[
                &mutation["tombstonedAt"],
                &mutation["tombstonedAt"],
                &json!(id),
                &json!(target),
            ]),
        )?;
        Ok(true)
    }
}

fn observation_params(observation: &Value) -> [Value; 4] {
    [
        observation["byteLength"].clone(),
        observation["modifiedAt"].clone(),
        observation["observedAt"].clone(),
        observation["localFileId"].clone(),
    ]
}

impl CatalogService {
    fn asset_row(&self, id: &str, asset_id: &str) -> Result<Value, String> {
        one(self.db()?,"SELECT asset_id AS assetId,root_id AS rootId,relative_path AS relativePath,observed_byte_length AS observedByteLength,observed_modified_at AS observedModifiedAt,observed_at AS observedAt,local_file_id AS localFileId,health,format_id AS formatId,camera_make AS cameraMake,camera_model AS cameraModel,lens_model AS lensModel FROM assets WHERE catalog_id=? AND asset_id=?",values(&[&json!(id),&json!(asset_id)]))?.ok_or("Catalog asset is missing.".into())
    }

    fn insert_asset(
        &self,
        id: &str,
        asset_id: &str,
        root_id: &str,
        path: &str,
        entry: &Value,
        timestamp: i64,
    ) -> Result<(), String> {
        let db = self.db()?;
        let observation = entry.get("observation").unwrap_or(&Value::Null);
        let [bytes, modified, observed, file_id] = observation_params(observation);
        execute(
            db,
            "INSERT INTO assets (catalog_id,asset_id,root_id,relative_path,observed_byte_length,observed_modified_at,observed_at,local_file_id,revision,health,format_id,camera_make,camera_model,lens_model) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)",
            values(&[
                &json!(id),
                &json!(asset_id),
                &json!(root_id),
                &json!(path),
                &bytes,
                &modified,
                &observed,
                &file_id,
                &entry["health"],
                &entry["formatId"],
                &entry["cameraMake"],
                &entry["cameraModel"],
                &entry["lensModel"],
            ]),
        )?;
        execute(
            db,
            "INSERT INTO asset_metadata (catalog_id,asset_id,archive,pick,rating,color_label,develop_json,develop_updated_at,updated_at,title,caption,copyright,keywords_json,raw_xmp,xmp_state,xmp_mtime,xmp_sha256) VALUES (?,?,0,'none',0,NULL,NULL,?,?,NULL,NULL,NULL,'[]',NULL,'unknown',NULL,NULL)",
            values(&[
                &json!(id),
                &json!(asset_id),
                &json!(timestamp),
                &json!(timestamp),
            ]),
        )?;
        execute(
            db,
            "INSERT INTO fingerprints (catalog_id,fingerprint_id,asset_id,status,sha256,observed_at,observed_byte_length,observed_modified_at,local_file_id,updated_at) VALUES (?,?,?,'missing',NULL,?,?,?,?,?)",
            values(&[
                &json!(id),
                &json!(Uuid::new_v4().to_string()),
                &json!(asset_id),
                &observed,
                &bytes,
                &modified,
                &file_id,
                &json!(timestamp),
            ]),
        )?;
        Ok(())
    }

    fn reconcile(&self, id: &str, mutation: &Value, timestamp: i64) -> Result<bool, String> {
        let db = self.db()?;
        let root_id = string(mutation, "rootId")?;
        if one(
            db,
            "SELECT 1 FROM roots WHERE catalog_id=? AND root_id=?",
            values(&[&json!(id), &json!(root_id)]),
        )?
        .is_none()
        {
            return Err("Catalog root is missing.".into());
        }
        let observations = field(mutation, "observations")?
            .as_array()
            .ok_or("Catalog observations are invalid.")?;
        let mut seen = std::collections::HashSet::new();
        let mut seen_assets = std::collections::HashSet::new();
        let mut changed = false;
        for entry in observations {
            let path = string(entry, "relativePath")?;
            if !seen.insert(path) {
                return Err("Catalog reconcile contains a duplicate path.".into());
            }
            let existing = one(
                db,
                "SELECT asset_id AS assetId FROM assets WHERE catalog_id=? AND root_id=? AND relative_path=?",
                values(&[&json!(id), &json!(root_id), &json!(path)]),
            )?;
            let asset_id = entry
                .get("assetId")
                .and_then(Value::as_str)
                .or_else(|| existing.as_ref().and_then(|v| v["assetId"].as_str()))
                .map(str::to_string)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            if let Some(ref current) = existing {
                if current["assetId"] != asset_id {
                    return Err("Catalog reconcile asset ID conflicts with its path.".into());
                }
            }
            let observation = entry.get("observation").unwrap_or(&Value::Null);
            if existing.is_none() {
                if one(
                    db,
                    "SELECT 1 FROM assets WHERE catalog_id=? AND asset_id=?",
                    values(&[&json!(id), &json!(asset_id)]),
                )?
                .is_some()
                {
                    return Err("Catalog reconcile asset ID conflicts with its path.".into());
                }
                self.insert_asset(id, &asset_id, root_id, path, entry, timestamp)?;
                changed = true;
            } else {
                let old = self.asset_row(id, &asset_id)?;
                let [bytes, modified, observed, file_id] = observation_params(observation);
                let has_observation = !observation.is_null();
                let identity_changed = has_observation
                    && (!same(&old["observedByteLength"], &bytes)
                        || !same(&old["observedModifiedAt"], &modified)
                        || old["localFileId"] != file_id);
                if has_observation
                    && (!same(&old["observedAt"], &observed)
                        || identity_changed
                        || old["health"] != entry["health"]
                        || old["formatId"] != entry["formatId"]
                        || old["cameraMake"] != entry["cameraMake"]
                        || old["cameraModel"] != entry["cameraModel"]
                        || old["lensModel"] != entry["lensModel"])
                {
                    execute(
                        db,
                        "UPDATE assets SET observed_byte_length=?,observed_modified_at=?,observed_at=?,local_file_id=?,health=?,format_id=?,camera_make=?,camera_model=?,lens_model=?,revision=revision+1 WHERE catalog_id=? AND asset_id=?",
                        values(&[
                            &bytes,
                            &modified,
                            &observed,
                            &file_id,
                            &entry["health"],
                            &entry["formatId"],
                            &entry["cameraMake"],
                            &entry["cameraModel"],
                            &entry["lensModel"],
                            &json!(id),
                            &json!(asset_id),
                        ]),
                    )?;
                    if identity_changed {
                        execute(
                            db,
                            "UPDATE fingerprints SET status='stale',sha256=NULL,updated_at=? WHERE catalog_id=? AND asset_id=?",
                            values(&[&json!(timestamp), &json!(id), &json!(asset_id)]),
                        )?;
                    }
                    changed = true;
                } else if !has_observation && old["health"] != entry["health"] {
                    execute(
                        db,
                        "UPDATE assets SET health=?,revision=revision+1 WHERE catalog_id=? AND asset_id=?",
                        values(&[&entry["health"], &json!(id), &json!(asset_id)]),
                    )?;
                    changed = true;
                }
            }
            seen_assets.insert(asset_id);
        }
        let complete = mutation["kind"] == "reconcile-complete" || mutation["complete"] == true;
        if complete {
            let assets = rows(
                db,
                "SELECT asset_id AS assetId,health FROM assets WHERE catalog_id=? AND root_id=?",
                values(&[&json!(id), &json!(root_id)]),
            )?;
            for asset in assets {
                let asset_id = string(&asset, "assetId")?;
                if !seen_assets.contains(asset_id) && asset["health"] != "missing" {
                    execute(
                        db,
                        "UPDATE assets SET health='missing',revision=revision+1 WHERE catalog_id=? AND asset_id=?",
                        values(&[&json!(id), &json!(asset_id)]),
                    )?;
                    changed = true;
                }
            }
        }
        let state = if complete { "complete" } else { "partial" };
        let old = one(
            db,
            "SELECT scan_state AS scanState FROM roots WHERE catalog_id=? AND root_id=?",
            values(&[&json!(id), &json!(root_id)]),
        )?
        .ok_or("Catalog root is missing.")?;
        if old["scanState"] != state {
            execute(
                db,
                "UPDATE roots SET scan_state=?,revision=revision+1 WHERE catalog_id=? AND root_id=?",
                values(&[&json!(state), &json!(id), &json!(root_id)]),
            )?;
            changed = true;
        }
        Ok(changed)
    }

    fn fingerprint_set(
        &self,
        id: &str,
        fingerprint: &Value,
        timestamp: i64,
    ) -> Result<bool, String> {
        let db = self.db()?;
        let asset_id = string(fingerprint, "assetId")?;
        let old=one(db,"SELECT status,sha256,observed_at AS observedAt,observed_byte_length AS observedByteLength,observed_modified_at AS observedModifiedAt,local_file_id AS localFileId FROM fingerprints WHERE catalog_id=? AND asset_id=?",values(&[&json!(id),&json!(asset_id)]))?.ok_or("Catalog fingerprint is missing.")?;
        let status = string(fingerprint, "status")?;
        if status == "valid" {
            if fingerprint["sha256"].is_null() || fingerprint["observedAt"].is_null() {
                return Err("Valid fingerprint needs observation proof.".into());
            }
            let asset = self.asset_row(id, asset_id)?;
            for (left, right) in [
                ("observedAt", "observedAt"),
                ("observedByteLength", "observedByteLength"),
                ("observedModifiedAt", "observedModifiedAt"),
                ("localFileId", "localFileId"),
            ] {
                if !same(&asset[left], &fingerprint[right]) {
                    return Err("Fingerprint proof does not match asset observation.".into());
                }
            }
        } else if !fingerprint["sha256"].is_null() {
            return Err("Non-valid fingerprint cannot have a digest.".into());
        }
        if [
            "status",
            "sha256",
            "observedAt",
            "observedByteLength",
            "observedModifiedAt",
            "localFileId",
        ]
        .iter()
        .all(|k| same(&old[*k], &fingerprint[*k]))
        {
            return Ok(false);
        }
        execute(
            db,
            "UPDATE fingerprints SET status=?,sha256=?,observed_at=?,observed_byte_length=?,observed_modified_at=?,local_file_id=?,updated_at=? WHERE catalog_id=? AND asset_id=?",
            values(&[
                &fingerprint["status"],
                &fingerprint["sha256"],
                &fingerprint["observedAt"],
                &fingerprint["observedByteLength"],
                &fingerprint["observedModifiedAt"],
                &fingerprint["localFileId"],
                &json!(timestamp),
                &json!(id),
                &json!(asset_id),
            ]),
        )?;
        Ok(true)
    }

    fn asset_relocate(&self, id: &str, mutation: &Value, timestamp: i64) -> Result<bool, String> {
        let db = self.db()?;
        let asset_id = string(mutation, "assetId")?;
        let asset = self.asset_row(id, asset_id)?;
        let root_id = string(mutation, "rootId")?;
        let path = string(mutation, "relativePath")?;
        if one(
            db,
            "SELECT 1 FROM roots WHERE catalog_id=? AND root_id=?",
            values(&[&json!(id), &json!(root_id)]),
        )?
        .is_none()
        {
            return Err("Catalog destination root is missing.".into());
        }
        if let Some(conflict) = one(
            db,
            "SELECT asset_id AS assetId FROM assets WHERE catalog_id=? AND root_id=? AND relative_path=?",
            values(&[&json!(id), &json!(root_id), &json!(path)]),
        )? {
            if conflict["assetId"] != asset_id {
                return Err("Catalog destination path is occupied.".into());
            }
        }
        let observation = field(mutation, "observation")?;
        let [bytes, modified, observed, file_id] = observation_params(observation);
        if asset["rootId"] == root_id
            && asset["relativePath"] == path
            && same(&asset["observedByteLength"], &bytes)
            && same(&asset["observedModifiedAt"], &modified)
            && same(&asset["observedAt"], &observed)
            && asset["localFileId"] == file_id
            && asset["health"] == mutation["health"]
        {
            return Ok(false);
        }
        execute(
            db,
            "UPDATE assets SET root_id=?,relative_path=?,observed_byte_length=?,observed_modified_at=?,observed_at=?,local_file_id=?,health=?,revision=revision+1 WHERE catalog_id=? AND asset_id=?",
            values(&[
                &json!(root_id),
                &json!(path),
                &bytes,
                &modified,
                &observed,
                &file_id,
                &mutation["health"],
                &json!(id),
                &json!(asset_id),
            ]),
        )?;
        if !same(&asset["observedByteLength"], &bytes)
            || !same(&asset["observedModifiedAt"], &modified)
            || asset["localFileId"] != file_id
        {
            execute(
                db,
                "UPDATE fingerprints SET status='stale',sha256=NULL,updated_at=? WHERE catalog_id=? AND asset_id=?",
                values(&[&json!(timestamp), &json!(id), &json!(asset_id)]),
            )?;
        }
        Ok(true)
    }

    fn asset_copy(&self, id: &str, mutation: &Value, timestamp: i64) -> Result<bool, String> {
        let db = self.db()?;
        let source = string(mutation, "sourceAssetId")?;
        let target = string(mutation, "newAssetId")?;
        if source == target {
            return Err("Asset copy needs a new ID.".into());
        }
        let original = self.asset_row(id, source)?;
        if one(
            db,
            "SELECT 1 FROM assets WHERE catalog_id=? AND asset_id=?",
            values(&[&json!(id), &json!(target)]),
        )?
        .is_some()
        {
            return Err("Copied asset ID already exists.".into());
        }
        let mut entry = mutation.clone();
        for key in ["formatId", "cameraMake", "cameraModel", "lensModel"] {
            entry[key] = original[key].clone();
        }
        self.insert_asset(
            id,
            target,
            string(mutation, "rootId")?,
            string(mutation, "relativePath")?,
            &entry,
            timestamp,
        )?;
        let metadata=one(db,"SELECT archive,pick,rating,color_label AS colorLabel,develop_json AS developJson,develop_updated_at AS developUpdatedAt,updated_at AS updatedAt,title,caption,copyright,keywords_json AS keywordsJson,raw_xmp AS rawXmp,xmp_state AS xmpState,xmp_mtime AS xmpMtime,xmp_sha256 AS xmpSha256 FROM asset_metadata WHERE catalog_id=? AND asset_id=?",values(&[&json!(id),&json!(source)]))?.ok_or("Source metadata is missing.")?;
        execute(
            db,
            "UPDATE asset_metadata SET archive=?,pick=?,rating=?,color_label=?,develop_json=?,develop_updated_at=?,updated_at=?,title=?,caption=?,copyright=?,keywords_json=?,raw_xmp=?,xmp_state=?,xmp_mtime=?,xmp_sha256=? WHERE catalog_id=? AND asset_id=?",
            values(&[
                &metadata["archive"],
                &metadata["pick"],
                &metadata["rating"],
                &metadata["colorLabel"],
                &metadata["developJson"],
                &metadata["developUpdatedAt"],
                &metadata["updatedAt"],
                &metadata["title"],
                &metadata["caption"],
                &metadata["copyright"],
                &metadata["keywordsJson"],
                &metadata["rawXmp"],
                &metadata["xmpState"],
                &metadata["xmpMtime"],
                &metadata["xmpSha256"],
                &json!(id),
                &json!(target),
            ]),
        )?;
        Ok(true)
    }
}

impl CatalogService {
    fn album_membership(&self, id: &str, mutation: &Value) -> Result<bool, String> {
        let db = self.db()?;
        let album = string(mutation, "albumId")?;
        if one(
            db,
            "SELECT 1 FROM albums WHERE catalog_id=? AND album_id=?",
            vec![SqlValue::Text(id.into()), SqlValue::Text(album.into())],
        )?
        .is_none()
        {
            return Err("Catalog album is missing.".into());
        }
        let ids = mutation
            .get("entryIds")
            .or_else(|| mutation.get("assetIds"))
            .and_then(Value::as_array)
            .ok_or("Catalog album members are invalid.")?;
        let current = rows(
            db,
            "SELECT entry_id AS entryId FROM album_entries WHERE catalog_id=? AND album_id=? ORDER BY position",
            vec![SqlValue::Text(id.into()), SqlValue::Text(album.into())],
        )?;
        if current.len() == ids.len() && current.iter().zip(ids).all(|(a, b)| a["entryId"] == *b) {
            return Ok(false);
        }
        let mut seen = std::collections::HashSet::new();
        for member in ids {
            let entry = member.as_str().ok_or("Catalog album member is invalid.")?;
            if !seen.insert(entry) {
                return Err("Catalog album membership contains duplicates.".into());
            }
            if one(
                db,
                "SELECT 1 FROM edit_entries WHERE catalog_id=? AND entry_id=?",
                vec![SqlValue::Text(id.into()), SqlValue::Text(entry.into())],
            )?
            .is_none()
            {
                return Err("Catalog album entry is missing.".into());
            }
        }
        execute(
            db,
            "DELETE FROM album_entries WHERE catalog_id=? AND album_id=?",
            vec![SqlValue::Text(id.into()), SqlValue::Text(album.into())],
        )?;
        execute(
            db,
            "DELETE FROM album_assets WHERE catalog_id=? AND album_id=?",
            vec![SqlValue::Text(id.into()), SqlValue::Text(album.into())],
        )?;
        for (position, member) in ids.iter().enumerate() {
            execute(
                db,
                "INSERT INTO album_entries (catalog_id,album_id,entry_id,position) VALUES (?,?,?,?)",
                values(&[&json!(id), &json!(album), member, &json!(position)]),
            )?;
            execute(
                db,
                "INSERT INTO album_assets (catalog_id,album_id,asset_id,position) SELECT catalog_id,?,source_id,? FROM edit_entries WHERE catalog_id=? AND entry_id=? AND is_original=1",
                values(&[&json!(album), &json!(position), &json!(id), member]),
            )?;
        }
        Ok(true)
    }

    fn preset_upsert(&self, id: &str, mutation: &Value) -> Result<bool, String> {
        let db = self.db()?;
        let preset_id = string(mutation, "presetId")?;
        let payload = field(mutation, "payload")?;
        let payload_json = payload.to_string();
        let old = one(
            db,
            "SELECT name,payload_json AS payloadJson FROM import_presets WHERE catalog_id=? AND preset_id=?",
            values(&[&json!(id), &json!(preset_id)]),
        )?;
        let mut changed = false;
        if let Some(old) = old {
            if old["name"] != mutation["name"] || old["payloadJson"] != payload_json {
                execute(
                    db,
                    "UPDATE import_presets SET name=?,payload_json=?,revision=revision+1,updated_at=? WHERE catalog_id=? AND preset_id=?",
                    values(&[
                        &mutation["name"],
                        &json!(payload_json),
                        &mutation["updatedAt"],
                        &json!(id),
                        &json!(preset_id),
                    ]),
                )?;
                changed = true;
            }
        } else {
            execute(
                db,
                "INSERT INTO import_presets (catalog_id,preset_id,name,payload_json,revision,created_at,updated_at) VALUES (?,?,?,?,1,?,?)",
                values(&[
                    &json!(id),
                    &json!(preset_id),
                    &mutation["name"],
                    &json!(payload_json),
                    &mutation["createdAt"],
                    &mutation["updatedAt"],
                ]),
            )?;
            changed = true;
        }
        if payload["isDefault"] == true {
            changed = self.preset_default(
                id,
                preset_id,
                mutation
                    .get("updatedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(now),
            )? || changed;
        }
        Ok(changed)
    }

    fn preset_default(&self, id: &str, preset_id: &str, timestamp: i64) -> Result<bool, String> {
        let db = self.db()?;
        let all = rows(
            db,
            "SELECT preset_id AS presetId,payload_json AS payloadJson FROM import_presets WHERE catalog_id=?",
            vec![SqlValue::Text(id.into())],
        )?;
        if !all.iter().any(|v| v["presetId"] == preset_id) {
            return Err("Catalog preset is missing.".into());
        }
        let mut changed = false;
        for preset in all {
            let mut payload = required_json(&preset["payloadJson"])?;
            let expected = preset["presetId"] == preset_id;
            if payload["isDefault"] == expected {
                continue;
            }
            payload["isDefault"] = json!(expected);
            execute(
                db,
                "UPDATE import_presets SET payload_json=?,revision=revision+1,updated_at=? WHERE catalog_id=? AND preset_id=?",
                values(&[
                    &json!(payload.to_string()),
                    &json!(timestamp),
                    &json!(id),
                    &preset["presetId"],
                ]),
            )?;
            changed = true;
        }
        Ok(changed)
    }

    fn rule_upsert(&self, id: &str, mutation: &Value) -> Result<bool, String> {
        let db = self.db()?;
        let rule_id = string(mutation, "ruleId")?;
        let config = field(mutation, "config")?;
        for root in [&mutation["destinationRootId"], &config["ingressRootId"]] {
            if one(
                db,
                "SELECT 1 FROM roots WHERE catalog_id=? AND root_id=?",
                values(&[&json!(id), root]),
            )?
            .is_none()
            {
                return Err("Catalog rule root is missing.".into());
            }
        }
        if one(
            db,
            "SELECT 1 FROM import_presets WHERE catalog_id=? AND preset_id=?",
            values(&[&json!(id), &mutation["presetId"]]),
        )?
        .is_none()
        {
            return Err("Catalog rule preset is missing.".into());
        }
        let serialized = config.to_string();
        let old = one(
            db,
            "SELECT name,enabled,destination_root_id AS destinationRootId,preset_id AS presetId,config_json AS configJson FROM auto_import_rules WHERE catalog_id=? AND rule_id=?",
            values(&[&json!(id), &json!(rule_id)]),
        )?;
        let unchanged = old.as_ref().is_some_and(|v| {
            v["name"] == mutation["name"]
                && (v["enabled"] == 1) == (mutation["enabled"] == true)
                && v["destinationRootId"] == mutation["destinationRootId"]
                && v["presetId"] == mutation["presetId"]
                && v["configJson"] == serialized
        });
        if unchanged {
            return Ok(false);
        }
        if old.is_some() {
            execute(
                db,
                "UPDATE auto_import_rules SET name=?,enabled=?,destination_root_id=?,preset_id=?,config_json=?,revision=revision+1,updated_at=? WHERE catalog_id=? AND rule_id=?",
                values(&[
                    &mutation["name"],
                    &mutation["enabled"],
                    &mutation["destinationRootId"],
                    &mutation["presetId"],
                    &json!(serialized),
                    &mutation["updatedAt"],
                    &json!(id),
                    &json!(rule_id),
                ]),
            )?;
        } else {
            execute(
                db,
                "INSERT INTO auto_import_rules (catalog_id,rule_id,name,enabled,destination_root_id,preset_id,config_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)",
                values(&[
                    &json!(id),
                    &json!(rule_id),
                    &mutation["name"],
                    &mutation["enabled"],
                    &mutation["destinationRootId"],
                    &mutation["presetId"],
                    &json!(serialized),
                    &mutation["createdAt"],
                    &mutation["updatedAt"],
                ]),
            )?;
        }
        Ok(true)
    }

    fn operation_upsert(&self, id: &str, operation: &Value) -> Result<bool, String> {
        let db = self.db()?;
        let operation_id = string(operation, "operationId")?;
        let payload = field(operation, "payload")?.to_string();
        let old = one(
            db,
            "SELECT kind,state,payload_json AS payloadJson,updated_at AS updatedAt FROM operations WHERE catalog_id=? AND operation_id=?",
            values(&[&json!(id), &json!(operation_id)]),
        )?;
        if let Some(old) = old {
            let old_payload = required_json(&old["payloadJson"])?;
            if old["kind"] != operation["kind"]
                || old_payload["kind"] != operation["payload"]["kind"]
                || old_payload["planHash"] != operation["payload"]["planHash"]
                || history::canonical_json(&old_payload["plan"])
                    != history::canonical_json(&operation["payload"]["plan"])
            {
                return Err("Catalog operation plan is immutable.".into());
            }
            let old_rank = operation_rank(&old["state"])?;
            let new_rank = operation_rank(&operation["state"])?;
            if new_rank < old_rank || (old_rank == 2 && old["state"] != operation["state"]) {
                return Err("Catalog operation state is not monotonic.".into());
            }
            if old["state"] == operation["state"]
                && old["payloadJson"] == payload
                && old["updatedAt"] == operation["updatedAt"]
            {
                return Ok(false);
            }
            execute(
                db,
                "UPDATE operations SET state=?,payload_json=?,revision=revision+1,updated_at=? WHERE catalog_id=? AND operation_id=?",
                values(&[
                    &operation["state"],
                    &json!(payload),
                    &operation["updatedAt"],
                    &json!(id),
                    &json!(operation_id),
                ]),
            )?;
        } else {
            execute(
                db,
                "INSERT INTO operations (catalog_id,operation_id,kind,state,payload_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)",
                values(&[
                    &json!(id),
                    &json!(operation_id),
                    &operation["kind"],
                    &operation["state"],
                    &json!(payload),
                    &operation["createdAt"],
                    &operation["updatedAt"],
                ]),
            )?;
        }
        Ok(true)
    }

    fn operation_item_upsert(&self, id: &str, item: &Value) -> Result<bool, String> {
        let db = self.db()?;
        let operation_id = string(item, "operationId")?;
        let item_id = string(item, "itemId")?;
        let operation=one(db,"SELECT payload_json AS payloadJson FROM operations WHERE catalog_id=? AND operation_id=?",values(&[&json!(id),&json!(operation_id)]))?.ok_or("Catalog operation is missing.")?;
        required_json(&operation["payloadJson"])?;
        if !item["assetId"].is_null() {
            self.asset_row(id, string(item, "assetId")?)?;
        }
        for root in [
            &item["payload"]["sourceRootId"],
            &item["payload"]["destinationRootId"],
        ] {
            if !root.is_null()
                && one(
                    db,
                    "SELECT 1 FROM roots WHERE catalog_id=? AND root_id=?",
                    values(&[&json!(id), root]),
                )?
                .is_none()
            {
                return Err("Catalog operation item root is missing.".into());
            }
        }
        let payload = field(item, "payload")?.to_string();
        let old = one(
            db,
            "SELECT asset_id AS assetId,state,payload_json AS payloadJson FROM operation_items WHERE catalog_id=? AND operation_id=? AND item_id=?",
            values(&[&json!(id), &json!(operation_id), &json!(item_id)]),
        )?;
        if let Some(old) = old {
            let old_payload = required_json(&old["payloadJson"])?;
            let old_stage = stage_rank(&old_payload["stage"])?;
            let next_stage = stage_rank(&item["payload"]["stage"])?;
            if next_stage < old_stage {
                return Err("Catalog operation item stage is not monotonic.".into());
            }
            for key in [
                "action",
                "sourceRootId",
                "sourceRelativePath",
                "destinationRootId",
                "destinationRelativePath",
            ] {
                if old_payload[key] != item["payload"][key] {
                    return Err("Catalog operation item plan is immutable.".into());
                }
            }
            if old_payload["xmpStatus"] != item["payload"]["xmpStatus"]
                && (!old_payload["xmpStatus"].is_null()
                    || item["payload"]["xmpStatus"].is_null()
                    || next_stage <= old_stage)
            {
                return Err(
                    "Catalog operation item XMP result is not a safe stage transition.".into(),
                );
            }
            let old_rank = operation_rank(&old["state"])?;
            let next_rank = operation_rank(&item["state"])?;
            if next_rank < old_rank || (old_rank == 2 && old["state"] != item["state"]) {
                return Err("Catalog operation item state is not monotonic.".into());
            }
            let old_status = if old_payload["status"].is_null() {
                &old["state"]
            } else {
                &old_payload["status"]
            };
            let next_status = if item["payload"]["status"].is_null() {
                &item["state"]
            } else {
                &item["payload"]["status"]
            };
            let old_status_rank = status_rank(old_status)?;
            let next_status_rank = status_rank(next_status)?;
            if next_status_rank < old_status_rank
                || (old_status_rank == 2 && old_status != next_status)
            {
                return Err("Catalog operation item status is not monotonic.".into());
            }
            if old["assetId"].is_null() && !item["assetId"].is_null() {
                if next_stage < 3 {
                    return Err("Catalog operation item asset can only be assigned at catalog-applied stage.".into());
                }
            } else if old["assetId"] != item["assetId"] {
                return Err("Catalog operation item asset is immutable.".into());
            }
            if old["assetId"] == item["assetId"]
                && old["state"] == item["state"]
                && old["payloadJson"] == payload
            {
                return Ok(false);
            }
            execute(
                db,
                "UPDATE operation_items SET asset_id=?,state=?,payload_json=? WHERE catalog_id=? AND operation_id=? AND item_id=?",
                values(&[
                    &item["assetId"],
                    &item["state"],
                    &json!(payload),
                    &json!(id),
                    &json!(operation_id),
                    &json!(item_id),
                ]),
            )?;
        } else {
            execute(
                db,
                "INSERT INTO operation_items (catalog_id,operation_id,item_id,asset_id,state,payload_json) VALUES (?,?,?,?,?,?)",
                values(&[
                    &json!(id),
                    &json!(operation_id),
                    &json!(item_id),
                    &item["assetId"],
                    &item["state"],
                    &json!(payload),
                ]),
            )?;
        }
        Ok(true)
    }
}
