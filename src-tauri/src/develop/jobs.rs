use super::{
    assets::{self, DevelopAssets},
    prototype::{self, Image, Output},
    store_io::*,
};
use image::ImageEncoder;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};
type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
const RECOVERY: u64 = 7 * 24 * 60 * 60 * 1000;
struct State {
    path: PathBuf,
    jobs: Vec<Value>,
    consents: Vec<Value>,
    emit: Option<Emit>,
    writable: bool,
    cancel: HashMap<String, Arc<AtomicBool>>,
}
pub struct JobService {
    state: Arc<Mutex<State>>,
    assets: Arc<Mutex<DevelopAssets>>,
    queue: mpsc::Sender<(String, Image, Arc<AtomicBool>)>,
}
fn canonical_hash(v: &Value) -> String {
    digest(serde_json::to_string(v).unwrap().as_bytes())
}
fn source_revision(s: &Value) -> Value {
    json!({"kind":"source-revision","value":canonical_hash(&json!([s["catalogId"],s["entryId"],s["assetRevision"],s["relativePath"],s["size"],s["lastModified"]]))})
}
fn parameter_hash(v: &Value) -> Result<String, String> {
    let kind = text(v, "kind")?;
    let array = match kind {
        "depth" => json!([kind, "builtin-prototype-depth-v1"]),
        "denoise" => json!([kind, "builtin-prototype-denoise-v1", v["strength"]]),
        "raw-details" => json!([kind, "builtin-prototype-raw-details-v1", v["amount"]]),
        "super-resolution" => json!([kind, "builtin-prototype-super-resolution-v1", 2]),
        "generative-remove" => json!([
            kind,
            "local-mock-remove-v1",
            v["selection"]["assetId"],
            v["seed"],
            v["searchRadius"]
        ]),
        _ => return Err("Develop operation is unsupported.".into()),
    };
    Ok(canonical_hash(&array))
}
fn revision(v: &Value, kind: &str) -> Result<(), String> {
    if v["kind"] != kind || text(v, "value")?.len() > 256 {
        return Err("Develop revision is invalid.".into());
    }
    Ok(())
}
fn validate_intent(v: &Value) -> Result<(), String> {
    assets::validate_source(&v["source"])?;
    revision(&v["documentRevision"], "develop-document-revision")?;
    match text(v, "kind")? {
        "depth" => {}
        "denoise" | "raw-details" => {
            let key = if v["kind"] == "denoise" {
                "strength"
            } else {
                "amount"
            };
            if v[key]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0. && *n <= 100.)
                .is_none()
            {
                return Err("Prototype amount is invalid.".into());
            }
        }
        "super-resolution" => {
            if v["scale"] != 2 {
                return Err("Prototype scale must be 2.".into());
            }
        }
        "generative-remove" => {
            assets::validate_ref(&v["selection"])?;
            if v["selection"]["kind"] != "mask-matte"
                || v["seed"]
                    .as_u64()
                    .filter(|n| *n <= u32::MAX as u64)
                    .is_none()
                || v["searchRadius"]
                    .as_u64()
                    .filter(|n| (1..=64).contains(n))
                    .is_none()
            {
                return Err("Remove parameters are invalid.".into());
            }
        }
        _ => return Err("Prototype operation is unsupported.".into()),
    }
    Ok(())
}
fn base(job: &Value, status: &str) -> Value {
    let mut result = serde_json::Map::new();
    for k in [
        "id",
        "request",
        "provenance",
        "attempt",
        "retryOf",
        "createdAtMs",
    ] {
        result.insert(k.into(), job[k].clone());
    }
    result.insert(
        "updatedAtMs".into(),
        json!(now_ms().max(job["updatedAtMs"].as_u64().unwrap_or(0))),
    );
    result.insert("status".into(), json!(status));
    Value::Object(result)
}
fn failure(code: &str, message: &str) -> Value {
    let recovery = match code {
        "model-unavailable" => "repair-model",
        "unsupported-input" => "choose-supported-input",
        "device-limit" => "reduce-work-or-change-device",
        "privacy-limit" => "review-consent",
        "provider-error" => "retry-provider",
        "integrity-error" => "restore-or-rebuild",
        _ => "repair-storage",
    };
    json!({"code":code,"message":message,"retryable":true,"recovery":recovery})
}
impl State {
    fn persist(&mut self) -> Result<(), String> {
        if !self.writable {
            return Err("Develop job journal must be repaired before continuing.".into());
        }
        let result = atomic_json(
            &self.path,
            &json!({"version":1,"jobs":self.jobs,"consents":self.consents}),
            4 * 1024 * 1024,
        );
        if result.is_err() {
            self.writable = false;
        }
        result?;
        if let Some(emit) = &self.emit {
            emit("darkroom:develop-jobs-updated", json!(self.jobs));
        }
        Ok(())
    }
    fn index(&self, id: &str) -> Result<usize, String> {
        self.jobs
            .iter()
            .position(|j| j["id"]["value"] == id)
            .ok_or_else(|| "Prototype job was not found.".into())
    }
    fn replace(&mut self, id: &str, job: Value) -> Result<Value, String> {
        let i = self.index(id)?;
        self.jobs[i] = job.clone();
        self.persist()?;
        Ok(job)
    }
    fn consent_valid(&self, r: &Value) -> bool {
        self.consents
            .iter()
            .find(|c| c["id"] == r["consent"]["id"])
            .is_some_and(|c| {
                c["revokedAtMs"].is_null()
                    && c["expiresAtMs"].as_u64().unwrap_or(0) > now_ms()
                    && c["intentHash"] == r["parameterHash"]
                    && c["selectionAssetId"] == r["selection"]["assetId"]
                    && c["sourceRevision"] == r["sourceRevision"]
                    && c["provider"] == "local-mock-remove-v1"
                    && c["disclosure"] == "local-processing-no-network-v1"
            })
    }
    fn materialize(&self, v: &Value) -> Result<Value, String> {
        validate_intent(v)?;
        let kind = text(v, "kind")?;
        let implementation = if kind == "generative-remove" {
            "local-mock-remove-v1".to_owned()
        } else {
            format!("builtin-prototype-{kind}-v1")
        };
        let mut r = json!({"kind":kind,"source":v["source"],"sourceRevision":source_revision(&v["source"]),"documentRevision":v["documentRevision"],"frameRevision":{"kind":"coordinate-frame-revision","value":assets::FRAME},"parameterHash":parameter_hash(v)?,"implementation":implementation});
        for key in [
            "strength",
            "amount",
            "scale",
            "selection",
            "seed",
            "searchRadius",
        ] {
            if let Some(value) = v.get(key) {
                r[key] = value.clone();
            }
        }
        if kind == "generative-remove" {
            let receipt = self
                .consents
                .iter()
                .find(|c| c["id"] == v["consentReceiptId"])
                .ok_or("Generative Remove consent is missing.")?;
            r["consent"] = receipt.clone();
            if !self.consent_valid(&r) {
                return Err("Generative Remove consent is expired, revoked, or stale.".into());
            }
        }
        Ok(r)
    }
}
fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    m.lock()
        .map_err(|_| "Develop service is unavailable.".into())
}
fn finalize(
    assets: &Arc<Mutex<DevelopAssets>>,
    candidates: &[Value],
    lifecycle: &str,
) -> Result<(), String> {
    let now = now_ms();
    let mut store = lock(assets)?;
    for c in candidates {
        let _=store.transition(&json!({"candidate":c,"lifecycle":lifecycle,"reference":null,"nowMs":now,"recoveryUntilMs":now+RECOVERY}))?;
    }
    Ok(())
}
impl JobService {
    pub fn new(app_data: &Path, assets: Arc<Mutex<DevelopAssets>>) -> Result<Self, String> {
        let path = app_data.join("develop-jobs-v3/journal.json");
        directory(path.parent().unwrap())?;
        let journal = if path.exists() {
            read_json(&path, 4 * 1024 * 1024)?
        } else {
            json!({"version":1,"jobs":[],"consents":[]})
        };
        if journal["version"] != 1 {
            return Err("Develop job journal version is invalid.".into());
        }
        let mut jobs = journal["jobs"]
            .as_array()
            .filter(|a| a.len() <= 256)
            .ok_or("Develop job journal is invalid.")?
            .clone();
        let consents = journal["consents"]
            .as_array()
            .filter(|a| a.len() <= 256)
            .ok_or("Develop consent journal is invalid.")?
            .clone();
        let mut ids = std::collections::HashSet::new();
        for job in &mut jobs {
            let id = text(&job["id"], "value")?;
            if job["id"]["kind"] != "develop-job-id" || !ids.insert(id.to_owned()) {
                return Err("Develop job journal has invalid IDs.".into());
            }
            assets::validate_source(&job["request"]["source"])?;
            if ["queued", "preparing", "running", "postprocess", "accepting"]
                .contains(&job["status"].as_str().unwrap_or(""))
            {
                let mut next = base(job, "interrupted");
                if job["status"] == "accepting" {
                    next["reason"] = json!("acceptance-recovery");
                    next["candidates"] = job["candidates"].clone();
                    next["acceptanceId"] = job["acceptanceId"].clone();
                } else {
                    next["reason"] = json!(if job["request"]["kind"] == "generative-remove" {
                        "provider-state-unknown"
                    } else {
                        "application-restart"
                    });
                    next["candidates"] = json!([]);
                }
                *job = next;
            }
        }
        let state = Arc::new(Mutex::new(State {
            path,
            jobs,
            consents,
            emit: None,
            writable: true,
            cancel: HashMap::new(),
        }));
        lock(&state)?.persist()?;
        let (queue, receive) = mpsc::channel::<(String, Image, Arc<AtomicBool>)>();
        let worker_state = state.clone();
        let worker_assets = assets.clone();
        std::thread::Builder::new()
            .name("darkroom-develop".into())
            .spawn(move || {
                for (id, image, cancel) in receive {
                    run(&worker_state, &worker_assets, &id, image, &cancel);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            state,
            assets,
            queue,
        })
    }
    pub fn set_emitter(&mut self, emit: Emit) -> Result<(), String> {
        lock(&self.state)?.emit = Some(emit);
        Ok(())
    }
    pub fn handle(&mut self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let v = args.first().unwrap_or(&Value::Null);
        match channel {
            "darkroom:develop-jobs-list" => Ok(json!(lock(&self.state)?.jobs)),
            "darkroom:develop-jobs-start" | "darkroom:develop-jobs-retry" => {
                let image = Image::parse(&v["image"])?;
                let mut s = lock(&self.state)?;
                let request = s.materialize(&v["intent"])?;
                let mut attempt = 1;
                let mut retry_of = Value::Null;
                if channel.ends_with("-retry") {
                    let previous = &s.jobs[s.index(text(&v["jobId"], "value")?)?];
                    let status = previous["status"].as_str().unwrap_or("");
                    if !["cancelled", "interrupted", "stale"].contains(&status)
                        && !(status == "failed" && previous["failure"]["retryable"] == true)
                    {
                        return Err("This Develop job cannot be retried.".into());
                    }
                    if previous["request"]["kind"] != request["kind"]
                        || previous["attempt"].as_u64().unwrap_or(16) >= 16
                    {
                        return Err("Retry changes operation or exceeds the attempt limit.".into());
                    }
                    attempt = previous["attempt"].as_u64().unwrap() + 1;
                    retry_of = previous["id"].clone();
                }
                if s.jobs.len() >= 256 {
                    let index = s
                        .jobs
                        .iter()
                        .position(|j| j["status"] == "discarded")
                        .ok_or("Prototype job history is full. Discard old jobs.")?;
                    s.jobs.remove(index);
                }
                let id = uuid::Uuid::new_v4().to_string();
                let now = now_ms();
                let job = json!({"id":{"kind":"develop-job-id","value":id},"request":request,"provenance":{"implementation":"prototype","operation":request["kind"],"algorithmId":request["implementation"],"algorithmRevision":"1","parameterHash":request["parameterHash"],"sourceRevision":request["sourceRevision"],"documentRevision":request["documentRevision"],"frameRevision":request["frameRevision"]},"attempt":attempt,"retryOf":retry_of,"createdAtMs":now,"updatedAtMs":now,"status":"queued"});
                let cancel = Arc::new(AtomicBool::new(false));
                s.cancel.insert(id.clone(), cancel.clone());
                s.jobs.push(job.clone());
                s.persist()?;
                drop(s);
                self.queue
                    .send((id, image, cancel))
                    .map_err(|_| "Develop worker has stopped.")?;
                Ok(job)
            }
            "darkroom:develop-jobs-cancel" | "darkroom:develop-jobs-discard" => {
                let id = text(&v["jobId"], "value")?;
                let mut s = lock(&self.state)?;
                let current = s.jobs[s.index(id)?].clone();
                let status = current["status"].as_str().unwrap_or("");
                let discard = channel.ends_with("-discard");
                let allowed = if discard {
                    &[
                        "awaiting-review",
                        "cancelled",
                        "failed",
                        "interrupted",
                        "stale",
                    ][..]
                } else {
                    &[
                        "queued",
                        "preparing",
                        "running",
                        "postprocess",
                        "awaiting-review",
                    ][..]
                };
                if !allowed.contains(&status) {
                    return Err(format!("Cannot change a {status} Develop job."));
                }
                if let Some(flag) = s.cancel.get(id) {
                    flag.store(true, Ordering::Relaxed);
                }
                if !(discard && current["reason"] == "acceptance-recovery") {
                    finalize(
                        &self.assets,
                        current["candidates"].as_array().unwrap_or(&vec![]),
                        if discard { "rejected" } else { "cancelled" },
                    )?;
                }
                let mut job = base(&current, if discard { "discarded" } else { "cancelled" });
                job["reason"] = json!(if discard {
                    "user-discarded"
                } else {
                    "user-requested"
                });
                s.replace(id, job.clone())?;
                Ok(if discard { Value::Null } else { job })
            }
            "darkroom:develop-jobs-consent-grant" => {
                assets::validate_source(&v["source"])?;
                assets::validate_ref(&v["selection"])?;
                let read = lock(&self.assets)?
                    .read(&json!({"reference":v["selection"],"sourceSignature":v["source"]}))?;
                if read["kind"] != "ready" {
                    return Err("Generative Remove selection is unavailable.".into());
                }
                let mut intent = v.clone();
                intent["kind"] = json!("generative-remove");
                let now = now_ms();
                let receipt = json!({"kind":"generative-remove-consent","id":uuid::Uuid::new_v4().to_string(),"provider":"local-mock-remove-v1","disclosure":"local-processing-no-network-v1","sourceRevision":source_revision(&v["source"]),"selectionAssetId":v["selection"]["assetId"],"intentHash":parameter_hash(&intent)?,"grantedAtMs":now,"expiresAtMs":now+15*60*1000,"revokedAtMs":null});
                let mut s = lock(&self.state)?;
                s.consents.push(receipt.clone());
                if s.consents.len() > 256 {
                    s.consents.retain(|c| {
                        c["revokedAtMs"].is_null() && c["expiresAtMs"].as_u64().unwrap_or(0) > now
                    });
                    let remove = s.consents.len().saturating_sub(256);
                    s.consents.drain(..remove);
                }
                s.persist()?;
                Ok(receipt)
            }
            "darkroom:develop-jobs-consent-revoke" => {
                let mut s = lock(&self.state)?;
                let receipt = s
                    .consents
                    .iter_mut()
                    .find(|r| r["id"] == v["receiptId"])
                    .ok_or("Consent receipt was not found.")?;
                if receipt["revokedAtMs"].is_null() {
                    receipt["revokedAtMs"] =
                        json!(now_ms().min(receipt["expiresAtMs"].as_u64().unwrap()));
                }
                let result = receipt.clone();
                s.persist()?;
                Ok(result)
            }
            "darkroom:develop-jobs-accept" => self.accept(v),
            _ => Err(format!("Unknown Develop job command: {channel}")),
        }
    }
    fn accept(&mut self, v: &Value) -> Result<Value, String> {
        let id = text(&v["jobId"], "value")?;
        assets::validate_source(&v["currentSource"])?;
        let mut s = lock(&self.state)?;
        let current = s.jobs[s.index(id)?].clone();
        if current["status"] != "awaiting-review"
            && !(current["status"] == "interrupted" && current["reason"] == "acceptance-recovery")
        {
            return Err("Only reviewed prototype results can be accepted.".into());
        }
        let stale = if current["request"]["sourceRevision"] != source_revision(&v["currentSource"])
        {
            Some("source-revision")
        } else if current["request"]["documentRevision"] != v["currentDocumentRevision"] {
            Some("document-revision")
        } else if current["request"]["frameRevision"] != v["currentFrameRevision"] {
            Some("frame-revision")
        } else {
            None
        };
        if let Some(reason) = stale {
            let mut job = base(&current, "stale");
            job["reason"] = json!(reason);
            job["candidates"] = current["candidates"].clone();
            s.replace(id, job)?;
            return Err("Prototype result is stale for the current Develop revision.".into());
        }
        let ids = v["candidateIds"]
            .as_array()
            .filter(|a| a.len() == 1)
            .ok_or("Exactly one prototype candidate must be selected.")?;
        let candidates = current["candidates"]
            .as_array()
            .ok_or("Prototype candidates are missing.")?;
        let selected = candidates
            .iter()
            .find(|c| c["candidateId"] == ids[0])
            .ok_or("Selected prototype candidate was not reviewed.")?
            .clone();
        validate_candidate_set(&current, candidates, current["status"] == "awaiting-review")?;
        let mut accepting = base(&current, "accepting");
        accepting["candidates"] = json!([selected]);
        accepting["acceptanceId"] = if current["status"] == "interrupted" {
            current["acceptanceId"].clone()
        } else {
            json!(uuid::Uuid::new_v4().to_string())
        };
        s.replace(id, accepting.clone())?;
        let reference = assets::accepted_ref(&selected);
        let now = now_ms();
        let result=lock(&self.assets)?.transition(&json!({"candidate":selected,"lifecycle":"accepted","reference":reference,"nowMs":now,"recoveryUntilMs":now+RECOVERY}))?;
        if !["changed", "unchanged"].contains(&result["kind"].as_str().unwrap_or("")) {
            let mut failed = base(&accepting, "failed");
            failed["failure"] = failure(
                "integrity-error",
                "Prototype artifact could not be verified for acceptance.",
            );
            s.replace(id, failed)?;
            return Err("Prototype artifact failed acceptance verification.".into());
        }
        let mut accepted = base(&accepting, "accepted");
        accepted["assets"] = json!([reference]);
        accepted["acceptanceId"] = accepting["acceptanceId"].clone();
        s.replace(id, accepted.clone())?;
        Ok(json!({"kind":"artifact-published-document-pending","job":accepted}))
    }
}
fn validate_candidate_set(job: &Value, candidates: &[Value], exact: bool) -> Result<(), String> {
    let count = if job["request"]["kind"] == "generative-remove" {
        2
    } else {
        1
    };
    let mut ids = std::collections::HashSet::new();
    let mut hashes = std::collections::HashSet::new();
    if candidates.is_empty() || (exact && candidates.len() != count) {
        return Err("Prototype candidate count is invalid.".into());
    }
    for c in candidates {
        assets::validate_candidate(c)?;
        let d = &c["descriptor"];
        if !ids.insert(text(c, "candidateId")?)
            || !hashes.insert(text(d, "sha256")?)
            || d["kind"]
                != if job["request"]["kind"] == "depth" {
                    "depth-map"
                } else {
                    "repair-patch"
                }
            || !assets::source_matches(&d["sourceSignature"], &job["request"]["source"])
            || d["coordinateFrameRevision"] != job["request"]["frameRevision"]["value"]
            || d["producerId"] != job["provenance"]["algorithmId"]
            || d["producerRevision"] != job["provenance"]["algorithmRevision"]
        {
            return Err("Prototype candidate provenance is invalid.".into());
        }
    }
    Ok(())
}
fn update(
    state: &Arc<Mutex<State>>,
    id: &str,
    status: &str,
    fields: Value,
) -> Result<Value, String> {
    let mut s = lock(state)?;
    let current = &s.jobs[s.index(id)?];
    if ["cancelled", "discarded"].contains(&current["status"].as_str().unwrap_or("")) {
        return Err("cancelled".into());
    }
    let mut next = base(current, status);
    for (k, v) in fields.as_object().unwrap() {
        next[k] = v.clone();
    }
    s.replace(id, next)
}
fn run(
    state: &Arc<Mutex<State>>,
    assets: &Arc<Mutex<DevelopAssets>>,
    id: &str,
    image: Image,
    cancel: &AtomicBool,
) {
    let mut stored = vec![];
    let result = (|| -> Result<(), String> {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let mut job = update(state, id, "preparing", json!({"stage":"validating-input"}))?;
        job = update(
            state,
            id,
            "running",
            json!({"stage":if job["request"]["kind"]=="generative-remove"{"provider-request"}else{"processing"},"progress":{"completed":0,"total":1}}),
        )?;
        let request = &job["request"];
        let selection = if request["kind"] == "generative-remove" {
            if !lock(state)?.consent_valid(request) {
                return Err("privacy-limit".into());
            }
            let selected = lock(assets)?.read(
                &json!({"reference":request["selection"],"sourceSignature":request["source"]}),
            )?;
            if selected["kind"] != "ready" {
                return Err("unsupported-input".into());
            }
            let bytes = crate::native::parse_binary(&selected["bytes"])?;
            let decoded = image::load_from_memory(&bytes)
                .map_err(|_| "unsupported-input")?
                .resize_exact(
                    image.width as u32,
                    image.height as u32,
                    image::imageops::FilterType::Nearest,
                )
                .to_rgba8();
            let alpha = decoded.pixels().any(|p| p[3] != 255);
            let mask = decoded
                .pixels()
                .map(|p| p[if alpha { 3 } else { 0 }])
                .collect::<Vec<_>>();
            if !lock(state)?.consent_valid(request) {
                return Err("privacy-limit".into());
            }
            update(
                state,
                id,
                "running",
                json!({"stage":"provider-response","progress":{"completed":0,"total":1}}),
            )?;
            Some(mask)
        } else {
            None
        };
        let output = prototype::process(request, &image, selection.as_deref(), cancel)?;
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let count = match &output {
            Output::Depth(_) => 1,
            Output::Images(images) => images.len(),
        };
        job = update(
            state,
            id,
            "postprocess",
            json!({"stage":"encoding-artifacts","progress":{"completed":0,"total":count}}),
        )?;
        let mut encoded = vec![];
        match output {
            Output::Depth(values) => {
                let mut bytes = Vec::with_capacity(24 + values.len() * 4);
                bytes.extend_from_slice(b"DRDEPTH\0");
                bytes.extend_from_slice(&1u16.to_le_bytes());
                bytes.extend_from_slice(&[1, 1]);
                bytes.extend_from_slice(&(image.width as u32).to_le_bytes());
                bytes.extend_from_slice(&(image.height as u32).to_le_bytes());
                bytes.extend_from_slice(&(image.width as u32 * 4).to_le_bytes());
                for value in values {
                    bytes.extend_from_slice(&value.to_le_bytes());
                }
                encoded.push((
                    bytes,
                    image.width,
                    image.height,
                    "depth-map",
                    "canonical-geometry",
                ));
            }
            Output::Images(images) => {
                for image in images {
                    let mut bytes = vec![];
                    image::codecs::png::PngEncoder::new_with_quality(
                        &mut bytes,
                        image::codecs::png::CompressionType::Default,
                        image::codecs::png::FilterType::Adaptive,
                    )
                    .write_image(
                        &image.pixels,
                        image.width as u32,
                        image.height as u32,
                        if image.channels == 3 {
                            image::ExtendedColorType::Rgb8
                        } else {
                            image::ExtendedColorType::Rgba8
                        },
                    )
                    .map_err(|e| e.to_string())?;
                    encoded.push((
                        bytes,
                        image.width,
                        image.height,
                        "repair-patch",
                        "source-repair",
                    ));
                }
            }
        }
        let mut candidates = vec![];
        for (i, (bytes, width, height, kind, stage)) in encoded.iter().enumerate() {
            let candidate = json!({"kind":"candidate","candidateId":format!("{id}:{i}"),"descriptor":{"kind":kind,"sha256":digest(bytes),"sourceSignature":job["request"]["source"],"coordinateFrameRevision":assets::FRAME,"colorStageId":stage,"dimensions":{"width":width,"height":height},"byteLength":bytes.len(),"mimeType":if *kind=="depth-map"{"application/x-darkroom-depth"}else{"image/png"},"producerId":job["provenance"]["algorithmId"],"producerRevision":job["provenance"]["algorithmRevision"]}});
            candidates.push(candidate);
        }
        validate_candidate_set(&job, &candidates, true)?;
        for (i, candidate) in candidates.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let now = now_ms();
            let result = lock(assets)?.put(
                &json!({"candidate":candidate,"nowMs":now,"recoveryUntilMs":now+RECOVERY}),
                &encoded[i].0,
            )?;
            if result["kind"] == "rejected" {
                return Err("integrity-error".into());
            }
            stored.push(candidate.clone());
            update(
                state,
                id,
                "postprocess",
                json!({"stage":"encoding-artifacts","progress":{"completed":i+1,"total":count}}),
            )?;
        }
        update(
            state,
            id,
            "awaiting-review",
            json!({"candidates":candidates}),
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = finalize(
            assets,
            &stored,
            if cancel.load(Ordering::Relaxed) {
                "cancelled"
            } else {
                "rejected"
            },
        );
        if error != "cancelled" {
            let (code, message) = match error.as_str() {
                "device-limit" => (
                    "device-limit",
                    "Image exceeds the prototype processing limit.",
                ),
                "unsupported-input" => (
                    "unsupported-input",
                    "Prototype input or selection is unsupported.",
                ),
                "privacy-limit" => (
                    "privacy-limit",
                    "Generative Remove consent expired or was revoked.",
                ),
                "integrity-error" => (
                    "integrity-error",
                    "Prototype artifact failed integrity verification.",
                ),
                _ => (
                    "filesystem-error",
                    "Prototype processing or storage failed.",
                ),
            };
            let _ = update(
                state,
                id,
                "failed",
                json!({"failure":failure(code,message)}),
            );
        }
    }
    if let Ok(mut s) = lock(state) {
        s.cancel.remove(id);
    }
}
