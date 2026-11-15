//! Publish one clip through Tebar: pick accounts (one workspace per post), let the engine write
//! copy per platform (Jev checks it), make the choices only you can, then post. Posting is never
//! automatic (constitution VI): the choices start empty and `core::publish_gate` keeps Post off
//! until they are made.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};
use serde_json::{Map, Value, json};
use sorot_desktop_core::publish_gate::{Choices, Platform, Target, can_post};

use crate::engine::types::{DraftTarget, PublishDraft, SocialAccount, SocialPost};
use crate::screens::panels::{Host, Load, Panels, answer, go};
use crate::ui::form::{Tone, area, btn, card, choice, field, heading, note, toggle};
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

#[derive(Default)]
pub struct Publish {
    pub clip_id: String,
    pub clip_title: String,
    pub load: Load,
    /// False when Tebar is not connected.
    pub enabled: bool,
    pub accounts: Vec<SocialAccount>,
    pub selected: Vec<String>,
    pub draft: Option<PublishDraft>,
    pub edits: Vec<TargetEdit>,
    pub confirmed: bool,
    pub posts: Vec<SocialPost>,
    pub busy: bool,
    pub error: Option<String>,
    /// Optional send time (UTC, like 2026-11-14 19:00); empty posts now.
    pub schedule: TextEdit,
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

/// Opens the panel for a clip: its accounts and earlier posts.
pub fn open<H: Host>(h: &mut H, clip_id: &str, clip_title: &str) {
    let id = clip_id.to_string();
    h.panels_mut().publish = Publish { clip_id: id.clone(), clip_title: clip_title.into(), load: Load::Loading, ..Publish::default() };
    go(h, move |e| {
        let both = e.social_accounts().and_then(|a| Ok((a, e.clip_posts(&id)?)));
        answer(both, |p, r| {
            let s = &mut p.publish;
            s.load = Load::of(&r);
            if let Ok((a, posts)) = r {
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
}

pub fn write_copy<H: Host>(h: &mut H) {
    let s = &mut h.panels_mut().publish;
    (s.busy, s.error) = (true, None);
    let (id, accounts) = (s.clip_id.clone(), s.selected.clone());
    go(h, move |e| {
        answer(e.publish_draft(&id, &accounts), |p, r| {
            let s = &mut p.publish;
            s.busy = false;
            match r {
                Ok(d) => {
                    s.edits = d.targets.iter().map(TargetEdit::new).collect();
                    (s.draft, s.confirmed) = (Some(d), false);
                }
                Err(e) => s.error = Some(e),
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
    if !s.schedule.text.trim().is_empty() {
        match crate::screens::feedback::iso_utc(&s.schedule.text) {
            Some(at) => body["scheduledAt"] = serde_json::json!(at),
            None => return s.error = Some("Write the schedule as 2026-11-14 19:00 (UTC), or leave it empty to post now.".into()),
        }
    }
    (s.busy, s.error) = (true, None);
    let id = s.clip_id.clone();
    go(h, move |e| {
        answer(e.publish(&id, &body), |p, r| {
            let s = &mut p.publish;
            s.busy = false;
            match r {
                Ok(post) => {
                    s.posts.insert(0, post);
                    (s.draft, s.edits) = (None, vec![]);
                }
                Err(e) => s.error = Some(e),
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
        Err(e) => s.error = Some(e),
    }
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

fn edit_mut<H: Host>(h: &mut H, i: usize) -> &mut TargetEdit {
    &mut h.panels_mut().publish.edits[i]
}

fn accounts_card<H: Host>(dark: bool, s: &Publish) -> El {
    let p = pal(dark);
    let mut c = card(dark, "publish/accounts", "Connected accounts");
    if !s.enabled {
        return c.child(note(dark, "publish/off", Tone::Plain, "Tebar is not connected. Connect it in Settings, Connections, or download the clip and post it yourself."));
    }
    if s.accounts.is_empty() {
        return c.child(note(dark, "publish/no-accounts", Tone::Plain, "No accounts yet. Connect TikTok, Instagram or YouTube at tebar.app, then open this again."));
    }
    let active = s.active_workspace();
    c = c.child(text("A post goes to one Tebar workspace. Once you pick an account, the others in other workspaces are off.").font(type_::LABEL).color(p.muted).wrap());
    for a in &s.accounts {
        let locked = active.as_deref().is_some_and(|w| w != workspace(a)) && !s.selected.contains(&a.id);
        let place = a.profile_name.as_deref().map(|n| format!(", workspace {n}")).unwrap_or_default();
        let words = format!("{} ({}{place}){}", a.name, a.platform, if a.supported { "" } else { ", cannot post a video here" });
        let id = a.id.clone();
        let mut line = toggle(dark, &format!("publish/account/{}", a.id), &words, s.selected.contains(&a.id), move |h: &mut H| select_account(h, &id));
        if !a.supported || locked {
            line = line.disabled(true);
        }
        c = c.child(line);
    }
    c.child(btn(dark, "publish/write", if s.draft.is_some() { "Rewrite the copy" } else { "Write the copy" }, false, !s.busy && !s.selected.is_empty(), write_copy::<H>))
}

fn choices_block<H: Host>(dark: bool, i: usize, t: &DraftTarget, e: &TargetEdit) -> El {
    let p = pal(dark);
    let k = |n: &str| format!("publish/{i}/{n}");
    let mut b = col().key(k("choices")).role("group").label("Your choices").gap(10.0).padding(16.0).w_full().fill(p.surface).border(1.0, p.beam).radius(10.0)
        .child(text("Your choices").font(type_::TITLE).color(p.text))
        .child(text("These stay empty until you fill them. Sorot picks nothing for you.").font(type_::BODY).color(p.muted).wrap());
    if t.platform == "tiktok" {
        let mode = row().gap(8.0)
            .child(choice(dark, &k("direct"), "Post directly", !e.choices.tiktok_draft_mode, move |h: &mut H| edit_mut(h, i).choices.tiktok_draft_mode = false))
            .child(choice(dark, &k("draft"), "Send as a draft to the TikTok app", e.choices.tiktok_draft_mode, move |h: &mut H| edit_mut(h, i).choices.tiktok_draft_mode = true));
        b = b.child(text("How to send it to TikTok").font(type_::LABEL).color(p.muted)).child(mode);
        if let (Some(levels), false) = (&t.needs.tiktok_privacy, e.choices.tiktok_draft_mode) {
            let mut r = row().gap(8.0);
            for (n, level) in levels.iter().enumerate() {
                let l = level.clone();
                r = r.child(choice(dark, &k(&format!("privacy/{n}")), level, e.choices.tiktok_privacy.as_deref() == Some(level), move |h: &mut H| edit_mut(h, i).choices.tiktok_privacy = Some(l.clone())));
            }
            let status = if e.choices.tiktok_privacy.is_some() { "Chosen." } else { "Not chosen yet: pick who can see it, or send it as a draft." };
            b = b.child(text("Who can see it on TikTok").font(type_::LABEL).color(p.muted)).child(r).child(text(status).key(k("privacy-status")).font(type_::LABEL).color(p.muted).wrap());
        }
    }
    if t.platform == "youtube" {
        b = b.child(field(dark, &k("title"), "YouTube title (required, 100 characters at most)", &e.title, t.title.as_deref().unwrap_or("Write a title"), false, edit_access(move |h: &mut H| &mut edit_mut(h, i).title)));
    }
    if t.needs.made_for_kids.is_some() {
        let kids = row().gap(8.0)
            .child(choice(dark, &k("kids-no"), "No", e.choices.made_for_kids == Some(false), move |h: &mut H| edit_mut(h, i).choices.made_for_kids = Some(false)))
            .child(choice(dark, &k("kids-yes"), "Yes", e.choices.made_for_kids == Some(true), move |h: &mut H| edit_mut(h, i).choices.made_for_kids = Some(true)));
        let status = if e.choices.made_for_kids.is_some() { "Answered." } else { "Not answered yet: YouTube asks this for every upload." };
        b = b.child(text("Made for kids (YouTube)").font(type_::LABEL).color(p.muted)).child(kids).child(text(status).key(k("kids-status")).font(type_::LABEL).color(p.muted).wrap());
    }
    b
}

fn target_block<H: Host>(dark: bool, i: usize, t: &DraftTarget, e: &TargetEdit) -> El {
    let p = pal(dark);
    let k = |n: &str| format!("publish/{i}/{n}");
    let by = if t.copy_by == "llm" { "the LLM" } else { "a template" };
    let mut b = card(dark, &k("target"), &format!("{} ({})", t.name, t.platform))
        .child(text(format!("Copy by {by}.")).font(type_::LABEL).color(p.muted))
        .child(area(dark, &k("text"), &format!("Post text for {}", t.name), &e.content, edit_access(move |h: &mut H| &mut edit_mut(h, i).content)))
        .child(text(format!("{} characters. The engine cuts anything over the platform limit.", e.content.text.chars().count())).key(k("count")).font(type_::LABEL).color(p.muted).wrap());
    for (n, w) in t.warnings.iter().enumerate() {
        b = b.child(note(dark, &k(&format!("warning/{n}")), Tone::Plain, &format!("Note: {w}")));
    }
    for (n, w) in t.blockers.iter().filter(|b| !b.starts_with(GATE_BLOCK)).enumerate() {
        b = b.child(note(dark, &k(&format!("blocker/{n}")), Tone::Bad, &format!("Cannot post: {w}")));
    }
    b.child(choices_block::<H>(dark, i, t, e))
}

fn draft_view<H: Host>(dark: bool, s: &Publish, d: &PublishDraft) -> El {
    let p = pal(dark);
    let mut c = col().gap(16.0).w_full();
    if let Some(by) = &d.copy_checked_by {
        c = c.child(text(format!("Copy checked by {by}.")).key("publish/checked").font(type_::BODY).color(p.muted));
    }
    for (i, (t, e)) in d.targets.iter().zip(&s.edits).enumerate() {
        c = c.child(target_block::<H>(dark, i, t, e));
    }
    if let Some(v @ ("REVIEW" | "FAIL")) = s.gate() {
        let lead = if v == "FAIL" { "Post anyway: the quality gate held this clip back" } else { "I checked it: the quality gate asks for a review" };
        let why = if d.clip.gate_reasons.is_empty() { "no reason given".to_string() } else { d.clip.gate_reasons.join("; ") };
        c = c.child(toggle(dark, "publish/confirm", &format!("{lead}. {why}"), s.confirmed, |h: &mut H| {
            let s = &mut h.panels_mut().publish;
            s.confirmed = !s.confirmed;
        }));
    }
    let hint = if s.post_enabled() { "Ready. Nothing is sent until you press Post." } else { "Post stays off until every choice above is made." };
    let label = if s.schedule.text.trim().is_empty() { "Post" } else { "Schedule" };
    c.child(field(dark, "publish/schedule", "Schedule (optional, UTC, like 2026-11-14 19:00)", &s.schedule, "Empty posts now", false, edit_access(|h: &mut H| &mut h.panels_mut().publish.schedule)))
        .child(btn(dark, "publish/post", label, true, s.post_enabled(), post::<H>)).child(text(hint).key("publish/post-hint").font(type_::LABEL).color(p.muted).wrap())
}

fn post_row<H: Host>(dark: bool, post: &SocialPost, busy: bool) -> El {
    let p = pal(dark);
    let k = |n: &str| format!("publish/post/{}/{n}", post.id);
    let when = post.scheduled_at.as_deref().map(|w| format!(", scheduled {w}")).unwrap_or_default();
    let mut r = col().key(k("row")).role("listitem").label(format!("{}{when}", post.status)).gap(4.0).padding(10.0).w_full().fill(p.raised).radius(6.0)
        .child(text(format!("{}{when}", post.status)).font(type_::TITLE).color(p.text));
    let targets: Vec<Value> = post.targets.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
    for (n, t) in targets.iter().enumerate() {
        let line = format!("{}: {}{}", t["platform"].as_str().unwrap_or("account"), t["status"].as_str().unwrap_or("unknown"), t["errorCode"].as_str().map(|c| format!(" ({c})")).unwrap_or_default());
        r = r.child(text(line).key(k(&format!("target/{n}"))).font(type_::BODY).color(p.muted).wrap());
    }
    if let Some(why) = &post.error_message {
        r = r.child(note(dark, &k("error"), Tone::Bad, why));
    }
    let id = post.id.clone();
    let mut actions = row().gap(8.0);
    if matches!(post.status.as_str(), "FAILED" | "PARTIAL") {
        let id = id.clone();
        actions = actions.child(btn(dark, k("retry"), "Retry", false, !busy, move |h: &mut H| retry(h, &id)));
    }
    if post.status == "SCHEDULED" {
        actions = actions.child(btn(dark, k("cancel"), "Cancel", false, !busy, move |h: &mut H| cancel(h, &id)));
    }
    r.child(actions)
}

pub fn view<H: Host>(h: &H) -> El {
    let dark = h.dark();
    let s = &h.panels().publish;
    let p = pal(dark);
    let head = heading(dark, "publish/title", &format!("Publish: {}", if s.clip_title.is_empty() { "this clip" } else { &s.clip_title }), "Write the copy, make your choices, then post. Nothing is sent automatically.");
    let body = match &s.load {
        Load::Failed(why) => return col().gap(20.0).padding(40.0).w_full().max_w(960.0).child(head)
            .child(state_block::<H>(dark, "publish/failed", Kind::Error, "Could not read your accounts.", &format!("{why}. Close this and open it again."), None)),
        Load::Ready => {
            let mut page = col().gap(16.0).w_full().child(accounts_card::<H>(dark, s));
            if let Some(d) = &s.draft {
                page = page.child(draft_view::<H>(dark, s, d));
            }
            if let Some(why) = &s.error {
                page = page.child(note(dark, "publish/error", Tone::Bad, &format!("{why}. Check it and try again.")));
            }
            let mut posts = card(dark, "publish/posts", "Posts of this clip");
            if s.posts.is_empty() {
                posts = posts.child(text("No posts yet. They appear here after you post.").key("publish/posts/empty").font(type_::BODY).color(p.muted).wrap());
            }
            for post in &s.posts {
                posts = posts.child(post_row::<H>(dark, post, s.busy));
            }
            page.child(posts)
        }
        _ => state_block::<H>(dark, "publish/loading", Kind::Loading, "Reading your accounts.", "This takes a moment.", None),
    };
    col().gap(20.0).padding(40.0).w_full().max_w(960.0).child(head).child(body)
}
