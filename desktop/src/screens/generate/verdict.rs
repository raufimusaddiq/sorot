//! The two verdicts of a build, side by side (`VerdictPanel.tsx`), and what follows them: fix,
//! accept, export. TECHNICAL is measured by code and a FAIL blocks the export; CREATIVE comes from
//! a separate judge, guides the next fix and never blocks. Findings are ranked worst first with
//! their shot and time; warnings kept on purpose are listed apart.

use rune::tok::type_;
use rune::{El, col, edit_access, row, text};

use crate::engine::generate::{Detail, Finding, Verdict};
use crate::screens::generate::{t, tf};
use crate::screens::generate::{Studio, build};
use crate::screens::panels::Host;
use crate::ui::form::{Tone, area, btn, card, note};
use crate::ui::kit::pal;
use crate::ui::states::{Kind, state_block};

const KINDS: [&str; 2] = ["TECHNICAL", "CREATIVE"];

fn rank(severity: &str) -> u8 {
    match severity {
        "must-fix" => 0,
        "should-fix" => 1,
        _ => 2,
    }
}

/// "s02 · 4.2 to 5 s", "s02", "12 s" or nothing.
pub fn place(f: &Finding) -> String {
    let time = match (f.from_sec, f.to_sec) {
        (Some(a), Some(b)) => format!("{a} to {b} s"),
        (Some(a), None) => format!("{a} s"),
        _ => String::new(),
    };
    [f.shot_id.clone().unwrap_or_default(), time].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · ")
}

fn one<H: Host>(dark: bool, kind: &str, v: Option<&Verdict>, version_id: &str, busy: bool) -> El {
    let p = pal(dark);
    let lower = kind.to_lowercase();
    let name = t(&format!("verdict.{lower}"));
    let head = match v {
        Some(v) => format!("{name}: {}", v.status),
        None => format!("{name}: {}", t("verdict.not_judged")),
    };
    let mut c = card(dark, &format!("generate/verdict/{lower}"), &head).child(text(t(&format!("verdict.{lower}.about"))).font(type_::LABEL).color(p.muted).wrap());
    let Some(v) = v else { return c };
    c = c.child(text(tf("verdict.judged_by", &[&v.judged_by])).font(type_::LABEL).color(p.muted));
    let mut live: Vec<&Finding> = v.findings.iter().filter(|f| f.state != "kept").collect();
    live.sort_by_key(|f| rank(&f.severity));
    if live.is_empty() {
        c = c.child(text(t("verdict.nothing")).font(type_::BODY).color(p.text));
    }
    for f in live {
        let k = |n: &str| format!("generate/finding/{}/{n}", f.id);
        let at = place(f);
        let times = f.count.filter(|n| *n > 1).map(|n| format!(" ×{n}")).unwrap_or_default();
        let line = format!("{}{} {}{times}", f.severity, if at.is_empty() { String::new() } else { format!(" · {at}") }, f.description);
        let mut body = col().gap(2.0).grow(1.0).child(text(line).key(k("text")).font(type_::BODY).color(p.text).wrap());
        if let Some(fix) = &f.suggested_fix {
            body = body.child(text(tf("verdict.fix_hint", &[fix])).font(type_::LABEL).color(p.muted).wrap());
        }
        let (fid, vid) = (f.id.clone(), version_id.to_string());
        c = c.child(
            row().key(k("row")).role("listitem").label(f.description.as_str()).gap(12.0).w_full().child(body)
                .child(btn(dark, k("fix"), &t("verdict.fix_this"), false, !busy, move |h: &mut H| build::fix(h, &vid, vec![fid.clone()], true))),
        );
    }
    let kept: Vec<&Finding> = v.findings.iter().filter(|f| f.state == "kept").collect();
    if !kept.is_empty() {
        c = c.child(text(t("verdict.kept")).font(type_::LABEL).color(p.text));
        for f in kept {
            let at = f.shot_id.as_ref().map(|s| format!(" ({s})")).unwrap_or_default();
            let why = f.kept_reason.clone().unwrap_or_else(|| t("verdict.no_reason"));
            c = c.child(text(format!("{}{at}: {why}", f.code)).font(type_::LABEL).color(p.muted).wrap());
        }
    }
    c
}

pub fn view<H: Host>(dark: bool, s: &Studio, d: &Detail) -> El {
    let p = pal(dark);
    let Some(built) = s.built.as_ref() else {
        return state_block::<H>(dark, "generate/verdict/empty", Kind::Empty, &t("verdict.empty.cause"), &t("verdict.empty.next"), None);
    };
    let (shown, verdicts) = (&built.version, built.verdicts.as_slice());
    let accepted = matches!(d.project.status.as_str(), "ACCEPTED" | "EXPORTED");
    let blocked = verdicts.iter().any(|x| x.kind == "TECHNICAL" && x.status == "FAIL");
    let must: Vec<String> = verdicts.iter().flat_map(|x| &x.findings).filter(|f| f.severity == "must-fix" && f.state == "open").map(|f| f.id.clone()).collect();
    let vid = shown.id.clone();
    let mut left = col().gap(12.0).w_full().child(text(tf("verdict.version", &[&shown.number.to_string()])).key("generate/verdict/version").font(type_::TITLE).color(p.text));
    for kind in KINDS {
        left = left.child(one::<H>(dark, kind, verdicts.iter().find(|v| v.kind == kind), &vid, s.busy));
    }
    let (v1, v2, v3, v4) = (vid.clone(), vid.clone(), vid.clone(), vid.clone());
    let mut actions = card(dark, "generate/verdict/actions", &t("step.verdict"))
        .child(btn(dark, "generate/build/fix-must", &tf("verdict.fix_must", &[&must.len().to_string()]), false, !s.busy && !must.is_empty(), move |h: &mut H| build::fix(h, &v1, vec![], false)))
        .child(area(dark, "generate/build/note", &t("verdict.note"), &s.build.note, edit_access(|h: &mut H| &mut h.panels_mut().studio.build.note)))
        .child(btn(dark, "generate/build/fix-note", &t("verdict.fix_note"), false, !s.busy && !s.build.note.text.trim().is_empty(), move |h: &mut H| build::fix(h, &v2, vec![], true)));
    if let Some(path) = &shown.draft_path {
        let (path, wv) = (path.clone(), shown.id.clone());
        actions = actions
            .child(text(tf("verdict.draft", &[&path])).font(type_::LABEL).color(p.muted).wrap())
            .child(btn(dark, "generate/build/watch", &t("verdict.watch"), true, !s.busy, move |h: &mut H| h.watch(&wv)))
            .child(btn(dark, "generate/build/reveal-draft", &t("verdict.reveal_draft"), false, true, move |h: &mut H| h.reveal(&path)));
    }
    if accepted {
        actions = actions.child(note(dark, "generate/build/accepted", Tone::Ok, &t("verdict.accepted")));
        actions = match d.exports.iter().find(|x| x.version_id == shown.id) {
            Some(x) => {
                let path = x.path.clone();
                actions
                    .child(note(dark, "generate/build/exported", Tone::Ok, &tf("verdict.exported", &[&x.path])))
                    .child(btn(dark, "generate/build/reveal", &t("verdict.reveal"), false, true, move |h: &mut H| h.reveal(&path)))
            }
            None => actions.child(btn(dark, "generate/build/export", &t("verdict.export"), true, !s.busy && !blocked, move |h: &mut H| build::export(h, &v3))),
        };
    } else {
        actions = actions.child(btn(dark, "generate/build/accept", &t("verdict.accept"), true, !s.busy && !blocked, move |h: &mut H| build::accept(h, &v4)));
        if blocked {
            actions = actions.child(note(dark, "generate/build/blocked", Tone::Bad, &t("verdict.blocked")));
        }
    }
    row().gap(20.0).w_full().child(col().grow(1.0).child(left)).child(col().w(340.0).child(actions))
}
