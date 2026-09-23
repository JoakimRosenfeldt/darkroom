use super::store_io::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

const FILE_LIMIT: usize = 2 * 1024 * 1024;
const STORE_LIMIT: usize = 256 * 1024 * 1024;
const RECORD_LIMIT: usize = 10_000;
const TTL: u64 = 15 * 60 * 1000;
struct Pending {
    preset: Value,
    hash: String,
    filename: String,
    created: u64,
}
pub struct PresetStore {
    root: PathBuf,
    manifest: Value,
    builtins: Vec<Value>,
    pending: HashMap<String, Pending>,
}

fn id(value: &Value) -> Result<&str, String> {
    let s = value.as_str().ok_or("Preset ID is invalid.")?;
    let parsed = uuid::Uuid::parse_str(s).map_err(|_| "Preset ID is invalid.")?;
    if s.len() != 36
        || !(1..=8).contains(&parsed.get_version_num())
        || parsed.get_variant() != uuid::Variant::RFC4122
    {
        return Err("Preset ID is invalid.".into());
    }
    Ok(s)
}
fn bounded(v: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
    *nodes += 1;
    if depth > 16 || *nodes > 100_000 {
        return Err("Preset exceeds its structural limits.".into());
    }
    match v {
        Value::Array(a) => {
            for v in a {
                bounded(v, depth + 1, nodes)?
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                bounded(v, depth + 1, nodes)?
            }
        }
        _ => {}
    }
    Ok(())
}
fn finite(v: &Value, min: f64, max: f64) -> Result<f64, String> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max)
        .ok_or_else(|| "Preset number is out of range.".into())
}
fn numbers(v: &Value, fields: &[(&str, f64, f64)]) -> Result<(), String> {
    object_keys(v, &fields.iter().map(|f| f.0).collect::<Vec<_>>())?;
    for (k, min, max) in fields {
        finite(&v[k], *min, *max)?;
    }
    Ok(())
}
fn strings(v: &Value, keys: &[&str]) -> Result<(), String> {
    for k in keys {
        if text(v, k)?.trim().is_empty() || text(v, k)?.len() > 256 {
            return Err(format!("Preset {k} is invalid."));
        }
    }
    Ok(())
}
fn tuple(v: &Value, n: usize, min: f64, max: f64) -> Result<(), String> {
    let a = v
        .as_array()
        .filter(|a| a.len() == n)
        .ok_or("Preset tuple length is invalid.")?;
    for x in a {
        finite(x, min, max)?;
    }
    Ok(())
}
fn boolean(v: &Value) -> Result<(), String> {
    if v.is_boolean() {
        Ok(())
    } else {
        Err("Preset boolean is invalid.".into())
    }
}
fn mask_text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    let s = text(v, key)?;
    if s.len() > 4096 {
        return Err("Mask text exceeds its limit.".into());
    }
    Ok(s)
}
fn asset_ref(v: &Value) -> Result<(), String> {
    object_keys(
        v,
        &[
            "assetId",
            "kind",
            "sha256",
            "producerRevision",
            "coordinateFrameRevision",
            "colorStageId",
        ],
    )?;
    let hash = text(v, "sha256")?;
    if !valid_hash(hash)
        || v["assetId"] != hash
        || v["kind"] != "mask-matte"
        || v["coordinateFrameRevision"] != "oriented-source-normalized-bottom-left-v1"
    {
        return Err("Preset mask asset reference is invalid.".into());
    }
    strings(v, &["producerRevision"])?;
    let stages = [
        "decode-and-orientation",
        "wb-and-input-profile",
        "optics",
        "standard-denoise",
        "canonical-geometry",
        "source-repair",
        "basic-tone",
        "curve-and-color",
        "local-adjustments",
        "presence",
        "creative-spatial-effect",
        "develop-sharpening",
        "post-crop-effects",
        "resize-and-tile-assembly",
        "output-or-proof-transform",
        "analysis-overlays-and-encode",
    ];
    if !stages.contains(&text(v, "colorStageId")?) {
        return Err("Preset mask color stage is invalid.".into());
    }
    Ok(())
}
#[derive(Default)]
struct MaskBudget {
    nodes: HashSet<String>,
    strokes: usize,
    points: usize,
}
fn expression(
    v: &Value,
    ai: bool,
    budget: &mut MaskBudget,
    embedded: &mut Vec<Value>,
) -> Result<(), String> {
    if !budget.nodes.insert(mask_text(v, "id")?.into()) || budget.nodes.len() > 256 {
        return Err("Mask nodes exceed their limit or contain duplicate IDs.".into());
    }
    boolean(&v["enabled"])?;
    match v["kind"].as_str() {
        Some("source") => {
            object_keys(v, &["kind", "id", "enabled", "source"])?;
            let s = &v["source"];
            let kind = text(s, "kind")?;
            if (ai && kind != "ai-matte") || (!ai && ["ai-matte", "depth-range"].contains(&kind)) {
                return Err("Preset mask source is unsupported.".into());
            }
            match kind {
                "brush" => {
                    object_keys(s, &["kind", "strokes", "autoMask"])?;
                    let strokes = s["strokes"]
                        .as_array()
                        .filter(|a| !a.is_empty())
                        .ok_or("Brush strokes are missing.")?;
                    budget.strokes += strokes.len();
                    if budget.strokes > 4096 {
                        return Err("Brush stroke limit exceeded.".into());
                    }
                    for stroke in strokes {
                        object_keys(stroke, &["points", "size", "feather", "flow", "density"])?;
                        for key in ["size", "feather", "flow", "density"] {
                            finite(&stroke[key], 0., 1.)?;
                        }
                        let points = stroke["points"]
                            .as_array()
                            .filter(|a| !a.is_empty() && a.len() <= 8192)
                            .ok_or("Brush points are invalid.")?;
                        budget.points += points.len();
                        if budget.points > 65536 {
                            return Err("Brush point limit exceeded.".into());
                        }
                        for point in points {
                            numbers(point, &[("x", 0., 1.), ("y", 0., 1.)])?;
                        }
                    }
                    let a = &s["autoMask"];
                    match a["kind"].as_str() {
                        Some("off") => object_keys(a, &["kind"])?,
                        Some("auto-mask-prototype-v1") => {
                            object_keys(
                                a,
                                &["kind", "samplePolicy", "samples", "radius", "algorithm"],
                            )?;
                            if !["first-stroke-point", "explicit-working-rgb"]
                                .contains(&text(a, "samplePolicy")?)
                                || a["algorithm"] != "analysis-color-edge-v1"
                            {
                                return Err("Auto Mask policy is invalid.".into());
                            }
                            let samples = a["samples"]
                                .as_array()
                                .filter(|a| a.len() <= 16)
                                .ok_or("Auto Mask samples are invalid.")?;
                            for sample in samples {
                                tuple(sample, 3, 0., 1.)?;
                            }
                            finite(&a["radius"], 0.001, 1.)?;
                        }
                        _ => return Err("Auto Mask kind is invalid.".into()),
                    }
                }
                "linear-gradient" => {
                    object_keys(s, &["kind", "start", "end"])?;
                    for key in ["start", "end"] {
                        numbers(&s[key], &[("x", 0., 1.), ("y", 0., 1.)])?;
                    }
                }
                "radial-gradient" => {
                    object_keys(
                        s,
                        &[
                            "kind", "center", "radiusX", "radiusY", "rotation", "feather",
                        ],
                    )?;
                    numbers(&s["center"], &[("x", 0., 1.), ("y", 0., 1.)])?;
                    finite(&s["radiusX"], 0.0001, 2.)?;
                    finite(&s["radiusY"], 0.0001, 2.)?;
                    finite(&s["rotation"], -360., 360.)?;
                    finite(&s["feather"], 0., 1.)?;
                }
                "luminance-range" => {
                    object_keys(s, &["kind", "minimum", "maximum", "feather", "algorithm"])?;
                    if s["algorithm"] != "linear-rec709-v1"
                        || finite(&s["minimum"], 0., 1.)? > finite(&s["maximum"], 0., 1.)?
                    {
                        return Err("Luminance range is invalid.".into());
                    }
                    finite(&s["feather"], 0., 1.)?;
                }
                "color-range" => {
                    object_keys(s, &["kind", "samples", "tolerance", "feather", "algorithm"])?;
                    if s["algorithm"] != "working-rgb-distance-v1" {
                        return Err("Color range algorithm is invalid.".into());
                    }
                    let samples = s["samples"]
                        .as_array()
                        .filter(|a| !a.is_empty() && a.len() <= 16)
                        .ok_or("Color samples are invalid.")?;
                    for sample in samples {
                        tuple(sample, 3, 0., 1.)?;
                    }
                    finite(&s["tolerance"], 0.001, 2.)?;
                    finite(&s["feather"], 0., 1.)?;
                }
                "ai-matte" => {
                    object_keys(
                        s,
                        &["kind", "selector", "asset", "model", "source", "threshold"],
                    )?;
                    if !["subject", "sky"].contains(&text(s, "selector")?) {
                        return Err("AI selector is invalid.".into());
                    }
                    asset_ref(&s["asset"])?;
                    embedded.push(s["asset"].clone());
                    object_keys(&s["model"], &["id", "revision"])?;
                    mask_text(&s["model"], "id")?;
                    mask_text(&s["model"], "revision")?;
                    let signature = &s["source"];
                    object_keys(
                        signature,
                        &[
                            "entryId",
                            "catalogId",
                            "assetRevision",
                            "relativePath",
                            "size",
                            "lastModified",
                        ],
                    )?;
                    for key in ["entryId", "relativePath"] {
                        mask_text(signature, key)?;
                    }
                    if signature.get("catalogId").is_some() {
                        mask_text(signature, "catalogId")?;
                    }
                    for key in ["assetRevision", "size", "lastModified"] {
                        if key != "assetRevision" || signature.get(key).is_some() {
                            finite(&signature[key], 0., 9_007_199_254_740_991.)?;
                        }
                    }
                    finite(&s["threshold"], 0., 1.)?;
                }
                _ => return Err("Preset mask source is invalid.".into()),
            }
        }
        Some("combine") => {
            object_keys(v, &["kind", "id", "enabled", "operation", "left", "right"])?;
            if !["add", "subtract", "intersect"].contains(&text(v, "operation")?) {
                return Err("Mask operation is invalid.".into());
            }
            expression(&v["left"], ai, budget, embedded)?;
            expression(&v["right"], ai, budget, embedded)?
        }
        Some("invert") => {
            object_keys(v, &["kind", "id", "enabled", "child"])?;
            expression(&v["child"], ai, budget, embedded)?;
        }
        _ => return Err("Preset mask expression is invalid.".into()),
    }
    Ok(())
}
fn masks(v: &Value, ai: bool) -> Result<Vec<Value>, String> {
    let a = v
        .as_array()
        .filter(|a| a.len() <= 64)
        .ok_or("Preset masks exceed their limit.")?;
    let mut ids = HashSet::new();
    let mut embedded = vec![];
    for mask in a {
        object_keys(
            mask,
            &["id", "name", "enabled", "expression", "adjustments"],
        )?;
        if !ids.insert(mask_text(mask, "id")?) {
            return Err("Preset mask IDs are duplicated.".into());
        }
        mask_text(mask, "name")?;
        boolean(&mask["enabled"])?;
        expression(
            &mask["expression"],
            ai,
            &mut MaskBudget::default(),
            &mut embedded,
        )?;
        let a = &mask["adjustments"];
        object_keys(
            a,
            &[
                "basic",
                "texture",
                "clarity",
                "sharpness",
                "noise",
                "moire",
                "defringe",
                "colorize",
            ],
        )?;
        numbers(
            &a["basic"],
            &[
                ("exposure", -5., 5.),
                ("contrast", -100., 100.),
                ("highlights", -100., 100.),
                ("shadows", -100., 100.),
                ("whites", -100., 100.),
                ("blacks", -100., 100.),
                ("temperature", -100., 100.),
                ("tint", -100., 100.),
                ("vibrance", -100., 100.),
                ("saturation", -100., 100.),
            ],
        )?;
        for key in ["texture", "clarity"] {
            finite(&a[key], -100., 100.)?;
        }
        for key in ["sharpness", "noise", "moire", "defringe"] {
            finite(&a[key], 0., 100.)?;
        }
        object_keys(&a["colorize"], &["color", "amount"])?;
        tuple(&a["colorize"]["color"], 3, 0., 1.)?;
        finite(&a["colorize"]["amount"], 0., 100.)?;
    }
    Ok(embedded)
}
fn payload(field: &str, v: &Value) -> Result<(), String> {
    match field {
        "basic" => {
            object_keys(v, &["tone", "global", "whiteBalanceAdjustment"])?;
            numbers(
                &v["tone"],
                &[
                    ("exposure", -5., 5.),
                    ("contrast", -100., 100.),
                    ("highlights", -100., 100.),
                    ("shadows", -100., 100.),
                    ("whites", -100., 100.),
                    ("blacks", -100., 100.),
                ],
            )?;
            numbers(
                &v["global"],
                &[("vibrance", -100., 100.), ("saturation", -100., 100.)],
            )?;
            numbers(
                &v["whiteBalanceAdjustment"],
                &[("temperature", -3000., 3000.), ("tint", -150., 150.)],
            )?;
        }
        "mixer" => {
            let colors = [
                "red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta",
            ];
            object_keys(v, &colors)?;
            for c in colors {
                numbers(
                    &v[c],
                    &[
                        ("hue", -100., 100.),
                        ("saturation", -100., 100.),
                        ("luminance", -100., 100.),
                    ],
                )?;
            }
        }
        "effects" => {
            object_keys(v, &["presence", "noiseReduction", "sharpening", "postCrop"])?;
            numbers(
                &v["presence"],
                &[
                    ("texture", -100., 100.),
                    ("clarity", -100., 100.),
                    ("dehaze", -100., 100.),
                ],
            )?;
            numbers(
                &v["noiseReduction"],
                &[
                    ("noiseReduction", 0., 100.),
                    ("noiseDetail", 0., 100.),
                    ("noiseContrast", 0., 100.),
                    ("colorNoiseReduction", 0., 100.),
                    ("colorNoiseDetail", 0., 100.),
                    ("colorNoiseSmoothness", 0., 100.),
                ],
            )?;
            numbers(
                &v["sharpening"],
                &[
                    ("sharpening", 0., 100.),
                    ("sharpenRadius", 0.5, 3.),
                    ("sharpenDetail", 0., 100.),
                    ("sharpenMasking", 0., 100.),
                ],
            )?;
            numbers(
                &v["postCrop"],
                &[
                    ("vignette", -100., 100.),
                    ("vignetteMidpoint", 0., 100.),
                    ("vignetteRoundness", -100., 100.),
                    ("vignetteFeather", 0., 100.),
                    ("vignetteHighlights", 0., 100.),
                    ("grain", 0., 100.),
                    ("grainSize", 0., 100.),
                    ("grainRoughness", 0., 100.),
                ],
            )?;
        }
        "tone-curves" => {
            object_keys(v, &["rgb", "red", "green", "blue"])?;
            for c in ["rgb", "red", "green", "blue"] {
                let a = v[c]
                    .as_array()
                    .filter(|a| (2..=256).contains(&a.len()))
                    .ok_or("Preset curve is invalid.")?;
                let mut last = -1.;
                for p in a {
                    numbers(p, &[("x", 0., 1.), ("y", 0., 1.)])?;
                    let x = p["x"].as_f64().unwrap();
                    if x <= last {
                        return Err("Preset curve x values must increase.".into());
                    }
                    last = x;
                }
            }
        }
        "camera-profile" => {
            object_keys(v, &["registryRevision", "selection", "calibration"])?;
            strings(v, &["registryRevision"])?;
            let s = &v["selection"];
            match s["kind"].as_str() {
                Some("decoder-default") => object_keys(s, &["kind"])?,
                Some("selected") => {
                    object_keys(s, &["kind", "profileId", "profileRevision"])?;
                    strings(s, &["profileId", "profileRevision"])?;
                }
                Some("unavailable") => {
                    object_keys(s, &["kind", "reason"])?;
                    text(s, "reason")?;
                }
                _ => return Err("Preset profile selection is invalid.".into()),
            }
            let c = &v["calibration"];
            object_keys(
                c,
                &["matrixToLinearSrgb", "channelScale", "exposureOffsetEv"],
            )?;
            tuple(&c["matrixToLinearSrgb"], 9, -16., 16.)?;
            tuple(&c["channelScale"], 3, 0.0625, 16.)?;
            finite(&c["exposureOffsetEv"], -8., 8.)?;
        }
        "crop" => {
            object_keys(
                v,
                &[
                    "enabled",
                    "x",
                    "y",
                    "width",
                    "height",
                    "aspectPreset",
                    "customAspectWidth",
                    "customAspectHeight",
                ],
            )?;
            if !v["enabled"].is_boolean() {
                return Err("Crop enabled is invalid.".into());
            }
            let x = finite(&v["x"], 0., 1.)?;
            let y = finite(&v["y"], 0., 1.)?;
            let w = finite(&v["width"], 0.05, 1.)?;
            let h = finite(&v["height"], 0.05, 1.)?;
            if x + w > 1. || y + h > 1. {
                return Err("Crop exceeds normalized bounds.".into());
            }
            if ![
                "original", "free", "1:1", "4:3", "3:2", "16:9", "5:4", "2:3", "9:16", "custom",
            ]
            .contains(&text(v, "aspectPreset")?)
            {
                return Err("Crop aspect preset is invalid.".into());
            }
            finite(&v["customAspectWidth"], 0.01, 1000.)?;
            finite(&v["customAspectHeight"], 0.01, 1000.)?;
        }
        "manual-masks" => {
            masks(v, false)?;
        }
        "ai-masks" => {
            object_keys(v, &["sourceId", "masks", "assetRefs"])?;
            id(&v["sourceId"])?;
            let embedded = masks(&v["masks"], true)?;
            let refs = v["assetRefs"]
                .as_array()
                .filter(|a| a.len() <= 256)
                .ok_or("Preset asset refs are invalid.")?;
            let mut ids = HashSet::new();
            for a in refs {
                asset_ref(a)?;
                if !ids.insert(text(a, "assetId")?) {
                    return Err("Preset asset references are duplicated.".into());
                }
            }
            let used: HashSet<_> = embedded
                .iter()
                .map(|a| a["assetId"].as_str().unwrap())
                .collect();
            if used.len() != refs.len() || embedded.iter().any(|a| !refs.contains(a)) {
                return Err("Preset asset references do not match the masks.".into());
            }
        }
        _ => return Err("Preset field is unsupported.".into()),
    }
    Ok(())
}
pub fn validate(p: &Value) -> Result<(), String> {
    bounded(p, 0, &mut 0)?;
    if serde_json::to_vec(p).map_err(|e| e.to_string())?.len() > FILE_LIMIT {
        return Err("Preset exceeds its byte limit.".into());
    }
    object_keys(
        p,
        &[
            "schemaVersion",
            "presetId",
            "revision",
            "name",
            "author",
            "category",
            "source",
            "favorite",
            "fields",
            "payload",
            "compatibility",
        ],
    )?;
    if p["schemaVersion"] != 1
        || p["revision"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
            .is_none()
        || !p["favorite"].is_boolean()
    {
        return Err("Preset record is invalid.".into());
    }
    id(&p["presetId"])?;
    strings(p, &["name", "author", "category"])?;
    if !["user", "imported", "built-in"].contains(&text(p, "source")?) {
        return Err("Preset source is invalid.".into());
    }
    object_keys(&p["compatibility"], &["process", "documentSchemaRevision"])?;
    if p["compatibility"]["process"] != "darkroom-v3"
        || p["compatibility"]["documentSchemaRevision"] != "darkroom-v3-document-2"
    {
        return Err("Preset compatibility is unsupported.".into());
    }
    let fields = p["fields"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 8)
        .ok_or("Preset fields are invalid.")?;
    let entries = p["payload"]
        .as_array()
        .filter(|a| a.len() == fields.len())
        .ok_or("Preset payload does not match fields.")?;
    let mut seen = HashSet::new();
    for f in fields {
        let f = f.as_str().ok_or("Preset field is invalid.")?;
        if !seen.insert(f) {
            return Err("Preset fields are duplicated.".into());
        }
        let e = entries
            .iter()
            .find(|e| e["field"] == f)
            .ok_or("Preset field is missing.")?;
        object_keys(e, &["field", "value"])?;
        payload(f, &e["value"])?;
    }
    Ok(())
}
impl PresetStore {
    pub fn new(app_data: &Path) -> Result<Self, String> {
        let root = app_data.join("develop-presets");
        directory(&root.join("imports"))?;
        let path = root.join("manifest.json");
        let mut manifest = if path.exists() {
            read_json(&path, STORE_LIMIT)?
        } else {
            json!({"version":1,"records":[],"builtInFavorites":[],"deletedPresetIds":[]})
        };
        if manifest["deletedPresetIds"].is_null() {
            manifest["deletedPresetIds"] = json!([])
        }
        let builtins: Vec<Value> = serde_json::from_str(include_str!("built-in-presets.json"))
            .map_err(|e| e.to_string())?;
        let store = Self {
            root,
            manifest,
            builtins,
            pending: HashMap::new(),
        };
        store.check(&store.manifest)?;
        let hashes: HashSet<_> = store
            .records()
            .iter()
            .filter_map(|v| v["importedSourceSha256"].as_str())
            .collect();
        for hash in &hashes {
            let b = read(
                &store.root.join("imports").join(format!("{hash}.json")),
                FILE_LIMIT,
            )?;
            if digest(&b) != *hash {
                return Err("Stored preset source copy is corrupt.".into());
            }
        }
        for e in fs::read_dir(store.root.join("imports")).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let name = e.file_name().to_string_lossy().to_string();
            let hash = name.strip_suffix(".json").unwrap_or("");
            if valid_hash(hash) && !hashes.contains(hash) {
                fs::remove_file(e.path()).map_err(|e| e.to_string())?;
            }
        }
        if !path.exists() {
            store.write(&store.manifest)?;
        }
        Ok(store)
    }
    fn records(&self) -> &Vec<Value> {
        self.manifest["records"].as_array().unwrap()
    }
    fn latest(&self, preset_id: &str) -> Option<&Value> {
        self.records()
            .iter()
            .filter(|v| v["preset"]["presetId"] == preset_id)
            .max_by_key(|v| v["preset"]["revision"].as_u64())
    }
    fn builtin(&self, preset_id: &str) -> Option<&Value> {
        self.builtins.iter().find(|v| v["presetId"] == preset_id)
    }
    fn deleted(&self, preset_id: &str) -> bool {
        self.manifest["deletedPresetIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == preset_id)
    }
    fn check(&self, m: &Value) -> Result<(), String> {
        if m["version"] != 1 {
            return Err("Preset manifest version is unsupported.".into());
        }
        let records = m["records"]
            .as_array()
            .filter(|a| a.len() <= RECORD_LIMIT)
            .ok_or("Preset record limit exceeded.")?;
        let mut seen = HashSet::new();
        for r in records {
            validate(&r["preset"])?;
            let key = format!("{}:{}", r["preset"]["presetId"], r["preset"]["revision"]);
            if !seen.insert(key) {
                return Err("Preset revisions are duplicated.".into());
            }
            let hash = r["importedSourceSha256"].as_str();
            if (r["preset"]["source"] == "imported") != hash.is_some()
                || hash.is_some() != r["importedFileName"].is_string()
            {
                return Err("Preset source metadata is invalid.".into());
            }
            if let Some(h) = hash {
                if !valid_hash(h) {
                    return Err("Preset hash is invalid.".into());
                }
            }
        }
        for key in ["builtInFavorites", "deletedPresetIds"] {
            let list = m[key].as_array().ok_or("Preset IDs are invalid.")?;
            let mut ids = HashSet::new();
            for v in list {
                let s = id(v)?;
                if !ids.insert(s) {
                    return Err("Preset IDs are duplicated.".into());
                }
                if key == "builtInFavorites" && self.builtin(s).is_none() {
                    return Err("Unknown built-in favorite.".into());
                }
            }
        }
        Ok(())
    }
    fn write(&self, m: &Value) -> Result<(), String> {
        self.check(m)?;
        let mut bytes = serde_json::to_vec(m).map_err(|e| e.to_string())?.len() as u64;
        for entry in fs::read_dir(self.root.join("imports")).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if !valid_hash(name.strip_suffix(".json").unwrap_or(""))
                || !meta.is_file()
                || meta.len() > FILE_LIMIT as u64
            {
                return Err("Preset import store contains an invalid file.".into());
            }
            bytes += meta.len();
        }
        if bytes > STORE_LIMIT as u64 {
            return Err("Preset store exceeds its aggregate byte limit.".into());
        }
        atomic_json(&self.root.join("manifest.json"), m, STORE_LIMIT)
    }
    fn save(&mut self, m: Value) -> Result<(), String> {
        self.write(&m)?;
        self.manifest = m;
        Ok(())
    }
    pub fn list(&self, search: &Value) -> Result<Value, String> {
        let query = search["query"].as_str().unwrap_or("").trim().to_lowercase();
        let category = search["category"].as_str();
        let favorites = search["favoriteOnly"].as_bool().unwrap_or(false);
        let mut latest = BTreeMap::new();
        for p in &self.builtins {
            let mut p = p.clone();
            p["favorite"] = json!(
                self.manifest["builtInFavorites"]
                    .as_array()
                    .unwrap()
                    .contains(&p["presetId"])
            );
            latest.insert(p["presetId"].as_str().unwrap().to_owned(), p);
        }
        for r in self.records() {
            let p = &r["preset"];
            let id = p["presetId"].as_str().unwrap();
            if latest
                .get(id)
                .is_none_or(|v| p["revision"].as_u64() > v["revision"].as_u64())
            {
                latest.insert(id.to_owned(), p.clone());
            }
        }
        let mut list: Vec<_> = latest
            .into_values()
            .filter(|p| {
                !self.deleted(p["presetId"].as_str().unwrap())
                    && category.is_none_or(|c| p["category"] == c)
                    && (!favorites || p["favorite"] == true)
                    && (query.is_empty()
                        || format!(
                            "{}\n{}\n{}",
                            p["name"].as_str().unwrap(),
                            p["author"].as_str().unwrap(),
                            p["category"].as_str().unwrap()
                        )
                        .to_lowercase()
                        .contains(&query))
            })
            .collect();
        list.sort_by(|a, b| {
            a["name"]
                .as_str()
                .cmp(&b["name"].as_str())
                .then(a["presetId"].as_str().cmp(&b["presetId"].as_str()))
        });
        Ok(json!(list))
    }
    pub fn get_revision(&self, preset_id: &str, revision: u64) -> Option<Value> {
        self.records()
            .iter()
            .map(|r| &r["preset"])
            .chain(self.builtins.iter())
            .find(|p| p["presetId"] == preset_id && p["revision"].as_u64() == Some(revision))
            .cloned()
    }
    pub fn handle(&mut self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let v = args.first().unwrap_or(&Value::Null);
        match channel {
            "darkroom:develop-presets-list" => self.list(v),
            "darkroom:develop-presets-create" | "darkroom:develop-presets-update" => {
                validate(v)?;
                let pid = text(v, "presetId")?;
                let create = channel.ends_with("-create");
                let current = self.latest(pid);
                if create {
                    if v["source"] != "user"
                        || v["revision"] != 1
                        || current.is_some()
                        || self.builtin(pid).is_some()
                    {
                        return Err("New preset identity or revision is invalid.".into());
                    }
                } else {
                    let c = current.ok_or("Preset is missing.")?;
                    if self.deleted(pid)
                        || v["source"] == "built-in"
                        || v["source"] != c["preset"]["source"]
                        || v["revision"].as_u64()
                            != Some(c["preset"]["revision"].as_u64().unwrap() + 1)
                    {
                        return Err("Preset revision is stale or immutable.".into());
                    }
                }
                let record = json!({"preset":v,"importedSourceSha256":current.map(|r|r["importedSourceSha256"].clone()),"importedFileName":current.map(|r|r["importedFileName"].clone())});
                let mut m = self.manifest.clone();
                m["records"].as_array_mut().unwrap().push(record);
                self.save(m)?;
                Ok(v.clone())
            }
            "darkroom:develop-presets-favorite" => {
                let pid = id(&v["presetId"])?;
                let favorite = v["favorite"]
                    .as_bool()
                    .ok_or("Preset favorite is invalid.")?;
                if self.deleted(pid) {
                    return Err("Preset is deleted.".into());
                }
                let mut m = self.manifest.clone();
                if let Some(current) = self.latest(pid) {
                    let mut record = current.clone();
                    let mut p = record["preset"].clone();
                    if p["favorite"] == favorite {
                        return Ok(p);
                    }
                    p["favorite"] = json!(favorite);
                    p["revision"] = json!(p["revision"].as_u64().unwrap() + 1);
                    record["preset"] = p.clone();
                    m["records"].as_array_mut().unwrap().push(record);
                    self.save(m)?;
                    Ok(p)
                } else {
                    let mut p = self.builtin(pid).ok_or("Preset is missing.")?.clone();
                    let f = m["builtInFavorites"].as_array_mut().unwrap();
                    f.retain(|v| v != pid);
                    if favorite {
                        f.push(json!(pid))
                    }
                    p["favorite"] = json!(favorite);
                    self.save(m)?;
                    Ok(p)
                }
            }
            "darkroom:develop-presets-delete" => {
                let pid = id(&v["presetId"])?;
                if self.latest(pid).is_none() || self.deleted(pid) {
                    return Err("Preset is missing or immutable.".into());
                }
                let mut m = self.manifest.clone();
                m["deletedPresetIds"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(pid));
                self.save(m)?;
                Ok(Value::Null)
            }
            "darkroom:develop-presets-import" => {
                match rfd::FileDialog::new()
                    .set_title("Import Develop preset")
                    .add_filter("Darkroom Develop preset", &["json", "drpreset"])
                    .pick_file()
                {
                    Some(path) => self.import_file(&path),
                    None => Ok(json!({"kind":"cancelled"})),
                }
            }
            "darkroom:develop-presets-resolve-conflict" => self.resolve(v),
            _ => Err(format!("Unknown preset command: {channel}")),
        }
    }
    fn prune(&mut self) -> Result<(), String> {
        let cutoff = now_ms().saturating_sub(TTL);
        let hashes: Vec<_> = self
            .pending
            .values()
            .filter(|p| p.created < cutoff)
            .map(|p| p.hash.clone())
            .collect();
        self.pending.retain(|_, p| p.created >= cutoff);
        for hash in hashes {
            self.remove_orphan(&hash)?;
        }
        Ok(())
    }
    fn remove_orphan(&self, hash: &str) -> Result<(), String> {
        if !self
            .records()
            .iter()
            .any(|r| r["importedSourceSha256"] == hash)
            && !self.pending.values().any(|p| p.hash == hash)
        {
            let p = self.root.join("imports").join(format!("{hash}.json"));
            if p.exists() {
                fs::remove_file(p).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    pub fn import_file(&mut self, path: &Path) -> Result<Value, String> {
        self.prune()?;
        if self.pending.len() >= 100 {
            return Err("Too many unresolved preset imports.".into());
        }
        let bytes = read(path, FILE_LIMIT)?;
        let mut incoming: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        validate(&incoming)?;
        incoming["presetId"] = json!(incoming["presetId"].as_str().unwrap().to_lowercase());
        for key in ["name", "author", "category"] {
            incoming[key] = json!(incoming[key].as_str().unwrap().trim());
        }
        incoming["source"] = json!("imported");
        let hash = digest(&bytes);
        let filename = path
            .file_name()
            .ok_or("Preset filename is missing.")?
            .to_string_lossy()
            .into_owned();
        let destination = self.root.join("imports").join(format!("{hash}.json"));
        if destination.exists() {
            if digest(&read(&destination, FILE_LIMIT)?) != hash {
                return Err("Stored preset import is corrupt.".into());
            }
        } else {
            atomic_write(&destination, &bytes, true)?;
        }
        if let Some(duplicate) = self
            .records()
            .iter()
            .find(|r| r["importedSourceSha256"] == hash)
        {
            let p = duplicate["preset"].clone();
            let mut m = self.manifest.clone();
            m["deletedPresetIds"]
                .as_array_mut()
                .unwrap()
                .retain(|v| v != &p["presetId"]);
            self.save(m)?;
            return Ok(json!({"kind":"exact-duplicate","preset":p}));
        }
        let pid = text(&incoming, "presetId")?;
        if let Some(existing) = self
            .latest(pid)
            .map(|r| &r["preset"])
            .or_else(|| self.builtin(pid))
        {
            let existing = existing.clone();
            let decisions = if self.latest(pid).is_none() {
                json!(["import-copy"])
            } else {
                json!(["replace", "import-copy"])
            };
            let token = uuid::Uuid::new_v4().to_string();
            self.pending.insert(
                token.clone(),
                Pending {
                    preset: incoming.clone(),
                    hash,
                    filename,
                    created: now_ms(),
                },
            );
            return Ok(
                json!({"kind":"conflict","token":token,"existing":existing,"incoming":incoming,"decisions":decisions}),
            );
        }
        let mut m = self.manifest.clone();
        m["records"].as_array_mut().unwrap().push(
            json!({"preset":incoming,"importedSourceSha256":hash,"importedFileName":filename}),
        );
        self.save(m)?;
        Ok(json!({"kind":"imported","preset":incoming}))
    }
    fn resolve(&mut self, v: &Value) -> Result<Value, String> {
        self.prune()?;
        let token = text(v, "token")?;
        let action = text(v, "action")?;
        let p = self
            .pending
            .get(token)
            .ok_or("Preset import conflict is unavailable.")?;
        if action == "cancel" {
            let hash = p.hash.clone();
            self.pending.remove(token);
            self.remove_orphan(&hash)?;
            return Ok(json!({"kind":"cancelled"}));
        }
        if !["replace", "import-copy"].contains(&action) {
            return Err("Preset conflict decision is invalid.".into());
        }
        let mut preset = p.preset.clone();
        let pid = text(&preset, "presetId")?.to_owned();
        if action == "replace" && self.latest(&pid).is_none() && self.builtin(&pid).is_some() {
            return Err("Built-in presets are immutable. Import a copy.".into());
        }
        if action == "import-copy" {
            preset["presetId"] = json!(uuid::Uuid::new_v4().to_string());
            preset["revision"] = json!(1)
        } else {
            preset["revision"] = json!(
                self.latest(&pid)
                    .map_or(0, |p| p["preset"]["revision"].as_u64().unwrap())
                    + 1
            )
        }
        let mut m = self.manifest.clone();
        m["records"].as_array_mut().unwrap().push(
            json!({"preset":preset,"importedSourceSha256":p.hash,"importedFileName":p.filename}),
        );
        m["deletedPresetIds"]
            .as_array_mut()
            .unwrap()
            .retain(|v| v != &preset["presetId"]);
        self.save(m)?;
        self.pending.remove(token);
        Ok(json!({"kind":"imported","preset":preset}))
    }
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
