use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

pub(super) struct StoredDraft {
    pub(super) public: Value,
    selected: HashMap<String, Value>,
    expires_at: i64,
}

fn filename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn observation(asset: &Value) -> Value {
    if asset["observedAt"].is_null()
        && asset["byteLength"].is_null()
        && asset["modifiedAt"].is_null()
        && asset["localFileId"].is_null()
    {
        Value::Null
    } else {
        json!({"byteLength":asset["byteLength"],"modifiedAt":asset["modifiedAt"],"localFileId":asset["localFileId"]})
    }
}

fn rank(asset: &Value, candidate: &Value) -> Option<&'static str> {
    if asset["fingerprint"]["status"] == "valid"
        && asset["fingerprint"]["sha256"] == candidate["fingerprint"]["sha256"]
        && !asset["fingerprint"]["sha256"].is_null()
    {
        return Some("exact-sha256");
    }
    if !asset["observation"]["localFileId"].is_null()
        && asset["observation"]["localFileId"] == candidate["observation"]["localFileId"]
    {
        return Some("local-file-identity");
    }
    if asset["relativePath"] == candidate["relativePath"]
        && !asset["observation"].is_null()
        && asset["observation"]["byteLength"] == candidate["observation"]["byteLength"]
        && asset["observation"]["modifiedAt"] == candidate["observation"]["modifiedAt"]
    {
        return Some("relative-observation");
    }
    if asset["filename"] == candidate["filename"]
        && !asset["observation"]["byteLength"].is_null()
        && asset["observation"]["byteLength"] == candidate["observation"]["byteLength"]
    {
        return Some("filename-size");
    }
    None
}

fn plan(
    catalog_id: &str,
    session_id: &str,
    operation_id: &str,
    missing: Vec<Value>,
    candidates: Vec<Value>,
) -> Value {
    let mut owners = HashMap::<String, usize>::new();
    for asset in &missing {
        for candidate in &candidates {
            if rank(asset, candidate) == Some("exact-sha256") {
                let id = candidate["candidateId"].as_str().unwrap_or("");
                *owners.entry(id.into()).or_default() += 1;
            }
        }
    }
    let mut preselected = Vec::new();
    let mut used = HashSet::new();
    for asset in &missing {
        let matches = candidates
            .iter()
            .filter(|c| rank(asset, c) == Some("exact-sha256"))
            .collect::<Vec<_>>();
        if matches.len() == 1
            && owners
                .get(matches[0]["candidateId"].as_str().unwrap_or(""))
                .copied()
                == Some(1)
        {
            let candidate_id = matches[0]["candidateId"].as_str().unwrap_or("").to_string();
            used.insert(candidate_id.clone());
            preselected.push(json!({"assetId":asset["assetId"],"candidateId":candidate_id,"rank":"exact-sha256"}));
        }
    }
    let mut suggestions = Vec::new();
    let mut ambiguous = 0usize;
    for asset in &missing {
        if let Some(pair) = preselected
            .iter()
            .find(|p| p["assetId"] == asset["assetId"])
        {
            suggestions.push(json!({"assetId":asset["assetId"],"rank":"exact-sha256","candidateIds":[pair["candidateId"]],"preselectedCandidateId":pair["candidateId"]}));
            continue;
        }
        let exact = candidates
            .iter()
            .filter(|c| rank(asset, c) == Some("exact-sha256"))
            .collect::<Vec<_>>();
        let (selected, match_rank) = if !exact.is_empty() {
            (exact, Some("exact-sha256"))
        } else {
            let mut result = (Vec::new(), None);
            for desired in [
                "local-file-identity",
                "relative-observation",
                "filename-size",
            ] {
                let matches = candidates
                    .iter()
                    .filter(|c| {
                        !used.contains(c["candidateId"].as_str().unwrap_or(""))
                            && rank(asset, c) == Some(desired)
                    })
                    .collect::<Vec<_>>();
                if !matches.is_empty() {
                    result = (matches, Some(desired));
                    break;
                }
            }
            result
        };
        if selected.len() > 1 {
            ambiguous += 1
        }
        suggestions.push(json!({"assetId":asset["assetId"],"rank":match_rank,"candidateIds":selected.iter().map(|v|v["candidateId"].clone()).collect::<Vec<_>>(),"preselectedCandidateId":null}));
    }
    json!({"catalogId":catalog_id,"sessionId":session_id,"operationId":operation_id,"missingAssets":missing,"candidates":candidates,"suggestions":suggestions,"preselectedPairs":preselected,"unresolvedAssetCount":missing.len()-used.len(),"ambiguousAssetCount":ambiguous,"expiresAt":now()+5*60*1000})
}

impl CatalogService {
    pub(super) fn relink_dispatch(&mut self, command: &str, args: &Value) -> Result<Value, String> {
        let input = first(args)?;
        self.require_session(input)?;
        self.relink_drafts
            .retain(|_, draft| draft.expires_at > now());
        match command {
            "darkroom:catalog-relink-files-prepare" => self.relink_prepare(args),
            "darkroom:catalog-relink-files-apply" => self.relink_apply(input),
            "darkroom:catalog-relink-files-cancel" => {
                let id = string(input, "operationId")?;
                self.relink_drafts.remove(id);
                Ok(Value::Null)
            }
            _ => Err("Unsupported relink command.".into()),
        }
    }

    fn relink_prepare(&mut self, args: &Value) -> Result<Value, String> {
        let input = first(args)?;
        let Some(paths) = args
            .as_array()
            .and_then(|v| v.get(1))
            .and_then(Value::as_array)
        else {
            return Ok(Value::Null);
        };
        if paths.is_empty() {
            return Ok(Value::Null);
        }
        if paths.len() > 250 {
            return Err("Relink candidate count is too large.".into());
        }
        if self.relink_drafts.len() >= 32 {
            return Err("Too many relink drafts are active.".into());
        }
        let catalog_id = string(input, "catalogId")?;
        let session_id = string(input, "sessionId")?;
        let roots = rows(
            self.db()?,
            "SELECT root_id AS rootId,canonical_path AS canonicalPath FROM roots WHERE catalog_id=? AND health='online' AND canonical_path IS NOT NULL ORDER BY root_id",
            vec![SqlValue::Text(catalog_id.into())],
        )?;
        if roots.is_empty() {
            return Err("No active catalog roots are available.".into());
        }
        let mut selected = HashMap::new();
        let mut seen = HashSet::new();
        let mut candidates = Vec::new();
        for value in paths {
            let path = value.as_str().ok_or("Relink selection is invalid.")?;
            let metadata =
                fs::symlink_metadata(path).map_err(|_| "Relink candidate is unavailable.")?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("Selected relink item is not a regular file.".into());
            }
            let canonical =
                fs::canonicalize(path).map_err(|_| "Relink candidate is unavailable.")?;
            if !seen.insert(canonical.clone()) {
                return Err("A relink file was selected more than once.".into());
            }
            let matches = roots
                .iter()
                .filter_map(|root| {
                    let base = Path::new(root["canonicalPath"].as_str()?);
                    canonical
                        .strip_prefix(base)
                        .ok()
                        .filter(|relative| !relative.as_os_str().is_empty())
                        .map(|relative| (root, relative))
                })
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                return Err(if matches.is_empty() {
                    "Selected relink file is outside active catalog roots."
                } else {
                    "Selected relink file belongs to multiple active roots."
                }
                .into());
            }
            let (root, relative) = matches[0];
            let relative_path = relative
                .to_str()
                .ok_or("Selected relink file has an invalid relative path.")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if relative_path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err("Selected relink file has an invalid relative path.".into());
            }
            let observed = fingerprint::file_observation(&metadata);
            let probe =
                json!({"canonicalRootPath":root["canonicalPath"],"relativePath":relative_path});
            let (state, sha, _) = fingerprint::hash(&probe, &AtomicBool::new(false));
            let fingerprint = if state == "indexed" {
                json!({"status":"valid","sha256":sha})
            } else {
                json!({"status":"failed","sha256":null})
            };
            let candidate_id = Uuid::new_v4().to_string();
            selected.insert(candidate_id.clone(),json!({"rootId":root["rootId"],"relativePath":relative_path,"absolutePath":canonical,"observation":observed}));
            candidates.push(json!({"candidateId":candidate_id,"rootId":root["rootId"],"relativePath":relative_path,"filename":filename(&relative_path),"observation":{"byteLength":observed["size"],"modifiedAt":observed["modifiedAt"],"localFileId":observed["localFileId"]},"fingerprint":fingerprint}));
        }
        let raw = rows(
            self.db()?,
            "SELECT a.asset_id AS assetId,a.root_id AS rootId,a.relative_path AS relativePath,a.observed_at AS observedAt,a.observed_byte_length AS byteLength,a.observed_modified_at AS modifiedAt,a.local_file_id AS localFileId,f.status AS fingerprintStatus,f.sha256 AS fingerprintSha256 FROM assets a JOIN fingerprints f ON f.catalog_id=a.catalog_id AND f.asset_id=a.asset_id WHERE a.catalog_id=? AND a.health='missing' ORDER BY a.relative_path,a.asset_id",
            vec![SqlValue::Text(catalog_id.into())],
        )?;
        if raw.len() > 250 {
            return Err("Relink missing asset count is too large.".into());
        }
        let missing=raw.iter().map(|asset|json!({"assetId":asset["assetId"],"rootId":asset["rootId"],"relativePath":asset["relativePath"],"filename":filename(asset["relativePath"].as_str().unwrap_or("")),"observation":observation(asset),"fingerprint":{"status":asset["fingerprintStatus"],"sha256":asset["fingerprintSha256"]}})).collect::<Vec<_>>();
        let operation_id = Uuid::new_v4().to_string();
        let draft = plan(catalog_id, session_id, &operation_id, missing, candidates);
        self.relink_drafts.insert(
            operation_id,
            StoredDraft {
                expires_at: draft["expiresAt"].as_i64().unwrap_or(0),
                public: draft.clone(),
                selected,
            },
        );
        Ok(draft)
    }

    fn relink_apply(&mut self, input: &Value) -> Result<Value, String> {
        let id = string(input, "operationId")?.to_string();
        let draft = self
            .relink_drafts
            .get(&id)
            .ok_or("Relink draft is missing or expired.")?;
        if draft.public["catalogId"] != input["catalogId"]
            || draft.public["sessionId"] != input["sessionId"]
        {
            return Err("Relink draft belongs to a different catalog session.".into());
        }
        let requested = field(input, "acceptedPairs")?
            .as_array()
            .ok_or("Relink accepted pairs are invalid.")?;
        if requested.len() > 250 {
            return Err("Relink accepted pair count is invalid.".into());
        }
        let mut pairs = draft.public["preselectedPairs"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut used_assets = pairs
            .iter()
            .filter_map(|v| v["assetId"].as_str().map(str::to_string))
            .collect::<HashSet<_>>();
        let mut used_candidates = pairs
            .iter()
            .filter_map(|v| v["candidateId"].as_str().map(str::to_string))
            .collect::<HashSet<_>>();
        for pair in requested {
            let asset_id = string(pair, "assetId")?;
            let candidate_id = string(pair, "candidateId")?;
            let suggestion = draft.public["suggestions"]
                .as_array()
                .and_then(|v| v.iter().find(|v| v["assetId"] == asset_id))
                .ok_or("Accepted relink pair is not in the draft.")?;
            if !suggestion["candidateIds"]
                .as_array()
                .is_some_and(|v| v.iter().any(|v| v == candidate_id))
            {
                return Err("Accepted relink pair is not in the draft.".into());
            }
            if used_assets.contains(asset_id) {
                if pairs
                    .iter()
                    .any(|v| v["assetId"] == asset_id && v["candidateId"] == candidate_id)
                {
                    continue;
                }
                return Err("Relink asset is already paired.".into());
            }
            if used_candidates.contains(candidate_id) {
                return Err("Relink candidates are one-to-one.".into());
            }
            used_assets.insert(asset_id.into());
            used_candidates.insert(candidate_id.into());
            pairs.push(
                json!({"assetId":asset_id,"candidateId":candidate_id,"rank":suggestion["rank"]}),
            );
        }
        let draft = self
            .relink_drafts
            .get(&id)
            .ok_or("Relink draft is missing or expired.")?;
        let catalog_id = string(input, "catalogId")?;
        let mut mutations = Vec::new();
        for pair in &pairs {
            let asset_id = string(pair, "assetId")?;
            let candidate_id = string(pair, "candidateId")?;
            let source = one(
                self.db()?,
                "SELECT health FROM assets WHERE catalog_id=? AND asset_id=?",
                values(&[&json!(catalog_id), &json!(asset_id)]),
            )?
            .ok_or("Relink source asset is missing.")?;
            if source["health"] != "missing" {
                return Err("Relink source asset is no longer missing.".into());
            }
            let candidate = draft
                .selected
                .get(candidate_id)
                .ok_or("Relink candidate is not in the draft.")?;
            let root=one(self.db()?,"SELECT canonical_path AS canonicalPath,health FROM roots WHERE catalog_id=? AND root_id=?",values(&[&json!(catalog_id),&candidate["rootId"]]))?.ok_or("Relink destination root is missing.")?;
            if root["health"] != "online" {
                return Err("Relink destination root is unavailable.".into());
            }
            let base = Path::new(string(&root, "canonicalPath")?);
            let path = Path::new(string(candidate, "absolutePath")?);
            if !path.starts_with(base)
                || fs::canonicalize(path)
                    .map_err(|_| "Relink candidate changed or is unavailable.")?
                    != path
            {
                return Err("Relink candidate changed or is unavailable.".into());
            }
            let metadata = fs::symlink_metadata(path)
                .map_err(|_| "Relink candidate changed or is unavailable.")?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("Relink candidate changed or is unavailable.".into());
            }
            let observed = fingerprint::file_observation(&metadata);
            if !fingerprint::same_stat(&observed, &candidate["observation"]) {
                return Err("Relink candidate changed or is unavailable.".into());
            }
            if one(self.db()?,"SELECT 1 FROM assets WHERE catalog_id=? AND root_id=? AND relative_path=? AND asset_id<>?",values(&[&json!(catalog_id),&candidate["rootId"],&candidate["relativePath"],&json!(asset_id)]))?.is_some() { return Err("Relink destination is already occupied.".into()) }
            mutations.push(json!({"kind":"asset-relocate","assetId":asset_id,"rootId":candidate["rootId"],"relativePath":candidate["relativePath"],"observation":{"byteLength":observed["size"],"modifiedAt":observed["modifiedAt"],"observedAt":now(),"localFileId":observed["localFileId"]},"health":"present"}));
        }
        let revision = self.revision(catalog_id)?;
        let applied = if mutations.is_empty() {
            json!({"catalogId":catalog_id,"revision":revision,"changed":false,"appliedMutations":0,"auditId":null})
        } else {
            self.apply(
                &json!({"catalogId":catalog_id,"expectedRevision":revision,"mutations":mutations}),
            )?
        };
        let draft = self
            .relink_drafts
            .remove(&id)
            .ok_or("Relink draft is missing or expired.")?;
        let unresolved = draft.public["missingAssets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| !used_assets.contains(v["assetId"].as_str().unwrap_or("")))
            .map(|v| v["assetId"].clone())
            .collect::<Vec<_>>();
        let mut result = json!({"catalogId":catalog_id,"sessionId":input["sessionId"],"operationId":id,"acceptedPairs":pairs,"unresolvedAssetIds":unresolved,"unresolvedAssetCount":unresolved.len(),"unresolvedCandidateCount":draft.public["candidates"].as_array().map_or(0,Vec::len)-used_candidates.len(),"ambiguousAssetCount":draft.public["ambiguousAssetCount"]});
        if let Some(object) = applied.as_object() {
            for (key, value) in object {
                result[key] = value.clone();
            }
        }
        Ok(result)
    }
}
