//! Clip list order and the edit-options layering (config ← job ← clip).

use crate::model::Clip;
use serde_json::{Map, Value};

fn key(ranks: &[Option<u32>], i: usize) -> (u8, u32) {
    ranks[i].map_or((1, 0), |r| (0, r))
}

/// Fills `idx` (as long as `ranks`) with the indices that put `ranks` in order: ascending
/// `rankPos`, clips without one last, ties in list order. Insertion sort over a plain slice: the
/// Kani proof reads exactly this code.
pub fn order_into(ranks: &[Option<u32>], idx: &mut [usize]) {
    for (i, slot) in idx.iter_mut().enumerate() {
        *slot = i;
    }
    for i in 1..idx.len() {
        let mut j = i;
        while j > 0 && key(ranks, idx[j - 1]) > key(ranks, idx[j]) {
            idx.swap(j - 1, j);
            j -= 1;
        }
    }
}

pub fn order_indices(ranks: &[Option<u32>]) -> Vec<usize> {
    let mut idx = vec![0; ranks.len()];
    order_into(ranks, &mut idx);
    idx
}

/// The list ordered by `rankPos`, never by `rank`.
pub fn ordered(clips: &[Clip]) -> Vec<Clip> {
    let ranks: Vec<Option<u32>> = clips.iter().map(|c| c.rank_pos).collect();
    order_indices(&ranks).into_iter().map(|i| clips[i].clone()).collect()
}

/// Editing options: a JSON object, layer by layer (`backend/src/options.ts`).
pub type Options = Map<String, Value>;

/// What the clip already resolves to: later layers win.
pub fn resolve(config: &Options, job: &Options, clip: &Options) -> Options {
    let mut out = config.clone();
    for layer in [job, clip] {
        out.extend(layer.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    out
}

/// The clip-layer delta: the keys of `wanted` whose value differs from what the three layers
/// already give this clip. Nothing else is sent.
pub fn edit_layer(config: &Options, job: &Options, clip: &Options, wanted: &Options) -> Options {
    let now = resolve(config, job, clip);
    wanted.iter().filter(|(k, v)| now.get(*k) != Some(*v)).map(|(k, v)| (k.clone(), v.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opts(v: Value) -> Options {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn clips_come_in_rank_pos_order() {
        let clip = |id: &str, rank_pos| Clip {
            id: id.into(), video_id: "v".into(), rank_pos, score: None, tier: "PRIMARY".into(), start_time: 0.0, end_time: 1.0,
            duration_sec: 1.0, text_content: None, title: None, description: None, render_status: String::new(),
            render_path: None, export_status: String::new(), export_path: None, created_at: String::new(), options: None,
            updated_at: None, hook_start: None, hook_end: None, gate_verdict: None, reason: None,
        };
        let got: String = ordered(&[clip("a", Some(3)), clip("b", None), clip("c", Some(1)), clip("d", Some(3))]).iter().map(|c| c.id.as_str()).collect();
        assert_eq!(got, "cadb");
    }

    #[test]
    fn only_the_clip_layer_change_is_sent() {
        let config = opts(json!({"style": "karaoke", "silenceTrim": false}));
        let job = opts(json!({"silenceTrim": true}));
        let clip = opts(json!({"style": "plain"}));
        for (wanted, want) in [
            (json!({"style": "plain", "silenceTrim": true}), json!({})),
            (json!({"style": "karaoke"}), json!({"style": "karaoke"})),
            (json!({"silenceTrim": false, "bgm": "a.mp3"}), json!({"silenceTrim": false, "bgm": "a.mp3"})),
            (json!({}), json!({})),
        ] {
            assert_eq!(edit_layer(&config, &job, &clip, &opts(wanted.clone())), opts(want), "{wanted}");
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(7)]
    fn sorting_is_a_permutation_ordered_by_rank_pos() {
        let all: [Option<u32>; 5] = std::array::from_fn(|_| kani::any());
        let n: usize = kani::any();
        kani::assume(n <= 5);
        let ranks = &all[..n];
        let mut buf = [0usize; 5];
        let idx = &mut buf[..n];
        order_into(ranks, idx);
        let mut seen = [false; 5];
        for &i in idx.iter() {
            assert!(i < n && !seen[i]);
            seen[i] = true;
        }
        for w in 1..n {
            assert!(key(ranks, idx[w - 1]) <= key(ranks, idx[w]));
        }
    }
}
