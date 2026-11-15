//! The clip editor: options for one clip, the hook on a timeline, Re-render, Export. Re-render
//! sends only what differs from what the clip already resolves to (`core::clips::edit_layer`).

use rune::tok::type_;
use std::rc::Rc;

use rune::{El, Tx, col, row, text};
use serde_json::Value;
use sorot_desktop_core::clips::{Options, edit_layer};
use sorot_desktop_core::model::Clip;
use sorot_desktop_core::toast::ToastKind;

use crate::app::{Cmd, Msg, Route, State};
use crate::i18n::{tr, trf};
use crate::ui::clip_stage;
use crate::ui::fx_moments::{Moment, slot};
use crate::ui::controls::{Pick, centered, dropdown, link, link_tx, option_choices, page_head, switch, waveform};
use crate::ui::kit::{button, pal};
use crate::ui::states::{Kind, state_block_with};

#[derive(Default)]
pub struct Editor {
    pub clip_id: String,
    /// What the person chose in this session.
    pub edits: Options,
    pub rendering: bool,
}

fn parsed(json: Option<&str>) -> Options {
    json.and_then(|j| serde_json::from_str::<Value>(j).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

impl State {
    pub fn open_editor(&mut self, clip_id: &str) {
        self.route = Route::Editor(clip_id.to_string());
        self.editor = Editor { clip_id: clip_id.to_string(), ..Editor::default() };
        if self.edit_options.is_none() {
            self.send(Cmd::LoadOptions);
        }
    }

    pub fn leave_editor(&mut self) {
        if let Some(v) = self.clips.video_id.clone() {
            self.route = Route::Clips(v);
        } else {
            self.route = Route::Home;
        }
    }

    pub fn set_edit(&mut self, key: &str, value: Value) {
        if self.editor.edits.get(key) == Some(&value) {
            self.editor.edits.remove(key);
        } else {
            self.editor.edits.insert(key.to_string(), value);
        }
    }

    /// The part of this session's choices the clip does not already have.
    pub fn rerender_delta(&self) -> Options {
        let defaults = self.edit_options.as_ref().map(|o| o.defaults.clone()).unwrap_or_default();
        let clip = self.clip_by_id(&self.editor.clip_id).map(|c| parsed(c.options.as_deref())).unwrap_or_default();
        edit_layer(&defaults, &Options::new(), &clip, &self.editor.edits)
    }

    pub fn rerender(&mut self) {
        let delta = self.rerender_delta();
        if delta.is_empty() {
            let words = tr(self.lang, "editor.unchanged");
            return self.apply(Msg::Toast(ToastKind::Info, words));
        }
        self.editor.rendering = true;
        let clip_id = self.editor.clip_id.clone();
        self.send(Cmd::Rerender { clip_id, delta });
    }

    pub fn rerendered(&mut self, clip: Clip) {
        self.editor.rendering = false;
        self.editor.edits.clear();
        if let Some(slot) = self.clips.clips.iter_mut().find(|c| c.id == clip.id) {
            // The render replaces the clip's file; the last export is a separate copy that stays.
            let (path, status) = (slot.export_path.take(), std::mem::take(&mut slot.export_status));
            *slot = clip;
            if path.is_some() {
                (slot.export_path, slot.export_status) = (path, status);
            }
        }
        let words = tr(self.lang, "editor.rendered");
        self.apply(Msg::Toast(ToastKind::Done, words));
    }

    /// What the clip will be rendered with now: this session's choice, else the clip's, else the default.
    fn current(&self, clip: &Clip, key: &str) -> Option<Value> {
        let defaults = self.edit_options.as_ref().map(|o| o.defaults.clone()).unwrap_or_default();
        self.editor.edits.get(key).cloned().or_else(|| parsed(clip.options.as_deref()).get(key).cloned()).or_else(|| defaults.get(key).cloned())
    }
}

/// The timeline: a waveform-shaped bar with the hook's marker (a vertical line, its dot and "Hook m:ss") on it.
fn timeline(s: &State, clip: &Clip) -> El {
    let p = pal(s.dark);
    let total = clip.duration_sec.max(0.001);
    let label = trf(s.lang, "editor.timeline.label", &[("t", &clip_stage::clock(clip.duration_sec))]);
    let seed = clip.id.bytes().fold(7u64, |a, b| a.wrapping_mul(31).wrapping_add(u64::from(b)));
    let bar = waveform(s.dark, "editor/timeline", &label, seed, 120.0);
    let mut wave = col().w_full().h(120.0).fill(p.surface).border(1.0, p.divider).radius(6.0).child(bar);
    let mut lane = col().w_full().h(24.0);
    if let Some(a) = clip.hook_start {
        let frac = (((a - clip.start_time) / total).clamp(0.0, 0.92) as f32).max(0.01);
        let words = trf(s.lang, "editor.hook", &[("t", &clip_stage::clock(a - clip.start_time))]);
        // The marker sits `frac` of the way along: two stretching spacers whose weights are the two sides.
        let marker = row().key("editor/hook-marker").role("img").label(words.clone()).gap(6.0).items_center()
            .child(col().w(10.0).h(10.0).radius(5.0).fill(p.beam).child(slot(Moment::BeamHead, [0.0; 4]).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)))).child(text(words).font(type_::LABEL).color(p.beam_text));
        lane = row().w_full().h(24.0).items_center().child(col().grow(frac)).child(marker.shrink()).child(col().grow(1.0 - frac));
        wave = wave.child(row().w_full().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).child(col().grow(frac)).child(col().w(2.0).h_full().fill(p.beam).linear_gradient(std::f32::consts::PI, [(0.0, p.beam), (1.0, p.beam.alpha(0.0))])).child(col().grow(1.0 - frac)));
    }
    let wave = col().w_full().child(lane).child(wave);
    col().w_full().max_w(900.0).gap(4.0).child(wave)
        .child(row().w_full().justify_between().child(text("0:00").font(type_::LABEL).color(p.muted)).child(text(clip_stage::clock(clip.duration_sec)).font(type_::LABEL).color(p.muted)))
}

/// The value the dropdown shows: this session's choice, else the clip's, else the engine's default.
fn word_of(s: &State, clip: &Clip, key: &str) -> String {
    s.current(clip, key).and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn pick(key: &'static str) -> Pick {
    Rc::new(move |s: &mut State, v: &str| {
        let value = Value::from(if v == "none" { "" } else { v });
        // Choosing again what is already chosen changes nothing (`set_edit` would undo it).
        if s.editor.edits.get(key) != Some(&value) {
            s.set_edit(key, value);
        }
    })
}

fn flag(s: &State, clip: &Clip, key: &str) -> bool {
    s.current(clip, key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn options_card(s: &State, clip: &Clip) -> El {
    let p = pal(s.dark);
    let opts = s.edit_options.clone().unwrap_or_default();
    let mut music = vec![("none".to_string(), tr(s.lang, "editor.nomusic"))];
    music.extend(s.music.iter().map(|m| (m.clone(), m.clone())));
    let now = word_of(s, clip, "bgm");
    let now = if now.is_empty() { "none".to_string() } else { now };
    let (hook_first, silence) = (flag(s, clip, "hookFirst"), flag(s, clip, "silenceTrim"));
    col().key("editor/options").role("group").label(tr(s.lang, "editor.options")).gap(14.0).padding(24.0).w(340.0).self_stretch().fill(p.surface).border(1.0, p.divider).radius(10.0)
        .child(text(tr(s.lang, "editor.options")).font(type_::TITLE).color(p.text))
        .child(dropdown(s, "editor/style", &tr(s.lang, "editor.style"), &word_of(s, clip, "style"), &option_choices(s.lang, "style", &opts.styles), pick("style")))
        .child(dropdown(s, "editor/reframe", &tr(s.lang, "editor.reframe"), &word_of(s, clip, "reframe"), &option_choices(s.lang, "reframe", &opts.reframe_modes), pick("reframe")))
        .child(switch(s.dark, "editor/hook-first", &tr(s.lang, "editor.hookfirst"), None, hook_first, move |s: &mut State| s.set_edit("hookFirst", Value::Bool(!hook_first))))
        .child(switch(s.dark, "editor/silence-trim", &tr(s.lang, "editor.silence"), None, silence, move |s: &mut State| s.set_edit("silenceTrim", Value::Bool(!silence))))
        .child(dropdown(s, "editor/music", &tr(s.lang, "editor.music"), &now, &music, pick("bgm")))
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark);
    let Some(clip) = s.clip_by_id(&s.editor.clip_id).cloned() else {
        let action = ("editor/missing/back", tr(s.lang, "editor.missing.back"), (|s: &mut State| s.leave_editor()) as fn(&mut State));
        return col().w_full().h_full().center().child(state_block_with::<State>(s.dark, "editor/missing", Kind::Empty, &tr(s.lang, "editor.missing.cause"), &tr(s.lang, "editor.missing.next"), Some(action)));
    };
    let title = trf(s.lang, "editor.title", &[("title", &clip_stage::title(s.lang, &clip))]);
    let head = page_head(s.dark, "editor/title", &title, &tr(s.lang, "editor.sub"));
    let mut middle = col().gap(6.0).grow(1.0).shrink()
        .child(text(tr(s.lang, "editor.timeline")).font(type_::TITLE).color(p.text))
        .child(text(tr(s.lang, "editor.timeline.sub")).font(type_::LABEL).color(p.muted).wrap())
        .child(col().h(8.0))
        .child(timeline(s, &clip))
        .child(col().h(8.0))
        .child(text(tr(s.lang, "editor.hook.note")).font(type_::LABEL).color(p.muted).wrap());
    if clip.export_path.is_some() {
        middle = middle.child(text(tr(s.lang, "editor.note.kept")).key("editor/export-note").font(type_::LABEL).color(p.muted).wrap());
    }
    let body = row().gap(32.0).w_full().grow(1.0).items_start()
        .child(clip_stage::view(s, &clip, Some((220.0, 390.0)), false))
        .child(middle)
        .child(options_card(s, &clip));
    let id = clip.id.clone();
    let mut footer = row().gap(12.0).items_center().justify_end().w_full();
    if clip.export_path.is_some() {
        let label = tr(s.lang, if s.remote { "clips.save" } else { "clips.reveal" });
        footer = footer.child(link_tx(s.dark, "editor/reveal", &label, false, move |s: &mut State, tx: &mut Tx| s.reveal_or_save(&id, tx)));
    }
    footer = footer
        .child(link(s.dark, "editor/back", &tr(s.lang, "editor.cancel"), false, |s: &mut State| s.leave_editor()))
        .child(centered(button(s.dark, "editor/rerender", &tr(s.lang, if s.editor.rendering { "editor.rendering" } else { "editor.rerender" }), true, |s: &mut State| s.rerender())));
    col().key("editor/scroll").scroll(rune::ScrollSpec { stick_bottom: false }).gap(24.0).padding(40.0).w_full().h_full().child(head).child(body).child(footer)
}
