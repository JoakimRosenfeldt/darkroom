use super::store_io::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
const LIMIT: usize = 16 * 1024 * 1024;
fn capabilities() -> Value {
    json!({"matrixToLinearSrgb":true,"channelScale":true,"exposureOffset":true,"hueSaturationMap":false,"lookTable":false,"toneCurve":false,"opcodes":false})
}
fn finite(v: &Value, min: f64, max: f64) -> Result<f64, String> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max)
        .ok_or_else(|| "Camera profile number is out of range.".into())
}
fn tuple(v: &Value, count: usize, min: f64, max: f64) -> Result<Vec<f64>, String> {
    v.as_array()
        .filter(|v| v.len() == count)
        .ok_or("Camera profile tuple has the wrong length.")?
        .iter()
        .map(|v| finite(v, min, max))
        .collect()
}
pub fn validate_matrix(v: &Value) -> Result<(), String> {
    object_keys(
        v,
        &[
            "version",
            "kind",
            "id",
            "revision",
            "label",
            "compatibility",
            "matrixToLinearSrgb",
            "channelScale",
            "exposureOffsetEv",
            "unsupportedTags",
            "opcodes",
        ],
    )?;
    if v["version"] != 1 || v["kind"] != "matrix" {
        return Err("Only matrix camera profile version 1 is supported.".into());
    }
    for key in ["id", "revision", "label"] {
        if text(v, key)?.trim().is_empty() || text(v, key)?.len() > 256 {
            return Err(format!("Camera profile {key} is invalid."));
        }
    }
    object_keys(&v["compatibility"], &["make", "model"])?;
    for key in ["make", "model"] {
        if text(&v["compatibility"], key)?.trim().is_empty()
            || text(&v["compatibility"], key)?.len() > 256
        {
            return Err("Camera profile camera identity is invalid.".into());
        }
    }
    for key in ["unsupportedTags", "opcodes"] {
        if let Some(value) = v.get(key) {
            if value.as_array().is_none_or(|v| !v.is_empty()) {
                return Err("Camera profile contains unsupported operations.".into());
            }
        }
    }
    let m = tuple(&v["matrixToLinearSrgb"], 9, -16., 16.)?;
    let d = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if d.abs() < 1e-8 || m == [1., 0., 0., 0., 1., 0., 0., 0., 1.] {
        return Err("Camera profile matrix must be invertible and non-neutral.".into());
    }
    tuple(&v["channelScale"], 3, 0.0625, 16.)?;
    finite(&v["exposureOffsetEv"], -8., 8.)?;
    Ok(())
}
fn normalize_profile(mut v: Value) -> Result<Value, String> {
    validate_matrix(&v)?;
    let o = v.as_object_mut().unwrap();
    o.remove("unsupportedTags");
    o.remove("opcodes");
    for key in ["id", "revision", "label"] {
        v[key] = json!(v[key].as_str().unwrap().trim());
    }
    for key in ["make", "model"] {
        v["compatibility"][key] = json!(v["compatibility"][key].as_str().unwrap().trim());
    }
    Ok(v)
}
fn parse_xmp(bytes: &[u8]) -> Result<Value, String> {
    let source = std::str::from_utf8(bytes).map_err(|_| "Profile XMP must be valid UTF-8.")?;
    if source.contains('&')
        || source.to_ascii_lowercase().contains("<!doctype")
        || source.to_ascii_lowercase().contains("<!entity")
    {
        return Err("Profile XMP cannot contain DTDs or entities.".into());
    }
    let mut source = source.trim_start_matches('\u{feff}').trim();
    if source.starts_with("<?xml") {
        source = source
            .split_once("?>")
            .ok_or("Profile XML declaration is invalid.")?
            .1
            .trim();
    }
    let mut body = source
        .strip_prefix("<DarkroomMatrixProfile")
        .and_then(|v| v.strip_suffix("/>"))
        .ok_or("Profile XMP must contain one self-closing DarkroomMatrixProfile element.")?;
    if !body.starts_with(char::is_whitespace) {
        return Err("Profile XMP element is invalid.".into());
    }
    let mut attributes = BTreeMap::new();
    loop {
        body = body.trim_start();
        if body.is_empty() {
            break;
        }
        let end = body
            .find(|c: char| !c.is_ascii_alphanumeric() && !"_.:-".contains(c))
            .ok_or("Profile XMP attribute is invalid.")?;
        let name = &body[..end];
        if name.is_empty() || !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
            return Err("Profile XMP attribute name is invalid.".into());
        }
        body = body[end..]
            .trim_start()
            .strip_prefix('=')
            .ok_or("Profile XMP attribute is invalid.")?
            .trim_start();
        let quote = body
            .chars()
            .next()
            .filter(|c| *c == '\'' || *c == '"')
            .ok_or("Profile XMP attribute must be quoted.")?;
        body = &body[1..];
        let end = body
            .find(quote)
            .ok_or("Profile XMP attribute is unterminated.")?;
        let value = &body[..end];
        if attributes.insert(name, value).is_some() {
            return Err("Profile XMP has duplicate attributes.".into());
        }
        body = &body[end + 1..];
    }
    let keys = [
        "id",
        "revision",
        "label",
        "make",
        "model",
        "matrixToLinearSrgb",
        "channelScale",
        "exposureOffsetEv",
        "unsupportedOpcodes",
    ];
    if attributes.len() != keys.len() || keys.iter().any(|key| !attributes.contains_key(key)) {
        return Err("Profile XMP has missing or unsupported fields.".into());
    }
    if attributes["unsupportedOpcodes"] != "" {
        return Err("Profile XMP contains unsupported profile operations.".into());
    }
    let list = |key: &str| -> Result<Vec<f64>, String> {
        attributes[key]
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<f64>().map_err(|e| e.to_string()))
            .collect()
    };
    let matrix = list("matrixToLinearSrgb")?;
    let scale = list("channelScale")?;
    let exposure = attributes["exposureOffsetEv"]
        .trim()
        .parse::<f64>()
        .map_err(|e| e.to_string())?;
    normalize_profile(
        json!({"version":1,"kind":"matrix","id":attributes["id"],"revision":attributes["revision"],"label":attributes["label"],"compatibility":{"make":attributes["make"],"model":attributes["model"]},"matrixToLinearSrgb":matrix,"channelScale":scale,"exposureOffsetEv":exposure}),
    )
}
#[derive(Clone)]
struct Entry {
    kind: u16,
    count: usize,
    offset: usize,
    size: usize,
}
struct Tiff<'a> {
    bytes: &'a [u8],
    little: bool,
}
impl<'a> Tiff<'a> {
    fn range(&self, offset: usize, length: usize) -> Result<&'a [u8], String> {
        self.bytes
            .get(offset..offset.checked_add(length).ok_or("DCP offset overflow.")?)
            .ok_or_else(|| "DCP TIFF offset is outside the file.".into())
    }
    fn u16(&self, o: usize) -> Result<u16, String> {
        let a: [u8; 2] = self.range(o, 2)?.try_into().unwrap();
        Ok(if self.little {
            u16::from_le_bytes(a)
        } else {
            u16::from_be_bytes(a)
        })
    }
    fn u32(&self, o: usize) -> Result<u32, String> {
        let a: [u8; 4] = self.range(o, 4)?.try_into().unwrap();
        Ok(if self.little {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    }
    fn entries(&self) -> Result<HashMap<u16, Entry>, String> {
        let mut offset = self.u32(4)? as usize;
        let mut seen = HashSet::new();
        let mut entries = HashMap::new();
        while offset != 0 {
            if seen.len() >= 8 || !seen.insert(offset) {
                return Err("DCP TIFF has too many or cyclic directories.".into());
            }
            let count = self.u16(offset)? as usize;
            if count > 2048 || entries.len() + count > 2048 {
                return Err("DCP TIFF has too many fields.".into());
            }
            self.range(offset + 2, count * 12 + 4)?;
            for i in 0..count {
                let o = offset + 2 + i * 12;
                let tag = self.u16(o)?;
                let kind = self.u16(o + 2)?;
                let size = match kind {
                    1 | 2 | 6 | 7 => 1,
                    3 | 8 => 2,
                    4 | 9 | 11 => 4,
                    5 | 10 | 12 => 8,
                    _ => return Err("DCP TIFF field type is unsupported.".into()),
                };
                let values = self.u32(o + 4)? as usize;
                if values > 1_000_000 {
                    return Err("DCP TIFF has too many values.".into());
                }
                let size = values * size;
                let data = if size <= 4 {
                    o + 8
                } else {
                    self.u32(o + 8)? as usize
                };
                self.range(data, size)?;
                if entries
                    .insert(
                        tag,
                        Entry {
                            kind,
                            count: values,
                            offset: data,
                            size,
                        },
                    )
                    .is_some()
                {
                    return Err(format!("DCP TIFF tag {tag} is duplicated."));
                }
            }
            offset = self.u32(offset + 2 + count * 12)? as usize;
        }
        if entries.is_empty() {
            return Err("DCP contains no TIFF fields.".into());
        }
        Ok(entries)
    }
    fn ascii(&self, e: &Entry) -> Result<String, String> {
        if e.kind != 2 || !(2..=1024).contains(&e.count) {
            return Err("DCP ASCII field is invalid.".into());
        }
        let b = self.range(e.offset, e.size)?;
        if b.last() != Some(&0) || b[..b.len() - 1].iter().any(|v| !(0x20..=0x7e).contains(v)) {
            return Err("DCP ASCII field is invalid.".into());
        }
        Ok(String::from_utf8(b[..b.len() - 1].to_vec())
            .unwrap()
            .trim()
            .to_owned())
    }
    fn matrix(&self, e: &Entry) -> Result<Vec<f64>, String> {
        if ![5, 10].contains(&e.kind) || e.count != 9 {
            return Err("DCP forward matrix needs nine rational values.".into());
        }
        let mut a = vec![];
        for i in 0..9 {
            let n = self.u32(e.offset + i * 8)?;
            let d = self.u32(e.offset + i * 8 + 4)?;
            let (n, d) = if e.kind == 10 {
                (n as i32 as f64, d as i32 as f64)
            } else {
                (n as f64, d as f64)
            };
            let v = n / d;
            if d == 0. || !v.is_finite() || v.abs() > 16. {
                return Err("DCP rational matrix is invalid.".into());
            }
            a.push(v);
        }
        Ok(a)
    }
}
fn slug(s: &str) -> Result<String, String> {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c)
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-')
        }
    }
    let out = out
        .trim_end_matches('-')
        .chars()
        .take(80)
        .collect::<String>();
    if out.is_empty() {
        Err("DCP identity cannot form a profile ID.".into())
    } else {
        Ok(out)
    }
}
fn parse_dcp(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() < 8 || (&bytes[..2] != b"II" && &bytes[..2] != b"MM") {
        return Err("DCP TIFF header is invalid.".into());
    }
    let reader = Tiff {
        bytes,
        little: &bytes[..2] == b"II",
    };
    if reader.u16(2)? != 42 {
        return Err("DCP TIFF magic is invalid.".into());
    }
    let entries = reader.entries()?;
    let unsupported = [
        50725, 50726, 50937, 50938, 50939, 50940, 50981, 50982, 51008, 51009, 51022, 51107, 51108,
        51109, 51110, 52525, 52542,
    ];
    if unsupported.iter().any(|tag| entries.contains_key(tag)) {
        return Err("DCP requires unsupported transform tags.".into());
    }
    let identity = reader.ascii(entries.get(&50708).ok_or("DCP needs UniqueCameraModel.")?)?;
    let label = reader.ascii(entries.get(&50936).ok_or("DCP needs ProfileName.")?)?;
    let a = entries.get(&50964).map(|e| reader.matrix(e)).transpose()?;
    let b = entries.get(&50965).map(|e| reader.matrix(e)).transpose()?;
    if let (Some(a), Some(b)) = (&a, &b) {
        if a.iter().zip(b).any(|(x, y)| (x - y).abs() > 1e-9) {
            return Err("DCP dual-illuminant matrix interpolation is unsupported.".into());
        }
    }
    let forward = a
        .or(b)
        .ok_or("DCP needs ForwardMatrix1 or ForwardMatrix2.")?;
    let camera = identity.split_whitespace().collect::<Vec<_>>().join(" ");
    let known = [
        "NIKON CORPORATION",
        "EASTMAN KODAK COMPANY",
        "FUJIFILM",
        "Hasselblad",
        "Leica Camera AG",
        "OLYMPUS IMAGING CORP.",
        "OM Digital Solutions",
        "PENTAX",
        "RICOH IMAGING COMPANY, LTD.",
        "SONY",
        "Canon",
    ];
    let make = known
        .iter()
        .find(|m| {
            camera
                .to_lowercase()
                .starts_with(&format!("{} ", m.to_lowercase()))
        })
        .copied()
        .or_else(|| camera.split_once(' ').map(|v| v.0))
        .ok_or("DCP camera identity must include make and model.")?;
    let model = camera[make.len()..].trim();
    if model.is_empty() {
        return Err("DCP camera model is missing.".into());
    }
    let left = [
        3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914,
        1.4052427,
    ];
    let mut matrix = [0.; 9];
    for r in 0..3 {
        for c in 0..3 {
            matrix[r * 3 + c] = (0..3).map(|k| left[r * 3 + k] * forward[k * 3 + c]).sum();
        }
    }
    normalize_profile(
        json!({"version":1,"kind":"matrix","id":format!("dcp.{}.{}.{}",slug(make)?,slug(model)?,slug(&label)?),"revision":format!("sha256-{}",&digest(bytes)[..24]),"label":label,"compatibility":{"make":make,"model":model},"matrixToLinearSrgb":matrix,"channelScale":[1,1,1],"exposureOffsetEv":0}),
    )
}
fn parse(bytes: &[u8], format: &str) -> Result<Value, String> {
    if bytes.is_empty() || bytes.len() > LIMIT {
        return Err("Camera profile exceeds its byte limit or is empty.".into());
    }
    match format {
        "xmp" => parse_xmp(bytes),
        "dcp" => parse_dcp(bytes),
        _ => Err("Choose a .dcp or .xmp camera profile.".into()),
    }
}
fn normalized(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
struct Pending {
    record: Value,
    bytes: Vec<u8>,
    created: u64,
}
pub struct ProfileStore {
    directory: PathBuf,
    state: Value,
    pending: HashMap<String, Pending>,
}
impl ProfileStore {
    pub fn new(app_data: &Path) -> Result<Self, String> {
        let directory = app_data.join("camera-profiles");
        super::store_io::directory(&directory)?;
        let index = directory.join("registry.json");
        let mut state = if index.exists() {
            read_json(&index, LIMIT)?
        } else {
            json!({"version":1,"generation":0,"profiles":[],"retiredProfiles":[],"replacements":{}})
        };
        if state["retiredProfiles"].is_null() {
            state["retiredProfiles"] = json!([])
        }
        if state["version"] != 1
            || state["generation"].as_u64().is_none()
            || !state["profiles"].is_array()
            || !state["retiredProfiles"].is_array()
            || !state["replacements"].is_object()
        {
            return Err("Camera profile registry is invalid.".into());
        }
        let mut store = Self {
            directory,
            state,
            pending: HashMap::new(),
        };
        store.rescan()?;
        Ok(store)
    }
    pub fn list(&self) -> Value {
        let mut profiles = self.state["profiles"].as_array().unwrap().clone();
        profiles.sort_by(|a, b| {
            let ak = a["kind"] == "ready";
            let bk = b["kind"] == "ready";
            bk.cmp(&ak).then_with(|| {
                let a = if ak {
                    a["profile"]["label"].as_str()
                } else {
                    a["sourceFilename"].as_str()
                };
                let b = if bk {
                    b["profile"]["label"].as_str()
                } else {
                    b["sourceFilename"].as_str()
                };
                a.cmp(&b)
            })
        });
        json!({"version":1,"revision":format!("camera-profile-registry-{}",self.state["generation"].as_u64().unwrap()),"profiles":profiles,"replacements":self.state["replacements"]})
    }
    fn save(&mut self, state: Value) -> Result<(), String> {
        atomic_json(&self.directory.join("registry.json"), &state, LIMIT)?;
        self.state = state;
        Ok(())
    }
    fn active(&self, id: &str) -> Option<&Value> {
        self.state["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "ready" && r["profile"]["id"] == id)
    }
    fn install(
        &mut self,
        record: &Value,
        bytes: &[u8],
        replace: Option<&str>,
    ) -> Result<(), String> {
        let hash = text(record, "hash")?;
        let path = self.directory.join(text(record, "storedFilename")?);
        if path.exists() {
            if digest(&read(&path, LIMIT)?) != hash {
                return Err("Stored camera profile hash collision.".into());
            }
        } else {
            atomic_write(&path, bytes, true)?;
        }
        let mut next = self.state.clone();
        let retired = next["retiredProfiles"].as_array_mut().unwrap();
        retired.retain(|r| r["hash"] != hash);
        if let Some(id) = replace {
            retired.extend(
                self.state["profiles"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|r| r["kind"] == "ready" && r["profile"]["id"] == id)
                    .cloned(),
            );
        }
        let profiles = next["profiles"].as_array_mut().unwrap();
        if let Some(id) = replace {
            for p in profiles {
                if p["kind"] == "ready" && p["profile"]["id"] == id {
                    *p = record.clone()
                }
            }
        } else {
            profiles.push(record.clone())
        }
        next["generation"] = json!(self.state["generation"].as_u64().unwrap() + 1);
        self.save(next)
    }
    pub fn import_file(&mut self, path: &Path) -> Result<Value, String> {
        let name = path
            .file_name()
            .ok_or("Camera profile filename is missing.")?
            .to_string_lossy()
            .trim()
            .to_owned();
        if name.is_empty() || name.len() > 256 {
            return Err("Camera profile filename is invalid.".into());
        }
        let format = if name.to_lowercase().ends_with(".dcp") {
            "dcp"
        } else if name.to_lowercase().ends_with(".xmp") {
            "xmp"
        } else {
            return Err("Choose a .dcp or .xmp camera profile.".into());
        };
        let bytes = read(path, LIMIT)?;
        let hash = digest(&bytes);
        if let Some(r) = self.state["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "ready" && r["hash"] == hash)
        {
            return Ok(json!({"kind":"duplicate","record":r}));
        }
        let profile = parse(&bytes, format)?;
        let record = json!({"kind":"ready","hash":hash,"sourceFilename":name,"storedFilename":format!("{hash}.{format}"),"format":format,"profile":profile,"capabilities":capabilities(),"unsupportedOperations":[]});
        if let Some(existing) = self.active(text(&profile, "id")?).cloned() {
            self.prune();
            if self.pending.len() >= 100 {
                return Err("Too many pending camera profile conflicts.".into());
            }
            let token = uuid::Uuid::new_v4().to_string();
            self.pending.insert(
                token.clone(),
                Pending {
                    record: record.clone(),
                    bytes,
                    created: now_ms(),
                },
            );
            return Ok(
                json!({"kind":"conflict","token":token,"existing":existing,"incoming":record}),
            );
        }
        self.install(&record, &bytes, None)?;
        Ok(json!({"kind":"imported","record":record}))
    }
    fn prune(&mut self) {
        self.pending
            .retain(|_, p| now_ms().saturating_sub(p.created) < 15 * 60 * 1000);
    }
    fn resolve(&mut self, v: &Value) -> Result<Value, String> {
        self.prune();
        let token = text(v, "token")?;
        let action = text(v, "action")?;
        let pending = self
            .pending
            .get(token)
            .ok_or("Camera profile import conflict expired.")?;
        if action == "cancel" {
            self.pending.remove(token);
            return Ok(json!({"kind":"cancelled"}));
        }
        let mut record = pending.record.clone();
        let bytes = pending.bytes.clone();
        let id = text(&record["profile"], "id")?.to_owned();
        let existing = self
            .active(&id)
            .ok_or("Conflicting camera profile changed. Import it again.")?;
        let replace = match action {
            "replace" => {
                for k in ["make", "model"] {
                    if normalized(text(&existing["profile"]["compatibility"], k)?)
                        != normalized(text(&record["profile"]["compatibility"], k)?)
                    {
                        return Err(
                            "Replace requires the same camera make and model. Import a copy."
                                .into(),
                        );
                    }
                }
                Some(id.as_str())
            }
            "import-copy" => {
                record["profile"]["id"] =
                    json!(format!("{id}.copy-{}", &text(&record, "hash")?[..12]));
                record["profile"]["label"] =
                    json!(format!("{} copy", text(&record["profile"], "label")?));
                validate_matrix(&record["profile"])?;
                None
            }
            _ => return Err("Camera profile conflict decision is invalid.".into()),
        };
        self.install(&record, &bytes, replace)?;
        self.pending.remove(token);
        Ok(json!({"kind":"imported","record":record}))
    }
    fn remove(&mut self, v: &Value) -> Result<Value, String> {
        let id = text(v, "profileId")?;
        let replacement_id = text(v, "replacementProfileId")?;
        if id == replacement_id {
            return Err("Replacement profile must be different.".into());
        }
        let removed = self
            .active(id)
            .ok_or("Camera profile is not installed.")?
            .clone();
        let replacement = self
            .active(replacement_id)
            .ok_or("Replacement camera profile is not installed.")?;
        for k in ["make", "model"] {
            if text(&removed["profile"]["compatibility"], k)?
                .trim()
                .to_lowercase()
                != text(&replacement["profile"]["compatibility"], k)?
                    .trim()
                    .to_lowercase()
            {
                return Err("Replacement camera profile must match the same camera.".into());
            }
        }
        let mut next = self.state.clone();
        next["profiles"]
            .as_array_mut()
            .unwrap()
            .retain(|r| r != &removed);
        next["retiredProfiles"]
            .as_array_mut()
            .unwrap()
            .push(removed);
        let replacements = next["replacements"].as_object_mut().unwrap();
        for v in replacements.values_mut() {
            if v == id {
                *v = json!(replacement_id)
            }
        }
        replacements.insert(id.into(), json!(replacement_id));
        next["generation"] = json!(self.state["generation"].as_u64().unwrap() + 1);
        self.save(next)?;
        Ok(self.list())
    }
    pub fn rescan(&mut self) -> Result<Value, String> {
        let profiles = self.state["profiles"].as_array().unwrap();
        let active: HashSet<_> = profiles.iter().filter_map(|r| r["hash"].as_str()).collect();
        let retired: HashSet<_> = self.state["retiredProfiles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["hash"].as_str())
            .filter(|h| !active.contains(h))
            .collect();
        let mut entries: Vec<_> = fs::read_dir(&self.directory)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        entries.sort_by_key(|e| e.file_name());
        let mut records = vec![];
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some((hash, format)) = name.rsplit_once('.') else {
                continue;
            };
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !["xmp", "dcp"].contains(&format)
                || retired.contains(hash)
            {
                continue;
            }
            let previous: Vec<_> = profiles.iter().filter(|r| r["hash"] == hash).collect();
            let parsed = (|| {
                let bytes = read(&entry.path(), LIMIT)?;
                if digest(&bytes) != hash {
                    return Err("Stored profile does not match its SHA-256 filename.".to_owned());
                }
                parse(&bytes, format)
            })();
            match parsed{Ok(profile)=>{let ready:Vec<_>=previous.iter().filter(|r|r["kind"]=="ready").collect();let variants:Vec<Option<&Value>>=if ready.is_empty(){vec![None]}else{ready.into_iter().map(|v|Some(*v)).collect()};for prior in variants{let mut p=profile.clone();if let Some(prior)=prior{if prior["profile"]["id"]!=p["id"]{p["id"]=prior["profile"]["id"].clone();p["label"]=prior["profile"]["label"].clone();}}validate_matrix(&p)?;records.push(json!({"kind":"ready","hash":hash,"sourceFilename":prior.map(|v|v["sourceFilename"].clone()).unwrap_or(json!(name)),"storedFilename":name,"format":format,"profile":p,"capabilities":capabilities(),"unsupportedOperations":[]}));}},Err(error)=>records.push(json!({"kind":"invalid","hash":hash,"sourceFilename":previous.first().map(|v|v["sourceFilename"].clone()).unwrap_or(json!(name)),"storedFilename":name,"format":format,"parseError":error,"unsupportedOperations":previous.first().map(|v|v["unsupportedOperations"].clone()).unwrap_or(json!([]))}))}
        }
        let changed = json!(records) != self.state["profiles"];
        if changed || !self.directory.join("registry.json").exists() {
            let mut state = self.state.clone();
            state["profiles"] = json!(records);
            state["generation"] = json!(state["generation"].as_u64().unwrap() + u64::from(changed));
            self.save(state)?;
        }
        Ok(self.list())
    }
    pub fn handle(&mut self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let v = args.first().unwrap_or(&Value::Null);
        match channel {
            "darkroom:camera-profiles-list" => Ok(self.list()),
            "darkroom:camera-profiles-rescan" => self.rescan(),
            "darkroom:camera-profiles-import" => match rfd::FileDialog::new()
                .set_title("Import camera profile")
                .add_filter("Camera profile", &["dcp", "xmp"])
                .pick_file()
            {
                Some(p) => self.import_file(&p),
                None => Ok(json!({"kind":"cancelled"})),
            },
            "darkroom:camera-profiles-resolve-conflict" => self.resolve(v),
            "darkroom:camera-profiles-remove" => self.remove(v),
            _ => Err(format!("Unknown camera profile command: {channel}")),
        }
    }
}
