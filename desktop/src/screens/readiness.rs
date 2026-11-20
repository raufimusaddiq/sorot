//! The first-run checklist: what this machine still needs, in plain words, with a fix per item.

use rune::tok::type_;
use rune::{El, col, row, text};
use sorot_desktop_core::model::ReadinessItem;
use sorot_desktop_core::readiness::ItemState;

use crate::app::{Cmd, State};
use crate::i18n::{Lang, tr, trf};
use crate::ui::focus;
use crate::ui::kit::{button, pal};

pub fn name(id: &str, lang: Lang) -> String {
    let key = match id {
        "python" => "readiness.name.python",
        "whisperModel" => "readiness.name.whisperModel",
        "gpu" => "readiness.name.gpu",
        "generateBrowser" => "readiness.name.generateBrowser",
        _ => return id.to_string(),
    };
    tr(lang, key)
}

/// What a failed fix means for the person, and whether another try can help.
pub fn failure(reason: &str, lang: Lang) -> String {
    match reason {
        "offline" => tr(lang, "readiness.failure.offline"),
        "checksum mismatch" => tr(lang, "readiness.failure.checksum"),
        other => trf(lang, "readiness.failure.other", &[("other", other)]),
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
    let l = s.lang;
    let id = item.id.clone();
    let status = |key: &str, words: String, color| text(words).key(focus::readiness(&id, key)).font(type_::LABEL).color(color).wrap();
    let act = |key: &str, label: &str, primary: bool| {
        let id = id.clone();
        button(s.dark(), focus::readiness(&id, key), label, primary, move |s: &mut State| s.send(Cmd::FixReadiness(id.clone())))
    };
    match state_of(s, item) {
        ItemState::Ok => status("status", tr(l, "readiness.ready"), p.pass),
        ItemState::Fixing { percent } => {
            let label = item.progress.as_ref().map_or_else(|| tr(l, "readiness.working"), |p| p.label.clone());
            status("progress", format!("{label} {percent}%"), p.text)
        }
        ItemState::FixFailed { reason } => col().gap(6.0).items_end().child(status("status", failure(&reason, l), p.skip)).child(act("retry", &tr(l, "readiness.retry"), true)),
        ItemState::Missing { fixable: true } => row().gap(10.0).items_center().child(status("status", tr(l, "readiness.not-ready"), p.skip)).child(act("fix", &tr(l, "readiness.fix"), true)),
        _ => status("status", tr(l, "readiness.needs-attention"), p.skip),
    }
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark());
    let l = s.lang;
    let pending = s.readiness.iter().filter(|i| i.required && !i.ok).count();
    let mut card = col().key("readiness/items").w_full().fill(p.surface).border(1.0, p.divider).radius(10.0);
    for item in &s.readiness {
        let id = &item.id;
        card = card.child(
            row().key(focus::readiness(id, "")).gap(16.0).padding(16.0).items_center()
                .child(
                    col().gap(2.0).grow(1.0)
                        .child(text(name(id, l)).key(focus::readiness(id, "name")).font(type_::TITLE).color(p.text))
                        .child(text(&item.detail).key(focus::readiness(id, "detail")).font(type_::BODY).color(p.muted).wrap()),
                )
                .child(tail(s, item)),
        );
    }
    let mut head = row().gap(16.0).items_center().w_full().child(
        col().gap(4.0).grow(1.0)
            .child(text(tr(l, "readiness.title")).key("readiness/title").role("heading").level(1).font(type_::TITLE).color(p.text))
            .child(text(trf(l, "readiness.summary", &[("pending", pending.to_string().as_str())])).key("readiness/summary").font(type_::BODY).color(p.muted).wrap()),
    );
    if !fixable(s).is_empty() {
        head = head.child(button(s.dark(), "readiness/fix-all", &tr(l, "readiness.fix-all"), true, |s: &mut State| {
            let ids = fixable(s);
            s.send(Cmd::FixAll(ids));
        }));
    }
    col().gap(20.0).padding(40.0).w_full().max_w(960.0).child(head).child(card)
        .child(text(tr(l, "readiness.footnote")).key("readiness/footnote").font(type_::BODY).color(p.muted).wrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_named_in_plain_words() {
        for (id, want) in [("ffmpeg", "ffmpeg"), ("python", "readiness.name.python"), ("whisperModel", "readiness.name.whisperModel"), ("gpu", "readiness.name.gpu"), ("generateBrowser", "readiness.name.generateBrowser"), ("other", "other")] {
            assert_eq!(name(id, Lang::En), tr(Lang::En, want));
        }
    }
}
