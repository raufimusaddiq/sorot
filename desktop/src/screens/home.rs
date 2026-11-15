//! Home: bring a video in (drop a file, choose one, paste a link), say what the clips should be
//! about, set the import options, and see the jobs already made.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use rune::tok::type_;
use rune::{El, FileDialogOptions, Key, KeyEvent, ScrollSpec, TextEdit, Tx, col, edit_access, row, text, text_input};
use sorot_desktop_core::clips::Options;
use sorot_desktop_core::model::{Job, JobPhase};

use crate::app::{Cmd, Route, State};
use crate::engine::{EngineError, ImportRequest, Source};
use crate::i18n::{Lang, tr, trf};
use crate::ui::controls::{DISPLAY_SMALL, Pick, centered, dropdown, option_choices, page_head, pill, switch};
use crate::ui::kit::{button, pal};
use crate::ui::states::{Kind, state_block};

pub const MAX_DIRECTION: usize = 500;
pub const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "mkv", "webm"];

/// Why an import did not start, in words for the person and the next step.
#[derive(Clone, Debug, PartialEq)]
pub enum HomeError {
    Direction(usize),
    Link,
    File(String),
    Engine(EngineError),
}

impl HomeError {
    pub fn words(&self, lang: Lang) -> String {
        match self {
            HomeError::Direction(n) => trf(lang, "home.err.direction", &[("n", &n.to_string()), ("max", &MAX_DIRECTION.to_string())]),
            HomeError::Link => tr(lang, "home.err.link"),
            HomeError::File(name) => trf(lang, "home.err.file", &[("name", name)]),
            HomeError::Engine(e) => e.to_string(),
        }
    }

    pub fn next(&self, lang: Lang) -> String {
        tr(lang, match self {
            HomeError::Direction(_) => "home.err.direction.next",
            HomeError::Link => "home.err.link.next",
            HomeError::File(_) => "home.err.file.next",
            HomeError::Engine(EngineError::DiskFull { .. }) => "home.err.disk.next",
            HomeError::Engine(_) => "home.err.engine.next",
        })
    }
}

pub struct Home {
    pub link: TextEdit,
    pub direction: TextEdit,
    /// Options the card changed from the engine's defaults.
    pub options: Options,
    pub error: Option<HomeError>,
    /// A drag of files is over the drop field.
    pub dropping: bool,
}

impl Default for Home {
    fn default() -> Self {
        Home { link: TextEdit::new(""), direction: TextEdit::new(""), options: Options::new(), error: None, dropping: false }
    }
}

fn is_video(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| VIDEO_EXTENSIONS.iter().any(|v| v.eq_ignore_ascii_case(e)))
}

impl State {
    /// Checks what Home holds and starts the import; a problem stays on Home with its next step.
    pub fn import(&mut self, source: Source) {
        let direction = self.home.direction.text.trim().to_string();
        let n = direction.chars().count();
        let problem = match &source {
            _ if n > MAX_DIRECTION => Some(HomeError::Direction(n)),
            Source::Url(u) if !(u.starts_with("http://") || u.starts_with("https://")) => Some(HomeError::Link),
            Source::File(p) if !is_video(p) => Some(HomeError::File(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())),
            _ => None,
        };
        self.home.error = problem.clone();
        if problem.is_none() {
            let options = self.home.options.clone();
            self.send(Cmd::Import(ImportRequest { source, direction, options }));
        }
    }

    pub fn import_link(&mut self) {
        let url = self.home.link.text.trim().to_string();
        self.import(Source::Url(url));
    }

    /// Files dropped on the field: the first video starts the import.
    pub fn dropped(&mut self, files: &[PathBuf]) {
        if let Some(first) = files.first() {
            self.import(Source::File(first.clone()));
        }
    }

    /// Sets an option; a value the engine already uses is not an option the person changed, so it is dropped.
    pub fn toggle_option(&mut self, key: &str, value: serde_json::Value) {
        let default = self.edit_options.as_ref().and_then(|o| o.defaults.get(key));
        if self.home.options.get(key) == Some(&value) || default == Some(&value) {
            self.home.options.remove(key);
        } else {
            self.home.options.insert(key.to_string(), value);
        }
    }

    /// Reads the engine's caption styles, framing modes and music once; the options card needs them.
    pub fn load_options(&mut self) {
        if self.edit_options.is_none() {
            self.send(Cmd::LoadOptions);
        }
    }

    /// Opens the file dialog for a video (Ctrl+O, or a press on the drop field).
    pub fn choose_file(&self, tx: &mut Tx) {
        let options = FileDialogOptions { title: tr(self.lang, "home.dialog"), ..Default::default() }.filter(tr(self.lang, "home.dialog.filter"), &VIDEO_EXTENSIONS);
        tx.open_file(options, |s: &mut State, picked, _| match picked {
            Ok(Some(path)) => s.import(Source::File(path)),
            Ok(None) => {}
            Err(e) => s.home.error = Some(HomeError::Engine(EngineError::Network(e.to_string()))),
        });
    }

    /// Ctrl+O on Home chooses a file, Ctrl+. on a running job cancels it; the clips keys come last.
    pub fn keys(&mut self, key: &KeyEvent, tx: &mut Tx) -> bool {
        let running = self.job.detail.as_ref().is_some_and(|d| d.job.is_running());
        match (&key.key, key.mods.cmd) {
            (Key::Command('o'), true) if matches!(self.route, Route::Home) => self.choose_file(tx),
            (Key::Command('.'), true) if matches!(self.route, Route::Job(_)) && running => self.cancel_shown_job(),
            _ => return self.clips_key(key),
        }
        true
    }
}

fn labelled(s: &State, label: &str, input: El) -> El {
    col().gap(6.0).w_full().child(text(label.to_string()).font(type_::LABEL).color(pal(s.dark()).muted)).child(input)
}

fn input_box(s: &State, key: &str, label: &str, hint: &str, edit: &TextEdit, single: bool, access: fn(&mut State) -> &mut TextEdit) -> El {
    let p = pal(s.dark());
    let input = text_input(edit, type_::BODY).key(key).label(label).color(p.text).placeholder(hint, p.muted).on_edit(edit_access(access)).w_full().padding(12.0)
        .fill(p.surface).border(1.0, p.edge).radius(6.0);
    if single { input.single_line() } else { input.h(88.0) }
}

/// What the person chose for `name`, else the engine's default, else nothing.
fn chosen(s: &State, name: &str) -> String {
    let defaults = s.edit_options.as_ref().map(|o| o.defaults.clone()).unwrap_or_default();
    s.home.options.get(name).and_then(|v| v.as_str()).or_else(|| defaults.get(name).and_then(|v| v.as_str())).unwrap_or_default().to_string()
}

fn chosen_default(s: &State, name: &str) -> String {
    s.edit_options.as_ref().and_then(|o| o.defaults.get(name)).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

fn flag(s: &State, name: &str) -> bool {
    let defaults = s.edit_options.as_ref().map(|o| o.defaults.clone()).unwrap_or_default();
    s.home.options.get(name).and_then(|v| v.as_bool()).or_else(|| defaults.get(name).and_then(|v| v.as_bool())).unwrap_or(false)
}

fn pick(name: &'static str) -> Pick {
    Rc::new(move |s: &mut State, v: &str| {
        // Choosing what the engine already uses is no change, so nothing is sent for it.
        if chosen_default(s, name) == v {
            s.home.options.remove(name);
        } else {
            s.home.options.insert(name.to_string(), serde_json::Value::from(v));
        }
    })
}

fn flip(name: &'static str) -> impl Fn(&mut State) + 'static {
    move |s: &mut State| {
        let on = flag(s, name);
        s.toggle_option(name, serde_json::Value::Bool(!on));
    }
}

/// The right card: the import options for this video.
fn options_card(s: &State) -> El {
    let p = pal(s.dark());
    let title = tr(s.lang, "home.opts.title");
    let card = col().key("home/options").role("group").label(title.clone()).gap(14.0).padding(24.0).w(340.0).fill(p.surface).border(1.0, p.divider).radius(10.0)
        .child(col().gap(2.0).child(text(title).font(type_::TITLE).color(p.text)).child(text(tr(s.lang, "home.opts.sub")).font(type_::LABEL).color(p.muted)));
    let Some(opts) = &s.edit_options else {
        return card.child(text(tr(s.lang, "home.opts.loading")).key("home/options/loading").role("status").font(type_::BODY).color(p.muted));
    };
    let mut music = vec![(String::new(), tr(s.lang, "home.opts.nomusic"))];
    music.extend(s.music.iter().map(|m| (m.clone(), m.clone())));
    card.child(dropdown(s, "home/option/style", &tr(s.lang, "home.opts.style"), &chosen(s, "style"), &option_choices(s.lang, "style", &opts.styles), pick("style")))
        .child(dropdown(s, "home/option/reframe", &tr(s.lang, "home.opts.reframe"), &chosen(s, "reframe"), &option_choices(s.lang, "reframe", &opts.reframe_modes), pick("reframe")))
        .child(switch(s.dark(), "home/option/silenceTrim", &tr(s.lang, "home.opts.silence"), None, flag(s, "silenceTrim"), flip("silenceTrim")))
        .child(switch(s.dark(), "home/option/youtubeCaptions", &tr(s.lang, "home.opts.captions"), Some(&tr(s.lang, "home.opts.captions.sub")), flag(s, "youtubeCaptions"), flip("youtubeCaptions")))
        .child(dropdown(s, "home/option/bgm", &tr(s.lang, "home.opts.music"), &chosen(s, "bgm"), &music, pick("bgm")))
}

fn drop_field(s: &State) -> El {
    let p = pal(s.dark());
    let label = tr(s.lang, "home.drop.title");
    col().key("home/drop").role("group").label(label.clone()).w_full().h(200.0).radius(10.0).fill(if s.home.dropping { p.raised } else { p.bg })
        .border(1.5, if s.home.dropping { p.beam } else { p.edge }).border_dash(6.0, 5.0)
        .on_drop_files(|s: &mut State, files: &[PathBuf], _: &mut Tx| s.dropped(files))
        .accepts_extensions(&VIDEO_EXTENSIONS)
        .on_drop_hover(|s: &mut State, over, _| s.home.dropping = over)
        .child(
            col().key("home/choose-file").role("button").label(label.clone()).focusable(true).w_full().h_full().gap(8.0).center().radius(10.0)
                .hover(p.text.alpha(0.04))
                .on_press_tx(|s: &mut State, tx: &mut Tx| s.choose_file(tx))
                .child(text(label).font(DISPLAY_SMALL).color(p.text))
                .child(text(tr(s.lang, "home.drop.hint")).font(type_::BODY).color(p.muted).wrap()),
        )
}

fn import_card(s: &State) -> El {
    let p = pal(s.dark());
    let n = s.home.direction.text.chars().count();
    let (link_label, dir_label) = (tr(s.lang, "home.link.label"), tr(s.lang, "home.dir.label"));
    let link_row = row().gap(12.0).items_end().w_full()
        .child(labelled(s, &link_label, input_box(s, "home/link", &link_label, &tr(s.lang, "home.link.hint"), &s.home.link, true, |s| &mut s.home.link)).grow(1.0))
        .child(centered(button(s.dark(), "home/import", &tr(s.lang, "home.import"), true, |s: &mut State| s.import_link()).px(18.0).h(41.0)));
    let counter = if n > MAX_DIRECTION { p.skip } else { p.muted };
    let direction = col().gap(6.0).w_full()
        .child(labelled(s, &dir_label, input_box(s, "home/direction", &dir_label, &tr(s.lang, "home.dir.hint"), &s.home.direction, false, |s| &mut s.home.direction)))
        .child(row().gap(12.0).w_full()
            .child(text(tr(s.lang, "home.dir.note")).font(type_::LABEL).color(p.muted).wrap().grow(1.0))
            .child(text(format!("{n}/{MAX_DIRECTION}")).key("home/direction-count").font(type_::LABEL).color(counter)));
    let mut card = col().gap(20.0).grow(1.0).shrink().child(drop_field(s)).child(link_row);
    // A problem shows right under the field that caused it, where the eye already is.
    if let Some(e) = &s.home.error {
        let (cause, next) = (e.words(s.lang), e.next(s.lang));
        card = card.child(col().key("home/error").role("alert").label(format!("{cause} {next}")).gap(2.0)
            .child(text(cause).key("home/error/cause").font(type_::BODY).color(p.skip).wrap())
            .child(text(next).key("home/error/next").font(type_::BODY).color(p.muted).wrap()));
    }
    card = card.child(direction);
    card
}

/// What a video is called: its title, else its file's name, else a placeholder.
pub fn video_name(s: &State, video_id: &str) -> String {
    let v = s.videos.iter().find(|v| v.id == video_id);
    v.and_then(|v| v.title.clone().or_else(|| v.file_path.as_deref().and_then(|p| p.rsplit(['/', '\\']).next()).map(String::from)))
        .unwrap_or_else(|| tr(s.lang, "home.untitled"))
}

fn recent_row(s: &State, j: &Job) -> El {
    let p = pal(s.dark());
    let id = j.id.clone();
    let phase = j.phase();
    let ink = match phase {
        JobPhase::Completed => p.pass,
        JobPhase::Running | JobPhase::Queued => p.beam_text,
        _ => p.skip,
    };
    let name = video_name(s, &j.video_id);
    let status = tr(s.lang, &format!("status.{}", if phase == JobPhase::Interrupted { "FAILED" } else { j.status.as_str() }));
    let open = tr(s.lang, if phase == JobPhase::Completed { "home.open" } else { "home.open.job" });
    row().key(format!("home/job/{}", j.id)).role("listitem").label(format!("{name}, {status}")).focusable(true).gap(12.0).px(16.0).py(14.0).items_center().w_full()
        .fill(p.surface).border(1.0, p.divider).radius(6.0).hover(p.text.alpha(0.04)).on_press(move |s: &mut State| s.open_job(&id))
        .child(text(name).font(type_::BODY).color(p.text).truncate().grow(1.0).shrink())
        .child(pill(format!("home/job/{}/status", j.id), &status, ink))
        .child(text(open).font(type_::LABEL).color(p.beam_text))
}

/// Jobs the last session left running, each with its Retry.
fn interrupted_block(s: &State) -> Option<El> {
    let p = pal(s.dark());
    let mut block = col().key("home/interrupted").role("list").label(tr(s.lang, "home.interrupted")).gap(12.0).w_full()
        .child(text(tr(s.lang, "home.interrupted")).font(type_::TITLE).color(p.text));
    let mut any = false;
    for j in s.jobs.iter().filter(|j| j.phase() == JobPhase::Interrupted) {
        let (id, retry_id) = (j.id.clone(), j.id.clone());
        let name = video_name(s, &j.video_id);
        any = true;
        // The row opens the job (the stage that stopped, the note) before Retry wipes it.
        block = block.child(row().key(format!("home/interrupted/{}", j.id)).role("listitem").label(name.clone()).focusable(true).gap(12.0).px(16.0).py(14.0).items_center().w_full()
            .fill(p.surface).border(1.0, p.divider).radius(6.0).hover(p.text.alpha(0.04)).on_press(move |s: &mut State| s.open_job(&id))
            .child(text(name).font(type_::BODY).color(p.text).truncate().grow(1.0).shrink())
            .child(text(tr(s.lang, "home.open.job")).font(type_::LABEL).color(p.beam_text))
            .child(button(s.dark(), format!("home/retry/{}", j.id), &tr(s.lang, "home.interrupted.retry"), true, move |s: &mut State| s.retry_interrupted(&retry_id))));
    }
    any.then_some(block)
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark());
    let head = page_head(s.dark(), "home/title", &tr(s.lang, "home.title"), &tr(s.lang, "home.sub"));
    let top = row().gap(40.0).w_full().items_start().child(import_card(s)).child(options_card(s));
    let only_interrupted = !s.jobs.is_empty() && s.jobs.iter().all(|j| j.phase() == JobPhase::Interrupted);
    let below = if only_interrupted {
        col()
    } else if s.jobs.is_empty() && s.videos.is_empty() {
        state_block::<State>(s.dark(), "home/empty", Kind::Empty, &tr(s.lang, "home.empty.cause"), &tr(s.lang, "home.empty.next"), None)
    } else {
        let mut list = col().key("home/jobs").role("list").label(tr(s.lang, "home.recent")).gap(12.0).w_full().child(text(tr(s.lang, "home.recent")).font(type_::TITLE).color(p.text));
        let mut jobs = s.jobs.iter().filter(|j| j.phase() != JobPhase::Interrupted).take(4);
        while let Some(a) = jobs.next() {
            let second = match jobs.next() {
                Some(b) => recent_row(s, b).grow(1.0),
                None => col().grow(1.0),
            };
            list = list.child(row().gap(12.0).w_full().child(recent_row(s, a).grow(1.0)).child(second));
        }
        list
    };
    col().key("home/scroll").scroll(ScrollSpec { stick_bottom: false }).gap(28.0).padding(40.0).w_full().h_full().child(head).child(top).children(interrupted_block(s)).child(below)
}
