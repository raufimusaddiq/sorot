//! A clip's score and verdict. The verdict always shows its word: colour never carries it alone.

use rune::Color;

use crate::i18n::{Lang, tr};
use crate::ui::kit::Pal;

/// The catalog key of the word a verdict reads as (`FAIL` is shown as SKIP: the clip is ranked last).
pub fn verdict_key(verdict: Option<&str>) -> &'static str {
    match verdict {
        Some("PASS") => "clips.verdict.PASS",
        Some("REVIEW") => "clips.verdict.REVIEW",
        Some("FAIL") => "clips.verdict.FAIL",
        _ => "clips.verdict.none",
    }
}

pub fn verdict_word(lang: Lang, verdict: Option<&str>) -> String {
    tr(lang, verdict_key(verdict))
}

/// The outline colour of a verdict pill.
pub fn verdict_ink(p: &Pal, verdict: Option<&str>) -> Color {
    match verdict {
        Some("PASS") => p.pass,
        Some("REVIEW") => p.steel,
        Some("FAIL") => p.skip,
        _ => p.muted,
    }
}

/// The engine's 0 to 1 score with two decimals, comma in Indonesian; a dash when the clip is not scored.
pub fn score_text(lang: Lang, score: Option<f64>) -> String {
    let Some(s) = score else { return "-".into() };
    let t = format!("{:.2}", s.clamp(0.0, 1.0));
    if lang == Lang::Id { t.replace('.', ",") } else { t }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_scores() {
        for (v, id, en) in [(Some("PASS"), "PASS", "PASS"), (Some("REVIEW"), "REVIEW", "REVIEW"), (Some("FAIL"), "SKIP", "SKIP"), (None, "BELUM", "UNCHECKED")] {
            assert_eq!((verdict_word(Lang::Id, v), verdict_word(Lang::En, v)), (id.to_string(), en.to_string()));
        }
        for (s, id, en) in [(Some(0.84), "0,84", "0.84"), (Some(1.7), "1,00", "1.00"), (Some(-1.0), "0,00", "0.00"), (None, "-", "-")] {
            assert_eq!((score_text(Lang::Id, s), score_text(Lang::En, s)), (id.to_string(), en.to_string()));
        }
    }
}
