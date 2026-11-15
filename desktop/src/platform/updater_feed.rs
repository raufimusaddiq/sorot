//! The real update feed: HTTP only. `latest.json` and its `.sig` are fetched, and
//! `update::manifest_signature_valid` checks them against the app's public key; cargo-packager-updater
//! finds the installer and verifies the installer's own signature before it installs.
use std::sync::Mutex;
use std::time::Duration;

use cargo_packager_updater::{reqwest::blocking::Client, semver::Version, Config, Update, UpdaterBuilder};

use crate::update::{manifest_signature_valid, Found, UpdateFeed};

const ENDPOINT: &str = "https://github.com/raufimusaddiq/sorot/releases/latest/download/latest.json";

/// `SOROT_UPDATE_PUBKEY` is the public minisign key, set when the release workflow builds.
pub struct GithubFeed {
    pubkey: &'static str,
    found: Mutex<Option<Update>>,
}

impl Default for GithubFeed {
    fn default() -> Self {
        Self::new()
    }
}

impl GithubFeed {
    pub fn new() -> Self {
        GithubFeed { pubkey: option_env!("SOROT_UPDATE_PUBKEY").unwrap_or(""), found: Mutex::new(None) }
    }
}

impl UpdateFeed for GithubFeed {
    fn fetch(&self) -> Result<Found, String> {
        let get = |url: String| -> Result<Vec<u8>, String> {
            let client = Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
            let r = client.get(url).send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
            r.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
        };
        let manifest = get(ENDPOINT.into())?;
        let sig = get(format!("{ENDPOINT}.sig")).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        let signature_valid = manifest_signature_valid(&manifest, &sig, self.pubkey);
        let feed = String::from_utf8_lossy(&manifest).into_owned();
        if signature_valid {
            let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
            let config = Config { endpoints: vec![ENDPOINT.parse().map_err(|e: cargo_packager_updater::url::ParseError| e.to_string())?], pubkey: self.pubkey.into(), windows: None };
            let updater = UpdaterBuilder::new(current, config).timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
            *self.found.lock().unwrap() = updater.check().map_err(|e| e.to_string())?;
        }
        Ok(Found { feed, signature_valid })
    }

    fn install(&self) -> Result<(), String> {
        let update = self.found.lock().unwrap().take().ok_or("No update to install")?;
        update.download_and_install().map_err(|e| e.to_string())
    }
}
