//! Command palette ranking: prefix, then word start, then substring; case and diacritics ignored
//! (Indonesian text is often typed without accents). Ties keep the caller's order.

pub type ActionId = u32;

pub struct Entry<'a> {
    pub id: ActionId,
    pub label: &'a str,
}

fn fold_char(c: char) -> char {
    match c {
        'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è'..='ë' | 'ē' | 'ę' | 'ě' => 'e',
        'ì'..='ï' | 'ī' | 'į' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò'..='ö' | 'ø' | 'ō' => 'o',
        'ù'..='ü' | 'ū' | 'ů' => 'u',
        'ý' | 'ÿ' => 'y',
        'š' | 'ś' => 's',
        'ž' | 'ź' | 'ż' => 'z',
        _ => c,
    }
}

fn fold(s: &str) -> String {
    s.chars().flat_map(char::to_lowercase).map(fold_char).collect()
}

/// 0 prefix, 1 word start, 2 substring. `label` and `query` are already folded.
fn tier(label: &str, query: &str) -> Option<u8> {
    if label.starts_with(query) {
        return Some(0);
    }
    let mut prev_word = false;
    for (i, c) in label.char_indices() {
        if !prev_word && c.is_alphanumeric() && label[i..].starts_with(query) {
            return Some(1);
        }
        prev_word = c.is_alphanumeric();
    }
    label.contains(query).then_some(2)
}

/// Writes the indices `0..n` that have a tier into `out`, best tier first and in the caller's
/// order inside a tier; returns how many. `out` holds at least `n`.
pub fn order_into(out: &mut [usize], n: usize, tier_of: impl Fn(usize) -> Option<u8>) -> usize {
    let mut len = 0;
    for t in 0..3 {
        for i in 0..n {
            if tier_of(i) == Some(t) {
                out[len] = i;
                len += 1;
            }
        }
    }
    len
}

/// An empty query lists everything in the caller's order.
pub fn rank(query: &str, actions: &[Entry]) -> Vec<ActionId> {
    let q = fold(query);
    let q = q.trim();
    let labels: Vec<String> = actions.iter().map(|a| fold(a.label)).collect();
    let mut at = vec![0; actions.len()];
    let len = order_into(&mut at, actions.len(), |i| if q.is_empty() { Some(0) } else { tier(&labels[i], q) });
    at[..len].iter().map(|&i| actions[i].id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rank_table() {
        let labels = ["Impor berkas", "Tempel tautan dan impor", "Buka Pengaturan", "Ekspor klip", "Pratinjau", "Siapkan impor"];
        let actions: Vec<Entry> = labels.iter().enumerate().map(|(i, l)| Entry { id: i as u32 * 10, label: l }).collect();
        for (query, want) in [
            ("", vec![0, 10, 20, 30, 40, 50]),
            ("impor", vec![0, 10, 50]),
            ("  IMPOR ", vec![0, 10, 50]),
            ("pengat", vec![20]),
            ("eks", vec![30]),
            ("prat", vec![40]),
            ("pratinjàu", vec![40]),
            ("ekspór", vec![30]),
            ("an", vec![10, 20, 50]),
            ("xyz", vec![]),
        ] {
            let got = rank(query, &actions);
            assert_eq!(got, want, "{query:?}");
        }
        let mixed = [Entry { id: 1, label: "Sistem" }, Entry { id: 2, label: "Buka tempel" }, Entry { id: 3, label: "Tempel" }];
        assert_eq!(rank("tem", &mixed), vec![3, 2, 1], "prefix, then word start, then substring");
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(8)]
    fn ranking_is_a_duplicate_free_subset_of_at_most_five() {
        let n: usize = kani::any();
        kani::assume(n <= 5);
        let tiers: [Option<u8>; 5] = [kani::any(), kani::any(), kani::any(), kani::any(), kani::any()];
        for t in tiers {
            kani::assume(t.map_or(true, |t| t < 3));
        }
        let mut out = [0usize; 5];
        let len = order_into(&mut out, n, |i| tiers[i]);
        assert!(len <= n);
        for a in 0..len {
            assert!(out[a] < n);
            for b in a + 1..len {
                assert!(out[a] != out[b]);
            }
        }
    }
}
