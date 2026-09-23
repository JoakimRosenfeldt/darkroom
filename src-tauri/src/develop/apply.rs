use serde_json::{Map, Value, json};
use std::collections::HashSet;

fn num(v: &Value) -> Result<f64, String> {
    v.as_f64().ok_or("Preset number is invalid.".into())
}
fn array(v: &Value) -> Result<&Vec<Value>, String> {
    v.as_array().ok_or("Preset array is invalid.".into())
}

fn mask_sources<'a>(expression: &'a Value, sources: &mut Vec<&'a Value>) {
    match expression["kind"].as_str() {
        Some("source") => sources.push(&expression["source"]),
        Some("combine") => {
            mask_sources(&expression["left"], sources);
            mask_sources(&expression["right"], sources);
        }
        Some("invert") => mask_sources(&expression["child"], sources),
        _ => (),
    }
}

pub fn mask_class(mask: &Value) -> &'static str {
    let mut sources = vec![];
    mask_sources(&mask["expression"], &mut sources);
    if !sources.is_empty() && sources.iter().all(|v| v["kind"] == "ai-matte") {
        "ai"
    } else if !sources.is_empty()
        && sources
            .iter()
            .all(|v| v["kind"] != "ai-matte" && v["kind"] != "depth-range")
    {
        "manual"
    } else {
        "source-specific"
    }
}

fn asset_ids(v: &Value, result: &mut HashSet<String>) {
    match v {
        Value::Object(map) => {
            if let Some(id) = map.get("assetId").and_then(Value::as_str) {
                result.insert(id.to_owned());
            }
            for child in map.values() {
                asset_ids(child, result);
            }
        }
        Value::Array(items) => {
            for child in items {
                asset_ids(child, result);
            }
        }
        _ => (),
    }
}

fn curves(value: &Value) -> Result<Value, String> {
    let mut result = Map::new();
    for channel in ["rgb", "red", "green", "blue"] {
        let points = array(&value[channel])?;
        if points.len() < 2 {
            return Err("Tone curve needs at least two points.".into());
        }
        let mut samples = vec![];
        for i in 0..256 {
            let x = i as f64 / 255.0;
            let y = if x <= num(&points[0]["x"])? {
                num(&points[0]["y"])?
            } else if x >= num(&points.last().unwrap()["x"])? {
                num(&points.last().unwrap()["y"])?
            } else {
                let mut y = num(&points.last().unwrap()["y"])?;
                for pair in points.windows(2) {
                    let left = &pair[0];
                    let right = &pair[1];
                    if x <= num(&right["x"])? {
                        let span = num(&right["x"])? - num(&left["x"])?;
                        if span <= 0.0 {
                            return Err("Tone curve points are not ordered.".into());
                        }
                        let amount = (x - num(&left["x"])?) / span;
                        y = num(&left["y"])? + (num(&right["y"])? - num(&left["y"])?) * amount;
                        break;
                    }
                }
                y
            };
            samples.push(json!({"x":x,"y":y}));
        }
        result.insert(channel.into(), json!(samples));
    }
    Ok(Value::Object(result))
}

pub fn capture(
    document: &Value,
    fields: &[Value],
    source_id: &Value,
) -> Result<Vec<Value>, String> {
    fields.iter().map(|field|{
        let value=match field.as_str() {
            Some("basic")=>json!({"tone":document["tone"]["basic"],"global":document["color"]["global"],"whiteBalanceAdjustment":document["color"]["whiteBalance"]["adjustment"]}),
            Some("mixer")=>document["color"]["mixer"].clone(),
            Some("effects")=>json!({"presence":document["presence"],"noiseReduction":document["detail"]["noiseReduction"],"sharpening":document["detail"]["sharpening"],"postCrop":document["effects"]["postCrop"]}),
            Some("tone-curves")=>curves(&document["tone"]["curves"])? ,
            Some("camera-profile")=>document["color"]["inputProfile"].clone(),
            Some("crop")=>document["geometry"]["crop"].clone(),
            Some("manual-masks")=>json!(array(&document["local"]["masks"] )?.iter().filter(|m|mask_class(m)=="manual").collect::<Vec<_>>()),
            Some("ai-masks")=>{
                if !source_id.is_string(){return Err("AI mask provenance needs a SourceId.".into());}
                let masks:Vec<_>=array(&document["local"]["masks"] )?.iter().filter(|m|mask_class(m)=="ai").cloned().collect();
                let mut ids=HashSet::new();for mask in &masks {asset_ids(&mask["expression"],&mut ids);}
                json!({"sourceId":source_id,"masks":masks,"assetRefs":array(&document["local"]["maskAssetRefs"] )?.iter().filter(|v|v["assetId"].as_str().is_some_and(|id|ids.contains(id))).collect::<Vec<_>>()})
            },
            _=>return Err("Preset field is unsupported.".into()),
        };
        Ok(json!({"field":field,"value":value}))
    }).collect()
}

fn blend(left: &Value, right: &Value, amount: f64) -> Result<Value, String> {
    match (left, right) {
        (Value::Number(_), Value::Number(_)) => {
            Ok(json!(num(left)? + (num(right)? - num(left)?) * amount))
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => Ok(json!(
            a.iter()
                .zip(b)
                .map(|(a, b)| blend(a, b, amount))
                .collect::<Result<Vec<_>, _>>()?
        )),
        (Value::Object(a), Value::Object(b)) => {
            let mut result = Map::new();
            for (key, left) in a {
                result.insert(
                    key.clone(),
                    blend(
                        left,
                        b.get(key)
                            .ok_or("Blendable preset field shapes do not match.")?,
                        amount,
                    )?,
                );
            }
            Ok(Value::Object(result))
        }
        _ if left == right => Ok(left.clone()),
        _ => Err("Blendable preset field shapes do not match.".into()),
    }
}

fn manual_balance(adjustment: &Value) -> Result<Value, String> {
    let temperature = num(&adjustment["temperature"])?.clamp(-3000.0, 3000.0);
    let tint = num(&adjustment["tint"])?.clamp(-150.0, 150.0);
    Ok(
        json!({"temperatureKelvin":(5500.0+temperature).clamp(2000.0,50000.0).round(),"tint":tint,"gains":[2.0_f64.powf(temperature/3000.0).clamp(0.25,4.0),2.0_f64.powf(-tint/150.0).clamp(0.25,4.0),2.0_f64.powf(-temperature/3000.0).clamp(0.25,4.0)]}),
    )
}

pub fn apply_payload(mut document: Value, payload: &[Value]) -> Result<Value, String> {
    for entry in payload {
        let value = &entry["value"];
        match entry["field"].as_str() {
            Some("basic") => {
                let old = &document["color"]["whiteBalance"];
                let previous = manual_balance(&old["adjustment"])?;
                let next = manual_balance(&value["whiteBalanceAdjustment"])?;
                let gains = (0..3)
                    .map(|i| {
                        Ok(json!(
                            (num(&old["resolved"]["gains"][i])? * num(&next["gains"][i])?
                                / num(&previous["gains"][i])?)
                            .clamp(0.25, 4.0)
                        ))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let resolved = json!({"temperatureKelvin":(num(&old["resolved"]["temperatureKelvin"])?+num(&next["temperatureKelvin"])?-num(&previous["temperatureKelvin"])?).clamp(2000.0,50000.0).round(),"tint":(num(&old["resolved"]["tint"])?+num(&next["tint"])?-num(&previous["tint"])?).clamp(-150.0,150.0),"gains":gains});
                document["tone"]["basic"] = value["tone"].clone();
                document["color"]["global"] = value["global"].clone();
                document["color"]["whiteBalance"]["adjustment"] =
                    value["whiteBalanceAdjustment"].clone();
                document["color"]["whiteBalance"]["resolved"] = resolved;
            }
            Some("mixer") => document["color"]["mixer"] = value.clone(),
            Some("effects") => {
                document["presence"] = value["presence"].clone();
                document["detail"]["noiseReduction"] = value["noiseReduction"].clone();
                document["detail"]["sharpening"] = value["sharpening"].clone();
                document["effects"]["postCrop"] = value["postCrop"].clone();
            }
            Some("tone-curves") => document["tone"]["curves"] = value.clone(),
            Some("camera-profile") => document["color"]["inputProfile"] = value.clone(),
            Some("crop") => document["geometry"]["crop"] = value.clone(),
            Some("manual-masks" | "ai-masks") => {
                let ai = entry["field"] == "ai-masks";
                let class = if ai { "ai" } else { "manual" };
                let old = array(&document["local"]["masks"])?;
                let mut removed = HashSet::new();
                for mask in old.iter().filter(|m| mask_class(m) == class) {
                    asset_ids(&mask["expression"], &mut removed);
                }
                let mut masks: Vec<_> = old
                    .iter()
                    .filter(|m| mask_class(m) != class)
                    .cloned()
                    .collect();
                masks.extend(
                    array(if ai { &value["masks"] } else { value })?
                        .iter()
                        .cloned(),
                );
                document["local"]["masks"] = json!(masks);
                if ai {
                    let mut refs: Vec<_> = array(&document["local"]["maskAssetRefs"])?
                        .iter()
                        .filter(|v| !v["assetId"].as_str().is_some_and(|id| removed.contains(id)))
                        .cloned()
                        .collect();
                    for item in array(&value["assetRefs"])? {
                        if let Some(existing) =
                            refs.iter_mut().find(|r| r["assetId"] == item["assetId"])
                        {
                            *existing = item.clone();
                        } else {
                            refs.push(item.clone());
                        }
                    }
                    document["local"]["maskAssetRefs"] = json!(refs);
                }
            }
            _ => return Err("Preset field is unsupported.".into()),
        }
    }
    Ok(document)
}

fn equivalent(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b)))
        }
        _ => left == right,
    }
}

pub fn reset_fields(
    mut document: Value,
    fields: &[Value],
    source_id: &Value,
    context: &Value,
) -> Result<Value, String> {
    let default: Value =
        serde_json::from_str(include_str!("default-document.json")).map_err(|e| e.to_string())?;
    let mut payload = capture(&default, fields, source_id)?;
    let mut warnings = Vec::new();
    payload.retain(|entry| {
        if entry["field"] == "camera-profile"
            && (context["kind"] != "available-before-tone"
                || context["decoderDefault"]["selection"]["kind"] != "decoder-default")
        {
            warnings.push(json!(
                "camera-profile: Decoder-default profile is unavailable for this target."
            ));
            false
        } else {
            true
        }
    });
    for entry in &mut payload {
        if entry["field"] == "camera-profile" {
            entry["value"] = context["decoderDefault"].clone();
        }
        if entry["field"] == "tone-curves" {
            entry["value"] = default["tone"]["curves"].clone();
        }
    }
    document = apply_payload(document, &payload)?;
    let mut retained = HashSet::new();
    for mask in array(&document["local"]["masks"])? {
        asset_ids(&mask["expression"], &mut retained);
    }
    let refs: Vec<_> = array(&document["local"]["maskAssetRefs"])?
        .iter()
        .filter(|reference| {
            reference["assetId"]
                .as_str()
                .is_some_and(|id| retained.contains(id))
        })
        .cloned()
        .collect();
    document["local"]["maskAssetRefs"] = json!(refs);
    Ok(json!({"kind":"changed","document":document,"warnings":warnings}))
}

fn compatible_profile(target: &Value, context: &Value) -> bool {
    let available = &context["cameraProfile"];
    if target["selection"]["kind"] == "unavailable" || available["kind"] != "available-before-tone"
    {
        return false;
    }
    if target["selection"]["kind"] == "decoder-default" {
        let default = &available["decoderDefault"];
        return default["selection"]["kind"] == "decoder-default"
            && default["registryRevision"] == target["registryRevision"]
            && equivalent(&default["calibration"], &target["calibration"]);
    }
    available["compatibleProfiles"]
        .as_array()
        .is_some_and(|profiles| {
            profiles.iter().any(|p| {
                p["selection"] == target["selection"]
                    && p["registryRevision"] == target["registryRevision"]
                    && equivalent(&p["calibration"], &target["calibration"])
            })
        })
}

pub fn apply_preset(
    document: &Value,
    preset: &Value,
    selection: Option<&[Value]>,
    amount: f64,
    context: &Value,
) -> Result<Value, String> {
    if !amount.is_finite() || !(0.0..=100.0).contains(&amount) {
        return Err("Preset Amount must be between 0 and 100.".into());
    }
    super::presets::validate(preset)?;
    let declared = array(&preset["fields"])?;
    let selected = selection.unwrap_or(declared);
    let mut seen = HashSet::new();
    if selected
        .iter()
        .any(|v| !declared.contains(v) || !v.as_str().is_some_and(|v| seen.insert(v)))
    {
        return Err("Preset field selection contains undeclared fields or duplicates.".into());
    }
    let mut skipped: Vec<_> = declared
        .iter()
        .filter(|f| !selected.contains(f))
        .map(|f| json!({"field":f,"reason":"Field was not selected."}))
        .collect();
    let mut unsupported = vec![];
    let mut regeneration = vec![];
    let mut supported = vec![];
    for field in selected {
        let mut entry = array(&preset["payload"])?
            .iter()
            .find(|e| &e["field"] == field)
            .cloned()
            .ok_or("Preset payload is incomplete.")?;
        let value = &entry["value"];
        if field == "manual-masks" && array(value)?.is_empty() {
            skipped.push(
                json!({"field":field,"reason":"The source has no transferable manual masks."}),
            );
            continue;
        }
        if field == "ai-masks" && array(&value["masks"])?.is_empty() {
            skipped
                .push(json!({"field":field,"reason":"The source has no transferable AI masks."}));
            continue;
        }
        if field == "camera-profile" && !compatible_profile(value, context) {
            unsupported.push(json!({"field":field,"reason":"Camera profile is not compatible with this source."}));
            continue;
        }
        if field == "ai-masks" && value["sourceId"] != context["sourceId"] {
            if context["regenerateAiMasks"] == true {
                regeneration.push(json!({"field":field,"reason":"AI masks require regeneration for this source."}));
                skipped.push(json!({"field":field,"reason":"AI masks were not applied until regeneration completes."}));
            } else {
                unsupported
                    .push(json!({"field":field,"reason":"AI masks belong to another source."}));
            }
            continue;
        }
        if field == "manual-masks" || field == "ai-masks" {
            let class = if field == "manual-masks" {
                "manual"
            } else {
                "ai"
            };
            let preserved: HashSet<_> = array(&document["local"]["masks"])?
                .iter()
                .filter(|m| mask_class(m) != class)
                .map(|m| m["id"].as_str())
                .collect();
            if array(if field == "manual-masks" {
                value
            } else {
                &value["masks"]
            })?
            .iter()
            .any(|m| preserved.contains(&m["id"].as_str()))
            {
                skipped.push(json!({"field":field,"reason":"Mask IDs conflict with masks preserved on the target."}));
                continue;
            }
        }
        if field == "tone-curves" {
            entry["value"] = curves(&curves(value)?)?;
        }
        supported.push(entry);
    }
    let fields: Vec<_> = supported.iter().map(|e| e["field"].clone()).collect();
    let report = json!({"included":fields,"unsupported":unsupported,"skipped":skipped,"regenerationRequests":regeneration});
    if supported.is_empty() {
        return Ok(json!({"document":document,"report":report}));
    }
    let baseline = capture(document, &fields, &context["sourceId"])?;
    let mut expanded = vec![];
    for (left, right) in baseline.iter().zip(&supported) {
        let entry = if matches!(
            left["field"].as_str(),
            Some("basic" | "mixer" | "effects" | "tone-curves")
        ) {
            let (left_value, right_value) = if left["field"] == "tone-curves" {
                (curves(&left["value"])?, curves(&right["value"])?)
            } else {
                (left["value"].clone(), right["value"].clone())
            };
            json!({"field":left["field"],"value":blend(&left_value,&right_value,amount/100.0)?})
        } else if amount == 100.0 {
            right.clone()
        } else {
            left.clone()
        };
        expanded.push(entry);
    }
    let mut result = apply_payload(document.clone(), &expanded)?;
    result["appliedPreset"] = json!({"presetId":preset["presetId"],"revision":preset["revision"],"amount":amount,"includedFields":fields,"baseline":baseline,"target":supported,"lastExpanded":expanded,"linkState":"linked"});
    Ok(json!({"document":result,"report":report}))
}
