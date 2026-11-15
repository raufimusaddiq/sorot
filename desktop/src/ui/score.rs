//! A clip's score and verdict. The verdict always shows its word: colour never carries it alone.

use rune::tok::type_;
use rune::{El, row, text};

use crate::ui::kit::pal;

/// The engine's gate verdict as the word a person reads (`FAIL` is shown as "Skip": the clip is ranked last).
pub fn verdict_word(verdict: Option<&str>) -> &'static str {
    match verdict {
        Some("PASS") => "Pass",
        Some("REVIEW") => "Review",
        Some("FAIL") => "Skip",
        _ => "Unchecked",
    }
}

/// 0-100 from the engine's 0-1 score; nothing when the clip is not scored.
pub fn score_text(score: Option<f64>) -> String {
    score.map_or_else(|| "-".into(), |s| format!("{}", (s.clamp(0.0, 1.0) * 100.0).round()))
}

/// `{key}/score` and `{key}/verdict` side by side.
pub fn mark(dark: bool, key: &str, score: Option<f64>, verdict: Option<&str>) -> El {
    let p = pal(dark);
    let word = verdict_word(verdict);
    let ink = match verdict {
        Some("PASS") => p.pass,
        Some("FAIL") => p.skip,
        _ => p.muted,
    };
    row().gap(8.0).items_center()
        .child(text(score_text(score)).key(format!("{key}/score")).font(type_::TITLE).color(p.text))
        .child(text(word).key(format!("{key}/verdict")).font(type_::LABEL).color(ink))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_scores() {
        for (v, word) in [(Some("PASS"), "Pass"), (Some("REVIEW"), "Review"), (Some("FAIL"), "Skip"), (None, "Unchecked")] {
            assert_eq!(verdict_word(v), word);
        }
        for (s, want) in [(Some(0.8), "80"), (Some(1.7), "100"), (Some(-1.0), "0"), (None, "-")] {
            assert_eq!(score_text(s), want);
        }
    }
}
