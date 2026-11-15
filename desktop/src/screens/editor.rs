//! The clip editor: options for one clip, the hook on a timeline, Re-render, Export. Re-render
//! sends only what differs from what the clip already resolves to (`core::clips::edit_layer`).

use rune::tok::type_;
use rune::{El, Tx, col, row, text};
use serde_json::Value;
use sorot_desktop_core::clips::{Options, edit_layer};
use sorot_desktop_core::model::Clip;
use sorot_desktop_core::toast::ToastKind;

use crate::app::{Cmd, Msg, Route, State};
use crate::ui::clip_stage;
use crate::ui::kit::{button, pal};
use crate::ui::states::{Kind, state_block};

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
            return self.apply(Msg::Toast(ToastKind::Info, "Nothing changed since the last render.".into()));
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
        self.apply(Msg::Toast(ToastKind::Done, "Rendered again. The earlier export stays until you export again.".into()));
    }

    /// What the clip will be rendered with now: this session's choice, else the clip's, else the default.
    fn current(&self, clip: &Clip, key: &str) -> Option<Value> {
        let defaults = self.edit_options.as_ref().map(|o| o.defaults.clone()).unwrap_or_default();
        self.editor.edits.get(key).cloned().or_else(|| parsed(clip.options.as_deref()).get(key).cloned()).or_else(|| defaults.get(key).cloned())
    }
}

fn timeline(s: &State, clip: &Clip) -> El {
    let p = pal(s.dark);
    const WIDTH: f32 = 240.0;
    let total = clip.duration_sec.max(0.001);
    let at = |t: f64| (((t - clip.start_time) / total).clamp(0.0, 1.0) as f32) * WIDTH;
    let mut bar = row().key("editor/timeline").role("img").label(format!("Timeline, {} long", clip_stage::clock(clip.duration_sec))).w(WIDTH).h(18.0).fill(p.raised).radius(4.0).items_center();
    if let (Some(a), Some(b)) = (clip.hook_start, clip.hook_end) {
        let (x0, x1) = (at(a), at(b).max(at(a) + 4.0));
        bar = bar.child(col().w(x0).h(18.0)).child(col().key("editor/hook-marker").role("img").label(format!("Hook {} to {}", clip_stage::clock(a - clip.start_time), clip_stage::clock(b - clip.start_time))).w(x1 - x0).h(18.0).fill(p.beam).radius(4.0));
    }
    bar
}

fn choice(s: &State, clip: &Clip, key: &'static str, title: &str, values: &[String]) -> El {
    let p = pal(s.dark);
    let now = s.current(clip, key).and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let mut line = row().gap(8.0).items_center().child(text(title).font(type_::LABEL).color(p.muted).w(100.0));
    for v in values {
        let value = Value::from(v.as_str());
        line = line.child(button(s.dark, format!("editor/{key}/{v}"), v, now == *v, move |s: &mut State| s.set_edit(key, value.clone())));
    }
    line
}

fn switch(s: &State, clip: &Clip, key: &'static str, ui_key: &str, label: &str) -> El {
    let on = s.current(clip, key).and_then(|v| v.as_bool()).unwrap_or(false);
    button(s.dark, ui_key, &format!("{label}: {}", if on { "on" } else { "off" }), on, move |s: &mut State| s.set_edit(key, Value::Bool(!on)))
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark);
    let Some(clip) = s.clip_by_id(&s.editor.clip_id).cloned() else {
        return col().w_full().h_full().center().child(state_block::<State>(s.dark, "editor/missing", Kind::Empty, "This clip is not loaded", "Go back to the clips and choose one.", Some(("editor/missing/back", "Back to clips", |s: &mut State| s.leave_editor()))));
    };
    let opts = s.edit_options.clone().unwrap_or_default();
    let mut music = vec!["none".to_string()];
    music.extend(s.music.iter().cloned());
    let now = s.current(&clip, "bgm").and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let mut music_line = row().gap(8.0).items_center().child(text("Music").font(type_::LABEL).color(p.muted).w(100.0));
    for m in &music {
        let value = Value::from(if m == "none" { "" } else { m.as_str() });
        let on = now == value.as_str().unwrap_or_default();
        music_line = music_line.child(button(s.dark, format!("editor/music/{m}"), m, on, move |s: &mut State| s.set_edit("bgm", value.clone())));
    }
    let id = clip.id.clone();
    let export_id = clip.id.clone();
    let mut actions = row().gap(10.0).items_center()
        .child(button(s.dark, "editor/rerender", if s.editor.rendering { "Rendering" } else { "Re-render" }, true, |s: &mut State| s.rerender()))
        .child(button(s.dark, "editor/export", "Export", false, move |s: &mut State| { s.select_id(&export_id); s.export_selected(); }));
    if clip.export_path.is_some() {
        let label = if s.remote { "Save a copy" } else { "Show in folder" };
        actions = actions.child(
            col().key("editor/reveal").role("button").label(label).focusable(true).padding(10.0).radius(6.0).fill(p.raised).border(1.0, p.divider)
                .on_press_tx(move |s: &mut State, tx: &mut Tx| s.reveal_or_save(&id, tx)).child(text(label).font(type_::LABEL).color(p.text)),
        );
    }
    let mut options = col().gap(12.0).grow(1.0).max_w(520.0)
        .child(choice(s, &clip, "style", "Captions", &opts.styles))
        .child(choice(s, &clip, "reframe", "Framing", &opts.reframe_modes))
        .child(switch(s, &clip, "silenceTrim", "editor/silence-trim", "Cut silences"))
        .child(switch(s, &clip, "hookFirst", "editor/hook-first", "Hook first"))
        .child(music_line)
        .child(actions);
    if clip.export_path.is_some() {
        options = options.child(text("The earlier export stays until you export again.").key("editor/export-note").font(type_::BODY).color(p.muted).wrap());
    }
    let head = row().gap(12.0).items_center().w_full()
        .child(text(clip_stage::title(&clip)).role("heading").level(1).font(type_::TITLE).color(p.text).grow(1.0))
        .child(button(s.dark, "editor/back", "Back to clips", false, |s: &mut State| s.leave_editor()));
    let stage = col().gap(12.0).items_center().child(clip_stage::view(s, &clip)).child(timeline(s, &clip));
    col().gap(16.0).padding(24.0).w_full().h_full().child(head).child(row().gap(24.0).w_full().grow(1.0).child(options).child(stage))
}
