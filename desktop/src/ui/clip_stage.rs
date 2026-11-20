//! The 9:16 stage a clip plays on, with its play button and clock.

use rune::tok::type_;
use rune::{El, col, row, text};
use sorot_desktop_core::model::Clip;

use crate::app::State;
use crate::preview::PreviewState;
use crate::ui::fx_moments::{Moment, slot};
use crate::i18n::{Lang, tr, trf};
use crate::ui::controls::transport_icon;
use crate::ui::kit::pal;

/// `m:ss`.
pub fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0).round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// What a clip is called: its title, else its words, else a placeholder.
pub fn title(lang: Lang, clip: &Clip) -> String {
    clip.title.clone().or_else(|| clip.text_content.clone()).unwrap_or_else(|| tr(lang, "clip.untitled"))
}

/// The 9:16 stage of a clip: the label, the sample caption while nothing plays, and (on the clips screen) the transport bar.
/// `size` is the stage's fixed width and height; `None` fills the width it is given at 9:16.
pub fn view(s: &State, clip: &Clip, size: Option<(f32, f32)>, transport: bool) -> El {
    stage_of(s, &title(s.lang, clip), clip.duration_sec, size, transport, !s.toasts.is_empty())
}

/// The stage and transport for whatever the player holds, filling its width: `label` names it, `length` is its
/// length until the player knows its own.
pub fn stage(s: &State, label: &str, length: f64) -> El {
    stage_of(s, label, length, None, true, false)
}

fn stage_of(s: &State, label: &str, length: f64, size: Option<(f32, f32)>, transport: bool, compact: bool) -> El {
    let p = pal(s.dark());
    let state = s.preview.state();
    let note = match (&state, &s.clips.preview_error) {
        (_, Some(why)) => Some(why.clone()),
        _ if s.cpu_renderer => Some(tr(s.lang, "clips.note.cpu")),
        (PreviewState::Error(why), _) => Some(trf(s.lang, "clips.note.error", &[("why", why)])),
        (PreviewState::Idle | PreviewState::Loading, _) => Some(tr(s.lang, "clips.note.loading")),
        _ => None,
    };
    let playing = state == PreviewState::Playing;
    let mut middle = col().grow(1.0).w_full().gap(10.0).center();
    if let Some(note) = note {
        middle = middle.child(text(note).key("clips/stage/note").role("status").font(type_::BODY).color(p.muted).wrap());
    }
    if !playing {
        middle = middle.child(text(tr(s.lang, "clips.sample")).key("clips/stage/sample").font(type_::TITLE).color(p.text).wrap());
    }
    let mut face = col().key("clips/stage").role("img").label(label).fill(p.bg).border(1.0, p.divider).radius(12.0)
        .child(col().padding(16.0).w_full().child(text(tr(s.lang, "clips.stage.label")).font(type_::LABEL).color(p.muted)))
        .child(middle);
    face = match size {
        Some((w, h)) => face.w(w).h(h),
        None => {
            let face = face.w_full().aspect_ratio(9.0 / 16.0);
            // ponytail: while the 60 pt toast lane is up, the stage is 360 instead of 9:16;
            // upgrade if the preview must keep its aspect during the six-second toast.
            if compact { face.h(360.0) } else { face }
        },
    };
    if transport {
        let total = s.preview.duration().unwrap_or(length).max(0.001);
        let at = s.preview.time();
        let word = tr(s.lang, if playing { "clips.pause" } else { "clips.play" });
        let filled = ((at / total).clamp(0.0, 1.0) as f32) * 110.0;
        // The transport bar: matte graphite on a CPU renderer, reeded glass where the GPU can draw it.
        let controls = row().key("clips/transport").gap(10.0).px(10.0).h(44.0).items_center().w_full().fill(p.surface)
            .child(slot(Moment::TransportGlass, [0.0; 4]).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)))
            .child(col().key("clips/play").role("button").label(word).focusable(true).padding(6.0).radius(6.0).hover(p.text.alpha(0.08)).press_scale(0.985)
                .on_press(|s: &mut State| s.toggle_play()).child(transport_icon(s.dark(), playing)))
            .child(text(format!("{} / {}", clock(at), clock(total))).key("clips/time").font(type_::LABEL).color(p.text))
            .child(col().w(110.0).h(3.0).radius(2.0).fill(p.divider).child(col().w(filled).h(3.0).radius(2.0).fill(p.beam)));
        face = face.child(controls);
    }
    s.preview.paint(face)
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
