//! The engine's one stdout line once it listens: `SOROT_READY {"port":54321,"version":"1.9.0","api":1}`.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ready {
    pub port: u16,
    pub version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HandshakeError {
    #[error("not a SOROT_READY line")]
    NotReady,
    #[error("the SOROT_READY line is malformed")]
    Malformed,
    #[error("This engine is newer than the app. Update Sorot.")]
    TooNew,
}

const PREFIX: &str = "SOROT_READY ";

/// `supported_api` is the contract's major version this app speaks; a larger `api` is `TooNew`.
pub fn parse_ready(line: &str, supported_api: u32) -> Result<Ready, HandshakeError> {
    let json = line.trim().strip_prefix(PREFIX).ok_or(HandshakeError::NotReady)?;
    let port = parse_port(digits(json, "port").ok_or(HandshakeError::Malformed)?).ok_or(HandshakeError::Malformed)?;
    let api = digits(json, "api").and_then(fold).ok_or(HandshakeError::Malformed)?;
    let version = string(json, "version").ok_or(HandshakeError::Malformed)?;
    if api > supported_api {
        return Err(HandshakeError::TooNew);
    }
    Ok(Ready { port, version: version.to_string() })
}

/// 1 to 5 ASCII digits worth 1..=65535, by an explicit fold with checked arithmetic.
pub fn parse_port(digits: &[u8]) -> Option<u16> {
    if digits.is_empty() || digits.len() > 5 {
        return None;
    }
    let mut n: u32 = 0;
    for d in digits {
        if !d.is_ascii_digit() {
            return None;
        }
        n = n.checked_mul(10)?.checked_add(u32::from(d - b'0'))?;
    }
    u16::try_from(n).ok().filter(|p| *p >= 1)
}

/// Up to 9 ASCII digits as a number.
fn fold(digits: &[u8]) -> Option<u32> {
    if digits.is_empty() || digits.len() > 9 {
        return None;
    }
    digits.iter().try_fold(0u32, |n, d| d.is_ascii_digit().then(|| n * 10 + u32::from(d - b'0')))
}

/// The text right after `"key":`, spaces skipped. Plain byte search: no allocation, no regex.
fn after_key<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let (j, k) = (json.as_bytes(), key.as_bytes());
    let mut i = 0;
    while i + k.len() + 2 <= j.len() {
        if j[i] == b'"' && &j[i + 1..i + 1 + k.len()] == k && j[i + 1 + k.len()] == b'"' {
            let rest = json[i + k.len() + 2..].trim_start();
            return Some(rest.strip_prefix(':')?.trim_start());
        }
        i += 1;
    }
    None
}

/// The run of digits after `"key":`.
fn digits<'a>(json: &'a str, key: &str) -> Option<&'a [u8]> {
    let rest = after_key(json, key)?.as_bytes();
    Some(&rest[..rest.iter().take_while(|b| b.is_ascii_digit()).count()])
}

fn string<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let rest = after_key(json, key)?.strip_prefix('"')?;
    Some(&rest[..rest.find('"')?])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_parse_or_fail_by_cause() {
        let ok = |p: u16, v: &str| Ok(Ready { port: p, version: v.into() });
        let bad = || Err(HandshakeError::Malformed);
        let cases = [
            (r#"SOROT_READY {"port":54321,"version":"1.9.0","api":1}"#, ok(54321, "1.9.0")),
            (r#"SOROT_READY { "api": 1, "port": 80, "version": "x" }"#, ok(80, "x")),
            ("server listening on 8080", Err(HandshakeError::NotReady)),
            (r#"SOROT_READY {"port":0,"version":"1","api":1}"#, bad()),
            (r#"SOROT_READY {"port":70000,"version":"1","api":1}"#, bad()),
            (r#"SOROT_READY {"port":5,"version":"1","api":2}"#, Err(HandshakeError::TooNew)),
            (r#"SOROT_READY {"port":65535,"version":"1","api":1}"#, ok(65535, "1")),
            (r#"SOROT_READY {"port":65536,"version":"1","api":1}"#, bad()),
            (r#"SOROT_READY {"port":,"version":"1","api":1}"#, bad()),
            (r#"SOROT_READY {"port":5,"version":"1","api":1234567890}"#, bad()),
            (r#"SOROT_READY {"port":5,"version":"1""#, bad()),
            ("SOROT_READY é\"port\"", bad()),
        ];
        for (line, want) in cases {
            assert_eq!(parse_ready(line, 1), want, "{line}");
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// The port parser on any bytes up to the bound: never panics, and `Ok` is 1..=65535 made
    /// only of digits. Bound: 6 bytes (one past the 5 it accepts, so the length check is
    /// covered), `unwind(7)`. The whole-line parser is covered by the table above: proving it
    /// end to end ran past 20 minutes, the cost being string search, not the port.
    #[kani::proof]
    #[kani::unwind(7)]
    fn the_port_parser_never_panics_and_ok_is_in_range() {
        let bytes: [u8; 6] = kani::any();
        let len: usize = kani::any();
        kani::assume(len <= 6);
        if let Some(p) = parse_port(&bytes[..len]) {
            assert!(p >= 1);
            assert!(len <= 5 && bytes[..len].iter().all(u8::is_ascii_digit));
        }
    }
}
