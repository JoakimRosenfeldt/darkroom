use super::*;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Read};

pub struct ExactDuplicateTrashPlan {
    keeper: Value,
    targets: Vec<(String, Option<Value>)>,
}

fn fingerprint(
    location: &Value,
) -> Result<(u64, String, fs::Metadata, Option<(u64, u64)>), String> {
    let path = crate::native::resolve_asset_path(location)?;
    let before = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err("Fingerprint source is not a regular file.".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let identity = Some(
        crate::native::windows_handle_identity(&file)
            .ok_or("Fingerprint source identity is unavailable.")?,
    );
    #[cfg(not(windows))]
    let identity = None;
    #[cfg(windows)]
    if crate::native::windows_path_identity(&path) != identity {
        return Err("Fingerprint source changed before it was opened.".into());
    }
    if !same_file(&before, &opened) {
        return Err("Fingerprint source changed before it was opened.".into());
    }
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|e| e.to_string())?;
    let path_after = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if crate::native::windows_handle_identity(&file) != identity
        || crate::native::windows_path_identity(&path) != identity
    {
        return Err("Fingerprint source changed while it was read.".into());
    }
    if bytes != opened.len() || !same_file(&opened, &after) || !same_file(&after, &path_after) {
        return Err("Fingerprint source changed while it was read.".into());
    }
    Ok((bytes, format!("{:x}", hash.finalize()), after, identity))
}
#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.is_file()
        && right.is_file()
        && left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
}
#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.is_file()
        && right.is_file()
        && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
}

pub fn run_exact_duplicate_trash(plan: ExactDuplicateTrashPlan) -> Result<Value, String> {
    let keeper_path = crate::native::resolve_asset_path(&plan.keeper)
        .map_err(|_| "The keeper could not be verified before trashing duplicates.")?;
    let keeper = fingerprint(&plan.keeper)
        .map_err(|_| "The keeper could not be verified before trashing duplicates.")?;
    let mut items = Vec::with_capacity(plan.targets.len());
    for (entry_id, location) in plan.targets {
        let result = (|| -> Result<(), String> {
            let location = location.ok_or("Duplicate member is no longer present.")?;
            let path = crate::native::resolve_asset_path(&location)?;
            if path == keeper_path {
                return Err("Keeper and duplicate resolve to the same path.".into());
            }
            let keeper_now = fingerprint(&plan.keeper)
                .map_err(|_| "The keeper changed before trashing duplicates.")?;
            if keeper_now.0 != keeper.0
                || keeper_now.1 != keeper.1
                || !same_file(&keeper.2, &keeper_now.2)
                || keeper_now.3 != keeper.3
            {
                return Err("The keeper changed before trashing duplicates.".into());
            }
            let target = fingerprint(&location)?;
            if target.0 != keeper.0 || target.1 != keeper.1 {
                return Err("File changed or is no longer byte-identical to the keeper.".into());
            }
            let before_trash = fs::symlink_metadata(&path)
                .map_err(|_| "Duplicate changed before it could be moved to trash.")?;
            if !same_file(&target.2, &before_trash) {
                return Err("Duplicate changed before it could be moved to trash.".into());
            }
            #[cfg(windows)]
            if crate::native::windows_path_identity(&path) != target.3 {
                return Err("Duplicate changed before it could be moved to trash.".into());
            }
            trash::delete(&path).map_err(|_| {
                format!(
                    "Could not move \"{}\" to the trash.",
                    path.file_name().unwrap_or_default().to_string_lossy()
                )
            })
        })();
        match result {
            Ok(()) => items.push(json!({"entryId":entry_id,"trashed":true,"error":null})),
            Err(error) => items.push(json!({"entryId":entry_id,"trashed":false,"error":error})),
        }
    }
    Ok(json!({"items":items}))
}

impl CatalogService {
    pub fn prepare_exact_duplicate_trash(
        &self,
        request: &Value,
    ) -> Result<ExactDuplicateTrashPlan, String> {
        self.require_session(request)?;
        let keeper_id = string(request, "keeperId")?;
        Uuid::parse_str(keeper_id).map_err(|_| "Exact duplicate keeper is invalid.")?;
        let ids = request["targetIds"]
            .as_array()
            .filter(|ids| !ids.is_empty() && ids.len() <= 10_000)
            .ok_or("Exact duplicate trash targets are invalid.")?;
        let mut seen = HashSet::new();
        let mut target_ids = Vec::new();
        for value in ids {
            let id = value
                .as_str()
                .ok_or("Exact duplicate trash targets are invalid.")?;
            Uuid::parse_str(id).map_err(|_| "Exact duplicate trash targets are invalid.")?;
            if id != keeper_id && seen.insert(id.to_owned()) {
                target_ids.push(id.to_owned());
            }
        }
        if target_ids.is_empty() {
            return Err("Exact duplicate trash needs a non-keeper target.".into());
        }
        let resolve = |id: &str| -> Option<Value> {
            let row=one(self.db().ok()?,"SELECT a.health,r.health AS rootHealth FROM assets a JOIN roots r ON r.catalog_id=a.catalog_id AND r.root_id=a.root_id WHERE a.catalog_id=? AND a.asset_id=?",vec![SqlValue::Text(string(request,"catalogId").ok()?.into()),SqlValue::Text(id.into())]).ok()??;
            if row["health"] != "present" || row["rootHealth"] != "online" {
                return None;
            }
            self.resolve_asset(&json!({"catalogId":request["catalogId"],"sessionId":request["sessionId"],"assetId":id})).ok()
        };
        let keeper = resolve(keeper_id)
            .ok_or("The keeper could not be verified before trashing duplicates.")?;
        let targets = target_ids
            .into_iter()
            .map(|id| {
                let location = resolve(&id);
                (id, location)
            })
            .collect();
        Ok(ExactDuplicateTrashPlan { keeper, targets })
    }
}
