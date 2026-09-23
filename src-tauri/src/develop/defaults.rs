use super::{presets::PresetStore, store_io};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};

const LIMIT: usize = 256 * 1024 * 1024;
const FIELDS: &[&str] = &[
    "basic",
    "mixer",
    "effects",
    "tone-curves",
    "camera-profile",
    "crop",
    "manual-masks",
    "ai-masks",
];

pub struct DefaultsStore {
    path: PathBuf,
}

fn integer(value: &Value, key: &str, min: i64, max: i64) -> Result<i64, String> {
    value[key]
        .as_i64()
        .filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| format!("Develop default {key} is invalid."))
}

fn text(value: &Value, key: &str) -> Result<String, String> {
    let text = store_io::text(value, key)?.trim();
    if text.is_empty() || text.encode_utf16().count() > 512 {
        return Err(format!("Develop default {key} is invalid."));
    }
    Ok(text.into())
}

fn bounded_json(value: &Value) -> Result<(), String> {
    fn visit(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
        *nodes += 1;
        if depth > 16 || *nodes > 100_000 {
            return Err("Develop default rule exceeds structural limits.".into());
        }
        match value {
            Value::String(value) if value.encode_utf16().count() > 4096 || value.contains('\0') => {
                return Err("Develop default rule contains an invalid string.".into());
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, depth + 1, nodes)?
                }
            }
            Value::Object(fields) => {
                for (key, item) in fields {
                    if key.is_empty()
                        || key.encode_utf16().count() > 256
                        || key.contains('\0')
                        || matches!(key.as_str(), "__proto__" | "prototype" | "constructor")
                    {
                        return Err("Develop default rule contains an invalid field.".into());
                    }
                    visit(item, depth + 1, nodes)?;
                }
            }
            _ => (),
        }
        Ok(())
    }
    visit(value, 0, &mut 0)
}

pub(crate) fn validate_facts(facts: &Value) -> Result<(), String> {
    store_io::object_keys(facts, &["camera", "decoder", "inputProfile", "iso"])?;
    let fact_text = |value: &Value, key: &str| -> Result<(), String> {
        let text = store_io::text(value, key)?;
        if text.trim().is_empty() || text.encode_utf16().count() > 512 {
            return Err(format!("Develop default {key} fact is invalid."));
        }
        Ok(())
    };
    let camera = &facts["camera"];
    store_io::object_keys(camera, &["kind", "make", "model", "reason"])?;
    match camera["kind"].as_str() {
        Some("known") => {
            fact_text(camera, "make")?;
            fact_text(camera, "model")?
        }
        Some("unknown") => fact_text(camera, "reason")?,
        _ => return Err("Develop default camera fact is invalid.".into()),
    };
    let decoder = &facts["decoder"];
    store_io::object_keys(decoder, &["kind", "value", "reason"])?;
    match decoder["kind"].as_str() {
        Some("known") => fact_text(decoder, "value")?,
        Some("unknown") => fact_text(decoder, "reason")?,
        _ => return Err("Develop default decoder fact is invalid.".into()),
    };
    let profile = &facts["inputProfile"];
    store_io::object_keys(
        profile,
        &["kind", "profileId", "profileRevision", "stage", "reason"],
    )?;
    match profile["kind"].as_str() {
        Some("known") => {
            fact_text(profile, "profileId")?;
            fact_text(profile, "profileRevision")?;
            if profile["stage"] != "before-develop-tone" {
                return Err("Develop default input profile stage is invalid.".into());
            }
        }
        Some("unknown") => fact_text(profile, "reason")?,
        _ => return Err("Develop default input profile fact is invalid.".into()),
    };
    let iso = &facts["iso"];
    store_io::object_keys(iso, &["kind", "value", "reason"])?;
    match iso["kind"].as_str() {
        Some("known") => {
            integer(iso, "value", 1, 9_007_199_254_740_991)?;
        }
        Some("unknown") => fact_text(iso, "reason")?,
        _ => return Err("Develop default ISO fact is invalid.".into()),
    };
    Ok(())
}

fn uuid(value: &Value, key: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(store_io::text(value, key)?)
        .map(|v| v.to_string())
        .map_err(|_| format!("Develop default {key} must be a UUID."))
}

fn validate_rule(value: &Value) -> Result<Value, String> {
    bounded_json(value)?;
    store_io::object_keys(
        value,
        &[
            "schemaVersion",
            "ruleId",
            "revision",
            "name",
            "enabled",
            "priority",
            "camera",
            "rawProfile",
            "iso",
            "preset",
            "createdAt",
            "updatedAt",
        ],
    )?;
    if value["schemaVersion"] != 1
        || !value["enabled"].is_boolean()
        || value.to_string().len() > 2 * 1024 * 1024
    {
        return Err("Develop default rule is invalid.".into());
    }
    let mut result = value.clone();
    result["ruleId"] = json!(uuid(value, "ruleId")?);
    result["name"] = json!(text(value, "name")?);
    integer(value, "revision", 1, 9_007_199_254_740_991)?;
    integer(value, "priority", -1_000_000, 1_000_000)?;
    let created = integer(value, "createdAt", 0, 9_007_199_254_740_991)?;
    integer(value, "updatedAt", created, 9_007_199_254_740_991)?;
    let camera = &value["camera"];
    match camera["kind"].as_str() {
        Some("unknown") => store_io::object_keys(camera, &["kind"])?,
        Some("exact") => {
            store_io::object_keys(camera, &["kind", "make", "model"])?;
            result["camera"]["make"] = json!(text(camera, "make")?);
            result["camera"]["model"] = json!(text(camera, "model")?);
        }
        _ => return Err("Develop default camera selector is invalid.".into()),
    }
    let raw = &value["rawProfile"];
    match raw["kind"].as_str() {
        Some("unknown" | "wildcard") => store_io::object_keys(raw, &["kind"])?,
        Some("exact") => {
            store_io::object_keys(raw, &["kind", "decoderId", "profileId", "profileRevision"])?;
            for key in ["decoderId", "profileId", "profileRevision"] {
                result["rawProfile"][key] = json!(text(raw, key)?);
            }
        }
        _ => return Err("Develop default profile selector is invalid.".into()),
    }
    let iso = &value["iso"];
    match iso["kind"].as_str() {
        Some("unknown") => store_io::object_keys(iso, &["kind"])?,
        Some("range") => {
            store_io::object_keys(iso, &["kind", "minimum", "maximum"])?;
            let minimum = integer(iso, "minimum", 1, 9_007_199_254_740_991)?;
            integer(iso, "maximum", minimum, 9_007_199_254_740_991)?;
        }
        _ => return Err("Develop default ISO selector is invalid.".into()),
    }
    let preset = &value["preset"];
    store_io::object_keys(preset, &["presetId", "presetRevision", "selectedFields"])?;
    result["preset"]["presetId"] = json!(uuid(preset, "presetId")?);
    integer(preset, "presetRevision", 1, 9_007_199_254_740_991)?;
    let fields = preset["selectedFields"]
        .as_array()
        .ok_or("Develop default preset fields are invalid.")?;
    let mut seen = HashSet::new();
    if fields.is_empty()
        || fields.iter().any(|v| {
            !v.as_str()
                .is_some_and(|f| FIELDS.contains(&f) && seen.insert(f))
        })
    {
        return Err("Develop default preset fields are invalid.".into());
    }
    Ok(result)
}

impl DefaultsStore {
    pub fn new(app_data: &Path) -> Result<Self, String> {
        let root = app_data.join("develop-defaults");
        store_io::directory(&root)?;
        if root.join(".manifest.json.recovery-backup").exists() {
            return Err("Develop defaults recovery backup needs manual resolution before the store can reopen.".into());
        }
        let path = root.join("manifest.json");
        if !path.try_exists().map_err(|e| e.to_string())? {
            store_io::atomic_json(&path, &json!({"version":1,"rules":[]}), LIMIT)?;
        }
        let result = Self { path };
        result.read()?;
        Ok(result)
    }

    fn read(&self) -> Result<Vec<Value>, String> {
        let manifest = store_io::read_json(&self.path, LIMIT)?;
        store_io::object_keys(&manifest, &["version", "rules"])?;
        let rules = manifest["rules"]
            .as_array()
            .ok_or("Develop defaults manifest is invalid.")?;
        if manifest["version"] != 1 || rules.len() > 10_000 {
            return Err("Develop defaults manifest is invalid.".into());
        }
        let parsed = rules
            .iter()
            .map(validate_rule)
            .collect::<Result<Vec<_>, _>>()?;
        let mut keys = HashSet::new();
        for rule in &parsed {
            if !keys.insert(format!("{}:{}", rule["ruleId"], rule["revision"])) {
                return Err("Develop defaults manifest contains duplicate revisions.".into());
            }
        }
        Ok(parsed)
    }

    fn write(&self, rules: Vec<Value>) -> Result<(), String> {
        if rules.len() > 10_000 {
            return Err("Develop defaults store exceeds the record limit.".into());
        }
        store_io::atomic_json(&self.path, &json!({"version":1,"rules":rules}), LIMIT)
    }

    pub fn list(&self) -> Result<Vec<Value>, String> {
        let mut latest = BTreeMap::<String, Value>::new();
        for rule in self.read()? {
            let id = rule["ruleId"].as_str().unwrap().to_owned();
            if latest
                .get(&id)
                .is_none_or(|current| current["revision"].as_u64() < rule["revision"].as_u64())
            {
                latest.insert(id, rule);
            }
        }
        Ok(latest.into_values().collect())
    }

    pub fn handle(
        &mut self,
        command: &str,
        request: &Value,
        presets: &PresetStore,
    ) -> Result<Value, String> {
        match command {
            "darkroom:develop-defaults-list" => Ok(json!(self.list()?)),
            "darkroom:develop-defaults-referenced-presets" => {
                let mut result = BTreeMap::new();
                for rule in self.list()? {
                    let id = rule["preset"]["presetId"].as_str().unwrap();
                    let revision = rule["preset"]["presetRevision"].as_u64().unwrap();
                    if let Some(preset) = presets.get_revision(id, revision) {
                        result.insert(format!("{id}:{revision}"), preset);
                    }
                }
                Ok(json!(result.into_values().collect::<Vec<_>>()))
            }
            "darkroom:develop-defaults-preview" => {
                validate_facts(&request["facts"])?;
                let (winner, traces) = self.evaluate(&request["facts"], presets)?;
                Ok(match winner {
                    Some((rule, _)) => {
                        json!({"kind":"matched","winner":{"ruleId":rule["ruleId"],"ruleRevision":rule["revision"],"ruleName":rule["name"]},"traces":traces})
                    }
                    None => json!({"kind":"no-match","winner":null,"traces":traces}),
                })
            }
            "darkroom:develop-defaults-create" | "darkroom:develop-defaults-update" => {
                let rule = validate_rule(request)?;
                let current = self
                    .list()?
                    .into_iter()
                    .find(|v| v["ruleId"] == rule["ruleId"]);
                if command.ends_with("-create") {
                    if current.is_some() || rule["revision"] != 1 {
                        return Err(
                            "New Develop default rules need a unique ID and revision 1.".into()
                        );
                    }
                } else {
                    let current = current.ok_or("Develop default rule is missing.")?;
                    if rule["revision"].as_u64() != current["revision"].as_u64().map(|n| n + 1)
                        || rule["createdAt"] != current["createdAt"]
                        || rule["updatedAt"].as_u64() < current["updatedAt"].as_u64()
                    {
                        return Err("Develop default rule revision is stale.".into());
                    }
                }
                let mut rules = self.read()?;
                rules.push(rule.clone());
                self.write(rules)?;
                Ok(rule)
            }
            "darkroom:develop-defaults-enabled" | "darkroom:develop-defaults-delete" => {
                let id = uuid(request, "ruleId")?;
                let mut current = self
                    .list()?
                    .into_iter()
                    .find(|v| v["ruleId"] == id)
                    .ok_or("Develop default rule is missing.")?;
                if request["expectedRevision"] != current["revision"] {
                    return Err("Develop default rule revision is stale.".into());
                }
                let mut rules = self.read()?;
                if command.ends_with("-delete") {
                    rules.retain(|v| v["ruleId"] != id);
                    self.write(rules)?;
                    return Ok(Value::Null);
                }
                if !request["enabled"].is_boolean() {
                    return Err("Develop default enabled state is invalid.".into());
                }
                if request["enabled"] == current["enabled"] {
                    return Ok(current);
                }
                let previous_updated = current["updatedAt"].as_i64().unwrap();
                current["enabled"] = request["enabled"].clone();
                current["revision"] = json!(current["revision"].as_u64().unwrap() + 1);
                current["updatedAt"] = json!(integer(
                    request,
                    "updatedAt",
                    previous_updated,
                    9_007_199_254_740_991
                )?);
                rules.push(current.clone());
                self.write(rules)?;
                Ok(current)
            }
            _ => Err(format!("Unsupported Develop default command: {command}")),
        }
    }

    pub fn evaluate(
        &self,
        facts: &Value,
        presets: &PresetStore,
    ) -> Result<(Option<(Value, Value)>, Vec<Value>), String> {
        let mut rules = self.list()?;
        let profile_rank = |r: &Value| match r["rawProfile"]["kind"].as_str() {
            Some("exact") => 2,
            Some("wildcard") => 1,
            _ => 0,
        };
        let iso_width = |r: &Value| {
            if r["iso"]["kind"] == "range" {
                r["iso"]["maximum"].as_i64().unwrap() - r["iso"]["minimum"].as_i64().unwrap()
            } else {
                i64::MAX
            }
        };
        rules.sort_by(|a, b| {
            b["priority"]
                .as_i64()
                .cmp(&a["priority"].as_i64())
                .then_with(|| {
                    (b["camera"]["kind"] == "exact").cmp(&(a["camera"]["kind"] == "exact"))
                })
                .then_with(|| profile_rank(b).cmp(&profile_rank(a)))
                .then_with(|| iso_width(a).cmp(&iso_width(b)))
                .then_with(|| a["ruleId"].as_str().cmp(&b["ruleId"].as_str()))
        });
        let mut winner = None;
        let mut traces = vec![];
        for rule in rules {
            let (preset, trace) = evaluate_rule(&rule, facts, presets)?;
            if winner.is_none() {
                if let Some(preset) = preset {
                    winner = Some((rule, preset));
                }
            }
            traces.push(trace);
        }
        Ok((winner, traces))
    }
}

fn evaluate_rule(
    rule: &Value,
    facts: &Value,
    presets: &PresetStore,
) -> Result<(Option<Value>, Value), String> {
    let norm = |v: &Value| v.as_str().unwrap_or("").trim().to_lowercase();
    let display = |v: &Value, key: &str| v[key].as_str().unwrap_or("unknown").to_owned();
    let fact = |name: &str, matched: bool, expected: String, actual: String, reason: String| json!({"fact":name,"matched":matched,"expected":expected,"actual":actual,"reason":reason});
    let enabled = rule["enabled"] == true;
    let mut entries = vec![fact(
        "enabled",
        enabled,
        "enabled".into(),
        if enabled { "enabled" } else { "disabled" }.into(),
        if enabled {
            "Rule is enabled."
        } else {
            "Disabled rules never match."
        }
        .into(),
    )];
    let camera = &rule["camera"];
    let actual = &facts["camera"];
    let matched = if camera["kind"] == "unknown" {
        actual["kind"] == "unknown"
    } else {
        actual["kind"] == "known"
            && norm(&camera["make"]) == norm(&actual["make"])
            && norm(&camera["model"]) == norm(&actual["model"])
    };
    entries.push(fact(
        "camera",
        matched,
        if camera["kind"] == "unknown" {
            "explicit unknown camera".into()
        } else {
            format!("{} {}", display(camera, "make"), display(camera, "model"))
        },
        if actual["kind"] == "known" {
            format!("{} {}", display(actual, "make"), display(actual, "model"))
        } else {
            format!("unknown: {}", display(actual, "reason"))
        },
        if matched {
            "Camera selector matched."
        } else if actual["kind"] == "unknown" && camera["kind"] != "unknown" {
            "Unknown camera facts require an explicit unknown selector."
        } else {
            "Camera make or model differs."
        }
        .into(),
    ));
    let profile = &rule["rawProfile"];
    let decoder = &facts["decoder"];
    let actual = &facts["inputProfile"];
    let known = decoder["kind"] == "known" && actual["kind"] == "known";
    let matched = match profile["kind"].as_str() {
        Some("unknown") => !known,
        Some("wildcard") => known,
        _ => {
            known
                && norm(&profile["decoderId"]) == norm(&decoder["value"])
                && norm(&profile["profileId"]) == norm(&actual["profileId"])
                && norm(&profile["profileRevision"]) == norm(&actual["profileRevision"])
        }
    };
    let expected = match profile["kind"].as_str() {
        Some("exact") => format!(
            "{} / {}@{}",
            display(profile, "decoderId"),
            display(profile, "profileId"),
            display(profile, "profileRevision")
        ),
        Some("wildcard") => "any known decoder/profile".into(),
        _ => "explicit unknown decoder/profile".into(),
    };
    let actual = if decoder["kind"] == "unknown" {
        format!("unknown decoder: {}", display(decoder, "reason"))
    } else if actual["kind"] == "unknown" {
        format!("unknown profile: {}", display(actual, "reason"))
    } else {
        format!(
            "{} / {}@{}",
            display(decoder, "value"),
            display(actual, "profileId"),
            display(actual, "profileRevision")
        )
    };
    entries.push(fact(
        "raw-profile",
        matched,
        expected,
        actual,
        if matched {
            "Decoder and profile selector matched."
        } else if !known && profile["kind"] != "unknown" {
            "Unknown decoder or profile facts require an explicit unknown selector."
        } else {
            "Decoder or profile differs."
        }
        .into(),
    ));
    let iso = &rule["iso"];
    let actual = &facts["iso"];
    let matched = if iso["kind"] == "unknown" {
        actual["kind"] == "unknown"
    } else {
        actual["kind"] == "known"
            && actual["value"].as_i64() >= iso["minimum"].as_i64()
            && actual["value"].as_i64() <= iso["maximum"].as_i64()
    };
    entries.push(fact(
        "iso",
        matched,
        if iso["kind"] == "unknown" {
            "explicit unknown ISO".into()
        } else {
            format!("{}-{} inclusive", iso["minimum"], iso["maximum"])
        },
        if actual["kind"] == "known" {
            actual["value"].to_string()
        } else {
            format!("unknown: {}", display(actual, "reason"))
        },
        if matched {
            "ISO selector matched."
        } else if actual["kind"] == "unknown" && iso["kind"] != "unknown" {
            "Unknown ISO requires an explicit unknown selector."
        } else {
            "ISO is outside the inclusive range."
        }
        .into(),
    ));
    let ref_id = store_io::text(&rule["preset"], "presetId")?;
    let revision = rule["preset"]["presetRevision"].as_u64().unwrap();
    let rejected = entries.iter().any(|v| v["matched"] != true);
    let preset = if rejected {
        None
    } else {
        presets.get_revision(ref_id, revision)
    };
    let missing: Vec<_> = rule["preset"]["selectedFields"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| {
            preset.as_ref().is_some_and(|p| {
                !p["fields"]
                    .as_array()
                    .is_some_and(|fields| fields.contains(f))
            })
        })
        .filter_map(Value::as_str)
        .collect();
    let matched = preset.is_some() && missing.is_empty();
    entries.push(fact(
        "preset",
        matched,
        format!("{ref_id}@{revision}"),
        if rejected {
            "not resolved".into()
        } else if preset.is_none() {
            "missing preset revision".into()
        } else {
            format!("{ref_id}@{revision}")
        },
        if rejected {
            "Preset was not resolved because the rule facts were rejected.".into()
        } else if preset.is_none() {
            "The referenced immutable preset revision is missing.".into()
        } else if !missing.is_empty() {
            format!(
                "Preset does not declare selected fields: {}.",
                missing.join(", ")
            )
        } else {
            "Preset revision and selected fields are available.".into()
        },
    ));
    let matched = entries.iter().all(|v| v["matched"] == true);
    let name = store_io::text(rule, "name")?;
    let summary = if matched {
        format!("Matched {name}.")
    } else {
        format!(
            "Rejected {name}: {}",
            entries
                .iter()
                .filter(|v| v["matched"] != true)
                .filter_map(|v| v["reason"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    Ok((
        if matched { preset } else { None },
        json!({"ruleId":rule["ruleId"],"ruleRevision":rule["revision"],"ruleName":rule["name"],"matched":matched,"summary":summary,"facts":entries}),
    ))
}
