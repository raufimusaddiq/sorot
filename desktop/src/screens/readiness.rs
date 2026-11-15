//! The first-run checklist: what this machine still needs, in plain words, with a fix per item.

use rune::tok::type_;
use rune::{El, col, row, text};
use sorot_desktop_core::model::ReadinessItem;
use sorot_desktop_core::readiness::ItemState;

use crate::app::{Cmd, State};
use crate::ui::kit::{button, pal};

pub fn name(id: &str) -> &str {
    match id {
        "ffmpeg" => "ffmpeg",
        "python" => "Python environment",
        "whisperModel" => "Speech model (Whisper)",
        "gpu" => "Graphics card",
        "generateBrowser" => "Browser for Generate",
        other => other,
    }
}

/// What a failed fix means for the person, and whether another try can help.
pub fn failure(reason: &str) -> String {
    match reason {
        "offline" => "Needs internet once. Connect, then try again.".into(),
        "checksum mismatch" => "The download was damaged (checksum mismatch). Try again.".into(),
        other => format!("The fix failed: {other}. Try again."),
    }
}

/// The ids "Fix all" starts: not ready, fixable, and not already running.
pub fn fixable(s: &State) -> Vec<String> {
    s.readiness.iter().filter(|i| !i.ok && i.fixable && i.progress.is_none()).map(|i| i.id.clone()).collect()
}

fn state_of(s: &State, item: &ReadinessItem) -> ItemState {
    s.item_states.iter().find(|(id, _)| *id == item.id).map(|(_, i)| i.state.clone()).unwrap_or(ItemState::Unknown)
}

fn tail(s: &State, item: &ReadinessItem) -> El {
    let p = pal(s.dark());
    let id = item.id.clone();
    let status = |key: &str, words: String, color| text(words).key(format!("readiness/{id}/{key}")).font(type_::LABEL).color(color).wrap();
    let act = |key: &str, label: &str, primary: bool| {
        let id = id.clone();
        button(s.dark(), format!("readiness/{id}/{key}"), label, primary, move |s: &mut State| s.send(Cmd::FixReadiness(id.clone())))
    };
    match state_of(s, item) {
        ItemState::Ok => status("status", "Ready".into(), p.pass),
        ItemState::Fixing { percent } => {
            let label = item.progress.as_ref().map_or("Working", |p| p.label.as_str());
            status("progress", format!("{label} {percent}%"), p.text)
        }
        ItemState::FixFailed { reason } => col().gap(6.0).items_end().child(status("status", failure(&reason), p.skip)).child(act("retry", "Retry", true)),
        ItemState::Missing { fixable: true } => row().gap(10.0).items_center().child(status("status", "Not ready".into(), p.skip)).child(act("fix", "Fix", true)),
        _ => status("status", "Needs attention".into(), p.skip),
    }
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark());
    let pending = s.readiness.iter().filter(|i| i.required && !i.ok).count();
    let mut card = col().key("readiness/items").w_full().fill(p.surface).border(1.0, p.divider).radius(10.0);
    for item in &s.readiness {
        let id = &item.id;
        card = card.child(
            row().key(format!("readiness/{id}")).gap(16.0).padding(16.0).items_center()
                .child(
                    col().gap(2.0).grow(1.0)
                        .child(text(name(id)).key(format!("readiness/{id}/name")).font(type_::TITLE).color(p.text))
                        .child(text(&item.detail).key(format!("readiness/{id}/detail")).font(type_::BODY).color(p.muted).wrap()),
                )
                .child(tail(s, item)),
        );
    }
    let mut head = row().gap(16.0).items_center().w_full().child(
        col().gap(4.0).grow(1.0)
            .child(text("Sorot needs a few things first").key("readiness/title").role("heading").level(1).font(type_::TITLE).color(p.text))
            .child(text(format!("Sorot checks this machine before it clips. {pending} required item(s) are not ready.")).key("readiness/summary").font(type_::BODY).color(p.muted).wrap()),
    );
    if !fixable(s).is_empty() {
        head = head.child(button(s.dark(), "readiness/fix-all", "Fix all", true, |s: &mut State| {
            let ids = fixable(s);
            s.send(Cmd::FixAll(ids));
        }));
    }
    col().gap(20.0).padding(40.0).w_full().max_w(960.0).child(head).child(card)
        .child(text("Each fix runs through the engine. Nothing changes outside the Sorot data folder.").key("readiness/footnote").font(type_::BODY).color(p.muted).wrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_named_in_plain_words() {
        for (id, want) in [("ffmpeg", "ffmpeg"), ("python", "Python environment"), ("whisperModel", "Speech model (Whisper)"), ("gpu", "Graphics card"), ("generateBrowser", "Browser for Generate"), ("other", "other")] {
            assert_eq!(name(id), want);
        }
    }
}
