use std::{
    fs::{self, Metadata},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use rayon::prelude::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::assets::{check_open_regular, open_regular};

const MAGIC: &[u8; 8] = b"DRRAWPC1";
const HEADER_SIZE: usize = 80;
const MAX_ENTRY: usize = 2560 * 2560 * 6 + 1024 * 1024;
const CACHE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

const FULL_MAGIC: &[u8; 8] = b"DRRAWFC1";
const FULL_HEADER_SIZE: usize = 64;
const MAX_FULL_ENTRY: usize = 512 * 1024 * 1024;
const FULL_CACHE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;

static WRITER: Mutex<()> = Mutex::new(());
static FULL_WRITER: Mutex<()> = Mutex::new(());

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
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            hash.update(metadata.file_attributes().to_le_bytes());
            hash.update(metadata.creation_time().to_le_bytes());
            hash.update(metadata.last_write_time().to_le_bytes());
        }
        #[cfg(not(any(unix, windows)))]
        {
            let created = metadata
                .created()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos());
            hash.update(created.to_le_bytes());
        }
        hash.update(max_edge.to_le_bytes());
        hash.update(std::env::consts::ARCH.as_bytes());
        hash.update(revision.as_bytes());
        Some(Self {
            directory: root?.join("raw-previews-v1"),
            key: hash.finalize(),
        })
    }

    pub(super) fn if_enabled(
        enabled: bool,
        root: Option<&Path>,
        source: &Path,
        metadata: &Metadata,
        revision: &str,
        max_edge: u64,
    ) -> Option<Self> {
        enabled.then(|| Self::new(root, source, metadata, revision, max_edge)).flatten()
    }

    fn path(&self) -> PathBuf {
        self.directory.join(format!("{:x}.rawpreview", self.key))
    }

    pub(super) fn exists(&self) -> bool {
        self.path().is_file()
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

fn evict_ext(directory: &Path, extension: &str, limit: u64) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut entries: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != extension) {
                return None;
            }
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

fn evict(directory: &Path, limit: u64) {
    evict_ext(directory, "rawpreview", limit);
}

#[inline]
fn mix64(mut x: u64) -> u64 {
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

fn hash_chunk(seed: u64, bytes: &[u8]) -> u64 {
    let mut acc = seed ^ (bytes.len() as u64);
    let mut chunks = bytes.chunks_exact(8);
    for chunk in &mut chunks {
        let word = u64::from_le_bytes(chunk.try_into().unwrap());
        acc = acc.wrapping_mul(0x9e37_79b9_7f4a_7c15).rotate_left(27) ^ word;
    }
    let rem = chunks.remainder();
    if !rem.is_empty() {
        let mut tail = [0_u8; 8];
        tail[..rem.len()].copy_from_slice(rem);
        acc = acc.wrapping_mul(0x9e37_79b9_7f4a_7c15).rotate_left(27) ^ u64::from_le_bytes(tail);
    }
    mix64(acc)
}

fn fast_integrity_hash(metadata: &[u8], pixels: &[u8]) -> u64 {
    const STRIPE: usize = 4 * 1024 * 1024;
    let meta_hash = hash_chunk(0x243f_6a88_85a3_08d3, metadata);
    let stripe_hashes: Vec<u64> = if pixels.len() >= STRIPE
        && let Some(pool) = crate::compute::pool()
    {
        pool.install(|| {
            pixels
                .par_chunks(STRIPE)
                .enumerate()
                .map(|(index, chunk)| hash_chunk(index as u64 ^ 0x1319_8a2e_0370_7344, chunk))
                .collect()
        })
    } else {
        pixels
            .chunks(STRIPE)
            .enumerate()
            .map(|(index, chunk)| hash_chunk(index as u64 ^ 0x1319_8a2e_0370_7344, chunk))
            .collect()
    };
    let mut combined = meta_hash ^ (pixels.len() as u64);
    for h in stripe_hashes {
        combined = mix64(combined.wrapping_mul(0x517c_c1b7_2722_0a95) ^ h);
    }
    combined
}

/// Bounded persistent disk cache for expensive full-resolution Nikon SDK decodes.
/// Writes asynchronously from a shared `Arc<RawSource>` (zero extra copy / latency)
/// and reads back in ~40–80 ms on NVMe SSDs using a Rayon-parallel integrity check.
pub(super) struct FullDecodeCache {
    directory: PathBuf,
    key: sha2::digest::Output<Sha256>,
}

impl FullDecodeCache {
    pub(super) fn new(
        root: Option<&Path>,
        source: &Path,
        metadata: &Metadata,
        revision: &str,
    ) -> Option<Self> {
        let preview_key = PreviewCache::new(root, source, metadata, revision, u64::MAX)?;
        Some(Self {
            directory: root?.join("nikon-full-v1"),
            key: preview_key.key,
        })
    }

    fn path(&self) -> PathBuf {
        self.directory.join(format!("{:x}.rawfull", self.key))
    }

    pub(super) fn load(&self, flag: Option<&AtomicBool>) -> Option<(Value, Vec<u8>)> {
        if cancelled(flag) {
            return None;
        }
        let path = self.path();
        let (mut file, opened) = open_regular(&path).ok()?;
        if opened.len() < FULL_HEADER_SIZE as u64 {
            return None;
        }
        let mut header = [0_u8; FULL_HEADER_SIZE];
        file.read_exact(&mut header).ok()?;
        if &header[..8] != FULL_MAGIC || header[8..40] != self.key[..] {
            return None;
        }
        let expected_hash = u64::from_le_bytes(header[40..48].try_into().ok()?);
        let meta_len = u64::from_le_bytes(header[48..56].try_into().ok()?) as usize;
        let pixels_len = u64::from_le_bytes(header[56..64].try_into().ok()?) as usize;
        if meta_len == 0
            || meta_len > 64 * 1024
            || pixels_len == 0
            || pixels_len > MAX_FULL_ENTRY
            || (FULL_HEADER_SIZE as u64)
                .checked_add(meta_len as u64)
                .and_then(|n| n.checked_add(pixels_len as u64))
                != Some(opened.len())
        {
            return None;
        }
        let mut meta_bytes = vec![0_u8; meta_len];
        file.read_exact(&mut meta_bytes).ok()?;
        let metadata: Value = serde_json::from_slice(&meta_bytes).ok()?;
        if metadata["available"] != true || metadata["byteCount"].as_u64() != Some(pixels_len as u64) {
            return None;
        }
        let mut pixels = vec![0_u8; pixels_len];
        for chunk in pixels.chunks_mut(4 * 1024 * 1024) {
            if cancelled(flag) {
                return None;
            }
            file.read_exact(chunk).ok()?;
        }
        if cancelled(flag) {
            return None;
        }
        if fast_integrity_hash(&meta_bytes, &pixels) != expected_hash {
            return None;
        }
        check_open_regular(&path, &file, &opened).ok()?;
        let _ = file.set_modified(SystemTime::now());
        Some((metadata, pixels))
    }

    pub(super) fn store_arc(
        self,
        metadata: Value,
        source: Arc<crate::RawSource>,
        flag: Option<&AtomicBool>,
    ) {
        if source.data.is_empty() || source.data.len() > MAX_FULL_ENTRY || cancelled(flag) {
            return;
        }
        let Ok(meta_bytes) = serde_json::to_vec(&metadata) else {
            return;
        };
        if meta_bytes.is_empty() || meta_bytes.len() > 64 * 1024 {
            return;
        }
        let _ = std::thread::Builder::new().spawn(move || {
            self.store_inner(&meta_bytes, &source.data);
        });
    }

    fn store_inner(&self, meta_bytes: &[u8], pixels: &[u8]) {
        let Ok(_writer) = FULL_WRITER.lock() else {
            return;
        };
        let write = || -> std::io::Result<()> {
            fs::create_dir_all(&self.directory)?;
            let hash = fast_integrity_hash(meta_bytes, pixels);
            let mut temp = tempfile::NamedTempFile::new_in(&self.directory)?;
            temp.write_all(FULL_MAGIC)?;
            temp.write_all(&self.key)?;
            temp.write_all(&hash.to_le_bytes())?;
            temp.write_all(&(meta_bytes.len() as u64).to_le_bytes())?;
            temp.write_all(&(pixels.len() as u64).to_le_bytes())?;
            temp.write_all(meta_bytes)?;
            temp.write_all(pixels)?;
            temp.persist(self.path()).map_err(|error| error.error)?;
            evict_ext(&self.directory, "rawfull", FULL_CACHE_LIMIT);
            Ok(())
        };
        let _ = write();
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
        let in_flight = cache.directory.join(".tmp123456");
        fs::write(&in_flight, b"partial write from another process").unwrap();
        evict(&cache.directory, 0);
        assert!(cache.load(None).is_none());
        assert!(in_flight.exists(), "eviction must not remove in-flight temp files");
    }

    #[test]
    fn full_decode_cache_round_trip_invalidation_and_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("photo.nef");
        fs::write(&source, b"raw-he").unwrap();
        let metadata = fs::metadata(&source).unwrap();
        let cache =
            FullDecodeCache::new(Some(directory.path()), &source, &metadata, "nikon-v1").unwrap();
        let pixels = vec![0x5a_u8; 4 * 4 * 6];
        let meta = serde_json::json!({
            "available": true,
            "width": 4,
            "height": 4,
            "byteCount": pixels.len(),
        });
        let meta_bytes = serde_json::to_vec(&meta).unwrap();
        cache.store_inner(&meta_bytes, &pixels);
        let (loaded_meta, loaded_pixels) = cache.load(None).expect("expected full cache hit");
        assert_eq!(loaded_meta, meta);
        assert_eq!(loaded_pixels, pixels);
        assert!(
            FullDecodeCache::new(Some(directory.path()), &source, &metadata, "nikon-v2")
                .unwrap()
                .load(None)
                .is_none()
        );
        let mut corrupt = fs::read(cache.path()).unwrap();
        *corrupt.last_mut().unwrap() ^= 1;
        fs::write(cache.path(), &corrupt).unwrap();
        assert!(cache.load(None).is_none());
    }
}
