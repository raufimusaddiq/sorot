//! Building a draft from the approved plan (`BuildPanel.tsx`, `DirectorLog.tsx`): start it with a
//! time estimate, follow its progress beside the director's notes, cancel it, or continue a failed
//! one from its failed step. Reading the result, fixing, accepting and exporting are the verdict
//! step (`verdict.rs`). Nothing posts.

use rune::tok::type_;
use rune::{El, TextEdit, col, row, text};

use crate::engine::EngineError;
use crate::engine::generate as api;
use crate::engine::generate::{Detail, Event, Version};
use crate::screens::generate::Studio;
use crate::screens::generate::act;
use crate::screens::generate::{t, tf};
use crate::screens::panels::{Host, Panels, answer, go};
use crate::ui::form::{Tone, btn, card, note};
use crate::ui::kit::pal;

const STEP_KEYS: [&str; 5] = ["author", "check", "render", "technical", "creative"];

pub struct Panel {
    /// A note for a fix.
    pub note: TextEdit,
    pub events: Option<Vec<Event>>,
    pub log_error: Option<String>,
    /// The log entry opened to its request and answer.
    pub expanded: Option<String>,
    /// The shot a fix note is about; `None` is any.
    pub shot: Option<String>,
}

impl Default for Panel {
    fn default() -> Self {
        Panel { note: TextEdit::new(""), events: None, log_error: None, expanded: None, shot: None }
    }
}

/// "about 30 s" or "about 10 min".
pub fn about(sec: u64) -> String {
    if sec < 90 { tf("about.secs", &[&sec.to_string()]) } else { tf("about.mins", &[&((sec as f64 / 60.0).round() as u64).to_string()]) }
}

pub fn start<H: Host>(h: &mut H) {
    act(h, |e, id| api::build(e, id).map(|()| None));
}

fn on_version<H: Host>(h: &mut H, version_id: &str, action: &'static str) {
    let vid = version_id.to_string();
    act(h, move |e, _| {
        api::version_action(e, &vid, action).map_err(|err| match (action, err) {
            ("retry", EngineError::Api { status: 409, .. }) => EngineError::Api { status: 409, message: t("build.plan_changed") },
            (_, other) => other,
        })?;
        Ok(None)
    });
}

pub fn cancel<H: Host>(h: &mut H, version_id: &str) {
    on_version(h, version_id, "cancel");
}

pub fn retry<H: Host>(h: &mut H, version_id: &str) {
    on_version(h, version_id, "retry");
}

pub fn accept<H: Host>(h: &mut H, version_id: &str) {
    on_version(h, version_id, "accept");
}

/// Asks the director to fix findings (none = every must-fix) or to change what the note says.
pub fn fix<H: Host>(h: &mut H, version_id: &str, findings: Vec<String>, with_note: bool) {
    let vid = version_id.to_string();
    let b = &mut h.panels_mut().studio.build;
    let (note, shot) = if with_note { (std::mem::replace(&mut b.note, TextEdit::new("")).text.trim().to_string(), b.shot.clone()) } else { (String::new(), None) };
    act(h, move |e, _| {
        let r = api::fix(e, &vid, &findings, &note, shot.as_deref())?;
        Ok(Some(if r.needs_approval { tf("verdict.needs_approval", &[&r.summary]) } else { r.summary }))
    });
}

pub fn export<H: Host>(h: &mut H, version_id: &str) {
    let vid = version_id.to_string();
    act(h, move |e, _| api::export_version(e, &vid).map(|_| None));
}

fn logged(p: &mut Panels, r: Result<Vec<Event>, String>) {
    match r {
        Ok(list) => (p.studio.build.events, p.studio.build.log_error) = (Some(list), None),
        Err(why) => p.studio.build.log_error = Some(why),
    }
}

/// Reads the director's log of the open video.
pub fn load_log<H: Host>(h: &mut H) {
    let Some(id) = h.panels().studio.selected.clone() else { return };
    go(h, move |e| answer(api::events(e, &id), logged));
}

fn open_event<H: Host>(h: &mut H, id: &str) {
    let b = &mut h.panels_mut().studio.build;
    b.expanded = if b.expanded.as_deref() == Some(id) { None } else { Some(id.to_string()) };
}

fn step_words(v: &Version) -> String {
    if v.status == "QUEUED" {
        return t("build.queued");
    }
    match v.step.as_deref().filter(|k| STEP_KEYS.contains(k)) {
        Some(k) => t(&format!("build.{k}")),
        None => t("build.building"),
    }
}

/// The director's local log, newest first.
fn log_card<H: Host>(dark: bool, s: &Studio) -> El {
    let p = pal(dark);
    let b = &s.build;
    let mut c = card(dark, "generate/log", &t("build.log"));
    if let Some(why) = &b.log_error {
        c = c.child(note(dark, "generate/log/error", Tone::Bad, why));
    }
    match &b.events {
        Some(list) if list.is_empty() => c = c.child(text(t("build.log.empty")).key("generate/log/empty").font(type_::LABEL).color(p.muted)),
        Some(list) => {
            for ev in list {
                let secs = ev.ms.map(|m| format!(" · {:.1} s", m / 1000.0)).unwrap_or_default();
                let model = ev.model.as_ref().map(|m| format!(" · {m}")).unwrap_or_default();
                let line = format!("{} · {}{secs}{model}", ev.kind, t(if ev.ok == 1 { "build.log.ok" } else { "build.log.failed" }));
                let id = ev.id.clone();
                let mut entry = col().key(format!("generate/log/{}", ev.id)).role("listitem").label(line.as_str()).gap(4.0).w_full().child(
                    row().key(format!("generate/log/{}/open", ev.id)).role("button").label(line.as_str()).focusable(true).on_press(move |h: &mut H| open_event(h, &id))
                        .child(text(line).font(type_::LABEL).color(p.text).wrap()),
                );
                if b.expanded.as_deref() == Some(ev.id.as_str()) {
                    for part in [&ev.request, &ev.response].into_iter().flatten() {
                        entry = entry.child(text(part.as_str()).font(type_::LABEL).color(p.muted).wrap());
                    }
                }
                c = c.child(entry);
            }
        }
        None => {}
    }
    c
}

pub fn view<H: Host>(dark: bool, s: &Studio, d: &Detail) -> El {
    let p = pal(dark);
    let version = d.versions.first();
    let working = version.is_some_and(|v| v.working());
    let approved = d.approved();
    let est = s.estimate.as_ref().map(|e| format!(" ({})", about(e.draft_sec))).unwrap_or_default();
    let start_label = format!("{}{est}", t(if version.is_some() { "build.again" } else { "build.start" }));
    let mut side = card(dark, "generate/build", &t("step.build"));
    match version {
        Some(v) if working => {
            let vid = v.id.clone();
            let pct = v.progress.unwrap_or(0.0).round().to_string();
            side = side
                .child(text(tf("build.progress", &[&step_words(v), &pct])).key("generate/build/progress").role("status").font(type_::BODY).color(p.text).wrap())
                .child(btn(dark, "generate/build/cancel", &t("build.cancel"), false, !s.busy, move |h: &mut H| cancel(h, &vid)));
        }
        Some(v) if v.status == "FAILED" => {
            let vid = v.id.clone();
            let why = v.error_message.clone().unwrap_or_default();
            side = side
                .child(note(dark, "generate/build/failed", Tone::Bad, &format!("{} {why}", t("build.failed.panel"))))
                .child(btn(dark, "generate/build/continue", &t("build.continue"), true, !s.busy, move |h: &mut H| retry(h, &vid)))
                .child(btn(dark, "generate/build/start", &start_label, false, approved && !s.busy, start::<H>));
        }
        _ => {
            side = side.child(btn(dark, "generate/build/start", &start_label, true, approved && !s.busy && !d.project.working(), start::<H>));
            if !approved {
                side = side.child(text(t("build.gate")).key("generate/build/gate").font(type_::LABEL).color(p.muted).wrap());
            }
            if version.is_some_and(|v| v.status == "CANCELLED") {
                side = side.child(text(t("build.cancelled")).font(type_::BODY).color(p.muted));
            }
        }
    }
    row().gap(20.0).w_full().child(col().grow(1.0).child(log_card::<H>(dark, s))).child(col().w(340.0).child(side))
}
