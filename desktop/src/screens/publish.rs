//! Publish one clip through Tebar: pick accounts (one workspace per post), let the engine write
//! copy per platform (Jev checks it), make the choices only you can, then post. Posting is never
//! automatic (constitution VI): the choices start empty and `core::publish_gate` keeps Post off
//! until they are made. The accounts picked last time come back selected, a post can be refreshed
//! and its links opened, and a time to send it can be picked in date and time boxes.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use serde_json::{Map, Value, json};
use sorot_desktop_core::publish_gate::{Choices, Listed, Platform, Target, can_post, preselect};

use crate::engine::generate as api;
use crate::engine::types::{DraftTarget, PublishDraft, SocialAccount, SocialPost};
use crate::i18n::{Lang, tr, trf};
use crate::screens::panels::{Host, Load, Panels, answer, go};
use crate::ui::datetime::{DateBoxes, picker};
use crate::ui::focus;
use crate::ui::form::{Tone, area, btn, card, choice, field, heading, note, page, toggle};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

/// The engine's blocker for a clip the quality gate held back: it can be confirmed, the others cannot.
const GATE_BLOCK: &str = "Held back by the quality gate";

/// What one platform's editor holds. Empty until the person fills it.
pub struct TargetEdit {
    pub content: TextEdit,
    pub title: TextEdit,
    pub choices: Choices,
}

/// What stops or fails a post, in words the view chooses the language for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    /// The send time boxes are not a real date and time.
    Schedule,
    /// The engine's own words.
    Engine(String),
}

#[derive(Default)]
pub struct Publish {
    /// The clip's id, or the id of an exported Generate video (`generated`).
    pub clip_id: String,
    /// The subject is an exported Generate video, not a clip.
    pub generated: bool,
    pub clip_title: String,
    pub load: Load,
    /// False when Tebar is not connected.
    pub enabled: bool,
    pub accounts: Vec<SocialAccount>,
    pub selected: Vec<String>,
    pub draft: Option<PublishDraft>,
    pub edits: Vec<TargetEdit>,
    /// The platform tab open (an index into the draft's targets).
    pub tab: usize,
    pub confirmed: bool,
    pub posts: Vec<SocialPost>,
    pub busy: bool,
    pub error: Option<Problem>,
    /// Optional send time (UTC); empty posts now.
    pub schedule: DateBoxes,
}

fn platform_of(name: &str) -> Platform {
    match name {
        "tiktok" => Platform::Tiktok,
        "youtube" => Platform::Youtube,
        _ => Platform::Other,
    }
}

fn workspace(a: &SocialAccount) -> &str {
    a.profile_id.as_deref().unwrap_or("")
}

impl Publish {
    /// The workspace the selection is in; a post goes to one.
    fn active_workspace(&self) -> Option<String> {
        self.accounts.iter().find(|a| self.selected.contains(&a.id)).map(|a| workspace(a).to_string())
    }

    fn gate(&self) -> Option<&str> {
        self.draft.as_ref().and_then(|d| d.clip.gate_verdict.as_deref())
    }

    /// What `core::publish_gate` reads: each target, and what was chosen for it.
    fn rule_input(&self) -> (Vec<Target>, Vec<Choices>) {
        let Some(d) = &self.draft else { return (vec![], vec![]) };
        let targets = d.targets.iter().map(|t| Target { platform: platform_of(&t.platform), video_public_only: t.platform == "tiktok" && t.needs.tiktok_privacy.is_none() }).collect();
        let choices = self.edits.iter().map(|e| Choices { youtube_title: e.title.text.clone(), ..e.choices.clone() }).collect();
        (targets, choices)
    }

    /// A blocker the engine named that the person has not accepted, or a gate verdict awaiting a check.
    fn held(&self) -> bool {
        let Some(d) = &self.draft else { return true };
        let blocked = d.targets.iter().any(|t| t.blockers.iter().any(|b| !b.starts_with(GATE_BLOCK) || !self.confirmed));
        blocked || (self.gate() == Some("REVIEW") && !self.confirmed)
    }

    /// Post is on only when every choice is made and nothing holds the clip back.
    pub fn post_enabled(&self) -> bool {
        let (targets, choices) = self.rule_input();
        !self.busy && can_post(&targets, &choices) && !self.held()
    }

    fn body(&self) -> Value {
        let d = self.draft.as_ref().expect("a post needs a draft");
        let targets: Vec<Value> = d.targets.iter().zip(&self.edits).map(|(t, e)| {
            let mut m = Map::new();
            m.insert("accountId".into(), json!(t.account_id));
            m.insert("content".into(), json!(e.content.text));
            if t.platform == "youtube" {
                m.insert("title".into(), json!(e.title.text));
            }
            if let Some(kids) = e.choices.made_for_kids {
                m.insert("madeForKids".into(), json!(kids));
            }
            if t.platform == "tiktok" {
                m.insert("postMode".into(), json!(if e.choices.tiktok_draft_mode { "draft" } else { "direct" }));
                if let (false, Some(p)) = (e.choices.tiktok_draft_mode, &e.choices.tiktok_privacy) {
                    m.insert("privacyLevel".into(), json!(p));
                }
            }
            Value::Object(m)
        }).collect();
        let mut body = json!({ "targets": targets });
        match self.gate() {
            Some("REVIEW") => body["confirmReview"] = json!(true),
            Some("FAIL") => body["override"] = json!(true),
            _ => {}
        }
        body
    }
}

impl TargetEdit {
    fn new(t: &DraftTarget) -> Self {
        TargetEdit { content: TextEdit::new(t.content.as_str()), title: TextEdit::new(""), choices: Choices::default() }
    }
}

/// Opens the panel for a clip: its accounts and earlier posts. The accounts picked last time come
/// back selected when they are still listed and can post.
pub fn open<H: Host>(h: &mut H, clip_id: &str, clip_title: &str) {
    begin(h, clip_id, clip_title, false);
}

/// The same panel for an exported Generate video: the same choices and protections, other routes.
pub fn open_export<H: Host>(h: &mut H, export_id: &str, title: &str) {
    begin(h, export_id, title, true);
}

fn begin<H: Host>(h: &mut H, clip_id: &str, clip_title: &str, generated: bool) {
    let id = clip_id.to_string();
    let saved = h.remembered();
    h.panels_mut().publish = Publish { clip_id: id.clone(), generated, clip_title: clip_title.into(), load: Load::Loading, ..Publish::default() };
    go(h, move |e| {
        let both = e.social_accounts().and_then(|a| Ok((a, if generated { api::export_posts(e, &id)? } else { e.clip_posts(&id)? })));
        answer(both, move |p, r| {
            let s = &mut p.publish;
            s.load = Load::of(&r);
            if let Ok((a, posts)) = r {
                let listed: Vec<Listed> = a.accounts.iter().map(|x| Listed { id: &x.id, supported: x.supported, workspace: workspace(x) }).collect();
                s.selected = preselect(&saved, &listed);
                (s.enabled, s.accounts, s.posts) = (a.enabled, a.accounts, posts);
            }
        })
    });
}

pub fn select_account<H: Host>(h: &mut H, id: &str) {
    let s = &mut h.panels_mut().publish;
    if let Some(i) = s.selected.iter().position(|x| x == id) {
        s.selected.remove(i);
    } else if let Some(a) = s.accounts.iter().find(|a| a.id == id && a.supported) {
        let ok = s.active_workspace().is_none_or(|w| w == workspace(a));
        if ok {
            s.selected.push(id.to_string());
        }
    }
    let now = s.selected.clone();
    h.remember(&now);
}

pub fn write_copy<H: Host>(h: &mut H) {
    let s = &mut h.panels_mut().publish;
    (s.busy, s.error) = (true, None);
    let (id, accounts, generated) = (s.clip_id.clone(), s.selected.clone(), s.generated);
    go(h, move |e| {
        answer(if generated { api::publish_draft(e, &id, &accounts) } else { e.publish_draft(&id, &accounts) }, |p, r| {
            let s = &mut p.publish;
            s.busy = false;
            match r {
                Ok(d) => {
                    s.edits = d.targets.iter().map(TargetEdit::new).collect();
                    (s.draft, s.confirmed, s.tab) = (Some(d), false, 0);
                }
                Err(e) => s.error = Some(Problem::Engine(e)),
            }
        })
    });
}

pub fn post<H: Host>(h: &mut H) {
    if !h.panels().publish.post_enabled() {
        return;
    }
    let s = &mut h.panels_mut().publish;
    let mut body = s.body();
    if !s.schedule.is_blank() {
        match s.schedule.parse() {
            Ok(at) => body["scheduledAt"] = json!(at.iso()),
            Err(_) => return s.error = Some(Problem::Schedule),
        }
    }
    (s.busy, s.error) = (true, None);
    let (id, generated) = (s.clip_id.clone(), s.generated);
    go(h, move |e| {
        answer(if generated { api::publish(e, &id, &body) } else { e.publish(&id, &body) }, |p, r| {
            let s = &mut p.publish;
            s.busy = false;
            match r {
                Ok(post) => {
                    s.posts.insert(0, post);
                    (s.draft, s.edits) = (None, vec![]);
                }
                Err(e) => s.error = Some(Problem::Engine(e)),
            }
        })
    });
}

fn replace_post(p: &mut Panels, r: Result<SocialPost, String>) {
    let s = &mut p.publish;
    s.busy = false;
    match r {
        Ok(post) => {
            if let Some(slot) = s.posts.iter_mut().find(|x| x.id == post.id) {
                *slot = post;
            }
        }
        Err(e) => s.error = Some(Problem::Engine(e)),
    }
}

/// Asks Tebar again how the post stands.
pub fn refresh<H: Host>(h: &mut H, id: &str) {
    let id = id.to_string();
    h.panels_mut().publish.busy = true;
    go(h, move |e| answer(e.refresh_post(&id), replace_post));
}

pub fn retry<H: Host>(h: &mut H, id: &str) {
    let id = id.to_string();
    h.panels_mut().publish.busy = true;
    go(h, move |e| answer(e.retry_post(&id), replace_post));
}

pub fn cancel<H: Host>(h: &mut H, id: &str) {
    let id = id.to_string();
    h.panels_mut().publish.busy = true;
    go(h, move |e| answer(e.cancel_post(&id), replace_post));
}

/// Opens a posted video's link in the browser.
pub fn open_link<H: Host>(h: &mut H, url: &str) {
    if let Err(why) = h.open_url(url) {
        h.panels_mut().publish.error = Some(Problem::Engine(why));
    }
}

fn edit_mut<H: Host>(h: &mut H, i: usize) -> &mut TargetEdit {
    &mut h.panels_mut().publish.edits[i]
}

fn schedule_of<H: Host>(h: &mut H) -> &mut DateBoxes {
    &mut h.panels_mut().publish.schedule
}

/// A platform's display name: the translation when there is one, else the engine's word.
fn platform_name(l: Lang, platform: &str) -> String {
    let key = format!("publish.platform.{platform}");
    let t = tr(l, &key);
    if t == key { platform.to_string() } else { t }
}

fn accounts_card<H: Host>(dark: bool, l: Lang, s: &Publish) -> El {
    let p = pal(dark);
    let mut c = card(dark, "publish/accounts", &tr(l, "publish.accounts.title"));
    if !s.enabled {
        return c.child(note(dark, "publish/off", Tone::Plain, &tr(l, "publish.off")));
    }
    if s.accounts.is_empty() {
        return c.child(note(dark, "publish/no-accounts", Tone::Plain, &tr(l, "publish.no-accounts")));
    }
    let active = s.active_workspace();
    c = c.child(text(tr(l, "publish.accounts.about")).font(type_::LABEL).color(p.muted).wrap());
    for a in &s.accounts {
        let locked = active.as_deref().is_some_and(|w| w != workspace(a)) && !s.selected.contains(&a.id);
        let place = a.profile_name.as_deref().map(|n| trf(l, "publish.workspace", &[("name", n)])).unwrap_or_default();
        let mut words = format!("{} ({}{place})", a.name, platform_name(l, &a.platform));
        if !a.supported {
            words.push_str(&format!(", {}", tr(l, "publish.cannot-video")));
        }
        let id = a.id.clone();
        let mut line = toggle(dark, l, &focus::publish_account(&a.id), &words, s.selected.contains(&a.id), move |h: &mut H| select_account(h, &id));
        if !a.supported || locked {
            line = line.disabled(true);
        }
        c = c.child(line);
    }
    c.child(btn(dark, "publish/write", &tr(l, if s.draft.is_some() { "publish.rewrite" } else { "publish.write" }), false, !s.busy && !s.selected.is_empty(), write_copy::<H>))
}

fn choices_block<H: Host>(dark: bool, l: Lang, i: usize, t: &DraftTarget, e: &TargetEdit) -> El {
    let p = pal(dark);
    let k = |n: &str| focus::publish_target(i, n);
    let mut b = col().key(k("choices")).role("group").label(tr(l, "publish.choices.title")).gap(10.0).padding(16.0).w_full().fill(p.surface).border(1.0, p.beam).radius(10.0)
        .child(text(tr(l, "publish.choices.title")).font(type_::TITLE).color(p.text))
        .child(text(tr(l, "publish.choices.about")).font(type_::BODY).color(p.muted).wrap());
    if t.platform == "tiktok" {
        let mode = row().gap(8.0)
            .child(choice(dark, &k("direct"), &tr(l, "publish.tiktok.direct"), !e.choices.tiktok_draft_mode, move |h: &mut H| edit_mut(h, i).choices.tiktok_draft_mode = false))
            .child(choice(dark, &k("draft"), &tr(l, "publish.tiktok.draft"), e.choices.tiktok_draft_mode, move |h: &mut H| edit_mut(h, i).choices.tiktok_draft_mode = true));
        b = b.child(text(tr(l, "publish.tiktok.how")).font(type_::LABEL).color(p.muted)).child(mode);
        if let (Some(levels), false) = (&t.needs.tiktok_privacy, e.choices.tiktok_draft_mode) {
            let mut r = row().gap(8.0);
            for (n, level) in levels.iter().enumerate() {
                let lv = level.clone();
                r = r.child(choice(dark, &k(&format!("privacy/{n}")), level, e.choices.tiktok_privacy.as_deref() == Some(level), move |h: &mut H| edit_mut(h, i).choices.tiktok_privacy = Some(lv.clone())));
            }
            let status = tr(l, if e.choices.tiktok_privacy.is_some() { "publish.chosen" } else { "publish.privacy-unchosen" });
            b = b.child(text(tr(l, "publish.tiktok.who")).font(type_::LABEL).color(p.muted)).child(r).child(text(status).key(k("privacy-status")).font(type_::LABEL).color(p.muted).wrap());
        }
    }
    if t.platform == "youtube" {
        b = b.child(field(dark, &k("title"), &tr(l, "publish.youtube.title"), &e.title, t.title.as_deref().unwrap_or(&tr(l, "publish.youtube.title-hint")), false, edit_access(move |h: &mut H| &mut edit_mut(h, i).title)))
            .child(text(tr(l, "publish.youtube.title-rule")).font(type_::LABEL).color(p.muted).wrap());
    }
    if t.needs.made_for_kids.is_some() {
        let kids = row().gap(8.0)
            .child(choice(dark, &k("kids-no"), &tr(l, "publish.no"), e.choices.made_for_kids == Some(false), move |h: &mut H| edit_mut(h, i).choices.made_for_kids = Some(false)))
            .child(choice(dark, &k("kids-yes"), &tr(l, "publish.yes"), e.choices.made_for_kids == Some(true), move |h: &mut H| edit_mut(h, i).choices.made_for_kids = Some(true)));
        let status = tr(l, if e.choices.made_for_kids.is_some() { "publish.answered" } else { "publish.kids-unanswered" });
        b = b.child(text(tr(l, "publish.kids")).font(type_::LABEL).color(p.muted)).child(kids).child(text(status).key(k("kids-status")).font(type_::LABEL).color(p.muted).wrap());
    }
    b
}

fn target_block<H: Host>(dark: bool, l: Lang, i: usize, t: &DraftTarget, e: &TargetEdit) -> El {
    let p = pal(dark);
    let k = |n: &str| focus::publish_target(i, n);
    let by = tr(l, if t.copy_by == "llm" { "publish.by-llm" } else { "publish.by-template" });
    let mut b = col().key(k("target")).gap(12.0).w_full()
        .child(text(trf(l, "publish.copy-by", &[("by", &by)])).font(type_::LABEL).color(p.muted))
        .child(area(dark, &k("text"), &trf(l, "publish.text-for", &[("name", &t.name)]), &e.content, edit_access(move |h: &mut H| &mut edit_mut(h, i).content)))
        .child(text(trf(l, "publish.count", &[("n", &e.content.text.chars().count().to_string())])).key(k("count")).font(type_::LABEL).color(p.muted).wrap());
    for (n, w) in t.warnings.iter().enumerate() {
        b = b.child(note(dark, &k(&format!("warning/{n}")), Tone::Plain, &trf(l, "publish.note", &[("w", w)])));
    }
    for (n, w) in t.blockers.iter().filter(|b| !b.starts_with(GATE_BLOCK)).enumerate() {
        b = b.child(note(dark, &k(&format!("blocker/{n}")), Tone::Bad, &trf(l, "publish.blocker", &[("w", w)])));
    }
    b.child(choices_block::<H>(dark, l, i, t, e))
}

fn draft_view<H: Host>(dark: bool, l: Lang, s: &Publish, d: &PublishDraft) -> El {
    let p = pal(dark);
    let mut c = col().gap(16.0).w_full();
    if let Some(by) = &d.copy_checked_by {
        c = c.child(text(trf(l, "publish.checked-by", &[("by", by)])).key("publish/checked").font(type_::BODY).color(p.muted));
    }
    let mut tabs = row().gap(8.0);
    for (i, t) in d.targets.iter().enumerate() {
        tabs = tabs.child(choice(dark, &focus::publish_tab(i), &platform_name(l, &t.platform), s.tab == i, move |h: &mut H| h.panels_mut().publish.tab = i));
    }
    c = c.child(tabs);
    let at = s.tab.min(d.targets.len().saturating_sub(1));
    if let (Some(t), Some(e)) = (d.targets.get(at), s.edits.get(at)) {
        c = c.child(target_block::<H>(dark, l, at, t, e));
    }
    if let Some(v @ ("REVIEW" | "FAIL")) = s.gate() {
        let lead = tr(l, if v == "FAIL" { "publish.gate.fail" } else { "publish.gate.review" });
        let why = if d.clip.gate_reasons.is_empty() { tr(l, "conn.no-reason") } else { d.clip.gate_reasons.join("; ") };
        c = c.child(toggle(dark, l, "publish/confirm", &format!("{lead}. {why}"), s.confirmed, |h: &mut H| {
            let s = &mut h.panels_mut().publish;
            s.confirmed = !s.confirmed;
        }));
    }
    let hint = tr(l, if s.post_enabled() { "publish.ready" } else { "publish.stays-off" });
    let label = tr(l, if s.schedule.is_blank() { "publish.post" } else { "publish.schedule" });
    c.child(picker::<H>(dark, l, "publish/schedule", &tr(l, "publish.schedule-label"), &s.schedule, schedule_of::<H>))
        .child(btn(dark, "publish/post", &label, true, s.post_enabled(), post::<H>)).child(text(hint).key("publish/post-hint").font(type_::LABEL).color(p.muted).wrap())
}

fn post_row<H: Host>(dark: bool, l: Lang, post: &SocialPost, busy: bool) -> El {
    let p = pal(dark);
    let k = |n: &str| focus::publish_post(&post.id, n);
    let when = post.scheduled_at.as_deref().map(|w| trf(l, "publish.scheduled", &[("at", w)])).unwrap_or_default();
    let head = format!("{}{when}", post.status);
    let mut r = col().key(k("row")).role("listitem").label(head.as_str()).gap(4.0).padding(10.0).w_full().fill(p.raised).radius(6.0)
        .child(text(head).font(type_::TITLE).color(p.text));
    let targets: Vec<Value> = post.targets.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
    for (n, t) in targets.iter().enumerate() {
        let line = format!("{}: {}{}", t["platform"].as_str().unwrap_or("account"), t["status"].as_str().unwrap_or("unknown"), t["errorCode"].as_str().map(|c| format!(" ({c})")).unwrap_or_default());
        let mut item = row().gap(8.0).items_center().child(text(line).key(k(&format!("target/{n}"))).font(type_::BODY).color(p.muted).wrap());
        if let Some(url) = t["permalink"].as_str().filter(|u| !u.is_empty()) {
            let url = url.to_string();
            item = item.child(btn(dark, k(&format!("target/{n}/open")), &tr(l, "publish.open"), false, true, move |h: &mut H| open_link(h, &url)));
        }
        r = r.child(item);
    }
    if let Some(why) = &post.error_message {
        r = r.child(note(dark, &k("error"), Tone::Bad, why));
    }
    let id = post.id.clone();
    let mut actions = row().gap(8.0).child({
        let id = id.clone();
        btn(dark, k("refresh"), &tr(l, "publish.refresh"), false, !busy, move |h: &mut H| refresh(h, &id))
    });
    if matches!(post.status.as_str(), "FAILED" | "PARTIAL") {
        let id = id.clone();
        actions = actions.child(btn(dark, k("retry"), &tr(l, "publish.retry"), false, !busy, move |h: &mut H| retry(h, &id)));
    }
    if post.status == "SCHEDULED" {
        actions = actions.child(btn(dark, k("cancel"), &tr(l, "publish.cancel"), false, !busy, move |h: &mut H| cancel(h, &id)));
    }
    r.child(actions)
}

fn problem_words(l: Lang, p: &Problem) -> String {
    match p {
        Problem::Schedule => tr(l, "publish.schedule-invalid"),
        Problem::Engine(why) => trf(l, "publish.error-next", &[("why", why)]),
    }
}

pub fn view<H: Host>(h: &H) -> El {
    let (dark, l) = (h.dark(), h.lang());
    let s = &h.panels().publish;
    let p = pal(dark);
    let name = if s.clip_title.is_empty() { tr(l, "publish.this-clip") } else { s.clip_title.clone() };
    let head = heading(dark, "publish/title", &trf(l, "publish.title", &[("clip", &name)]), &tr(l, "publish.sub"));
    let body = match &s.load {
        Load::Failed(why) => return page().child(head)
            .child(state_block::<H>(dark, "publish/failed", Kind::Error, &tr(l, "publish.read-failed"), &trf(l, "publish.close-reopen", &[("why", why)]), None)),
        Load::Ready => {
            let mut main = col().gap(16.0).grow(1.0);
            if let Some(d) = &s.draft {
                main = main.child(draft_view::<H>(dark, l, s, d));
            }
            if let Some(why) = &s.error {
                main = main.child(note(dark, "publish/error", Tone::Bad, &problem_words(l, why)));
            }
            let mut posts = card(dark, "publish/posts", &tr(l, "publish.posts.title"));
            if s.posts.is_empty() {
                posts = posts.child(text(tr(l, "publish.posts.empty")).key("publish/posts/empty").font(type_::BODY).color(p.muted).wrap());
            }
            for post in &s.posts {
                posts = posts.child(post_row::<H>(dark, l, post, s.busy));
            }
            let generated = card(dark, "publish/generated", &tr(l, "publish.generated.title"))
                .child(text(tr(l, "publish.generated.soon")).key("publish/generated/soon").font(type_::BODY).color(p.muted).wrap());
            let side = col().gap(16.0).w(360.0).child(accounts_card::<H>(dark, l, s)).child(posts).child(generated);
            row().gap(24.0).w_full().child(main).child(side)
        }
        _ => state_block::<H>(dark, "publish/loading", Kind::Loading, &tr(l, "publish.reading"), &tr(l, "state.moment"), None),
    };
    page().child(head).child(body)
}
