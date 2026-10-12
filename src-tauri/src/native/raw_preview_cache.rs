use std::{
    fs::{self, Metadata},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};

use super::assets::{check_open_regular, open_regular};

const MAGIC: &[u8; 8] = b"DRRAWPC1";
const HEADER_SIZE: usize = 80;
const MAX_ENTRY: usize = 2560 * 2560 * 6 + 1024 * 1024;
const CACHE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
static WRITER: Mutex<()> = Mutex::new(());

pub(super) struct PreviewCache {
    directory: PathBuf,
    key: sha2::digest::Output<Sha256>,
}

fn cancelled(flag: Option<&AtomicBool>) -> bool {
    flag.is_some_and(|flag| flag.load(Ordering::Relaxed))
}

impl PreviewCache {
    pub(super) fn new(
        root: Option<&Path>,
        source: &Path,
        metadata: &Metadata,
        revision: &str,
        max_edge: u64,
    ) -> Option<Self> {
        let mut hash = Sha256::new();
        let path = source.as_os_str().as_encoded_bytes();
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path);
        hash.update(metadata.len().to_le_bytes());
        hash.update(
            metadata
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_nanos()
                .to_le_bytes(),
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            hash.update(metadata.dev().to_le_bytes());
            hash.update(metadata.ino().to_le_bytes());
            hash.update(metadata.ctime().to_le_bytes());
            hash.update(metadata.ctime_nsec().to_le_bytes());
        }
        hash.update(max_edge.to_le_bytes());
        hash.update(std::env::consts::ARCH.as_bytes());
        hash.update(revision.as_bytes());
        Some(Self {
            directory: root?.join("raw-previews-v1"),
            key: hash.finalize(),
        })
    }

    fn path(&self) -> PathBuf {
        self.directory.join(format!("{:x}.rawpreview", self.key))
    }

    pub(super) fn load(&self, flag: Option<&AtomicBool>) -> Option<Vec<u8>> {
        let path = self.path();
        let (mut file, opened) = open_regular(&path).ok()?;
        if opened.len() < HEADER_SIZE as u64 || opened.len() > (HEADER_SIZE + MAX_ENTRY) as u64 {
            return None;
        }
        let mut header = [0_u8; HEADER_SIZE];
        file.read_exact(&mut header).ok()?;
        let length = u64::from_le_bytes(header[72..80].try_into().ok()?);
        if &header[..8] != MAGIC
            || header[8..40] != self.key[..]
            || length != opened.len() - HEADER_SIZE as u64
        {
            return None;
        }
        let mut bytes = vec![0_u8; length as usize];
        let mut digest = Sha256::new();
        for chunk in bytes.chunks_mut(64 * 1024) {
            if cancelled(flag) {
                return None;
            }
            file.read_exact(chunk).ok()?;
            digest.update(chunk);
        }
        if cancelled(flag) || digest.finalize()[..] != header[40..72] {
            return None;
        }
        check_open_regular(&path, &file, &opened).ok()?;
        let _ = file.set_modified(SystemTime::now());
        Some(bytes)
    }

    pub(super) fn store(self, bytes: &[u8], flag: Option<&AtomicBool>) {
        if bytes.len() > MAX_ENTRY || cancelled(flag) {
            return;
        }
        let bytes = bytes.to_vec();
        let _ = std::thread::Builder::new().spawn(move || self.store_inner(&bytes));
    }

    fn store_inner(&self, bytes: &[u8]) {
        let Ok(_writer) = WRITER.lock() else {
            return;
        };
        let write = || -> std::io::Result<()> {
            fs::create_dir_all(&self.directory)?;
            let mut temp = tempfile::NamedTempFile::new_in(&self.directory)?;
            temp.write_all(MAGIC)?;
            temp.write_all(&self.key)?;
            temp.write_all(&Sha256::digest(bytes))?;
            temp.write_all(&(bytes.len() as u64).to_le_bytes())?;
            temp.write_all(bytes)?;
            temp.persist(self.path()).map_err(|error| error.error)?;
            evict(&self.directory, CACHE_LIMIT);
            Ok(())
        };
        let _ = write();
    }
}

fn evict(directory: &Path, limit: u64) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut entries: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            metadata
                .is_file()
                .then_some((metadata.modified().ok()?, metadata.len(), path))
        })
        .collect();
    let mut total: u64 = entries.iter().map(|entry| entry.1).sum();
    entries.sort_unstable_by_key(|entry| entry.0);
    for (_, size, path) in entries {
        if total <= limit {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total -= size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[test]
    fn preview_round_trip_invalidation_and_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("photo.nef");
        fs::write(&source, b"raw").unwrap();
        let metadata = fs::metadata(&source).unwrap();
        let cache = PreviewCache::new(
            Some(directory.path()),
            &source,
            &metadata,
            "decoder-v1",
            2560,
        )
        .unwrap();
        let packet = b"metadata and exact RGB16 bytes\x00\xff";
        cache.store_inner(packet);
        assert_eq!(cache.load(None).unwrap(), packet);
        for (path, revision, edge) in [
            (source.as_path(), "decoder-v2", 2560),
            (source.as_path(), "decoder-v1", 720),
            (directory.path(), "decoder-v1", 2560),
        ] {
            assert!(
                PreviewCache::new(Some(directory.path()), path, &metadata, revision, edge)
                    .unwrap()
                    .load(None)
                    .is_none()
            );
        }
        let mut changed = File::options().write(true).open(&source).unwrap();
        changed
            .set_times(
                fs::FileTimes::new().set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1)),
            )
            .unwrap();
        let modified = fs::metadata(&source).unwrap();
        assert!(
            PreviewCache::new(
                Some(directory.path()),
                &source,
                &modified,
                "decoder-v1",
                2560
            )
            .unwrap()
            .load(None)
            .is_none()
        );
        changed.write_all(b"longer raw").unwrap();
        let resized = fs::metadata(&source).unwrap();
        assert!(
            PreviewCache::new(
                Some(directory.path()),
                &source,
                &resized,
                "decoder-v1",
                2560
            )
            .unwrap()
            .load(None)
            .is_none()
        );
        let flag = AtomicBool::new(true);
        assert!(cache.load(Some(&flag)).is_none());
        let mut corrupt = fs::read(cache.path()).unwrap();
        *corrupt.last_mut().unwrap() ^= 1;
        fs::write(cache.path(), &corrupt).unwrap();
        assert!(cache.load(None).is_none());
        fs::write(cache.path(), &corrupt[..corrupt.len() - 1]).unwrap();
        assert!(cache.load(None).is_none());
        cache.store_inner(packet);
        corrupt = fs::read(cache.path()).unwrap();
        corrupt[8] ^= 1;
        fs::write(cache.path(), &corrupt).unwrap();
        assert!(cache.load(None).is_none());
        cache.store_inner(packet);
        evict(&cache.directory, 0);
        assert!(cache.load(None).is_none());
    }
}
