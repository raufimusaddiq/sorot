//! The clips of one video: the ranked list beside the 9:16 stage. Export and reveal live here too.

use std::path::Path;

use rune::tok::type_;
use rune::{El, FileDialogOptions, GrowthSpec, Key, KeyEvent, ScrollSpec, Tx, col, row, text};
use sorot_desktop_core::clips::ordered;
use sorot_desktop_core::model::Clip;
use sorot_desktop_core::toast::ToastKind;

use crate::app::{Cmd, Msg, Route, State};
use crate::ui::clip_stage::{self, clock};
use crate::ui::fx_moments::{Moment, burst_life, rank_spring, slot};
use crate::ui::kit::{button, pal};
use crate::ui::score;
use crate::ui::states::{Kind, state_block};

#[derive(Default)]
pub struct ClipsScreen {
    pub video_id: Option<String>,
    /// In `rankPos` order (`core::clips`).
    pub clips: Vec<Clip>,
    pub selected: usize,
    pub preview_error: Option<String>,
    /// The clip whose export is running.
    pub exporting: Option<String>,
    /// CPU renderer: the clip's local file, which Play opens in the system's video player.
    pub external: Option<std::path::PathBuf>,
    /// Clips whose rank just changed: `(clip id, start, points to travel)`; the rank spring and its blur read it.
    pub moves: Vec<(String, f32, f32)>,
}

/// A row's height plus the gap between rows: how far one rank step moves a clip.
const ROW_STEP: f32 = 70.0;

impl State {
    pub fn show_clips(&mut self, video_id: &str) {
        self.route = Route::Clips(video_id.to_string());
        self.clips = ClipsScreen { video_id: Some(video_id.to_string()), ..ClipsScreen::default() };
        self.send(Cmd::LoadClips(video_id.to_string()));
    }

    pub fn selected_clip(&self) -> Option<&Clip> {
        self.clips.clips.get(self.clips.selected)
    }

    /// The engine's clips for a video, in rank order; the selection stays on the same clip.
    pub fn apply_clips(&mut self, video_id: &str, list: Vec<Clip>) {
        if self.clips.video_id.as_deref() != Some(video_id) {
            return;
        }
        let keep = self.selected_clip().map(|c| c.id.clone());
        let before: Vec<String> = self.clips.clips.iter().map(|c| c.id.clone()).collect();
        self.clips.clips = ordered(&list);
        self.clips.moves = self.clips.clips.iter().enumerate()
            .filter_map(|(new, c)| before.iter().position(|id| *id == c.id).filter(|old| *old != new).map(|old| (c.id.clone(), self.now as f32, (old as f32 - new as f32) * ROW_STEP)))
            .collect();
        self.clips.selected = self.clips.clips.iter().position(|c| Some(&c.id) == keep.as_ref()).unwrap_or(0);
        if self.clips.preview_wanted() {
            self.load_preview();
        }
    }

    pub fn select(&mut self, index: usize) {
        if index < self.clips.clips.len() && index != self.clips.selected {
            self.clips.selected = index;
            self.load_preview();
        }
    }

    pub fn select_id(&mut self, id: &str) {
        if let Some(i) = self.clips.clips.iter().position(|c| c.id == id) {
            self.select(i);
        }
    }

    /// J (next) and K (previous), stopping at the ends.
    pub fn move_selection(&mut self, delta: isize) {
        let last = self.clips.clips.len().saturating_sub(1);
        self.select(self.clips.selected.saturating_add_signed(delta).min(last));
    }

    fn load_preview(&mut self) {
        self.clips.preview_error = None;
        self.clips.external = None;
        self.preview.pause();
        if let Some(clip) = self.selected_clip().cloned() {
            self.send(Cmd::Preview(Box::new(clip)));
        }
    }

    pub fn toggle_play(&mut self) {
        if self.cpu_renderer {
            return self.open_externally();
        }
        if self.preview.state() == crate::preview::PreviewState::Playing {
            self.preview.pause();
        } else {
            self.preview.play();
        }
    }

    pub fn export_selected(&mut self) {
        if let Some(id) = self.selected_clip().map(|c| c.id.clone()) {
            self.clips.exporting = Some(id.clone());
            self.send(Cmd::Export(id));
        }
    }

    pub fn exported(&mut self, clip_id: &str, path: &str) {
        self.clips.exporting = None;
        for c in self.clips.clips.iter_mut().filter(|c| c.id == clip_id) {
            (c.export_path, c.export_status) = (Some(path.to_string()), "COMPLETED".into());
        }
        self.apply(Msg::Toast(ToastKind::Done, "Exported. The file is ready.".into()));
    }

    /// A local engine's file is shown in the file manager; a remote engine's is saved to a place the person picks.
    pub fn reveal_or_save(&mut self, clip_id: &str, tx: &mut Tx) {
        let Some(path) = self.clip_by_id(clip_id).and_then(|c| c.export_path.clone()) else { return };
        if !self.remote {
            return self.reveal_path(Path::new(&path));
        }
        let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned());
        let id = clip_id.to_string();
        let options = FileDialogOptions { title: "Save the clip".into(), file_name: name, ..Default::default() }.filter("Video", &["mp4"]);
        tx.save_file(options, move |s: &mut State, picked, _| match picked {
            Ok(Some(dest)) => s.send(Cmd::DownloadExport { clip_id: id.clone(), dest }),
            Ok(None) => {}
            Err(e) => s.apply(Msg::Toast(ToastKind::Failed, format!("Could not open the save dialog: {e}"))),
        });
    }

    pub fn reveal_path(&mut self, path: &Path) {
        if let Some(Err(e)) = self.reveal.as_ref().map(|r| r.reveal(path)) {
            self.apply(Msg::Toast(ToastKind::Failed, format!("Could not show the file: {e}")));
        }
    }

    pub fn clip_by_id(&self, id: &str) -> Option<&Clip> {
        self.clips.clips.iter().find(|c| c.id == id)
    }

    /// Keys nobody else took: J/K choose a clip, Space plays, Ctrl+E exports.
    pub fn clips_key(&mut self, key: &KeyEvent) -> bool {
        if !matches!(self.route, Route::Clips(_)) {
            return false;
        }
        match (&key.key, key.mods.cmd) {
            (Key::Text(t), false) if t.eq_ignore_ascii_case("j") => self.move_selection(1),
            (Key::Text(t), false) if t.eq_ignore_ascii_case("k") => self.move_selection(-1),
            (Key::Text(t), false) if t == " " => self.toggle_play(),
            (Key::Command('e'), true) => self.export_selected(),
            _ => return false,
        }
        true
    }
}

/// How long after a rank change the rows still move, in seconds (the spring has settled by then).
const MOVE_LIFE: f32 = 0.9;

impl ClipsScreen {
    /// Rows still moving at `now`, as `(rect now, start, points to travel)`; `rect_of` finds a row's presented rect by key.
    pub fn rank_blurs(&self, now: f32, rect_of: impl Fn(&str) -> Option<rune_fx::Rect>) -> Vec<(rune_fx::Rect, f32, f32)> {
        self.moves.iter().filter(|(_, t0, _)| now - t0 < MOVE_LIFE).filter_map(|(id, t0, dy)| Some((rect_of(&format!("clips/row/{id}"))?, *t0, *dy))).collect()
    }

    pub fn moving(&self, now: f32) -> bool {
        self.moves.iter().any(|(_, t0, _)| now - t0 < MOVE_LIFE)
    }

    fn preview_wanted(&self) -> bool {
        !self.clips.is_empty()
    }
}

fn row_of(s: &State, i: usize) -> El {
    let p = pal(s.dark);
    let clip = &s.clips.clips[i];
    let chosen = i == s.clips.selected;
    let id = clip.id.clone();
    let title = clip_stage::title(clip);
    let when = format!("{} - {}", clock(clip.start_time), clock(clip.end_time));
    row().key(format!("clips/row/{}", clip.id)).role("listitem").motion(rank_spring()).animate_layout().label(format!("{}. {title}, {}", i + 1, score::verdict_word(clip.gate_verdict.as_deref())))
        .focusable(true).gap(10.0).padding(10.0).items_center().w_full().radius(8.0)
        .fill(if chosen { p.raised } else { p.surface }).border(1.0, if chosen { p.beam } else { p.divider })
        .on_press(move |s: &mut State| s.select_id(&id))
        .child(text(format!("#{}", clip.rank_pos.map_or("-".into(), |r| r.to_string()))).key(format!("clips/row/{}/rank", clip.id)).font(type_::LABEL).color(p.muted).w(32.0))
        .child(col().gap(2.0).grow(1.0).shrink()
            .child(text(title).key(format!("clips/row/{}/title", clip.id)).font(type_::BODY).color(p.text).truncate())
            .child(text(when).font(type_::LABEL).color(p.muted)))
        .child(score::mark(s.dark, &format!("clips/row/{}", clip.id), clip.score, clip.gate_verdict.as_deref()))
}

fn details(s: &State, clip: &Clip) -> El {
    let p = pal(s.dark);
    let exported = clip.export_path.is_some();
    let busy = s.clips.exporting.as_deref() == Some(clip.id.as_str());
    let id = clip.id.clone();
    let mut actions = row().gap(10.0).items_center();
    for (_, t0, k, seed) in s.bursts.live(s.now as f32, burst_life()).map(|(b, k)| ((), b.t0, k, b.seed)) {
        actions = actions.child(slot(Moment::JobSparkle, [t0, k, seed as f32, 0.0]).w(90.0).h(36.0).absolute(0.0, 0.0));
    }
    let mut actions = actions.child(button(s.dark, "clips/export", if busy { "Exporting" } else { "Export" }, !exported, |s: &mut State| s.export_selected()));
    let mut more = row().gap(10.0).items_center();
    if exported {
        let label = if s.remote { "Save a copy" } else { "Show in folder" };
        more = more.child(
            col().key("clips/reveal").role("button").label(label).focusable(true).padding(10.0).radius(6.0).fill(p.raised).border(1.0, p.divider)
                .on_press_tx(move |s: &mut State, tx: &mut Tx| s.reveal_or_save(&id, tx)).child(text(label).font(type_::LABEL).color(p.text)),
        );
    }
    let edit_id = clip.id.clone();
    actions = actions.child(button(s.dark, "clips/edit", "Edit", false, move |s: &mut State| s.open_editor(&edit_id)));
    let mut panel = col().gap(10.0).w_full()
        .child(text(clip_stage::title(clip)).key("clips/title").font(type_::TITLE).color(p.text).wrap())
        .child(score::mark(s.dark, "clips/detail", clip.score, clip.gate_verdict.as_deref()));
    if let Some(why) = &clip.reason {
        panel = panel.child(text(why).key("clips/reason").font(type_::BODY).color(p.muted).wrap());
    }
    panel.child(actions).child(more)
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark);
    let head = row().gap(12.0).items_center().w_full()
        .child(text("Clips").role("heading").level(1).font(type_::TITLE).color(p.text).grow(1.0))
        .child(button(s.dark, "clips/home", "Back to Home", false, |s: &mut State| s.go_home()));
    let Some(clip) = s.selected_clip() else {
        let body = state_block::<State>(s.dark, "clips/empty", Kind::Empty, "No clips yet", "When a job finishes, its clips show here ranked best first.", Some(("clips/empty/home", "Go to Home", |s: &mut State| s.go_home())));
        return col().gap(16.0).padding(24.0).w_full().h_full().child(head).child(col().grow(1.0).w_full().center().child(body));
    };
    let blur = s.clips.moving(s.now as f32);
    let scroll = col().key("clips/scroll").scroll(ScrollSpec { stick_bottom: false }).w(300.0).h_full().child(
        col().key("clips/list").role("list").label("Clips, best first").growth(GrowthSpec::default()).gap(6.0).virtual_rows(
            s.clips.clips.len(), 64.0,
            |s: &State, i| format!("clips/row/{}", s.clips.clips[i].id).into(),
            row_of,
        ),
    );
    // One slot after the rows, copying the frame drawn so far: the blur of rows that just moved reads it.
    let mut list = col().w(300.0).h_full().child(scroll);
    if blur {
        list = list.child(slot(Moment::RankBlur, [0.0; 4]).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)));
    }
    let side = col().key("clips/side").scroll(ScrollSpec { stick_bottom: false }).grow(1.0).h_full()
        .child(col().gap(12.0).items_center().w_full().child(clip_stage::view(s, clip)).child(details(s, clip)));
    let body = row().gap(24.0).w_full().grow(1.0).child(list).child(side);
    col().gap(16.0).padding(24.0).w_full().h_full().child(head).child(body)
}
