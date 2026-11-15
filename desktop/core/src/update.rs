//! Whether to offer an update. The app crate verifies the minisign signature and passes the
//! result; core stays crypto-free. Anything doubtful is `Ignore`: it never blocks, never installs.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Offer(Version),
    UpToDate,
    Ignore,
}

/// `1.2.3` or `v1.2.3`; anything else (a pre-release tag, two parts) is not a version.
pub fn parse_version(s: &str) -> Option<Version> {
    let mut parts = s.trim().trim_start_matches('v').split('.').map(|p| {
        if p.bytes().all(|b| b.is_ascii_digit()) { p.parse::<u32>().ok() } else { None }
    });
    let v = Version { major: parts.next()??, minor: parts.next()??, patch: parts.next()?? };
    parts.next().is_none().then_some(v)
}

/// The `version` of a `latest.json` feed.
fn feed_version(feed: &str) -> Option<Version> {
    let v: serde_json::Value = serde_json::from_str(feed).ok()?;
    parse_version(v.get("version")?.as_str()?)
}

pub fn verdict(current: Option<Version>, latest: Option<Version>, signature_valid: bool) -> Decision {
    match (current, latest, signature_valid) {
        (Some(c), Some(l), true) if l > c => Decision::Offer(l),
        (Some(_), Some(_), true) => Decision::UpToDate,
        _ => Decision::Ignore,
    }
}

pub fn decide(current: &str, feed: &str, signature_valid: bool) -> Decision {
    verdict(parse_version(current), feed_version(feed), signature_valid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_table() {
        let v = |major, minor, patch| Version { major, minor, patch };
        let feed = |ver: &str| format!(r#"{{"version":"{ver}","notes":"x"}}"#);
        for (current, feed, sig, want) in [
            ("1.2.3", feed("1.3.0"), true, Decision::Offer(v(1, 3, 0))),
            ("1.2.3", feed("v1.2.4"), true, Decision::Offer(v(1, 2, 4))),
            ("1.9.0", feed("1.10.0"), true, Decision::Offer(v(1, 10, 0))),
            ("1.2.3", feed("1.2.3"), true, Decision::UpToDate),
            ("1.2.3", feed("1.0.9"), true, Decision::UpToDate),
            ("1.2.3", feed("2.0.0"), false, Decision::Ignore),
            ("1.2.3", "{".into(), true, Decision::Ignore),
            ("1.2.3", r#"{"version":7}"#.into(), true, Decision::Ignore),
            ("1.2.3", feed("2.0"), true, Decision::Ignore),
            ("1.2.3", feed("2.0.0-beta"), true, Decision::Ignore),
            ("1.2.3", feed("2.0.0.1"), true, Decision::Ignore),
            ("1.2.3", feed("99999999999.0.0"), true, Decision::Ignore),
            ("dev", feed("2.0.0"), true, Decision::Ignore),
        ] {
            assert_eq!(decide(current, &feed, sig), want, "{current} {feed} {sig}");
        }
        assert_eq!(v(1, 3, 0).to_string(), "1.3.0");
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    fn any_version() -> Option<Version> {
        kani::any::<bool>().then(|| Version { major: kani::any(), minor: kani::any(), patch: kani::any() })
    }

    #[kani::proof]
    fn an_invalid_signature_never_offers() {
        assert_eq!(verdict(any_version(), any_version(), false), Decision::Ignore);
    }

    #[kani::proof]
    fn an_offer_is_always_newer() {
        let (c, l) = (any_version(), any_version());
        if let Decision::Offer(v) = verdict(c, l, kani::any()) {
            assert!(Some(v) == l && l > c);
        }
    }
}
