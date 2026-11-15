//! Every build of a video is kept as a version (`VersionHistory.tsx`, "Riwayat versi"): view any of
//! them with its two verdicts, or restore the plan it was built from. Old drafts are removed to
//! save space; their verdicts stay.

use rune::tok::type_;
use rune::{El, col, row, text};

use crate::screens::generate::words::{t, tf};
use crate::screens::generate::{Step, Studio, View, act, go_view, poll};
use crate::screens::panels::Host;
use crate::ui::form::{btn, card, heading};
use crate::ui::kit::pal;

/// Shows one version's verdicts on the verdict step.
pub fn view_one<H: Host>(h: &mut H, version_id: &str) {
    h.panels_mut().studio.shown = Some(version_id.to_string());
    poll(h);
    go_view(h, View::Step(Step::Verdict));
}

pub fn restore<H: Host>(h: &mut H, version_id: &str) {
    let vid = version_id.to_string();
    act(h, move |e, _| crate::engine::generate::version_action(e, &vid, "restore").map(|()| None));
}

pub fn view<H: Host>(dark: bool, s: &Studio) -> El {
    let p = pal(dark);
    let head = heading(dark, "generate/versions/title", &t("versions.title"), &t("versions.sub"));
    let mut c = card(dark, "generate/versions", &t("versions.title"));
    match &s.detail {
        Some(d) if !d.versions.is_empty() => {
            let shown = s.built.as_ref().map(|b| b.version.id.as_str());
            for v in &d.versions {
                let k = |n: &str| format!("generate/version/{}/{n}", v.id);
                let mut line = tf("versions.version", &[&v.number.to_string()]);
                line.push_str(&format!(" · {}", t(&format!("status.{}", v.status))));
                if let Some(parent) = d.versions.iter().find(|x| Some(&x.id) == v.parent_version_id.as_ref()) {
                    line.push_str(&format!(" · {}", tf("versions.fixed_from", &[&parent.number.to_string()])));
                }
                if let Some(st) = d.verdict_statuses.get(&v.id) {
                    for kind in ["TECHNICAL", "CREATIVE"] {
                        if let Some(word) = st.get(kind) {
                            line.push_str(&format!(" · {} {word}", t(&format!("verdict.{}", kind.to_lowercase()))));
                        }
                    }
                }
                if v.status == "BUILT" && v.draft_path.is_none() {
                    line.push_str(&format!(" · {}", t("versions.removed")));
                }
                let mut actions = row().gap(8.0);
                if v.status == "BUILT" {
                    let (a, b) = (v.id.clone(), v.id.clone());
                    let on = shown == Some(v.id.as_str());
                    let current = Some(&v.plan_id) == d.project.current_plan_id.as_ref();
                    actions = actions
                        .child(btn(dark, k("view"), &t(if on { "versions.showing" } else { "versions.view" }), false, !s.busy && !on, move |h: &mut H| view_one(h, &a)))
                        .child(btn(dark, k("restore"), &t(if current { "versions.current" } else { "versions.restore" }), false, !s.busy && !current, move |h: &mut H| restore(h, &b)));
                }
                c = c.child(row().key(k("row")).role("listitem").label(line.as_str()).gap(12.0).items_center().w_full().child(text(line).font(type_::BODY).color(p.text).wrap().grow(1.0)).child(actions));
            }
        }
        _ => c = c.child(text(t("versions.none")).key("generate/versions/none").font(type_::BODY).color(p.muted)),
    }
    col().gap(16.0).w_full().child(head).child(c).child(btn(dark, "generate/versions/back", &t("step.verdict"), false, true, |h: &mut H| go_view(h, View::Step(Step::Verdict))))
}
