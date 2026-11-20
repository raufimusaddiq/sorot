//! The clips of one video: the ranked list beside the 9:16 stage. Export and reveal live here too.

use std::path::Path;

use rune::tok::type_;
use rune::{El, FileDialogOptions, GrowthSpec, ScrollSpec, Tx, col, row, text};
use sorot_desktop_core::clips::ordered;
use sorot_desktop_core::model::Clip;
use sorot_desktop_core::toast::ToastKind;

use crate::app::{Cmd, Msg, Route, State};
use crate::i18n::{tr, trf};
use crate::screens::{feedback, home};
use crate::ui::clip_stage::{self, clock};
use crate::ui::controls::{centered, link, link_tx, page_head, pill, score_bar};
use crate::ui::focus;
use crate::ui::fx_moments::{Moment, burst_life, rank_spring, slot};
use crate::ui::kit::{button, pal};
use crate::ui::score;
use crate::ui::states::{Kind, state_block, state_block_with};

/// Which verdicts the list shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Filter {
    #[default]
    All,
    Pass,
    Review,
    Skip,
}

impl Filter {
    pub const ALL: [Filter; 4] = [Filter::All, Filter::Pass, Filter::Review, Filter::Skip];

    pub fn id(self) -> &'static str {
        match self {
            Filter::All => "all",
            Filter::Pass => "pass",
            Filter::Review => "review",
            Filter::Skip => "skip",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Filter::All => "clips.tab.all",
            Filter::Pass => "clips.tab.pass",
            Filter::Review => "clips.tab.review",
            Filter::Skip => "clips.tab.skip",
        }
    }

    fn shows(self, verdict: Option<&str>) -> bool {
        matches!((self, verdict), (Filter::All, _) | (Filter::Pass, Some("PASS")) | (Filter::Review, Some("REVIEW")) | (Filter::Skip, Some("FAIL")))
    }
}

#[derive(Default)]
pub struct ClipsScreen {
    pub filter: Filter,
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

fn mmss(seconds: f64) -> String {
    let n = seconds.max(0.0).round() as u64;
    format!("{:02}:{:02}", n / 60, n % 60)
}

/// A row's height plus the gap between rows: how far one rank step moves a clip.
const ROW_STEP: f32 = 80.0;

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

    /// Shows one verdict's clips; the selection moves to the first of them when the chosen clip is hidden.
    pub fn set_filter(&mut self, filter: Filter) {
        self.clips.filter = filter;
        let visible = self.clips.visible();
        if let (false, Some(first)) = (visible.contains(&self.clips.selected), visible.first()) {
            self.select(*first);
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
        let visible = self.clips.visible();
        let Some(at) = visible.iter().position(|i| *i == self.clips.selected) else { return };
        if let Some(next) = visible.get(at.saturating_add_signed(delta).min(visible.len() - 1)) {
            self.select(*next);
        }
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
        let words = tr(self.lang, "clips.exported");
        self.apply(Msg::Toast(ToastKind::Done, words));
    }

    /// A local engine's file is shown in the file manager; a remote engine's is saved to a place the person picks.
    pub fn reveal_or_save(&mut self, clip_id: &str, tx: &mut Tx) {
        let Some(path) = self.clip_by_id(clip_id).and_then(|c| c.export_path.clone()) else { return };
        if !self.remote {
            return self.reveal_path(Path::new(&path));
        }
        let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned());
        let id = clip_id.to_string();
        let options = FileDialogOptions { title: tr(self.lang, "clips.save.title"), file_name: name, ..Default::default() }.filter("Video", &["mp4"]);
        tx.save_file(options, move |s: &mut State, picked, _| match picked {
            Ok(Some(dest)) => s.send(Cmd::DownloadExport { clip_id: id.clone(), dest }),
            Ok(None) => {}
            Err(e) => {
                let words = trf(s.lang, "clips.save.fail", &[("why", &e.to_string())]);
                s.apply(Msg::Toast(ToastKind::Failed, words));
            }
        });
    }

    pub fn reveal_path(&mut self, path: &Path) {
        if let Some(Err(e)) = self.reveal.as_ref().map(|r| r.reveal(path)) {
            let words = trf(self.lang, "clips.reveal.fail", &[("why", &e.to_string())]);
            self.apply(Msg::Toast(ToastKind::Failed, words));
        }
    }

    pub fn clip_by_id(&self, id: &str) -> Option<&Clip> {
        self.clips.clips.iter().find(|c| c.id == id)
    }
}

/// How long after a rank change the rows still move, in seconds (the spring has settled by then).
const MOVE_LIFE: f32 = 0.9;

impl ClipsScreen {
    /// Indexes into `clips` of the rows the filter shows, in rank order.
    pub fn visible(&self) -> Vec<usize> {
        self.clips.iter().enumerate().filter(|(_, c)| self.filter.shows(c.gate_verdict.as_deref())).map(|(i, _)| i).collect()
    }

    /// Rows still moving at `now`, as `(rect now, start, points to travel)`; `rect_of` finds a row's presented rect by key.
    pub fn rank_blurs(&self, now: f32, rect_of: impl Fn(&str) -> Option<rune_fx::Rect>) -> Vec<(rune_fx::Rect, f32, f32)> {
        self.moves.iter().filter(|(_, t0, _)| now - t0 < MOVE_LIFE).filter_map(|(id, t0, dy)| Some((rect_of(&focus::clips_row(id))?, *t0, *dy))).collect()
    }

    pub fn moving(&self, now: f32) -> bool {
        self.moves.iter().any(|(_, t0, _)| now - t0 < MOVE_LIFE)
    }

    fn preview_wanted(&self) -> bool {
        !self.clips.is_empty()
    }
}

fn row_of(s: &State, i: usize) -> El {
    let p = pal(s.dark());
    let clip = &s.clips.clips[i];
    let chosen = i == s.clips.selected;
    let verdict = clip.gate_verdict.as_deref();
    let skipped = verdict == Some("FAIL");
    let id = clip.id.clone();
    let title = clip_stage::title(s.lang, clip);
    let word = score::verdict_word(s.lang, verdict);
    let hook = clip.hook_start.map(|h| format!(" \u{b7} {}", trf(s.lang, "clips.hook", &[("t", &clock(h - clip.start_time))]))).unwrap_or_default();
    let when = format!("{}{hook}", mmss(clip.duration_sec));
    let ink = if skipped { p.muted } else { p.text };
    let thumb = col().w(40.0).h(48.0).radius(4.0).fill(p.bg).border(1.0, p.divider);
    let rank = clip.rank_pos.map_or("-".into(), |r| r.to_string());
    let inner = row().gap(16.0).px(16.0).items_center().w_full().grow(1.0)
        .child(text(rank).key(focus::clips_row(&clip.id) + "/rank").font(type_::BODY).color(if chosen { p.beam_text } else { p.muted }).w(20.0))
        .child(thumb)
        .child(col().gap(2.0).grow(1.0).shrink()
            .child(text(title.clone()).key(focus::clips_row(&clip.id) + "/title").font(type_::TITLE).color(ink).truncate())
            .child(text(when).font(type_::LABEL).color(p.muted)))
        .child(pill(focus::clips_row(&clip.id) + "/verdict", &word, score::verdict_ink(&p, verdict)))
        .child(score_bar(s.dark(), clip.score.unwrap_or(0.0)))
        .child(text(score::score_text(s.lang, clip.score)).key(focus::clips_row(&clip.id) + "/score").font(type_::BODY).color(ink).w(36.0));
    // The chosen row carries a beam line along its top edge, fading to the right.
    let top = if chosen {
        col().w_full().h(2.0).fill(p.beam).linear_gradient(std::f32::consts::FRAC_PI_2, [(0.0, p.beam), (1.0, p.beam.alpha(0.0))])
    } else {
        col().w_full().h(2.0)
    };
    col().key(focus::clips_row(&clip.id)).role("listitem").motion(rank_spring()).animate_layout().label(format!("{}. {title}, {word}", i + 1))
        .focusable(true).w_full().h(72.0).radius(8.0).fill(if chosen { p.surface } else { p.bg }).hover(p.text.alpha(0.04))
        .on_press(move |s: &mut State| s.select_id(&id)).child(top).child(inner)
}

fn tabs(s: &State) -> El {
    let p = pal(s.dark());
    let mut bar = row().key("clips/tabs").role("tablist").label(tr(s.lang, "clips.list")).gap(8.0).items_center();
    for f in Filter::ALL {
        let on = s.clips.filter == f;
        let label = tr(s.lang, f.key());
        bar = bar.child(
            col().key(focus::clips_tab(f)).role("tab").label(label.clone()).checked(on).focusable(true).px(14.0).py(8.0).radius(6.0)
                .border(1.0, if on { p.edge } else { p.bg }).fill(if on { p.raised } else { p.bg }).hover(p.text.alpha(0.06))
                .on_press(move |s: &mut State| s.set_filter(f)).child(text(label).font(type_::LABEL).color(if on { p.text } else { p.muted })),
        );
    }
    bar
}

fn details(s: &State, clip: &Clip) -> El {
    let exported = clip.export_path.is_some();
    let busy = s.clips.exporting.as_deref() == Some(clip.id.as_str());
    let (edit_id, publish_id, feedback_id, id) = (clip.id.clone(), clip.id.clone(), clip.id.clone(), clip.id.clone());
    let title = clip_stage::title(s.lang, clip);
    let (publish_title, feedback_title) = (title.clone(), title);
    let mut export = row().gap(10.0).items_center().w_full()
        .child(centered(button(s.dark(), "clips/edit", &tr(s.lang, "clips.edit"), false, move |s: &mut State| s.open_editor(&edit_id))).grow(1.0))
        .child(centered(button(s.dark(), "clips/export", &tr(s.lang, if busy { "clips.exporting" } else { "clips.export" }), !exported, |s: &mut State| s.export_selected())).grow(1.0));
    for (_, t0, k, seed) in s.bursts.live(s.now as f32, burst_life()).map(|(b, k)| ((), b.t0, k, b.seed)) {
        export = export.child(slot(Moment::JobSparkle, [t0, k, seed as f32, 0.0]).w(90.0).h(36.0).absolute(0.0, 0.0));
    }
    let mut more = row().gap(10.0).items_center().w_full()
        .child(centered(button(s.dark(), "clips/publish", &tr(s.lang, "clips.publish"), false, move |s: &mut State| s.open_publish(&publish_id, &publish_title))).grow(1.0));
    if exported {
        let label = tr(s.lang, if s.remote { "clips.save" } else { "clips.reveal" });
        more = more.child(link_tx(s.dark(), "clips/reveal", &label, false, move |s: &mut State, tx: &mut Tx| s.reveal_or_save(&id, tx)).grow(1.0));
    } else {
        more = more.child(col().grow(1.0));
    }
    let log = link(s.dark(), "clips/feedback", &tr(s.lang, "clips.feedback"), true, move |s: &mut State| feedback::open(s, &feedback_id, &feedback_title));
    col().gap(10.0).w_full().child(export).child(more).child(row().w_full().child(log))
}

pub fn view(s: &State) -> El {
    let video = s.clips.video_id.as_deref().map(|v| home::video_name(s, v)).unwrap_or_else(|| tr(s.lang, "clips.video.fallback"));
    let head = page_head(s.dark(), "clips/heading", &trf(s.lang, "clips.title", &[("video", &video)]), &tr(s.lang, "clips.sub"));
    let Some(clip) = s.selected_clip() else {
        let body = state_block_with::<State>(s.dark(), "clips/empty", Kind::Empty, &tr(s.lang, "clips.empty.cause"), &tr(s.lang, "clips.empty.next"), Some(("clips/empty/home", tr(s.lang, "clips.empty.home"), |s: &mut State| s.go_home())));
        return col().gap(24.0).padding(40.0).w_full().h_full().child(head).child(col().grow(1.0).w_full().center().child(body));
    };
    let visible = s.clips.visible();
    let blur = s.clips.moving(s.now as f32);
    let list: El = if visible.is_empty() {
        col().grow(1.0).w_full().center().child(state_block::<State>(s.dark(), "clips/filtered", Kind::Empty, &tr(s.lang, "clips.filtered.cause"), &tr(s.lang, "clips.filtered.next"), None))
    } else {
        col().key("clips/scroll").scroll(ScrollSpec { stick_bottom: false }).w_full().grow(1.0).child(
            col().key("clips/list").role("list").label(tr(s.lang, "clips.list")).growth(GrowthSpec::default()).gap(8.0).virtual_rows(
                visible.len(), 72.0,
                |s: &State, i| focus::clips_row(&s.clips.clips[s.clips.visible()[i]].id).into(),
                |s: &State, i| row_of(s, s.clips.visible()[i]),
            ),
        )
    };
    // One slot after the rows, copying the frame drawn so far: the blur of rows that just moved reads it.
    let mut left = col().gap(12.0).grow(1.0).min_h(0.0).max_w(1000.0).h_full().child(tabs(s)).child(list);
    if blur {
        left = left.child(slot(Moment::RankBlur, [0.0; 4]).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)));
    }
    let mut side = col().key("clips/side/scroll").scroll(ScrollSpec { stick_bottom: false }).grow(1.0).min_h(0.0).h_full().gap(16.0);
    // The results sheet opens above the stage: it is what the person just asked for.
    if s.panels.feedback.clip_id.as_deref() == Some(clip.id.as_str()) {
        side = side.child(feedback::view(s));
    }
    let side = side.child(clip_stage::view(s, clip, None, true)).child(details(s, clip));
    // 270 wide at 1280, 400 at 1920 (screens.ts: SW), plus the 30 pt gutter.
    let side = row().h_full().w_frac(0.25).min_w(300.0).max_w(430.0).child(side).child(col().w(30.0));
    col().gap(20.0).padding(40.0).w_full().h_full().child(head).child(row().gap(40.0).w_full().grow(1.0).justify_between().child(left).child(side))
}
