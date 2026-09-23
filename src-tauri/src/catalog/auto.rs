use super::*;
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

#[derive(Clone)]
struct State {
    rule: Option<Value>,
    items: Vec<Value>,
    paused: bool,
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn valid_uuid(value: &Value) -> bool {
    value.as_str().is_some_and(|raw| {
        Uuid::parse_str(raw).is_ok_and(|parsed| {
            parsed.to_string() == raw
                && (1..=8).contains(&parsed.get_version_num())
                && parsed.get_variant() == uuid::Variant::RFC4122
        })
    })
}

fn validate_state(catalog_id: &str, state: &State) -> Result<(), String> {
    if let Some(rule) = &state.rule {
        if !exact_keys(
            rule,
            &[
                "catalogId",
                "ruleId",
                "ingressRootId",
                "ingressRelativePath",
                "destinationRootId",
                "destinationRelativePath",
                "placement",
                "presetId",
                "presetVersion",
                "presetSha256",
                "duplicatePolicy",
                "destinationConflictPolicy",
                "enabled",
                "stabilityMs",
                "maxAttempts",
                "retryBackoffMs",
            ],
        ) || rule["catalogId"] != catalog_id
            || !["ruleId", "ingressRootId", "destinationRootId", "presetId"]
                .iter()
                .all(|key| valid_uuid(&rule[*key]))
            || rule["placement"] != "copy"
            || !rule["enabled"].is_boolean()
            || relative(rule, "ingressRelativePath").is_err()
            || relative(rule, "destinationRelativePath").is_err()
            || !rule["presetSha256"].as_str().is_some_and(|sha| {
                sha.len() == 64
                    && sha
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || ![
                "skip-incoming",
                "continue-unchecked",
                "keep-both",
                "use-existing-location",
            ]
            .contains(&rule["duplicatePolicy"].as_str().unwrap_or(""))
            || !["skip", "replace", "rename"]
                .contains(&rule["destinationConflictPolicy"].as_str().unwrap_or(""))
            || !rule["presetVersion"].as_i64().is_some_and(|n| n >= 0)
            || !rule["stabilityMs"].as_i64().is_some_and(|n| n >= 0)
            || !rule["maxAttempts"].as_i64().is_some_and(|n| n >= 1)
            || !rule["retryBackoffMs"].as_i64().is_some_and(|n| n >= 0)
        {
            return Err("Auto Import sidecar rule is invalid.".into());
        }
    }
    let mut queue_ids = std::collections::HashSet::new();
    let mut dedupe_keys = std::collections::HashSet::new();
    for item in &state.items {
        let has_recovery = item.get("recoveryRequired").is_some();
        let keys = &[
            "queueId",
            "catalogId",
            "ruleId",
            "relativePath",
            "placement",
            "observation",
            "dedupeKey",
            "state",
            "attempts",
            "maxAttempts",
            "retryBackoffMs",
            "nextAttemptAt",
            "leaseUntil",
            "error",
            "createdAt",
            "updatedAt",
        ];
        let mut expected = keys.to_vec();
        if has_recovery {
            expected.push("recoveryRequired")
        }
        if !exact_keys(item, &expected)
            || !valid_uuid(&item["queueId"])
            || item["catalogId"] != catalog_id
            || state
                .rule
                .as_ref()
                .is_none_or(|rule| item["ruleId"] != rule["ruleId"])
            || item["placement"] != "copy"
            || !["queued", "claimed", "completed", "failed", "cancelled"]
                .contains(&item["state"].as_str().unwrap_or(""))
        {
            return Err("Auto Import sidecar queue item is invalid.".into());
        }
        let path = relative(item, "relativePath")?;
        let obs = &item["observation"];
        if !exact_keys(obs, &["size", "modifiedAt", "localFileId", "observedAt"])
            || obs["size"].as_u64().is_none()
            || obs["modifiedAt"].as_f64().is_none()
            || obs["observedAt"].as_f64().is_none()
            || (!obs["localFileId"].is_null() && !obs["localFileId"].is_string())
        {
            return Err("Auto Import sidecar observation is invalid.".into());
        }
        let dedupe = format!(
            "{}\0{}\0{}\0{}",
            path,
            obs["size"],
            history::js_stringify(&obs["modifiedAt"]),
            obs["localFileId"].as_str().unwrap_or("")
        );
        if item["dedupeKey"] != dedupe
            || !queue_ids.insert(item["queueId"].as_str().unwrap_or(""))
            || !dedupe_keys.insert(dedupe)
        {
            return Err("Auto Import sidecar queue identity is invalid.".into());
        }
        let attempts = number(item, "attempts")?;
        let max = number(item, "maxAttempts")?;
        let backoff = number(item, "retryBackoffMs")?;
        if attempts < 0
            || max < 1
            || attempts > max
            || backoff < 0
            || !item["nextAttemptAt"].is_number()
            || !item["createdAt"].is_number()
            || !item["updatedAt"].is_number()
            || !item.get("recoveryRequired").is_none_or(Value::is_boolean)
            || (!item["error"].is_null() && !item["error"].is_string())
        {
            return Err("Auto Import sidecar queue timing is invalid.".into());
        }
        let lease = item["leaseUntil"].as_i64();
        if (item["state"] == "claimed") != lease.is_some()
            || lease.is_some_and(|lease| lease < item["updatedAt"].as_i64().unwrap_or(i64::MAX))
        {
            return Err("Auto Import sidecar queue lease is invalid.".into());
        }
    }
    Ok(())
}

fn path(user_data: &Path, catalog_id: &str) -> PathBuf {
    user_data
        .join("catalog-auto-import-state")
        .join(catalog_id)
        .join("auto-import.json")
}

fn no_symlink_components(target: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("Auto Import state path must be absolute.".into());
    }
    let mut current = PathBuf::new();
    for component in target.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Auto Import persistence refuses symlink traversal.".into());
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn load(user_data: &Path, catalog_id: &str) -> Result<State, String> {
    let target = path(user_data, catalog_id);
    no_symlink_components(&target)?;
    let before = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(State {
                rule: None,
                items: Vec::new(),
                paused: false,
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    if !before.is_file() || before.file_type().is_symlink() {
        return Err("Auto Import state file is not a regular file.".into());
    }
    if before.len() > 4 * 1024 * 1024 {
        return Err("Auto Import state file is too large.".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&target).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err("Auto Import state file changed while opening.".into());
        }
    }
    let mut raw = Vec::new();
    use std::io::Read;
    file.take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    let after = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if after.len() != before.len() || after.modified().ok() != before.modified().ok() {
        return Err("Auto Import state file changed while reading.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err("Auto Import state file changed while reading.".into());
        }
    }
    if raw.len() > 4 * 1024 * 1024 {
        return Err("Auto Import state file is too large.".into());
    }
    let envelope: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if !exact_keys(&envelope, &["version", "kind", "rules", "items", "paused"])
        || envelope["version"] != 1
        || envelope["kind"] != "darkroom-auto-import-state"
        || !envelope["rules"].is_array()
        || !envelope["items"].is_array()
        || !envelope["paused"].is_boolean()
    {
        return Err("Auto Import state envelope is invalid.".into());
    }
    let rules = envelope["rules"]
        .as_array()
        .ok_or("Auto Import rules are invalid.")?;
    if rules.len() > 1 {
        return Err("Auto Import sidecar has multiple rules.".into());
    }
    let rule = rules.first().cloned();
    if rule.as_ref().is_some_and(|v| v["catalogId"] != catalog_id) {
        return Err("Auto Import sidecar belongs to another catalog.".into());
    }
    let state = State {
        rule,
        items: envelope["items"].as_array().cloned().unwrap_or_default(),
        paused: envelope["paused"] == true,
    };
    validate_state(catalog_id, &state)?;
    Ok(state)
}

fn save(user_data: &Path, catalog_id: &str, state: &State) -> Result<(), String> {
    validate_state(catalog_id, state)?;
    let target = path(user_data, catalog_id);
    let parent = target
        .parent()
        .ok_or("Auto Import state path is invalid.")?;
    no_symlink_components(parent)?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    no_symlink_components(&target)?;
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Auto Import state target is not a regular file.".into());
        }
    }
    let envelope = json!({"version":1,"kind":"darkroom-auto-import-state","rules":state.rule.as_ref().map(|v|vec![v]).unwrap_or_default(),"items":state.items,"paused":state.paused});
    let bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Auto Import state file is too large.".into());
    }
    let temporary = parent.join(format!(".auto-import.json.{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            fs::File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn relative(value: &Value, key: &str) -> Result<String, String> {
    let raw = string(value, key)?.to_string();
    if raw.contains('\\') {
        return Err("Auto Import path must be relative.".into());
    }
    if raw.starts_with('/')
        || raw
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Auto Import path must be relative.".into());
    }
    Ok(raw)
}

fn live_rule(db: &Connection, catalog_id: &str) -> Result<(Option<Value>, bool), String> {
    let selected = rows(
        db,
        "SELECT rule_id AS ruleId,enabled,destination_root_id AS destinationRootId,preset_id AS presetId,config_json AS configJson FROM auto_import_rules WHERE catalog_id=? ORDER BY enabled DESC,updated_at DESC,rule_id DESC",
        vec![SqlValue::Text(catalog_id.into())],
    )?;
    if selected.iter().filter(|v| v["enabled"] == 1).count() > 1 {
        return Err("Auto Import has multiple enabled rules.".into());
    }
    let Some(row) = selected.first() else {
        return Ok((None, false));
    };
    let config: Value = serde_json::from_str(
        row["configJson"]
            .as_str()
            .ok_or("Auto Import live config is invalid.")?,
    )
    .map_err(|e| e.to_string())?;
    if config["version"] != 2 {
        return Ok((None, true));
    }
    Ok((
        Some(
            json!({"catalogId":catalog_id,"ruleId":row["ruleId"],"ingressRootId":config["ingressRootId"],"ingressRelativePath":config["ingressRelativePath"],"destinationRootId":row["destinationRootId"],"destinationRelativePath":config["destinationRelativePath"],"placement":"copy","presetId":row["presetId"],"presetVersion":config["presetVersion"],"presetSha256":config["presetSha256"],"duplicatePolicy":config["duplicatePolicy"],"destinationConflictPolicy":config["destinationConflictPolicy"],"enabled":row["enabled"]==1,"stabilityMs":config["stabilityMs"],"maxAttempts":config["maxAttempts"],"retryBackoffMs":config["retryBackoffMs"]}),
        ),
        false,
    ))
}

fn sync(user_data: &Path, db: &Connection, catalog_id: &str) -> Result<(State, bool), String> {
    let (rule, legacy) = live_rule(db, catalog_id)?;
    let mut state = load(user_data, catalog_id)?;
    if state.rule != rule {
        if rule.is_none() {
            state = State {
                rule: None,
                items: Vec::new(),
                paused: false,
            };
        } else if state
            .rule
            .as_ref()
            .is_some_and(|v| v["ruleId"] == rule.as_ref().unwrap()["ruleId"])
        {
            for item in &mut state.items {
                if item["state"] == "queued" || item["state"] == "claimed" {
                    item["state"] = json!("cancelled");
                    item["leaseUntil"] = Value::Null;
                    item["updatedAt"] = json!(now());
                }
            }
            state.rule = rule;
        } else {
            state.rule = rule;
            state.items.clear();
        }
        save(user_data, catalog_id, &state)?;
    }
    Ok((state, legacy))
}

fn status(catalog_id: &str, state: &State) -> Value {
    let mut counts = json!({"total":state.items.len(),"queued":0,"claimed":0,"completed":0,"failed":0,"cancelled":0});
    let items=state.items.iter().map(|item|{
        let key=item["state"].as_str().unwrap_or("");
        if let Some(value)=counts.get(key).and_then(Value::as_u64){counts[key]=json!(value+1)}
        json!({"queueId":item["queueId"],"ruleId":item["ruleId"],"relativePath":item["relativePath"],"state":item["state"],"attempts":item["attempts"],"maxAttempts":item["maxAttempts"],"nextAttemptAt":item["nextAttemptAt"],"leaseUntil":item["leaseUntil"],"createdAt":item["createdAt"],"updatedAt":item["updatedAt"],"error":if item["error"].is_null(){Value::Null}else{json!({"code":"execution-failed","message":"Auto Import execution failed."})}})
    }).collect::<Vec<_>>();
    let public_rule=state.rule.as_ref().map(|rule|json!({"ruleId":rule["ruleId"],"enabled":rule["enabled"],"ingressRootId":rule["ingressRootId"],"ingressRelativePath":rule["ingressRelativePath"],"destinationRootId":rule["destinationRootId"],"destinationRelativePath":rule["destinationRelativePath"],"presetId":rule["presetId"],"presetVersion":rule["presetVersion"],"presetSha256":rule["presetSha256"],"duplicatePolicy":rule["duplicatePolicy"],"destinationConflictPolicy":rule["destinationConflictPolicy"],"stabilityMs":rule["stabilityMs"],"maxAttempts":rule["maxAttempts"],"retryBackoffMs":rule["retryBackoffMs"]}));
    let state_name = if state.rule.is_none() {
        "unconfigured"
    } else if state.rule.as_ref().is_some_and(|v| v["enabled"] == false) {
        "disabled"
    } else if state.paused {
        "paused"
    } else {
        "ready"
    };
    json!({"catalogId":catalog_id,"state":state_name,"paused":state.paused,"degraded":false,"rule":public_rule,"counts":counts,"items":items})
}

fn cancel_queue_item(item: &mut Value) {
    item["state"] = json!("cancelled");
    item["leaseUntil"] = Value::Null;
    item["updatedAt"] = json!(now());
}

impl CatalogService {
    fn auto_configure(&mut self, input: &Value) -> Result<Value, String> {
        let guard = self.auto_guard.clone();
        let _guard = guard.lock().map_err(|e| e.to_string())?;
        let catalog_id = string(input, "catalogId")?.to_string();
        if input.get("action").is_some_and(|v| v != "copy") {
            return Err("Move is unavailable for Auto Import.".into());
        }
        let ingress_id = string(input, "ingressRootId")?;
        let destination_id = string(input, "destinationRootId")?;
        let preset_id = string(input, "presetId")?;
        let ingress = relative(input, "ingressRelativePath")?;
        let destination = relative(input, "destinationRelativePath")?;
        let duplicate = string(input, "duplicatePolicy")?;
        if !["skip-incoming", "continue-unchecked", "keep-both"].contains(&duplicate) {
            return Err("Auto Import duplicate policy is invalid.".into());
        }
        let conflict = string(input, "destinationConflictPolicy")?;
        if !["skip", "rename"].contains(&conflict) {
            return Err("Auto Import destination conflict policy is invalid.".into());
        }
        for key in ["stabilityMs", "retryBackoffMs"] {
            if number(input, key)? < 0 || number(input, key)? > 24 * 60 * 60 * 1000 {
                return Err(format!("Auto Import {key} is invalid."));
            }
        }
        if !(1..=100).contains(&number(input, "maxAttempts")?) {
            return Err("Auto Import attempt limit is invalid.".into());
        }
        let enabled = input["enabled"]
            .as_bool()
            .ok_or("Auto Import enabled is invalid.")?;
        let roots = rows(
            self.db()?,
            "SELECT root_id AS rootId,canonical_path AS canonicalPath,health FROM roots WHERE catalog_id=? AND root_id IN (?,?)",
            values(&[
                &json!(catalog_id),
                &json!(ingress_id),
                &json!(destination_id),
            ]),
        )?;
        let ingress_root = roots
            .iter()
            .find(|v| v["rootId"] == ingress_id)
            .ok_or("Auto Import ingress root is unavailable.")?;
        let destination_root = roots
            .iter()
            .find(|v| v["rootId"] == destination_id)
            .ok_or("Auto Import destination root is unavailable.")?;
        if ingress_root["health"] != "online" || destination_root["health"] != "online" {
            return Err("Auto Import root is unavailable.".into());
        }
        let source = Path::new(string(ingress_root, "canonicalPath")?).join(&ingress);
        let target = Path::new(string(destination_root, "canonicalPath")?).join(&destination);
        if source.starts_with(&target) || target.starts_with(&source) {
            return Err("Auto Import ingress and destination may not overlap.".into());
        }
        let preset=one(self.db()?,"SELECT name,payload_json AS payloadJson,revision,updated_at AS updatedAt FROM import_presets WHERE catalog_id=? AND preset_id=?",values(&[&json!(catalog_id),&json!(preset_id)]))?.ok_or("Auto Import preset is unavailable.")?;
        let payload: Value =
            serde_json::from_str(string(&preset, "payloadJson")?).map_err(|e| e.to_string())?;
        let template = payload["template"].clone();
        let inner = payload["payload"].clone();
        let frozen = json!({"catalogId":catalog_id,"presetId":preset_id,"name":preset["name"],"version":preset["revision"],"template":{"pattern":template["pattern"]},"payload":inner,"updatedAt":preset["updatedAt"]});
        let hash = format!(
            "{:x}",
            Sha256::digest(history::canonical_json(&frozen).as_bytes())
        );
        let (existing, _) = live_rule(self.db()?, &catalog_id)?;
        let rule_id = existing
            .as_ref()
            .and_then(|v| v["ruleId"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let rule = json!({"catalogId":catalog_id,"ruleId":rule_id,"ingressRootId":ingress_id,"ingressRelativePath":ingress,"destinationRootId":destination_id,"destinationRelativePath":destination,"placement":"copy","presetId":preset_id,"presetVersion":preset["revision"],"presetSha256":hash,"duplicatePolicy":duplicate,"destinationConflictPolicy":conflict,"enabled":enabled,"stabilityMs":input["stabilityMs"],"maxAttempts":input["maxAttempts"],"retryBackoffMs":input["retryBackoffMs"]});
        let config = json!({"version":2,"action":"copy","ingressRootId":ingress_id,"ingressRelativePath":ingress,"destinationRelativePath":destination,"presetVersion":preset["revision"],"presetSha256":hash,"duplicatePolicy":duplicate,"destinationConflictPolicy":conflict,"stabilityMs":input["stabilityMs"],"maxAttempts":input["maxAttempts"],"retryBackoffMs":input["retryBackoffMs"]});
        let prior = one(
            self.db()?,
            "SELECT name,created_at AS createdAt FROM auto_import_rules WHERE catalog_id=? AND rule_id=?",
            values(&[&json!(catalog_id), &json!(rule_id)]),
        )?;
        let mutation = json!({"kind":"rule-upsert","ruleId":rule_id,"name":prior.as_ref().map_or(json!("Auto Import"),|v|v["name"].clone()),"enabled":enabled,"destinationRootId":destination_id,"presetId":preset_id,"config":config,"createdAt":prior.as_ref().map_or(json!(now()),|v|v["createdAt"].clone()),"updatedAt":now()});
        let mut applied = false;
        for _ in 0..4 {
            let revision = self.revision(&catalog_id)?;
            match self.apply(
                &json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":[mutation]}),
            ) {
                Ok(_) => {
                    applied = true;
                    break;
                }
                Err(error) if error.contains("revision") && error.contains("stale") => continue,
                Err(error) => return Err(error),
            }
        }
        if !applied {
            return Err("Auto Import catalog revision stayed stale.".into());
        }
        let mut state = load(&self.user_data, &catalog_id)?;
        if state.rule != Some(rule.clone()) {
            if state
                .rule
                .as_ref()
                .is_some_and(|old| old["ruleId"] == rule["ruleId"])
            {
                for item in &mut state.items {
                    if item["state"] == "queued" || item["state"] == "claimed" {
                        cancel_queue_item(item)
                    }
                }
            } else {
                state.items.clear()
            }
            if let Ok(cancellations) = self.auto_cancellations.lock() {
                for cancel in cancellations.values() {
                    cancel.store(true, Ordering::SeqCst)
                }
            }
        }
        state.rule = Some(rule);
        save(&self.user_data, &catalog_id, &state)?;
        Ok(status(&catalog_id, &state))
    }

    pub(super) fn auto_dispatch(&mut self, command: &str, input: &Value) -> Result<Value, String> {
        self.require_session(input)?;
        let catalog_id = string(input, "catalogId")?.to_string();
        if command == "darkroom:catalog-auto-import-configure" {
            return self.auto_configure(input);
        }
        let guard = self.auto_guard.clone();
        let _guard = guard.lock().map_err(|e| e.to_string())?;
        let (mut state, legacy) = sync(&self.user_data, self.db()?, &catalog_id)?;
        let action = command
            .strip_prefix("darkroom:catalog-auto-import-")
            .ok_or("Auto Import channel is invalid.")?;
        if action != "cancel" && action != "open-ingress" && input["action"] != action {
            return Err("Auto Import control action does not match the channel.".into());
        }
        if action == "status" {
            return Ok(status(&catalog_id, &state));
        }
        if action == "open-ingress" {
            let rule = state.rule.as_ref().ok_or(if legacy {
                "Auto Import requires reconfiguration."
            } else {
                "Auto Import rule is not configured."
            })?;
            let root=one(self.db()?,"SELECT canonical_path AS canonicalPath FROM roots WHERE catalog_id=? AND root_id=?",values(&[&json!(catalog_id),&rule["ingressRootId"]]))?.ok_or("Auto Import ingress is unavailable.")?;
            let path = Path::new(string(&root, "canonicalPath")?)
                .join(relative(rule, "ingressRelativePath")?);
            open::that(path).map_err(|_| "Auto Import ingress could not be opened.".to_string())?;
            return Ok(Value::Null);
        }
        if ["enable", "disable"].contains(&action) {
            let rule = state.rule.as_ref().ok_or(if legacy {
                "Auto Import requires reconfiguration."
            } else {
                "Auto Import rule is not configured."
            })?;
            let rule_id = string(rule, "ruleId")?;
            let original=one(self.db()?,"SELECT name,created_at AS createdAt,config_json AS configJson FROM auto_import_rules WHERE catalog_id=? AND rule_id=?",values(&[&json!(catalog_id),&json!(rule_id)]))?.ok_or("Auto Import rule is not configured.")?;
            let config: Value = serde_json::from_str(string(&original, "configJson")?)
                .map_err(|e| e.to_string())?;
            let enabled = action == "enable";
            let mutation = json!({"kind":"rule-upsert","ruleId":rule_id,"name":original["name"],"enabled":enabled,"destinationRootId":rule["destinationRootId"],"presetId":rule["presetId"],"config":config,"createdAt":original["createdAt"],"updatedAt":now()});
            let mut applied = false;
            for _ in 0..4 {
                let revision = self.revision(&catalog_id)?;
                match self.apply(&json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":[mutation]})) {
                    Ok(_)=>{applied=true;break},
                    Err(error) if error.contains("revision") && error.contains("stale")=>continue,
                    Err(error)=>return Err(error),
                }
            }
            if !applied {
                return Err("Auto Import catalog revision stayed stale.".into());
            }
            state.rule.as_mut().unwrap()["enabled"] = json!(enabled);
            if !enabled {
                for item in &mut state.items {
                    if item["state"] == "queued" || item["state"] == "claimed" {
                        cancel_queue_item(item)
                    }
                }
                if let Ok(cancellations) = self.auto_cancellations.lock() {
                    for cancel in cancellations.values() {
                        cancel.store(true, Ordering::SeqCst)
                    }
                }
            }
        } else if action == "pause" {
            state.paused = true
        } else if action == "resume" {
            state.paused = false
        } else if action == "cancel" {
            let queue_id = string(input, "queueId")?;
            let item = state
                .items
                .iter_mut()
                .find(|v| v["queueId"] == queue_id)
                .ok_or("Auto Import queue item does not exist.")?;
            if item["state"] != "queued" && item["state"] != "claimed" {
                return Err("Auto Import queue item cannot be cancelled.".into());
            }
            cancel_queue_item(item);
            if let Ok(cancellations) = self.auto_cancellations.lock() {
                if let Some(cancel) = cancellations.get(queue_id) {
                    cancel.store(true, Ordering::SeqCst)
                }
            }
        } else if action == "retry-failed" {
            for item in &mut state.items {
                if item["state"] == "failed" {
                    item["queueId"] = json!(Uuid::new_v4().to_string());
                    item["state"] = json!("queued");
                    item["attempts"] = json!(0);
                    item["nextAttemptAt"] = json!(now());
                    item["leaseUntil"] = Value::Null;
                    item["error"] = Value::Null;
                    item["recoveryRequired"] = json!(false);
                    item["createdAt"] = json!(now());
                    item["updatedAt"] = json!(now());
                }
            }
        } else if action == "clear-failed" {
            state.items.retain(|v| v["state"] != "failed")
        } else {
            return Err("Unsupported Auto Import control action.".into());
        }
        save(&self.user_data, &catalog_id, &state)?;
        Ok(status(&catalog_id, &state))
    }

    pub(super) fn stop_auto(&mut self) {
        self.auto_stop.store(true, Ordering::SeqCst);
        if let Ok(cancellations) = self.auto_cancellations.lock() {
            for cancel in cancellations.values() {
                cancel.store(true, Ordering::SeqCst)
            }
        }
        if let Some(handle) = self.auto_handle.take() {
            let _ = handle.join();
        }
        self.auto_stop = Arc::new(AtomicBool::new(false));
        self.auto_cancellations = Arc::new(Mutex::new(HashMap::new()));
    }

    pub(super) fn start_auto(&mut self) -> Result<(), String> {
        let active = self.active.as_ref().ok_or("Catalog session is inactive.")?;
        let db_path = active.database_path.clone();
        let user_data = self.user_data.clone();
        let catalog_id = active.catalog_id.clone();
        let stop = self.auto_stop.clone();
        let guard = self.auto_guard.clone();
        let cancellations = self.auto_cancellations.clone();
        self.auto_handle = Some(std::thread::spawn(move || {
            monitor_loop(
                &db_path,
                &user_data,
                &catalog_id,
                &stop,
                &guard,
                &cancellations,
            )
        }));
        Ok(())
    }
}

fn monitor_loop(
    db_path: &Path,
    user_data: &Path,
    catalog_id: &str,
    stop: &Arc<AtomicBool>,
    guard: &Arc<Mutex<()>>,
    cancellations: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
) {
    let mut pending: HashMap<String, (Value, Instant)> = HashMap::new();
    let mut last_rule = Value::Null;
    while !stop.load(Ordering::SeqCst) {
        let run = (|| -> Result<(), String> {
            let db = Connection::open(db_path).map_err(|e| e.to_string())?;
            db.pragma_update(None, "foreign_keys", "ON")
                .map_err(|e| e.to_string())?;
            db.busy_timeout(Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            let (state, _legacy) = {
                let _lock = guard.lock().map_err(|e| e.to_string())?;
                sync(user_data, &db, catalog_id)?
            };
            let rule = state.rule.as_ref();
            if rule != Some(&last_rule) {
                pending.clear();
                last_rule = rule.cloned().unwrap_or(Value::Null);
            }
            if let Some(rule) = rule.filter(|rule| rule["enabled"] == true && !state.paused) {
                observe_ingress(&db, user_data, catalog_id, rule, stop, guard, &mut pending)?;
                for _ in 0..100 {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let next = {
                        let _lock = guard.lock().map_err(|e| e.to_string())?;
                        let mut state = sync(user_data, &db, catalog_id)?.0;
                        if state.paused || state.rule.as_ref() != Some(rule) {
                            None
                        } else {
                            let claimed = claim(&mut state)?;
                            if claimed.is_some() {
                                save(user_data, catalog_id, &state)?;
                            }
                            claimed
                        }
                    };
                    let Some(item) = next else { break };
                    let queue_id = string(&item, "queueId")?.to_string();
                    let cancellation = Arc::new(AtomicBool::new(false));
                    cancellations
                        .lock()
                        .map_err(|e| e.to_string())?
                        .insert(queue_id.clone(), cancellation.clone());
                    let result = execute_auto(db_path, &item, rule, user_data, &cancellation);
                    cancellations
                        .lock()
                        .map_err(|e| e.to_string())?
                        .remove(&queue_id);
                    let _lock = guard.lock().map_err(|e| e.to_string())?;
                    let mut latest = sync(user_data, &db, catalog_id)?.0;
                    if let Some(current) = latest
                        .items
                        .iter_mut()
                        .find(|v| v["queueId"] == queue_id && v["state"] == "claimed")
                    {
                        finish(current, result.as_ref().err().map(String::as_str), rule);
                        save(user_data, catalog_id, &latest)?;
                    }
                }
            }
            Ok(())
        })();
        if run.is_err() {
            std::thread::sleep(Duration::from_secs(2));
        }
        for _ in 0..8 {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

fn observe_ingress(
    db: &Connection,
    user_data: &Path,
    catalog_id: &str,
    rule: &Value,
    stop: &AtomicBool,
    guard: &Arc<Mutex<()>>,
    pending: &mut HashMap<String, (Value, Instant)>,
) -> Result<(), String> {
    let root = one(
        db,
        "SELECT canonical_path AS canonicalPath,health FROM roots WHERE catalog_id=? AND root_id=?",
        values(&[&json!(catalog_id), &rule["ingressRootId"]]),
    )?
    .ok_or("Auto Import ingress root is unavailable.")?;
    if root["health"] != "online" {
        return Err("Auto Import ingress root is offline.".into());
    }
    let canonical_root = PathBuf::from(string(&root, "canonicalPath")?);
    if fs::canonicalize(&canonical_root).map_err(|e| e.to_string())? != canonical_root {
        return Err("Auto Import root changed.".into());
    }
    let prefix = relative(rule, "ingressRelativePath")?;
    let ingress = canonical_root.join(&prefix);
    if fs::canonicalize(&ingress).map_err(|e| e.to_string())? != ingress {
        return Err("Auto Import ingress is not canonical.".into());
    }
    let (entries, _, _, _) =
        scan::scan_folder(&ingress, stop, Duration::from_secs(300), |_, _, _, _, _| {})?;
    let mut live = std::collections::HashSet::new();
    for row in entries.into_iter().take(100_000) {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let relative_path = format!("{prefix}/{}", string(&row, "relativePath")?);
        let observation = json!({"size":row["observation"]["byteLength"],"modifiedAt":row["observation"]["modifiedAt"],"localFileId":row["observation"]["localFileId"],"observedAt":now()});
        live.insert(relative_path.clone());
        let stable = match pending.get(&relative_path) {
            Some((first, when)) if fingerprint::same_stat(first, &observation) => {
                when.elapsed().as_millis() >= number(rule, "stabilityMs")? as u128
            }
            None => false,
            Some(_) => false,
        };
        if !stable {
            pending.insert(relative_path.clone(), (observation, Instant::now()));
            continue;
        }
        let _lock = guard.lock().map_err(|e| e.to_string())?;
        let mut state = load(user_data, catalog_id)?;
        if state.paused || state.rule.as_ref() != Some(rule) {
            break;
        }
        let key = format!(
            "{}\0{}\0{}\0{}",
            relative_path,
            observation["size"],
            history::js_stringify(&observation["modifiedAt"]),
            observation["localFileId"].as_str().unwrap_or("")
        );
        if state
            .items
            .iter()
            .any(|item| item["dedupeKey"] == key && item["state"] != "cancelled")
        {
            continue;
        }
        state
            .items
            .retain(|item| item["dedupeKey"] != key || item["state"] != "cancelled");
        let timestamp = now();
        state.items.push(json!({"queueId":Uuid::new_v4().to_string(),"catalogId":catalog_id,"ruleId":rule["ruleId"],"relativePath":relative_path,"placement":"copy","observation":observation,"dedupeKey":key,"state":"queued","attempts":0,"maxAttempts":rule["maxAttempts"],"recoveryRequired":false,"retryBackoffMs":rule["retryBackoffMs"],"nextAttemptAt":timestamp,"leaseUntil":null,"error":null,"createdAt":timestamp,"updatedAt":timestamp}));
        save(user_data, catalog_id, &state)?;
    }
    pending.retain(|key, _| live.contains(key));
    Ok(())
}

fn claim(state: &mut State) -> Result<Option<Value>, String> {
    let timestamp = now();
    for item in &mut state.items {
        if item["state"] == "claimed"
            && item["leaseUntil"].as_i64().unwrap_or(0) <= timestamp
            && number(item, "attempts")? >= number(item, "maxAttempts")?
            && item["recoveryRequired"] != true
        {
            item["state"] = json!("failed");
            item["leaseUntil"] = Value::Null;
            item["updatedAt"] = json!(timestamp);
        }
    }
    let position = state
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            (item["state"] == "queued"
                || item["state"] == "claimed"
                    && item["leaseUntil"].as_i64().unwrap_or(0) <= timestamp)
                && item["nextAttemptAt"].as_i64().unwrap_or(i64::MAX) <= timestamp
                && (item["attempts"].as_i64().unwrap_or(i64::MAX)
                    < item["maxAttempts"].as_i64().unwrap_or(0)
                    || item["recoveryRequired"] == true)
        })
        .min_by_key(|(_, item)| item["createdAt"].as_i64().unwrap_or(i64::MAX))
        .map(|(index, _)| index);
    let Some(index) = position else {
        return Ok(None);
    };
    let item = &mut state.items[index];
    item["state"] = json!("claimed");
    if item["recoveryRequired"] != true {
        item["attempts"] = json!(number(item, "attempts")? + 1)
    }
    item["leaseUntil"] = json!(timestamp + 30_000);
    item["updatedAt"] = json!(timestamp);
    Ok(Some(item.clone()))
}

fn finish(item: &mut Value, error: Option<&str>, rule: &Value) {
    let timestamp = now();
    item["leaseUntil"] = Value::Null;
    item["updatedAt"] = json!(timestamp);
    match error {
        None => {
            item["state"] = json!("completed");
            item["error"] = Value::Null;
            item["recoveryRequired"] = json!(false)
        }
        Some(error) => {
            let attempts = item["attempts"].as_i64().unwrap_or(1);
            let recovery = item["recoveryRequired"] == true;
            let terminal = !recovery && attempts >= number(rule, "maxAttempts").unwrap_or(1);
            item["state"] = json!(if terminal { "failed" } else { "queued" });
            item["error"] = json!(error);
            item["nextAttemptAt"] = json!(if terminal {
                timestamp
            } else {
                timestamp + number(rule, "retryBackoffMs").unwrap_or(0) * attempts.max(1)
            });
        }
    }
}

fn auto_root(db: &Connection, catalog_id: &str, root_id: &str) -> Result<PathBuf, String> {
    let row = one(
        db,
        "SELECT canonical_path AS path,health FROM roots WHERE catalog_id=? AND root_id=?",
        values(&[&json!(catalog_id), &json!(root_id)]),
    )?
    .ok_or("Auto Import root is missing.")?;
    if row["health"] != "online" {
        return Err("Auto Import root is offline.".into());
    }
    let path = PathBuf::from(string(&row, "path")?);
    if fs::canonicalize(&path).map_err(|_| "Auto Import root is unavailable.")? != path {
        return Err("Auto Import root changed.".into());
    }
    Ok(path)
}

fn safe_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.starts_with('/')
        || relative_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || relative_path.contains(['\\', '\0'])
    {
        return Err("Auto Import path is invalid.".into());
    }
    let mut path = root.to_path_buf();
    for part in relative_path.split('/') {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Auto Import path is symlinked.".into());
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("Auto Import path is unavailable.".into()),
        }
    }
    Ok(path)
}

fn apply_auto(
    service: &mut CatalogService,
    catalog_id: &str,
    mutations: Vec<Value>,
) -> Result<(), String> {
    for _ in 0..4 {
        let revision = service.revision(catalog_id)?;
        match service.apply(
            &json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":mutations}),
        ) {
            Ok(_) => return Ok(()),
            Err(error) if error.to_ascii_lowercase().contains("revision") => continue,
            Err(error) => return Err(error),
        }
    }
    Err("Auto Import catalog revision stayed stale.".into())
}

fn execute_auto(
    db_path: &Path,
    item: &Value,
    rule: &Value,
    user_data: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let db = Connection::open(db_path).map_err(|e| e.to_string())?;
    db.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let mut service = CatalogService::for_worker(db);
    let persisted = one(
        service.db()?,
        "SELECT payload_json AS payloadJson FROM operations WHERE catalog_id=? AND operation_id=? AND kind='import'",
        values(&[&item["catalogId"], &item["queueId"]]),
    )?;
    let plan = if let Some(persisted) = persisted {
        let payload: Value =
            serde_json::from_str(string(&persisted, "payloadJson")?).map_err(|e| e.to_string())?;
        let plan = payload["plan"].clone();
        import::verify(&plan)?;
        if plan["catalogId"] != item["catalogId"]
            || plan["operationId"] != item["queueId"]
            || plan["destinationRootId"] != rule["destinationRootId"]
            || plan["items"][0]["source"]["rootId"] != rule["ingressRootId"]
            || plan["items"][0]["source"]["relativePath"] != item["relativePath"]
            || !fingerprint::same_stat(
                &plan["items"][0]["source"]["observation"],
                &item["observation"],
            )
            || plan["preset"]["sha256"] != rule["presetSha256"]
        {
            return Err(
                "Auto Import persisted plan does not match its queue item and rule.".into(),
            );
        }
        plan
    } else {
        prepare_auto_plan(&mut service, item, rule, cancel)?
    };
    let retryable = number(item, "attempts")? < number(item, "maxAttempts")?;
    let result = import::execute_plan_retryable(&mut service, &plan, cancel, user_data, retryable)?;
    if result["state"] == "completed" {
        Ok(())
    } else {
        Err(result["error"]
            .as_str()
            .unwrap_or("Auto Import execution failed.")
            .to_string())
    }
}

fn prepare_auto_plan(
    service: &mut CatalogService,
    item: &Value,
    rule: &Value,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    let catalog_id = string(item, "catalogId")?;
    if item["ruleId"] != rule["ruleId"] || item["placement"] != "copy" {
        return Err("Auto Import item and rule do not match.".into());
    }
    let ingress_id = string(rule, "ingressRootId")?;
    let destination_id = string(rule, "destinationRootId")?;
    let source_relative = relative(item, "relativePath")?;
    let ingress_root = auto_root(service.db()?, catalog_id, ingress_id)?;
    let source_path = safe_path(&ingress_root, &source_relative)?;
    let source_meta =
        fs::symlink_metadata(&source_path).map_err(|_| "Auto Import source is unavailable.")?;
    if !source_meta.is_file() {
        return Err("Auto Import source is not a regular file.".into());
    }
    let observed = fingerprint::file_observation(&source_meta);
    if !fingerprint::same_stat(&observed, &item["observation"]) {
        return Err("Auto Import source observation is stale.".into());
    }
    let format =
        scan::format_id(&source_relative).ok_or("Auto Import source format is unavailable.")?;
    let xmp_relative = Path::new(&source_relative)
        .with_extension("xmp")
        .to_string_lossy()
        .replace('\\', "/");
    let xmp_path = safe_path(&ingress_root, &xmp_relative)?;
    let xmp_state = match fs::symlink_metadata(&xmp_path) {
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => "present",
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "absent",
        _ => "unreadable",
    };
    if xmp_state == "unreadable" {
        return Err("Auto Import source XMP is unreadable.".into());
    }
    let row=one(service.db()?,"SELECT name,payload_json AS payloadJson,revision,updated_at AS updatedAt FROM import_presets WHERE catalog_id=? AND preset_id=?",values(&[&json!(catalog_id),&rule["presetId"]]))?.ok_or("Auto Import preset is unavailable.")?;
    let payload: Value =
        serde_json::from_str(string(&row, "payloadJson")?).map_err(|e| e.to_string())?;
    let preset = json!({"catalogId":catalog_id,"presetId":rule["presetId"],"name":row["name"],"version":row["revision"],"template":{"pattern":payload["template"]["pattern"]},"payload":payload["payload"],"updatedAt":row["updatedAt"]});
    let hash = format!(
        "{:x}",
        Sha256::digest(history::canonical_json(&preset).as_bytes())
    );
    if preset["version"] != rule["presetVersion"] || hash != rule["presetSha256"] {
        return Err("Auto Import preset does not match the frozen rule.".into());
    }
    let existing = one(
        service.db()?,
        "SELECT asset_id AS assetId,health,observed_byte_length AS size,observed_modified_at AS modifiedAt,local_file_id AS localFileId FROM assets WHERE catalog_id=? AND root_id=? AND relative_path=?",
        values(&[
            &json!(catalog_id),
            &json!(ingress_id),
            &json!(source_relative),
        ]),
    )?;
    let source_asset_id = existing
        .as_ref()
        .map(|v| v["assetId"].clone())
        .unwrap_or_else(|| json!(Uuid::new_v4().to_string()));
    if existing
        .as_ref()
        .is_none_or(|old| old["health"] != "present" || !fingerprint::same_stat(old, &observed))
    {
        apply_auto(
            service,
            catalog_id,
            vec![
                json!({"kind":"reconcile","rootId":ingress_id,"complete":false,"observations":[{"assetId":source_asset_id,"relativePath":source_relative,"observation":{"byteLength":observed["size"],"modifiedAt":observed["modifiedAt"],"localFileId":observed["localFileId"],"observedAt":observed["observedAt"]},"health":"present","formatId":format,"cameraMake":null,"cameraModel":null,"lensModel":null}]}),
            ],
        )?;
    }
    let source = json!({"rootId":ingress_id,"relativePath":source_relative,"observation":observed,"xmpState":xmp_state,"formatId":format});
    let rendered = import::render(string(&preset["template"], "pattern")?, &source, None)?;
    let destination_relative = format!(
        "{}/{}",
        relative(rule, "destinationRelativePath")?,
        rendered
    );
    let destination_root = auto_root(service.db()?, catalog_id, destination_id)?;
    let mut destination_decision = Value::Null;
    let occupied = |candidate: &str| -> Result<bool, String> {
        let path = safe_path(&destination_root, candidate)?;
        let xmp = safe_path(
            &destination_root,
            &Path::new(candidate)
                .with_extension("xmp")
                .to_string_lossy()
                .replace('\\', "/"),
        )?;
        Ok(path.exists()
            || xmp.exists()
            || one(
                service.db()?,
                "SELECT 1 FROM assets WHERE catalog_id=? AND root_id=? AND relative_path=?",
                values(&[
                    &json!(catalog_id),
                    &json!(destination_id),
                    &json!(candidate),
                ]),
            )?
            .is_some())
    };
    if occupied(&destination_relative)? {
        if rule["destinationConflictPolicy"] == "skip" {
            destination_decision = json!({"kind":"skip"})
        } else if rule["destinationConflictPolicy"] == "rename" {
            let original = Path::new(&destination_relative);
            let stem = original
                .file_stem()
                .and_then(|v| v.to_str())
                .ok_or("Auto Import destination is invalid.")?;
            let ext = original.extension().and_then(|v| v.to_str());
            let parent = original.parent().and_then(|v| v.to_str()).unwrap_or("");
            for suffix in 1..=10_000 {
                let name = if let Some(ext) = ext {
                    format!("{stem} ({suffix}).{ext}")
                } else {
                    format!("{stem} ({suffix})")
                };
                let candidate = if parent.is_empty() {
                    name
                } else {
                    format!("{parent}/{name}")
                };
                if !occupied(&candidate)? {
                    destination_decision =
                        json!({"kind":"rename","destinationRelativePath":candidate});
                    break;
                }
            }
            if destination_decision.is_null() {
                return Err("Auto Import could not resolve a destination name.".into());
            }
        } else {
            return Err("Auto Import destination conflict policy is invalid.".into());
        }
    }
    let mut duplicate_decision = Value::Null;
    if rule["duplicatePolicy"] == "continue-unchecked" {
        duplicate_decision = json!({"kind":"continue-unchecked"})
    } else if rule["duplicatePolicy"] == "keep-both" {
        duplicate_decision = json!({"kind":"keep-both"})
    } else if rule["duplicatePolicy"] == "skip-incoming" {
        let source_asset = json!({"canonicalRootPath":ingress_root,"relativePath":source_relative});
        let (status, source_hash, after) = fingerprint::hash(&source_asset, cancel);
        if status != "indexed" || !fingerprint::same_stat(&after, &item["observation"]) {
            return Err("Auto Import duplicate check could not finish.".into());
        }
        let candidates = rows(
            service.db()?,
            "SELECT a.root_id AS rootId,a.relative_path AS relativePath,r.canonical_path AS canonicalRootPath FROM assets a JOIN roots r ON r.catalog_id=a.catalog_id AND r.root_id=a.root_id WHERE a.catalog_id=? AND a.health='present' AND a.observed_byte_length=? AND a.asset_id<>?",
            values(&[
                &json!(catalog_id),
                &item["observation"]["size"],
                &source_asset_id,
            ]),
        )?;
        for candidate in candidates {
            let (state, hash, _) = fingerprint::hash(&candidate, cancel);
            if state != "indexed" {
                return Err("Auto Import duplicate check could not finish.".into());
            }
            if hash == source_hash {
                duplicate_decision = json!({"kind":"skip-incoming"});
                break;
            }
        }
    } else {
        return Err("Auto Import duplicate policy is invalid.".into());
    }
    let final_destination = destination_decision["destinationRelativePath"]
        .as_str()
        .unwrap_or(&destination_relative);
    let xmp_destination = if xmp_state == "present" {
        json!(
            Path::new(final_destination)
                .with_extension("xmp")
                .to_string_lossy()
                .replace('\\', "/")
        )
    } else {
        Value::Null
    };
    let plan = json!({"operationId":item["queueId"],"catalogId":catalog_id,"destinationRootId":destination_id,"preset":preset,"items":[{"itemId":Uuid::new_v4().to_string(),"sourceAssetId":source_asset_id,"destinationAssetId":Uuid::new_v4().to_string(),"action":"copy","source":source,"destinationRelativePath":final_destination,"xmpDestinationRelativePath":xmp_destination,"conflictDecisions":{"duplicate":duplicate_decision,"destination":destination_decision}}],"createdAt":now()});
    Ok(import::freeze(plan))
}
