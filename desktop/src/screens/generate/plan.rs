//! The plan, shot by shot (`PlanEditor.tsx`). Edit it, ask the director for a change in plain
//! words, then approve: nothing is built from a plan that is not approved (plan before building).
//! Every saved change is a new revision that needs approving again.

use rune::tok::type_;
use rune::{El, TextEdit, col, edit_access, row, text};

use crate::engine::generate as api;
use crate::engine::generate::{Detail, Plan, PlanRow};
use crate::screens::generate::{t, tf};
use crate::screens::generate::{Step, Studio, View, act};
use crate::screens::panels::Host;
use crate::ui::form::{Tone, area, btn, card, field, note};
use crate::ui::kit::pal;

/// One shot's editable text.
pub struct ShotEdit {
    pub seconds: TextEdit,
    pub texts: Vec<TextEdit>,
    pub visual: TextEdit,
    pub motion: TextEdit,
}

pub struct Draft {
    /// The plan row these edits start from.
    pub row: Option<(String, u32)>,
    pub title: TextEdit,
    pub message: TextEdit,
    pub shots: Vec<ShotEdit>,
    pub request: TextEdit,
    /// The shot opened to its words, picture and motion.
    pub open: Option<usize>,
}

impl Default for Draft {
    fn default() -> Self {
        Draft { row: None, title: TextEdit::new(""), message: TextEdit::new(""), shots: vec![], request: TextEdit::new(""), open: None }
    }
}

impl Draft {
    /// A new revision (an edit saved, one from the director) replaces what is on screen.
    pub fn sync(&mut self, row: &PlanRow) {
        let key = (row.id.clone(), row.revision);
        if self.row.as_ref() == Some(&key) {
            return;
        }
        let plan = &row.plan;
        self.row = Some(key);
        self.title = TextEdit::new(&plan.title);
        self.message = TextEdit::new(&plan.message);
        self.shots = plan
            .shots
            .iter()
            .map(|s| ShotEdit {
                seconds: TextEdit::new(s.duration_sec.to_string()),
                texts: s.text.iter().map(|t| TextEdit::new(&t.value)).collect(),
                visual: TextEdit::new(&s.visual.description),
                motion: TextEdit::new(&s.motion),
            })
            .collect();
    }

    /// `base` with the edits applied.
    pub fn plan(&self, base: &Plan) -> Plan {
        let mut plan = base.clone();
        plan.title = self.title.text.clone();
        plan.message = self.message.text.clone();
        for (shot, edit) in plan.shots.iter_mut().zip(&self.shots) {
            shot.duration_sec = edit.seconds.text.trim().parse().unwrap_or(shot.duration_sec);
            for (t, e) in shot.text.iter_mut().zip(&edit.texts) {
                t.value = e.text.clone();
            }
            shot.visual.description = edit.visual.text.clone();
            shot.motion = edit.motion.text.clone();
        }
        plan
    }
}

pub fn save<H: Host>(h: &mut H) {
    let s = &h.panels().studio;
    let Some(row) = s.detail.as_ref().and_then(|d| d.current_plan()) else { return };
    let plan = s.plan.plan(&row.plan);
    act(h, move |e, id| api::save_plan(e, id, &plan).map(|()| None));
}

pub fn approve<H: Host>(h: &mut H) {
    let Some(plan_id) = h.panels().studio.detail.as_ref().and_then(|d| d.current_plan()).map(|r| r.id.clone()) else { return };
    h.panels_mut().studio.view = View::Step(Step::Build);
    act(h, move |e, id| api::approve_plan(e, id, &plan_id).map(|()| None));
}

pub fn revise<H: Host>(h: &mut H) {
    let request = h.panels().studio.plan.request.text.trim().to_string();
    if request.is_empty() {
        return;
    }
    h.panels_mut().studio.plan.request = TextEdit::new("");
    act(h, move |e, id| api::revise_plan(e, id, &request).map(|()| None));
}

fn toggle<H: Host>(h: &mut H, i: usize) {
    let d = &mut h.panels_mut().studio.plan;
    d.open = if d.open == Some(i) { None } else { Some(i) };
}

/// The shots, one row each (seconds beside the name; words, picture and motion open on press):
/// read-only once approved.
fn shots<H: Host>(dark: bool, s: &Studio, draft: &Plan, approved: bool) -> El {
    let p = pal(dark);
    let mut list = card(dark, "generate/plan/shots", &draft.title);
    if approved {
        list = list.child(text(draft.message.as_str()).font(type_::BODY).color(p.muted).wrap());
    } else {
        list = list
            .child(field(dark, "generate/plan/title", &t("plan.title"), &s.plan.title, "", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.plan.title)))
            .child(field(dark, "generate/plan/message", &t("plan.message"), &s.plan.message, "", false, edit_access(|h: &mut H| &mut h.panels_mut().studio.plan.message)));
    }
    for (i, shot) in draft.shots.iter().enumerate() {
        let Some(edit) = s.plan.shots.get(i) else { continue };
        let n = (i + 1).to_string();
        let open = s.plan.open == Some(i);
        let when: El = if approved {
            text(tf("plan.secs", &[&shot.duration_sec.to_string()])).font(type_::LABEL).color(p.muted)
        } else {
            col().w(150.0).child(field(dark, &format!("generate/plan/shot/{i}/seconds"), &tf("plan.shot_seconds", &[&n]), &edit.seconds, "4", false, edit_access(move |h: &mut H| &mut h.panels_mut().studio.plan.shots[i].seconds)))
        };
        let head = row().gap(12.0).items_center().w_full()
            .child(col().grow(1.0).child(btn(dark, format!("generate/plan/shot/{i}/toggle"), &format!("{n}. {}", shot.purpose), open, true, move |h: &mut H| toggle(h, i))))
            .child(when);
        let mut sc = col().key(format!("generate/plan/shot/{i}")).role("group").label(format!("{n}. {}", shot.purpose)).gap(8.0).padding(8.0).w_full().border(1.0, p.divider).radius(8.0).child(head);
        if open && approved {
            sc = sc.child(text(shot.visual.description.as_str()).font(type_::BODY).color(p.muted).wrap());
            for tx in &shot.text {
                sc = sc.child(text(format!("{}: {}", tx.role, tx.value)).font(type_::BODY).color(p.text).wrap());
            }
        } else if open {
            for (k, tx) in shot.text.iter().enumerate() {
                sc = sc.child(field(dark, &format!("generate/plan/shot/{i}/text/{k}"), &format!("{n} {}", tx.role), &edit.texts[k], "", false, edit_access(move |h: &mut H| &mut h.panels_mut().studio.plan.shots[i].texts[k])));
            }
            sc = sc
                .child(area(dark, &format!("generate/plan/shot/{i}/visual"), &tf("plan.shot_see", &[&n]), &edit.visual, edit_access(move |h: &mut H| &mut h.panels_mut().studio.plan.shots[i].visual)))
                .child(field(dark, &format!("generate/plan/shot/{i}/motion"), &tf("plan.shot_move", &[&n]), &edit.motion, "", false, edit_access(move |h: &mut H| &mut h.panels_mut().studio.plan.shots[i].motion)));
        }
        list = list.child(sc);
    }
    list
}

pub fn view<H: Host>(dark: bool, s: &Studio, d: &Detail) -> El {
    let p = pal(dark);
    let Some(current) = d.current_plan() else { return col() };
    let approved = current.approved_at.is_some();
    let draft = s.plan.plan(&current.plan);
    let dirty = draft != current.plan;
    let busy = s.busy || d.project.working();
    let (total, target) = (draft.total(), d.project.target_sec);
    let off_target = total < target * 0.9 || total > target * 1.1;
    let status = tf("plan.status", &[&t(if approved { "plan.approved" } else { "plan.pending" }), &total.to_string(), &target.to_string()]);

    let mut side = card(dark, "generate/plan/panel", &tf("plan.revision", &[&current.revision.to_string()]))
        .child(text(status).key("generate/plan/status").font(type_::LABEL).color(if approved { p.pass } else { p.muted }).wrap())
        .child(text(t("plan.panel.sub")).font(type_::LABEL).color(p.muted).wrap());
    if off_target {
        side = side.child(note(dark, "generate/plan/off-target", Tone::Bad, &tf("plan.off_target", &[&target.to_string()])));
    }
    if approved {
        side = side.child(note(dark, "generate/plan/locked", Tone::Ok, &t("plan.locked")));
    }
    if !draft.assumptions.is_empty() {
        side = side.child(text(tf("plan.assumed", &[&draft.assumptions.join("; ")])).font(type_::LABEL).color(p.muted).wrap());
    }
    if let Some(notes) = current.plan.rest.get("effectNotes").and_then(|v| v.as_array()) {
        let words: Vec<&str> = notes.iter().filter_map(|n| n.as_str()).collect();
        if !words.is_empty() {
            side = side.child(text(tf("plan.effects", &[&words.join("; ")])).font(type_::LABEL).color(p.muted).wrap());
        }
    }
    if !approved {
        side = side
            .child(btn(dark, "generate/plan/approve", &t("plan.approve"), true, !busy && !dirty, approve::<H>))
            .child(btn(dark, "generate/plan/save", &t("plan.save"), false, !busy && dirty, save::<H>))
            .child(area(dark, "generate/plan/request", &t("plan.request"), &s.plan.request, edit_access(|h: &mut H| &mut h.panels_mut().studio.plan.request)))
            .child(btn(dark, "generate/plan/revise", &t("plan.revise"), false, !busy && !dirty && !s.plan.request.text.trim().is_empty(), revise::<H>));
    }
    for r in d.plans.iter().filter(|r| r.change_request.is_some() || r.change_summary.is_some()) {
        let ask = r.change_request.as_ref().map(|q| tf("plan.asked", &[q])).unwrap_or_default();
        let said = r.change_summary.as_ref().map(|q| format!(" · {q}")).unwrap_or_default();
        side = side.child(text(tf("plan.history", &[&r.revision.to_string(), &ask, &said])).font(type_::LABEL).color(p.muted).wrap());
    }
    row().gap(20.0).w_full().child(col().grow(1.0).child(shots::<H>(dark, s, &draft, approved))).child(col().w(340.0).child(side))
}
