pub(crate) mod apply;
pub(crate) mod batch;
pub(crate) mod clipboard;
pub(crate) mod assets;
mod defaults;
pub(crate) mod default_install;
pub(crate) mod jobs;
pub(crate) mod presets;
pub(crate) mod profiles;
pub(crate) mod prototype;
pub(crate) mod store_io;

use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

pub struct DevelopService {
    pub jobs: jobs::JobService,
    pub assets: Arc<Mutex<assets::DevelopAssets>>,
    pub presets: presets::PresetStore,
    pub profiles: profiles::ProfileStore,
    pub defaults: defaults::DefaultsStore,
}

impl DevelopService {
    pub fn new(app_data: &Path) -> Result<Self, String> {
        let assets = Arc::new(Mutex::new(assets::DevelopAssets::new(app_data)?));
        let jobs = jobs::JobService::new(app_data, assets.clone())?;
        Ok(Self {
            assets,
            jobs,
            presets: presets::PresetStore::new(app_data)?,
            profiles: profiles::ProfileStore::new(app_data)?,
            defaults: defaults::DefaultsStore::new(app_data)?,
        })
    }

    pub fn handle(&mut self, channel: &str, args: &[Value]) -> Result<Value, String> {
        if channel.starts_with("darkroom:develop-jobs-") {
            self.jobs.handle(channel, args)
        } else if channel.starts_with("darkroom:develop-asset-") {
            self.assets
                .lock()
                .map_err(|_| "Develop asset store is unavailable.".to_owned())?
                .handle(channel, args)
        } else if channel.starts_with("darkroom:develop-presets-") {
            self.presets.handle(channel, args)
        } else if channel.starts_with("darkroom:camera-profiles-") {
            self.profiles.handle(channel, args)
        } else if channel.starts_with("darkroom:develop-defaults-") {
            self.defaults
                .handle(channel, args.first().unwrap_or(&Value::Null), &self.presets)
        } else {
            Err(format!("Unknown Develop command: {channel}"))
        }
    }
}
