use super::store_io::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
const LIMIT: usize = 512 * 1024 * 1024;
const MANIFEST_LIMIT: usize = 4 * 1024 * 1024;
pub const FRAME: &str = "oriented-source-normalized-bottom-left-v1";
pub fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn hash(v: &Value) -> Result<&str, String> {
    v.as_str()
        .filter(|s| valid_hash(s))
        .ok_or_else(|| "Asset hash is invalid.".into())
}
fn integer(v: &Value, min: u64, max: u64) -> Result<u64, String> {
    v.as_u64()
        .filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| "Asset integer is out of range.".into())
}
pub fn validate_source(v: &Value) -> Result<(), String> {
    for (k, max) in [
        ("entryId", 1024),
        ("catalogId", 1024),
        ("relativePath", 4096),
    ] {
        if text(v, k)?.len() > max {
            return Err("Asset source text exceeds its limit.".into());
        }
    }
    for k in ["assetRevision", "size"] {
        integer(&v[k], 0, 9_007_199_254_740_991)?;
    }
    if v["lastModified"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0. && *v <= 9_007_199_254_740_991.)
        .is_none()
    {
        return Err("Asset source time is invalid.".into());
    }
    Ok(())
}
pub fn source_matches(a: &Value, b: &Value) -> bool {
    [
        "entryId",
        "catalogId",
        "assetRevision",
        "relativePath",
        "size",
        "lastModified",
    ]
    .iter()
    .all(|k| a[k] == b[k])
}
pub fn validate_ref(v: &Value) -> Result<(), String> {
    let h = hash(&v["sha256"])?;
    if v["assetId"] != h {
        return Err("Asset address does not match checksum.".into());
    }
    validate_common(v)
}
fn validate_common(v: &Value) -> Result<(), String> {
    if !["mask-matte", "depth-map", "repair-patch"].contains(&text(v, "kind")?)
        || v["coordinateFrameRevision"] != FRAME
    {
        return Err("Asset kind or coordinate frame is invalid.".into());
    }
    if text(v, "producerRevision")?.len() > 256 {
        return Err("Asset producer revision is too long.".into());
    }
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
        return Err("Asset color stage is invalid.".into());
    }
    Ok(())
}
pub fn validate_descriptor(v: &Value) -> Result<(), String> {
    validate_common(v)?;
    hash(&v["sha256"])?;
    validate_source(&v["sourceSignature"])?;
    if text(v, "producerId")?.len() > 256 {
        return Err("Asset producer ID is too long.".into());
    }
    integer(&v["byteLength"], 1, LIMIT as u64)?;
    integer(&v["dimensions"]["width"], 1, 65535)?;
    integer(&v["dimensions"]["height"], 1, 65535)?;
    let mime = text(v, "mimeType")?;
    if (v["kind"] == "depth-map" && mime != "application/x-darkroom-depth")
        || (v["kind"] != "depth-map" && !["image/png", "image/webp"].contains(&mime))
        || (v["kind"] == "mask-matte" && mime != "image/png")
    {
        return Err("Asset MIME type does not match kind.".into());
    }
    Ok(())
}
pub fn validate_candidate(v: &Value) -> Result<(), String> {
    if v["kind"] != "candidate" || text(v, "candidateId")?.len() > 256 {
        return Err("Asset candidate is invalid.".into());
    }
    validate_descriptor(&v["descriptor"])
}
pub fn accepted_ref(candidate: &Value) -> Value {
    let d = &candidate["descriptor"];
    json!({"assetId":d["sha256"],"kind":d["kind"],"sha256":d["sha256"],"producerRevision":d["producerRevision"],"coordinateFrameRevision":d["coordinateFrameRevision"],"colorStageId":d["colorStageId"]})
}
fn reference_matches(d: &Value, r: &Value) -> bool {
    [
        "kind",
        "sha256",
        "producerRevision",
        "coordinateFrameRevision",
        "colorStageId",
    ]
    .iter()
    .all(|k| d[k] == r[k])
        && d["sha256"] == r["assetId"]
}
fn content(d: &Value, bytes: &[u8]) -> bool {
    let width = d["dimensions"]["width"].as_u64().unwrap_or(0);
    let height = d["dimensions"]["height"].as_u64().unwrap_or(0);
    if d["kind"] == "depth-map" {
        if bytes.len() < 24
            || &bytes[..8] != b"DRDEPTH\0"
            || u16::from_le_bytes([bytes[8], bytes[9]]) != 1
            || bytes[10] != 1
            || bytes[11] != 1
        {
            return false;
        }
        let u32at =
            |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as u64;
        if u32at(12) != width
            || u32at(16) != height
            || u32at(20) != width * 4
            || 24 + width * height * 4 != bytes.len() as u64
        {
            return false;
        }
        return bytes[24..].chunks_exact(4).all(|p| {
            let v = f32::from_le_bytes(p.try_into().unwrap());
            v.is_finite() && (0.0..=1.0).contains(&v)
        });
    }
    let expected = if d["mimeType"] == "image/png" {
        image::ImageFormat::Png
    } else {
        image::ImageFormat::WebP
    };
    if image::guess_format(bytes).ok() != Some(expected) {
        return false;
    }
    image::ImageReader::with_format(std::io::Cursor::new(bytes), expected)
        .into_dimensions()
        .is_ok_and(|(w, h)| w as u64 == width && h as u64 == height)
}
fn window(v: &Value) -> Result<(u64, u64), String> {
    let now = integer(&v["nowMs"], 0, 9_007_199_254_740_991)?;
    let until = integer(&v["recoveryUntilMs"], now, 9_007_199_254_740_991)?;
    Ok((now, until))
}
fn rejected(reason: &str, message: &str) -> Value {
    json!({"kind":"rejected","reason":reason,"message":message})
}
fn issue(kind: &str, reason: &str, action: &str, message: &str) -> Value {
    json!({"kind":kind,"reason":reason,"action":action,"message":message})
}
pub struct DevelopAssets {
    root: PathBuf,
}
impl DevelopAssets {
    pub fn new(app_data: &Path) -> Result<Self, String> {
        let root = app_data.join("develop-assets-v3");
        for name in ["objects", "manifests", "transactions"] {
            directory(&root.join(name))?;
        }
        Ok(Self { root })
    }
    fn path(&self, group: &str, id: &str, extension: &str) -> PathBuf {
        self.root
            .join(group)
            .join(&id[..2])
            .join(format!("{id}.{extension}"))
    }
    fn manifest(&self, id: &str) -> Result<Option<Value>, String> {
        let path = self.path("manifests", id, "json");
        if !path.try_exists().map_err(|e| e.to_string())? {
            return Ok(None);
        }
        let m = read_json(&path, MANIFEST_LIMIT)?;
        let records = m["records"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 256)
            .ok_or("Asset manifest record count is invalid.")?;
        if m["version"] != 1 {
            return Err("Asset manifest version is invalid.".into());
        }
        let mut ids = HashSet::new();
        for r in records {
            validate_candidate(&r["candidate"])?;
            let d = &r["candidate"]["descriptor"];
            if d["sha256"] != id
                || !ids.insert(text(&r["candidate"], "candidateId")?)
                || ![
                    "preview-candidate",
                    "accepted",
                    "rejected",
                    "cancelled",
                    "stale",
                ]
                .contains(&text(r, "lifecycle")?)
            {
                return Err("Asset manifest records conflict.".into());
            }
            let created = integer(&r["createdAtMs"], 0, 9_007_199_254_740_991)?;
            integer(&r["recoveryUntilMs"], created, 9_007_199_254_740_991)?;
        }
        Ok(Some(m))
    }
    pub fn put(&mut self, v: &Value, bytes: &[u8]) -> Result<Value, String> {
        let c = &v["candidate"];
        validate_candidate(c)?;
        let (now, until) = window(v)?;
        let d = &c["descriptor"];
        let id = hash(&d["sha256"])?;
        if bytes.len() as u64 != d["byteLength"].as_u64().unwrap() {
            return Ok(rejected(
                "byte-length-mismatch",
                "Candidate bytes do not match declared byte length.",
            ));
        }
        if digest(bytes) != id {
            return Ok(rejected(
                "checksum-mismatch",
                "Candidate bytes do not match declared checksum.",
            ));
        }
        if !content(d, bytes) {
            return Ok(rejected(
                "content-metadata-mismatch",
                "Candidate dimensions or MIME type do not match metadata.",
            ));
        }
        let mut manifest = match self.manifest(id) {
            Ok(m) => m.unwrap_or(json!({"version":1,"records":[]})),
            Err(_) => {
                return Ok(rejected(
                    "candidate-conflict",
                    "Existing candidate metadata is corrupt.",
                ));
            }
        };
        let records = manifest["records"].as_array_mut().unwrap();
        let duplicate = records
            .iter()
            .find(|r| r["candidate"]["candidateId"] == c["candidateId"]);
        if let Some(r) = duplicate {
            if r["candidate"]["descriptor"] != *d {
                return Ok(rejected(
                    "candidate-conflict",
                    "Candidate ID belongs to different metadata.",
                ));
            }
        } else if records.len() >= 256 {
            return Ok(rejected(
                "record-limit",
                "Content object has too many candidate records.",
            ));
        }
        let object_path = self.path("objects", id, "asset");
        let exists = object_path.exists();
        if exists {
            let existing = match read(&object_path, LIMIT) {
                Ok(b) => b,
                Err(_) => {
                    return Ok(rejected(
                        "candidate-conflict",
                        "Existing content bytes are unreadable.",
                    ));
                }
            };
            if existing.len() != bytes.len() || digest(&existing) != id {
                return Ok(rejected(
                    "candidate-conflict",
                    "Existing content bytes are corrupt.",
                ));
            }
            if let Some(r) = duplicate {
                return Ok(json!({"kind":"deduplicated","candidate":r["candidate"]}));
            }
        }
        let tx = self.root.join("transactions").join(&id[..2]).join(format!(
            "{id}-{}.json",
            digest(text(c, "candidateId")?.as_bytes())
        ));
        atomic_json(
            &tx,
            &json!({"version":1,"assetId":id,"candidateId":c["candidateId"],"createdAtMs":now,"recoveryUntilMs":until}),
            4096,
        )?;
        if !exists {
            atomic_write(&object_path, bytes, true)?;
        }
        if duplicate.is_none() {
            records.push(json!({"candidate":c,"lifecycle":"preview-candidate","createdAtMs":now,"recoveryUntilMs":until}));
            atomic_json(
                &self.path("manifests", id, "json"),
                &manifest,
                MANIFEST_LIMIT,
            )?;
        }
        let _ = fs::remove_file(tx);
        Ok(json!({"kind":"stored","candidate":c,"object":if exists{"reused"}else{"created"}}))
    }
    pub fn transition(&mut self, v: &Value) -> Result<Value, String> {
        let c = &v["candidate"];
        validate_candidate(c)?;
        let (_, until) = window(v)?;
        let lifecycle = text(v, "lifecycle")?;
        if !["accepted", "rejected", "cancelled", "stale"].contains(&lifecycle) {
            return Err("Asset lifecycle is invalid.".into());
        }
        let d = &c["descriptor"];
        let id = hash(&d["sha256"])?;
        let missing = || json!({"kind":"missing","action":"rebuild-candidate","message":"Candidate metadata is missing."});
        let conflict =
            |m: &str| json!({"kind":"conflict","action":"review-current-candidate","message":m});
        let mut manifest = match self.manifest(id) {
            Ok(Some(m)) => m,
            Ok(None) => return Ok(missing()),
            Err(_) => return Ok(conflict("Candidate metadata is corrupt.")),
        };
        let Some(current) = manifest["records"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|r| r["candidate"]["candidateId"] == c["candidateId"])
        else {
            return Ok(missing());
        };
        if current["candidate"]["descriptor"] != *d {
            return Ok(conflict("Candidate metadata changed."));
        }
        if lifecycle == "accepted" {
            validate_ref(&v["reference"])?;
            if !reference_matches(d, &v["reference"]) {
                return Ok(conflict("Accepted reference does not match metadata."));
            }
            let bytes = read(&self.path("objects", id, "asset"), LIMIT);
            if bytes.as_ref().map_or(true, |b| {
                b.len() as u64 != d["byteLength"].as_u64().unwrap()
                    || digest(b) != id
                    || !content(d, b)
            }) {
                return Ok(conflict("Candidate bytes are missing or corrupt."));
            }
        }
        if current["lifecycle"] == lifecycle {
            return Ok(json!({"kind":"unchanged","lifecycle":lifecycle}));
        }
        if current["lifecycle"] != "preview-candidate" {
            return Ok(conflict("Candidate lifecycle is already final."));
        }
        current["lifecycle"] = json!(lifecycle);
        current["recoveryUntilMs"] = json!(current["recoveryUntilMs"].as_u64().unwrap().max(until));
        atomic_json(
            &self.path("manifests", id, "json"),
            &manifest,
            MANIFEST_LIMIT,
        )?;
        Ok(json!({"kind":"changed","lifecycle":lifecycle}))
    }
    pub fn read(&self, v: &Value) -> Result<Value, String> {
        let r = &v["reference"];
        validate_ref(r)?;
        validate_source(&v["sourceSignature"])?;
        let id = hash(&r["assetId"])?;
        let m = match self.manifest(id) {
            Ok(Some(m)) => m,
            Ok(None) => {
                return Ok(issue(
                    "missing",
                    "metadata-missing",
                    "restore-or-rebuild",
                    "Accepted metadata is missing.",
                ));
            }
            Err(_) => {
                return Ok(issue(
                    "corrupt",
                    "metadata-invalid",
                    "restore-or-rebuild",
                    "Accepted metadata is corrupt.",
                ));
            }
        };
        let matching: Vec<_> = m["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|record| {
                reference_matches(&record["candidate"]["descriptor"], r)
                    && source_matches(
                        &record["candidate"]["descriptor"]["sourceSignature"],
                        &v["sourceSignature"],
                    )
            })
            .collect();
        if matching.is_empty() {
            return Ok(issue(
                "corrupt",
                "reference-mismatch",
                "restore-or-rebuild",
                "Accepted reference does not match metadata.",
            ));
        }
        let Some(accepted) = matching.into_iter().find(|r| r["lifecycle"] == "accepted") else {
            return Ok(issue(
                "missing",
                "not-accepted",
                "accept-candidate",
                "Candidate has not been accepted.",
            ));
        };
        let d = &accepted["candidate"]["descriptor"];
        let path = self.path("objects", id, "asset");
        if !path.exists() {
            return Ok(issue(
                "missing",
                "bytes-missing",
                "restore-or-rebuild",
                "Accepted bytes are missing.",
            ));
        }
        let bytes = match read(&path, LIMIT) {
            Ok(b) => b,
            Err(_) => {
                return Ok(issue(
                    "corrupt",
                    "byte-length-mismatch",
                    "restore-or-rebuild",
                    "Accepted bytes are invalid.",
                ));
            }
        };
        for (failed, reason) in [
            (
                bytes.len() as u64 != d["byteLength"].as_u64().unwrap(),
                "byte-length-mismatch",
            ),
            (digest(&bytes) != id, "checksum-mismatch"),
            (!content(d, &bytes), "content-metadata-mismatch"),
        ] {
            if failed {
                return Ok(issue(
                    "corrupt",
                    reason,
                    "restore-or-rebuild",
                    "Accepted bytes do not match metadata.",
                ));
            }
        }
        let mut binary = crate::native::binary_value(&bytes);
        binary["type"] = json!("Uint8Array");
        Ok(json!({"kind":"ready","descriptor":d,"bytes":binary}))
    }
    fn transactions(&self, id: &str) -> Result<Vec<(PathBuf, Value)>, String> {
        let path = self.root.join("transactions").join(&id[..2]);
        if !path.exists() {
            return Ok(vec![]);
        }
        let mut output = vec![];
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(&format!("{id}-")) || !name.ends_with(".json") {
                continue;
            }
            let v = read_json(&entry.path(), 4096)?;
            if v["version"] != 1 || v["assetId"] != id || text(&v, "candidateId")?.len() > 256 {
                return Err("Asset transaction is invalid.".into());
            }
            let created = integer(&v["createdAtMs"], 0, 9_007_199_254_740_991)?;
            integer(&v["recoveryUntilMs"], created, 9_007_199_254_740_991)?;
            output.push((entry.path(), v));
        }
        Ok(output)
    }
    fn collect_one(
        &mut self,
        id: &str,
        protected: &HashSet<&str>,
        now: u64,
    ) -> Result<&'static str, String> {
        if protected.contains(id) {
            return Ok("protected");
        }
        let m = self.manifest(id)?;
        let tx = self.transactions(id)?;
        let mut active = false;
        for (path, t) in tx {
            let complete = m.as_ref().is_some_and(|m| {
                m["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["candidate"]["candidateId"] == t["candidateId"])
            });
            if complete || t["recoveryUntilMs"].as_u64().unwrap() <= now {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            } else {
                active = true
            }
        }
        if active {
            return Ok("recoveryDeferred");
        }
        let object = self.path("objects", id, "asset");
        let Some(mut m) = m else {
            if object.exists() {
                let meta = fs::symlink_metadata(&object).map_err(|e| e.to_string())?;
                if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > LIMIT as u64 {
                    return Err("Orphan asset is invalid.".into());
                }
                let modified = meta
                    .modified()
                    .map_err(|e| e.to_string())?
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_millis() as u64;
                if modified.saturating_add(24 * 60 * 60 * 1000) > now {
                    return Ok("recoveryDeferred");
                }
                fs::remove_file(object).map_err(|e| e.to_string())?;
            }
            return Ok("deleted");
        };
        let records = m["records"].as_array_mut().unwrap();
        let before = records.len();
        records.retain(|r| {
            r["lifecycle"] == "preview-candidate" || r["recoveryUntilMs"].as_u64().unwrap() > now
        });
        if !records.is_empty() {
            let candidate = records
                .iter()
                .any(|r| r["lifecycle"] == "preview-candidate");
            if records.len() != before {
                atomic_json(&self.path("manifests", id, "json"), &m, MANIFEST_LIMIT)?;
            }
            return Ok(if candidate {
                "candidateDeferred"
            } else {
                "recoveryDeferred"
            });
        }
        fs::remove_file(self.path("manifests", id, "json")).map_err(|e| e.to_string())?;
        if object.exists() {
            fs::remove_file(object).map_err(|e| e.to_string())?;
        }
        Ok("deleted")
    }
    pub fn collect(&mut self, v: &Value) -> Result<Value, String> {
        let now = integer(&v["nowMs"], 0, 9_007_199_254_740_991)?;
        let refs = v["protectedReferences"]
            .as_array()
            .filter(|a| a.len() <= 50000)
            .ok_or("Protected asset references are invalid.")?;
        let mut protected = HashSet::new();
        for r in refs {
            validate_ref(&r["reference"])?;
            let owner = &r["owner"];
            if !["canonical-document", "retained-v2", "recovery-journal"]
                .contains(&text(owner, "kind")?)
            {
                return Err("Asset reference owner is invalid.".into());
            }
            text(owner, "ownerId")?;
            protected.insert(hash(&r["reference"]["assetId"])?);
        }
        let cursor = v["cursor"].as_str().unwrap_or("");
        if !cursor.is_empty() && !valid_hash(cursor) {
            return Err("Asset collection cursor is invalid.".into());
        }
        let mut ids = BTreeSet::new();
        for group in ["objects", "manifests", "transactions"] {
            for dir in fs::read_dir(self.root.join(group)).map_err(|e| e.to_string())? {
                let dir = dir.map_err(|e| e.to_string())?;
                if !dir.file_type().map_err(|e| e.to_string())?.is_dir() {
                    continue;
                }
                for entry in fs::read_dir(dir.path()).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.len() >= 64 {
                        let id = &name[..64];
                        if valid_hash(id) && id > cursor {
                            ids.insert(id.to_owned());
                        }
                    }
                }
            }
        }
        let ids: Vec<_> = ids.into_iter().collect();
        let page = &ids[..ids.len().min(10000)];
        let mut result = json!({"examined":page.len(),"deleted":0,"protected":0,"candidateDeferred":0,"recoveryDeferred":0,"failed":0,"failures":[],"omittedFailures":0,"nextCursor":if ids.len()>10000{page.last().map(String::as_str)}else{None}});
        for id in page {
            match self.collect_one(id, &protected, now) {
                Ok(kind) => result[kind] = json!(result[kind].as_u64().unwrap() + 1),
                Err(message) => {
                    result["failed"] = json!(result["failed"].as_u64().unwrap() + 1);
                    let failures = result["failures"].as_array_mut().unwrap();
                    if failures.len() < 256 {
                        failures.push(
                            json!({"assetId":id,"code":"metadata-invalid","message":message}),
                        );
                    }
                }
            }
        }
        result["omittedFailures"] = json!(
            result["failed"].as_u64().unwrap()
                - result["failures"].as_array().unwrap().len() as u64
        );
        Ok(result)
    }
    pub fn handle(&mut self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let v = args.first().ok_or("Asset request is missing.")?;
        match channel {
            "darkroom:develop-asset-put" => self.put(v, &crate::native::parse_binary(&v["bytes"])?),
            "darkroom:develop-asset-transition" => self.transition(v),
            "darkroom:develop-asset-read" => self.read(v),
            "darkroom:develop-asset-gc" => self.collect(v),
            _ => Err(format!("Unknown Develop asset command: {channel}")),
        }
    }
}
