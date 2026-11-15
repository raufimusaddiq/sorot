//! Diagnostic text with secrets removed.

pub const MASK: &str = "•••";

/// Replaces every occurrence of each secret and every `Bearer <token>` with `•••`.
/// Empty secrets are ignored. Secrets are tokens and keys, never text containing the mask.
pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = replace_all(text, "Bearer ", true);
    for s in secrets {
        if !s.is_empty() {
            out = replace_all(&out, s, false);
        }
    }
    out
}

/// Left to right, no overlaps. With `to_space`, the run of non-whitespace after `needle` goes
/// and `needle` stays.
fn replace_all(text: &str, needle: &str, to_space: bool) -> String {
    let (t, n) = (text.as_bytes(), needle.as_bytes());
    let mut out: Vec<u8> = Vec::with_capacity(t.len());
    let mut i = 0;
    while i < t.len() {
        if t[i..].starts_with(n) {
            if to_space {
                out.extend_from_slice(n);
                i += n.len();
                let run = t[i..].iter().take_while(|b| !b.is_ascii_whitespace()).count();
                if run > 0 {
                    out.extend_from_slice(MASK.as_bytes());
                }
                i += run;
            } else {
                out.extend_from_slice(MASK.as_bytes());
                i += n.len();
            }
        } else {
            out.push(t[i]);
            i += 1;
        }
    }
    // Only whole UTF-8 sequences were copied or replaced.
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_and_bearer_tokens_are_masked() {
        let cases: [(&str, Vec<&str>, &str); 5] = [
            ("GET http://127.0.0.1:1/?t=abc123 failed", vec!["abc123"], "GET http://127.0.0.1:1/?t=••• failed"),
            ("Authorization: Bearer abc123 sent", vec!["abc123"], "Authorization: Bearer ••• sent"),
            ("Bearer unknown-token", vec![], "Bearer •••"),
            ("k1 k2 k1 k1", vec!["k1", "k2"], "••• ••• ••• •••"),
            ("nothing here", vec![""], "nothing here"),
        ];
        for (text, secrets, want) in cases {
            assert_eq!(redact(text, &secrets), want, "{text}");
        }
    }

    /// All strings over {a, b} of length `min..=max`.
    fn strings(min: usize, max: usize) -> Vec<String> {
        (min..=max).flat_map(|n| (0..1u32 << n).map(move |bits| (0..n).map(|i| if bits >> i & 1 == 0 { 'a' } else { 'b' }).collect())).collect()
    }

    // Exhaustive over the same bound a Kani proof would use; Kani on heap strings exceeded
    // the 10 min / memory limit.
    #[test]
    fn no_text_up_to_6_bytes_keeps_a_secret_up_to_3_bytes() {
        for text in strings(0, 6) {
            for secret in strings(1, 3) {
                let out = redact(&text, &[&secret]);
                assert!(!out.contains(&secret), "{text:?} with {secret:?} gave {out:?}");
            }
        }
    }
}
