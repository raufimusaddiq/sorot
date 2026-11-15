//! Staying current: check at launch and every 24 h, offer a newer signed release without
//! blocking, install only when the user clicks. The feed (network, minisign) sits behind
//! `UpdateFeed`; `core::update::decide` says what to do with its answer.

use std::sync::Arc;
use std::time::Duration;

use sorot_desktop_core::update::{decide, parse_version, Decision, Version};

use crate::engine::sidecar::Clock;

/// A minisign key or signature as the packager writes it (the whole `.pub`/`.sig` text,
/// base64-encoded), as minisign writes it, or (a key) as its bare base64 line.
fn minisign_text(s: &str) -> Option<String> {
    use base64::Engine;
    let s = s.trim();
    if s.starts_with("untrusted comment") {
        return Some(s.to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(s).ok()?;
    String::from_utf8(bytes).ok()
}

/// Whether `signature` is a valid minisign signature of the `latest.json` bytes under the
/// app's public key. An empty key, a missing signature or any malformed input is `false`.
pub fn manifest_signature_valid(manifest: &[u8], signature: &str, pubkey: &str) -> bool {
    use minisign_verify::{PublicKey, Signature};
    let key = PublicKey::from_base64(pubkey.trim()).ok().or_else(|| PublicKey::decode(&minisign_text(pubkey)?).ok());
    let sig = minisign_text(signature).and_then(|t| Signature::decode(&t).ok());
    matches!((key, sig), (Some(k), Some(s)) if k.verify(manifest, &s, false).is_ok())
}

pub const CHECK_EVERY: Duration = Duration::from_secs(24 * 3600);

/// What a feed fetch found: the `latest.json` text and whether the release's signature checks
/// out against the public key built into the app.
pub struct Found {
    pub feed: String,
    pub signature_valid: bool,
}

pub trait UpdateFeed: Send + Sync {
    fn fetch(&self) -> Result<Found, String>;
    /// Downloads and installs the release the last `fetch` found. Only ever called on a click.
    fn install(&self) -> Result<(), String>;
}

/// The shell calls `tick` from a worker thread (it may wait on the network), shows a toast when
/// it returns an offer, and calls `install` or `decline` from the toast's buttons.
pub struct Updater {
    feed: Arc<dyn UpdateFeed>,
    clock: Arc<dyn Clock>,
    current: String,
    last_check: Option<Duration>,
    offered: Option<Version>,
    seen: Vec<Version>,
    declined: bool,
}

impl Updater {
    pub fn new(feed: Arc<dyn UpdateFeed>, clock: Arc<dyn Clock>, current: &str) -> Self {
        Updater { feed, clock, current: current.to_string(), last_check: None, offered: None, seen: Vec::new(), declined: false }
    }

    /// Checks when it is the first call or 24 h passed since the last check. Returns a version
    /// to announce only the first time it is found, and never after a decline this session.
    pub fn tick(&mut self) -> Option<Version> {
        let now = self.clock.now();
        if self.last_check.is_some_and(|t| now.saturating_sub(t) < CHECK_EVERY) {
            return None;
        }
        self.last_check = Some(now);
        self.check()
    }

    /// A check now, whatever the clock says ("Check for updates").
    pub fn check(&mut self) -> Option<Version> {
        let found = self.feed.fetch().ok()?;
        match decide(&self.current, &found.feed, found.signature_valid) {
            Decision::Offer(v) => {
                self.offered = Some(v);
                let fresh = !self.seen.contains(&v);
                self.seen.push(v);
                (!self.declined && fresh).then_some(v)
            }
            Decision::UpToDate | Decision::Ignore => {
                self.offered = None;
                None
            }
        }
    }

    /// The release waiting for the user's answer.
    pub fn offer(&self) -> Option<Version> {
        self.offered
    }

    /// "Not now": no more prompts until the app restarts.
    pub fn decline(&mut self) {
        self.declined = true;
    }

    /// The click on "Install and restart". Without an offer it does nothing.
    pub fn install(&mut self) -> Result<(), String> {
        match self.offered {
            Some(_) => self.feed.install(),
            None => Err("No update to install".into()),
        }
    }

    pub fn current(&self) -> Option<Version> {
        parse_version(&self.current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::fake::FakeClock;
    use std::sync::Mutex;

    struct FakeFeed {
        version: Mutex<String>,
        signed: bool,
        fetches: Mutex<u32>,
        installs: Mutex<u32>,
    }

    impl UpdateFeed for FakeFeed {
        fn fetch(&self) -> Result<Found, String> {
            *self.fetches.lock().unwrap() += 1;
            let v = self.version.lock().unwrap().clone();
            if v.is_empty() {
                return Err("offline".into());
            }
            Ok(Found { feed: format!(r#"{{"version":"{v}"}}"#), signature_valid: self.signed })
        }

        fn install(&self) -> Result<(), String> {
            *self.installs.lock().unwrap() += 1;
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    enum Act {
        Tick,
        Wait(u64),
        Decline,
        Install,
        Publish(&'static str),
    }

    fn run(signed: bool, first: &str, acts: &[Act]) -> (Vec<Option<u32>>, u32, u32, Option<bool>) {
        let feed = Arc::new(FakeFeed { version: Mutex::new(first.into()), signed, fetches: Mutex::new(0), installs: Mutex::new(0) });
        let clock = Arc::new(FakeClock::default());
        let mut u = Updater::new(feed.clone(), clock.clone(), "1.0.0");
        let (mut shown, mut installed) = (vec![], None);
        for a in acts {
            match *a {
                Act::Tick => shown.push(u.tick().map(|v| v.minor)),
                Act::Wait(h) => clock.advance(Duration::from_secs(h * 3600)),
                Act::Decline => u.decline(),
                Act::Install => installed = Some(u.install().is_ok()),
                Act::Publish(v) => *feed.version.lock().unwrap() = v.into(),
            }
        }
        let (f, i) = (*feed.fetches.lock().unwrap(), *feed.installs.lock().unwrap());
        (shown, f, i, installed)
    }

    #[test]
    fn an_update_is_offered_once_and_installed_only_on_a_click() {
        use Act::*;
        // (name, signed, first feed version, actions) -> (announced, fetches, installs, install ok)
        type Row = (&'static str, bool, &'static str, Vec<Act>, (Vec<Option<u32>>, u32, u32, Option<bool>));
        let rows: Vec<Row> = vec![
            ("offer then click", true, "1.2.0", vec![Tick, Install], (vec![Some(2)], 1, 1, Some(true))),
            ("no click, no install", true, "1.2.0", vec![Tick, Wait(30), Tick], (vec![Some(2), None], 2, 0, None)),
            ("within 24 h is not asked again", true, "1.2.0", vec![Tick, Wait(23), Tick], (vec![Some(2), None], 1, 0, None)),
            ("declined: no prompt for a newer one either", true, "1.2.0", vec![Tick, Decline, Wait(24), Publish("1.3.0"), Tick, Install], (vec![Some(2), None], 2, 1, Some(true))),
            ("a newer release after a day is announced", true, "1.2.0", vec![Tick, Wait(24), Publish("1.3.0"), Tick], (vec![Some(2), Some(3)], 2, 0, None)),
            ("bad signature: nothing, install refused", false, "1.2.0", vec![Tick, Install], (vec![None], 1, 0, Some(false))),
            ("up to date", true, "1.0.0", vec![Tick, Install], (vec![None], 1, 0, Some(false))),
            ("offline", true, "", vec![Tick], (vec![None], 1, 0, None)),
        ];
        for (name, signed, first, acts, want) in rows {
            assert_eq!(run(signed, first, &acts), want, "{name}");
        }
    }

    #[test]
    fn only_a_manifest_signed_by_the_apps_key_is_trusted() {
        use base64::Engine;
        const KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        const OTHER_KEY: &str = "RWQg6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        const SIG: &str = "untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1633700835	file:test	prehashed
wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==
";
        let packed = base64::engine::general_purpose::STANDARD.encode(SIG);
        let packed_key = base64::engine::general_purpose::STANDARD.encode(format!("untrusted comment: minisign public key
{KEY}
"));
        for (name, manifest, sig, key, want) in [
            ("valid", &b"test"[..], SIG, KEY, true),
            ("valid, packager encoding", b"test", packed.as_str(), packed_key.as_str(), true),
            ("tampered manifest", b"tesT", SIG, KEY, false),
            ("wrong key", b"test", SIG, OTHER_KEY, false),
            ("missing signature", b"test", "", KEY, false),
            ("garbage signature", b"test", "not a signature", KEY, false),
            ("no key built in", b"test", SIG, "", false),
        ] {
            assert_eq!(manifest_signature_valid(manifest, sig, key), want, "{name}");
        }
    }

    #[test]
    fn a_manual_check_ignores_the_clock_and_offer_shows_the_waiting_release() {
        let feed = Arc::new(FakeFeed { version: Mutex::new("1.1.0".into()), signed: true, fetches: Mutex::new(0), installs: Mutex::new(0) });
        let mut u = Updater::new(feed.clone(), Arc::new(FakeClock::default()), "1.0.0");
        assert_eq!((u.tick().map(|v| v.minor), u.tick(), u.check(), u.offer().map(|v| v.minor)), (Some(1), None, None, Some(1)));
        assert_eq!((*feed.fetches.lock().unwrap(), u.current().map(|v| v.major)), (2, Some(1)));
    }
}
