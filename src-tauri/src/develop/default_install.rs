use super::{apply, defaults, store_io};
use crate::{
    Backend,
    catalog::{CatalogService, history, now, one, string, values},
    native,
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

struct Request {
    binding: String,
    cancelled: Arc<AtomicBool>,
    active: bool,
    expires: Instant,
}
static REQUESTS: LazyLock<Mutex<HashMap<String, Request>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
struct Installation(String);
impl Drop for Installation {
    fn drop(&mut self) {
        if let Ok(mut requests) = REQUESTS.lock() {
            requests.remove(&self.0);
        }
    }
}

fn binding(request: &Value, install: bool) -> Result<(String, String), String> {
    store_io::object_keys(
        request,
        if install {
            &["catalogId", "sessionId", "entryId", "requestId", "facts"]
        } else {
            &["catalogId", "sessionId", "entryId", "requestId"]
        },
    )?;
    for field in ["catalogId", "sessionId", "entryId", "requestId"] {
        uuid::Uuid::parse_str(string(request, field)?)
            .map_err(|_| "Develop default request identity is invalid.")?;
    }
    Ok((
        string(request, "requestId")?.into(),
        format!(
            "{}:{}:{}",
            request["catalogId"], request["sessionId"], request["entryId"]
        ),
    ))
}

pub fn cancel(request: &Value) -> Result<Value, String> {
    let (id, binding) = binding(request, false)?;
    let mut requests = REQUESTS
        .lock()
        .map_err(|_| "Develop default request state is unavailable.")?;
    requests.retain(|_, r| r.active || r.expires > Instant::now());
    if let Some(current) = requests.get(&id) {
        if current.binding != binding {
            return Err("Develop default cancellation does not match its request.".into());
        }
        current.cancelled.store(true, Ordering::SeqCst);
    } else {
        if requests.values().filter(|r| !r.active).count() >= 1024 {
            if let Some(oldest) = requests
                .iter()
                .filter(|(_, r)| !r.active)
                .min_by_key(|(_, r)| r.expires)
                .map(|(id, _)| id.clone())
            {
                requests.remove(&oldest);
            }
        }
        requests.insert(
            id,
            Request {
                binding,
                cancelled: Arc::new(AtomicBool::new(true)),
                active: false,
                expires: Instant::now() + Duration::from_secs(60),
            },
        );
    }
    Ok(Value::Null)
}

pub fn entry(catalog: &mut CatalogService, request: &Value) -> Result<Value, String> {
    catalog.require_session(request)?;
    let query=catalog.dispatch("darkroom:catalog-query",json!([{"catalogId":request["catalogId"],"sessionId":request["sessionId"],"entryId":request["entryId"],"expectedRevision":null}]))?;
    query["assets"]
        .as_array()
        .and_then(|entries| entries.iter().find(|v| v["entryId"] == request["entryId"]))
        .cloned()
        .ok_or("Develop default entry is not active in this catalog session.".into())
}

fn stored(db: &Connection, id: &str, entry: &str) -> Result<Value, String> {
    let Some(row) = one(
        db,
        "SELECT revision_id AS revisionId,provenance_json AS provenance FROM develop_default_installs WHERE catalog_id=? AND entry_id=?",
        values(&[&json!(id), &json!(entry)]),
    )?
    else {
        return Ok(Value::Null);
    };
    let installed: Value =
        serde_json::from_str(string(&row, "provenance")?).map_err(|e| e.to_string())?;
    if installed["catalogId"] != id
        || installed["entryId"] != entry
        || installed["revisionId"] != row["revisionId"]
    {
        return Err("Installed Develop default provenance does not match its identity.".into());
    }
    if history::reconstruct(db, id, entry, string(&row, "revisionId")?)?
        != installed["baselineDocument"]
    {
        return Err("Installed Develop default baseline does not match its revision.".into());
    }
    Ok(installed)
}

pub fn installed(catalog: &mut CatalogService, request: &Value) -> Result<Value, String> {
    store_io::object_keys(request, &["catalogId", "sessionId", "entryId"])?;
    entry(catalog, request)?;
    stored(
        catalog.active_database().ok_or("Catalog is unavailable.")?,
        string(request, "catalogId")?,
        string(request, "entryId")?,
    )
}

fn normalize(v: &Value) -> String {
    v.as_str().unwrap_or("").trim().to_lowercase()
}
pub(super) fn same_camera(
    left_make: &Value,
    left_model: &Value,
    right_make: &Value,
    right_model: &Value,
) -> bool {
    let identity = |make: &Value, model: &Value| {
        let make = normalize(make);
        let model = normalize(model);
        if make == "nikon" || make == "nikon corporation" {
            (
                "nikon".to_owned(),
                model.strip_prefix("nikon ").unwrap_or(&model).to_owned(),
            )
        } else {
            (make, model)
        }
    };
    identity(left_make, left_model) == identity(right_make, right_model)
}
fn numbers_equal(left: &Value, right: &Value) -> bool {
    left.as_f64()
        .zip(right.as_f64())
        .is_some_and(|(left, right)| left == right)
}
pub fn profile_context(registry: &Value, profile: &Value, camera: &Value) -> Value {
    if profile.is_null() || camera["kind"] != "known" {
        return json!({"kind":"unavailable","reason":"The decoded source has no verified before-tone input profile stage."});
    }
    let calibration = |profile: &Value| json!({"matrixToLinearSrgb":profile["matrixToLinearSrgb"],"channelScale":profile["channelScale"],"exposureOffsetEv":profile["exposureOffsetEv"]});
    let compatible:Vec<_>=registry["profiles"].as_array().into_iter().flatten().filter(|r|r["kind"]=="ready"&&same_camera(&r["profile"]["compatibility"]["make"],&r["profile"]["compatibility"]["model"],&camera["make"],&camera["model"])).map(|r|json!({"registryRevision":registry["revision"],"selection":{"kind":"selected","profileId":r["profile"]["id"],"profileRevision":r["profile"]["revision"]},"calibration":calibration(&r["profile"])})).collect();
    json!({"kind":"available-before-tone","decoderDefault":{"registryRevision":registry["revision"],"selection":{"kind":"decoder-default"},"calibration":calibration(profile)},"compatibleProfiles":compatible})
}

fn pristine(entry: &Value, head: &Value) -> bool {
    head["ordinal"] == 0
        && entry["metadata"]["developJson"].is_null()
        && entry["metadata"]["rawXmp"].is_null()
        && entry["metadata"]["xmpState"] != "preserved"
        && (head["document"].is_null()
            || head["document"]
                == serde_json::from_str::<Value>(include_str!("default-document.json")).unwrap())
}

fn loaded_head(
    db: &rusqlite::Connection,
    catalog_id: &str,
    entry_id: &str,
) -> Result<Value, String> {
    let loaded = history::loaded(db, catalog_id, entry_id, None)?;
    if loaded["kind"] == "recovery" {
        return Err(loaded["corruption"]["message"]
            .as_str()
            .unwrap_or("Develop history needs recovery.")
            .into());
    }
    Ok(loaded["value"].clone())
}

pub fn install(backend: Arc<Backend>, request: Value) -> Result<Value, String> {
    let (request_id, binding) = binding(&request, true)?;
    defaults::validate_facts(&request["facts"])?;
    let cancelled = {
        let mut requests = REQUESTS
            .lock()
            .map_err(|_| "Develop default request state is unavailable.")?;
        requests.retain(|_, r| r.active || r.expires > Instant::now());
        if requests.values().filter(|r| r.active).count() >= 1024 {
            return Err("Too many Develop default installations are active.".into());
        }
        if let Some(current) = requests.get(&request_id) {
            if current.active || current.binding != binding {
                return Err(
                    "Develop default request ID is already bound to another request.".into(),
                );
            }
        }
        let cancelled = requests
            .remove(&request_id)
            .map(|r| r.cancelled)
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        requests.insert(
            request_id.clone(),
            Request {
                binding,
                cancelled: cancelled.clone(),
                active: true,
                expires: Instant::now(),
            },
        );
        cancelled
    };
    let _installation = Installation(request_id);
    let check = || {
        if cancelled.load(Ordering::SeqCst) {
            Err(
                "Develop default installation was cancelled because the active photo changed."
                    .to_owned(),
            )
        } else {
            Ok(())
        }
    };
    check()?;
    let (original, location) = {
        let mut catalog = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?;
        let entry = entry(&mut catalog, &request)?;
        if entry["sourceId"].is_null()
            || entry["health"] != "present"
            || entry["observation"].is_null()
        {
            return Err("Develop default source is unavailable.".into());
        }
        let mut asset = request.clone();
        asset["assetId"] = entry["assetId"].clone();
        let mut location = catalog.resolve_asset(&asset)?;
        location["fallback"] = json!({"cameraMake":entry["cameraMake"],"cameraModel":entry["cameraModel"],"lens":entry["lensModel"]});
        (entry, location)
    };
    let id = string(&request, "catalogId")?;
    let entry_id = string(&request, "entryId")?;
    {
        let catalog = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?;
        catalog.require_session(&request)?;
        let db = catalog.active_database().ok_or("Catalog is unavailable.")?;
        let stored = stored(db, id, entry_id)?;
        let head = loaded_head(db, id, entry_id)?;
        if !stored.is_null() {
            check()?;
            return Ok(json!({"kind":"already-installed","head":head,"installed":stored}));
        }
        if !pristine(&original, &head) {
            check()?;
            return Ok(json!({"kind":"not-pristine","head":head,"installed":null}));
        }
    }
    let has_enabled_defaults = {
        let develop = backend
            .develop
            .lock()
            .map_err(|_| "Develop service is unavailable.")?;
        develop
            .defaults
            .list()?
            .iter()
            .any(|rule| rule["enabled"] == true)
    };
    check()?;
    if !has_enabled_defaults {
        let catalog = backend
            .catalog
            .lock()
            .map_err(|_| "Catalog service is unavailable.")?;
        catalog.require_session(&request)?;
        let db = catalog.active_database().ok_or("Catalog is unavailable.")?;
        let installed = stored(db, id, entry_id)?;
        let head = loaded_head(db, id, entry_id)?;
        if !installed.is_null() {
            check()?;
            return Ok(json!({"kind":"already-installed","head":head,"installed":installed}));
        }
        if !pristine(&original, &head) {
            check()?;
            return Ok(json!({"kind":"not-pristine","head":head,"installed":null}));
        }
        check()?;
        return Ok(json!({"kind":"no-match","head":head,"installed":null}));
    }
    let verified = native::analyze_file(&location, &backend.native)?;
    check()?;
    if !verified["error"].is_null()
        || verified["sourceSha256"].is_null()
        || !numbers_equal(&verified["size"], &original["observation"]["byteLength"])
        || !numbers_equal(
            &verified["modifiedAt"],
            &original["observation"]["modifiedAt"],
        )
    {
        return Err("Develop default source analysis is missing, stale, or failed.".into());
    }
    let camera = if verified["cameraMake"].is_string() && verified["cameraModel"].is_string() {
        json!({"kind":"known","make":verified["cameraMake"],"model":verified["cameraModel"]})
    } else {
        json!({"kind":"unknown","reason":"Camera identity is unavailable in verified metadata."})
    };
    let iso = if verified["iso"]
        .as_f64()
        .is_some_and(|n| n >= 1.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0)
    {
        json!({"kind":"known","value":verified["iso"]})
    } else {
        json!({"kind":"unknown","reason":"ISO is unavailable in verified metadata."})
    };
    let profile = if original["formatId"] == "nef" {
        native::verify_libraw_profile(&location).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    check()?;
    let path = native::resolve_asset_path(&location)?;
    if native::metadata_sha256(&path)? != string(&verified, "sourceSha256")? {
        return Err("Develop default source changed during profile verification.".into());
    }
    let candidate = if profile.is_null() {
        None
    } else {
        if camera["kind"] != "known"
            || !same_camera(
                &camera["make"],
                &camera["model"],
                &profile["compatibility"]["make"],
                &profile["compatibility"]["model"],
            )
        {
            return Err("Verified decoder profile does not match source camera metadata.".into());
        }
        let camera = json!({"kind":"known","make":profile["compatibility"]["make"],"model":profile["compatibility"]["model"]});
        let facts = json!({"camera":camera,"iso":iso,"decoder":{"kind":"known","value":"libraw-wasm"},"inputProfile":{"kind":"known","profileId":profile["id"],"profileRevision":profile["revision"],"stage":"before-develop-tone"}});
        let supplied = &request["facts"];
        for key in ["camera", "decoder", "inputProfile", "iso"] {
            if supplied[key]["kind"] != facts[key]["kind"] {
                return Err(format!(
                    "Develop default {key} kind does not match verified source provenance."
                ));
            }
            if facts[key]["kind"] == "known" {
                for field in match key {
                    "camera" => vec!["make", "model"],
                    "inputProfile" => vec!["profileId", "profileRevision"],
                    _ => vec!["value"],
                } {
                    let matches = if key == "camera" {
                        normalize(&supplied[key][field]) == normalize(&facts[key][field])
                    } else if key == "iso" {
                        numbers_equal(&supplied[key][field], &facts[key][field])
                    } else {
                        supplied[key][field] == facts[key][field]
                    };
                    if !matches {
                        return Err(format!(
                            "Develop default {key}.{field} does not match verified source provenance."
                        ));
                    }
                }
            }
        }
        let develop = backend
            .develop
            .lock()
            .map_err(|_| "Develop service is unavailable.")?;
        let (matched, _) = develop.defaults.evaluate(&facts, &develop.presets)?;
        if let Some((rule, preset)) = matched {
            let selected = rule["preset"]["selectedFields"]
                .as_array()
                .ok_or("Develop default selected fields are invalid.")?;
            let safe: Vec<_> = selected
                .iter()
                .filter(|f| **f != "ai-masks")
                .cloned()
                .collect();
            let context = profile_context(&develop.profiles.list(), &profile, &camera);
            let initial: Value = serde_json::from_str(include_str!("default-document.json"))
                .map_err(|e| e.to_string())?;
            let mut application = if safe.is_empty() {
                json!({"document":initial,"report":{"included":[],"skipped":[],"unsupported":[]}})
            } else {
                apply::apply_preset(
                    &initial,
                    &preset,
                    Some(&safe),
                    100.0,
                    &json!({"sourceId":original["sourceId"],"cameraProfile":context,"regenerateAiMasks":false}),
                )?
            };
            if selected.iter().any(|f| *f == "ai-masks") {
                application["report"]["skipped"].as_array_mut().unwrap().insert(0,json!({"field":"ai-masks","reason":"Source-specific AI masks never apply as Develop defaults."}));
            }
            Some((rule, preset, application))
        } else {
            None
        }
    };
    check()?;
    let mut catalog = backend
        .catalog
        .lock()
        .map_err(|_| "Catalog service is unavailable.")?;
    let current = entry(&mut catalog, &request)?;
    for field in [
        "sourceId",
        "revision",
        "health",
        "observation",
        "rootId",
        "relativePath",
    ] {
        if current[field] != original[field] {
            return Err("Develop default source changed before installation.".into());
        }
    }
    let final_path = native::resolve_asset_path(&location)?;
    if native::metadata_sha256(&final_path)? != string(&verified, "sourceSha256")? {
        return Err("Develop default source changed before installation.".into());
    }
    let db = catalog.active_database().ok_or("Catalog is unavailable.")?;
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        check()?;
        let stored = stored(db, id, entry_id)?;
        let head = loaded_head(db, id, entry_id)?;
        if !stored.is_null() {
            return Ok(json!({"kind":"already-installed","head":head,"installed":stored}));
        }
        if !pristine(&current, &head) {
            return Ok(json!({"kind":"not-pristine","head":head,"installed":null}));
        }
        let Some((rule, preset, application)) = candidate else {
            return Ok(json!({"kind":"no-match","head":head,"installed":null}));
        };
        let revision = uuid::Uuid::new_v4().to_string();
        let created = now();
        history::commit(
            db,
            &json!({"catalogId":id,"entryId":entry_id,"revisionId":revision,"expectedParentRevisionId":head["revisionId"],"operationId":uuid::Uuid::new_v4().to_string(),"label":format!("Apply default {}",string(&rule,"name")?),"document":application["document"],"createdAt":created}),
        )?;
        let installed = json!({"catalogId":id,"entryId":entry_id,"revisionId":revision,"ruleId":rule["ruleId"],"ruleRevision":rule["revision"],"presetId":preset["presetId"],"presetRevision":preset["revision"],"selectedFields":rule["preset"]["selectedFields"],"baselineDocument":application["document"],"appliedFields":application["report"]["included"],"skipped":application["report"]["skipped"],"unsupported":application["report"]["unsupported"],"createdAt":created});
        db.execute("INSERT INTO develop_default_installs(catalog_id,entry_id,revision_id,provenance_json,created_at) VALUES(?1,?2,?3,?4,?5)",params![id,entry_id,revision,history::js_stringify(&installed),created]).map_err(|e|e.to_string())?;
        check()?;
        Ok(json!({"kind":"installed","head":loaded_head(db,id,entry_id)?,"installed":installed}))
    })();
    match result {
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
