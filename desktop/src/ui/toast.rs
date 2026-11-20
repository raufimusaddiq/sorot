//! Toasts on screen, driven by `core::toast`: six seconds, paused while the pointer is on one.
//! A toast is an overlay: it picks the first of three anchors that misses the controls Rune last laid out.

use rune::tok::{self, type_};
use rune::{Cx, El, col, row, text};
use sorot_desktop_core::toast::{Toast, ToastKind};

use crate::app::State;

/// Controls that can share an anchor band. `Cx` reads rects by key, not by "every focusable
/// node"; the L2 row across every scene is the gate that catches a missed one.
const WATCHED: &[&str] = &[
    "clips/play", "clips/edit", "clips/export", "clips/publish", "clips/feedback", "clips/reveal",
    "editor/back", "editor/rerender", "home/interrupted/ji", "home/retry/ji", "job/cancel",
    "engine/restart", "shell/export-diagnostic", "readiness/fix-all", "readiness/ffmpeg/fix",
    "welcome/copy", "welcome/use-here", "learning/log/c1",
    "discover/drain", "discover/c/d1/pick", "discover/c/d1/status", "discover/c/d1/yt", "discover/c/d1/import", "discover/c/d2/yt", "discover/c/d3/status",
    "publish/schedule/day", "publish/schedule/now", "publish/post/p1/retry", "publish/post/p1/refresh",
    "conn/jev/enabled", "conn/jev/director", "conn/jev/endpoint", "conn/jev/model", "conn/jev/key", "conn/jev/test",
    "gen/voice/key", "gen/voice/test", "gen/image/key", "gen/image/test", "gen/field/genMaxTokens", "gen/field/judgeModel",
    "gen/calibrate", "gen/cmd/add", "gen/cmd/1/remove", "generate/step/plan", "generate/step/build", "generate/step/verdict",
    "palette/item/hide", "palette/item/diagnostic", "palette/item/restart",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToastItem {
    pub toast: Toast,
    pub hovered: bool,
}

fn hits(a: [f32; 4], b: [f32; 4]) -> bool {
    let x = (a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0]);
    let y = (a[1] + a[3]).min(b[1] + b[3]) - a[1].max(b[1]);
    x > 0.0 && y > 0.0
}

/// Where the stack goes this frame: first free anchor, else above everything it would hit.
fn place(cx: &Cx<State>) -> [f32; 2] {
    let [w, h] = cx.layout_size("app/root").unwrap_or([1100.0, 720.0]);
    let [tw, th] = cx.layout_with("toast/stack", |r| [r[2], r[3]]).unwrap_or([210.0, 60.0]);
    let anchors = [
        [w - 16.0 - tw, h - 16.0 - th],
        [80.0, h - 16.0 - th],
        [w - 16.0 - tw, 40.0],
    ];
    let rect = |p: [f32; 2]| [p[0], p[1], tw, th];
    let controls: Vec<[f32; 4]> = WATCHED.iter().filter_map(|k| cx.window_layout(k)).filter(|r| r[2] > 0.0 && r[3] > 0.0).collect();
    let clear = |p: &[f32; 2]| !controls.iter().any(|c| hits(rect(*p), *c));
    if let Some(p) = anchors.into_iter().find(clear) {
        return p;
    }
    let top = controls.iter().filter(|c| hits(rect(anchors[0]), **c)).map(|c| c[1]).fold(f32::INFINITY, f32::min);
    [anchors[0][0], (top - th - 8.0).max(40.0)]
}

/// The stack overlays the window. A failed toast is announced at once (`alert`).
pub fn toast_stack(dark: bool, items: &[ToastItem], cx: &Cx<State>) -> El {
    let t = tok::theme(dark);
    let [x, y] = place(cx);
    let mut stack = col().key("toast/stack").gap(6.0).padding(12.0).items_end().absolute(x, y);
    for (i, item) in items.iter().enumerate() {
        let (role, mark) = match item.toast.kind {
            ToastKind::Failed => ("alert", "Failed"),
            ToastKind::Done => ("status", "Done"),
            ToastKind::Info => ("status", "Note"),
        };
        stack = stack.child(
            row().key(format!("toast/{i}")).role(role).label(format!("{mark}: {}", item.toast.text)).gap(8.0).padding(10.0).radius(8.0)
                .fill(t.card).border(1.0, t.card_border)
                .on_hover_change(move |s: &mut State, inside, _| {
                    if let Some(item) = s.toasts.get_mut(i) {
                        item.hovered = inside;
                    }
                })
                .child(text(&item.toast.text).font(type_::BODY).color(t.text)),
        );
    }
    stack
}
