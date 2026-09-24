use std::sync::OnceLock;

pub fn pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: OnceLock<Option<rayon::ThreadPool>> = OnceLock::new();
    POOL.get_or_init(|| {
        let workers = std::thread::available_parallelism()
            .map_or(1, |count| count.get().saturating_sub(1).max(1));
        if workers == 1 {
            return None;
        }
        rayon::ThreadPoolBuilder::new()
            .num_threads(workers)
            .thread_name(|index| format!("darkroom-compute-{index}"))
            .build()
            .ok()
    })
    .as_ref()
}
