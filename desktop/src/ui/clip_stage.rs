//! The 9:16 stage a clip plays on, with its play button and clock.

use rune::tok::type_;
use rune::{El, col, row, text};
use sorot_desktop_core::model::Clip;

use crate::app::State;
use crate::preview::PreviewState;
use crate::ui::kit::{button, pal};

/// `m:ss`.
pub fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0).round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// What a clip is called: its title, else its words, else a placeholder.
pub fn title(clip: &Clip) -> String {
    clip.title.as_deref().or(clip.text_content.as_deref()).unwrap_or("Untitled clip").to_string()
}

pub fn view(s: &State, clip: &Clip) -> El {
    let p = pal(s.dark);
    let state = s.preview.state();
    let note = match (&state, &s.clips.preview_error) {
        (_, Some(why)) => Some(why.clone()),
        (PreviewState::Error(why), _) => Some(format!("The preview cannot play: {why}")),
        (PreviewState::Idle | PreviewState::Loading, _) => Some("Loading the preview".to_string()),
        _ => None,
    };
    let mut face = col().key("clips/stage").role("img").label(title(clip))
        .aspect_ratio(9.0 / 16.0).h(340.0).center().fill(p.bg).border(1.0, p.divider).radius(8.0);
    if let Some(note) = note {
        face = face.child(text(note).key("clips/stage/note").role("status").font(type_::BODY).color(p.muted).wrap().max_w(220.0));
    }
    let face = s.preview.paint(face);
    let playing = state == PreviewState::Playing;
    let total = s.preview.duration().unwrap_or(clip.duration_sec);
    let controls = row().gap(10.0).items_center()
        .child(button(s.dark, "clips/play", if playing { "Pause" } else { "Play" }, true, |s: &mut State| s.toggle_play()))
        .child(text(format!("{} / {}", clock(s.preview.time()), clock(total))).key("clips/time").font(type_::LABEL).color(p.muted));
    col().gap(10.0).items_center().child(face).child(controls)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_clock_reads_minutes_and_seconds() {
        for (t, want) in [(0.0, "0:00"), (59.6, "1:00"), (125.0, "2:05"), (-3.0, "0:00")] {
            assert_eq!(super::clock(t), want);
        }
    }
}
