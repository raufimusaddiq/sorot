//! Home: bring a video in (drop a file, choose one, paste a link), say what the clips should be
//! about, and see the jobs already made.

use std::path::{Path, PathBuf};

use rune::tok::type_;
use rune::{El, FileDialogOptions, TextEdit, Tx, col, edit_access, row, text, text_input};
use sorot_desktop_core::clips::Options;

use crate::app::{Cmd, State};
use crate::engine::{EngineError, ImportRequest, Source};
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
    pub fn words(&self) -> String {
        match self {
            HomeError::Direction(n) => format!("The direction is {n} characters; the limit is {MAX_DIRECTION}."),
            HomeError::Link => "Paste a link that starts with http:// or https://.".into(),
            HomeError::File(name) => format!("{name} is not a video Sorot can read (mp4, mov, mkv or webm)."),
            HomeError::Engine(e) => e.to_string(),
        }
    }

    pub fn next(&self) -> &'static str {
        match self {
            HomeError::Direction(_) => "Shorten it, then import again.",
            HomeError::Link => "Copy the video's address from the browser and paste it here.",
            HomeError::File(_) => "Drop another file, or paste a link.",
            HomeError::Engine(EngineError::DiskFull { .. }) => "Free some space on the drive that holds the data folder, then import again.",
            HomeError::Engine(_) => "Check the engine, then import again.",
        }
    }
}

pub struct Home {
    pub link: TextEdit,
    pub direction: TextEdit,
    /// The import options sheet is open.
    pub sheet: bool,
    /// Options the sheet changed from the engine's defaults.
    pub options: Options,
    pub error: Option<HomeError>,
    /// A drag of files is over the drop field.
    pub dropping: bool,
}

impl Default for Home {
    fn default() -> Self {
        Home { link: TextEdit::new(""), direction: TextEdit::new(""), sheet: false, options: Options::new(), error: None, dropping: false }
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

    pub fn toggle_option(&mut self, key: &str, value: serde_json::Value) {
        if self.home.options.get(key) == Some(&value) {
            self.home.options.remove(key);
        } else {
            self.home.options.insert(key.to_string(), value);
        }
    }
}

fn field(s: &State, key: &str, label: &str, placeholder: &str, edit: &TextEdit, access: fn(&mut State) -> &mut TextEdit) -> El {
    let p = pal(s.dark);
    text_input(edit, type_::BODY).single_line().key(key).label(label).color(p.text).placeholder(placeholder, p.muted)
        .on_edit(edit_access(access)).w_full().padding(10.0).fill(p.surface).border(1.0, p.divider).radius(6.0)
}

fn sheet(s: &State) -> El {
    let p = pal(s.dark);
    let defaults = s.edit_options.as_ref().map(|o| o.defaults.clone()).unwrap_or_default();
    let chosen = |name: &str, default: &str| s.home.options.get(name).and_then(|v| v.as_str()).or_else(|| defaults.get(name).and_then(|v| v.as_str())).unwrap_or(default).to_string();
    let mut panel = col().key("home/options-sheet").role("group").label("Import options").gap(12.0).padding(16.0).w_full().fill(p.surface).border(1.0, p.divider).radius(10.0);
    let Some(opts) = &s.edit_options else {
        return panel.child(text("Loading the options").font(type_::BODY).color(p.muted));
    };
    for (name, title, values) in [("style", "Caption style", &opts.styles), ("reframe", "Framing", &opts.reframe_modes)] {
        let now = chosen(name, "");
        let mut line = row().gap(8.0).items_center().child(text(title).font(type_::LABEL).color(p.muted).w(110.0));
        for v in values {
            let value = serde_json::Value::from(v.as_str());
            line = line.child(button(s.dark, format!("home/option/{name}/{v}"), v, now == *v, move |s: &mut State| s.toggle_option(name, value.clone())));
        }
        panel = panel.child(line);
    }
    let trim = s.home.options.get("silenceTrim").and_then(|v| v.as_bool()).or_else(|| defaults.get("silenceTrim").and_then(|v| v.as_bool())).unwrap_or(false);
    panel = panel.child(button(s.dark, "home/option/silenceTrim", if trim { "Cut silences: on" } else { "Cut silences: off" }, trim, move |s: &mut State| s.toggle_option("silenceTrim", serde_json::Value::Bool(!trim))));
    if !s.music.is_empty() {
        let mut line = row().gap(8.0).items_center().child(text("Music").font(type_::LABEL).color(p.muted).w(110.0));
        let now = s.home.options.get("bgm").and_then(|v| v.as_str()).unwrap_or("").to_string();
        for track in &s.music {
            let value = serde_json::Value::from(track.as_str());
            line = line.child(button(s.dark, format!("home/option/bgm/{track}"), track, now == *track, move |s: &mut State| s.toggle_option("bgm", value.clone())));
        }
        panel = panel.child(line);
    }
    panel
}

fn import_card(s: &State) -> El {
    let p = pal(s.dark);
    let n = s.home.direction.text.chars().count();
    let drop = col().key("home/drop").role("group").label("Drop a video here").gap(10.0).padding(24.0).items_center().w_full()
        .fill(if s.home.dropping { p.raised } else { p.surface }).border(1.0, if s.home.dropping { p.beam } else { p.divider }).radius(10.0)
        .on_drop_files(|s: &mut State, files: &[PathBuf], _: &mut Tx| s.dropped(files))
        .accepts_extensions(&VIDEO_EXTENSIONS)
        .on_drop_hover(|s: &mut State, over, _| s.home.dropping = over)
        .child(text("Drop a video here").font(type_::TITLE).color(p.text))
        .child(text("mp4, mov, mkv or webm").font(type_::LABEL).color(p.muted))
        .child({
            let options = FileDialogOptions { title: "Choose a video".into(), ..Default::default() }.filter("Video", &VIDEO_EXTENSIONS);
            col().key("home/choose-file").role("button").label("Choose file").focusable(true).padding(10.0).radius(6.0).fill(p.raised).border(1.0, p.divider)
                .on_press_tx(move |_: &mut State, tx: &mut Tx| {
                    tx.open_file(options.clone(), |s: &mut State, picked, _| match picked {
                        Ok(Some(path)) => s.import(Source::File(path)),
                        Ok(None) => {}
                        Err(e) => s.home.error = Some(HomeError::Engine(EngineError::Network(e.to_string()))),
                    });
                })
                .child(text("Choose file").font(type_::LABEL).color(p.text))
        });
    let link = row().gap(10.0).items_center().w_full()
        .child(field(s, "home/link", "Video link", "Or paste a link", &s.home.link, |s| &mut s.home.link).grow(1.0))
        .child(button(s.dark, "home/import", "Import link", true, |s: &mut State| s.import_link()));
    let counter = if n > MAX_DIRECTION { p.skip } else { p.muted };
    let direction = col().gap(6.0).w_full()
        .child(field(s, "home/direction", "Direction", "What should the clips be about? (optional)", &s.home.direction, |s| &mut s.home.direction))
        .child(text(format!("{n}/{MAX_DIRECTION}")).key("home/direction-count").font(type_::LABEL).color(counter));
    let toggle = button(s.dark, "home/options-toggle", if s.home.sheet { "Hide import options" } else { "Import options" }, false, |s: &mut State| s.toggle_sheet());
    let mut card = col().gap(14.0).w_full().max_w(760.0).child(drop).child(link).child(direction).child(toggle);
    if s.home.sheet {
        card = card.child(sheet(s));
    }
    if let Some(e) = &s.home.error {
        card = card.child(col().key("home/error").role("alert").label(format!("{} {}", e.words(), e.next())).gap(2.0)
            .child(text(e.words()).key("home/error/cause").font(type_::BODY).color(p.skip).wrap())
            .child(text(e.next()).key("home/error/next").font(type_::BODY).color(p.muted).wrap()));
    }
    card
}

impl State {
    pub fn toggle_sheet(&mut self) {
        self.home.sheet = !self.home.sheet;
        if self.home.sheet && self.edit_options.is_none() {
            self.send(Cmd::LoadOptions);
        }
    }
}

pub fn view(s: &State) -> El {
    let p = pal(s.dark);
    let below = if s.jobs.is_empty() && s.videos.is_empty() {
        state_block::<State>(s.dark, "home/empty", Kind::Empty, "No videos yet", "Paste a link or choose a file to make your first clips.", None)
    } else {
        let mut list = col().key("home/jobs").role("list").label("Jobs").gap(6.0).w_full().max_w(760.0);
        for j in &s.jobs {
            let id = j.id.clone();
            let stage = j.current_stage.clone().unwrap_or_default();
            list = list.child(
                row().key(format!("home/job/{}", j.id)).role("listitem").label(format!("{} {}", j.status, stage)).focusable(true).gap(8.0).padding(10.0).w_full()
                    .fill(p.surface).border(1.0, p.divider).radius(8.0).on_press(move |s: &mut State| s.open_job(&id))
                    .child(text(&j.status).font(type_::LABEL).color(p.text)).child(text(stage).font(type_::BODY).color(p.muted)),
            );
        }
        list
    };
    col().gap(24.0).padding(24.0).w_full().h_full().items_center().child(import_card(s)).child(below)
}
